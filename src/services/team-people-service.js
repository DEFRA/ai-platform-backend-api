import { ObjectId } from 'mongodb'

import { config } from '#/config.js'
import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { isDuplicateKeyError } from '#/common/helpers/mongo-errors.js'
import { directory as defaultDirectory } from '#/adapters/directory-registry.js'
import { recordAuditEvent } from '#/services/audit-service.js'
import { emailOf, isEligible } from '#/services/directory-eligibility.js'
import { TEAM_ADMIN, requireTeamRole } from '#/common/helpers/auth/access.js'
import { requireTeamId } from '#/services/team-service.js'
import { ensurePersonFromDirectory } from '#/services/user-service.js'

// The most people one search returns; the Admin narrows the search for more.
const MAX_PEOPLE_RESULTS = 20

/**
 * What a team Admin sees of a member they added: the membership with the
 * person's name and email for display, read from `users` rather than stored
 * on the membership.
 * @param {object} member - the `teamMembers` document
 * @param {{displayName?: string, email?: string}} user
 */
function toAddedMember(member, user) {
  return {
    _id: member._id,
    teamId: member.teamId,
    userId: member.userId,
    displayName: user.displayName ?? null,
    email: user.email ?? null,
    role: member.role,
    status: member.status,
    createdAt: member.createdAt
  }
}

async function findUserById(db, userId) {
  return db.collection('users').findOne({ _id: new ObjectId(userId) })
}

/**
 * Searches the directory for people an Admin of the team can add: eligible
 * Defra people who are not already active members, by name, sorted by name
 * and capped at {@link MAX_PEOPLE_RESULTS}. Only an active admin of the team
 * may search, and a non-member is told only that there is nothing there. The
 * search text and the user assertion are never logged or stored.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, actor: {userId: string}, search: string, userAssertion?: string}} params - `teamId` is the team's id or slug; `actor` is the token's credentials
 * @param {{directory?: import('#/adapters/directory.js').Directory, allowedDomains?: string[]}} [deps]
 * @returns {Promise<{items: {oid: string, displayName: string, email: string}[]}>}
 */
export async function searchTeamPeople(
  db,
  { teamId: teamRef, actor, search, userAssertion },
  {
    directory = defaultDirectory,
    allowedDomains = config.get('directory.allowedDomains')
  } = {}
) {
  const teamId = await requireTeamId(db, teamRef)

  await requireTeamRole(db, actor, teamId, {
    role: TEAM_ADMIN,
    action: 'add members'
  })

  const found = await directory.searchPeople({ userAssertion, query: search })
  const memberOids = await activeMemberOids(db, teamId)

  const items = found
    .filter(
      (person) =>
        isEligible(person, allowedDomains) && !memberOids.has(person.oid)
    )
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'en'))
    .slice(0, MAX_PEOPLE_RESULTS)
    .map((person) => ({
      oid: person.oid,
      displayName: person.displayName,
      email: emailOf(person)
    }))

  return { items }
}

/**
 * The Entra object IDs of the team's active members, for leaving them out of
 * a search.
 * @param {import('mongodb').Db} db
 * @param {string} teamId
 * @returns {Promise<Set<string>>}
 */
async function activeMemberOids(db, teamId) {
  const memberships = await db
    .collection('teamMembers')
    .find({ teamId, status: 'active' }, { projection: { userId: 1 } })
    .toArray()
  const userIds = memberships
    .filter((membership) => ObjectId.isValid(membership.userId))
    .map((membership) => new ObjectId(membership.userId))
  const users = await db
    .collection('users')
    .find({ _id: { $in: userIds } }, { projection: { oid: 1 } })
    .toArray()

  return new Set(users.map((user) => user.oid).filter(Boolean))
}

/**
 * The membership a repeated Idempotency-Key stands for, if the repeat is the
 * same request: the same person and the role the add asked for
 * (`requestedRole`, kept with the key; the member's current role can since
 * have been changed). A key reused for another person or role is refused, so
 * the caller is never told the first person was added when they asked for
 * someone else.
 * @param {object} member - the `teamMembers` document the key made
 * @param {{oid?: string, displayName?: string, email?: string}|null} user - the member's record
 * @param {{oid: string, role: string}} request
 */
function replayOf(member, user, { oid, role }) {
  if (user?.oid !== oid || member.requestedRole !== role) {
    throw boomWithCode(
      Boom.conflict,
      'This idempotency key was used for a different request',
      'idempotency-key-reused'
    )
  }

  return toAddedMember(member, user)
}

function memberExists() {
  return boomWithCode(
    Boom.conflict,
    'This person is already a member of the team',
    'member-exists'
  )
}

/**
 * The directory's person for an oid, when they may be added. One that is not
 * held and one that is ineligible are refused alike, so existence is not
 * disclosed.
 * @param {import('#/adapters/directory.js').Directory} directory
 * @param {{userAssertion?: string, oid: string}} lookup
 * @param {string[]} allowedDomains
 */
async function requireEligiblePerson(directory, lookup, allowedDomains) {
  const person = await directory.getPerson(lookup)

  if (!person || !isEligible(person, allowedDomains)) {
    throw boomWithCode(
      Boom.badData,
      'This person cannot be added to the team',
      'person-not-eligible'
    )
  }

  return person
}

/**
 * Writes the membership. The unique indexes, not the reads before it, decide
 * a race: losing one is the same request (replayed) or the same person (a
 * genuine duplicate add), so concurrent adds cannot both succeed.
 * @param {import('mongodb').Db} db
 * @param {object} member - the `teamMembers` document to insert
 * @param {{oid: string, role: string}} request
 * @returns {Promise<{insertedId: import('mongodb').ObjectId}|{replay: object}>}
 */
async function insertMembership(db, member, request) {
  try {
    const { insertedId } = await db.collection('teamMembers').insertOne(member)

    return { insertedId }
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error
    }

    const winner = await db
      .collection('teamMembers')
      .findOne({ teamId: member.teamId, idempotencyKey: member.idempotencyKey })

    if (!winner) {
      throw memberExists()
    }

    // The winner's own person, not this request's: a twin that asked for
    // someone else must not be told that person was added.
    const winnerUser = await findUserById(db, winner.userId)

    return { replay: replayOf(winner, winnerUser, request) }
  }
}

/**
 * The membership an Idempotency-Key already made, shown as a replay of the
 * request, or null when the key is new.
 * @param {import('mongodb').Db} db
 * @param {string} teamId
 * @param {string} idempotencyKey
 * @param {{oid: string, role: string}} request
 */
async function findReplay(db, teamId, idempotencyKey, request) {
  const member = await db
    .collection('teamMembers')
    .findOne({ teamId, idempotencyKey })

  return member
    ? replayOf(member, await findUserById(db, member.userId), request)
    : null
}

/**
 * Audits an add, once per Idempotency-Key. The membership is written before
 * its audit, so an audit write that failed leaves a member with no event; the
 * event's id comes from the key, so a retry (a replay) records it again and a
 * key that already has its event is left alone (a duplicate id is the event
 * already there, not a failure).
 */
async function recordMemberAdded(
  db,
  { actor, teamId, role, oid, idempotencyKey }
) {
  try {
    await recordAuditEvent(db, {
      eventId: `team.addMember:${teamId}:${idempotencyKey}`,
      actor,
      role: TEAM_ADMIN,
      action: 'team.addMember',
      resource: 'team',
      resourceId: teamId,
      outcome: 'success',
      code: role,
      subjectOid: oid
    })
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error
    }
  }
}

/**
 * A replay of an add, once its audit event is known to exist: the first
 * request may have written the membership and failed before auditing it.
 */
async function auditedReplay(db, replay, audit) {
  await recordMemberAdded(db, audit)

  return replay
}

/**
 * Adds a person from the directory to the team, active at once, with the
 * given role (`admin` or `user`, always stated). Only an active admin
 * of the team may do this, so only an admin can make another admin. The
 * directory is read again for the person and checked (a person it does not
 * hold is `422 person-not-eligible`, as an ineligible one is, so existence is
 * not disclosed); their `users` record is made if they have never signed in,
 * and is the one their first sign-in then finds. A repeat of the same
 * Idempotency-Key for the same person and role returns the same membership,
 * even after the member's role has since been changed, and records the add's
 * audit event if the first request failed before writing it; for another person or
 * role it is `409 idempotency-key-reused`.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, actor: {userId: string, tid: string}, oid: string, role: 'admin'|'user', idempotencyKey: string, userAssertion?: string}} params - `teamId` is the team's id or slug; `actor` is the token's credentials, and the person is added to the actor's own tenant
 * @param {{directory?: import('#/adapters/directory.js').Directory, allowedDomains?: string[]}} [deps]
 */
export async function addMember(
  db,
  { teamId: teamRef, actor, oid, role, idempotencyKey, userAssertion },
  {
    directory = defaultDirectory,
    allowedDomains = config.get('directory.allowedDomains')
  } = {}
) {
  const teamId = await requireTeamId(db, teamRef)

  await requireTeamRole(db, actor, teamId, {
    role: TEAM_ADMIN,
    action: 'add members'
  })

  const replay = await findReplay(db, teamId, idempotencyKey, { oid, role })

  if (replay) {
    return auditedReplay(db, replay, {
      actor,
      teamId,
      role,
      oid,
      idempotencyKey
    })
  }

  const person = await requireEligiblePerson(
    directory,
    { userAssertion, oid },
    allowedDomains
  )
  const user = await ensurePersonFromDirectory(db, {
    oid: person.oid,
    tid: actor.tid,
    email: emailOf(person),
    displayName: person.displayName
  })
  const userId = user._id.toString()
  const request = { oid: person.oid, role }
  const audit = { actor, teamId, role, oid: person.oid, idempotencyKey }

  const existingMember = await db
    .collection('teamMembers')
    .findOne({ teamId, userId, status: 'active' })

  if (existingMember) {
    // The same request, arriving while its twin was still being written.
    if (existingMember.idempotencyKey === idempotencyKey) {
      return auditedReplay(db, replayOf(existingMember, user, request), audit)
    }

    throw memberExists()
  }

  const member = {
    teamId,
    userId,
    role,
    requestedRole: role,
    status: 'active',
    idempotencyKey,
    createdAt: new Date().toISOString()
  }
  const inserted = await insertMembership(db, member, request)

  if (inserted.replay) {
    return auditedReplay(db, inserted.replay, audit)
  }

  await recordMemberAdded(db, audit)

  return toAddedMember({ _id: inserted.insertedId, ...member }, user)
}

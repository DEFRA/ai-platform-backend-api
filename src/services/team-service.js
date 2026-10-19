import { ObjectId } from 'mongodb'

import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { isDuplicateKeyError } from '#/common/helpers/mongo-errors.js'
import { acquireLockWithRetry } from '#/common/helpers/mongo-lock.js'
import { deriveTeamSlug, withSlugSuffix } from '#/common/helpers/team-slug.js'
import { serviceCodeVerifier } from '#/adapters/service-code-verifier-registry.js'
import { recordAuditEvent } from '#/services/audit-service.js'

// Two names that differ only in punctuation ("Data Team" and "Data Team!")
// pass the name check but derive one slug, so a clash needs a numbered retry.
const MAX_SLUG_ATTEMPTS = 10

function membershipLock(teamId) {
  return `team-members:${teamId}`
}

/**
 * The three-character service code the team's AI use is charged to, as the
 * team file's schema requires it (design F, R01).
 * @param {string} serviceCode
 */
function normaliseServiceCode(serviceCode) {
  return serviceCode.trim().toUpperCase()
}

/**
 * Normalises a team name for duplicate detection, same pattern as the
 * team-by-name upsert previously used in user-service.js before Route 1.
 * @param {string} name
 */
function normaliseName(name) {
  return name.toLowerCase().trim().replace(/\s+/g, '-')
}

/**
 * Inserts a team, taking the next numbered slug when the derived one is
 * already held, and replaying an Idempotency-Key winner when a concurrent
 * retry got there first.
 * @param {import('mongodb').Db} db
 * @param {object} fields - the team document without its slug
 * @param {{createdBy: string, idempotencyKey: string}} replayKey
 * @returns {Promise<{insertedId?: import('mongodb').ObjectId, slug?: string, replay?: object}>}
 */
async function insertTeamWithUniqueSlug(db, fields, replayKey) {
  const base = deriveTeamSlug(fields.name)

  for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt++) {
    const slug = attempt === 1 ? base : withSlugSuffix(base, attempt)

    try {
      const { insertedId } = await db
        .collection('teams')
        .insertOne({ ...fields, slug })

      return { insertedId, slug }
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error
      }

      // Either index can trip first when a concurrent retry uses the same key
      // and the same name, so always check for a replay before reporting a clash.
      const winner = await db.collection('teams').findOne(replayKey)

      if (winner) {
        return { replay: winner }
      }

      if (!error.keyPattern?.slug) {
        break
      }
    }
  }

  throw boomWithCode(
    Boom.conflict,
    'A team with this name already exists',
    'team-exists'
  )
}

/**
 * Creates a team and makes the creator its first admin, or replays a prior
 * call with the same Idempotency-Key.
 * @param {import('mongodb').Db} db
 * @param {{name: string, serviceCode: string, description?: string, createdBy: string, idempotencyKey: string}} params
 * @param {{verifier?: import('#/adapters/service-code-verifier.js').ServiceCodeVerifier}} [deps]
 */
export async function createTeam(
  db,
  { name, serviceCode, description, createdBy, idempotencyKey },
  { verifier = serviceCodeVerifier } = {}
) {
  const existing = await db
    .collection('teams')
    .findOne({ createdBy, idempotencyKey })

  if (existing) {
    return { team: existing, replay: true }
  }

  const code = normaliseServiceCode(serviceCode)
  const { verified } = await verifier.verify(code)
  const now = new Date().toISOString()
  const team = {
    name,
    normalisedName: normaliseName(name),
    serviceCode: code,
    verified,
    description: description || null,
    createdBy,
    idempotencyKey,
    createdAt: now
  }

  const inserted = await insertTeamWithUniqueSlug(db, team, {
    createdBy,
    idempotencyKey
  })

  if (inserted.replay) {
    return { team: inserted.replay, replay: true }
  }

  const { insertedId, slug } = inserted

  try {
    await db.collection('teamMembers').insertOne({
      teamId: insertedId.toString(),
      userId: createdBy,
      email: null,
      role: 'admin',
      status: 'active',
      createdAt: now
    })
  } catch (error) {
    // Without this the team would survive with no admin, and the idempotent
    // replay would keep handing back that unusable team forever.
    await db.collection('teams').deleteOne({ _id: insertedId })
    throw error
  }

  await recordAuditEvent(db, {
    actorUserId: createdBy,
    action: 'team.create',
    resource: 'team',
    resourceId: insertedId.toString(),
    outcome: 'success'
  })

  return { team: { _id: insertedId, ...team, slug }, replay: false }
}

/**
 * Lists the teams a user is an active member of, each with the caller's own
 * `role` in that team - lets `/manage` role-gate rotate/revoke without a
 * second call per team.
 * @param {import('mongodb').Db} db
 * @param {string} userId
 */
export async function listTeamsForUser(db, userId) {
  const memberships = await db
    .collection('teamMembers')
    .find({ userId, status: 'active' })
    .toArray()

  if (memberships.length === 0) {
    return []
  }

  const roleByTeamId = new Map(
    memberships.map((membership) => [membership.teamId, membership.role])
  )
  const teamIds = memberships.map(
    (membership) => new ObjectId(membership.teamId)
  )

  const teams = await db
    .collection('teams')
    .find({ _id: { $in: teamIds } })
    .toArray()

  return teams.map((team) => ({
    ...team,
    role: roleByTeamId.get(team._id.toString()) ?? null
  }))
}

/**
 * Sets a team's service code, for a team created before one was required or
 * one given the wrong code. Admins only, re-verified on every change, and
 * audited: the code attributes the team's AI spend, and the team file carries
 * it to Azure as a tag.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, actorUserId: string, serviceCode: string}} params
 * @param {{verifier?: import('#/adapters/service-code-verifier.js').ServiceCodeVerifier}} [deps]
 */
export async function setServiceCode(
  db,
  { teamId, actorUserId, serviceCode },
  { verifier = serviceCodeVerifier } = {}
) {
  if (!ObjectId.isValid(teamId)) {
    throw Boom.notFound()
  }

  const role = await getMemberRole(db, { teamId, userId: actorUserId })

  if (role !== 'admin') {
    // A non-member learns nothing about the team; a member learns only that
    // they are not an admin.
    throw role ? Boom.forbidden() : Boom.notFound()
  }

  const code = normaliseServiceCode(serviceCode)
  const { verified } = await verifier.verify(code)
  const team = await db
    .collection('teams')
    .findOneAndUpdate(
      { _id: new ObjectId(teamId) },
      { $set: { serviceCode: code, verified } },
      { returnDocument: 'after' }
    )

  if (!team) {
    throw Boom.notFound()
  }

  await recordAuditEvent(db, {
    actorUserId,
    action: 'team.setServiceCode',
    resource: 'team',
    resourceId: teamId,
    outcome: 'success',
    code
  })

  return { team }
}

/**
 * Returns the caller's role (`'admin'|'user'`) in a team, or null if they
 * are not an active member - used to gate rotate/revoke on a shared team
 * credential to admins only.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, userId: string}} params
 */
export async function getMemberRole(db, { teamId, userId }) {
  const membership = await db
    .collection('teamMembers')
    .findOne({ teamId, userId, status: 'active' })

  return membership?.role ?? null
}

/**
 * Finds a team and its members, only for a requester who is an active member.
 * Returns null (not a 403) for a non-member so existence isn't disclosed.
 * @param {import('mongodb').Db} db
 * @param {{id: string, userId: string}} params
 */
export async function findTeamById(db, { id, userId }) {
  if (!ObjectId.isValid(id)) {
    return null
  }

  const membership = await db
    .collection('teamMembers')
    .findOne({ teamId: id, userId, status: 'active' })

  if (!membership) {
    return null
  }

  const team = await db.collection('teams').findOne({ _id: new ObjectId(id) })

  if (!team) {
    return null
  }

  const members = await db
    .collection('teamMembers')
    .find({ teamId: id })
    .toArray()

  return { team, members: await withMemberDisplayNames(db, members) }
}

/**
 * A member has no display name until they've signed in at least once (their
 * `users` record is what carries it) - joined in here rather than stored
 * redundantly on `teamMembers`, so a later name change in `users` is always
 * reflected without a backfill.
 * @param {import('mongodb').Db} db
 * @param {object[]} members
 */
async function withMemberDisplayNames(db, members) {
  const userIds = members
    .filter((member) => member.userId && ObjectId.isValid(member.userId))
    .map((member) => new ObjectId(member.userId))

  if (userIds.length === 0) {
    return members.map((member) => ({ ...member, displayName: null }))
  }

  const users = await db
    .collection('users')
    .find({ _id: { $in: userIds } })
    .toArray()

  const displayNameByUserId = new Map(
    users.map((user) => [user._id.toString(), user.displayName])
  )

  return members.map((member) => ({
    ...member,
    displayName: member.userId
      ? (displayNameByUserId.get(member.userId) ?? null)
      : null
  }))
}

/**
 * The actor must be an active admin of the team. A non-member is told only
 * that there is nothing there, so team membership is never disclosed.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, actorUserId: string, action: string}} params
 */
async function requireTeamAdmin(db, { teamId, actorUserId, action }) {
  const actorMembership = await db
    .collection('teamMembers')
    .findOne({ teamId, userId: actorUserId, status: 'active' })

  if (!actorMembership) {
    throw Boom.notFound()
  }

  if (actorMembership.role !== 'admin') {
    throw boomWithCode(
      Boom.forbidden,
      `Only a team admin can ${action}`,
      'admin-required'
    )
  }

  return actorMembership
}

/**
 * A member of this team an admin may act on: active or still invited.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, memberId: string}} params
 */
async function findManageableMember(db, { teamId, memberId }) {
  if (!ObjectId.isValid(memberId)) {
    throw Boom.notFound()
  }

  const member = await db
    .collection('teamMembers')
    .findOne({ _id: new ObjectId(memberId), teamId })

  if (!member || !['active', 'invited'].includes(member.status)) {
    throw Boom.notFound()
  }

  return member
}

/**
 * A team always keeps an admin (design F), so the last one can be neither
 * removed nor demoted. Promote someone else first, as two separate changes.
 * @param {import('mongodb').Db} db
 * @param {string} teamId
 */
async function refuseIfLastAdmin(db, teamId) {
  const activeAdminCount = await db
    .collection('teamMembers')
    .countDocuments({ teamId, role: 'admin', status: 'active' })

  if (activeAdminCount <= 1) {
    throw boomWithCode(
      Boom.conflict,
      'A team must keep at least one admin',
      'last-admin'
    )
  }
}

/**
 * Invites a member by email. Only an active admin of the team may do this.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, actorUserId: string, email: string, idempotencyKey: string}} params
 */
export async function addMember(
  db,
  { teamId, actorUserId, email, idempotencyKey }
) {
  await requireTeamAdmin(db, { teamId, actorUserId, action: 'add members' })

  const lowerEmail = email.toLowerCase()

  const replay = await db
    .collection('teamMembers')
    .findOne({ teamId, idempotencyKey })

  if (replay) {
    return replay
  }

  const existingMember = await db
    .collection('teamMembers')
    .findOne({ teamId, email: lowerEmail })

  if (existingMember) {
    throw boomWithCode(
      Boom.conflict,
      'This person is already a member of the team',
      'member-exists'
    )
  }

  const now = new Date().toISOString()
  const member = {
    teamId,
    userId: null,
    email: lowerEmail,
    role: 'user',
    status: 'invited',
    idempotencyKey,
    createdAt: now
  }

  let insertedId

  try {
    ;({ insertedId } = await db.collection('teamMembers').insertOne(member))
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      // Lost a race: either the same key (replay it) or the same email
      // (a genuine duplicate invite). The unique indexes decide, not the
      // earlier reads, so concurrent invites cannot both succeed.
      const winner = await db
        .collection('teamMembers')
        .findOne({ teamId, idempotencyKey })

      if (winner) {
        return winner
      }

      throw boomWithCode(
        Boom.conflict,
        'This person is already a member of the team',
        'member-exists'
      )
    }

    throw error
  }

  await recordAuditEvent(db, {
    actorUserId,
    action: 'team.addMember',
    resource: 'team',
    resourceId: teamId,
    outcome: 'success'
  })

  return { _id: insertedId, ...member }
}

/**
 * Removes a member from a team. Only an active admin may do this, and a
 * team must always keep at least one active admin - the removal is a status
 * change (`'removed'`), not a delete, so the audit trail and idempotency
 * history survive.
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {{teamId: string, actorUserId: string, memberId: string}} params
 */
export async function removeMember(
  db,
  locker,
  { teamId, actorUserId, memberId }
) {
  await requireTeamAdmin(db, { teamId, actorUserId, action: 'remove members' })

  // Counting the admins and then writing is not atomic, so two admins
  // removing or demoting each other at once could leave the team with none.
  const lock = await acquireLockWithRetry(locker, membershipLock(teamId))

  try {
    const member = await findManageableMember(db, { teamId, memberId })

    if (member.role === 'admin') {
      await refuseIfLastAdmin(db, teamId)
    }

    await db.collection('teamMembers').updateOne(
      { _id: member._id },
      {
        $set: {
          status: 'removed',
          removedAt: new Date().toISOString(),
          removedBy: actorUserId
        }
      }
    )
  } finally {
    await lock.free()
  }

  await recordAuditEvent(db, {
    actorUserId,
    action: 'team.removeMember',
    resource: 'team',
    resourceId: teamId,
    outcome: 'success'
  })
}

/**
 * Changes a member's role. Only an active admin may do this, and the team's
 * last admin can no more be demoted than removed, including by themselves:
 * promote someone else first.
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {{teamId: string, actorUserId: string, memberId: string, role: 'admin'|'user'}} params
 */
export async function setMemberRole(
  db,
  locker,
  { teamId, actorUserId, memberId, role }
) {
  await requireTeamAdmin(db, {
    teamId,
    actorUserId,
    action: "change a member's role"
  })

  const lock = await acquireLockWithRetry(locker, membershipLock(teamId))
  let updated

  try {
    const member = await findManageableMember(db, { teamId, memberId })

    if (member.role === role) {
      return { member }
    }

    if (member.role === 'admin') {
      await refuseIfLastAdmin(db, teamId)
    }

    updated = await db
      .collection('teamMembers')
      .findOneAndUpdate(
        { _id: member._id },
        { $set: { role, roleChangedAt: new Date().toISOString() } },
        { returnDocument: 'after' }
      )
  } finally {
    await lock.free()
  }

  await recordAuditEvent(db, {
    actorUserId,
    action: 'team.setMemberRole',
    resource: 'team',
    resourceId: teamId,
    outcome: 'success',
    code: role
  })

  return { member: updated }
}

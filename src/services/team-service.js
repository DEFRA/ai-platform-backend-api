import { ObjectId } from 'mongodb'

import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { recordAuditEvent } from '#/services/audit-service.js'

/**
 * Normalises a team name for duplicate detection, same pattern as the
 * team-by-name upsert previously used in user-service.js before Route 1.
 * @param {string} name
 */
function normaliseName(name) {
  return name.toLowerCase().trim().replace(/\s+/g, '-')
}

/**
 * Creates a team and makes the creator its first admin, or replays a prior
 * call with the same Idempotency-Key.
 * @param {import('mongodb').Db} db
 * @param {{name: string, serviceCode?: string, description?: string, createdBy: string, idempotencyKey: string}} params
 */
export async function createTeam(
  db,
  { name, serviceCode, description, createdBy, idempotencyKey }
) {
  const existing = await db
    .collection('teams')
    .findOne({ createdBy, idempotencyKey })

  if (existing) {
    return { team: existing, replay: true }
  }

  const now = new Date().toISOString()
  const team = {
    name,
    normalisedName: normaliseName(name),
    serviceCode: serviceCode || null,
    verified: false,
    description: description || null,
    createdBy,
    idempotencyKey,
    createdAt: now
  }

  let insertedId

  try {
    ;({ insertedId } = await db.collection('teams').insertOne(team))
  } catch (error) {
    if (error.code === 11000) {
      throw boomWithCode(
        Boom.conflict,
        'A team with this name already exists',
        'team-exists'
      )
    }

    throw error
  }

  await db.collection('teamMembers').insertOne({
    teamId: insertedId.toString(),
    userId: createdBy,
    email: null,
    role: 'admin',
    status: 'active',
    createdAt: now
  })

  await recordAuditEvent(db, {
    actorUserId: createdBy,
    action: 'team.create',
    resource: 'team',
    resourceId: insertedId.toString(),
    outcome: 'success'
  })

  return { team: { _id: insertedId, ...team }, replay: false }
}

/**
 * Lists the teams a user is an active member of.
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

  const teamIds = memberships.map(
    (membership) => new ObjectId(membership.teamId)
  )

  return db
    .collection('teams')
    .find({ _id: { $in: teamIds } })
    .toArray()
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

  return { team, members }
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
  const actorMembership = await db
    .collection('teamMembers')
    .findOne({ teamId, userId: actorUserId, status: 'active' })

  if (!actorMembership) {
    throw Boom.notFound()
  }

  if (actorMembership.role !== 'admin') {
    throw boomWithCode(
      Boom.forbidden,
      'Only a team admin can add members',
      'admin-required'
    )
  }

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

  const { insertedId } = await db.collection('teamMembers').insertOne(member)

  await recordAuditEvent(db, {
    actorUserId,
    action: 'team.addMember',
    resource: 'team',
    resourceId: teamId,
    outcome: 'success'
  })

  return { _id: insertedId, ...member }
}

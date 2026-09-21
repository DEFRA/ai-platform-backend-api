import { ObjectId } from 'mongodb'

import { config } from '#/config.js'
import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { recordAuditEvent } from '#/services/audit-service.js'

function normaliseTeamName(teamName) {
  return teamName.trim().toLowerCase().replace(/\s+/g, '-')
}

function isAllowedEmailDomain(email) {
  const domain = email.split('@')[1]
  const allowedDomains = config
    .get('allowedEmailDomains')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean)

  return allowedDomains.includes(domain)
}

/**
 * Upserts the team and user for the self-declared sign-in journey (J1).
 * @param {import('mongodb').Db} db
 * @param {{email: string, displayName: string, teamName: string}} params
 */
export async function upsertUser(db, { email, displayName, teamName }) {
  const lowerEmail = email.toLowerCase()

  if (!isAllowedEmailDomain(lowerEmail)) {
    throw boomWithCode(
      Boom.forbidden,
      'Email domain is not allowed',
      'domain-not-allowed'
    )
  }

  const now = new Date().toISOString()
  const normalisedName = normaliseTeamName(teamName)

  const team = await db.collection('teams').findOneAndUpdate(
    { normalisedName },
    {
      $setOnInsert: {
        name: teamName,
        normalisedName,
        serviceCode: null,
        billingCode: null,
        createdBy: lowerEmail,
        createdAt: now
      }
    },
    { upsert: true, returnDocument: 'after' }
  )

  const user = await db.collection('users').findOneAndUpdate(
    { email: lowerEmail },
    {
      $set: {
        displayName,
        teamId: team._id,
        lastSignInAt: now,
        updatedAt: now
      },
      $setOnInsert: {
        email: lowerEmail,
        roles: ['research-user'],
        createdAt: now
      }
    },
    { upsert: true, returnDocument: 'after' }
  )

  await recordAuditEvent(db, {
    actorUserId: user._id.toString(),
    action: 'user.signIn',
    resource: 'user',
    resourceId: user._id.toString(),
    outcome: 'success'
  })

  return { user, team }
}

/**
 * Finds the current user and team for the `/v1/users/me` route.
 * @param {import('mongodb').Db} db
 * @param {string} userId
 */
export async function findCurrentUser(db, userId) {
  if (!ObjectId.isValid(userId)) {
    return null
  }

  const user = await db
    .collection('users')
    .findOne({ _id: new ObjectId(userId) })

  if (!user) {
    return null
  }

  const team = user.teamId
    ? await db.collection('teams').findOne({ _id: user.teamId })
    : null

  return { user, team }
}

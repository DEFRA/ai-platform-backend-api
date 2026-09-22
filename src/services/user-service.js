import { ObjectId } from 'mongodb'

import { config } from '#/config.js'
import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { recordAuditEvent } from '#/services/audit-service.js'

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
 * Upserts the user for the Entra ID sign-in journey (B03). Team membership
 * is assigned separately once a team exists (see Route 2's team-creation plan).
 * @param {import('mongodb').Db} db
 * @param {{email: string, displayName: string}} params
 */
export async function upsertUser(db, { email, displayName }) {
  const lowerEmail = email.toLowerCase()

  if (!isAllowedEmailDomain(lowerEmail)) {
    throw boomWithCode(
      Boom.forbidden,
      'Email domain is not allowed',
      'domain-not-allowed'
    )
  }

  const now = new Date().toISOString()

  const user = await db.collection('users').findOneAndUpdate(
    { email: lowerEmail },
    {
      $set: {
        displayName,
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

  return { user, team: null }
}

/**
 * Finds the current user and team for the `/v1/users/me` route. Returns
 * `team: null` until team creation/membership is built (Route 2's plan).
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

  return { user, team: null }
}

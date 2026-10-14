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

// The person's own record, else one from before oid keying (same email, no
// `oid`) bound to them, else a new one. In that order, so an identity never
// binds a second record.
async function signInUser(users, identity, signIn) {
  const existing = await users.findOneAndUpdate(
    identity,
    { $set: signIn },
    { returnDocument: 'after' }
  )

  if (existing) {
    return existing
  }

  const bound = await users.findOneAndUpdate(
    { email: signIn.email, oid: null },
    { $set: { ...signIn, ...identity } },
    { returnDocument: 'after' }
  )

  if (bound) {
    return bound
  }

  return users.findOneAndUpdate(
    identity,
    {
      $set: signIn,
      $setOnInsert: { roles: ['research-user'], createdAt: signIn.updatedAt }
    },
    { upsert: true, returnDocument: 'after' }
  )
}

/**
 * Upserts the user for the Entra ID sign-in journey (B03), keyed on the
 * immutable Entra object ID and tenant ID (design F); email and display
 * name are for display only and refresh on every sign-in. A record from
 * before that keying - the same email and no `oid` - binds to the identity
 * on its first sign-in, as team invitations for this email bind to the
 * signed-in user (B08).
 * @param {import('mongodb').Db} db
 * @param {{oid: string, tid: string, email: string, displayName: string}} params
 */
export async function upsertUser(db, { oid, tid, email, displayName }) {
  const lowerEmail = email.toLowerCase()

  if (!isAllowedEmailDomain(lowerEmail)) {
    throw boomWithCode(
      Boom.forbidden,
      'Email domain is not allowed',
      'domain-not-allowed'
    )
  }

  const now = new Date().toISOString()
  const user = await signInUser(
    db.collection('users'),
    { oid, tid },
    { email: lowerEmail, displayName, lastSignInAt: now, updatedAt: now }
  )

  await db
    .collection('teamMembers')
    .updateMany(
      { email: lowerEmail, status: 'invited' },
      { $set: { userId: user._id.toString(), status: 'active' } }
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

// Design F: Platform Admin is a portal role held outside team roles; it is
// neither a cloud role nor a team credential.
export const PLATFORM_ADMIN_ROLE = 'platform-admin'

/**
 * The principal a person's GitOps changes are attributed to, `entra:{oid}`
 * (the GitOps contract's "Attributed" rule). Rejects with
 * `403 entra-identity-required` for a user with no Entra object ID - a
 * record from before oid keying, until its next sign-in binds one.
 * @param {import('mongodb').Db} db
 * @param {string} userId
 * @returns {Promise<string>}
 */
export async function requireUserPrincipal(db, userId) {
  const user = ObjectId.isValid(userId)
    ? await db
        .collection('users')
        .findOne({ _id: new ObjectId(userId) }, { projection: { oid: 1 } })
    : null

  if (!user?.oid) {
    throw boomWithCode(
      Boom.forbidden,
      'Sign in again so this change can be attributed to you',
      'entra-identity-required'
    )
  }

  return `entra:${user.oid}`
}

/**
 * Rejects with `403 platform-admin-required` unless the user holds the
 * Platform Admin role. Nothing in the portal assigns the role yet.
 * @param {import('mongodb').Db} db
 * @param {string} userId
 */
export async function requirePlatformAdmin(db, userId) {
  const user = ObjectId.isValid(userId)
    ? await db.collection('users').findOne({ _id: new ObjectId(userId) })
    : null

  if (!user?.roles?.includes(PLATFORM_ADMIN_ROLE)) {
    throw boomWithCode(
      Boom.forbidden,
      'Only a Platform Admin can do this',
      'platform-admin-required'
    )
  }
}

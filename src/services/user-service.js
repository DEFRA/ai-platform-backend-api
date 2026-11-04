import { ObjectId } from 'mongodb'

import { recordAuditEvent } from '#/services/audit-service.js'

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
 * Upserts the user for the Entra ID sign-in journey (B03, B27), keyed on the
 * immutable Entra object ID and tenant ID (design F) from the validated
 * token; email and display name are for display only and refresh on every
 * sign-in. A record from before that keying - the same email and no `oid` -
 * binds to the identity on its first sign-in, as team invitations for this
 * email bind to the signed-in user (B08).
 * @param {import('mongodb').Db} db
 * @param {{oid: string, tid: string, email: string, displayName: string, actor: object}} params - `actor` is the token's credentials, for the audit record
 */
export async function upsertUser(db, { oid, tid, email, displayName, actor }) {
  const lowerEmail = email.toLowerCase()
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
    actor: { ...actor, userId: user._id.toString() },
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

/**
 * The principal a person's GitOps changes are attributed to, `entra:{oid}`
 * (the GitOps contract's "Attributed" rule), from the validated token's
 * `oid`: every actor has one.
 * @param {{oid: string}} actor
 * @returns {string}
 */
export function principalOf(actor) {
  return `entra:${actor.oid}`
}

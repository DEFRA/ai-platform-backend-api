import { ObjectId } from 'mongodb'

import { isDuplicateKeyError } from '#/common/helpers/mongo-errors.js'
import { recordAuditEvent } from '#/services/audit-service.js'

/**
 * Upserts the user for the Entra ID sign-in journey (B03, B27), keyed on the
 * immutable Entra object ID and tenant ID (design F) from the validated
 * token; email and display name are for display only and refresh on every
 * sign-in. Sign-in binds no team membership: an Admin adds a person to a
 * team by object ID, and the person's own record, made then or here, is the
 * same one (`{ oid, tid }`). The token's tenant and account checks replace
 * the email-domain check.
 * @param {import('mongodb').Db} db
 * @param {{oid: string, tid: string, email: string, displayName: string, actor: object}} params - `actor` is the token's credentials, for the audit record
 */
export async function upsertUser(db, { oid, tid, email, displayName, actor }) {
  const lowerEmail = email.toLowerCase()
  const now = new Date().toISOString()
  const user = await db.collection('users').findOneAndUpdate(
    { oid, tid },
    {
      $set: {
        email: lowerEmail,
        displayName,
        lastSignInAt: now,
        updatedAt: now
      },
      $setOnInsert: { roles: ['research-user'], createdAt: now }
    },
    { upsert: true, returnDocument: 'after' }
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
 * The person's record for a team Admin's add from the directory: the one
 * sign-in upserts (`{ oid, tid }`), made now for a person who has never
 * signed in, with no `lastSignInAt`. A record that exists - the person has
 * signed in - is returned as it is; their own sign-in owns their name and
 * email.
 * @param {import('mongodb').Db} db
 * @param {{oid: string, tid: string, email: string, displayName: string}} params
 */
export async function ensurePersonFromDirectory(
  db,
  { oid, tid, email, displayName }
) {
  const users = db.collection('users')
  const now = new Date().toISOString()

  try {
    return await users.findOneAndUpdate(
      { oid, tid },
      {
        $setOnInsert: {
          email: email.toLowerCase(),
          displayName,
          roles: ['research-user'],
          createdAt: now,
          updatedAt: now
        }
      },
      { upsert: true, returnDocument: 'after' }
    )
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error
    }

    // A concurrent add or sign-in made the record first.
    return users.findOne({ oid, tid })
  }
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

import { ObjectId } from 'mongodb'

import { config } from '#/config.js'
import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { isDuplicateKeyError } from '#/common/helpers/mongo-errors.js'
import { recordAuditEvent } from '#/services/audit-service.js'
import { isEligible } from '#/services/directory-eligibility.js'

// The sign-in rule is the directory's eligibility rule on the email alone:
// an exact, case-insensitive domain match, no look-alikes, and no `#EXT#`
// address. It is sent no claims, so it cannot tell a guest by anything else:
// the portal's sign-in refuses those from the ID token (until B27).
function isAllowedEmailDomain(email) {
  return isEligible(
    { userPrincipalName: email },
    config.get('allowedEmailDomains')
  )
}

/**
 * Upserts the user for the Entra ID sign-in journey (B03), keyed on the
 * immutable Entra object ID and tenant ID (design F); email and display
 * name are for display only and refresh on every sign-in. Sign-in binds no
 * team membership: an Admin adds a person to a team by object ID, and the
 * person's own record, made then or here, is the same one (`{ oid, tid }`).
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
    actorUserId: user._id.toString(),
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
 * The tenant the signed-in person belongs to, written at sign-in. An Admin
 * adds people from their own tenant, so the add reads it here. Rejects with
 * `403 entra-identity-required` for a person with no record or no tenant.
 * @param {import('mongodb').Db} db
 * @param {string} userId
 * @returns {Promise<string>}
 */
export async function requireUserTenant(db, userId) {
  const user = ObjectId.isValid(userId)
    ? await db
        .collection('users')
        .findOne({ _id: new ObjectId(userId) }, { projection: { tid: 1 } })
    : null

  if (!user?.tid) {
    throw boomWithCode(
      Boom.forbidden,
      'Sign in again so this change can be attributed to you',
      'entra-identity-required'
    )
  }

  return user.tid
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

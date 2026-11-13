import { acquireLockWithRetry } from '#/common/helpers/mongo-lock.js'

// A Platform Admin's block on a team's credentials in one environment (B31
// "Disable credentials"), kept on the team's `teamDeployments` document for
// that environment: one document per team and environment, already read by
// credential recovery and the admin pages. The block outlives a revoke and a
// new credential, which a flag on a credential row would not. Absent means
// not blocked, so there is nothing to backfill and only `true` is queried.

const COLLECTION = 'teamDeployments'

/**
 * Whether a team's document for an environment holds a Platform Admin block.
 * @param {{adminBlocked?: unknown}|null|undefined} doc - the `teamDeployments` document
 * @returns {boolean}
 */
export function isCredentialsBlocked(doc) {
  return doc?.adminBlocked === true
}

/**
 * The lock every change to one team's block in one environment takes, and
 * every grant of a credential there, so a block cannot land between a grant's
 * last look at it and its issue.
 * @param {string} teamId
 * @param {string} environment
 * @returns {string}
 */
export function credentialsBlockLockName(teamId, environment) {
  return `credentials-block:${teamId}:${environment}`
}

/**
 * Runs `work` holding the team and environment's block lock, waiting while
 * another request holds it.
 * @template T
 * @param {import('mongo-locks').LockManager} locker
 * @param {{teamId: string, environment: string}} target
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
export async function withCredentialsBlockLock(
  locker,
  { teamId, environment },
  work
) {
  const lock = await acquireLockWithRetry(
    locker,
    credentialsBlockLockName(teamId, environment)
  )

  try {
    return await work()
  } finally {
    await lock.free()
  }
}

/**
 * Whether credentials are blocked for the team and environment now, read from
 * the database rather than from a document read earlier.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, environment: string}} target
 * @returns {Promise<boolean>}
 */
export async function isEnvironmentBlocked(db, { teamId, environment }) {
  const doc = await db
    .collection(COLLECTION)
    .findOne({ teamId, environment }, { projection: { adminBlocked: 1 } })

  return isCredentialsBlocked(doc)
}

/**
 * Blocks the team's credentials in the environment: who and when are kept.
 * Idempotent: an environment already blocked keeps its first block, so the
 * result says whether this call changed anything. The caller holds the block
 * lock and has checked the document exists.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, environment: string, actor: {userId: string}}} params
 * @returns {Promise<{changed: boolean}>}
 */
export async function blockCredentials(db, { teamId, environment, actor }) {
  const { modifiedCount } = await db.collection(COLLECTION).updateOne(
    { teamId, environment, adminBlocked: { $ne: true } },
    {
      $set: {
        adminBlocked: true,
        adminBlockedAt: new Date().toISOString(),
        adminBlockedBy: actor.userId
      }
    }
  )

  return { changed: modifiedCount === 1 }
}

/**
 * Clears the block. Idempotent: an environment that is not blocked is left as
 * it is. The caller holds the block lock.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, environment: string}} target
 * @returns {Promise<{changed: boolean}>}
 */
export async function unblockCredentials(db, { teamId, environment }) {
  const { modifiedCount } = await db
    .collection(COLLECTION)
    .updateOne(
      { teamId, environment, adminBlocked: true },
      { $unset: { adminBlocked: '', adminBlockedAt: '', adminBlockedBy: '' } }
    )

  return { changed: modifiedCount === 1 }
}

/**
 * The credential status an admin sees for a team in an environment: `disabled`
 * while blocked, else `active` while any credential is, `revoked` when every
 * one that was made has been, and `none` when no credential was ever issued
 * (an attempt that did not finish is not one). While blocked, `held` says what
 * is under the block (`active`, `revoked` or `none`, by the same rule), so a
 * page can offer Revoke only where a credential is live and show Revoked
 * beside Disabled. Never a secret, key hint or external ID.
 * @param {{adminBlocked?: unknown, adminBlockedAt?: string}} doc - the `teamDeployments` document
 * @param {Array<{status: string}>} credentials - the team's credential records in that environment
 * @returns {{status: 'disabled'|'active'|'revoked'|'none', blockedAt?: string, held?: 'active'|'revoked'|'none'}}
 */
export function credentialStatusOf(doc, credentials) {
  const held = heldStatusOf(credentials)

  if (isCredentialsBlocked(doc)) {
    return { status: 'disabled', blockedAt: doc.adminBlockedAt, held }
  }

  return { status: held }
}

function heldStatusOf(credentials) {
  if (credentials.some(({ status }) => status === 'active')) {
    return 'active'
  }

  return credentials.some(({ status }) => status === 'revoked')
    ? 'revoked'
    : 'none'
}

/**
 * Called once after each successful Disable, Enable or Revoke by a Platform
 * Admin. A no-op today: the registration-wide gateway and Entra effects it
 * will carry (the access window's block, the service principal) belong to the
 * federated credential work, which adds them here without touching a route.
 * @param {import('mongodb').Db} _db
 * @param {{teamId: string, environment: string, change: 'disabled'|'enabled'|'revoked', actor: object}} _change
 * @returns {Promise<void>}
 */
export async function credentialsAccessChanged(_db, _change) {
  // intentionally empty, see above
}

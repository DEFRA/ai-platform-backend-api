import { recordAuditEvent } from '#/services/audit-service.js'
import { mockCredentialIssuer } from '#/adapters/mock-credential-issuer.js'
import { requireLock } from '#/common/helpers/mongo-lock.js'

const PENDING_RECONCILE_AFTER_MS = 10 * 60 * 1000

/**
 * Expires past-due active credentials and suspends their APIM subscriptions.
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {import('#/adapters/credential-issuer.js').CredentialIssuer} [issuer]
 */
export async function expireCredentials(
  db,
  locker,
  issuer = mockCredentialIssuer
) {
  const now = new Date().toISOString()
  const dueCredentials = await db
    .collection('credentials')
    .find({ status: 'active', expiresAt: { $lt: now } })
    .toArray()

  let expired = 0
  let suspended = 0

  for (const credential of dueCredentials) {
    const lock = await requireLock(locker, `credential:${credential._id}`)

    try {
      await db
        .collection('credentials')
        .updateOne({ _id: credential._id }, { $set: { status: 'expired' } })
      expired += 1

      await issuer.suspend({
        apimSubscriptionId: credential.apimSubscriptionId
      })
      suspended += 1

      await recordAuditEvent(db, {
        actorUserId: credential.userId,
        action: 'credential.expire',
        resource: 'credential',
        resourceId: credential._id.toString(),
        outcome: 'success'
      })
    } finally {
      await lock.free()
    }
  }

  return { expired, suspended }
}

/**
 * Resolves `pending` credentials stuck for more than 10 minutes (e.g. a crash
 * mid-issue) to `failed`, since the mock/real issuer call is otherwise synchronous.
 * @param {import('mongodb').Db} db
 */
export async function reconcilePendingCredentials(db) {
  const cutoff = new Date(Date.now() - PENDING_RECONCILE_AFTER_MS).toISOString()

  const { modifiedCount } = await db.collection('credentials').updateMany(
    { status: 'pending', createdAt: { $lt: cutoff } },
    {
      $set: { status: 'failed', failureReason: 'reconciliation-timeout' }
    }
  )

  return { reconciled: modifiedCount }
}

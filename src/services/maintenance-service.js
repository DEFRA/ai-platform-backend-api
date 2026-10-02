import { recordAuditEvent } from '#/services/audit-service.js'
import { credentialIssuerRegistry } from '#/adapters/credential-issuer-registry.js'
import { credentialVault } from '#/adapters/credential-vault-registry.js'
import {
  writeSecretToVault,
  externalGatewaySubscriptionIdOf
} from '#/services/credential-service.js'
import { requireLock } from '#/common/helpers/mongo-lock.js'

const PENDING_RECONCILE_AFTER_MS = 10 * 60 * 1000

/**
 * Expires past-due active credentials and suspends their APIM subscriptions.
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {import('#/adapters/credential-issuer-registry.js').CredentialIssuerRegistry} [registry]
 */
export async function expireCredentials(
  db,
  locker,
  registry = credentialIssuerRegistry
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

      const { issuer } = registry.forCredential(credential)
      await issuer.suspend({
        externalId: externalGatewaySubscriptionIdOf(credential)
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
 * mid-issue) to `failed`, since the mock/real issuer call is otherwise
 * synchronous, and retries any credential flagged `vaultState: 'unwritten'`
 * (the issuer call succeeded but the Key Vault write failed at issue/rotate
 * time) by re-issuing - this works because `listSecrets` is repeatable:
 * re-calling `issuer.issue()` with the same params reaches the same
 * already-created subscription and reads back the same key, rather than
 * minting a new one, so no secret has to be parked anywhere in the meantime.
 * @param {import('mongodb').Db} db
 * @param {import('#/adapters/credential-issuer-registry.js').CredentialIssuerRegistry} [registry]
 * @param {import('#/adapters/credential-vault.js').CredentialVault} [vault]
 */
export async function reconcilePendingCredentials(
  db,
  registry = credentialIssuerRegistry,
  vault = credentialVault
) {
  const cutoff = new Date(Date.now() - PENDING_RECONCILE_AFTER_MS).toISOString()

  const { modifiedCount } = await db.collection('credentials').updateMany(
    { status: 'pending', createdAt: { $lt: cutoff } },
    {
      $set: { status: 'failed', failureReason: 'reconciliation-timeout' }
    }
  )

  const vaultReconciled = await reconcileUnwrittenVaultSecrets(
    db,
    registry,
    vault
  )

  return { reconciled: modifiedCount, vaultReconciled }
}

/**
 * Retries the vault write for every credential flagged `vaultState:
 * 'unwritten'`. Leaves the flag in place (to retry again next run) for any
 * credential whose issuer call or vault write still fails.
 * @param {import('mongodb').Db} db
 * @param {import('#/adapters/credential-issuer-registry.js').CredentialIssuerRegistry} registry
 * @param {import('#/adapters/credential-vault.js').CredentialVault} vault
 */
async function reconcileUnwrittenVaultSecrets(db, registry, vault) {
  const unwritten = await db
    .collection('credentials')
    .find({ vaultState: 'unwritten' })
    .toArray()

  let reconciled = 0

  for (const credential of unwritten) {
    try {
      const { issuer } = registry.forCredential(credential)
      const reissued = await issuer.issue({
        userId: credential.userId,
        modelSlug: credential.modelSlug,
        tier: credential.tier,
        teamId: credential.teamId,
        environment: credential.environment,
        credentialType: credential.credentialType
      })

      if (await writeSecretToVault(db, vault, credential, reissued.secret)) {
        reconciled += 1
      }
    } catch {
      // issuer call failed - leave vaultState: 'unwritten', retried next run
    }
  }

  return reconciled
}

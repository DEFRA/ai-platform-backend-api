import { recordAuditEvent } from '#/services/audit-service.js'
import { config } from '#/config.js'
import { credentialIssuerRegistry } from '#/adapters/credential-issuer-registry.js'
import { credentialVault } from '#/adapters/credential-vault-registry.js'
import { AZURE_APIM } from '#/adapters/gateway-keys.js'
import {
  writeSecretToVault,
  externalGatewaySubscriptionIdOf,
  environmentOf
} from '#/services/credential-service.js'
import {
  recoverTeamCredentials,
  sweepGitopsDeployments
} from '#/services/team-deployment-gitops.js'
import { requireLock } from '#/common/helpers/mongo-lock.js'

const PENDING_RECONCILE_AFTER_MS = 10 * 60 * 1000

/**
 * Polls every non-terminal GitHub-mode team deployment so operations nobody
 * is watching still progress through the GitOps states, with an audit event
 * per transition and the D14 failure policy applied, then creates any team
 * credential still missing for an active deployment (`credentials`).
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker - a model reaching `active` creates its team's credential under it
 * @param {import('pino').Logger} [logger]
 * @returns {Promise<{polled: number, transitioned: number, abandoned: number, credentials: number}>}
 */
export async function pollTeamDeployments(db, locker, logger) {
  const swept = await sweepGitopsDeployments(db, { locker, logger })
  const credentials = await recoverTeamCredentials(db, { locker, logger })

  return { ...swept, credentials }
}

/**
 * Expires past-due active credentials and suspends their APIM subscriptions.
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {import('#/adapters/credential-issuer-registry.js').CredentialIssuerRegistry} [registry]
 * @param {import('pino').Logger} [logger]
 */
export async function expireCredentials(
  db,
  locker,
  registry = credentialIssuerRegistry,
  logger
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
      // Suspend in APIM before marking expired in Mongo - if suspend fails,
      // status stays 'active' so the next sweep retries it, rather than
      // getting stuck 'expired' here while still active upstream forever.
      const { issuer } = registry.forCredential(credential)
      await issuer.suspend({
        externalId: externalGatewaySubscriptionIdOf(credential),
        environment: environmentOf(credential)
      })
      suspended += 1

      await db
        .collection('credentials')
        .updateOne({ _id: credential._id }, { $set: { status: 'expired' } })
      expired += 1

      await recordAuditEvent(db, {
        actorUserId: credential.userId,
        action: 'credential.expire',
        resource: 'credential',
        resourceId: credential._id.toString(),
        outcome: 'success'
      })
    } catch (error) {
      // One credential's issuer failure must not abort the rest of the batch.
      logger?.error(
        error,
        `Failed to expire credential ${credential._id}, will retry next sweep`
      )
    } finally {
      await lock.free()
    }
  }

  return { expired, suspended }
}

/**
 * Reports any API Management subscription in the research environment that
 * is not a `research-*` key scoped to the research API. The portal's role
 * can write a subscription for any API, so a stray one means something other
 * than this backend created it. Logged, never revoked: an engineer decides.
 * A failed check is logged and counts as none found, so it never blocks the
 * rest of the sweep.
 * @param {import('pino').Logger} [logger]
 * @param {import('#/adapters/credential-issuer-registry.js').CredentialIssuerRegistry} [registry]
 * @returns {Promise<number>} how many stray subscriptions were found
 */
export async function flagStraySubscriptions(
  logger,
  registry = credentialIssuerRegistry
) {
  if (registry.isMockedFor('research')) {
    return 0
  }

  const environment = config.get('research.environment')

  try {
    const { issuer } = registry.forCredential({ issuerKey: AZURE_APIM })
    const strays = await issuer.findStraySubscriptions({ environment })

    for (const stray of strays) {
      logger?.warn(
        { environment, subscription: stray.name, reasons: stray.reasons },
        'API Management subscription is not a research key on the research API'
      )
    }

    return strays.length
  } catch (error) {
    logger?.error(
      error,
      'Failed to check for stray API Management subscriptions'
    )
    return 0
  }
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
        environment: environmentOf(credential)
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

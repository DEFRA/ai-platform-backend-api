import { config } from '#/config.js'
import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { recordAuditEvent } from '#/services/audit-service.js'
import { requireLock } from '#/common/helpers/mongo-lock.js'
import { credentialIssuerRegistry } from '#/adapters/credential-issuer-registry.js'
import { credentialVault } from '#/adapters/credential-vault-registry.js'
import { grantedModelSlugs } from '#/services/team-deployment-gateway.js'
import { isEnvironmentBlocked } from '#/services/credential-block.js'
import {
  ROLE_OWNER,
  assertNotRevoked,
  credentialLockName,
  credentialsCollection,
  environmentOf,
  externalGatewaySubscriptionIdOf
} from '#/services/credential-common.js'
import {
  findCredentialForUser,
  loadCredentialForAction
} from '#/services/credential-access.js'
import {
  withRenewalsRemaining,
  withTeamGrants
} from '#/services/credential-presenter.js'
import {
  VAULT_UNWRITTEN,
  clearVaultUnwritten,
  markVaultUnwritten,
  writeSecretToVault
} from '#/services/credential-vault-writer.js'

const HOURS_PER_DAY = 24
const MINUTES_PER_HOUR = 60
const SECONDS_PER_MINUTE = 60
const MS_PER_SECOND = 1000
const MS_PER_DAY =
  HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND

const CREDENTIALS_DISABLED = 'credentials-disabled'

function auditAction(db, { actor, role, action, id, ...extra }) {
  return recordAuditEvent(db, {
    actor,
    role,
    action,
    resource: 'credential',
    resourceId: id,
    outcome: 'success',
    ...extra
  })
}

// A team credential cannot be rotated or revealed while a Platform Admin has
// disabled the team's credentials in its environment: refused as `409
// credentials-disabled`, and audited as the action that was refused. The
// response and the event say nothing of why; the block's reason is only in
// its own audit event. Research credentials are personal and never blocked.
async function assertCredentialsEnabled(
  db,
  { credential, actor, role, action, id }
) {
  const { teamId } = credential
  const environment = environmentOf(credential)

  if (
    credential.tier !== 'team' ||
    !(await isEnvironmentBlocked(db, { teamId, environment }))
  ) {
    return
  }

  await auditAction(db, {
    actor,
    role,
    action,
    id,
    outcome: 'failure',
    code: CREDENTIALS_DISABLED,
    teamId,
    environment
  })

  throw boomWithCode(
    Boom.conflict,
    'Credentials are disabled for this team in this environment',
    CREDENTIALS_DISABLED
  )
}

// A renewal is refused for a team credential (it never expires), a revoked one
// and one that has used its renewals.
function assertRenewable(credential) {
  if (credential.tier === 'team') {
    throw boomWithCode(
      Boom.badRequest,
      'Team credentials do not expire and cannot be renewed',
      'team-credential-no-renewal'
    )
  }

  assertNotRevoked(credential)

  if (credential.renewalCount >= config.get('research.renewalCap')) {
    throw boomWithCode(
      Boom.forbidden,
      'Renewal cap reached for this credential',
      'renewal-cap-reached'
    )
  }
}

// Pushes the extended expiry to the Key Vault secret, tolerating a vault
// failure by flagging the credential `vaultState: 'unwritten'`.
async function pushExpiryToVault(
  db,
  vault,
  { id, credential, updated, expiresAt }
) {
  try {
    await vault.updateExpiry({
      credentialId: id,
      issuerKey: credential.issuerKey,
      environment: environmentOf(credential),
      expiresOn: new Date(expiresAt)
    })

    await clearVaultUnwritten(db, updated)
  } catch {
    await markVaultUnwritten(db, credential)
    updated.vaultState = VAULT_UNWRITTEN
  }
}

/**
 * Renews a credential within the renewal cap, reactivating it in APIM if it was suspended.
 * Also pushes the extended `expiresAt` to the Key Vault secret's own expiry attribute -
 * tolerating a vault failure the same way `writeSecretToVault` does (flag `vaultState:
 * 'unwritten'`, picked up by `reconcilePendingCredentials`, which re-writes the secret
 * using the already-renewed `expiresAt` from Mongo).
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {{id: string, actor: {userId: string}}} params
 * @param {import('#/adapters/credential-issuer-registry.js').CredentialIssuerRegistry} [registry]
 * @param {import('#/adapters/credential-vault.js').CredentialVault} [vault]
 */
export async function renewCredential(
  db,
  locker,
  { id, actor },
  registry = credentialIssuerRegistry,
  vault = credentialVault
) {
  const lock = await requireLock(locker, credentialLockName(id))

  try {
    const credential = await findCredentialForUser(db, { id, actor })

    if (!credential) {
      throw Boom.notFound()
    }

    assertRenewable(credential)

    const ttlDays = config.get('research.credentialTtlDays')
    const expiresAt = new Date(Date.now() + ttlDays * MS_PER_DAY).toISOString()

    // Always pushed to APIM (not just when already-expired) so
    // context.Subscription.EndDate never drifts behind Mongo's expiresAt -
    // see apim-credential-issuer.js's renew().
    const { issuer } = registry.forCredential(credential)
    await issuer.renew({
      externalId: externalGatewaySubscriptionIdOf(credential),
      expiresAt,
      environment: environmentOf(credential)
    })

    const updated = await credentialsCollection(db).findOneAndUpdate(
      { _id: credential._id },
      {
        $set: { status: 'active', expiresAt },
        $inc: { renewalCount: 1 }
      },
      { returnDocument: 'after' }
    )

    await pushExpiryToVault(db, vault, { id, credential, updated, expiresAt })
    await auditAction(db, {
      actor,
      role: ROLE_OWNER,
      action: 'credential.renew',
      id
    })

    return withRenewalsRemaining(updated)
  } finally {
    await lock.free()
  }
}

/**
 * Rotates a credential's secret in place, keeping its existing
 * `expiresAt`/policy - distinct from `renewCredential`, which extends
 * expiry. Team credentials require the requester to be an admin member;
 * research credentials stay self-service. No
 * overlap/grace window in this slice - the old secret is invalidated
 * immediately.
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {{id: string, actor: {userId: string}}} params
 * @param {import('#/adapters/credential-issuer-registry.js').CredentialIssuerRegistry} [registry]
 * @param {import('#/adapters/credential-vault.js').CredentialVault} [vault]
 */
export async function rotateCredential(
  db,
  locker,
  { id, actor },
  registry = credentialIssuerRegistry,
  vault = credentialVault
) {
  const lock = await requireLock(locker, credentialLockName(id))

  try {
    const loaded = await loadCredentialForAction(db, { id, actor })

    if (!loaded) {
      throw Boom.notFound()
    }

    const { credential, role } = loaded

    assertNotRevoked(credential)
    await assertCredentialsEnabled(db, {
      credential,
      actor,
      role,
      action: 'credential.rotate',
      id
    })

    const { issuer } = registry.forCredential(credential)
    const rotated = await issuer.rotate({
      externalId: externalGatewaySubscriptionIdOf(credential),
      environment: environmentOf(credential)
    })

    const now = new Date().toISOString()
    const updated = await credentialsCollection(db).findOneAndUpdate(
      { _id: credential._id },
      { $set: { keyHint: rotated.keyHint, rotatedAt: now } },
      { returnDocument: 'after' }
    )

    // Creates a new Key Vault version; the old version stays recoverable
    // inside the 90-day soft-delete window.
    await writeSecretToVault(db, vault, updated, rotated.secret)

    await auditAction(db, { actor, role, action: 'credential.rotate', id })

    return {
      credential: await withTeamGrants(db, withRenewalsRemaining(updated)),
      secret: rotated.secret
    }
  } finally {
    await lock.free()
  }
}

// Soft-deletes the secret for 90 days. Best-effort: the credential is already
// revoked in APIM, which is the access control that matters - a vault write
// failure here is hygiene, not a security hole.
async function removeSecretFromVault(vault, credential) {
  try {
    await vault.remove({
      credentialId: credential._id.toString(),
      issuerKey: credential.issuerKey,
      environment: environmentOf(credential)
    })
  } catch {
    // intentionally swallowed, see comment above
  }
}

/**
 * Revokes one credential record: deletes its gateway subscription, removes
 * its secret from the vault (best effort) and marks it `revoked`. The one
 * path a team Admin's revoke and a Platform Admin's revoke both take;
 * authorisation, the credential lock and, for a Platform Admin, the audit
 * event (one per environment, not per record) are the caller's. An issuer
 * failure throws and leaves the record active.
 * @param {import('mongodb').Db} db
 * @param {object} credential - the stored, not yet revoked, credential
 * @param {{actor: object, role: string, revokedReason?: string, audit?: boolean}} options - `revokedReason` is what the record keeps (`user-requested` unless a Platform Admin revokes); `audit` false leaves the `credential.revoke` event to the caller
 * @param {import('#/adapters/credential-issuer-registry.js').CredentialIssuerRegistry} [registry]
 * @param {import('#/adapters/credential-vault.js').CredentialVault} [vault]
 * @returns {Promise<object>} the revoked record
 */
export async function revokeCredentialRecord(
  db,
  credential,
  { actor, role, revokedReason = 'user-requested', audit = true },
  registry = credentialIssuerRegistry,
  vault = credentialVault
) {
  const { issuer } = registry.forCredential(credential)
  await issuer.revoke({
    externalId: externalGatewaySubscriptionIdOf(credential),
    environment: environmentOf(credential)
  })

  await removeSecretFromVault(vault, credential)

  const now = new Date().toISOString()
  // The record keeps what the credential covered when it was revoked,
  // since a revoked credential no longer follows the team's grants.
  const covered =
    credential.tier === 'team'
      ? { allowedDeployments: await grantedModelSlugs(db, credential) }
      : {}
  const updated = await credentialsCollection(db).findOneAndUpdate(
    { _id: credential._id },
    {
      $set: {
        status: 'revoked',
        revokedAt: now,
        revokedReason,
        ...covered
      }
    },
    { returnDocument: 'after' }
  )

  if (audit) {
    await auditAction(db, {
      actor,
      role,
      action: 'credential.revoke',
      id: credential._id.toString()
    })
  }

  return updated
}

/**
 * Revokes a credential, deleting its APIM subscription. A team credential
 * may be revoked by any admin member of that team, not only whoever
 * originally requested it. Revoking is allowed while a Platform Admin has
 * disabled the team's credentials: it only reduces access.
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {{id: string, actor: {userId: string}}} params
 * @param {import('#/adapters/credential-issuer-registry.js').CredentialIssuerRegistry} [registry]
 * @param {import('#/adapters/credential-vault.js').CredentialVault} [vault]
 */
export async function revokeCredential(
  db,
  locker,
  { id, actor },
  registry = credentialIssuerRegistry,
  vault = credentialVault
) {
  const lock = await requireLock(locker, credentialLockName(id))

  try {
    const loaded = await loadCredentialForAction(db, { id, actor })

    if (!loaded) {
      throw Boom.notFound()
    }

    const { credential, role } = loaded

    if (credential.status === 'revoked') {
      return credential
    }

    const updated = await revokeCredentialRecord(
      db,
      credential,
      { actor, role },
      registry,
      vault
    )

    return withRenewalsRemaining(updated)
  } finally {
    await lock.free()
  }
}

/**
 * Reveals a credential's plaintext secret for view/re-share - a
 * state-changing, audited action (never a GET: the secret must never sit in
 * a URL, query string or access log). Authorisation reuses
 * `loadCredentialForAction`: owner-only for a research credential, team-admin
 * only for a team credential. A platform-operator
 * override is also in the design pack, but no such role exists anywhere
 * else in this codebase yet (no operator collection/flag) - deferred until
 * that lands rather than invented here.
 * @param {import('mongodb').Db} db
 * @param {{id: string, actor: {userId: string}, reason: string}} params
 * @param {import('#/adapters/credential-vault.js').CredentialVault} [vault]
 */
export async function revealCredential(
  db,
  { id, actor, reason },
  vault = credentialVault
) {
  const loaded = await loadCredentialForAction(db, { id, actor })

  if (!loaded) {
    throw Boom.notFound()
  }

  const { credential, role } = loaded

  assertNotRevoked(credential)
  await assertCredentialsEnabled(db, {
    credential,
    actor,
    role,
    action: 'credential.reveal',
    id
  })

  if (
    credential.status === 'failed' ||
    credential.vaultState === VAULT_UNWRITTEN
  ) {
    // Either never had a secret, or the vault write is still pending
    // reconciliation - matches findCredentialForViewing's "don't disclose
    // more than a 404" behaviour rather than a more specific error.
    throw Boom.notFound()
  }

  const secret = await vault.get({
    credentialId: credential._id.toString(),
    issuerKey: credential.issuerKey,
    environment: environmentOf(credential)
  })

  if (!secret) {
    throw Boom.notFound()
  }

  await auditAction(db, {
    actor,
    role,
    action: 'credential.reveal',
    id,
    reason
  })

  return secret
}

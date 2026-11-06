import { recordAuditEvent } from '#/services/audit-service.js'
import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import {
  credentialsCollection,
  issuanceAuditActor
} from '#/services/credential-common.js'
import {
  VAULT_UNWRITTEN,
  writeSecretToVault
} from '#/services/credential-vault-writer.js'

const AUDIT_ISSUE = 'credential.issue'

function auditIssue(db, actor, insertedId, outcome) {
  return recordAuditEvent(db, {
    ...issuanceAuditActor(actor),
    action: AUDIT_ISSUE,
    resource: 'credential',
    resourceId: insertedId.toString(),
    outcome,
    ...(outcome === 'failure' && { code: 'upstream-unavailable' })
  })
}

// Writes the pending document, or resets the one being retried, and returns
// its id.
async function savePending(db, { reusable, insertId, pending }) {
  if (reusable) {
    await credentialsCollection(db).updateOne(
      { _id: reusable._id },
      { $set: pending, $unset: { failureReason: '' } }
    )

    return reusable._id
  }

  const { insertedId } = await credentialsCollection(db).insertOne(
    insertId ? { _id: insertId, ...pending } : pending
  )

  return insertedId
}

// Asks the issuer for the secret. A failing issuer leaves the document
// `failed`, audited, and is reported as `502 upstream-unavailable`.
async function requestSecret(db, { issuer, issueParams, insertedId, actor }) {
  try {
    return await issuer.issue(issueParams)
  } catch {
    await credentialsCollection(db).updateOne(
      { _id: insertedId },
      { $set: { status: 'failed', failureReason: 'issuer-error' } }
    )
    await auditIssue(db, actor, insertedId, 'failure')

    throw boomWithCode(
      Boom.badGateway,
      'Failed to issue credential',
      'upstream-unavailable'
    )
  }
}

// The credential as it leaves the service once its secret is in the vault:
// the unwritten marker is gone.
function withoutVaultMarker(credential) {
  const settled = { ...credential }
  delete settled.vaultState

  return settled
}

/**
 * Writes the pending document (or resets the one being retried), asks the
 * issuer for the secret, then activates the document, puts the secret in the
 * vault and audits it. A failing issuer leaves the document `failed`. The
 * caller decides who sees the secret. A credential with `noExpiry` never
 * expires; otherwise it expires when the issuer says.
 */
export async function issueAndActivate(
  db,
  vault,
  { issuer, pending, reusable, insertId, issueParams, noExpiry, actor }
) {
  const insertedId = await savePending(db, { reusable, insertId, pending })
  const issued = await requestSecret(db, {
    issuer,
    issueParams,
    insertedId,
    actor
  })

  // `vaultState: unwritten` is stored with the activation and cleared once
  // the secret is in the vault, so a stop between the two leaves a marker
  // for `reconcilePendingCredentials`, never an active credential whose
  // secret is nowhere.
  const active = {
    status: 'active',
    externalGatewaySubscriptionId: issued.externalId,
    keyHint: issued.keyHint,
    activatedAt: pending.createdAt,
    expiresAt: noExpiry ? null : issued.expiresAt,
    vaultState: VAULT_UNWRITTEN
  }

  await credentialsCollection(db).updateOne(
    { _id: insertedId },
    { $set: active }
  )

  const unsettled = { _id: insertedId, ...pending, ...active }
  const vaultWritten = await writeSecretToVault(
    db,
    vault,
    unsettled,
    issued.secret
  )
  const credential = vaultWritten ? withoutVaultMarker(unsettled) : unsettled

  await auditIssue(db, actor, insertedId, 'success')

  return { credential, secret: issued.secret, vaultWritten }
}

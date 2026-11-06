import { ObjectId } from 'mongodb'

import {
  credentialsCollection,
  environmentOf
} from '#/services/credential-common.js'

export const VAULT_UNWRITTEN = 'unwritten'

/**
 * Tags attached to a credential's Key Vault secret, per the design's
 * "tagged aip-team, aip-service-code and aip-environment". `aip-team` is
 * the literal platform team name for a research-tier credential with no
 * team of its own, or the owning team's id otherwise; `aip-service-code`
 * is best-effort (omitted if the team has none recorded) rather than a
 * required field, since it is metadata for operators, not an access check.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string|null, tier?: string, environment: string|null}} credential
 */
async function buildVaultTags(db, credential) {
  const { teamId } = credential
  const environment = environmentOf(credential)
  const tags = {
    'aip-team': teamId ?? 'research',
    ...(environment && { 'aip-environment': environment })
  }

  if (teamId && ObjectId.isValid(teamId)) {
    const team = await db
      .collection('teams')
      .findOne(
        { _id: new ObjectId(teamId) },
        { projection: { serviceCode: 1 } }
      )

    if (team?.serviceCode) {
      tags['aip-service-code'] = team.serviceCode
    }
  }

  return tags
}

/**
 * Flags a credential whose secret is not in the vault yet, for
 * `reconcilePendingCredentials` to retry.
 * @param {import('mongodb').Db} db
 * @param {{_id: import('mongodb').ObjectId}} credential
 */
export async function markVaultUnwritten(db, credential) {
  await credentialsCollection(db).updateOne(
    { _id: credential._id },
    { $set: { vaultState: VAULT_UNWRITTEN } }
  )
}

/**
 * Clears the unwritten flag once the secret is in the vault.
 * @param {import('mongodb').Db} db
 * @param {{_id: import('mongodb').ObjectId, vaultState?: string}} credential
 */
export async function clearVaultUnwritten(db, credential) {
  if (credential.vaultState === VAULT_UNWRITTEN) {
    await credentialsCollection(db).updateOne(
      { _id: credential._id },
      { $unset: { vaultState: '' } }
    )
  }
}

/**
 * Writes a credential's secret to the vault, tolerating a vault failure by
 * flagging the credential `vaultState: 'unwritten'` rather than failing the
 * caller's request - the user already holds the secret from the issuer, and
 * `reconcilePendingCredentials` retries unwritten writes later. Exported so
 * that retry can reuse the exact same tagging/flag-clearing logic instead of
 * duplicating it.
 * @param {import('mongodb').Db} db
 * @param {import('#/adapters/credential-vault.js').CredentialVault} vault
 * @param {object} credential
 * @param {string} secret
 * @returns {Promise<boolean>} whether the vault write succeeded
 */
export async function writeSecretToVault(db, vault, credential, secret) {
  try {
    const tags = await buildVaultTags(db, credential)

    await vault.put({
      credentialId: credential._id.toString(),
      issuerKey: credential.issuerKey,
      environment: environmentOf(credential),
      secret,
      tags,
      ...(credential.expiresAt && { expiresOn: new Date(credential.expiresAt) })
    })

    await clearVaultUnwritten(db, credential)

    return true
  } catch {
    await markVaultUnwritten(db, credential)

    return false
  }
}

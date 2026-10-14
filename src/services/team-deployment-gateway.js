import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'

// The team's gateway on its `teamDeployments` document, as credential
// issuance (`credential-service.js`) reads and fixes it.

/**
 * Finds the active deployment entry for a team+model+environment, used by
 * `credential-service.js` to gate team-tier credential issuance. Does not
 * refresh status itself - the requester's poll of `getDeployment` in
 * `team-deployment-service.js` is what keeps the persisted record up to date.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, modelSlug: string, environment: string}} params
 */
export async function findActiveDeployment(
  db,
  { teamId, modelSlug, environment }
) {
  const doc = await db.collection('teamDeployments').findOne({
    teamId,
    environment,
    deployments: { $elemMatch: { modelSlug, status: 'active' } }
  })

  return (
    doc?.deployments?.find(
      (deployment) =>
        deployment.modelSlug === modelSlug && deployment.status === 'active'
    ) ?? null
  )
}

/**
 * Fixes a team's gateway credential type for an environment on first use, or
 * rejects a later request that asks for a different one
 * (`credential-type-fixed`) - design C's "one credential type per team per
 * environment", chosen once and changed only by a team-file edit.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, environment: string, credentialType: 'oauth'|'subscription-key'}} params
 * @returns {Promise<{credentialType: 'oauth'|'subscription-key', wasNewlyReserved: boolean}>}
 */
export async function reserveCredentialType(
  db,
  { teamId, environment, credentialType }
) {
  const now = new Date().toISOString()

  const reserved = await db.collection('teamDeployments').findOneAndUpdate(
    { teamId, environment, 'gateway.credentialType': null },
    {
      $set: {
        'gateway.credentialType': credentialType,
        'oauthClient.enabled': credentialType === 'oauth',
        updatedAt: now
      }
    },
    { returnDocument: 'after' }
  )

  if (reserved) {
    return { credentialType, wasNewlyReserved: true }
  }

  const doc = await db
    .collection('teamDeployments')
    .findOne({ teamId, environment })
  const existingType = doc?.gateway?.credentialType

  if (existingType && existingType !== credentialType) {
    throw boomWithCode(
      Boom.conflict,
      'This team already uses a different credential type in this environment',
      'credential-type-fixed'
    )
  }

  return {
    credentialType: existingType ?? credentialType,
    wasNewlyReserved: false
  }
}

/**
 * Undoes a reservation made by `reserveCredentialType` when the credential
 * issue that relied on it subsequently fails, so a retry (or another team
 * member) isn't permanently locked into a credential type that was never
 * actually issued. Only resets the gateway if it's still set to the type
 * being released, so it can't clobber a genuine concurrent reservation.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, environment: string, credentialType: 'oauth'|'subscription-key'}} params
 */
export async function releaseCredentialTypeReservation(
  db,
  { teamId, environment, credentialType }
) {
  await db.collection('teamDeployments').updateOne(
    { teamId, environment, 'gateway.credentialType': credentialType },
    {
      $set: {
        'gateway.credentialType': null,
        'oauthClient.enabled': false,
        updatedAt: new Date().toISOString()
      }
    }
  )
}

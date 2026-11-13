import {
  TEAM_CREDENTIAL_FILTER,
  credentialsCollection
} from '#/services/credential-common.js'
import { clientSecretsAllowedIn } from '#/services/team-oauth-block.js'

// The client secrets a team holds in an environment (design E, choice A): the
// credentials of its tier, the one made with its first model and those an
// Admin adds. Up to three are unexpired at a time. Nothing here reads or
// returns a value: a secret is in the vault, and an Admin reveals it.

export const MAX_CLIENT_SECRETS = 3

const EXPIRED = 'expired'
const ACTIVE = 'active'

// Kept on the record once they have been made, so they show in the list: a
// secret still working, and one whose time has run out.
const LISTED_STATUSES = [ACTIVE, EXPIRED]

function isExpired(secret, now) {
  return (
    secret.status === EXPIRED ||
    (Boolean(secret.expiresAt) && secret.expiresAt <= now.toISOString())
  )
}

/**
 * The places taken in one environment: the secrets still working, one that
 * never expires included. A failed attempt, a revoked secret and an expired
 * one hold no place.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, environment: string}} scope
 * @param {Date} [now]
 * @returns {Promise<number>}
 */
export function countUnexpiredSecrets(
  db,
  { teamId, environment },
  now = new Date()
) {
  return credentialsCollection(db).countDocuments({
    teamId,
    environment,
    ...TEAM_CREDENTIAL_FILTER,
    status: ACTIVE,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now.toISOString() } }]
  })
}

/**
 * The secrets of a team in some environments, oldest first, by environment.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, environments: string[]}} scope
 * @returns {Promise<Map<string, object[]>>}
 */
export async function clientSecretsOf(db, { teamId, environments }) {
  const secrets = await credentialsCollection(db)
    .find({
      teamId,
      environment: { $in: environments },
      ...TEAM_CREDENTIAL_FILTER,
      status: { $in: LISTED_STATUSES }
    })
    .sort({ createdAt: 1 })
    .toArray()

  return new Map(
    environments.map((environment) => [
      environment,
      secrets.filter((secret) => secret.environment === environment)
    ])
  )
}

/**
 * What a read of an environment says of the team's secrets there: whether
 * they are allowed, how many of the three places are taken and the limit.
 * @param {string} environment
 * @param {object[]} secrets - what `clientSecretsOf` found for it
 * @param {Date} [now]
 * @returns {{allowed: boolean, used: number, limit: number}}
 */
export function clientSecretsSummaryOf(environment, secrets, now = new Date()) {
  return {
    allowed: clientSecretsAllowedIn(environment),
    used: secrets.filter((secret) => !isExpired(secret, now)).length,
    limit: MAX_CLIENT_SECRETS
  }
}

/**
 * One secret as a member sees it: no value, only what identifies it.
 * @param {object} secret
 * @param {Date} [now]
 * @returns {{id: string, keyHint: string, expiresAt: string|null, status: 'active'|'expired'}}
 */
export function clientSecretViewOf(secret, now = new Date()) {
  return {
    id: secret._id.toString(),
    keyHint: secret.keyHint,
    expiresAt: secret.expiresAt ?? null,
    status: isExpired(secret, now) ? EXPIRED : ACTIVE
  }
}

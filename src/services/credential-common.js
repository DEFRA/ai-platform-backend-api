import { ObjectId } from 'mongodb'

import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { systemActor } from '#/common/helpers/auth/system-actor.js'
import { requireLock } from '#/common/helpers/mongo-lock.js'

// The team tier is OAuth only - a client secret or a federated credential,
// local development included. Research credentials are subscription keys.
// A team's one credential per environment is created when its first model
// there turns active (`ensureTeamCredential`), never by a request.
export const TEAM_CREDENTIAL_TYPE = 'oauth'

// The right a person uses on their own research credential.
export const ROLE_OWNER = 'owner'

// Research credentials issued before `environment` was persisted were all
// minted against the hand-built sandbox resources.
const LEGACY_RESEARCH_ENVIRONMENT = 'sandbox'

// The credential type of the gateway subscription every credential is issued as.
export const SUBSCRIPTION_TYPE = 'apim-subscription'

// An attempt that did not finish, and so may be reused by a retry.
export const UNFINISHED_STATUSES = ['pending', 'failed']

export const TEAM_CREDENTIAL_FILTER = {
  tier: 'team',
  credentialType: TEAM_CREDENTIAL_TYPE
}

const REVOKED_MESSAGE = 'Credential has been revoked'
const REVOKED_CODE = 'credential-revoked'

/**
 * The `credentials` collection.
 * @param {import('mongodb').Db} db
 */
export function credentialsCollection(db) {
  return db.collection('credentials')
}

/**
 * The environment a credential was issued in. Every lifecycle call (renew,
 * rotate, revoke, suspend, reveal, vault) reads this, never the current
 * `research.environment`, so a credential issued before a move still acts on
 * the resources that hold it. Falls back for a research document the
 * `2026-10-20-research-credentials-environment` backfill has not reached yet;
 * remove the fallback once it has run in every environment.
 * @param {{tier?: string, environment?: string|null}} credential
 * @returns {string|null}
 */
export function environmentOf(credential) {
  return (
    credential.environment ??
    (credential.tier === 'research' ? LEGACY_RESEARCH_ENVIRONMENT : null)
  )
}

/**
 * Mongo filter that scopes a research credential lookup to one environment,
 * counting a document with no `environment` as the legacy `sandbox` one, so a
 * key left in an old environment never blocks issuing into the new one.
 * @param {string} environment
 * @returns {object}
 */
export function researchEnvironmentFilter(environment) {
  return environment === LEGACY_RESEARCH_ENVIRONMENT
    ? {
        $or: [
          { environment },
          { environment: null },
          { environment: { $exists: false } }
        ]
      }
    : { environment }
}

/**
 * Reads the provider-neutral gateway subscription id, falling back to the
 * pre-rename `apimSubscriptionId` field for documents the backfill hasn't
 * reached yet (see `src/common/backfills/registry.js`). Exported so
 * `maintenance-service.js` reads the same fallback, not a second copy of it.
 * @param {object} credential
 */
export function externalGatewaySubscriptionIdOf(credential) {
  return (
    credential.externalGatewaySubscriptionId ?? credential.apimSubscriptionId
  )
}

/**
 * The lock every action on one credential row takes (issuing, renewing,
 * rotating, revoking, expiring, reconciling its vault secret). Named from the
 * id's canonical hex form, so a request that spells the same id in upper case
 * contends for the same lock.
 * @param {string|import('mongodb').ObjectId} id
 * @returns {string}
 */
export function credentialLockName(id) {
  return `credential:${ObjectId.isValid(id) ? new ObjectId(id).toHexString() : id}`
}

/**
 * A revoked credential cannot be renewed, rotated or revealed: refused as
 * `409 credential-revoked`.
 * @param {{status: string}} credential
 */
export function assertNotRevoked(credential) {
  if (credential.status === 'revoked') {
    throw boomWithCode(Boom.conflict, REVOKED_MESSAGE, REVOKED_CODE)
  }
}

/**
 * The gateway issuer for a model, with an issuer that is not enabled here
 * reported as `501 gateway-not-enabled`.
 */
export function resolveIssuer(registry, model, tier) {
  try {
    return registry.forModel(model, tier)
  } catch (error) {
    if (error.code === 'gateway-not-enabled') {
      throw boomWithCode(
        Boom.notImplemented,
        'This model is not available through any gateway enabled in this environment',
        'gateway-not-enabled'
      )
    }

    throw error
  }
}

// Who an issuance audit names: the person whose request issued the credential,
// acting with the owner's right, or, when no request did (a team's credential
// issued as its first model turns active), the system, whose role the audit
// service records. The person the credential is for is on the credential.
export function issuanceAuditActor(actor) {
  return actor ? { actor, role: ROLE_OWNER } : { actor: systemActor }
}

// Runs `work` holding the lock `revokeCredential` takes on the credential
// row (`credential:{id}`), so an admin cannot revoke a row while it is being
// issued and have the issuance write `active` over the revocation. A row
// being retried is locked, then read again: if it has been revoked since it
// was found, a fresh row is made instead, and that row's id is locked before
// the row exists, so it is never visible unlocked.
export async function withCredentialRow(db, locker, unfinished, work) {
  const rowId = unfinished?._id ?? new ObjectId()
  const lock = await requireLock(locker, credentialLockName(rowId))

  try {
    const reusable = unfinished
      ? await credentialsCollection(db).findOne({
          _id: rowId,
          status: { $in: UNFINISHED_STATUSES }
        })
      : null

    if (!unfinished || reusable) {
      return await work({ reusable, rowId })
    }

    const freshId = new ObjectId()
    const freshLock = await requireLock(locker, credentialLockName(freshId))

    try {
      return await work({ reusable: null, rowId: freshId })
    } finally {
      await freshLock.free()
    }
  } finally {
    await lock.free()
  }
}

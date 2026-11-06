import { ObjectId } from 'mongodb'

import { config } from '#/config.js'
import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { findModelBySlug } from '#/services/models-service.js'
import { isResearchEligible } from '#/services/catalogue-service.js'
import { readResearchDeployments } from '#/services/research-deployments.js'
import { credentialIssuerRegistry } from '#/adapters/credential-issuer-registry.js'
import { credentialVault } from '#/adapters/credential-vault-registry.js'
import { acquireLockWithRetry } from '#/common/helpers/mongo-lock.js'
import {
  SUBSCRIPTION_TYPE,
  credentialsCollection,
  researchEnvironmentFilter,
  resolveIssuer,
  withCredentialRow
} from '#/services/credential-common.js'
import { issueAndActivate } from '#/services/credential-issuance.js'

const RESEARCH_TIER = 'research'

/**
 * The team of the person's record, if any.
 * @param {import('mongodb').Db} db
 * @param {string} userId
 */
async function findTeamIdForUser(db, userId) {
  if (!ObjectId.isValid(userId)) {
    return null
  }

  const user = await db
    .collection('users')
    .findOne({ _id: new ObjectId(userId) }, { projection: { teamId: 1 } })

  return user?.teamId ?? null
}

/**
 * A research key is issued into the configured research environment; naming a
 * different one is refused, so a caller can never aim the portal's API
 * Management role at an instance this deployment was not set up for.
 * @param {string|undefined} requested
 * @returns {string}
 */
function resolveIssueEnvironment(requested) {
  const researchEnvironment = config.get('research.environment')

  if (requested && requested !== researchEnvironment) {
    throw boomWithCode(
      Boom.forbidden,
      'Research keys are not available in this environment',
      'environment-not-available'
    )
  }

  return researchEnvironment
}

// Eligible in the catalogue is not enough: a key for a model research has not
// deployed would not work.
async function assertResearchModelUsable(model) {
  if (!isResearchEligible(model)) {
    throw boomWithCode(
      Boom.forbidden,
      'Model is not eligible',
      'model-not-eligible'
    )
  }

  if (!(await readResearchDeployments()).has(model.slug)) {
    throw boomWithCode(
      Boom.forbidden,
      'Model is not deployed for research',
      'model-not-deployed'
    )
  }
}

// A person holds one live credential per model and environment: an active one
// is refused, and so is an expired one, which is renewed rather than replaced.
async function assertNoLiveCredential(db, { userId, modelSlug, environment }) {
  const existing = await credentialsCollection(db).findOne({
    userId,
    modelSlug,
    ...researchEnvironmentFilter(environment),
    status: { $in: ['active', 'expired'] }
  })

  if (existing?.status === 'active') {
    throw boomWithCode(
      Boom.conflict,
      'An active credential already exists for this model',
      'active-credential-exists'
    )
  }

  // An expired credential's APIM subscription id is deterministic
  // (sidFor()), so re-issuing would silently reactivate that same
  // subscription under a brand-new credential document/vault secret
  // instead of renewing the existing one - renew() is the correct way
  // to bring it back without fragmenting Key Vault state.
  if (existing?.status === 'expired') {
    throw boomWithCode(
      Boom.conflict,
      'Your credential for this model has expired. Renew it instead of requesting a new one.',
      'credential-expired-use-renew'
    )
  }
}

async function buildPendingCredential(
  db,
  { actor, modelSlug, purpose, idempotencyKey, environment },
  { model, issuerKey }
) {
  const { userId } = actor

  return {
    userId,
    teamId: await findTeamIdForUser(db, userId),
    modelSlug,
    tier: RESEARCH_TIER,
    environment,
    purpose: purpose || null,
    type: SUBSCRIPTION_TYPE,
    status: 'pending',
    idempotencyKey,
    issuerKey,
    // Catalogue snapshot at issue time, so "which cloud/gateway is this
    // credential for" needs no join. `gateway` is what the catalogue said at
    // issue time; `issuerKey` is which issuer actually minted it - they
    // differ in `mock` mode or a `mockTiers` tier.
    provider: model.provider ?? null,
    offering: model.offering ?? null,
    cloud: model.hosting?.cloud ?? null,
    gateway: model.gateway ?? null,
    createdAt: new Date().toISOString(),
    renewalCount: 0
  }
}

// A retry after a failed (or crash-abandoned pending) attempt reuses that
// same document instead of inserting a new one - otherwise every retry of
// the same model request leaves behind another permanent 'failed' row, so
// /manage's "Keys you can use" table fills up with duplicate entries for
// one logical request (none of which can be usefully renewed or revoked,
// since they were never actually issued).
function findUnfinishedResearchCredential(
  db,
  { userId, modelSlug, environment }
) {
  return credentialsCollection(db).findOne({
    userId,
    modelSlug,
    tier: RESEARCH_TIER,
    ...researchEnvironmentFilter(environment),
    status: { $in: ['pending', 'failed'] }
  })
}

async function issueCredentialForParams(
  db,
  locker,
  params,
  registry = credentialIssuerRegistry,
  vault = credentialVault
) {
  const { actor, modelSlug, idempotencyKey, environment } = params
  const { userId } = actor
  const existing = await credentialsCollection(db).findOne({
    userId,
    idempotencyKey
  })

  if (existing) {
    return { credential: existing, replay: true }
  }

  const model = await findModelBySlug(db, modelSlug)

  await assertResearchModelUsable(model)

  const { issuerKey, issuer } = resolveIssuer(registry, model, RESEARCH_TIER)

  await assertNoLiveCredential(db, { userId, modelSlug, environment })

  const pending = await buildPendingCredential(db, params, { model, issuerKey })
  const unfinished = await findUnfinishedResearchCredential(db, {
    userId,
    modelSlug,
    environment
  })

  // Held from before the row exists until its secret is stored, so neither a
  // revocation nor a reconciliation of the vault marker can act on a
  // credential still being issued.
  return withCredentialRow(
    db,
    locker,
    unfinished,
    async ({ reusable, rowId }) => {
      const { credential, secret } = await issueAndActivate(db, vault, {
        issuer,
        pending,
        reusable,
        insertId: rowId,
        actor,
        issueParams: {
          userId,
          modelSlug,
          tier: RESEARCH_TIER,
          teamId: pending.teamId,
          environment
        }
      })

      return { credential, secret }
    }
  )
}

/**
 * Issues a research credential (a personal subscription key), or replays the
 * result of a prior call with the same Idempotency-Key. A team's credential
 * is never issued here: it is created when the team's first deployment in
 * an environment turns `active` (`ensureTeamCredential`).
 *
 * Note: the secret is never persisted, so a replayed idempotent request
 * returns the credential without a secret — this matches "the key is shown
 * once" from the spec, at the cost of not being able to replay the secret
 * itself on retry.
 *
 * Refused as `403 model-not-eligible` when the catalogue does not offer the
 * model to research, `403 model-not-deployed` when it does but the research
 * environment has not deployed it, and `502 research-deployments-unavailable`
 * when the deployed models cannot be read.
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {{actor: {userId: string}, modelSlug: string, purpose?: string, idempotencyKey: string, environment?: string}} params - `actor` is the token's credentials
 * @param {import('#/adapters/credential-issuer-registry.js').CredentialIssuerRegistry} [registry]
 * @param {import('#/adapters/credential-vault.js').CredentialVault} [vault]
 */
export async function issueCredential(
  db,
  locker,
  params,
  registry = credentialIssuerRegistry,
  vault = credentialVault
) {
  const { modelSlug } = params
  const { userId } = params.actor
  const environment = resolveIssueEnvironment(params.environment)

  // Guards the check-for-reusable-pending/failed-doc-then-write below
  // (see issueCredentialForParams): without it, two concurrent requests
  // for the same user+model could both reuse and overwrite one shared
  // document with two different attempts' results.
  const lock = await acquireLockWithRetry(
    locker,
    `research-credential:${userId}:${modelSlug}`
  )

  try {
    return await issueCredentialForParams(
      db,
      locker,
      { ...params, environment },
      registry,
      vault
    )
  } finally {
    await lock.free()
  }
}

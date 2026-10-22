import { ObjectId } from 'mongodb'

import { config } from '#/config.js'
import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { findModelBySlug } from '#/services/models-service.js'
import { isResearchEligible } from '#/services/catalogue-service.js'
import { credentialIssuerRegistry } from '#/adapters/credential-issuer-registry.js'
import { credentialVault } from '#/adapters/credential-vault-registry.js'
import { recordAuditEvent } from '#/services/audit-service.js'
import {
  requireLock,
  acquireLockWithRetry
} from '#/common/helpers/mongo-lock.js'
import { grantedModelSlugs } from '#/services/team-deployment-gateway.js'
import { getMemberRole } from '#/services/team-service.js'

// The team tier is OAuth only - a client secret or a federated credential,
// local development included. Research credentials are subscription keys.
// A team's one credential per environment is created when its first model
// there turns active (`ensureTeamCredential`), never by a request.
const TEAM_CREDENTIAL_TYPE = 'oauth'

// Research credentials issued before `environment` was persisted were all
// minted against the hand-built sandbox resources.
const LEGACY_RESEARCH_ENVIRONMENT = 'sandbox'

/**
 * Best-effort lookup of a user's team, tolerant of the day-1 interim trust
 * model where `x-user-id` is an unverified, caller-asserted value that may
 * not match a real `users._id`.
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
function researchEnvironmentFilter(environment) {
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
      expiresOn: credential.expiresAt
        ? new Date(credential.expiresAt)
        : undefined
    })

    if (credential.vaultState === 'unwritten') {
      await db
        .collection('credentials')
        .updateOne({ _id: credential._id }, { $unset: { vaultState: '' } })
    }

    return true
  } catch {
    await db
      .collection('credentials')
      .updateOne({ _id: credential._id }, { $set: { vaultState: 'unwritten' } })

    return false
  }
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
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {{userId: string, modelSlug: string, purpose?: string, idempotencyKey: string, environment?: string}} params
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
  const { userId, modelSlug } = params
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

/**
 * The gateway issuer for a model, with an issuer that is not enabled here
 * reported as `501 gateway-not-enabled`.
 */
function resolveIssuer(registry, model, tier) {
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

/**
 * Writes the pending document (or resets the one being retried), asks the
 * issuer for the secret, then activates the document, puts the secret in the
 * vault and audits it. A failing issuer leaves the document `failed`. The
 * caller decides who sees the secret.
 */
async function issueAndActivate(
  db,
  vault,
  { issuer, pending, reusable, insertId, issueParams, expiresAt }
) {
  let insertedId
  if (reusable) {
    insertedId = reusable._id
    await db
      .collection('credentials')
      .updateOne(
        { _id: insertedId },
        { $set: pending, $unset: { failureReason: '' } }
      )
  } else {
    ;({ insertedId } = await db
      .collection('credentials')
      .insertOne(insertId ? { _id: insertId, ...pending } : pending))
  }

  let issued
  try {
    issued = await issuer.issue(issueParams)
  } catch {
    await db
      .collection('credentials')
      .updateOne(
        { _id: insertedId },
        { $set: { status: 'failed', failureReason: 'issuer-error' } }
      )
    await recordAuditEvent(db, {
      actorUserId: pending.userId,
      action: 'credential.issue',
      resource: 'credential',
      resourceId: insertedId.toString(),
      outcome: 'failure',
      code: 'upstream-unavailable'
    })

    throw boomWithCode(
      Boom.badGateway,
      'Failed to issue credential',
      'upstream-unavailable'
    )
  }

  // `vaultState: unwritten` is stored with the activation and cleared once
  // the secret is in the vault, so a stop between the two leaves a marker
  // for `reconcilePendingCredentials`, never an active credential whose
  // secret is nowhere.
  const active = {
    status: 'active',
    externalGatewaySubscriptionId: issued.externalId,
    keyHint: issued.keyHint,
    activatedAt: pending.createdAt,
    expiresAt: expiresAt === undefined ? issued.expiresAt : expiresAt,
    vaultState: 'unwritten'
  }

  await db
    .collection('credentials')
    .updateOne({ _id: insertedId }, { $set: active })

  const unsettled = { _id: insertedId, ...pending, ...active }

  const vaultWritten = await writeSecretToVault(
    db,
    vault,
    unsettled,
    issued.secret
  )
  const credential = vaultWritten
    ? { ...unsettled, vaultState: undefined }
    : unsettled

  await recordAuditEvent(db, {
    actorUserId: pending.userId,
    action: 'credential.issue',
    resource: 'credential',
    resourceId: insertedId.toString(),
    outcome: 'success'
  })

  return { credential, secret: issued.secret, vaultWritten }
}

async function issueCredentialForParams(
  db,
  locker,
  { userId, modelSlug, purpose, idempotencyKey, environment },
  registry = credentialIssuerRegistry,
  vault = credentialVault
) {
  const existing = await db
    .collection('credentials')
    .findOne({ userId, idempotencyKey })

  if (existing) {
    return { credential: existing, secret: undefined, replay: true }
  }

  const model = await findModelBySlug(db, modelSlug)

  if (!isResearchEligible(model)) {
    throw boomWithCode(
      Boom.forbidden,
      'Model is not eligible',
      'model-not-eligible'
    )
  }

  const { issuerKey, issuer } = resolveIssuer(registry, model, 'research')

  const existingCredential = await db.collection('credentials').findOne({
    userId,
    modelSlug,
    ...researchEnvironmentFilter(environment),
    status: { $in: ['active', 'expired'] }
  })

  if (existingCredential?.status === 'active') {
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
  if (existingCredential?.status === 'expired') {
    throw boomWithCode(
      Boom.conflict,
      'Your credential for this model has expired. Renew it instead of requesting a new one.',
      'credential-expired-use-renew'
    )
  }

  const pending = {
    userId,
    teamId: await findTeamIdForUser(db, userId),
    modelSlug,
    tier: 'research',
    environment,
    purpose: purpose || null,
    type: 'apim-subscription',
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

  // A retry after a failed (or crash-abandoned pending) attempt reuses that
  // same document instead of inserting a new one - otherwise every retry of
  // the same model request leaves behind another permanent 'failed' row, so
  // /manage's "Keys you can use" table fills up with duplicate entries for
  // one logical request (none of which can be usefully renewed or revoked,
  // since they were never actually issued).
  const unfinished = await db.collection('credentials').findOne({
    userId,
    modelSlug,
    tier: 'research',
    ...researchEnvironmentFilter(environment),
    status: { $in: ['pending', 'failed'] }
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
        issueParams: {
          userId,
          modelSlug,
          tier: 'research',
          teamId: pending.teamId,
          environment
        }
      })

      return { credential, secret }
    }
  )
}

const TEAM_CREDENTIAL_FILTER = {
  tier: 'team',
  credentialType: TEAM_CREDENTIAL_TYPE
}

/**
 * Makes sure a team has its credential for an environment once one of its
 * models is `active` there: nothing happens if it already holds an active
 * one (the model is already covered, because coverage is the team's live
 * grants - see `withTeamGrants`), otherwise the credential is created and
 * its secret goes straight to the vault. The secret is never returned or
 * persisted; an admin reveals it with `revealCredential`. Runs under the
 * lock the team's credential has always had, so concurrent activations
 * create one credential. An attempt that did not finish - failed, abandoned
 * `pending` after a crash, or one that failed before an issuer was even
 * resolved (recorded as a `failed` document with its reason) - is reused
 * rather than left beside a second row.
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {{teamId: string, environment: string, modelSlug: string, requestedBy: string, operationId: string, activatedAt?: string|null, retryAfterMs?: number}} params - `requestedBy` is the person whose request activated the model, recorded as the credential's owner and the audit actor (an unfinished attempt keeps its own). `activatedAt` is when that activation happened: an admin's revocation made after it is respected, checked again inside the lock. `retryAfterMs` marks a retry from a poll rather than the activation itself (see `teamCredentialNeedsRetry`), so polls that raced for the lock cannot repeat an attempt that has just failed
 * @param {import('#/adapters/credential-issuer-registry.js').CredentialIssuerRegistry} [registry]
 * @param {import('#/adapters/credential-vault.js').CredentialVault} [vault]
 * @returns {Promise<{credential: object|null, created: boolean, vaultWritten?: boolean}>} `credential` is null when nothing was owed any longer; `vaultWritten` is false when the credential was created but its secret is not in the vault yet (reconciliation retries it)
 */
export async function ensureTeamCredential(
  db,
  locker,
  {
    teamId,
    environment,
    modelSlug,
    requestedBy,
    operationId,
    retryAfterMs,
    activatedAt
  },
  registry = credentialIssuerRegistry,
  vault = credentialVault
) {
  const lock = await acquireLockWithRetry(
    locker,
    `team-credential:${teamId}:${environment}`
  )

  try {
    const scope = { teamId, environment, ...TEAM_CREDENTIAL_FILTER }
    const active = await db
      .collection('credentials')
      .findOne({ ...scope, status: 'active' })

    if (active) {
      return { credential: active, created: false }
    }

    // The newest attempt that did not finish, if any.
    const unfinished = await db
      .collection('credentials')
      .findOne(
        { ...scope, status: { $in: UNFINISHED_STATUSES } },
        { sort: { createdAt: -1 } }
      )

    return await withCredentialRow(
      db,
      locker,
      unfinished,
      async ({ reusable, rowId }) => {
        const owed = await teamCredentialOwed(
          db,
          { teamId, environment },
          { retryAfterMs, activatedAt }
        )

        if (!owed) {
          return { credential: null, created: false }
        }

        return attemptTeamCredential(
          db,
          vault,
          registry,
          { reusable, rowId },
          { teamId, environment, modelSlug, requestedBy, operationId }
        )
      }
    )
  } finally {
    await lock.free()
  }
}

const UNFINISHED_STATUSES = ['pending', 'failed']

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

// Whether the credential is still owed, read inside the lock: a retry from a
// poll is owed by `teamCredentialNeedsRetry`; the activation itself is owed
// unless an admin revoked the team's latest credential after it, which
// `activatedAt` tells apart from a revocation that came first.
async function teamCredentialOwed(
  db,
  team,
  { retryAfterMs, activatedAt = null }
) {
  if (retryAfterMs !== undefined) {
    return teamCredentialNeedsRetry(db, team, { retryAfterMs, activatedAt })
  }

  const [latest] = await db
    .collection('credentials')
    .find(
      { ...team, ...TEAM_CREDENTIAL_FILTER },
      { projection: { status: 1, revokedAt: 1 } }
    )
    .sort({ createdAt: -1 })
    .toArray()
  const revokedAfterActivation =
    latest?.status === 'revoked' &&
    activatedAt !== null &&
    Boolean(latest.revokedAt) &&
    latest.revokedAt >= activatedAt

  return !revokedAfterActivation
}

// Runs `work` holding the lock `revokeCredential` takes on the credential
// row (`credential:{id}`), so an admin cannot revoke a row while it is being
// issued and have the issuance write `active` over the revocation. A row
// being retried is locked, then read again: if it has been revoked since it
// was found, a fresh row is made instead, and that row's id is locked before
// the row exists, so it is never visible unlocked.
async function withCredentialRow(db, locker, unfinished, work) {
  const rowId = unfinished?._id ?? new ObjectId()
  const lock = await requireLock(locker, credentialLockName(rowId))

  try {
    const reusable = unfinished
      ? await db.collection('credentials').findOne({
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

// One attempt at the credential, on the unfinished document if there is one
// (which keeps its owner and idempotency key, so reusing it can never clash
// with another row's): resolves the issuer, then issues, activates and puts
// the secret in the vault. An attempt that fails before an issuer is
// resolved is recorded.
async function attemptTeamCredential(
  db,
  vault,
  registry,
  { reusable, rowId },
  { teamId, environment, modelSlug, requestedBy, operationId }
) {
  const model = await findModelBySlug(db, modelSlug)
  const userId = reusable?.userId ?? requestedBy
  const pending = {
    userId,
    teamId,
    modelSlug: null,
    credentialType: TEAM_CREDENTIAL_TYPE,
    tier: 'team',
    environment,
    purpose: null,
    type: 'apim-subscription',
    status: 'pending',
    idempotencyKey:
      reusable?.idempotencyKey ?? `team-activation:${operationId}`,
    issuerKey: null,
    // A team credential spans several models, so it records no single
    // provider/offering, only the cloud and gateway of the model that
    // created it.
    provider: null,
    offering: null,
    cloud: model?.hosting?.cloud ?? null,
    gateway: model?.gateway ?? null,
    createdAt: new Date().toISOString(),
    renewalCount: 0
  }

  let resolved
  try {
    resolved = resolveIssuer(registry, model, 'team')
  } catch (error) {
    await recordUnissued(db, { reusable, rowId }, pending, error)
    throw error
  }

  // Shared indefinitely across the team and never renewed (see
  // `renewCredential`'s tier guard), so it has no expiry.
  const { credential, vaultWritten } = await issueAndActivate(db, vault, {
    issuer: resolved.issuer,
    pending: { ...pending, issuerKey: resolved.issuerKey },
    reusable,
    insertId: rowId,
    issueParams: { userId, modelSlug, tier: 'team', teamId, environment },
    expiresAt: null
  })

  return { credential, created: true, vaultWritten }
}

// Keeps a record that an attempt never reached an issuer, so the activation
// can be retried later without recreating a credential an admin revoked.
async function recordUnissued(db, { reusable, rowId }, pending, error) {
  const failed = {
    ...pending,
    status: 'failed',
    failureReason: error.data?.code ?? 'issuer-unavailable'
  }

  if (reusable) {
    await db
      .collection('credentials')
      .updateOne({ _id: reusable._id }, { $set: failed })
  } else {
    await db.collection('credentials').insertOne({ _id: rowId, ...failed })
  }
}

/**
 * Whether a team's credential for an environment still needs creating even
 * though one of its models is active there: nothing is active and either no
 * attempt has been recorded, or the latest one did not finish (`failed`, or
 * `pending` after a crash) at least `retryAfterMs` ago, or the latest one was
 * revoked before the newest activation (`activatedAt`), whose own issuance
 * therefore never started. Only the latest attempt counts, so an old failure
 * never undoes a later revocation, and a credential an admin revoked after
 * the last activation is not recreated by a poll, only by a later activation.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, environment: string}} team
 * @param {{retryAfterMs?: number, activatedAt?: string|null}} [options] - `retryAfterMs`: how long after an attempt a retry waits, so a persistent failure is not retried on every poll; `activatedAt`: when the team's newest active deployment activated
 * @returns {Promise<boolean>}
 */
export async function teamCredentialNeedsRetry(
  db,
  { teamId, environment },
  { retryAfterMs = 0, activatedAt = null } = {}
) {
  const attempts = await db
    .collection('credentials')
    .find(
      { teamId, environment, ...TEAM_CREDENTIAL_FILTER },
      { projection: { status: 1, createdAt: 1, revokedAt: 1 } }
    )
    .sort({ createdAt: -1 })
    .toArray()
  const cutoff = new Date(Date.now() - retryAfterMs).toISOString()

  if (attempts.some(({ status }) => status === 'active')) {
    return false
  }

  const [latest] = attempts

  if (latest === undefined) {
    return true
  }

  if (UNFINISHED_STATUSES.includes(latest.status)) {
    return latest.createdAt <= cutoff
  }

  return (
    latest.status === 'revoked' &&
    activatedAt !== null &&
    Boolean(latest.revokedAt) &&
    latest.revokedAt < activatedAt
  )
}

/**
 * Marks a credential `expired` if its `expiresAt` has passed, auditing the transition.
 * @param {import('mongodb').Db} db
 * @param {object} credential
 */
async function applyLazyExpiry(db, credential) {
  if (
    credential.status !== 'active' ||
    !credential.expiresAt ||
    new Date(credential.expiresAt) > new Date()
  ) {
    return credential
  }

  await db
    .collection('credentials')
    .updateOne({ _id: credential._id }, { $set: { status: 'expired' } })

  await recordAuditEvent(db, {
    actorUserId: credential.userId,
    action: 'credential.expire',
    resource: 'credential',
    resourceId: credential._id.toString(),
    outcome: 'success'
  })

  return { ...credential, status: 'expired' }
}

/**
 * Adds the derived `renewalsRemaining` allowance field the frontend account page displays.
 * @param {object} credential
 */
function withRenewalsRemaining(credential) {
  return {
    ...credential,
    renewalsRemaining: Math.max(
      0,
      config.get('research.renewalCap') - credential.renewalCount
    )
  }
}

/**
 * Gives a team credential its coverage. While it is active that is the
 * team's live gateway grants for its environment, read from the team's
 * deployments rather than kept as a copy, so a model removed from the team
 * leaves the credential at once; once revoked, it is what was frozen on the
 * record at that moment (`revokeCredential`). A research credential has
 * its one `modelSlug` and is returned as is.
 * @param {import('mongodb').Db} db
 * @param {object} credential
 * @returns {Promise<object>}
 */
async function withTeamGrants(db, credential) {
  if (credential.tier !== 'team' || credential.status !== 'active') {
    return credential
  }

  return {
    ...credential,
    allowedDeployments: await grantedModelSlugs(db, credential)
  }
}

// How every credential leaves the service: lazily expired, with its
// allowance and, for a team's, its coverage.
async function presentCredential(db, credential) {
  return withTeamGrants(
    db,
    withRenewalsRemaining(await applyLazyExpiry(db, credential))
  )
}

/**
 * Lists a user's own credentials plus any shared team credentials for teams
 * they're an active member of (never includes secrets), applying lazy expiry.
 * @param {import('mongodb').Db} db
 * @param {{userId: string}} params
 */
export async function listCredentials(db, { userId }) {
  const memberships = await db
    .collection('teamMembers')
    .find({ userId, status: 'active' })
    .toArray()

  const teamIds = memberships.map((membership) => membership.teamId)

  // The membership side is restricted to tier:'team' because research
  // credentials also persist a teamId - without it a teammate's personal
  // credential would be listed as if it were shared.
  const query =
    teamIds.length > 0
      ? { $or: [{ userId }, { teamId: { $in: teamIds }, tier: 'team' }] }
      : { userId }

  const items = await db.collection('credentials').find(query).toArray()

  return Promise.all(items.map((item) => presentCredential(db, item)))
}

/**
 * Finds one of a user's own credentials by id, applying lazy expiry.
 * Returns null for another user's credential id, matching the spec's 404 behaviour.
 * @param {import('mongodb').Db} db
 * @param {{id: string, userId: string}} params
 */
export async function findCredentialForUser(db, { id, userId }) {
  if (!ObjectId.isValid(id)) {
    return null
  }

  const credential = await db
    .collection('credentials')
    .findOne({ _id: new ObjectId(id), userId })

  if (!credential) {
    return null
  }

  return presentCredential(db, credential)
}

/**
 * Finds a credential for read-only viewing - a user's own credential, OR a
 * shared team credential for a team they're an active member of (mirrors
 * `listCredentials`' access rule). Used only by the GET-by-id route; renew
 * stays owner-only via `findCredentialForUser` above (team credentials
 * don't renew as a concept - they don't expire on the research TTL/cap).
 * Rotate/revoke use the role-aware `loadCredentialForAction` below instead,
 * since any admin member (not just the original requester) may act on a
 * shared team credential.
 * @param {import('mongodb').Db} db
 * @param {{id: string, userId: string}} params
 */
export async function findCredentialForViewing(db, { id, userId }) {
  if (!ObjectId.isValid(id)) {
    return null
  }

  const memberships = await db
    .collection('teamMembers')
    .find({ userId, status: 'active' })
    .toArray()

  const teamIds = memberships.map((membership) => membership.teamId)

  const query =
    teamIds.length > 0
      ? {
          _id: new ObjectId(id),
          $or: [{ userId }, { teamId: { $in: teamIds }, tier: 'team' }]
        }
      : { _id: new ObjectId(id), userId }

  const credential = await db.collection('credentials').findOne(query)

  if (!credential) {
    return null
  }

  return presentCredential(db, credential)
}

/**
 * Loads a credential for an admin-gated action (rotate/revoke) - the
 * requester need not be the original requester, only an active member of
 * the credential's team (research credentials, `teamId: null`, stay
 * owner-only). Returns null (not 403) for a non-member/non-owner so
 * existence isn't disclosed; the caller's role is attached as `actorRole`
 * for `requireAdminForTeamCredential` to check.
 * @param {import('mongodb').Db} db
 * @param {{id: string, userId: string}} params
 */
async function loadCredentialForAction(db, { id, userId }) {
  if (!ObjectId.isValid(id)) {
    return null
  }

  const credential = await db
    .collection('credentials')
    .findOne({ _id: new ObjectId(id) })

  if (!credential) {
    return null
  }

  if (credential.tier !== 'team') {
    return credential.userId === userId ? credential : null
  }

  const role = await getMemberRole(db, { teamId: credential.teamId, userId })

  return role ? { ...credential, actorRole: role } : null
}

/**
 * Only a team admin may rotate or revoke a shared team credential; a
 * `user`-role member may still view it. Research credentials (`teamId:
 * null`) are unaffected - they stay self-service, checked by
 * `loadCredentialForAction` returning null for anyone but the owner.
 * @param {object} credential
 */
function requireAdminForTeamCredential(credential) {
  if (credential.tier === 'team' && credential.actorRole !== 'admin') {
    throw boomWithCode(
      Boom.forbidden,
      'Only a team admin can do this',
      'admin-required'
    )
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
 * @param {{id: string, userId: string}} params
 * @param {import('#/adapters/credential-issuer-registry.js').CredentialIssuerRegistry} [registry]
 * @param {import('#/adapters/credential-vault.js').CredentialVault} [vault]
 */
export async function renewCredential(
  db,
  locker,
  { id, userId },
  registry = credentialIssuerRegistry,
  vault = credentialVault
) {
  const lock = await requireLock(locker, credentialLockName(id))

  try {
    const credential = await findCredentialForUser(db, { id, userId })

    if (!credential) {
      throw Boom.notFound()
    }

    if (credential.tier === 'team') {
      throw boomWithCode(
        Boom.badRequest,
        'Team credentials do not expire and cannot be renewed',
        'team-credential-no-renewal'
      )
    }

    if (credential.status === 'revoked') {
      throw boomWithCode(
        Boom.conflict,
        'Credential has been revoked',
        'credential-revoked'
      )
    }

    if (credential.renewalCount >= config.get('research.renewalCap')) {
      throw boomWithCode(
        Boom.forbidden,
        'Renewal cap reached for this credential',
        'renewal-cap-reached'
      )
    }

    const ttlDays = config.get('research.credentialTtlDays')
    const expiresAt = new Date(
      Date.now() + ttlDays * 24 * 60 * 60 * 1000
    ).toISOString()

    // Always pushed to APIM (not just when already-expired) so
    // context.Subscription.EndDate never drifts behind Mongo's expiresAt -
    // see apim-credential-issuer.js's renew().
    const { issuer } = registry.forCredential(credential)
    await issuer.renew({
      externalId: externalGatewaySubscriptionIdOf(credential),
      expiresAt,
      environment: environmentOf(credential)
    })

    const updated = await db.collection('credentials').findOneAndUpdate(
      { _id: credential._id },
      {
        $set: { status: 'active', expiresAt },
        $inc: { renewalCount: 1 }
      },
      { returnDocument: 'after' }
    )

    try {
      await vault.updateExpiry({
        credentialId: id,
        issuerKey: credential.issuerKey,
        environment: environmentOf(credential),
        expiresOn: new Date(expiresAt)
      })

      if (updated.vaultState === 'unwritten') {
        await db
          .collection('credentials')
          .updateOne({ _id: credential._id }, { $unset: { vaultState: '' } })
      }
    } catch {
      await db
        .collection('credentials')
        .updateOne(
          { _id: credential._id },
          { $set: { vaultState: 'unwritten' } }
        )
      updated.vaultState = 'unwritten'
    }

    await recordAuditEvent(db, {
      actorUserId: userId,
      action: 'credential.renew',
      resource: 'credential',
      resourceId: id,
      outcome: 'success'
    })

    return withRenewalsRemaining(updated)
  } finally {
    await lock.free()
  }
}

/**
 * Rotates a credential's secret in place, keeping its existing
 * `expiresAt`/policy - distinct from `renewCredential`, which extends
 * expiry. Team credentials require the requester to be an admin member
 * (`admin-required`); research credentials stay self-service. No
 * overlap/grace window in this slice - the old secret is invalidated
 * immediately.
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {{id: string, userId: string}} params
 * @param {import('#/adapters/credential-issuer-registry.js').CredentialIssuerRegistry} [registry]
 * @param {import('#/adapters/credential-vault.js').CredentialVault} [vault]
 */
export async function rotateCredential(
  db,
  locker,
  { id, userId },
  registry = credentialIssuerRegistry,
  vault = credentialVault
) {
  const lock = await requireLock(locker, credentialLockName(id))

  try {
    const credential = await loadCredentialForAction(db, { id, userId })

    if (!credential) {
      throw Boom.notFound()
    }

    requireAdminForTeamCredential(credential)

    if (credential.status === 'revoked') {
      throw boomWithCode(
        Boom.conflict,
        'Credential has been revoked',
        'credential-revoked'
      )
    }

    const { issuer } = registry.forCredential(credential)
    const rotated = await issuer.rotate({
      externalId: externalGatewaySubscriptionIdOf(credential),
      environment: environmentOf(credential)
    })

    const now = new Date().toISOString()
    const updated = await db
      .collection('credentials')
      .findOneAndUpdate(
        { _id: credential._id },
        { $set: { keyHint: rotated.keyHint, rotatedAt: now } },
        { returnDocument: 'after' }
      )

    // Creates a new Key Vault version; the old version stays recoverable
    // inside the 90-day soft-delete window.
    await writeSecretToVault(db, vault, updated, rotated.secret)

    await recordAuditEvent(db, {
      actorUserId: userId,
      action: 'credential.rotate',
      resource: 'credential',
      resourceId: id,
      outcome: 'success'
    })

    return {
      credential: await withTeamGrants(db, withRenewalsRemaining(updated)),
      secret: rotated.secret
    }
  } finally {
    await lock.free()
  }
}

/**
 * Revokes a credential, deleting its APIM subscription. A team credential
 * may be revoked by any admin member of that team, not only whoever
 * originally requested it.
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {{id: string, userId: string}} params
 * @param {import('#/adapters/credential-issuer-registry.js').CredentialIssuerRegistry} [registry]
 * @param {import('#/adapters/credential-vault.js').CredentialVault} [vault]
 */
export async function revokeCredential(
  db,
  locker,
  { id, userId },
  registry = credentialIssuerRegistry,
  vault = credentialVault
) {
  const lock = await requireLock(locker, credentialLockName(id))

  try {
    const credential = await loadCredentialForAction(db, { id, userId })

    if (!credential) {
      throw Boom.notFound()
    }

    requireAdminForTeamCredential(credential)

    if (credential.status === 'revoked') {
      return credential
    }

    const { issuer } = registry.forCredential(credential)
    await issuer.revoke({
      externalId: externalGatewaySubscriptionIdOf(credential),
      environment: environmentOf(credential)
    })

    // Soft-deletes for 90 days. Best-effort: the credential is already
    // revoked in APIM, which is the access control that matters - a vault
    // write failure here is hygiene, not a security hole.
    try {
      await vault.remove({
        credentialId: credential._id.toString(),
        issuerKey: credential.issuerKey,
        environment: environmentOf(credential)
      })
    } catch {
      // intentionally swallowed, see comment above
    }

    const now = new Date().toISOString()
    // The record keeps what the credential covered when it was revoked,
    // since a revoked credential no longer follows the team's grants.
    const covered =
      credential.tier === 'team'
        ? { allowedDeployments: await grantedModelSlugs(db, credential) }
        : {}
    const updated = await db.collection('credentials').findOneAndUpdate(
      { _id: credential._id },
      {
        $set: {
          status: 'revoked',
          revokedAt: now,
          revokedReason: 'user-requested',
          ...covered
        }
      },
      { returnDocument: 'after' }
    )

    await recordAuditEvent(db, {
      actorUserId: userId,
      action: 'credential.revoke',
      resource: 'credential',
      resourceId: id,
      outcome: 'success'
    })

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
 * only for a team credential (`admin-required`). A platform-operator
 * override is also in the design pack, but no such role exists anywhere
 * else in this codebase yet (no operator collection/flag) - deferred until
 * that lands rather than invented here.
 * @param {import('mongodb').Db} db
 * @param {{id: string, actorUserId: string, reason: string}} params
 * @param {import('#/adapters/credential-vault.js').CredentialVault} [vault]
 */
export async function revealCredential(
  db,
  { id, actorUserId, reason },
  vault = credentialVault
) {
  const credential = await loadCredentialForAction(db, {
    id,
    userId: actorUserId
  })

  if (!credential) {
    throw Boom.notFound()
  }

  requireAdminForTeamCredential(credential)

  if (credential.status === 'revoked') {
    throw boomWithCode(
      Boom.conflict,
      'Credential has been revoked',
      'credential-revoked'
    )
  }

  if (credential.status === 'failed' || credential.vaultState === 'unwritten') {
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

  await recordAuditEvent(db, {
    actorUserId,
    action: 'credential.reveal',
    resource: 'credential',
    resourceId: id,
    outcome: 'success',
    reason
  })

  return secret
}

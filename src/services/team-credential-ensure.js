import { findModelBySlug } from '#/services/models-service.js'
import { credentialIssuerRegistry } from '#/adapters/credential-issuer-registry.js'
import { credentialVault } from '#/adapters/credential-vault-registry.js'
import { acquireLockWithRetry } from '#/common/helpers/mongo-lock.js'
import {
  NOT_AN_UNFINISHED_ADDITION,
  SUBSCRIPTION_TYPE,
  TEAM_CREDENTIAL_FILTER,
  TEAM_CREDENTIAL_TYPE,
  UNFINISHED_STATUSES,
  credentialsCollection,
  resolveIssuer,
  withCredentialRow
} from '#/services/credential-common.js'
import { issueAndActivate } from '#/services/credential-issuance.js'
import { clientSecretsAllowedIn } from '#/services/team-oauth-block.js'

const TEAM_TIER = 'team'

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
  // Never owed where client secrets are not allowed.
  if (!clientSecretsAllowedIn(environment)) {
    return false
  }

  const attempts = await credentialsCollection(db)
    .find(
      {
        teamId,
        environment,
        ...TEAM_CREDENTIAL_FILTER,
        ...NOT_AN_UNFINISHED_ADDITION
      },
      { projection: { status: 1, createdAt: 1, revokedAt: 1 } }
    )
    .sort({ createdAt: -1 })
    .toArray()
  const cutoff = new Date(Date.now() - retryAfterMs).toISOString()

  if (attempts.some(({ status }) => status === 'active')) {
    return false
  }

  const [latest] = attempts

  if (!latest) {
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

// Whether the credential is still owed, read inside the lock: a retry from a
// poll is owed by `teamCredentialNeedsRetry`; the activation itself is owed
// unless an admin revoked the team's latest credential after it, which
// `activatedAt` tells apart from a revocation that came first.
async function teamCredentialOwed(
  db,
  team,
  { retryAfterMs, activatedAt = null }
) {
  if (typeof retryAfterMs === 'number') {
    return teamCredentialNeedsRetry(db, team, { retryAfterMs, activatedAt })
  }

  const [latest] = await credentialsCollection(db)
    .find(
      { ...team, ...TEAM_CREDENTIAL_FILTER, ...NOT_AN_UNFINISHED_ADDITION },
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

// Keeps a record that an attempt never reached an issuer, so the activation
// can be retried later without recreating a credential an admin revoked.
async function recordUnissued(db, { reusable, rowId }, pending, error) {
  const failed = {
    ...pending,
    status: 'failed',
    failureReason: error.data?.code ?? 'issuer-unavailable'
  }

  if (reusable) {
    await credentialsCollection(db).updateOne(
      { _id: reusable._id },
      { $set: failed }
    )
  } else {
    await credentialsCollection(db).insertOne({ _id: rowId, ...failed })
  }
}

function buildPendingTeamCredential(
  { reusable, model },
  { teamId, environment, requestedBy, operationId }
) {
  return {
    userId: reusable?.userId ?? requestedBy,
    teamId,
    modelSlug: null,
    credentialType: TEAM_CREDENTIAL_TYPE,
    tier: TEAM_TIER,
    environment,
    purpose: null,
    type: SUBSCRIPTION_TYPE,
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
  request
) {
  const { teamId, environment, modelSlug } = request
  const model = await findModelBySlug(db, modelSlug)
  const pending = buildPendingTeamCredential({ reusable, model }, request)

  let resolved
  try {
    resolved = resolveIssuer(registry, model, TEAM_TIER)
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
    issueParams: {
      userId: pending.userId,
      modelSlug,
      tier: TEAM_TIER,
      teamId,
      environment
    },
    noExpiry: true
  })

  return { credential, created: true, vaultWritten }
}

// The work done under the credential row's lock: nothing if the credential is
// no longer owed, otherwise one attempt at it.
async function createTeamCredentialIfOwed(
  db,
  { vault, registry, row, request, options }
) {
  const { teamId, environment } = request
  const owed = await teamCredentialOwed(db, { teamId, environment }, options)

  if (!owed) {
    return { credential: null, created: false }
  }

  return attemptTeamCredential(db, vault, registry, row, request)
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
 * rather than left beside a second row. Nothing is created where client
 * secrets are not allowed (`CLIENT_SECRET_ENVIRONMENTS`).
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {{teamId: string, environment: string, modelSlug: string, requestedBy: string, operationId: string, activatedAt?: string|null, retryAfterMs?: number}} params - `requestedBy` is the person whose request activated the model, recorded as the credential's owner (an unfinished attempt keeps its own); the issuance audit names the system, not that person. `activatedAt` is when that activation happened: an admin's revocation made after it is respected, checked again inside the lock. `retryAfterMs` marks a retry from a poll rather than the activation itself (see `teamCredentialNeedsRetry`), so polls that raced for the lock cannot repeat an attempt that has just failed
 * @param {import('#/adapters/credential-issuer-registry.js').CredentialIssuerRegistry} [registry]
 * @param {import('#/adapters/credential-vault.js').CredentialVault} [vault]
 * @returns {Promise<{credential: object|null, created: boolean, vaultWritten?: boolean}>} `credential` is null when nothing was owed any longer; `vaultWritten` is false when the credential was created but its secret is not in the vault yet (reconciliation retries it)
 */
export async function ensureTeamCredential(
  db,
  locker,
  { retryAfterMs, activatedAt, ...request },
  registry = credentialIssuerRegistry,
  vault = credentialVault
) {
  const { teamId, environment } = request

  // The team's secret is made only where client secrets are allowed: elsewhere
  // its applications federate and an Admin adds nothing (design E, choice A).
  if (!clientSecretsAllowedIn(environment)) {
    return { credential: null, created: false }
  }

  const lock = await acquireLockWithRetry(
    locker,
    `team-credential:${teamId}:${environment}`
  )

  try {
    const scope = { teamId, environment, ...TEAM_CREDENTIAL_FILTER }
    const active = await credentialsCollection(db).findOne({
      ...scope,
      status: 'active'
    })

    if (active) {
      return { credential: active, created: false }
    }

    // The newest attempt that did not finish, if any: never an Admin's
    // addition, which would come out of here with no expiry.
    const unfinished = await credentialsCollection(db).findOne(
      {
        ...scope,
        ...NOT_AN_UNFINISHED_ADDITION,
        status: { $in: UNFINISHED_STATUSES }
      },
      { sort: { createdAt: -1 } }
    )

    return await withCredentialRow(db, locker, unfinished, (row) =>
      createTeamCredentialIfOwed(db, {
        vault,
        registry,
        row,
        request,
        options: { retryAfterMs, activatedAt }
      })
    )
  } finally {
    await lock.free()
  }
}

import { ObjectId } from 'mongodb'

import { config } from '#/config.js'
import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { findModelBySlug } from '#/services/models-service.js'
import { credentialIssuerRegistry } from '#/adapters/credential-issuer-registry.js'
import { credentialVault } from '#/adapters/credential-vault-registry.js'
import { recordAuditEvent } from '#/services/audit-service.js'
import {
  requireLock,
  acquireLockWithRetry
} from '#/common/helpers/mongo-lock.js'
import {
  findActiveDeployment,
  grantedModelSlugs
} from '#/services/team-deployment-gateway.js'
import { getMemberRole } from '#/services/team-service.js'

// The team tier is OAuth only - a client secret or a federated credential,
// local development included. Research credentials are subscription keys.
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
 * Issues a Research or Team tier credential, or replays the result of a
 * prior call with the same Idempotency-Key. A Team tier request must carry
 * an explicit `teamId` (never derived from `users.teamId`, which is a
 * single-team field incompatible with the many-to-many `teamMembers`
 * model) and only proceeds once that team's model deployment is `active`;
 * the credential is shared across the whole team per environment (one doc
 * per team+environment, not per member and not per model) and covers
 * whatever the team's gateway grants there, read from the team's
 * deployments rather than copied - a team already holding an active
 * credential for this environment gets that same credential back rather
 * than a fresh one.
 *
 * Note: the secret is never persisted, so a replayed idempotent request
 * returns the credential without a secret — this matches "the key is shown
 * once" from the spec, at the cost of not being able to replay the secret
 * itself on retry.
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {{userId: string, modelSlug: string, purpose?: string, idempotencyKey: string, tier?: 'research'|'team', teamId?: string, environment?: string, credentialType?: 'oauth'}} params
 * @param {import('#/adapters/credential-issuer-registry.js').CredentialIssuerRegistry} [registry]
 */
export async function issueCredential(
  db,
  locker,
  params,
  registry = credentialIssuerRegistry,
  vault = credentialVault
) {
  const { tier = 'research', teamId, userId, modelSlug } = params
  const environment = resolveIssueEnvironment(tier, params.environment)

  if (tier !== 'team') {
    // Guards the check-for-reusable-pending/failed-doc-then-write below
    // (see issueCredentialForParams) from the same interleaving race the
    // team-tier lock below prevents - without it, two concurrent requests
    // for the same user+model could both reuse and overwrite one shared
    // document with two different attempts' results.
    const lock = await acquireLockWithRetry(
      locker,
      `research-credential:${userId}:${modelSlug}`
    )

    try {
      return await issueCredentialForParams(
        db,
        { ...params, environment },
        registry,
        vault
      )
    } finally {
      await lock.free()
    }
  }

  // A team shares one credential per environment, so the
  // check-for-active-then-insert below must not interleave with another
  // member's request or both would create an active credential.
  const lock = await acquireLockWithRetry(
    locker,
    `team-credential:${teamId}:${environment}`
  )

  try {
    return await issueCredentialForParams(db, params, registry, vault)
  } finally {
    await lock.free()
  }
}

/**
 * A research key is issued into the configured research environment; naming a
 * different one is refused, so a caller can never aim the portal's API
 * Management role at an instance this deployment was not set up for. A team
 * credential's environment is the team deployment's, passed through.
 * @param {'research'|'team'} tier
 * @param {string|undefined} requested
 * @returns {string|undefined}
 */
function resolveIssueEnvironment(tier, requested) {
  if (tier === 'team') {
    return requested
  }

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

async function issueCredentialForParams(
  db,
  {
    userId,
    modelSlug,
    purpose,
    idempotencyKey,
    tier = 'research',
    teamId,
    environment
  },
  registry = credentialIssuerRegistry,
  vault = credentialVault
) {
  const existing = await db
    .collection('credentials')
    .findOne({ userId, idempotencyKey })

  if (existing) {
    return {
      credential: await withTeamGrants(db, existing),
      secret: undefined,
      replay: true
    }
  }

  const model = await findModelBySlug(db, modelSlug)

  if (!model || !model.eligible || !model.tiers?.includes(tier)) {
    throw boomWithCode(
      Boom.forbidden,
      'Model is not eligible',
      'model-not-eligible'
    )
  }

  let resolvedIssuer

  try {
    resolvedIssuer = registry.forModel(model, tier)
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

  const { issuerKey, issuer } = resolvedIssuer

  let resolvedTeamId = null

  if (tier === 'team') {
    const membership = await db
      .collection('teamMembers')
      .findOne({ teamId, userId, status: 'active' })

    if (!membership) {
      throw Boom.notFound()
    }

    const deployment = await findActiveDeployment(db, {
      teamId,
      modelSlug,
      environment
    })

    if (!deployment) {
      throw boomWithCode(
        Boom.conflict,
        'The team deployment for this model is not ready yet',
        'deployment-not-ready'
      )
    }

    // Only an OAuth credential is the team's; the tier has issued nothing
    // else since it became OAuth only (14 October 2026). The team's one
    // credential covers whatever its gateway grants, so a second model
    // needs nothing added to it: the deployment reaching `active` already
    // granted the model.
    const activeTeamCredential = await db.collection('credentials').findOne({
      teamId,
      environment,
      tier: 'team',
      credentialType: TEAM_CREDENTIAL_TYPE,
      status: 'active'
    })

    if (activeTeamCredential) {
      return {
        credential: await withTeamGrants(db, activeTeamCredential),
        secret: undefined,
        replay: true
      }
    }

    resolvedTeamId = teamId
  } else {
    const existingCredential = await db
      .collection('credentials')
      .findOne({ userId, modelSlug, status: { $in: ['active', 'expired'] } })

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

    resolvedTeamId = await findTeamIdForUser(db, userId)
  }

  const now = new Date().toISOString()
  const pending = {
    userId,
    teamId: resolvedTeamId,
    modelSlug: tier === 'team' ? null : modelSlug,
    ...(tier === 'team' && { credentialType: TEAM_CREDENTIAL_TYPE }),
    tier,
    environment: environment || null,
    purpose: purpose || null,
    type: 'apim-subscription',
    status: 'pending',
    idempotencyKey,
    issuerKey,
    // Catalogue snapshot at issue time, so "which cloud/gateway is this
    // credential for" needs no join. A team credential spans several models,
    // so only the research tier records a single provider/offering.
    // `gateway` is what the catalogue said at issue time; `issuerKey` is which
    // issuer actually minted it - they differ in `mock` mode or a `mockTiers` tier.
    provider: tier === 'team' ? null : (model.provider ?? null),
    offering: tier === 'team' ? null : (model.offering ?? null),
    cloud: model.hosting?.cloud ?? null,
    gateway: model.gateway ?? null,
    createdAt: now,
    renewalCount: 0
  }

  // A research-tier retry after a failed (or crash-abandoned pending)
  // attempt reuses that same document instead of inserting a new one -
  // otherwise every retry of the same model request leaves behind another
  // permanent 'failed' row, so /manage's "Keys you can use" table fills up
  // with duplicate entries for one logical request (none of which can be
  // usefully renewed or revoked, since they were never actually issued).
  const reusableCredential =
    tier === 'research'
      ? await db.collection('credentials').findOne({
          userId,
          modelSlug,
          tier: 'research',
          status: { $in: ['pending', 'failed'] }
        })
      : null

  let insertedId
  if (reusableCredential) {
    insertedId = reusableCredential._id
    await db
      .collection('credentials')
      .updateOne(
        { _id: insertedId },
        { $set: pending, $unset: { failureReason: '' } }
      )
  } else {
    ;({ insertedId } = await db.collection('credentials').insertOne(pending))
  }

  let issued
  try {
    issued = await issuer.issue({
      userId,
      modelSlug,
      tier,
      teamId: resolvedTeamId,
      environment: environment || null
    })
  } catch {
    await db
      .collection('credentials')
      .updateOne(
        { _id: insertedId },
        { $set: { status: 'failed', failureReason: 'issuer-error' } }
      )
    await recordAuditEvent(db, {
      actorUserId: userId,
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

  const active = {
    status: 'active',
    externalGatewaySubscriptionId: issued.externalId,
    keyHint: issued.keyHint,
    activatedAt: now,
    // Team credentials are shared indefinitely across the team and never
    // renewed (see `renewCredential`'s tier guard) - only research-tier
    // personal credentials expire.
    expiresAt: tier === 'team' ? null : issued.expiresAt
  }

  await db
    .collection('credentials')
    .updateOne({ _id: insertedId }, { $set: active })

  const activeCredential = { _id: insertedId, ...pending, ...active }

  await writeSecretToVault(db, vault, activeCredential, issued.secret)

  await recordAuditEvent(db, {
    actorUserId: userId,
    action: 'credential.issue',
    resource: 'credential',
    resourceId: insertedId.toString(),
    outcome: 'success'
  })

  return {
    credential: await withTeamGrants(db, activeCredential),
    secret: issued.secret
  }
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
  const lock = await requireLock(locker, `credential:${id}`)

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
  const lock = await requireLock(locker, `credential:${id}`)

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
  const lock = await requireLock(locker, `credential:${id}`)

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

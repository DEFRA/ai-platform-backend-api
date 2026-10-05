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
  reserveCredentialType,
  releaseCredentialTypeReservation
} from '#/services/team-deployment-service.js'
import { getMemberRole } from '#/services/team-service.js'

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
 * Reads the provider-neutral gateway subscription id, falling back to the
 * pre-rename `apimSubscriptionId` field for documents the backfill hasn't
 * reached yet (see `src/common/backfills/registry.js`). Exported so
 * `maintenance-service.js` reads the same fallback, not a second copy of it.
 * @param {object} credential
 */
export function externalGatewaySubscriptionIdOf(credential) {
  return credential.externalGatewaySubscriptionId ?? credential.apimSubscriptionId
}

/**
 * Tags attached to a credential's Key Vault secret, per the design's
 * "tagged aip-team, aip-service-code and aip-environment". `aip-team` is
 * the literal platform team name for a research-tier credential with no
 * team of its own, or the owning team's id otherwise; `aip-service-code`
 * is best-effort (omitted if the team has none recorded) rather than a
 * required field, since it is metadata for operators, not an access check.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string|null, environment: string|null}} credential
 */
async function buildVaultTags(db, { teamId, environment }) {
  const tags = {
    'aip-team': teamId ?? 'research',
    'aip-environment': environment ?? config.get('cdpEnvironment')
  }

  if (teamId && ObjectId.isValid(teamId)) {
    const team = await db
      .collection('teams')
      .findOne({ _id: new ObjectId(teamId) }, { projection: { serviceCode: 1 } })

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
      secret,
      tags,
      expiresOn: credential.expiresAt ? new Date(credential.expiresAt) : undefined
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
      .updateOne(
        { _id: credential._id },
        { $set: { vaultState: 'unwritten' } }
      )

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
 * per team+environment, covering every model in `allowedDeployments`, not
 * per member and not per model) - a team already holding an active
 * credential for this environment gets that same credential back, extended
 * to cover the new model, rather than a fresh one.
 *
 * Note: the secret is never persisted, so a replayed idempotent request
 * returns the credential without a secret — this matches "the key is shown
 * once" from the spec, at the cost of not being able to replay the secret
 * itself on retry.
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {{userId: string, modelSlug: string, purpose?: string, idempotencyKey: string, tier?: 'research'|'team', teamId?: string, environment?: string, credentialType?: 'oauth'|'subscription-key'}} params
 * @param {import('#/adapters/credential-issuer-registry.js').CredentialIssuerRegistry} [registry]
 */
export async function issueCredential(
  db,
  locker,
  params,
  registry = credentialIssuerRegistry,
  vault = credentialVault
) {
  const { tier = 'research', teamId, environment } = params

  if (tier !== 'team') {
    return issueCredentialForParams(db, params, registry, vault)
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

async function issueCredentialForParams(
  db,
  {
    userId,
    modelSlug,
    purpose,
    idempotencyKey,
    tier = 'research',
    teamId,
    environment,
    credentialType = 'subscription-key'
  },
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

  if (!model || !model.eligible || !model.tiers?.includes(tier)) {
    throw boomWithCode(
      Boom.forbidden,
      'Model is not eligible',
      'model-not-eligible'
    )
  }

  const { issuerKey, issuer } = registry.forModel(model)

  let resolvedTeamId = null
  let resolvedCredentialType = null
  let credentialTypeReservation = null

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

    // Design C: one credential type per team per environment, fixed on
    // first use - throws 409 credential-type-fixed on a later mismatch.
    credentialTypeReservation = await reserveCredentialType(db, {
      teamId,
      environment,
      credentialType
    })
    resolvedCredentialType = credentialTypeReservation.credentialType

    const activeTeamCredential = await db
      .collection('credentials')
      .findOne({ teamId, environment, tier: 'team', status: 'active' })

    if (activeTeamCredential) {
      const allowedDeployments = new Set(
        activeTeamCredential.allowedDeployments ?? []
      )

      if (!allowedDeployments.has(modelSlug)) {
        allowedDeployments.add(modelSlug)
        await db
          .collection('credentials')
          .updateOne(
            { _id: activeTeamCredential._id },
            { $addToSet: { allowedDeployments: modelSlug } }
          )
      }

      return {
        credential: {
          ...activeTeamCredential,
          allowedDeployments: [...allowedDeployments]
        },
        secret: undefined,
        replay: true
      }
    }

    resolvedTeamId = teamId
  } else {
    const activeCredential = await db
      .collection('credentials')
      .findOne({ userId, modelSlug, status: 'active' })

    if (activeCredential) {
      throw boomWithCode(
        Boom.conflict,
        'An active credential already exists for this model',
        'active-credential-exists'
      )
    }

    resolvedTeamId = await findTeamIdForUser(db, userId)
  }

  const now = new Date().toISOString()
  const pending = {
    userId,
    teamId: resolvedTeamId,
    modelSlug: tier === 'team' ? null : modelSlug,
    ...(tier === 'team' && {
      allowedDeployments: [modelSlug],
      credentialType: resolvedCredentialType
    }),
    tier,
    environment: environment || null,
    purpose: purpose || null,
    type: 'apim-subscription',
    status: 'pending',
    idempotencyKey,
    issuerKey,
    createdAt: now,
    renewalCount: 0
  }

  const { insertedId } = await db.collection('credentials').insertOne(pending)

  let issued
  try {
    issued = await issuer.issue({
      userId,
      modelSlug,
      tier,
      teamId: resolvedTeamId,
      environment: environment || null,
      credentialType: resolvedCredentialType ?? undefined
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

    // Don't leave the team permanently locked into a credential type that
    // was never actually issued - only undo the reservation if this call
    // was the one that made it (a concurrent caller may have since made a
    // real reservation of their own).
    if (tier === 'team' && credentialTypeReservation?.wasNewlyReserved) {
      await releaseCredentialTypeReservation(db, {
        teamId,
        environment,
        credentialType: resolvedCredentialType
      })
    }

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
    credential: activeCredential,
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
  const expired = await Promise.all(
    items.map((item) => applyLazyExpiry(db, item))
  )

  return expired.map(withRenewalsRemaining)
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

  return withRenewalsRemaining(await applyLazyExpiry(db, credential))
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

  return withRenewalsRemaining(await applyLazyExpiry(db, credential))
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

    if (credential.status === 'expired') {
      const { issuer } = registry.forCredential(credential)
      await issuer.renew({
        externalId: externalGatewaySubscriptionIdOf(credential)
      })
    }

    const ttlDays = config.get('research.credentialTtlDays')
    const expiresAt = new Date(
      Date.now() + ttlDays * 24 * 60 * 60 * 1000
    ).toISOString()

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
      credentialType: credential.credentialType
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
      credential: withRenewalsRemaining(updated),
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
      externalId: externalGatewaySubscriptionIdOf(credential)
    })

    // Soft-deletes for 90 days. Best-effort: the credential is already
    // revoked in APIM, which is the access control that matters - a vault
    // write failure here is hygiene, not a security hole.
    try {
      await vault.remove({ credentialId: credential._id.toString() })
    } catch {
      // intentionally swallowed, see comment above
    }

    const now = new Date().toISOString()
    const updated = await db.collection('credentials').findOneAndUpdate(
      { _id: credential._id },
      {
        $set: {
          status: 'revoked',
          revokedAt: now,
          revokedReason: 'user-requested'
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

  const secret = await vault.get({ credentialId: credential._id.toString() })

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

import { ObjectId } from 'mongodb'

import { config } from '#/config.js'
import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { findModelBySlug } from '#/services/models-service.js'
import { mockCredentialIssuer } from '#/adapters/mock-credential-issuer.js'
import { recordAuditEvent } from '#/services/audit-service.js'
import { requireLock } from '#/common/helpers/mongo-lock.js'
import { findActiveDeployment } from '#/services/team-deployment-service.js'

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
 * Issues a Research or Team tier credential, or replays the result of a
 * prior call with the same Idempotency-Key. A Team tier request must carry
 * an explicit `teamId` (never derived from `users.teamId`, which is a
 * single-team field incompatible with the many-to-many `teamMembers`
 * model) and only proceeds once that team's model deployment is `active`;
 * since the credential is shared across the whole team (one doc per
 * team+model, not per member), a team already holding an active credential
 * for this model gets that same credential back rather than a fresh one.
 *
 * Note: the secret is never persisted, so a replayed idempotent request
 * returns the credential without a secret — this matches "the key is shown
 * once" from the spec, at the cost of not being able to replay the secret
 * itself on retry.
 * @param {import('mongodb').Db} db
 * @param {{userId: string, modelSlug: string, purpose?: string, idempotencyKey: string, tier?: 'research'|'team', teamId?: string, environment?: string}} params
 * @param {import('#/adapters/credential-issuer.js').CredentialIssuer} [issuer]
 */
export async function issueCredential(
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
  issuer = mockCredentialIssuer
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

    const activeTeamCredential = await db
      .collection('credentials')
      .findOne({ teamId, modelSlug, tier: 'team', status: 'active' })

    if (activeTeamCredential) {
      return {
        credential: activeTeamCredential,
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
    modelSlug,
    tier,
    environment: environment || null,
    purpose: purpose || null,
    type: 'apim-subscription',
    status: 'pending',
    idempotencyKey,
    createdAt: now,
    renewalCount: 0
  }

  const { insertedId } = await db.collection('credentials').insertOne(pending)

  let issued
  try {
    issued = await issuer.issue({ userId, modelSlug })
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
    apimSubscriptionId: issued.apimSubscriptionId,
    keyHint: issued.keyHint,
    activatedAt: now,
    expiresAt: issued.expiresAt
  }

  await db
    .collection('credentials')
    .updateOne({ _id: insertedId }, { $set: active })

  await recordAuditEvent(db, {
    actorUserId: userId,
    action: 'credential.issue',
    resource: 'credential',
    resourceId: insertedId.toString(),
    outcome: 'success'
  })

  return {
    credential: { _id: insertedId, ...pending, ...active },
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
 * and revoke keep the stricter owner-only `findCredentialForUser` above,
 * since team-credential rotate/revoke role enforcement is Route 3's plan.
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
 * Renews a credential within the renewal cap, reactivating it in APIM if it was suspended.
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {{id: string, userId: string}} params
 * @param {import('#/adapters/credential-issuer.js').CredentialIssuer} [issuer]
 */
export async function renewCredential(
  db,
  locker,
  { id, userId },
  issuer = mockCredentialIssuer
) {
  const lock = await requireLock(locker, `credential:${id}`)

  try {
    const credential = await findCredentialForUser(db, { id, userId })

    if (!credential) {
      throw Boom.notFound()
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
      await issuer.renew({ apimSubscriptionId: credential.apimSubscriptionId })
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
 * Revokes a credential, deleting its APIM subscription.
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {{id: string, userId: string}} params
 * @param {import('#/adapters/credential-issuer.js').CredentialIssuer} [issuer]
 */
export async function revokeCredential(
  db,
  locker,
  { id, userId },
  issuer = mockCredentialIssuer
) {
  const lock = await requireLock(locker, `credential:${id}`)

  try {
    const credential = await findCredentialForUser(db, { id, userId })

    if (!credential) {
      throw Boom.notFound()
    }

    if (credential.status === 'revoked') {
      return credential
    }

    await issuer.revoke({ apimSubscriptionId: credential.apimSubscriptionId })

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

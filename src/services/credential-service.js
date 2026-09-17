import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { findModelBySlug } from '#/services/models-service.js'
import { mockCredentialIssuer } from '#/adapters/mock-credential-issuer.js'

/**
 * Issues a Research tier credential for a user/model, or replays the result
 * of a prior call with the same Idempotency-Key.
 *
 * Note: the secret is never persisted, so a replayed idempotent request
 * returns the credential without a secret — this matches "the key is shown
 * once" from the spec, at the cost of not being able to replay the secret
 * itself on retry.
 * @param {import('mongodb').Db} db
 * @param {{userId: string, modelSlug: string, idempotencyKey: string}} params
 * @param {import('#/adapters/credential-issuer.js').CredentialIssuer} [issuer]
 */
export async function issueCredential(
  db,
  { userId, modelSlug, idempotencyKey },
  issuer = mockCredentialIssuer
) {
  const existing = await db
    .collection('credentials')
    .findOne({ userId, idempotencyKey })

  if (existing) {
    return { credential: existing, secret: undefined, replay: true }
  }

  const model = await findModelBySlug(db, modelSlug)

  if (!model || !model.eligible) {
    throw boomWithCode(
      Boom.badRequest,
      'Model is not eligible',
      'model-not-eligible'
    )
  }

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

  const now = new Date().toISOString()
  const pending = {
    userId,
    modelSlug,
    tier: 'research',
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

  return {
    credential: { _id: insertedId, ...pending, ...active },
    secret: issued.secret
  }
}

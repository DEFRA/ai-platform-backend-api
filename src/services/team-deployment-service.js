import { ObjectId } from 'mongodb'

import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { findModelBySlug } from '#/services/models-service.js'
import { mockTenantOrchestrator } from '#/adapters/mock-tenant-orchestrator.js'
import { recordAuditEvent } from '#/services/audit-service.js'
import { acquireLockWithRetry } from '#/common/helpers/mongo-lock.js'

const TERMINAL_FAILURE_STATUSES = ['checks-failed', 'deploy-failed']

// Phase 1 (confirmed 24 Sept 2026): the one live team-facing environment is
// the Sandbox (SND4) - Infradev (SND1) is platform-internal/synthetic, not
// team-facing, so it is a valid schema value but never policy-allowed here.
const TEAM_FACING_ENVIRONMENT = 'sandbox'

/**
 * Maps a `teamDeployments` document + one of its `deployments[]` entries to
 * the flat shape routes/frontend already expect (an `_id` per deployment,
 * as if it still had its own document).
 * @param {{teamId: string, environment: string}} doc
 * @param {object} entry
 */
function toDeploymentView(doc, entry) {
  return {
    _id: entry.id,
    teamId: doc.teamId,
    environment: doc.environment,
    modelSlug: entry.modelSlug,
    status: entry.status,
    operationId: entry.operationId,
    requestedBy: entry.requestedBy,
    idempotencyKey: entry.idempotencyKey,
    createdAt: entry.createdAt,
    activatedAt: entry.activatedAt,
    failureReason: entry.failureReason
  }
}

function findEntry(doc, id) {
  return doc?.deployments?.find((deployment) => deployment.id === id)
}

/**
 * Requests provisioning of a team's dedicated model deployment (B09). One
 * document per team per environment holds every model the team has
 * requested there, mirroring design C's `environments/{env}/{team}.json`
 * shape (`gateway.allowedDeployments` etc.) - requesting a second model for
 * a team that already has a document for this environment extends it,
 * rather than creating a sibling document. Only `sandbox` is policy-allowed
 * today, even though the schema accepts every design C environment - future
 * environments are a policy change, not a schema change.
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {{teamId: string, modelSlug: string, environment: string, requestedBy: string, idempotencyKey: string}} params
 * @param {import('#/adapters/tenant-orchestrator.js').TenantOrchestrator} [orchestrator]
 */
export async function requestDeployment(
  db,
  locker,
  { teamId, modelSlug, environment, requestedBy, idempotencyKey },
  orchestrator = mockTenantOrchestrator
) {
  if (environment !== TEAM_FACING_ENVIRONMENT) {
    throw boomWithCode(
      Boom.forbidden,
      'This environment is not available yet',
      'environment-not-available'
    )
  }

  const membership = await db
    .collection('teamMembers')
    .findOne({ teamId, userId: requestedBy, status: 'active' })

  if (!membership) {
    throw Boom.notFound()
  }

  const model = await findModelBySlug(db, modelSlug)

  if (
    !model ||
    !model.eligible ||
    !model.tiers?.includes('team') ||
    !model.environments?.includes(environment)
  ) {
    throw boomWithCode(
      Boom.forbidden,
      'Model is not eligible for this environment',
      'model-not-eligible'
    )
  }

  // Several models can now be requested for the same team+environment
  // document, so a plain unique index can no longer detect an
  // idempotency-key replay or a duplicate model by itself - every mutation
  // of the document is serialised behind this lock instead.
  const lock = await acquireLockWithRetry(
    locker,
    `team-deployment:${teamId}:${environment}`
  )

  try {
    const doc = await db
      .collection('teamDeployments')
      .findOne({ teamId, environment })

    const replay = doc?.deployments?.find(
      (deployment) => deployment.idempotencyKey === idempotencyKey
    )

    if (replay) {
      return toDeploymentView(doc, replay)
    }

    const conflicting = doc?.deployments?.find(
      (deployment) => deployment.modelSlug === modelSlug
    )

    if (conflicting) {
      throw boomWithCode(
        Boom.conflict,
        'A deployment already exists for this team and model',
        'deployment-exists',
        { existingId: conflicting.id }
      )
    }

    const now = new Date().toISOString()
    const entry = {
      id: new ObjectId().toString(),
      modelSlug,
      status: 'requested',
      operationId: new ObjectId().toString(),
      requestedBy,
      idempotencyKey,
      createdAt: now,
      activatedAt: null,
      failureReason: null
    }

    await db.collection('teamDeployments').updateOne(
      { teamId, environment },
      {
        $push: { deployments: entry },
        $setOnInsert: {
          teamId,
          environment,
          gateway: {
            credentialType: null,
            allowedDeployments: [],
            limits: {}
          },
          oauthClient: { enabled: false, appRoles: [] },
          createdAt: now
        },
        $set: { updatedAt: now }
      },
      { upsert: true }
    )

    try {
      await orchestrator.requestDeployment({
        teamId,
        modelSlug,
        environment,
        operationId: entry.operationId,
        requestedBy
      })
    } catch {
      // Pull the entry so a retry can start cleanly - it never reached the
      // orchestrator, so nothing needs unwinding on that side either.
      await db
        .collection('teamDeployments')
        .updateOne(
          { teamId, environment },
          { $pull: { deployments: { id: entry.id } } }
        )
      await recordAuditEvent(db, {
        actorUserId: requestedBy,
        action: 'teamDeployment.request',
        resource: 'teamDeployment',
        resourceId: entry.id,
        outcome: 'failure',
        code: 'upstream-unavailable'
      })

      throw boomWithCode(
        Boom.badGateway,
        'Failed to request the team deployment',
        'upstream-unavailable'
      )
    }

    await recordAuditEvent(db, {
      actorUserId: requestedBy,
      action: 'teamDeployment.request',
      resource: 'teamDeployment',
      resourceId: entry.id,
      outcome: 'success'
    })

    return toDeploymentView({ teamId, environment }, entry)
  } finally {
    await lock.free()
  }
}

/**
 * Advances one deployment entry's persisted status by asking the
 * orchestrator for its current state, if it hasn't already reached a
 * terminal/active state. Reaching `active` also adds the model to the
 * team's `gateway.allowedDeployments` - the allow-list a shared team
 * credential's coverage is drawn from.
 * @param {import('mongodb').Db} db
 * @param {object} doc
 * @param {object} entry
 * @param {import('#/adapters/tenant-orchestrator.js').TenantOrchestrator} orchestrator
 */
async function refreshEntryStatus(db, doc, entry, orchestrator) {
  if (
    entry.status === 'active' ||
    TERMINAL_FAILURE_STATUSES.includes(entry.status)
  ) {
    return entry
  }

  const { status, failureReason } = await orchestrator.getDeploymentStatus({
    operationId: entry.operationId,
    requestedAt: entry.createdAt
  })

  if (status === entry.status) {
    return entry
  }

  const update = { status }

  if (status === 'active') {
    update.activatedAt = new Date().toISOString()
  }

  if (TERMINAL_FAILURE_STATUSES.includes(status)) {
    update.failureReason = failureReason ?? 'unknown'
  }

  const updateOps = {
    $set: Object.fromEntries(
      Object.entries(update).map(([key, value]) => [
        `deployments.$.${key}`,
        value
      ])
    )
  }

  if (status === 'active') {
    updateOps.$addToSet = { 'gateway.allowedDeployments': entry.modelSlug }
  }

  // Compare-and-set on the entry id and status we read: a slower concurrent
  // poll must not overwrite a newer status with its stale one.
  const { matchedCount } = await db.collection('teamDeployments').updateOne(
    {
      _id: doc._id,
      deployments: { $elemMatch: { id: entry.id, status: entry.status } }
    },
    updateOps
  )

  if (matchedCount === 0) {
    const fresh = await db
      .collection('teamDeployments')
      .findOne({ _id: doc._id })

    return findEntry(fresh, entry.id) ?? entry
  }

  return { ...entry, ...update }
}

/**
 * Finds one deployment entry by id for the "being set up" poll, refreshing
 * its status first. Returns null (not a 403) for a non-member so existence
 * isn't disclosed.
 * @param {import('mongodb').Db} db
 * @param {{id: string, teamId: string, userId: string}} params
 * @param {import('#/adapters/tenant-orchestrator.js').TenantOrchestrator} [orchestrator]
 */
export async function getDeployment(
  db,
  { id, teamId, userId },
  orchestrator = mockTenantOrchestrator
) {
  const membership = await db
    .collection('teamMembers')
    .findOne({ teamId, userId, status: 'active' })

  if (!membership) {
    return null
  }

  const doc = await db
    .collection('teamDeployments')
    .findOne({ teamId, 'deployments.id': id })

  const entry = findEntry(doc, id)

  if (!doc || !entry) {
    return null
  }

  const refreshed = await refreshEntryStatus(db, doc, entry, orchestrator)

  return toDeploymentView(doc, refreshed)
}

/**
 * Lists every deployment entry for a team (any status, any environment),
 * refreshing each one's status first - powers the "check progress" links on
 * `/manage` so a request stays reachable even after the requester navigates
 * away or signs back in later. Throws 404 for a non-member so existence
 * isn't disclosed.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, userId: string}} params
 * @param {import('#/adapters/tenant-orchestrator.js').TenantOrchestrator} [orchestrator]
 */
export async function listDeploymentsForTeam(
  db,
  { teamId, userId },
  orchestrator = mockTenantOrchestrator
) {
  const membership = await db
    .collection('teamMembers')
    .findOne({ teamId, userId, status: 'active' })

  if (!membership) {
    throw Boom.notFound()
  }

  const docs = await db.collection('teamDeployments').find({ teamId }).toArray()

  const views = []

  for (const doc of docs) {
    for (const entry of doc.deployments ?? []) {
      // Sequential by design: each refresh may write back to the same
      // document, and entries share one document per team+environment.
      const refreshed = await refreshEntryStatus(db, doc, entry, orchestrator)
      views.push(toDeploymentView(doc, refreshed))
    }
  }

  return views
}

/**
 * Finds the active deployment entry for a team+model+environment, used by
 * `credential-service.js` to gate team-tier credential issuance. Does not
 * refresh status itself - the requester's poll of `getDeployment` above is
 * what keeps the persisted record up to date.
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

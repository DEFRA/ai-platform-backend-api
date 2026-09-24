import { ObjectId } from 'mongodb'

import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { findModelBySlug } from '#/services/models-service.js'
import { mockTenantOrchestrator } from '#/adapters/mock-tenant-orchestrator.js'
import { recordAuditEvent } from '#/services/audit-service.js'

const TERMINAL_FAILURE_STATUSES = ['checks-failed', 'deploy-failed']

/**
 * Requests provisioning of a team's dedicated model deployment (B09). Only
 * `dev` is policy-allowed today, even though the schema accepts all five
 * design C environments - future environments are a policy change, not a
 * schema change.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, modelSlug: string, environment: string, requestedBy: string}} params
 * @param {import('#/adapters/tenant-orchestrator.js').TenantOrchestrator} [orchestrator]
 */
export async function requestDeployment(
  db,
  { teamId, modelSlug, environment, requestedBy },
  orchestrator = mockTenantOrchestrator
) {
  if (environment !== 'dev') {
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

  const existing = await db
    .collection('teamDeployments')
    .findOne({ teamId, modelSlug, environment })

  if (existing) {
    throw boomWithCode(
      Boom.conflict,
      'A deployment already exists for this team and model',
      'deployment-exists',
      { existingId: existing._id.toString() }
    )
  }

  const now = new Date().toISOString()
  const operationId = new ObjectId().toString()
  const deployment = {
    teamId,
    modelSlug,
    environment,
    status: 'requested',
    operationId,
    requestedBy,
    createdAt: now,
    activatedAt: null,
    failureReason: null
  }

  let insertedId

  try {
    ;({ insertedId } = await db
      .collection('teamDeployments')
      .insertOne(deployment))
  } catch (error) {
    if (error.code === 11000) {
      const conflictError = boomWithCode(
        Boom.conflict,
        'A deployment already exists for this team and model',
        'deployment-exists'
      )
      throw conflictError
    }

    throw error
  }

  await orchestrator.requestDeployment({
    teamId,
    modelSlug,
    environment,
    operationId,
    requestedBy
  })

  await recordAuditEvent(db, {
    actorUserId: requestedBy,
    action: 'teamDeployment.request',
    resource: 'teamDeployment',
    resourceId: insertedId.toString(),
    outcome: 'success'
  })

  return { _id: insertedId, ...deployment }
}

/**
 * Advances a deployment's persisted status by asking the orchestrator for
 * its current state, if it hasn't already reached a terminal/active state.
 * @param {import('mongodb').Db} db
 * @param {object} deployment
 * @param {import('#/adapters/tenant-orchestrator.js').TenantOrchestrator} orchestrator
 */
async function refreshDeploymentStatus(db, deployment, orchestrator) {
  if (
    deployment.status === 'active' ||
    TERMINAL_FAILURE_STATUSES.includes(deployment.status)
  ) {
    return deployment
  }

  const { status, failureReason } = await orchestrator.getDeploymentStatus({
    operationId: deployment.operationId,
    requestedAt: deployment.createdAt
  })

  if (status === deployment.status) {
    return deployment
  }

  const update = { status }

  if (status === 'active') {
    update.activatedAt = new Date().toISOString()
  }

  if (TERMINAL_FAILURE_STATUSES.includes(status)) {
    update.failureReason = failureReason ?? 'unknown'
  }

  await db
    .collection('teamDeployments')
    .updateOne({ _id: deployment._id }, { $set: update })

  return { ...deployment, ...update }
}

/**
 * Finds a deployment by id for the "being set up" poll, refreshing its
 * status first. Returns null (not a 403) for a non-member so existence
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
  if (!ObjectId.isValid(id)) {
    return null
  }

  const membership = await db
    .collection('teamMembers')
    .findOne({ teamId, userId, status: 'active' })

  if (!membership) {
    return null
  }

  const deployment = await db
    .collection('teamDeployments')
    .findOne({ _id: new ObjectId(id), teamId })

  if (!deployment) {
    return null
  }

  return refreshDeploymentStatus(db, deployment, orchestrator)
}

/**
 * Lists every deployment for a team (any status), refreshing each one's
 * status first - powers the "check progress" links on `/manage` so a
 * request stays reachable even after the requester navigates away or
 * signs back in later. 404s for a non-member so existence isn't disclosed.
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

  const deployments = await db
    .collection('teamDeployments')
    .find({ teamId })
    .toArray()

  return Promise.all(
    deployments.map((deployment) =>
      refreshDeploymentStatus(db, deployment, orchestrator)
    )
  )
}

/**
 * Finds the active deployment for a team+model+environment, used by
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
  return db
    .collection('teamDeployments')
    .findOne({ teamId, modelSlug, environment, status: 'active' })
}

import { tenantOrchestratorRegistry } from '#/adapters/tenant-orchestrator-registry.js'
import { uuidv7 } from '#/common/helpers/uuid-v7.js'
import { projectOperation } from '#/operations/operation-projection.js'
import { withStatusTime } from '#/services/team-deployment-entries.js'
import {
  FEDERATION_STATUS,
  definitionOf,
  federationViewOf
} from '#/services/team-federation-entries.js'
import {
  ACTIONS,
  adminContext,
  audited,
  auditSuccess,
  conflict,
  hasBeenReplaced,
  isAcceptedFor,
  nextGenerationOf,
  operationRequestOf,
  requireEntry,
  underLock,
  viewOfEntry
} from '#/services/team-federation-support.js'

// Removing an application.

// Clears such an application from the registration's record, with no
// operation: there is nothing in the file to take out.
async function clearReplaced(db, scope, entry) {
  const at = new Date().toISOString()

  await db.collection('teamDeployments').updateOne(
    scope,
    {
      $set: {
        'federations.$[f].status': FEDERATION_STATUS.REMOVED,
        'federations.$[f].statusTimes': withStatusTime(
          entry.statusTimes,
          FEDERATION_STATUS.REMOVED,
          at
        ),
        'federations.$[f].removedAt': at,
        updatedAt: at
      }
    },
    { arrayFilters: [{ 'f.id': entry.id }] }
  )
}

// A removal takes the application's next generation, under the lock, before
// its operation is asked for.
async function takeGeneration(db, { teamId, environment }, entry) {
  const generation = nextGenerationOf(entry)

  await db
    .collection('teamDeployments')
    .updateOne(
      { teamId, environment },
      { $set: { 'federations.$[f].generation': generation } },
      { arrayFilters: [{ 'f.id': entry.id }] }
    )

  return generation
}

// Gives a removal's generation back when no operation took it, so the
// operation the application last had is not refused as superseded.
function releaseGeneration(db, { teamId, environment }, entry, generation) {
  return db
    .collection('teamDeployments')
    .updateOne(
      { teamId, environment },
      { $set: { 'federations.$[f].generation': entry.generation ?? 0 } },
      { arrayFilters: [{ 'f.id': entry.id, 'f.generation': generation }] }
    )
}

// Asks for a removal's operation, with the generation it took; one no
// operation accepted gives the generation back.
async function requestRemoval(db, context, entry) {
  const { teamId, environment, operations } = context
  const scope = { teamId, environment }
  const generation = await takeGeneration(db, scope, entry)
  // A removal has no key of its own: the application's status is what
  // makes a repeat harmless, and each removal is its own operation.
  const key = `remove:${uuidv7()}`

  try {
    const { operation } = await operations.request(
      operationRequestOf(
        context,
        environment,
        {
          entryId: entry.id,
          change: 'remove',
          generation,
          name: entry.name,
          federation: definitionOf(entry)
        },
        { idempotencyKey: key }
      )
    )

    return operation
  } catch (error) {
    if (!(await isAcceptedFor(db, { teamId, key }, entry))) {
      await releaseGeneration(db, scope, entry, generation)
    }

    throw error
  }
}

async function removeUnderLock(db, context, federationId) {
  const { teamId, environment } = context
  const scope = { teamId, environment }
  const entry = await requireEntry(db, context, federationId)

  if (entry.status === FEDERATION_STATUS.REMOVED) {
    return { federation: federationViewOf(entry), done: true }
  }

  if (entry.status === FEDERATION_STATUS.REMOVING) {
    return { federation: federationViewOf(entry), done: false }
  }

  if (entry.status === FEDERATION_STATUS.SETTING_UP) {
    throw conflict(
      'The application is being set up; try again when it is done',
      'federation-in-progress'
    )
  }

  if (await hasBeenReplaced(db, scope, entry)) {
    await clearReplaced(db, scope, entry)
    await auditSuccess(db, context, ACTIONS.REMOVE, entry, environment)

    return { federation: await viewOfEntry(db, scope, entry.id), done: true }
  }

  const operation = await requestRemoval(db, context, entry)

  await projectOperation(db, operation)
  await auditSuccess(db, context, ACTIONS.REMOVE, entry, environment)

  return { federation: await viewOfEntry(db, scope, entry.id), done: false }
}

/**
 * Removes an application, for a team Admin: one operation on the
 * environment's team file without its entry. Removing at once (`done`
 * false); `done` once it is removed. A removal under way is answered as it
 * is; one still being set up is `409 federation-in-progress`.
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {{teamId: string, environment: string, federationId: string, actor: {userId: string, oid: string}, traceParent?: string, cdpRequestId?: string}} params - `teamId` is the team's id or slug
 * @param {{operations: ReturnType<typeof import('#/operations/operations-service.js').createOperationsService>, registry?: import('#/adapters/tenant-orchestrator-registry.js').TenantOrchestratorRegistry}} deps
 * @returns {Promise<{federation: object, done: boolean}>}
 */
export async function removeFederation(
  db,
  locker,
  params,
  { operations, registry = tenantOrchestratorRegistry }
) {
  const context = {
    ...(await adminContext(db, params, 'remove an application')),
    locker,
    operations,
    registry
  }

  return audited(
    db,
    context,
    ACTIONS.REMOVE,
    'Failed to remove the application',
    () =>
      underLock(locker, context.teamId, params.environment, () =>
        removeUnderLock(db, context, params.federationId)
      )
  )
}

import { tenantOrchestratorRegistry } from '#/adapters/tenant-orchestrator-registry.js'
import { uuidv7 } from '#/common/helpers/uuid-v7.js'
import { projectOperation } from '#/operations/operation-projection.js'
import { discardStagedAudit } from '#/services/admin-pending-audit.js'
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

// What a removal sets, in the same update as its own change, when the caller
// staged an audit event for it (`stage`): the event is recorded from the marker.
function markerSet(markerId) {
  return markerId ? { 'federations.$[f].pendingAuditId': markerId } : {}
}

// Clears such an application from the registration's record, with no
// operation: there is nothing in the file to take out.
async function clearReplaced(db, scope, entry, markerId) {
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
        ...markerSet(markerId),
        updatedAt: at
      }
    },
    { arrayFilters: [{ 'f.id': entry.id }] }
  )
}

// A removal takes the application's next generation, under the lock, before
// its operation is asked for, and with it the marker of its staged event.
async function takeGeneration(db, { teamId, environment }, entry, markerId) {
  const generation = nextGenerationOf(entry)

  await db.collection('teamDeployments').updateOne(
    { teamId, environment },
    {
      $set: {
        'federations.$[f].generation': generation,
        ...markerSet(markerId)
      }
    },
    { arrayFilters: [{ 'f.id': entry.id }] }
  )

  return generation
}

// Gives a removal's generation and marker back when no operation took them, so
// the operation the application last had is not refused as superseded.
function releaseGeneration(
  db,
  { teamId, environment },
  entry,
  generation,
  markerId
) {
  return db.collection('teamDeployments').updateOne(
    { teamId, environment },
    {
      $set: { 'federations.$[f].generation': entry.generation ?? 0 },
      ...(markerId && { $unset: { 'federations.$[f].pendingAuditId': '' } })
    },
    { arrayFilters: [{ 'f.id': entry.id, 'f.generation': generation }] }
  )
}

// A staged event whose removal was not taken has no marker to be recorded from;
// dropping it keeps the staging collection clean.
async function dropStaged(db, markerId) {
  if (markerId) {
    await discardStagedAudit(db, markerId)
  }
}

// Asks for a removal's operation, with the generation it took; one no
// operation accepted gives the generation, the marker and the staged event back.
async function requestRemoval(db, context, entry, markerId) {
  const { teamId, environment, operations } = context
  const scope = { teamId, environment }
  let generation

  try {
    generation = await takeGeneration(db, scope, entry, markerId)
  } catch (error) {
    await dropStaged(db, markerId)

    throw error
  }
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
      await dropStaged(db, markerId)
      await releaseGeneration(db, scope, entry, generation, markerId)
    }

    throw error
  }
}

/**
 * The removal itself, for a caller that holds the deployment's lock and has
 * checked its own right to act. Neither callback runs for an application
 * already removed or being removed. `stage` runs before the removal is made
 * and gives the id of the event it staged: the removal's own update marks the
 * application with it, and the event is dropped if the removal is not taken.
 * `onRemoved` runs after the removal is made.
 * @param {import('mongodb').Db} db
 * @param {object} context - the team, environment, target, actor, operations and registry
 * @param {string} federationId
 * @param {{stage?: (entry: object) => Promise<string>, onRemoved?: (entry: object) => Promise<unknown>}} [hooks]
 * @returns {Promise<{federation: object, done: boolean}>}
 */
export async function removeUnderLock(
  db,
  context,
  federationId,
  { stage, onRemoved } = {}
) {
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

  const replaced = await hasBeenReplaced(db, scope, entry)
  const markerId = await stage?.(entry)

  if (replaced) {
    await clearReplaced(db, scope, entry, markerId).catch(async (error) => {
      await dropStaged(db, markerId)

      throw error
    })
    await onRemoved?.(entry)

    return { federation: await viewOfEntry(db, scope, entry.id), done: true }
  }

  const operation = await requestRemoval(db, context, entry, markerId)

  await projectOperation(db, operation)
  await onRemoved?.(entry)

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
        removeUnderLock(db, context, params.federationId, {
          onRemoved: (entry) =>
            auditSuccess(db, context, ACTIONS.REMOVE, entry, params.environment)
        })
      )
  )
}

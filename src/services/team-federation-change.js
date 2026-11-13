import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { tenantOrchestratorRegistry } from '#/adapters/tenant-orchestrator-registry.js'
import { findByIdempotencyKey } from '#/operations/operation-repository.js'
import { projectOperation } from '#/operations/operation-projection.js'
import {
  FEDERATION_HOSTS,
  FEDERATION_STATUS,
  definitionOf,
  federationFingerprintOf,
  trustKeyOf
} from '#/services/team-federation-entries.js'
import {
  readRegistrations,
  refusalFor
} from '#/services/team-federation-checks.js'
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
  requireLiveEntry,
  requireSameRequest,
  underLock,
  underTeamLock,
  underTrustLock,
  viewOfEntry
} from '#/services/team-federation-support.js'

// Changing an application: the same host, a new service or principal.

// What a change asks of an application: the same host, so a CDP application
// takes a service and an Azure one a principal ID and a name.
function changedDefinition(entry, request) {
  const sameHost =
    entry.host === FEDERATION_HOSTS.CDP
      ? request.service !== undefined
      : request.principalId !== undefined

  if (!sameHost) {
    throw boomWithCode(
      Boom.badRequest,
      'An application keeps its host: a CDP one takes a service, an Azure one a principal ID and a name',
      'federation-host-mismatch'
    )
  }

  return definitionOf({ host: entry.host, ...request })
}

async function requireChangeable(db, context, entry, definition) {
  const { teamId, environment, registry } = context

  if (
    entry.status === FEDERATION_STATUS.SETTING_UP ||
    entry.status === FEDERATION_STATUS.REMOVING
  ) {
    throw conflict(
      'The application is being set up or removed; try again when it is done',
      'federation-in-progress'
    )
  }

  if (
    trustKeyOf(definition) === entry.trustKey &&
    definition.name === entry.name
  ) {
    throw conflict(
      'The application is already as asked',
      'federation-unchanged'
    )
  }

  const team = context.team
  const registrations = await readRegistrations(db, {
    teamId,
    team,
    environments: [environment],
    registry
  })
  const code = await refusalFor(db, {
    teamId,
    environment,
    registration: registrations.get(environment),
    definition,
    except: { id: entry.id, name: entry.name }
  })

  if (code) {
    throw conflict('The application cannot be changed to that', code)
  }
}

// What an application is being changed to waits in `pending` on its entry
// until the change commits: the entry keeps the definition the team file
// still holds, so it stays listed, and can be removed, if the change fails.
function pendingOf(definition) {
  return {
    name: definition.name,
    trustKey: trustKeyOf(definition),
    ...(definition.service
      ? { service: definition.service }
      : { principalId: definition.principalId })
  }
}

// The pending definition goes on the entry with the status it had, which a
// change that fails before it commits, or is reverted, leaves it with (an
// addition that failed stays failed, not ready). The entry shows setting up
// from this save: it is the reservation of what it is changing to, kept
// whatever follows the save (a failure before the projection, the
// projection itself) and after the operation has accepted it, so the trust
// lock can be released and another team asking for the workload meanwhile
// still finds it held. The change also takes its generation here, under the
// environment's lock.
function reserveChange(
  db,
  { teamId, environment },
  entry,
  pending,
  generation
) {
  return db.collection('teamDeployments').updateOne(
    { teamId, environment },
    {
      $set: {
        'federations.$[f].pending': pending,
        'federations.$[f].statusBefore': entry.status,
        'federations.$[f].status': FEDERATION_STATUS.SETTING_UP,
        'federations.$[f].generation': generation
      }
    },
    { arrayFilters: [{ 'f.id': entry.id }] }
  )
}

// Gives the reservation back: no operation took the change, so the
// application is as it was, and holds the generation it held, so the
// operation it last had is not refused as superseded by one that never was.
// Only a reservation still at the generation this change took is given back.
function releaseChange(db, { teamId, environment }, entry, generation) {
  return db.collection('teamDeployments').updateOne(
    { teamId, environment },
    {
      $set: {
        'federations.$[f].status': entry.status,
        'federations.$[f].generation': entry.generation ?? 0
      },
      $unset: {
        'federations.$[f].pending': '',
        'federations.$[f].statusBefore': ''
      }
    },
    { arrayFilters: [{ 'f.id': entry.id, 'f.generation': generation }] }
  )
}

// Queues the change with its reservation recorded first, so the projection
// finds it; a request that is refused releases it. One that failed after an
// operation took it (a merge into a waiting operation is saved before it is
// projected) keeps it, for the operation to apply.
async function queueChange(db, context, { entry, definition, fingerprint }) {
  const { teamId, environment, idempotencyKey, operations } = context
  const generation = nextGenerationOf(entry)

  await reserveChange(db, context, entry, pendingOf(definition), generation)

  try {
    const { operation } = await operations.request(
      operationRequestOf(
        context,
        environment,
        {
          entryId: entry.id,
          change: 'change',
          generation,
          name: entry.name,
          federation: definition
        },
        { idempotencyKey, requestFingerprint: fingerprint }
      )
    )

    return operation
  } catch (error) {
    if (!(await isAcceptedFor(db, { teamId, key: idempotencyKey }, entry))) {
      await releaseChange(db, { teamId, environment }, entry, generation)
    }

    throw error
  }
}

async function changeUnderLock(db, context, { entry, request, federationId }) {
  const { teamId, environment, idempotencyKey } = context
  const definition = changedDefinition(entry, request)
  const fingerprint = federationFingerprintOf('change', entry.id, definition)
  const replayed = await findByIdempotencyKey(db, {
    teamId,
    key: idempotencyKey
  })

  if (replayed) {
    requireSameRequest(replayed, idempotencyKey, fingerprint)
    // Projected again, so a failure after the save that left it unprojected
    // is restored.
    await projectOperation(db, replayed)

    return {
      federation: await viewOfEntry(db, { teamId, environment }, federationId),
      operationId: replayed._id,
      replay: true
    }
  }

  // A failed application that another has replaced in the file holds nothing
  // of its own there: a change of it would replace the replacement's entry by
  // name, as removing it would remove it.
  if (await hasBeenReplaced(db, { teamId, environment }, entry)) {
    throw conflict(
      'The application has been replaced by another of the same name; it can only be removed',
      'federation-replaced'
    )
  }

  // The check against other teams and the pending definition that reserves
  // the workload are one step, as for an addition.
  const operation = await underTrustLock(
    context.locker,
    environment,
    trustKeyOf(definition),
    async () => {
      await requireChangeable(db, context, entry, definition)

      return queueChange(db, context, { entry, definition, fingerprint })
    }
  )

  await projectOperation(db, operation)
  await auditSuccess(db, context, ACTIONS.CHANGE, entry, environment)

  return {
    federation: await viewOfEntry(db, { teamId, environment }, federationId),
    operationId: operation._id,
    replay: false
  }
}

/**
 * Changes an application, for a team Admin: a CDP application's service, or
 * an Azure one's principal ID and name; one operation on the environment's
 * team file, replacing the application's entry by its name. The application
 * is compared with every other (never itself) for `409 federation-exists`
 * and `409 federation-trusted-elsewhere`; a full registration does not
 * refuse a change. `409 federation-unchanged` when nothing would change,
 * `409 federation-replaced` for a failed application that another of the same
 * name has replaced,
 * `409 federation-in-progress` while it is being set up or removed.
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {{teamId: string, environment: string, federationId: string, request: {service?: string, principalId?: string, name?: string}, actor: {userId: string, oid: string}, idempotencyKey: string, traceParent?: string, cdpRequestId?: string}} params - `teamId` is the team's id or slug
 * @param {{operations: ReturnType<typeof import('#/operations/operations-service.js').createOperationsService>, registry?: import('#/adapters/tenant-orchestrator-registry.js').TenantOrchestratorRegistry}} deps
 * @returns {Promise<{federation: object, operationId: string, replay: boolean}>}
 */
export async function changeFederation(
  db,
  locker,
  params,
  { operations, registry = tenantOrchestratorRegistry }
) {
  const context = {
    ...(await adminContext(db, params, 'change an application')),
    locker,
    operations,
    registry
  }
  const { environment, federationId, request } = params

  return audited(
    db,
    context,
    ACTIONS.CHANGE,
    'Failed to change the application',
    () =>
      underTeamLock(locker, context.teamId, () =>
        underLock(locker, context.teamId, environment, async () =>
          changeUnderLock(db, context, {
            entry: await requireLiveEntry(db, context, federationId),
            request,
            federationId
          })
        )
      )
  )
}

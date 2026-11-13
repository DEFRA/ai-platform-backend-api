import { tenantOrchestratorRegistry } from '#/adapters/tenant-orchestrator-registry.js'
import { isFederationItem } from '#/operations/operation-items.js'
import { findByIdempotencyKey } from '#/operations/operation-repository.js'
import { projectOperation } from '#/operations/operation-projection.js'
import { teamEnvironments } from '#/services/team-deployment-service.js'
import { resolveTeamTarget } from '#/services/team-desired-state.js'
import { findMemberTeam } from '#/services/team-environments-service.js'
import {
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
  audited,
  auditRefusal,
  auditSuccess,
  dropEntry,
  federationRefused,
  findEntry,
  isAcceptedFor,
  newEntry,
  operationRequestOf,
  recordEntry,
  requireSameRequest,
  underLock,
  underTeamLock,
  underTrustLock
} from '#/services/team-federation-support.js'

// Asking for an application in each environment, and the dry run of its checks.

/**
 * Says, for each environment asked for, why the application cannot be
 * federated there, or null: a dry run of the checks the request makes, with
 * no side effects. For any team member.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, request: {host: string, service?: string, principalId?: string, name?: string, environments: string[]}, actor: {userId: string}}} params - `teamId` is the team's id or slug
 * @param {{registry?: import('#/adapters/tenant-orchestrator-registry.js').TenantOrchestratorRegistry}} [deps]
 * @returns {Promise<{environments: Array<{environment: string, code: string|null}>}>}
 */
export async function checkFederation(
  db,
  { teamId: teamRef, request, actor },
  { registry = tenantOrchestratorRegistry } = {}
) {
  const { teamId, team } = await findMemberTeam(db, teamRef, actor)
  const definition = definitionOf(request)
  const registrations = await readRegistrations(db, {
    teamId,
    team,
    environments: request.environments,
    registry
  })

  return {
    environments: await Promise.all(
      request.environments.map(async (environment) => ({
        environment,
        code: await refusalFor(db, {
          teamId,
          environment,
          registration: registrations.get(environment),
          definition
        })
      }))
    )
  }
}

// The environments in the order this instance lists them, then any other.
function inFixedOrder(environments) {
  const order = teamEnvironments()
  const rank = (environment) =>
    order.includes(environment) ? order.indexOf(environment) : order.length

  return [...environments].sort((a, b) => rank(a) - rank(b))
}

// The operation a key already made in an environment, checked to be the same
// request.
async function replayIn(db, context, environment) {
  const { teamId, idempotencyKey, definition } = context
  const key = `${idempotencyKey}:${environment}`
  const operation = await findByIdempotencyKey(db, { teamId, key })

  if (!operation) {
    return null
  }

  requireSameRequest(
    operation,
    key,
    federationFingerprintOf('add', environment, definition)
  )

  return operation
}

// The application a key made in an environment: the one recorded under the
// key, among those on the operation (a request merged into a waiting
// operation has its own application there, beside the others). The
// operation is projected again, so a replay restores what a failure after
// the save left unprojected.
async function existingResult(db, context, environment, operation) {
  const { teamId, idempotencyKey } = context
  const key = `${idempotencyKey}:${environment}`
  const items = operation.items.filter(isFederationItem)

  await projectOperation(db, operation)

  const doc = await db
    .collection('teamDeployments')
    .findOne({ teamId, environment })
  const entries = doc?.federations ?? []
  const entry =
    entries.find(
      (found) =>
        found.idempotencyKey === key &&
        items.some(({ entryId }) => entryId === found.id)
    ) ?? entries.find(({ id }) => id === items[0]?.entryId)

  return {
    environment,
    id: entry?.id ?? items[0].entryId,
    status: entry?.status ?? FEDERATION_STATUS.SETTING_UP,
    operationId: operation._id
  }
}

// Records the application and asks for its operation, under the environment's
// lock. A refusal leaves nothing behind: the entry is dropped.
async function queueApplication(db, context, environment) {
  const { teamId, definition, idempotencyKey, operations } = context
  const scope = { teamId, environment }
  const key = `${idempotencyKey}:${environment}`
  const entry = newEntry(definition, {
    actor: context.actor,
    idempotencyKey: key
  })

  await recordEntry(db, scope, entry)

  try {
    const target = await resolveTeamTarget(db, scope)
    const { operation, replay } = await operations.request(
      operationRequestOf(
        { ...context, target },
        environment,
        {
          entryId: entry.id,
          change: 'add',
          generation: entry.generation,
          name: definition.name,
          federation: definition
        },
        {
          idempotencyKey: key,
          requestFingerprint: federationFingerprintOf(
            'add',
            environment,
            definition
          )
        }
      )
    )

    if (replay) {
      requireSameRequest(
        operation,
        key,
        federationFingerprintOf('add', environment, definition)
      )
      await dropEntry(db, scope, entry)

      return existingResult(db, context, environment, operation)
    }

    await projectOperation(db, operation)
    await auditSuccess(db, context, ACTIONS.REQUEST, entry, environment)

    return {
      environment,
      id: entry.id,
      status: (await findEntry(db, scope, entry.id)).status,
      operationId: operation._id
    }
  } catch (error) {
    // Dropped only if no operation took it: one that was saved before this
    // failed (its projection or audit) still commits the application, and a
    // replay of the key must find it.
    if (!(await isAcceptedFor(db, { teamId, key }, entry))) {
      await dropEntry(db, scope, entry)
    }

    throw error
  }
}

// What follows the checks of one environment, under the trust lock: the
// checks again, so that a request of another team that was ahead is seen, and
// the application queued.
async function checkedAndQueued(db, context, environment) {
  const registrations = await readRegistrations(db, {
    ...context,
    environments: [environment]
  })
  const code = await refusalFor(db, {
    teamId: context.teamId,
    environment,
    registration: registrations.get(environment),
    definition: context.definition
  })

  if (code) {
    throw federationRefused([{ environment, code }])
  }

  return {
    ...(await queueApplication(db, context, environment)),
    replay: false
  }
}

// One environment of a request: a key already used answers with its
// operation; otherwise the checks are made again under the locks, so two
// requests together see each other, and the application is queued.
async function federateIn(db, context, environment) {
  return underLock(context.locker, context.teamId, environment, async () => {
    const replayed = await replayIn(db, context, environment)

    if (replayed) {
      return {
        ...(await existingResult(db, context, environment, replayed)),
        replay: true
      }
    }

    return underTrustLock(
      context.locker,
      environment,
      trustKeyOf(context.definition),
      () => checkedAndQueued(db, context, environment)
    )
  })
}

// Every environment that has no operation for the key yet must pass the
// checks, or nothing is queued for any.
async function requireAllAllowed(db, context, environments) {
  const registrations = await readRegistrations(db, {
    ...context,
    environments
  })
  const codes = await Promise.all(
    environments.map((environment) =>
      refusalFor(db, {
        teamId: context.teamId,
        environment,
        registration: registrations.get(environment),
        definition: context.definition
      })
    )
  )
  const refused = environments.flatMap((environment, index) =>
    codes[index] ? [{ environment, code: codes[index] }] : []
  )

  if (refused.length > 0) {
    throw federationRefused(refused)
  }
}

// Each environment's operation, in order. A refusal found inside an
// environment's lock (another team took the workload since the checks) is
// kept, so that a request that queued anything answers with what it did.
async function queueEach(db, context, environments) {
  const federations = []
  const refused = []

  for (const environment of environments) {
    try {
      federations.push(await federateIn(db, context, environment)) // NOSONAR: sequential, each environment its own operation
    } catch (error) {
      if (error.data?.code !== 'federation-refused') {
        throw error
      }

      refused.push(...error.data.environments)
    }
  }

  return { federations, refused }
}

async function requestUnderTeamLock(db, context, environments) {
  const replays = await Promise.all(
    environments.map((environment) => replayIn(db, context, environment))
  )
  const pending = environments.filter((_, index) => !replays[index])

  await requireAllAllowed(db, context, pending)

  const { federations, refused } = await queueEach(db, context, environments)

  if (refused.length > 0) {
    const refusal = federationRefused(refused)

    // Nothing queued is the whole request refused; otherwise it is answered
    // with what was queued, and the refusal audited here.
    if (federations.length === 0) {
      throw refusal
    }

    await auditRefusal(db, context, ACTIONS.REQUEST, refusal)
  }

  return {
    federations: federations.map(
      ({ environment, id, status, operationId }) => ({
        environment,
        id,
        status,
        operationId
      })
    ),
    ...(refused.length > 0 ? { refused } : {}),
    replay: federations.every(({ replay }) => replay)
  }
}

/**
 * Federates an application in each environment asked for, for any team
 * member: one operation per environment, under the key `{Idempotency-Key}:{environment}`,
 * the environments in this instance's order, one request of a team at a time.
 * All or nothing up front: if any environment that does not already have the
 * key's operation would refuse it (`409 federation-refused` with each
 * environment's code), nothing is queued. `409` always means nothing was
 * queued; if another team takes the workload while the operations are being
 * queued, the request answers with those queued and `refused` for the rest.
 * A repeat of the key replays what was made and makes the rest. A key used for
 * another application is `409 idempotency-key-reused`.
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {{teamId: string, request: {host: string, service?: string, principalId?: string, name?: string, environments: string[]}, actor: {userId: string, oid: string}, idempotencyKey: string, traceParent?: string, cdpRequestId?: string}} params - `teamId` is the team's id or slug
 * @param {{operations: ReturnType<typeof import('#/operations/operations-service.js').createOperationsService>, registry?: import('#/adapters/tenant-orchestrator-registry.js').TenantOrchestratorRegistry}} deps
 * @returns {Promise<{federations: Array<{environment: string, id: string, status: string, operationId: string}>, refused?: Array<{environment: string, code: string}>, replay: boolean}>}
 */
export async function requestFederations(
  db,
  locker,
  { teamId: teamRef, request, actor, idempotencyKey, ...trace },
  { operations, registry = tenantOrchestratorRegistry }
) {
  const { teamId, team, role } = await findMemberTeam(db, teamRef, actor)
  const context = {
    ...trace,
    db,
    locker,
    operations,
    registry,
    actor,
    role,
    teamId,
    team,
    idempotencyKey,
    definition: definitionOf(request)
  }

  return audited(
    db,
    context,
    ACTIONS.REQUEST,
    'Failed to request the federation',
    () =>
      underTeamLock(locker, teamId, () =>
        requestUnderTeamLock(db, context, inFixedOrder(request.environments))
      )
  )
}

import { ObjectId } from 'mongodb'

import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { TEAM_ADMIN } from '#/common/helpers/auth/access.js'
import { acquireLockWithRetry } from '#/common/helpers/mongo-lock.js'
import { uuidv7 } from '#/common/helpers/uuid-v7.js'
import { tenantOrchestratorRegistry } from '#/adapters/tenant-orchestrator-registry.js'
import { ITEM_KINDS, isFederationItem } from '#/operations/operation-items.js'
import { findByIdempotencyKey } from '#/operations/operation-repository.js'
import { projectOperation } from '#/operations/operation-projection.js'
import { recordAuditEvent } from '#/services/audit-service.js'
import { teamEnvironments } from '#/services/team-deployment-service.js'
import { refusalOf, traceOf } from '#/services/team-deployment-submission.js'
import { resolveTeamTarget } from '#/services/team-desired-state.js'
import {
  findMemberTeam,
  requireAvailableEnvironment
} from '#/services/team-environments-service.js'
import {
  FEDERATION_HOSTS,
  FEDERATION_STATUS,
  definitionOf,
  federationFingerprintOf,
  federationViewOf,
  trustKeyOf
} from '#/services/team-federation-entries.js'
import {
  readRegistrations,
  refusalFor
} from '#/services/team-federation-checks.js'
import { principalOf } from '#/services/user-service.js'

// Federating an application to a team's registration in each environment
// (design E): one operation per environment on that environment's team file,
// the application recorded in the team's document from the moment it is asked
// for, and followed through the operation's states. Every action and every
// refusal is audited; another team is never named.

const ACTIONS = Object.freeze({
  REQUEST: 'teamFederation.request',
  CHANGE: 'teamFederation.change',
  REMOVE: 'teamFederation.remove'
})
const UPSTREAM_UNAVAILABLE = 'upstream-unavailable'
const NOT_FOUND = 'not-found'

function conflict(message, code, extra) {
  return boomWithCode(Boom.conflict, message, code, extra)
}

// What a request of this kind answers with for a key already used for another
// request.
function keyReused() {
  return conflict(
    'This idempotency key was used for a different request',
    'idempotency-key-reused'
  )
}

function requireSameRequest(operation, key, fingerprint) {
  if (operation.requestFingerprints?.[key] !== fingerprint) {
    throw keyReused()
  }
}

function lockNameOf(teamId, environment) {
  return `team-deployment:${teamId}:${environment}`
}

async function underLock(locker, teamId, environment, work) {
  const lock = await acquireLockWithRetry(
    locker,
    lockNameOf(teamId, environment)
  )

  try {
    return await work()
  } finally {
    await lock.free()
  }
}

// The code an audit records for a refusal: the API's own, or what kind of
// failure it was.
function codeOf(refusal) {
  return (
    refusal.data?.code ??
    (refusal.output.statusCode === 404 ? NOT_FOUND : UPSTREAM_UNAVAILABLE)
  )
}

function auditFederation(db, context, event) {
  return recordAuditEvent(db, {
    actor: context.actor,
    role: context.role,
    resource: 'team',
    resourceId: context.teamId,
    ...event
  })
}

// One audit event for each refusal: against the team, with its code, and for
// a refusal of several environments one each, naming the environment.
async function auditRefusal(db, context, action, refusal) {
  const refused = refusal.data?.environments ?? [
    { environment: context.environment, code: codeOf(refusal) }
  ]

  await Promise.all(
    refused.map(({ environment, code }) =>
      auditFederation(db, context, {
        action,
        outcome: 'failure',
        code,
        ...(environment ? { reason: environment } : {})
      })
    )
  )
}

// Runs the work, and audits a refusal or a failure of it before it is thrown.
async function audited(db, context, action, message, work) {
  try {
    return await work()
  } catch (error) {
    const refusal = refusalOf(error, message)

    await auditRefusal(db, context, action, refusal)

    throw refusal
  }
}

function auditSuccess(db, context, action, entry, environment) {
  return recordAuditEvent(db, {
    actor: context.actor,
    role: context.role,
    action,
    resource: 'teamFederation',
    resourceId: entry.id,
    outcome: 'success',
    reason: environment
  })
}

function federationRefused(environments) {
  return conflict(
    'The application cannot be federated in every environment asked for',
    'federation-refused',
    { environments }
  )
}

// The entry recorded for an application asked for, before its operation.
function newEntry(definition, { actor, idempotencyKey }) {
  return {
    id: new ObjectId().toString(),
    name: definition.name,
    host: definition.host,
    ...(definition.service ? { service: definition.service } : {}),
    ...(definition.principalId ? { principalId: definition.principalId } : {}),
    trustKey: trustKeyOf(definition),
    status: FEDERATION_STATUS.SETTING_UP,
    statusTimes: {},
    operationId: null,
    requestedBy: actor.userId,
    idempotencyKey,
    createdAt: new Date().toISOString(),
    failureReason: null
  }
}

function recordEntry(db, { teamId, environment }, entry) {
  return db.collection('teamDeployments').updateOne(
    { teamId, environment },
    {
      $push: { federations: entry },
      $setOnInsert: {
        teamId,
        environment,
        deployments: [],
        createdAt: entry.createdAt
      },
      $set: { updatedAt: entry.createdAt }
    },
    { upsert: true }
  )
}

function dropEntry(db, { teamId, environment }, entry) {
  return db
    .collection('teamDeployments')
    .updateOne(
      { teamId, environment },
      { $pull: { federations: { id: entry.id } } }
    )
}

async function findEntry(db, { teamId, environment }, id) {
  const doc = await db
    .collection('teamDeployments')
    .findOne({ teamId, environment })

  return (doc?.federations ?? []).find((entry) => entry.id === id) ?? null
}

// The application as the API shows it, as the projection left it.
async function viewOfEntry(db, scope, id) {
  const entry = await findEntry(db, scope, id)

  return entry ? federationViewOf(entry) : null
}

function federationItemOf(operation) {
  return operation.items.find(isFederationItem)
}

function operationRequestOf(context, environment, item, extra) {
  const { teamId, actor, target, registry } = context

  return {
    teamId,
    environment,
    target,
    items: [{ kind: ITEM_KINDS.FEDERATION, ...item }],
    requestedBy: principalOf(actor),
    requestedByUserId: actor.userId,
    // Under the mock a marker in the name forces the outcome of making or
    // changing the application; removing one, however it is named, goes
    // through, so a failed application can always be cleared away.
    mockOutcome:
      item.change === 'remove'
        ? null
        : registry.mockOutcomeOfName(item.federation.name),
    ...traceOf(context),
    ...extra
  }
}

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

async function existingResult(db, context, environment, operation) {
  const { entryId } = federationItemOf(operation)
  const entry = await findEntry(db, { ...context, environment }, entryId)

  return {
    environment,
    id: entryId,
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
    await dropEntry(db, scope, entry)

    throw error
  }
}

// One environment of a request: a key already used answers with its
// operation; otherwise the checks are made again under the lock, so two
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
  })
}

// Every environment that has no operation for the key yet must pass the
// checks, or nothing is queued for any.
async function requireAllAllowed(db, context, environments) {
  const registrations = await readRegistrations(db, {
    ...context,
    environments
  })
  const refused = []

  for (const environment of environments) {
    const code = await refusalFor(db, {
      teamId: context.teamId,
      environment,
      registration: registrations.get(environment),
      definition: context.definition
    }) // NOSONAR: sequential, the order is the answer's

    if (code) {
      refused.push({ environment, code })
    }
  }

  if (refused.length > 0) {
    throw federationRefused(refused)
  }
}

/**
 * Federates an application in each environment asked for, for any team
 * member: one operation per environment, under the key `{Idempotency-Key}:{environment}`,
 * the environments in this instance's order. All or nothing up front: if any
 * environment that does not already have the key's operation would refuse it
 * (`409 federation-refused` with each environment's code), nothing is queued.
 * A repeat of the key replays what was made and makes the rest. A key used for
 * another application is `409 idempotency-key-reused`.
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {{teamId: string, request: {host: string, service?: string, principalId?: string, name?: string, environments: string[]}, actor: {userId: string, oid: string}, idempotencyKey: string, traceParent?: string, cdpRequestId?: string}} params - `teamId` is the team's id or slug
 * @param {{operations: ReturnType<typeof import('#/operations/operations-service.js').createOperationsService>, registry?: import('#/adapters/tenant-orchestrator-registry.js').TenantOrchestratorRegistry}} deps
 * @returns {Promise<{federations: Array<{environment: string, id: string, status: string, operationId: string}>, replay: boolean}>}
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
  const environments = inFixedOrder(request.environments)

  return audited(
    db,
    context,
    ACTIONS.REQUEST,
    'Failed to request the federation',
    async () => {
      const pending = []

      for (const environment of environments) {
        if (!(await replayIn(db, context, environment))) {
          // NOSONAR: sequential, one answer per key
          pending.push(environment)
        }
      }

      await requireAllAllowed(db, context, pending)

      const federations = []

      for (const environment of environments) {
        federations.push(await federateIn(db, context, environment)) // NOSONAR: sequential, each environment its own operation
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
        replay: federations.every(({ replay }) => replay)
      }
    }
  )
}

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

function entryFieldsOf(definition) {
  return {
    'federations.$[f].name': definition.name,
    'federations.$[f].trustKey': trustKeyOf(definition),
    ...(definition.service
      ? { 'federations.$[f].service': definition.service }
      : { 'federations.$[f].principalId': definition.principalId })
  }
}

async function changeUnderLock(db, context, { entry, request, federationId }) {
  const { teamId, environment, idempotencyKey, operations } = context
  const definition = changedDefinition(entry, request)
  const fingerprint = federationFingerprintOf('change', entry.id, definition)
  const replayed = await findByIdempotencyKey(db, {
    teamId,
    key: idempotencyKey
  })

  if (replayed) {
    requireSameRequest(replayed, idempotencyKey, fingerprint)

    return {
      federation: await viewOfEntry(db, { teamId, environment }, federationId),
      operationId: replayed._id,
      replay: true
    }
  }

  await requireChangeable(db, context, entry, definition)

  const { operation } = await operations.request(
    operationRequestOf(
      context,
      environment,
      {
        entryId: entry.id,
        change: 'change',
        name: entry.name,
        federation: definition
      },
      { idempotencyKey, requestFingerprint: fingerprint }
    )
  )

  await db
    .collection('teamDeployments')
    .updateOne(
      { teamId, environment },
      { $set: entryFieldsOf(definition) },
      { arrayFilters: [{ 'f.id': entry.id }] }
    )
  await projectOperation(db, operation)
  await auditSuccess(db, context, ACTIONS.CHANGE, entry, environment)

  return {
    federation: await viewOfEntry(db, { teamId, environment }, federationId),
    operationId: operation._id,
    replay: false
  }
}

// The team and the application for an Admin's action on one application: a
// non-member is `404`, a Member `403`, an environment not offered or an
// application the team has not got (or another team's) `404`.
async function adminContext(db, params, action) {
  const { teamId, team, role } = await findMemberTeam(
    db,
    params.teamId,
    params.actor,
    { role: TEAM_ADMIN, action }
  )

  requireAvailableEnvironment(params.environment)

  return {
    ...params,
    db,
    teamId,
    team,
    role,
    target: await resolveTeamTarget(db, {
      teamId,
      environment: params.environment
    })
  }
}

async function requireEntry(db, context, federationId) {
  const entry = await findEntry(db, context, federationId)

  if (!entry) {
    throw Boom.notFound()
  }

  return entry
}

// An application to change: one that has been removed is as good as gone.
async function requireLiveEntry(db, context, federationId) {
  const entry = await requireEntry(db, context, federationId)

  if (entry.status === FEDERATION_STATUS.REMOVED) {
    throw Boom.notFound()
  }

  return entry
}

/**
 * Changes an application, for a team Admin: a CDP application's service, or
 * an Azure one's principal ID and name; one operation on the environment's
 * team file, replacing the application's entry by its name. The application
 * is compared with every other (never itself) for `409 federation-exists`
 * and `409 federation-trusted-elsewhere`; a full registration does not
 * refuse a change. `409 federation-unchanged` when nothing would change,
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
      underLock(locker, context.teamId, environment, async () =>
        changeUnderLock(db, context, {
          entry: await requireLiveEntry(db, context, federationId),
          request,
          federationId
        })
      )
  )
}

async function removeUnderLock(db, context, federationId) {
  const { teamId, environment, operations } = context
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

  const { operation } = await operations.request(
    operationRequestOf(
      context,
      environment,
      {
        entryId: entry.id,
        change: 'remove',
        name: entry.name,
        federation: definitionOf(entry)
      },
      // A removal has no key of its own: the application's status is what
      // makes a repeat harmless, and each removal is its own operation.
      { idempotencyKey: `remove:${uuidv7()}` }
    )
  )

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

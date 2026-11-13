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
import { withStatusTime } from '#/services/team-deployment-entries.js'
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
  isOccupying,
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

async function withLock(locker, name, work) {
  const lock = await acquireLockWithRetry(locker, name)

  try {
    return await work()
  } finally {
    await lock.free()
  }
}

function underLock(locker, teamId, environment, work) {
  return withLock(locker, lockNameOf(teamId, environment), work)
}

// One lock for a workload in an environment, across teams, taken last: the
// check that no other team trusts it and the recording of the application
// that reserves it are one step, so two teams asking for the same workload
// together cannot both pass the check.
function underTrustLock(locker, environment, trustKey, work) {
  return withLock(
    locker,
    `team-federation-trust:${environment}:${trustKey}`,
    work
  )
}

// One lock for a team's additions and changes, taken before any
// environment's: a second request waits for the first to finish, so it is
// checked against what the first queued.
function underTeamLock(locker, teamId, work) {
  return withLock(locker, `team-federation:${teamId}`, work)
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

// The order an application's requests were made in, which operation ids do
// not tell (their random suffixes and each host's clock do not follow it).
// Each request takes the application's next generation under the
// environment's lock and carries it on its item; the projection takes an
// operation only if its generation is not behind the last it projected.
const FIRST_GENERATION = 1

function nextGenerationOf(entry) {
  return (entry.generation ?? 0) + 1
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
    generation: FIRST_GENERATION,
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

// Whether an operation of the key took this application: its item is on the
// operation (a request merged into a waiting operation adds its own).
async function isAcceptedFor(db, { teamId, key }, entry) {
  const operation = await findByIdempotencyKey(db, { teamId, key })

  return (
    operation?.items?.some(
      (item) => isFederationItem(item) && item.entryId === entry.id
    ) ?? false
  )
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
  const pending = []

  for (const environment of environments) {
    if (!(await replayIn(db, context, environment))) {
      // NOSONAR: sequential, one answer per key
      pending.push(environment)
    }
  }

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
// application is as it was.
function releaseChange(db, { teamId, environment }, entry) {
  return db.collection('teamDeployments').updateOne(
    { teamId, environment },
    {
      $set: { 'federations.$[f].status': entry.status },
      $unset: {
        'federations.$[f].pending': '',
        'federations.$[f].statusBefore': ''
      }
    },
    { arrayFilters: [{ 'f.id': entry.id }] }
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
      await releaseChange(db, { teamId, environment }, entry)
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

// A failed application that another one has replaced in the file holds
// nothing of its own there: an addition that failed, before it committed or
// was reverted, released its name, and a new application may have taken it.
// Removing the failed one by name would remove the replacement.
async function hasBeenReplaced(db, scope, entry) {
  if (entry.status !== FEDERATION_STATUS.FAILED) {
    return false
  }

  const doc = await db.collection('teamDeployments').findOne(scope)

  return (doc?.federations ?? []).some(
    (other) =>
      other.id !== entry.id &&
      other.name === entry.name &&
      isOccupying(other.status)
  )
}

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

  if (await hasBeenReplaced(db, scope, entry)) {
    await clearReplaced(db, scope, entry)
    await auditSuccess(db, context, ACTIONS.REMOVE, entry, environment)

    return { federation: await viewOfEntry(db, scope, entry.id), done: true }
  }

  const generation = await takeGeneration(db, scope, entry)
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

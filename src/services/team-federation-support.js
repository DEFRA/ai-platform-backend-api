import { ObjectId } from 'mongodb'

import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { TEAM_ADMIN } from '#/common/helpers/auth/access.js'
import { acquireLockWithRetry } from '#/common/helpers/mongo-lock.js'
import { ITEM_KINDS, isFederationItem } from '#/operations/operation-items.js'
import { findByIdempotencyKey } from '#/operations/operation-repository.js'
import { recordAuditEvent } from '#/services/audit-service.js'
import { refusalOf, traceOf } from '#/services/team-deployment-submission.js'
import { resolveTeamTarget } from '#/services/team-desired-state.js'
import {
  findMemberTeam,
  requireAvailableEnvironment
} from '#/services/team-environments-service.js'
import {
  FEDERATION_STATUS,
  federationViewOf,
  isOccupying,
  trustKeyOf
} from '#/services/team-federation-entries.js'
import { principalOf } from '#/services/user-service.js'

// What the federation requests share (design E): the locks, the audit of each
// action and refusal, the application's entry in the team's document, the
// Admin's context for one application and the operation request.

export const ACTIONS = Object.freeze({
  REQUEST: 'teamFederation.request',
  CHANGE: 'teamFederation.change',
  REMOVE: 'teamFederation.remove'
})
const UPSTREAM_UNAVAILABLE = 'upstream-unavailable'
const NOT_FOUND = 'not-found'
const HTTP_NOT_FOUND = 404

export function conflict(message, code, extra) {
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

export function requireSameRequest(operation, key, fingerprint) {
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

export function underLock(locker, teamId, environment, work) {
  return withLock(locker, lockNameOf(teamId, environment), work)
}

// One lock for a workload in an environment, across teams, taken last: the
// check that no other team trusts it and the recording of the application
// that reserves it are one step, so two teams asking for the same workload
// together cannot both pass the check.
export function underTrustLock(locker, environment, trustKey, work) {
  return withLock(
    locker,
    `team-federation-trust:${environment}:${trustKey}`,
    work
  )
}

// One lock for a team's additions and changes, taken before any
// environment's: a second request waits for the first to finish, so it is
// checked against what the first queued.
export function underTeamLock(locker, teamId, work) {
  return withLock(locker, `team-federation:${teamId}`, work)
}

// The code an audit records for a refusal: the API's own, or what kind of
// failure it was.
function codeOf(refusal) {
  return (
    refusal.data?.code ??
    (refusal.output.statusCode === HTTP_NOT_FOUND
      ? NOT_FOUND
      : UPSTREAM_UNAVAILABLE)
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
export async function auditRefusal(db, context, action, refusal) {
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
export async function audited(db, context, action, message, work) {
  try {
    return await work()
  } catch (error) {
    const refusal = refusalOf(error, message)

    await auditRefusal(db, context, action, refusal)

    throw refusal
  }
}

export function auditSuccess(db, context, action, entry, environment) {
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

export function federationRefused(environments) {
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

export function nextGenerationOf(entry) {
  return (entry.generation ?? 0) + 1
}

// The entry recorded for an application asked for, before its operation.
export function newEntry(definition, { actor, idempotencyKey }) {
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

export function recordEntry(db, { teamId, environment }, entry) {
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

export function dropEntry(db, { teamId, environment }, entry) {
  return db
    .collection('teamDeployments')
    .updateOne(
      { teamId, environment },
      { $pull: { federations: { id: entry.id } } }
    )
}

export async function findEntry(db, { teamId, environment }, id) {
  const doc = await db
    .collection('teamDeployments')
    .findOne({ teamId, environment })

  return (doc?.federations ?? []).find((entry) => entry.id === id) ?? null
}

// The application as the API shows it, as the projection left it.
export async function viewOfEntry(db, scope, id) {
  const entry = await findEntry(db, scope, id)

  return entry ? federationViewOf(entry) : null
}

// Whether an operation of the key took this application: its item is on the
// operation (a request merged into a waiting operation adds its own).
export async function isAcceptedFor(db, { teamId, key }, entry) {
  const operation = await findByIdempotencyKey(db, { teamId, key })

  return (
    operation?.items?.some(
      (item) => isFederationItem(item) && item.entryId === entry.id
    ) ?? false
  )
}

export function operationRequestOf(context, environment, item, extra) {
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

// The team and the application for an Admin's action on one application: a
// non-member is `404`, a Member `403`, an environment not offered or an
// application the team has not got (or another team's) `404`.
export async function adminContext(db, params, action) {
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

export async function requireEntry(db, context, federationId) {
  const entry = await findEntry(db, context, federationId)

  if (!entry) {
    throw Boom.notFound()
  }

  return entry
}

// An application to change: one that has been removed is as good as gone.
export async function requireLiveEntry(db, context, federationId) {
  const entry = await requireEntry(db, context, federationId)

  if (entry.status === FEDERATION_STATUS.REMOVED) {
    throw Boom.notFound()
  }

  return entry
}

// A failed application that another one has replaced in the file holds
// nothing of its own there: an addition that failed, before it committed or
// was reverted, released its name, and a new application may have taken it.
// Removing the failed one by name would remove the replacement.
export async function hasBeenReplaced(db, scope, entry) {
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

import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { TEAM_ADMIN, requireTeamRole } from '#/common/helpers/auth/access.js'
import { acquireLockWithRetry } from '#/common/helpers/mongo-lock.js'
import { tenantOrchestratorRegistry } from '#/adapters/tenant-orchestrator-registry.js'
import { ITEM_KINDS, requestedLimitsOf } from '#/operations/operation-items.js'
import {
  findByIdempotencyKey,
  findTeamOperations
} from '#/operations/operation-repository.js'
import { recordAuditEvent } from '#/services/audit-service.js'
import { teamEnvironments } from '#/services/team-deployment-service.js'
import { refusalOf, traceOf } from '#/services/team-deployment-submission.js'
import { requireAvailableEnvironment } from '#/services/team-environments-service.js'
import { resolveTeamTarget } from '#/services/team-desired-state.js'
import { limitBoundsFor, withinBounds } from '#/services/team-limit-bounds.js'
import {
  MAX_OPERATIONS_LIMIT,
  viewsOf
} from '#/services/team-operations-service.js'
import { readTeamFiles, requireTeamId } from '#/services/team-service.js'
import { principalOf } from '#/services/user-service.js'

const CHANGE_ACTION = 'teamLimits.change'
const UPSTREAM_UNAVAILABLE = 'upstream-unavailable'

function notSetUp() {
  return boomWithCode(
    Boom.conflict,
    'This environment is not set up for the team yet, so there are no limits to change',
    'environment-not-set-up'
  )
}

function sameLimits(a, b) {
  return (
    a?.tokensPerMinute === b?.tokensPerMinute &&
    a?.requestsPerMinute === b?.requestsPerMinute
  )
}

/**
 * What a limits request asks for, recorded under its `Idempotency-Key` on the
 * operation it made or joined: a key replayed for another request, in
 * another environment or for other limits, is not that request's.
 * @param {string} environment
 * @param {{tokensPerMinute: number, requestsPerMinute: number}} limits
 * @returns {string}
 */
export function limitsFingerprintOf(
  environment,
  { tokensPerMinute, requestsPerMinute }
) {
  return `limits:${environment}:${tokensPerMinute}:${requestsPerMinute}`
}

// A key replayed for another request (another environment, other limits, a
// model request, or a different request that merged into the same operation)
// is refused, never answered with the operation. The operation records what
// each key asked for.
function requireSameRequest(
  operation,
  { idempotencyKey, environment, limits }
) {
  const asked = operation.requestFingerprints?.[idempotencyKey]

  if (asked !== limitsFingerprintOf(environment, limits)) {
    throw boomWithCode(
      Boom.conflict,
      'This idempotency key was used for a different request',
      'idempotency-key-reused'
    )
  }
}

// The team's file in the environment, from `main`: what the team holds now.
async function readFile(registry, team, environment) {
  const others = teamEnvironments().filter((name) => name !== environment)
  const [file] = await readTeamFiles(registry, team, others)

  return file?.document ?? null
}

// What the team will have once the changes already asked for land: the newest
// open change that sets limits, else the file's own.
async function effectiveLimits(db, { teamId, environment, document }) {
  const open = await findTeamOperations(db, {
    teamId,
    environment,
    status: 'open',
    limit: MAX_OPERATIONS_LIMIT
  })

  return (
    open.map(({ items }) => requestedLimitsOf(items ?? [])).find(Boolean) ??
    document.gateway?.limits
  )
}

// The refusals of a request that may be made: the environment is set up,
// the limits sit within the catalogue's bounds, and they change something.
async function requireAllowed(db, params, registry) {
  const { teamId, teamSlug, environment, limits } = params
  const document = await readFile(registry, teamSlug, environment)
  const bounds = document
    ? await limitBoundsFor(db, { environment, document })
    : null

  if (!bounds) {
    throw notSetUp()
  }

  if (!withinBounds(bounds, limits)) {
    throw boomWithCode(
      Boom.badRequest,
      'The limits are outside the bounds the catalogue allows for this environment',
      'limits-out-of-bounds',
      { limitBounds: bounds }
    )
  }

  if (
    sameLimits(
      limits,
      await effectiveLimits(db, { teamId, environment, document })
    )
  ) {
    throw boomWithCode(
      Boom.conflict,
      'The team already has these limits',
      'limits-unchanged'
    )
  }
}

function audit(db, { actor, role, teamId, environment, limits }, extra) {
  return recordAuditEvent(db, {
    actor,
    role,
    action: CHANGE_ACTION,
    resource: 'team',
    resourceId: teamId,
    reason: `${environment}: ${limits.tokensPerMinute} tokens, ${limits.requestsPerMinute} requests a minute`,
    ...extra
  })
}

// Asks for the operation that sets the limits, recording what the key asked
// for so the key is told apart if it is replayed for another request.
function requestChange(context, { operations, target }) {
  const { teamId, environment, limits, actor, idempotencyKey } = context

  return operations.request({
    teamId,
    environment,
    target,
    items: [{ kind: ITEM_KINDS.LIMITS, change: 'set', limits }],
    requestedBy: principalOf(actor),
    requestedByUserId: actor.userId,
    idempotencyKey,
    requestFingerprint: limitsFingerprintOf(environment, limits),
    ...traceOf(context)
  })
}

// Everything that depends on the file's state, under the team's lock, so two
// requests asking together see each other's: a replayed key answers with its
// operation; otherwise the request must be allowed, and is then queued.
async function decideAndRequest(db, context, deps) {
  const { teamId, idempotencyKey } = context
  const replayed = await findByIdempotencyKey(db, {
    teamId,
    key: idempotencyKey
  })

  if (replayed) {
    requireSameRequest(replayed, context)

    return { operation: replayed, replay: true }
  }

  await requireAllowed(db, context, deps.registry)

  const { operation, replay } = await requestChange(context, deps)

  if (replay) {
    requireSameRequest(operation, context)
  } else {
    await audit(db, context, { outcome: 'success' })
  }

  return { operation, replay }
}

/**
 * Changes a team's limits in one environment, for a team Admin: one operation
 * on the team's file that sets `gateway.limits` and nothing else, followed
 * through the same states as a model change. The limits must sit within the
 * catalogue's bounds for the models the team holds there (`400
 * limits-out-of-bounds`), the environment must be set up (`409
 * environment-not-set-up`) and the limits must change what the team has or is
 * about to have (`409 limits-unchanged`); these are decided under the team's
 * lock, as are model requests, so concurrent requests see one another. While
 * another change holds the file, the request waits and merges into the next.
 * Replaying an `Idempotency-Key` returns its operation; a key used for
 * another request, even one that merged into the same operation, is
 * `409 idempotency-key-reused`. A Member is refused `403` and
 * a non-member `404`, both audited, as is every refusal and the change.
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {{teamId: string, environment: string, limits: {tokensPerMinute: number, requestsPerMinute: number}, actor: {userId: string, oid: string}, idempotencyKey: string, traceParent?: string, cdpRequestId?: string}} params - `teamId` is the team's id or slug
 * @param {{operations: ReturnType<typeof import('#/operations/operations-service.js').createOperationsService>, registry?: import('#/adapters/tenant-orchestrator-registry.js').TenantOrchestratorRegistry}} deps
 * @returns {Promise<{operation: object, replay: boolean}>}
 */
export async function changeTeamLimits(
  db,
  locker,
  { teamId: teamRef, environment, limits, actor, idempotencyKey, ...trace },
  { operations, registry = tenantOrchestratorRegistry }
) {
  const teamId = await requireTeamId(db, teamRef)

  const role = await requireTeamRole(db, actor, teamId, {
    role: TEAM_ADMIN,
    action: "change the team's limits"
  })

  requireAvailableEnvironment(environment)

  // Resolved first: a team that cannot have a file built has nothing to change.
  const target = await resolveTeamTarget(db, { teamId, environment })
  const context = {
    ...trace,
    actor,
    role,
    teamId,
    teamSlug: target.team,
    environment,
    limits,
    idempotencyKey
  }

  try {
    const lock = await acquireLockWithRetry(
      locker,
      `team-deployment:${teamId}:${environment}`
    )

    try {
      const { operation, replay } = await decideAndRequest(db, context, {
        operations,
        registry,
        target
      })

      return { operation: (await viewsOf(db, [operation]))[0], replay }
    } finally {
      await lock.free()
    }
  } catch (error) {
    const refusal = refusalOf(error, 'Failed to request the limits change')

    await audit(db, context, {
      outcome: 'failure',
      code: refusal.data?.code ?? UPSTREAM_UNAVAILABLE
    })

    throw refusal
  }
}

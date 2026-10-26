import { uuidv7 } from '#/common/helpers/uuid-v7.js'
import {
  findOperation,
  insertOperation,
  isDuplicateKey,
  operationsOf
} from '#/operations/operation-repository.js'
import { decideEvent, factsOf } from '#/operations/operation-state-machine.js'
import { writeOperation } from '#/operations/operation-writer.js'
import { recordAuditEvent } from '#/services/audit-service.js'

// External operations (plan 5, DD22): a run the portal did not start - a
// manual `submit`, a promote, a release `autoPin`, a manual apply,
// `reconcile-all`, or an engineer's break-glass commit - is recorded once as
// an operation of its own, with its source and actor, holding no slot, so the
// portal has one history of every change. It is corroborated first; an event
// that is not is dropped.

function newExternal(event, { type, externalKey }) {
  const now = new Date().toISOString()

  return {
    _id: uuidv7(),
    type,
    externalKey,
    teamId: event.team ?? event.environment,
    environment: event.environment,
    target: {
      repository: event.repository,
      team: event.team,
      path: event.path
    },
    items: [],
    requestedBy: event.requestedBy,
    traceparent: event.traceparent ?? null,
    cdpRequestId: event.cdpRequestId ?? null,
    source: event.source,
    state: event.status,
    stateVersion: 0,
    attempt: 1,
    reconcileCount: 0,
    gitops: factsOf(event),
    history: [
      {
        state: event.status,
        at: event.timestamp,
        receivedAt: now,
        source: event.source,
        eventId: event.eventId
      }
    ],
    outbox: [],
    outboxPending: false,
    createdAt: now,
    updatedAt: now
  }
}

const MAX_ATTEMPTS = 4

// A later event of a run already recorded moves it on by the same rank
// rule, and has no other effect. When another writer moves the operation
// first the decision is made again on what it wrote; an event whose update
// was never persisted is never reported as advanced, so it is redelivered.
async function advanceExternal(ctx, first, event) {
  let operation = first

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const decision = decideEvent(operation, event)

    if (['duplicate', 'ignore'].includes(decision.kind)) {
      return { outcome: 'duplicate', operation }
    }

    const written = await writeOperation(ctx, operation, {
      state: decision.kind === 'advance' ? decision.state : undefined,
      facts: decision.facts,
      source: event.source,
      eventId: event.eventId,
      eventAt: event.timestamp
    })

    if (written) {
      return { outcome: 'advanced', operation: written }
    }

    operation = await findOperation(ctx.db, operation._id) // NOSONAR: sequential compare-and-set retry
  }

  throw new Error(`Operation ${operation._id} kept moving; try again`)
}

/**
 * Records runs and commits the portal did not start.
 * @param {{db: import('mongodb').Db, corroborator: object, settings: object, logger?: import('pino').Logger}} deps
 */
export function createExternalOperations({
  db,
  corroborator,
  settings,
  logger
}) {
  async function audit(operation, event) {
    await recordAuditEvent(db, {
      actorUserId: event.requestedBy,
      action: 'operation.external',
      resource: 'operation',
      resourceId: operation._id,
      outcome: 'success',
      code: operation.type,
      reason: `${event.source} ${event.status}`
    })
  }

  function advance(operation, event) {
    return advanceExternal({ db, settings, logger }, operation, event)
  }

  async function recordOnce(event, { type, externalKey, verdict }) {
    const existing = await operationsOf(db).findOne({ externalKey })

    if (existing) {
      return advance(existing, event)
    }

    const checked = await verdict()

    if (!checked.ok) {
      logger?.warn(
        { eventId: event.eventId, reason: checked.reason },
        'An event for a run the portal has no operation for was not corroborated, dropped'
      )

      return { outcome: 'uncorroborated' }
    }

    const operation = newExternal(event, { type, externalKey })

    try {
      await insertOperation(db, operation)
    } catch (error) {
      if (isDuplicateKey(error)) {
        return advance(await operationsOf(db).findOne({ externalKey }), event)
      }

      throw error
    }

    await audit(operation, event)

    return { outcome: 'recorded', operation }
  }

  /**
   * Records an event with no operation, or an unknown one, once per
   * `{repository}:{runId}` as `external.{action}`.
   * @param {object} event
   */
  function record(event) {
    return recordOnce(event, {
      type: `external.${event.action}`,
      externalKey: `${event.repository}:${event.runId}`,
      verdict: () => corroborator.corroborateRun(event)
    })
  }

  /**
   * Records an engineer's break-glass commit once, as a `break-glass`
   * operation for the audit trail: it moves the projection of nothing; the
   * next portal write reads the new revision.
   * @param {object} event
   */
  function recordBreakGlass(event) {
    return recordOnce(event, {
      type: 'break-glass',
      externalKey: `${event.repository}:${event.commitSha}`,
      verdict: () => corroborator.corroborateCommit(event)
    })
  }

  return { record, recordBreakGlass }
}

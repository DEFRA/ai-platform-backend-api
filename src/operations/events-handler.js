import { validateEvent } from '#/contracts/message-validators.js'
import { findOperation } from '#/operations/operation-repository.js'
import {
  FAILURE_CODES,
  projectOperation
} from '#/operations/operation-projection.js'
import {
  CHECKS_FAILED,
  DEPLOYED,
  DEPLOY_FAILED,
  OPERATION_TYPES,
  QUEUED,
  RETRY_APPLY,
  decideEvent,
  failurePolicy,
  heldDeadline,
  nextResubmitAt
} from '#/operations/operation-state-machine.js'
import {
  writeOperation,
  writeWithRetry
} from '#/operations/operation-writer.js'

const MAX_TRIES = 4

// The statuses of an event that means the commit happened.
const COMMITTED_STATUSES = new Set([
  'committed',
  'deploying',
  'deployed',
  DEPLOY_FAILED
])

class TransientError extends Error {}

/**
 * The events handler (plan 5, 6.1): validates an `aip.gitops.event/1`, finds
 * its operation, lets the state machine decide, corroborates a failure
 * before acting on it, and persists by compare-and-set. It returns an
 * outcome for anything it accepted or dropped; it throws only for a transient
 * failure, so the message is redelivered (and can reach the dead-letter
 * queue, like any other).
 * @param {object} deps
 * @param {{db: import('mongodb').Db, settings: object, logger?: import('pino').Logger}} deps.ctx
 * @param {object} deps.operations - the operations service
 * @param {{verify: (id: string) => Promise<object|null>}} deps.verifier
 * @param {{corroborateFailure: Function}} deps.corroborator
 * @param {{apply: Function, get: Function}} deps.controls
 * @param {{record: Function, recordBreakGlass: Function}} deps.external
 */
export function createEventsHandler(deps) {
  return {
    /**
     * Handles one message from the events queue.
     * @param {unknown} raw - the parsed message body
     * @returns {Promise<{outcome: string, reason?: string, operationId?: string}>}
     */
    handle: (raw) => handleEvent(deps, raw)
  }
}

function drop({ ctx }, event, reason) {
  ctx.logger?.warn(
    { eventId: event?.eventId, operationId: event?.operationId, reason },
    'An event was dropped'
  )

  return { outcome: 'dropped', reason }
}

async function handlePause(deps, event) {
  const result = await deps.controls.apply(event)

  if (result.outcome === 'applied' && event.status === 'resumed') {
    await resumeHeld(deps, event)
  }

  return result
}

// What an operation held or deferred does when the environment resumes.
function resumeOne({ ctx, operations }, operation) {
  if (operation.held) {
    return operations.resubmit(operation._id)
  }

  return operation.deferred === 'retry'
    ? operations.publishApply(operation._id)
    : makeDue(ctx, operation._id)
}

// On resume, held writes are rebuilt from main and resubmitted, and
// deferred work is re-armed (plan 5, "Pause").
async function resumeHeld(deps, event) {
  const held = await deps.ctx.db
    .collection('operations')
    .find({
      environment: event.environment,
      slot: { $in: ['active', 'revert'] },
      $or: [{ held: { $exists: true } }, { deferred: { $exists: true } }]
    })
    .toArray()

  // One at a time by design: a failure stops the resume and the redelivery
  // finds the rest still held.
  for (const operation of held) {
    await resumeOne(deps, operation) // NOSONAR: sequential by design, see above
  }
}

// A deferred revert is made due at once for the sweeper; the write is tried
// again when another writer moved the operation first.
function makeDue(ctx, operationId) {
  return writeWithRetry(ctx, operationId, (current) =>
    current.deferred ? { deadlineAt: new Date().toISOString() } : null
  )
}

function needsCorroboration(event) {
  return event.status === CHECKS_FAILED || event.status === DEPLOY_FAILED
}

async function corroborate({ corroborator }, event, operation) {
  const verdict = await corroborator.corroborateFailure(event, operation)

  if (verdict.ok) {
    return verdict
  }

  if (verdict.transient) {
    throw new TransientError(`Cannot corroborate yet: ${verdict.reason}`)
  }

  return verdict
}

function holdDueAt(settings, operation, paused) {
  if (paused) {
    return heldDeadline(settings.deadlineHeldMs, operation.heldPasses ?? 0)
  }

  return nextResubmitAt(operation.resubmitCount ?? 0, settings.resubmitMax)
}

// A refusal from a run that started before the latest `resumed` is
// resubmitted at once: the pause it saw has ended.
async function isStaleRefusal({ controls }, operation, event, run, paused) {
  const control = await controls.get(operation.environment)
  const startedAt = run?.runStartedAt ?? event.timestamp

  return paused && !control.paused && control.runStartedAt > startedAt
}

// A revert refused for a stale base or a conflict ends at once: it carries the
// rollback it was built with, so the same refusal is certain again. It
// alerts, and the failed parent keeps the file until an engineer acts
// (plan 5, "Revert"). Only a pause holds a revert.
async function endRevertRefused(deps, operation, decision, event) {
  const ended = await advanceWrite(
    deps,
    operation,
    { state: CHECKS_FAILED, facts: decision.facts },
    event
  )

  if (ended) {
    await deps.operations.finish(ended)
  }

  return ended
}

async function holdWrite(deps, operation, decision, event, run) {
  const { ctx, operations } = deps
  const code = decision.code
  const paused = code === 'paused'

  if (!paused && operation.type === OPERATION_TYPES.REVERT) {
    return endRevertRefused(deps, operation, decision, event)
  }

  const dueAt = holdDueAt(ctx.settings, operation, paused)

  if (!paused && !dueAt) {
    return endAsTimedOut(deps, operation, decision, event)
  }

  const staleRefusal = await isStaleRefusal(deps, operation, event, run, paused)

  const written = await writeOperation(ctx, operation, {
    state: QUEUED,
    facts: decision.facts,
    source: event.source,
    eventId: event.eventId,
    eventAt: event.timestamp,
    set: {
      held: {
        code,
        since: operation.heldSince ?? new Date().toISOString()
      }
    },
    deadlineAt: dueAt
  })

  if (written && staleRefusal) {
    await operations.resubmit(written._id)
  }

  return written
}

async function endAsTimedOut({ ctx }, operation, decision, event) {
  const written = await writeOperation(ctx, operation, {
    state: 'timed-out',
    facts: decision.facts,
    set: {
      leftState: operation.state,
      error: {
        code: FAILURE_CODES.TIMED_OUT,
        message: event.failureReason?.message ?? 'Resubmission ran out',
        retryable: false
      }
    },
    unset: ['held'],
    source: event.source,
    eventId: event.eventId,
    deadlineAt: null
  })

  if (written) {
    ctx.logger?.error(
      {
        operationId: written._id,
        code: FAILURE_CODES.TIMED_OUT,
        alert: true
      },
      'A write was refused again and again; it needs a platform engineer'
    )
  }

  return written
}

async function deferWrite({ ctx }, operation, decision, event) {
  return writeOperation(ctx, operation, {
    facts: decision.facts,
    set: {
      deferred: 'retry',
      deferredSince: operation.deferredSince ?? new Date().toISOString()
    },
    push: {
      history: {
        state: operation.state,
        at: event.timestamp,
        receivedAt: new Date().toISOString(),
        source: event.source,
        eventId: event.eventId
      }
    },
    deadlineAt: heldDeadline(
      ctx.settings.deadlineHeldMs,
      operation.heldPasses ?? 0
    )
  })
}

function failureFields(state, event) {
  if (state === CHECKS_FAILED) {
    return {
      error: {
        code: FAILURE_CODES.CHECKS_FAILED,
        message: event.failureReason.message,
        retryable: false
      }
    }
  }

  if (state === DEPLOY_FAILED) {
    return {
      error: {
        code: FAILURE_CODES.DEPLOY_FAILED,
        message: event.failureReason.message,
        retryable: false
      },
      lastFailure: { runId: event.runId, runAttempt: event.runAttempt }
    }
  }

  return {}
}

function advanceUnset(operation, decision, pending) {
  const failed = [CHECKS_FAILED, DEPLOY_FAILED].includes(decision.state)
  const unset = ['held', 'deferred', 'deferredAttempt', 'heldSince'].filter(
    (field) => !(field in pending.set)
  )

  if (pending.set.deferred === 'revert') {
    unset.push('revertId')
  }

  if (decision.recovered) {
    unset.push('error', 'retrying', 'lastFailure', 'followUp')
  }

  if (!failed && operation.error) {
    unset.push('error')
  }

  return unset
}

// Whether an accepted event ends the operation for good, leaving its file to
// be freed: a refusal that is not retried, or an apply failure that will not
// be retried or reverted (a revert's own, or one that is not attributable).
function endsTheFile(operation, decision, event) {
  if (decision.state === CHECKS_FAILED) {
    return true
  }

  return (
    decision.state === DEPLOY_FAILED &&
    (operation.type === OPERATION_TYPES.REVERT ||
      failurePolicy(operation, event) === 'alert')
  )
}

// What a counted `deploy-failed` leads to, persisted with the failure so a
// redelivery or the sweep can do it if the handler stopped first: the retry's
// attempt with `followUp: 'retry-apply'` (done at the next sweep), or the
// revert deferred for its grace.
function pendingAction(operation, decision, event, settings) {
  const none = { set: {} }

  if (
    decision.state !== DEPLOY_FAILED ||
    endsTheFile(operation, decision, event)
  ) {
    return none
  }

  if (failurePolicy(operation, event) === 'retry-apply') {
    return {
      set: {
        followUp: RETRY_APPLY,
        deferredAttempt: operation.attempt + 1
      },
      deadlineAt: new Date(Date.now() + settings.sweepIntervalMs).toISOString()
    }
  }

  return {
    set: { deferred: 'revert' },
    deadlineAt: new Date(Date.now() + settings.revertGraceMs).toISOString()
  }
}

async function advanceWrite({ ctx }, operation, decision, event) {
  const pending = pendingAction(operation, decision, event, ctx.settings)

  return writeOperation(ctx, operation, {
    state: decision.state,
    facts: decision.facts,
    set: { ...failureFields(decision.state, event), ...pending.set },
    unset: advanceUnset(operation, decision, pending),
    source: event.source,
    eventId: event.eventId,
    eventAt: event.timestamp,
    finishes: endsTheFile(operation, decision, event),
    ...(pending.deadlineAt ? { deadlineAt: pending.deadlineAt } : {})
  })
}

// What a counted `deploy-failed` leads to (plan 5, "Rules"); the retry and
// the revert were persisted with the failure.
async function afterDeployFailed(deps, operation, event) {
  const { ctx, operations } = deps

  if (operation.type === OPERATION_TYPES.REVERT) {
    ctx.logger?.error(
      { operationId: operation._id, alert: true },
      'A revert failed to apply and needs a platform engineer'
    )

    return operations.finish(operation)
  }

  const policy = failurePolicy(operation, event)

  if (policy === 'retry-apply') {
    return operations.completeFollowUp(operation)
  }

  if (policy === 'revert') {
    return operation
  }

  ctx.logger?.error(
    {
      operationId: operation._id,
      environment: operation.environment,
      alert: true
    },
    'Unattributed tenants apply failure needs a platform engineer'
  )

  return operations.finish(operation)
}

// A parent that recovers cancels a revert not yet committed; only one that
// was committed needs an engineer to check the file.
async function afterDeployed({ ctx, operations, verifier }, written, decision) {
  if (decision.recovered && written.revertId) {
    const revert = await operations.settleRecoveredRevert(written)

    if (revert === 'committed') {
      ctx.logger?.error(
        { operationId: written._id, alert: true },
        'The apply recovered after its revert was committed; an engineer should check the file'
      )
    }
  }

  await verifier.verify(written._id)
}

async function afterWrite(deps, written, decision, event) {
  if (decision.kind !== 'advance') {
    return
  }

  switch (decision.state) {
    case DEPLOYED:
      await afterDeployed(deps, written, decision)
      break
    case CHECKS_FAILED:
      await deps.operations.finish(written)
      break
    case DEPLOY_FAILED:
      await afterDeployFailed(deps, written, event)
      break
    default:
      break
  }
}

async function applyDecision(deps, operation, decision, event, run) {
  switch (decision.kind) {
    case 'fill':
    case 'replace-run':
      return Object.keys(decision.facts).length === 0
        ? operation
        : writeOperation(deps.ctx, operation, { facts: decision.facts })
    case 'hold':
      return holdWrite(deps, operation, decision, event, run)
    case 'defer':
      return deferWrite(deps, operation, decision, event)
    default:
      return advanceWrite(deps, operation, decision, event)
  }
}

function isRepeat(decision) {
  return decision.kind === 'duplicate' || decision.kind === 'ignore'
}

function requiresCorroboration(decision, event) {
  return (
    !['fill', 'replace-run'].includes(decision.kind) &&
    needsCorroboration(event)
  )
}

async function handleOperationEvent(deps, event, first) {
  const { db } = deps.ctx
  let operation = first
  let verdict = null

  // Each pass reads the operation as it is now and writes by compare-and-set,
  // so the passes cannot overlap.
  for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
    const decision = decideEvent(operation, event)

    if (isRepeat(decision)) {
      // A redelivery repairs what the first delivery did not finish: the
      // projection, and the follow-up persisted with the transition (the
      // freeing of the file, or the retry of an apply).
      await projectOperation(db, operation) // NOSONAR: sequential compare-and-set retry

      if (operation.followUp) {
        await deps.operations.completeFollowUp(operation)
      }

      return { outcome: decision.kind }
    }

    if (requiresCorroboration(decision, event)) {
      verdict ??= await corroborate(deps, event, operation)

      if (!verdict.ok) {
        return drop(deps, event, verdict.reason)
      }
    }

    const written = await applyDecision(
      deps,
      operation,
      decision,
      event,
      verdict?.run
    )

    if (written) {
      await afterWrite(deps, written, decision, event)

      return { outcome: decision.kind, operationId: written._id }
    }

    operation = await findOperation(db, operation._id)
  }

  throw new TransientError(`Operation ${operation._id} kept moving`)
}

function targetMatches(operation, event) {
  return (
    operation.environment === event.environment &&
    operation.target.team === event.team &&
    operation.target.path === event.path &&
    operation.target.repository === event.repository
  )
}

// A revert cancelled because its parent recovered (plan 5, "Revert").
function isCancelledRevert(operation) {
  return (
    operation.type === OPERATION_TYPES.REVERT &&
    operation.error?.code === FAILURE_CODES.REVERT_CANCELLED
  )
}

// The cancel only ended the operation here: a command already sent still runs.
// An event that says it committed (or went on to apply) means the rollback
// landed over the recovered change, which is the revert "already committed"
// of AC22: an engineer is alerted, and the cancelled operation does not move.
function handleCancelledRevert({ ctx }, event, operation) {
  if (COMMITTED_STATUSES.has(event.status)) {
    ctx.logger?.error(
      {
        operationId: operation._id,
        parentId: operation.parentId,
        eventId: event.eventId,
        status: event.status,
        alert: true
      },
      'A cancelled revert was committed after all: the failed change was rolled back over the recovered apply, and an engineer should check the file'
    )
  }

  return { outcome: 'dropped', reason: 'revert-cancelled' }
}

async function handleEvent(deps, raw) {
  const { ctx, external } = deps
  const { valid, errors } = validateEvent(raw)

  if (!valid) {
    ctx.logger?.warn(
      { eventId: raw?.eventId, errors },
      'An invalid event was dropped'
    )

    return { outcome: 'dropped', reason: 'invalid' }
  }

  const event = raw

  if (!ctx.settings.environments.includes(event.environment)) {
    return drop(deps, event, 'unknown-environment')
  }

  if (event.action === 'pause') {
    return handlePause(deps, event)
  }

  if (event.action === 'break-glass') {
    return external.recordBreakGlass(event)
  }

  const operation = event.operationId
    ? await findOperation(ctx.db, event.operationId)
    : null

  if (!operation || operation.externalKey) {
    return external.record(event)
  }

  if (!targetMatches(operation, event)) {
    return drop(deps, event, 'target-differs')
  }

  if (isCancelledRevert(operation)) {
    return handleCancelledRevert(deps, event, operation)
  }

  return handleOperationEvent(deps, event, operation)
}

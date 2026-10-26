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
  decideEvent,
  failurePolicy,
  heldDeadline,
  nextResubmitAt
} from '#/operations/operation-state-machine.js'
import { writeOperation } from '#/operations/operation-writer.js'

const MAX_TRIES = 4

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

// On resume, held writes are rebuilt from main and resubmitted, and
// deferred work is re-armed (plan 5, "Pause").
async function resumeHeld({ ctx, operations }, event) {
  const held = await ctx.db
    .collection('operations')
    .find({
      environment: event.environment,
      slot: { $in: ['active', 'revert'] },
      $or: [{ held: { $exists: true } }, { deferred: { $exists: true } }]
    })
    .toArray()

  for (const operation of held) {
    if (operation.held) {
      await operations.resubmit(operation._id)
    } else if (operation.deferred === 'retry') {
      await operations.publishApply(operation._id)
    } else {
      await writeOperation(ctx, operation, {
        deadlineAt: new Date().toISOString()
      })
    }
  }
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

async function holdWrite(deps, operation, decision, event, run) {
  const { ctx, operations } = deps
  const code = decision.code
  const paused = code === 'paused'
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

function advanceUnset(operation, decision) {
  const failed = [CHECKS_FAILED, DEPLOY_FAILED].includes(decision.state)
  const unset = ['held', 'deferred', 'deferredAttempt', 'heldSince']

  if (decision.recovered) {
    unset.push('error', 'retrying', 'lastFailure')
  }

  if (!failed && operation.error) {
    unset.push('error')
  }

  return unset
}

async function advanceWrite({ ctx }, operation, decision, event) {
  return writeOperation(ctx, operation, {
    state: decision.state,
    facts: decision.facts,
    set: failureFields(decision.state, event),
    unset: advanceUnset(operation, decision),
    source: event.source,
    eventId: event.eventId,
    eventAt: event.timestamp
  })
}

async function retryApplyAfterFailure(
  { ctx, operations, controls },
  operation
) {
  const { paused } = await controls.get(operation.environment)

  if (paused) {
    // The retry's attempt is counted now and used on resume, so a failure
    // after the pause still leads to the revert; a pause alone counts nothing.
    return writeOperation(ctx, operation, {
      set: {
        deferred: 'retry',
        deferredAttempt: operation.attempt + 1,
        retrying: true
      },
      deadlineAt: heldDeadline(ctx.settings.deadlineHeldMs)
    })
  }

  return operations.publishApply(operation._id, {
    attempt: operation.attempt + 1
  })
}

// What a counted `deploy-failed` leads to (plan 5, "Rules").
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
    return retryApplyAfterFailure(deps, operation)
  }

  if (policy === 'revert') {
    return writeOperation(ctx, operation, {
      set: { deferred: 'revert' },
      deadlineAt: new Date(
        Date.now() + ctx.settings.revertGraceMs
      ).toISOString()
    })
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

async function afterDeployed({ ctx, verifier }, written, decision) {
  if (decision.recovered && written.revertId) {
    ctx.logger?.error(
      { operationId: written._id, alert: true },
      'The apply recovered after its revert was committed; an engineer should check the file'
    )
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

  for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
    const decision = decideEvent(operation, event)

    if (isRepeat(decision)) {
      // A redelivery repairs a projection the first delivery did not finish.
      await projectOperation(db, operation)

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

  return handleOperationEvent(deps, event, operation)
}

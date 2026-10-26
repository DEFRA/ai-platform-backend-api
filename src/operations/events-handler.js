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
export function createEventsHandler({
  ctx,
  operations,
  verifier,
  corroborator,
  controls,
  external
}) {
  const { db, settings, logger } = ctx

  function drop(event, reason) {
    logger?.warn(
      { eventId: event?.eventId, operationId: event?.operationId, reason },
      'An event was dropped'
    )

    return { outcome: 'dropped', reason }
  }

  async function handlePause(event) {
    const result = await controls.apply(event)

    if (result.outcome === 'applied' && event.status === 'resumed') {
      await resumeHeld(event)
    }

    return result
  }

  // On resume, held writes are rebuilt from main and resubmitted, and
  // deferred work is re-armed (plan 5, "Pause").
  async function resumeHeld(event) {
    const held = await db
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

  async function corroborate(event, operation) {
    const verdict = await corroborator.corroborateFailure(event, operation)

    if (verdict.ok) {
      return verdict
    }

    if (verdict.transient) {
      throw new TransientError(`Cannot corroborate yet: ${verdict.reason}`)
    }

    return verdict
  }

  async function holdWrite(operation, decision, event, run) {
    const code = decision.code
    const resubmits = operation.resubmitCount ?? 0
    const paused = code === 'paused'
    const dueAt = paused
      ? heldDeadline(settings.deadlineHeldMs, operation.heldPasses ?? 0)
      : nextResubmitAt(resubmits, settings.resubmitMax)

    if (!paused && !dueAt) {
      return endAsTimedOut(operation, decision, event)
    }

    // A refusal from a run that started before the latest `resumed` is
    // resubmitted at once: the pause it saw has ended.
    const control = await controls.get(operation.environment)
    const startedAt = run?.runStartedAt ?? event.timestamp
    const staleRefusal =
      paused && !control.paused && control.runStartedAt > startedAt

    const written = await writeOperation(ctx, operation, {
      state: QUEUED,
      facts: decision.facts,
      source: event.source,
      eventId: event.eventId,
      eventAt: event.timestamp,
      set: { held: { code, since: new Date().toISOString() } },
      deadlineAt: dueAt
    })

    if (written && staleRefusal) {
      await operations.resubmit(written._id)
    }

    return written
  }

  async function endAsTimedOut(operation, decision, event) {
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
      logger?.error(
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

  async function deferWrite(operation, decision, event) {
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
        settings.deadlineHeldMs,
        operation.heldPasses ?? 0
      )
    })
  }

  async function advanceWrite(operation, decision, event) {
    const failed = [CHECKS_FAILED, DEPLOY_FAILED].includes(decision.state)
    const set = {}

    if (decision.state === CHECKS_FAILED) {
      set.error = {
        code: FAILURE_CODES.CHECKS_FAILED,
        message: event.failureReason.message,
        retryable: false
      }
    }

    if (decision.state === DEPLOY_FAILED) {
      set.error = {
        code: FAILURE_CODES.DEPLOY_FAILED,
        message: event.failureReason.message,
        retryable: false
      }
      set.lastFailure = { runId: event.runId, runAttempt: event.runAttempt }
    }

    return writeOperation(ctx, operation, {
      state: decision.state,
      facts: decision.facts,
      set,
      unset: [
        'held',
        'deferred',
        ...(decision.recovered ? ['error', 'retrying', 'lastFailure'] : []),
        ...(failed ? [] : operation.error ? ['error'] : [])
      ],
      source: event.source,
      eventId: event.eventId,
      eventAt: event.timestamp
    })
  }

  // What a counted `deploy-failed` leads to (plan 5, "Rules").
  async function afterDeployFailed(operation, event) {
    if (operation.type === OPERATION_TYPES.REVERT) {
      logger?.error(
        { operationId: operation._id, alert: true },
        'A revert failed to apply and needs a platform engineer'
      )

      return operations.finish(operation)
    }

    const policy = failurePolicy(operation, event)

    if (policy === 'retry-apply') {
      if (
        await controls.get(operation.environment).then(({ paused }) => paused)
      ) {
        return writeOperation(ctx, operation, {
          set: { deferred: 'retry', retrying: true },
          deadlineAt: heldDeadline(settings.deadlineHeldMs)
        })
      }

      return operations.publishApply(operation._id, {
        attempt: operation.attempt + 1
      })
    }

    if (policy === 'revert') {
      return writeOperation(ctx, operation, {
        set: { deferred: 'revert' },
        deadlineAt: new Date(Date.now() + settings.revertGraceMs).toISOString()
      })
    }

    logger?.error(
      {
        operationId: operation._id,
        environment: operation.environment,
        alert: true
      },
      'Unattributed tenants apply failure needs a platform engineer'
    )

    return operations.finish(operation)
  }

  async function afterWrite(written, decision, event) {
    if (decision.kind !== 'advance') {
      return
    }

    if (decision.state === DEPLOYED) {
      if (decision.recovered && written.revertId) {
        logger?.error(
          { operationId: written._id, alert: true },
          'The apply recovered after its revert was committed; an engineer should check the file'
        )
      }

      await verifier.verify(written._id)
    } else if (decision.state === CHECKS_FAILED) {
      await operations.finish(written)
    } else if (decision.state === DEPLOY_FAILED) {
      await afterDeployFailed(written, event)
    }
  }

  async function applyDecision(operation, decision, event, run) {
    switch (decision.kind) {
      case 'fill':
      case 'replace-run':
        return Object.keys(decision.facts).length === 0
          ? operation
          : writeOperation(ctx, operation, { facts: decision.facts })
      case 'hold':
        return holdWrite(operation, decision, event, run)
      case 'defer':
        return deferWrite(operation, decision, event)
      default:
        return advanceWrite(operation, decision, event)
    }
  }

  async function handleOperationEvent(event, first) {
    let operation = first
    let verdict = null

    for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
      const decision = decideEvent(operation, event)

      if (decision.kind === 'duplicate' || decision.kind === 'ignore') {
        // A redelivery repairs a projection the first delivery did not finish.
        await projectOperation(db, operation)

        return { outcome: decision.kind }
      }

      if (
        !['fill', 'replace-run'].includes(decision.kind) &&
        needsCorroboration(event)
      ) {
        verdict ??= await corroborate(event, operation)

        if (!verdict.ok) {
          return drop(event, verdict.reason)
        }
      }

      const written = await applyDecision(
        operation,
        decision,
        event,
        verdict?.run
      )

      if (written) {
        await afterWrite(written, decision, event)

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

  /**
   * Handles one message from the events queue.
   * @param {unknown} raw - the parsed message body
   * @returns {Promise<{outcome: string, reason?: string, operationId?: string}>}
   */
  async function handle(raw) {
    const { valid, errors } = validateEvent(raw)

    if (!valid) {
      logger?.warn(
        { eventId: raw?.eventId, errors },
        'An invalid event was dropped'
      )

      return { outcome: 'dropped', reason: 'invalid' }
    }

    const event = raw

    if (!settings.environments.includes(event.environment)) {
      return drop(event, 'unknown-environment')
    }

    if (event.action === 'pause') {
      return handlePause(event)
    }

    if (event.action === 'break-glass') {
      return external.recordBreakGlass(event)
    }

    const operation = event.operationId
      ? await findOperation(db, event.operationId)
      : null

    if (!operation) {
      return external.record(event)
    }

    if (operation.externalKey) {
      return external.record(event)
    }

    if (!targetMatches(operation, event)) {
      return drop(event, 'target-differs')
    }

    return handleOperationEvent(event, operation)
  }

  return { handle }
}

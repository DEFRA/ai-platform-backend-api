import { acquireLock } from '#/common/helpers/mongo-lock.js'
import {
  findOverdue,
  findVerificationDue,
  operationsOf
} from '#/operations/operation-repository.js'
import { FAILURE_CODES } from '#/operations/operation-projection.js'
import {
  QUEUED,
  TIMED_OUT,
  VERIFIED,
  overdueAction
} from '#/operations/operation-state-machine.js'
import { writeOperation } from '#/operations/operation-writer.js'

const LOCK_NAME = 'gitops-deadline-sweeper'

/**
 * The deadline sweeper (plan 5, "Deadlines, reconcile and verification"):
 * every `GITOPS_SWEEP_INTERVAL_MS`, under a MongoDB lock so one instance
 * sweeps at a time, reading only its own database. An operation past its
 * deadline is reconciled once (the worker finds what GitHub holds), then, with no
 * progress, `timed-out` (it keeps its file until a later event or a retry).
 * It also retries ARM verification when due, finishes verified operations and
 * ended operations whose follow-up (freeing the file) was left undone,
 * resubmits held writes, runs
 * deferred retries and reverts, and raises an alarm for work held too long.
 * @param {object} deps
 * @param {{db: import('mongodb').Db, settings: object, logger?: import('pino').Logger}} deps.ctx
 * @param {import('mongo-locks').LockManager} deps.locker
 * @param {object} deps.operations - the operations service
 * @param {{verify: (id: string) => Promise<object|null>}} deps.verifier
 */
export function createDeadlineSweeper(deps) {
  return {
    /**
     * One sweep.
     * @returns {Promise<{overdue: number, verified: number, alarms: number}|null>} null when another instance holds the lock.
     */
    sweep: () => sweepOnce(deps)
  }
}

async function timeOut({ ctx }, operation) {
  const written = await writeOperation(ctx, operation, {
    state: TIMED_OUT,
    set: {
      leftState: operation.state,
      error: {
        code: FAILURE_CODES.TIMED_OUT,
        message: 'No progress after a reconcile',
        retryable: false
      }
    },
    deadlineAt: null,
    unset: ['held', 'deferred'],
    source: 'backend'
  })

  if (written) {
    ctx.logger?.error(
      {
        operationId: written._id,
        environment: written.environment,
        leftState: operation.state,
        code: FAILURE_CODES.TIMED_OUT,
        alert: true
      },
      'An operation timed out and needs a platform engineer'
    )
  }

  return written
}

// A held write at its deadline: a refused write is rebuilt and resubmitted
// (counted, up to the bound, then timed out); a paused one is resubmitted
// too, because the workflows' own read of the pause is authoritative and
// the `resumed` event may have been lost (plan 5, "Pause"). The submit
// answers `paused` again if the pause stands, and the hold then doubles.
async function resolveHeld(deps, operation) {
  const { ctx, operations } = deps
  const paused = operation.held.code === 'paused'

  if (!paused && (operation.resubmitCount ?? 0) >= ctx.settings.resubmitMax) {
    return timeOut(deps, { ...operation, state: 'requested' })
  }

  return operations.resubmit(operation._id, {
    counted: !paused,
    passed: paused
  })
}

// Deferred work at its deadline: a revert re-checks itself; a retry is
// published at once, and its own pause check answers if the pause stands.
async function resolveDeferred(deps, operation) {
  const { operations } = deps

  if (operation.deferred === 'revert') {
    return operations.startRevert(operation)
  }

  return operations.publishApply(operation._id, { passed: true })
}

async function sweepOverdue(deps, operation) {
  // A follow-up left undone: the retry of a failed apply, or the freeing of
  // an ended operation's file and the promotion of the waiting request.
  if (operation.followUp) {
    return deps.operations.completeFollowUp(operation)
  }

  // A verified operation is only waiting to be ended: finish it, never
  // reconcile or time it out.
  if (operation.state === VERIFIED) {
    return deps.verifier.verify(operation._id)
  }

  if (operation.state === QUEUED && operation.held) {
    return resolveHeld(deps, operation)
  }

  if (operation.deferred) {
    return resolveDeferred(deps, operation)
  }

  const action = overdueAction(operation)

  if (action === 'reconcile') {
    return deps.operations.reconcile(operation._id, { extendDeadline: true })
  }

  return action === 'time-out' ? timeOut(deps, operation) : null
}

async function alarmOnHeld({ ctx }) {
  const { db, settings, logger } = ctx
  const cutoff = new Date(Date.now() - settings.heldAlarmMs).toISOString()
  const stuck = await operationsOf(db)
    .find({
      slot: { $exists: true },
      $or: [
        { 'held.since': { $lte: cutoff } },
        { deferredSince: { $lte: cutoff } }
      ]
    })
    .toArray()

  for (const operation of stuck) {
    logger?.error(
      {
        operationId: operation._id,
        environment: operation.environment,
        alert: true
      },
      'An operation has been held or deferred longer than the alarm threshold'
    )
  }

  return stuck.length
}

async function sweepLocked(deps) {
  const { db } = deps.ctx
  const totals = { overdue: 0, verified: 0, alarms: 0 }

  for (const operation of await findOverdue(db)) {
    await sweepOverdue(deps, operation)
    totals.overdue += 1
  }

  for (const { _id } of await findVerificationDue(db)) {
    await deps.verifier.verify(_id)
    totals.verified += 1
  }

  totals.alarms = await alarmOnHeld(deps)

  return totals
}

async function sweepOnce(deps) {
  const lock = await acquireLock(deps.locker, LOCK_NAME)

  if (!lock) {
    return null
  }

  try {
    return await sweepLocked(deps)
  } finally {
    await lock.free()
  }
}

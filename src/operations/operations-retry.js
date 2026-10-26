import { Boom, boomWithCode } from '#/common/helpers/boom-with-code.js'
import { newOutboxEntry } from '#/operations/operation-factory.js'
import {
  findOperation,
  isDuplicateKey
} from '#/operations/operation-repository.js'
import {
  DEPLOYING,
  DEPLOY_FAILED,
  OPERATION_TYPES,
  RANK,
  RETRY_APPLY,
  TIMED_OUT,
  heldDeadline
} from '#/operations/operation-state-machine.js'
import {
  writeOperation,
  writeWithRetry
} from '#/operations/operation-writer.js'
import { endRefused, finish } from '#/operations/operations-slots.js'
import { cancelStaleRevert } from '#/operations/operations-revert.js'
import {
  MAX_TRIES,
  busyConflict,
  isPolicyRefusal,
  publish,
  withHeldSubmit,
  withSubmit
} from '#/operations/operations-support.js'

// Resubmitting a held write, publishing a fresh apply, reconciling and the
// admin retry. Each function takes the service's context
// ({db, settings, logger, relay, buildDocument, reader, controls}).

// What a resubmission records besides the new submit. At a held deadline
// (`passed`) it counts the pass, so the next hold doubles, and keeps the
// first hold time for the alarm; any other resubmission starts afresh.
function resubmitRecord(operation, { counted, passed }) {
  const set = {
    resubmitCount: (operation.resubmitCount ?? 0) + (counted ? 1 : 0)
  }

  if (!passed) {
    return { set, unset: ['held', 'deferred', 'followUp', 'heldSince'] }
  }

  return {
    set: {
      ...set,
      heldPasses: (operation.heldPasses ?? 0) + 1,
      heldSince:
        operation.heldSince ?? operation.held?.since ?? new Date().toISOString()
    },
    unset: ['held', 'deferred', 'followUp']
  }
}

// What a resubmission submits: a revert its own rollback, built once when it
// was created, so a refusal never swaps it for the file as it is now, and
// only while its parent still holds the failure (else it is `ended`,
// cancelled); any other write is rebuilt from main. A request that can no
// longer be built comes back as the refusal that ends it.
async function resubmission(ctx, operation) {
  if (operation.type === OPERATION_TYPES.REVERT) {
    const ended = await cancelStaleRevert(ctx, operation)

    return ended ? { ended } : { submit: withHeldSubmit(operation) }
  }

  try {
    return { submit: withSubmit(operation, await ctx.buildDocument(operation)) }
  } catch (error) {
    if (!isPolicyRefusal(error)) {
      throw error
    }

    return { refusal: error }
  }
}

/**
 * Rebuilds a held write from main and publishes it again: after a
 * `stale-revision` or `commit-conflict` (counted, at most
 * `GITOPS_RESUBMIT_MAX`), a resume, or the held deadline (`passed`: the
 * submit reads the pause itself and, if it stands, the hold doubles).
 * @param {object} ctx
 * @param {string} operationId
 * @param {{counted?: boolean, passed?: boolean}} [options]
 * @returns {Promise<object|null>}
 */
export async function resubmit(
  ctx,
  operationId,
  { counted = false, passed = false } = {}
) {
  for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
    const operation = await findOperation(ctx.db, operationId)

    if (!operation?.slot) {
      return null
    }

    const { submit, refusal, ended } = await resubmission(ctx, operation)

    if (ended) {
      return ended
    }

    if (refusal) {
      return endRefused(ctx, operation, refusal)
    }

    const record = resubmitRecord(operation, { counted, passed })
    const written = await writeOperation(ctx, operation, {
      state: 'requested',
      source: 'backend',
      ...submit,
      set: { ...submit.set, ...record.set },
      unset: record.unset
    })

    if (written) {
      await publish(ctx, operationId)

      return written
    }
  }

  throw new Error(`Operation ${operationId} kept moving; try again`)
}

// The change that publishes a fresh apply. At a deferred deadline (`passed`)
// it counts the pass, so a paused apply's next deferral doubles. Completing
// a persisted retry (`pending`) also ends the deadline that fell due for it.
function applyChange(operation, { attempt, state, reset, passed, pending }) {
  const next = attempt ?? operation.deferredAttempt ?? operation.attempt

  return {
    ...(state ? { state, source: 'backend' } : {}),
    ...(pending ? { deadlineAt: null } : {}),
    set: {
      attempt: next,
      retrying: true,
      outboxPending: true,
      ...(passed ? { heldPasses: (operation.heldPasses ?? 0) + 1 } : {}),
      ...(reset ? { verify: { attempts: 0, nextAt: null } } : {})
    },
    unset: [
      'deferred',
      'deferredAttempt',
      'followUp',
      'held',
      ...(reset ? ['error'] : [])
    ],
    push: { outbox: newOutboxEntry('apply', { attempt: next }) }
  }
}

/**
 * Publishes a fresh apply for an operation, at `attempt`: the one D14 retry,
 * an admin's retry, or a deferred retry re-armed. With `pending` it does so
 * only while that follow-up is still persisted, so a redelivery and the
 * sweep together publish the apply once.
 * @param {object} ctx
 * @param {string} operationId
 * @param {{attempt?: number, state?: string, reset?: boolean, passed?: boolean, pending?: boolean}} [options]
 * @returns {Promise<object|null>}
 */
export async function publishApply(ctx, operationId, options = {}) {
  const written = await writeWithRetry(ctx, operationId, (operation) =>
    options.pending && !isRetryPending(operation)
      ? null
      : applyChange(operation, options)
  )

  if (written) {
    await publish(ctx, operationId)
  }

  return written
}

function isRetryPending(operation) {
  return operation.followUp === RETRY_APPLY && operation.state === DEPLOY_FAILED
}

// The retry persisted with a counted failure, done: paused, it is deferred
// to the held deadline (its attempt already counted, so a failure after the
// pause still leads to the revert); otherwise its apply is published.
async function completeRetry(ctx, operation) {
  if (await ctx.controls.isPaused(operation.environment)) {
    return writeWithRetry(ctx, operation._id, (current) =>
      isRetryPending(current)
        ? {
            set: { deferred: 'retry', retrying: true },
            unset: ['followUp'],
            deadlineAt: heldDeadline(ctx.settings.deadlineHeldMs)
          }
        : null
    )
  }

  return publishApply(ctx, operation._id, { pending: true })
}

/**
 * Completes the follow-up persisted with a transition: the retry of a failed
 * apply, or the freeing of an ended operation's file. Safe to run again.
 * @param {object} ctx
 * @param {object} operation
 * @returns {Promise<unknown>}
 */
export function completeFollowUp(ctx, operation) {
  return operation.followUp === RETRY_APPLY
    ? completeRetry(ctx, operation)
    : finish(ctx, operation)
}

/**
 * Publishes a `reconcile` for an operation: the worker looks for what
 * GitHub holds for it and reports the true state (plan 5).
 * @param {object} ctx
 * @param {string} operationId
 * @param {{extendDeadline?: boolean}} [options]
 * @returns {Promise<object|null>}
 */
export async function reconcile(
  ctx,
  operationId,
  { extendDeadline = false } = {}
) {
  const written = await writeWithRetry(ctx, operationId, (operation) => ({
    set: {
      outboxPending: true,
      ...(extendDeadline
        ? {
            reconcileCount: (operation.reconcileCount ?? 0) + 1,
            deadlineAt: new Date(
              Date.now() + ctx.settings.reconcileGraceMs
            ).toISOString()
          }
        : {})
    },
    push: {
      outbox: newOutboxEntry('reconcile', operation, {
        state: operation.state
      })
    }
  }))

  await publish(ctx, operationId)

  return written
}

/**
 * Re-takes the slot of an operation that ended, for a retry by an admin;
 * refused while another operation holds the file.
 * @param {object} ctx
 * @param {object} operation
 */
async function reacquireSlot(ctx, operation) {
  if (operation.slot) {
    return operation
  }

  try {
    const written = await writeWithRetry(ctx, operation._id, (current) =>
      current.slot ? null : { set: { slot: 'active' } }
    )

    return written ?? (await findOperation(ctx.db, operation._id))
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw busyConflict()
    }

    throw error
  }
}

function assertRetryable(operation) {
  if (
    operation.state !== TIMED_OUT &&
    operation.state !== DEPLOY_FAILED &&
    !operation.held
  ) {
    throw boomWithCode(
      Boom.conflict,
      'Only a failed deployment can be retried',
      'deployment-not-retryable'
    )
  }
}

/**
 * A Platform Admin retry, by state (plan 5): a failed apply gets a fresh
 * apply (attempt + 1, the verification count starting again); a
 * `timed-out` operation resumes from the state it left (a submit before
 * `committed`, an apply after); a held write is rebuilt and resubmitted.
 * @param {object} ctx
 * @param {object} operation
 * @returns {Promise<object>}
 */
export async function retry(ctx, operation) {
  const leftOf =
    operation.state === TIMED_OUT ? operation.leftState : operation.state

  assertRetryable(operation)

  const held = await reacquireSlot(ctx, operation)

  if (RANK[leftOf] < RANK.committed) {
    return resubmit(ctx, held._id)
  }

  const failed = operation.state === DEPLOY_FAILED

  return publishApply(ctx, held._id, {
    attempt: failed ? operation.attempt + 1 : operation.attempt,
    state: failed ? DEPLOYING : leftOf,
    reset: true
  })
}

import { Boom, boomWithCode } from '#/common/helpers/boom-with-code.js'
import { uuidv7 } from '#/common/helpers/uuid-v7.js'
import {
  buildOperation,
  canonicalDocument,
  newOutboxEntry,
  submissionFields
} from '#/operations/operation-factory.js'
import { FAILURE_CODES } from '#/operations/operation-projection.js'
import {
  findByIdempotencyKey,
  findOperation,
  findSlotHolder,
  insertOperation,
  isDuplicateKey
} from '#/operations/operation-repository.js'
import {
  DEPLOYING,
  DEPLOY_FAILED,
  OPERATION_TYPES,
  QUEUED,
  RANK,
  TIMED_OUT,
  heldDeadline
} from '#/operations/operation-state-machine.js'
import {
  writeOperation,
  writeWithRetry
} from '#/operations/operation-writer.js'
import { SYSTEM_ACTOR } from '#/services/team-deployment-entries.js'

/**
 * The principal the backend's own operations (a revert) are attributed to.
 */
export const SYSTEM_PRINCIPAL = SYSTEM_ACTOR

const MAX_TRIES = 3

// Requests that can never be submitted as they stand: their document cannot
// be built (no builder, no team SKU for the model, no service code) or is too
// large. They end refused so the file moves on; any other failure is retried.
const UNSUBMITTABLE = new Set([
  'desired-state-unavailable',
  'desired-state-too-large',
  'invalid-path',
  'model-not-eligible',
  'service-code-required'
])

function isPolicyRefusal(error) {
  return UNSUBMITTABLE.has(error?.data?.code ?? error?.code)
}

/**
 * The application core of the operations (plan 5, 6.1): the file's slots,
 * merging, promotion, resubmission, the apply retry and the revert. It
 * decides nothing about events (the state machine and the handler do);
 * it creates and moves operations and writes their commands to the outbox,
 * which the relay publishes.
 * @param {object} deps
 * @param {import('mongodb').Db} deps.db
 * @param {object} deps.settings
 * @param {{publishOperation: (id: string) => Promise<number>}} deps.relay
 * @param {(operation: object) => Promise<{document: object, expectedRevision?: number, expectedBase?: string|null}>} deps.buildDocument - the whole document for an operation's items, from main now; throws a coded error for a request that cannot be built
 * @param {import('#/adapters/team-file-reader.js').TeamFileReader} deps.reader
 * @param {{isPaused: (environment: string) => Promise<boolean>}} deps.controls
 * @param {import('pino').Logger} [deps.logger]
 */
export function createOperationsService({
  db,
  settings,
  relay,
  buildDocument,
  reader,
  controls,
  logger
}) {
  const ctx = { db, settings, logger }

  // Best effort straight after a write: the sweep publishes what this does
  // not, so an SQS outage never fails or loses a request.
  async function publish(operationId) {
    try {
      await relay.publishOperation(operationId)
    } catch (error) {
      logger?.warn(
        { operationId, message: error.message },
        'Publishing after the write failed, the sweep will retry'
      )
    }
  }

  function withSubmit(operation, submission, attempt = operation.attempt) {
    return {
      set: {
        ...submissionFields(submission),
        revision: submission.document.revision ?? null,
        outboxPending: true
      },
      push: { outbox: newOutboxEntry('submit', { attempt }) }
    }
  }

  // The operation is ended as refused when its document cannot be built: the
  // request was fine when accepted but is no longer eligible, so waiting on
  // it would block the file.
  async function endRefused(operation, error) {
    const written = await writeWithRetry(ctx, operation._id, (current) => ({
      state: 'checks-failed',
      set: {
        error: {
          code: FAILURE_CODES.CHECKS_FAILED,
          message: error.message,
          retryable: false
        }
      },
      unset: ['held', 'deferred'],
      source: 'backend'
    }))

    await finish(written)

    return written
  }

  async function insertActive(base, held) {
    const operation = buildOperation({
      ...base,
      state: held ? QUEUED : 'requested',
      slot: 'active',
      held
    })

    if (held) {
      operation.deadlineAt = heldDeadline(settings.deadlineHeldMs)
    } else {
      const submission = await buildDocument(operation)
      const { set, push } = withSubmit(operation, submission)

      Object.assign(operation, set)
      operation.outbox = [push.outbox]
      operation.deadlineAt = new Date(
        Date.now() + settings.deadlines.requested
      ).toISOString()
    }

    return insertOperation(db, operation)
  }

  /**
   * Accepts a request for a team file (plan 5, DD5): one operation per
   * request per file. A free file gets an active operation with its document
   * built now and its command in the outbox (or held, when the environment is
   * paused); a busy file gets a waiting operation, and requests arriving
   * meanwhile merge into it. A replayed idempotency key (a merged
   * request's too) finds its operation. Nothing is written when the document
   * cannot be built.
   * @param {{teamId: string, environment: string, target: object, items: Array<{entryId: string, modelSlug: string, change: 'add'|'remove'}>, requestedBy: string, requestedByUserId: string, idempotencyKey: string, traceparent?: string|null, cdpRequestId?: string|null}} params
   * @returns {Promise<{operation: object, replay: boolean, waiting: boolean}>}
   */
  async function request(params) {
    const { teamId, environment, idempotencyKey } = params
    const base = {
      ...params,
      type: OPERATION_TYPES.WRITE,
      idempotencyKeys: [idempotencyKey]
    }
    const paused = await controls.isPaused(environment)

    for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
      const replay = await findByIdempotencyKey(db, {
        teamId,
        key: idempotencyKey
      })

      if (replay) {
        return {
          operation: replay,
          replay: true,
          waiting: replay.slot === 'waiting'
        }
      }

      const result = await tryRequest(base, paused)

      if (result) {
        return result
      }
    }

    throw boomWithCode(
      Boom.conflict,
      'Another change to this team is in progress; try again shortly',
      'team-file-busy'
    )
  }

  async function tryRequest(base, paused) {
    const { teamId, environment } = base
    const active = await findSlotHolder(db, {
      environment,
      teamId,
      slot: 'active'
    })

    try {
      if (!active) {
        const operation = await insertActive(
          base,
          paused
            ? { code: 'paused', since: new Date().toISOString() }
            : undefined
        )

        await publish(operation._id)

        return { operation, replay: false, waiting: false }
      }

      return await queueBehind(base)
    } catch (error) {
      // A concurrent request took the slot or the key: look again.
      if (isDuplicateKey(error)) {
        return null
      }

      throw error
    }
  }

  async function queueBehind(base) {
    const { teamId, environment, items, idempotencyKeys } = base
    const waiting = await findSlotHolder(db, {
      environment,
      teamId,
      slot: 'waiting'
    })

    if (!waiting) {
      const operation = await insertOperation(
        db,
        buildOperation({ ...base, state: QUEUED, slot: 'waiting' })
      )

      return { operation, replay: false, waiting: true }
    }

    const merged = await writeOperation(ctx, waiting, {
      push: { items: { $each: items } },
      addToSet: { idempotencyKeys: { $each: idempotencyKeys } }
    })

    return merged ? { operation: merged, replay: false, waiting: true } : null
  }

  /**
   * Gives the file to the waiting operation once nothing holds it (plan 5):
   * its document is built now, from main, and its command goes to the outbox;
   * paused, it holds. A document that can no longer be built ends it refused.
   * @param {{environment: string, teamId: string}} file
   * @returns {Promise<object|null>} The promoted operation, or null.
   */
  async function promoteWaiting({ environment, teamId }) {
    const waiting = await findSlotHolder(db, {
      environment,
      teamId,
      slot: 'waiting'
    })

    if (!waiting) {
      return null
    }

    try {
      const paused = await controls.isPaused(environment)
      const change = paused
        ? {
            set: {
              slot: 'active',
              held: { code: 'paused', since: new Date().toISOString() }
            },
            deadlineAt: heldDeadline(settings.deadlineHeldMs)
          }
        : await promotionOf(waiting)
      const promoted = await writeOperation(ctx, waiting, change)

      if (promoted && !paused) {
        await publish(promoted._id)
      }

      return promoted
    } catch (error) {
      if (isDuplicateKey(error)) {
        return null
      }

      if (isPolicyRefusal(error)) {
        return endRefused(await findOperation(db, waiting._id), error)
      }

      throw error
    }
  }

  async function promotionOf(waiting) {
    const submission = await buildDocument(waiting)
    const { set, push } = withSubmit(waiting, submission)

    return {
      state: 'requested',
      source: 'backend',
      set: { ...set, slot: 'active' },
      push
    }
  }

  /**
   * Frees an ended operation's file and promotes the waiting one; a revert's
   * end settles the operation it reverts.
   * @param {object} operation - as written, in an ending state
   * @returns {Promise<void>}
   */
  async function finish(operation) {
    if (operation.slot) {
      await writeWithRetry(ctx, operation._id, (current) =>
        current.slot ? { unset: ['slot'], deadlineAt: null } : null
      )

      if (operation.type !== OPERATION_TYPES.REVERT) {
        await promoteWaiting({
          environment: operation.environment,
          teamId: operation.teamId
        })
      }
    }

    if (operation.parentId) {
      await settleParent(operation)
    }
  }

  /**
   * Rebuilds a held write from main and publishes it again: after a
   * `stale-revision` or `commit-conflict` (counted, at most
   * `GITOPS_RESUBMIT_MAX`), a resume, or the held deadline.
   * @param {string} operationId
   * @param {{counted?: boolean}} [options]
   * @returns {Promise<object|null>}
   */
  async function resubmit(operationId, { counted = false } = {}) {
    for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
      const operation = await findOperation(db, operationId)

      if (!operation?.slot) {
        return null
      }

      let submission

      try {
        submission = await buildDocument(operation)
      } catch (error) {
        if (!isPolicyRefusal(error)) {
          throw error
        }

        return endRefused(operation, error)
      }

      const written = await writeOperation(ctx, operation, {
        state: 'requested',
        source: 'backend',
        ...withSubmit(operation, submission),
        set: {
          ...withSubmit(operation, submission).set,
          resubmitCount: (operation.resubmitCount ?? 0) + (counted ? 1 : 0)
        },
        unset: ['held', 'deferred']
      })

      if (written) {
        await publish(operationId)

        return written
      }
    }

    throw new Error(`Operation ${operationId} kept moving; try again`)
  }

  /**
   * Publishes a fresh apply for an operation, at `attempt`: the one D14 retry,
   * an admin's retry, or a deferred retry re-armed.
   * @param {string} operationId
   * @param {{attempt?: number, state?: string, reset?: boolean}} [options]
   * @returns {Promise<object|null>}
   */
  async function publishApply(operationId, { attempt, state, reset } = {}) {
    const written = await writeWithRetry(ctx, operationId, (operation) => {
      const next = attempt ?? operation.attempt

      return {
        ...(state ? { state, source: 'backend' } : {}),
        set: {
          attempt: next,
          retrying: true,
          outboxPending: true,
          ...(reset ? { verify: { attempts: 0, nextAt: null } } : {})
        },
        unset: ['deferred', 'held', ...(reset ? ['error'] : [])],
        push: { outbox: newOutboxEntry('apply', { attempt: next }) }
      }
    })

    if (written) {
      await publish(operationId)
    }

    return written
  }

  /**
   * Publishes a `reconcile` for an operation: the worker looks for what
   * GitHub holds for it and reports the true state (plan 5).
   * @param {string} operationId
   * @param {{extendDeadline?: boolean}} [options]
   * @returns {Promise<object|null>}
   */
  async function reconcile(operationId, { extendDeadline = false } = {}) {
    const written = await writeWithRetry(ctx, operationId, (operation) => ({
      set: {
        outboxPending: true,
        ...(extendDeadline
          ? {
              reconcileCount: (operation.reconcileCount ?? 0) + 1,
              deadlineAt: new Date(
                Date.now() + settings.reconcileGraceMs
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

    await publish(operationId)

    return written
  }

  // The revert's document: the file before the operation's commit, as the
  // next revision (plan 5, "Revert"); none when the file is new, so the
  // revert removes it.
  async function revertOf(parent, id) {
    const { document: previous } = await reader.getPreviousDocument({
      path: parent.target.path,
      commitSha: parent.gitops.commitSha
    })
    const revision = parent.revision ?? 0
    const now = new Date().toISOString()

    return previous
      ? {
          action: 'revert',
          document: {
            ...previous,
            revision: revision + 1,
            operationId: id,
            updatedAt: now,
            updatedBy: SYSTEM_PRINCIPAL
          }
        }
      : { action: 'remove', document: null }
  }

  /**
   * Starts the revert of a `deploy-failed` operation once its grace has
   * passed (plan 5): a child `team-file.revert`, built now, published only
   * if the parent is still `deploy-failed`, the environment is not paused and
   * no newer apply attempt is running; otherwise it is cancelled or, paused,
   * re-armed. The child takes no slot of the file; the parent keeps its.
   * @param {object} parent
   * @returns {Promise<'started'|'cancelled'|'re-armed'>}
   */
  async function startRevert(parent) {
    const newerAttempt =
      parent.lastFailure?.runId != null &&
      parent.gitops.applyRunId !== parent.lastFailure.runId

    if (parent.state !== DEPLOY_FAILED || newerAttempt) {
      await writeOperation(ctx, parent, { unset: ['deferred'] })
      logger?.warn(
        { operationId: parent._id, code: FAILURE_CODES.REVERT_CANCELLED },
        'The revert was cancelled: the failed apply moved on'
      )

      return 'cancelled'
    }

    if (await controls.isPaused(parent.environment)) {
      await writeOperation(ctx, parent, {
        deadlineAt: heldDeadline(
          settings.deadlineHeldMs,
          (parent.heldPasses ?? 0) + 1
        ),
        set: { heldPasses: (parent.heldPasses ?? 0) + 1 }
      })

      return 're-armed'
    }

    const id = uuidv7()
    const { action, document } = await revertOf(parent, id)
    const child = buildOperation({
      type: OPERATION_TYPES.REVERT,
      state: 'requested',
      teamId: parent.teamId,
      environment: parent.environment,
      target: parent.target,
      items: [],
      parentId: parent._id,
      slot: 'revert',
      action,
      requestedBy: SYSTEM_PRINCIPAL,
      requestedByUserId: SYSTEM_PRINCIPAL,
      traceparent: parent.traceparent,
      cdpRequestId: parent.cdpRequestId
    })

    child._id = id
    Object.assign(child, {
      ...(document ? { document: canonicalDocument(document) } : {}),
      expectedRevision: parent.revision ?? 0,
      outbox: [newOutboxEntry('submit', { attempt: 1 })],
      outboxPending: true,
      deadlineAt: new Date(
        Date.now() + settings.deadlines.requested
      ).toISOString()
    })
    await insertOperation(db, child)
    await writeOperation(ctx, parent, {
      unset: ['deferred'],
      set: { revertId: id },
      deadlineAt: null
    })
    await publish(id)

    return 'started'
  }

  // What follows a revert's end for the operation it reverts (plan 5): a
  // revert that landed ends the parent as reverted; one that failed leaves the
  // file with the parent until an engineer acts, as a failed revert does today.
  async function settleParent(child) {
    const succeeded = child.state === 'active'

    await writeWithRetry(ctx, child.parentId, (parent) =>
      succeeded
        ? {
            set: {
              error: {
                code: FAILURE_CODES.REVERTED,
                message: 'The failed change was reverted',
                retryable: false
              }
            },
            unset: ['revertId', 'retrying']
          }
        : { set: { revertFailed: true }, unset: ['revertId'] }
    )

    if (succeeded) {
      const parent = await findOperation(db, child.parentId)

      await finish(parent)
    } else {
      logger?.error(
        { operationId: child.parentId, revertOperationId: child._id },
        'The revert did not complete: the file stays with the failed operation and needs a platform engineer'
      )
    }
  }

  /**
   * Re-takes the slot of an operation that ended, for a retry by an admin;
   * refused while another operation holds the file.
   * @param {object} operation
   */
  async function reacquireSlot(operation) {
    if (operation.slot) {
      return operation
    }

    try {
      const written = await writeWithRetry(ctx, operation._id, (current) =>
        current.slot ? null : { set: { slot: 'active' } }
      )

      return written ?? (await findOperation(db, operation._id))
    } catch (error) {
      if (isDuplicateKey(error)) {
        throw boomWithCode(
          Boom.conflict,
          'Another change to this team is in progress; try again shortly',
          'team-file-busy'
        )
      }

      throw error
    }
  }

  /**
   * A Platform Admin retry, by state (plan 5): a failed apply gets a fresh
   * apply (attempt + 1, the verification count starting again); a
   * `timed-out` operation resumes from the state it left (a submit before
   * `committed`, an apply after); a held write is rebuilt and resubmitted.
   * @param {object} operation
   * @returns {Promise<object>}
   */
  async function retry(operation) {
    const leftOf =
      operation.state === TIMED_OUT ? operation.leftState : operation.state

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

    const held = await reacquireSlot(operation)

    if (RANK[leftOf] < RANK.committed) {
      return resubmit(held._id)
    }

    return publishApply(held._id, {
      attempt:
        operation.state === DEPLOY_FAILED
          ? operation.attempt + 1
          : operation.attempt,
      state: operation.state === DEPLOY_FAILED ? DEPLOYING : leftOf,
      reset: true
    })
  }

  return {
    request,
    promoteWaiting,
    finish,
    resubmit,
    publishApply,
    reconcile,
    startRevert,
    retry,
    endRefused
  }
}

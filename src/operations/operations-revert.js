import { uuidv7 } from '#/common/helpers/uuid-v7.js'
import {
  buildOperation,
  canonicalDocument,
  newOutboxEntry
} from '#/operations/operation-factory.js'
import { FAILURE_CODES } from '#/operations/operation-projection.js'
import { insertOperation } from '#/operations/operation-repository.js'
import {
  DEPLOY_FAILED,
  OPERATION_TYPES,
  heldDeadline
} from '#/operations/operation-state-machine.js'
import { writeOperation } from '#/operations/operation-writer.js'
import { publish } from '#/operations/operations-support.js'
import { SYSTEM_ACTOR } from '#/services/team-deployment-entries.js'

// The revert of a failed write (plan 5). Each function takes the service's
// context ({db, settings, logger, relay, buildDocument, reader, controls}).

// The revert's document: the file before the operation's commit, as the
// next revision (plan 5, "Revert"); none when the file is new, so the
// revert removes it.
async function revertOf(reader, parent, id) {
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
          updatedBy: SYSTEM_ACTOR
        }
      }
    : { action: 'remove', document: null }
}

function revertChildOf(parent, id, { action, document }, settings) {
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
    requestedBy: SYSTEM_ACTOR,
    requestedByUserId: SYSTEM_ACTOR,
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

  return child
}

async function cancelRevert(ctx, parent) {
  await writeOperation(ctx, parent, { unset: ['deferred'] })
  ctx.logger?.warn(
    { operationId: parent._id, code: FAILURE_CODES.REVERT_CANCELLED },
    'The revert was cancelled: the failed apply moved on'
  )
}

async function rearmRevert(ctx, parent) {
  const passes = (parent.heldPasses ?? 0) + 1

  await writeOperation(ctx, parent, {
    deadlineAt: heldDeadline(ctx.settings.deadlineHeldMs, passes),
    set: { heldPasses: passes }
  })
}

/**
 * Starts the revert of a `deploy-failed` operation once its grace has
 * passed (plan 5): a child `team-file.revert`, built now, published only
 * if the parent is still `deploy-failed`, the environment is not paused and
 * no newer apply attempt is running; otherwise it is cancelled or, paused,
 * re-armed. The child takes no slot of the file; the parent keeps its.
 * @param {object} ctx
 * @param {object} parent
 * @returns {Promise<'started'|'cancelled'|'re-armed'>}
 */
export async function startRevert(ctx, parent) {
  const newerAttempt =
    parent.lastFailure?.runId != null &&
    parent.gitops.applyRunId !== parent.lastFailure.runId

  if (parent.state !== DEPLOY_FAILED || newerAttempt) {
    await cancelRevert(ctx, parent)

    return 'cancelled'
  }

  if (await ctx.controls.isPaused(parent.environment)) {
    await rearmRevert(ctx, parent)

    return 're-armed'
  }

  const id = uuidv7()
  const revert = await revertOf(ctx.reader, parent, id)

  await insertOperation(ctx.db, revertChildOf(parent, id, revert, ctx.settings))
  await writeOperation(ctx, parent, {
    unset: ['deferred'],
    set: { revertId: id },
    deadlineAt: null
  })
  await publish(ctx, id)

  return 'started'
}

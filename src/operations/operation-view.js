import { supportReferenceOf } from '#/operations/support-reference.js'
import {
  ITEM_KINDS,
  isModelItem,
  itemKindOf
} from '#/operations/operation-items.js'
import {
  FAILURE_CODES,
  entryFailureReasonOf,
  runUrlOf
} from '#/operations/operation-projection.js'
import {
  CHECKS_FAILED,
  DEPLOY_FAILED,
  OPERATION_TYPES,
  QUEUED,
  RANK,
  TIMED_OUT,
  rankOf
} from '#/operations/operation-state-machine.js'

// What a team's members are shown of an operation: its kind and changes, the
// five steps with the time each was reached (from the operation's history),
// who asked, and what failed with the run to follow and the reference to
// quote. The state table is the one source of the ranks the steps follow, so
// a step is read from a state's rank, never from a restated list of states.
// Nothing here carries the document, the outbox, the trace identifiers or
// the requester's principal.

const STEPS = Object.freeze([
  { key: 'received', label: 'Request received' },
  { key: 'checks', label: 'Checks passed' },
  { key: 'deploying', label: 'Deploying' },
  { key: 'deployed', label: 'Deployed' },
  { key: 'ready', label: 'Ready to use' }
])

/**
 * The keys of the steps, in order.
 */
export const STEP_KEYS = STEPS.map(({ key }) => key)

const LAST_STEP = STEPS.length - 1
const STEP_AFTER_DEPLOYING_FAILS = 2
const STEP_AFTER_VERIFY_FAILS = 3
const STEP_CHECKS = 1

const KIND_MIXED = 'mixed'
const KIND_REVERT = 'revert'

// The step a state belongs to: the state's rank, one down, so `requested` is
// the first step and `active` (and `removed`) is past the last, with every
// step done. A waiting operation is at the first. A state with no rank (a
// timed-out operation's own) belongs to none.
function stepIndexOf(state) {
  if (state === QUEUED) {
    return 0
  }

  return RANK[state] === undefined ? -1 : RANK[state] - 1
}

// The step a failed operation stopped at, or null when it has not failed. A
// refused change failed its checks; a failed apply failed deploying, unless
// it was the ARM check that failed, which is the step after; a timed-out
// operation was waiting for the step after the state it left.
function failedStepOf(operation) {
  switch (operation.state) {
    case CHECKS_FAILED:
      return STEP_CHECKS
    case DEPLOY_FAILED:
      return operation.error?.code === FAILURE_CODES.VERIFY_FAILED
        ? STEP_AFTER_VERIFY_FAILS
        : STEP_AFTER_DEPLOYING_FAILS
    case TIMED_OUT:
      return Math.min(rankOf(operation) ?? STEP_CHECKS, LAST_STEP)
    default:
      return null
  }
}

function statusOf(index, current, failed) {
  const stopped = failed ?? current

  if (index < stopped) {
    return 'done'
  }

  if (index > stopped) {
    return 'todo'
  }

  return failed === null ? 'current' : 'failed'
}

// When the operation reached the step: the first event of that step or a
// later one (a step it went past without an event reads as reached with the
// next), and for the step it failed at, the failure.
function timeOf(history, index, status) {
  if (status === 'todo') {
    return null
  }

  if (status === 'failed') {
    return history.at(-1)?.at ?? null
  }

  return history.find(({ state }) => stepIndexOf(state) >= index)?.at ?? null
}

function stepsOf(operation) {
  const history = operation.history ?? [
    { state: operation.state, at: operation.createdAt }
  ]
  const failed = failedStepOf(operation)
  const current = stepIndexOf(operation.state)

  return STEPS.map(({ key, label }, index) => {
    const status = statusOf(index, current, failed)

    return { key, label, status, at: timeOf(history, index, status) }
  })
}

function changeOf(item) {
  const kind = itemKindOf(item)

  if (kind === ITEM_KINDS.MODEL) {
    return { kind, change: item.change, modelSlug: item.modelSlug }
  }

  if (kind === ITEM_KINDS.LIMITS) {
    return { kind, change: item.change, limits: item.limits }
  }

  return { kind, change: item.change }
}

function kindOf(operation) {
  if (operation.type === OPERATION_TYPES.REVERT) {
    return KIND_REVERT
  }

  const kinds = new Set((operation.items ?? []).map(itemKindOf))

  if (kinds.size > 1) {
    return KIND_MIXED
  }

  return kinds.values().next().value ?? ITEM_KINDS.MODEL
}

// The failure text of the model change that led the operation (a removal has
// its own), or of the operation when it holds no model change.
function failureTextOf(operation) {
  const item = (operation.items ?? []).find(isModelItem) ?? { change: 'set' }

  return entryFailureReasonOf(operation, item)
}

/**
 * An operation as a team's members see it.
 * @param {object} operation - the operation as stored
 * @param {{requesterName?: string|null}} [options] - the requester's display name, from their record
 * @returns {{id: string, environment: string, kind: string, changes: object[], state: string, open: boolean, steps: Array<{key: string, label: string, status: 'done'|'current'|'failed'|'todo', at: string|null}>, requestedBy: {name: string}|null, createdAt: string, updatedAt: string, failureReason: string|null, runUrl: string|null, supportReference: string|null}}
 */
export function toOperationView(operation, { requesterName = null } = {}) {
  return {
    id: operation._id,
    environment: operation.environment,
    kind: kindOf(operation),
    changes: (operation.items ?? []).map(changeOf),
    state: operation.state,
    // An open operation holds its team file, so it has a slot.
    open: Boolean(operation.slot),
    steps: stepsOf(operation),
    requestedBy: requesterName ? { name: requesterName } : null,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    failureReason: failureTextOf(operation),
    runUrl: runUrlOf(operation),
    supportReference: supportReferenceOf(operation._id)
  }
}

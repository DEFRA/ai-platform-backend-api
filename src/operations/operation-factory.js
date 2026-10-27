import { canonicalJson } from '#/common/helpers/canonical-json.js'
import { uuidv7 } from '#/common/helpers/uuid-v7.js'
import { REQUESTED } from '#/operations/operation-state-machine.js'

// What a document may weigh: a dispatch input holds at most 65,535
// characters, so the contract keeps every machine-written file under 60 KB.
const MAX_DOCUMENT_BYTES = 60 * 1024

/**
 * An outbox entry: a command to publish, with its own ID, which is also its
 * FIFO deduplication ID and is kept when the entry is republished (plan 5).
 * @param {'submit'|'apply'|'reconcile'} type
 * @param {{attempt: number}} operation
 * @param {{state?: string, now?: string}} [options] - `state` is the operation's state, for a reconcile
 */
export function newOutboxEntry(
  type,
  { attempt },
  { state, now = new Date().toISOString() } = {}
) {
  return {
    commandId: uuidv7(),
    type,
    attempt,
    ...(state ? { state } : {}),
    createdAt: now,
    claimedUntil: null,
    publishedAt: null
  }
}

/**
 * The document as the canonical JSON the command carries, or a coded error
 * when it is too large to dispatch.
 * @param {object} document
 * @returns {string}
 */
export function canonicalDocument(document) {
  const text = canonicalJson(document)

  if (Buffer.byteLength(text) > MAX_DOCUMENT_BYTES) {
    const error = new Error('The desired-state document is too large to submit')

    error.code = 'desired-state-too-large'

    throw error
  }

  return text
}

/**
 * A new operation document (plan 5, "operations collection"). A waiting or
 * held one (state `queued`) holds only its items; an active one also gets the
 * built document and a submit command from `submissionFields` and
 * `newOutboxEntry`.
 * @param {object} params
 * @returns {object}
 */
export function buildOperation({
  type,
  state,
  teamId,
  environment,
  target,
  items,
  parentId,
  slot,
  action = 'write',
  idempotencyKeys,
  requestedBy,
  requestedByUserId,
  traceparent = null,
  cdpRequestId = null,
  held,
  mockOutcome,
  now = new Date().toISOString()
}) {
  const operation = {
    _id: uuidv7(),
    type,
    teamId,
    environment,
    target,
    items,
    action,
    requestedBy,
    requestedByUserId,
    traceparent,
    cdpRequestId,
    state,
    stateVersion: 0,
    attempt: 1,
    reconcileCount: 0,
    verify: { attempts: 0, nextAt: null },
    gitops: {},
    history: [
      { state, at: now, receivedAt: now, source: 'backend', eventId: null }
    ],
    outbox: [],
    outboxPending: false,
    createdAt: now,
    updatedAt: now
  }

  if (parentId) {
    operation.parentId = parentId
  }

  if (idempotencyKeys) {
    operation.idempotencyKeys = idempotencyKeys
  }

  if (slot) {
    operation.slot = slot
  }

  if (held) {
    operation.held = held
  }

  // Only the mock orchestrator sets this: the outcome its worker forces.
  if (mockOutcome) {
    operation.mockOutcome = mockOutcome
  }

  return operation
}

/**
 * Adds a built submission to an operation: the whole document as canonical
 * JSON, the base it was built on, and a submit command to publish.
 * @param {object} operation
 * @param {{document: object, expectedRevision?: number, expectedBase?: string|null}} submission
 * @returns {object} The fields to set.
 */
export function submissionFields(submission) {
  return {
    document: canonicalDocument(submission.document),
    ...(submission.expectedRevision !== undefined
      ? { expectedRevision: submission.expectedRevision }
      : {}),
    ...(submission.expectedBase !== undefined
      ? { expectedBase: submission.expectedBase }
      : {})
  }
}

// What a submit, and a reconcile from `requested`, carry from the operation.
function submitFields(operation) {
  const isPin = ['platform', 'tenants'].includes(operation.target.team)

  return {
    action: operation.action,
    ...(operation.document !== undefined
      ? { document: operation.document }
      : {}),
    ...(isPin
      ? { expectedBase: operation.expectedBase ?? null }
      : { expectedRevision: operation.expectedRevision ?? 0 })
  }
}

/**
 * The `aip.gitops.command/1` for an outbox entry, built from the operation as
 * it is when published (plan 5, "Messages"). A command never carries
 * more than the contract names.
 * @param {object} operation
 * @param {{commandId: string, type: string, attempt: number, state?: string, createdAt: string}} entry
 * @returns {object}
 */
export function buildCommand(operation, entry) {
  const carriesSubmit =
    entry.type === 'submit' ||
    (entry.type === 'reconcile' && entry.state === REQUESTED)

  return {
    schema: 'aip.gitops.command/1',
    type: entry.type,
    commandId: entry.commandId,
    operationId: operation._id,
    environment: operation.environment,
    team: operation.target.team,
    repository: operation.target.repository,
    path: operation.target.path,
    ...(carriesSubmit ? submitFields(operation) : {}),
    attempt: entry.attempt,
    ...(entry.type === 'reconcile' ? { state: entry.state } : {}),
    requestedBy: operation.requestedBy,
    traceparent: operation.traceparent ?? null,
    cdpRequestId: operation.cdpRequestId ?? null,
    createdAt: entry.createdAt
  }
}

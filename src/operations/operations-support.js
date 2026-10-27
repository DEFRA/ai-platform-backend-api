import { Boom, boomWithCode } from '#/common/helpers/boom-with-code.js'
import {
  newOutboxEntry,
  submissionFields
} from '#/operations/operation-factory.js'

/**
 * How many times a request or a resubmission looks again when another writer
 * moved the file first.
 */
export const MAX_TRIES = 3

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

/**
 * The conflict for a team file another change holds.
 * @returns {Error}
 */
export function busyConflict() {
  return boomWithCode(
    Boom.conflict,
    'Another change to this team is in progress; try again shortly',
    'team-file-busy'
  )
}

/**
 * Whether an error means the request can never be submitted as it stands.
 * @param {{code?: string, data?: {code?: string}}|undefined} error
 * @returns {boolean}
 */
export function isPolicyRefusal(error) {
  return UNSUBMITTABLE.has(error?.data?.code ?? error?.code)
}

/**
 * Best effort straight after a write: the sweep publishes what this does
 * not, so an SNS outage never fails or loses a request.
 * @param {{relay: {publishOperation: (id: string) => Promise<number>}, logger?: import('pino').Logger}} ctx
 * @param {string} operationId
 * @returns {Promise<void>}
 */
export async function publish({ relay, logger }, operationId) {
  try {
    await relay.publishOperation(operationId)
  } catch (error) {
    logger?.warn(
      { operationId, message: error.message },
      'Publishing after the write failed, the sweep will retry'
    )
  }
}

/**
 * The change that submits again what an operation already holds: a revert's
 * rollback document (or its removal of the file) and base, built once when
 * the revert was created and never rebuilt from the file as it is now.
 * @param {object} operation
 * @param {number} [attempt]
 * @returns {{set: object, push: {outbox: object}}}
 */
export function withHeldSubmit(operation, attempt = operation.attempt) {
  return {
    set: { outboxPending: true },
    push: { outbox: newOutboxEntry('submit', { attempt }) }
  }
}

/**
 * The change that submits an operation's built document: the submission
 * fields, a pending outbox flag and a `submit` command.
 * @param {object} operation
 * @param {{document: object}} submission
 * @param {number} [attempt]
 * @returns {{set: object, push: {outbox: object}}}
 */
export function withSubmit(operation, submission, attempt = operation.attempt) {
  return {
    set: {
      ...submissionFields(submission),
      revision: submission.document.revision ?? null,
      outboxPending: true
    },
    push: { outbox: newOutboxEntry('submit', { attempt }) }
  }
}

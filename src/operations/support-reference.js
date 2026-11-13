import { isModelItem } from '#/operations/operation-items.js'

const REFERENCE_PREFIX = 'AIP-'
const REFERENCE_LENGTH = 5

/**
 * The reference a person quotes to AI Platform Support: `AIP-` and the last
 * five characters of the operation id, in upper case. It is shown on the
 * failed-setup page and logged with every failure, so support can search the
 * logs for it.
 * @param {string | null | undefined} operationId
 * @returns {string | null}
 */
export function supportReferenceOf(operationId) {
  if (typeof operationId !== 'string' || operationId.length === 0) {
    return null
  }

  return `${REFERENCE_PREFIX}${operationId.slice(-REFERENCE_LENGTH).toUpperCase()}`
}

function entriesOf(operation) {
  return (operation.items ?? [])
    .filter(isModelItem)
    .map(({ entryId, modelSlug, change }) => ({
      entryId,
      modelSlug,
      change
    }))
}

function errorFieldsOf({ error }) {
  return {
    errorCode: error?.code ?? null,
    errorMessage: error?.message ?? null
  }
}

function gitopsFieldsOf({ gitops = {} }) {
  return {
    submitRunUrl: gitops.submitRunUrl ?? null,
    applyRunUrl: gitops.applyRunUrl ?? null,
    commitSha: gitops.commitSha ?? null
  }
}

function traceFieldsOf(operation) {
  return {
    requestedByUserId: operation.requestedByUserId ?? null,
    traceparent: operation.traceparent ?? null,
    cdpRequestId: operation.cdpRequestId ?? null
  }
}

/**
 * Everything support needs to find out what went wrong, keyed by the
 * reference: the operation, its team, environment and models, where it was
 * and where it stopped, the error, the runs and commit, and the trace ids.
 * @param {object} operation - the operation as written
 * @param {string} previousState - the state it moved from
 * @returns {Record<string, unknown>}
 */
export function failureLogFields(operation, previousState) {
  return {
    supportReference: supportReferenceOf(operation._id),
    operationId: operation._id,
    operationType: operation.type,
    teamId: operation.teamId,
    environment: operation.environment,
    entries: entriesOf(operation),
    state: operation.state,
    previousState,
    leftState: operation.leftState ?? null,
    attempt: operation.attempt,
    reconcileCount: operation.reconcileCount,
    ...errorFieldsOf(operation),
    ...gitopsFieldsOf(operation),
    ...traceFieldsOf(operation)
  }
}

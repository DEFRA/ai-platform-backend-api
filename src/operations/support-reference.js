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

/**
 * Everything support needs to find out what went wrong, keyed by the
 * reference: the operation, its team, environment and models, where it was
 * and where it stopped, the error, the runs and commit, and the trace ids.
 * @param {object} operation - the operation as written
 * @param {string} previousState - the state it moved from
 * @returns {Record<string, unknown>}
 */
export function failureLogFields(operation, previousState) {
  const { gitops = {} } = operation

  return {
    supportReference: supportReferenceOf(operation._id),
    operationId: operation._id,
    operationType: operation.type,
    teamId: operation.teamId,
    environment: operation.environment,
    entries: (operation.items ?? []).map(({ entryId, modelSlug, change }) => ({
      entryId,
      modelSlug,
      change
    })),
    state: operation.state,
    previousState,
    leftState: operation.leftState ?? null,
    attempt: operation.attempt,
    reconcileCount: operation.reconcileCount,
    errorCode: operation.error?.code ?? null,
    errorMessage: operation.error?.message ?? null,
    submitRunUrl: gitops.submitRunUrl ?? null,
    applyRunUrl: gitops.applyRunUrl ?? null,
    commitSha: gitops.commitSha ?? null,
    requestedByUserId: operation.requestedByUserId ?? null,
    traceparent: operation.traceparent ?? null,
    cdpRequestId: operation.cdpRequestId ?? null
  }
}

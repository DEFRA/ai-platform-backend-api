import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'

// How a team deployment's operation is submitted, shared by a new request
// and by a queued one dispatched later.

/**
 * The WS6 seam: the GitHub orchestrator submits a whole desired-state
 * document, which only the Teams developer's builder (with the team's
 * immutable `slug`) can produce. Until it is supplied, GitHub-mode requests
 * fail with `501 desired-state-unavailable`; the mock needs no document.
 * The document's `updatedBy` is always the requester's principal, which the
 * submit workflow requires to equal `requested_by`.
 * @param {(db: import('mongodb').Db, params: {teamId: string, environment: string, modelSlug: string, operationId: string, requestedBy: string, change?: 'add'|'remove'}) => Promise<{document: object, expectedRevision: number}|null>} [buildDesiredState]
 * @param {import('mongodb').Db} db
 * @param {object} params
 * @param {string} principal - `entra:{oid}` of the requester
 * @returns {Promise<{path: string, document: object, expectedRevision: number}>}
 */
export async function buildSubmission(
  buildDesiredState,
  db,
  params,
  principal
) {
  const desired = buildDesiredState ? await buildDesiredState(db, params) : null
  const slug = desired?.document?.team?.slug

  if (!slug) {
    throw boomWithCode(
      Boom.notImplemented,
      'The desired-state document for this team cannot be built yet',
      'desired-state-unavailable'
    )
  }

  return {
    path: `environments/${params.environment}/${slug}.json`,
    document: { ...desired.document, updatedBy: principal },
    expectedRevision: desired.expectedRevision ?? 0
  }
}

/**
 * What to submit for an operation: for GitHub, the whole desired-state
 * document, built now so it starts from the latest file on `main`; the mock
 * needs none.
 * @param {import('mongodb').Db} db
 * @param {{isGithub: boolean, buildDesiredState?: Function}} mode
 * @param {{teamId: string, environment: string, modelSlug: string, operationId: string, requestedBy: string}} params
 * @param {string} principal
 * @returns {Promise<{path: string|null, document: object|null, expectedRevision: number}>}
 */
export async function prepareSubmission(
  db,
  { isGithub, buildDesiredState },
  params,
  principal
) {
  return isGithub
    ? buildSubmission(buildDesiredState, db, params, principal)
    : { path: null, document: null, expectedRevision: 0 }
}

/**
 * The GitOps trail a GitHub-mode operation starts with.
 * @param {{path: string, document: object, expectedRevision: number}} submission
 * @param {string} operationId
 * @returns {object}
 */
export function githubTrailOf(submission, operationId) {
  return {
    path: submission.path,
    branch: `op/${operationId}`,
    action: 'write',
    revision: submission.document.revision ?? null,
    expectedRevision: submission.expectedRevision,
    submitRunId: null,
    submitRunUrl: null
  }
}

// A W3C trace context header; anything else is dropped rather than forwarded.
const W3C_TRACEPARENT = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/

/**
 * The orchestrator request that submits an operation's desired state as
 * its requester. Only a well-formed `traceparent` is passed on.
 * @param {{environment: string, operationId: string, principal: string, traceParent?: string}} operation
 * @param {{path: string|null, document: object|null, expectedRevision: number}} submission
 * @returns {import('#/adapters/tenant-orchestrator.js').DeploymentRequest}
 */
export function submissionRequest(
  { environment, operationId, principal, traceParent },
  submission
) {
  return {
    environment,
    path: submission.path,
    document: submission.document,
    operationId,
    requestedBy: principal,
    expectedRevision: submission.expectedRevision,
    action: 'write',
    traceParent: W3C_TRACEPARENT.test(traceParent ?? '')
      ? traceParent
      : undefined
  }
}

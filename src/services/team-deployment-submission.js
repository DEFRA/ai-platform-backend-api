import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { teamDesiredStateBuilder } from '#/services/team-desired-state.js'

// How a team change becomes an operation: the document the operation
// submits, the trace identifiers its commands carry, and what a refused
// request is reported as.

const UPSTREAM_UNAVAILABLE = 'upstream-unavailable'
const DESIRED_STATE_TOO_LARGE = 'desired-state-too-large'

// A W3C trace context header; anything else is dropped rather than forwarded.
const W3C_TRACEPARENT = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/
// What a command's `cdpRequestId` may hold (`command.schema.json`).
const CDP_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/

/**
 * The trace identifiers an operation carries into its commands. A value the
 * command contract would refuse is dropped, never forwarded.
 * @param {{traceParent?: string, cdpRequestId?: string}} headers
 * @returns {{traceparent: string|null, cdpRequestId: string|null}}
 */
export function traceOf({ traceParent, cdpRequestId }) {
  return {
    traceparent: W3C_TRACEPARENT.test(traceParent ?? '') ? traceParent : null,
    cdpRequestId: CDP_REQUEST_ID.test(cdpRequestId ?? '') ? cdpRequestId : null
  }
}

/**
 * Creates the function the operations build their document with: the whole
 * desired-state document for the operation's items, built from `main` now so
 * it starts from the latest file, as the next revision of the file it was
 * built from (`expectedRevision`). The document's `updatedBy` is the
 * operation's requester, which the submit workflow requires to equal
 * `requested_by`. A team the builder cannot build for fails with
 * `501 desired-state-unavailable`.
 * @param {import('mongodb').Db} db
 * @param {{buildDesiredState?: (db: import('mongodb').Db, params: {teamId: string, environment: string, items: object[], operationId: string}) => Promise<{document: object, expectedRevision: number}|null>}} [deps]
 * @returns {(operation: object) => Promise<{document: object, expectedRevision: number}>}
 */
export function createDocumentBuilder(
  db,
  { buildDesiredState = teamDesiredStateBuilder } = {}
) {
  return async function buildDocument(operation) {
    const desired = await buildDesiredState(db, {
      teamId: operation.teamId,
      environment: operation.environment,
      items: operation.items,
      operationId: operation._id
    })

    if (!desired?.document?.team?.slug) {
      throw boomWithCode(
        Boom.notImplemented,
        'The desired-state document for this team cannot be built yet',
        'desired-state-unavailable'
      )
    }

    return {
      document: { ...desired.document, updatedBy: operation.requestedBy },
      expectedRevision: desired.expectedRevision ?? 0
    }
  }
}

/**
 * The error a refused request is reported as: a refusal that already is an
 * API error (a policy refusal, a busy file) as it is, a document too large
 * as `422`, anything else as `502 upstream-unavailable`.
 * @param {Error & {code?: string}} error
 * @param {string} message - the `502` message
 * @returns {import('@hapi/boom').Boom}
 */
export function refusalOf(error, message) {
  if (error?.isBoom) {
    return error
  }

  return error?.code === DESIRED_STATE_TOO_LARGE
    ? boomWithCode(
        Boom.badData,
        'The desired-state document is too large to submit',
        DESIRED_STATE_TOO_LARGE
      )
    : boomWithCode(Boom.badGateway, message, UPSTREAM_UNAVAILABLE)
}

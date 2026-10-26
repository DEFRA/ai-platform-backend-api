import {
  endRefused,
  finish,
  promoteWaiting,
  requestOperation
} from '#/operations/operations-slots.js'
import {
  completeFollowUp,
  publishApply,
  reconcile,
  resubmit,
  retry
} from '#/operations/operations-retry.js'
import {
  settleRecoveredRevert,
  startRevert
} from '#/operations/operations-revert.js'

// The principal the backend's own operations (a revert) are attributed to.
export { SYSTEM_ACTOR as SYSTEM_PRINCIPAL } from '#/services/team-deployment-entries.js'

function bindTo(ctx, operationFn) {
  return (...args) => operationFn(ctx, ...args)
}

/**
 * The application core of the operations (plan 5, 6.1): the file's slots,
 * merging, promotion, resubmission, the apply retry and the revert. It
 * decides nothing about events (the state machine and the handler do);
 * it creates and moves operations and writes their commands to the outbox,
 * which the relay publishes. The work lives in `operations-slots.js`,
 * `operations-retry.js` and `operations-revert.js`; this binds them to the
 * dependencies.
 * @param {object} deps
 * @param {import('mongodb').Db} deps.db
 * @param {object} deps.settings
 * @param {{publishOperation: (id: string) => Promise<number>}} deps.relay
 * @param {(operation: object) => Promise<{document: object, expectedRevision?: number, expectedBase?: string|null}>} deps.buildDocument - the whole document for an operation's items, from main now; throws a coded error for a request that cannot be built
 * @param {import('#/adapters/team-file-reader.js').TeamFileReader} deps.reader
 * @param {{isPaused: (environment: string) => Promise<boolean>}} deps.controls
 * @param {import('pino').Logger} [deps.logger]
 */
export function createOperationsService(deps) {
  const ctx = { ...deps }

  return {
    request: bindTo(ctx, requestOperation),
    promoteWaiting: bindTo(ctx, promoteWaiting),
    finish: bindTo(ctx, finish),
    completeFollowUp: bindTo(ctx, completeFollowUp),
    resubmit: bindTo(ctx, resubmit),
    publishApply: bindTo(ctx, publishApply),
    reconcile: bindTo(ctx, reconcile),
    startRevert: bindTo(ctx, startRevert),
    settleRecoveredRevert: bindTo(ctx, settleRecoveredRevert),
    retry: bindTo(ctx, retry),
    endRefused: bindTo(ctx, endRefused)
  }
}

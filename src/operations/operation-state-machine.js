// The operation state machine (plan 5, "States" and "Rules"): pure, no I/O.
// An operation moves forward by rank; an event of a lower or equal rank only
// fills facts the operation lacks, except four named exceptions. The handler
// persists what these functions decide, by compare-and-set on `stateVersion`.

export const QUEUED = 'queued'
export const REQUESTED = 'requested'
export const COMMITTED = 'committed'
export const DEPLOYING = 'deploying'
export const DEPLOYED = 'deployed'
export const VERIFIED = 'verified'
export const ACTIVE = 'active'
export const REMOVED = 'removed'
export const CHECKS_FAILED = 'checks-failed'
export const DEPLOY_FAILED = 'deploy-failed'
export const TIMED_OUT = 'timed-out'

/**
 * Each state's rank (plan 5). `timed-out` has none of its own: it ranks as
 * the state it left (`leftState`).
 */
export const RANK = Object.freeze({
  [QUEUED]: 0,
  [REQUESTED]: 1,
  [COMMITTED]: 2,
  [DEPLOYING]: 3,
  [DEPLOYED]: 4,
  [VERIFIED]: 5,
  [ACTIVE]: 6,
  [REMOVED]: 6,
  [CHECKS_FAILED]: 2,
  [DEPLOY_FAILED]: 4
})

/**
 * The types of operation the backend creates or records (plan 5).
 */
export const OPERATION_TYPES = Object.freeze({
  WRITE: 'team-file.write',
  REMOVE: 'team-file.remove',
  REVERT: 'team-file.revert',
  PIN: 'pin.write',
  BREAK_GLASS: 'break-glass'
})

// The `checks-failed` codes the backend resubmits (plan 5, "Rules").
const RETRYABLE_CHECK_CODES = new Set([
  'stale-revision',
  'paused',
  'commit-conflict'
])

/**
 * The rank an operation has for the rank rule.
 * @param {{state: string, leftState?: string}} operation
 * @returns {number}
 */
export function rankOf({ state, leftState }) {
  return RANK[state === TIMED_OUT ? leftState : state]
}

/**
 * Whether a `checks-failed` event's reason is one the backend resubmits.
 * @param {{failureReason?: {code: string, retryable: boolean}}} event
 * @returns {boolean}
 */
export function isRetryableRefusal(event) {
  return (
    event.failureReason?.retryable === true &&
    RETRYABLE_CHECK_CODES.has(event.failureReason.code)
  )
}

/**
 * The facts an event reports, by status: only what that status carries.
 * @param {object} event
 * @returns {Record<string, unknown>}
 */
export function factsOf(event) {
  const facts = {}
  const fromSubmit = ['requested', 'checks-failed', 'committed'].includes(
    event.status
  )

  if (event.runId != null) {
    facts[fromSubmit ? 'submitRunId' : 'applyRunId'] = event.runId
    facts[fromSubmit ? 'submitRunUrl' : 'applyRunUrl'] = event.runUrl
  }

  for (const key of ['commitSha', 'committedAt', 'appliedSha', 'resources']) {
    if (event[key] !== undefined) {
      facts[key] = event[key]
    }
  }

  return facts
}

// Only the facts the operation does not hold yet.
function missingFacts(operation, facts) {
  return Object.fromEntries(
    Object.entries(facts).filter(([key]) => operation.gitops?.[key] == null)
  )
}

function fill(operation, facts) {
  return { kind: 'fill', facts: missingFacts(operation, facts) }
}

function advance(state, facts, extra = {}) {
  return { kind: 'advance', state, facts, ...extra }
}

// A run older than the one recorded for the apply is not this attempt's.
function olderThanRecorded(operation, event) {
  const recorded = operation.gitops?.applyRunId

  return recorded != null && event.runId < recorded
}

function sameRunAsLastFailure(operation, event) {
  const last = operation.lastFailure

  return last?.runId === event.runId && last?.runAttempt === event.runAttempt
}

function decideChecksFailed(operation, event, facts) {
  if (rankOf(operation) >= RANK[CHECKS_FAILED]) {
    return fill(operation, facts)
  }

  return isRetryableRefusal(event)
    ? { kind: 'hold', code: event.failureReason.code, facts }
    : advance(CHECKS_FAILED, facts)
}

function decideDeployFailed(operation, event, facts) {
  if (olderThanRecorded(operation, event)) {
    return { kind: 'ignore', reason: 'older-run' }
  }

  if (rankOf(operation) > RANK[DEPLOY_FAILED]) {
    return fill(operation, facts)
  }

  if (event.failureReason?.retryable) {
    return { kind: 'defer', facts }
  }

  // The retry's own failure counts again, once per run attempt; the first
  // failure counts from any state below deploy-failed.
  if (operation.state === DEPLOY_FAILED) {
    return operation.retrying && !sameRunAsLastFailure(operation, event)
      ? advance(DEPLOY_FAILED, facts, { recount: true })
      : fill(operation, facts)
  }

  return advance(DEPLOY_FAILED, facts)
}

function decideDeployed(operation, event, facts) {
  if (operation.state === DEPLOY_FAILED) {
    return olderThanRecorded(operation, event)
      ? { kind: 'ignore', reason: 'older-run' }
      : advance(DEPLOYED, facts, { recovered: true })
  }

  return rankOf(operation) < RANK[DEPLOYED]
    ? advance(DEPLOYED, facts)
    : fill(operation, facts)
}

function decideDeploying(operation, event, facts) {
  const rank = rankOf(operation)

  if (rank < RANK[DEPLOYING]) {
    return advance(DEPLOYING, facts)
  }

  const recorded = operation.gitops?.applyRunId
  const inFlight = rank === RANK[DEPLOYING] || operation.state === DEPLOY_FAILED

  // Applies are serialised per environment, so a later run is the one now
  // applying this operation's commit.
  if (inFlight && (recorded == null || event.runId > recorded)) {
    return {
      kind: 'replace-run',
      facts: {
        applyRunId: facts.applyRunId,
        applyRunUrl: facts.applyRunUrl
      }
    }
  }

  return fill(operation, facts)
}

/**
 * What an event does to an operation (plan 5, "Rules"): `duplicate` (its
 * event ID is in the history), `ignore`, `fill` (lower or equal rank: only
 * missing facts), `advance` (higher rank), `hold` (a retryable refusal back
 * to `queued`), `defer` (a retryable `deploy-failed`: no state change) or
 * `replace-run` (a newer apply run). Never reads or writes anything.
 * @param {object} operation
 * @param {object} event - a validated `aip.gitops.event/1`
 * @returns {{kind: string, state?: string, facts?: object, code?: string, reason?: string, recount?: boolean, recovered?: boolean}}
 */
export function decideEvent(operation, event) {
  if (operation.history?.some(({ eventId }) => eventId === event.eventId)) {
    return { kind: 'duplicate' }
  }

  const facts = factsOf(event)

  switch (event.status) {
    case CHECKS_FAILED:
      return decideChecksFailed(operation, event, facts)
    case DEPLOY_FAILED:
      return decideDeployFailed(operation, event, facts)
    case DEPLOYED:
      return decideDeployed(operation, event, facts)
    case DEPLOYING:
      return decideDeploying(operation, event, facts)
    default:
      return RANK[event.status] > rankOf(operation)
        ? advance(event.status, facts)
        : fill(operation, facts)
  }
}

/**
 * What to do about a counted `deploy-failed` (plan 5): an attributable
 * failure at attempt 1 gets one fresh apply, at attempt 2 a revert of the
 * whole operation; a failure that is not the team's own alerts an engineer
 * and ends.
 * @param {{attempt: number}} operation
 * @param {{attributable?: boolean}} event
 * @returns {'retry-apply'|'revert'|'alert'}
 */
export function failurePolicy(operation, event) {
  if (!event.attributable) {
    return 'alert'
  }

  return operation.attempt <= 1 ? 'retry-apply' : 'revert'
}

/**
 * The deadline from entering a state, or null for a state with none (plan 5).
 * @param {string} state
 * @param {{deadlines: Record<string, number>}} settings - ms by state
 * @param {number} [now]
 * @returns {string|null} ISO time
 */
export function deadlineFor(state, settings, now = Date.now()) {
  const ms = settings.deadlines[state]

  return ms ? new Date(now + ms).toISOString() : null
}

/**
 * What the sweeper does with an operation past its deadline (plan 5): the
 * first time it asks the worker to reconcile and extends the deadline; the
 * second time, with no event in between, it times the operation out.
 * @param {{deadlineAt?: string|null, reconcileCount?: number}} operation
 * @param {number} [now]
 * @returns {'wait'|'reconcile'|'time-out'}
 */
export function overdueAction(operation, now = Date.now()) {
  if (!operation.deadlineAt || Date.parse(operation.deadlineAt) > now) {
    return 'wait'
  }

  return (operation.reconcileCount ?? 0) < 1 ? 'reconcile' : 'time-out'
}

const SECOND_MS = 1000
const VERIFY_RETRY_1_S = 30
const VERIFY_RETRY_2_S = 60
const VERIFY_RETRY_3_S = 120
const VERIFY_RETRY_4_S = 240
const RESUBMIT_1_S = 10
const RESUBMIT_2_S = 30
const RESUBMIT_3_S = 90

/**
 * The delays before the ARM verification retries (plan 5): FIFO queues take
 * no per-message delay, so the sweeper retries at these ages.
 */
export const VERIFY_BACKOFF_MS = Object.freeze([
  VERIFY_RETRY_1_S * SECOND_MS,
  VERIFY_RETRY_2_S * SECOND_MS,
  VERIFY_RETRY_3_S * SECOND_MS,
  VERIFY_RETRY_4_S * SECOND_MS
])

/**
 * What follows a failed ARM verification: another try at `nextAt`, or, once
 * `maxAttempts` have failed, the end.
 * @param {number} attempts - failed verifications so far, this one included
 * @param {number} maxAttempts
 * @param {number} [now]
 * @returns {{kind: 'retry', nextAt: string}|{kind: 'fail'}}
 */
export function verifyOutcome(attempts, maxAttempts, now = Date.now()) {
  if (attempts >= maxAttempts) {
    return { kind: 'fail' }
  }

  const delay =
    VERIFY_BACKOFF_MS[Math.min(attempts, VERIFY_BACKOFF_MS.length) - 1]

  return { kind: 'retry', nextAt: new Date(now + delay).toISOString() }
}

/**
 * The delays before a refused write is rebuilt and resubmitted (plan 5).
 */
export const RESUBMIT_DELAYS_MS = Object.freeze([
  RESUBMIT_1_S * SECOND_MS,
  RESUBMIT_2_S * SECOND_MS,
  RESUBMIT_3_S * SECOND_MS
])

/**
 * When the next resubmission is due, or null once `max` are used up.
 * @param {number} used - resubmissions already made
 * @param {number} max - `GITOPS_RESUBMIT_MAX`
 * @param {number} [now]
 * @returns {string|null}
 */
export function nextResubmitAt(used, max, now = Date.now()) {
  if (used >= max) {
    return null
  }

  const delay =
    RESUBMIT_DELAYS_MS[Math.min(used, RESUBMIT_DELAYS_MS.length - 1)]

  return new Date(now + delay).toISOString()
}

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000

/**
 * The held deadline: `baseMs`, doubling each time it passes with nothing
 * moving, up to four hours (plan 5, "Pause").
 * @param {number} baseMs - `GITOPS_DEADLINE_HELD_MS`
 * @param {number} [passes] - times the deadline has already passed
 * @param {number} [now]
 * @returns {string}
 */
export function heldDeadline(baseMs, passes = 0, now = Date.now()) {
  return new Date(
    now + Math.min(baseMs * 2 ** passes, FOUR_HOURS_MS)
  ).toISOString()
}

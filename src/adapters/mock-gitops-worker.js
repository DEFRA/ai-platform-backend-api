import { createHash } from 'node:crypto'

import { config } from '#/config.js'
import { createInMemoryCommandPublisher } from '#/adapters/in-memory-command-publisher.js'
import { findOperation } from '#/operations/operation-repository.js'

// The mock stands in for the GitOps worker and the workflows in local
// development and tests: it takes each command from the in-memory queue and
// sends the events the real pipeline would, one stage at a time, to the same
// events handler the SQS consumer feeds. Every state and its history time is
// therefore exercised, and a failure is corroborated by a mock run reader.

export const MOCK_CHECKS_FAILED = 'checks-failed'
export const MOCK_DEPLOY_FAILED = 'deploy-failed'

// Reserved-test-pattern failure simulation, as the mock credential issuer's
// `test-fail-` userId prefix: a requester in one of these Entra object ID
// ranges ends in a terminal failure instead of `active`. Entra object IDs
// are random version 4 GUIDs, which never start `00000000-0000-0000-`.
const FORCED_BY_PRINCIPAL = [
  ['entra:00000000-0000-0000-0001-', MOCK_CHECKS_FAILED],
  ['entra:00000000-0000-0000-0002-', MOCK_DEPLOY_FAILED]
]

// The journey tests sign in as real Entra users, so they carry the outcome in
// the request's purpose. Only the mock orchestrator ever reads it.
const FORCED_BY_PURPOSE = [
  ['[mock:checks-failed]', MOCK_CHECKS_FAILED],
  ['[mock:deploy-failed]', MOCK_DEPLOY_FAILED]
]

const SUBMIT_WORKFLOW = '.github/workflows/submit.yml'
const APPLY_WORKFLOW = '.github/workflows/apply.yml'
const APPLY_STATES = new Set(['committed', 'deploying', 'deployed'])
const SUBMIT_STATUSES = new Set(['requested', 'committed', MOCK_CHECKS_FAILED])
// A fake commit SHA is as long as a Git object name in hex.
const SHA_HEX_LENGTH = 40

/**
 * The outcome a request's purpose forces in the mock orchestrator, or null.
 * The caller records it on the operation only in mock mode, so the marker
 * has no effect with a real orchestrator.
 * @param {string|undefined} purpose
 * @returns {'checks-failed'|'deploy-failed'|null}
 */
export function mockOutcomeOfPurpose(purpose) {
  return (
    FORCED_BY_PURPOSE.find(([marker]) => purpose?.includes(marker))?.[1] ?? null
  )
}

function forcedOutcomeOf(command, operation) {
  return (
    operation?.mockOutcome ??
    FORCED_BY_PRINCIPAL.find(([prefix]) =>
      command.requestedBy.startsWith(prefix)
    )?.[1] ??
    null
  )
}

function mockSha(operationId) {
  return createHash('sha256')
    .update(operationId)
    .digest('hex')
    .slice(0, SHA_HEX_LENGTH)
}

/**
 * A run reader over the runs the mock worker made up, so the corroborator
 * can check a mock failure like a real one.
 * @returns {{record: (run: object) => void, getRun: Function, getRunReport: Function, isOnMain: Function, getActorPermission: Function}}
 */
export function createMockRunReader() {
  const runs = new Map()

  return {
    record(run) {
      runs.set(run.id, run)
    },
    async getRun({ runId }) {
      return runs.get(runId) ?? null
    },
    async getRunReport({ runId }) {
      return runs.get(runId)?.report ?? null
    },
    async isOnMain() {
      return true
    },
    async getActorPermission() {
      return null
    }
  }
}

// The steps a command leads to, and whether the first apply fails: a forced
// `deploy-failed` is not attributable, so it is final at once with nothing
// to retry or revert, and an admin's retry (attempt 2) goes through.
function stepsOf(command, forced) {
  const steps = []
  const submits =
    command.type === 'submit' ||
    (command.type === 'reconcile' && command.state === 'requested')

  if (
    !submits &&
    command.type === 'reconcile' &&
    !APPLY_STATES.has(command.state)
  ) {
    return []
  }

  if (submits) {
    steps.push('requested')

    if (forced === MOCK_CHECKS_FAILED) {
      return [...steps, MOCK_CHECKS_FAILED]
    }

    steps.push('committed')
  }

  const fails = forced === MOCK_DEPLOY_FAILED && command.attempt === 1

  return [...steps, 'deploying', fails ? MOCK_DEPLOY_FAILED : 'deployed']
}

// Run IDs rise by one, and never fall behind the clock, as GitHub's do.
function createRunIdSource(now) {
  let lastRunId = 0

  return function nextRunId() {
    lastRunId = Math.max(lastRunId + 1, now())

    return lastRunId
  }
}

// A cancellable sleep: `pause` resolves true once it has slept, false when
// `stop` cut it short or the pauser was already stopped.
function createPauser() {
  const sleepers = new Set()
  let stopped = false

  return {
    pause(ms) {
      return new Promise((resolve) => {
        const sleeper = { resolve }

        sleeper.timer = setTimeout(() => {
          sleepers.delete(sleeper)
          resolve(!stopped)
        }, ms)
        sleeper.timer.unref()
        sleepers.add(sleeper)
      })
    },
    stop() {
      stopped = true

      for (const sleeper of sleepers) {
        clearTimeout(sleeper.timer)
        sleeper.resolve(false)
      }

      sleepers.clear()
    }
  }
}

function recordRun({ runReader, now }, command, { source, runId, conclusion }) {
  const label = source === 'submit' ? 'Submit' : 'Apply'

  runReader.record({
    id: runId,
    name: `${label} (${command.operationId})`,
    path: source === 'submit' ? SUBMIT_WORKFLOW : APPLY_WORKFLOW,
    headBranch: 'main',
    status: 'completed',
    conclusion,
    runStartedAt: new Date(now()).toISOString(),
    report:
      conclusion === 'failure'
        ? { outcome: 'failure', failingTeams: [command.team] }
        : null
  })

  return {
    source,
    runId,
    runUrl: `https://github.com/${command.repository}/actions/runs/${runId}`
  }
}

function eventOf(now, command, operation, status, run, facts) {
  return {
    schema: 'aip.gitops.event/1',
    eventId: `${command.operationId}:${status}:${run.runId}:1`,
    environment: command.environment,
    team: command.team,
    path: command.path,
    action: command.action ?? operation?.action ?? 'write',
    status,
    timestamp: new Date(now()).toISOString(),
    source: run.source,
    requestedBy: command.requestedBy,
    repository: command.repository,
    traceparent: command.traceparent ?? null,
    cdpRequestId: command.cdpRequestId ?? null,
    operationId: command.operationId,
    runId: run.runId,
    runAttempt: 1,
    runUrl: run.runUrl,
    ...facts
  }
}

function factsOf(status, command, { sha, committedAt }) {
  if (status === 'requested') {
    return {}
  }

  if (status === MOCK_CHECKS_FAILED) {
    return {
      failureReason: {
        code: 'validation-failed',
        message: 'Automated checks failed on the desired-state change (mock)',
        retryable: false
      }
    }
  }

  if (status === MOCK_DEPLOY_FAILED) {
    return {
      commitSha: sha,
      committedAt,
      failureReason: {
        code: 'apply-failed',
        message: 'Deploy workflow failed to reconcile the stack (mock)',
        retryable: false
      },
      failingTeams: [command.team],
      attributable: false
    }
  }

  return {
    commitSha: sha,
    committedAt,
    ...(status === 'deployed' ? { appliedSha: sha, resources: [] } : {})
  }
}

// The stages are sent one after another, each a stage duration after the
// last, so the order of the events is the order of the pipeline.
async function play(stages, command, operation, steps) {
  const { handle, now, pause, nextRunId, stageDurationMs } = stages
  const sha = operation?.gitops?.commitSha ?? mockSha(command.operationId)
  const runIds = { submit: nextRunId(), apply: nextRunId() }
  let committedAt =
    operation?.gitops?.committedAt ?? new Date(now()).toISOString()

  for (const status of steps) {
    if (!(await pause(stageDurationMs))) {
      return
    }

    const source = SUBMIT_STATUSES.has(status) ? 'submit' : 'apply'
    const failed =
      status === MOCK_CHECKS_FAILED || status === MOCK_DEPLOY_FAILED
    const run = recordRun(stages, command, {
      source,
      runId: runIds[source],
      conclusion: failed ? 'failure' : 'success'
    })

    if (status === 'committed') {
      committedAt = new Date(now()).toISOString()
    }

    const facts = factsOf(status, command, { sha, committedAt })

    await handle(eventOf(now, command, operation, status, run, facts))
  }
}

/**
 * Creates the mock worker: `accept` takes a command and, a stage duration at
 * a time, sends the events it leads to through `handle`.
 * @param {object} deps
 * @param {import('mongodb').Db} deps.db
 * @param {(event: object) => Promise<unknown>} deps.handle - the events handler
 * @param {ReturnType<typeof createMockRunReader>} deps.runReader
 * @param {number} deps.stageDurationMs
 * @param {import('pino').Logger} [deps.logger]
 * @param {() => number} [deps.now]
 */
export function createMockGitopsWorker({
  db,
  handle,
  runReader,
  stageDurationMs,
  logger,
  now = Date.now
}) {
  const pending = new Set()
  const pauser = createPauser()
  const stages = {
    handle,
    runReader,
    now,
    pause: pauser.pause,
    nextRunId: createRunIdSource(now),
    stageDurationMs
  }

  return {
    /**
     * Takes a command off the queue: the events follow in the background.
     * @param {object} command
     */
    async accept(command) {
      const operation = await findOperation(db, command.operationId)
      const steps = stepsOf(command, forcedOutcomeOf(command, operation))
      const chain = play(stages, command, operation, steps)
        .catch((error) => {
          logger?.warn(
            { operationId: command.operationId, message: error.message },
            'The mock worker could not send an event'
          )
        })
        .finally(() => pending.delete(chain))

      pending.add(chain)
    },

    /**
     * Resolves once every command taken so far has sent its last event.
     * @returns {Promise<void>}
     */
    async idle() {
      while (pending.size > 0) {
        await Promise.all(pending)
      }
    },

    /**
     * Cancels the events still to come.
     */
    stop() {
      pauser.stop()
    }
  }
}

/**
 * The mock transport (the mock orchestrator): commands go to an in-memory
 * queue whose consumer is the mock worker, which feeds the events handler;
 * there is nothing to start.
 * @param {{db: import('mongodb').Db, handle: (event: object) => Promise<unknown>, logger?: import('pino').Logger}} deps
 * @param {{stageDurationMs?: number}} [options]
 */
export function createMockTransport(
  { db, handle, logger },
  { stageDurationMs = config.get('teamDeployment.mockStageDurationMs') } = {}
) {
  const runReader = createMockRunReader()
  const worker = createMockGitopsWorker({
    db,
    handle,
    runReader,
    stageDurationMs,
    logger
  })
  const publisher = createInMemoryCommandPublisher({
    onDeliver: (command) => worker.accept(command)
  })

  return {
    publisher,
    runReader,
    worker,
    start() {},
    async stop() {
      worker.stop()
    }
  }
}

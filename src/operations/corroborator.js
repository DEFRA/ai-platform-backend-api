// Corroboration (plan 5, "Corroboration"): an event can only be sent by a
// holder of the events identity, but the backend does not take a failure on
// trust. Before acting on `checks-failed` or `deploy-failed` (a terminal state,
// a retry or a revert), and before recording a run it has no operation for,
// it reads the run with its read token; an event that does not match is
// logged and dropped. IDs and codes only are logged.

const SUBMIT_WORKFLOW = '.github/workflows/submit.yml'
const APPLY_WORKFLOWS = [
  '.github/workflows/apply.yml',
  '.github/workflows/reconcile-all.yml'
]
const PAUSE_WORKFLOW = '.github/workflows/pause.yml'
const KNOWN_WORKFLOWS = [SUBMIT_WORKFLOW, ...APPLY_WORKFLOWS, PAUSE_WORKFLOW]
const FAILED_CONCLUSIONS = new Set([
  'action_required',
  'cancelled',
  'failure',
  'stale',
  'startup_failure',
  'timed_out'
])

const OK = Object.freeze({ ok: true })

function mismatch(reason) {
  return { ok: false, reason }
}

/**
 * Creates the corroborator over a `RunReader` (the GitHub adapter).
 * @param {{runReader: ReturnType<import('#/adapters/github/github-run-reader.js').createGithubRunReader>, repositories: {tenants: string, deployments: string}}} deps
 */
export function createCorroborator({ runReader, repositories }) {
  const stateRepositories = [repositories.tenants, repositories.deployments]

  // The checks every run must pass: a state repository, on main, of a
  // workflow the portal knows, with the ID and URL the event names.
  async function readKnownRun(event, workflows) {
    if (!stateRepositories.includes(event.repository)) {
      return mismatch('unknown-repository')
    }

    const run = await runReader.getRun({
      repository: event.repository,
      runId: event.runId
    })

    if (!run) {
      return mismatch('run-not-found')
    }

    if (run.headBranch !== 'main') {
      return mismatch('not-on-main')
    }

    if (!workflows.some((workflow) => run.path === workflow)) {
      return mismatch('unexpected-workflow')
    }

    return { ok: true, run }
  }

  function workflowsFor(event) {
    if (event.source === 'submit') {
      return [SUBMIT_WORKFLOW]
    }

    if (event.source === 'pause') {
      return [PAUSE_WORKFLOW]
    }

    return event.source === 'apply' ? APPLY_WORKFLOWS : KNOWN_WORKFLOWS
  }

  async function failureReportMatches(event) {
    const report = await runReader.getRunReport({
      repository: event.repository,
      runId: event.runId,
      environment: event.environment
    })

    if (!report) {
      // The run may still be uploading it: transient, so the event is
      // redelivered rather than dropped.
      return { ok: false, reason: 'report-unavailable', transient: true }
    }

    if (event.failureReason?.retryable) {
      return report.outcome === 'paused' ? OK : mismatch('report-not-paused')
    }

    const listed = report.failingTeams ?? []

    return (event.failingTeams ?? []).every((slug) => listed.includes(slug))
      ? OK
      : mismatch('failing-teams-differ')
  }

  /**
   * Whether a `checks-failed` or `deploy-failed` event for an operation is
   * what GitHub says: the repository, the workflow, the branch, the
   * submit run's name, the conclusion of a finished run and, for
   * `deploy-failed`, the run report.
   * @param {object} event
   * @param {object} operation
   * @returns {Promise<{ok: boolean, reason?: string, transient?: boolean, run?: object}>}
   */
  async function corroborateFailure(event, operation) {
    if (event.repository !== operation.target.repository) {
      return mismatch('repository-differs')
    }

    const known = await readKnownRun(event, workflowsFor(event))

    if (!known.ok) {
      return known
    }

    const { run } = known

    if (
      event.source === 'submit' &&
      !run.name?.includes(`(${operation._id})`)
    ) {
      return mismatch('run-is-for-another-operation')
    }

    // A refusal that is retryable may come from a run that went on to pass.
    const permanent = !event.failureReason?.retryable

    if (
      permanent &&
      run.status === 'completed' &&
      !FAILED_CONCLUSIONS.has(run.conclusion)
    ) {
      return mismatch('run-did-not-fail')
    }

    if (event.status === 'deploy-failed') {
      const report = await failureReportMatches(event)

      return report.ok ? { ok: true, run } : report
    }

    return { ok: true, run }
  }

  /**
   * Whether a run with no portal operation (a manual `submit`, an apply,
   * `reconcile-all`) exists in a state repository, on main, from a known
   * workflow, so it can be recorded as an external operation.
   * @param {object} event
   */
  async function corroborateRun(event) {
    return readKnownRun(event, workflowsFor(event))
  }

  /**
   * Whether a `paused` or `resumed` event is a successful `pause.yml` run on
   * main by actors who hold the admin role on the repository.
   * @param {object} event
   */
  async function corroboratePause(event) {
    const known = await readKnownRun(event, [PAUSE_WORKFLOW])

    if (!known.ok) {
      return known
    }

    const { run } = known

    if (run.conclusion !== 'success' && run.status === 'completed') {
      return mismatch('run-did-not-succeed')
    }

    for (const username of new Set([run.actor, run.triggeringActor])) {
      const permission = username
        ? await runReader.getActorPermission({
            repository: event.repository,
            username
          })
        : null

      if (permission !== 'admin') {
        return mismatch('actor-not-admin')
      }
    }

    return { ok: true, run }
  }

  /**
   * Whether a break-glass commit exists in a state repository, on main.
   * @param {object} event
   */
  async function corroborateCommit(event) {
    if (!stateRepositories.includes(event.repository)) {
      return mismatch('unknown-repository')
    }

    return (await runReader.isOnMain({
      repository: event.repository,
      sha: event.commitSha
    }))
      ? OK
      : mismatch('commit-not-on-main')
  }

  return {
    corroborateFailure,
    corroborateRun,
    corroboratePause,
    corroborateCommit
  }
}

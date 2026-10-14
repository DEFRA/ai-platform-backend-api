// GitHub REST response shapes for the GitOps contract, one factory per
// endpoint. Each takes overrides; never share a returned object between
// tests. Shapes follow GitHub's REST reference for API version 2026-03-10
// (fields this backend reads only) and the run report from
// ai-platform-infra checks/src/run-report.js; none has yet been checked
// against a live response - do that in WS5 milestone M6 and note it here.

const REPOSITORY_URL = 'https://github.com/DEFRA/ai-platform-tenants'

/**
 * Body of `POST .../actions/workflows/{id}/dispatches` on 200.
 * @param {object} [overrides]
 */
export function dispatchedRun(overrides = {}) {
  const runId = overrides.workflow_run_id ?? 1001

  return {
    workflow_run_id: runId,
    run_url: `https://api.github.com/repos/DEFRA/ai-platform-tenants/actions/runs/${runId}`,
    html_url: `${REPOSITORY_URL}/actions/runs/${runId}`,
    ...overrides
  }
}

/**
 * Body of `GET .../actions/runs/{run_id}`.
 * @param {object} [overrides]
 */
export function workflowRun(overrides = {}) {
  return {
    id: 1001,
    status: 'in_progress',
    conclusion: null,
    html_url: `${REPOSITORY_URL}/actions/runs/1001`,
    ...overrides
  }
}

/**
 * One item of `GET .../pulls?head={owner}:op/{operationId}&state=all`.
 * @param {object} [overrides]
 */
export function pullRequest(overrides = {}) {
  return {
    number: 7,
    state: 'open',
    merged_at: null,
    merge_commit_sha: 'test-merge-preview-sha',
    html_url: `${REPOSITORY_URL}/pull/7`,
    head: { sha: 'head-sha' },
    ...overrides
  }
}

/**
 * Body of `GET .../commits/{ref}/check-runs?check_name=...`.
 * @param {object[]} checkRuns
 */
export function checkRunList(checkRuns) {
  return { total_count: checkRuns.length, check_runs: checkRuns }
}

/**
 * One check run, by default the `validate-desired-state / validate` required
 * check still running.
 * @param {object} [overrides]
 */
export function checkRun(overrides = {}) {
  return {
    id: 1,
    name: 'validate-desired-state / validate',
    status: 'in_progress',
    conclusion: null,
    ...overrides
  }
}

/**
 * One item of `GET .../deployments?environment={env}`.
 * @param {object} [overrides]
 */
export function deployment(overrides = {}) {
  return {
    id: 501,
    sha: 'merge-sha',
    environment: 'infradev',
    created_at: '2026-10-13T10:05:00Z',
    ...overrides
  }
}

/**
 * One item of `GET .../deployments/{id}/statuses`; Actions links it to the
 * job of the apply run.
 * @param {object} [overrides]
 */
export function deploymentStatus(overrides = {}) {
  const runId = overrides.runId ?? 2002
  const { runId: _runId, ...rest } = overrides

  return {
    id: 9001,
    state: 'in_progress',
    created_at: '2026-10-13T10:06:00Z',
    log_url: `${REPOSITORY_URL}/actions/runs/${runId}/job/3003`,
    target_url: `${REPOSITORY_URL}/actions/runs/${runId}/job/3003`,
    ...rest
  }
}

/**
 * Body of `GET .../compare/{base}...{head}`.
 * @param {'ahead'|'behind'|'diverged'|'identical'} status
 */
export function comparison(status) {
  return { status, ahead_by: status === 'ahead' ? 1 : 0, commits: [] }
}

/**
 * Body of `GET .../actions/runs/{run_id}/artifacts?name=run-report-{env}.json`.
 * @param {object[]} [artifacts]
 */
export function artifactList(
  artifacts = [
    {
      id: 77,
      name: 'run-report-infradev.json',
      expired: false,
      archive_download_url:
        'https://api.github.com/repos/DEFRA/ai-platform-tenants/actions/artifacts/77/zip'
    }
  ]
) {
  return { total_count: artifacts.length, artifacts }
}

/**
 * Body of `GET .../commits/{ref}`.
 * @param {object} [overrides]
 */
export function commit(overrides = {}) {
  return { sha: 'merge-sha', parents: [{ sha: 'parent-sha' }], ...overrides }
}

/**
 * Body of `GET .../contents/{path}?ref=...` for a file.
 * @param {string} text
 */
export function fileContents(text) {
  return {
    type: 'file',
    encoding: 'base64',
    content: Buffer.from(text).toString('base64')
  }
}

/**
 * A tenants run report, as `buildRunReport` writes it, listing one
 * operation and the `alpha` team's resources.
 * @param {object} [overrides]
 */
export function runReport(overrides = {}) {
  return {
    schemaVersion: 1,
    repository: 'DEFRA/ai-platform-tenants',
    environment: 'infradev',
    state: 'tenants',
    release: 'v0.4.0',
    run: { id: 2002, attempt: 1, url: `${REPOSITORY_URL}/actions/runs/2002` },
    outcome: 'success',
    appliedSha: 'merge-sha',
    baseSha: 'parent-sha',
    operations: [
      {
        sha: 'merge-sha',
        operationIds: ['0123456789abcdef01234567'],
        traceparent: null
      }
    ],
    changes: { total: { create: 3, update: 0, delete: 0, replace: 0 } },
    failingTeams: [],
    unattributedFailure: false,
    failures: [],
    outputs: {
      teams: {
        sensitive: false,
        value: {
          alpha: {
            project: {
              id: '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-placeholder/providers/Microsoft.CognitiveServices/accounts/aif-placeholder/projects/aip-alpha'
            }
          }
        }
      }
    },
    generatedAt: '2026-10-13T10:10:00.000Z',
    ...overrides
  }
}

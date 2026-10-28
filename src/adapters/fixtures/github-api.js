// GitHub REST response shapes for the GitOps contract, one factory per
// endpoint. Each takes overrides; never share a returned object between
// tests. Shapes follow GitHub's REST reference for API version 2026-03-10
// (fields this backend reads only) and the run report from
// ai-platform-infra checks/src/run-report.js; none has yet been checked
// against a live response - do that in WS5 milestone M6 and note it here.

const REPOSITORY_URL = 'https://github.com/DEFRA/ai-platform-tenants'
// The workflow run the run reader looks up, and the apply run a run report
// belongs to.
const DISPATCHED_RUN_ID = 1001
const APPLY_RUN_ID = 2002

/**
 * Body of `GET .../actions/runs/{run_id}`.
 * @param {object} [overrides]
 */
export function workflowRun(overrides = {}) {
  return {
    id: DISPATCHED_RUN_ID,
    status: 'in_progress',
    conclusion: null,
    html_url: `${REPOSITORY_URL}/actions/runs/${DISPATCHED_RUN_ID}`,
    ...overrides
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
    run: {
      id: APPLY_RUN_ID,
      attempt: 1,
      url: `${REPOSITORY_URL}/actions/runs/${APPLY_RUN_ID}`
    },
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

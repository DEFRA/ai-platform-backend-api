/**
 * Port for provisioning team and platform desired state through GitOps
 * (design C, the contract in `ai-platform-infra/docs/gitops-contract.md`):
 * submit a whole document -> pull request -> checks -> merge -> Terraform
 * apply -> ARM verification. The backend never commits; a real adapter
 * dispatches the state repository's `submit` workflow and reads progress
 * back from GitHub and ARM. Statuses use the contract's operation states:
 * `requested`, `pr-raised`, `merged`, `deploying`, `deployed`, `verified`,
 * `active`, `checks-failed`, `deploy-failed`.
 *
 * @typedef {object} DeploymentRequest
 * @property {string} environment - registry entry name, e.g. `infradev`
 * @property {string} path - `environments/{env}/{slug}.json` or `environments/{env}/platform.json`
 * @property {object|null} document - the whole desired-state document for `write`; null otherwise
 * @property {string} operationId - also the branch `op/{operationId}`
 * @property {string} requestedBy - the principal the change is attributed to: `entra:{oid}` for a person, `app:{name}` for automation (`github:{user ID}` is set by the workflow only, never by the backend)
 * @property {number} expectedRevision - the team file revision last read, 0 for a new file
 * @property {'write'|'remove'|'abandon'} [action] - defaults to `write`
 * @property {string} [traceParent] - optional W3C `traceparent`
 *
 * @typedef {object} DeploymentLinks
 * @property {string} [submitRun] - the submit workflow run
 * @property {string} [pullRequest] - the `op/{operationId}` pull request
 * @property {string} [applyRun] - the apply workflow run behind the GitHub Deployment
 *
 * @typedef {object} DeploymentFailure
 * @property {string} observedAt - when the failed GitHub Deployment status was recorded
 * @property {string[]} failingTeams - team slugs the run report attributes the failure to (R3)
 * @property {boolean} unattributedFailure - the run report could not attribute the failure
 *
 * @typedef {object} DeploymentStatus
 * @property {string} operationId
 * @property {string} status
 * @property {string} [failureReason]
 * @property {DeploymentLinks} links
 * @property {string} [mergeSha] - squash commit of the merged pull request
 * @property {string} [appliedSha] - commit the successful apply ran at
 * @property {object} [resources] - the team's entry in the run report's `outputs.teams`
 * @property {number} [pullRequestNumber]
 * @property {string} [mergedAt]
 * @property {number} [applyRunId]
 * @property {string} [polledAt] - set when the adapter read GitHub or ARM on this call
 * @property {DeploymentFailure} [failure] - on `deploy-failed` when a run report says why; drives the D14 policy
 *
 * @typedef {object} TenantOrchestrator
 * @property {(request: DeploymentRequest) => Promise<{operationId: string, status: 'requested', submitRunId: number|null, submitRunUrl: string|null}>} requestDeployment
 * @property {(entry: object) => Promise<DeploymentStatus>} getDeploymentStatus - takes a persisted deployment entry plus its `environment`
 * @property {(params: {environment: string, reason: string}) => Promise<{runId: number|null, runUrl: string|null}>} requestApply - a fresh tenants apply on `main`, never a re-run
 * @property {(params: {path: string, mergeSha: string}) => Promise<{document: object|null}>} getPreviousDocument - the file before the merge, null when it did not exist
 */

export {}

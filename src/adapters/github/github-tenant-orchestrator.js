import { config } from '#/config.js'
import { statusCodes } from '#/common/constants/status-codes.js'
import { canonicalJson } from '#/common/helpers/canonical-json.js'
import { createGithubAppClient } from '#/adapters/github/github-app-client.js'
import { createConditionalReader } from '#/adapters/github/github-conditional-reader.js'
import { tenantResourceVerifier } from '#/adapters/tenant-resource-verifier-registry.js'

// A dispatch input holds at most 65,535 characters, so the GitOps contract
// keeps every machine-written file under 60 KB.
const MAX_DOCUMENT_BYTES = 60 * 1024
const PIN_PATH = /^environments\/[^/]+\/platform\.json$/
const STATE_FILE_PATH = /^environments\/([^/]+)\/([a-z0-9-]+)\.json$/
const RUN_URL = /^(https:\/\/\S+\/actions\/runs\/(\d+))/
const FAILED_CONCLUSIONS = new Set([
  'action_required',
  'cancelled',
  'failure',
  'stale',
  'startup_failure',
  'timed_out'
])
// The required check on every state repository pull request: one stable
// name, because a pull request changes exactly one environment.
const VALIDATE_CHECK = 'validate-desired-state / validate'
// GitHub marks an earlier successful Deployment `inactive` once a later one
// for the same environment succeeds, so `inactive` was a success too.
const SUCCEEDED_DEPLOYMENT_STATES = new Set(['success', 'inactive'])
const FAILED_DEPLOYMENT_STATES = new Set(['error', 'failure'])
const MAX_REMEMBERED = 500
const CHECKS_FAILED = 'checks-failed'

// Down-scoped per use (D6): a dispatch token can only start workflows in one
// repository; a status token can only read it.
const DISPATCH_PERMISSIONS = { actions: 'write' }
const STATUS_PERMISSIONS = {
  actions: 'read',
  checks: 'read',
  contents: 'read',
  deployments: 'read',
  pull_requests: 'read'
}

const FAILURE_REASONS = {
  submit:
    'The submit workflow rejected the change, so nothing was written to Git',
  validate: 'The validate check failed on the pull request',
  closed: 'The pull request was closed without being merged',
  apply: 'The apply workflow failed'
}

function codedError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

function remember(map, key, value) {
  map.set(key, value)

  if (map.size > MAX_REMEMBERED) {
    map.delete(map.keys().next().value)
  }
}

function parseRepo(fullName) {
  const [owner, repo] = fullName.split('/')
  return { owner, repo }
}

function slugOf(path) {
  return STATE_FILE_PATH.exec(path)?.[2] ?? null
}

function linksOf(gitops) {
  return Object.fromEntries(
    Object.entries({
      submitRun: gitops.submitRunUrl,
      pullRequest: gitops.pullRequestUrl,
      applyRun: gitops.applyRunUrl
    }).filter(([, url]) => url)
  )
}

// The apply job's Deployment status links to its run; that run uploaded
// the run report.
function runOf(deploymentStatus) {
  const match = RUN_URL.exec(
    deploymentStatus?.log_url || deploymentStatus?.target_url || ''
  )

  return match ? { url: match[1], id: Number(match[2]) } : null
}

// The run report is uploaded unzipped (`archive: false`), so the download is
// the JSON file itself, whatever content type the storage host labels it.
function parseReport(data) {
  if (typeof data === 'string') {
    return JSON.parse(data)
  }

  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    return JSON.parse(Buffer.from(data).toString('utf8'))
  }

  return data
}

function listsOperation(report, operationId) {
  return (report?.operations ?? []).some((operation) =>
    operation.operationIds?.includes(operationId)
  )
}

// The `submit.yml` inputs for a request the contract accepts: a state file
// of its environment, a whole document for a write, and under 60 KB once
// canonical.
function submitInputs({
  environment,
  path,
  document,
  operationId,
  requestedBy,
  expectedRevision,
  action = 'write',
  traceParent
}) {
  if (STATE_FILE_PATH.exec(path)?.[1] !== environment) {
    throw codedError(
      `${path} is not a state file of ${environment}`,
      'invalid-path'
    )
  }

  if (action === 'write' && !document) {
    throw codedError(
      'A write needs the whole desired-state document',
      'desired-state-unavailable'
    )
  }

  const text = action === 'write' ? canonicalJson(document) : ''

  if (Buffer.byteLength(text, 'utf8') >= MAX_DOCUMENT_BYTES) {
    throw codedError(
      'The desired-state document is 60 KB or more',
      'desired-state-too-large'
    )
  }

  return {
    action,
    environment,
    path,
    document: text,
    operation_id: operationId,
    expected_revision: String(expectedRevision ?? 0),
    requested_by: requestedBy,
    trace_parent: traceParent ?? ''
  }
}

async function dispatchWorkflow(client, repo, workflowId, inputs) {
  const { data } = await client.request(
    'POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches',
    { ...repo, workflow_id: workflowId, ref: 'main', inputs }
  )

  return {
    runId: data?.workflow_run_id ?? null,
    runUrl: data?.html_url ?? null
  }
}

// Every status read below takes `reads`: the conditional reader, a
// read-only client for the repository and that repository, plus the run
// report and ancestry caches shared across polls.

async function readPreviousDocument({ reader, client, repo }, path, mergeSha) {
  const commit = await reader.read(
    client,
    'GET /repos/{owner}/{repo}/commits/{ref}',
    { ...repo, ref: mergeSha }
  )
  const parentSha = commit.parents?.[0]?.sha

  if (!parentSha) {
    return { document: null }
  }

  try {
    const file = await reader.read(
      client,
      'GET /repos/{owner}/{repo}/contents/{+path}',
      { ...repo, path, ref: parentSha }
    )

    return {
      document: JSON.parse(
        Buffer.from(file.content, file.encoding).toString('utf8')
      )
    }
  } catch (error) {
    if (error.status === statusCodes.notFound) {
      return { document: null }
    }

    throw error
  }
}

async function submitRunState({ reader, client, repo }, gitops, links) {
  if (!gitops.submitRunId) {
    return { status: 'requested', links }
  }

  const run = await reader.read(
    client,
    'GET /repos/{owner}/{repo}/actions/runs/{run_id}',
    { ...repo, run_id: gitops.submitRunId }
  )
  const withRun = { ...links, submitRun: run.html_url ?? links.submitRun }

  if (run.status === 'completed' && FAILED_CONCLUSIONS.has(run.conclusion)) {
    return {
      status: CHECKS_FAILED,
      failureReason: FAILURE_REASONS.submit,
      links: withRun
    }
  }

  return { status: 'requested', links: withRun }
}

async function validateFailed({ reader, client, repo }, sha) {
  const { check_runs: checkRuns = [] } = await reader.read(
    client,
    'GET /repos/{owner}/{repo}/commits/{ref}/check-runs',
    { ...repo, ref: sha, check_name: VALIDATE_CHECK }
  )
  const latest = checkRuns.reduce(
    (newest, checkRun) =>
      !newest || checkRun.id > newest.id ? checkRun : newest,
    null
  )

  return (
    latest?.status === 'completed' && FAILED_CONCLUSIONS.has(latest.conclusion)
  )
}

// An open pull request is checks-failed once its validate check fails, and
// a closed unmerged one always is.
async function unmergedPullState(reads, pull, links) {
  const opened = { links, pullRequestNumber: pull.number }

  if (pull.state === 'closed') {
    return {
      ...opened,
      status: CHECKS_FAILED,
      failureReason: FAILURE_REASONS.closed
    }
  }

  return (await validateFailed(reads, pull.head.sha))
    ? {
        ...opened,
        status: CHECKS_FAILED,
        failureReason: FAILURE_REASONS.validate
      }
    : { ...opened, status: 'pr-raised' }
}

async function includesCommit(reads, mergeSha, sha) {
  if (sha === mergeSha) {
    return true
  }

  const { reader, client, repo, ancestry } = reads
  const key = `${repo.repo}:${mergeSha}...${sha}`

  if (!ancestry.has(key)) {
    const { status } = await reader.read(
      client,
      'GET /repos/{owner}/{repo}/compare/{basehead}',
      { ...repo, basehead: `${mergeSha}...${sha}`, per_page: 1 }
    )

    remember(ancestry, key, ['ahead', 'identical'].includes(status))
  }

  return ancestry.get(key)
}

async function runReport({ reader, client, repo, reports }, run, environment) {
  const key = `${repo.repo}:${run.id}`

  if (reports.has(key)) {
    return reports.get(key)
  }

  const name = `run-report-${environment}.json`
  const { artifacts = [] } = await reader.read(
    client,
    'GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts',
    { ...repo, run_id: run.id, name }
  )
  const artifact = artifacts.find(
    (candidate) => candidate.name === name && !candidate.expired
  )

  if (!artifact) {
    return null
  }

  const { data } = await client.request({
    method: 'GET',
    url: artifact.archive_download_url
  })
  const report = parseReport(data)

  remember(reports, key, report)

  return report
}

async function deploymentsAtOrAfter(reads, environment, merge) {
  const { reader, client, repo } = reads
  const deployments = await reader.read(
    client,
    'GET /repos/{owner}/{repo}/deployments',
    { ...repo, environment, per_page: 30 }
  )
  const observed = []

  // Newest first, as GitHub lists them. A Deployment created before the
  // merge cannot be at the merge commit or a descendant of it.
  for (const deployment of deployments) {
    if (Date.parse(deployment.created_at) < Date.parse(merge.mergedAt)) {
      continue
    }

    if (await includesCommit(reads, merge.mergeSha, deployment.sha)) {
      const [latest] = await reader.read(
        client,
        'GET /repos/{owner}/{repo}/deployments/{deployment_id}/statuses',
        { ...repo, deployment_id: deployment.id, per_page: 1 }
      )

      observed.push({ latest, run: runOf(latest) })
    }
  }

  return observed
}

// Deployed once any successful apply's run report lists the operation,
// even if a later apply (another team's change) has failed since. Null
// when none does.
async function deployedState(reads, entry, observed, links) {
  const { operationId, environment, gitops } = entry

  for (const { latest, run } of observed) {
    if (SUCCEEDED_DEPLOYMENT_STATES.has(latest?.state) && run) {
      const report = await runReport(reads, run, environment)

      if (listsOperation(report, operationId)) {
        return {
          status: 'deployed',
          links: { ...links, applyRun: run.url },
          applyRunId: run.id,
          appliedSha: report.appliedSha,
          resources: report.outputs?.teams?.value?.[slugOf(gitops.path)] ?? null
        }
      }
    }
  }

  return null
}

// Otherwise the newest Deployment decides: failed, with what its run report
// attributes, or still deploying.
async function newestDeploymentState(reads, environment, newest, links) {
  const { latest, run } = newest
  const withRun = run
    ? { applyRunId: run.id, links: { ...links, applyRun: run.url } }
    : { links }

  if (!FAILED_DEPLOYMENT_STATES.has(latest?.state)) {
    return { status: 'deploying', ...withRun }
  }

  const report = run ? await runReport(reads, run, environment) : null

  return {
    status: 'deploy-failed',
    failureReason: FAILURE_REASONS.apply,
    ...withRun,
    failure: {
      observedAt: latest.created_at,
      failingTeams: report?.failingTeams ?? [],
      unattributedFailure: report ? Boolean(report.unattributedFailure) : true
    }
  }
}

async function deploymentState(reads, entry, merge, links) {
  const observed = await deploymentsAtOrAfter(reads, entry.environment, merge)

  if (observed.length === 0) {
    return { status: 'merged', links }
  }

  return (
    (await deployedState(reads, entry, observed, links)) ??
    newestDeploymentState(reads, entry.environment, observed[0], links)
  )
}

async function observe(reads, entry) {
  const { operationId, gitops } = entry
  const { reader, client, repo } = reads
  const links = linksOf(gitops)
  let merge = {
    pullRequestNumber: gitops.pullRequestNumber,
    mergeSha: gitops.mergeSha,
    mergedAt: gitops.mergedAt
  }

  if (!merge.mergeSha) {
    const [pull] = await reader.read(
      client,
      'GET /repos/{owner}/{repo}/pulls',
      { ...repo, head: `${repo.owner}:op/${operationId}`, state: 'all' }
    )

    if (!pull) {
      return submitRunState(reads, gitops, links)
    }

    links.pullRequest = pull.html_url

    if (!pull.merged_at) {
      return unmergedPullState(reads, pull, links)
    }

    merge = {
      pullRequestNumber: pull.number,
      mergeSha: pull.merge_commit_sha,
      mergedAt: pull.merged_at
    }
  }

  return {
    ...merge,
    ...(await deploymentState(reads, entry, merge, links))
  }
}

async function verifyDeployed(verifier, { environment, gitops }) {
  // Only a team file write creates resources to confirm; a removal or a
  // platform pin has nothing team-specific to read back.
  if (gitops.action !== 'write' || PIN_PATH.test(gitops.path)) {
    return { status: 'verified' }
  }

  const { verified } = await verifier.verify({
    environment,
    resources: gitops.resources ?? null
  })

  return { status: verified ? 'verified' : 'deployed' }
}

// Builds each client lazily, once per repository and permission set.
function cachedClients(createClient) {
  const clients = new Map()

  return function clientFor({ repo }, permissions) {
    const key = `${repo}:${JSON.stringify(permissions)}`

    if (!clients.has(key)) {
      clients.set(key, createClient({ repositoryNames: [repo], permissions }))
    }

    return clients.get(key)
  }
}

/**
 * Creates the GitHub-backed `TenantOrchestrator` (WS5). It never commits:
 * `requestDeployment` dispatches the state repository's `submit.yml` on
 * `main` with the whole canonical document, and `getDeploymentStatus` reads
 * the GitOps contract's signals back - the submit run, the `op/{operationId}`
 * pull request and its `validate-desired-state / validate` check, the GitHub Deployment for
 * the environment at the merge commit or a descendant, the apply run's
 * `run-report-{env}.json`, then ARM through the `TenantResourceVerifier`.
 * Polls are conditional, at most one per operation per
 * `GITOPS_POLL_MIN_INTERVAL_MS`, and back off on rate limits (R11). All
 * clients are built lazily, so this is safe to construct with GitHub config
 * unset.
 * @param {object} [deps]
 * @param {typeof createGithubAppClient} [deps.createClient]
 * @param {string} [deps.tenantsRepo]
 * @param {string} [deps.deploymentsRepo]
 * @param {number} [deps.pollMinIntervalMs]
 * @param {import('#/adapters/tenant-resource-verifier.js').TenantResourceVerifier} [deps.verifier]
 * @param {ReturnType<typeof createConditionalReader>} [deps.reader]
 * @param {() => number} [deps.now]
 * @returns {import('#/adapters/tenant-orchestrator.js').TenantOrchestrator}
 */
export function createGithubTenantOrchestrator({
  createClient = createGithubAppClient,
  tenantsRepo = config.get('gitops.tenantsRepo'),
  deploymentsRepo = config.get('gitops.deploymentsRepo'),
  pollMinIntervalMs = config.get('gitops.pollMinIntervalMs'),
  verifier = tenantResourceVerifier,
  reader = createConditionalReader(),
  now = Date.now
} = {}) {
  const clientFor = cachedClients(createClient)
  const reports = new Map()
  const ancestry = new Map()

  function repoFor(path) {
    return parseRepo(PIN_PATH.test(path) ? deploymentsRepo : tenantsRepo)
  }

  function readsFor(path) {
    const repo = repoFor(path)
    const client = clientFor(repo, STATUS_PERMISSIONS)

    return { reader, client, repo, reports, ancestry }
  }

  function dispatch(repo, workflowId, inputs) {
    const client = clientFor(repo, DISPATCH_PERMISSIONS)

    return dispatchWorkflow(client, repo, workflowId, inputs)
  }

  async function requestDeployment(request) {
    const inputs = submitInputs(request)
    const { runId, runUrl } = await dispatch(
      repoFor(request.path),
      'submit.yml',
      inputs
    )

    return {
      operationId: request.operationId,
      status: 'requested',
      submitRunId: runId,
      submitRunUrl: runUrl
    }
  }

  async function requestApply({ environment, reason }) {
    return dispatch(parseRepo(tenantsRepo), 'apply.yml', {
      environment,
      reason
    })
  }

  async function getPreviousDocument({ path, mergeSha }) {
    return readPreviousDocument(readsFor(path), path, mergeSha)
  }

  async function getDeploymentStatus(entry) {
    const { operationId, status, gitops = {} } = entry
    const links = linksOf(gitops)

    // Activation is the backend's own step once ARM has confirmed the
    // resources, so it needs no further read.
    if (status === 'verified') {
      return { operationId, status: 'active', links }
    }

    if (now() - Date.parse(gitops.lastPolledAt) < pollMinIntervalMs) {
      return { operationId, status, links }
    }

    const polledAt = new Date(now()).toISOString()
    const observed =
      status === 'deployed'
        ? { links, ...(await verifyDeployed(verifier, entry)) }
        : await observe(readsFor(entry.gitops.path), entry)

    return { operationId, ...observed, polledAt }
  }

  return {
    requestDeployment,
    getDeploymentStatus,
    requestApply,
    getPreviousDocument
  }
}

import { statusCodes } from '#/common/constants/status-codes.js'
import { createGithubAppClient } from '#/adapters/github/github-app-client.js'
import { createConditionalReader } from '#/adapters/github/github-conditional-reader.js'

// Read-only, down-scoped to the one repository a read targets.
export const RUN_READ_PERMISSIONS = {
  actions: 'read',
  contents: 'read',
  metadata: 'read'
}

const MAIN = 'main'
// `base...head` with base the commit and head `main`: `ahead` means main has
// commits the commit lacks, so the commit is an ancestor of main.
const ON_MAIN_STATUSES = new Set(['ahead', 'identical'])

function parseRepo(fullName) {
  const [owner, repo] = fullName.split('/')
  return { owner, repo }
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

function toRun(run) {
  return {
    id: run.id,
    name: run.name,
    path: run.path,
    headBranch: run.head_branch,
    headSha: run.head_sha,
    status: run.status,
    conclusion: run.conclusion,
    event: run.event,
    runStartedAt: run.run_started_at,
    actor: run.actor?.login ?? null,
    triggeringActor: run.triggering_actor?.login ?? null,
    htmlUrl: run.html_url
  }
}

// Clients are built lazily, once per repository.
function createTargetResolver(createClient) {
  const clients = new Map()

  return function target(repository) {
    const { owner, repo } = parseRepo(repository)

    if (!clients.has(repository)) {
      clients.set(
        repository,
        createClient({
          repositoryNames: [repo],
          permissions: RUN_READ_PERMISSIONS
        })
      )
    }

    return { client: clients.get(repository), repo: { owner, repo } }
  }
}

// A missing resource reads as `fallback`; any other error propagates.
async function readOr({ target, reader }, fallback, repository, route, params) {
  const { client, repo } = target(repository)

  try {
    return await reader.read(client, route, { ...repo, ...params })
  } catch (error) {
    if (error.status === statusCodes.notFound) {
      return fallback
    }

    throw error
  }
}

async function readRunReport(access, { repository, runId, environment }) {
  const name = `run-report-${environment}.json`
  const { artifacts = [] } = await readOr(
    access,
    {},
    repository,
    'GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts',
    { run_id: runId, name }
  )
  const artifact = artifacts.find(
    (candidate) => candidate.name === name && !candidate.expired
  )

  if (!artifact) {
    return null
  }

  const { client } = access.target(repository)
  const { data } = await client.request({
    method: 'GET',
    url: artifact.archive_download_url
  })

  return parseReport(data)
}

/**
 * Creates the GitHub reader for workflow runs, their run reports, commit
 * ancestry and actor permissions. It only ever reads. Repositories are
 * passed per call as `owner/name`; clients are built lazily, once per
 * repository, so this is safe to construct with GitHub config unset.
 * @param {object} [deps]
 * @param {typeof createGithubAppClient} [deps.createClient]
 * @param {ReturnType<typeof createConditionalReader>} [deps.reader]
 */
export function createGithubRunReader({
  createClient = createGithubAppClient,
  reader = createConditionalReader()
} = {}) {
  const access = { target: createTargetResolver(createClient), reader }

  return {
    /**
     * A workflow run, or null when it does not exist.
     * @param {{repository: string, runId: number}} params
     */
    async getRun({ repository, runId }) {
      const run = await readOr(
        access,
        null,
        repository,
        'GET /repos/{owner}/{repo}/actions/runs/{run_id}',
        { run_id: runId }
      )

      return run && toRun(run)
    },

    /**
     * The parsed `run-report-{environment}.json` artifact of a run, or null
     * when the run has no unexpired one.
     * @param {{repository: string, runId: number, environment: string}} params
     */
    async getRunReport(params) {
      return readRunReport(access, params)
    },

    /**
     * Whether a commit is on `main`: an ancestor of it, or its tip.
     * @param {{repository: string, sha: string}} params
     * @returns {Promise<boolean>}
     */
    async isOnMain({ repository, sha }) {
      const { status } = await readOr(
        access,
        {},
        repository,
        'GET /repos/{owner}/{repo}/compare/{basehead}',
        { basehead: `${sha}...${MAIN}`, per_page: 1 }
      )

      return ON_MAIN_STATUSES.has(status)
    },

    /**
     * A user's permission on a repository (`admin`, `write`, `read`,
     * `none`, ...), or null when GitHub does not know the user there.
     * @param {{repository: string, username: string}} params
     * @returns {Promise<string|null>}
     */
    async getActorPermission({ repository, username }) {
      const collaborator = await readOr(
        access,
        null,
        repository,
        'GET /repos/{owner}/{repo}/collaborators/{username}/permission',
        { username }
      )

      return collaborator?.permission ?? null
    }
  }
}

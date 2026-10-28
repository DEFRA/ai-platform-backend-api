import { statusCodes } from '#/common/constants/status-codes.js'
import { createGithubAppClient } from '#/adapters/github/github-app-client.js'
import { createConditionalReader } from '#/adapters/github/github-conditional-reader.js'

// Read-only, down-scoped to the one repository a read targets.
export const READ_PERMISSIONS = { contents: 'read', metadata: 'read' }

const PIN_PATH = /^environments\/[^/]+\/platform\.json$/
const MAIN = 'main'

function parseRepo(fullName) {
  const [owner, repo] = fullName.split('/')
  return { owner, repo }
}

/**
 * Creates the GitHub-backed `TeamFileReader`: it only ever reads. The pin
 * file `environments/{env}/platform.json` lives in the deployments
 * repository and every other state file in the tenants repository. Clients
 * are built lazily, once per repository, so this is safe to construct with
 * GitHub config unset.
 * @param {object} deps
 * @param {typeof createGithubAppClient} [deps.createClient]
 * @param {string} deps.tenantsRepo - `owner/name`
 * @param {string} deps.deploymentsRepo - `owner/name`
 * @param {ReturnType<typeof createConditionalReader>} [deps.reader]
 * @returns {import('#/adapters/team-file-reader.js').TeamFileReader}
 */
export function createGithubTeamFileReader({
  createClient = createGithubAppClient,
  tenantsRepo,
  deploymentsRepo,
  reader = createConditionalReader()
}) {
  const clients = new Map()

  function target(path) {
    const fullName = PIN_PATH.test(path) ? deploymentsRepo : tenantsRepo

    if (!clients.has(fullName)) {
      const { repo } = parseRepo(fullName)

      clients.set(
        fullName,
        createClient({ repositoryNames: [repo], permissions: READ_PERMISSIONS })
      )
    }

    return { client: clients.get(fullName), repo: parseRepo(fullName) }
  }

  async function readFile(path, ref) {
    const { client, repo } = target(path)

    try {
      const file = await reader.read(
        client,
        'GET /repos/{owner}/{repo}/contents/{+path}',
        { ...repo, path, ref }
      )

      return {
        document: JSON.parse(
          Buffer.from(file.content, file.encoding).toString('utf8')
        ),
        sha: file.sha
      }
    } catch (error) {
      if (error.status === statusCodes.notFound) {
        return { document: null, sha: null }
      }

      throw error
    }
  }

  return {
    async getCurrentDocument({ path }) {
      return readFile(path, MAIN)
    },

    async getPreviousDocument({ path, commitSha }) {
      const { client, repo } = target(path)
      const commit = await reader.read(
        client,
        'GET /repos/{owner}/{repo}/commits/{ref}',
        { ...repo, ref: commitSha }
      )
      const parentSha = commit.parents?.[0]?.sha

      if (!parentSha) {
        return { document: null }
      }

      const { document } = await readFile(path, parentSha)

      return { document }
    }
  }
}

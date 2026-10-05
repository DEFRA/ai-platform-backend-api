import { Octokit } from 'octokit'
import { createAppAuth } from '@octokit/auth-app'

import { config } from '#/config.js'

function createOctokit() {
  // Client ID is GitHub's current recommendation over the numeric App ID -
  // @octokit/auth-app's `appId` field accepts either value interchangeably.
  const appId = config.get('github.clientId') || config.get('github.appId')
  const privateKey = config.get('github.privateKey')

  // This adapter already has its own resilience strategy (fall back to the
  // last good mirror on any failure) - octokit's bundled retry plugin would
  // only add latency on top of that, so it's disabled here.
  if (appId && privateKey) {
    return new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId,
        privateKey,
        installationId: config.get('github.installationId')
      },
      request: { retries: 0 }
    })
  }

  return new Octokit({
    auth: config.get('github.token'),
    request: { retries: 0 }
  })
}

function isCatalogueJson(entry) {
  return (
    entry.type === 'blob' &&
    entry.path.startsWith('catalogue/') &&
    entry.path.endsWith('.json') &&
    !entry.path.startsWith('catalogue/schema/')
  )
}

/**
 * Reads `catalogue/**.json` from `ai-platform-infra` at a pinned release tag,
 * through Octokit. Conditional on the tag ref's ETag: if the ref hasn't
 * moved since the last fetch, a 304 is returned and this adapter skips
 * re-fetching the tree and every blob. On a 304, or on ANY failure (a
 * transient GitHub outage), it returns the last good mirror rather than
 * throwing - the catalogue must never go empty because GitHub was briefly
 * unreachable. Only the very first fetch, with no mirror yet, can throw.
 * @param {{octokit?: Octokit, repo?: string}} [deps]
 * @returns {import('../catalogue-source.js').CatalogueSource}
 */
export function createGithubCatalogueSource({
  octokit = createOctokit(),
  repo = config.get('catalogue.repo')
} = {}) {
  const [owner, name] = repo.split('/')
  let lastGood = null
  let lastEtag = null

  async function fetchCatalogue({ ref = config.get('catalogue.ref') } = {}) {
    try {
      const refResponse = await octokit.request(
        'GET /repos/{owner}/{repo}/git/ref/{ref}',
        {
          owner,
          repo: name,
          ref: `tags/${ref}`,
          headers: lastEtag ? { 'if-none-match': lastEtag } : undefined
        }
      )

      lastEtag = refResponse.headers.etag ?? lastEtag

      const { data: tree } = await octokit.rest.git.getTree({
        owner,
        repo: name,
        tree_sha: refResponse.data.object.sha,
        recursive: 'true'
      })

      const records = await Promise.all(
        tree.tree.filter(isCatalogueJson).map(async (entry) => {
          const { data: blob } = await octokit.rest.git.getBlob({
            owner,
            repo: name,
            file_sha: entry.sha
          })

          return {
            path: entry.path,
            record: JSON.parse(
              Buffer.from(blob.content, blob.encoding).toString('utf8')
            )
          }
        })
      )

      lastGood = {
        models: records
          .filter((entry) => entry.path.startsWith('catalogue/models/'))
          .map((entry) => entry.record),
        providers: records
          .filter((entry) => entry.path.startsWith('catalogue/providers/'))
          .map((entry) => entry.record),
        catalogueSha: tree.sha,
        release: ref
      }

      return lastGood
    } catch (error) {
      // A 304 means the ref's ETag matched (the tag hasn't moved); any other
      // failure is a transient GitHub problem. Either way, the last good
      // mirror is preferable to an empty catalogue.
      if (lastGood) {
        return lastGood
      }

      throw error
    }
  }

  return { fetchCatalogue }
}

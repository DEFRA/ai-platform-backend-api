import { config } from '#/config.js'
import { createGithubAppClient } from '#/adapters/github/github-app-client.js'

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
 * Its App token can read contents of the catalogue repository only.
 * @param {{octokit?: import('octokit').Octokit, repo?: string}} [deps]
 * @returns {import('../catalogue-source.js').CatalogueSource}
 */
export function createGithubCatalogueSource({
  repo = config.get('catalogue.repo'),
  octokit = createGithubAppClient({
    repositoryNames: [repo.split('/')[1]],
    permissions: { contents: 'read' }
  })
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

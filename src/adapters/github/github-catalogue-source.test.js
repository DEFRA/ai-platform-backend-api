import nock from 'nock'

// The repo's global test setup (.vite/setup-files.js) replaces global.fetch
// with vitest-fetch-mock for every file - undo that here so nock, which
// intercepts at the undici level, actually sees Octokit's requests.
const realFetch = globalThis.fetch

beforeAll(() => {
  globalThis.fetch = realFetch
})

const { createGithubCatalogueSource } =
  await import('#/adapters/github/github-catalogue-source.js')
const { Octokit } = await import('octokit')

const GITHUB_API = 'https://api.github.com'
const REPO = 'DEFRA/ai-platform-infra'

function createSource() {
  return createGithubCatalogueSource({
    octokit: new Octokit({ auth: 'fake-token', request: { retries: 0 } }),
    repo: REPO
  })
}

function mockSuccessfulFetch({ ref = 'v0.1.0', etag = 'etag-1' } = {}) {
  nock(GITHUB_API)
    .get(`/repos/${REPO}/git/ref/tags%2F${ref}`)
    .reply(200, { object: { sha: 'commit-sha-1' } }, { etag })

  nock(GITHUB_API)
    .get(`/repos/${REPO}/git/trees/commit-sha-1`)
    .query({ recursive: 'true' })
    .reply(200, {
      sha: 'tree-sha-1',
      tree: [
        {
          type: 'blob',
          path: 'catalogue/models/gpt-4o.json',
          sha: 'blob-model'
        },
        {
          type: 'blob',
          path: 'catalogue/providers/openai.json',
          sha: 'blob-provider'
        },
        {
          type: 'blob',
          path: 'catalogue/schema/model.schema.json',
          sha: 'blob-schema'
        }
      ]
    })

  nock(GITHUB_API)
    .get('/repos/DEFRA/ai-platform-infra/git/blobs/blob-model')
    .reply(200, {
      content: Buffer.from(JSON.stringify({ slug: 'gpt-4o' })).toString(
        'base64'
      ),
      encoding: 'base64'
    })

  nock(GITHUB_API)
    .get('/repos/DEFRA/ai-platform-infra/git/blobs/blob-provider')
    .reply(200, {
      content: Buffer.from(JSON.stringify({ id: 'openai' })).toString('base64'),
      encoding: 'base64'
    })
}

describe('#createGithubCatalogueSource', () => {
  afterEach(() => {
    nock.cleanAll()
  })

  test('fetches models and providers from catalogue/**.json, excluding catalogue/schema', async () => {
    mockSuccessfulFetch()

    const result = await createSource().fetchCatalogue({ ref: 'v0.1.0' })

    expect(result).toEqual({
      models: [{ slug: 'gpt-4o' }],
      providers: [{ id: 'openai' }],
      catalogueSha: 'tree-sha-1',
      release: 'v0.1.0'
    })
  })

  test('falls back to the last good mirror when a later fetch fails', async () => {
    const source = createSource()

    mockSuccessfulFetch()
    const first = await source.fetchCatalogue({ ref: 'v0.1.0' })

    nock(GITHUB_API)
      .get('/repos/DEFRA/ai-platform-infra/git/ref/tags%2Fv0.1.0')
      .reply(500, { message: 'outage' })

    const second = await source.fetchCatalogue({ ref: 'v0.1.0' })

    expect(second).toEqual(first)
  })

  test('throws on the first-ever fetch failure, with no mirror to fall back to', async () => {
    const source = createSource()

    nock(GITHUB_API)
      .get('/repos/DEFRA/ai-platform-infra/git/ref/tags%2Fv0.1.0')
      .reply(404, { message: 'not found' })

    await expect(source.fetchCatalogue({ ref: 'v0.1.0' })).rejects.toThrow()
  })
})

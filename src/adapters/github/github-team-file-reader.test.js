import nock from 'nock'

// The repo's global test setup (.vite/setup-files.js) replaces global.fetch
// with vitest-fetch-mock for every file - undo that here so nock, which
// intercepts at the undici level, actually sees Octokit's requests.
const realFetch = globalThis.fetch

beforeAll(() => {
  globalThis.fetch = realFetch
})

const { createGithubTeamFileReader, READ_PERMISSIONS } =
  await import('#/adapters/github/github-team-file-reader.js')
const { createGithubAppClient } =
  await import('#/adapters/github/github-app-client.js')
const { describeTeamFileReaderContract } =
  await import('#/adapters/team-file-reader-contract.js')
const github = await import('#/adapters/fixtures/github-api.js')

const GITHUB_API = 'https://api.github.com'
const TENANTS = '/repos/DEFRA/ai-platform-tenants'
const DEPLOYMENTS = '/repos/DEFRA/ai-platform-deployments'
const TEAM_PATH = 'environments/infradev/alpha.json'
const PIN_PATH = 'environments/infradev/platform.json'
const BLOB_SHA = '5d7b1c1f0e6a4c3b2a190817263544332211ffee'
const COMMIT_SHA = 'merge-sha'
const PARENT_SHA = 'parent-sha'
const NOT_FOUND = { message: 'Not Found' }

function createReader(overrides = {}) {
  return createGithubTeamFileReader({
    tenantsRepo: 'DEFRA/ai-platform-tenants',
    deploymentsRepo: 'DEFRA/ai-platform-deployments',
    ...overrides
  })
}

function file(document) {
  return {
    ...github.fileContents(JSON.stringify(document)),
    sha: BLOB_SHA
  }
}

function replyWithFile(repository, path, query, document) {
  return nock(GITHUB_API)
    .get(`${repository}/contents/${path}`)
    .query(query)
    .reply(200, file(document))
}

function replyNotFound(repository, path, query) {
  return nock(GITHUB_API)
    .get(`${repository}/contents/${path}`)
    .query(query)
    .reply(404, NOT_FOUND)
}

function replyWithCommit(repository, commit) {
  return nock(GITHUB_API)
    .get(`${repository}/commits/${COMMIT_SHA}`)
    .reply(200, commit)
}

// Every request that is not a GET fails the test; GETs are recorded.
function trapWrites() {
  const writes = []

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
    nock(GITHUB_API)
      .persist()
      .intercept(/.*/, method)
      .reply(function () {
        writes.push(`${this.req.method} ${this.req.path}`)
        return [500, { message: 'a reader must not write' }]
      })
  }

  return writes
}

afterEach(() => {
  nock.cleanAll()
})

describeTeamFileReaderContract('github (nocked GitHub)', () => createReader(), {
  arrange() {
    nock(GITHUB_API)
      .persist()
      .get(/\/contents\//)
      .query(true)
      .reply(404, NOT_FOUND)
    nock(GITHUB_API)
      .persist()
      .get(/\/commits\/contract-commit-sha$/)
      .reply(200, github.commit({ parents: [{ sha: PARENT_SHA }] }))
  }
})

describe('#createGithubTeamFileReader', () => {
  describe('getCurrentDocument', () => {
    test('parses the team file on main from the tenants repository and returns its blob sha', async () => {
      const document = { environment: 'infradev', revision: 4 }
      const scope = replyWithFile(TENANTS, TEAM_PATH, { ref: 'main' }, document)

      const current = await createReader().getCurrentDocument({
        path: TEAM_PATH
      })

      expect(current).toEqual({ document, sha: BLOB_SHA })
      expect(scope.isDone()).toBe(true)
    })

    test('reads the pin file from the deployments repository', async () => {
      const document = { environment: 'infradev', pins: {} }
      const scope = replyWithFile(
        DEPLOYMENTS,
        PIN_PATH,
        { ref: 'main' },
        document
      )

      const current = await createReader().getCurrentDocument({
        path: PIN_PATH
      })

      expect(current).toEqual({ document, sha: BLOB_SHA })
      expect(scope.isDone()).toBe(true)
    })

    test('returns a null document and sha for a file that does not exist', async () => {
      replyNotFound(TENANTS, TEAM_PATH, { ref: 'main' })

      await expect(
        createReader().getCurrentDocument({ path: TEAM_PATH })
      ).resolves.toEqual({ document: null, sha: null })
    })

    test('propagates a server error', async () => {
      nock(GITHUB_API)
        .get(`${TENANTS}/contents/${TEAM_PATH}`)
        .query({ ref: 'main' })
        .reply(503, { message: 'Service Unavailable' })

      await expect(
        createReader().getCurrentDocument({ path: TEAM_PATH })
      ).rejects.toMatchObject({ status: 503 })
    })
  })

  describe('getPreviousDocument', () => {
    test('reads the file at the first parent of the commit', async () => {
      const document = { environment: 'infradev', revision: 3 }
      const commit = replyWithCommit(
        TENANTS,
        github.commit({ parents: [{ sha: PARENT_SHA }, { sha: 'other' }] })
      )
      const fileScope = replyWithFile(
        TENANTS,
        TEAM_PATH,
        { ref: PARENT_SHA },
        document
      )

      const previous = await createReader().getPreviousDocument({
        path: TEAM_PATH,
        commitSha: COMMIT_SHA
      })

      expect(previous).toEqual({ document })
      expect(commit.isDone()).toBe(true)
      expect(fileScope.isDone()).toBe(true)
    })

    test('returns a null document when the file did not exist at the parent', async () => {
      replyWithCommit(TENANTS, github.commit())
      replyNotFound(TENANTS, TEAM_PATH, { ref: PARENT_SHA })

      await expect(
        createReader().getPreviousDocument({
          path: TEAM_PATH,
          commitSha: COMMIT_SHA
        })
      ).resolves.toEqual({ document: null })
    })

    test('returns a null document when the commit has no parent', async () => {
      replyWithCommit(TENANTS, github.commit({ parents: [] }))

      await expect(
        createReader().getPreviousDocument({
          path: TEAM_PATH,
          commitSha: COMMIT_SHA
        })
      ).resolves.toEqual({ document: null })
    })

    test('propagates a server error from the commit lookup', async () => {
      nock(GITHUB_API)
        .get(`${TENANTS}/commits/${COMMIT_SHA}`)
        .reply(500, { message: 'Server Error' })

      await expect(
        createReader().getPreviousDocument({
          path: TEAM_PATH,
          commitSha: COMMIT_SHA
        })
      ).rejects.toMatchObject({ status: 500 })
    })
  })

  describe('clients', () => {
    test('builds one read-only client per repository, lazily', async () => {
      const createClient = vi.fn(createGithubAppClient)
      const reader = createReader({ createClient })

      expect(createClient).not.toHaveBeenCalled()

      replyNotFound(TENANTS, TEAM_PATH, { ref: 'main' })
      replyNotFound(TENANTS, 'environments/infradev/beta.json', {
        ref: 'main'
      })
      replyNotFound(DEPLOYMENTS, PIN_PATH, { ref: 'main' })

      await reader.getCurrentDocument({ path: TEAM_PATH })
      await reader.getCurrentDocument({
        path: 'environments/infradev/beta.json'
      })
      await reader.getCurrentDocument({ path: PIN_PATH })

      expect(READ_PERMISSIONS).toEqual({ contents: 'read', metadata: 'read' })
      expect(createClient.mock.calls).toEqual([
        [
          {
            repositoryNames: ['ai-platform-tenants'],
            permissions: READ_PERMISSIONS
          }
        ],
        [
          {
            repositoryNames: ['ai-platform-deployments'],
            permissions: READ_PERMISSIONS
          }
        ]
      ])
    })
  })

  test('only ever sends GET requests', async () => {
    const writes = trapWrites()
    const methods = []
    const reads = nock(GITHUB_API).persist()

    reads.on('request', (request) => methods.push(request.method))
    reads
      .get(/.*/)
      .query(true)
      .reply((uri) =>
        uri.includes('/commits/')
          ? [200, github.commit()]
          : [200, file({ revision: 1 })]
      )

    const reader = createReader()

    await reader.getCurrentDocument({ path: TEAM_PATH })
    await reader.getCurrentDocument({ path: PIN_PATH })
    await reader.getPreviousDocument({
      path: TEAM_PATH,
      commitSha: COMMIT_SHA
    })

    expect(methods).toHaveLength(4)
    expect(new Set(methods)).toEqual(new Set(['GET']))
    expect(writes).toEqual([])
  })
})

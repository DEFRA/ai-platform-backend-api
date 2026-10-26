import nock from 'nock'

// The repo's global test setup (.vite/setup-files.js) replaces global.fetch
// with vitest-fetch-mock for every file - undo that here so nock, which
// intercepts at the undici level, actually sees Octokit's requests.
const realFetch = globalThis.fetch

beforeAll(() => {
  globalThis.fetch = realFetch
})

const { createGithubRunReader, RUN_READ_PERMISSIONS } =
  await import('#/adapters/github/github-run-reader.js')
const { createGithubAppClient } =
  await import('#/adapters/github/github-app-client.js')
const github = await import('#/adapters/fixtures/github-api.js')

const GITHUB_API = 'https://api.github.com'
const ARTIFACT_HOST = 'https://artifacts.example.test'
const REPOSITORY = 'DEFRA/ai-platform-tenants'
const TENANTS = '/repos/DEFRA/ai-platform-tenants'
const RUN_ID = 1001
const SHA = 'abc123'
const NOT_FOUND = { message: 'Not Found' }

function apiRun(overrides = {}) {
  return github.workflowRun({
    name: 'submit',
    path: '.github/workflows/submit.yml',
    head_branch: 'main',
    head_sha: SHA,
    event: 'workflow_dispatch',
    run_started_at: '2026-10-26T12:00:00Z',
    actor: { login: 'octocat' },
    triggering_actor: { login: 'hubot' },
    ...overrides
  })
}

function replyWithArtifacts(artifacts) {
  return nock(GITHUB_API)
    .get(`${TENANTS}/actions/runs/${RUN_ID}/artifacts`)
    .query({ name: 'run-report-infradev.json' })
    .reply(200, artifacts)
}

function replyWithDownload(body, headers = {}) {
  nock(GITHUB_API)
    .get(`${TENANTS}/actions/artifacts/77/zip`)
    .reply(302, '', { location: `${ARTIFACT_HOST}/run-report-infradev.json` })

  return nock(ARTIFACT_HOST)
    .get('/run-report-infradev.json')
    .reply(200, body, headers)
}

function createReader(overrides = {}) {
  return createGithubRunReader(overrides)
}

afterEach(() => {
  nock.cleanAll()
})

describe('#createGithubRunReader', () => {
  describe('getRun', () => {
    test('maps the run, naming actor and triggering actor by login', async () => {
      nock(GITHUB_API)
        .get(`${TENANTS}/actions/runs/${RUN_ID}`)
        .reply(200, apiRun({ status: 'completed', conclusion: 'success' }))

      await expect(
        createReader().getRun({ repository: REPOSITORY, runId: RUN_ID })
      ).resolves.toEqual({
        id: RUN_ID,
        name: 'submit',
        path: '.github/workflows/submit.yml',
        headBranch: 'main',
        headSha: SHA,
        status: 'completed',
        conclusion: 'success',
        event: 'workflow_dispatch',
        runStartedAt: '2026-10-26T12:00:00Z',
        actor: 'octocat',
        triggeringActor: 'hubot',
        htmlUrl: `https://github.com/DEFRA/ai-platform-tenants/actions/runs/${RUN_ID}`
      })
    })

    test('names no actor when the run has none', async () => {
      nock(GITHUB_API)
        .get(`${TENANTS}/actions/runs/${RUN_ID}`)
        .reply(200, apiRun({ actor: null, triggering_actor: undefined }))

      const run = await createReader().getRun({
        repository: REPOSITORY,
        runId: RUN_ID
      })

      expect(run).toMatchObject({ actor: null, triggeringActor: null })
    })

    test('returns null for a run that does not exist', async () => {
      nock(GITHUB_API)
        .get(`${TENANTS}/actions/runs/${RUN_ID}`)
        .reply(404, NOT_FOUND)

      await expect(
        createReader().getRun({ repository: REPOSITORY, runId: RUN_ID })
      ).resolves.toBeNull()
    })

    test('propagates a server error', async () => {
      nock(GITHUB_API)
        .get(`${TENANTS}/actions/runs/${RUN_ID}`)
        .reply(502, { message: 'Bad Gateway' })

      await expect(
        createReader().getRun({ repository: REPOSITORY, runId: RUN_ID })
      ).rejects.toMatchObject({ status: 502 })
    })
  })

  describe('getRunReport', () => {
    const report = github.runReport()
    const params = {
      repository: REPOSITORY,
      runId: RUN_ID,
      environment: 'infradev'
    }

    test.each([
      [
        'a binary download',
        Buffer.from(JSON.stringify(report)),
        'application/octet-stream'
      ],
      ['a text download', JSON.stringify(report), 'text/plain']
    ])('parses the artifact from %s', async (_label, body, contentType) => {
      replyWithArtifacts(github.artifactList())
      replyWithDownload(body, { 'content-type': contentType })

      await expect(createReader().getRunReport(params)).resolves.toEqual(report)
    })

    test('uses an already parsed JSON body as it is', async () => {
      replyWithArtifacts(github.artifactList())
      replyWithDownload(report, { 'content-type': 'application/json' })

      await expect(createReader().getRunReport(params)).resolves.toEqual(report)
    })

    test('returns null when the run has no run report artifact', async () => {
      replyWithArtifacts(github.artifactList([]))

      await expect(createReader().getRunReport(params)).resolves.toBeNull()
    })

    test('ignores an expired artifact and one with another name', async () => {
      const [artifact] = github.artifactList().artifacts

      replyWithArtifacts(
        github.artifactList([
          { ...artifact, expired: true },
          { ...artifact, id: 78, name: 'run-report-sandbox.json' }
        ])
      )

      await expect(createReader().getRunReport(params)).resolves.toBeNull()
    })

    test('returns null when the artifact listing is empty of a list', async () => {
      replyWithArtifacts({})

      await expect(createReader().getRunReport(params)).resolves.toBeNull()
    })

    test('returns null when the run does not exist', async () => {
      nock(GITHUB_API)
        .get(`${TENANTS}/actions/runs/${RUN_ID}/artifacts`)
        .query(true)
        .reply(404, NOT_FOUND)

      await expect(createReader().getRunReport(params)).resolves.toBeNull()
    })

    test('propagates a failed download', async () => {
      replyWithArtifacts(github.artifactList())
      nock(GITHUB_API)
        .get(`${TENANTS}/actions/artifacts/77/zip`)
        .reply(500, { message: 'Server Error' })

      await expect(createReader().getRunReport(params)).rejects.toMatchObject({
        status: 500
      })
    })
  })

  describe('isOnMain', () => {
    test.each([
      ['ahead', true],
      ['identical', true],
      ['behind', false],
      ['diverged', false]
    ])('compares the commit to main: %s is %s', async (status, expected) => {
      const scope = nock(GITHUB_API)
        .get(`${TENANTS}/compare/${SHA}...main`)
        .query({ per_page: 1 })
        .reply(200, github.comparison(status))

      await expect(
        createReader().isOnMain({ repository: REPOSITORY, sha: SHA })
      ).resolves.toBe(expected)
      expect(scope.isDone()).toBe(true)
    })

    test('is false for a commit GitHub does not know', async () => {
      nock(GITHUB_API)
        .get(`${TENANTS}/compare/${SHA}...main`)
        .query(true)
        .reply(404, NOT_FOUND)

      await expect(
        createReader().isOnMain({ repository: REPOSITORY, sha: SHA })
      ).resolves.toBe(false)
    })
  })

  describe('getActorPermission', () => {
    test.each(['admin', 'write', 'read', 'none'])(
      'returns the %s permission',
      async (permission) => {
        nock(GITHUB_API)
          .get(`${TENANTS}/collaborators/octocat/permission`)
          .reply(200, { permission, user: { login: 'octocat' } })

        await expect(
          createReader().getActorPermission({
            repository: REPOSITORY,
            username: 'octocat'
          })
        ).resolves.toBe(permission)
      }
    )

    test('returns null for a user GitHub does not know', async () => {
      nock(GITHUB_API)
        .get(`${TENANTS}/collaborators/ghost/permission`)
        .reply(404, NOT_FOUND)

      await expect(
        createReader().getActorPermission({
          repository: REPOSITORY,
          username: 'ghost'
        })
      ).resolves.toBeNull()
    })

    test('returns null when the response names no permission', async () => {
      nock(GITHUB_API)
        .get(`${TENANTS}/collaborators/octocat/permission`)
        .reply(200, {})

      await expect(
        createReader().getActorPermission({
          repository: REPOSITORY,
          username: 'octocat'
        })
      ).resolves.toBeNull()
    })
  })

  describe('clients', () => {
    test('builds one read-only client per repository, lazily', async () => {
      const createClient = vi.fn(createGithubAppClient)
      const reader = createReader({ createClient })

      expect(createClient).not.toHaveBeenCalled()

      nock(GITHUB_API)
        .persist()
        .get(/\/actions\/runs\/\d+$/)
        .reply(200, apiRun())

      await reader.getRun({ repository: REPOSITORY, runId: RUN_ID })
      await reader.getRun({ repository: REPOSITORY, runId: 1002 })
      await reader.getRun({
        repository: 'DEFRA/ai-platform-deployments',
        runId: RUN_ID
      })

      expect(RUN_READ_PERMISSIONS).toEqual({
        actions: 'read',
        contents: 'read',
        metadata: 'read'
      })
      expect(createClient.mock.calls).toEqual([
        [
          {
            repositoryNames: ['ai-platform-tenants'],
            permissions: RUN_READ_PERMISSIONS
          }
        ],
        [
          {
            repositoryNames: ['ai-platform-deployments'],
            permissions: RUN_READ_PERMISSIONS
          }
        ]
      ])
    })
  })

  test('only ever sends GET requests', async () => {
    const writes = []
    const methods = []
    const reads = nock(GITHUB_API).persist()

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
      nock(GITHUB_API)
        .persist()
        .intercept(/.*/, method)
        .reply(function () {
          writes.push(`${this.req.method} ${this.req.path}`)
          return [500, { message: 'a reader must not write' }]
        })
    }

    reads.on('request', (request) => methods.push(request.method))
    reads.get(/\/actions\/runs\/\d+$/).reply(200, apiRun())
    reads
      .get(/\/artifacts$/)
      .query(true)
      .reply(200, github.artifactList())
    reads
      .get(/\/artifacts\/77\/zip$/)
      .reply(200, JSON.stringify(github.runReport()))
    reads
      .get(/\/compare\//)
      .query(true)
      .reply(200, github.comparison('ahead'))
    reads.get(/\/permission$/).reply(200, { permission: 'write' })

    const reader = createReader()

    await reader.getRun({ repository: REPOSITORY, runId: RUN_ID })
    await reader.getRunReport({
      repository: REPOSITORY,
      runId: RUN_ID,
      environment: 'infradev'
    })
    await reader.isOnMain({ repository: REPOSITORY, sha: SHA })
    await reader.getActorPermission({
      repository: REPOSITORY,
      username: 'octocat'
    })

    expect(methods).toHaveLength(5)
    expect(new Set(methods)).toEqual(new Set(['GET']))
    expect(writes).toEqual([])
  })
})

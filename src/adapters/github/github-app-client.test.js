import { generateKeyPairSync } from 'node:crypto'

import nock from 'nock'

// The repo's global test setup (.vite/setup-files.js) replaces global.fetch
// with vitest-fetch-mock for every file - undo that here so nock, which
// intercepts at the undici level, actually sees Octokit's requests.
const realFetch = globalThis.fetch

beforeAll(() => {
  globalThis.fetch = realFetch
})

const GITHUB_API = 'https://api.github.com'

// A throwaway key generated per run, so the real JWT signing path runs
// without any key material in the repository.
function generateBase64PrivateKey() {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  })

  return Buffer.from(privateKey).toString('base64')
}

async function loadClientModule(env) {
  vi.resetModules()

  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value)
  }

  return import('#/adapters/github/github-app-client.js')
}

const appEnv = {
  GITHUB_CLIENT_ID: 'Iv1.placeholder',
  GITHUB_APP_INSTALLATION_ID: '123',
  GITHUB_APP_PRIVATE_KEY: generateBase64PrivateKey(),
  GITHUB_TOKEN: ''
}

const READ_SCOPE = {
  repositoryNames: ['ai-platform-infra'],
  permissions: { contents: 'read' }
}

describe('#createGithubAppClient', () => {
  afterEach(() => {
    nock.cleanAll()
    vi.unstubAllEnvs()
  })

  describe('with GitHub App credentials', () => {
    test('mints an installation token down-scoped to the given repositories and permissions', async () => {
      const { createGithubAppClient } = await loadClientModule(appEnv)
      let tokenRequestBody
      let sentAuthorization

      nock(GITHUB_API)
        .post('/app/installations/123/access_tokens', (body) => {
          tokenRequestBody = body
          return true
        })
        .reply(201, {
          token: 'ghs_scoped',
          expires_at: new Date(Date.now() + 3600000).toISOString()
        })
      nock(GITHUB_API)
        .get('/repos/DEFRA/ai-platform-tenants')
        .reply(function () {
          sentAuthorization = this.req.headers.authorization
          return [200, {}]
        })

      const client = createGithubAppClient({
        repositoryNames: ['ai-platform-tenants'],
        permissions: { contents: 'read', actions: 'read' }
      })

      await client.request('GET /repos/{owner}/{repo}', {
        owner: 'DEFRA',
        repo: 'ai-platform-tenants'
      })

      expect(tokenRequestBody).toEqual({
        repositories: ['ai-platform-tenants'],
        permissions: { contents: 'read', actions: 'read' }
      })
      expect(sentAuthorization).toBe('token ghs_scoped')
    })

    test('reuses the cached installation token for later requests', async () => {
      const { createGithubAppClient } = await loadClientModule(appEnv)
      let tokenRequests = 0

      nock(GITHUB_API)
        .post('/app/installations/123/access_tokens')
        .times(2)
        .reply(() => {
          tokenRequests += 1
          return [
            201,
            {
              token: `ghs_${tokenRequests}`,
              expires_at: new Date(Date.now() + 3600000).toISOString()
            }
          ]
        })
      nock(GITHUB_API).get('/repos/DEFRA/ai-platform-infra').twice().reply(200)

      const client = createGithubAppClient({
        repositoryNames: ['ai-platform-infra'],
        permissions: { contents: 'read' }
      })
      const params = { owner: 'DEFRA', repo: 'ai-platform-infra' }

      await client.request('GET /repos/{owner}/{repo}', params)
      await client.request('GET /repos/{owner}/{repo}', params)

      expect(tokenRequests).toBe(1)
    })
  })

  test('sends the PAT and the pinned API version when no App is configured', async () => {
    const { createGithubAppClient, GITHUB_API_VERSION } =
      await loadClientModule({ GITHUB_TOKEN: 'pat-placeholder' })
    let sentHeaders

    nock(GITHUB_API)
      .get('/repos/DEFRA/ai-platform-infra')
      .reply(function () {
        sentHeaders = this.req.headers
        return [200, {}]
      })

    await createGithubAppClient(READ_SCOPE).request(
      'GET /repos/{owner}/{repo}',
      {
        owner: 'DEFRA',
        repo: 'ai-platform-infra'
      }
    )

    expect(GITHUB_API_VERSION).toBe('2026-03-10')
    expect(sentHeaders['x-github-api-version']).toBe('2026-03-10')
    expect(sentHeaders.authorization).toBe('token pat-placeholder')
  })

  test('fails fast on a rate limit instead of sleeping and retrying', async () => {
    const { createGithubAppClient } = await loadClientModule({
      GITHUB_TOKEN: ''
    })
    let attempts = 0

    nock(GITHUB_API)
      .get('/repos/DEFRA/ai-platform-infra')
      .twice()
      .reply(() => {
        attempts += 1
        return [
          403,
          { message: 'secondary rate limit' },
          { 'retry-after': '60' }
        ]
      })

    await expect(
      createGithubAppClient(READ_SCOPE).request('GET /repos/{owner}/{repo}', {
        owner: 'DEFRA',
        repo: 'ai-platform-infra'
      })
    ).rejects.toMatchObject({ status: 403 })
    expect(attempts).toBe(1)
  })

  describe('read-only enforcement', () => {
    test('allows exactly the read permissions contents, actions and metadata', async () => {
      const { GITHUB_READ_PERMISSIONS } = await loadClientModule({})

      expect(GITHUB_READ_PERMISSIONS).toEqual({
        contents: 'read',
        actions: 'read',
        metadata: 'read'
      })
      expect(Object.isFrozen(GITHUB_READ_PERMISSIONS)).toBe(true)
    })

    test.each([
      ['write access to contents', { contents: 'write' }],
      ['write access to actions', { actions: 'write' }],
      ['admin access to metadata', { metadata: 'admin' }],
      ['a write mixed in with reads', { contents: 'read', actions: 'write' }],
      ['a permission outside the allow-list', { pull_requests: 'read' }],
      ['an inherited property name', { toString: 'read' }]
    ])('refuses %s without minting a token', async (_name, permissions) => {
      const { createGithubAppClient } = await loadClientModule(appEnv)
      const tokenRequests = nock(GITHUB_API)
        .post('/app/installations/123/access_tokens')
        .reply(201, { token: 'ghs_never' })

      expect(() =>
        createGithubAppClient({
          repositoryNames: ['ai-platform-tenants'],
          permissions
        })
      ).toThrow(/read permissions/)
      expect(tokenRequests.isDone()).toBe(false)
    })

    test.each([
      ['no scope', undefined],
      ['no permissions', { repositoryNames: ['ai-platform-infra'] }],
      [
        'empty permissions',
        { repositoryNames: ['ai-platform-infra'], permissions: {} }
      ],
      ['no repositories', { permissions: { contents: 'read' } }],
      [
        'an empty repository list',
        { repositoryNames: [], permissions: { contents: 'read' } }
      ]
    ])(
      'requires explicit repositories and permissions: %s',
      async (_n, scope) => {
        const { createGithubAppClient } = await loadClientModule({})

        expect(() => createGithubAppClient(scope)).toThrow(
          /repositoryNames and permissions/
        )
      }
    )

    test.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
      'refuses a %s request before any token or call goes out',
      async (method) => {
        const { createGithubAppClient } = await loadClientModule(appEnv)
        const calls = []
        const scope = nock(GITHUB_API).persist()

        scope.on('request', (request) =>
          calls.push(`${request.method} ${request.path}`)
        )
        scope.intercept(/.*/, method).reply(200, {})
        scope.post(/.*/).reply(201, { token: 'ghs_never' })

        const client = createGithubAppClient(READ_SCOPE)

        await expect(
          client.request(`${method} /repos/{owner}/{repo}/dispatches`, {
            owner: 'DEFRA',
            repo: 'ai-platform-tenants'
          })
        ).rejects.toMatchObject({ code: 'github-write-refused' })
        expect(calls).toEqual([])
      }
    )

    test('refuses a write through a named Octokit method too, on the PAT fallback', async () => {
      const { createGithubAppClient } = await loadClientModule({
        GITHUB_TOKEN: 'pat-placeholder'
      })
      const client = createGithubAppClient(READ_SCOPE)

      await expect(
        client.rest.actions.createWorkflowDispatch({
          owner: 'DEFRA',
          repo: 'ai-platform-tenants',
          workflow_id: 'submit.yml',
          ref: 'main'
        })
      ).rejects.toMatchObject({ code: 'github-write-refused' })
    })
  })
})

describe('#toPemPrivateKey', () => {
  test('decodes a base64-encoded PEM back into a genuine multi-line PEM', async () => {
    const { toPemPrivateKey } =
      await import('#/adapters/github/github-app-client.js')
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nabc123\n-----END RSA PRIVATE KEY-----\n'

    expect(toPemPrivateKey(Buffer.from(pem).toString('base64'))).toBe(pem)
  })

  test('returns null when given null', async () => {
    const { toPemPrivateKey } =
      await import('#/adapters/github/github-app-client.js')

    expect(toPemPrivateKey(null)).toBeNull()
  })
})

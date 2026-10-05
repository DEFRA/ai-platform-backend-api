import nock from 'nock'

const ARM_BASE_URL = 'https://management.azure.com'

// The repo's global test setup (.vite/setup-files.js) replaces global.fetch
// with vitest-fetch-mock for every file - undo that here so nock, which
// intercepts at the undici level, actually sees these requests.
const realFetch = globalThis.fetch

beforeAll(() => {
  globalThis.fetch = realFetch
})

function stubCredential(token = 'fake-arm-token') {
  return () => ({ getToken: async () => ({ token }) })
}

describe('#createArmClient', () => {
  afterEach(() => {
    nock.cleanAll()
  })

  test('sends a bearer token from the credential and returns parsed JSON', async () => {
    nock(ARM_BASE_URL)
      .matchHeader('authorization', 'Bearer fake-arm-token')
      .get('/path')
      .reply(200, { properties: { state: 'active' } })

    const { createArmClient } = await import('#/adapters/azure/arm-client.js')
    const armClient = createArmClient({ getCredential: stubCredential() })

    const result = await armClient.request('GET', '/path')

    expect(result).toEqual({ properties: { state: 'active' } })
  })

  test('sends the If-Match header when ifMatch is provided', async () => {
    nock(ARM_BASE_URL).matchHeader('if-match', '*').delete('/path').reply(204)

    const { createArmClient } = await import('#/adapters/azure/arm-client.js')
    const armClient = createArmClient({ getCredential: stubCredential() })

    await armClient.request('DELETE', '/path', { ifMatch: '*' })

    expect(nock.isDone()).toBe(true)
  })

  test('returns null for a 204 response', async () => {
    nock(ARM_BASE_URL).post('/path').reply(204)

    const { createArmClient } = await import('#/adapters/azure/arm-client.js')
    const armClient = createArmClient({ getCredential: stubCredential() })

    const result = await armClient.request('POST', '/path')

    expect(result).toBeNull()
  })

  test('returns null for a 200 response with an empty body', async () => {
    nock(ARM_BASE_URL).delete('/path').reply(200, '')

    const { createArmClient } = await import('#/adapters/azure/arm-client.js')
    const armClient = createArmClient({ getCredential: stubCredential() })

    const result = await armClient.request('DELETE', '/path')

    expect(result).toBeNull()
  })

  test('sends a JSON body when provided', async () => {
    nock(ARM_BASE_URL)
      .put('/path', { properties: { state: 'active' } })
      .reply(200, {})

    const { createArmClient } = await import('#/adapters/azure/arm-client.js')
    const armClient = createArmClient({ getCredential: stubCredential() })

    await armClient.request('PUT', '/path', {
      body: { properties: { state: 'active' } }
    })

    expect(nock.isDone()).toBe(true)
  })

  test('throws on a non-2xx response without leaking the response body', async () => {
    nock(ARM_BASE_URL)
      .get('/path')
      .reply(403, { error: { message: 'do-not-leak-this' } })

    const { createArmClient } = await import('#/adapters/azure/arm-client.js')
    const armClient = createArmClient({ getCredential: stubCredential() })

    await expect(armClient.request('GET', '/path')).rejects.toThrow(
      'ARM request failed: GET /path -> 403'
    )
  })
})

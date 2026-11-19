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

  describe('a 202 Accepted', () => {
    const OPERATION = '/operations/1'
    const client = (options = {}) =>
      createArmClientWith({
        operationTimeoutMs: 1000,
        defaultPollMs: 0,
        ...options
      })

    async function createArmClientWith(options) {
      const { createArmClient } = await import('#/adapters/azure/arm-client.js')

      return createArmClient({ getCredential: stubCredential(), ...options })
    }

    test('is polled at Azure-AsyncOperation until Succeeded, then resolves', async () => {
      nock(ARM_BASE_URL)
        .patch('/path')
        .reply(202, '', {
          'azure-asyncoperation': `${ARM_BASE_URL}${OPERATION}`,
          'retry-after': '0'
        })
      nock(ARM_BASE_URL)
        .get(OPERATION)
        .reply(200, { status: 'InProgress' })
        .get(OPERATION)
        .reply(200, { status: 'Succeeded' })

      await expect(
        (await client()).request('PATCH', '/path', { body: { a: 1 } })
      ).resolves.toBeNull()
      expect(nock.isDone()).toBe(true)
    })

    test.each(['Failed', 'Canceled'])(
      'throws when the operation is %s, without its body',
      async (status) => {
        nock(ARM_BASE_URL)
          .patch('/path')
          .reply(202, '', {
            'azure-asyncoperation': `${ARM_BASE_URL}${OPERATION}`
          })
        nock(ARM_BASE_URL)
          .get(OPERATION)
          .reply(200, { status, error: { message: 'do-not-leak-this' } })

        await expect(
          (await client()).request('PATCH', '/path')
        ).rejects.toThrow(
          `ARM request failed: PATCH /path -> operation ${status.toLowerCase()}`
        )
      }
    )

    test('throws when the operation does not end within the timeout', async () => {
      nock(ARM_BASE_URL)
        .patch('/path')
        .reply(202, '', {
          'azure-asyncoperation': `${ARM_BASE_URL}${OPERATION}`
        })
      nock(ARM_BASE_URL)
        .get(OPERATION)
        .times(1000)
        .reply(200, { status: 'InProgress' })

      await expect(
        (await client({ operationTimeoutMs: 50 })).request('PATCH', '/path')
      ).rejects.toThrow(
        'ARM request failed: PATCH /path -> operation timed out'
      )
    })

    test('a call’s own maxWaitMs bounds the wait, whatever the client’s timeout', async () => {
      nock(ARM_BASE_URL)
        .patch('/path')
        .reply(202, '', {
          'azure-asyncoperation': `${ARM_BASE_URL}${OPERATION}`
        })
      nock(ARM_BASE_URL)
        .get(OPERATION)
        .times(1000)
        .reply(200, { status: 'InProgress' })

      const started = Date.now()

      await expect(
        (await client({ operationTimeoutMs: 60_000 })).request(
          'PATCH',
          '/path',
          { maxWaitMs: 50 }
        )
      ).rejects.toThrow(
        'ARM request failed: PATCH /path -> operation timed out'
      )
      expect(Date.now() - started).toBeLessThan(5000)
    })

    test('a delayed first response is cut off at maxWaitMs', async () => {
      nock(ARM_BASE_URL)
        .patch('/path')
        .reply(() => new Promise(() => {}))

      const started = Date.now()

      await expect(
        (await client()).request('PATCH', '/path', { maxWaitMs: 50 })
      ).rejects.toThrow(
        'ARM request failed: PATCH /path -> operation timed out'
      )
      expect(Date.now() - started).toBeLessThan(1500)
    })

    test('a token that never arrives is cut off at maxWaitMs', async () => {
      const { createArmClient } = await import('#/adapters/azure/arm-client.js')
      const armClient = createArmClient({
        getCredential: () => ({ getToken: () => new Promise(() => {}) })
      })

      await expect(
        armClient.request('GET', '/path', { maxWaitMs: 50 })
      ).rejects.toThrow('ARM request failed: GET /path -> operation timed out')
    })

    test('a caller’s own abort stops the request before the deadline', async () => {
      nock(ARM_BASE_URL)
        .get('/path')
        .reply(() => new Promise(() => {}))

      const controller = new AbortController()
      const pending = (await client()).request('GET', '/path', {
        signal: controller.signal
      })

      controller.abort(new Error('caller gave up'))

      await expect(pending).rejects.toThrow('caller gave up')
    })

    test.each([
      ['absent', undefined],
      ['empty', ''],
      ['not a number', 'soon'],
      ['negative', '-3']
    ])('waits defaultPollMs when Retry-After is %s', async (_name, value) => {
      const accepted = new Response(null, {
        status: 202,
        headers: {
          location: `${ARM_BASE_URL}${OPERATION}`,
          ...(value === undefined ? {} : { 'retry-after': value })
        }
      })
      const replies = [accepted, new Response('{"id":"done"}', { status: 200 })]

      vi.stubGlobal(
        'fetch',
        vi.fn(async () => replies.shift())
      )

      const timers = vi.spyOn(globalThis, 'setTimeout')

      try {
        await expect(
          (await client({ defaultPollMs: 37 })).request('PUT', '/path')
        ).resolves.toEqual({ id: 'done' })
        expect(timers.mock.calls.map(([, ms]) => ms)).toContain(37)
      } finally {
        timers.mockRestore()
        vi.stubGlobal('fetch', realFetch)
      }
    })

    test('releases the body of the 202 and of each polled 202', async () => {
      const cancelled = vi.fn()
      const reply = (status, headers, body) =>
        new Response(
          body ??
            new ReadableStream({
              start: (controller) => controller.enqueue(new Uint8Array([1])),
              cancel: cancelled
            }),
          { status, headers }
        )
      const location = { location: `${ARM_BASE_URL}${OPERATION}` }
      const replies = [
        reply(202, location),
        reply(202, location),
        reply(200, {}, JSON.stringify({ id: 'done' }))
      ]
      const fetchMock = vi.fn(async () => replies.shift())

      vi.stubGlobal('fetch', fetchMock)

      try {
        await expect((await client()).request('PUT', '/path')).resolves.toEqual(
          { id: 'done' }
        )
      } finally {
        vi.stubGlobal('fetch', realFetch)
      }

      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(cancelled).toHaveBeenCalledTimes(2)
    })

    test('follows Location until it answers 200 and returns that body', async () => {
      nock(ARM_BASE_URL)
        .put('/path')
        .reply(202, '', { location: `${ARM_BASE_URL}${OPERATION}` })
      nock(ARM_BASE_URL)
        .get(OPERATION)
        .reply(202, '')
        .get(OPERATION)
        .reply(200, { id: 'done' })

      await expect((await client()).request('PUT', '/path')).resolves.toEqual({
        id: 'done'
      })
    })

    test('throws when polling is refused', async () => {
      nock(ARM_BASE_URL)
        .patch('/path')
        .reply(202, '', {
          'azure-asyncoperation': `${ARM_BASE_URL}${OPERATION}`
        })
      nock(ARM_BASE_URL).get(OPERATION).reply(500, 'do-not-leak-this')

      await expect((await client()).request('PATCH', '/path')).rejects.toThrow(
        'ARM request failed: PATCH /path -> 500 while polling'
      )
    })

    test.each([
      ['no status URL', {}],
      ['a status URL outside ARM', { location: 'https://evil.example/x' }]
    ])('throws, without polling, with %s', async (_name, headers) => {
      nock(ARM_BASE_URL).patch('/path').reply(202, '', headers)

      await expect((await client()).request('PATCH', '/path')).rejects.toThrow(
        'accepted with no status URL'
      )
    })
  })
})

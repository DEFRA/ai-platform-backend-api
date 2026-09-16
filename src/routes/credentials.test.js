import { randomUUID } from 'node:crypto'

describe('#credentials routes', () => {
  let server

  beforeAll(async () => {
    // Dynamic import needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')

    server = await createServer()
    await server.initialize()
  })

  afterAll(async () => {
    await server.stop({ timeout: 0 })
  })

  test('POST /v1/credentials issues a mock credential', async () => {
    const { result, statusCode, headers } = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers: { 'x-user-id': 'user-1', 'idempotency-key': randomUUID() },
      payload: { modelSlug: 'gpt-4o' }
    })

    expect(statusCode).toBe(201)
    expect(headers.location).toBe(`/v1/credentials/${result.credential._id}`)
    expect(result.secret).toEqual(expect.stringContaining('mock_'))
    expect(result.credential.status).toBe('active')
    expect(result.credential.keyHint).toHaveLength(4)
  })

  test('POST /v1/credentials replays without a secret for a repeated Idempotency-Key', async () => {
    const idempotencyKey = randomUUID()
    const headers = { 'x-user-id': 'user-2', 'idempotency-key': idempotencyKey }
    const payload = { modelSlug: 'gpt-4o-mini' }

    const first = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers,
      payload
    })
    const second = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers,
      payload
    })

    expect(first.statusCode).toBe(201)
    expect(second.statusCode).toBe(200)
    expect(second.result.secret).toBeUndefined()
  })

  test('POST /v1/credentials rejects a second active credential for the same model', async () => {
    const headers = { 'x-user-id': 'user-3', 'idempotency-key': randomUUID() }
    const payload = { modelSlug: 'gpt-3-5-turbo' }

    await server.inject({ method: 'POST', url: '/v1/credentials', headers, payload })

    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers: { ...headers, 'idempotency-key': randomUUID() },
      payload
    })

    expect(statusCode).toBe(409)
    expect(result.code).toBe('active-credential-exists')
  })

  test('POST /v1/credentials rejects a model that does not exist', async () => {
    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers: { 'x-user-id': 'user-4', 'idempotency-key': randomUUID() },
      payload: { modelSlug: 'not-a-real-model' }
    })

    expect(statusCode).toBe(400)
    expect(result.code).toBe('model-not-eligible')
  })

  test('POST /v1/credentials requires an Idempotency-Key header', async () => {
    const { statusCode } = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers: { 'x-user-id': 'user-5' },
      payload: { modelSlug: 'gpt-4o' }
    })

    expect(statusCode).toBe(400)
  })
})

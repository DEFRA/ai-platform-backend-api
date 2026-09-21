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

    await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers,
      payload
    })

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

  test("GET /v1/credentials lists a user's own credentials without secrets", async () => {
    const headers = { 'x-user-id': 'user-6', 'idempotency-key': randomUUID() }

    await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers,
      payload: { modelSlug: 'gpt-4o' }
    })

    const { result, statusCode } = await server.inject({
      method: 'GET',
      url: '/v1/credentials',
      headers: { 'x-user-id': 'user-6' }
    })

    expect(statusCode).toBe(200)
    expect(result.items).toHaveLength(1)
    expect(result.items[0].secret).toBeUndefined()
    expect(result.items[0].renewalsRemaining).toBe(3)
  })

  test("GET /v1/credentials/{id} returns 404 for another user's credential", async () => {
    const headers = { 'x-user-id': 'user-7', 'idempotency-key': randomUUID() }
    const issued = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers,
      payload: { modelSlug: 'gpt-4o' }
    })

    const { statusCode } = await server.inject({
      method: 'GET',
      url: `/v1/credentials/${issued.result.credential._id}`,
      headers: { 'x-user-id': 'someone-else' }
    })

    expect(statusCode).toBe(404)
  })

  test('POST /v1/credentials/{id}/renew extends expiry and increments renewalCount', async () => {
    const headers = { 'x-user-id': 'user-8', 'idempotency-key': randomUUID() }
    const issued = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers,
      payload: { modelSlug: 'gpt-4o' }
    })

    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: `/v1/credentials/${issued.result.credential._id}/renew`,
      headers: { 'x-user-id': 'user-8' }
    })

    expect(statusCode).toBe(200)
    expect(result.renewalCount).toBe(1)
    expect(result.renewalsRemaining).toBe(2)
  })

  test('POST /v1/credentials/{id}/renew rejects once the renewal cap is reached', async () => {
    const headers = { 'x-user-id': 'user-9', 'idempotency-key': randomUUID() }
    const issued = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers,
      payload: { modelSlug: 'gpt-4o' }
    })
    const id = issued.result.credential._id

    for (let i = 0; i < 3; i++) {
      await server.inject({
        method: 'POST',
        url: `/v1/credentials/${id}/renew`,
        headers: { 'x-user-id': 'user-9' }
      })
    }

    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: `/v1/credentials/${id}/renew`,
      headers: { 'x-user-id': 'user-9' }
    })

    expect(statusCode).toBe(403)
    expect(result.code).toBe('renewal-cap-reached')
  })

  test('DELETE /v1/credentials/{id} revokes the credential', async () => {
    const headers = { 'x-user-id': 'user-10', 'idempotency-key': randomUUID() }
    const issued = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers,
      payload: { modelSlug: 'gpt-4o' }
    })
    const id = issued.result.credential._id

    const revoke = await server.inject({
      method: 'DELETE',
      url: `/v1/credentials/${id}`,
      headers: { 'x-user-id': 'user-10' }
    })

    const { result } = await server.inject({
      method: 'GET',
      url: `/v1/credentials/${id}`,
      headers: { 'x-user-id': 'user-10' }
    })

    expect(revoke.statusCode).toBe(204)
    expect(result.status).toBe('revoked')
  })

  test('DELETE /v1/credentials/{id} returns 404 for an unknown id', async () => {
    const { statusCode } = await server.inject({
      method: 'DELETE',
      url: '/v1/credentials/507f1f77bcf86cd799439011',
      headers: { 'x-user-id': 'user-11' }
    })

    expect(statusCode).toBe(404)
  })
})

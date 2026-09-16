describe('#models routes', () => {
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

  test('GET /v1/models returns the seeded eligible models', async () => {
    const { result, statusCode } = await server.inject({
      method: 'GET',
      url: '/v1/models'
    })

    expect(statusCode).toBe(200)
    expect(result.items.length).toBeGreaterThan(0)
    expect(result.items[0]).toHaveProperty('slug')
  })

  test('GET /v1/models filters by provider', async () => {
    const { result, statusCode } = await server.inject({
      method: 'GET',
      url: '/v1/models?provider=openai'
    })

    expect(statusCode).toBe(200)
    expect(result.items.every((model) => model.provider === 'openai')).toBe(
      true
    )
  })

  test('GET /v1/models rejects unknown query params', async () => {
    const { statusCode } = await server.inject({
      method: 'GET',
      url: '/v1/models?unknown=true'
    })

    expect(statusCode).toBe(400)
  })

  test('GET /v1/models/{slug} returns model detail', async () => {
    const { result, statusCode } = await server.inject({
      method: 'GET',
      url: '/v1/models/gpt-4o'
    })

    expect(statusCode).toBe(200)
    expect(result.slug).toBe('gpt-4o')
    expect(result.deploymentName).toBe('gpt-4o')
  })

  test('GET /v1/models/{slug} returns 404 for an unknown slug', async () => {
    const { statusCode } = await server.inject({
      method: 'GET',
      url: '/v1/models/does-not-exist'
    })

    expect(statusCode).toBe(404)
  })
})

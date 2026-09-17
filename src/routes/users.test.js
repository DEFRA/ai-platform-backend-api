describe('#users routes', () => {
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

  test('POST /v1/users upserts a user and team', async () => {
    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: '/v1/users',
      payload: {
        email: 'test.user@defra.gov.uk',
        displayName: 'Test User',
        teamName: 'Platform Team'
      }
    })

    expect(statusCode).toBe(200)
    expect(result.user.email).toBe('test.user@defra.gov.uk')
    expect(result.team.name).toBe('Platform Team')
  })

  test('POST /v1/users rejects disallowed email domains', async () => {
    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: '/v1/users',
      payload: {
        email: 'test.user@example.com',
        displayName: 'Test User',
        teamName: 'Platform Team'
      }
    })

    expect(statusCode).toBe(403)
    expect(result.code).toBe('domain-not-allowed')
  })

  test('POST /v1/users rejects unknown payload keys', async () => {
    const { statusCode } = await server.inject({
      method: 'POST',
      url: '/v1/users',
      payload: {
        email: 'test.user@defra.gov.uk',
        displayName: 'Test User',
        teamName: 'Platform Team',
        extra: 'not-allowed'
      }
    })

    expect(statusCode).toBe(400)
  })
})

describe('#router', () => {
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

  test.each(['/example', '/example/abc'])(
    'does not register the CDP template route %s',
    async (url) => {
      const { statusCode } = await server.inject({ method: 'GET', url })

      expect(statusCode).toBe(404)
    }
  )

  test('registers no route whose path starts with /example', () => {
    const paths = server.table().map((route) => route.path)

    expect(paths.filter((path) => path.startsWith('/example'))).toEqual([])
  })

  test('still registers the health route', async () => {
    const { statusCode } = await server.inject({
      method: 'GET',
      url: '/health'
    })

    expect(statusCode).toBe(200)
  })
})

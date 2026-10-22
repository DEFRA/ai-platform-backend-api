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

  test('GET /v1/models excludes ineligible models by default', async () => {
    const { result } = await server.inject({
      method: 'GET',
      url: '/v1/models'
    })

    expect(
      result.items.some((model) => model.slug === 'text-embedding-ada-002')
    ).toBe(false)
  })

  test('GET /v1/models?includeIneligible=true includes ineligible models', async () => {
    const { result } = await server.inject({
      method: 'GET',
      url: '/v1/models?includeIneligible=true'
    })

    const model = result.items.find(
      (item) => item.slug === 'text-embedding-ada-002'
    )
    expect(model).toBeDefined()
    expect(model.eligible).toBe(false)
  })

  describe('tier=team (D4)', () => {
    async function slugsOf(query) {
      const { result, statusCode } = await server.inject({
        method: 'GET',
        url: `/v1/models?${query}`
      })

      return { statusCode, slugs: result.items?.map((item) => item.slug) }
    }

    test('offers GPT-4o and leaves out GPT-4.1 nano, whose team SKU is only in swedencentral', async () => {
      const { statusCode, slugs } = await slugsOf('tier=team')

      expect(statusCode).toBe(200)
      expect(slugs).toContain('gpt-4o')
      expect(slugs).not.toContain('gpt-4-1-nano')
    })

    test('leaves out models without a team SKU and ineligible ones', async () => {
      const { slugs } = await slugsOf('tier=team')

      expect(slugs).not.toContain('gpt-5-nano')
      expect(slugs).not.toContain('text-embedding-ada-002')
    })

    test('keeps only the models listed for the environment asked for', async () => {
      const sandbox = await slugsOf('tier=team&environment=sandbox')
      const qa = await slugsOf('tier=team&environment=qa')

      expect(sandbox.slugs).toContain('gpt-4o')
      expect(qa).toEqual({ statusCode: 200, slugs: [] })
    })

    test('filters by provider as well', async () => {
      const { slugs } = await slugsOf('tier=team&provider=nobody')

      expect(slugs).toEqual([])
    })

    test('refuses an environment without tier=team', async () => {
      expect((await slugsOf('environment=sandbox')).statusCode).toBe(400)
      expect(
        (await slugsOf('tier=research&environment=sandbox')).statusCode
      ).toBe(400)
    })

    test('leaves the unfiltered list unchanged, so GPT-4.1 nano can be explained', async () => {
      const { slugs } = await slugsOf('')

      expect(slugs).toContain('gpt-4-1-nano')
      expect(slugs).toContain('gpt-4o')
    })
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

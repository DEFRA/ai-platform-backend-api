describe('#models routes', () => {
  let server
  let invalidateModelsCache
  let deployInResearch
  let failResearchRead
  let restoreResearchDeployments

  beforeAll(async () => {
    // Dynamic import needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')

    ;({ invalidateModelsCache } = await import('#/services/models-service.js'))
    ;({ deployInResearch, failResearchRead, restoreResearchDeployments } =
      await import('#/common/test-helpers/research-deployments.js'))
    server = await createServer()
    await server.initialize()
  })

  afterEach(() => {
    restoreResearchDeployments()
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

  describe('tier=team', () => {
    async function slugsOf(query) {
      const { result, statusCode } = await server.inject({
        method: 'GET',
        url: `/v1/models?${query}`
      })

      return { statusCode, slugs: result.items?.map((item) => item.slug) }
    }

    test('offers GPT-4o and GPT-4.1 nano, whose team SKU is in swedencentral', async () => {
      const { statusCode, slugs } = await slugsOf('tier=team')

      expect(statusCode).toBe(200)
      expect(slugs).toContain('gpt-4o')
      expect(slugs).toContain('gpt-4-1-nano')
    })

    test('leaves out a model whose only team SKU is in an unallowed region or Global', async () => {
      const gpt4o = await server.db
        .collection('models')
        .findOne({ slug: 'gpt-4o' }, { projection: { _id: 0 } })

      await server.db.collection('models').insertMany([
        {
          ...gpt4o,
          slug: 'team-east-us-only',
          skus: [{ name: 'Standard', tiers: ['team'], regions: ['eastus'] }]
        },
        {
          ...gpt4o,
          slug: 'team-global-only',
          skus: [
            { name: 'GlobalStandard', tiers: ['team'], regions: ['uksouth'] }
          ]
        }
      ])
      invalidateModelsCache()

      const { slugs } = await slugsOf('tier=team')

      expect(slugs).not.toContain('team-east-us-only')
      expect(slugs).not.toContain('team-global-only')
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

    test('leaves the unfiltered list unchanged, so a model that is not offered can be explained', async () => {
      const { slugs } = await slugsOf('')

      expect(slugs).toContain('gpt-4-1-nano')
      expect(slugs).toContain('gpt-4o')
    })
  })

  describe('tier=research', () => {
    async function researchSlugs(query = 'tier=research') {
      const { result, statusCode } = await server.inject({
        method: 'GET',
        url: `/v1/models?${query}`
      })

      return { statusCode, slugs: result.items?.map((item) => item.slug) }
    }

    test('offers only the research-eligible models research has deployed (just gpt-4o in the mock research file), not ineligible ones', async () => {
      const { statusCode, slugs } = await researchSlugs()

      expect(statusCode).toBe(200)
      expect(slugs).toEqual(['gpt-4o'])
    })

    test('offers a catalogue-eligible model once research deploys it, and never an ineligible one', async () => {
      deployInResearch(['gpt-4o', 'gpt-5-nano', 'text-embedding-ada-002'])

      const { slugs } = await researchSlugs()

      expect(slugs).toEqual(expect.arrayContaining(['gpt-4o', 'gpt-5-nano']))
      expect(slugs).not.toContain('gpt-4-1-nano')
      expect(slugs).not.toContain('text-embedding-ada-002')
    })

    test('refuses with 502 research-deployments-unavailable when the research file cannot be read', async () => {
      failResearchRead()

      const { result, statusCode } = await server.inject({
        method: 'GET',
        url: '/v1/models?tier=research'
      })
      const plain = await server.inject({ method: 'GET', url: '/v1/models' })

      expect(statusCode).toBe(502)
      expect(result.code).toBe('research-deployments-unavailable')
      expect(plain.statusCode).toBe(502)
    })

    test('leaves out a GlobalStandard-only model, but keeps it in the plain list', async () => {
      const gpt4o = await server.db
        .collection('models')
        .findOne({ slug: 'gpt-4o' }, { projection: { _id: 0 } })

      await server.db.collection('models').insertMany([
        {
          ...gpt4o,
          slug: 'research-global-only',
          skus: [
            {
              name: 'GlobalStandard',
              tiers: ['research'],
              regions: ['uksouth']
            }
          ]
        },
        {
          ...gpt4o,
          slug: 'research-east-us-only',
          skus: [{ name: 'Standard', tiers: ['research'], regions: ['eastus'] }]
        }
      ])
      invalidateModelsCache()
      deployInResearch([
        'gpt-4o',
        'research-global-only',
        'research-east-us-only'
      ])

      const research = await researchSlugs()
      const plain = await researchSlugs('includeIneligible=true')

      expect(research.slugs).toEqual(['gpt-4o'])
      expect(plain.slugs).toContain('research-global-only')
    })

    test('filters by provider as well', async () => {
      const { slugs } = await researchSlugs('tier=research&provider=nobody')

      expect(slugs).toEqual([])
    })
  })

  describe('researchAvailable in the plain list', () => {
    async function availability() {
      const { result } = await server.inject({
        method: 'GET',
        url: '/v1/models?includeIneligible=true'
      })

      return Object.fromEntries(
        result.items.map((item) => [item.slug, item.researchAvailable])
      )
    }

    test('is true only for a research-eligible model research has deployed', async () => {
      deployInResearch(['gpt-4o', 'text-embedding-ada-002'])

      const flags = await availability()

      expect(flags['gpt-4o']).toBe(true)
      // eligible in the catalogue, not deployed
      expect(flags['gpt-4-1-nano']).toBe(false)
      expect(flags['gpt-5-nano']).toBe(false)
      // deployed, not eligible
      expect(flags['text-embedding-ada-002']).toBe(false)
    })

    test('is a boolean on every model and leaves the other fields alone', async () => {
      const { result } = await server.inject({
        method: 'GET',
        url: '/v1/models'
      })

      expect(
        result.items.every(
          (item) => typeof item.researchAvailable === 'boolean'
        )
      ).toBe(true)
      expect(result.items.find((item) => item.slug === 'gpt-4o')).toMatchObject(
        { eligible: true, tiers: ['research', 'team'] }
      )
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

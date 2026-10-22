import {
  ALLOWED_REGIONS,
  isGlobalSku,
  isResearchEligible,
  isTeamEligible,
  researchSkuOf,
  syncCatalogue,
  teamSkuOf
} from '#/services/catalogue-service.js'

const OPENAI = { provider: 'openai', offering: 'azure-openai' }

const UK_TEAM_SKU = { name: 'DataZoneStandard', tiers: ['team'] }
const UK_RESEARCH_SKU = { name: 'Standard', tiers: ['research'] }

function teamModel(fields = {}) {
  return {
    slug: 'rule-model',
    eligible: true,
    regions: ['uksouth'],
    environments: ['dev', 'qa'],
    skus: [UK_TEAM_SKU],
    ...fields
  }
}

function researchModel(fields = {}) {
  return {
    slug: 'research-rule-model',
    eligible: true,
    regions: ['uksouth'],
    tiers: ['research'],
    skus: [UK_RESEARCH_SKU],
    ...fields
  }
}

describe('allowed regions and Global SKUs', () => {
  test('allows only UK South/West, Sweden Central and EU North/West', () => {
    expect(ALLOWED_REGIONS).toEqual([
      'uksouth',
      'ukwest',
      'swedencentral',
      'northeurope',
      'westeurope'
    ])
  })

  test.each(['GlobalStandard', 'globalbatch', 'GLOBALPROVISIONED'])(
    'treats %s as a Global SKU',
    (name) => {
      expect(isGlobalSku({ name })).toBe(true)
    }
  )

  test.each([
    ['Standard', { name: 'Standard' }],
    ['DataZoneStandard', { name: 'DataZoneStandard' }],
    ['no name', {}],
    ['no SKU', undefined]
  ])('does not treat %s as a Global SKU', (_why, sku) => {
    expect(isGlobalSku(sku)).toBe(false)
  })
})

describe('team eligibility rule', () => {
  test('takes a SKU without regions from the model, which is in the UK', () => {
    expect(teamSkuOf(teamModel())).toBe(UK_TEAM_SKU)
    expect(isTeamEligible(teamModel(), 'dev')).toBe(true)
  })

  test.each([
    'uksouth',
    'ukwest',
    'swedencentral',
    'northeurope',
    'westeurope'
  ])(
    'allows a team SKU in %s (Sweden Central and the EU included)',
    (region) => {
      const sku = { ...UK_TEAM_SKU, regions: [region] }

      expect(teamSkuOf(teamModel({ skus: [sku] }))).toBe(sku)
      expect(isTeamEligible(teamModel({ skus: [sku] }), 'dev')).toBe(true)
    }
  )

  test.each(['eastus', 'eastus2', 'westus', 'australiaeast', 'francecentral'])(
    'refuses a team SKU in %s, which is not an allowed region',
    (region) => {
      const sku = { ...UK_TEAM_SKU, regions: [region] }

      expect(teamSkuOf(teamModel({ skus: [sku] }))).toBeUndefined()
      expect(isTeamEligible(teamModel({ skus: [sku] }), 'dev')).toBe(false)
    }
  )

  test('takes a SKU with its own regions over the model’s', () => {
    const elsewhere = teamModel({
      regions: ['uksouth'],
      skus: [{ ...UK_TEAM_SKU, regions: ['eastus'] }]
    })
    const sweden = teamModel({
      regions: ['eastus'],
      skus: [{ ...UK_TEAM_SKU, regions: ['swedencentral'] }]
    })

    expect(teamSkuOf(elsewhere)).toBeUndefined()
    expect(isTeamEligible(sweden, 'dev')).toBe(true)
  })

  test('needs every region of the SKU to be allowed, in any case', () => {
    const mixed = { ...UK_TEAM_SKU, regions: ['uksouth', 'eastus'] }
    const upper = { ...UK_TEAM_SKU, regions: ['UKWest', 'SwedenCentral'] }

    expect(teamSkuOf(teamModel({ skus: [mixed] }))).toBeUndefined()
    expect(teamSkuOf(teamModel({ skus: [upper] }))).toBe(upper)
  })

  test('never takes a Global SKU, whatever its regions', () => {
    const global = { name: 'GlobalStandard', tiers: ['team'] }
    const globalUk = { ...global, regions: ['uksouth'] }
    const lower = { name: 'globalstandard', tiers: ['team'] }

    expect(teamSkuOf(teamModel({ skus: [global] }))).toBeUndefined()
    expect(isTeamEligible(teamModel({ skus: [globalUk] }), 'dev')).toBe(false)
    expect(isTeamEligible(teamModel({ skus: [lower] }), 'dev')).toBe(false)
  })

  test('picks the first usable team SKU among others', () => {
    const elsewhere = { ...UK_TEAM_SKU, regions: ['eastus'] }
    const global = { name: 'GlobalStandard', tiers: ['team'] }
    const research = { name: 'Standard', tiers: ['research'] }

    expect(
      teamSkuOf(teamModel({ skus: [research, global, elsewhere, UK_TEAM_SKU] }))
    ).toBe(UK_TEAM_SKU)
  })

  test.each([
    ['has no regions anywhere', { regions: undefined }],
    ['has an empty regions list', { regions: [] }],
    ['has no SKUs', { skus: undefined }],
    ['has no team SKU', { skus: [{ name: 'Standard', tiers: ['research'] }] }],
    [
      'has only a Global team SKU',
      { skus: [{ name: 'GlobalStandard', tiers: ['team'] }] }
    ],
    ['has a SKU with no tiers', { skus: [{ name: 'Standard' }] }],
    ['is not eligible', { eligible: false }]
  ])('refuses a model that %s', (_why, fields) => {
    expect(isTeamEligible(teamModel(fields), 'dev')).toBe(false)
  })

  test('refuses a model that does not exist', () => {
    expect(isTeamEligible(null, 'dev')).toBe(false)
    expect(teamSkuOf(undefined)).toBeUndefined()
  })

  test('needs the environment to be one the catalogue lists, when one is named', () => {
    expect(isTeamEligible(teamModel(), 'qa')).toBe(true)
    expect(isTeamEligible(teamModel(), 'prod')).toBe(false)
    expect(isTeamEligible(teamModel({ environments: undefined }), 'dev')).toBe(
      false
    )
    expect(isTeamEligible(teamModel({ environments: [] }))).toBe(true)
  })
})

describe('research eligibility rule', () => {
  test('takes a research SKU in an allowed region', () => {
    expect(researchSkuOf(researchModel())).toBe(UK_RESEARCH_SKU)
    expect(isResearchEligible(researchModel())).toBe(true)
  })

  test('still works with an allowed DataZoneStandard SKU in Sweden Central', () => {
    const sku = {
      name: 'DataZoneStandard',
      tiers: ['research', 'team'],
      regions: ['swedencentral']
    }

    expect(researchSkuOf(researchModel({ skus: [sku] }))).toBe(sku)
    expect(isResearchEligible(researchModel({ skus: [sku] }))).toBe(true)
  })

  test.each(['northeurope', 'westeurope', 'ukwest'])(
    'allows a research SKU in %s',
    (region) => {
      const sku = { ...UK_RESEARCH_SKU, regions: [region] }

      expect(isResearchEligible(researchModel({ skus: [sku] }))).toBe(true)
    }
  )

  test('refuses a model whose only research SKU is GlobalStandard', () => {
    const global = { name: 'GlobalStandard', tiers: ['research'] }

    expect(researchSkuOf(researchModel({ skus: [global] }))).toBeUndefined()
    expect(isResearchEligible(researchModel({ skus: [global] }))).toBe(false)
  })

  test('uses the allowed SKU when a Global one is also offered', () => {
    const global = { name: 'GlobalStandard', tiers: ['research'] }
    const dataZone = {
      name: 'DataZoneStandard',
      tiers: ['research', 'team'],
      regions: ['swedencentral']
    }

    expect(researchSkuOf(researchModel({ skus: [global, dataZone] }))).toBe(
      dataZone
    )
  })

  test.each([
    [
      'a SKU in East US',
      { skus: [{ ...UK_RESEARCH_SKU, regions: ['eastus'] }] }
    ],
    ['a model in a US region', { regions: ['westus'] }],
    ['no regions anywhere', { regions: undefined }],
    ['no research SKU', { skus: [UK_TEAM_SKU] }],
    ['no SKUs', { skus: undefined }],
    ['the research tier missing from `tiers`', { tiers: ['team'] }],
    ['no `tiers`', { tiers: undefined }],
    ['the eligible flag off', { eligible: false }]
  ])('refuses a model with %s', (_why, fields) => {
    expect(isResearchEligible(researchModel(fields))).toBe(false)
  })

  test('refuses a model that does not exist', () => {
    expect(isResearchEligible(null)).toBe(false)
    expect(researchSkuOf(undefined)).toBeUndefined()
  })

  test('a Global SKU never makes a team model eligible, even beside a research SKU', () => {
    const model = teamModel({
      skus: [
        { name: 'GlobalStandard', tiers: ['research', 'team'] },
        UK_RESEARCH_SKU
      ]
    })

    expect(isTeamEligible(model, 'dev')).toBe(false)
  })
})

function stubSource(result) {
  return { fetchCatalogue: vi.fn().mockResolvedValue(result) }
}

function loadProviders(db) {
  return db
    .collection('providers')
    .find({}, { projection: { _id: 0 } })
    .toArray()
}

function loadModels(db) {
  return db
    .collection('models')
    .find({}, { projection: { _id: 0 } })
    .toArray()
}

describe('#syncCatalogue', () => {
  let server
  let db

  beforeAll(async () => {
    // Dynamic import needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')

    server = await createServer()
    await server.initialize()
    db = server.db
  })

  afterAll(async () => {
    await server.stop({ timeout: 0 })
  })

  test('upserts models with catalogueSha, release and syncedAt', async () => {
    const existingModels = await loadModels(db)
    const source = stubSource({
      models: [
        ...existingModels,
        { slug: 'sync-test-a', ...OPENAI, eligible: true }
      ],
      providers: [...(await loadProviders(db)), { id: 'sync-test-provider' }],
      catalogueSha: 'sha-1',
      release: 'v1.0.0'
    })

    const result = await syncCatalogue(db, source, server.locker, server.logger)

    expect(result).toEqual({ synced: existingModels.length + 1, retired: 0 })

    const doc = await db.collection('models').findOne({ slug: 'sync-test-a' })
    expect(doc.catalogueSha).toBe('sha-1')
    expect(doc.release).toBe('v1.0.0')
    expect(doc.syncedAt).toEqual(expect.any(String))

    const provider = await db
      .collection('providers')
      .findOne({ id: 'sync-test-provider' })
    expect(provider.catalogueSha).toBe('sha-1')
  })

  test('normalises the github source shape (nested eligibility, regions array) to flat eligible/region', async () => {
    const source = stubSource({
      models: [
        ...(await loadModels(db)),
        {
          slug: 'sync-test-github-shape',
          ...OPENAI,
          eligibility: { eligible: true, reason: null },
          regions: ['uksouth'],
          apiProfile: 'chat-completions'
        }
      ],
      providers: await loadProviders(db),
      catalogueSha: 'sha-github',
      release: 'v1.0.4'
    })

    await syncCatalogue(db, source, server.locker, server.logger)

    const doc = await db
      .collection('models')
      .findOne({ slug: 'sync-test-github-shape' })
    expect(doc.eligible).toBe(true)
    expect(doc.eligibilityReason).toBeNull()
    expect(doc.region).toBe('uksouth')
    expect(doc.apiVersion).toBe('2024-05-01-preview')
  })

  test('defaults apiVersion per apiProfile when the source has none, pinning responses to its own api-version', async () => {
    const source = stubSource({
      models: [
        ...(await loadModels(db)),
        {
          slug: 'sync-test-responses-profile',
          ...OPENAI,
          apiProfile: 'responses'
        }
      ],
      providers: await loadProviders(db),
      catalogueSha: 'sha-github-2',
      release: 'v1.0.5'
    })

    await syncCatalogue(db, source, server.locker, server.logger)

    const doc = await db
      .collection('models')
      .findOne({ slug: 'sync-test-responses-profile' })
    expect(doc.apiVersion).toBe('2025-03-01-preview')
  })

  test('overrides a source-supplied apiVersion for a responses-profile model, since the source has shipped a stale generic value for one', async () => {
    const source = stubSource({
      models: [
        ...(await loadModels(db)),
        {
          slug: 'sync-test-responses-stale-version',
          ...OPENAI,
          apiProfile: 'responses',
          apiVersion: '2024-05-01-preview'
        }
      ],
      providers: await loadProviders(db),
      catalogueSha: 'sha-github-3',
      release: 'v1.0.6'
    })

    await syncCatalogue(db, source, server.locker, server.logger)

    const doc = await db
      .collection('models')
      .findOne({ slug: 'sync-test-responses-stale-version' })
    expect(doc.apiVersion).toBe('2025-03-01-preview')
  })

  test('retires a model no longer present in the catalogue, without deleting it', async () => {
    await db.collection('models').insertOne({
      slug: 'sync-test-retiring',
      ...OPENAI,
      eligible: true,
      lifecycle: { status: 'available' }
    })

    const keepModels = (await loadModels(db)).filter(
      (model) => model.slug !== 'sync-test-retiring'
    )

    const source = stubSource({
      models: keepModels,
      providers: await loadProviders(db),
      catalogueSha: 'sha-2',
      release: 'v1.0.1'
    })

    const result = await syncCatalogue(db, source, server.locker, server.logger)

    expect(result.retired).toBe(1)

    const retired = await db
      .collection('models')
      .findOne({ slug: 'sync-test-retiring' })
    expect(retired).not.toBeNull()
    expect(retired.eligible).toBe(false)
    expect(retired.lifecycle.status).toBe('retired')
  })

  test('derives nested hosting and gateway from a bedrock-platform offering that still uses the azure-apim gateway', async () => {
    const source = stubSource({
      models: [
        ...(await loadModels(db)),
        {
          slug: 'sync-test-bedrock',
          provider: 'sync-anthropic',
          offering: 'bedrock-anthropic',
          eligible: true
        }
      ],
      providers: [
        ...(await loadProviders(db)),
        {
          id: 'sync-anthropic',
          offerings: [
            {
              id: 'bedrock-anthropic',
              hosting: { platform: 'bedrock', cloud: 'aws' },
              gateway: 'azure-apim'
            }
          ]
        }
      ],
      catalogueSha: 'sha-cloud',
      release: 'v1.0.5'
    })

    await syncCatalogue(db, source, server.locker, server.logger)

    const doc = await db
      .collection('models')
      .findOne({ slug: 'sync-test-bedrock' })
    expect(doc.hosting).toEqual({
      platform: 'bedrock',
      cloud: 'aws',
      provider: null
    })
    expect(doc.gateway).toBe('azure-apim')
  })

  test('a direct offering yields hosting.provider and a null hosting.cloud', async () => {
    const source = stubSource({
      models: [
        ...(await loadModels(db)),
        {
          slug: 'sync-test-direct',
          provider: 'sync-meta',
          offering: 'meta-direct',
          eligible: true
        }
      ],
      providers: [
        ...(await loadProviders(db)),
        {
          id: 'sync-meta',
          offerings: [
            {
              id: 'meta-direct',
              hosting: { platform: 'direct', provider: 'meta' },
              gateway: 'azure-apim'
            }
          ]
        }
      ],
      catalogueSha: 'sha-direct',
      release: 'v1.0.5'
    })

    await syncCatalogue(db, source, server.locker, server.logger)

    const doc = await db
      .collection('models')
      .findOne({ slug: 'sync-test-direct' })
    expect(doc.hosting).toEqual({
      platform: 'direct',
      cloud: null,
      provider: 'meta'
    })
  })

  test('drops the $schema editor key from a provider file before storing it', async () => {
    const source = stubSource({
      models: await loadModels(db),
      providers: [
        ...(await loadProviders(db)),
        {
          $schema: '../schema/provider.schema.json',
          id: 'sync-schema-key',
          offerings: []
        }
      ],
      catalogueSha: 'sha-schema-key',
      release: 'v0.2.0'
    })

    await syncCatalogue(db, source, server.locker, server.logger)

    const provider = await db
      .collection('providers')
      .findOne({ id: 'sync-schema-key' })
    expect(provider).not.toBeNull()
    expect(provider).not.toHaveProperty('$schema')
  })

  test.each([
    [
      'lists the same offering id twice',
      [
        {
          id: 'dup',
          hosting: { platform: 'foundry', cloud: 'azure' },
          gateway: 'azure-apim'
        },
        {
          id: 'dup',
          hosting: { platform: 'foundry', cloud: 'azure' },
          gateway: 'azure-apim'
        }
      ]
    ],
    [
      'has an offering without hosting or gateway',
      [{ id: 'flat', cloud: 'azure' }]
    ]
  ])('skips the whole sync when a provider %s', async (_label, offerings) => {
    const source = stubSource({
      models: [
        ...(await loadModels(db)),
        { slug: 'sync-test-invalid-offering', ...OPENAI, eligible: true }
      ],
      providers: [
        ...(await loadProviders(db)),
        { id: 'sync-invalid', offerings }
      ],
      catalogueSha: 'sha-invalid',
      release: 'v0.2.0'
    })

    const result = await syncCatalogue(db, source, server.locker, server.logger)

    expect(result).toEqual({ synced: 0, retired: 0, skipped: true })
    expect(
      await db
        .collection('models')
        .findOne({ slug: 'sync-test-invalid-offering' })
    ).toBeNull()
  })

  test.each([
    ['no provider or offering', undefined, undefined],
    ['an unknown provider', 'sync-no-such-provider', 'azure-openai'],
    ['an unknown offering', 'openai', 'no-such-offering']
  ])(
    'skips a model with %s rather than defaulting its hosting',
    async (_label, provider, offering) => {
      const existingModels = await loadModels(db)
      const source = stubSource({
        models: [
          ...existingModels,
          { slug: 'sync-test-unresolved', provider, offering, eligible: true }
        ],
        providers: await loadProviders(db),
        catalogueSha: 'sha-unresolved',
        release: 'v1.0.7'
      })

      const result = await syncCatalogue(
        db,
        source,
        server.locker,
        server.logger
      )

      expect(result.synced).toBe(existingModels.length)
      expect(
        await db.collection('models').findOne({ slug: 'sync-test-unresolved' })
      ).toBeNull()
    }
  )

  test('skips the sync (does not retire anything) when the source returns zero models', async () => {
    const source = stubSource({
      models: [],
      providers: [],
      catalogueSha: 'sha-3',
      release: 'v1.0.2'
    })

    const result = await syncCatalogue(db, source, server.locker, server.logger)

    expect(result).toEqual({ synced: 0, retired: 0, skipped: true })

    const stillThere = await db
      .collection('models')
      .findOne({ slug: 'sync-test-a' })
    expect(stillThere).not.toBeNull()
    expect(stillThere.eligible).toBe(true)
  })

  test('skips when the catalogue-sync lock is already held', async () => {
    const lock = await server.locker.lock('catalogue-sync')
    const source = stubSource({
      models: [{ slug: 'sync-test-b' }],
      providers: [],
      catalogueSha: 'sha-4',
      release: 'v1.0.3'
    })

    try {
      const result = await syncCatalogue(
        db,
        source,
        server.locker,
        server.logger
      )

      expect(result).toEqual({ synced: 0, retired: 0, skipped: true })
      expect(source.fetchCatalogue).not.toHaveBeenCalled()
    } finally {
      await lock.free()
    }
  })
})

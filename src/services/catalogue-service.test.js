import { syncCatalogue } from '#/services/catalogue-service.js'

function stubSource(result) {
  return { fetchCatalogue: vi.fn().mockResolvedValue(result) }
}

function loadProviders(db) {
  return db
    .collection('providers')
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
    const existingModels = await db
      .collection('models')
      .find({}, { projection: { _id: 0 } })
      .toArray()
    const source = stubSource({
      models: [...existingModels, { slug: 'sync-test-a', eligible: true }],
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
    const existingModels = await db
      .collection('models')
      .find({}, { projection: { _id: 0 } })
      .toArray()
    const source = stubSource({
      models: [
        ...existingModels,
        {
          slug: 'sync-test-github-shape',
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
    const existingModels = await db
      .collection('models')
      .find({}, { projection: { _id: 0 } })
      .toArray()
    const source = stubSource({
      models: [
        ...existingModels,
        { slug: 'sync-test-responses-profile', apiProfile: 'responses' }
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
    const existingModels = await db
      .collection('models')
      .find({}, { projection: { _id: 0 } })
      .toArray()
    const source = stubSource({
      models: [
        ...existingModels,
        {
          slug: 'sync-test-responses-stale-version',
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
      eligible: true,
      lifecycle: { status: 'available' }
    })

    const keepModels = await db
      .collection('models')
      .find({ slug: { $ne: 'sync-test-retiring' } }, { projection: { _id: 0 } })
      .toArray()

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
    const existingModels = await db
      .collection('models')
      .find({}, { projection: { _id: 0 } })
      .toArray()
    const source = stubSource({
      models: [
        ...existingModels,
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
    expect(doc).not.toHaveProperty('cloud')
    expect(doc).not.toHaveProperty('adapter')
  })

  test('a direct offering yields hosting.provider and a null hosting.cloud', async () => {
    const existingModels = await db
      .collection('models')
      .find({}, { projection: { _id: 0 } })
      .toArray()
    const source = stubSource({
      models: [
        ...existingModels,
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

  test('reads a flat v0.1.x offering and lifts it into the nested shape', async () => {
    const existingModels = await db
      .collection('models')
      .find({}, { projection: { _id: 0 } })
      .toArray()
    const source = stubSource({
      models: [
        ...existingModels,
        {
          slug: 'sync-test-flat-offering',
          provider: 'sync-flat',
          offering: 'azure-openai',
          eligible: true
        }
      ],
      providers: [
        ...(await loadProviders(db)),
        {
          id: 'sync-flat',
          offerings: [
            { id: 'azure-openai', cloud: 'azure', adapter: 'azure-apim' }
          ]
        }
      ],
      catalogueSha: 'sha-flat',
      release: 'v0.1.2'
    })

    await syncCatalogue(db, source, server.locker, server.logger)

    const doc = await db
      .collection('models')
      .findOne({ slug: 'sync-test-flat-offering' })
    expect(doc.hosting).toEqual({
      platform: 'foundry',
      cloud: 'azure',
      provider: null
    })
    expect(doc.gateway).toBe('azure-apim')
    expect(doc).not.toHaveProperty('cloud')
    expect(doc).not.toHaveProperty('adapter')
  })

  test('defaults to foundry/azure/azure-apim for a legacy release whose offerings are plain strings', async () => {
    const existingModels = await db
      .collection('models')
      .find({}, { projection: { _id: 0 } })
      .toArray()
    const source = stubSource({
      models: [
        ...existingModels,
        {
          slug: 'sync-test-legacy',
          provider: 'sync-legacy',
          offering: 'azure-openai',
          eligible: true
        }
      ],
      providers: [
        ...(await loadProviders(db)),
        { id: 'sync-legacy', offerings: ['azure-openai'] }
      ],
      catalogueSha: 'sha-legacy',
      release: 'v0.1.1'
    })

    await syncCatalogue(db, source, server.locker, server.logger)

    const doc = await db
      .collection('models')
      .findOne({ slug: 'sync-test-legacy' })
    expect(doc.hosting).toEqual({
      platform: 'foundry',
      cloud: 'azure',
      provider: null
    })
    expect(doc.gateway).toBe('azure-apim')
  })

  test('removes flat cloud/adapter from a previously synced document on re-sync', async () => {
    await db.collection('models').insertOne({
      slug: 'sync-test-flat-stale',
      provider: 'openai',
      offering: 'azure-openai',
      cloud: 'azure',
      adapter: 'azure-apim',
      eligible: true
    })
    const existingModels = await db
      .collection('models')
      .find({}, { projection: { _id: 0 } })
      .toArray()
    const source = stubSource({
      models: existingModels.map(({ cloud, adapter, ...model }) => model),
      providers: await loadProviders(db),
      catalogueSha: 'sha-stale',
      release: 'v0.2.0'
    })

    await syncCatalogue(db, source, server.locker, server.logger)

    const doc = await db
      .collection('models')
      .findOne({ slug: 'sync-test-flat-stale' })
    expect(doc.hosting.platform).toBe('foundry')
    expect(doc.gateway).toBe('azure-apim')
    expect(doc).not.toHaveProperty('cloud')
    expect(doc).not.toHaveProperty('adapter')
  })

  test('drops the $schema editor key from a provider file before storing it', async () => {
    const existingModels = await db
      .collection('models')
      .find({}, { projection: { _id: 0 } })
      .toArray()
    const source = stubSource({
      models: existingModels,
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

  test('skips the whole sync when a provider lists the same offering id twice', async () => {
    const existingModels = await db
      .collection('models')
      .find({}, { projection: { _id: 0 } })
      .toArray()
    const source = stubSource({
      models: [
        ...existingModels,
        { slug: 'sync-test-duplicate-offering', eligible: true }
      ],
      providers: [
        ...(await loadProviders(db)),
        {
          id: 'sync-duplicate',
          offerings: [
            { id: 'dup', hosting: { platform: 'foundry', cloud: 'azure' } },
            { id: 'dup', hosting: { platform: 'foundry', cloud: 'azure' } }
          ]
        }
      ],
      catalogueSha: 'sha-duplicate',
      release: 'v0.2.0'
    })

    const result = await syncCatalogue(db, source, server.locker, server.logger)

    expect(result).toEqual({ synced: 0, retired: 0, skipped: true })
    expect(
      await db
        .collection('models')
        .findOne({ slug: 'sync-test-duplicate-offering' })
    ).toBeNull()
  })

  test('skips a model whose cloud/adapter contradict its provider offering', async () => {
    const existingModels = await db
      .collection('models')
      .find({}, { projection: { _id: 0 } })
      .toArray()
    const source = stubSource({
      models: [
        ...existingModels,
        {
          slug: 'sync-test-mismatch',
          provider: 'sync-mismatch',
          offering: 'azure-openai',
          cloud: 'aws',
          adapter: 'aws-bedrock',
          eligible: true
        }
      ],
      providers: [
        ...(await loadProviders(db)),
        {
          id: 'sync-mismatch',
          offerings: [
            { id: 'azure-openai', cloud: 'azure', adapter: 'azure-apim' }
          ]
        }
      ],
      catalogueSha: 'sha-mismatch',
      release: 'v1.0.6'
    })

    const result = await syncCatalogue(db, source, server.locker, server.logger)

    expect(result.synced).toBe(existingModels.length)
    expect(
      await db.collection('models').findOne({ slug: 'sync-test-mismatch' })
    ).toBeNull()
  })

  test.each([
    ['an unknown provider', 'sync-no-such-provider', 'azure-openai'],
    ['an unknown offering', 'openai', 'no-such-offering']
  ])(
    'skips a model referencing %s rather than defaulting it to azure/azure-apim',
    async (_label, provider, offering) => {
      const existingModels = await db
        .collection('models')
        .find({}, { projection: { _id: 0 } })
        .toArray()
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

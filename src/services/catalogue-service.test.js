import { syncCatalogue } from '#/services/catalogue-service.js'

function stubSource(result) {
  return { fetchCatalogue: vi.fn().mockResolvedValue(result) }
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
      providers: [{ id: 'sync-test-provider' }],
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
      providers: [],
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
      providers: [],
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
      providers: [],
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
      providers: [],
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

  test('derives cloud and adapter from the provider offering when the model omits them', async () => {
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
        {
          id: 'sync-anthropic',
          offerings: [
            { id: 'bedrock-anthropic', cloud: 'aws', adapter: 'aws-bedrock' }
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
    expect(doc.cloud).toBe('aws')
    expect(doc.adapter).toBe('aws-bedrock')
  })

  test('defaults to azure/azure-apim for a legacy release whose offerings are plain strings', async () => {
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
      providers: [{ id: 'sync-legacy', offerings: ['azure-openai'] }],
      catalogueSha: 'sha-legacy',
      release: 'v0.1.1'
    })

    await syncCatalogue(db, source, server.locker, server.logger)

    const doc = await db
      .collection('models')
      .findOne({ slug: 'sync-test-legacy' })
    expect(doc.cloud).toBe('azure')
    expect(doc.adapter).toBe('azure-apim')
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

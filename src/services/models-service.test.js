import {
  listModels,
  findModelBySlug,
  invalidateModelsCache
} from '#/services/models-service.js'

function fakeDb(models) {
  return {
    collection: () => ({
      find: (query) => ({
        toArray: async () =>
          models.filter((model) =>
            Object.entries(query).every(([key, value]) =>
              key === 'tiers'
                ? model.tiers?.includes(value)
                : model[key] === value
            )
          )
      }),
      findOne: async (query) =>
        models.find((model) => model.slug === query.slug) ?? null
    })
  }
}

describe('#models-service caching', () => {
  beforeEach(() => {
    invalidateModelsCache()
  })

  test('listModels caches results for the same filters', async () => {
    const models = [{ slug: 'a', eligible: true }]
    const db = fakeDb(models)
    const findSpy = vi.spyOn(db, 'collection')

    await listModels(db, { provider: 'openai' })
    await listModels(db, { provider: 'openai' })

    expect(findSpy).toHaveBeenCalledTimes(1)
  })

  test('listModels re-queries for different filters', async () => {
    const db = fakeDb([{ slug: 'a', eligible: true }])
    const findSpy = vi.spyOn(db, 'collection')

    await listModels(db, { provider: 'openai' })
    await listModels(db, { provider: 'anthropic' })

    expect(findSpy).toHaveBeenCalledTimes(2)
  })

  test('listModels excludes ineligible models by default', async () => {
    const db = fakeDb([
      { slug: 'a', eligible: true },
      { slug: 'b', eligible: false }
    ])

    const items = await listModels(db)

    expect(items.map((model) => model.slug)).toEqual(['a'])
  })

  test('listModels with includeIneligible returns ineligible models too', async () => {
    const db = fakeDb([
      { slug: 'a', eligible: true },
      { slug: 'b', eligible: false }
    ])

    const items = await listModels(db, { includeIneligible: true })

    expect(items.map((model) => model.slug).sort()).toEqual(['a', 'b'])
  })

  test('findModelBySlug caches results, including misses', async () => {
    const db = fakeDb([{ slug: 'a', eligible: true }])
    const findSpy = vi.spyOn(db, 'collection')

    await findModelBySlug(db, 'missing')
    await findModelBySlug(db, 'missing')

    expect(findSpy).toHaveBeenCalledTimes(1)
  })

  test('invalidateModelsCache forces a re-query', async () => {
    const db = fakeDb([{ slug: 'a', eligible: true }])
    const findSpy = vi.spyOn(db, 'collection')

    await findModelBySlug(db, 'a')
    invalidateModelsCache()
    await findModelBySlug(db, 'a')

    expect(findSpy).toHaveBeenCalledTimes(2)
  })
})

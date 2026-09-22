import {
  listEligibleModels,
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
              key === 'tiers' ? model.tiers?.includes(value) : model[key] === value
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

  test('listEligibleModels caches results for the same filters', async () => {
    const models = [{ slug: 'a', eligible: true }]
    const db = fakeDb(models)
    const findSpy = vi.spyOn(db, 'collection')

    await listEligibleModels(db, { provider: 'openai' })
    await listEligibleModels(db, { provider: 'openai' })

    expect(findSpy).toHaveBeenCalledTimes(1)
  })

  test('listEligibleModels re-queries for different filters', async () => {
    const db = fakeDb([{ slug: 'a', eligible: true }])
    const findSpy = vi.spyOn(db, 'collection')

    await listEligibleModels(db, { provider: 'openai' })
    await listEligibleModels(db, { provider: 'anthropic' })

    expect(findSpy).toHaveBeenCalledTimes(2)
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

import { createFileCatalogueSource } from '#/adapters/file-catalogue-source.js'

describe('#createFileCatalogueSource', () => {
  test('reads the committed seed fixtures and returns a stable catalogueSha', async () => {
    const source = createFileCatalogueSource()

    const result = await source.fetchCatalogue()

    expect(result.models.length).toBeGreaterThan(0)
    expect(result.models[0]).toHaveProperty('slug')
    expect(result.providers).toEqual([
      expect.objectContaining({ id: 'openai' })
    ])
    expect(result.release).toBe('local')
    expect(result.catalogueSha).toEqual(expect.any(String))
  })

  test('reads from custom fixture paths when provided', async () => {
    const source = createFileCatalogueSource({
      modelsPath: new URL('./fixtures/models.json', import.meta.url),
      providersPath: new URL('./fixtures/providers.json', import.meta.url)
    })

    const result = await source.fetchCatalogue()

    expect(result.models).toEqual([{ slug: 'fixture-model' }])
    expect(result.providers).toEqual([{ id: 'fixture-provider' }])
  })
})

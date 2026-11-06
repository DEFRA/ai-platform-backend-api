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

  test('fingerprints the catalogue with a repeatable SHA-256 digest', async () => {
    const source = createFileCatalogueSource({
      modelsPath: new URL('./fixtures/models.json', import.meta.url),
      providersPath: new URL('./fixtures/providers.json', import.meta.url)
    })

    const first = await source.fetchCatalogue()
    const second = await source.fetchCatalogue()

    expect(first.catalogueSha).toBe(
      '14953e111333f8a918190a2a0a7fdc49b11b6b2ebcb460e04f672f9bd628bbd6'
    )
    expect(second.catalogueSha).toBe(first.catalogueSha)
  })
})

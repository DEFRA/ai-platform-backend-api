describe('catalogue-service imports', () => {
  afterEach(() => {
    vi.doUnmock('#/config.js')
    vi.resetModules()
  })

  test('does not load the config until a research read needs it', async () => {
    const loadConfig = vi.fn(() => ({ config: { get: vi.fn() } }))

    vi.resetModules()
    vi.doMock('#/config.js', loadConfig)

    await import('#/services/catalogue-service.js')

    expect(loadConfig).not.toHaveBeenCalled()
  })
})

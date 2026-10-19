import { createTenantOrchestratorRegistry } from '#/adapters/tenant-orchestrator-registry.js'

describe('#createTenantOrchestratorRegistry', () => {
  const mock = { id: 'mock-orchestrator' }
  const github = { id: 'github-orchestrator' }
  const orchestratorsByKey = { mock, github }

  test('submits new deployments through the configured orchestrator', () => {
    const registry = createTenantOrchestratorRegistry(
      orchestratorsByKey,
      'github',
      'dev'
    )

    expect(registry.key).toBe('github')
    expect(registry.orchestrator).toBe(github)
  })

  test('resolves an entry to the orchestrator that submitted it, whatever the mode', () => {
    const registry = createTenantOrchestratorRegistry(
      orchestratorsByKey,
      'github',
      'dev'
    )

    expect(registry.forEntry({ orchestrator: 'mock' })).toBe(mock)
    expect(registry.forEntry({ orchestrator: 'github' })).toBe(github)
  })

  test('treats an entry from before the orchestrator was recorded as mock', () => {
    const registry = createTenantOrchestratorRegistry(
      orchestratorsByKey,
      'github',
      'dev'
    )

    expect(registry.forEntry({})).toBe(mock)
  })

  test('refuses to start with the mock orchestrator in prod', () => {
    expect(() =>
      createTenantOrchestratorRegistry(orchestratorsByKey, 'mock', 'prod')
    ).toThrow('TENANT_ORCHESTRATOR must not be "mock" in the prod environment')
  })

  test('starts with the github orchestrator in prod', () => {
    expect(
      createTenantOrchestratorRegistry(orchestratorsByKey, 'github', 'prod')
        .orchestrator
    ).toBe(github)
  })

  test('refuses an orchestrator it has no adapter for', () => {
    expect(() =>
      createTenantOrchestratorRegistry({ mock }, 'github', 'dev')
    ).toThrow('No tenant orchestrator registered for "github"')
  })
})

describe('#tenantOrchestratorRegistry', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  test('throws at registration when prod is configured with the mock orchestrator', async () => {
    vi.resetModules()
    vi.stubEnv('ENVIRONMENT', 'prod')
    vi.stubEnv('PROVISIONING_MODE', 'live')
    vi.stubEnv('AZURE_ARM_TENANT_ID', 'tenant')
    vi.stubEnv('AZURE_ARM_CLIENT_ID', 'client')
    vi.stubEnv('AZURE_ARM_CLIENT_SECRET', 'secret')
    vi.stubEnv('AZURE_ARM_SUBSCRIPTION_ID', 'subscription')
    vi.stubEnv('AZURE_ARM_RESOURCE_GROUP', 'rg')
    vi.stubEnv('APIM_SERVICE_NAME', 'apim')
    vi.stubEnv('AZURE_KEY_VAULT_NAME', 'vault')

    await expect(
      import('#/adapters/tenant-orchestrator-registry.js')
    ).rejects.toThrow(
      'TENANT_ORCHESTRATOR must not be "mock" in the prod environment'
    )
  })
})

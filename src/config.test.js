const armEnv = {
  AZURE_ARM_TENANT_ID: 'tenant',
  AZURE_ARM_CLIENT_ID: 'client',
  AZURE_ARM_CLIENT_SECRET: 'secret',
  AZURE_ARM_SUBSCRIPTION_ID: 'subscription',
  AZURE_ARM_RESOURCE_GROUP: 'rg',
  APIM_SERVICE_NAME: 'apim',
  AZURE_KEY_VAULT_NAME: 'vault'
}

async function loadConfig(env) {
  vi.resetModules()

  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value)
  }

  return import('#/config.js')
}

describe('#config provisioning', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('defaults to mock mode with azure-apim enabled', async () => {
    const { config } = await loadConfig({ PROVISIONING_MODE: 'mock' })

    expect(config.get('provisioning.mode')).toBe('mock')
    expect(config.get('provisioning.gateways')).toEqual(['azure-apim'])
  })

  test('treats the deprecated azure mode as live', async () => {
    const { config } = await loadConfig({
      PROVISIONING_MODE: 'azure',
      ...armEnv
    })

    expect(config.get('provisioning.mode')).toBe('live')
  })

  test('live mode requires the config of every enabled gateway', async () => {
    await expect(loadConfig({ PROVISIONING_MODE: 'live' })).rejects.toThrow(
      /Gateway azure-apim requires .*armAuth\.tenantId/
    )
  })

  test('live mode rejects a gateway the backend cannot run', async () => {
    await expect(
      loadConfig({
        PROVISIONING_MODE: 'live',
        ENABLED_GATEWAYS: 'azure-apim,aws-apigw',
        ...armEnv
      })
    ).rejects.toThrow('unknown gateway "aws-apigw"')
  })

  test('does not validate gateway config in mock mode', async () => {
    const { config } = await loadConfig({
      PROVISIONING_MODE: 'mock',
      ENABLED_GATEWAYS: 'aws-apigw'
    })

    expect(config.get('provisioning.gateways')).toEqual(['aws-apigw'])
  })

  test('reads MOCK_TIERS as a list, empty by default', async () => {
    const { config } = await loadConfig({
      PROVISIONING_MODE: 'live',
      MOCK_TIERS: 'team',
      ...armEnv
    })

    expect(config.get('provisioning.mockTiers')).toEqual(['team'])
  })

  test('rejects an unknown tier in MOCK_TIERS', async () => {
    await expect(
      loadConfig({
        PROVISIONING_MODE: 'live',
        MOCK_TIERS: 'dedicated',
        ...armEnv
      })
    ).rejects.toThrow('unknown tier "dedicated"')
  })

  test('refuses MOCK_TIERS in the prod environment', async () => {
    await expect(
      loadConfig({
        ENVIRONMENT: 'prod',
        PROVISIONING_MODE: 'live',
        MOCK_TIERS: 'team',
        ...armEnv
      })
    ).rejects.toThrow('MOCK_TIERS must be empty in the prod environment')
  })
})

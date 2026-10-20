const armEnv = {
  AZURE_ARM_TENANT_ID: 'tenant',
  AZURE_ARM_CLIENT_ID: 'client',
  AZURE_ARM_CLIENT_SECRET: 'secret',
  AZURE_ARM_SUBSCRIPTION_ID: 'subscription',
  AZURE_ARM_RESOURCE_GROUP: 'rg',
  APIM_SERVICE_NAME: 'apim',
  AZURE_KEY_VAULT_NAME: 'vault'
}

// Federated auth has no client secret - the AWS STS token proves identity instead.
const armEnvFederated = Object.fromEntries(
  Object.entries(armEnv).filter(([key]) => key !== 'AZURE_ARM_CLIENT_SECRET')
)

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

describe('#config armAuth.authMethod', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('client-secret (the default) requires armAuth.clientSecret', async () => {
    await expect(
      loadConfig({ PROVISIONING_MODE: 'live', ...armEnvFederated })
    ).rejects.toThrow(/Gateway azure-apim requires .*armAuth\.clientSecret/)
  })

  test('federated does not require armAuth.clientSecret', async () => {
    const { config } = await loadConfig({
      PROVISIONING_MODE: 'live',
      AZURE_ARM_AUTH_METHOD: 'federated',
      ...armEnvFederated
    })

    expect(config.get('armAuth.authMethod')).toBe('federated')
  })

  test('federated requires armAuth.federatedAudience', async () => {
    await expect(
      loadConfig({
        PROVISIONING_MODE: 'live',
        AZURE_ARM_AUTH_METHOD: 'federated',
        AZURE_ARM_FEDERATED_AUDIENCE: '',
        ...armEnvFederated
      })
    ).rejects.toThrow(
      /Gateway azure-apim requires .*armAuth\.federatedAudience/
    )
  })
})

describe('#config tenant orchestrator and GitOps', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('defaults to the mock orchestrator, the DEFRA state repositories, a 30 second poll interval and a 10 minute claim lease', async () => {
    const { config } = await loadConfig({})

    expect(config.get('tenantOrchestrator')).toBe('mock')
    expect(config.get('gitops')).toEqual({
      tenantsRepo: 'DEFRA/ai-platform-tenants',
      deploymentsRepo: 'DEFRA/ai-platform-deployments',
      pollMinIntervalMs: 30000,
      claimLeaseMs: 600000,
      verifyMaxAttempts: 5
    })
    expect(config.get('aipEnvironments')).toEqual({})
  })

  test('parses AIP_ENVIRONMENTS from JSON', async () => {
    const infradev = {
      subscriptionId: '00000000-0000-0000-0000-000000000000',
      resourceGroup: 'rg-placeholder',
      apimName: 'apim-placeholder',
      foundryAccounts: ['aif-placeholder'],
      tenantsVault: 'kv-placeholder'
    }

    const { config } = await loadConfig({
      AIP_ENVIRONMENTS: JSON.stringify({ infradev })
    })

    expect(config.get('aipEnvironments')).toEqual({ infradev })
  })

  test('rejects an AIP_ENVIRONMENTS entry missing a setting', async () => {
    await expect(
      loadConfig({ AIP_ENVIRONMENTS: JSON.stringify({ infradev: {} }) })
    ).rejects.toThrow(/subscriptionId/)
  })

  test('the github orchestrator requires GitHub App credentials, not a PAT', async () => {
    await expect(
      loadConfig({ TENANT_ORCHESTRATOR: 'github', GITHUB_TOKEN: 'pat' })
    ).rejects.toThrow('TENANT_ORCHESTRATOR=github requires GITHUB_CLIENT_ID')
  })

  test('accepts the github orchestrator with GitHub App credentials', async () => {
    const { config } = await loadConfig({
      TENANT_ORCHESTRATOR: 'github',
      GITHUB_CLIENT_ID: 'Iv1.placeholder',
      GITHUB_APP_INSTALLATION_ID: '1',
      GITHUB_APP_PRIVATE_KEY: 'cGxhY2Vob2xkZXI='
    })

    expect(config.get('tenantOrchestrator')).toBe('github')
  })
})

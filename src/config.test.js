const infradev = {
  subscriptionId: '00000000-0000-0000-0000-000000000000',
  resourceGroup: 'rg-placeholder',
  apimName: 'apim-placeholder',
  foundryAccounts: ['aif-placeholder'],
  tenantsVault: 'kv-placeholder'
}

const armEnv = {
  AZURE_ARM_TENANT_ID: 'tenant',
  AZURE_ARM_CLIENT_ID: 'client',
  AZURE_ARM_CLIENT_SECRET: 'secret',
  AIP_ENVIRONMENTS: JSON.stringify({ infradev })
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

describe('#config research environment', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('caches the research deployments for a minute by default, configurable', async () => {
    const { config } = await loadConfig({})
    const { config: tuned } = await loadConfig({
      RESEARCH_DEPLOYMENTS_CACHE_MS: '5000'
    })

    expect(config.get('research.deploymentsCacheMs')).toBe(60000)
    expect(tuned.get('research.deploymentsCacheMs')).toBe(5000)
  })

  test('defaults to infradev', async () => {
    const { config } = await loadConfig({})

    expect(config.get('research.environment')).toBe('infradev')
  })

  test('refuses a research environment that is not an environment name', async () => {
    await expect(
      loadConfig({ RESEARCH_ENVIRONMENT: 'Infra Dev' })
    ).rejects.toThrow('RESEARCH_ENVIRONMENT must be a lowercase environment')
  })

  test('live mode refuses a research environment missing from AIP_ENVIRONMENTS', async () => {
    await expect(
      loadConfig({
        PROVISIONING_MODE: 'live',
        RESEARCH_ENVIRONMENT: 'sandbox',
        ...armEnv
      })
    ).rejects.toThrow(
      'RESEARCH_ENVIRONMENT "sandbox" must be in AIP_ENVIRONMENTS'
    )
  })

  test('live mode refuses to boot with no AIP_ENVIRONMENTS at all', async () => {
    await expect(
      loadConfig({
        PROVISIONING_MODE: 'live',
        ...armEnv,
        AIP_ENVIRONMENTS: '{}'
      })
    ).rejects.toThrow('RESEARCH_ENVIRONMENT "infradev" must be in')
  })

  test('live mode accepts a research environment that is configured', async () => {
    const { config } = await loadConfig({
      PROVISIONING_MODE: 'live',
      ...armEnv
    })

    expect(config.get('research.environment')).toBe('infradev')
  })

  test('does not check the environment in mock mode or when research is mocked', async () => {
    await expect(
      loadConfig({ PROVISIONING_MODE: 'mock', AIP_ENVIRONMENTS: '{}' })
    ).resolves.toBeDefined()
    await expect(
      loadConfig({
        PROVISIONING_MODE: 'live',
        MOCK_TIERS: 'research',
        ...armEnv,
        AIP_ENVIRONMENTS: '{}'
      })
    ).resolves.toBeDefined()
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

  test('defaults to the mock orchestrator, the DEFRA state repositories and the GitOps timings', async () => {
    const { config } = await loadConfig({})

    expect(config.get('tenantOrchestrator')).toBe('mock')
    expect(config.get('gitops')).toEqual({
      tenantsRepo: 'DEFRA/ai-platform-tenants',
      deploymentsRepo: 'DEFRA/ai-platform-deployments',
      verifyMaxAttempts: 5,
      commandsQueueUrl: null,
      eventsQueueUrl: null,
      awsSqsEndpoint: null,
      awsRegion: 'eu-west-2',
      handlerTimeoutMs: 30000,
      sqsWaitTimeSeconds: 20,
      outboxSweepMs: 2000,
      sweepIntervalMs: 15000,
      reconcileGraceMs: 600000,
      deadlineRequestedMs: 600000,
      deadlineCommittedMs: 1800000,
      deadlineDeployingMs: 2700000,
      deadlineDeployedMs: 900000,
      resubmitMax: 3,
      revertGraceMs: 300000,
      deadlineHeldMs: 1800000,
      heldAlarmMs: 3600000
    })
    expect(config.get('aipEnvironments')).toEqual({})
  })

  const SQS_ENV = {
    TENANT_ORCHESTRATOR: 'sqs',
    GITOPS_COMMANDS_QUEUE_URL: 'http://sqs.test/commands.fifo',
    GITOPS_EVENTS_QUEUE_URL: 'http://sqs.test/events.fifo',
    GITHUB_APP_ID: '1',
    GITHUB_APP_INSTALLATION_ID: '2',
    GITHUB_APP_PRIVATE_KEY: 'cGxhY2Vob2xkZXI='
  }

  test('accepts the sqs orchestrator with both queues and GitHub App credentials', async () => {
    const { config } = await loadConfig(SQS_ENV)

    expect(config.get('tenantOrchestrator')).toBe('sqs')
    expect(config.get('gitops.commandsQueueUrl')).toBe(
      'http://sqs.test/commands.fifo'
    )
  })

  test('the sqs orchestrator requires GitHub App credentials', async () => {
    await expect(
      loadConfig({
        ...SQS_ENV,
        GITHUB_APP_ID: undefined,
        GITHUB_APP_INSTALLATION_ID: undefined,
        GITHUB_APP_PRIVATE_KEY: undefined
      })
    ).rejects.toThrow('TENANT_ORCHESTRATOR=sqs requires GITHUB_CLIENT_ID')
  })

  test.each([
    ['GITOPS_COMMANDS_QUEUE_URL', 'GITOPS_COMMANDS_QUEUE_URL to be set'],
    ['GITOPS_EVENTS_QUEUE_URL', 'GITOPS_EVENTS_QUEUE_URL to be set']
  ])('the sqs orchestrator requires %s', async (name, message) => {
    await expect(loadConfig({ ...SQS_ENV, [name]: undefined })).rejects.toThrow(
      message
    )
  })

  test('parses AIP_ENVIRONMENTS from JSON', async () => {
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

  test('refuses the github orchestrator, which no longer exists', async () => {
    await expect(
      loadConfig({
        TENANT_ORCHESTRATOR: 'github',
        GITHUB_APP_ID: '1',
        GITHUB_APP_INSTALLATION_ID: '2',
        GITHUB_APP_PRIVATE_KEY: 'cGxhY2Vob2xkZXI='
      })
    ).rejects.toThrow('must be one of the possible values: ["mock","sqs"]')
  })

  test.each([
    ['GITOPS_POLL_MIN_INTERVAL_MS', 'pollMinIntervalMs'],
    ['GITOPS_CLAIM_LEASE_MS', 'claimLeaseMs'],
    ['GITOPS_STALL_WARN_AFTER_MS', 'stallWarnAfterMs']
  ])('has no %s setting any more', async (name, key) => {
    const { config } = await loadConfig({ [name]: '1' })

    expect(config.get('gitops')).not.toHaveProperty(key)
  })
})

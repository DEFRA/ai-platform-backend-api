import {
  MOCK_ORCHESTRATOR,
  SQS_ORCHESTRATOR,
  createTenantOrchestratorRegistry,
  tenantOrchestratorRegistry
} from '#/adapters/tenant-orchestrator-registry.js'
import { mockTeamFileReader } from '#/adapters/mock-team-file-reader.js'
import { mockOutcomeOfPurpose } from '#/adapters/mock-gitops-worker.js'

describe('#createTenantOrchestratorRegistry', () => {
  const mock = {
    reader: { id: 'mock-reader' },
    createTransport: vi.fn(),
    mockOutcomeOf: vi.fn().mockReturnValue('deploy-failed')
  }
  const sqs = {
    reader: { id: 'github-reader' },
    createTransport: vi.fn()
  }
  const adaptersByMode = { [MOCK_ORCHESTRATOR]: mock, [SQS_ORCHESTRATOR]: sqs }

  test('provides the reader and the transport of the configured mode', () => {
    const registry = createTenantOrchestratorRegistry(
      adaptersByMode,
      SQS_ORCHESTRATOR,
      'dev'
    )

    expect(registry.key).toBe('sqs')
    expect(registry.reader).toBe(sqs.reader)
    expect(registry.createTransport).toBe(sqs.createTransport)
  })

  test('forces no outcome from a purpose unless the mode is the mock', () => {
    const live = createTenantOrchestratorRegistry(
      adaptersByMode,
      SQS_ORCHESTRATOR,
      'dev'
    )
    const staged = createTenantOrchestratorRegistry(
      adaptersByMode,
      MOCK_ORCHESTRATOR,
      'dev'
    )

    expect(live.mockOutcomeOf('[mock:deploy-failed]')).toBeNull()
    expect(staged.mockOutcomeOf('[mock:deploy-failed]')).toBe('deploy-failed')
  })

  test('refuses to start with the mock orchestrator in prod', () => {
    expect(() =>
      createTenantOrchestratorRegistry(
        adaptersByMode,
        MOCK_ORCHESTRATOR,
        'prod'
      )
    ).toThrow('TENANT_ORCHESTRATOR must not be "mock" in the prod environment')
  })

  test('starts with the sqs orchestrator in prod', () => {
    expect(
      createTenantOrchestratorRegistry(adaptersByMode, SQS_ORCHESTRATOR, 'prod')
        .reader
    ).toBe(sqs.reader)
  })

  test.each(['github', 'unknown'])(
    'refuses a mode it has no adapter for (%s)',
    (mode) => {
      expect(() =>
        createTenantOrchestratorRegistry(adaptersByMode, mode, 'dev')
      ).toThrow(`No tenant orchestrator registered for "${mode}"`)
    }
  )
})

describe('#tenantOrchestratorRegistry', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  test('is the mock in the tests: the mock reader, the mock transport and the purpose markers', () => {
    expect(tenantOrchestratorRegistry.key).toBe('mock')
    expect(tenantOrchestratorRegistry.reader).toBe(mockTeamFileReader)
    expect(tenantOrchestratorRegistry.mockOutcomeOf).toBe(mockOutcomeOfPurpose)
    expect(
      tenantOrchestratorRegistry.mockOutcomeOf('[mock:checks-failed]')
    ).toBe('checks-failed')
  })

  test('throws at registration when prod is configured with the mock orchestrator', async () => {
    vi.resetModules()
    vi.stubEnv('ENVIRONMENT', 'prod')
    vi.stubEnv('PROVISIONING_MODE', 'live')
    vi.stubEnv('AZURE_ARM_TENANT_ID', 'tenant')
    vi.stubEnv('AZURE_ARM_CLIENT_ID', 'client')
    vi.stubEnv('AZURE_ARM_CLIENT_SECRET', 'secret')
    vi.stubEnv(
      'AIP_ENVIRONMENTS',
      JSON.stringify({
        infradev: {
          subscriptionId: '00000000-0000-0000-0000-000000000000',
          resourceGroup: 'rg',
          apimName: 'apim',
          foundryAccounts: ['aif'],
          tenantsVault: 'vault'
        }
      })
    )

    await expect(
      import('#/adapters/tenant-orchestrator-registry.js')
    ).rejects.toThrow(
      'TENANT_ORCHESTRATOR must not be "mock" in the prod environment'
    )
  })
})

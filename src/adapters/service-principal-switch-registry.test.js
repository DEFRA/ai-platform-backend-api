import {
  selectServicePrincipalSwitch,
  servicePrincipalSwitch
} from '#/adapters/service-principal-switch-registry.js'
import { mockServicePrincipalSwitch } from '#/adapters/mock-service-principal-switch.js'

describe('#selectServicePrincipalSwitch', () => {
  const mock = { id: 'mock-switch' }
  const graph = { id: 'graph-switch' }

  test('selects the switch for the mode', () => {
    expect(selectServicePrincipalSwitch({ mock, graph }, 'mock', 'dev')).toBe(
      mock
    )
    expect(selectServicePrincipalSwitch({ mock, graph }, 'graph', 'prod')).toBe(
      graph
    )
  })

  test.each(['local', 'dev', 'test', 'perf-test', 'ext-test'])(
    'allows the mock in %s',
    (environment) => {
      expect(selectServicePrincipalSwitch({ mock }, 'mock', environment)).toBe(
        mock
      )
    }
  )

  test('refuses the mock in the prod environment, where a block would never reach Entra', () => {
    expect(() =>
      selectServicePrincipalSwitch({ mock }, 'mock', 'prod')
    ).toThrow(
      'SERVICE_PRINCIPAL_SWITCH must not be "mock" in the prod environment'
    )
  })

  test('refuses a mode it has no switch for', () => {
    expect(() =>
      selectServicePrincipalSwitch({ mock }, 'graph', 'dev')
    ).toThrow('No service principal switch for mode "graph"')
  })
})

describe('#servicePrincipalSwitch at start-up', () => {
  // Prod must get past the provisioning guards, which refuse the mock.
  const prod = {
    ENVIRONMENT: 'prod',
    PROVISIONING_MODE: 'live',
    AZURE_ARM_TENANT_ID: 'tenant',
    AZURE_ARM_CLIENT_ID: 'client',
    AZURE_ARM_CLIENT_SECRET: 'secret',
    AIP_ENVIRONMENTS: JSON.stringify({
      infradev: {
        subscriptionId: '00000000-0000-0000-0000-000000000000',
        resourceGroup: 'rg',
        apimName: 'apim',
        foundryAccounts: ['aif'],
        tenantsVault: 'vault'
      }
    })
  }

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  test('is the mock switch by default', () => {
    expect(servicePrincipalSwitch).toBe(mockServicePrincipalSwitch)
  })

  test('refuses the default mock in prod', async () => {
    vi.resetModules()

    for (const [key, value] of Object.entries(prod)) {
      vi.stubEnv(key, value)
    }

    await expect(
      import('#/adapters/service-principal-switch-registry.js')
    ).rejects.toThrow('must not be "mock"')
  })

  test('refuses a mode other than mock until the Graph adapter exists', async () => {
    vi.resetModules()
    vi.stubEnv('SERVICE_PRINCIPAL_SWITCH', 'graph')

    await expect(
      import('#/adapters/service-principal-switch-registry.js')
    ).rejects.toThrow()
  })
})

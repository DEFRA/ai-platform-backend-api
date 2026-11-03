import { directory, selectDirectory } from '#/adapters/directory-registry.js'
import { mockDirectory } from '#/adapters/mock-directory.js'

describe('#selectDirectory', () => {
  const mock = { searchPeople: async () => [], getPerson: async () => null }
  const graph = { searchPeople: async () => [], getPerson: async () => null }

  test('selects the directory for the directory mode', () => {
    expect(selectDirectory({ mock, graph }, 'mock', 'dev')).toBe(mock)
    expect(selectDirectory({ mock, graph }, 'graph', 'prod')).toBe(graph)
  })

  test.each(['local', 'dev', 'test', 'perf-test', 'ext-test'])(
    'allows the mock in %s',
    (environment) => {
      expect(selectDirectory({ mock }, 'mock', environment)).toBe(mock)
    }
  )

  test('refuses the mock in the prod environment, even when it is registered', () => {
    expect(() => selectDirectory({ mock }, 'mock', 'prod')).toThrow(
      'DIRECTORY_MODE must not be "mock" in the prod environment'
    )
  })

  test('refuses graph until it is registered, saying why', () => {
    expect(() => selectDirectory({ mock }, 'graph', 'dev')).toThrow(
      "DIRECTORY_MODE=graph needs B27's portal token"
    )
  })

  test('refuses a mode it has no directory for', () => {
    expect(() => selectDirectory({ mock }, 'ldap', 'dev')).toThrow(
      'No directory for directory mode "ldap"'
    )
  })
})

describe('#directory at start-up', () => {
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

  test('is the mock directory by default', () => {
    expect(directory).toBe(mockDirectory)
  })

  test.each([
    ['the default mock in prod', prod, 'must not be "mock"'],
    [
      'graph in dev, until B27 wires the token',
      { DIRECTORY_MODE: 'graph' },
      "needs B27's portal token"
    ],
    [
      'graph in prod, until B27 wires the token',
      { ...prod, DIRECTORY_MODE: 'graph' },
      "needs B27's portal token"
    ]
  ])('refuses %s', async (_, env, message) => {
    vi.resetModules()

    for (const [key, value] of Object.entries(env)) {
      vi.stubEnv(key, value)
    }

    await expect(import('#/adapters/directory-registry.js')).rejects.toThrow(
      message
    )
  })
})

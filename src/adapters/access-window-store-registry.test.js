import {
  accessWindowStore,
  selectAccessWindowStore
} from '#/adapters/access-window-store-registry.js'
import { mockAccessWindowStore } from '#/adapters/mock-access-window-store.js'

describe('#selectAccessWindowStore', () => {
  const mock = { id: 'mock-store' }
  const apim = { id: 'apim-store' }

  test('selects the store for the access window mode', () => {
    expect(selectAccessWindowStore({ mock, apim }, 'mock', 'dev')).toBe(mock)
    expect(selectAccessWindowStore({ mock, apim }, 'apim', 'prod')).toBe(apim)
  })

  test.each(['local', 'dev', 'test', 'perf-test', 'ext-test'])(
    'allows the mock in %s',
    (environment) => {
      expect(selectAccessWindowStore({ mock }, 'mock', environment)).toBe(mock)
    }
  )

  test('refuses the mock in the prod environment, where a block would never reach the gateway', () => {
    expect(() => selectAccessWindowStore({ mock }, 'mock', 'prod')).toThrow(
      'ACCESS_WINDOW_STORE must not be "mock" in the prod environment'
    )
  })

  test('refuses a mode it has no store for', () => {
    expect(() => selectAccessWindowStore({ mock }, 'redis', 'dev')).toThrow(
      'No access window store for mode "redis"'
    )
  })
})

describe('#accessWindowStore at start-up', () => {
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

  test('is the mock store by default', () => {
    expect(accessWindowStore).toBe(mockAccessWindowStore)
  })

  test('is the API Management store when the mode says so', async () => {
    vi.resetModules()
    vi.stubEnv('ACCESS_WINDOW_STORE', 'apim')

    const registry = await import('#/adapters/access-window-store-registry.js')

    expect(registry.accessWindowStore).not.toBe(mockAccessWindowStore)
    expect(registry.accessWindowStore).toEqual({
      read: expect.any(Function),
      write: expect.any(Function)
    })
  })

  test('refuses the default mock in prod', async () => {
    vi.resetModules()

    for (const [key, value] of Object.entries(prod)) {
      vi.stubEnv(key, value)
    }

    await expect(
      import('#/adapters/access-window-store-registry.js')
    ).rejects.toThrow('must not be "mock"')
  })
})

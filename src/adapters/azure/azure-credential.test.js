import {
  ClientAssertionCredential,
  ClientSecretCredential
} from '@azure/identity'

describe('#getArmCredential', () => {
  beforeAll(() => {
    process.env.AZURE_ARM_TENANT_ID = 'test-tenant'
    process.env.AZURE_ARM_CLIENT_ID = 'test-client'
    process.env.AZURE_ARM_CLIENT_SECRET = 'test-secret'
  })

  test('returns the same cached credential instance across calls', async () => {
    // Dynamic import needed so this file's env vars are read by config.js
    // before it (and this module, which reads armAuth.* from it) first loads.
    const { getArmCredential } =
      await import('#/adapters/azure/azure-credential.js')

    expect(getArmCredential()).toBe(getArmCredential())
  })

  test('defaults to a ClientSecretCredential', async () => {
    vi.resetModules()
    const { getArmCredential } =
      await import('#/adapters/azure/azure-credential.js')

    expect(getArmCredential()).toBeInstanceOf(ClientSecretCredential)
  })
})

describe('#getArmCredential federated', () => {
  beforeAll(() => {
    process.env.AZURE_ARM_TENANT_ID = 'test-tenant'
    process.env.AZURE_ARM_CLIENT_ID = 'test-client'
    process.env.AZURE_ARM_AUTH_METHOD = 'federated'
  })

  afterAll(() => {
    delete process.env.AZURE_ARM_AUTH_METHOD
  })

  test('uses a ClientAssertionCredential backed by the AWS STS token provider', async () => {
    vi.resetModules()
    const { getArmCredential } =
      await import('#/adapters/azure/azure-credential.js')
    const tokenProvider = {
      getCredentials: vi.fn().mockResolvedValue('fake-jwt')
    }

    const credential = getArmCredential({ tokenProvider })

    expect(credential).toBeInstanceOf(ClientAssertionCredential)
  })

  test('the client assertion callback delegates to the token provider', async () => {
    vi.resetModules()
    const { getArmCredential } =
      await import('#/adapters/azure/azure-credential.js')
    const tokenProvider = {
      getCredentials: vi.fn().mockResolvedValue('fake-jwt')
    }

    const credential = getArmCredential({ tokenProvider })
    const assertion = await credential.getAssertion()

    expect(assertion).toBe('fake-jwt')
    expect(tokenProvider.getCredentials).toHaveBeenCalled()
  })

  test('still caches a single credential instance across calls', async () => {
    vi.resetModules()
    const { getArmCredential } =
      await import('#/adapters/azure/azure-credential.js')
    const tokenProvider = { getCredentials: vi.fn() }

    expect(getArmCredential({ tokenProvider })).toBe(
      getArmCredential({ tokenProvider })
    )
  })

  test('defaults to the AWS STS WebIdentityTokenProvider when none is injected', async () => {
    process.env.AZURE_ARM_FEDERATED_AUDIENCE = 'api://AzureADTokenExchange'
    vi.resetModules()
    const { getArmCredential } =
      await import('#/adapters/azure/azure-credential.js')

    expect(getArmCredential()).toBeInstanceOf(ClientAssertionCredential)
  })
})

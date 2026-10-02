describe('#getArmCredential', () => {
  beforeAll(() => {
    process.env.AZURE_ARM_TENANT_ID = 'test-tenant'
    process.env.AZURE_ARM_CLIENT_ID = 'test-client'
    process.env.AZURE_ARM_CLIENT_SECRET = 'test-secret'
  })

  test('returns the same cached credential instance across calls', async () => {
    // Dynamic import needed so this file's env vars are read by config.js
    // before it (and this module, which reads armAuth.* from it) first loads.
    const { getArmCredential } = await import(
      '#/adapters/azure/azure-credential.js'
    )

    expect(getArmCredential()).toBe(getArmCredential())
  })
})

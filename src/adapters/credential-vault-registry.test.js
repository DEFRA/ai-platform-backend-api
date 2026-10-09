import { createCredentialVaultRegistry } from '#/adapters/credential-vault-registry.js'

function fakeVault() {
  return {
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue('secret'),
    remove: vi.fn().mockResolvedValue(undefined),
    updateExpiry: vi.fn().mockResolvedValue(undefined)
  }
}

describe('#createCredentialVaultRegistry', () => {
  test('routes every operation to the vault for the credential issuerKey', async () => {
    const mock = fakeVault()
    const azure = fakeVault()
    const otherGateway = fakeVault()
    const vault = createCredentialVaultRegistry({
      mock,
      'azure-apim': azure,
      'aws-apigw': otherGateway
    })
    const expiresOn = new Date()

    await vault.put({
      credentialId: 'c1',
      issuerKey: 'aws-apigw',
      secret: 's'
    })
    await vault.get({ credentialId: 'c1', issuerKey: 'aws-apigw' })
    await vault.updateExpiry({
      credentialId: 'c2',
      issuerKey: 'azure-apim',
      expiresOn
    })
    await vault.remove({ credentialId: 'c3', issuerKey: 'mock' })

    expect(otherGateway.put).toHaveBeenCalledWith(
      expect.objectContaining({ credentialId: 'c1', secret: 's' })
    )
    expect(otherGateway.get).toHaveBeenCalledTimes(1)
    expect(azure.updateExpiry).toHaveBeenCalledTimes(1)
    expect(mock.remove).toHaveBeenCalledTimes(1)
    expect(azure.put).not.toHaveBeenCalled()
  })

  test('falls back to the mock vault for a legacy credential with no issuerKey', async () => {
    const mock = fakeVault()
    const vault = createCredentialVaultRegistry({ mock })

    await expect(vault.get({ credentialId: 'c1' })).resolves.toBe('secret')
    expect(mock.get).toHaveBeenCalledTimes(1)
  })

  test('rejects with a coded error for an issuerKey with no registered vault', async () => {
    const vault = createCredentialVaultRegistry({ mock: fakeVault() })

    await expect(
      vault.put({ credentialId: 'c1', issuerKey: 'aws-apigw', secret: 's' })
    ).rejects.toThrow(
      expect.objectContaining({
        code: 'gateway-not-enabled',
        message: 'No credential vault registered for issuerKey "aws-apigw"'
      })
    )
  })
})

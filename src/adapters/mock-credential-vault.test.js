import { mockCredentialVault } from '#/adapters/mock-credential-vault.js'

describe('#mockCredentialVault', () => {
  test('put then get returns the stored secret', async () => {
    await mockCredentialVault.put({
      credentialId: 'cred-1',
      secret: 'top-secret'
    })

    await expect(
      mockCredentialVault.get({ credentialId: 'cred-1' })
    ).resolves.toBe('top-secret')
  })

  test('get returns null for a credentialId never written', async () => {
    await expect(
      mockCredentialVault.get({ credentialId: 'never-written' })
    ).resolves.toBeNull()
  })

  test('remove then get returns null', async () => {
    await mockCredentialVault.put({ credentialId: 'cred-2', secret: 'abc' })
    await mockCredentialVault.remove({ credentialId: 'cred-2' })

    await expect(
      mockCredentialVault.get({ credentialId: 'cred-2' })
    ).resolves.toBeNull()
  })

  test('remove is idempotent - calling it twice does not throw', async () => {
    await mockCredentialVault.put({ credentialId: 'cred-3', secret: 'abc' })

    await expect(
      mockCredentialVault.remove({ credentialId: 'cred-3' })
    ).resolves.toBeUndefined()
    await expect(
      mockCredentialVault.remove({ credentialId: 'cred-3' })
    ).resolves.toBeUndefined()
  })

  test('put overwrites a previous secret for the same credentialId', async () => {
    await mockCredentialVault.put({ credentialId: 'cred-4', secret: 'first' })
    await mockCredentialVault.put({ credentialId: 'cred-4', secret: 'second' })

    await expect(
      mockCredentialVault.get({ credentialId: 'cred-4' })
    ).resolves.toBe('second')
  })
})

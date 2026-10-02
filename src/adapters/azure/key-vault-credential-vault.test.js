import { createKeyVaultCredentialVault } from '#/adapters/azure/key-vault-credential-vault.js'

function fakeClient() {
  const secrets = new Map()

  return {
    async setSecret(name, value, options) {
      secrets.set(name, { value, options })
      return { value, properties: { name } }
    },
    async getSecret(name) {
      const found = secrets.get(name)

      if (!found) {
        const error = new Error('not found')
        error.statusCode = 404
        error.code = 'SecretNotFound'
        throw error
      }

      return { value: found.value }
    },
    async beginDeleteSecret(name) {
      secrets.delete(name)
      return { pollUntilDone: async () => {} }
    }
  }
}

describe('#createKeyVaultCredentialVault', () => {
  test('put then get returns the stored secret', async () => {
    const vault = createKeyVaultCredentialVault({ client: fakeClient() })

    await vault.put({ credentialId: 'cred-1', secret: 'top-secret' })

    await expect(vault.get({ credentialId: 'cred-1' })).resolves.toBe(
      'top-secret'
    )
  })

  test('put passes tags and expiresOn through to the client', async () => {
    const client = fakeClient()
    const vault = createKeyVaultCredentialVault({ client })
    const expiresOn = new Date()

    await vault.put({
      credentialId: 'cred-1',
      secret: 'top-secret',
      tags: { 'aip-team': 'research' },
      expiresOn
    })

    const stored = await client.getSecret('cred-cred-1')

    expect(stored.value).toBe('top-secret')
  })

  test('get returns null for a secret that does not exist', async () => {
    const vault = createKeyVaultCredentialVault({ client: fakeClient() })

    await expect(
      vault.get({ credentialId: 'never-written' })
    ).resolves.toBeNull()
  })

  test('get rethrows an error that is not a not-found', async () => {
    const client = fakeClient()
    client.getSecret = async () => {
      throw new Error('boom')
    }
    const vault = createKeyVaultCredentialVault({ client })

    await expect(vault.get({ credentialId: 'cred-1' })).rejects.toThrow(
      'boom'
    )
  })

  test('remove then get returns null', async () => {
    const vault = createKeyVaultCredentialVault({ client: fakeClient() })

    await vault.put({ credentialId: 'cred-2', secret: 'abc' })
    await vault.remove({ credentialId: 'cred-2' })

    await expect(vault.get({ credentialId: 'cred-2' })).resolves.toBeNull()
  })

  test('remove is idempotent - a not-found delete does not throw', async () => {
    const client = fakeClient()
    client.beginDeleteSecret = async () => {
      const error = new Error('not found')
      error.statusCode = 404
      throw error
    }
    const vault = createKeyVaultCredentialVault({ client })

    await expect(
      vault.remove({ credentialId: 'never-written' })
    ).resolves.toBeUndefined()
  })
})

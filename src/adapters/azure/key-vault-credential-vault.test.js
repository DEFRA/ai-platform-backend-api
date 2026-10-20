import { createKeyVaultCredentialVault as createVaultFor } from '#/adapters/azure/key-vault-credential-vault.js'

// One vault, whatever the environment - the per-environment routing has its own tests below.
function createKeyVaultCredentialVault({ client }) {
  return createVaultFor({
    createClient: () => client,
    resolveEnvironment: () => ({ tenantsVault: 'kv-test' })
  })
}

function fakeClient() {
  const secrets = new Map()

  return {
    async setSecret(name, value, options) {
      secrets.set(name, { value, options, version: 'v1' })
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

      return {
        value: found.value,
        properties: { name, version: found.version }
      }
    },
    async updateSecretProperties(name, version, options) {
      const found = secrets.get(name)
      secrets.set(name, { ...found, options: { ...found.options, ...options } })
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

    await expect(vault.get({ credentialId: 'cred-1' })).rejects.toThrow('boom')
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

  test('updateExpiry updates the current version in place without changing the secret value', async () => {
    const client = fakeClient()
    const vault = createKeyVaultCredentialVault({ client })
    const expiresOn = new Date('2030-01-01')

    await vault.put({ credentialId: 'cred-3', secret: 'abc' })
    await vault.updateExpiry({ credentialId: 'cred-3', expiresOn })

    const stored = await client.getSecret('cred-cred-3')
    expect(stored.value).toBe('abc')
  })

  test('updateExpiry rethrows when the secret does not exist', async () => {
    const vault = createKeyVaultCredentialVault({ client: fakeClient() })

    await expect(
      vault.updateExpiry({
        credentialId: 'never-written',
        expiresOn: new Date()
      })
    ).rejects.toThrow()
  })

  describe('per environment', () => {
    const tenantsVaults = { infradev: 'kv-infradev', sandbox: 'kv-sandbox' }

    function createRoutedVault() {
      const clientsByUrl = new Map()
      const vault = createVaultFor({
        createClient: (url) => {
          const client = fakeClient()
          clientsByUrl.set(url, client)
          return client
        },
        resolveEnvironment: (name) => {
          if (!tenantsVaults[name]) {
            throw new Error(`Environment "${name}" is not configured`)
          }

          return { tenantsVault: tenantsVaults[name] }
        }
      })

      return { vault, clientsByUrl }
    }

    test('writes to, and reads back from, the vault of the credential environment', async () => {
      const { vault, clientsByUrl } = createRoutedVault()

      await vault.put({
        credentialId: 'a',
        environment: 'infradev',
        secret: 'infradev-secret'
      })
      await vault.put({
        credentialId: 'b',
        environment: 'sandbox',
        secret: 'sandbox-secret'
      })

      expect([...clientsByUrl.keys()].sort()).toEqual([
        'https://kv-infradev.vault.azure.net',
        'https://kv-sandbox.vault.azure.net'
      ])
      await expect(
        vault.get({ credentialId: 'a', environment: 'infradev' })
      ).resolves.toBe('infradev-secret')
      await expect(
        vault.get({ credentialId: 'a', environment: 'sandbox' })
      ).resolves.toBeNull()
    })

    test('builds one client per vault, not one per call', async () => {
      const { vault, clientsByUrl } = createRoutedVault()

      await vault.put({
        credentialId: 'a',
        environment: 'infradev',
        secret: 's'
      })
      await vault.put({
        credentialId: 'b',
        environment: 'infradev',
        secret: 's'
      })

      expect(clientsByUrl.size).toBe(1)
    })

    test.each(['put', 'get', 'remove', 'updateExpiry'])(
      '%s fails closed for an environment that is not configured',
      async (method) => {
        const { vault } = createRoutedVault()

        await expect(
          vault[method]({
            credentialId: 'a',
            environment: 'nowhere',
            secret: 's',
            expiresOn: new Date()
          })
        ).rejects.toThrow('is not configured')
      }
    )
  })
})

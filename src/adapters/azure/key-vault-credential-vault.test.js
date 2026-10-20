import { SecretClient } from '@azure/keyvault-secrets'
import nock from 'nock'

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
    const tokenCredential = {
      getToken: async () => ({
        token: 'test-token',
        expiresOnTimestamp: Date.now() + 3_600_000
      })
    }
    const challenge =
      'Bearer authorization="https://login.microsoftonline.com/tenant", resource="https://vault.azure.net"'

    // A minimal Key Vault data plane behind nock, so the real SecretClient
    // (challenge auth, serialisation, delete polling) runs against each host.
    function interceptVault(name) {
      const host = `https://${name}.vault.azure.net`
      const secrets = new Map()
      const deleted = new Set()

      function bundle(secretName, secret) {
        return {
          id: `${host}/secrets/${secretName}/v1`,
          value: secret.value,
          tags: secret.tags,
          attributes: { enabled: true, exp: secret.exp }
        }
      }

      function respond(method) {
        return function (uri, body) {
          if (!this.req.headers.authorization) {
            return [401, '', { 'www-authenticate': challenge }]
          }

          const [, kind, secretName] = new URL(uri, host).pathname.split('/')
          const notFound = [
            404,
            { error: { code: 'SecretNotFound', message: 'not found' } }
          ]

          if (kind === 'deletedsecrets') {
            return deleted.has(secretName)
              ? [
                  200,
                  {
                    id: `${host}/secrets/${secretName}/v1`,
                    recoveryId: `${host}/deletedsecrets/${secretName}`
                  }
                ]
              : notFound
          }

          const found = secrets.get(secretName)

          if (method === 'PUT') {
            const secret = {
              value: body.value,
              tags: body.tags,
              exp: body.attributes?.exp
            }
            secrets.set(secretName, secret)
            return [200, bundle(secretName, secret)]
          }

          if (!found) {
            return notFound
          }

          if (method === 'PATCH') {
            found.exp = body.attributes?.exp
            return [200, bundle(secretName, found)]
          }

          if (method === 'DELETE') {
            secrets.delete(secretName)
            deleted.add(secretName)
            return [
              200,
              {
                ...bundle(secretName, found),
                recoveryId: `${host}/deletedsecrets/${secretName}`
              }
            ]
          }

          return [200, bundle(secretName, found)]
        }
      }

      const scope = nock(host).persist()

      for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
        scope.intercept(/.*/, method).reply(respond(method))
      }

      return secrets
    }

    function createRoutedVault() {
      const createClient = vi.fn(
        (url) =>
          new SecretClient(url, tokenCredential, {
            disableChallengeResourceVerification: true
          })
      )
      const vault = createVaultFor({
        createClient,
        resolveEnvironment: (name) => {
          if (!tenantsVaults[name]) {
            throw new Error(`Environment "${name}" is not configured`)
          }

          return { tenantsVault: tenantsVaults[name] }
        }
      })

      return { vault, createClient }
    }

    let infradevSecrets
    let sandboxSecrets

    beforeEach(() => {
      nock.disableNetConnect()
      infradevSecrets = interceptVault('kv-infradev')
      sandboxSecrets = interceptVault('kv-sandbox')
    })

    afterEach(() => {
      nock.cleanAll()
      nock.enableNetConnect()
    })

    test('writes to, and reads back from, the vault of the credential environment', async () => {
      const { vault } = createRoutedVault()

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

      expect([...infradevSecrets.keys()]).toEqual(['cred-a'])
      expect([...sandboxSecrets.keys()]).toEqual(['cred-b'])
      await expect(
        vault.get({ credentialId: 'a', environment: 'infradev' })
      ).resolves.toBe('infradev-secret')
      await expect(
        vault.get({ credentialId: 'a', environment: 'sandbox' })
      ).resolves.toBeNull()
    })

    test('removes only from the vault of the credential environment', async () => {
      const { vault } = createRoutedVault()

      for (const environment of ['infradev', 'sandbox']) {
        await vault.put({ credentialId: 'a', environment, secret: 's' })
      }

      await vault.remove({ credentialId: 'a', environment: 'infradev' })

      expect([...infradevSecrets.keys()]).toEqual([])
      expect([...sandboxSecrets.keys()]).toEqual(['cred-a'])
    })

    test('updates the expiry only in the vault of the credential environment', async () => {
      const { vault } = createRoutedVault()
      const expiresOn = new Date('2030-01-01T00:00:00.000Z')

      for (const environment of ['infradev', 'sandbox']) {
        await vault.put({ credentialId: 'a', environment, secret: 's' })
      }

      await vault.updateExpiry({
        credentialId: 'a',
        environment: 'sandbox',
        expiresOn
      })

      expect(sandboxSecrets.get('cred-a').exp).toBe(
        Math.floor(expiresOn.getTime() / 1000)
      )
      expect(infradevSecrets.get('cred-a').exp).toBeUndefined()
    })

    test('builds one client per vault, not one per call', async () => {
      const { vault, createClient } = createRoutedVault()

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

      expect(createClient).toHaveBeenCalledTimes(1)
      expect(createClient).toHaveBeenCalledWith(
        'https://kv-infradev.vault.azure.net'
      )

      await vault.put({
        credentialId: 'c',
        environment: 'sandbox',
        secret: 's'
      })

      expect(createClient).toHaveBeenCalledTimes(2)
    })

    test.each(['put', 'get', 'remove', 'updateExpiry'])(
      '%s fails closed for an environment that is not configured',
      async (method) => {
        const { vault, createClient } = createRoutedVault()

        await expect(
          vault[method]({
            credentialId: 'a',
            environment: 'nowhere',
            secret: 's',
            expiresOn: new Date()
          })
        ).rejects.toThrow('is not configured')
        expect(createClient).not.toHaveBeenCalled()
      }
    )
  })
})

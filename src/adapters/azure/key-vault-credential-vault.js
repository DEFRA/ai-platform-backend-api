import { SecretClient } from '@azure/keyvault-secrets'

import { getArmCredential } from '#/adapters/azure/azure-credential.js'
import { resolveAipEnvironment } from '#/common/helpers/aip-environment.js'

// Opaque, and valid against Key Vault's `^[0-9a-zA-Z-]+$` secret name rule -
// `credentialId` is this platform's own Mongo `_id`, never derived from a
// user-visible field.
function secretNameFor(credentialId) {
  return `cred-${credentialId}`
}

function isNotFound(error) {
  return error.statusCode === 404 || error.code === 'SecretNotFound'
}

/**
 * Creates the real Key Vault-backed `CredentialVault`, using the `SecretClient`
 * from `@azure/keyvault-secrets` and the shared credential from
 * `azure-credential.js` - deliberately not `arm-client.js`, because Key Vault
 * secrets are a data-plane concern on a different host and token audience
 * than ARM. Each call names the credential's environment, which is resolved
 * to that environment's tenants vault, so credentials issued into different
 * environments land in (and are read back from) different vaults. A client is
 * built lazily on first use of each vault, same as `arm-client.js`'s credential
 * resolution, so this adapter is safe to construct even when
 * `PROVISIONING_MODE` is "mock" and no environment is configured.
 * @param {{createClient?: (vaultUrl: string) => import('@azure/keyvault-secrets').SecretClient, resolveEnvironment?: typeof resolveAipEnvironment}} [deps]
 * @returns {import('#/adapters/credential-vault.js').CredentialVault}
 */
export function createKeyVaultCredentialVault({
  createClient = (vaultUrl) => new SecretClient(vaultUrl, getArmCredential()),
  resolveEnvironment = resolveAipEnvironment
} = {}) {
  const clientsByVault = new Map()

  function getClient(environment) {
    const { tenantsVault } = resolveEnvironment(environment)

    if (!clientsByVault.has(tenantsVault)) {
      clientsByVault.set(
        tenantsVault,
        createClient(`https://${tenantsVault}.vault.azure.net`)
      )
    }

    return clientsByVault.get(tenantsVault)
  }

  return {
    async put({ credentialId, environment, secret, tags, expiresOn }) {
      await getClient(environment).setSecret(
        secretNameFor(credentialId),
        secret,
        {
          tags,
          expiresOn
        }
      )
    },

    async get({ credentialId, environment }) {
      try {
        const found = await getClient(environment).getSecret(
          secretNameFor(credentialId)
        )
        return found.value
      } catch (error) {
        if (isNotFound(error)) {
          return null
        }

        throw error
      }
    },

    async remove({ credentialId, environment }) {
      const client = getClient(environment)

      try {
        const poller = await client.beginDeleteSecret(
          secretNameFor(credentialId)
        )
        await poller.pollUntilDone()
      } catch (error) {
        if (!isNotFound(error)) {
          throw error
        }
      }
    },

    // Updates the current version's expiry attribute in place - unlike
    // `put`, this does NOT create a new secret version, since the value
    // (and so the APIM/Foundry key it represents) hasn't changed, only how
    // long Key Vault considers it valid (a renew, not a rotate).
    async updateExpiry({ credentialId, environment, expiresOn }) {
      const client = getClient(environment)
      const name = secretNameFor(credentialId)
      const current = await client.getSecret(name)
      await client.updateSecretProperties(name, current.properties.version, {
        expiresOn
      })
    }
  }
}

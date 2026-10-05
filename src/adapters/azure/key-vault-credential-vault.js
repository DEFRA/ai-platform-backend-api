import { SecretClient } from '@azure/keyvault-secrets'

import { config } from '#/config.js'
import { getArmCredential } from '#/adapters/azure/azure-credential.js'

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
 * than ARM. The client is built lazily on first use (not at construction),
 * same as `arm-client.js`'s credential resolution, so this adapter is safe
 * to construct even when `PROVISIONING_MODE` is "mock" and `keyVault.vaultName`
 * is unset.
 * @param {{client?: import('@azure/keyvault-secrets').SecretClient}} [deps]
 * @returns {import('#/adapters/credential-vault.js').CredentialVault}
 */
export function createKeyVaultCredentialVault({ client } = {}) {
  let resolvedClient = client ?? null

  function getClient() {
    if (!resolvedClient) {
      const vaultUrl = `https://${config.get('keyVault.vaultName')}.vault.azure.net`
      resolvedClient = new SecretClient(vaultUrl, getArmCredential())
    }

    return resolvedClient
  }

  return {
    async put({ credentialId, secret, tags, expiresOn }) {
      await getClient().setSecret(secretNameFor(credentialId), secret, {
        tags,
        expiresOn
      })
    },

    async get({ credentialId }) {
      try {
        const found = await getClient().getSecret(secretNameFor(credentialId))
        return found.value
      } catch (error) {
        if (isNotFound(error)) {
          return null
        }

        throw error
      }
    },

    async remove({ credentialId }) {
      try {
        const poller = await getClient().beginDeleteSecret(
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
    async updateExpiry({ credentialId, expiresOn }) {
      const name = secretNameFor(credentialId)
      const current = await getClient().getSecret(name)
      await getClient().updateSecretProperties(name, current.properties.version, {
        expiresOn
      })
    }
  }
}

import { config } from '#/config.js'
import { mockCredentialVault } from '#/adapters/mock-credential-vault.js'
import { createKeyVaultCredentialVault } from '#/adapters/azure/key-vault-credential-vault.js'
import { AZURE_APIM } from '#/adapters/adapter-keys.js'

/**
 * Creates a `CredentialVault` that stores each secret in the vault that
 * belongs to the gateway which minted the credential. Every call carries the
 * credential's `issuerKey` (mock, azure-apim, ...), so a mock-issued secret
 * stays in the mock vault even after switching to live, and a Bedrock
 * credential's secret goes to AWS while an Azure one goes to Key Vault.
 * Adding a gateway is one entry in `vaultFactories` below.
 * @param {Record<string, import('#/adapters/credential-vault.js').CredentialVault>} vaultsByKey
 * @returns {import('#/adapters/credential-vault.js').CredentialVault}
 */
export function createCredentialVaultRegistry(vaultsByKey) {
  function resolve(issuerKey = 'mock') {
    const vault = vaultsByKey[issuerKey]

    if (!vault) {
      const error = new Error(
        `No credential vault registered for issuerKey "${issuerKey}"`
      )
      error.code = 'adapter-not-enabled'
      throw error
    }

    return vault
  }

  return {
    put: async (params) => resolve(params.issuerKey).put(params),
    get: async (params) => resolve(params.issuerKey).get(params),
    remove: async (params) => resolve(params.issuerKey).remove(params),
    updateExpiry: async (params) =>
      resolve(params.issuerKey).updateExpiry(params)
  }
}

// Keyed by catalogue `adapter` id. Safe to construct with the adapter's
// config unset - clients are built lazily on first request.
const vaultFactories = {
  [AZURE_APIM]: createKeyVaultCredentialVault
}

const vaultsByKey = { mock: mockCredentialVault }

for (const adapter of config.get('provisioning.adapters')) {
  vaultsByKey[adapter] = vaultFactories[adapter]?.()
}

// Credentials issued before the catalogue carried `adapter` persisted this key.
vaultsByKey.azure = vaultsByKey[AZURE_APIM]

/**
 * The live vault, routing by each credential's `issuerKey`.
 * @type {import('#/adapters/credential-vault.js').CredentialVault}
 */
export const credentialVault = createCredentialVaultRegistry(vaultsByKey)

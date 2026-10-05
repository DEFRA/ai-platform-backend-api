import { config } from '#/config.js'
import { mockCredentialVault } from '#/adapters/mock-credential-vault.js'
import { createKeyVaultCredentialVault } from '#/adapters/azure/key-vault-credential-vault.js'

const vaultsByMode = {
  mock: mockCredentialVault,
  // Safe to construct even when PROVISIONING_MODE is "mock" and
  // keyVault.vaultName is unset - client construction is deferred to the
  // first Key Vault request.
  azure: createKeyVaultCredentialVault()
}

/**
 * The live `CredentialVault`, chosen by `provisioning.mode` - the same guard
 * used for `credentialIssuerRegistry`. Unlike credential issuing, a vault
 * write isn't tied to a persisted per-credential key: the design treats Key
 * Vault as a single platform-wide store, so one instance selected at
 * startup is enough.
 * @type {import('#/adapters/credential-vault.js').CredentialVault}
 */
export const credentialVault = vaultsByMode[config.get('provisioning.mode')]

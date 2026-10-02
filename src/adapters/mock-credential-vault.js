// In-memory, for dev and tests - selected by the same `PROVISIONING_MODE`
// guard as `mockCredentialIssuer`. Keyed on `credentialId` (this platform's
// own Mongo `_id`), never a provider-specific id.
const secretsByCredentialId = new Map()

/**
 * Mock credential vault used until the real Key Vault adapter is selected.
 * @type {import('./credential-vault.js').CredentialVault}
 */
export const mockCredentialVault = {
  async put({ credentialId, secret }) {
    secretsByCredentialId.set(credentialId, secret)
  },

  async get({ credentialId }) {
    return secretsByCredentialId.get(credentialId) ?? null
  },

  async remove({ credentialId }) {
    secretsByCredentialId.delete(credentialId)
  }
}

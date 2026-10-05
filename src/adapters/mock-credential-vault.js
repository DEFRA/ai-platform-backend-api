// In-memory, for dev and tests - selected by the same `PROVISIONING_MODE`
// guard as `mockCredentialIssuer`. Keyed on `credentialId` (this platform's
// own Mongo `_id`), never a provider-specific id.
const secretsByCredentialId = new Map()

/**
 * Mock credential vault used until the real Key Vault adapter is selected.
 * @type {import('./credential-vault.js').CredentialVault}
 */
export const mockCredentialVault = {
  async put({ credentialId, secret, expiresOn }) {
    secretsByCredentialId.set(credentialId, { secret, expiresOn })
  },

  async get({ credentialId }) {
    return secretsByCredentialId.get(credentialId)?.secret ?? null
  },

  async remove({ credentialId }) {
    secretsByCredentialId.delete(credentialId)
  },

  async updateExpiry({ credentialId, expiresOn }) {
    const found = secretsByCredentialId.get(credentialId)

    if (!found) {
      const error = new Error('not found')
      error.code = 'SecretNotFound'
      throw error
    }

    secretsByCredentialId.set(credentialId, { ...found, expiresOn })
  }
}

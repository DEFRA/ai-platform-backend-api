import { config } from '#/config.js'
import { mockCredentialIssuer } from '#/adapters/mock-credential-issuer.js'
import { createApimCredentialIssuer } from '#/adapters/azure/apim-credential-issuer.js'
import { AZURE_APIM, DEFAULT_ADAPTER } from '#/adapters/adapter-keys.js'

/**
 * @typedef {object} CredentialIssuerRegistry
 * @property {(model: object, tier?: string) => {issuerKey: string, issuer: import('#/adapters/credential-issuer.js').CredentialIssuer}} forModel
 * @property {(credential: object) => {issuerKey: string, issuer: import('#/adapters/credential-issuer.js').CredentialIssuer}} forCredential
 */

/**
 * Creates a registry that resolves which `CredentialIssuer` handles a given
 * model or already-issued credential. Adding a new gateway (e.g. AWS
 * Bedrock) is one new adapter file plus one entry in `issuerFactories` below
 * keyed by the catalogue's `adapter` id - no change to `credential-service.js`.
 * @param {Record<string, import('#/adapters/credential-issuer.js').CredentialIssuer>} issuersByKey
 * @param {'mock'|'live'} mode - `mock` forces the mock issuer for every model; `live` picks the issuer by the model's `adapter`
 * @param {string[]} [mockTiers] - tiers that use the mock issuer even in `live` mode
 * @returns {CredentialIssuerRegistry}
 */
export function createCredentialIssuerRegistry(
  issuersByKey,
  mode,
  mockTiers = []
) {
  function resolve(issuerKey) {
    const issuer = issuersByKey[issuerKey]

    if (!issuer) {
      const error = new Error(
        `No credential issuer registered for issuerKey "${issuerKey}"`
      )
      error.code = 'adapter-not-enabled'
      throw error
    }

    return { issuerKey, issuer }
  }

  return {
    // `mock` mode (local dev) never reaches a real gateway whatever the
    // model's adapter says, and neither does a tier listed in `mockTiers`;
    // otherwise the catalogue's `adapter` picks it.
    forModel(model, tier) {
      if (mode === 'mock' || mockTiers.includes(tier)) {
        return resolve('mock')
      }

      return resolve(model?.adapter ?? DEFAULT_ADAPTER)
    },
    // Lifecycle operations on an already-issued credential must use the
    // issuer that minted it, regardless of the current mode - this is
    // the whole reason `issuerKey` is persisted on the document.
    forCredential(credential) {
      return resolve(credential?.issuerKey ?? 'mock')
    }
  }
}

// Keyed by catalogue `adapter` id. Safe to construct even when mode is
// "mock" and the adapter's config is unset - clients are built lazily.
const issuerFactories = {
  [AZURE_APIM]: createApimCredentialIssuer
}

const issuersByKey = { mock: mockCredentialIssuer }

for (const adapter of config.get('provisioning.adapters')) {
  issuersByKey[adapter] = issuerFactories[adapter]?.()
}

// Credentials issued before the catalogue carried `adapter` persisted this key.
issuersByKey.azure = issuersByKey[AZURE_APIM]

/**
 * The live registry, built from config at startup.
 * @type {CredentialIssuerRegistry}
 */
export const credentialIssuerRegistry = createCredentialIssuerRegistry(
  issuersByKey,
  config.get('provisioning.mode'),
  config.get('provisioning.mockTiers')
)

import { config } from '#/config.js'
import { mockCredentialIssuer } from '#/adapters/mock-credential-issuer.js'
import { createApimCredentialIssuer } from '#/adapters/azure/apim-credential-issuer.js'

/**
 * @typedef {object} CredentialIssuerRegistry
 * @property {(model: object) => {issuerKey: string, issuer: import('#/adapters/credential-issuer.js').CredentialIssuer}} forModel
 * @property {(credential: object) => {issuerKey: string, issuer: import('#/adapters/credential-issuer.js').CredentialIssuer}} forCredential
 */

/**
 * Creates a registry that resolves which `CredentialIssuer` handles a given
 * model or already-issued credential. Adding a new provider (e.g. AWS
 * Bedrock) is one new adapter file plus one entry in `issuersByKey` - no
 * change to `credential-service.js`.
 * @param {Record<string, import('#/adapters/credential-issuer.js').CredentialIssuer>} issuersByKey
 * @param {string} defaultIssuerKey - issuer new credentials use, keyed by `PROVISIONING_MODE`
 * @returns {CredentialIssuerRegistry}
 */
export function createCredentialIssuerRegistry(issuersByKey, defaultIssuerKey) {
  function resolve(issuerKey) {
    const issuer = issuersByKey[issuerKey]

    if (!issuer) {
      throw new Error(
        `No credential issuer registered for issuerKey "${issuerKey}"`
      )
    }

    return { issuerKey, issuer }
  }

  return {
    // Every model uses the one configured provisioning provider today -
    // a per-model override (e.g. a Bedrock-only model) would read a field
    // off `model` here instead of always falling back to the default.
    forModel(model) {
      return resolve(model?.issuerKey ?? defaultIssuerKey)
    },
    // Lifecycle operations on an already-issued credential must use the
    // issuer that minted it, regardless of the current default - this is
    // the whole reason `issuerKey` is persisted on the document.
    forCredential(credential) {
      return resolve(credential?.issuerKey ?? 'mock')
    }
  }
}

const issuersByKey = {
  mock: mockCredentialIssuer,
  // Safe to construct even when PROVISIONING_MODE is "mock" and armAuth.* is
  // unset - credential construction is deferred to the first ARM request.
  azure: createApimCredentialIssuer()
}

/**
 * The live registry, built from config at startup.
 * @type {CredentialIssuerRegistry}
 */
export const credentialIssuerRegistry = createCredentialIssuerRegistry(
  issuersByKey,
  config.get('provisioning.mode')
)

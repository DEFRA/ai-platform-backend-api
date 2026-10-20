/**
 * Port interface for persisting the plaintext secret of an issued
 * credential (e.g. in Azure Key Vault). Kept separate from `CredentialIssuer`
 * because the design treats them as sequential steps - a credential is
 * minted through the issuer, then written here - and so the issuer's
 * signature stays untouched. `credentialId` is this platform's own Mongo
 * `_id` (stringified), used as the opaque secret name, never a
 * provider-specific id. `issuerKey` is the key of the issuer that minted the
 * credential; the live vault registry routes on it and the real vault
 * adapters ignore it. `environment` is the credential's own environment, which
 * the real vault adapter resolves to that environment's tenants vault.
 * @typedef {object} CredentialVault
 * @property {(params: {credentialId: string, issuerKey?: string, environment?: string|null, secret: string, tags?: Record<string, string>, expiresOn?: Date}) => Promise<void>} put
 * @property {(params: {credentialId: string, issuerKey?: string, environment?: string|null}) => Promise<string|null>} get
 * @property {(params: {credentialId: string, issuerKey?: string, environment?: string|null}) => Promise<void>} remove
 * @property {(params: {credentialId: string, issuerKey?: string, environment?: string|null, expiresOn: Date}) => Promise<void>} updateExpiry
 */

export {}

/**
 * Port interface for persisting the plaintext secret of an issued
 * credential (e.g. in Azure Key Vault). Kept separate from `CredentialIssuer`
 * because the design treats them as sequential steps - a credential is
 * minted through the issuer, then written here - and so the issuer's
 * signature stays untouched. `credentialId` is this platform's own Mongo
 * `_id` (stringified), used as the opaque secret name, never a
 * provider-specific id. `issuerKey` is the key of the issuer that minted the
 * credential; the live vault registry routes on it and the real vault
 * adapters ignore it.
 * @typedef {object} CredentialVault
 * @property {(params: {credentialId: string, issuerKey?: string, secret: string, tags?: Record<string, string>, expiresOn?: Date}) => Promise<void>} put
 * @property {(params: {credentialId: string, issuerKey?: string}) => Promise<string|null>} get
 * @property {(params: {credentialId: string, issuerKey?: string}) => Promise<void>} remove
 * @property {(params: {credentialId: string, issuerKey?: string, expiresOn: Date}) => Promise<void>} updateExpiry
 */

export {}

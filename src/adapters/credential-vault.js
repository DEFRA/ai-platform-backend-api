/**
 * Port interface for persisting the plaintext secret of an issued
 * credential (e.g. in Azure Key Vault). Kept separate from `CredentialIssuer`
 * because the design treats them as sequential steps - a credential is
 * minted through the issuer, then written here - and so the issuer's
 * signature stays untouched. `credentialId` is this platform's own Mongo
 * `_id` (stringified), used as the opaque secret name, never a
 * provider-specific id.
 * @typedef {object} CredentialVault
 * @property {(params: {credentialId: string, secret: string, tags?: Record<string, string>, expiresOn?: Date}) => Promise<void>} put
 * @property {(params: {credentialId: string}) => Promise<string|null>} get
 * @property {(params: {credentialId: string}) => Promise<void>} remove
 * @property {(params: {credentialId: string, expiresOn: Date}) => Promise<void>} updateExpiry
 */

export {}

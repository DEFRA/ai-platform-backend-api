/**
 * Port interface for issuing tier credentials against a gateway (e.g. Azure APIM).
 * Services depend on this shape only, never on a concrete adapter, so the mock
 * issuer used today can be swapped for a real Azure APIM adapter (or a future
 * second provider, e.g. AWS Bedrock) with no route/service changes.
 * `externalId` is the only provider-specific term in an otherwise
 * provider-neutral interface (an Azure APIM subscription id today) - it is
 * persisted on the credential document as the provider-neutral
 * `externalGatewaySubscriptionId` (renamed 2 Oct 2026 from `apimSubscriptionId`,
 * which is still read as a fallback on documents predating the rename - see
 * `src/common/backfills/registry.js`).
 * @typedef {object} CredentialIssuer
 * @property {(params: {userId: string, modelSlug: string, tier: 'research'|'team', teamId?: string|null, environment?: string|null, credentialType?: 'oauth'|'subscription-key'}) => Promise<{externalId: string, secret: string, keyHint: string, expiresAt: string}>} issue
 * @property {(params: {externalId: string}) => Promise<{externalId: string}>} renew
 * @property {(params: {externalId: string, credentialType?: 'oauth'|'subscription-key'}) => Promise<{externalId: string, secret: string, keyHint: string}>} rotate
 * @property {(params: {externalId: string}) => Promise<{externalId: string}>} revoke
 * @property {(params: {externalId: string}) => Promise<{externalId: string}>} suspend
 */

export {}

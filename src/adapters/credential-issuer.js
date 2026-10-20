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
 * The research tier issues subscription keys; the team tier is OAuth only, so
 * an issuer that serves it issues an OAuth client secret. Every call carries the
 * `environment` the credential was issued in, never the current configuration,
 * so a credential issued in an earlier environment still renews and revokes
 * against the resources that hold it.
 * @typedef {object} CredentialIssuer
 * @property {(params: {userId: string, modelSlug: string, tier: 'research'|'team', teamId?: string|null, environment: string|null}) => Promise<{externalId: string, secret: string, keyHint: string, expiresAt: string}>} issue
 * @property {(params: {externalId: string, expiresAt: string, environment: string|null}) => Promise<{externalId: string}>} renew
 * @property {(params: {externalId: string, environment: string|null}) => Promise<{externalId: string, secret: string, keyHint: string}>} rotate
 * @property {(params: {externalId: string, environment: string|null}) => Promise<{externalId: string}>} revoke
 * @property {(params: {externalId: string, environment: string|null}) => Promise<{externalId: string}>} suspend
 * @property {(params: {environment: string}) => Promise<{name: string, reasons: string[]}[]>} findStraySubscriptions - subscriptions on the gateway that are not research keys on the research API
 */

export {}

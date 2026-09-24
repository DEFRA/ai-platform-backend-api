/**
 * Port interface for issuing tier credentials against a gateway (e.g. Azure APIM).
 * Services depend on this shape only, never on a concrete adapter, so the mock
 * issuer used today can be swapped for a real Azure APIM adapter later with no
 * route/service changes.
 * @typedef {object} CredentialIssuer
 * @property {(params: {userId: string, modelSlug: string, tier: 'research'|'team', teamId?: string|null, environment?: string|null}) => Promise<{apimSubscriptionId: string, secret: string, keyHint: string, expiresAt: string}>} issue
 * @property {(params: {apimSubscriptionId: string}) => Promise<{apimSubscriptionId: string}>} renew
 * @property {(params: {apimSubscriptionId: string}) => Promise<{apimSubscriptionId: string}>} revoke
 * @property {(params: {apimSubscriptionId: string}) => Promise<{apimSubscriptionId: string}>} suspend
 */

export {}

import { randomUUID } from 'node:crypto'

import { config } from '#/config.js'

// Deterministic failure hook for tests: any x-user-id with this prefix makes
// the mock issuer throw, exercising the 502 upstream-unavailable path against
// a real, eligible model without needing a reserved test-only model in the
// production catalogue seed.
const FORCED_FAILURE_USER_PREFIX = 'test-fail-'

/**
 * Mock credential issuer used until the real Azure APIM adapter is wired up.
 * Generates a fake subscription key locally instead of calling Azure.
 * @type {import('./credential-issuer.js').CredentialIssuer}
 */
export const mockCredentialIssuer = {
  async issue({ userId, modelSlug }) {
    if (userId.startsWith(FORCED_FAILURE_USER_PREFIX)) {
      throw new Error('Mock issuer forced failure')
    }

    const secret = `mock_${randomUUID().replace(/-/g, '')}`
    const ttlDays = config.get('research.credentialTtlDays')
    const expiresAt = new Date(
      Date.now() + ttlDays * 24 * 60 * 60 * 1000
    ).toISOString()

    return {
      apimSubscriptionId: `research-${userId}-${modelSlug}`,
      secret,
      keyHint: secret.slice(-4),
      expiresAt
    }
  },

  async renew({ apimSubscriptionId }) {
    return { apimSubscriptionId }
  },

  async revoke({ apimSubscriptionId }) {
    return { apimSubscriptionId }
  },

  async suspend({ apimSubscriptionId }) {
    return { apimSubscriptionId }
  }
}

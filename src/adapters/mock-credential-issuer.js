import { randomUUID } from 'node:crypto'

import { config } from '#/config.js'

/**
 * Mock credential issuer used until the real Azure APIM adapter is wired up.
 * Generates a fake subscription key locally instead of calling Azure.
 * @type {import('./credential-issuer.js').CredentialIssuer}
 */
export const mockCredentialIssuer = {
  async issue({ userId, modelSlug }) {
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

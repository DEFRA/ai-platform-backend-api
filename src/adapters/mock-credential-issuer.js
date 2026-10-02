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
  async issue({
    userId,
    modelSlug,
    tier = 'research',
    teamId,
    environment,
    credentialType = 'subscription-key'
  }) {
    if (userId.startsWith(FORCED_FAILURE_USER_PREFIX)) {
      throw new Error('Mock issuer forced failure')
    }

    const ttlDays = config.get('research.credentialTtlDays')
    const expiresAt = new Date(
      Date.now() + ttlDays * 24 * 60 * 60 * 1000
    ).toISOString()

    if (tier === 'team') {
      // Shared across the whole team+environment, not per model or per
      // member - one credential covers every model in the team's allow-list.
      const secret =
        credentialType === 'oauth'
          ? `mock-oauth-${randomUUID().replace(/-/g, '')}`
          : `mock-key-${randomUUID().replace(/-/g, '')}`

      return {
        externalId: `team-${teamId}-${environment}`,
        secret,
        keyHint: secret.slice(-4),
        expiresAt
      }
    }

    const secret = `mock_${randomUUID().replace(/-/g, '')}`

    return {
      externalId: `research-${userId}-${modelSlug}`,
      secret,
      keyHint: secret.slice(-4),
      expiresAt
    }
  },

  async renew({ externalId }) {
    return { externalId }
  },

  async rotate({ externalId, credentialType = 'subscription-key' }) {
    const isTeamCredential = externalId.startsWith('team-')
    const secret = !isTeamCredential
      ? `mock_${randomUUID().replace(/-/g, '')}`
      : credentialType === 'oauth'
        ? `mock-oauth-${randomUUID().replace(/-/g, '')}`
        : `mock-key-${randomUUID().replace(/-/g, '')}`

    return { externalId, secret, keyHint: secret.slice(-4) }
  },

  async revoke({ externalId }) {
    return { externalId }
  },

  async suspend({ externalId }) {
    return { externalId }
  }
}

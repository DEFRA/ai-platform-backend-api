import { randomUUID } from 'node:crypto'

import { config } from '#/config.js'
import { keyHintFor } from '#/adapters/key-hint.js'

// Deterministic failure hook for tests: any user ID with this prefix makes
// the mock issuer throw, exercising the 502 upstream-unavailable path against
// a real, eligible model without needing a reserved test-only model in the
// production catalogue seed.
const FORCED_FAILURE_USER_PREFIX = 'test-fail-'

function randomToken() {
  return randomUUID().replaceAll('-', '')
}

function mockOauthSecret() {
  return `mock-oauth-${randomToken()}`
}

function mockApiKey() {
  return `mock_${randomToken()}`
}

// Shared across the whole team+environment, not per model or per member -
// one credential covers every model in the team's allow-list. The team
// tier is OAuth only, so its secret is an OAuth client secret. A secret an
// Admin adds names itself by its credential id, so each is its own to
// rotate and revoke.
function teamCredential({ teamId, environment, credentialId }, expiresAt) {
  const secret = mockOauthSecret()
  const suffix = credentialId ? `-${credentialId}` : ''

  return {
    externalId: `team-${teamId}-${environment}${suffix}`,
    secret,
    keyHint: keyHintFor(secret),
    expiresAt
  }
}

/**
 * Mock credential issuer used until the real Azure APIM adapter is wired up.
 * Generates a fake subscription key locally instead of calling Azure, or for
 * the team tier (OAuth only) a fake OAuth client secret.
 * @type {import('./credential-issuer.js').CredentialIssuer}
 */
export const mockCredentialIssuer = {
  async issue({
    userId,
    modelSlug,
    tier = 'research',
    teamId,
    environment,
    credentialId,
    expiresAt: requestedExpiry
  }) {
    if (userId.startsWith(FORCED_FAILURE_USER_PREFIX)) {
      throw new Error('Mock issuer forced failure')
    }

    const ttlDays = config.get('research.credentialTtlDays')
    const expiresAt =
      requestedExpiry ??
      new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString()

    if (tier === 'team') {
      return teamCredential({ teamId, environment, credentialId }, expiresAt)
    }

    const secret = mockApiKey()

    return {
      externalId: `research-${userId}-${modelSlug}`,
      secret,
      keyHint: keyHintFor(secret),
      expiresAt
    }
  },

  async renew({ externalId }) {
    return { externalId }
  },

  async rotate({ externalId }) {
    const secret = externalId.startsWith('team-')
      ? mockOauthSecret()
      : mockApiKey()

    return { externalId, secret, keyHint: keyHintFor(secret) }
  },

  async revoke({ externalId }) {
    return { externalId }
  },

  async suspend({ externalId }) {
    return { externalId }
  },

  async findStraySubscriptions() {
    return []
  }
}

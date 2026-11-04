import Jwt from '@hapi/jwt'

import { config } from '#/config.js'
import { createIdentityValidator } from '#/common/helpers/auth/identity.js'

export const STRATEGY = 'portal'
export const INVALID_TOKEN = 'invalid-token'

const ENTRA_AUTHORITY = 'https://login.microsoftonline.com'
const REALM = 'aip-portal'
const ALGORITHMS = ['RS256']
const CLOCK_SKEW_SECONDS = 60

// Entra publishes a new signing key ahead of using it. A key set older than
// the stale time is fetched again on the next request, so an unknown key ID
// waits at most that long; a failed fetch keeps serving the last good set.
const KEY_CACHE = {
  expiresIn: 24 * 60 * 60 * 1000,
  staleIn: 5 * 60 * 1000,
  staleTimeout: 1000,
  generateTimeout: 30 * 1000
}

/**
 * Where tokens come from: the Defra tenant's v2 issuer and signing keys, or,
 * for local development only, the frontend's mock OpenID provider.
 * @param {{tenantId: string, mockIssuerUrl?: string|null}} settings
 */
export function tokenSource({ tenantId, mockIssuerUrl }) {
  if (mockIssuerUrl) {
    const issuer = mockIssuerUrl.replace(/\/+$/, '')

    return { issuer, jwksUri: `${issuer}/jwks` }
  }

  return {
    issuer: `${ENTRA_AUTHORITY}/${tenantId}/v2.0`,
    jwksUri: `${ENTRA_AUTHORITY}/${tenantId}/discovery/v2.0/keys`
  }
}

// Any 401 on a protected route is `invalid-token`; the challenge says only
// that a token is needed when none was sent, as RFC 6750 asks.
function challengeFor(request) {
  return request.headers.authorization
    ? `Bearer realm="${REALM}", error="invalid_token"`
    : `Bearer realm="${REALM}"`
}

function describeUnauthorised(request, h) {
  const { response } = request

  if (
    response.isBoom &&
    response.output.statusCode === 401 &&
    request.auth.mode === 'required'
  ) {
    response.data = { code: INVALID_TOKEN }
    response.output.headers['WWW-Authenticate'] = challengeFor(request)
  }

  return h.continue
}

/**
 * Authentication for every route, denying by default. A request needs an
 * Entra access token for this instance's API (design E #portal); the
 * signature, issuer, audience and times are checked by `@hapi/jwt` and the
 * rest by `createIdentityValidator`. Registers the keys' first fetch before
 * the server starts, so a server that cannot reach them does not start.
 * `/health` and the maintenance route opt out with `auth: false`.
 */
export const auth = {
  plugin: {
    name: 'portal-auth',
    register: async (server) => {
      const { tenantId, audience, clientId, mockIssuerUrl } =
        config.get('portalAuth')
      const { issuer, jwksUri } = tokenSource({ tenantId, mockIssuerUrl })

      await server.register(Jwt)

      server.auth.strategy(STRATEGY, 'jwt', {
        keys: [{ uri: jwksUri, algorithms: ALGORITHMS }],
        cache: KEY_CACHE,
        verify: {
          aud: audience,
          iss: issuer,
          sub: false,
          nbf: true,
          exp: true,
          timeSkewSec: CLOCK_SKEW_SECONDS
        },
        validate: createIdentityValidator({ tenantId, clientId })
      })
      server.auth.default(STRATEGY)

      server.ext('onPreResponse', describeUnauthorised)
    }
  }
}

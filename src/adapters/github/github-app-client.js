import { Octokit } from 'octokit'
import { createAppAuth } from '@octokit/auth-app'

import { config } from '#/config.js'

/**
 * GitHub's REST API version, pinned on every request (D11) so a change of
 * GitHub's default can never alter a response shape - in this version the
 * workflow dispatch endpoint returns the run it created.
 */
export const GITHUB_API_VERSION = '2026-03-10'

/**
 * CDP's secret store (and many others) rejects values containing real
 * newlines, so the private key is stored base64-encoded as a single line -
 * decode it here, since @octokit/auth-app needs a genuine multi-line PEM to
 * sign JWTs.
 * @param {string | null} base64PrivateKey
 * @returns {string | null}
 */
export function toPemPrivateKey(base64PrivateKey) {
  return base64PrivateKey
    ? Buffer.from(base64PrivateKey, 'base64').toString('utf8')
    : null
}

// Every caller owns its resilience (the catalogue falls back to its last
// good mirror, the orchestrator backs off and polls again later), so
// octokit's bundled retry and throttling plugins - which would sleep inside
// a request for minutes on a rate limit - are both off.
function createBaseOctokit(auth) {
  const octokit = new Octokit({
    auth,
    request: { retries: 0 },
    throttle: { enabled: false }
  })

  octokit.hook.before('request', (options) => {
    options.headers['x-github-api-version'] = GITHUB_API_VERSION
  })

  return octokit
}

/**
 * Creates an Octokit client for one use. Authenticates as the GitHub App
 * installation when App credentials are configured, with an installation
 * token down-scoped to `repositoryNames` and `permissions` (so, for example,
 * a dispatch token can write Actions on one repository and nothing else);
 * otherwise falls back to `github.token` (a PAT, catalogue reads only) or no
 * auth. Tokens are minted lazily on first request and cached until shortly
 * before they expire.
 * @param {{repositoryNames?: string[], permissions?: Record<string, 'read'|'write'>}} [scope]
 * @returns {Octokit}
 */
export function createGithubAppClient({ repositoryNames, permissions } = {}) {
  // Client ID is GitHub's current recommendation over the numeric App ID -
  // @octokit/auth-app's `appId` field accepts either value interchangeably.
  const appId = config.get('github.clientId') || config.get('github.appId')
  const privateKey = toPemPrivateKey(config.get('github.privateKey'))

  if (!appId || !privateKey) {
    return createBaseOctokit(config.get('github.token') ?? undefined)
  }

  // The App's own requests (the JWT-signed token exchange) go through a
  // separate, unauthenticated client so they never re-enter the hook below.
  const appAuth = createAppAuth({
    appId,
    privateKey,
    installationId: config.get('github.installationId'),
    request: createBaseOctokit().request
  })
  const octokit = createBaseOctokit()

  octokit.hook.before('request', async (options) => {
    const { token } = await appAuth({
      type: 'installation',
      repositoryNames,
      permissions
    })

    options.headers.authorization = `token ${token}`
  })

  return octokit
}

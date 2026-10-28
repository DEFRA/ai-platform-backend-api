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
 * The only GitHub App permissions the backend may ever request, all at read
 * level (plan 6.3): contents for the state and catalogue files, actions for
 * corroborating runs and their reports, metadata for actor permissions. A
 * `write` value or any other permission is refused.
 */
export const GITHUB_READ_PERMISSIONS = Object.freeze({
  contents: 'read',
  actions: 'read',
  metadata: 'read'
})

const READ_METHODS = new Set(['GET', 'HEAD'])

function assertScope(repositoryNames, permissions) {
  if (
    !Array.isArray(repositoryNames) ||
    repositoryNames.length === 0 ||
    !permissions ||
    Object.keys(permissions).length === 0
  ) {
    throw new Error(
      'A GitHub client needs explicit repositoryNames and permissions'
    )
  }

  for (const [name, level] of Object.entries(permissions)) {
    if (
      !Object.hasOwn(GITHUB_READ_PERMISSIONS, name) ||
      GITHUB_READ_PERMISSIONS[name] !== level
    ) {
      throw new Error(
        `The backend may only request read permissions on ${Object.keys(GITHUB_READ_PERMISSIONS).join(', ')}; refused ${name}: ${level}`
      )
    }
  }
}

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
// good mirror, the readers back off on a rate limit), so octokit's bundled
// retry and throttling plugins - which would sleep inside a request for
// minutes on a rate limit - are both off.
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

// The backend only reads: any request that is not a GET or HEAD is refused,
// whatever token the client holds. Octokit runs the hook registered last
// first, so this is registered after the others and refuses before a token
// is minted.
function refuseWrites(octokit) {
  octokit.hook.before('request', (options) => {
    if (!READ_METHODS.has(options.method)) {
      const error = new Error(
        `The backend's GitHub client is read-only; refused ${options.method} ${options.url}`
      )
      error.code = 'github-write-refused'
      throw error
    }
  })

  return octokit
}

/**
 * Creates a read-only Octokit client for one use. Authenticates as the GitHub
 * App installation when App credentials are configured, with an installation
 * token down-scoped to the required `repositoryNames` and `permissions`, which
 * must be read permissions from `GITHUB_READ_PERMISSIONS` (anything else
 * throws); otherwise falls back to `github.token` (a PAT, catalogue reads
 * only) or no auth. Tokens are minted lazily on first request and cached
 * until shortly before they expire. Any request other than a GET or HEAD is
 * refused.
 * @param {{repositoryNames: string[], permissions: Record<string, 'read'>}} scope
 * @returns {Octokit}
 */
export function createGithubAppClient({ repositoryNames, permissions } = {}) {
  assertScope(repositoryNames, permissions)

  // Client ID is GitHub's current recommendation over the numeric App ID -
  // @octokit/auth-app's `appId` field accepts either value interchangeably.
  const appId = config.get('github.clientId') || config.get('github.appId')
  const privateKey = toPemPrivateKey(config.get('github.privateKey'))

  if (!appId || !privateKey) {
    return refuseWrites(
      createBaseOctokit(config.get('github.token') ?? undefined)
    )
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

  return refuseWrites(octokit)
}

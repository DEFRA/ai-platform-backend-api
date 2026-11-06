import { createPublicKey } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'

import { statusCodes } from '#/common/constants/status-codes.js'

// The tenant's signing keys (design E #portal), fetched by this module and
// not by `@hapi/jwt`: the library reads them with `@hapi/wreck`, whose own
// `https.Agent` ignores the proxy that CDP gives every service
// (`NODE_USE_ENV_PROXY` only reaches Node's global agents), so on CDP the key
// fetch would go direct, fail, and the backend would refuse to start.

export const SIGNING_ALGORITHMS = Object.freeze(['RS256'])

const REQUEST_TIMEOUT_MS = 10 * 1000
const MAX_BODY_BYTES = 256 * 1024

/**
 * The agent for a key address. An `https:` address goes through the proxy
 * named by `HTTPS_PROXY` (and not through it for hosts in `NO_PROXY`) when
 * the environment names one; a plain `http:` address, only the local mock
 * issuer, goes direct.
 * @param {string} uri
 * @param {NodeJS.ProcessEnv} env
 */
export function agentFor(uri, env = process.env) {
  return uri.startsWith('https:')
    ? new https.Agent({ proxyEnv: env })
    : undefined
}

function getJson(uri, { agent, timeoutMs }) {
  const client = uri.startsWith('https:') ? https : http

  return new Promise((resolve, reject) => {
    const fail = (error) => {
      request.destroy()
      reject(error)
    }
    const request = client.get(
      uri,
      { agent, timeout: timeoutMs, headers: { accept: 'application/json' } },
      (response) => {
        if (response.statusCode !== statusCodes.ok) {
          fail(new Error(`The key endpoint answered ${response.statusCode}`))
          return
        }

        const chunks = []
        let size = 0

        response.on('data', (chunk) => {
          size += chunk.length

          if (size > MAX_BODY_BYTES) {
            fail(new Error('The key endpoint answered too much'))
            return
          }

          chunks.push(chunk)
        })
        response.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch {
            reject(new Error('The key endpoint did not answer JSON'))
          }
        })
        response.on('error', reject)
      }
    )

    request.on('timeout', () => fail(new Error('The key endpoint timed out')))
    request.on('error', reject)
  })
}

// Whether `createPublicKey` can read the key, the call `keyFor` makes when a
// token names it. Checked here so a malformed key never reaches the cache:
// a refresh left with no usable key throws, and the cache keeps the last good
// set (`dropOnError: false`).
function isReadableKey(jwk) {
  try {
    createPublicKey({ key: jwk, format: 'jwk' })

    return true
  } catch {
    return false
  }
}

const hasSigningFields = (key) =>
  key?.use === 'sig' &&
  key.kty === 'RSA' &&
  typeof key.kid === 'string' &&
  key.kid !== '' &&
  Boolean(key.n) &&
  Boolean(key.e)

const isSigningKey = (key) => hasSigningFields(key) && isReadableKey(key)

/**
 * Fetches a key set and keeps only the RSA signing keys that can be read, as
 * plain JSON so a cache can hold it. Throws when the endpoint fails or holds
 * no usable key.
 * @param {string} uri
 * @param {{env?: NodeJS.ProcessEnv, timeoutMs?: number}} [options]
 * @returns {Promise<object[]>}
 */
export async function fetchSigningKeys(
  uri,
  { env = process.env, timeoutMs = REQUEST_TIMEOUT_MS } = {}
) {
  const payload = await getJson(uri, { agent: agentFor(uri, env), timeoutMs })
  const keys = Array.isArray(payload?.keys)
    ? payload.keys.filter(isSigningKey)
    : []

  if (keys.length === 0) {
    throw new Error('The key endpoint holds no signing key')
  }

  return keys
}

/**
 * The key the `@hapi/jwt` provider needs for one key ID, or nothing when the
 * tenant publishes none by that ID (the token is then refused).
 * @param {object[]} keys from `fetchSigningKeys`
 * @param {string|undefined} kid
 */
export function keyFor(keys, kid) {
  const jwk = kid ? keys.find((key) => key.kid === kid) : undefined

  return jwk
    ? {
        key: createPublicKey({ key: jwk, format: 'jwk' }),
        algorithms: [...SIGNING_ALGORITHMS],
        kid
      }
    : undefined
}

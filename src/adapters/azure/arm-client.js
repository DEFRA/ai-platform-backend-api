import { getArmCredential } from '#/adapters/azure/azure-credential.js'

const ARM_BASE_URL = 'https://management.azure.com'
const ARM_SCOPE = 'https://management.azure.com/.default'
const ACCEPTED = 202
const OPERATION_TIMEOUT_MS = 120_000
const DEFAULT_POLL_MS = 2000
const FAILED_STATES = new Set(['failed', 'canceled', 'cancelled'])

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)

    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true }
    )
  })
}

// The bearer token goes to the status URL ARM gave, so it must be ARM's own.
function statusOf(response) {
  const asyncOperation = response.headers.get('azure-asyncoperation')
  const url = asyncOperation ?? response.headers.get('location')

  return url?.startsWith(`${ARM_BASE_URL}/`)
    ? { url, isAsyncOperation: Boolean(asyncOperation) }
    : null
}

function pollDelayOf(response, defaultPollMs) {
  const seconds = Number(response.headers.get('retry-after'))

  return Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1000
    : defaultPollMs
}

/**
 * Creates a single-purpose Azure Resource Manager request client. Knows
 * nothing about credentials, subscriptions or models - callers supply the
 * full ARM path (starting `/subscriptions/...`) and get back parsed JSON (or
 * `null` for a 204). Never `{apim}.management.azure-api.net` - always
 * `management.azure.com`, authenticated with an Entra bearer token. A `202
 * Accepted` is followed (`Azure-AsyncOperation`, else `Location`, at the
 * `Retry-After` pace) until the operation ends, so a resolved request is a
 * finished one; Failed, Canceled, no status URL or the wait (`operationTimeoutMs`,
 * or a call's own `maxWaitMs`) running out throws.
 * @param {{getCredential?: () => import('@azure/identity').TokenCredential, operationTimeoutMs?: number, defaultPollMs?: number}} [deps]
 * @returns {{request: (method: string, path: string, options?: {body?: object, ifMatch?: string, maxWaitMs?: number}) => Promise<object|null>}}
 */
export function createArmClient({
  getCredential = getArmCredential,
  operationTimeoutMs = OPERATION_TIMEOUT_MS,
  defaultPollMs = DEFAULT_POLL_MS
} = {}) {
  async function send(method, url, { body, ifMatch, signal } = {}) {
    const credential = getCredential()
    const token = await credential.getToken(ARM_SCOPE)

    const headers = {
      authorization: `Bearer ${token.token}`,
      'content-type': 'application/json'
    }

    if (ifMatch) {
      headers['if-match'] = ifMatch
    }

    return fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal
    })
  }

  // ARM doesn't reliably use 204 for an empty body - a subscription DELETE
  // can come back 200 with nothing to parse, so check the body itself
  // rather than trusting the status code.
  async function parsed(response) {
    const text = await response.text()
    return text ? JSON.parse(text) : null
  }

  // Never include the response body - on `listSecrets` it can carry the
  // subscription key, and this message may end up in logs or an error path.
  function failure(method, path, what) {
    return new Error(`ARM request failed: ${method} ${path} -> ${what}`)
  }

  // A body nobody reads keeps its socket until garbage collection.
  async function discard(response) {
    await response.body?.cancel()
  }

  async function awaitOperation(method, path, accepted, maxWaitMs) {
    const status = statusOf(accepted)

    await discard(accepted)

    if (!status) {
      throw failure(method, path, 'accepted with no status URL')
    }

    const signal = AbortSignal.timeout(maxWaitMs)
    let delay = pollDelayOf(accepted, defaultPollMs)

    try {
      for (;;) {
        await sleep(delay, signal)

        const response = await send('GET', status.url, { signal })

        if (!response.ok) {
          await discard(response)
          throw failure(method, path, `${response.status} while polling`)
        }

        if (response.status === ACCEPTED) {
          await discard(response)
        } else {
          const result = await parsed(response)
          const state = String(result?.status ?? '').toLowerCase()

          if (!status.isAsyncOperation) {
            return result
          }

          if (state === 'succeeded') {
            return null
          }

          if (FAILED_STATES.has(state)) {
            throw failure(method, path, `operation ${state}`)
          }
        }

        delay = pollDelayOf(response, defaultPollMs)
      }
    } catch (error) {
      if (signal.aborted) {
        throw failure(method, path, 'operation timed out')
      }

      throw error
    }
  }

  async function request(method, path, options = {}) {
    const { maxWaitMs = operationTimeoutMs, ...sendOptions } = options
    const response = await send(method, `${ARM_BASE_URL}${path}`, sendOptions)

    if (!response.ok) {
      throw failure(method, path, response.status)
    }

    if (response.status === ACCEPTED) {
      return awaitOperation(method, path, response, maxWaitMs)
    }

    return parsed(response)
  }

  return { request }
}

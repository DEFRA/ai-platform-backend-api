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

// Number('') is 0, so an empty header must be ruled out before converting.
function pollDelayOf(response, defaultPollMs) {
  const header = response.headers.get('retry-after')?.trim()
  const seconds = header ? Number(header) : Number.NaN

  return Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1000
    : defaultPollMs
}

// A credential may ignore the abort signal, so race it rather than trust it.
function abortable(promise, signal) {
  signal.throwIfAborted()

  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true
      })
    })
  ])
}

async function sendRequest(
  getCredential,
  method,
  url,
  { body, ifMatch, signal }
) {
  const credential = getCredential()
  const token = await abortable(
    credential.getToken(ARM_SCOPE, { abortSignal: signal }),
    signal
  )

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

// `done: false` means the operation is still running.
function outcomeOf(result, isAsyncOperation, method, path) {
  if (!isAsyncOperation) {
    return { done: true, value: result }
  }

  const state = String(result?.status ?? '').toLowerCase()

  if (state === 'succeeded') {
    return { done: true, value: null }
  }

  if (FAILED_STATES.has(state)) {
    throw failure(method, path, `operation ${state}`)
  }

  return { done: false }
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
  function send(method, url, options) {
    return sendRequest(getCredential, method, url, options)
  }

  async function awaitOperation(method, path, accepted, signal) {
    const status = statusOf(accepted)

    await discard(accepted)

    if (!status) {
      throw failure(method, path, 'accepted with no status URL')
    }

    let delay = pollDelayOf(accepted, defaultPollMs)

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
        const outcome = outcomeOf(
          await parsed(response),
          status.isAsyncOperation,
          method,
          path
        )

        if (outcome.done) {
          return outcome.value
        }
      }

      delay = pollDelayOf(response, defaultPollMs)
    }
  }

  // One deadline from here covers the token, the request, the body read and
  // every poll; a caller's own signal can still cancel earlier.
  async function request(method, path, options = {}) {
    const { maxWaitMs = operationTimeoutMs, signal: caller, ...rest } = options
    const deadline = AbortSignal.timeout(maxWaitMs)
    const signal = caller ? AbortSignal.any([deadline, caller]) : deadline

    try {
      const response = await send(method, `${ARM_BASE_URL}${path}`, {
        ...rest,
        signal
      })

      if (!response.ok) {
        await discard(response)
        throw failure(method, path, response.status)
      }

      if (response.status === ACCEPTED) {
        return await awaitOperation(method, path, response, signal)
      }

      return await abortable(parsed(response), signal)
    } catch (error) {
      if (deadline.aborted) {
        throw failure(method, path, 'operation timed out')
      }

      throw error
    }
  }

  return { request }
}

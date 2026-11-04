import { createHash } from 'node:crypto'

import { OnBehalfOfCredential } from '@azure/identity'

import { config } from '#/config.js'
import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { createLogger } from '#/common/helpers/logging/logger.js'

const SELECT = 'id,displayName,mail,userPrincipalName'
const SEARCH_TOP = 50
const HTTP_NOT_FOUND = 404
// A token is replaced this long before it expires, so a call never starts
// with one about to lapse.
const REFRESH_MARGIN_MS = 2 * 60 * 1000
const DEFAULT_MAX_CACHED_TOKENS = 500

// What a failure is logged against.
const SEARCH = 'search'
const GET_PERSON = 'get-person'

/**
 * Quotes text into a `$search` phrase for a field: a quote or backslash in the
 * text is escaped so it cannot end the phrase and add terms of its own.
 * @param {string} field
 * @param {string} text
 */
function quoted(field, text) {
  const escaped = text.replaceAll(/[\\"]/g, String.raw`\$&`)

  return `"${field}:${escaped}"`
}

function toPerson(user) {
  return {
    oid: user.id,
    displayName: user.displayName ?? '',
    mail: user.mail ?? null,
    userPrincipalName: user.userPrincipalName ?? ''
  }
}

// What the log may say about a failure: the HTTP status, the error's name and
// the AADSTS code at the start of an Entra error. Never its message or body,
// which can carry a trace ID or a name.
function describeFailure(operation, cause) {
  return {
    operation,
    status: cause?.status ?? cause?.statusCode,
    errorName: cause?.name,
    aadstsCode: /AADSTS\d+/.exec(cause?.message ?? '')?.[0]
  }
}

// A call stops at its own timeout and, when it is part of a larger operation
// (a search), when that operation's signal aborts.
function callSignal(timeoutMs, signal) {
  return AbortSignal.any(
    signal
      ? [AbortSignal.timeout(timeoutMs), signal]
      : [AbortSignal.timeout(timeoutMs)]
  )
}

function withTimeout(work, timeoutMs) {
  let timer

  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error('Timed out')
      error.name = 'TimeoutError'
      reject(error)
    }, timeoutMs)
  })

  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Logs a failed directory request (only what {@link describeFailure} allows)
 * and makes the `503` every failure is answered with.
 * @param {{warn: (fields: object, message: string) => void}} logger
 * @param {string} operation
 * @param {unknown} cause
 */
function directoryUnavailable(logger, operation, cause) {
  logger.warn(
    { directory: describeFailure(operation, cause) },
    'Directory request failed'
  )

  return boomWithCode(
    Boom.serverUnavailable,
    'The directory is unavailable',
    'directory-unavailable'
  )
}

/**
 * Exchanges a user assertion for a Graph token and keeps the result in
 * memory, per assertion, until shortly before it expires. Keyed on a hash of
 * the assertion, so a token is only ever reused by the very assertion it was
 * exchanged for.
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} params.clientId
 * @param {() => Promise<string>} params.getClientAssertion
 * @param {string} params.scope
 * @param {number} params.timeoutMs
 * @param {number} params.maxCachedTokens
 * @param {() => number} params.now
 * @param {(options: object) => {getToken: (scope: string, options: {abortSignal: AbortSignal}) => Promise<{token: string, expiresOnTimestamp: number}>}} params.createCredential
 * @returns {(userAssertion: string, signal?: AbortSignal) => Promise<string>}
 */
function createTokenSource({
  tenantId,
  clientId,
  getClientAssertion,
  scope,
  timeoutMs,
  maxCachedTokens,
  now,
  createCredential
}) {
  const tokens = new Map()

  return async function tokenFor(userAssertion, signal) {
    const key = createHash('sha256').update(userAssertion).digest('hex')
    const cached = tokens.get(key)

    if (cached && cached.expiresOn - REFRESH_MARGIN_MS > now()) {
      return cached.token
    }

    const credential = createCredential({
      tenantId,
      clientId,
      getAssertion: getClientAssertion,
      userAssertionToken: userAssertion,
      disableInstanceDiscovery: true
    })
    // The signal aborts the exchange's own request at the timeout, or when the
    // search it is for runs out of time; the race still answers at the
    // timeout if the library does not honour it.
    const { token, expiresOnTimestamp } = await withTimeout(
      credential.getToken(scope, {
        abortSignal: callSignal(timeoutMs, signal)
      }),
      timeoutMs
    )

    tokens.delete(key)
    tokens.set(key, { token, expiresOn: expiresOnTimestamp })

    while (tokens.size > maxCachedTokens) {
      tokens.delete(tokens.keys().next().value)
    }

    return token
  }
}

/**
 * What the `Directory` methods need of a Graph client: send a request as the
 * person (stopping at `signal` as well as at the per-call timeout), read its
 * JSON, and make the `503` for a failure.
 * @typedef {object} GraphClient
 * @property {(operation: string, userAssertion: string|undefined, path: string, signal?: AbortSignal) => Promise<Response>} send
 * @property {(operation: string, response: Response) => Promise<any>} readJson
 * @property {(operation: string, cause: unknown) => Error} unavailable
 */

/**
 * The path (relative to `/v1.0`) of the next page of a search, or null when
 * Graph names none. The link is only followed when it is the users endpoint
 * on Graph's own origin: the request carries the Admin's token, so a link to
 * anywhere else is refused, not followed.
 * @param {unknown} nextLink - `@odata.nextLink` from the page
 * @param {URL} usersUrl - the users endpoint, `{baseUrl}/v1.0/users`
 * @returns {string|null}
 */
function nextPagePath(nextLink, usersUrl) {
  if (nextLink === undefined || nextLink === null) {
    return null
  }

  const link = typeof nextLink === 'string' ? URL.parse(nextLink) : null

  if (
    !link ||
    link.origin !== usersUrl.origin ||
    link.pathname !== usersUrl.pathname
  ) {
    throw new TypeError('UnexpectedNextLink')
  }

  return `/users${link.search}`
}

/**
 * Reads the pages of a search, following `@odata.nextLink`, until Graph has
 * no more or `maxPages` have been read.
 * @param {GraphClient} graph
 * @param {{userAssertion?: string, query: string}} params
 * @param {{usersUrl: URL, maxPages: number, signal: AbortSignal}} limits
 */
async function readPages(
  { send, readJson, unavailable },
  { userAssertion, query },
  { usersUrl, maxPages, signal }
) {
  const phrase = `${quoted('displayName', query)} OR ${quoted('mail', query)}`
  let path = `/users?$search=${encodeURIComponent(phrase)}&$select=${SELECT}&$top=${SEARCH_TOP}`
  const people = []

  for (let page = 0; path && page < maxPages; page++) {
    const response = await send(SEARCH, userAssertion, path, signal)

    if (!response.ok) {
      throw unavailable(SEARCH, response)
    }

    const body = await readJson(SEARCH, response)

    if (!Array.isArray(body?.value)) {
      throw unavailable(SEARCH, { name: 'UnexpectedResponse' })
    }

    people.push(...body.value.map(toPerson))

    try {
      path = nextPagePath(body['@odata.nextLink'], usersUrl)
    } catch {
      throw unavailable(SEARCH, { name: 'UnexpectedNextLink' })
    }
  }

  return people
}

/**
 * Every person the search finds within the page and time budget. The eligible
 * and not-yet-members are chosen from these by the caller, so the budget is
 * what lets an addable person behind a first page of members or guests be
 * found; a search that needs more is answered with what was read.
 * @param {GraphClient} graph
 * @param {{userAssertion?: string, query: string}} params
 * @param {{usersUrl: URL, maxPages: number, timeoutMs: number}} limits
 */
async function searchPeople(graph, params, { usersUrl, maxPages, timeoutMs }) {
  try {
    return await withTimeout(
      readPages(graph, params, {
        usersUrl,
        maxPages,
        signal: AbortSignal.timeout(timeoutMs)
      }),
      timeoutMs
    )
  } catch (error) {
    throw error?.isBoom ? error : graph.unavailable(SEARCH, error)
  }
}

/**
 * @param {GraphClient} graph
 * @param {{userAssertion?: string, oid: string}} params
 */
async function getPerson(
  { send, readJson, unavailable },
  { userAssertion, oid }
) {
  const response = await send(
    GET_PERSON,
    userAssertion,
    `/users/${encodeURIComponent(oid)}?$select=${SELECT}`
  )

  if (response.status === HTTP_NOT_FOUND) {
    return null
  }

  if (!response.ok) {
    throw unavailable(GET_PERSON, response)
  }

  return toPerson(await readJson(GET_PERSON, response))
}

/**
 * A `Directory` over Microsoft Graph, called on behalf of the signed-in
 * person: their access token is exchanged for a Graph token with the portal's
 * own client assertion (the on-behalf-of flow), so Graph sees the Admin and
 * not the service. Tokens are cached in memory, per user assertion, until two
 * minutes before they expire. Every failure - a refused exchange, a Graph
 * error or 429, a timeout, no user assertion - is `503 directory-unavailable`,
 * and the log holds only the status and the AADSTS code.
 * Built but switched off until B27 supplies the person's token (hand-off H1).
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} params.clientId
 * @param {() => Promise<string>} params.getClientAssertion - the portal's federated client assertion
 * @param {string} [params.baseUrl]
 * @param {number} [params.timeoutMs] - for each Graph or token call
 * @param {number} [params.searchMaxPages] - the most pages one search reads
 * @param {number} [params.searchTimeoutMs] - for the whole search, across its pages
 * @param {number} [params.maxCachedTokens]
 * @param {() => number} [params.now]
 * @param {(options: object) => {getToken: Function}} [params.createCredential] - the on-behalf-of credential, replaceable in tests
 * @param {{warn: (fields: object, message: string) => void}} [params.logger]
 * @returns {import('#/adapters/directory.js').Directory}
 */
export function createGraphDirectory({
  tenantId,
  clientId,
  getClientAssertion,
  baseUrl = config.get('directory.graphBaseUrl'),
  timeoutMs = config.get('directory.timeoutMs'),
  searchMaxPages = config.get('directory.searchMaxPages'),
  searchTimeoutMs = config.get('directory.searchTimeoutMs'),
  maxCachedTokens = DEFAULT_MAX_CACHED_TOKENS,
  now = Date.now,
  createCredential = (options) => new OnBehalfOfCredential(options),
  logger = createLogger()
}) {
  const tokenFor = createTokenSource({
    tenantId,
    clientId,
    getClientAssertion,
    scope: `${baseUrl}/.default`,
    timeoutMs,
    maxCachedTokens,
    now,
    createCredential
  })

  function unavailable(operation, cause) {
    return directoryUnavailable(logger, operation, cause)
  }

  async function send(operation, userAssertion, path, signal) {
    if (!userAssertion) {
      throw unavailable(operation, { name: 'MissingUserAssertion' })
    }

    let response

    try {
      const token = await tokenFor(userAssertion, signal)

      response = await fetch(`${baseUrl}/v1.0${path}`, {
        headers: {
          authorization: `Bearer ${token}`,
          consistencylevel: 'eventual',
          accept: 'application/json'
        },
        signal: callSignal(timeoutMs, signal)
      })
    } catch (error) {
      throw unavailable(operation, error)
    }

    return response
  }

  async function readJson(operation, response) {
    try {
      return await response.json()
    } catch (error) {
      throw unavailable(operation, error)
    }
  }

  const graph = { send, readJson, unavailable }
  const searchLimits = {
    usersUrl: new URL(`${baseUrl}/v1.0/users`),
    maxPages: searchMaxPages,
    timeoutMs: searchTimeoutMs
  }

  return {
    searchPeople: (params) => searchPeople(graph, params, searchLimits),
    getPerson: (params) => getPerson(graph, params)
  }
}

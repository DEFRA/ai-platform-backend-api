import nock from 'nock'

import { describeDirectoryContract } from '#/adapters/directory-contract.js'
import { createGraphDirectory } from '#/adapters/azure/graph-directory.js'

const TENANT_ID = '6f504113-6b64-43f2-ade9-242e05780007'
const CLIENT_ID = '11111111-1111-4111-8111-111111111111'
const LOGIN = 'https://login.microsoftonline.com'
const GRAPH = 'https://graph.microsoft.com'
const TOKEN_PATH = `/${TENANT_ID}/oauth2/v2.0/token`

function nockTokenEndpoint() {
  return nock(LOGIN).post(TOKEN_PATH).query(true)
}
const SELECT = 'id,displayName,mail,userPrincipalName'
const USER_TOKEN = 'user-token-abc'
const CLIENT_ASSERTION = 'client-assertion-xyz'

// The repo's global test setup (.vite/setup-files.js) replaces global.fetch
// with vitest-fetch-mock for every file - undo that here so nock, which
// intercepts at the undici level, actually sees the Graph calls. The token
// exchange goes through Node's http module, which nock intercepts too.
const realFetch = globalThis.fetch

beforeAll(() => {
  globalThis.fetch = realFetch
})

afterEach(() => {
  nock.cleanAll()
})

function graphUser(person) {
  return {
    id: person.oid,
    displayName: person.displayName,
    mail: person.mail,
    userPrincipalName: person.userPrincipalName
  }
}

function replyToken({ expiresIn = 3600, onBody } = {}) {
  return nock(LOGIN)
    .persist()
    .post(TOKEN_PATH, (body) => {
      onBody?.(body)
      return true
    })
    .query(true)
    .reply(200, {
      access_token: 'graph-token',
      token_type: 'Bearer',
      expires_in: expiresIn
    })
}

function createDirectory(overrides = {}) {
  return createGraphDirectory({
    tenantId: TENANT_ID,
    clientId: CLIENT_ID,
    getClientAssertion: async () => CLIENT_ASSERTION,
    baseUrl: GRAPH,
    timeoutMs: 2000,
    logger: { warn: vi.fn() },
    ...overrides
  })
}

const ada = {
  oid: '11111111-2222-4333-8444-555555555555',
  displayName: 'Ada Lovelace',
  mail: 'ada.lovelace@defra.gov.uk',
  userPrincipalName: 'ada.lovelace@defra.gov.uk'
}

describeDirectoryContract('graph (nock)', ({ people }) => {
  nock.cleanAll()
  replyToken()
  nock(GRAPH)
    .persist()
    .get('/v1.0/users')
    .query(true)
    .reply(200, { value: people.map(graphUser) })

  for (const person of people) {
    nock(GRAPH)
      .persist()
      .get(`/v1.0/users/${person.oid}`)
      .query(true)
      .reply(200, graphUser(person))
  }

  nock(GRAPH)
    .persist()
    .get(/^\/v1\.0\/users\/[^/?]+/)
    .query(true)
    .reply(404, { error: { code: 'Request_ResourceNotFound' } })

  return createDirectory()
})

describe('#createGraphDirectory on-behalf-of exchange', () => {
  test('sends the user assertion and the client assertion to the tenant token endpoint', async () => {
    let form
    replyToken({ onBody: (body) => (form = body) })
    nock(GRAPH).get('/v1.0/users').query(true).reply(200, { value: [] })

    await createDirectory().searchPeople({
      userAssertion: USER_TOKEN,
      query: 'ada'
    })

    expect(form).toMatchObject({
      client_id: CLIENT_ID,
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      requested_token_use: 'on_behalf_of',
      assertion: USER_TOKEN,
      client_assertion: CLIENT_ASSERTION,
      client_assertion_type:
        'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
    })
    expect(form.scope).toContain('https://graph.microsoft.com/.default')
  })

  test('calls Graph with the exchanged token, never the Admin’s own', async () => {
    replyToken()
    let received
    nock(GRAPH, {
      reqheaders: { authorization: 'Bearer graph-token' }
    })
      .get('/v1.0/users')
      .query(true)
      .reply(200, function reply() {
        received = this.req.headers.authorization

        return { value: [graphUser(ada)] }
      })

    // Graph answers only a request that carries the exchanged token, so the
    // people come back only if that is what was sent.
    const people = await createDirectory().searchPeople({
      userAssertion: USER_TOKEN,
      query: 'ada'
    })

    expect(people).toEqual([ada])
    expect(received).not.toContain(USER_TOKEN)
    expect(received).not.toContain(CLIENT_ASSERTION)
  })
})

describe('#createGraphDirectory search pages', () => {
  // One person per page keeps the pages easy to count.
  const peopleOnPages = Array.from({ length: 8 }, (_, index) => ({
    oid: `00000000-0000-4000-8000-00000000000${index}`,
    displayName: `Person ${index}`,
    mail: `person.${index}@defra.gov.uk`,
    userPrincipalName: `person.${index}@defra.gov.uk`
  }))

  // Graph answers a search one page at a time, each page but the last with
  // the link to the next (`@odata.nextLink`, carrying a `$skiptoken`).
  function graphPages(pageCount) {
    const seen = { pages: [], consistencyLevels: [] }

    nock(GRAPH)
      .persist()
      .get('/v1.0/users')
      .query(true)
      .reply(200, function reply(uri) {
        const page = Number(
          new URL(uri, GRAPH).searchParams.get('$skiptoken') ?? 0
        )

        seen.pages.push(page)
        seen.consistencyLevels.push(this.req.headers.consistencylevel)

        return {
          value: [graphUser(peopleOnPages[page])],
          ...(page + 1 < pageCount && {
            '@odata.nextLink': nextLinkTo(page + 1)
          })
        }
      })

    return seen
  }

  function nextLinkTo(page, base = GRAPH) {
    return `${base}/v1.0/users?$search=%22displayName%3Aada%22&$select=${SELECT}&$top=50&$skiptoken=${page}`
  }

  const search = (directory) =>
    directory.searchPeople({ userAssertion: USER_TOKEN, query: 'ada' })

  async function expectUnavailable(promise) {
    const error = await promise.then(
      () => null,
      (rejected) => rejected
    )

    expect(error?.isBoom).toBe(true)
    expect(error.data.code).toBe('directory-unavailable')
  }

  test('follows @odata.nextLink to the pages after the first, with the same headers', async () => {
    replyToken()
    const seen = graphPages(3)

    const people = await search(createDirectory())

    expect(seen.pages).toEqual([0, 1, 2])
    expect(seen.consistencyLevels).toEqual(['eventual', 'eventual', 'eventual'])
    expect(people.map((person) => person.oid)).toEqual(
      peopleOnPages.slice(0, 3).map((person) => person.oid)
    )
  })

  test('stops at the page budget when Graph still has more pages, and answers with what it read', async () => {
    replyToken()
    const seen = graphPages(8)

    const people = await search(createDirectory({ searchMaxPages: 3 }))

    expect(seen.pages).toEqual([0, 1, 2])
    expect(people).toHaveLength(3)
  })

  test('reads at most 5 pages by default', async () => {
    replyToken()
    const seen = graphPages(8)

    const people = await search(createDirectory())

    expect(seen.pages).toEqual([0, 1, 2, 3, 4])
    expect(people).toHaveLength(5)
  })

  test('gives directory-unavailable when the whole search outlasts its timeout, however fast each page is allowed to be', async () => {
    replyToken()
    nock(GRAPH)
      .get('/v1.0/users')
      .query(true)
      .reply(200, {
        value: [graphUser(peopleOnPages[0])],
        '@odata.nextLink': nextLinkTo(1)
      })
    nock(GRAPH)
      .get('/v1.0/users')
      .query((query) => query.$skiptoken === '1')
      .delay(1000)
      .reply(200, { value: [graphUser(peopleOnPages[1])] })
    const started = Date.now()

    await expectUnavailable(
      search(createDirectory({ timeoutMs: 5000, searchTimeoutMs: 150 }))
    )

    expect(Date.now() - started).toBeLessThan(800)
  })

  test('gives directory-unavailable, not a part of the people, when a later page fails', async () => {
    replyToken()
    nock(GRAPH)
      .get('/v1.0/users')
      .query(true)
      .reply(200, {
        value: [graphUser(peopleOnPages[0])],
        '@odata.nextLink': nextLinkTo(1)
      })
    nock(GRAPH)
      .get('/v1.0/users')
      .query((query) => query.$skiptoken === '1')
      .reply(503, {})

    await expectUnavailable(search(createDirectory()))
  })

  test.each([
    ['another host', nextLinkTo(1, 'https://evil.example.com')],
    ['another scheme', nextLinkTo(1, 'http://graph.microsoft.com')],
    ['another path on Graph', `${GRAPH}/v1.0/me/messages?$skiptoken=1`],
    ['text that is not a URL', 'not a url']
  ])(
    'never sends the Admin’s token to a nextLink on %s',
    async (_, nextLink) => {
      replyToken()
      nock(GRAPH)
        .get('/v1.0/users')
        .query(true)
        .reply(200, {
          value: [graphUser(peopleOnPages[0])],
          '@odata.nextLink': nextLink
        })
      const elsewhere = nock('https://evil.example.com')
        .persist()
        .get(/.*/)
        .reply(200, { value: [] })
      const insecure = nock('http://graph.microsoft.com')
        .persist()
        .get(/.*/)
        .reply(200, { value: [] })
      const messages = nock(GRAPH)
        .get('/v1.0/me/messages')
        .query(true)
        .reply(200)

      await expectUnavailable(search(createDirectory()))

      expect(elsewhere.isDone()).toBe(false)
      expect(insecure.isDone()).toBe(false)
      expect(messages.isDone()).toBe(false)
    }
  )
})

describe('#createGraphDirectory search request', () => {
  test('searches name and mail with $select, $top and the eventual-consistency header', async () => {
    replyToken()
    let search
    const graph = nock(GRAPH, { reqheaders: { consistencylevel: 'eventual' } })
      .get('/v1.0/users')
      .query((query) => {
        search = query
        return true
      })
      .reply(200, { value: [graphUser(ada)] })

    const people = await createDirectory().searchPeople({
      userAssertion: USER_TOKEN,
      query: 'Ada Love'
    })

    expect(graph.isDone()).toBe(true)
    expect(search).toEqual({
      $search: '"displayName:Ada Love" OR "mail:Ada Love"',
      $select: SELECT,
      $top: '50'
    })
    expect(people).toEqual([ada])
  })

  test('escapes quotes and backslashes in the query so it cannot break out of the phrase', async () => {
    replyToken()
    let search
    nock(GRAPH)
      .get('/v1.0/users')
      .query((query) => {
        search = query.$search
        return true
      })
      .reply(200, { value: [] })

    await createDirectory().searchPeople({
      userAssertion: USER_TOKEN,
      query: 'Ann "The" O\\Brien" OR "x'
    })

    expect(search).toBe(
      '"displayName:Ann \\"The\\" O\\\\Brien\\" OR \\"x" OR "mail:Ann \\"The\\" O\\\\Brien\\" OR \\"x"'
    )
  })

  test('reads a user Graph sends with only an id as empty text, so eligibility refuses them', async () => {
    replyToken()
    nock(GRAPH)
      .get('/v1.0/users')
      .query(true)
      .reply(200, { value: [{ id: ada.oid }] })

    const [person] = await createDirectory().searchPeople({
      userAssertion: USER_TOKEN,
      query: 'ada'
    })

    expect(person).toEqual({
      oid: ada.oid,
      displayName: '',
      mail: null,
      userPrincipalName: ''
    })
  })

  test('reads a missing mail as null', async () => {
    replyToken()
    nock(GRAPH)
      .get('/v1.0/users')
      .query(true)
      .reply(200, {
        value: [{ ...graphUser(ada), mail: undefined }]
      })

    const [person] = await createDirectory().searchPeople({
      userAssertion: USER_TOKEN,
      query: 'ada'
    })

    expect(person.mail).toBeNull()
  })

  test('getPerson reads one user by object ID with the same $select', async () => {
    replyToken()
    let select
    nock(GRAPH)
      .get(`/v1.0/users/${ada.oid}`)
      .query((query) => {
        select = query.$select
        return true
      })
      .reply(200, graphUser(ada))

    const person = await createDirectory().getPerson({
      userAssertion: USER_TOKEN,
      oid: ada.oid
    })

    expect(select).toBe(SELECT)
    expect(person).toEqual(ada)
  })
})

describe('#createGraphDirectory failures', () => {
  async function expectUnavailable(promise) {
    const error = await promise.then(
      () => null,
      (rejected) => rejected
    )

    expect(error?.isBoom).toBe(true)
    expect(error.output.statusCode).toBe(503)
    expect(error.data.code).toBe('directory-unavailable')

    return error
  }

  test.each([
    ['a 429', 429],
    ['a 500', 500],
    ['a 503', 503],
    ['a 401', 401],
    ['a 403', 403]
  ])(
    'search gives directory-unavailable for %s from Graph',
    async (_, status) => {
      replyToken()
      nock(GRAPH).get('/v1.0/users').query(true).reply(status, { error: {} })
      const logger = { warn: vi.fn() }

      await expectUnavailable(
        createDirectory({ logger }).searchPeople({
          userAssertion: USER_TOKEN,
          query: 'ada'
        })
      )

      expect(logger.warn).toHaveBeenCalledWith(
        { directory: expect.objectContaining({ operation: 'search', status }) },
        expect.any(String)
      )
    }
  )

  test('getPerson gives directory-unavailable for a 500, and null only for a 404', async () => {
    replyToken()
    nock(GRAPH).get(`/v1.0/users/${ada.oid}`).query(true).reply(500, {})

    await expectUnavailable(
      createDirectory().getPerson({ userAssertion: USER_TOKEN, oid: ada.oid })
    )
  })

  test('a refused token exchange gives directory-unavailable and logs only the AADSTS code', async () => {
    nockTokenEndpoint().reply(400, {
      error: 'invalid_grant',
      error_description:
        'AADSTS65001: The user or administrator has not consented to use the application with ID. Trace ID: secret-trace',
      error_codes: [65001]
    })
    const logger = { warn: vi.fn() }

    await expectUnavailable(
      createDirectory({ logger }).searchPeople({
        userAssertion: USER_TOKEN,
        query: 'ada'
      })
    )

    expect(logger.warn).toHaveBeenCalledWith(
      {
        directory: expect.objectContaining({
          operation: 'search',
          aadstsCode: 'AADSTS65001'
        })
      },
      expect.any(String)
    )
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret-trace')
  })

  test('a slow token exchange is told to stop at the timeout, not left running (F10)', async () => {
    let abortSignal
    // The credential is the adapter's port to the token exchange: this one
    // never answers, and records the signal the adapter gave it.
    const createCredential = () => ({
      getToken: (_scope, options) => {
        abortSignal = options.abortSignal

        return new Promise(() => {})
      }
    })

    await expectUnavailable(
      createDirectory({ timeoutMs: 50, createCredential }).searchPeople({
        userAssertion: USER_TOKEN,
        query: 'ada'
      })
    )

    expect(abortSignal).toBeInstanceOf(AbortSignal)
    await vi.waitFor(() => expect(abortSignal.aborted).toBe(true))
  })

  test('a slow token exchange gives directory-unavailable at the timeout', async () => {
    nockTokenEndpoint()
      .delay(500)
      .reply(200, { access_token: 'graph-token', expires_in: 3600 })

    await expectUnavailable(
      createDirectory({ timeoutMs: 50 }).searchPeople({
        userAssertion: USER_TOKEN,
        query: 'ada'
      })
    )
  })

  test('a slow Graph call gives directory-unavailable at the timeout', async () => {
    replyToken()
    nock(GRAPH)
      .get('/v1.0/users')
      .query(true)
      .delay(500)
      .reply(200, { value: [] })

    await expectUnavailable(
      createDirectory({ timeoutMs: 50 }).searchPeople({
        userAssertion: USER_TOKEN,
        query: 'ada'
      })
    )
  })

  test('a network error gives directory-unavailable', async () => {
    replyToken()
    nock(GRAPH).get('/v1.0/users').query(true).replyWithError('socket hang up')

    await expectUnavailable(
      createDirectory().searchPeople({
        userAssertion: USER_TOKEN,
        query: 'ada'
      })
    )
  })

  test.each([
    ['a body that is not JSON', 'not json'],
    ['a body with no value list', { value: 'nope' }]
  ])('search gives directory-unavailable for %s', async (_, body) => {
    replyToken()
    nock(GRAPH).get('/v1.0/users').query(true).reply(200, body)

    await expectUnavailable(
      createDirectory().searchPeople({
        userAssertion: USER_TOKEN,
        query: 'ada'
      })
    )
  })

  test.each([undefined, '', null])(
    'a missing user assertion (%j) gives directory-unavailable without calling out',
    async (userAssertion) => {
      const login = replyToken()
      const graph = nock(GRAPH).get('/v1.0/users').query(true).reply(200, {})

      await expectUnavailable(
        createDirectory().searchPeople({ userAssertion, query: 'ada' })
      )
      await expectUnavailable(
        createDirectory().getPerson({ userAssertion, oid: ada.oid })
      )

      expect(graph.isDone()).toBe(false)
      expect(login.isDone()).toBe(false)
    }
  )

  test('never logs the query, the user assertion, the client assertion or the token', async () => {
    replyToken()
    nock(GRAPH).get('/v1.0/users').query(true).reply(503, {})
    const logger = { warn: vi.fn() }

    await expectUnavailable(
      createDirectory({ logger }).searchPeople({
        userAssertion: USER_TOKEN,
        query: 'lovelace-secret-query'
      })
    )

    const logged = JSON.stringify(logger.warn.mock.calls)

    for (const secret of [
      'lovelace-secret-query',
      USER_TOKEN,
      CLIENT_ASSERTION,
      'graph-token'
    ]) {
      expect(logged).not.toContain(secret)
    }
  })
})

describe('#createGraphDirectory getPerson', () => {
  test('returns null when Graph has no such user', async () => {
    replyToken()
    nock(GRAPH).get(`/v1.0/users/${ada.oid}`).query(true).reply(404, {})

    await expect(
      createDirectory().getPerson({ userAssertion: USER_TOKEN, oid: ada.oid })
    ).resolves.toBeNull()
  })
})

describe('#createGraphDirectory token cache', () => {
  async function searchTwice(directory, assertions) {
    for (const userAssertion of assertions) {
      await directory.searchPeople({ userAssertion, query: 'ada' })
    }
  }

  function countTokenCalls() {
    const counter = { calls: 0 }

    replyToken({ onBody: () => (counter.calls += 1) })
    nock(GRAPH)
      .persist()
      .get('/v1.0/users')
      .query(true)
      .reply(200, { value: [] })

    return counter
  }

  test('reuses a token for the same user assertion', async () => {
    const counter = countTokenCalls()

    await searchTwice(createDirectory(), [USER_TOKEN, USER_TOKEN])

    expect(counter.calls).toBe(1)
  })

  test('exchanges a token for each different user assertion', async () => {
    const counter = countTokenCalls()

    await searchTwice(createDirectory(), [USER_TOKEN, 'another-user-token'])

    expect(counter.calls).toBe(2)
  })

  test('exchanges again once the token is within two minutes of expiring', async () => {
    const counter = countTokenCalls()
    const start = Date.now()
    let offsetMs = 0
    const directory = createDirectory({ now: () => start + offsetMs })

    await searchTwice(directory, [USER_TOKEN])
    offsetMs = 57 * 60 * 1000
    await searchTwice(directory, [USER_TOKEN])
    expect(counter.calls).toBe(1)

    offsetMs = 59 * 60 * 1000
    await searchTwice(directory, [USER_TOKEN])
    expect(counter.calls).toBe(2)
  })

  test('keeps a bounded number of tokens, dropping the oldest', async () => {
    const counter = countTokenCalls()
    const directory = createDirectory({ maxCachedTokens: 2 })

    await searchTwice(directory, ['token-a', 'token-b', 'token-c'])
    expect(counter.calls).toBe(3)

    await searchTwice(directory, ['token-b', 'token-c'])
    expect(counter.calls).toBe(3)

    await searchTwice(directory, ['token-a'])
    expect(counter.calls).toBe(4)
  })

  test('does not cache a failed exchange', async () => {
    nockTokenEndpoint().reply(400, {
      error: 'invalid_grant',
      error_description: 'AADSTS50013: Assertion failed signature validation.'
    })
    const counter = countTokenCalls()
    const directory = createDirectory()

    await expect(
      directory.searchPeople({ userAssertion: USER_TOKEN, query: 'ada' })
    ).rejects.toThrow()
    await directory.searchPeople({ userAssertion: USER_TOKEN, query: 'ada' })

    expect(counter.calls).toBe(1)
  })
})

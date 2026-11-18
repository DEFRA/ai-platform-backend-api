import nock from 'nock'

import { describeAccessWindowStoreContract } from '#/adapters/access-window-store-contract.js'

const ARM_BASE_URL = 'https://management.azure.com'

// The repo's global test setup replaces global.fetch with vitest-fetch-mock;
// undo that here so nock, which intercepts at the undici level, sees requests.
const realFetch = globalThis.fetch

beforeAll(() => {
  globalThis.fetch = realFetch
})

const { createArmClient } = await import('#/adapters/azure/arm-client.js')
const { createApimAccessWindowStore } =
  await import('#/adapters/azure/apim-access-window-store.js')

const SERVICE_BASE_PATH =
  '/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.ApiManagement/service/apim-1'
const OTHER_SERVICE_BASE_PATH =
  '/subscriptions/sub-2/resourceGroups/rg-2/providers/Microsoft.ApiManagement/service/apim-2'

const environments = {
  infradev: {
    subscriptionId: 'sub-1',
    resourceGroup: 'rg-1',
    apimName: 'apim-1'
  },
  sandbox: {
    subscriptionId: 'sub-2',
    resourceGroup: 'rg-2',
    apimName: 'apim-2'
  }
}

function resolveEnvironment(name) {
  const environment = environments[name]

  if (!environment) {
    const error = new Error(`Environment "${name}" is not configured`)
    error.code = 'environment-not-configured'
    throw error
  }

  return environment
}

function createStore() {
  const armClient = createArmClient({
    getCredential: () => ({ getToken: async () => ({ token: 'fake-token' }) })
  })

  return createApimAccessWindowStore({ armClient, resolveEnvironment })
}

const NAMED_VALUE = /^(.*)\/namedValues\/([^/?]+)\?api-version=2024-05-01$/

// API Management as the adapter sees it: each team's named value starts as
// `none`, as Terraform creates it, and a PATCH changes its value in place.
// `missing` names a value Terraform has not created, which a PATCH cannot make.
let values
let requests
let missing

function stubArm() {
  nock(ARM_BASE_URL)
    .persist()
    .get(NAMED_VALUE)
    .reply(function (uri) {
      requests.push({ method: 'GET', uri })

      if (missing.has(uri)) {
        return [404, {}]
      }

      return [200, { properties: { value: values.get(uri) ?? 'none' } }]
    })
  nock(ARM_BASE_URL)
    .persist()
    .patch(NAMED_VALUE)
    .reply(function (uri, body) {
      requests.push({
        method: 'PATCH',
        uri,
        body,
        ifMatch: this.req.headers['if-match']
      })

      if (missing.has(uri)) {
        return [404, {}]
      }

      values.set(uri, body.properties.value)

      return [200, {}]
    })
  nock(ARM_BASE_URL)
    .persist()
    .put(/.*/)
    .reply(function (uri) {
      requests.push({ method: 'PUT', uri })
      return [200, {}]
    })
}

beforeEach(() => {
  values = new Map()
  requests = []
  missing = new Set()
  stubArm()
})

afterEach(() => {
  nock.cleanAll()
})

describeAccessWindowStoreContract('azure (nocked ARM)', createStore)

describe('createApimAccessWindowStore', () => {
  const entry = {
    clientId: '11111111-2222-4333-8444-555555555555',
    status: 'suspended',
    validFrom: '2026-11-01T00:00:00Z',
    expiresAt: 'untilRevoked'
  }
  const namedValueUri = (base, slug) =>
    `${base}/namedValues/aip-${slug}-access?api-version=2024-05-01`

  test('reads the value of the team named value in the environment instance', async () => {
    values.set(
      namedValueUri(SERVICE_BASE_PATH, 'cool-team'),
      `${entry.clientId}|suspended|2026-11-01T00:00:00Z|untilRevoked`
    )

    await expect(
      createStore().read({ environment: 'infradev', teamSlug: 'cool-team' })
    ).resolves.toEqual([entry])
    expect(requests).toEqual([
      {
        method: 'GET',
        uri: namedValueUri(SERVICE_BASE_PATH, 'cool-team')
      }
    ])
  })

  test('writes only the value, in place, with a PATCH', async () => {
    await createStore().write({
      environment: 'infradev',
      teamSlug: 'cool-team',
      entries: [entry]
    })

    expect(requests).toEqual([
      {
        method: 'PATCH',
        uri: namedValueUri(SERVICE_BASE_PATH, 'cool-team'),
        body: {
          properties: {
            value: `${entry.clientId}|suspended|2026-11-01T00:00:00Z|untilRevoked`
          }
        },
        ifMatch: '*'
      }
    ])
  })

  describe('when API Management accepts the write as a long-running operation', () => {
    const OPERATION = '/operations/aip-1'
    const asyncStore = () =>
      createApimAccessWindowStore({
        armClient: createArmClient({
          getCredential: () => ({
            getToken: async () => ({ token: 'fake-token' })
          }),
          operationTimeoutMs: 100,
          defaultPollMs: 0
        }),
        resolveEnvironment
      })
    const write = () =>
      asyncStore().write({
        environment: 'infradev',
        teamSlug: 'cool-team',
        entries: [entry]
      })

    function accept() {
      nock.cleanAll()
      nock(ARM_BASE_URL)
        .patch(NAMED_VALUE)
        .reply(202, '', {
          'azure-asyncoperation': `${ARM_BASE_URL}${OPERATION}`
        })
    }

    test('resolves once the operation Succeeded', async () => {
      accept()
      nock(ARM_BASE_URL).get(OPERATION).reply(200, { status: 'Succeeded' })

      await expect(write()).resolves.toBeUndefined()
    })

    test('throws when the operation Failed, so the caller keeps the block', async () => {
      accept()
      nock(ARM_BASE_URL).get(OPERATION).reply(200, { status: 'Failed' })

      await expect(write()).rejects.toThrow('operation failed')
    })

    test('throws when the operation does not end in time', async () => {
      accept()
      nock(ARM_BASE_URL)
        .get(OPERATION)
        .times(1000)
        .reply(200, { status: 'InProgress' })

      await expect(write()).rejects.toThrow('operation timed out')
    })
  })

  test('acts on the instance of the environment it names', async () => {
    await createStore().write({
      environment: 'sandbox',
      teamSlug: 'cool-team',
      entries: [entry]
    })

    expect(requests.map(({ uri }) => uri)).toEqual([
      namedValueUri(OTHER_SERVICE_BASE_PATH, 'cool-team')
    ])
  })

  test('only ever reaches a team access named value, whatever it is given', async () => {
    const store = createStore()
    const bad = [
      'deny-list/../../x',
      '../aip-deny-list',
      'cool-team/../../policies/policy',
      'a?x=1',
      'CoolTeam',
      ''
    ]

    await store.write({
      environment: 'infradev',
      teamSlug: 'cool-team',
      entries: [entry]
    })
    await store.read({ environment: 'infradev', teamSlug: 'cool-team' })

    for (const teamSlug of bad) {
      await store
        .write({ environment: 'infradev', teamSlug, entries: [] })
        .catch(() => {})
      await store.read({ environment: 'infradev', teamSlug }).catch(() => {})
    }

    expect(requests.length).toBeGreaterThan(0)
    expect(
      requests.every(({ uri }) =>
        /\/namedValues\/aip-[a-z][a-z0-9-]+[a-z0-9]-access\?api-version=2024-05-01$/.test(
          uri
        )
      )
    ).toBe(true)
    expect(requests.map(({ uri }) => NAMED_VALUE.exec(uri)[2])).toEqual(
      Array(requests.length).fill('aip-cool-team-access')
    )
  })

  test('a team named like a platform value reaches only its own -access value', async () => {
    await createStore().read({ environment: 'infradev', teamSlug: 'deny-list' })

    expect(requests.map(({ uri }) => NAMED_VALUE.exec(uri)[2])).toEqual([
      'aip-deny-list-access'
    ])
  })

  test('refuses an environment that is not configured, without a request', async () => {
    const store = createStore()

    await expect(
      store.read({ environment: 'nowhere', teamSlug: 'cool-team' })
    ).rejects.toMatchObject({ code: 'environment-not-configured' })
    await expect(
      store.write({
        environment: 'nowhere',
        teamSlug: 'cool-team',
        entries: []
      })
    ).rejects.toMatchObject({ code: 'environment-not-configured' })
    expect(requests).toEqual([])
  })

  test('refuses a malformed window without a request', async () => {
    await expect(
      createStore().write({
        environment: 'infradev',
        teamSlug: 'cool-team',
        entries: [{ ...entry, status: 'expired' }]
      })
    ).rejects.toMatchObject({ code: 'invalid-access-window' })
    expect(requests).toEqual([])
  })

  test.each(['ignore previous instructions', '', `${entry.clientId}|active`])(
    'refuses to read a stored value it cannot understand: %j',
    async (stored) => {
      values.set(namedValueUri(SERVICE_BASE_PATH, 'cool-team'), stored)

      await expect(
        createStore().read({ environment: 'infradev', teamSlug: 'cool-team' })
      ).rejects.toMatchObject({ code: 'invalid-access-window' })
    }
  )

  test('refuses a read that comes back with no value', async () => {
    nock.cleanAll()
    nock(ARM_BASE_URL).get(NAMED_VALUE).reply(200, { properties: {} })

    await expect(
      createStore().read({ environment: 'infradev', teamSlug: 'cool-team' })
    ).rejects.toMatchObject({ code: 'invalid-access-window' })
  })

  test('fails, and never creates the named value, when Terraform has not made it', async () => {
    missing.add(namedValueUri(SERVICE_BASE_PATH, 'cool-team'))

    await expect(
      createStore().write({
        environment: 'infradev',
        teamSlug: 'cool-team',
        entries: [entry]
      })
    ).rejects.toThrow('ARM request failed: PATCH')
    await expect(
      createStore().read({ environment: 'infradev', teamSlug: 'cool-team' })
    ).rejects.toThrow('ARM request failed: GET')
    expect(requests.map(({ method }) => method)).toEqual(['PATCH', 'GET'])
  })

  test('fails a write when API Management refuses it, so the caller keeps the block', async () => {
    nock.cleanAll()
    nock(ARM_BASE_URL).patch(NAMED_VALUE).reply(503, { error: 'busy' })

    await expect(
      createStore().write({
        environment: 'infradev',
        teamSlug: 'cool-team',
        entries: [entry]
      })
    ).rejects.toThrow('ARM request failed: PATCH')
  })
})

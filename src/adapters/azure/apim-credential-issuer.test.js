import nock from 'nock'

import { describeCredentialIssuerContract } from '#/adapters/credential-issuer-contract.js'

const ARM_BASE_URL = 'https://management.azure.com'

// The repo's global test setup (.vite/setup-files.js) replaces global.fetch
// with vitest-fetch-mock for every file - undo that here so nock, which
// intercepts at the undici level, actually sees these requests.
const realFetch = globalThis.fetch

beforeAll(() => {
  globalThis.fetch = realFetch
})

// Must be set before config.js is first loaded (by the dynamic imports
// below), since convict reads process.env once at construction time.
process.env.APIM_RESEARCH_API_ID = 'research'

const { createArmClient } = await import('#/adapters/azure/arm-client.js')
const { createApimCredentialIssuer } =
  await import('#/adapters/azure/apim-credential-issuer.js')

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
    throw new Error(`Environment "${name}" is not configured`)
  }

  return environment
}

function stubCredential() {
  return () => ({ getToken: async () => ({ token: 'fake-arm-token' }) })
}

function createAzureIssuer() {
  const armClient = createArmClient({ getCredential: stubCredential() })
  return createApimCredentialIssuer({ armClient, resolveEnvironment })
}

function subscriptionPattern(suffix = '', basePath = SERVICE_BASE_PATH) {
  return new RegExp(
    `^${basePath}/subscriptions/[^/]+${suffix}\\?api-version=2024-05-01$`
  )
}

beforeEach(() => {
  nock(ARM_BASE_URL).persist().put(subscriptionPattern()).reply(200, {})
  nock(ARM_BASE_URL)
    .persist()
    .post(subscriptionPattern('/listSecrets'))
    .reply(200, { primaryKey: 'real-primary-key-1234' })
  nock(ARM_BASE_URL)
    .persist()
    .post(subscriptionPattern('/regeneratePrimaryKey'))
    .reply(204)
  nock(ARM_BASE_URL).persist().patch(subscriptionPattern()).reply(200, {})
  nock(ARM_BASE_URL).persist().delete(subscriptionPattern()).reply(204)
  nock(ARM_BASE_URL)
    .persist()
    .get(`${SERVICE_BASE_PATH}/subscriptions?api-version=2024-05-01`)
    .reply(200, { value: [] })
})

afterEach(() => {
  nock.cleanAll()
})

describeCredentialIssuerContract('azure (nocked ARM)', createAzureIssuer)

describe('createApimCredentialIssuer', () => {
  test('issue scopes the subscription to the research API, not a product', async () => {
    nock.cleanAll()

    let capturedBody
    nock(ARM_BASE_URL)
      .put(subscriptionPattern(), (body) => {
        capturedBody = body
        return true
      })
      .reply(200, {})
    nock(ARM_BASE_URL)
      .post(subscriptionPattern('/listSecrets'))
      .reply(200, { primaryKey: 'real-primary-key-1234' })

    const issuer = createAzureIssuer()
    await issuer.issue({
      userId: 'user-1',
      modelSlug: 'gpt-4o',
      tier: 'research',
      environment: 'infradev'
    })

    expect(capturedBody.properties.scope).toBe(
      `${SERVICE_BASE_PATH}/apis/research`
    )
    expect(capturedBody.properties.scope).not.toContain('/products/')
  })

  test('every call acts on the instance of the environment it names, not a fixed one', async () => {
    nock.cleanAll()

    const other = nock(ARM_BASE_URL)
    const put = other
      .put(subscriptionPattern('', OTHER_SERVICE_BASE_PATH))
      .reply(200, {})
    const secrets = other
      .post(subscriptionPattern('/listSecrets', OTHER_SERVICE_BASE_PATH))
      .times(2)
      .reply(200, { primaryKey: 'real-primary-key-1234' })
    const regenerate = other
      .post(
        subscriptionPattern('/regeneratePrimaryKey', OTHER_SERVICE_BASE_PATH)
      )
      .reply(204)
    const patch = other
      .patch(subscriptionPattern('', OTHER_SERVICE_BASE_PATH))
      .times(3)
      .reply(200, {})
    const del = other
      .delete(subscriptionPattern('', OTHER_SERVICE_BASE_PATH))
      .reply(204)

    const issuer = createAzureIssuer()
    const expiresAt = new Date('2030-01-01T00:00:00.000Z').toISOString()
    const { externalId } = await issuer.issue({
      userId: 'user-1',
      modelSlug: 'gpt-4o',
      tier: 'research',
      environment: 'sandbox'
    })
    await issuer.rotate({ externalId, environment: 'sandbox' })
    await issuer.renew({ externalId, expiresAt, environment: 'sandbox' })
    await issuer.suspend({ externalId, environment: 'sandbox' })
    await issuer.revoke({ externalId, environment: 'sandbox' })

    for (const interceptor of [put, secrets, regenerate, patch, del]) {
      expect(interceptor.isDone()).toBe(true)
    }
  })

  test.each([null, undefined, 'unknown'])(
    'fails closed, before any ARM call, for environment %s',
    async (environment) => {
      nock.cleanAll()

      const issuer = createAzureIssuer()

      await expect(
        issuer.issue({
          userId: 'user-1',
          modelSlug: 'gpt-4o',
          tier: 'research',
          environment
        })
      ).rejects.toThrow('is not configured')
      expect(nock.pendingMocks()).toEqual([])
    }
  )

  test('issue sets expirationDate to the same expiresAt it returns, so context.Subscription.EndDate agrees with Mongo from creation', async () => {
    nock.cleanAll()

    let capturedBody
    nock(ARM_BASE_URL)
      .put(subscriptionPattern(), (body) => {
        capturedBody = body
        return true
      })
      .reply(200, {})
    nock(ARM_BASE_URL)
      .post(subscriptionPattern('/listSecrets'))
      .reply(200, { primaryKey: 'real-primary-key-1234' })

    const issuer = createAzureIssuer()
    const issued = await issuer.issue({
      userId: 'user-1',
      modelSlug: 'gpt-4o',
      tier: 'research',
      environment: 'infradev'
    })

    expect(capturedBody.properties.expirationDate).toBe(issued.expiresAt)
  })

  test('renew reactivates (state: active) before updating expirationDate, as two separate PATCH calls', async () => {
    // ARM rejects {state: 'active', expirationDate} in one combined PATCH
    // with "Only 'active' subscriptions can be renewed" when the
    // subscription is currently suspended - confirmed against real APIM.
    nock.cleanAll()

    const capturedBodies = []
    nock(ARM_BASE_URL)
      .patch(subscriptionPattern(), (body) => {
        capturedBodies.push(body)
        return true
      })
      .reply(200, {})
    nock(ARM_BASE_URL)
      .patch(subscriptionPattern(), (body) => {
        capturedBodies.push(body)
        return true
      })
      .reply(200, {})

    const issuer = createAzureIssuer()
    const expiresAt = new Date('2030-01-01T00:00:00.000Z').toISOString()
    await issuer.renew({
      externalId: 'research-user-1-gpt-4o',
      expiresAt,
      environment: 'infradev'
    })

    expect(capturedBodies[0].properties.state).toBe('active')
    expect(capturedBodies[1].properties.expirationDate).toBe(expiresAt)
  })

  test('rejects without leaking the ARM response body when a call fails', async () => {
    nock.cleanAll()
    nock(ARM_BASE_URL)
      .put(subscriptionPattern())
      .reply(403, { error: { message: 'do-not-leak-this-key' } })

    const issuer = createAzureIssuer()

    await expect(
      issuer.issue({
        userId: 'user-1',
        modelSlug: 'gpt-4o',
        tier: 'research',
        environment: 'infradev'
      })
    ).rejects.toThrow(/^ARM request failed: PUT /)
  })

  describe('findStraySubscriptions', () => {
    const researchScope = `${SERVICE_BASE_PATH}/apis/research`

    test('reports a subscription with another name or scope, across pages, and ignores the built-in one', async () => {
      nock.cleanAll()
      nock(ARM_BASE_URL)
        .get(`${SERVICE_BASE_PATH}/subscriptions?api-version=2024-05-01`)
        .reply(200, {
          value: [
            {
              name: 'research-user-1-gpt-4o',
              properties: { scope: researchScope }
            },
            { name: 'master', properties: { scope: '/' } },
            {
              name: 'research-user-2-gpt-4o',
              properties: { scope: `${SERVICE_BASE_PATH}/apis/cool-team` }
            }
          ],
          nextLink: `${ARM_BASE_URL}${SERVICE_BASE_PATH}/subscriptions?api-version=2024-05-01&$skip=3`
        })
      nock(ARM_BASE_URL)
        .get(
          `${SERVICE_BASE_PATH}/subscriptions?api-version=2024-05-01&$skip=3`
        )
        .reply(200, {
          value: [
            { name: 'someone-else', properties: { scope: researchScope } },
            { name: 'manual-key', properties: { scope: '/products/x' } }
          ]
        })

      await expect(
        createAzureIssuer().findStraySubscriptions({ environment: 'infradev' })
      ).resolves.toEqual([
        { name: 'research-user-2-gpt-4o', reasons: ['unexpected-scope'] },
        { name: 'someone-else', reasons: ['unexpected-name'] },
        {
          name: 'manual-key',
          reasons: ['unexpected-name', 'unexpected-scope']
        }
      ])
    })

    test('finds none when every subscription is a research key on the research API', async () => {
      nock.cleanAll()
      nock(ARM_BASE_URL)
        .get(`${SERVICE_BASE_PATH}/subscriptions?api-version=2024-05-01`)
        .reply(200, {
          value: [
            {
              name: 'research-user-1-gpt-4o',
              properties: { scope: researchScope.toUpperCase() }
            }
          ]
        })

      await expect(
        createAzureIssuer().findStraySubscriptions({ environment: 'infradev' })
      ).resolves.toEqual([])
    })

    test('does not follow a next link off the ARM host', async () => {
      nock.cleanAll()
      nock(ARM_BASE_URL)
        .get(`${SERVICE_BASE_PATH}/subscriptions?api-version=2024-05-01`)
        .reply(200, {
          value: [],
          nextLink: 'https://attacker.example/subscriptions'
        })

      await expect(
        createAzureIssuer().findStraySubscriptions({ environment: 'infradev' })
      ).resolves.toEqual([])
    })
  })
})

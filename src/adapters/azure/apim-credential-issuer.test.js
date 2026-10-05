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
process.env.AZURE_ARM_SUBSCRIPTION_ID = 'sub-1'
process.env.AZURE_ARM_RESOURCE_GROUP = 'rg-1'
process.env.APIM_SERVICE_NAME = 'apim-1'
process.env.APIM_RESEARCH_API_ID = 'research'

const { createArmClient } = await import('#/adapters/azure/arm-client.js')
const { createApimCredentialIssuer } =
  await import('#/adapters/azure/apim-credential-issuer.js')

const SERVICE_BASE_PATH =
  '/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.ApiManagement/service/apim-1'

function stubCredential() {
  return () => ({ getToken: async () => ({ token: 'fake-arm-token' }) })
}

function createAzureIssuer() {
  const armClient = createArmClient({ getCredential: stubCredential() })
  return createApimCredentialIssuer({ armClient })
}

function subscriptionPattern(suffix = '') {
  return new RegExp(
    `^${SERVICE_BASE_PATH}/subscriptions/[^/]+${suffix}\\?api-version=2024-05-01$`
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
      tier: 'research'
    })

    expect(capturedBody.properties.scope).toBe(
      `${SERVICE_BASE_PATH}/apis/research`
    )
    expect(capturedBody.properties.scope).not.toContain('/products/')
  })

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
      tier: 'research'
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
    await issuer.renew({ externalId: 'research-user-1-gpt-4o', expiresAt })

    expect(capturedBodies[0].properties.state).toBe('active')
    expect(capturedBodies[1].properties.expirationDate).toBe(expiresAt)
  })

  test('issue uses a team-scoped externalId shared across the team+environment, not per model', async () => {
    const issuer = createAzureIssuer()
    const issued = await issuer.issue({
      userId: 'user-1',
      modelSlug: 'gpt-4o',
      tier: 'team',
      teamId: 'team-1',
      environment: 'sandbox'
    })

    expect(issued.externalId).toBe('team-team-1-sandbox')
  })

  test('rejects without leaking the ARM response body when a call fails', async () => {
    nock.cleanAll()
    nock(ARM_BASE_URL)
      .put(subscriptionPattern())
      .reply(403, { error: { message: 'do-not-leak-this-key' } })

    const issuer = createAzureIssuer()

    await expect(
      issuer.issue({ userId: 'user-1', modelSlug: 'gpt-4o', tier: 'research' })
    ).rejects.toThrow(/^ARM request failed: PUT /)
  })
})

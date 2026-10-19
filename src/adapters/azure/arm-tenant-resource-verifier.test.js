import nock from 'nock'

// The repo's global test setup (.vite/setup-files.js) replaces global.fetch
// with vitest-fetch-mock for every file - undo that here so nock, which
// intercepts at the undici level, actually sees these requests.
const realFetch = globalThis.fetch

beforeAll(() => {
  globalThis.fetch = realFetch
})

const { createArmClient } = await import('#/adapters/azure/arm-client.js')
const { createArmTenantResourceVerifier, collectResourceIds } =
  await import('#/adapters/azure/arm-tenant-resource-verifier.js')

const ARM_BASE_URL = 'https://management.azure.com'
const SUBSCRIPTION = '00000000-0000-0000-0000-000000000000'
const RESOURCE_GROUP = 'rg-placeholder'
const SCOPE = `/subscriptions/${SUBSCRIPTION}/resourceGroups/${RESOURCE_GROUP}/providers`
const ACCOUNT_ID = `${SCOPE}/Microsoft.CognitiveServices/accounts/aif-placeholder`
const PROJECT_ID = `${ACCOUNT_ID}/projects/aip-alpha`
const DEPLOYMENT_ID = `${ACCOUNT_ID}/deployments/alpha-gpt-5-nano`
const API_ID = `${SCOPE}/Microsoft.ApiManagement/service/apim-placeholder/apis/alpha`

// The shape of one team's `outputs.teams.value[slug]` in a run report: IDs
// alongside names and non-ARM identifiers the verifier must ignore.
function teamOutputs(overrides = {}) {
  return {
    project: { id: PROJECT_ID, name: 'aip-alpha' },
    deployments: { 'gpt-5-nano': { id: DEPLOYMENT_ID } },
    api: { id: API_ID, path: '/alpha' },
    entraAppObjectId: '00000000-0000-0000-0000-000000000003',
    ...overrides
  }
}

function createVerifier() {
  return createArmTenantResourceVerifier({
    armClient: createArmClient({
      getCredential: () => ({
        getToken: async () => ({ token: 'fake-arm-token' })
      })
    }),
    environments: {
      infradev: {
        subscriptionId: SUBSCRIPTION,
        resourceGroup: RESOURCE_GROUP,
        apimName: 'apim-placeholder',
        foundryAccounts: ['aif-placeholder'],
        tenantsVault: 'kv-placeholder'
      }
    }
  })
}

function replyWithState(resourceId, apiVersion, provisioningState) {
  return nock(ARM_BASE_URL)
    .get(resourceId)
    .query({ 'api-version': apiVersion })
    .reply(200, { id: resourceId, properties: { provisioningState } })
}

describe('#createArmTenantResourceVerifier', () => {
  afterEach(() => {
    nock.cleanAll()
  })

  test('verifies a team whose every resource exists and has succeeded', async () => {
    replyWithState(PROJECT_ID, '2025-06-01', 'Succeeded')
    replyWithState(DEPLOYMENT_ID, '2025-06-01', 'Succeeded')
    replyWithState(API_ID, '2024-05-01', 'Succeeded')

    await expect(
      createVerifier().verify({
        environment: 'infradev',
        resources: teamOutputs()
      })
    ).resolves.toEqual({ verified: true })
  })

  test('verifies a resource type that reports no provisioning state by its existence', async () => {
    replyWithState(PROJECT_ID, '2025-06-01', 'Succeeded')
    replyWithState(DEPLOYMENT_ID, '2025-06-01', 'Succeeded')
    nock(ARM_BASE_URL)
      .get(API_ID)
      .query({ 'api-version': '2024-05-01' })
      .reply(200, { id: API_ID, properties: { path: 'alpha' } })

    await expect(
      createVerifier().verify({
        environment: 'infradev',
        resources: teamOutputs()
      })
    ).resolves.toEqual({ verified: true })
  })

  test('does not verify a resource that is still being created', async () => {
    replyWithState(PROJECT_ID, '2025-06-01', 'Succeeded')
    replyWithState(DEPLOYMENT_ID, '2025-06-01', 'Creating')

    await expect(
      createVerifier().verify({
        environment: 'infradev',
        resources: teamOutputs()
      })
    ).resolves.toEqual({ verified: false, reason: 'resource-not-succeeded' })
  })

  test('does not verify a resource ARM cannot find', async () => {
    nock(ARM_BASE_URL)
      .get(PROJECT_ID)
      .query(true)
      .reply(404, { error: { code: 'ResourceNotFound' } })

    await expect(
      createVerifier().verify({
        environment: 'infradev',
        resources: teamOutputs()
      })
    ).resolves.toEqual({ verified: false, reason: 'resource-unavailable' })
  })

  test('refuses a resource outside the environment without calling ARM', async () => {
    const outside = nock(ARM_BASE_URL).get(/.*/).reply(200, {})

    const result = await createVerifier().verify({
      environment: 'infradev',
      resources: teamOutputs({
        api: {
          id: `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-other/providers/Microsoft.ApiManagement/service/apim-other/apis/alpha`
        }
      })
    })

    expect(result).toEqual({
      verified: false,
      reason: 'resource-outside-environment'
    })
    expect(outside.isDone()).toBe(false)
  })

  test('fails a resource type it has no api-version for', async () => {
    await expect(
      createVerifier().verify({
        environment: 'infradev',
        resources: {
          storage: { id: `${SCOPE}/Microsoft.Storage/storageAccounts/st1` }
        }
      })
    ).resolves.toEqual({ verified: false, reason: 'unsupported-resource-type' })
  })

  test('fails an environment missing from AIP_ENVIRONMENTS', async () => {
    await expect(
      createVerifier().verify({
        environment: 'sandbox',
        resources: teamOutputs()
      })
    ).resolves.toEqual({
      verified: false,
      reason: 'environment-not-configured'
    })
  })

  test('fails a team with no resources in the run report', async () => {
    await expect(
      createVerifier().verify({ environment: 'infradev', resources: null })
    ).resolves.toEqual({ verified: false, reason: 'no-resources' })
  })
})

describe('#collectResourceIds', () => {
  test('collects each ARM resource ID once and ignores names and Entra IDs', () => {
    expect(
      collectResourceIds({
        ...teamOutputs(),
        again: [PROJECT_ID],
        count: 2
      })
    ).toEqual([PROJECT_ID, DEPLOYMENT_ID, API_ID])
  })
})

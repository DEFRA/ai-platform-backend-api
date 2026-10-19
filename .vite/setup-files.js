import { afterAll, beforeAll } from 'vitest'
import createFetchMock from 'vitest-fetch-mock'

// The tests request team deployments in the Sandbox, as the CDP test
// instance does (design C #control-plane); the default is Infradev.
process.env.TEAM_ENVIRONMENTS ??= 'sandbox'

const fetchMock = createFetchMock(vi)

beforeAll(async () => {
  // Setup fetch mock
  fetchMock.enableMocks()
  global.fetch = fetchMock
  global.fetchMock = fetchMock
})

afterAll(async () => {
  fetchMock.disableMocks()
})

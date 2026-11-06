import { afterAll, beforeAll } from 'vitest'
import createFetchMock from 'vitest-fetch-mock'

import {
  AUDIENCE,
  FRONTEND_CLIENT_ID,
  TENANT_ID,
  serveJwks
} from '#/common/test-helpers/portal-token.js'

// The tests request team deployments in the Sandbox, as the CDP test
// instance does (design C #control-plane); the default is Infradev.
process.env.TEAM_ENVIRONMENTS ??= 'sandbox'

// The identifiers every test token is checked against; the test helper signs
// tokens for them and serves the signing keys.
process.env.PORTAL_AUTH_TENANT_ID = TENANT_ID
process.env.PORTAL_AUTH_AUDIENCE = AUDIENCE
process.env.PORTAL_AUTH_CLIENT_ID = FRONTEND_CLIENT_ID
delete process.env.PORTAL_AUTH_MOCK_ISSUER_URL

const fetchMock = createFetchMock(vi)

beforeAll(async () => {
  // Setup fetch mock
  fetchMock.enableMocks()
  global.fetchMock = fetchMock
  global.fetch = fetchMock

  // The signing keys every server fetches when it starts
  serveJwks()
})

afterAll(async () => {
  fetchMock.disableMocks()
})

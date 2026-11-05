import { ACCESS } from '#/common/helpers/auth/access.js'

// Every route and the access it declares (design E #portal; the route table
// in the frontend's docs/plans/remaining.md). A new route fails this test
// until it is listed here with a declared access, so none is open by accident.
const ROUTES = [
  ['GET /health', ACCESS.public],
  ['POST /maintenance/expire-credentials', ACCESS.public],
  ['GET /v1/models', ACCESS.catalogue],
  ['GET /v1/models/{slug}', ACCESS.catalogue],
  ['PUT /v1/users/me', ACCESS.signIn],
  ['GET /v1/users/me', ACCESS.user],
  ['POST /v1/credentials', ACCESS.user],
  ['GET /v1/credentials', ACCESS.user],
  ['GET /v1/credentials/{id}', ACCESS.credentialOwnerOrTeamMember],
  ['POST /v1/credentials/{id}/renew', ACCESS.credentialOwner],
  ['POST /v1/credentials/{id}/rotate', ACCESS.credentialOwnerOrTeamAdmin],
  ['DELETE /v1/credentials/{id}', ACCESS.credentialOwnerOrTeamAdmin],
  ['POST /v1/credentials/{id}/reveal', ACCESS.credentialOwnerOrTeamAdmin],
  ['POST /v1/teams', ACCESS.user],
  ['GET /v1/teams', ACCESS.user],
  ['GET /v1/teams/{id}', ACCESS.teamMember],
  ['PATCH /v1/teams/{id}', ACCESS.teamAdmin],
  ['POST /v1/teams/{id}/people/search', ACCESS.teamAdmin],
  ['POST /v1/teams/{id}/members', ACCESS.teamAdmin],
  ['PATCH /v1/teams/{id}/members/{memberId}', ACCESS.teamAdmin],
  ['DELETE /v1/teams/{id}/members/{memberId}', ACCESS.teamAdmin],
  ['POST /v1/teams/{teamId}/deployments', ACCESS.teamMember],
  ['GET /v1/teams/{teamId}/deployments', ACCESS.teamMember],
  ['GET /v1/teams/{teamId}/deployments/{id}', ACCESS.teamMember],
  ['DELETE /v1/teams/{teamId}/deployments/{id}', ACCESS.teamAdmin],
  ['POST /v1/admin/team-deployments/{id}/retry', ACCESS.platformAdmin],
  ['POST /v1/admin/team-deployments/{id}/reconcile', ACCESS.platformAdmin]
]

describe('#route access', () => {
  let server
  let routes

  beforeAll(async () => {
    const { createServer } = await import('#/server.js')

    server = await createServer()
    await server.initialize()
    routes = server.table().map((route) => ({
      name: `${route.method.toUpperCase()} ${route.path}`,
      route
    }))
  })

  afterAll(async () => {
    await server.stop({ timeout: 0 })
  })

  test('registers exactly the routes in the table', () => {
    expect(routes.map(({ name }) => name).sort()).toEqual(
      ROUTES.map(([name]) => name).sort()
    )
  })

  test('every route declares a known access', () => {
    const known = Object.values(ACCESS)

    expect(
      routes
        .filter(({ route }) => !known.includes(route.settings.app?.access))
        .map(({ name }) => name)
    ).toEqual([])
  })

  test.each(ROUTES)('%s declares %s', (name, access) => {
    expect(
      routes.find((entry) => entry.name === name).route.settings.app.access
    ).toBe(access)
  })

  test('only the public routes opt out of the token check', () => {
    const open = routes
      .filter(({ route }) => route.settings.auth === false)
      .map(({ name }) => name)
    const declaredPublic = routes
      .filter(({ route }) => route.settings.app.access === ACCESS.public)
      .map(({ name }) => name)

    expect(open.sort()).toEqual(declaredPublic.sort())
    expect(open.sort()).toEqual([
      'GET /health',
      'POST /maintenance/expire-credentials'
    ])
  })

  test('every other route is authenticated by the portal strategy', () => {
    for (const { name, route } of routes) {
      if (route.settings.app.access !== ACCESS.public) {
        expect(
          server.auth.lookup(route),
          `${name} is not authenticated`
        ).toMatchObject({
          mode: 'required',
          strategies: ['portal']
        })
      }
    }
  })

  test('the CDP template routes are gone', () => {
    expect(routes.some(({ name }) => name.includes('/example'))).toBe(false)
  })
})

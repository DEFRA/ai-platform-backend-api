import { randomUUID } from 'node:crypto'

import { ObjectId } from 'mongodb'

import { authFor, withTestUsers } from '#/common/test-helpers/portal-token.js'

const ENVIRONMENTS = ['lifedev', 'lifetest', 'lifeprod']
const [DEV, TEST] = ENVIRONMENTS
const ADMIN = 'team-lifecycle-admin'
const REASON = 'Investigating a leaked client secret'

describe('#admin team lifecycle routes', () => {
  let server
  let config
  let configured

  beforeAll(async () => {
    // Dynamic imports needed due to config being updated by vitest-mongodb
    ;({ config } = await import('#/config.js'))
    configured = config.get('teamDeployment.environments')
    config.set('teamDeployment.environments', ENVIRONMENTS)

    const { createServer } = await import('#/server.js')

    server = await createServer()
    await server.initialize()
    withTestUsers(server)
  })

  afterAll(async () => {
    config.set('teamDeployment.environments', configured)
    await server.stop({ timeout: 0 })
  })

  const asAdmin = () =>
    authFor(ADMIN, { roles: ['research-user', 'platform-admin'] })
  const asPerson = () => authFor('team-lifecycle-person')

  async function seedTeam(fields = {}) {
    const name = `Lifecycle ${randomUUID().slice(0, 8)}`
    const slug = name.toLowerCase().replaceAll(' ', '-')
    const { insertedId } = await server.db.collection('teams').insertOne({
      name,
      normalisedName: slug,
      slug,
      serviceCode: 'ABC',
      status: 'active',
      ...fields
    })

    return { id: insertedId.toString(), slug }
  }

  function post(
    team,
    action,
    payload,
    headers = asAdmin(),
    key = randomUUID()
  ) {
    return server.inject({
      method: 'POST',
      url: `/v1/admin/teams/${team.id ?? team}/${action}`,
      headers: { ...headers, 'idempotency-key': key },
      payload
    })
  }

  const disable = (team, payload, headers, key) =>
    post(team, 'disable', payload, headers, key)
  const enable = (team, payload, headers) =>
    post(team, 'enable', payload, headers)

  const stored = (team) =>
    server.db
      .collection('teams')
      .findOne({ _id: new ObjectId(team.id ?? team) })

  const auditRows = (team, action) =>
    server.db
      .collection('auditEvents')
      .find({ teamId: team.id, action })
      .toArray()

  async function seedDeployment(team, environment, fields = {}) {
    await server.db.collection('teamDeployments').insertOne({
      teamId: team.id,
      environment,
      deployments: [],
      ...fields
    })
  }

  const deploymentOf = (team, environment) =>
    server.db
      .collection('teamDeployments')
      .findOne({ teamId: team.id, environment })

  describe('POST /v1/admin/teams/{id}/disable', () => {
    test('disables the team alone and records one event with the reason', async () => {
      const team = await seedTeam()

      const { statusCode, result } = await disable(team, {
        reason: `  ${REASON}  `
      })

      expect(statusCode).toBe(200)
      expect(result).toEqual({
        team: { id: team.id, status: 'disabled', disabledEnvironments: [] }
      })
      expect(await stored(team)).toMatchObject({ status: 'disabled' })

      const rows = await auditRows(team, 'admin.team.disable')

      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        resource: 'team',
        resourceId: team.id,
        role: 'platform-admin',
        outcome: 'success',
        reason: REASON,
        actorUserId: ADMIN
      })
    })

    test('changes no environment: the ones already disabled stay so, and none is added', async () => {
      const team = await seedTeam({ disabledEnvironments: [TEST] })

      const { result } = await disable(team, { reason: REASON })

      expect(result.team).toEqual({
        id: team.id,
        status: 'disabled',
        disabledEnvironments: [TEST]
      })
    })

    test('takes a team by its slug', async () => {
      const team = await seedTeam()

      const { statusCode, result } = await disable(team.slug, {
        reason: REASON
      })

      expect(statusCode).toBe(200)
      expect(result.team.id).toBe(team.id)
    })

    test('leaves the block of the team’s credentials and every environment alone', async () => {
      const team = await seedTeam()

      await seedDeployment(team, DEV, { adminBlocked: false })
      await disable(team, { reason: REASON })

      expect(await deploymentOf(team, DEV)).toMatchObject({
        adminBlocked: false
      })
      expect((await stored(team)).disabledEnvironments ?? []).toEqual([])
    })

    test('a repeat of the same key and reason changes nothing and writes no second event', async () => {
      const team = await seedTeam()
      const key = randomUUID()

      const first = await disable(team, { reason: REASON }, asAdmin(), key)
      const again = await disable(team, { reason: REASON }, asAdmin(), key)

      expect(again.statusCode).toBe(200)
      expect(again.result).toEqual(first.result)
      expect(await auditRows(team, 'admin.team.disable')).toHaveLength(1)
    })

    test('the same key with another reason is 409 idempotency-key-reused and changes nothing', async () => {
      const team = await seedTeam()
      const key = randomUUID()

      await disable(team, { reason: REASON }, asAdmin(), key)

      const { statusCode, result } = await disable(
        team,
        { reason: 'Another reason' },
        asAdmin(),
        key
      )

      expect(statusCode).toBe(409)
      expect(result.code).toBe('idempotency-key-reused')
      expect(await auditRows(team, 'admin.team.disable')).toHaveLength(1)
    })

    test('a team already disabled changes nothing and writes no event', async () => {
      const team = await seedTeam({ status: 'disabled' })

      const { statusCode, result } = await disable(team, { reason: REASON })

      expect(statusCode).toBe(200)
      expect(result.team.status).toBe('disabled')
      expect(await auditRows(team, 'admin.team.disable')).toEqual([])
    })

    test('refuses a team pending removal with 409 team-pending-removal, and changes and records nothing', async () => {
      const team = await seedTeam({ status: 'pending-removal' })

      const { statusCode, result } = await disable(team, { reason: REASON })

      expect(statusCode).toBe(409)
      expect(result.code).toBe('team-pending-removal')
      expect(await stored(team)).toMatchObject({ status: 'pending-removal' })
      expect(await auditRows(team, 'admin.team.disable')).toEqual([])
    })

    test('a team pending removal never becomes active: Disable is refused, so Enable has nothing to lift', async () => {
      const team = await seedTeam({ status: 'pending-removal' })

      await disable(team, { reason: REASON })
      await enable(team)

      expect((await stored(team)).status).toBe('pending-removal')
    })

    test.each([
      ['no reason', {}, 'reason-required'],
      ['an empty reason', { reason: '' }, 'reason-required'],
      ['a reason of spaces', { reason: '   ' }, 'reason-required'],
      ['a reason that is not text', { reason: 5 }, 'reason-required'],
      [
        'a reason of 501 characters',
        { reason: 'a'.repeat(501) },
        'reason-too-long'
      ],
      [
        'a key nobody asked for',
        { reason: REASON, other: true },
        'invalid-request'
      ],
      [
        'environments, which a team no longer takes',
        { reason: REASON, environments: [DEV] },
        'invalid-request'
      ]
    ])(
      'refuses %s with 400 %s and changes nothing',
      async (_name, payload, code) => {
        const team = await seedTeam()

        const { statusCode, result } = await disable(team, payload)

        expect(statusCode).toBe(400)
        expect(result.code).toBe(code)
        expect((await stored(team)).status).toBe('active')
        expect(await auditRows(team, 'admin.team.disable')).toEqual([])
      }
    )

    test('accepts a reason of exactly 500 characters', async () => {
      const team = await seedTeam()

      const { statusCode } = await disable(team, { reason: 'a'.repeat(500) })

      expect(statusCode).toBe(200)
    })

    test('refuses a request with no Idempotency-Key with 400 invalid-request', async () => {
      const team = await seedTeam()

      const { statusCode, result } = await server.inject({
        method: 'POST',
        url: `/v1/admin/teams/${team.id}/disable`,
        headers: asAdmin(),
        payload: { reason: REASON }
      })

      expect(statusCode).toBe(400)
      expect(result.code).toBe('invalid-request')
    })

    test('refuses a person who is not a Platform Admin with 403, an access.denied event, and changes nothing', async () => {
      const team = await seedTeam()

      const { statusCode, result } = await disable(
        team,
        { reason: REASON },
        asPerson()
      )

      expect(statusCode).toBe(403)
      expect(result.code).toBe('platform-admin-required')
      expect((await stored(team)).status).toBe('active')
      expect(
        await server.db.collection('auditEvents').countDocuments({
          action: 'access.denied',
          code: 'platform-admin-required',
          resourceId: team.id
        })
      ).toBe(1)
    })

    test('is 404 team-not-found for a team nobody holds', async () => {
      const { statusCode, result } = await disable(new ObjectId().toString(), {
        reason: REASON
      })

      expect(statusCode).toBe(404)
      expect(result.code).toBe('team-not-found')
    })

    test('requires a token', async () => {
      const { statusCode } = await server.inject({
        method: 'POST',
        url: '/v1/admin/teams/any/disable'
      })

      expect(statusCode).toBe(401)
    })
  })

  describe('POST /v1/admin/teams/{id}/enable', () => {
    test('lifts the team lock and records one event', async () => {
      const team = await seedTeam({ status: 'disabled' })

      const { statusCode, result } = await enable(team)

      expect(statusCode).toBe(200)
      expect(result).toEqual({
        team: { id: team.id, status: 'active', disabledEnvironments: [] }
      })

      const rows = await auditRows(team, 'admin.team.enable')

      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        resource: 'team',
        role: 'platform-admin',
        outcome: 'success',
        actorUserId: ADMIN,
        reason: null
      })
    })

    test('takes an empty body as well as none', async () => {
      const team = await seedTeam({ status: 'disabled' })

      const { statusCode, result } = await enable(team, {})

      expect(statusCode).toBe(200)
      expect(result.team.status).toBe('active')
    })

    test('never unlocks an environment: one disabled by its credentials stays disabled', async () => {
      const team = await seedTeam({
        status: 'disabled',
        disabledEnvironments: [DEV]
      })

      const { result } = await enable(team)

      expect(result.team).toEqual({
        id: team.id,
        status: 'active',
        disabledEnvironments: [DEV]
      })
    })

    test('a team that is not disabled changes nothing and writes no event', async () => {
      const team = await seedTeam()
      const before = await stored(team)

      const { statusCode, result } = await enable(team)

      expect(statusCode).toBe(200)
      expect(result.team).toEqual({
        id: team.id,
        status: 'active',
        disabledEnvironments: []
      })
      expect(await stored(team)).toEqual(before)
      expect(await auditRows(team, 'admin.team.enable')).toEqual([])
    })

    test('enabling twice writes one event', async () => {
      const team = await seedTeam({ status: 'disabled' })

      await enable(team)
      await enable(team)

      expect(await auditRows(team, 'admin.team.enable')).toHaveLength(1)
    })

    test('leaves a team pending removal pending', async () => {
      const team = await seedTeam({ status: 'pending-removal' })

      const { result } = await enable(team)

      expect(result.team.status).toBe('pending-removal')
    })

    test('never touches the block of the team’s credentials', async () => {
      const team = await seedTeam({
        status: 'disabled',
        disabledEnvironments: [DEV]
      })

      await seedDeployment(team, DEV, { adminBlocked: true })
      await enable(team)

      expect(await deploymentOf(team, DEV)).toMatchObject({
        adminBlocked: true
      })
    })

    test('and enabling the credentials never enables the team, but does unlock that environment', async () => {
      const team = await seedTeam({
        status: 'disabled',
        disabledEnvironments: [DEV]
      })

      await seedDeployment(team, DEV, { adminBlocked: true })

      const { statusCode } = await server.inject({
        method: 'POST',
        url: `/v1/admin/team-deployments/${team.id}/${DEV}/credentials/enable`,
        headers: asAdmin()
      })

      expect(statusCode).toBe(200)
      expect(await stored(team)).toMatchObject({
        status: 'disabled',
        disabledEnvironments: []
      })
    })

    test.each([
      ['a key nobody asked for', { other: 1 }],
      ['environments, which a team no longer takes', { environments: [DEV] }]
    ])('refuses %s with 400 invalid-request', async (_name, payload) => {
      const team = await seedTeam({ status: 'disabled' })

      const { statusCode, result } = await enable(team, payload)

      expect(statusCode).toBe(400)
      expect(result.code).toBe('invalid-request')
      expect((await stored(team)).status).toBe('disabled')
    })

    test('refuses a person who is not a Platform Admin with 403 and changes nothing', async () => {
      const team = await seedTeam({ status: 'disabled' })

      const { statusCode, result } = await enable(team, undefined, asPerson())

      expect(statusCode).toBe(403)
      expect(result.code).toBe('platform-admin-required')
      expect((await stored(team)).status).toBe('disabled')
    })

    test('is 404 team-not-found for a team nobody holds', async () => {
      const missing = await enable(new ObjectId().toString())

      expect(missing.statusCode).toBe(404)
      expect(missing.result.code).toBe('team-not-found')
    })
  })

  describe('Disable credentials is what disables an environment', () => {
    const credentials = (team, environment, action, payload) =>
      server.inject({
        method: 'POST',
        url: `/v1/admin/team-deployments/${team.id}/${environment}/credentials/${action}`,
        headers: { ...asAdmin(), 'idempotency-key': randomUUID() },
        payload
      })

    test('lists the environment on the team and changes the team status not at all', async () => {
      const team = await seedTeam()

      await seedDeployment(team, DEV)

      const disabled = await credentials(team, DEV, 'disable', {
        reason: REASON
      })

      expect(disabled.statusCode).toBe(200)
      expect(await stored(team)).toMatchObject({
        status: 'active',
        disabledEnvironments: [DEV]
      })
    })

    test('lists each environment once and keeps the others when one is enabled again', async () => {
      const team = await seedTeam()

      await seedDeployment(team, DEV)
      await seedDeployment(team, TEST)
      await credentials(team, DEV, 'disable', { reason: REASON })
      await credentials(team, DEV, 'disable', { reason: REASON })
      await credentials(team, TEST, 'disable', { reason: REASON })

      expect((await stored(team)).disabledEnvironments.toSorted()).toEqual([
        DEV,
        TEST
      ])

      await credentials(team, DEV, 'enable')

      expect(await stored(team)).toMatchObject({
        disabledEnvironments: [TEST]
      })
    })

    test('repairs a team that lists an environment whose credentials are not blocked, when they are enabled', async () => {
      const team = await seedTeam({ disabledEnvironments: [DEV] })

      await seedDeployment(team, DEV)
      await credentials(team, DEV, 'enable')

      expect((await stored(team)).disabledEnvironments).toEqual([])
    })
  })

  describe('when the audit event cannot be written after the update', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    // Makes the audit event of one action fail to be written, once.
    function failAuditOnce(action) {
      const original = server.db.collection.bind(server.db)
      let failed = false

      vi.spyOn(server.db, 'collection').mockImplementation((name, ...rest) => {
        const collection = original(name, ...rest)

        if (name !== 'auditEvents') {
          return collection
        }

        return new Proxy(collection, {
          get(target, property) {
            if (property === 'insertOne') {
              return (event, ...args) => {
                if (!failed && event.action === action) {
                  failed = true

                  return Promise.reject(new Error('the audit is down'))
                }

                return target.insertOne(event, ...args)
              }
            }

            const value = target[property]

            return typeof value === 'function' ? value.bind(target) : value
          }
        })
      })
    }

    const pending = () =>
      server.db.collection('pendingAudits').countDocuments({
        _id: /^team-status:/
      })

    test('Disable: the team stays disabled and the reason is off the team’s document; a retry with the same key records the event once with its reason', async () => {
      const team = await seedTeam()
      const key = randomUUID()
      const payload = { reason: REASON }

      failAuditOnce('admin.team.disable')

      const failed = await disable(team, payload, asAdmin(), key)

      expect(failed.statusCode).toBe(500)
      expect(await stored(team)).toMatchObject({ status: 'disabled' })
      expect(JSON.stringify(await stored(team))).not.toContain(REASON)
      expect(await auditRows(team, 'admin.team.disable')).toEqual([])

      const retried = await disable(team, payload, asAdmin(), key)

      expect(retried.statusCode).toBe(200)
      expect(retried.result.team).toEqual({
        id: team.id,
        status: 'disabled',
        disabledEnvironments: []
      })

      const rows = await auditRows(team, 'admin.team.disable')

      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        _id: `admin.team.disable:${team.id}:${key}`,
        outcome: 'success',
        reason: REASON,
        actorUserId: ADMIN
      })
      expect(await stored(team)).not.toHaveProperty('pendingAuditId')
      expect(await pending()).toBe(0)

      const again = await disable(team, payload, asAdmin(), key)

      expect(again.statusCode).toBe(200)
      expect(await auditRows(team, 'admin.team.disable')).toHaveLength(1)
    })

    test('Disable: a key reused with another reason after the failed attempt is still refused once the first event is recorded', async () => {
      const team = await seedTeam()
      const key = randomUUID()

      failAuditOnce('admin.team.disable')
      await disable(team, { reason: REASON }, asAdmin(), key)

      const reused = await disable(team, { reason: 'Another' }, asAdmin(), key)

      expect(reused.statusCode).toBe(409)
      expect(reused.result.code).toBe('idempotency-key-reused')
      expect(await auditRows(team, 'admin.team.disable')).toEqual([
        expect.objectContaining({ reason: REASON })
      ])
    })

    test('Enable: the team stays enabled; a retry records the event once', async () => {
      const team = await seedTeam({ status: 'disabled' })

      failAuditOnce('admin.team.enable')

      const failed = await enable(team)

      expect(failed.statusCode).toBe(500)
      expect(await stored(team)).toMatchObject({ status: 'active' })
      expect(await auditRows(team, 'admin.team.enable')).toEqual([])

      const retried = await enable(team)

      expect(retried.statusCode).toBe(200)

      const rows = await auditRows(team, 'admin.team.enable')

      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        outcome: 'success',
        actorUserId: ADMIN
      })
      expect(await pending()).toBe(0)

      await enable(team)

      expect(await auditRows(team, 'admin.team.enable')).toHaveLength(1)
    })
  })
})

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

  describe('POST /v1/admin/teams/{id}/disable', () => {
    test('disables the team and the environments chosen, and records one event with the reason', async () => {
      const team = await seedTeam()

      const { statusCode, result } = await disable(team, {
        reason: `  ${REASON}  `,
        environments: [DEV]
      })

      expect(statusCode).toBe(200)
      expect(result).toEqual({
        team: { id: team.id, status: 'disabled', disabledEnvironments: [DEV] }
      })
      expect(await stored(team)).toMatchObject({
        status: 'disabled',
        disabledEnvironments: [DEV]
      })

      const rows = await auditRows(team, 'admin.team.disable')

      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        resource: 'team',
        resourceId: team.id,
        role: 'platform-admin',
        outcome: 'success',
        reason: REASON,
        environments: [DEV],
        actorUserId: ADMIN
      })
    })

    test('allows no environment at all: the team alone is disabled', async () => {
      const team = await seedTeam()

      const { statusCode, result } = await disable(team, { reason: REASON })

      expect(statusCode).toBe(200)
      expect(result.team).toEqual({
        id: team.id,
        status: 'disabled',
        disabledEnvironments: []
      })
      expect((await auditRows(team, 'admin.team.disable'))[0]).toMatchObject({
        environments: []
      })
    })

    test('lists the environments in the configured order, once each', async () => {
      const team = await seedTeam()

      const { result } = await disable(team, {
        reason: REASON,
        environments: [TEST, DEV, TEST]
      })

      expect(result.team.disabledEnvironments).toEqual([DEV, TEST])
    })

    test('keeps an environment the instance no longer lists after the listed ones, by name', async () => {
      const team = await seedTeam({
        status: 'disabled',
        disabledEnvironments: ['zzold', 'aaold']
      })

      const { result } = await disable(team, {
        reason: REASON,
        environments: [DEV]
      })

      expect(result.team.disabledEnvironments).toEqual([DEV, 'aaold', 'zzold'])
    })
    test('takes a team by its slug', async () => {
      const team = await seedTeam()

      const { statusCode, result } = await disable(team.slug, {
        reason: REASON
      })

      expect(statusCode).toBe(200)
      expect(result.team.id).toBe(team.id)
    })

    test('leaves the block of the team’s credentials and the file status alone', async () => {
      const team = await seedTeam()

      await server.db.collection('teamDeployments').insertOne({
        teamId: team.id,
        environment: DEV,
        adminBlocked: false,
        deployments: []
      })
      await disable(team, { reason: REASON, environments: [DEV] })

      expect(
        await server.db
          .collection('teamDeployments')
          .findOne({ teamId: team.id, environment: DEV })
      ).toMatchObject({ adminBlocked: false })
    })

    test('a repeat of the same key and reason changes nothing and writes no second event', async () => {
      const team = await seedTeam()
      const key = randomUUID()

      const first = await disable(
        team,
        { reason: REASON, environments: [DEV] },
        asAdmin(),
        key
      )
      const again = await disable(
        team,
        { reason: REASON, environments: [DEV] },
        asAdmin(),
        key
      )

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
        { reason: 'Another reason', environments: [DEV] },
        asAdmin(),
        key
      )

      expect(statusCode).toBe(409)
      expect(result.code).toBe('idempotency-key-reused')
      expect((await stored(team)).disabledEnvironments).toEqual([])
      expect(await auditRows(team, 'admin.team.disable')).toHaveLength(1)
    })

    test('the same key and reason with other environments is 409 idempotency-key-reused, and the new environments are not applied', async () => {
      const team = await seedTeam()
      const key = randomUUID()

      await disable(
        team,
        { reason: REASON, environments: [DEV] },
        asAdmin(),
        key
      )

      const { statusCode, result } = await disable(
        team,
        { reason: REASON, environments: [DEV, TEST] },
        asAdmin(),
        key
      )

      expect(statusCode).toBe(409)
      expect(result.code).toBe('idempotency-key-reused')
      expect((await stored(team)).disabledEnvironments).toEqual([DEV])
      expect(await auditRows(team, 'admin.team.disable')).toHaveLength(1)
    })

    test('the same key and reason with environments where there were none, or none where there were some, is 409 too', async () => {
      const none = await seedTeam()
      const some = await seedTeam()
      const noneKey = randomUUID()
      const someKey = randomUUID()

      await disable(none, { reason: REASON }, asAdmin(), noneKey)
      await disable(
        some,
        { reason: REASON, environments: [DEV] },
        asAdmin(),
        someKey
      )

      expect(
        (
          await disable(
            none,
            { reason: REASON, environments: [DEV] },
            asAdmin(),
            noneKey
          )
        ).statusCode
      ).toBe(409)
      expect(
        (await disable(some, { reason: REASON }, asAdmin(), someKey)).statusCode
      ).toBe(409)
    })

    test('a repeat that lists the same environments in another order, or twice, is a replay', async () => {
      const team = await seedTeam()
      const key = randomUUID()

      await disable(
        team,
        { reason: REASON, environments: [DEV, TEST] },
        asAdmin(),
        key
      )

      const { statusCode, result } = await disable(
        team,
        { reason: REASON, environments: [TEST, DEV, TEST] },
        asAdmin(),
        key
      )

      expect(statusCode).toBe(200)
      expect(result.team.disabledEnvironments).toEqual([DEV, TEST])
      expect(await auditRows(team, 'admin.team.disable')).toHaveLength(1)
    })

    test('the requested environments are kept on the event for the repeat check, and not shown in the audit log', async () => {
      const team = await seedTeam({
        status: 'disabled',
        disabledEnvironments: [TEST]
      })

      await disable(team, { reason: REASON, environments: [DEV, TEST] })

      const [row] = await auditRows(team, 'admin.team.disable')

      expect(row.environments).toEqual([DEV])
      expect(row.requestedEnvironments).toEqual([DEV, TEST])

      const { statusCode, result } = await server.inject({
        method: 'GET',
        url: `/v1/admin/audit?team=${team.id}`,
        headers: asAdmin()
      })
      const shown = result.events.find(
        ({ action }) => action === 'admin.team.disable'
      )

      expect(statusCode).toBe(200)
      expect(shown).toBeDefined()
      expect(shown).not.toHaveProperty('requestedEnvironments')
      expect(JSON.stringify(shown)).not.toContain(TEST)
    })

    test('a team already disabled with nothing to add changes nothing and writes no event', async () => {
      const team = await seedTeam({
        status: 'disabled',
        disabledEnvironments: [DEV]
      })

      const { statusCode, result } = await disable(team, {
        reason: REASON,
        environments: [DEV]
      })

      expect(statusCode).toBe(200)
      expect(result.team.disabledEnvironments).toEqual([DEV])
      expect(await auditRows(team, 'admin.team.disable')).toEqual([])
    })

    test('a team already disabled takes environments it has not got, and records only those', async () => {
      const team = await seedTeam({
        status: 'disabled',
        disabledEnvironments: [TEST]
      })

      const { result } = await disable(team, {
        reason: REASON,
        environments: [DEV, TEST]
      })

      expect(result.team.disabledEnvironments).toEqual([DEV, TEST])

      const rows = await auditRows(team, 'admin.team.disable')

      expect(rows).toHaveLength(1)
      expect(rows[0].environments).toEqual([DEV])
    })

    test('disables a team made active again by a partial enable, keeping its disabled environments', async () => {
      const team = await seedTeam({
        status: 'active',
        disabledEnvironments: [TEST]
      })

      const { result } = await disable(team, { reason: REASON })

      expect(result.team).toEqual({
        id: team.id,
        status: 'disabled',
        disabledEnvironments: [TEST]
      })
      expect(await auditRows(team, 'admin.team.disable')).toHaveLength(1)
    })

    test('refuses a team pending removal with 409 team-pending-removal, and changes and records nothing', async () => {
      const team = await seedTeam({ status: 'pending-removal' })

      const { statusCode, result } = await disable(team, {
        reason: REASON,
        environments: [DEV]
      })

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
        'environments that are not a list',
        { reason: REASON, environments: DEV },
        'invalid-request'
      ],
      [
        'an environment that is not a name',
        { reason: REASON, environments: ['Not A Name'] },
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

    test('is 404 environment-not-found for an environment this instance does not offer, and changes nothing', async () => {
      const team = await seedTeam()

      const { statusCode, result } = await disable(team, {
        reason: REASON,
        environments: [DEV, 'unlisted']
      })

      expect(statusCode).toBe(404)
      expect(result.code).toBe('environment-not-found')
      expect((await stored(team)).status).toBe('active')
      expect(await auditRows(team, 'admin.team.disable')).toEqual([])
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
    test('with no environments named, lifts the lock and unlocks every disabled environment', async () => {
      const team = await seedTeam({
        status: 'disabled',
        disabledEnvironments: [DEV, TEST]
      })

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
        environments: [DEV, TEST],
        actorUserId: ADMIN,
        reason: null
      })
    })

    test('lifts the team lock at once and leaves the environments not chosen disabled', async () => {
      const team = await seedTeam({
        status: 'disabled',
        disabledEnvironments: [DEV, TEST]
      })

      const { result } = await enable(team, { environments: [DEV] })

      expect(result.team).toEqual({
        id: team.id,
        status: 'active',
        disabledEnvironments: [TEST]
      })
      expect((await auditRows(team, 'admin.team.enable'))[0]).toMatchObject({
        environments: [DEV]
      })
    })

    test('with an empty list lifts the team lock only', async () => {
      const team = await seedTeam({
        status: 'disabled',
        disabledEnvironments: [DEV]
      })

      const { result } = await enable(team, { environments: [] })

      expect(result.team).toEqual({
        id: team.id,
        status: 'active',
        disabledEnvironments: [DEV]
      })
    })

    test('can unlock an environment later, with the team already active', async () => {
      const team = await seedTeam({
        status: 'active',
        disabledEnvironments: [DEV]
      })

      const { result } = await enable(team, { environments: [DEV] })

      expect(result.team).toEqual({
        id: team.id,
        status: 'active',
        disabledEnvironments: []
      })
      expect(await auditRows(team, 'admin.team.enable')).toHaveLength(1)
    })

    test('a team that is not disabled and has nothing to unlock changes nothing and writes no event', async () => {
      const team = await seedTeam()
      const before = await stored(team)

      const { statusCode, result } = await enable(team, {
        environments: [DEV]
      })

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
      const team = await seedTeam({
        status: 'pending-removal',
        disabledEnvironments: [DEV]
      })

      const { result } = await enable(team)

      expect(result.team.status).toBe('pending-removal')
      expect(result.team.disabledEnvironments).toEqual([])
    })

    test('never touches the block of the team’s credentials', async () => {
      const team = await seedTeam({
        status: 'disabled',
        disabledEnvironments: [DEV]
      })

      await server.db.collection('teamDeployments').insertOne({
        teamId: team.id,
        environment: DEV,
        adminBlocked: true,
        deployments: []
      })
      await enable(team)

      expect(
        await server.db
          .collection('teamDeployments')
          .findOne({ teamId: team.id, environment: DEV })
      ).toMatchObject({ adminBlocked: true })
    })

    test('and enabling the credentials never enables the team', async () => {
      const team = await seedTeam({
        status: 'disabled',
        disabledEnvironments: [DEV]
      })

      await server.db.collection('teamDeployments').insertOne({
        teamId: team.id,
        environment: DEV,
        adminBlocked: true,
        deployments: []
      })

      const { statusCode } = await server.inject({
        method: 'POST',
        url: `/v1/admin/team-deployments/${team.id}/${DEV}/credentials/enable`,
        headers: asAdmin()
      })

      expect(statusCode).toBe(200)
      expect(await stored(team)).toMatchObject({
        status: 'disabled',
        disabledEnvironments: [DEV]
      })
    })

    test.each([
      ['a key nobody asked for', { other: 1 }],
      ['environments that are not a list', { environments: DEV }]
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

    test('is 404 team-not-found for a team nobody holds, and 404 environment-not-found for an environment not offered', async () => {
      const team = await seedTeam({ status: 'disabled' })
      const missing = await enable(new ObjectId().toString())
      const unlisted = await enable(team, { environments: ['unlisted'] })

      expect(missing.statusCode).toBe(404)
      expect(missing.result.code).toBe('team-not-found')
      expect(unlisted.statusCode).toBe(404)
      expect(unlisted.result.code).toBe('environment-not-found')
      expect((await stored(team)).status).toBe('disabled')
    })
  })
})

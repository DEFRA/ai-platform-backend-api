import { randomUUID } from 'node:crypto'

import { ObjectId } from 'mongodb'

import {
  authFor,
  appAuth,
  oidFor,
  withTestUsers
} from '#/common/test-helpers/portal-token.js'

const ADMIN_ROLES = ['research-user', 'platform-admin']
const ADMIN = 'admin-audit-admin'
const MINUTE = 60 * 1000
const BASE_TIME = Date.parse('2026-06-15T12:00:00.000Z')

describe('#admin audit log read', () => {
  let server
  let config
  let configured

  beforeAll(async () => {
    // Dynamic import needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')

    server = await createServer()
    await server.initialize()
    withTestUsers(server)
    ;({ config } = await import('#/config.js'))
    configured = {
      environments: config.get('teamDeployment.environments'),
      retentionDays: config.get('audit.retentionDays')
    }
  })

  afterAll(async () => {
    await server.stop({ timeout: 0 })
  })

  beforeEach(async () => {
    await server.db.collection('auditEvents').deleteMany({})
  })

  afterEach(() => {
    config.set('teamDeployment.environments', configured.environments)
    config.set('audit.retentionDays', configured.retentionDays)
  })

  const asAdmin = () => authFor(ADMIN, { roles: ADMIN_ROLES })

  function get(query = '', headers = asAdmin()) {
    return server.inject({
      method: 'GET',
      url: `/v1/admin/audit${query}`,
      headers
    })
  }

  const events = () => server.db.collection('auditEvents')
  const newTeamId = () => new ObjectId().toString()

  // An event the way `recordAuditEvent` stores it; `minutes` after the base time.
  function event(overrides = {}) {
    const { minutes = 0, ...fields } = overrides

    return {
      at: new Date(BASE_TIME + minutes * MINUTE),
      actorUserId: 'someone-nobody-knows',
      oid: null,
      tid: null,
      azp: null,
      uti: null,
      role: 'user',
      action: 'team.setDescription',
      resource: 'team',
      resourceId: 'r-1',
      outcome: 'success',
      code: null,
      reason: null,
      requestId: null,
      ...fields
    }
  }

  async function seed(...docs) {
    if (docs.length > 0) {
      await events().insertMany(docs.map((doc) => event(doc)))
    }
  }

  async function insertPerson(label, displayName) {
    await server.db.collection('users').insertOne({
      _id: label,
      oid: oidFor(label),
      tid: 'tenant-of-test',
      email: `${label}@defra.gov.uk`,
      displayName,
      roles: ['research-user']
    })

    return label
  }

  async function insertTeam(name) {
    const { insertedId } = await server.db.collection('teams').insertOne({
      name,
      normalisedName: name.toLowerCase().replaceAll(' ', '-'),
      slug: name.toLowerCase().replaceAll(' ', '-')
    })

    return insertedId.toString()
  }

  describe('the page of events', () => {
    test('returns an event with who, what, when, the team and the environment, and the lists a filter form needs', async () => {
      const suffix = randomUUID().slice(0, 8)
      const teamId = await insertTeam(`Audit Alpha ${suffix}`)
      const actorId = await insertPerson(`actor-${suffix}`, 'Jo Smith')
      const subject = await insertPerson(`subject-${suffix}`, 'Sam Jones')

      config.set('teamDeployment.environments', ['infradev', 'sandbox'])
      config.set('audit.retentionDays', 14)
      await seed({
        _id: 'event-1',
        actorUserId: actorId,
        role: 'admin',
        action: 'team.removeMember',
        resource: 'team',
        resourceId: teamId,
        teamId,
        environment: 'infradev',
        subjectOid: oidFor(subject),
        outcome: 'success',
        code: 'removed',
        reason: 'left the project'
      })

      const { statusCode, result } = await get(`?team=${teamId}`)

      expect(statusCode).toBe(200)
      expect(result).toEqual({
        events: [
          {
            id: 'event-1',
            at: new Date(BASE_TIME).toISOString(),
            action: 'team.removeMember',
            outcome: 'success',
            code: 'removed',
            reason: 'left the project',
            resource: 'team',
            actor: { type: 'team-admin', displayName: 'Jo Smith' },
            subject: { displayName: 'Sam Jones' },
            team: { id: teamId, name: `Audit Alpha ${suffix}` },
            environment: 'infradev'
          }
        ],
        page: 1,
        pageSize: 25,
        total: 1,
        retentionDays: 14,
        options: {
          teams: expect.arrayContaining([
            { id: teamId, name: `Audit Alpha ${suffix}` }
          ]),
          environments: ['infradev', 'sandbox']
        }
      })
    })

    test('lists the teams in the filter options by name', async () => {
      const suffix = randomUUID().slice(0, 8)
      const second = await insertTeam(`Zz Audit ${suffix}`)
      const first = await insertTeam(`Aa Audit ${suffix}`)

      const { result } = await get()
      const ids = result.options.teams.map(({ id }) => id)

      expect(ids.indexOf(first)).toBeGreaterThanOrEqual(0)
      expect(ids.indexOf(first)).toBeLessThan(ids.indexOf(second))
    })

    test('gives null for what an event does not hold: no subject, no team, no environment, no code and no reason', async () => {
      await seed({ _id: 'bare', role: null, actorUserId: 'someone' })

      const { result } = await get()

      expect(result.events).toEqual([
        {
          id: 'bare',
          at: new Date(BASE_TIME).toISOString(),
          action: 'team.setDescription',
          outcome: 'success',
          code: null,
          reason: null,
          resource: 'team',
          actor: { type: 'person', displayName: null },
          subject: null,
          team: null,
          environment: null
        }
      ])
    })

    test('gives null names for a person who is no longer known and a team that no longer exists', async () => {
      const teamId = newTeamId()

      await seed({
        actorUserId: 'a-person-who-is-gone',
        teamId,
        subjectOid: oidFor('nobody')
      })

      const { result } = await get(`?team=${teamId}`)

      expect(result.events[0]).toMatchObject({
        actor: { displayName: null },
        subject: { displayName: null },
        team: { id: teamId, name: null }
      })
    })

    test('shows the backend itself as the system, with no name', async () => {
      const teamId = newTeamId()

      await seed({
        actorUserId: 'app:ai-platform-backend',
        role: 'system',
        action: 'operation.external',
        teamId
      })

      const { result } = await get(`?team=${teamId}`)

      expect(result.events[0].actor).toEqual({
        type: 'system',
        displayName: null
      })
    })

    test('returns a reason exactly as it was stored, unmasked', async () => {
      const teamId = newTeamId()
      const reason = 'Jo Smith asked: mail jo.smith@defra.gov.uk <b>now</b>'

      await seed({ teamId, reason })

      const { result } = await get(`?team=${teamId}`)

      expect(result.events[0].reason).toBe(reason)
    })

    test('holds no id, object id, tenant, token or request detail of the people, or any email, outside the reason', async () => {
      const suffix = randomUUID().slice(0, 8)
      const teamId = newTeamId()
      const actorId = await insertPerson(`scan-actor-${suffix}`, 'Pat Actor')
      const subject = await insertPerson(
        `scan-subject-${suffix}`,
        'Sue Subject'
      )

      await seed({
        actorUserId: actorId,
        oid: oidFor(actorId),
        tid: 'tenant-of-test',
        azp: 'client-of-test',
        uti: 'uti-of-test',
        requestId: 'trace-of-test',
        subjectOid: oidFor(subject),
        teamId,
        resourceId: 'internal-resource-id',
        reason: 'a@b.c'
      })

      const { result } = await get(`?team=${teamId}`)
      const [found] = result.events
      const { reason: _reason, id: _id, ...rest } = found
      const body = JSON.stringify(rest)

      for (const leaked of [
        '@',
        oidFor(actorId),
        oidFor(subject),
        'tenant-of-test',
        'client-of-test',
        'uti-of-test',
        'trace-of-test',
        'internal-resource-id',
        actorId
      ]) {
        expect(body).not.toContain(leaked)
      }

      for (const key of [
        'oid',
        'tid',
        'azp',
        'uti',
        'actorUserId',
        'requestId',
        'resourceId',
        'subjectOid'
      ]) {
        expect(result.events[0]).not.toHaveProperty(key)
      }
    })

    test('lists newest first, and events at the same time in a stable order', async () => {
      const teamId = newTeamId()

      await seed(
        { _id: 'a-old', teamId, minutes: 0 },
        { _id: 'b-tie', teamId, minutes: 5 },
        { _id: 'c-tie', teamId, minutes: 5 },
        { _id: 'd-new', teamId, minutes: 9 }
      )

      const first = await get(`?team=${teamId}`)
      const again = await get(`?team=${teamId}`)

      expect(first.result.events.map(({ id }) => id)).toEqual([
        'd-new',
        'c-tie',
        'b-tie',
        'a-old'
      ])
      expect(again.result.events).toEqual(first.result.events)
    })

    test.each([
      [0, 1, 0, 0],
      [25, 1, 25, 25],
      [26, 1, 25, 26],
      [26, 2, 1, 26],
      [26, 3, 0, 26]
    ])(
      'with %i events, page %i holds %i and the total is %i',
      async (count, page, onPage, total) => {
        const teamId = newTeamId()

        await seed(
          ...Array.from({ length: count }, (_, index) => ({
            teamId,
            minutes: index
          }))
        )

        const { result } = await get(`?team=${teamId}&page=${page}`)

        expect(result).toMatchObject({ page, pageSize: 25, total })
        expect(result.events).toHaveLength(onPage)
      }
    )

    test('does not record an audit event for reading the log', async () => {
      await seed({})
      const before = await events().countDocuments()

      await get()
      await get('?action=team.setDescription')

      expect(await events().countDocuments()).toBe(before)
    })
  })

  describe('the filters', () => {
    test('team: only that team’s events', async () => {
      const [mine, other] = [newTeamId(), newTeamId()]

      await seed({ _id: 'mine', teamId: mine }, { _id: 'other', teamId: other })

      const { result } = await get(`?team=${mine}`)

      expect(result.events.map(({ id }) => id)).toEqual(['mine'])
      expect(result.total).toBe(1)
    })

    test('environment: only events of that environment', async () => {
      const teamId = newTeamId()

      await seed(
        { _id: 'dev', teamId, environment: 'infradev' },
        { _id: 'box', teamId, environment: 'sandbox' },
        { _id: 'none', teamId }
      )

      const { result } = await get(`?team=${teamId}&environment=sandbox`)

      expect(result.events.map(({ id }) => id)).toEqual(['box'])
    })

    test('action: only that action, exactly', async () => {
      const teamId = newTeamId()

      await seed(
        { _id: 'one', teamId, action: 'team.setDescription' },
        { _id: 'two', teamId, action: 'team.setDescriptionX' },
        { _id: 'three', teamId, action: 'access.denied' }
      )

      const { result } = await get(`?team=${teamId}&action=team.setDescription`)

      expect(result.events.map(({ id }) => id)).toEqual(['one'])
    })

    test.each([
      ['platform-admin', ['pa']],
      ['team-admin', ['ta']],
      ['team-member', ['tm']],
      ['person', ['owner', 'none', 'missing']],
      ['system', ['sys']]
    ])('actorType %s maps to its stored roles', async (type, expected) => {
      const teamId = newTeamId()
      const stored = (id, doc) => event({ _id: id, teamId, ...doc })
      const withoutRole = stored('missing', {})

      delete withoutRole.role
      await events().insertMany([
        stored('pa', { role: 'platform-admin' }),
        stored('ta', { role: 'admin' }),
        stored('tm', { role: 'user' }),
        stored('owner', { role: 'owner' }),
        stored('none', { role: null }),
        withoutRole,
        stored('sys', { role: 'system' })
      ])

      const { result } = await get(`?team=${teamId}&actorType=${type}`)

      expect(result.events.map(({ id }) => id).sort()).toEqual(
        [...expected].sort()
      )
    })

    test('actorType: each event shows the type its role maps to', async () => {
      const teamId = newTeamId()

      await seed(
        { _id: 'pa', teamId, role: 'platform-admin', minutes: 1 },
        { _id: 'ta', teamId, role: 'admin', minutes: 2 },
        { _id: 'tm', teamId, role: 'user', minutes: 3 },
        { _id: 'ow', teamId, role: 'owner', minutes: 4 },
        { _id: 'no', teamId, role: null, minutes: 5 },
        { _id: 'sy', teamId, role: 'system', minutes: 6 }
      )

      const { result } = await get(`?team=${teamId}`)

      expect(result.events.map(({ actor }) => actor.type)).toEqual([
        'system',
        'person',
        'person',
        'team-member',
        'team-admin',
        'platform-admin'
      ])
    })

    describe('person', () => {
      let teamId
      let jo
      let sam

      beforeEach(async () => {
        const suffix = randomUUID().slice(0, 8)

        teamId = newTeamId()
        jo = await insertPerson(`jo-${suffix}`, `Jo (Smith) ${suffix}`)
        sam = await insertPerson(`sam-${suffix}`, `Sam Jones ${suffix}`)
        await seed(
          { _id: 'by-jo', teamId, actorUserId: jo },
          { _id: 'by-sam', teamId, actorUserId: sam },
          { _id: 'by-nobody', teamId, actorUserId: 'nobody-here' }
        )
      })

      const ids = (result) => result.events.map(({ id }) => id)

      test('matches part of an actor’s name, ignoring case', async () => {
        const { result } = await get(`?team=${teamId}&person=sAM%20jon`)

        expect(ids(result)).toEqual(['by-sam'])
      })

      test('matches the characters of a pattern literally', async () => {
        const literal = await get(
          `?team=${teamId}&person=${encodeURIComponent('(Smith)')}`
        )
        const wildcard = await get(
          `?team=${teamId}&person=${encodeURIComponent('J.')}`
        )

        expect(ids(literal.result)).toEqual(['by-jo'])
        expect(ids(wildcard.result)).toEqual([])
      })

      test('trims the text it is given', async () => {
        const { result } = await get(`?team=${teamId}&person=%20%20sam%20%20`)

        expect(ids(result)).toEqual(['by-sam'])
      })

      test('matches no event when it matches no one', async () => {
        const { statusCode, result } = await get(
          `?team=${teamId}&person=zzz-no-such-person`
        )

        expect(statusCode).toBe(200)
        expect(result.events).toEqual([])
        expect(result.total).toBe(0)
      })

      test('considers at most 100 people', async () => {
        const marker = `bulk-${randomUUID().slice(0, 8)}`

        await server.db.collection('users').insertMany(
          Array.from({ length: 101 }, (_, index) => ({
            _id: `${marker}-${String(index).padStart(3, '0')}`,
            oid: oidFor(`${marker}-${index}`),
            tid: 'tenant-of-test',
            displayName: `${marker} person`
          }))
        )
        await events().insertMany(
          Array.from({ length: 101 }, (_, index) =>
            event({
              teamId,
              actorUserId: `${marker}-${String(index).padStart(3, '0')}`
            })
          )
        )

        const { result } = await get(`?team=${teamId}&person=${marker}`)

        expect(result.total).toBe(100)
      })
    })

    test('from and to: an inclusive range of time', async () => {
      const teamId = newTeamId()

      await seed(
        { _id: 'before', teamId, minutes: -1 },
        { _id: 'at-from', teamId, minutes: 0 },
        { _id: 'inside', teamId, minutes: 5 },
        { _id: 'at-to', teamId, minutes: 10 },
        { _id: 'after', teamId, minutes: 11 }
      )

      const from = new Date(BASE_TIME).toISOString()
      const to = new Date(BASE_TIME + 10 * MINUTE).toISOString()
      const both = await get(`?team=${teamId}&from=${from}&to=${to}`)
      const fromOnly = await get(`?team=${teamId}&from=${from}`)
      const toOnly = await get(`?team=${teamId}&to=${from}`)

      expect(both.result.events.map(({ id }) => id)).toEqual([
        'at-to',
        'inside',
        'at-from'
      ])
      expect(fromOnly.result.total).toBe(4)
      expect(toOnly.result.events.map(({ id }) => id)).toEqual([
        'at-from',
        'before'
      ])
    })

    test('combined filters all apply, and the total counts what matches', async () => {
      const teamId = newTeamId()
      const actor = await insertPerson(
        `combo-${randomUUID().slice(0, 8)}`,
        'Combo Person'
      )

      await seed(
        {
          _id: 'match',
          teamId,
          environment: 'infradev',
          action: 'team.removeMember',
          role: 'admin',
          actorUserId: actor
        },
        {
          _id: 'wrong-role',
          teamId,
          environment: 'infradev',
          action: 'team.removeMember',
          role: 'user',
          actorUserId: actor
        },
        {
          _id: 'wrong-env',
          teamId,
          environment: 'sandbox',
          action: 'team.removeMember',
          role: 'admin',
          actorUserId: actor
        }
      )

      const { result } = await get(
        `?team=${teamId}&environment=infradev&action=team.removeMember&actorType=team-admin&person=combo`
      )

      expect(result.events.map(({ id }) => id)).toEqual(['match'])
      expect(result.total).toBe(1)
    })

    test('pages keep to the filter', async () => {
      const teamId = newTeamId()

      await events().insertMany(
        Array.from({ length: 30 }, (_, index) =>
          event({ teamId, minutes: index })
        )
      )
      await seed({ teamId: newTeamId() })

      const { result } = await get(`?team=${teamId}&page=2`)

      expect(result).toMatchObject({ page: 2, total: 30 })
      expect(result.events).toHaveLength(5)
    })
  })

  describe('refusals', () => {
    test.each([
      ['an empty team', 'team='],
      ['a team over 100 characters', `team=${'x'.repeat(101)}`],
      ['an environment in capitals', 'environment=Sandbox'],
      ['an environment over 40 characters', `environment=${'a'.repeat(41)}`],
      ['a person of one character', 'person=a'],
      ['a person of one character after trimming', 'person=%20a%20'],
      ['a person over 100 characters', `person=${'a'.repeat(101)}`],
      ['an action with no dot', 'action=teamcreate'],
      ['an action with a pattern in it', 'action=team.%2A'],
      ['an action over 64 characters', `action=team.${'a'.repeat(64)}`],
      ['an unknown actor type', 'actorType=robot'],
      ['a from that is not a date', 'from=yesterday'],
      ['a to that is not a date', 'to=soon'],
      [
        'a from after the to',
        'from=2026-06-02T00:00:00.000Z&to=2026-06-01T00:00:00.000Z'
      ],
      ['a page of 0', 'page=0'],
      ['a page that is not a number', 'page=first'],
      ['a key the route does not know', 'sort=asc'],
      ['a status, which is the Teams list’s', 'status=active']
    ])('refuses %s with 400 invalid-query', async (_name, query) => {
      const { statusCode, result } = await get(`?${query}`)

      expect(statusCode).toBe(400)
      expect(result.code).toBe('invalid-query')
    })

    test('accepts a from equal to the to', async () => {
      const when = new Date(BASE_TIME).toISOString()

      const { statusCode } = await get(`?from=${when}&to=${when}`)

      expect(statusCode).toBe(200)
    })

    test('does not echo a refused person', async () => {
      const secret = `s${'x'.repeat(100)}`

      const { result } = await get(`?person=${secret}`)

      expect(JSON.stringify(result)).not.toContain(secret)
    })

    test('refuses a person who is not a Platform Admin with 403, an access.denied event, and no events', async () => {
      await seed({})
      const before = await events().countDocuments({
        action: 'access.denied',
        code: 'platform-admin-required'
      })

      const { statusCode, result } = await get('', authFor('admin-audit-plain'))

      expect(statusCode).toBe(403)
      expect(result.code).toBe('platform-admin-required')
      expect(result).not.toHaveProperty('events')
      expect(
        await events().countDocuments({
          action: 'access.denied',
          code: 'platform-admin-required'
        })
      ).toBe(before + 1)
    })

    test('refuses the frontend’s own app-only token with 401 and no event', async () => {
      const before = await events().countDocuments()

      const { statusCode } = await get('', appAuth())

      expect(statusCode).toBe(401)
      expect(await events().countDocuments()).toBe(before)
    })

    test('refuses a request with no token with 401', async () => {
      const { statusCode } = await get('', {})

      expect(statusCode).toBe(401)
    })
  })

  describe('speed', () => {
    test('answers a page of 10,000 events in under a second, with or without a filter', async () => {
      const teamId = newTeamId()

      await events().insertMany(
        Array.from({ length: 10000 }, (_, index) =>
          event({ teamId: index % 2 ? teamId : newTeamId(), minutes: index })
        )
      )

      for (const query of ['', `?team=${teamId}`]) {
        const started = performance.now()
        const { statusCode, result } = await get(query)

        expect(statusCode).toBe(200)
        expect(result.events).toHaveLength(25)
        expect(performance.now() - started).toBeLessThan(1000)
      }
    })

    test.each([
      ['no filter', () => ({})],
      ['a team', () => ({ teamId: 'any-team' })]
    ])(
      'reads a page with %s in index order, with no sort of the events',
      async (_name, filterOf) => {
        const plan = await events()
          .find(filterOf())
          .sort({ at: -1, _id: -1 })
          .limit(25)
          .explain('queryPlanner')
        const stages = JSON.stringify(plan.queryPlanner.winningPlan)

        expect(stages).toContain('IXSCAN')
        expect(stages).not.toContain('"stage":"SORT"')
      }
    )
  })
})

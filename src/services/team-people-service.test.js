import { randomUUID } from 'node:crypto'

import nock from 'nock'
import { ObjectId } from 'mongodb'

import { dbFailingOn } from '#/common/test-helpers/failing-db.js'
import { actorFor } from '#/common/test-helpers/portal-token.js'

// The graph directory adapter imports #/config.js, which snapshots MONGO_URI
// on first import, so it is loaded in beforeAll (after the in-memory Mongo
// setup file has set that variable), never as a static import: a static one
// makes the server connect to the default 127.0.0.1:27017, which only works
// where a Mongo happens to run there (not on CI).
let createGraphDirectory

// The repo's global test setup swaps global.fetch for a mock when each file
// starts; nock intercepts the real one.
const realFetch = globalThis.fetch

const TENANT_ID = '6f504113-6b64-43f2-ade9-242e05780007'

describe('team-people-service: adding people from the directory', () => {
  let server
  let db
  let service
  let peopleService
  let userService

  beforeAll(async () => {
    // Dynamic imports needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')

    ;({ createGraphDirectory } =
      await import('#/adapters/azure/graph-directory.js'))

    server = await createServer()
    await server.initialize()
    db = server.db
    service = await import('#/services/team-service.js')
    peopleService = await import('#/services/team-people-service.js')
    userService = await import('#/services/user-service.js')
  })

  afterAll(async () => {
    await server?.stop({ timeout: 0 })
  })

  test('runs against the in-memory database the setup file started, not a localhost one', async () => {
    const { config } = await import('#/config.js')

    expect(config.get('mongo.mongoUrl')).toBe(process.env.MONGO_URI)
  })

  const DOMAINS = ['defra.gov.uk']

  function directoryOf(...people) {
    return {
      searchPeople: vi.fn(async () => people),
      getPerson: vi.fn(
        async ({ oid }) => people.find((one) => one.oid === oid) ?? null
      )
    }
  }

  function ada(overrides = {}) {
    return {
      oid: randomUUID(),
      displayName: 'Ada Service',
      mail: 'ada.service@defra.gov.uk',
      userPrincipalName: 'ada.service@defra.gov.uk',
      ...overrides
    }
  }

  // A team and its Admin, who has signed in, made through the service. The
  // admin is the actor the token would give.
  async function teamWithAdmin(label) {
    const tokenActor = actorFor('placeholder', { tid: TENANT_ID })
    const { user } = await userService.upsertUser(db, {
      oid: randomUUID(),
      tid: TENANT_ID,
      email: `${label}@defra.gov.uk`,
      displayName: `Admin ${label}`,
      actor: tokenActor
    })
    const adminId = user._id.toString()
    const actor = actorFor(adminId, { oid: user.oid })
    const { team } = await service.createTeam(db, {
      // The unique part comes after the label alone, so a slug cut to its
      // length limit still holds it: the test database outlives a run, and a
      // label shared across runs would use up the numbered suffixes.
      name: `${label} ${randomUUID().slice(0, 6)}`,
      serviceCode: 'ABC',
      actor,
      idempotencyKey: randomUUID()
    })

    return { adminId, actor, teamId: team._id.toString() }
  }

  function add(team, person, directory, overrides = {}) {
    return peopleService.addMember(
      db,
      {
        teamId: team.teamId,
        actor: team.actor,
        oid: person.oid,
        role: 'user',
        idempotencyKey: randomUUID(),
        userAssertion: 'user-token',
        ...overrides
      },
      { directory, allowedDomains: DOMAINS }
    )
  }

  // Settles every call, so a test sees which of the concurrent requests won
  // and how the others were refused.
  async function settled(calls) {
    const results = await Promise.allSettled(calls)

    return {
      won: results.filter((r) => r.status === 'fulfilled').map((r) => r.value),
      refused: results
        .filter((r) => r.status === 'rejected')
        .map((r) => r.reason)
    }
  }

  function activeMemberships(team) {
    return db
      .collection('teamMembers')
      .countDocuments({ teamId: team.teamId, status: 'active' })
  }

  test('addMember lets one of two people who race for the same key win, and refuses the other as a reused key (F2)', async () => {
    const team = await teamWithAdmin('svc-race-other')
    const first = ada()
    const second = ada({ displayName: 'Bea Service' })
    const directory = directoryOf(first, second)
    const idempotencyKey = randomUUID()

    const { won, refused } = await settled(
      Array.from({ length: 8 }, (_, index) =>
        add(team, index % 2 ? second : first, directory, { idempotencyKey })
      )
    )

    expect(new Set(won.map((member) => member.userId)).size).toBe(1)
    expect(refused).toHaveLength(4)
    for (const error of refused) {
      expect(error).toMatchObject({
        output: { statusCode: 409 },
        data: { code: 'idempotency-key-reused' }
      })
    }
    expect(await activeMemberships(team)).toBe(2)
  })

  test('addMember lets one of two roles that race for the same key win, and refuses the other as a reused key (F2)', async () => {
    const team = await teamWithAdmin('svc-race-role')
    const person = ada()
    const directory = directoryOf(person)
    const idempotencyKey = randomUUID()

    const { won, refused } = await settled(
      ['user', 'admin', 'user', 'admin'].map((role) =>
        add(team, person, directory, { idempotencyKey, role })
      )
    )

    expect(new Set(won.map((member) => member._id.toString())).size).toBe(1)
    expect(refused).toHaveLength(2)
    for (const error of refused) {
      expect(error).toMatchObject({ data: { code: 'idempotency-key-reused' } })
    }
    expect(await activeMemberships(team)).toBe(2)
  })

  test('addMember adds a person once when requests with different keys race for them, and refuses the rest as a duplicate', async () => {
    const team = await teamWithAdmin('svc-race-person')
    const person = ada()
    const directory = directoryOf(person)

    const { won, refused } = await settled(
      Array.from({ length: 6 }, () => add(team, person, directory))
    )

    expect(won).toHaveLength(1)
    expect(refused).toHaveLength(5)
    for (const error of refused) {
      expect(error).toMatchObject({
        output: { statusCode: 409 },
        data: { code: 'member-exists' }
      })
    }
    expect(await activeMemberships(team)).toBe(2)
  })

  test('addMember refuses a key reused with another role, as a replay', async () => {
    const team = await teamWithAdmin('svc-role')
    const person = ada()
    const directory = directoryOf(person)
    const idempotencyKey = randomUUID()

    await add(team, person, directory, { idempotencyKey, role: 'user' })

    await expect(
      add(team, person, directory, { idempotencyKey, role: 'admin' })
    ).rejects.toMatchObject({ data: { code: 'idempotency-key-reused' } })
  })

  test('addMember refuses a key reused for another person, as a replay', async () => {
    const team = await teamWithAdmin('svc-other-person')
    const first = ada()
    const second = ada({ displayName: 'Bea Service' })
    const directory = directoryOf(first, second)
    const idempotencyKey = randomUUID()

    await add(team, first, directory, { idempotencyKey })

    await expect(
      add(team, second, directory, { idempotencyKey })
    ).rejects.toMatchObject({ data: { code: 'idempotency-key-reused' } })
  })

  test('addMember replays a retry after the member’s role was changed, and still refuses another role for the key (thread 2)', async () => {
    const team = await teamWithAdmin('svc-role-changed')
    const person = ada()
    const directory = directoryOf(person)
    const idempotencyKey = randomUUID()
    const first = await add(team, person, directory, {
      idempotencyKey,
      role: 'user'
    })

    await db
      .collection('teamMembers')
      .updateOne({ _id: first._id }, { $set: { role: 'admin' } })
    const retry = await add(team, person, directory, {
      idempotencyKey,
      role: 'user'
    })

    expect(retry._id.toString()).toBe(first._id.toString())
    expect(retry.role).toBe('admin')
    await expect(
      add(team, person, directory, { idempotencyKey, role: 'admin' })
    ).rejects.toMatchObject({ data: { code: 'idempotency-key-reused' } })
  })

  test('addMember keeps the role the add asked for with its key', async () => {
    const team = await teamWithAdmin('svc-requested-role')
    const person = ada()

    const member = await add(team, person, directoryOf(person), {
      role: 'admin'
    })

    expect(
      await db.collection('teamMembers').findOne({ _id: member._id })
    ).toMatchObject({ role: 'admin', requestedRole: 'admin' })
  })

  test.each([
    ['empty', ''],
    ['spaces', '   '],
    ['a tab', '\t']
  ])(
    'addMember stores and returns the user principal name when the mail is %s, never a blank email (thread 3)',
    async (_, mail) => {
      const team = await teamWithAdmin('svc-blank-mail')
      const person = ada({
        mail,
        userPrincipalName: 'Blank.Mail@defra.gov.uk'
      })

      const member = await add(team, person, directoryOf(person))

      expect(member.email).toBe('blank.mail@defra.gov.uk')
      expect(
        (await db.collection('users').findOne({ oid: person.oid })).email
      ).toBe('blank.mail@defra.gov.uk')
    }
  )

  test('addMember hands the user assertion to the directory and checks the person against the allowed domains', async () => {
    const team = await teamWithAdmin('svc-assertion')
    const outsider = ada({
      userPrincipalName: 'ada@elsewhere.example.com',
      mail: null
    })
    const directory = directoryOf(outsider)

    await expect(add(team, outsider, directory)).rejects.toMatchObject({
      output: { statusCode: 422 },
      data: { code: 'person-not-eligible' }
    })
    expect(directory.getPerson).toHaveBeenCalledWith({
      userAssertion: 'user-token',
      oid: outsider.oid
    })
  })

  test('addMember makes the person’s record in the tenant the token names, and audits the actor with the role used', async () => {
    const team = await teamWithAdmin('svc-tenant')
    const person = ada()
    const otherTenant = randomUUID()
    const actor = { ...team.actor, tid: otherTenant }

    await add({ ...team, actor }, person, directoryOf(person))

    const made = await db
      .collection('users')
      .findOne({ oid: person.oid, tid: otherTenant })
    const event = await db
      .collection('auditEvents')
      .findOne({ resourceId: team.teamId, action: 'team.addMember' })

    expect(made).not.toBeNull()
    expect(event).toMatchObject({
      actorUserId: team.adminId,
      oid: actor.oid,
      tid: otherTenant,
      azp: actor.azp,
      role: 'admin',
      subjectOid: person.oid
    })
  })

  test.each([
    ['a member who is not an admin', 'user', 403, 'admin-required'],
    ['someone outside the team', null, 404, undefined]
  ])(
    'addMember and searchTeamPeople refuse %s before they reach the directory',
    async (_, role, statusCode, code) => {
      const team = await teamWithAdmin(`svc-refuse-${statusCode}`)
      const person = ada()
      const directory = directoryOf(person)
      const userId = new ObjectId().toString()
      const actor = actorFor(userId)

      if (role) {
        await db.collection('teamMembers').insertOne({
          teamId: team.teamId,
          userId,
          role,
          status: 'active'
        })
      }

      const refusal = {
        output: { statusCode },
        ...(code && { data: { code } })
      }

      await expect(
        add({ ...team, actor }, person, directory)
      ).rejects.toMatchObject(refusal)
      await expect(
        peopleService.searchTeamPeople(
          db,
          { teamId: team.teamId, actor, search: 'ada' },
          { directory, allowedDomains: DOMAINS }
        )
      ).rejects.toMatchObject(refusal)
      expect(directory.getPerson).not.toHaveBeenCalled()
      expect(directory.searchPeople).not.toHaveBeenCalled()
    }
  )

  test('addMember replays the same membership for twin requests that arrive together', async () => {
    const team = await teamWithAdmin('svc-twins')
    const person = ada()
    const directory = directoryOf(person)
    const idempotencyKey = randomUUID()

    const members = await Promise.all(
      Array.from({ length: 6 }, () =>
        add(team, person, directory, { idempotencyKey })
      )
    )

    expect(new Set(members.map((member) => member._id.toString())).size).toBe(1)
    expect(await activeMemberships(team)).toBe(2)
  })

  test('addMember cannot confirm a replay whose person’s record has gone, so refuses it as a different request', async () => {
    const team = await teamWithAdmin('svc-gone')
    const person = ada()
    const directory = directoryOf(person)
    const idempotencyKey = randomUUID()

    await add(team, person, directory, { idempotencyKey })
    await db.collection('users').deleteOne({ oid: person.oid })

    await expect(
      add(team, person, directory, { idempotencyKey })
    ).rejects.toMatchObject({ data: { code: 'idempotency-key-reused' } })
  })

  test('addMember does not hide a failure to write the membership', async () => {
    const team = await teamWithAdmin('svc-write-fails')
    const person = ada()
    // A real MongoDB cannot be made to lose its connection on demand, so
    // this one write fails through a wrapper over the db the service is given.
    const failing = dbFailingOn(
      db,
      'teamMembers',
      'insertOne',
      new Error('connection lost')
    )

    await expect(
      peopleService.addMember(
        failing,
        {
          teamId: team.teamId,
          actor: team.actor,
          oid: person.oid,
          role: 'user',
          idempotencyKey: randomUUID(),
          userAssertion: 'user-token'
        },
        { directory: directoryOf(person), allowedDomains: DOMAINS }
      )
    ).rejects.toThrow('connection lost')
    expect(await activeMemberships(team)).toBe(1)
  })

  test('searchTeamPeople shows the user principal name for a person whose mail is blank (thread 3)', async () => {
    const team = await teamWithAdmin('svc-search-blank')
    const person = ada({
      mail: '   ',
      userPrincipalName: 'blank.search@defra.gov.uk'
    })

    const { items } = await peopleService.searchTeamPeople(
      db,
      {
        teamId: team.teamId,
        actor: team.actor,
        search: 'blank',
        userAssertion: 'user-token'
      },
      { directory: directoryOf(person), allowedDomains: DOMAINS }
    )

    expect(items).toEqual([
      {
        oid: person.oid,
        displayName: person.displayName,
        email: 'blank.search@defra.gov.uk'
      }
    ])
  })

  test('searchTeamPeople drops ineligible people and members, sorts by name and takes 20', async () => {
    const team = await teamWithAdmin('svc-search')
    const member = ada({ displayName: 'Aaron Member' })
    await add(team, member, directoryOf(member))
    const crowd = Array.from({ length: 25 }, (_, index) =>
      ada({ displayName: `Zed ${String(25 - index).padStart(2, '0')}` })
    )
    const stranger = ada({
      displayName: 'Mallory',
      userPrincipalName: 'mallory@example.com'
    })
    const directory = directoryOf(member, stranger, ...crowd)

    const { items } = await peopleService.searchTeamPeople(
      db,
      {
        teamId: team.teamId,
        actor: team.actor,
        search: 'zed',
        userAssertion: 'user-token'
      },
      { directory, allowedDomains: DOMAINS }
    )

    expect(directory.searchPeople).toHaveBeenCalledWith({
      userAssertion: 'user-token',
      query: 'zed'
    })
    expect(items).toHaveLength(20)
    expect(items[0].displayName).toBe('Zed 01')
    expect(items.map((item) => item.oid)).not.toContain(member.oid)
    expect(items.map((item) => item.oid)).not.toContain(stranger.oid)
  })

  test('searchTeamPeople finds an addable person on the second Graph page, behind a first page of a member, a guest and an outsider', async () => {
    const team = await teamWithAdmin('svc-search-pages')
    const member = ada({ displayName: 'Page One Member' })
    await add(team, member, directoryOf(member))
    const guest = ada({
      displayName: 'Page One Guest',
      userPrincipalName: 'guest_example.com#EXT#@defra.onmicrosoft.com'
    })
    const outsider = ada({
      displayName: 'Page One Outsider',
      mail: 'outsider@example.com',
      userPrincipalName: 'outsider@example.com'
    })
    const addable = ada({ displayName: 'Page Two Addable' })
    const asGraph = (person) => ({
      id: person.oid,
      displayName: person.displayName,
      mail: person.mail,
      userPrincipalName: person.userPrincipalName
    })
    const graph = 'https://graph.microsoft.com'

    nock('https://login.microsoftonline.com')
      .persist()
      .post(`/${TENANT_ID}/oauth2/v2.0/token`)
      .query(true)
      .reply(200, { access_token: 'graph-token', expires_in: 3600 })
    nock(graph)
      .get('/v1.0/users')
      .query((query) => !query.$skiptoken)
      .reply(200, {
        value: [member, guest, outsider].map(asGraph),
        '@odata.nextLink': `${graph}/v1.0/users?$search=%22x%22&$skiptoken=2`
      })
    nock(graph)
      .get('/v1.0/users')
      .query((query) => query.$skiptoken === '2')
      .reply(200, { value: [asGraph(addable)] })

    const mockedFetch = globalThis.fetch

    globalThis.fetch = realFetch

    try {
      const { items } = await peopleService.searchTeamPeople(
        db,
        {
          teamId: team.teamId,
          actor: team.actor,
          search: 'page',
          userAssertion: 'user-token'
        },
        {
          directory: createGraphDirectory({
            tenantId: TENANT_ID,
            clientId: '11111111-1111-4111-8111-111111111111',
            getClientAssertion: async () => 'client-assertion',
            logger: { warn: vi.fn() }
          }),
          allowedDomains: ['defra.gov.uk', 'defra.onmicrosoft.com']
        }
      )

      expect(items.map((item) => item.oid)).toEqual([addable.oid])
    } finally {
      globalThis.fetch = mockedFetch
      nock.cleanAll()
    }
  })
})

import { randomUUID } from 'node:crypto'

import { Collection } from 'mongodb'

const TENANT_ID = '6f504113-6b64-43f2-ade9-242e05780007'

describe('team-service: adding people from the directory', () => {
  let server
  let db
  let service
  let userService

  beforeAll(async () => {
    // Dynamic imports needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')

    server = await createServer()
    await server.initialize()
    db = server.db
    service = await import('#/services/team-service.js')
    userService = await import('#/services/user-service.js')
  })

  afterAll(async () => {
    await server.stop({ timeout: 0 })
  })

  afterEach(() => {
    vi.restoreAllMocks()
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

  // A team and its Admin, who has signed in, made through the service.
  async function teamWithAdmin(label) {
    const { user } = await userService.upsertUser(db, {
      oid: randomUUID(),
      tid: TENANT_ID,
      email: `${label}@defra.gov.uk`,
      displayName: `Admin ${label}`
    })
    const adminId = user._id.toString()
    const { team } = await service.createTeam(db, {
      name: `Service ${label} ${randomUUID().slice(0, 6)}`,
      serviceCode: 'ABC',
      createdBy: adminId,
      idempotencyKey: randomUUID()
    })

    return { adminId, teamId: team._id.toString() }
  }

  function add(team, person, directory, overrides = {}) {
    return service.addMember(
      db,
      {
        teamId: team.teamId,
        actorUserId: team.adminId,
        oid: person.oid,
        idempotencyKey: randomUUID(),
        userAssertion: 'user-token',
        ...overrides
      },
      { directory, allowedDomains: DOMAINS }
    )
  }

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
    expect(
      await db
        .collection('teamMembers')
        .countDocuments({ teamId: team.teamId, status: 'active' })
    ).toBe(2)
  })

  test('addMember shows no name or email for a replayed member whose record has gone', async () => {
    const team = await teamWithAdmin('svc-gone')
    const person = ada()
    const directory = directoryOf(person)
    const idempotencyKey = randomUUID()
    const first = await add(team, person, directory, { idempotencyKey })

    await db.collection('users').deleteOne({ oid: person.oid })
    const replay = await add(team, person, directory, { idempotencyKey })

    expect(replay._id.toString()).toBe(first._id.toString())
    expect(replay).toMatchObject({ displayName: null, email: null })
  })

  test('addMember does not hide a failure to write the membership', async () => {
    const team = await teamWithAdmin('svc-write-fails')
    const person = ada()

    vi.spyOn(Collection.prototype, 'insertOne').mockRejectedValueOnce(
      new Error('connection lost')
    )

    await expect(add(team, person, directoryOf(person))).rejects.toThrow(
      'connection lost'
    )
  })

  test('addMember refuses as a duplicate when the unique index refuses a person who is not yet seen as a member', async () => {
    const team = await teamWithAdmin('svc-index')
    const person = ada()
    const directory = directoryOf(person)

    await add(team, person, directory)
    // The earlier read finds nobody, as when two adds race; the index decides.
    const findOne = Collection.prototype.findOne

    vi.spyOn(Collection.prototype, 'findOne').mockImplementation(
      async function (filter, ...rest) {
        const isMemberCheck =
          filter?.status === 'active' &&
          filter?.userId &&
          filter.userId !== team.adminId

        return isMemberCheck ? null : findOne.call(this, filter, ...rest)
      }
    )

    await expect(add(team, person, directory)).rejects.toMatchObject({
      output: { statusCode: 409 },
      data: { code: 'member-exists' }
    })
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

    const { items } = await service.searchTeamPeople(
      db,
      {
        teamId: team.teamId,
        actorUserId: team.adminId,
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
})

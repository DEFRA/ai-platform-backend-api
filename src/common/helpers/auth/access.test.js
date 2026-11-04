import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join as joinPath, relative, sep } from 'node:path'

import { ObjectId } from 'mongodb'

import {
  ACCESS,
  PLATFORM_ADMIN_ROLE,
  getActiveTeamIds,
  getTeamRole,
  refuse,
  requirePlatformAdmin,
  requireTeamRole
} from '#/common/helpers/auth/access.js'
import { Boom } from '#/common/helpers/boom-with-code.js'

const TEAM = 'team-1'

function actorOf(overrides = {}) {
  return {
    kind: 'user',
    userId: new ObjectId().toString(),
    oid: 'oid-1',
    tid: 'tid-1',
    azp: 'azp-1',
    uti: 'uti-1',
    isPlatformAdmin: false,
    ...overrides
  }
}

describe('#access', () => {
  let server
  let db

  beforeAll(async () => {
    const { createServer } = await import('#/server.js')

    server = await createServer()
    await server.initialize()
    db = server.db
  })

  afterAll(async () => {
    await server.stop({ timeout: 0 })
  })

  beforeEach(async () => {
    await db.collection('teamMembers').deleteMany({ teamId: /^team-/ })
    await db.collection('auditEvents').deleteMany({ resource: /./ })
  })

  async function join(teamId, userId, role, status = 'active') {
    await db
      .collection('teamMembers')
      .insertOne({ teamId, userId, role, status, email: null })
  }

  async function denials() {
    return db
      .collection('auditEvents')
      .find({ action: 'access.denied' })
      .toArray()
  }

  describe('getTeamRole', () => {
    test('is the role of an active member', async () => {
      const admin = actorOf()
      const member = actorOf()

      await join(TEAM, admin.userId, 'admin')
      await join(TEAM, member.userId, 'user')

      expect(await getTeamRole(db, admin, TEAM)).toBe('admin')
      expect(await getTeamRole(db, member, TEAM)).toBe('user')
    })

    test('is null for someone who is not a member', async () => {
      expect(await getTeamRole(db, actorOf(), TEAM)).toBeNull()
    })

    test.each(['invited', 'removed'])(
      'is null for a member whose status is %s',
      async (status) => {
        const actor = actorOf()

        await join(TEAM, actor.userId, 'admin', status)

        expect(await getTeamRole(db, actor, TEAM)).toBeNull()
      }
    )

    test("is null for someone else's team", async () => {
      const actor = actorOf()

      await join('team-2', actor.userId, 'admin')

      expect(await getTeamRole(db, actor, TEAM)).toBeNull()
    })
  })

  describe('getActiveTeamIds', () => {
    test('lists the teams the actor is an active member of', async () => {
      const actor = actorOf()

      await join('team-a', actor.userId, 'user')
      await join('team-b', actor.userId, 'admin')
      await join('team-c', actor.userId, 'user', 'removed')
      await join('team-d', actorOf().userId, 'admin')

      expect((await getActiveTeamIds(db, actor)).sort()).toEqual([
        'team-a',
        'team-b'
      ])
    })
  })

  describe('requireTeamRole', () => {
    test('lets a member in and says which role they hold', async () => {
      const actor = actorOf()

      await join(TEAM, actor.userId, 'user')

      expect(await requireTeamRole(db, actor, TEAM)).toBe('user')
      expect(await denials()).toEqual([])
    })

    test('lets an admin do an admin action', async () => {
      const actor = actorOf()

      await join(TEAM, actor.userId, 'admin')

      expect(await requireTeamRole(db, actor, TEAM, { role: 'admin' })).toBe(
        'admin'
      )
    })

    test('answers 404 to a non-member, and audits the refusal', async () => {
      const actor = actorOf()

      await expect(requireTeamRole(db, actor, TEAM)).rejects.toMatchObject({
        isBoom: true,
        output: { statusCode: 404 }
      })

      expect(await denials()).toEqual([
        expect.objectContaining({
          actorUserId: actor.userId,
          oid: 'oid-1',
          tid: 'tid-1',
          azp: 'azp-1',
          uti: 'uti-1',
          role: null,
          resource: 'team',
          resourceId: TEAM,
          outcome: 'failure',
          code: 'not-a-member'
        })
      ])
    })

    test('answers 404 to a non-member of an admin action too', async () => {
      await expect(
        requireTeamRole(db, actorOf(), TEAM, { role: 'admin' })
      ).rejects.toMatchObject({ output: { statusCode: 404 } })
    })

    test('answers 403 admin-required to a member, and audits the refusal with the role held', async () => {
      const actor = actorOf()

      await join(TEAM, actor.userId, 'user')

      await expect(
        requireTeamRole(db, actor, TEAM, {
          role: 'admin',
          action: 'add members'
        })
      ).rejects.toMatchObject({
        output: {
          statusCode: 403,
          payload: expect.objectContaining({
            message: 'Only a team admin can add members'
          })
        },
        data: { code: 'admin-required' }
      })

      expect(await denials()).toEqual([
        expect.objectContaining({
          actorUserId: actor.userId,
          role: 'user',
          resourceId: TEAM,
          code: 'admin-required'
        })
      ])
    })

    test('does not let an invited or removed member in', async () => {
      const actor = actorOf()

      await join(TEAM, actor.userId, 'admin', 'invited')

      await expect(
        requireTeamRole(db, actor, TEAM, { role: 'admin' })
      ).rejects.toMatchObject({ output: { statusCode: 404 } })
    })
  })

  describe('requirePlatformAdmin', () => {
    test('lets a Platform Admin through', async () => {
      await expect(
        requirePlatformAdmin(db, actorOf({ isPlatformAdmin: true }))
      ).resolves.toBeUndefined()
      expect(await denials()).toEqual([])
    })

    test('answers 403 platform-admin-required to anyone else, and audits it', async () => {
      const actor = actorOf()

      await expect(
        requirePlatformAdmin(db, actor, {
          resource: 'teamDeployment',
          resourceId: 'deployment-1'
        })
      ).rejects.toMatchObject({
        output: { statusCode: 403 },
        data: { code: 'platform-admin-required' }
      })

      expect(await denials()).toEqual([
        expect.objectContaining({
          actorUserId: actor.userId,
          resource: 'teamDeployment',
          resourceId: 'deployment-1',
          code: 'platform-admin-required',
          outcome: 'failure'
        })
      ])
    })

    test('names the role the same everywhere', () => {
      expect(PLATFORM_ADMIN_ROLE).toBe('platform-admin')
    })
  })

  describe('refuse', () => {
    test('audits a refusal and returns the error to throw', async () => {
      const error = Boom.notFound()
      const actor = actorOf()

      const returned = await refuse(db, actor, {
        resource: 'credential',
        resourceId: new ObjectId(),
        code: 'not-owner',
        error
      })

      expect(returned).toBe(error)
      expect(await denials()).toEqual([
        expect.objectContaining({
          resource: 'credential',
          resourceId: expect.any(String),
          code: 'not-owner'
        })
      ])
    })
  })

  test('declares each kind of access once', () => {
    const values = Object.values(ACCESS)

    expect(new Set(values).size).toBe(values.length)
    expect(Object.isFrozen(ACCESS)).toBe(true)
  })
})

// The one place a person's right is decided is access.js: no other module may
// say who is an admin of a team or a Platform Admin.
describe('#access is the only rights check', () => {
  const SRC = joinPath(import.meta.dirname, '..', '..', '..')

  function sourceFiles(dir) {
    return readdirSync(dir).flatMap((name) => {
      const path = joinPath(dir, name)

      if (statSync(path).isDirectory()) {
        return sourceFiles(path)
      }

      return /\.js$/.test(name) && !/\.test\.js$/.test(name) ? [path] : []
    })
  }

  const modules = sourceFiles(SRC)
    .map((path) => ({
      name: relative(SRC, path).split(sep).join('/'),
      text: readFileSync(path, 'utf8')
    }))
    .filter(
      ({ name }) =>
        name !== 'common/helpers/auth/access.js' &&
        !name.startsWith('common/test-helpers/')
    )

  test.each([
    ['the admin-required refusal', /admin-required/],
    ['the platform-admin-required refusal', /platform-admin-required/],
    ['the old role lookup', /getMemberRole|requireTeamAdmin|actorRole/]
  ])('no other module contains %s', (_name, pattern) => {
    expect(
      modules.filter(({ text }) => pattern.test(text)).map(({ name }) => name)
    ).toEqual([])
  })

  test('no module reads the x-user-id header', () => {
    expect(
      modules
        .filter(({ text }) => /x-user-id/.test(text))
        .map(({ name }) => name)
    ).toEqual([])
  })
})

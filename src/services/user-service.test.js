import { randomUUID } from 'node:crypto'

import { ObjectId } from 'mongodb'

import { dbFailingOn } from '#/common/test-helpers/failing-db.js'

const TENANT_ID = '6f504113-6b64-43f2-ade9-242e05780007'

describe('user-service', () => {
  let server
  let db
  let service

  beforeAll(async () => {
    // Dynamic imports needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')

    server = await createServer()
    await server.initialize()
    db = server.db
    service = await import('#/services/user-service.js')
  })

  afterAll(async () => {
    await server.stop({ timeout: 0 })
  })

  function person(overrides = {}) {
    return {
      oid: randomUUID(),
      tid: TENANT_ID,
      email: 'Directory.Person@Defra.gov.uk',
      displayName: 'Directory Person',
      ...overrides
    }
  }

  describe('#ensurePersonFromDirectory', () => {
    test('makes a record with the sign-in defaults and no lastSignInAt', async () => {
      const params = person()

      const user = await service.ensurePersonFromDirectory(db, params)

      expect(user).toMatchObject({
        oid: params.oid,
        tid: TENANT_ID,
        email: 'directory.person@defra.gov.uk',
        displayName: 'Directory Person',
        roles: ['research-user']
      })
      expect(user.createdAt).toEqual(expect.any(String))
      expect(user.lastSignInAt).toBeUndefined()
    })

    test('returns a record that exists as it is, so the person’s own sign-in owns their name and email', async () => {
      const params = person()
      const first = await service.ensurePersonFromDirectory(db, params)

      const second = await service.ensurePersonFromDirectory(db, {
        ...params,
        email: 'other@defra.gov.uk',
        displayName: 'Another Name'
      })

      expect(second._id.toString()).toBe(first._id.toString())
      expect(second.displayName).toBe('Directory Person')
      expect(second.email).toBe('directory.person@defra.gov.uk')
    })

    test('returns one record for every concurrent add or sign-in of the same person, when the unique index refuses an upsert', async () => {
      const params = person()

      const users = await Promise.all(
        Array.from({ length: 8 }, () =>
          service.ensurePersonFromDirectory(db, params)
        )
      )

      expect(new Set(users.map((user) => user._id.toString())).size).toBe(1)
      expect(
        await db
          .collection('users')
          .countDocuments({ oid: params.oid, tid: TENANT_ID })
      ).toBe(1)
    })

    test('returns the record a concurrent add or sign-in made first when the unique index refuses the upsert', async () => {
      const params = person()
      const made = await service.ensurePersonFromDirectory(db, params)
      // Which request MongoDB refuses with a duplicate key when upserts race
      // is not up to the test, so the refusal comes through a wrapper over the
      // db the service is given; the record it then reads is the real one.
      const refusing = dbFailingOn(
        db,
        'users',
        'findOneAndUpdate',
        Object.assign(new Error('E11000 duplicate key'), { code: 11000 })
      )

      const found = await service.ensurePersonFromDirectory(refusing, params)

      expect(found._id.toString()).toBe(made._id.toString())
    })

    test('does not hide any other failure', async () => {
      // A real MongoDB cannot be made to lose its connection on demand, so
      // this one write fails through a wrapper over the db the service is given.
      const failing = dbFailingOn(
        db,
        'users',
        'findOneAndUpdate',
        new Error('connection lost')
      )

      await expect(
        service.ensurePersonFromDirectory(failing, person())
      ).rejects.toThrow('connection lost')
    })
  })

  describe('#requireUserTenant', () => {
    test('returns the tenant of a person who has signed in', async () => {
      const { insertedId } = await db
        .collection('users')
        .insertOne({ oid: randomUUID(), tid: TENANT_ID })

      await expect(
        service.requireUserTenant(db, insertedId.toString())
      ).resolves.toBe(TENANT_ID)
    })

    test.each([
      ['an id that is not an ObjectId', 'not-an-id'],
      ['a person who does not exist', new ObjectId().toString()]
    ])('asks to sign in again for %s', async (_, userId) => {
      await expect(service.requireUserTenant(db, userId)).rejects.toMatchObject(
        {
          output: { statusCode: 403 },
          data: { code: 'entra-identity-required' }
        }
      )
    })

    test('asks to sign in again for a record with no tenant', async () => {
      const { insertedId } = await db
        .collection('users')
        .insertOne({ email: 'no.tenant@defra.gov.uk' })

      await expect(
        service.requireUserTenant(db, insertedId.toString())
      ).rejects.toMatchObject({ data: { code: 'entra-identity-required' } })
    })
  })
})

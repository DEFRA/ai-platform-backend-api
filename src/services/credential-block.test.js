import { randomUUID } from 'node:crypto'

describe('credential-block', () => {
  let server
  let db
  let block

  beforeAll(async () => {
    // Dynamic imports needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')

    server = await createServer()
    await server.initialize()
    db = server.db
    block = await import('#/services/credential-block.js')
  })

  afterAll(async () => {
    await server.stop({ timeout: 0 })
  })

  const actor = { userId: 'platform-admin-1' }

  async function deploymentDocument(fields = {}) {
    const doc = {
      teamId: `block-team-${randomUUID()}`,
      environment: 'sandbox',
      deployments: [],
      ...fields
    }

    await db.collection('teamDeployments').insertOne(doc)

    return doc
  }

  function stored(doc) {
    return db
      .collection('teamDeployments')
      .findOne({ teamId: doc.teamId, environment: doc.environment })
  }

  describe('isCredentialsBlocked', () => {
    test.each([
      ['a document with no block fields', { teamId: 't' }, false],
      ['a missing document', null, false],
      ['a block that is not true', { adminBlocked: 'yes' }, false],
      ['a document blocked', { adminBlocked: true }, true]
    ])('reads %s', (_name, doc, expected) => {
      expect(block.isCredentialsBlocked(doc)).toBe(expected)
    })
  })

  describe('blockCredentials', () => {
    test('sets the block with when and by whom, and says it changed', async () => {
      const doc = await deploymentDocument()

      const result = await block.blockCredentials(db, { ...doc, actor })

      expect(result).toEqual({ changed: true })
      expect(await stored(doc)).toMatchObject({
        adminBlocked: true,
        adminBlockedBy: actor.userId,
        adminBlockedAt: expect.any(String)
      })
    })

    test('keeps the deployments and every other field of the document', async () => {
      const doc = await deploymentDocument({
        deployments: [{ id: 'entry-1', modelSlug: 'gpt-4o' }],
        gateway: { allowedDeployments: ['gpt-4o'] }
      })

      await block.blockCredentials(db, { ...doc, actor })

      expect(await stored(doc)).toMatchObject({
        deployments: doc.deployments,
        gateway: doc.gateway
      })
    })

    test('set twice is one write: the first time and by whom are kept', async () => {
      const doc = await deploymentDocument()

      await block.blockCredentials(db, { ...doc, actor })

      const first = await stored(doc)
      const again = await block.blockCredentials(db, {
        ...doc,
        actor: { userId: 'platform-admin-2' }
      })

      expect(again).toEqual({ changed: false })
      expect(await stored(doc)).toEqual(first)
    })

    test('changes nothing for a team and environment with no document', async () => {
      const result = await block.blockCredentials(db, {
        teamId: `no-document-${randomUUID()}`,
        environment: 'sandbox',
        actor
      })

      expect(result).toEqual({ changed: false })
    })

    test('blocks one environment and leaves the team’s other environment alone', async () => {
      const doc = await deploymentDocument()
      const other = await deploymentDocument({
        teamId: doc.teamId,
        environment: 'development'
      })

      await block.blockCredentials(db, { ...doc, actor })

      expect(block.isCredentialsBlocked(await stored(other))).toBe(false)
    })
  })

  describe('unblockCredentials', () => {
    test('clears the block and every field of it, and says it changed', async () => {
      const doc = await deploymentDocument()

      await block.blockCredentials(db, { ...doc, actor })

      const result = await block.unblockCredentials(db, doc)
      const after = await stored(doc)

      expect(result).toEqual({ changed: true })
      expect(after).not.toHaveProperty('adminBlocked')
      expect(after).not.toHaveProperty('adminBlockedAt')
      expect(after).not.toHaveProperty('adminBlockedBy')
    })

    test('when there is no block is a no-op that writes nothing', async () => {
      const doc = await deploymentDocument()
      const before = await stored(doc)

      const result = await block.unblockCredentials(db, doc)

      expect(result).toEqual({ changed: false })
      expect(await stored(doc)).toEqual(before)
    })
  })

  describe('isEnvironmentBlocked', () => {
    test('reads the block now held for the team and environment', async () => {
      const doc = await deploymentDocument()

      expect(await block.isEnvironmentBlocked(db, doc)).toBe(false)

      await block.blockCredentials(db, { ...doc, actor })

      expect(await block.isEnvironmentBlocked(db, doc)).toBe(true)
    })

    test('reads a team and environment with no document as not blocked', async () => {
      expect(
        await block.isEnvironmentBlocked(db, {
          teamId: `none-${randomUUID()}`,
          environment: 'sandbox'
        })
      ).toBe(false)
    })
  })

  describe('credentialsBlockLockName', () => {
    test('names one lock for a team and environment', () => {
      expect(block.credentialsBlockLockName('team-1', 'sandbox')).toBe(
        'credentials-block:team-1:sandbox'
      )
    })
  })

  describe('withCredentialsBlockLock', () => {
    test('holds the lock while the work runs and frees it after, even when the work throws', async () => {
      const doc = await deploymentDocument()
      const lockName = block.credentialsBlockLockName(
        doc.teamId,
        doc.environment
      )

      await expect(
        block.withCredentialsBlockLock(server.locker, doc, async () => {
          expect(await server.locker.lock(lockName)).toBeNull()
          throw new Error('work failed')
        })
      ).rejects.toThrow('work failed')

      const free = await server.locker.lock(lockName)

      expect(free).not.toBeNull()

      await free.free()
    })

    test('returns what the work returns', async () => {
      const doc = await deploymentDocument()

      await expect(
        block.withCredentialsBlockLock(server.locker, doc, async () => 42)
      ).resolves.toBe(42)
    })
  })

  describe('credentialStatusOf', () => {
    const active = { status: 'active' }
    const revoked = { status: 'revoked' }

    test.each([
      ['no credential', {}, [], { status: 'none' }],
      ['an active credential', {}, [active], { status: 'active' }],
      [
        'an active one beside a revoked one',
        {},
        [revoked, active],
        { status: 'active' }
      ],
      [
        'only revoked credentials',
        {},
        [revoked, revoked],
        { status: 'revoked' }
      ],
      [
        'an attempt that never finished',
        {},
        [{ status: 'failed' }, { status: 'pending' }],
        { status: 'none' }
      ],
      [
        'a revoked credential beside an attempt that never finished',
        {},
        [revoked, { status: 'failed' }],
        { status: 'revoked' }
      ]
    ])('reads %s', (_name, doc, credentials, expected) => {
      expect(block.credentialStatusOf(doc, credentials)).toEqual(expected)
    })

    test.each([
      ['none', []],
      ['none', [{ status: 'failed' }, { status: 'pending' }]],
      ['active', [{ status: 'active' }]],
      ['active', [revoked, active]],
      ['revoked', [{ status: 'revoked' }]],
      ['revoked', [revoked, { status: 'failed' }]]
    ])(
      'reads a block as disabled and says what is held under it: %s (%j)',
      (held, credentials) => {
        expect(
          block.credentialStatusOf(
            { adminBlocked: true, adminBlockedAt: '2026-11-13T10:00:00.000Z' },
            credentials
          )
        ).toEqual({
          status: 'disabled',
          blockedAt: '2026-11-13T10:00:00.000Z',
          held
        })
      }
    )

    test('gives no held state outside a block, where the status says it', () => {
      expect(block.credentialStatusOf({}, [active])).not.toHaveProperty('held')
    })
  })

  describe('credentialsAccessChanged', () => {
    test.each(['disabled', 'enabled', 'revoked'])(
      'is a no-op for a %s change until the gateway work reads it',
      async (change) => {
        const doc = await deploymentDocument()
        const before = await stored(doc)

        await expect(
          block.credentialsAccessChanged(db, { ...doc, change, actor })
        ).resolves.toBeUndefined()
        expect(await stored(doc)).toEqual(before)
      }
    )
  })
})

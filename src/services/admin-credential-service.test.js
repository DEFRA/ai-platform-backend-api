import { randomUUID } from 'node:crypto'

import { ObjectId } from 'mongodb'

import { actorFor } from '#/common/test-helpers/portal-token.js'

const ENVIRONMENTS = ['cred-dev', 'cred-test']
const DEV = ENVIRONMENTS[0]
const TEST = ENVIRONMENTS[1]
const ADMIN = actorFor('credentials-admin', { isPlatformAdmin: true })
const OTHER = actorFor('credentials-team-admin')
const REASON = 'Suspected leak of a client secret'

describe('#admin-credential-service', () => {
  let server
  let db
  let locker
  let config
  let configured
  let service
  let block

  beforeAll(async () => {
    // Dynamic imports needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')

    ;({ config } = await import('#/config.js'))
    configured = config.get('teamDeployment.environments')
    config.set('teamDeployment.environments', ENVIRONMENTS)
    server = await createServer()
    await server.initialize()
    db = server.db
    locker = server.locker
    service = await import('#/services/admin-credential-service.js')
    block = await import('#/services/credential-block.js')
  })

  afterAll(async () => {
    config.set('teamDeployment.environments', configured)
    await server.stop({ timeout: 0 })
  })

  beforeEach(async () => {
    await Promise.all(
      ['teamDeployments', 'teams', 'credentials'].map((name) =>
        db.collection(name).deleteMany({})
      )
    )
    await db.collection('auditEvents').deleteMany({})
  })

  async function team() {
    const name = `Credential Team ${randomUUID().slice(0, 8)}`
    const { insertedId } = await db.collection('teams').insertOne({
      name,
      normalisedName: name.toLowerCase().replaceAll(' ', '-'),
      slug: name.toLowerCase().replaceAll(' ', '-')
    })
    const teamId = insertedId.toString()

    for (const environment of ENVIRONMENTS) {
      await db
        .collection('teamDeployments')
        .insertOne({ teamId, environment, deployments: [] })
    }

    return teamId
  }

  async function credential(teamId, environment, fields = {}) {
    const record = {
      userId: 'requester',
      teamId,
      environment,
      tier: 'team',
      credentialType: 'oauth',
      status: 'active',
      issuerKey: 'mock',
      keyHint: 'ABCD',
      externalGatewaySubscriptionId: `ext-${randomUUID()}`,
      ...fields
    }
    const { insertedId } = await db.collection('credentials').insertOne(record)

    return { ...record, _id: insertedId }
  }

  function stored(id) {
    return db.collection('credentials').findOne({ _id: id })
  }

  function events(teamId, action) {
    return db
      .collection('auditEvents')
      .find({ teamId, ...(action && { action }) })
      .toArray()
  }

  function deps(fields = {}) {
    const issuer = { revoke: vi.fn().mockResolvedValue(undefined) }

    return {
      issuer,
      registry: { forCredential: vi.fn(() => ({ issuer })) },
      vault: { remove: vi.fn().mockResolvedValue(undefined) },
      accessChanged: vi.fn().mockResolvedValue(undefined),
      logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
      ...fields
    }
  }

  const disable = (teamId, extra = {}, withDeps = deps()) =>
    service.disableCredentials(
      db,
      locker,
      {
        actor: ADMIN,
        teamId,
        environment: DEV,
        reason: REASON,
        idempotencyKey: randomUUID(),
        ...extra
      },
      withDeps
    )

  const enable = (teamId, extra = {}, withDeps = deps()) =>
    service.enableCredentials(
      db,
      locker,
      { actor: ADMIN, teamId, environment: DEV, ...extra },
      withDeps
    )

  const revoke = (teamId, extra = {}, withDeps = deps()) =>
    service.revokeCredentials(
      db,
      locker,
      {
        actor: ADMIN,
        teamId,
        environment: DEV,
        reason: REASON,
        idempotencyKey: randomUUID(),
        ...extra
      },
      withDeps
    )

  function blocked(teamId, environment = DEV) {
    return db
      .collection('teamDeployments')
      .findOne({ teamId, environment })
      .then(block.isCredentialsBlocked)
  }

  describe.each([
    ['disableCredentials', disable],
    ['enableCredentials', enable],
    ['revokeCredentials', revoke]
  ])('%s is refused', (_name, act) => {
    test('for a person who is not a Platform Admin: 403, audited, nothing changed or called', async () => {
      const teamId = await team()
      const record = await credential(teamId, DEV)
      const withDeps = deps()

      await expect(
        act(teamId, { actor: OTHER }, withDeps)
      ).rejects.toMatchObject({
        output: { statusCode: 403 },
        data: { code: 'platform-admin-required' }
      })

      expect(await blocked(teamId)).toBe(false)
      expect((await stored(record._id)).status).toBe('active')
      expect(withDeps.issuer.revoke).not.toHaveBeenCalled()
      expect(withDeps.accessChanged).not.toHaveBeenCalled()
      expect(
        await db
          .collection('auditEvents')
          .find({ resourceId: teamId })
          .toArray()
      ).toEqual([
        expect.objectContaining({
          action: 'access.denied',
          outcome: 'failure',
          resource: 'teamDeployment',
          resourceId: teamId
        })
      ])
    })

    test.each([
      ['a team that does not exist', () => new ObjectId().toString(), DEV],
      ['an id that is not a team id', () => 'not-a-team', DEV],
      ['an environment the team has no document in', null, 'cred-missing'],
      ['an environment the instance does not list', null, 'sandbox']
    ])(
      'for %s: 404 deployment-not-found, no event',
      async (_name, idOf, where) => {
        const teamId = idOf ? idOf() : await team()

        await expect(act(teamId, { environment: where })).rejects.toMatchObject(
          {
            output: { statusCode: 404 },
            data: { code: 'deployment-not-found' }
          }
        )
        expect(await events(teamId)).toEqual([])
      }
    )
  })

  describe('disableCredentials', () => {
    test('blocks the environment ticked, leaves the other and every credential record alone, and answers disabled', async () => {
      const teamId = await team()
      const record = await credential(teamId, DEV)
      const testRecord = await credential(teamId, TEST)
      const before = await stored(record._id)

      const result = await disable(teamId)

      expect(result).toEqual({
        environment: DEV,
        credential: {
          status: 'disabled',
          blockedAt: expect.any(String),
          held: 'active'
        }
      })
      expect(await blocked(teamId, DEV)).toBe(true)
      expect(await blocked(teamId, TEST)).toBe(false)
      expect(await stored(record._id)).toEqual(before)
      expect((await stored(testRecord._id)).status).toBe('active')
    })

    test('writes one admin.credentials.disable event with the actor, role, team, environment and reason, and calls the hook once', async () => {
      const teamId = await team()
      const withDeps = deps()

      await disable(teamId, {}, withDeps)

      expect(await events(teamId)).toEqual([
        expect.objectContaining({
          action: 'admin.credentials.disable',
          outcome: 'success',
          role: 'platform-admin',
          actorUserId: ADMIN.userId,
          resource: 'teamDeployment',
          resourceId: teamId,
          teamId,
          environment: DEV,
          reason: REASON
        })
      ])
      expect(withDeps.accessChanged).toHaveBeenCalledTimes(1)
      expect(withDeps.accessChanged).toHaveBeenCalledWith(db, {
        teamId,
        environment: DEV,
        change: 'disabled',
        actor: ADMIN
      })
    })

    test('records who and when on the block', async () => {
      const teamId = await team()

      await disable(teamId)

      expect(
        await db.collection('teamDeployments').findOne({
          teamId,
          environment: DEV
        })
      ).toMatchObject({
        adminBlocked: true,
        adminBlockedBy: ADMIN.userId,
        adminBlockedAt: expect.any(String)
      })
    })

    test('a repeat with the same key and reason is the same answer, with no second event and no second hook call', async () => {
      const teamId = await team()
      const withDeps = deps()
      const idempotencyKey = randomUUID()

      const first = await disable(teamId, { idempotencyKey }, withDeps)
      const again = await disable(teamId, { idempotencyKey }, withDeps)

      expect(again).toEqual(first)
      expect(await events(teamId, 'admin.credentials.disable')).toHaveLength(1)
      expect(withDeps.accessChanged).toHaveBeenCalledTimes(1)
    })

    test('a new key for an environment already disabled is a no-op: no event, no hook, the first block kept', async () => {
      const teamId = await team()
      const withDeps = deps()

      await disable(teamId, {}, withDeps)

      const first = await db
        .collection('teamDeployments')
        .findOne({ teamId, environment: DEV })
      const again = await disable(
        teamId,
        { reason: 'Another reason' },
        withDeps
      )

      expect(again.credential.status).toBe('disabled')
      expect(await events(teamId, 'admin.credentials.disable')).toHaveLength(1)
      expect(withDeps.accessChanged).toHaveBeenCalledTimes(1)
      expect(
        await db
          .collection('teamDeployments')
          .findOne({ teamId, environment: DEV })
      ).toEqual(first)
    })

    test('a key reused with another reason is refused 409 idempotency-key-reused and changes nothing', async () => {
      const teamId = await team()
      const idempotencyKey = randomUUID()

      await disable(teamId, { idempotencyKey })

      await expect(
        disable(teamId, { idempotencyKey, reason: 'A different reason' })
      ).rejects.toMatchObject({
        output: { statusCode: 409 },
        data: { code: 'idempotency-key-reused' }
      })
      expect(await events(teamId, 'admin.credentials.disable')).toHaveLength(1)
    })

    test('a key used for the other environment is a new request', async () => {
      const teamId = await team()
      const idempotencyKey = randomUUID()

      await disable(teamId, { idempotencyKey })
      await disable(teamId, { idempotencyKey, environment: TEST })

      expect(await blocked(teamId, TEST)).toBe(true)
      expect(await events(teamId, 'admin.credentials.disable')).toHaveLength(2)
    })

    test('two requests at once make one block, one event and one hook call', async () => {
      const teamId = await team()
      const withDeps = deps()

      await Promise.all([
        disable(teamId, {}, withDeps),
        disable(teamId, {}, withDeps)
      ])

      expect(await events(teamId, 'admin.credentials.disable')).toHaveLength(1)
      expect(withDeps.accessChanged).toHaveBeenCalledTimes(1)
    })

    test('works while the credential is revoked or missing', async () => {
      const teamId = await team()

      await credential(teamId, DEV, { status: 'revoked' })

      expect((await disable(teamId)).credential.status).toBe('disabled')
    })

    test('keeps the reason out of every log line', async () => {
      const teamId = await team()
      const withDeps = deps()

      await disable(teamId, {}, withDeps)

      expect(
        JSON.stringify(
          Object.values(withDeps.logger).map((fn) => fn.mock.calls)
        )
      ).not.toContain(REASON)
    })
  })

  describe('enableCredentials', () => {
    test('clears the block, writes one admin.credentials.enable event with no reason, calls the hook, and shows the credential’s own status', async () => {
      const teamId = await team()
      const withDeps = deps()

      await credential(teamId, DEV)
      await disable(teamId)

      const result = await enable(teamId, {}, withDeps)

      expect(result).toEqual({
        environment: DEV,
        credential: { status: 'active' }
      })
      expect(await blocked(teamId)).toBe(false)
      expect(await events(teamId, 'admin.credentials.enable')).toEqual([
        expect.objectContaining({
          outcome: 'success',
          role: 'platform-admin',
          actorUserId: ADMIN.userId,
          resourceId: teamId,
          teamId,
          environment: DEV,
          reason: null
        })
      ])
      expect(withDeps.accessChanged).toHaveBeenCalledWith(db, {
        teamId,
        environment: DEV,
        change: 'enabled',
        actor: ADMIN
      })
    })

    test('a revoked credential stays revoked', async () => {
      const teamId = await team()
      const record = await credential(teamId, DEV, { status: 'revoked' })

      await disable(teamId)

      const result = await enable(teamId)

      expect(result.credential).toEqual({ status: 'revoked' })
      expect((await stored(record._id)).status).toBe('revoked')
    })

    test('an environment that is not disabled is a no-op: no event, no hook', async () => {
      const teamId = await team()
      const withDeps = deps()

      const result = await enable(teamId, {}, withDeps)

      expect(result).toEqual({
        environment: DEV,
        credential: { status: 'none' }
      })
      expect(await events(teamId)).toEqual([])
      expect(withDeps.accessChanged).not.toHaveBeenCalled()
    })

    test('enabling twice writes one event', async () => {
      const teamId = await team()

      await disable(teamId)
      await enable(teamId)
      await enable(teamId)

      expect(await events(teamId, 'admin.credentials.enable')).toHaveLength(1)
    })

    test('enables one environment and leaves the other disabled', async () => {
      const teamId = await team()

      await disable(teamId)
      await disable(teamId, { environment: TEST })
      await enable(teamId)

      expect(await blocked(teamId, DEV)).toBe(false)
      expect(await blocked(teamId, TEST)).toBe(true)
    })
  })

  describe('revokeCredentials', () => {
    test('revokes the environment’s active credential through the built path and writes one admin.credentials.revoke event with the reason', async () => {
      const teamId = await team()
      const record = await credential(teamId, DEV)
      const withDeps = deps()

      const result = await revoke(teamId, {}, withDeps)

      expect(result).toEqual({ environment: DEV, revoked: 1 })
      expect(withDeps.issuer.revoke).toHaveBeenCalledWith({
        externalId: record.externalGatewaySubscriptionId,
        environment: DEV
      })
      expect(withDeps.vault.remove).toHaveBeenCalledTimes(1)
      expect(await stored(record._id)).toMatchObject({
        status: 'revoked',
        revokedReason: 'admin-revoked',
        revokedAt: expect.any(String)
      })
      expect(await events(teamId)).toEqual([
        expect.objectContaining({
          action: 'admin.credentials.revoke',
          outcome: 'success',
          role: 'platform-admin',
          actorUserId: ADMIN.userId,
          resource: 'teamDeployment',
          resourceId: teamId,
          teamId,
          environment: DEV,
          reason: REASON
        })
      ])
      expect(withDeps.accessChanged).toHaveBeenCalledTimes(1)
      expect(withDeps.accessChanged).toHaveBeenCalledWith(db, {
        teamId,
        environment: DEV,
        change: 'revoked',
        actor: ADMIN
      })
    })

    test('with two records (a second one an Admin added) revokes both and writes one event', async () => {
      const teamId = await team()
      const first = await credential(teamId, DEV)
      const second = await credential(teamId, DEV, { origin: 'admin-added' })

      const result = await revoke(teamId)

      expect(result.revoked).toBe(2)
      expect((await stored(first._id)).status).toBe('revoked')
      expect((await stored(second._id)).status).toBe('revoked')
      expect(await events(teamId, 'admin.credentials.revoke')).toHaveLength(1)
      expect(await events(teamId, 'credential.revoke')).toEqual([])
    })

    test('in a disabled environment revokes the credential and the credential then reads disabled with revoked held beneath (P1-AC10)', async () => {
      const teamId = await team()
      const record = await credential(teamId, DEV)

      await disable(teamId)

      const result = await revoke(teamId)
      const after = await disable(teamId)

      expect(result).toEqual({ environment: DEV, revoked: 1 })
      expect((await stored(record._id)).status).toBe('revoked')
      expect(after.credential).toEqual({
        status: 'disabled',
        blockedAt: expect.any(String),
        held: 'revoked'
      })
    })

    test('in a disabled environment holding no active credential revokes nothing and says nothing was held (P1-AC11)', async () => {
      const teamId = await team()
      const withDeps = deps()

      await disable(teamId)

      const result = await revoke(teamId, {}, withDeps)
      const after = await disable(teamId)

      expect(result).toEqual({ environment: DEV, revoked: 0 })
      expect(after.credential.held).toBe('none')
      expect(await events(teamId, 'admin.credentials.revoke')).toEqual([])
      expect(withDeps.accessChanged).not.toHaveBeenCalledWith(
        db,
        expect.objectContaining({ change: 'revoked' })
      )
    })

    test('with no record is a no-op: no event, no hook', async () => {
      const teamId = await team()
      const withDeps = deps()

      const result = await revoke(teamId, {}, withDeps)

      expect(result).toEqual({ environment: DEV, revoked: 0 })
      expect(await events(teamId)).toEqual([])
      expect(withDeps.accessChanged).not.toHaveBeenCalled()
    })

    test('leaves a revoked record, another environment’s record, a research key and an unfinished attempt alone', async () => {
      const teamId = await team()
      const revokedRecord = await credential(teamId, DEV, { status: 'revoked' })
      const otherEnvironment = await credential(teamId, TEST)
      const research = await credential(teamId, DEV, { tier: 'research' })
      const failed = await credential(teamId, DEV, { status: 'failed' })
      const withDeps = deps()

      const result = await revoke(teamId, {}, withDeps)

      expect(result.revoked).toBe(0)
      expect(withDeps.issuer.revoke).not.toHaveBeenCalled()
      expect((await stored(revokedRecord._id)).status).toBe('revoked')
      expect((await stored(otherEnvironment._id)).status).toBe('active')
      expect((await stored(research._id)).status).toBe('active')
      expect((await stored(failed._id)).status).toBe('failed')
    })

    test('a repeat with the same key is a no-op with no second event', async () => {
      const teamId = await team()
      const idempotencyKey = randomUUID()
      const withDeps = deps()

      await credential(teamId, DEV)
      await revoke(teamId, { idempotencyKey }, withDeps)

      const again = await revoke(teamId, { idempotencyKey }, withDeps)

      expect(again).toEqual({ environment: DEV, revoked: 0 })
      expect(await events(teamId, 'admin.credentials.revoke')).toHaveLength(1)
      expect(withDeps.accessChanged).toHaveBeenCalledTimes(1)
    })

    test('a repeat with a new key finds nothing left to revoke: no event, no hook', async () => {
      const teamId = await team()
      const withDeps = deps()

      await credential(teamId, DEV)
      await revoke(teamId, {}, withDeps)
      await revoke(teamId, {}, withDeps)

      expect(await events(teamId, 'admin.credentials.revoke')).toHaveLength(1)
      expect(withDeps.accessChanged).toHaveBeenCalledTimes(1)
    })

    test('a key reused with another reason is refused 409 idempotency-key-reused', async () => {
      const teamId = await team()
      const idempotencyKey = randomUUID()
      const record = await credential(teamId, DEV)

      await revoke(teamId, { idempotencyKey })

      await credential(teamId, DEV)

      await expect(
        revoke(teamId, { idempotencyKey, reason: 'A different reason' })
      ).rejects.toMatchObject({
        output: { statusCode: 409 },
        data: { code: 'idempotency-key-reused' }
      })
      expect((await stored(record._id)).status).toBe('revoked')
    })

    test('works while the environment is disabled, and the block stays', async () => {
      const teamId = await team()
      const record = await credential(teamId, DEV)

      await disable(teamId)
      await revoke(teamId)

      expect((await stored(record._id)).status).toBe('revoked')
      expect(await blocked(teamId)).toBe(true)
    })

    test('leaves a record that was revoked while the request waited, and revokes the rest', async () => {
      const teamId = await team()
      const first = await credential(teamId, DEV)
      const second = await credential(teamId, DEV, { origin: 'admin-added' })
      const issuer = {
        revoke: vi.fn(async () => {
          await db
            .collection('credentials')
            .updateOne({ _id: second._id }, { $set: { status: 'revoked' } })
        })
      }

      const result = await revoke(
        teamId,
        {},
        deps({ issuer, registry: { forCredential: () => ({ issuer }) } })
      )

      expect(result.revoked).toBe(1)
      expect(issuer.revoke).toHaveBeenCalledTimes(1)
      expect((await stored(first._id)).status).toBe('revoked')
    })

    test('a vault failure is tolerated as the built revoke tolerates it', async () => {
      const teamId = await team()
      const record = await credential(teamId, DEV)
      const withDeps = deps({
        vault: { remove: vi.fn().mockRejectedValue(new Error('vault down')) }
      })

      const result = await revoke(teamId, {}, withDeps)

      expect(result.revoked).toBe(1)
      expect((await stored(record._id)).status).toBe('revoked')
    })

    describe('when the issuer fails', () => {
      async function failingSecond() {
        const teamId = await team()
        const first = await credential(teamId, DEV)
        const second = await credential(teamId, DEV, { origin: 'admin-added' })
        const issuer = {
          revoke: vi
            .fn()
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error(`gateway said ${'SECRET-DETAIL'}`))
            .mockResolvedValue(undefined)
        }
        const withDeps = deps({
          issuer,
          registry: { forCredential: vi.fn(() => ({ issuer })) }
        })

        return { teamId, first, second, withDeps }
      }

      test('answers 502 upstream-unavailable, leaves the failed record active and writes a failure event naming the environment', async () => {
        const { teamId, first, second, withDeps } = await failingSecond()

        await expect(revoke(teamId, {}, withDeps)).rejects.toMatchObject({
          output: { statusCode: 502 },
          data: { code: 'upstream-unavailable' }
        })

        expect((await stored(first._id)).status).toBe('revoked')
        expect((await stored(second._id)).status).toBe('active')
        expect(await events(teamId)).toEqual([
          expect.objectContaining({
            action: 'admin.credentials.revoke',
            outcome: 'failure',
            code: 'upstream-unavailable',
            role: 'platform-admin',
            teamId,
            environment: DEV
          })
        ])
        expect(withDeps.accessChanged).not.toHaveBeenCalled()
      })

      test('a repeat with the same key completes the rest and writes the success event once', async () => {
        const { teamId, second, withDeps } = await failingSecond()
        const idempotencyKey = randomUUID()

        await revoke(teamId, { idempotencyKey }, withDeps).catch(() => {})

        const result = await revoke(teamId, { idempotencyKey }, withDeps)

        expect(result).toEqual({ environment: DEV, revoked: 1 })
        expect((await stored(second._id)).status).toBe('revoked')
        expect(await events(teamId, 'admin.credentials.revoke')).toHaveLength(2)
        expect(
          await events(teamId).then((all) =>
            all.map(({ outcome }) => outcome).sort()
          )
        ).toEqual(['failure', 'success'])
        expect(withDeps.accessChanged).toHaveBeenCalledTimes(1)
      })

      test('keeps the reason, the gateway’s message and any secret out of the logs and the error', async () => {
        const { teamId, withDeps } = await failingSecond()

        const error = await revoke(teamId, {}, withDeps).catch(
          (caught) => caught
        )
        const logged = JSON.stringify(
          Object.values(withDeps.logger).map((fn) => fn.mock.calls)
        )

        for (const text of [REASON, 'SECRET-DETAIL', 'ABCD']) {
          expect(logged).not.toContain(text)
          expect(JSON.stringify(error.output.payload)).not.toContain(text)
          expect(error.message).not.toContain(text)
        }
      })

      test('logs a warning with the code, team and environment only', async () => {
        const { teamId, withDeps } = await failingSecond()

        await revoke(teamId, {}, withDeps).catch(() => {})

        expect(withDeps.logger.warn).toHaveBeenCalledWith(
          { code: 'upstream-unavailable', teamId, environment: DEV },
          expect.any(String)
        )
      })
    })

    test('two requests at once revoke a record once', async () => {
      const teamId = await team()
      const withDeps = deps()

      await credential(teamId, DEV)

      await Promise.all([
        revoke(teamId, {}, withDeps),
        revoke(teamId, {}, withDeps)
      ])

      expect(withDeps.issuer.revoke).toHaveBeenCalledTimes(1)
      expect(await events(teamId, 'admin.credentials.revoke')).toHaveLength(1)
    })
  })
})

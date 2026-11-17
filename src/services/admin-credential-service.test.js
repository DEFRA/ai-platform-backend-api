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

  function blocked(teamId, environment = DEV) {
    return db
      .collection('teamDeployments')
      .findOne({ teamId, environment })
      .then(block.isCredentialsBlocked)
  }

  describe.each([
    ['disableCredentials', disable],
    ['enableCredentials', enable]
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

  describe('revokeCredential (one secret)', () => {
    const revokeOne = (teamId, credentialId, extra = {}, withDeps = deps()) =>
      service.revokeCredential(
        db,
        locker,
        {
          actor: ADMIN,
          teamId,
          environment: DEV,
          credentialId: credentialId.toString(),
          reason: REASON,
          idempotencyKey: randomUUID(),
          ...extra
        },
        withDeps
      )

    test('revokes only the secret named, through the built path, and writes one admin.credential.revoke event for it with the reason', async () => {
      const teamId = await team()
      const target = await credential(teamId, DEV)
      const other = await credential(teamId, DEV, { origin: 'admin-added' })
      const withDeps = deps()

      const result = await revokeOne(teamId, target._id, {}, withDeps)

      expect(result).toEqual({
        environment: DEV,
        credentialId: target._id.toString(),
        revoked: true
      })
      expect(withDeps.issuer.revoke).toHaveBeenCalledTimes(1)
      expect(withDeps.issuer.revoke).toHaveBeenCalledWith({
        externalId: target.externalGatewaySubscriptionId,
        environment: DEV
      })
      expect(await stored(target._id)).toMatchObject({
        status: 'revoked',
        revokedReason: 'admin-revoked'
      })
      expect((await stored(other._id)).status).toBe('active')
      expect(await events(teamId)).toEqual([
        expect.objectContaining({
          action: 'admin.credential.revoke',
          outcome: 'success',
          role: 'platform-admin',
          actorUserId: ADMIN.userId,
          resource: 'credential',
          resourceId: target._id.toString(),
          teamId,
          environment: DEV,
          reason: REASON
        })
      ])
      expect(withDeps.accessChanged).toHaveBeenCalledWith(db, {
        teamId,
        environment: DEV,
        change: 'revoked',
        actor: ADMIN
      })
    })

    test('works while the environment is disabled, and the block stays', async () => {
      const teamId = await team()
      const target = await credential(teamId, DEV)

      await disable(teamId)
      await revokeOne(teamId, target._id)

      expect((await stored(target._id)).status).toBe('revoked')
      expect(await blocked(teamId)).toBe(true)
    })

    test('a secret already revoked is left alone: revoked false, no event, no hook', async () => {
      const teamId = await team()
      const target = await credential(teamId, DEV, { status: 'revoked' })
      const withDeps = deps()

      const result = await revokeOne(teamId, target._id, {}, withDeps)

      expect(result.revoked).toBe(false)
      expect(withDeps.issuer.revoke).not.toHaveBeenCalled()
      expect(withDeps.accessChanged).not.toHaveBeenCalled()
      expect(await events(teamId)).toEqual([])
    })

    test('a repeat with the same key and reason writes no second event, and the same key for another secret is a new request', async () => {
      const teamId = await team()
      const first = await credential(teamId, DEV)
      const second = await credential(teamId, DEV, { origin: 'admin-added' })
      const withDeps = deps()
      const idempotencyKey = randomUUID()

      await revokeOne(teamId, first._id, { idempotencyKey }, withDeps)
      await revokeOne(teamId, first._id, { idempotencyKey }, withDeps)
      await revokeOne(teamId, second._id, { idempotencyKey }, withDeps)

      expect(await events(teamId, 'admin.credential.revoke')).toHaveLength(2)
      expect(withDeps.issuer.revoke).toHaveBeenCalledTimes(2)
    })

    test('a key reused with another reason for the same secret is refused 409 idempotency-key-reused', async () => {
      const teamId = await team()
      const target = await credential(teamId, DEV)
      const idempotencyKey = randomUUID()

      await revokeOne(teamId, target._id, { idempotencyKey })

      await expect(
        revokeOne(teamId, target._id, { idempotencyKey, reason: 'Another' })
      ).rejects.toMatchObject({
        output: { statusCode: 409 },
        data: { code: 'idempotency-key-reused' }
      })
    })

    test.each([
      ['an id that is not an id', () => 'not-an-id'],
      ['an id no credential has', () => new ObjectId().toString()]
    ])('for %s: 404 credential-not-found, no event', async (_name, idOf) => {
      const teamId = await team()

      await expect(revokeOne(teamId, idOf())).rejects.toMatchObject({
        output: { statusCode: 404 },
        data: { code: 'credential-not-found' }
      })
      expect(await events(teamId)).toEqual([])
    })

    test('a secret of another team or environment, or a research key, is not found and is left alone', async () => {
      const teamId = await team()
      const otherTeam = await team()
      const elsewhere = await credential(teamId, TEST)
      const theirs = await credential(otherTeam, DEV)
      const research = await credential(teamId, DEV, { tier: 'research' })

      for (const record of [elsewhere, theirs, research]) {
        await expect(revokeOne(teamId, record._id)).rejects.toMatchObject({
          data: { code: 'credential-not-found' }
        })
        expect((await stored(record._id)).status).toBe('active')
      }
    })

    test('for a person who is not a Platform Admin: 403, audited, nothing revoked', async () => {
      const teamId = await team()
      const target = await credential(teamId, DEV)
      const withDeps = deps()

      await expect(
        revokeOne(teamId, target._id, { actor: OTHER }, withDeps)
      ).rejects.toMatchObject({
        output: { statusCode: 403 },
        data: { code: 'platform-admin-required' }
      })
      expect((await stored(target._id)).status).toBe('active')
      expect(withDeps.issuer.revoke).not.toHaveBeenCalled()
    })

    test('when the issuer fails: 502 upstream-unavailable, the secret stays active, a failure event names it, and no reason or gateway message is logged', async () => {
      const teamId = await team()
      const target = await credential(teamId, DEV)
      const issuer = {
        revoke: vi
          .fn()
          .mockRejectedValue(new Error('gateway said SECRET-DETAIL'))
      }
      const withDeps = deps({
        issuer,
        registry: { forCredential: vi.fn(() => ({ issuer })) }
      })

      const error = await revokeOne(teamId, target._id, {}, withDeps).catch(
        (caught) => caught
      )
      const logged = JSON.stringify(
        Object.values(withDeps.logger).map((fn) => fn.mock.calls)
      )

      expect(error).toMatchObject({
        output: { statusCode: 502 },
        data: { code: 'upstream-unavailable' }
      })
      expect((await stored(target._id)).status).toBe('active')
      expect(await events(teamId)).toEqual([
        expect.objectContaining({
          action: 'admin.credential.revoke',
          outcome: 'failure',
          code: 'upstream-unavailable',
          resource: 'credential',
          resourceId: target._id.toString(),
          environment: DEV
        })
      ])
      expect(withDeps.accessChanged).not.toHaveBeenCalled()

      for (const text of [REASON, 'SECRET-DETAIL', 'ABCD']) {
        expect(logged).not.toContain(text)
        expect(JSON.stringify(error.output.payload)).not.toContain(text)
      }
    })
  })
})

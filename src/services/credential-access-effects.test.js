import { randomUUID } from 'node:crypto'

import { createMockAccessWindowStore } from '#/adapters/mock-access-window-store.js'
import { createMockServicePrincipalSwitch } from '#/adapters/mock-service-principal-switch.js'
import { actorFor } from '#/common/test-helpers/portal-token.js'

const ENVIRONMENTS = ['eff-dev', 'eff-test']
const DEV = ENVIRONMENTS[0]
const TEST = ENVIRONMENTS[1]
const ADMIN = actorFor('effects-admin', { isPlatformAdmin: true })
const REASON = 'Suspected leak of a client secret'
const CLIENT_ID = '11111111-2222-4333-8444-555555555555'
const OTHER_CLIENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const SP_ID = '99999999-8888-4777-8666-555555555555'
const REGISTRATION = {
  clientId: CLIENT_ID,
  objectId: 'application-object-id',
  servicePrincipalObjectId: SP_ID
}
const ORDINARY = {
  clientId: CLIENT_ID,
  status: 'active',
  validFrom: '2020-01-01T00:00:00Z',
  expiresAt: 'untilRevoked'
}
const OTHER_ENTRY = { ...ORDINARY, clientId: OTHER_CLIENT_ID }
const UPSTREAM_DETAIL = 'SECRET-DETAIL the gateway refused the write'

// What Disable and Enable credentials do at the gateway and in Entra (B31,
// R-D1 to R-D3): the order, each failure point, a retry, and the time Graph
// confirmed the service principal disabled.
describe('#credential-access-effects through the admin credential service', () => {
  let server
  let db
  let locker
  let config
  let configured
  let service
  let effects
  let deployments

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
    effects = await import('#/services/credential-access-effects.js')
    deployments = await import('#/services/admin-deployment-service.js')
  })

  afterAll(async () => {
    config.set('teamDeployment.environments', configured)
    await server.stop({ timeout: 0 })
  })

  beforeEach(async () => {
    await Promise.all(
      ['teamDeployments', 'teams', 'credentials', 'pendingAudits'].map((name) =>
        db.collection(name).deleteMany({})
      )
    )
    await db.collection('auditEvents').deleteMany({})
  })

  async function team({ registration = REGISTRATION } = {}) {
    const slug = `eff-${randomUUID().slice(0, 8)}`
    const { insertedId } = await db
      .collection('teams')
      .insertOne({ name: slug, normalisedName: slug, slug })
    const teamId = insertedId.toString()

    for (const environment of ENVIRONMENTS) {
      await db.collection('teamDeployments').insertOne({
        teamId,
        environment,
        deployments: [],
        oauthClient: { enabled: true, appRoles: [], registration }
      })
    }

    return { teamId, slug }
  }

  async function deploymentOf(teamId, environment = DEV) {
    return db.collection('teamDeployments').findOne({ teamId, environment })
  }

  async function flagged(teamId, environment = DEV) {
    return (await deploymentOf(teamId, environment)).adminBlocked === true
  }

  function events(teamId, action) {
    return db.collection('auditEvents').find({ teamId, action }).toArray()
  }

  // The mock store and switch, with every call logged beside whether the block
  // was set when it was made, and a way to make the next call fail.
  function rig(teamId, { ordinary = null, connection } = {}) {
    const store = createMockAccessWindowStore()
    const principal = createMockServicePrincipalSwitch()
    const log = []
    const state = { ordinary }
    const failNext = { window: false, principal: false }
    const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() }

    function refuseOnce(step) {
      if (failNext[step]) {
        failNext[step] = false

        throw new Error(UPSTREAM_DETAIL)
      }
    }

    const watchedStore = {
      read: (params) => store.read(params),
      async write(params) {
        refuseOnce('window')
        await store.write(params)
        log.push({
          step: 'window',
          statuses: params.entries.map(({ status }) => status),
          flagged: await flagged(teamId, params.environment)
        })
      }
    }
    const watchedPrincipal = {
      async setAccountEnabled(params) {
        refuseOnce('principal')

        const done = await principal.setAccountEnabled(params)

        log.push({
          step: 'service-principal',
          enabled: params.enabled,
          flagged: await flagged(teamId, params.environment)
        })

        return done
      }
    }
    const accessChanged = (database, change) =>
      effects.credentialsAccessChanged(database, change, {
        store: watchedStore,
        servicePrincipal: watchedPrincipal,
        ordinaryEntry: async () => state.ordinary,
        ...(connection && { connection })
      })

    return {
      store,
      principal,
      log,
      failNext,
      logger,
      useOrdinary(entry) {
        state.ordinary = entry
      },
      deps: { accessChanged, logger }
    }
  }

  const disable = (teamId, { deps, ...extra } = {}) =>
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
      deps
    )

  const enable = (teamId, { deps, ...extra } = {}) =>
    service.enableCredentials(
      db,
      locker,
      { actor: ADMIN, teamId, environment: DEV, ...extra },
      deps
    )

  const bad = {
    output: { statusCode: 502 },
    data: { code: 'upstream-unavailable' }
  }

  describe('Disable credentials', () => {
    test('sets the flag, then writes the window suspended, then switches the service principal off, and keeps when Graph confirmed it', async () => {
      const { teamId, slug } = await team()
      const r = rig(teamId)
      const before = Date.now()

      const result = await disable(teamId, { deps: r.deps })

      expect(result.credential.status).toBe('disabled')
      expect(r.log).toEqual([
        { step: 'window', statuses: ['suspended'], flagged: true },
        { step: 'service-principal', enabled: false, flagged: true }
      ])
      expect(await r.store.read({ environment: DEV, teamSlug: slug })).toEqual([
        {
          clientId: CLIENT_ID,
          status: 'suspended',
          validFrom: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:]+Z$/),
          expiresAt: 'untilRevoked'
        }
      ])
      expect(r.principal.enabledState(DEV, SP_ID)).toBe(false)

      const confirmed = Date.parse(
        (await deploymentOf(teamId)).servicePrincipalDisabledAt
      )

      expect(confirmed).toBeGreaterThanOrEqual(before)
      expect(confirmed).toBeLessThanOrEqual(Date.now())
      expect(await events(teamId, 'admin.credentials.disable')).toEqual([
        expect.objectContaining({ outcome: 'success', reason: REASON })
      ])
    })

    test('the confirmation time is read back on the admin deployment read, and is null for a team never disabled', async () => {
      const disabled = await team()
      const never = await team()

      await disable(disabled.teamId, { deps: rig(disabled.teamId).deps })

      const read = (teamId) =>
        deployments.getTeamDeployment(db, {
          actor: ADMIN,
          teamId,
          environment: DEV
        })

      expect((await read(disabled.teamId)).servicePrincipalDisabledAt).toBe(
        (await deploymentOf(disabled.teamId)).servicePrincipalDisabledAt
      )
      expect((await read(never.teamId)).servicePrincipalDisabledAt).toBeNull()
    })

    test('keeps the other clients in the window and the other environment’s window untouched', async () => {
      const { teamId, slug } = await team()
      const r = rig(teamId)

      await r.store.write({
        environment: DEV,
        teamSlug: slug,
        entries: [OTHER_ENTRY]
      })

      await disable(teamId, { deps: r.deps })

      expect(await r.store.read({ environment: DEV, teamSlug: slug })).toEqual([
        OTHER_ENTRY,
        expect.objectContaining({ clientId: CLIENT_ID, status: 'suspended' })
      ])
      expect(await r.store.read({ environment: TEST, teamSlug: slug })).toEqual(
        []
      )
      expect(r.principal.enabledState(TEST, SP_ID)).toBeUndefined()
    })

    test('suspends the ordinary entry in place, keeping its times, when the ordinary window has one', async () => {
      const { teamId, slug } = await team()
      const r = rig(teamId, {
        ordinary: { ...ORDINARY, expiresAt: '2030-01-01T00:00:00Z' }
      })

      await disable(teamId, { deps: r.deps })

      expect(await r.store.read({ environment: DEV, teamSlug: slug })).toEqual([
        {
          ...ORDINARY,
          status: 'suspended',
          expiresAt: '2030-01-01T00:00:00Z'
        }
      ])
    })

    test('fails at the window: the block stays, nothing reaches Entra, the failure is audited and the answer is 502', async () => {
      const { teamId } = await team()
      const r = rig(teamId)

      r.failNext.window = true

      const error = await disable(teamId, { deps: r.deps }).catch((e) => e)

      expect(error).toMatchObject(bad)
      expect(await flagged(teamId)).toBe(true)
      expect(r.log).toEqual([])
      expect(r.principal.enabledState(DEV, SP_ID)).toBeUndefined()
      expect(await deploymentOf(teamId)).not.toHaveProperty(
        'servicePrincipalDisabledAt'
      )
      expect(await events(teamId, 'admin.credentials.disable')).toEqual([
        expect.objectContaining({
          outcome: 'failure',
          code: 'upstream-unavailable',
          actorUserId: ADMIN.userId,
          environment: DEV
        })
      ])
      expect(
        await db
          .collection('auditEvents')
          .countDocuments({ outcome: 'success' })
      ).toBe(0)

      const shown = JSON.stringify([
        error.output.payload,
        r.logger.warn.mock.calls
      ])

      expect(shown).not.toContain('SECRET-DETAIL')
      expect(shown).not.toContain(REASON)
    })

    test('fails at the window, then a retry with the same key finishes the change, records the success once and writes the window and the switch once each', async () => {
      const { teamId, slug } = await team()
      const r = rig(teamId)
      const idempotencyKey = randomUUID()

      r.failNext.window = true

      await expect(
        disable(teamId, { deps: r.deps, idempotencyKey })
      ).rejects.toMatchObject(bad)

      const retried = await disable(teamId, { deps: r.deps, idempotencyKey })

      expect(retried.credential.status).toBe('disabled')
      expect(r.log).toEqual([
        { step: 'window', statuses: ['suspended'], flagged: true },
        { step: 'service-principal', enabled: false, flagged: true }
      ])
      expect(
        (await r.store.read({ environment: DEV, teamSlug: slug }))[0].status
      ).toBe('suspended')
      expect(
        (await events(teamId, 'admin.credentials.disable')).map(
          ({ outcome }) => outcome
        )
      ).toEqual(expect.arrayContaining(['failure', 'success']))
      expect(await events(teamId, 'admin.credentials.disable')).toHaveLength(2)
      expect(await db.collection('pendingAudits').countDocuments()).toBe(0)
      expect(await deploymentOf(teamId)).not.toHaveProperty('pendingAuditId')
    })

    test('fails at the service principal: the window is suspended, the block stays, no time is kept, and the answer is 502', async () => {
      const { teamId, slug } = await team()
      const r = rig(teamId)

      r.failNext.principal = true

      await expect(disable(teamId, { deps: r.deps })).rejects.toMatchObject(bad)

      expect(await flagged(teamId)).toBe(true)
      expect(
        (await r.store.read({ environment: DEV, teamSlug: slug }))[0].status
      ).toBe('suspended')
      expect(r.principal.enabledState(DEV, SP_ID)).toBeUndefined()
      expect(await deploymentOf(teamId)).not.toHaveProperty(
        'servicePrincipalDisabledAt'
      )
      expect(await events(teamId, 'admin.credentials.disable')).toEqual([
        expect.objectContaining({
          outcome: 'failure',
          code: 'upstream-unavailable'
        })
      ])
    })

    test('fails at the service principal, then a retry keeps the same window entry and switches the principal off', async () => {
      const { teamId, slug } = await team()
      const r = rig(teamId)
      const idempotencyKey = randomUUID()

      r.failNext.principal = true

      await expect(
        disable(teamId, { deps: r.deps, idempotencyKey })
      ).rejects.toMatchObject(bad)

      const [first] = await r.store.read({ environment: DEV, teamSlug: slug })

      await disable(teamId, { deps: r.deps, idempotencyKey })

      expect(await r.store.read({ environment: DEV, teamSlug: slug })).toEqual([
        first
      ])
      expect(r.principal.enabledState(DEV, SP_ID)).toBe(false)
      expect((await deploymentOf(teamId)).servicePrincipalDisabledAt).toEqual(
        expect.any(String)
      )
      expect(
        (await events(teamId, 'admin.credentials.disable')).filter(
          ({ outcome }) => outcome === 'success'
        )
      ).toHaveLength(1)
    })

    test('a request with another key after a failure finishes the first request’s change before its own', async () => {
      const { teamId } = await team()
      const r = rig(teamId)

      r.failNext.window = true

      await expect(disable(teamId, { deps: r.deps })).rejects.toMatchObject(bad)

      await disable(teamId, { deps: r.deps, reason: 'Another reason' })

      expect(r.principal.enabledState(DEV, SP_ID)).toBe(false)
      expect(
        (await events(teamId, 'admin.credentials.disable')).filter(
          ({ outcome }) => outcome === 'success'
        )
      ).toEqual([expect.objectContaining({ reason: REASON })])
    })

    test('disabling an environment already disabled touches neither the window nor the principal again', async () => {
      const { teamId } = await team()
      const r = rig(teamId)

      await disable(teamId, { deps: r.deps })
      await disable(teamId, { deps: r.deps })

      expect(r.log).toHaveLength(2)
    })

    test('a registration with no service principal object ID has its window written and no switch made', async () => {
      const { teamId, slug } = await team({
        registration: { ...REGISTRATION, servicePrincipalObjectId: null }
      })
      const r = rig(teamId)

      const result = await disable(teamId, { deps: r.deps })

      expect(result.credential.status).toBe('disabled')
      expect(r.log.map(({ step }) => step)).toEqual(['window'])
      expect(
        (await r.store.read({ environment: DEV, teamSlug: slug }))[0].status
      ).toBe('suspended')
      expect(await deploymentOf(teamId)).not.toHaveProperty(
        'servicePrincipalDisabledAt'
      )
    })

    test('a team with no registration yet takes its client ID from the connection details, and no switch is made', async () => {
      const { teamId, slug } = await team({ registration: null })
      const r = rig(teamId, {
        connection: async () => ({ clientId: OTHER_CLIENT_ID })
      })

      await disable(teamId, { deps: r.deps })

      expect(await r.store.read({ environment: DEV, teamSlug: slug })).toEqual([
        expect.objectContaining({
          clientId: OTHER_CLIENT_ID,
          status: 'suspended'
        })
      ])
      expect(r.log.map(({ step }) => step)).toEqual(['window'])
    })

    test('a team with no registration and no connection details has nothing to block: no write, no switch, still disabled', async () => {
      const { teamId, slug } = await team({ registration: null })
      const r = rig(teamId, { connection: async () => null })

      const result = await disable(teamId, { deps: r.deps })

      expect(result.credential.status).toBe('disabled')
      expect(r.log).toEqual([])
      expect(await r.store.read({ environment: DEV, teamSlug: slug })).toEqual(
        []
      )
    })

    test('a registration whose client ID cannot be found fails closed: 502, block kept, nothing written', async () => {
      const { teamId } = await team({
        registration: { ...REGISTRATION, clientId: null }
      })
      const r = rig(teamId, { connection: async () => null })

      await expect(disable(teamId, { deps: r.deps })).rejects.toMatchObject(bad)

      expect(await flagged(teamId)).toBe(true)
      expect(r.log).toEqual([])
    })
  })

  describe('Enable credentials', () => {
    async function disabledTeam(options) {
      const made = await team(options)
      const r = rig(made.teamId, options)

      await disable(made.teamId, { deps: r.deps })
      r.log.length = 0

      return { ...made, r }
    }

    test('switches the principal on, then restores the ordinary window, then clears the flag last', async () => {
      const { teamId, slug, r } = await disabledTeam()

      r.useOrdinary(ORDINARY)

      await enable(teamId, { deps: r.deps })

      expect(r.log).toEqual([
        { step: 'service-principal', enabled: true, flagged: true },
        { step: 'window', statuses: ['active'], flagged: true }
      ])
      expect(await flagged(teamId)).toBe(false)
      expect(r.principal.enabledState(DEV, SP_ID)).toBe(true)
      expect(await r.store.read({ environment: DEV, teamSlug: slug })).toEqual([
        ORDINARY
      ])
      expect(await events(teamId, 'admin.credentials.enable')).toEqual([
        expect.objectContaining({ outcome: 'success' })
      ])
    })

    test('while the ordinary window is none, the suspended entry is removed, the principal is left off, and the flag is cleared', async () => {
      const { teamId, slug } = await team()
      const r = rig(teamId)

      await disable(teamId, { deps: r.deps })
      r.log.length = 0

      const result = await enable(teamId, { deps: r.deps })

      expect(result.credential.status).not.toBe('disabled')
      expect(await flagged(teamId)).toBe(false)
      expect(await r.store.read({ environment: DEV, teamSlug: slug })).toEqual(
        []
      )
      expect(r.log).toEqual([{ step: 'window', statuses: [], flagged: true }])
      expect(r.principal.enabledState(DEV, SP_ID)).toBe(false)
    })

    test('restores only what the ordinary window allows: a suspended ordinary entry stays suspended and the principal stays off', async () => {
      const { teamId, slug } = await team()
      const suspended = { ...ORDINARY, status: 'suspended' }
      const r = rig(teamId, { ordinary: suspended })

      await disable(teamId, { deps: r.deps })
      await enable(teamId, { deps: r.deps })

      expect(await r.store.read({ environment: DEV, teamSlug: slug })).toEqual([
        suspended
      ])
      expect(r.principal.enabledState(DEV, SP_ID)).toBe(false)
      expect(await flagged(teamId)).toBe(false)
    })

    test('an ordinary entry that has expired does not switch the principal on', async () => {
      const { teamId } = await team()
      const expired = { ...ORDINARY, expiresAt: '2020-06-01T00:00:00Z' }
      const r = rig(teamId, { ordinary: expired })

      await disable(teamId, { deps: r.deps })
      await enable(teamId, { deps: r.deps })

      expect(r.principal.enabledState(DEV, SP_ID)).toBe(false)
    })

    test('fails at the service principal: the block and the suspended window stay, the failure is audited, and the answer is 502', async () => {
      const { teamId, slug, r } = await disabledTeam()

      r.useOrdinary(ORDINARY)
      r.failNext.principal = true

      await expect(enable(teamId, { deps: r.deps })).rejects.toMatchObject(bad)

      expect(await flagged(teamId)).toBe(true)
      expect(r.log).toEqual([])
      expect(
        (await r.store.read({ environment: DEV, teamSlug: slug }))[0].status
      ).toBe('suspended')
      expect(await events(teamId, 'admin.credentials.enable')).toEqual([
        expect.objectContaining({
          outcome: 'failure',
          code: 'upstream-unavailable',
          actorUserId: ADMIN.userId
        })
      ])
    })

    test('fails at the window: the principal is on, the block stays, and a retry finishes it with one success event', async () => {
      const { teamId, slug, r } = await disabledTeam()

      r.useOrdinary(ORDINARY)
      r.failNext.window = true

      await expect(enable(teamId, { deps: r.deps })).rejects.toMatchObject(bad)

      expect(await flagged(teamId)).toBe(true)
      expect(r.principal.enabledState(DEV, SP_ID)).toBe(true)
      expect(
        (await r.store.read({ environment: DEV, teamSlug: slug }))[0].status
      ).toBe('suspended')

      await enable(teamId, { deps: r.deps })

      expect(await flagged(teamId)).toBe(false)
      expect(await r.store.read({ environment: DEV, teamSlug: slug })).toEqual([
        ORDINARY
      ])
      expect(
        (await events(teamId, 'admin.credentials.enable')).map(
          ({ outcome }) => outcome
        )
      ).toEqual(expect.arrayContaining(['failure', 'success']))
      expect(await events(teamId, 'admin.credentials.enable')).toHaveLength(2)
    })

    test('an environment that is not disabled changes nothing at the gateway or in Entra', async () => {
      const { teamId } = await team()
      const r = rig(teamId, { ordinary: ORDINARY })

      await enable(teamId, { deps: r.deps })

      expect(r.log).toEqual([])
      expect(await events(teamId, 'admin.credentials.enable')).toEqual([])
    })
  })

  describe('a window write API Management has not finished within the wait', () => {
    const ARM = 'https://management.azure.com'
    const OPERATION = '/operations/slow-1'
    const realFetch = globalThis.fetch
    const WAIT_MS = 50
    let slowDeps
    let nock
    let fetchBefore

    beforeAll(async () => {
      fetchBefore = globalThis.fetch
      globalThis.fetch = realFetch
      nock = (await import('nock')).default

      const { createArmClient } = await import('#/adapters/azure/arm-client.js')
      const { createApimAccessWindowStore } =
        await import('#/adapters/azure/apim-access-window-store.js')
      const store = createApimAccessWindowStore({
        armClient: createArmClient({
          getCredential: () => ({ getToken: async () => ({ token: 't' }) }),
          defaultPollMs: 0
        }),
        resolveEnvironment: () => ({
          subscriptionId: 'sub',
          resourceGroup: 'rg',
          apimName: 'apim'
        }),
        writeWaitMs: WAIT_MS
      })
      const principal = createMockServicePrincipalSwitch()
      const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() }

      slowDeps = {
        accessChanged: (database, change) =>
          effects.credentialsAccessChanged(database, change, {
            store,
            servicePrincipal: principal
          }),
        logger
      }
    })

    afterAll(() => {
      globalThis.fetch = fetchBefore
    })

    afterEach(() => {
      nock.cleanAll()
    })

    // The named value starts as none; its write is accepted, and the operation
    // reports `status` until it is changed.
    function gateway(status) {
      nock.cleanAll()
      nock(ARM)
        .persist()
        .get(/\/namedValues\//)
        .reply(200, { properties: { value: 'none' } })
      nock(ARM)
        .persist()
        .patch(/\/namedValues\//)
        .reply(202, '', { 'azure-asyncoperation': `${ARM}${OPERATION}` })
      nock(ARM).persist().get(OPERATION).reply(200, { status })
    }

    test('Disable answers 502 within the wait and keeps the block; a retry with the same key finishes it and records the success once', async () => {
      const { teamId } = await team()
      const idempotencyKey = randomUUID()

      gateway('InProgress')

      const started = Date.now()

      await expect(
        disable(teamId, { deps: slowDeps, idempotencyKey })
      ).rejects.toMatchObject(bad)
      expect(Date.now() - started).toBeLessThan(3000)
      expect(await flagged(teamId)).toBe(true)
      expect(await deploymentOf(teamId)).not.toHaveProperty(
        'servicePrincipalDisabledAt'
      )

      gateway('Succeeded')

      const retried = await disable(teamId, { deps: slowDeps, idempotencyKey })

      expect(retried.credential.status).toBe('disabled')
      expect(await deploymentOf(teamId)).toHaveProperty(
        'servicePrincipalDisabledAt'
      )
      expect(
        (await events(teamId, 'admin.credentials.disable')).map(
          ({ outcome }) => outcome
        )
      ).toEqual(expect.arrayContaining(['failure', 'success']))
      expect(await events(teamId, 'admin.credentials.disable')).toHaveLength(2)
    })

    test('Enable answers 502 within the wait and leaves the block set; a retry clears it and records the success once', async () => {
      const { teamId } = await team()
      const r = rig(teamId)

      await disable(teamId, { deps: r.deps })
      gateway('InProgress')

      await expect(enable(teamId, { deps: slowDeps })).rejects.toMatchObject(
        bad
      )
      expect(await flagged(teamId)).toBe(true)

      gateway('Succeeded')

      const retried = await enable(teamId, { deps: slowDeps })

      expect(retried.credential.status).not.toBe('disabled')
      expect(await flagged(teamId)).toBe(false)
      expect(
        (await events(teamId, 'admin.credentials.enable')).map(
          ({ outcome }) => outcome
        )
      ).toEqual(expect.arrayContaining(['failure', 'success']))
      expect(await events(teamId, 'admin.credentials.enable')).toHaveLength(2)
    })
  })

  describe('credentialsAccessChanged', () => {
    test('a revoke of one secret changes neither the window nor the service principal', async () => {
      const { teamId } = await team()
      const r = rig(teamId)

      await r.deps.accessChanged(db, {
        teamId,
        environment: DEV,
        change: 'revoked',
        actor: ADMIN
      })

      expect(r.log).toEqual([])
    })
  })
})

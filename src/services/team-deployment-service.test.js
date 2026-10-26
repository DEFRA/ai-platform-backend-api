import { randomUUID } from 'node:crypto'

import { ObjectId } from 'mongodb'

import { createInMemoryCommandPublisher } from '#/adapters/in-memory-command-publisher.js'
import { mockTeamFileReader } from '#/adapters/mock-team-file-reader.js'
import { validateCommand } from '#/contracts/message-validators.js'
import { Boom, boomWithCode } from '#/common/helpers/boom-with-code.js'
import { exampleEvent } from '#/common/test-helpers/gitops-messages.js'

const SANDBOX = 'sandbox'
const VALID_TRACEPARENT =
  '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
const SUBMIT_RUN = 25000000001
const RETRY_RUN = 25000000011
const SUBMIT_WORKFLOW = '.github/workflows/submit.yml'
const APPLY_WORKFLOW = '.github/workflows/apply.yml'

describe('team-deployment-service (operations)', () => {
  let server
  let db
  let service
  let removal
  let runtime
  let publisher
  let verifier
  let ensureCredential
  let fileOnMain
  let buildDesiredState
  let teamOfRun
  let operationOfRun
  let deps
  let realBuild
  let rebuildRuntime

  beforeAll(async () => {
    // Dynamic imports needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')
    const { createOperationsRuntime } =
      await import('#/operations/operations-runtime.js')
    const { gitopsSettings } = await import('#/operations/gitops-settings.js')
    const { createDocumentBuilder } =
      await import('#/services/team-deployment-submission.js')
    const { createTeamDesiredStateBuilder } =
      await import('#/services/team-desired-state.js')
    const { createCredentialGranter } =
      await import('#/services/team-credential-grant.js')
    const { invalidateModelsCache } =
      await import('#/services/models-service.js')

    server = await createServer()
    await server.initialize()
    db = server.db
    service = await import('#/services/team-deployment-service.js')
    removal = await import('#/services/team-deployment-removal.js')

    const gpt4o = await db
      .collection('models')
      .findOne({ slug: 'gpt-4o' }, { projection: { _id: 0 } })

    await db.collection('models').insertMany(
      ['svc-b', 'svc-c'].map((slug) => ({
        ...gpt4o,
        slug,
        displayName: slug
      }))
    )
    invalidateModelsCache()

    // The file `main` holds: none unless a test says so.
    const reader = {
      getCurrentDocument: vi.fn(async () => ({ document: fileOnMain })),
      getPreviousDocument: mockTeamFileReader.getPreviousDocument
    }
    const realBuilder = createTeamDesiredStateBuilder({ registry: { reader } })

    realBuild = realBuilder
    buildDesiredState = vi.fn((...args) => realBuilder(...args))
    verifier = { verify: vi.fn() }
    ensureCredential = vi.fn()

    // The runtime the server runs, over an in-memory queue and a run reader
    // that tells the corroborator what the events say.
    rebuildRuntime = () => {
      const logger = { warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

      publisher = createInMemoryCommandPublisher()
      runtime = createOperationsRuntime({
        db,
        locker: server.locker,
        logger,
        settings: gitopsSettings({ environments: [SANDBOX] }),
        publisher,
        reader,
        runReader: {
          getRun: async ({ runId }) => ({
            headBranch: 'main',
            path: runId === SUBMIT_RUN ? SUBMIT_WORKFLOW : APPLY_WORKFLOW,
            name: `submit (${operationOfRun})`,
            status: 'completed',
            conclusion: 'failure',
            runStartedAt: '2026-10-26T12:00:00Z'
          }),
          getRunReport: async () => ({
            outcome: 'failure',
            failingTeams: [teamOfRun]
          }),
          getActorPermission: async () => 'admin',
          isOnMain: async () => true
        },
        verifier,
        buildDocument: createDocumentBuilder(db, {
          buildDesiredState: (...args) => buildDesiredState(...args)
        }),
        grantCredentials: createCredentialGranter({
          db,
          locker: server.locker,
          logger,
          ensureCredential,
          retryAfterMs: 0
        })
      })
      deps = { operations: runtime.operations }
    }
  })

  afterAll(async () => {
    await server.stop({ timeout: 0 })
  })

  beforeEach(() => {
    fileOnMain = null
    buildDesiredState.mockClear()
    verifier.verify.mockResolvedValue({ verified: true })
    ensureCredential.mockResolvedValue({ created: true })
    rebuildRuntime()
  })

  afterEach(async () => {
    await db.collection('environmentControls').deleteMany({})
  })

  async function joinTeam(userId, { role = 'admin', slug } = {}) {
    const teamObjectId = new ObjectId()
    const teamId = teamObjectId.toString()
    const team = {
      _id: teamObjectId,
      name: `Team ${teamId}`,
      normalisedName: `team-${teamId}`,
      serviceCode: 'ABC',
      slug: slug === undefined ? `team-${teamId.slice(-8)}` : slug
    }

    if (!team.slug) {
      delete team.slug
    }

    await db.collection('teams').insertOne(team)
    await db
      .collection('teamMembers')
      .insertOne({ teamId, userId, role, status: 'active' })

    return { teamId, slug: team.slug }
  }

  // A team member who signed in with an Entra object ID, which a deployment
  // request is attributed to; `fields` overrides the user record.
  async function signedInMember(fields = {}, teamOptions) {
    const oid = randomUUID()
    const { insertedId } = await db.collection('users').insertOne({
      oid,
      tid: '6f504113-6b64-43f2-ade9-242e05780007',
      email: `ops-${oid}@defra.gov.uk`,
      displayName: 'Operations User',
      roles: ['research-user'],
      ...fields
    })
    const userId = insertedId.toString()
    const { teamId, slug } = await joinTeam(userId, teamOptions)

    teamOfRun = slug

    return { userId, teamId, slug, principal: `entra:${oid}` }
  }

  function requestModels(
    { teamId, userId, ...params },
    modelSlugs = ['gpt-4o'],
    extra = deps
  ) {
    return service.requestDeployments(
      db,
      server.locker,
      {
        teamId,
        modelSlugs,
        environment: SANDBOX,
        requestedBy: userId,
        idempotencyKey: randomUUID(),
        ...params
      },
      extra
    )
  }

  async function requestOne(member, modelSlug = 'gpt-4o', params, extra) {
    const [deployment] = await requestModels(
      { ...member, ...params },
      [modelSlug],
      extra
    )

    return deployment
  }

  function operationsOf(teamId) {
    return db
      .collection('operations')
      .find({ teamId })
      .sort({ _id: 1 })
      .toArray()
  }

  async function operationOf(teamId) {
    const [operation] = await operationsOf(teamId)

    return operation
  }

  async function storedEntry(teamId, id) {
    const doc = await db.collection('teamDeployments').findOne({ teamId })

    return doc?.deployments.find((entry) => entry.id === id)
  }

  async function view(member, id) {
    return service.getDeployment(db, {
      id,
      teamId: member.teamId,
      userId: member.userId
    })
  }

  function eventFor(operation, status, overrides = {}) {
    operationOfRun = operation._id
    teamOfRun = operation.target.team

    return exampleEvent(status, {
      operationId: operation._id,
      environment: operation.environment,
      team: operation.target.team,
      path: operation.target.path,
      repository: operation.target.repository,
      requestedBy: operation.requestedBy,
      ...(status === 'deploy-failed'
        ? { failingTeams: [operation.target.team] }
        : {}),
      ...overrides
    })
  }

  async function deliver(operation, ...statuses) {
    for (const status of statuses) {
      await runtime.handler.handle(eventFor(operation, status))
    }
  }

  // A deployment that has gone all the way to active.
  async function activeDeployment(member, modelSlug = 'gpt-4o') {
    const deployment = await requestOne(member, modelSlug)
    const operation = await operationOf(member.teamId)

    await deliver(operation, 'requested', 'committed', 'deploying', 'deployed')

    return { deployment, operation }
  }

  function commandsOf(operationId, type) {
    return publisher.published.filter(
      (command) =>
        command.operationId === operationId &&
        (type === undefined || command.type === type)
    )
  }

  async function auditOf(id) {
    return db
      .collection('auditEvents')
      .find({ resourceId: id })
      .sort({ at: 1 })
      .toArray()
  }

  describe('requestDeployments', () => {
    test('fails with desired-state-unavailable and records nothing when the team has no file to build', async () => {
      const member = await signedInMember({}, { slug: '' })

      await expect(requestOne(member)).rejects.toMatchObject({
        output: { statusCode: 501 },
        data: { code: 'desired-state-unavailable' }
      })

      expect(
        await db
          .collection('teamDeployments')
          .findOne({ teamId: member.teamId })
      ).toBeNull()
      expect(await operationsOf(member.teamId)).toEqual([])
    })

    test('records one operation for the whole file, built now, with its submit command in the outbox', async () => {
      const member = await signedInMember()
      const key = randomUUID()
      const deployment = await requestOne(member, 'gpt-4o', {
        idempotencyKey: key,
        traceParent: VALID_TRACEPARENT,
        cdpRequestId: 'cdp-request-1'
      })
      const operation = await operationOf(member.teamId)
      const document = JSON.parse(operation.document)

      expect(deployment).toMatchObject({
        status: 'requested',
        operationId: operation._id,
        operation: {
          id: operation._id,
          state: 'requested',
          attempt: 1,
          runUrl: null,
          commitSha: null,
          failureReason: null
        },
        links: {}
      })
      expect(operation).toMatchObject({
        type: 'team-file.write',
        state: 'requested',
        slot: 'active',
        environment: SANDBOX,
        target: {
          repository: 'DEFRA/ai-platform-tenants',
          team: member.slug,
          path: `environments/${SANDBOX}/${member.slug}.json`
        },
        items: [
          { entryId: deployment._id, modelSlug: 'gpt-4o', change: 'add' }
        ],
        requestedBy: member.principal,
        requestedByUserId: member.userId,
        idempotencyKeys: [key],
        traceparent: VALID_TRACEPARENT,
        cdpRequestId: 'cdp-request-1',
        expectedRevision: 0
      })
      expect(document).toMatchObject({
        revision: 1,
        operationId: operation._id,
        updatedBy: member.principal,
        team: { slug: member.slug, serviceCode: 'ABC' }
      })
      expect(document.deployments.map(({ slug }) => slug)).toEqual(['gpt-4o'])
      expect(document.gateway.allowedDeployments).toEqual(['gpt-4o'])

      // Published within the request, the entry marked as published.
      const [command] = commandsOf(operation._id)

      expect(commandsOf(operation._id)).toHaveLength(1)
      expect(validateCommand(command).valid).toBe(true)
      expect(command).toMatchObject({
        type: 'submit',
        action: 'write',
        expectedRevision: 0,
        requestedBy: member.principal,
        traceparent: VALID_TRACEPARENT,
        cdpRequestId: 'cdp-request-1'
      })
      expect(operation.outbox).toEqual([
        expect.objectContaining({
          commandId: command.commandId,
          type: 'submit',
          publishedAt: expect.any(String)
        })
      ])
      expect(operation.outboxPending).toBe(false)
      expect(await auditOf(deployment._id)).toEqual([
        expect.objectContaining({
          action: 'teamDeployment.request',
          actorUserId: member.userId,
          outcome: 'success'
        })
      ])
    })

    test('builds the document from the revision main holds, as the next revision', async () => {
      const member = await signedInMember()

      fileOnMain = {
        schemaVersion: 1,
        revision: 4,
        environment: SANDBOX,
        status: 'active',
        deployments: [
          {
            slug: 'svc-b',
            sku: 'DataZoneStandard',
            capacity: 1,
            status: 'active'
          }
        ],
        gateway: {
          credentialType: 'oauth',
          allowedDeployments: ['svc-b'],
          limits: { tokensPerMinute: 1000, requestsPerMinute: 60 }
        },
        oauth: { federations: [], externalClients: [], secretsAllowed: true }
      }
      await requestOne(member)

      const operation = await operationOf(member.teamId)
      const document = JSON.parse(operation.document)

      expect(operation.expectedRevision).toBe(4)
      expect(commandsOf(operation._id)[0].expectedRevision).toBe(4)
      expect(document.revision).toBe(5)
      expect(document.deployments.map(({ slug }) => slug)).toEqual([
        'svc-b',
        'gpt-4o'
      ])
    })

    test('drops a traceparent and a request ID the command contract would refuse', async () => {
      const member = await signedInMember()

      await requestOne(member, 'gpt-4o', {
        traceParent: 'not-a-traceparent',
        cdpRequestId: 'not a request id!'
      })

      const operation = await operationOf(member.teamId)

      expect(operation).toMatchObject({ traceparent: null, cdpRequestId: null })
      expect(validateCommand(commandsOf(operation._id)[0]).valid).toBe(true)
    })

    test('refuses a document too large to submit, removes the entry and queues nothing', async () => {
      const member = await signedInMember()

      buildDesiredState.mockImplementationOnce(
        async function (database, params) {
          const built = await realBuild(database, params)

          return {
            ...built,
            document: { ...built.document, padding: 'x'.repeat(70 * 1024) }
          }
        }
      )

      await expect(requestOne(member)).rejects.toMatchObject({
        output: { statusCode: 422 },
        data: { code: 'desired-state-too-large' }
      })

      const doc = await db
        .collection('teamDeployments')
        .findOne({ teamId: member.teamId })

      expect(doc.deployments).toEqual([])
      expect(await operationsOf(member.teamId)).toEqual([])
      expect(publisher.published).toEqual([])
    })

    test('refuses as upstream-unavailable, with nothing left behind, when the file cannot be read', async () => {
      const member = await signedInMember()

      buildDesiredState.mockRejectedValueOnce(new Error('GitHub is down'))

      await expect(requestOne(member)).rejects.toMatchObject({
        output: { statusCode: 502 },
        data: { code: 'upstream-unavailable' }
      })

      const doc = await db
        .collection('teamDeployments')
        .findOne({ teamId: member.teamId })

      expect(doc.deployments).toEqual([])
      expect(await operationsOf(member.teamId)).toEqual([])
      expect(
        await db.collection('auditEvents').findOne({
          action: 'teamDeployment.request',
          outcome: 'failure',
          actorUserId: member.userId
        })
      ).toMatchObject({ code: 'upstream-unavailable' })
    })

    test('queues nothing for a policy refusal: no operation, no outbox entry, no entry', async () => {
      const member = await signedInMember()

      buildDesiredState.mockRejectedValueOnce(
        boomWithCode(
          Boom.badRequest,
          'Model is not eligible for this environment',
          'model-not-eligible'
        )
      )

      await expect(
        requestModels(member, ['gpt-4o', 'svc-b'])
      ).rejects.toMatchObject({ data: { code: 'model-not-eligible' } })

      const doc = await db
        .collection('teamDeployments')
        .findOne({ teamId: member.teamId })

      expect(doc.deployments).toEqual([])
      expect(await operationsOf(member.teamId)).toEqual([])
      expect(publisher.published).toEqual([])
    })

    test('is one operation, one commit and one command for three models', async () => {
      const member = await signedInMember()
      const views = await requestModels(member, ['gpt-4o', 'svc-b', 'svc-c'])
      const operations = await operationsOf(member.teamId)
      const [operation] = operations
      const document = JSON.parse(operation.document)

      expect(operations).toHaveLength(1)
      expect(operation.items.map(({ modelSlug }) => modelSlug)).toEqual([
        'gpt-4o',
        'svc-b',
        'svc-c'
      ])
      expect(views.map(({ modelSlug }) => modelSlug)).toEqual([
        'gpt-4o',
        'svc-b',
        'svc-c'
      ])
      expect(new Set(views.map(({ operationId }) => operationId))).toEqual(
        new Set([operation._id])
      )
      expect(views.every(({ status }) => status === 'requested')).toBe(true)
      expect(document.deployments.map(({ slug }) => slug)).toEqual([
        'gpt-4o',
        'svc-b',
        'svc-c'
      ])
      expect(commandsOf(operation._id)).toHaveLength(1)
    })

    test('moves all three models together to active', async () => {
      const member = await signedInMember()
      const views = await requestModels(member, ['gpt-4o', 'svc-b', 'svc-c'])
      const operation = await operationOf(member.teamId)

      await deliver(
        operation,
        'requested',
        'committed',
        'deploying',
        'deployed'
      )

      for (const { _id } of views) {
        expect(await view(member, _id)).toMatchObject({
          status: 'active',
          operation: { id: operation._id, state: 'active' }
        })
      }

      expect(ensureCredential).toHaveBeenCalledTimes(1)
    })

    test('drops a repeated model from one request', async () => {
      const member = await signedInMember()
      const views = await requestModels(member, ['gpt-4o', 'gpt-4o'])
      const operation = await operationOf(member.teamId)

      expect(views).toHaveLength(1)
      expect(operation.items).toHaveLength(1)
    })

    test('refuses a member with no Entra object ID, before recording or submitting anything', async () => {
      const member = await signedInMember({ oid: undefined })

      await expect(requestOne(member)).rejects.toMatchObject({
        output: { statusCode: 403 },
        data: { code: 'entra-identity-required' }
      })
      expect(
        await db
          .collection('teamDeployments')
          .findOne({ teamId: member.teamId })
      ).toBeNull()
      expect(await operationsOf(member.teamId)).toEqual([])
    })

    test('refuses a non-member and a team that does not exist as not found', async () => {
      const member = await signedInMember()
      const stranger = await signedInMember()

      await expect(
        requestOne({ ...member, userId: stranger.userId })
      ).rejects.toMatchObject({ output: { statusCode: 404 } })
      await expect(
        requestOne({ ...member, teamId: new ObjectId().toString() })
      ).rejects.toMatchObject({ output: { statusCode: 404 } })
    })

    test('refuses an environment this instance does not deploy to', async () => {
      const member = await signedInMember()

      await expect(
        requestOne(member, 'gpt-4o', { environment: 'infradev' })
      ).rejects.toMatchObject({ data: { code: 'environment-not-available' } })
    })

    test('refuses a model that is not eligible, naming every offender, before anything is written', async () => {
      const member = await signedInMember()

      await expect(
        requestModels(member, ['gpt-4o', 'no-such-model'])
      ).rejects.toMatchObject({
        data: { code: 'model-not-eligible', modelSlugs: ['no-such-model'] }
      })
      expect(await operationsOf(member.teamId)).toEqual([])
    })

    describe('idempotency', () => {
      test('returns the same entries for a replayed key, with no second operation or command', async () => {
        const member = await signedInMember()
        const key = randomUUID()
        const [first] = await requestModels({ ...member, idempotencyKey: key })
        const [replay] = await requestModels({ ...member, idempotencyKey: key })
        const operations = await operationsOf(member.teamId)

        expect(replay._id).toBe(first._id)
        expect(operations).toHaveLength(1)
        expect(commandsOf(operations[0]._id)).toHaveLength(1)
        expect(
          (
            await db
              .collection('teamDeployments')
              .findOne({ teamId: member.teamId })
          ).deployments
        ).toHaveLength(1)
      })

      test('finishes a request a crashed attempt did not get to, under the same entry', async () => {
        const member = await signedInMember()
        const key = randomUUID()
        const id = new ObjectId().toString()

        await db.collection('teamDeployments').insertOne({
          teamId: member.teamId,
          environment: SANDBOX,
          gateway: {
            credentialType: 'oauth',
            allowedDeployments: [],
            limits: {}
          },
          deployments: [
            {
              id,
              modelSlug: 'gpt-4o',
              status: 'queued',
              statusTimes: {},
              operationId: null,
              requestedBy: member.userId,
              idempotencyKey: key,
              createdAt: new Date().toISOString(),
              activatedAt: null,
              failureReason: null
            }
          ]
        })

        const [finished] = await requestModels({
          ...member,
          idempotencyKey: key
        })
        const operation = await operationOf(member.teamId)

        expect(finished._id).toBe(id)
        expect(finished.status).toBe('requested')
        expect(operation.items).toEqual([
          { entryId: id, modelSlug: 'gpt-4o', change: 'add' }
        ])
      })

      test('refuses a model the team already has, but not one it removed', async () => {
        const member = await signedInMember()
        const first = await requestOne(member)

        await expect(
          requestOne({ ...member, idempotencyKey: randomUUID() })
        ).rejects.toMatchObject({
          output: { statusCode: 409 },
          data: {
            code: 'deployment-exists',
            existingId: first._id,
            existing: [{ id: first._id, modelSlug: 'gpt-4o' }]
          }
        })

        await db
          .collection('teamDeployments')
          .updateOne(
            { teamId: member.teamId },
            { $set: { 'deployments.0.status': 'removed' } }
          )
        await db.collection('operations').deleteMany({ teamId: member.teamId })

        const again = await requestOne(member)

        expect(again._id).not.toBe(first._id)
      })
    })

    describe('one change per file', () => {
      test('queues a request made while another holds the file, then merges later ones into it', async () => {
        const member = await signedInMember()
        const first = await requestOne(member, 'gpt-4o')
        const secondKey = randomUUID()
        const thirdKey = randomUUID()
        const second = await requestOne(member, 'svc-b', {
          idempotencyKey: secondKey
        })
        const third = await requestOne(member, 'svc-c', {
          idempotencyKey: thirdKey
        })
        const [active, waiting, ...others] = await operationsOf(member.teamId)

        expect(others).toEqual([])
        expect(first.status).toBe('requested')
        expect(second.status).toBe('queued')
        expect(third.status).toBe('queued')
        expect(waiting).toMatchObject({
          slot: 'waiting',
          state: 'queued',
          idempotencyKeys: [secondKey, thirdKey]
        })
        expect(waiting.items.map(({ modelSlug }) => modelSlug)).toEqual([
          'svc-b',
          'svc-c'
        ])
        expect(waiting).not.toHaveProperty('document')
        expect(waiting.outbox).toEqual([])
        expect(publisher.published).toHaveLength(1)
        expect(commandsOf(active._id)).toHaveLength(1)
        expect(second.operationId).toBe(waiting._id)
        expect(third.operationId).toBe(waiting._id)

        const replay = await requestOne(member, 'svc-c', {
          idempotencyKey: thirdKey
        })

        expect(replay._id).toBe(third._id)
        expect(await operationsOf(member.teamId)).toHaveLength(2)
      })

      test('submits the waiting request, built from main then, once the first ends', async () => {
        const member = await signedInMember()

        await requestOne(member, 'gpt-4o')
        const second = await requestOne(member, 'svc-b')
        const [active, waiting] = await operationsOf(member.teamId)

        expect(publisher.published).toHaveLength(1)

        await deliver(active, 'requested', 'committed', 'deploying', 'deployed')

        const promoted = await db
          .collection('operations')
          .findOne({ _id: waiting._id })
        const [command] = commandsOf(waiting._id)

        expect(promoted).toMatchObject({ state: 'requested', slot: 'active' })
        expect(
          JSON.parse(promoted.document).deployments.map(({ slug }) => slug)
        ).toEqual(['svc-b'])
        expect(validateCommand(command).valid).toBe(true)
        expect(await view(member, second._id)).toMatchObject({
          status: 'requested',
          operation: { id: waiting._id, state: 'requested' }
        })
      })

      test('holds a request while its environment is paused, committing nothing', async () => {
        const member = await signedInMember()

        await db
          .collection('environmentControls')
          .insertOne({ _id: SANDBOX, paused: true })

        const held = await requestOne(member)
        const operation = await operationOf(member.teamId)

        expect(held.status).toBe('queued')
        expect(operation).toMatchObject({
          state: 'queued',
          slot: 'active',
          held: { code: 'paused' }
        })
        expect(publisher.published).toEqual([])
      })
    })

    describe('the mock orchestrator marker', () => {
      const registryOf = (mockOutcomeOf) => ({ key: 'x', mockOutcomeOf })
      const marker = 'Journey test [mock:deploy-failed]'

      test('records the outcome the registry reads from the purpose, and no purpose', async () => {
        const member = await signedInMember()

        await requestOne(
          member,
          'gpt-4o',
          { purpose: marker },
          {
            ...deps,
            registry: registryOf((purpose) =>
              purpose?.includes('[mock:deploy-failed]') ? 'deploy-failed' : null
            )
          }
        )

        expect((await operationOf(member.teamId)).mockOutcome).toBe(
          'deploy-failed'
        )

        const other = await signedInMember()

        await requestOne(
          other,
          'gpt-4o',
          {},
          {
            ...deps,
            registry: registryOf(() => null)
          }
        )

        expect(await operationOf(other.teamId)).not.toHaveProperty(
          'mockOutcome'
        )
      })

      test('has no effect with the sqs orchestrator, whatever the purpose says', async () => {
        const { createTenantOrchestratorRegistry } =
          await import('#/adapters/tenant-orchestrator-registry.js')
        const sqs = createTenantOrchestratorRegistry(
          { sqs: { reader: {}, createTransport: vi.fn() } },
          'sqs',
          'dev'
        )
        const member = await signedInMember()

        await requestOne(
          member,
          'gpt-4o',
          { purpose: marker },
          {
            ...deps,
            registry: sqs
          }
        )

        expect(await operationOf(member.teamId)).not.toHaveProperty(
          'mockOutcome'
        )
      })
    })
  })

  describe('following the operation', () => {
    test('goes through every state to active, with each stage time in the history and the credential made once', async () => {
      const member = await signedInMember()
      const { deployment, operation } = await activeDeployment(member)
      const ended = await db
        .collection('operations')
        .findOne({ _id: operation._id })
      const doc = await db
        .collection('teamDeployments')
        .findOne({ teamId: member.teamId })
      const active = await view(member, deployment._id)

      expect(ended.state).toBe('active')
      expect(ended.slot).toBeUndefined()
      expect(ended.history.map(({ state }) => state)).toEqual([
        'requested',
        'committed',
        'deploying',
        'deployed',
        'verified',
        'active'
      ])
      expect(
        ended.history.every(({ at, receivedAt }) => at && receivedAt)
      ).toBe(true)
      expect(active).toMatchObject({
        status: 'active',
        activatedAt: expect.any(String),
        failureReason: null,
        operation: {
          id: operation._id,
          state: 'active',
          attempt: 1,
          commitSha: expect.stringMatching(/^[0-9a-f]{40}$/),
          runUrl: expect.stringContaining('/actions/runs/'),
          failureReason: null
        },
        links: {
          submitRun: expect.stringContaining('/actions/runs/'),
          applyRun: expect.stringContaining('/actions/runs/')
        }
      })
      expect(active.links).not.toHaveProperty('pullRequest')
      expect(active.progressSteps.map(({ state }) => state)).toEqual([
        'done',
        'done',
        'done',
        'done',
        'done'
      ])
      expect(Object.keys(doc.deployments[0].statusTimes).sort()).toEqual(
        [
          'active',
          'committed',
          'deployed',
          'deploying',
          'requested',
          'verified'
        ].sort()
      )
      expect(doc.gateway.allowedDeployments).toEqual(['gpt-4o'])
      expect(ensureCredential).toHaveBeenCalledTimes(1)
      expect(verifier.verify).toHaveBeenCalledTimes(1)
    })

    test('shows each state as the events arrive', async () => {
      const member = await signedInMember()
      const deployment = await requestOne(member)
      const operation = await operationOf(member.teamId)
      const seen = []

      for (const status of ['requested', 'committed', 'deploying']) {
        await deliver(operation, status)
        seen.push((await view(member, deployment._id)).status)
      }

      expect(seen).toEqual(['requested', 'committed', 'deploying'])
    })

    test('ends checks-failed with the reason, shows no steps and frees the file', async () => {
      const member = await signedInMember()
      const deployment = await requestOne(member)
      const operation = await operationOf(member.teamId)

      await deliver(operation, 'requested', 'checks-failed')

      const failed = await view(member, deployment._id)

      expect(failed).toMatchObject({
        status: 'checks-failed',
        failureReason: 'The file failed validation',
        progressSteps: null,
        operation: {
          state: 'checks-failed',
          failureReason: 'operation-checks-failed'
        }
      })
      expect(
        (await db.collection('operations').findOne({ _id: operation._id })).slot
      ).toBeUndefined()

      // Another request is accepted as soon as the file is free.
      const next = await requestOne(member, 'svc-b')

      expect(next.status).toBe('requested')
    })

    test('gives an attributable failure one fresh apply, then a revert of the whole operation', async () => {
      const member = await signedInMember()
      const deployment = await requestOne(member)
      const operation = await operationOf(member.teamId)

      await deliver(
        operation,
        'requested',
        'committed',
        'deploying',
        'deploy-failed'
      )

      const retried = await db
        .collection('operations')
        .findOne({ _id: operation._id })

      expect(retried).toMatchObject({ state: 'deploy-failed', attempt: 2 })
      expect(commandsOf(operation._id, 'apply')).toEqual([
        expect.objectContaining({ attempt: 2 })
      ])
      expect(await view(member, deployment._id)).toMatchObject({
        status: 'deploy-failed',
        failureReason:
          'The apply failed and platform engineers have been alerted'
      })

      // The retry's own failure, from a later run, schedules the revert.
      await runtime.handler.handle(
        eventFor(operation, 'deploy-failed', { runId: RETRY_RUN })
      )

      const reverting = await db
        .collection('operations')
        .findOne({ _id: operation._id })

      expect(reverting).toMatchObject({ deferred: 'revert', slot: 'active' })

      await runtime.operations.startRevert(reverting)

      const [, revert] = await operationsOf(member.teamId)

      expect(revert).toMatchObject({
        type: 'team-file.revert',
        parentId: operation._id,
        action: 'remove'
      })
      expect(commandsOf(revert._id, 'submit')).toEqual([
        expect.objectContaining({ action: 'remove' })
      ])
    })

    test('recovers when the retry deploys: active, with the one retry used', async () => {
      const member = await signedInMember()
      const deployment = await requestOne(member)
      const operation = await operationOf(member.teamId)

      await deliver(
        operation,
        'requested',
        'committed',
        'deploying',
        'deploy-failed'
      )
      await runtime.handler.handle(
        eventFor(operation, 'deployed', { runId: RETRY_RUN })
      )

      expect(await view(member, deployment._id)).toMatchObject({
        status: 'active',
        failureReason: null,
        operation: { state: 'active', attempt: 2 }
      })
    })

    test('keeps verifying against ARM, up to five attempts, before it fails for good with the reason', async () => {
      const member = await signedInMember()
      const deployment = await requestOne(member)
      const operation = await operationOf(member.teamId)

      verifier.verify.mockResolvedValue({
        verified: false,
        reason: 'resource-unavailable'
      })
      await deliver(
        operation,
        'requested',
        'committed',
        'deploying',
        'deployed'
      )

      expect(await view(member, deployment._id)).toMatchObject({
        status: 'deployed',
        verificationFailure: { reason: 'resource-unavailable', attempts: 1 }
      })

      for (let attempt = 2; attempt <= 5; attempt += 1) {
        await runtime.verifier.verify(operation._id)
      }

      expect(verifier.verify).toHaveBeenCalledTimes(5)

      const failed = await view(member, deployment._id)

      expect(failed.status).toBe('deploy-failed')
      expect(failed.failureReason).toContain('could not be confirmed')
      expect(failed.failureReason).toContain('resource-unavailable')
      expect(failed.operation.failureReason).toBe('operation-verify-failed')
      expect(ensureCredential).not.toHaveBeenCalled()
    })

    test('lets a later verification succeed, so the deployment activates', async () => {
      const member = await signedInMember()
      const deployment = await requestOne(member)
      const operation = await operationOf(member.teamId)

      verifier.verify.mockResolvedValueOnce({
        verified: false,
        reason: 'resource-not-succeeded'
      })
      await deliver(
        operation,
        'requested',
        'committed',
        'deploying',
        'deployed'
      )
      await runtime.verifier.verify(operation._id)

      expect((await view(member, deployment._id)).status).toBe('active')
      expect(ensureCredential).toHaveBeenCalledTimes(1)
    })
  })

  describe('reading', () => {
    test('finds nothing when a member asks after an unknown deployment, or a non-member asks', async () => {
      const member = await signedInMember()
      const stranger = await signedInMember()
      const deployment = await requestOne(member)

      expect(await view(member, new ObjectId().toString())).toBeNull()
      expect(
        await view({ ...member, userId: stranger.userId }, deployment._id)
      ).toBeNull()
      expect(
        await service.getDeployment(db, {
          id: deployment._id,
          teamId: 'no-such-team',
          userId: member.userId
        })
      ).toBeNull()
    })

    test('lists every deployment of the team, naming the model', async () => {
      const member = await signedInMember()

      await requestModels(member, ['gpt-4o', 'svc-b'])

      const items = await service.listDeploymentsForTeam(db, {
        teamId: member.teamId,
        userId: member.userId
      })

      expect(items.map(({ modelSlug }) => modelSlug)).toEqual([
        'gpt-4o',
        'svc-b'
      ])
      expect(
        items.every(({ operation }) => operation.state === 'requested')
      ).toBe(true)
      expect(items[1].progressSteps[2].label).toBe('Setting up svc-b in Azure')
    })

    test('is not found to a non-member listing', async () => {
      const member = await signedInMember()
      const stranger = await signedInMember()

      await expect(
        service.listDeploymentsForTeam(db, {
          teamId: member.teamId,
          userId: stranger.userId
        })
      ).rejects.toMatchObject({ output: { statusCode: 404 } })
    })
  })

  describe('removeDeployment', () => {
    function remove(member, id, params, extra = deps) {
      return removal.removeDeployment(
        db,
        server.locker,
        {
          teamId: member.teamId,
          id,
          requestedBy: member.userId,
          ...params
        },
        extra
      )
    }

    // The team holds an active deployment, as an earlier operation left it.
    async function seededActive(member, modelSlug = 'gpt-4o') {
      const id = new ObjectId().toString()

      await db.collection('teamDeployments').insertOne({
        teamId: member.teamId,
        environment: SANDBOX,
        gateway: {
          credentialType: 'oauth',
          allowedDeployments: [modelSlug],
          limits: {}
        },
        deployments: [
          {
            id,
            modelSlug,
            status: 'active',
            statusTimes: {},
            operationId: randomUUID(),
            requestedBy: member.userId,
            createdAt: new Date().toISOString(),
            activatedAt: new Date().toISOString(),
            failureReason: null
          }
        ]
      })

      return id
    }

    test('submits the team file without the model as the requester, and the entry is removing', async () => {
      const member = await signedInMember()
      const { deployment } = await activeDeployment(member)

      fileOnMain = {
        schemaVersion: 1,
        revision: 2,
        environment: SANDBOX,
        status: 'active',
        deployments: [
          {
            slug: 'gpt-4o',
            sku: 'DataZoneStandard',
            capacity: 1,
            status: 'active'
          },
          {
            slug: 'svc-b',
            sku: 'DataZoneStandard',
            capacity: 1,
            status: 'active'
          }
        ],
        gateway: {
          credentialType: 'oauth',
          allowedDeployments: ['gpt-4o', 'svc-b'],
          limits: { tokensPerMinute: 1000, requestsPerMinute: 60 }
        },
        oauth: { federations: [], externalClients: [], secretsAllowed: true }
      }

      const removing = await remove(member, deployment._id, {
        traceParent: VALID_TRACEPARENT
      })
      const [, operation] = await operationsOf(member.teamId)
      const document = JSON.parse(operation.document)

      expect(removing).toMatchObject({
        status: 'removing',
        progressSteps: null,
        operation: { id: operation._id, state: 'requested' }
      })
      expect(operation).toMatchObject({
        type: 'team-file.write',
        items: [
          { entryId: deployment._id, modelSlug: 'gpt-4o', change: 'remove' }
        ],
        requestedBy: member.principal,
        traceparent: VALID_TRACEPARENT,
        expectedRevision: 2
      })
      expect(document.revision).toBe(3)
      expect(document.deployments.map(({ slug }) => slug)).toEqual(['svc-b'])
      expect(document.gateway.allowedDeployments).toEqual(['svc-b'])
      expect(commandsOf(operation._id)).toEqual([
        expect.objectContaining({ type: 'submit', action: 'write' })
      ])
      expect(
        (await auditOf(deployment._id)).map(({ action, reason }) => [
          action,
          reason
        ])
      ).toContainEqual([
        'teamDeployment.remove',
        `remove operation ${operation._id}`
      ])
    })

    test('ends removed, with the grant withdrawn, once the removal has applied', async () => {
      const member = await signedInMember()
      const { deployment } = await activeDeployment(member)

      await remove(member, deployment._id)

      const [, operation] = await operationsOf(member.teamId)

      await deliver(
        operation,
        'requested',
        'committed',
        'deploying',
        'deployed'
      )

      const removed = await view(member, deployment._id)
      const doc = await db
        .collection('teamDeployments')
        .findOne({ teamId: member.teamId })

      expect(removed).toMatchObject({
        status: 'removed',
        removedAt: expect.any(String),
        progressSteps: null,
        operation: { id: operation._id, state: 'removed' }
      })
      expect(doc.gateway.allowedDeployments).toEqual([])
      expect(verifier.verify).toHaveBeenCalledTimes(1)
    })

    test('puts the model back as active when the removal fails, and says so', async () => {
      const member = await signedInMember()
      const { deployment } = await activeDeployment(member)

      await remove(member, deployment._id)

      const [, operation] = await operationsOf(member.teamId)

      await deliver(operation, 'requested', 'checks-failed')

      expect(await view(member, deployment._id)).toMatchObject({
        status: 'active',
        failureReason: expect.stringContaining('still deployed')
      })
    })

    test('returns the entry as it is while a removal is in progress, or once removed', async () => {
      const member = await signedInMember()
      const { deployment } = await activeDeployment(member)

      await remove(member, deployment._id)

      const again = await remove(member, deployment._id)

      expect(again.status).toBe('removing')
      expect(await operationsOf(member.teamId)).toHaveLength(2)

      const [, operation] = await operationsOf(member.teamId)

      await deliver(
        operation,
        'requested',
        'committed',
        'deploying',
        'deployed'
      )

      expect((await remove(member, deployment._id)).status).toBe('removed')
      expect(await operationsOf(member.teamId)).toHaveLength(2)
    })

    test('marks removed at once a model whose request the checks refused', async () => {
      const member = await signedInMember()
      const deployment = await requestOne(member)
      const operation = await operationOf(member.teamId)

      await deliver(operation, 'requested', 'checks-failed')

      const removed = await remove(member, deployment._id)

      expect(removed.status).toBe('removed')
      expect(await operationsOf(member.teamId)).toHaveLength(1)
      expect(
        (await auditOf(deployment._id)).find(
          ({ action }) => action === 'teamDeployment.remove'
        )
      ).toMatchObject({ code: 'record-only', actorUserId: member.userId })
    })

    test.each([
      ['being set up', async (member) => requestOne(member)],
      [
        'waiting for the file',
        async (member) => {
          await requestOne(member, 'gpt-4o')

          return requestOne(member, 'svc-b')
        }
      ]
    ])('refuses a deployment still %s', async (_name, request) => {
      const member = await signedInMember()
      const deployment = await request(member)

      await expect(remove(member, deployment._id)).rejects.toMatchObject({
        output: { statusCode: 409 },
        data: { code: 'deployment-in-progress' }
      })
    })

    test('refuses while another operation holds the team file', async () => {
      const member = await signedInMember()
      const id = await seededActive(member, 'gpt-4o')

      await requestOne(member, 'svc-b')

      await expect(remove(member, id)).rejects.toMatchObject({
        output: { statusCode: 409 },
        data: { code: 'team-file-busy' }
      })
      expect(await operationsOf(member.teamId)).toHaveLength(1)
    })

    test('is for team admins only, and hides the entry from non-members', async () => {
      const admin = await signedInMember()
      const id = await seededActive(admin)
      const plain = await signedInMember()

      await db.collection('teamMembers').insertOne({
        teamId: admin.teamId,
        userId: plain.userId,
        role: 'user',
        status: 'active'
      })

      await expect(
        remove({ ...admin, userId: plain.userId }, id)
      ).rejects.toMatchObject({
        output: { statusCode: 403 },
        data: { code: 'admin-required' }
      })
      expect(await remove(plain, id)).toBeNull()
      expect(await remove(admin, new ObjectId().toString())).toBeNull()
      expect(await operationsOf(admin.teamId)).toEqual([])
    })

    test('leaves the deployment active when the removal cannot be submitted', async () => {
      const member = await signedInMember()
      const id = await seededActive(member)

      buildDesiredState.mockRejectedValueOnce(new Error('GitHub is down'))

      await expect(remove(member, id)).rejects.toMatchObject({
        output: { statusCode: 502 },
        data: { code: 'upstream-unavailable' }
      })

      expect((await storedEntry(member.teamId, id)).status).toBe('active')
      expect(await operationsOf(member.teamId)).toEqual([])
      expect(
        (await auditOf(id)).find(
          ({ action }) => action === 'teamDeployment.remove'
        )
      ).toMatchObject({ outcome: 'failure', code: 'upstream-unavailable' })
    })

    test('passes a policy refusal on as it is', async () => {
      const member = await signedInMember()
      const id = await seededActive(member)

      buildDesiredState.mockRejectedValueOnce(
        boomWithCode(Boom.conflict, 'No service code', 'service-code-required')
      )

      await expect(remove(member, id)).rejects.toMatchObject({
        data: { code: 'service-code-required' }
      })
      expect(await operationsOf(member.teamId)).toEqual([])
    })
  })

  describe('redispatchApply', () => {
    async function adminId() {
      const { insertedId } = await db.collection('users').insertOne({
        email: `admin-${randomUUID()}@defra.gov.uk`,
        displayName: 'Platform Admin',
        roles: ['research-user', 'platform-admin']
      })

      return insertedId.toString()
    }

    async function redispatch(id, kind, actorUserId, extra = deps) {
      return service.redispatchApply(
        db,
        { id, actorUserId: actorUserId ?? (await adminId()), kind },
        extra
      )
    }

    // An unattributable deploy failure ends the operation for good.
    async function failedDeployment(member) {
      const deployment = await requestOne(member)
      const operation = await operationOf(member.teamId)

      for (const status of ['requested', 'committed', 'deploying']) {
        await deliver(operation, status)
      }

      await runtime.handler.handle(
        eventFor(operation, 'deploy-failed', { attributable: false })
      )

      return { deployment, operation }
    }

    test('refuses anyone who is not a Platform Admin', async () => {
      const member = await signedInMember()
      const { deployment } = await failedDeployment(member)

      await expect(
        redispatch(deployment._id, 'retry', member.userId)
      ).rejects.toMatchObject({
        output: { statusCode: 403 },
        data: { code: 'platform-admin-required' }
      })
      expect(commandsOf(deployment.operationId, 'apply')).toEqual([])
    })

    test.each([['requested'], ['active']])(
      'retries only a failed deployment, not one that is %s',
      async (state) => {
        const member = await signedInMember()

        if (state === 'active') {
          const { deployment } = await activeDeployment(member)

          await expect(
            redispatch(deployment._id, 'retry')
          ).rejects.toMatchObject({
            output: { statusCode: 409 },
            data: { code: 'deployment-not-retryable' }
          })
        } else {
          const deployment = await requestOne(member)

          await expect(
            redispatch(deployment._id, 'retry')
          ).rejects.toMatchObject({
            data: { code: 'deployment-not-retryable' }
          })
        }
      }
    )

    test('retries a failed deployment with a fresh apply at the next attempt, back at deploying', async () => {
      const member = await signedInMember()
      const { deployment, operation } = await failedDeployment(member)
      const admin = await adminId()

      expect((await view(member, deployment._id)).status).toBe('deploy-failed')

      const retried = await redispatch(deployment._id, 'retry', admin)
      const stored = await db
        .collection('operations')
        .findOne({ _id: operation._id })

      expect(retried).toMatchObject({
        status: 'deploying',
        failureReason: null,
        operation: { state: 'deploying', attempt: 2 }
      })
      expect(stored).toMatchObject({
        state: 'deploying',
        attempt: 2,
        slot: 'active'
      })
      expect(stored.verify).toEqual({ attempts: 0, nextAt: null })
      expect(commandsOf(operation._id, 'apply')).toEqual([
        expect.objectContaining({ attempt: 2 })
      ])
      expect(
        (await auditOf(deployment._id)).find(
          ({ action }) => action === 'teamDeployment.retry'
        )
      ).toMatchObject({
        actorUserId: admin,
        outcome: 'success',
        reason: 'deploy-failed -> deploying'
      })
    })

    test.each([['requested'], ['committed'], ['deploying']])(
      'resumes a timed-out operation that left %s, with a submit before committed and an apply after',
      async (leftState) => {
        const type = leftState === 'requested' ? 'submit' : 'apply'
        const member = await signedInMember()
        const deployment = await requestOne(member)
        const operation = await operationOf(member.teamId)

        await db.collection('operations').updateOne(
          { _id: operation._id },
          {
            $set: {
              state: 'timed-out',
              leftState,
              error: {
                code: 'operation-timed-out',
                message: 'No progress',
                retryable: false
              }
            }
          }
        )

        const before = commandsOf(operation._id, type).length
        const retried = await redispatch(deployment._id, 'retry')
        const commands = commandsOf(operation._id, type)

        expect(commands).toHaveLength(before + 1)
        expect(validateCommand(commands.at(-1)).valid).toBe(true)
        expect(retried.status).toBe(leftState)
      }
    )

    test('reconciles a deployment in any state by publishing a reconcile for it', async () => {
      const member = await signedInMember()
      const deployment = await requestOne(member)
      const operation = await operationOf(member.teamId)

      await deliver(operation, 'requested', 'committed')

      const reconciled = await redispatch(deployment._id, 'reconcile')
      const [command] = commandsOf(operation._id, 'reconcile')

      expect(reconciled.status).toBe('committed')
      expect(command).toMatchObject({ state: 'committed' })
      expect(validateCommand(command).valid).toBe(true)
      expect(
        (await auditOf(deployment._id)).find(
          ({ action }) => action === 'teamDeployment.reconcile'
        )
      ).toMatchObject({ outcome: 'success' })
    })

    test('returns 404 for an unknown deployment, and for one with no operation', async () => {
      const member = await signedInMember()
      const id = new ObjectId().toString()

      await db.collection('teamDeployments').insertOne({
        teamId: member.teamId,
        environment: SANDBOX,
        deployments: [{ id, modelSlug: 'gpt-4o', status: 'queued' }]
      })

      await expect(
        redispatch(new ObjectId().toString(), 'retry')
      ).rejects.toMatchObject({ output: { statusCode: 404 } })
      await expect(redispatch(id, 'reconcile')).rejects.toMatchObject({
        output: { statusCode: 404 }
      })
    })

    test('reports and audits a command that could not be handed on', async () => {
      const member = await signedInMember()
      const { deployment } = await failedDeployment(member)
      const admin = await adminId()

      await expect(
        redispatch(deployment._id, 'retry', admin, {
          operations: {
            retry: vi.fn().mockRejectedValue(new Error('mongo down'))
          }
        })
      ).rejects.toMatchObject({
        output: { statusCode: 502 },
        data: { code: 'upstream-unavailable' }
      })
      expect(
        (await auditOf(deployment._id)).find(
          ({ action }) => action === 'teamDeployment.retry'
        )
      ).toMatchObject({ outcome: 'failure', code: 'upstream-unavailable' })
    })

    test('passes on a refusal the operations service already made', async () => {
      const member = await signedInMember()
      const { deployment } = await failedDeployment(member)

      await expect(
        redispatch(deployment._id, 'retry', undefined, {
          operations: {
            retry: vi
              .fn()
              .mockRejectedValue(
                boomWithCode(Boom.conflict, 'Busy', 'team-file-busy')
              )
          }
        })
      ).rejects.toMatchObject({ data: { code: 'team-file-busy' } })
    })
  })
})

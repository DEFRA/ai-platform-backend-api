import { randomUUID } from 'node:crypto'

import { ObjectId } from 'mongodb'

const SUBMIT_RUN_URL =
  'https://github.com/DEFRA/ai-platform-tenants/actions/runs/1001'

// A fake of this repo's own TenantOrchestrator port - the GitHub adapter
// itself is tested against nocked GitHub in its own file.
function fakeOrchestrator() {
  return {
    requestDeployment: vi.fn(async ({ operationId }) => ({
      operationId,
      status: 'requested',
      submitRunId: 1001,
      submitRunUrl: SUBMIT_RUN_URL
    })),
    getDeploymentStatus: vi.fn(async ({ operationId, status }) => ({
      operationId,
      status,
      links: {}
    })),
    requestApply: vi.fn(),
    getPreviousDocument: vi.fn()
  }
}

function githubRegistry(orchestrator) {
  return {
    key: 'github',
    orchestrator,
    forEntry: () => orchestrator
  }
}

// Stands in for the WS6 desired-state builder, so a test can see when a
// document is built.
function fakeBuilder() {
  return vi.fn(async (db, { environment, operationId, modelSlug }) => ({
    document: {
      schemaVersion: 1,
      revision: 2,
      environment,
      operationId,
      team: { slug: 'alpha', serviceCode: 'ZZZ' },
      gateway: { allowedDeployments: [modelSlug], credentialType: 'oauth' },
      oauth: { externalClients: [], federations: [], secretsAllowed: true }
    },
    expectedRevision: 1
  }))
}

const anHourAgo = () => new Date(Date.now() - 60 * 60 * 1000).toISOString()

describe('team deployment queue', () => {
  let server
  let db
  let service

  beforeAll(async () => {
    // Dynamic import needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')

    server = await createServer()
    await server.initialize()
    db = server.db
    service = await import('#/services/team-deployment-service.js')
  })

  afterAll(async () => {
    await server.stop({ timeout: 0 })
  })

  // A signed-in member of a new team, with the GitHub-mode dependencies a
  // test's requests and polls share.
  async function teamMember() {
    const oid = randomUUID()
    const { insertedId } = await db.collection('users').insertOne({
      oid,
      tid: '6f504113-6b64-43f2-ade9-242e05780007',
      email: `queue-${oid}@defra.gov.uk`,
      displayName: 'Queue User',
      roles: ['research-user']
    })
    const userId = insertedId.toString()
    const teamId = new ObjectId().toString()
    const orchestrator = fakeOrchestrator()
    const buildDesiredState = fakeBuilder()

    await db
      .collection('teamMembers')
      .insertOne({ teamId, userId, role: 'admin', status: 'active' })

    return {
      teamId,
      userId,
      principal: `entra:${oid}`,
      orchestrator,
      buildDesiredState,
      deps: { registry: githubRegistry(orchestrator), buildDesiredState }
    }
  }

  async function request(member, modelSlug) {
    const [deployment] = await service.requestDeployments(
      db,
      server.locker,
      {
        teamId: member.teamId,
        modelSlugs: [modelSlug],
        environment: 'sandbox',
        requestedBy: member.userId,
        idempotencyKey: randomUUID()
      },
      member.deps
    )

    return deployment
  }

  function poll(member, deployment, deps = {}) {
    return service.getDeployment(
      db,
      { id: deployment._id, teamId: member.teamId, userId: member.userId },
      { ...member.deps, pollMinIntervalMs: 0, ...deps }
    )
  }

  async function storedEntry(id) {
    const doc = await db
      .collection('teamDeployments')
      .findOne({ 'deployments.id': id })

    return doc?.deployments.find((entry) => entry.id === id) ?? null
  }

  async function setEntry(id, fields) {
    await db.collection('teamDeployments').updateOne(
      { 'deployments.id': id },
      {
        $set: Object.fromEntries(
          Object.entries(fields).map(([key, value]) => [
            `deployments.$.${key}`,
            value
          ])
        )
      }
    )
  }

  async function auditActions(id) {
    return (
      await db.collection('auditEvents').find({ resourceId: id }).toArray()
    ).map(({ action, outcome, code }) => [action, outcome, code ?? null])
  }

  // Two requests for one team and environment: the first in flight, the
  // second queued behind it.
  async function firstAndQueued() {
    const member = await teamMember()
    const first = await request(member, 'gpt-4o')
    const queued = await request(member, 'gpt-4-1-nano')

    return { member, first, queued }
  }

  test('queues a request while another holds the team file, neither building nor dispatching it', async () => {
    const { member, first, queued } = await firstAndQueued()
    const stored = await storedEntry(queued._id)

    expect(first.status).toBe('requested')
    expect(queued).toMatchObject({
      status: 'queued',
      links: {},
      progressSteps: [
        { label: 'Request recorded', state: 'current' },
        { label: 'Team checked', state: 'pending' },
        { label: 'Setting up access in Azure', state: 'pending' },
        { label: 'Checking and preparing your client secret', state: 'pending' }
      ]
    })
    expect(member.orchestrator.requestDeployment).toHaveBeenCalledTimes(1)
    expect(member.buildDesiredState).toHaveBeenCalledTimes(1)
    expect(stored).toMatchObject({
      status: 'queued',
      gitops: null,
      requestedByPrincipal: member.principal
    })
    expect(await auditActions(queued._id)).toEqual([
      ['teamDeployment.request', 'success', 'queued']
    ])
  })

  test('keeps the request queued while the first is still in progress', async () => {
    const { member, queued } = await firstAndQueued()

    const view = await poll(member, queued)

    expect(view.status).toBe('queued')
    expect(member.orchestrator.requestDeployment).toHaveBeenCalledTimes(1)
  })

  test('dispatches the queued request, building its document then, once the first ends', async () => {
    const { member, first, queued } = await firstAndQueued()

    member.orchestrator.getDeploymentStatus.mockImplementation(
      async ({ operationId, status }) => ({
        operationId,
        status: operationId === first.operationId ? 'active' : status,
        links: {}
      })
    )

    const view = await poll(member, queued)
    const stored = await storedEntry(queued._id)

    expect(view.status).toBe('requested')
    expect(member.buildDesiredState).toHaveBeenCalledTimes(2)
    expect(member.buildDesiredState).toHaveBeenLastCalledWith(db, {
      teamId: member.teamId,
      environment: 'sandbox',
      modelSlug: 'gpt-4-1-nano',
      operationId: queued.operationId,
      requestedBy: member.userId
    })
    expect(member.orchestrator.requestDeployment).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operationId: queued.operationId,
        requestedBy: member.principal,
        action: 'write',
        document: expect.objectContaining({ updatedBy: member.principal })
      })
    )
    expect(stored).toMatchObject({
      status: 'requested',
      dispatch: {
        claimedAt: expect.any(String),
        dispatchedAt: expect.any(String)
      },
      gitops: expect.objectContaining({
        path: 'environments/sandbox/alpha.json',
        branch: `op/${queued.operationId}`,
        submitRunId: 1001
      })
    })
    expect(await auditActions(queued._id)).toContainEqual([
      'teamDeployment.dispatch',
      'success',
      null
    ])
  })

  test('dispatches once when two requests arrive together', async () => {
    const member = await teamMember()

    const views = await Promise.all([
      request(member, 'gpt-4o'),
      request(member, 'gpt-4-1-nano')
    ])

    expect(views.map(({ status }) => status).sort()).toEqual([
      'queued',
      'requested'
    ])
    expect(member.orchestrator.requestDeployment).toHaveBeenCalledTimes(1)
  })

  test('dispatches the queued request once when two polls release it together', async () => {
    const { member, first, queued } = await firstAndQueued()

    await setEntry(first._id, { status: 'active' })
    await Promise.all([poll(member, queued), poll(member, queued)])

    expect(member.orchestrator.requestDeployment).toHaveBeenCalledTimes(2)
    expect((await storedEntry(queued._id)).status).toBe('requested')
  })

  test.each([
    ['deploy-failed', 'The apply workflow failed'],
    ['checks-failed', 'The submit workflow rejected the change']
  ])(
    'releases the queue once the first ends %s',
    async (status, failureReason) => {
      const { member, first, queued } = await firstAndQueued()

      await setEntry(first._id, { status, failureReason })

      expect((await poll(member, queued)).status).toBe('requested')
    }
  )

  test('releases the queue only once the first’s failed pull request has been abandoned', async () => {
    const { member, first, queued } = await firstAndQueued()

    await setEntry(first._id, {
      status: 'checks-failed',
      'gitops.pullRequestNumber': 7
    })

    expect((await poll(member, queued)).status).toBe('queued')

    await setEntry(first._id, {
      'gitops.abandon': {
        claimedAt: new Date().toISOString(),
        action: 'abandon',
        submitRunId: 4004,
        dispatchedAt: new Date().toISOString(),
        status: 'requested'
      }
    })

    expect((await poll(member, queued)).status).toBe('queued')

    member.orchestrator.getDeploymentStatus.mockResolvedValue({
      operationId: first.operationId,
      status: 'active',
      links: {}
    })

    expect((await poll(member, queued)).status).toBe('requested')
    expect(member.orchestrator.requestDeployment).toHaveBeenCalledTimes(2)
  })

  test('claims a queued dispatch that never finished again under the same operation ID', async () => {
    const { member, first, queued } = await firstAndQueued()

    await setEntry(first._id, { status: 'active' })
    await setEntry(queued._id, {
      dispatch: { claimedAt: new Date().toISOString() }
    })

    expect((await poll(member, queued)).status).toBe('queued')

    await setEntry(queued._id, { dispatch: { claimedAt: anHourAgo() } })

    expect((await poll(member, queued)).status).toBe('requested')
    expect(member.orchestrator.requestDeployment).toHaveBeenLastCalledWith(
      expect.objectContaining({ operationId: queued.operationId })
    )
  })

  test('releases the claim for the next poll when the dispatch fails', async () => {
    const { member, first, queued } = await firstAndQueued()
    const logger = { warn: vi.fn(), error: vi.fn() }

    await setEntry(first._id, { status: 'active' })
    member.orchestrator.requestDeployment.mockRejectedValueOnce(
      new Error('GitHub unavailable')
    )

    expect((await poll(member, queued, { logger })).status).toBe('queued')
    expect((await storedEntry(queued._id)).dispatch).toEqual({
      claimedAt: null
    })
    expect(logger.error).toHaveBeenCalledWith(
      { code: null, operationId: queued.operationId },
      'Queued team deployment could not be dispatched, retrying on the next poll'
    )

    expect((await poll(member, queued)).status).toBe('requested')
  })

  test('fails a queued request that cannot be built, then dispatches the next, oldest first', async () => {
    const member = await teamMember()
    const queuedEntry = (modelSlug) => ({
      id: randomUUID(),
      modelSlug,
      status: 'queued',
      operationId: randomUUID(),
      requestedBy: member.userId,
      requestedByPrincipal: member.principal,
      createdAt: new Date().toISOString(),
      orchestrator: 'github',
      gitops: null
    })
    const unbuildable = queuedEntry('gpt-4o')
    const next = queuedEntry('gpt-4-1-nano')

    await db.collection('teamDeployments').insertOne({
      teamId: member.teamId,
      environment: 'sandbox',
      deployments: [unbuildable, next]
    })
    member.buildDesiredState.mockImplementationOnce(async () => null)

    const failed = await poll(member, { _id: unbuildable.id })

    expect(failed).toMatchObject({
      status: 'checks-failed',
      failureReason:
        'The desired-state document for this team cannot be built yet'
    })
    expect(await auditActions(unbuildable.id)).toContainEqual([
      'teamDeployment.dispatch',
      'failure',
      'desired-state-unavailable'
    ])

    expect((await poll(member, { _id: next.id })).status).toBe('requested')
  })
})

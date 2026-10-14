import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

const alpha = JSON.parse(
  readFileSync(
    new URL(
      '../common/fixtures/gitops/ai-platform-tenants/environments/infradev/alpha.json',
      import.meta.url
    ),
    'utf8'
  )
)

const SUBMIT_RUN_URL =
  'https://github.com/DEFRA/ai-platform-tenants/actions/runs/1001'
const APPLY_RUN_URL =
  'https://github.com/DEFRA/ai-platform-tenants/actions/runs/2002'
const PULL_REQUEST_URL = 'https://github.com/DEFRA/ai-platform-tenants/pull/7'
const VALID_TRACEPARENT =
  '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'

// A fake of this repo's own TenantOrchestrator port - the GitHub adapter
// itself is tested against nocked GitHub in its own file.
function fakeOrchestrator(overrides = {}) {
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
    requestApply: vi.fn(async () => ({ runId: 2002, runUrl: APPLY_RUN_URL })),
    getPreviousDocument: vi.fn(async () => ({ document: null })),
    ...overrides
  }
}

function githubRegistry(orchestrator) {
  return {
    key: 'github',
    orchestrator,
    forEntry: () => orchestrator
  }
}

// Stands in for the WS6 desired-state builder: the infra example team file,
// at the operation being submitted.
async function buildDesiredState(db, { environment, operationId }) {
  return {
    document: { ...alpha, environment, operationId, revision: 2 },
    expectedRevision: 1
  }
}

function fakeLogger() {
  return { warn: vi.fn(), error: vi.fn() }
}

describe('team-deployment-service (GitOps)', () => {
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

  async function joinTeam(userId) {
    const teamId = `gitops-team-${randomUUID()}`

    await db
      .collection('teamMembers')
      .insertOne({ teamId, userId, role: 'admin', status: 'active' })

    return teamId
  }

  // A team member who signed in with an Entra object ID, which a deployment
  // request is attributed to; `fields` overrides the user record.
  async function signedInMember(fields = {}) {
    const oid = randomUUID()
    const { insertedId } = await db.collection('users').insertOne({
      oid,
      tid: '6f504113-6b64-43f2-ade9-242e05780007',
      email: `gitops-${oid}@defra.gov.uk`,
      displayName: 'GitOps User',
      roles: ['research-user'],
      ...fields
    })
    const userId = insertedId.toString()

    return { userId, teamId: await joinTeam(userId), principal: `entra:${oid}` }
  }

  async function submitGithubDeployment(orchestrator, overrides = {}) {
    const { userId, teamId, principal } = await signedInMember()
    const deployment = await service.requestDeployment(
      db,
      server.locker,
      {
        teamId,
        modelSlug: 'gpt-4o',
        environment: 'sandbox',
        requestedBy: userId,
        idempotencyKey: randomUUID(),
        traceParent: VALID_TRACEPARENT,
        ...overrides
      },
      { registry: githubRegistry(orchestrator), buildDesiredState }
    )

    return { deployment, teamId, userId, principal }
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
      await db
        .collection('auditEvents')
        .find({ resourceId: id })
        .sort({ at: 1 })
        .toArray()
    ).map((event) => [event.action, event.code, event.reason])
  }

  // Polls as a member's page does, with no minimum interval so a test can
  // poll the same operation again straight away.
  function poll(orchestrator, { deployment, teamId, userId }, logger) {
    return service.getDeployment(
      db,
      { id: deployment._id, teamId, userId },
      { registry: githubRegistry(orchestrator), logger, pollMinIntervalMs: 0 }
    )
  }

  describe('requestDeployment', () => {
    test('fails with desired-state-unavailable and records nothing until the WS6 builder is supplied', async () => {
      const orchestrator = fakeOrchestrator()
      const { teamId, userId } = await signedInMember()

      await expect(
        service.requestDeployment(
          db,
          server.locker,
          {
            teamId,
            modelSlug: 'gpt-4o',
            environment: 'sandbox',
            requestedBy: userId,
            idempotencyKey: randomUUID()
          },
          { registry: githubRegistry(orchestrator) }
        )
      ).rejects.toMatchObject({
        output: { statusCode: 501 },
        data: { code: 'desired-state-unavailable' }
      })
      expect(orchestrator.requestDeployment).not.toHaveBeenCalled()
      expect(
        await db.collection('teamDeployments').findOne({ teamId })
      ).toBeNull()
    })

    test('submits the built document to the team file as the requester and stores the GitOps trail', async () => {
      const orchestrator = fakeOrchestrator()
      const { deployment, userId, principal } =
        await submitGithubDeployment(orchestrator)
      const entry = await storedEntry(deployment._id)

      expect(orchestrator.requestDeployment).toHaveBeenCalledWith({
        environment: 'sandbox',
        path: 'environments/sandbox/alpha.json',
        document: {
          ...alpha,
          environment: 'sandbox',
          operationId: entry.operationId,
          revision: 2,
          updatedBy: principal
        },
        operationId: entry.operationId,
        requestedBy: principal,
        expectedRevision: 1,
        action: 'write',
        traceParent: VALID_TRACEPARENT
      })
      expect(principal).toMatch(
        /^entra:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      )
      // The portal's own user ID stays on the entry for authorisation.
      expect(entry.requestedBy).toBe(userId)
      expect(entry.orchestrator).toBe('github')
      expect(entry.gitops).toEqual({
        path: 'environments/sandbox/alpha.json',
        branch: `op/${entry.operationId}`,
        action: 'write',
        revision: 2,
        expectedRevision: 1,
        submitRunId: 1001,
        submitRunUrl: SUBMIT_RUN_URL
      })
      expect(deployment.links).toEqual({ submitRun: SUBMIT_RUN_URL })
    })

    test('drops a traceparent that is not W3C-shaped', async () => {
      const orchestrator = fakeOrchestrator()

      await submitGithubDeployment(orchestrator, {
        traceParent: 'not-a-traceparent'
      })

      expect(
        orchestrator.requestDeployment.mock.calls[0][0].traceParent
      ).toBeUndefined()
    })

    test('refuses a document too large to submit and removes the entry', async () => {
      const orchestrator = fakeOrchestrator({
        requestDeployment: vi.fn(async () => {
          const error = new Error('too large')
          error.code = 'desired-state-too-large'
          throw error
        })
      })
      const { teamId, userId } = await signedInMember()

      await expect(
        service.requestDeployment(
          db,
          server.locker,
          {
            teamId,
            modelSlug: 'gpt-4o',
            environment: 'sandbox',
            requestedBy: userId,
            idempotencyKey: randomUUID()
          },
          { registry: githubRegistry(orchestrator), buildDesiredState }
        )
      ).rejects.toMatchObject({
        output: { statusCode: 422 },
        data: { code: 'desired-state-too-large' }
      })

      const doc = await db.collection('teamDeployments').findOne({ teamId })

      expect(doc.deployments).toEqual([])
    })

    test('refuses a member with no Entra object ID, before recording or submitting anything', async () => {
      const orchestrator = fakeOrchestrator()
      // A record from before oid keying, until its next sign-in binds one.
      const { teamId, userId } = await signedInMember({ oid: undefined })

      await expect(
        service.requestDeployment(
          db,
          server.locker,
          {
            teamId,
            modelSlug: 'gpt-4o',
            environment: 'sandbox',
            requestedBy: userId,
            idempotencyKey: randomUUID()
          },
          { registry: githubRegistry(orchestrator), buildDesiredState }
        )
      ).rejects.toMatchObject({
        output: { statusCode: 403 },
        data: { code: 'entra-identity-required' }
      })
      expect(orchestrator.requestDeployment).not.toHaveBeenCalled()
      expect(
        await db.collection('teamDeployments').findOne({ teamId })
      ).toBeNull()
    })
  })

  describe('polling', () => {
    test('finds nothing when a member asks after an unknown deployment', async () => {
      const { teamId, userId } = await signedInMember()

      expect(
        await service.getDeployment(db, {
          id: 'no-such-deployment',
          teamId,
          userId
        })
      ).toBeNull()
    })

    test('stores the pull request and merge trail and audits each transition', async () => {
      const orchestrator = fakeOrchestrator()
      const submitted = await submitGithubDeployment(orchestrator)

      orchestrator.getDeploymentStatus
        .mockResolvedValueOnce({
          operationId: submitted.deployment.operationId,
          status: 'pr-raised',
          pullRequestNumber: 7,
          links: { submitRun: SUBMIT_RUN_URL, pullRequest: PULL_REQUEST_URL },
          polledAt: '2026-10-13T12:00:00.000Z'
        })
        .mockResolvedValueOnce({
          operationId: submitted.deployment.operationId,
          status: 'merged',
          pullRequestNumber: 7,
          mergeSha: 'merge-sha',
          mergedAt: '2026-10-13T12:01:00Z',
          links: { submitRun: SUBMIT_RUN_URL, pullRequest: PULL_REQUEST_URL },
          polledAt: '2026-10-13T12:01:00.000Z'
        })

      await poll(orchestrator, submitted)
      const view = await poll(orchestrator, submitted)
      const entry = await storedEntry(submitted.deployment._id)

      expect(view.status).toBe('merged')
      expect(view.links).toEqual({
        submitRun: SUBMIT_RUN_URL,
        pullRequest: PULL_REQUEST_URL
      })
      expect(entry.gitops).toMatchObject({
        pullRequestNumber: 7,
        pullRequestUrl: PULL_REQUEST_URL,
        mergeSha: 'merge-sha',
        mergedAt: '2026-10-13T12:01:00Z',
        lastPolledAt: '2026-10-13T12:01:00.000Z'
      })
      expect(await auditActions(submitted.deployment._id)).toEqual([
        ['teamDeployment.request', null, null],
        ['teamDeployment.transition', 'pr-raised', 'requested -> pr-raised'],
        ['teamDeployment.transition', 'merged', 'pr-raised -> merged']
      ])
    })

    test('records the last poll time even when the status has not moved', async () => {
      const orchestrator = fakeOrchestrator({
        getDeploymentStatus: vi.fn(async ({ operationId }) => ({
          operationId,
          status: 'requested',
          links: {},
          polledAt: '2026-10-13T12:02:00.000Z'
        }))
      })
      const submitted = await submitGithubDeployment(orchestrator)

      await poll(orchestrator, submitted)

      expect(
        (await storedEntry(submitted.deployment._id)).gitops.lastPolledAt
      ).toBe('2026-10-13T12:02:00.000Z')
    })

    test('activates with the run report resources and the model allowed', async () => {
      const orchestrator = fakeOrchestrator()
      const submitted = await submitGithubDeployment(orchestrator)
      const resources = { project: { id: 'resource-id-placeholder' } }

      orchestrator.getDeploymentStatus.mockResolvedValueOnce({
        operationId: submitted.deployment.operationId,
        status: 'deployed',
        applyRunId: 2002,
        appliedSha: 'merge-sha',
        resources,
        links: { applyRun: APPLY_RUN_URL }
      })
      await poll(orchestrator, submitted)
      orchestrator.getDeploymentStatus.mockResolvedValueOnce({
        operationId: submitted.deployment.operationId,
        status: 'active',
        links: { applyRun: APPLY_RUN_URL }
      })
      const view = await poll(orchestrator, submitted)

      const doc = await db
        .collection('teamDeployments')
        .findOne({ teamId: submitted.teamId })

      expect(view.status).toBe('active')
      expect(view.activatedAt).toEqual(expect.any(String))
      expect(doc.gateway.allowedDeployments).toEqual(['gpt-4o'])
      expect(doc.deployments[0].gitops).toMatchObject({
        applyRunId: 2002,
        applyRunUrl: APPLY_RUN_URL,
        appliedSha: 'merge-sha',
        resources
      })
    })

    test('keeps the last known status when GitHub cannot be read', async () => {
      const orchestrator = fakeOrchestrator({
        getDeploymentStatus: vi.fn(async () => {
          const error = new Error('rate limited')
          error.code = 'github-rate-limited'
          throw error
        })
      })
      const submitted = await submitGithubDeployment(orchestrator)
      const logger = fakeLogger()

      const view = await poll(orchestrator, submitted, logger)

      expect(view.status).toBe('requested')
      expect(logger.warn).toHaveBeenCalledWith(
        { code: 'github-rate-limited', operationId: view.operationId },
        expect.stringContaining('keeping the last known status')
      )
    })

    test('abandons the pull request once checks fail', async () => {
      const orchestrator = fakeOrchestrator()
      const submitted = await submitGithubDeployment(orchestrator)

      orchestrator.getDeploymentStatus.mockResolvedValueOnce({
        operationId: submitted.deployment.operationId,
        status: 'checks-failed',
        failureReason: 'The validate check failed on the pull request',
        pullRequestNumber: 7,
        links: { pullRequest: PULL_REQUEST_URL }
      })

      const view = await poll(orchestrator, submitted)
      const entry = await storedEntry(submitted.deployment._id)

      expect(view.failureReason).toBe(
        'The validate check failed on the pull request'
      )
      expect(orchestrator.requestDeployment).toHaveBeenLastCalledWith({
        environment: 'sandbox',
        path: 'environments/sandbox/alpha.json',
        document: null,
        operationId: entry.operationId,
        requestedBy: 'app:ai-platform-backend',
        expectedRevision: 1,
        action: 'abandon'
      })
      expect(entry.gitops.abandon).toMatchObject({ submitRunId: 1001 })
    })

    test('does not abandon a submit that failed before any pull request', async () => {
      const orchestrator = fakeOrchestrator()
      const submitted = await submitGithubDeployment(orchestrator)

      orchestrator.getDeploymentStatus.mockResolvedValueOnce({
        operationId: submitted.deployment.operationId,
        status: 'checks-failed',
        links: {}
      })

      await poll(orchestrator, submitted)

      expect(orchestrator.requestDeployment).toHaveBeenCalledTimes(1)
    })
  })

  describe('the D14 failure policy', () => {
    function failed(operationId, failure, extra = {}) {
      return {
        operationId,
        status: 'deploy-failed',
        failureReason: 'The apply workflow failed',
        links: { applyRun: APPLY_RUN_URL },
        failure: {
          observedAt: '2026-10-13T12:30:00Z',
          failingTeams: [],
          unattributedFailure: false,
          ...failure
        },
        ...extra
      }
    }

    async function deployingGithubDeployment(orchestrator, gitops = {}) {
      const submitted = await submitGithubDeployment(orchestrator)

      await setEntry(submitted.deployment._id, {
        status: 'deploying',
        'gitops.mergeSha': 'merge-sha',
        ...Object.fromEntries(
          Object.entries(gitops).map(([key, value]) => [`gitops.${key}`, value])
        )
      })

      return submitted
    }

    const retried = {
      dispatchedAt: '2026-10-13T12:00:00.000Z',
      reason: 'd14-retry',
      runId: 2002,
      runUrl: APPLY_RUN_URL
    }

    test('dispatches one fresh apply on the first failure and keeps deploying', async () => {
      const orchestrator = fakeOrchestrator()
      const submitted = await deployingGithubDeployment(orchestrator)

      orchestrator.getDeploymentStatus.mockResolvedValue(
        failed(submitted.deployment.operationId, { failingTeams: ['alpha'] })
      )

      const view = await poll(orchestrator, submitted)
      const entry = await storedEntry(submitted.deployment._id)

      expect(orchestrator.requestApply).toHaveBeenCalledTimes(1)
      expect(orchestrator.requestApply).toHaveBeenCalledWith({
        environment: 'sandbox',
        reason: `retry ${entry.operationId}`
      })
      expect(view.status).toBe('deploying')
      expect(entry.gitops.applyRetry).toEqual({
        claimedAt: expect.any(String),
        dispatchedAt: expect.any(String),
        reason: 'd14-retry',
        runId: 2002,
        runUrl: APPLY_RUN_URL
      })
    })

    test('dispatches the retry once when two polls see the failure at the same time', async () => {
      const orchestrator = fakeOrchestrator()
      const submitted = await deployingGithubDeployment(orchestrator)

      orchestrator.getDeploymentStatus.mockResolvedValue(
        failed(submitted.deployment.operationId, { failingTeams: ['alpha'] })
      )

      const views = await Promise.all([
        poll(orchestrator, submitted),
        poll(orchestrator, submitted)
      ])

      expect(orchestrator.requestApply).toHaveBeenCalledTimes(1)
      expect(views.map((view) => view.status)).toEqual([
        'deploying',
        'deploying'
      ])
    })

    test('waits while the failure GitHub reports predates the retry', async () => {
      const orchestrator = fakeOrchestrator()
      const submitted = await deployingGithubDeployment(orchestrator, {
        applyRetry: { ...retried, dispatchedAt: '2026-10-13T12:31:00.000Z' }
      })

      orchestrator.getDeploymentStatus.mockResolvedValue(
        failed(submitted.deployment.operationId, { failingTeams: ['alpha'] })
      )

      const view = await poll(orchestrator, submitted)

      expect(view.status).toBe('deploying')
      expect(orchestrator.requestApply).not.toHaveBeenCalled()
      expect(orchestrator.getPreviousDocument).not.toHaveBeenCalled()
    })

    test('reverts to the previous revision when the retry failed and this team is attributed', async () => {
      const previous = {
        ...alpha,
        revision: 1,
        operationId: 'previous-op-0001'
      }
      const orchestrator = fakeOrchestrator({
        getPreviousDocument: vi.fn(async () => ({ document: previous }))
      })
      const submitted = await deployingGithubDeployment(orchestrator, {
        applyRetry: retried
      })

      orchestrator.getDeploymentStatus.mockResolvedValue(
        failed(submitted.deployment.operationId, { failingTeams: ['alpha'] })
      )

      const view = await poll(orchestrator, submitted)
      const entry = await storedEntry(submitted.deployment._id)
      const revert = orchestrator.requestDeployment.mock.calls.at(-1)[0]

      expect(orchestrator.getPreviousDocument).toHaveBeenCalledWith({
        path: 'environments/sandbox/alpha.json',
        mergeSha: 'merge-sha'
      })
      expect(revert).toEqual({
        environment: 'sandbox',
        path: 'environments/sandbox/alpha.json',
        document: {
          ...previous,
          revision: 3,
          operationId: entry.gitops.revert.operationId,
          updatedAt: entry.gitops.revert.requestedAt,
          updatedBy: 'app:ai-platform-backend'
        },
        operationId: entry.gitops.revert.operationId,
        requestedBy: 'app:ai-platform-backend',
        expectedRevision: 2,
        action: 'write'
      })
      expect(revert.operationId).not.toBe(entry.operationId)
      expect(view.status).toBe('deploy-failed')
      expect(view.failureReason).toContain('reverted')
      expect(entry.gitops.revert).toMatchObject({
        action: 'write',
        submitRunId: 1001
      })
      expect(await auditActions(submitted.deployment._id)).toContainEqual([
        'teamDeployment.revert',
        'write',
        `revert operation ${entry.gitops.revert.operationId}`
      ])
    })

    test('removes a team file that did not exist before the operation', async () => {
      const orchestrator = fakeOrchestrator()
      const submitted = await deployingGithubDeployment(orchestrator, {
        applyRetry: retried
      })

      orchestrator.getDeploymentStatus.mockResolvedValue(
        failed(submitted.deployment.operationId, { failingTeams: ['alpha'] })
      )

      await poll(orchestrator, submitted)

      expect(orchestrator.requestDeployment.mock.calls.at(-1)[0]).toMatchObject(
        { action: 'remove', document: null, expectedRevision: 2 }
      )
    })

    test('keeps deploying and tries again later when the revert cannot be submitted', async () => {
      const orchestrator = fakeOrchestrator({
        getPreviousDocument: vi.fn(async () => {
          throw new Error('GitHub unavailable')
        })
      })
      const submitted = await deployingGithubDeployment(orchestrator, {
        applyRetry: retried
      })
      const logger = fakeLogger()

      orchestrator.getDeploymentStatus.mockResolvedValue(
        failed(submitted.deployment.operationId, { failingTeams: ['alpha'] })
      )

      const view = await poll(orchestrator, submitted, logger)
      const { revert } = (await storedEntry(submitted.deployment._id)).gitops

      expect(view.status).toBe('deploying')
      // Released for the next poll, which submits the same operation.
      expect(revert).toEqual({
        operationId: expect.any(String),
        requestedAt: expect.any(String),
        action: null,
        claimedAt: null
      })
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ operationId: view.operationId }),
        expect.stringContaining('revert could not be submitted')
      )

      orchestrator.getPreviousDocument.mockResolvedValue({ document: null })
      await poll(orchestrator, submitted, logger)

      expect(orchestrator.requestDeployment.mock.calls.at(-1)[0]).toMatchObject(
        { operationId: revert.operationId, action: 'remove' }
      )
    })

    test('alerts engineers and fails when the retry failed unattributed', async () => {
      const orchestrator = fakeOrchestrator()
      const submitted = await deployingGithubDeployment(orchestrator, {
        applyRetry: retried
      })
      const logger = fakeLogger()

      orchestrator.getDeploymentStatus.mockResolvedValue(
        failed(submitted.deployment.operationId, { unattributedFailure: true })
      )

      const view = await poll(orchestrator, submitted, logger)

      expect(view.status).toBe('deploy-failed')
      expect(view.failureReason).toContain('platform engineers')
      expect(logger.error).toHaveBeenCalledWith(
        { operationId: view.operationId, environment: 'sandbox' },
        'Unattributed tenants apply failure needs a platform engineer'
      )
      expect(await auditActions(submitted.deployment._id)).toContainEqual([
        'teamDeployment.deployFailed',
        'unattributed-failure',
        null
      ])
      expect(orchestrator.requestDeployment).toHaveBeenCalledTimes(1)
    })

    test('waits for another team’s revert when only that team is attributed', async () => {
      const orchestrator = fakeOrchestrator()
      const submitted = await deployingGithubDeployment(orchestrator, {
        applyRetry: retried
      })

      orchestrator.getDeploymentStatus.mockResolvedValue(
        failed(submitted.deployment.operationId, { failingTeams: ['beta'] })
      )

      const view = await poll(orchestrator, submitted)

      expect(view.status).toBe('deploying')
      expect(orchestrator.requestDeployment).toHaveBeenCalledTimes(1)
    })

    test('tries the retry again on the next poll when its dispatch fails', async () => {
      const orchestrator = fakeOrchestrator({
        requestApply: vi.fn(async () => {
          throw new Error('GitHub unavailable')
        })
      })
      const submitted = await deployingGithubDeployment(orchestrator)

      orchestrator.getDeploymentStatus.mockResolvedValue(
        failed(submitted.deployment.operationId, { failingTeams: ['alpha'] })
      )

      const view = await poll(orchestrator, submitted, fakeLogger())

      expect(view.status).toBe('deploying')
      expect(
        (await storedEntry(submitted.deployment._id)).gitops.applyRetry
      ).toEqual({ claimedAt: null, reason: 'd14-retry' })

      orchestrator.requestApply.mockResolvedValue({
        runId: 2002,
        runUrl: APPLY_RUN_URL
      })
      await poll(orchestrator, submitted, fakeLogger())

      expect(orchestrator.requestApply).toHaveBeenCalledTimes(2)
      expect(
        (await storedEntry(submitted.deployment._id)).gitops.applyRetry
      ).toMatchObject({ dispatchedAt: expect.any(String), runId: 2002 })
    })
  })

  describe('redispatchApply', () => {
    let adminId

    beforeAll(async () => {
      const { insertedId } = await db.collection('users').insertOne({
        email: 'gitops-platform-admin@defra.gov.uk',
        displayName: 'Platform Admin',
        roles: ['research-user', 'platform-admin']
      })

      adminId = insertedId.toString()
    })

    test('refuses anyone who is not a Platform Admin', async () => {
      const orchestrator = fakeOrchestrator()
      const { deployment } = await submitGithubDeployment(orchestrator)

      await expect(
        service.redispatchApply(
          db,
          { id: deployment._id, actorUserId: 'gitops-user', kind: 'retry' },
          { registry: githubRegistry(orchestrator) }
        )
      ).rejects.toMatchObject({
        output: { statusCode: 403 },
        data: { code: 'platform-admin-required' }
      })
    })

    test('retries only a failed deployment', async () => {
      const orchestrator = fakeOrchestrator()
      const { deployment } = await submitGithubDeployment(orchestrator)

      await expect(
        service.redispatchApply(
          db,
          { id: deployment._id, actorUserId: adminId, kind: 'retry' },
          { registry: githubRegistry(orchestrator) }
        )
      ).rejects.toMatchObject({ data: { code: 'deployment-not-retryable' } })
      expect(orchestrator.requestApply).not.toHaveBeenCalled()
    })

    test('retries a failed deployment with a fresh apply and resumes polling it', async () => {
      const orchestrator = fakeOrchestrator()
      const { deployment } = await submitGithubDeployment(orchestrator)

      await setEntry(deployment._id, {
        status: 'deploy-failed',
        failureReason: 'The apply workflow failed'
      })

      const view = await service.redispatchApply(
        db,
        { id: deployment._id, actorUserId: adminId, kind: 'retry' },
        { registry: githubRegistry(orchestrator) }
      )
      const entry = await storedEntry(deployment._id)

      expect(orchestrator.requestApply).toHaveBeenCalledWith({
        environment: 'sandbox',
        reason: `retry ${entry.operationId}`
      })
      expect(view.status).toBe('deploying')
      expect(entry.status).toBe('deploying')
      expect(entry.failureReason).toBeNull()
      expect(entry.gitops.applyRetry).toMatchObject({
        reason: 'retry',
        runId: 2002
      })
      expect(
        await db.collection('auditEvents').findOne({
          resourceId: deployment._id,
          action: 'teamDeployment.retry'
        })
      ).toMatchObject({ actorUserId: adminId, outcome: 'success' })
    })

    test('dispatches one apply when two retries race, and audits only that one', async () => {
      const orchestrator = fakeOrchestrator()
      const { deployment } = await submitGithubDeployment(orchestrator)

      await setEntry(deployment._id, {
        status: 'deploy-failed',
        failureReason: 'The apply workflow failed'
      })

      const views = await Promise.all(
        [1, 2].map(() =>
          service.redispatchApply(
            db,
            { id: deployment._id, actorUserId: adminId, kind: 'retry' },
            { registry: githubRegistry(orchestrator) }
          )
        )
      )

      expect(orchestrator.requestApply).toHaveBeenCalledTimes(1)
      expect(views.map((view) => view.status)).toEqual([
        'deploying',
        'deploying'
      ])
      expect(
        await db.collection('auditEvents').countDocuments({
          resourceId: deployment._id,
          action: 'teamDeployment.retry'
        })
      ).toBe(1)
    })

    test('puts a failed deployment back when GitHub refuses its retry', async () => {
      const orchestrator = fakeOrchestrator({
        requestApply: vi.fn(async () => {
          throw new Error('GitHub unavailable')
        })
      })
      const { deployment } = await submitGithubDeployment(orchestrator)

      await setEntry(deployment._id, {
        status: 'deploy-failed',
        failureReason: 'The apply workflow failed'
      })

      await expect(
        service.redispatchApply(
          db,
          { id: deployment._id, actorUserId: adminId, kind: 'retry' },
          { registry: githubRegistry(orchestrator) }
        )
      ).rejects.toMatchObject({ data: { code: 'upstream-unavailable' } })
      expect(await storedEntry(deployment._id)).toMatchObject({
        status: 'deploy-failed',
        failureReason: 'The apply workflow failed',
        gitops: expect.objectContaining({ applyRetry: null })
      })
    })

    test('reconciles a deployment with no GitOps trail without claiming anything', async () => {
      const orchestrator = fakeOrchestrator()
      const { deployment } = await submitGithubDeployment(orchestrator)

      await setEntry(deployment._id, { status: 'active', gitops: null })

      const view = await service.redispatchApply(
        db,
        { id: deployment._id, actorUserId: adminId, kind: 'reconcile' },
        { registry: githubRegistry(orchestrator) }
      )

      expect(orchestrator.requestApply).toHaveBeenCalledTimes(1)
      expect(view).toMatchObject({ status: 'active', links: {} })
    })

    test('reconciles any deployment without changing its status', async () => {
      const orchestrator = fakeOrchestrator()
      const { deployment } = await submitGithubDeployment(orchestrator)

      await setEntry(deployment._id, { status: 'active' })

      const view = await service.redispatchApply(
        db,
        { id: deployment._id, actorUserId: adminId, kind: 'reconcile' },
        { registry: githubRegistry(orchestrator) }
      )

      expect(view.status).toBe('active')
      expect((await storedEntry(deployment._id)).gitops.applyRetry.reason).toBe(
        'reconcile'
      )
    })

    test('reports and audits a dispatch GitHub refused', async () => {
      const orchestrator = fakeOrchestrator({
        requestApply: vi.fn(async () => {
          throw new Error('GitHub unavailable')
        })
      })
      const { deployment } = await submitGithubDeployment(orchestrator)

      await expect(
        service.redispatchApply(
          db,
          { id: deployment._id, actorUserId: adminId, kind: 'reconcile' },
          { registry: githubRegistry(orchestrator) }
        )
      ).rejects.toMatchObject({
        output: { statusCode: 502 },
        data: { code: 'upstream-unavailable' }
      })
      expect(
        await db.collection('auditEvents').findOne({
          resourceId: deployment._id,
          action: 'teamDeployment.reconcile'
        })
      ).toMatchObject({ outcome: 'failure', code: 'upstream-unavailable' })
    })

    test('returns 404 for an unknown deployment', async () => {
      await expect(
        service.redispatchApply(db, {
          id: 'no-such-deployment',
          actorUserId: adminId,
          kind: 'reconcile'
        })
      ).rejects.toMatchObject({ output: { statusCode: 404 } })
    })
  })
})

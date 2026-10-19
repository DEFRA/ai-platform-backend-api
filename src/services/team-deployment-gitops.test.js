import { randomUUID } from 'node:crypto'

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

describe('team-deployment-gitops', () => {
  let server
  let db
  let gitops

  beforeAll(async () => {
    // Dynamic import needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')

    server = await createServer()
    await server.initialize()
    db = server.db
    gitops = await import('#/services/team-deployment-gitops.js')
  })

  afterAll(async () => {
    await server.stop({ timeout: 0 })
  })

  // A GitHub-mode entry, as `requestDeployment` stores it once submitted,
  // in a team document of its own.
  function githubEntry({ gitops: trail = {}, ...fields } = {}) {
    return {
      id: randomUUID(),
      modelSlug: 'gpt-4o',
      status: 'requested',
      operationId: randomUUID(),
      orchestrator: 'github',
      gitops: {
        path: 'environments/sandbox/alpha.json',
        branch: 'op/sweep',
        action: 'write',
        expectedRevision: 1,
        submitRunId: 1001,
        submitRunUrl: SUBMIT_RUN_URL,
        ...trail
      },
      ...fields
    }
  }

  async function insertDocument(...deployments) {
    const doc = {
      teamId: `gitops-team-${randomUUID()}`,
      environment: 'sandbox',
      deployments
    }
    const { insertedId } = await db.collection('teamDeployments').insertOne(doc)

    return { ...doc, _id: insertedId }
  }

  async function storedEntry(id) {
    const doc = await db
      .collection('teamDeployments')
      .findOne({ 'deployments.id': id })

    return doc?.deployments.find((entry) => entry.id === id) ?? null
  }

  async function auditEvents(entry) {
    return db
      .collection('auditEvents')
      .find({ resourceId: entry.id })
      .sort({ at: 1 })
      .toArray()
  }

  function refresh(orchestrator, doc, entry, deps = {}) {
    return gitops.refreshEntryStatus(db, doc, entry, {
      registry: githubRegistry(orchestrator),
      pollMinIntervalMs: 0,
      ...deps
    })
  }

  // Older than the claim lease and the poll interval; and now.
  const anHourAgo = () => new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const justNow = () => new Date().toISOString()

  // A failed apply this team's change is attributed to, after the D14 retry.
  function failedApply(entry) {
    return {
      operationId: entry.operationId,
      status: 'deploy-failed',
      failureReason: 'The apply workflow failed',
      links: {},
      failure: {
        observedAt: '2026-10-13T12:30:00Z',
        failingTeams: ['alpha'],
        unattributedFailure: false
      }
    }
  }

  const retried = {
    claimedAt: '2026-10-13T11:59:59.000Z',
    dispatchedAt: '2026-10-13T12:00:00.000Z',
    reason: 'd14-retry',
    runId: 2002,
    runUrl: 'https://github.com/DEFRA/ai-platform-tenants/actions/runs/2002'
  }

  describe('the poll window', () => {
    test('reads GitHub once when two polls race inside the minimum interval', async () => {
      const orchestrator = fakeOrchestrator()
      const entry = githubEntry()
      const doc = await insertDocument(entry)

      const refreshed = await Promise.all([
        refresh(orchestrator, doc, entry, { pollMinIntervalMs: 60000 }),
        refresh(orchestrator, doc, entry, { pollMinIntervalMs: 60000 })
      ])

      expect(orchestrator.getDeploymentStatus).toHaveBeenCalledTimes(1)
      expect(refreshed.map(({ status }) => status)).toEqual([
        'requested',
        'requested'
      ])
      expect((await storedEntry(entry.id)).gitops.lastPolledAt).toEqual(
        expect.any(String)
      )
    })

    test('does not poll inside the minimum interval, and polls once it has passed', async () => {
      const orchestrator = fakeOrchestrator()
      const entry = githubEntry({ gitops: { lastPolledAt: justNow() } })
      const doc = await insertDocument(entry)

      await refresh(orchestrator, doc, entry, { pollMinIntervalMs: 60000 })

      expect(orchestrator.getDeploymentStatus).not.toHaveBeenCalled()

      await db
        .collection('teamDeployments')
        .updateOne(
          { _id: doc._id, 'deployments.id': entry.id },
          { $set: { 'deployments.$.gitops.lastPolledAt': anHourAgo() } }
        )
      await refresh(orchestrator, doc, await storedEntry(entry.id), {
        pollMinIntervalMs: 60000
      })

      expect(orchestrator.getDeploymentStatus).toHaveBeenCalledTimes(1)
    })

    test('activates a verified entry inside the minimum interval, since activation reads nothing', async () => {
      const orchestrator = fakeOrchestrator()
      const entry = githubEntry({
        status: 'verified',
        gitops: { lastPolledAt: justNow() }
      })
      const doc = await insertDocument(entry)

      orchestrator.getDeploymentStatus.mockResolvedValue({
        operationId: entry.operationId,
        status: 'active',
        links: {}
      })

      const refreshed = await refresh(orchestrator, doc, entry, {
        pollMinIntervalMs: 60000
      })

      expect(refreshed.status).toBe('active')
    })
  })

  describe('claim leases', () => {
    test('claims a D14 retry again once a claim that never dispatched outlives its lease', async () => {
      const orchestrator = fakeOrchestrator()
      const entry = githubEntry({
        status: 'deploying',
        gitops: {
          mergeSha: 'merge-sha',
          applyRetry: { claimedAt: anHourAgo(), reason: 'd14-retry' }
        }
      })
      const doc = await insertDocument(entry)

      orchestrator.getDeploymentStatus.mockResolvedValue(failedApply(entry))
      orchestrator.requestApply.mockResolvedValue({ runId: 2002, runUrl: null })

      await refresh(orchestrator, doc, entry)

      expect(orchestrator.requestApply).toHaveBeenCalledTimes(1)
      expect((await storedEntry(entry.id)).gitops.applyRetry).toMatchObject({
        dispatchedAt: expect.any(String),
        runId: 2002
      })
    })

    test('leaves a claim inside its lease to the poll that holds it', async () => {
      const orchestrator = fakeOrchestrator()
      const entry = githubEntry({
        status: 'deploying',
        gitops: {
          mergeSha: 'merge-sha',
          applyRetry: { claimedAt: justNow(), reason: 'd14-retry' }
        }
      })
      const doc = await insertDocument(entry)

      orchestrator.getDeploymentStatus.mockResolvedValue(failedApply(entry))

      const refreshed = await refresh(orchestrator, doc, entry)

      expect(orchestrator.requestApply).not.toHaveBeenCalled()
      expect(refreshed.status).toBe('deploying')
    })

    test('reclaims a revert that never dispatched under the same operation ID', async () => {
      const orchestrator = fakeOrchestrator()
      const entry = githubEntry({
        status: 'deploying',
        gitops: {
          mergeSha: 'merge-sha',
          revision: 2,
          applyRetry: retried,
          revert: {
            operationId: 'stale-revert-op',
            requestedAt: '2026-10-13T12:40:00.000Z',
            action: null,
            claimedAt: anHourAgo()
          }
        }
      })
      const doc = await insertDocument(entry)

      orchestrator.getDeploymentStatus.mockResolvedValue(failedApply(entry))
      orchestrator.getPreviousDocument.mockResolvedValue({ document: null })

      const refreshed = await refresh(orchestrator, doc, entry)

      expect(orchestrator.requestDeployment).toHaveBeenCalledTimes(1)
      expect(orchestrator.requestDeployment).toHaveBeenCalledWith(
        expect.objectContaining({
          operationId: 'stale-revert-op',
          action: 'remove'
        })
      )
      expect(refreshed.status).toBe('deploy-failed')
      expect((await storedEntry(entry.id)).gitops.revert).toMatchObject({
        operationId: 'stale-revert-op',
        requestedAt: '2026-10-13T12:40:00.000Z',
        dispatchedAt: expect.any(String),
        status: 'requested'
      })
    })

    test('leaves a revert claim inside its lease to the poll that holds it', async () => {
      const orchestrator = fakeOrchestrator()
      const entry = githubEntry({
        status: 'deploying',
        gitops: {
          mergeSha: 'merge-sha',
          applyRetry: retried,
          revert: {
            operationId: 'held-revert-op',
            requestedAt: justNow(),
            action: null,
            claimedAt: justNow()
          }
        }
      })
      const doc = await insertDocument(entry)

      orchestrator.getDeploymentStatus.mockResolvedValue(failedApply(entry))

      const refreshed = await refresh(orchestrator, doc, entry)

      expect(orchestrator.requestDeployment).not.toHaveBeenCalled()
      expect(refreshed.status).toBe('deploying')
    })

    test('does not submit a revert twice when a poll stopped before recording its outcome', async () => {
      const orchestrator = fakeOrchestrator()
      const entry = githubEntry({
        status: 'deploying',
        gitops: {
          mergeSha: 'merge-sha',
          applyRetry: retried,
          revert: {
            operationId: 'dispatched-revert-op',
            requestedAt: '2026-10-13T12:40:00.000Z',
            action: 'remove',
            claimedAt: '2026-10-13T12:40:00.000Z',
            dispatchedAt: '2026-10-13T12:40:01.000Z',
            status: 'requested'
          }
        }
      })
      const doc = await insertDocument(entry)

      orchestrator.getDeploymentStatus.mockResolvedValue(failedApply(entry))

      const refreshed = await refresh(orchestrator, doc, entry)

      expect(orchestrator.requestDeployment).not.toHaveBeenCalled()
      expect(refreshed).toMatchObject({
        status: 'deploy-failed',
        failureReason: expect.stringContaining('being reverted')
      })
    })
  })

  describe('reverts', () => {
    function revertingEntry() {
      return githubEntry({
        status: 'deploy-failed',
        failureReason:
          'The apply failed again after a fresh retry, so the change is being reverted',
        gitops: {
          revert: {
            operationId: 'revert-op',
            requestedAt: '2026-10-13T12:40:00.000Z',
            action: 'write',
            claimedAt: '2026-10-13T12:40:00.000Z',
            dispatchedAt: '2026-10-13T12:40:01.000Z',
            status: 'requested',
            submitRunId: 3003,
            submitRunUrl:
              'https://github.com/DEFRA/ai-platform-tenants/actions/runs/3003'
          }
        }
      })
    }

    test('follows a dispatched revert to its end, then flags the entry and alerts when it fails', async () => {
      const orchestrator = fakeOrchestrator()
      const logger = { warn: vi.fn(), error: vi.fn() }
      const entry = revertingEntry()
      const doc = await insertDocument(entry)

      orchestrator.getDeploymentStatus
        .mockResolvedValueOnce({
          operationId: 'revert-op',
          status: 'pr-raised',
          pullRequestNumber: 8,
          links: {}
        })
        .mockResolvedValueOnce({
          operationId: 'revert-op',
          status: 'checks-failed',
          failureReason: 'The validate check failed on the pull request',
          links: {}
        })

      await refresh(orchestrator, doc, entry, { logger })

      expect(orchestrator.getDeploymentStatus).toHaveBeenCalledWith({
        operationId: 'revert-op',
        status: 'requested',
        environment: 'sandbox',
        createdAt: '2026-10-13T12:40:01.000Z',
        gitops: expect.objectContaining({
          path: 'environments/sandbox/alpha.json',
          action: 'write',
          submitRunId: 3003
        })
      })
      expect((await storedEntry(entry.id)).gitops.revert).toMatchObject({
        status: 'pr-raised',
        pullRequestNumber: 8
      })

      const failed = await refresh(
        orchestrator,
        doc,
        await storedEntry(entry.id),
        { logger }
      )

      expect(failed.failureReason).toContain('reverting the change failed')
      expect(await storedEntry(entry.id)).toMatchObject({
        status: 'deploy-failed',
        failureReason: failed.failureReason,
        gitops: expect.objectContaining({
          revert: expect.objectContaining({ status: 'checks-failed' })
        })
      })
      expect(
        (await auditEvents(entry)).map(({ action, outcome, code }) => [
          action,
          outcome,
          code
        ])
      ).toContainEqual([
        'teamDeployment.revertFailed',
        'failure',
        'checks-failed'
      ])
      expect(logger.error).toHaveBeenCalledWith(
        {
          operationId: entry.operationId,
          followUpOperationId: 'revert-op',
          environment: 'sandbox',
          status: 'checks-failed'
        },
        'The revert ended checks-failed and needs a platform engineer'
      )

      // A failed revert is final: nothing polls or resubmits it again.
      await refresh(orchestrator, doc, await storedEntry(entry.id), { logger })

      expect(orchestrator.getDeploymentStatus).toHaveBeenCalledTimes(2)
      expect(orchestrator.requestDeployment).not.toHaveBeenCalled()
    })

    test('keeps a failed revert whose pull request stays open holding the team file until an engineer closes it', async () => {
      const orchestrator = fakeOrchestrator()
      const logger = { warn: vi.fn(), error: vi.fn() }
      const entry = revertingEntry()
      const queued = githubEntry({
        status: 'queued',
        requestedBy: 'queue-user',
        requestedByPrincipal: 'entra:00000000-0000-0000-0000-000000000001'
      })
      queued.gitops = null
      await insertDocument(entry, queued)
      const settings = {
        registry: githubRegistry(orchestrator),
        logger,
        pollMinIntervalMs: 0,
        buildDesiredState: async (_, { environment, operationId }) => ({
          document: {
            environment,
            operationId,
            revision: 1,
            team: { slug: 'alpha' }
          },
          expectedRevision: 0
        })
      }

      // The revert's validate failed; its pull request is left open. Any
      // other operation polled meanwhile is simply still requested.
      const revertStatus =
        (status) =>
        async ({ operationId }) =>
          operationId === 'revert-op'
            ? { operationId, pullRequestNumber: 8, links: {}, ...status }
            : { operationId, status: 'requested', links: {} }

      orchestrator.getDeploymentStatus.mockImplementation(
        revertStatus({
          status: 'checks-failed',
          failureReason: 'The validate check failed on the pull request',
          pullRequestOpen: true
        })
      )

      await gitops.sweepGitopsDeployments(db, settings)
      await gitops.sweepGitopsDeployments(db, settings)

      expect((await storedEntry(entry.id)).gitops.revert).toMatchObject({
        status: 'checks-failed',
        pullRequestOpen: true
      })
      expect((await storedEntry(queued.id)).status).toBe('queued')
      expect(orchestrator.requestDeployment).not.toHaveBeenCalled()

      // An engineer closes the pull request: the file is free.
      orchestrator.getDeploymentStatus.mockImplementation(
        revertStatus({
          status: 'checks-failed',
          failureReason: 'The pull request was closed without being merged',
          pullRequestOpen: false
        })
      )

      await gitops.sweepGitopsDeployments(db, settings)
      await gitops.sweepGitopsDeployments(db, settings)

      expect((await storedEntry(queued.id)).status).toBe('requested')
      expect(orchestrator.requestDeployment).toHaveBeenCalledWith(
        expect.objectContaining({ operationId: queued.operationId })
      )
    })

    test('records a revert that completes and leaves the entry as it was', async () => {
      const orchestrator = fakeOrchestrator()
      const entry = revertingEntry()
      const doc = await insertDocument(entry)

      orchestrator.getDeploymentStatus.mockResolvedValue({
        operationId: 'revert-op',
        status: 'active',
        links: {}
      })

      const refreshed = await refresh(orchestrator, doc, entry)

      expect(refreshed.failureReason).toBe(entry.failureReason)
      expect(refreshed.gitops.revert.status).toBe('active')
      expect(
        (await auditEvents(entry)).map(({ action, outcome }) => [
          action,
          outcome
        ])
      ).toContainEqual(['teamDeployment.revertCompleted', 'success'])
    })

    test('keeps a revert’s last known status when its poll fails', async () => {
      const orchestrator = fakeOrchestrator()
      const logger = { warn: vi.fn(), error: vi.fn() }
      const entry = revertingEntry()
      const doc = await insertDocument(entry)

      orchestrator.getDeploymentStatus.mockRejectedValue(
        new Error('GitHub unavailable')
      )

      const refreshed = await refresh(orchestrator, doc, entry, { logger })

      expect(refreshed.gitops.revert.status).toBe('requested')
      expect(logger.warn).toHaveBeenCalledWith(
        {
          code: null,
          status: null,
          message: 'GitHub unavailable',
          operationId: entry.operationId
        },
        'The revert status poll failed, keeping its last known status'
      )
    })

    test('writes nothing for a revert poll that read nothing new', async () => {
      const orchestrator = fakeOrchestrator()
      const entry = revertingEntry()
      const doc = await insertDocument(entry)

      const refreshed = await refresh(orchestrator, doc, entry)

      expect(orchestrator.getDeploymentStatus).toHaveBeenCalledTimes(1)
      expect(refreshed).toBe(entry)
    })

    test('does not poll a revert again inside the minimum interval', async () => {
      const orchestrator = fakeOrchestrator()
      const entry = revertingEntry()

      entry.gitops.revert.lastPolledAt = justNow()

      const doc = await insertDocument(entry)
      const refreshed = await refresh(orchestrator, doc, entry, {
        pollMinIntervalMs: 60000
      })

      expect(orchestrator.getDeploymentStatus).not.toHaveBeenCalled()
      expect(refreshed.gitops.revert.status).toBe('requested')
    })

    test('never overwrites a newer revert status with a slower poll’s', async () => {
      const orchestrator = fakeOrchestrator()
      const entry = revertingEntry()
      const doc = await insertDocument({
        ...entry,
        gitops: {
          ...entry.gitops,
          revert: { ...entry.gitops.revert, status: 'merged' }
        }
      })

      orchestrator.getDeploymentStatus.mockResolvedValue({
        operationId: 'revert-op',
        status: 'pr-raised',
        links: {}
      })

      // This poll read the revert while it was still `requested`.
      const refreshed = await refresh(orchestrator, doc, entry)

      expect(refreshed.gitops.revert.status).toBe('merged')
      expect((await storedEntry(entry.id)).gitops.revert.status).toBe('merged')
    })
  })

  describe('sweepGitopsDeployments', () => {
    beforeEach(async () => {
      // The sweep reads every GitHub-mode operation; start from none.
      await db
        .collection('teamDeployments')
        .deleteMany({ 'deployments.orchestrator': 'github' })
    })

    test('polls only GitHub operations that are still in progress', async () => {
      const orchestrator = fakeOrchestrator()
      const inProgress = githubEntry()

      await insertDocument(
        inProgress,
        { id: 'mock-sibling', status: 'requested', orchestrator: 'mock' },
        githubEntry({ status: 'active' })
      )
      await insertDocument(githubEntry({ status: 'active' }))
      await insertDocument({
        id: 'mock-entry',
        status: 'requested',
        orchestrator: 'mock'
      })
      orchestrator.getDeploymentStatus.mockImplementation(
        async ({ operationId }) => ({
          operationId,
          status: 'pr-raised',
          links: {}
        })
      )

      const result = await gitops.sweepGitopsDeployments(db, {
        registry: githubRegistry(orchestrator)
      })

      expect(result).toEqual({ polled: 1, transitioned: 1, abandoned: 0 })
      expect(
        orchestrator.getDeploymentStatus.mock.calls.map(([entry]) => entry.id)
      ).toEqual([inProgress.id])
      expect((await storedEntry(inProgress.id)).status).toBe('pr-raised')
    })

    test('retries an abandon that could not be submitted', async () => {
      const orchestrator = fakeOrchestrator()
      const failed = githubEntry({
        status: 'checks-failed',
        gitops: { pullRequestNumber: 7 }
      })

      await insertDocument(failed)

      const result = await gitops.sweepGitopsDeployments(db, {
        registry: githubRegistry(orchestrator)
      })

      expect(result).toEqual({ polled: 0, transitioned: 0, abandoned: 1 })
      expect(orchestrator.requestDeployment.mock.calls.at(-1)[0].action).toBe(
        'abandon'
      )
    })

    test('dispatches a queued request nobody is polling once the team file is free', async () => {
      const orchestrator = fakeOrchestrator()
      const queued = githubEntry({
        status: 'queued',
        requestedBy: 'queue-user',
        requestedByPrincipal: 'entra:00000000-0000-0000-0000-000000000001'
      })

      // A queued request has no GitOps trail until it is dispatched.
      queued.gitops = null
      await insertDocument(githubEntry({ status: 'active' }), queued)

      const result = await gitops.sweepGitopsDeployments(db, {
        registry: githubRegistry(orchestrator),
        buildDesiredState: async (_, { environment, operationId }) => ({
          document: {
            environment,
            operationId,
            revision: 1,
            team: { slug: 'alpha' }
          },
          expectedRevision: 0
        })
      })

      expect(result).toEqual({ polled: 1, transitioned: 1, abandoned: 0 })
      expect(orchestrator.requestDeployment).toHaveBeenCalledWith(
        expect.objectContaining({
          operationId: queued.operationId,
          requestedBy: 'entra:00000000-0000-0000-0000-000000000001'
        })
      )
      expect((await storedEntry(queued.id)).status).toBe('requested')
    })

    test('fails a queued request its builder refuses for good, so the next one is not stuck behind it', async () => {
      const { boomWithCode, Boom } =
        await import('#/common/helpers/boom-with-code.js')
      const orchestrator = fakeOrchestrator()
      const ineligible = githubEntry({
        status: 'queued',
        modelSlug: 'no-team-sku',
        requestedByPrincipal: 'entra:00000000-0000-0000-0000-000000000001'
      })
      const valid = githubEntry({
        status: 'queued',
        modelSlug: 'gpt-4o',
        requestedByPrincipal: 'entra:00000000-0000-0000-0000-000000000002'
      })
      ineligible.gitops = null
      valid.gitops = null
      await insertDocument(githubEntry({ status: 'active' }), ineligible, valid)

      const settings = {
        registry: githubRegistry(orchestrator),
        pollMinIntervalMs: 0,
        buildDesiredState: async (
          _,
          { modelSlug, environment, operationId }
        ) => {
          if (modelSlug === 'no-team-sku') {
            throw boomWithCode(
              Boom.forbidden,
              'Model has no team tier SKU in the catalogue',
              'model-not-eligible'
            )
          }

          return {
            document: {
              environment,
              operationId,
              revision: 1,
              team: { slug: 'alpha' }
            },
            expectedRevision: 0
          }
        }
      }

      await gitops.sweepGitopsDeployments(db, settings)

      // The refused request fails for good and, in the same sweep, the file
      // is free for the valid one behind it.
      expect(await storedEntry(ineligible.id)).toMatchObject({
        status: 'checks-failed',
        failureReason: 'Model has no team tier SKU in the catalogue'
      })
      expect((await storedEntry(valid.id)).status).toBe('requested')
      expect(orchestrator.requestDeployment).toHaveBeenCalledTimes(1)
      expect(orchestrator.requestDeployment).toHaveBeenCalledWith(
        expect.objectContaining({ operationId: valid.operationId })
      )
    })

    test('abandons once when two sweeps race', async () => {
      const orchestrator = fakeOrchestrator()

      await insertDocument(
        githubEntry({
          status: 'checks-failed',
          gitops: { pullRequestNumber: 7 }
        })
      )

      await Promise.all([
        gitops.sweepGitopsDeployments(db, {
          registry: githubRegistry(orchestrator)
        }),
        gitops.sweepGitopsDeployments(db, {
          registry: githubRegistry(orchestrator)
        })
      ])

      expect(orchestrator.requestDeployment).toHaveBeenCalledTimes(1)
    })

    test('clears a failed abandon so the next sweep tries again', async () => {
      const orchestrator = fakeOrchestrator()
      const failed = githubEntry({
        status: 'checks-failed',
        gitops: { pullRequestNumber: 7 }
      })

      await insertDocument(failed)
      orchestrator.requestDeployment.mockRejectedValueOnce(
        new Error('GitHub unavailable')
      )

      await gitops.sweepGitopsDeployments(db, {
        registry: githubRegistry(orchestrator),
        logger: { warn: vi.fn(), error: vi.fn() }
      })

      expect((await storedEntry(failed.id)).gitops.abandon).toEqual({
        claimedAt: null
      })

      const retried = await gitops.sweepGitopsDeployments(db, {
        registry: githubRegistry(orchestrator)
      })

      expect(retried.abandoned).toBe(1)
      expect(orchestrator.requestDeployment).toHaveBeenCalledTimes(2)
    })

    test('claims an abandon again only once a claim that never dispatched outlives its lease', async () => {
      const orchestrator = fakeOrchestrator()
      const held = githubEntry({
        status: 'checks-failed',
        gitops: { pullRequestNumber: 7, abandon: { claimedAt: justNow() } }
      })
      const stale = githubEntry({
        status: 'checks-failed',
        gitops: { pullRequestNumber: 7, abandon: { claimedAt: anHourAgo() } }
      })

      await insertDocument(held)
      await insertDocument(stale)

      const result = await gitops.sweepGitopsDeployments(db, {
        registry: githubRegistry(orchestrator)
      })

      expect(result).toEqual({ polled: 0, transitioned: 0, abandoned: 1 })
      expect(orchestrator.requestDeployment).toHaveBeenCalledWith(
        expect.objectContaining({
          operationId: stale.operationId,
          action: 'abandon'
        })
      )
      expect((await storedEntry(stale.id)).gitops.abandon).toMatchObject({
        action: 'abandon',
        dispatchedAt: expect.any(String),
        status: 'requested',
        submitRunId: 1001
      })
    })

    test('follows a dispatched abandon to its end and alerts when it fails', async () => {
      const orchestrator = fakeOrchestrator()
      const logger = { warn: vi.fn(), error: vi.fn() }
      const abandoning = githubEntry({
        status: 'checks-failed',
        gitops: {
          pullRequestNumber: 7,
          abandon: {
            claimedAt: '2026-10-13T12:40:00.000Z',
            action: 'abandon',
            submitRunId: 4004,
            submitRunUrl: SUBMIT_RUN_URL,
            dispatchedAt: '2026-10-13T12:40:01.000Z',
            status: 'requested'
          }
        }
      })

      await insertDocument(abandoning)
      orchestrator.getDeploymentStatus.mockResolvedValue({
        operationId: abandoning.operationId,
        status: 'checks-failed',
        failureReason: 'The submit workflow could not abandon the pull request',
        links: {}
      })

      const deps = { registry: githubRegistry(orchestrator), logger }
      const result = await gitops.sweepGitopsDeployments(db, deps)

      expect(result).toEqual({ polled: 1, transitioned: 0, abandoned: 0 })
      expect(orchestrator.getDeploymentStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          operationId: abandoning.operationId,
          gitops: expect.objectContaining({
            action: 'abandon',
            submitRunId: 4004
          })
        })
      )
      expect((await storedEntry(abandoning.id)).gitops.abandon.status).toBe(
        'checks-failed'
      )
      expect(
        (await auditEvents(abandoning)).map(({ action }) => action)
      ).toContain('teamDeployment.abandonFailed')
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'checks-failed' }),
        'The abandon ended checks-failed and needs a platform engineer'
      )

      // Never retried: the next sweep leaves it alone.
      expect(await gitops.sweepGitopsDeployments(db, deps)).toEqual({
        polled: 0,
        transitioned: 0,
        abandoned: 0
      })
    })
  })
})

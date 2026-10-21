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
      locker: server.locker,
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

  describe('status times', () => {
    test('records when each status was reached, keeping the earlier times', async () => {
      const orchestrator = fakeOrchestrator()
      const requestedAt = '2026-10-21T10:40:00.000Z'
      let entry = githubEntry({ statusTimes: { requested: requestedAt } })
      const doc = await insertDocument(entry)

      for (const status of ['pr-raised', 'merged', 'active']) {
        orchestrator.getDeploymentStatus.mockResolvedValue({
          operationId: entry.operationId,
          status,
          links: {}
        })
        entry = await refresh(orchestrator, doc, entry)
      }

      const stored = await storedEntry(entry.id)

      expect(Object.keys(stored.statusTimes)).toEqual([
        'requested',
        'pr-raised',
        'merged',
        'active'
      ])
      expect(stored.statusTimes.requested).toBe(requestedAt)
      expect(stored.statusTimes.active).toBe(stored.activatedAt)
      expect(entry.statusTimes).toEqual(stored.statusTimes)
    })

    test('keeps the time a status was first reached when a retry revisits it', async () => {
      const orchestrator = fakeOrchestrator()
      const first = '2026-10-21T10:44:00.000Z'
      let entry = githubEntry({
        status: 'deploying',
        statusTimes: { requested: '2026-10-21T10:40:00.000Z', deployed: first }
      })
      const doc = await insertDocument(entry)

      // deployed -> deploy-failed -> deploying (the retry) -> deployed again
      orchestrator.getDeploymentStatus.mockResolvedValue({
        operationId: entry.operationId,
        status: 'deployed',
        links: {}
      })
      entry = await refresh(orchestrator, doc, entry)

      expect(entry.status).toBe('deployed')
      expect(entry.statusTimes.deployed).toBe(first)
      expect((await storedEntry(entry.id)).statusTimes.deployed).toBe(first)
    })

    test('starts the record for an entry made before times were kept', async () => {
      const orchestrator = fakeOrchestrator()
      const entry = githubEntry()
      const doc = await insertDocument(entry)

      orchestrator.getDeploymentStatus.mockResolvedValue({
        operationId: entry.operationId,
        status: 'pr-raised',
        links: {}
      })
      await refresh(orchestrator, doc, entry)

      expect(Object.keys((await storedEntry(entry.id)).statusTimes)).toEqual([
        'pr-raised'
      ])
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

  describe('verification', () => {
    const resources = {
      project: { name: 'aip-alpha' },
      registration: {
        client_id: 'client-1',
        object_id: 'object-1',
        service_principal_object_id: 'sp-1',
        federations: {}
      }
    }

    function stillDeployed(entry, reason) {
      return {
        operationId: entry.operationId,
        status: 'deployed',
        links: {},
        polledAt: justNow(),
        verificationFailure: { reason }
      }
    }

    function logger() {
      return { warn: vi.fn(), error: vi.fn() }
    }

    test('records the reason, counts the attempt, audits and logs it, and keeps verifying', async () => {
      const orchestrator = fakeOrchestrator()
      const log = logger()
      const entry = githubEntry({ status: 'deployed', gitops: { resources } })
      const doc = await insertDocument(entry)

      orchestrator.getDeploymentStatus.mockResolvedValue(
        stillDeployed(entry, 'environment-not-configured')
      )

      const refreshed = await refresh(orchestrator, doc, entry, {
        logger: log,
        verifyMaxAttempts: 3
      })

      expect(refreshed.status).toBe('deployed')
      expect((await storedEntry(entry.id)).gitops.verification).toEqual({
        reason: 'environment-not-configured',
        attempts: 1,
        lastAttemptAt: expect.any(String)
      })
      expect(await auditEvents(entry)).toEqual([
        expect.objectContaining({
          action: 'teamDeployment.verificationFailed',
          outcome: 'failure',
          code: 'environment-not-configured',
          reason: 'attempt 1 of 3'
        })
      ])
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'environment-not-configured',
          attempts: 1
        }),
        expect.any(String)
      )
    })

    test('counts every overlapping failed verification once, whichever finishes last', async () => {
      const { applyVerificationPolicy } =
        await import('#/services/team-deployment-verification.js')
      const entry = githubEntry({ status: 'deployed', gitops: { resources } })
      const doc = await insertDocument(entry)
      const failed = stillDeployed(entry, 'resource-unavailable')

      // Both read the entry before either wrote, as two slow polls would.
      const results = await Promise.all([
        applyVerificationPolicy(db, doc, entry, failed, 2),
        applyVerificationPolicy(db, doc, entry, failed, 2)
      ])

      expect((await storedEntry(entry.id)).gitops.verification.attempts).toBe(2)
      expect(results.map(({ status }) => status).sort()).toEqual([
        'deploy-failed',
        'deployed'
      ])
    })

    test('starts counting from one after a retry cleared the earlier count', async () => {
      const { applyVerificationPolicy } =
        await import('#/services/team-deployment-verification.js')
      const entry = githubEntry({
        status: 'deployed',
        gitops: { resources, verification: null }
      })
      const doc = await insertDocument(entry)

      const result = await applyVerificationPolicy(
        db,
        doc,
        entry,
        stillDeployed(entry, 'no-resources'),
        3
      )

      expect(result.verification.attempts).toBe(1)
      expect((await storedEntry(entry.id)).gitops.verification.attempts).toBe(1)
    })

    test('does not count a failed verification for an entry that has moved on', async () => {
      const { applyVerificationPolicy } =
        await import('#/services/team-deployment-verification.js')
      const entry = githubEntry({ status: 'deployed', gitops: { resources } })
      const doc = await insertDocument({ ...entry, status: 'active' })

      const result = await applyVerificationPolicy(
        db,
        doc,
        entry,
        stillDeployed(entry, 'no-resources'),
        3
      )

      expect(result).toBeNull()
      expect((await storedEntry(entry.id)).gitops.verification).toBeUndefined()
    })

    test('fails for good with the reason once the attempts run out', async () => {
      const orchestrator = fakeOrchestrator()
      const log = logger()
      const entry = githubEntry({
        status: 'deployed',
        gitops: {
          resources,
          verification: {
            reason: 'environment-not-configured',
            attempts: 2,
            lastAttemptAt: anHourAgo()
          }
        }
      })
      const doc = await insertDocument(entry)

      orchestrator.getDeploymentStatus.mockResolvedValue(
        stillDeployed(entry, 'environment-not-configured')
      )

      const refreshed = await refresh(orchestrator, doc, entry, {
        logger: log,
        verifyMaxAttempts: 3
      })

      expect(refreshed.status).toBe('deploy-failed')
      expect(refreshed.failureReason).toContain('environment-not-configured')
      expect((await storedEntry(entry.id)).gitops.verification.attempts).toBe(3)
      expect(
        (await auditEvents(entry)).map(({ action }) => action).sort()
      ).toEqual([
        'teamDeployment.transition',
        'teamDeployment.verificationFailed'
      ])
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'environment-not-configured' }),
        expect.any(String)
      )

      // Terminal: never polled again.
      orchestrator.getDeploymentStatus.mockClear()
      await refresh(orchestrator, doc, await storedEntry(entry.id), {
        logger: log
      })

      expect(orchestrator.getDeploymentStatus).not.toHaveBeenCalled()
    })

    test('carries the team app registration identifiers onto the team record when it verifies', async () => {
      const orchestrator = fakeOrchestrator()
      const entry = githubEntry({ status: 'deployed', gitops: { resources } })
      const doc = await insertDocument(entry)

      orchestrator.getDeploymentStatus.mockResolvedValue({
        operationId: entry.operationId,
        status: 'verified',
        links: {}
      })

      await refresh(orchestrator, doc, entry)

      const stored = await db
        .collection('teamDeployments')
        .findOne({ _id: doc._id })
      expect(stored.oauthClient.registration).toEqual({
        clientId: 'client-1',
        objectId: 'object-1',
        servicePrincipalObjectId: 'sp-1'
      })
    })

    test('has no registration to carry where Entra skipped it', async () => {
      const orchestrator = fakeOrchestrator()
      const entry = githubEntry({
        status: 'deployed',
        gitops: {
          resources: { project: { name: 'aip-alpha' }, registration: null }
        }
      })
      const doc = await insertDocument(entry)

      orchestrator.getDeploymentStatus.mockResolvedValue({
        operationId: entry.operationId,
        status: 'verified',
        links: {}
      })

      const refreshed = await refresh(orchestrator, doc, entry)

      expect(refreshed.status).toBe('verified')
      expect(
        (await db.collection('teamDeployments').findOne({ _id: doc._id }))
          .oauthClient
      ).toBeUndefined()
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
              Boom.badRequest,
              'Model is not eligible for this environment',
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
        failureReason: 'Model is not eligible for this environment'
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

  describe('the team credential on activation', () => {
    function activating(overrides = {}) {
      return githubEntry({
        status: 'verified',
        requestedBy: 'requester-1',
        ...overrides
      })
    }

    function activeResult(entry) {
      return { operationId: entry.operationId, status: 'active', links: {} }
    }

    test('grants the model to the team credential for its environment when the deployment turns active', async () => {
      const orchestrator = fakeOrchestrator()
      const ensureCredential = vi.fn().mockResolvedValue({ created: true })
      const entry = activating()
      const doc = await insertDocument(entry)

      orchestrator.getDeploymentStatus.mockResolvedValue(activeResult(entry))

      const refreshed = await refresh(orchestrator, doc, entry, {
        locker: server.locker,
        ensureCredential
      })

      expect(refreshed.status).toBe('active')
      expect(ensureCredential).toHaveBeenCalledTimes(1)
      expect(ensureCredential).toHaveBeenCalledWith(db, server.locker, {
        teamId: doc.teamId,
        environment: 'sandbox',
        modelSlug: 'gpt-4o',
        requestedBy: 'requester-1',
        operationId: entry.operationId
      })
    })

    test('creates the credential for real, once, however often the entry is polled', async () => {
      const orchestrator = fakeOrchestrator()
      const entry = activating()
      const doc = await insertDocument(entry)

      orchestrator.getDeploymentStatus.mockResolvedValue(activeResult(entry))

      const active = await refresh(orchestrator, doc, entry, {
        locker: server.locker
      })

      await refresh(orchestrator, doc, active, { locker: server.locker })
      await refresh(orchestrator, doc, active, { locker: server.locker })

      const credentials = await db
        .collection('credentials')
        .find({ teamId: doc.teamId })
        .toArray()

      expect(credentials).toHaveLength(1)
      expect(credentials[0]).toMatchObject({
        tier: 'team',
        environment: 'sandbox',
        status: 'active',
        userId: 'requester-1'
      })
    })

    test.each(['pr-raised', 'merged', 'deploying'])(
      'does nothing while the deployment is only %s',
      async (status) => {
        const orchestrator = fakeOrchestrator()
        const ensureCredential = vi.fn()
        const entry = githubEntry({ status: 'requested' })
        const doc = await insertDocument(entry)

        orchestrator.getDeploymentStatus.mockResolvedValue({
          operationId: entry.operationId,
          status,
          links: {}
        })
        await refresh(orchestrator, doc, entry, {
          locker: server.locker,
          ensureCredential
        })

        expect(ensureCredential).not.toHaveBeenCalled()
      }
    )

    test('logs and audits a failed credential against the operation without failing or undoing the activation', async () => {
      const orchestrator = fakeOrchestrator()
      const logger = { warn: vi.fn(), debug: vi.fn() }
      const failure = Object.assign(new Error('not enabled'), {
        data: { code: 'gateway-not-enabled' }
      })
      const ensureCredential = vi.fn().mockRejectedValue(failure)
      const entry = activating()
      const doc = await insertDocument(entry)

      orchestrator.getDeploymentStatus.mockResolvedValue(activeResult(entry))

      const refreshed = await refresh(orchestrator, doc, entry, {
        locker: server.locker,
        ensureCredential,
        logger
      })

      expect(refreshed.status).toBe('active')
      expect((await storedEntry(entry.id)).status).toBe('active')
      expect(logger.warn).toHaveBeenCalledWith(
        { code: 'gateway-not-enabled', operationId: entry.operationId },
        'Creating the team credential failed, retrying on a later poll'
      )
      expect(await auditEvents(entry)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'teamDeployment.credential',
            outcome: 'failure',
            code: 'gateway-not-enabled'
          })
        ])
      )
    })

    test('logs and audits a secret that could not be written to the vault, keeping the activation', async () => {
      const orchestrator = fakeOrchestrator()
      const logger = { warn: vi.fn(), debug: vi.fn() }
      const ensureCredential = vi
        .fn()
        .mockResolvedValue({ created: true, vaultWritten: false })
      const entry = activating()
      const doc = await insertDocument(entry)

      orchestrator.getDeploymentStatus.mockResolvedValue(activeResult(entry))

      const refreshed = await refresh(orchestrator, doc, entry, {
        locker: server.locker,
        ensureCredential,
        logger
      })

      expect(refreshed.status).toBe('active')
      expect(logger.warn).toHaveBeenCalledWith(
        { code: 'vault-write-failed', operationId: entry.operationId },
        'The team secret could not be written to the vault, reconciliation will retry it'
      )
      expect(await auditEvents(entry)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'teamDeployment.credential',
            outcome: 'failure',
            code: 'vault-write-failed'
          })
        ])
      )
    })

    test('keeps the activation when the failure itself cannot be audited', async () => {
      const orchestrator = fakeOrchestrator()
      const logger = { warn: vi.fn(), debug: vi.fn() }
      const entry = activating()
      const doc = await insertDocument(entry)
      const collection = db.collection.bind(db)

      orchestrator.getDeploymentStatus.mockResolvedValue(activeResult(entry))

      const spy = vi.spyOn(db, 'collection').mockImplementation((name) => {
        const real = collection(name)

        return name === 'auditEvents'
          ? {
              insertOne: async (event) => {
                if (event.action === 'teamDeployment.credential') {
                  throw new Error('audit down')
                }

                return real.insertOne(event)
              }
            }
          : real
      })

      try {
        const refreshed = await refresh(orchestrator, doc, entry, {
          locker: server.locker,
          ensureCredential: vi.fn().mockRejectedValue(new Error('boom')),
          logger
        })

        expect(refreshed.status).toBe('active')
      } finally {
        spy.mockRestore()
      }

      expect(logger.warn).toHaveBeenCalledWith(
        { code: 'credential-failed', operationId: entry.operationId },
        'The team credential failure could not be audited'
      )
    })

    test('retries a credential still missing when an active entry is polled, logging only at debug and auditing nothing', async () => {
      const orchestrator = fakeOrchestrator()
      const logger = { warn: vi.fn(), debug: vi.fn() }
      const ensureCredential = vi.fn().mockRejectedValue(new Error('down'))
      const entry = activating({ status: 'active' })
      const doc = await insertDocument(entry)
      const deps = { locker: server.locker, ensureCredential, logger }

      // Nothing recorded for the team: the credential was never created.
      await refresh(orchestrator, doc, entry, deps)

      expect(ensureCredential).toHaveBeenCalledTimes(1)
      expect(orchestrator.getDeploymentStatus).not.toHaveBeenCalled()
      expect(logger.warn).not.toHaveBeenCalled()
      expect(logger.debug).toHaveBeenCalledWith(
        { code: 'credential-failed', operationId: entry.operationId },
        'Creating the team credential failed, retrying on a later poll'
      )
      expect(await auditEvents(entry)).toEqual([])
    })

    test.each([
      ['an active credential', { status: 'active' }],
      [
        'a revoked credential, which a poll never recreates',
        { status: 'revoked' }
      ]
    ])('does not retry when the team already has %s', async (_label, held) => {
      const orchestrator = fakeOrchestrator()
      const ensureCredential = vi.fn()
      const entry = activating({ status: 'active' })
      const doc = await insertDocument(entry)

      await db.collection('credentials').insertOne({
        teamId: doc.teamId,
        environment: 'sandbox',
        tier: 'team',
        credentialType: 'oauth',
        createdAt: anHourAgo(),
        ...held
      })
      await refresh(orchestrator, doc, entry, {
        locker: server.locker,
        ensureCredential
      })

      expect(ensureCredential).not.toHaveBeenCalled()
    })

    test('waits out the poll interval before retrying an attempt that did not finish', async () => {
      const orchestrator = fakeOrchestrator()
      const ensureCredential = vi.fn().mockResolvedValue({ created: true })
      const entry = activating({ status: 'active' })
      const doc = await insertDocument(entry)
      const deps = {
        locker: server.locker,
        ensureCredential,
        pollMinIntervalMs: 60000
      }

      const { insertedId } = await db.collection('credentials').insertOne({
        teamId: doc.teamId,
        environment: 'sandbox',
        tier: 'team',
        credentialType: 'oauth',
        status: 'failed',
        createdAt: justNow()
      })
      await refresh(orchestrator, doc, entry, deps)

      expect(ensureCredential).not.toHaveBeenCalled()

      await db
        .collection('credentials')
        .updateOne({ _id: insertedId }, { $set: { createdAt: anHourAgo() } })
      await refresh(orchestrator, doc, entry, deps)

      expect(ensureCredential).toHaveBeenCalledTimes(1)
    })
  })
})

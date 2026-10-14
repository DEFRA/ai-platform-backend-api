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
    await db.collection('teamDeployments').insertOne({
      teamId: `gitops-team-${randomUUID()}`,
      environment: 'sandbox',
      deployments
    })
  }

  async function storedEntry(id) {
    const doc = await db
      .collection('teamDeployments')
      .findOne({ 'deployments.id': id })

    return doc?.deployments.find((entry) => entry.id === id) ?? null
  }

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

      await insertDocument(inProgress, {
        id: 'mock-sibling',
        status: 'requested',
        orchestrator: 'mock'
      })
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

      expect((await storedEntry(failed.id)).gitops.abandon).toBeNull()
    })
  })
})

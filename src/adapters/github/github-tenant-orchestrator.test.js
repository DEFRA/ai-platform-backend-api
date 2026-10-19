import { generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'

import nock from 'nock'

// The repo's global test setup (.vite/setup-files.js) replaces global.fetch
// with vitest-fetch-mock for every file - undo that here so nock, which
// intercepts at the undici level, actually sees Octokit's requests.
const realFetch = globalThis.fetch

beforeAll(() => {
  globalThis.fetch = realFetch
})

const { createGithubTenantOrchestrator } =
  await import('#/adapters/github/github-tenant-orchestrator.js')
const { describeTenantOrchestratorContract } =
  await import('#/adapters/tenant-orchestrator-contract.js')
const github = await import('#/adapters/fixtures/github-api.js')

const GITHUB_API = 'https://api.github.com'
const ARTIFACT_HOST = 'https://artifacts.example.test'
const TENANTS = '/repos/DEFRA/ai-platform-tenants'
const DEPLOYMENTS = '/repos/DEFRA/ai-platform-deployments'
const OPERATION_ID = '0123456789abcdef01234567'
const PATH = 'environments/infradev/alpha.json'
const NOW = Date.parse('2026-10-13T12:00:00Z')

const alphaText = readFileSync(
  new URL(
    '../../common/fixtures/gitops/ai-platform-tenants/environments/infradev/alpha.json',
    import.meta.url
  ),
  'utf8'
)

function reversedKeys(value) {
  if (Array.isArray(value)) {
    return value.map(reversedKeys)
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .reverse()
        .map((key) => [key, reversedKeys(value[key])])
    )
  }

  return value
}

function createOrchestrator(overrides = {}) {
  return createGithubTenantOrchestrator({
    tenantsRepo: 'DEFRA/ai-platform-tenants',
    deploymentsRepo: 'DEFRA/ai-platform-deployments',
    pollMinIntervalMs: 30000,
    verifier: { verify: vi.fn(async () => ({ verified: true })) },
    now: () => NOW,
    ...overrides
  })
}

function deploymentRequest(overrides = {}) {
  return {
    environment: 'infradev',
    path: PATH,
    document: reversedKeys(JSON.parse(alphaText)),
    operationId: OPERATION_ID,
    requestedBy: 'entra:00000000-0000-0000-0000-000000000001',
    expectedRevision: 0,
    ...overrides
  }
}

function entry({ status = 'requested', ...gitops } = {}) {
  return {
    operationId: OPERATION_ID,
    environment: 'infradev',
    status,
    createdAt: '2026-10-13T10:00:00Z',
    gitops: {
      path: PATH,
      action: 'write',
      submitRunId: 1001,
      submitRunUrl:
        'https://github.com/DEFRA/ai-platform-tenants/actions/runs/1001',
      ...gitops
    }
  }
}

function mergedEntry(gitops = {}) {
  return entry({
    status: 'merged',
    pullRequestNumber: 7,
    pullRequestUrl: 'https://github.com/DEFRA/ai-platform-tenants/pull/7',
    mergeSha: 'merge-sha',
    mergedAt: '2026-10-13T10:04:00Z',
    ...gitops
  })
}

function replyWithPulls(pulls) {
  return nock(GITHUB_API)
    .get(`${TENANTS}/pulls`)
    .query({ head: `DEFRA:op/${OPERATION_ID}`, state: 'all' })
    .reply(200, pulls)
}

function replyWithMergedEvent(mergeSha) {
  return nock(GITHUB_API)
    .get(`${TENANTS}/issues/7/events`)
    .query({ per_page: 100 })
    .reply(200, github.pullRequestEvents(mergeSha))
}

function replyWithDeployments(deployments) {
  return nock(GITHUB_API)
    .get(`${TENANTS}/deployments`)
    .query({ environment: 'infradev', per_page: 100, page: 1 })
    .reply(200, deployments)
}

function replyWithStatus(deploymentId, status) {
  return nock(GITHUB_API)
    .get(`${TENANTS}/deployments/${deploymentId}/statuses`)
    .query({ per_page: 1 })
    .reply(200, [status])
}

function replyWithRunReport(runId, report) {
  nock(GITHUB_API)
    .get(`${TENANTS}/actions/runs/${runId}/artifacts`)
    .query({ name: 'run-report-infradev.json' })
    .reply(200, github.artifactList())
  nock(GITHUB_API)
    .get(`${TENANTS}/actions/artifacts/77/zip`)
    .reply(302, '', { location: `${ARTIFACT_HOST}/run-report-infradev.json` })
  nock(ARTIFACT_HOST)
    .get('/run-report-infradev.json')
    .reply(200, Buffer.from(JSON.stringify(report)), {
      'content-type': 'application/octet-stream'
    })
}

afterEach(() => {
  nock.cleanAll()
})

describeTenantOrchestratorContract(
  'github (nocked GitHub)',
  () => createOrchestrator(),
  {
    arrange() {
      nock(GITHUB_API)
        .persist()
        .post(`${TENANTS}/actions/workflows/submit.yml/dispatches`)
        .reply(200, github.dispatchedRun())
      nock(GITHUB_API)
        .persist()
        .post(`${TENANTS}/actions/workflows/apply.yml/dispatches`)
        .reply(200, github.dispatchedRun({ workflow_run_id: 2002 }))
      nock(GITHUB_API)
        .persist()
        .get(`${TENANTS}/pulls`)
        .query(true)
        .reply(200, [])
      nock(GITHUB_API)
        .persist()
        .get(`${TENANTS}/actions/runs/1001`)
        .reply(200, github.workflowRun())
      nock(GITHUB_API)
        .persist()
        .get(`${TENANTS}/commits/contract-merge-sha`)
        .reply(200, github.commit())
      nock(GITHUB_API)
        .persist()
        .get(`${TENANTS}/contents/${PATH}`)
        .query(true)
        .reply(404, { message: 'Not Found' })
    }
  }
)

describe('#createGithubTenantOrchestrator', () => {
  describe('requestDeployment', () => {
    test('dispatches submit.yml on main with the canonical document and every input as a string', async () => {
      let dispatched

      nock(GITHUB_API)
        .post(`${TENANTS}/actions/workflows/submit.yml/dispatches`, (body) => {
          dispatched = body
          return true
        })
        .reply(200, github.dispatchedRun())

      const submitted = await createOrchestrator().requestDeployment(
        deploymentRequest({
          traceParent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
        })
      )

      expect(dispatched).toEqual({
        ref: 'main',
        inputs: {
          action: 'write',
          environment: 'infradev',
          path: PATH,
          document: alphaText,
          operation_id: OPERATION_ID,
          expected_revision: '0',
          requested_by: 'entra:00000000-0000-0000-0000-000000000001',
          trace_parent:
            '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
        }
      })
      expect(submitted).toEqual({
        operationId: OPERATION_ID,
        status: 'requested',
        submitRunId: 1001,
        submitRunUrl:
          'https://github.com/DEFRA/ai-platform-tenants/actions/runs/1001'
      })
    })

    test('dispatches a platform pin to the deployments repository', async () => {
      const pin = nock(GITHUB_API)
        .post(`${DEPLOYMENTS}/actions/workflows/submit.yml/dispatches`)
        .reply(200, github.dispatchedRun())

      await createOrchestrator().requestDeployment(
        deploymentRequest({
          path: 'environments/infradev/platform.json',
          document: { release: 'v0.4.0' }
        })
      )

      expect(pin.isDone()).toBe(true)
    })

    test('sends an empty document for abandon', async () => {
      let dispatched

      nock(GITHUB_API)
        .post(`${TENANTS}/actions/workflows/submit.yml/dispatches`, (body) => {
          dispatched = body
          return true
        })
        .reply(200, github.dispatchedRun())

      await createOrchestrator().requestDeployment(
        deploymentRequest({ action: 'abandon', document: null })
      )

      expect(dispatched.inputs.action).toBe('abandon')
      expect(dispatched.inputs.document).toBe('')
    })

    test('accepts a canonical document of 61,439 bytes', async () => {
      nock(GITHUB_API)
        .post(`${TENANTS}/actions/workflows/submit.yml/dispatches`)
        .reply(200, github.dispatchedRun())

      // Canonical text of {padding} is the padding plus 20 bytes.
      await expect(
        createOrchestrator().requestDeployment(
          deploymentRequest({ document: { padding: 'x'.repeat(61419) } })
        )
      ).resolves.toMatchObject({ status: 'requested' })
    })

    test('refuses a canonical document of 60 KB (61,440 bytes) without dispatching', async () => {
      const dispatch = nock(GITHUB_API)
        .post(`${TENANTS}/actions/workflows/submit.yml/dispatches`)
        .reply(200, github.dispatchedRun())

      await expect(
        createOrchestrator().requestDeployment(
          deploymentRequest({ document: { padding: 'x'.repeat(61420) } })
        )
      ).rejects.toMatchObject({ code: 'desired-state-too-large' })
      expect(dispatch.isDone()).toBe(false)
    })

    test('refuses a write with no document', async () => {
      await expect(
        createOrchestrator().requestDeployment(
          deploymentRequest({ document: null })
        )
      ).rejects.toMatchObject({ code: 'desired-state-unavailable' })
    })

    test('refuses a path outside the environment', async () => {
      await expect(
        createOrchestrator().requestDeployment(
          deploymentRequest({ path: 'environments/sandbox/alpha.json' })
        )
      ).rejects.toMatchObject({ code: 'invalid-path' })
    })

    test('reports no run when GitHub does not return one', async () => {
      nock(GITHUB_API)
        .post(`${TENANTS}/actions/workflows/submit.yml/dispatches`)
        .reply(204)

      await expect(
        createOrchestrator().requestDeployment(deploymentRequest())
      ).resolves.toMatchObject({ submitRunId: null, submitRunUrl: null })
    })
  })

  test('requestApply dispatches a fresh apply.yml on main of the tenants repository', async () => {
    let dispatched

    nock(GITHUB_API)
      .post(`${TENANTS}/actions/workflows/apply.yml/dispatches`, (body) => {
        dispatched = body
        return true
      })
      .reply(200, github.dispatchedRun({ workflow_run_id: 2002 }))

    const applied = await createOrchestrator().requestApply({
      environment: 'infradev',
      reason: `retry ${OPERATION_ID}`
    })

    expect(dispatched).toEqual({
      ref: 'main',
      inputs: { environment: 'infradev', reason: `retry ${OPERATION_ID}` }
    })
    expect(applied.runId).toBe(2002)
  })

  describe('getPreviousDocument', () => {
    test('reads the file at the merge commit parent', async () => {
      nock(GITHUB_API)
        .get(`${TENANTS}/commits/merge-sha`)
        .reply(200, github.commit())
      nock(GITHUB_API)
        .get(`${TENANTS}/contents/${PATH}`)
        .query({ ref: 'parent-sha' })
        .reply(200, github.fileContents(alphaText))

      await expect(
        createOrchestrator().getPreviousDocument({
          path: PATH,
          mergeSha: 'merge-sha'
        })
      ).resolves.toEqual({ document: JSON.parse(alphaText) })
    })

    test('has no previous document for a root commit', async () => {
      nock(GITHUB_API)
        .get(`${TENANTS}/commits/merge-sha`)
        .reply(200, github.commit({ parents: [] }))

      await expect(
        createOrchestrator().getPreviousDocument({
          path: PATH,
          mergeSha: 'merge-sha'
        })
      ).resolves.toEqual({ document: null })
    })

    test('passes on a failure other than a missing file', async () => {
      nock(GITHUB_API)
        .get(`${TENANTS}/commits/merge-sha`)
        .reply(200, github.commit())
      nock(GITHUB_API)
        .get(`${TENANTS}/contents/${PATH}`)
        .query(true)
        .reply(500, { message: 'outage' })

      await expect(
        createOrchestrator().getPreviousDocument({
          path: PATH,
          mergeSha: 'merge-sha'
        })
      ).rejects.toMatchObject({ status: 500 })
    })
  })

  describe('getCurrentDocument', () => {
    test('reads the file from the default branch', async () => {
      nock(GITHUB_API)
        .get(`${TENANTS}/contents/${PATH}`)
        .reply(200, github.fileContents(alphaText))

      await expect(
        createOrchestrator().getCurrentDocument({ path: PATH })
      ).resolves.toEqual({ document: JSON.parse(alphaText) })
    })

    test('has no document for a team with no file yet', async () => {
      nock(GITHUB_API)
        .get(`${TENANTS}/contents/${PATH}`)
        .reply(404, { message: 'Not Found' })

      await expect(
        createOrchestrator().getCurrentDocument({ path: PATH })
      ).resolves.toEqual({ document: null })
    })
  })

  describe('getDeploymentStatus', () => {
    test('is requested while the submit run is queued or running', async () => {
      replyWithPulls([])
      nock(GITHUB_API)
        .get(`${TENANTS}/actions/runs/1001`)
        .reply(200, github.workflowRun({ status: 'queued' }))

      const status = await createOrchestrator().getDeploymentStatus(entry())

      expect(status).toEqual({
        operationId: OPERATION_ID,
        status: 'requested',
        links: {
          submitRun:
            'https://github.com/DEFRA/ai-platform-tenants/actions/runs/1001'
        },
        polledAt: new Date(NOW).toISOString()
      })
    })

    test('is checks-failed when the submit run failed before any pull request', async () => {
      replyWithPulls([])
      nock(GITHUB_API)
        .get(`${TENANTS}/actions/runs/1001`)
        .reply(
          200,
          github.workflowRun({ status: 'completed', conclusion: 'failure' })
        )

      const status = await createOrchestrator().getDeploymentStatus(entry())

      expect(status.status).toBe('checks-failed')
      expect(status.failureReason).toContain('nothing was written')
    })

    test('is requested with no submit run to read', async () => {
      replyWithPulls([])

      const status = await createOrchestrator().getDeploymentStatus(
        entry({ submitRunId: null, submitRunUrl: null })
      )

      expect(status).toMatchObject({ status: 'requested', links: {} })
    })

    test.each([
      ['in_progress', null, 'requested'],
      ['completed', 'success', 'active'],
      ['completed', 'failure', 'checks-failed']
    ])(
      'follows an abandon by its submit run alone: %s %s is %s',
      async (runStatus, conclusion, expected) => {
        nock(GITHUB_API)
          .get(`${TENANTS}/actions/runs/1001`)
          .reply(200, github.workflowRun({ status: runStatus, conclusion }))

        const status = await createOrchestrator().getDeploymentStatus(
          entry({ action: 'abandon' })
        )

        expect(status.status).toBe(expected)
      }
    )

    test('says why an abandon failed', async () => {
      nock(GITHUB_API)
        .get(`${TENANTS}/actions/runs/1001`)
        .reply(
          200,
          github.workflowRun({ status: 'completed', conclusion: 'failure' })
        )

      const status = await createOrchestrator().getDeploymentStatus(
        entry({ action: 'abandon' })
      )

      expect(status.failureReason).toBe(
        'The submit workflow could not abandon the pull request'
      )
    })

    test('is pr-raised while the pull request is open and validate has not failed', async () => {
      replyWithPulls([github.pullRequest()])
      nock(GITHUB_API)
        .get(`${TENANTS}/commits/head-sha/check-runs`)
        .query({ check_name: 'validate-desired-state / validate' })
        .reply(200, github.checkRunList([github.checkRun()]))

      const status = await createOrchestrator().getDeploymentStatus(entry())

      expect(status).toMatchObject({
        status: 'pr-raised',
        pullRequestNumber: 7,
        links: {
          submitRun:
            'https://github.com/DEFRA/ai-platform-tenants/actions/runs/1001',
          pullRequest: 'https://github.com/DEFRA/ai-platform-tenants/pull/7'
        }
      })
      expect(status).not.toHaveProperty('mergeSha')
    })

    test('is checks-failed when the latest validate-desired-state / validate run failed', async () => {
      replyWithPulls([github.pullRequest()])
      nock(GITHUB_API)
        .get(`${TENANTS}/commits/head-sha/check-runs`)
        .query({ check_name: 'validate-desired-state / validate' })
        .reply(
          200,
          github.checkRunList([
            github.checkRun({
              id: 1,
              status: 'completed',
              conclusion: 'success'
            }),
            github.checkRun({
              id: 2,
              status: 'completed',
              conclusion: 'failure'
            })
          ])
        )

      const status = await createOrchestrator().getDeploymentStatus(entry())

      expect(status.status).toBe('checks-failed')
      expect(status.failureReason).toContain('validate')
      expect(status.pullRequestNumber).toBe(7)
    })

    test('is checks-failed when the pull request was closed without merging', async () => {
      replyWithPulls([github.pullRequest({ state: 'closed' })])

      const status = await createOrchestrator().getDeploymentStatus(entry())

      expect(status.status).toBe('checks-failed')
      expect(status.failureReason).toContain('closed')
    })

    test('is merged at the squash commit while no Deployment includes it', async () => {
      replyWithPulls([
        github.pullRequest({
          state: 'closed',
          merged_at: '2026-10-13T10:04:00Z'
        })
      ])
      replyWithMergedEvent('merge-sha')
      replyWithDeployments([
        github.deployment({ id: 400, created_at: '2026-10-13T09:00:00Z' })
      ])

      const status = await createOrchestrator().getDeploymentStatus(entry())

      expect(status).toMatchObject({
        status: 'merged',
        mergeSha: 'merge-sha',
        mergedAt: '2026-10-13T10:04:00Z',
        pullRequestNumber: 7
      })
    })

    test('reads the merge commit from the merged event, as the pull request omits it', async () => {
      replyWithPulls([
        github.pullRequest({
          state: 'closed',
          merged_at: '2026-10-13T10:04:00Z'
        })
      ])
      replyWithMergedEvent('merge-sha')
      replyWithDeployments([github.deployment({ sha: 'later-sha' })])
      nock(GITHUB_API)
        .get(`${TENANTS}/compare/merge-sha...later-sha`)
        .query({ per_page: 1 })
        .reply(200, github.comparison('ahead'))
      replyWithStatus(501, github.deploymentStatus({ state: 'success' }))
      replyWithRunReport(2002, github.runReport())

      const status = await createOrchestrator().getDeploymentStatus(entry())

      expect(status).toMatchObject({
        status: 'deployed',
        mergeSha: 'merge-sha',
        applyRunId: 2002
      })
    })

    test('fails clearly, not with a malformed compare, when a merged pull request has no merged event', async () => {
      replyWithPulls([
        github.pullRequest({
          state: 'closed',
          merged_at: '2026-10-13T10:04:00Z'
        })
      ])
      replyWithMergedEvent(undefined)

      await expect(
        createOrchestrator().getDeploymentStatus(entry())
      ).rejects.toThrow('no merged event')
    })

    test('is deploying while a Deployment at a descendant of the merge commit is in progress', async () => {
      replyWithDeployments([github.deployment({ sha: 'later-sha' })])
      nock(GITHUB_API)
        .get(`${TENANTS}/compare/merge-sha...later-sha`)
        .query({ per_page: 1 })
        .reply(200, github.comparison('ahead'))
      replyWithStatus(501, github.deploymentStatus())

      const status =
        await createOrchestrator().getDeploymentStatus(mergedEntry())

      expect(status).toMatchObject({
        status: 'deploying',
        applyRunId: 2002,
        links: {
          pullRequest: 'https://github.com/DEFRA/ai-platform-tenants/pull/7',
          applyRun:
            'https://github.com/DEFRA/ai-platform-tenants/actions/runs/2002'
        }
      })
    })

    test('ignores a Deployment on a commit that does not include the merge', async () => {
      replyWithDeployments([github.deployment({ sha: 'other-sha' })])
      nock(GITHUB_API)
        .get(`${TENANTS}/compare/merge-sha...other-sha`)
        .query({ per_page: 1 })
        .reply(200, github.comparison('diverged'))

      const status =
        await createOrchestrator().getDeploymentStatus(mergedEntry())

      expect(status.status).toBe('merged')
    })

    test('is deployed when a successful apply’s run report lists the operation', async () => {
      replyWithDeployments([github.deployment()])
      replyWithStatus(501, github.deploymentStatus({ state: 'success' }))
      replyWithRunReport(2002, github.runReport())

      const status =
        await createOrchestrator().getDeploymentStatus(mergedEntry())

      expect(status).toMatchObject({
        status: 'deployed',
        appliedSha: 'merge-sha',
        applyRunId: 2002,
        resources: github.runReport().outputs.teams.value.alpha
      })
    })

    // A full page of later Deployments, none including the merge.
    const laterDeployments = Array.from({ length: 100 }, (_, index) =>
      github.deployment({
        id: 1000 + index,
        sha: 'later-sha',
        created_at: '2026-10-13T11:00:00Z'
      })
    )

    test('pages back past later applies to find the operation’s own when it is polled late', async () => {
      replyWithDeployments(laterDeployments)
      nock(GITHUB_API)
        .get(`${TENANTS}/compare/merge-sha...later-sha`)
        .query({ per_page: 1 })
        .reply(200, github.comparison('diverged'))
      nock(GITHUB_API)
        .get(`${TENANTS}/deployments`)
        .query({ environment: 'infradev', per_page: 100, page: 2 })
        .reply(200, [
          github.deployment(),
          github.deployment({ id: 400, created_at: '2026-10-13T09:00:00Z' })
        ])
      replyWithStatus(501, github.deploymentStatus({ state: 'success' }))
      replyWithRunReport(2002, github.runReport())

      const status =
        await createOrchestrator().getDeploymentStatus(mergedEntry())

      expect(status).toMatchObject({ status: 'deployed', applyRunId: 2002 })
      expect(nock.isDone()).toBe(true)
    })

    test('stops paging at a Deployment created before the merge', async () => {
      replyWithDeployments([
        ...laterDeployments.slice(1),
        github.deployment({ id: 400, created_at: '2026-10-13T09:00:00Z' })
      ])
      nock(GITHUB_API)
        .get(`${TENANTS}/compare/merge-sha...later-sha`)
        .query({ per_page: 1 })
        .reply(200, github.comparison('diverged'))

      const status =
        await createOrchestrator().getDeploymentStatus(mergedEntry())

      // nock refuses an unexpected page 2, which would fail the poll.
      expect(status.status).toBe('merged')
    })

    test.each([
      ['application/json', (report) => report],
      ['text/plain; charset=utf-8', (report) => JSON.stringify(report)]
    ])('reads a run report served as %s', async (contentType, toBody) => {
      replyWithDeployments([github.deployment()])
      replyWithStatus(501, github.deploymentStatus({ state: 'success' }))
      nock(GITHUB_API)
        .get(`${TENANTS}/actions/runs/2002/artifacts`)
        .query(true)
        .reply(200, github.artifactList())
      nock(GITHUB_API)
        .get(`${TENANTS}/actions/artifacts/77/zip`)
        .reply(200, toBody(github.runReport()), {
          'content-type': contentType
        })

      const status =
        await createOrchestrator().getDeploymentStatus(mergedEntry())

      expect(status.status).toBe('deployed')
    })

    test('downloads a run’s report once, however often the operation is polled', async () => {
      const orchestrator = createOrchestrator()

      replyWithDeployments([github.deployment()])
      replyWithStatus(501, github.deploymentStatus({ state: 'success' }))
      replyWithRunReport(2002, github.runReport({ operations: [] }))
      await orchestrator.getDeploymentStatus(mergedEntry())

      replyWithDeployments([github.deployment()])
      replyWithStatus(501, github.deploymentStatus({ state: 'success' }))
      const artifacts = nock(GITHUB_API)
        .get(`${TENANTS}/actions/runs/2002/artifacts`)
        .query(true)
        .reply(200, github.artifactList())

      const status = await orchestrator.getDeploymentStatus(mergedEntry())

      expect(status.status).toBe('deploying')
      expect(artifacts.isDone()).toBe(false)
    })

    test('stays deploying when the successful apply’s run report does not list the operation', async () => {
      replyWithDeployments([github.deployment()])
      replyWithStatus(501, github.deploymentStatus({ state: 'success' }))
      replyWithRunReport(2002, github.runReport({ operations: [] }))

      const status =
        await createOrchestrator().getDeploymentStatus(mergedEntry())

      expect(status.status).toBe('deploying')
    })

    test('is deployed when an earlier apply listed the operation, even if a later one failed', async () => {
      replyWithDeployments([
        github.deployment({
          id: 502,
          sha: 'later-sha',
          created_at: '2026-10-13T11:00:00Z'
        }),
        github.deployment({ id: 501 })
      ])
      nock(GITHUB_API)
        .get(`${TENANTS}/compare/merge-sha...later-sha`)
        .query({ per_page: 1 })
        .reply(200, github.comparison('ahead'))
      replyWithStatus(
        502,
        github.deploymentStatus({ state: 'failure', runId: 2003 })
      )
      replyWithStatus(501, github.deploymentStatus({ state: 'inactive' }))
      replyWithRunReport(2002, github.runReport())

      const status =
        await createOrchestrator().getDeploymentStatus(mergedEntry())

      expect(status.status).toBe('deployed')
    })

    test('is deploy-failed with the run report’s attribution when the latest apply failed', async () => {
      replyWithDeployments([github.deployment()])
      replyWithStatus(
        501,
        github.deploymentStatus({
          state: 'failure',
          created_at: '2026-10-13T10:09:00Z'
        })
      )
      replyWithRunReport(
        2002,
        github.runReport({
          outcome: 'failure',
          operations: [],
          failingTeams: ['alpha']
        })
      )

      const status =
        await createOrchestrator().getDeploymentStatus(mergedEntry())

      expect(status).toMatchObject({
        status: 'deploy-failed',
        failureReason: 'The apply workflow failed',
        applyRunId: 2002,
        failure: {
          observedAt: '2026-10-13T10:09:00Z',
          failingTeams: ['alpha'],
          unattributedFailure: false
        }
      })
    })

    test('treats a failed apply with no run report as unattributed', async () => {
      replyWithDeployments([github.deployment()])
      replyWithStatus(501, github.deploymentStatus({ state: 'error' }))
      nock(GITHUB_API)
        .get(`${TENANTS}/actions/runs/2002/artifacts`)
        .query(true)
        .reply(200, github.artifactList([]))

      const status =
        await createOrchestrator().getDeploymentStatus(mergedEntry())

      expect(status.failure).toEqual({
        observedAt: '2026-10-13T10:06:00Z',
        failingTeams: [],
        unattributedFailure: true
      })
    })

    describe('once deployed', () => {
      const resources = github.runReport().outputs.teams.value.alpha

      test('is verified when ARM confirms the team’s resources from the run report', async () => {
        const verifier = { verify: vi.fn(async () => ({ verified: true })) }

        const status = await createOrchestrator({
          verifier
        }).getDeploymentStatus(mergedEntry({ status: 'deployed', resources }))

        expect(verifier.verify).toHaveBeenCalledWith({
          environment: 'infradev',
          resources
        })
        expect(status.status).toBe('verified')
      })

      test('stays deployed and keeps the reason while ARM cannot confirm them', async () => {
        const verifier = {
          verify: vi.fn(async () => ({
            verified: false,
            reason: 'environment-not-configured'
          }))
        }

        const status = await createOrchestrator({
          verifier
        }).getDeploymentStatus(mergedEntry({ status: 'deployed', resources }))

        expect(status.status).toBe('deployed')
        expect(status.verificationFailure).toEqual({
          reason: 'environment-not-configured'
        })
      })

      test('has no verification failure once ARM confirms them', async () => {
        const verifier = { verify: vi.fn(async () => ({ verified: true })) }

        const status = await createOrchestrator({
          verifier
        }).getDeploymentStatus(mergedEntry({ status: 'deployed', resources }))

        expect(status).not.toHaveProperty('verificationFailure')
      })

      test('has nothing to verify for a removal', async () => {
        const verifier = { verify: vi.fn() }

        const status = await createOrchestrator({
          verifier
        }).getDeploymentStatus(
          mergedEntry({ status: 'deployed', action: 'remove' })
        )

        expect(status.status).toBe('verified')
        expect(verifier.verify).not.toHaveBeenCalled()
      })
    })

    test('activates a verified entry without reading GitHub or ARM', async () => {
      const verifier = { verify: vi.fn() }

      const status = await createOrchestrator({ verifier }).getDeploymentStatus(
        mergedEntry({
          status: 'verified',
          lastPolledAt: new Date(NOW).toISOString()
        })
      )

      expect(status.status).toBe('active')
      expect(status).not.toHaveProperty('polledAt')
      expect(verifier.verify).not.toHaveBeenCalled()
    })

    test('does not poll the same operation again within GITOPS_POLL_MIN_INTERVAL_MS', async () => {
      const pulls = replyWithPulls([github.pullRequest()])

      const status = await createOrchestrator().getDeploymentStatus(
        entry({ lastPolledAt: new Date(NOW - 29000).toISOString() })
      )

      expect(status).toEqual({
        operationId: OPERATION_ID,
        status: 'requested',
        links: {
          submitRun:
            'https://github.com/DEFRA/ai-platform-tenants/actions/runs/1001'
        }
      })
      expect(pulls.isDone()).toBe(false)
    })

    test('surfaces a GitHub rate limit as a coded error', async () => {
      nock(GITHUB_API)
        .get(`${TENANTS}/pulls`)
        .query(true)
        .reply(
          403,
          { message: 'secondary rate limit' },
          { 'retry-after': '60' }
        )

      await expect(
        createOrchestrator().getDeploymentStatus(entry())
      ).rejects.toMatchObject({ code: 'github-rate-limited' })
    })
  })
})

describe('#createGithubTenantOrchestrator with GitHub App credentials', () => {
  let tokenRequests

  beforeEach(() => {
    tokenRequests = []
    nock(GITHUB_API)
      .persist()
      .post('/app/installations/123/access_tokens', (body) => {
        tokenRequests.push(body)
        return true
      })
      .reply(201, () => ({
        token: `ghs_${tokenRequests.length}`,
        expires_at: new Date(Date.now() + 3600000).toISOString()
      }))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  async function loadOrchestrator() {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' }
    })

    vi.resetModules()
    vi.stubEnv('GITHUB_CLIENT_ID', 'Iv1.placeholder')
    vi.stubEnv('GITHUB_APP_INSTALLATION_ID', '123')
    vi.stubEnv(
      'GITHUB_APP_PRIVATE_KEY',
      Buffer.from(privateKey).toString('base64')
    )

    const module =
      await import('#/adapters/github/github-tenant-orchestrator.js')

    return module.createGithubTenantOrchestrator({
      tenantsRepo: 'DEFRA/ai-platform-tenants',
      deploymentsRepo: 'DEFRA/ai-platform-deployments',
      now: () => NOW
    })
  }

  test('reads the run from the dispatch’s 200 under the pinned API version, which needs no return_run_details', async () => {
    const orchestrator = await loadOrchestrator()
    let body

    nock(GITHUB_API)
      .post(`${TENANTS}/actions/workflows/submit.yml/dispatches`, (sent) => {
        body = sent
        return true
      })
      .matchHeader('x-github-api-version', '2026-03-10')
      .reply(200, github.dispatchedRun())

    const submitted = await orchestrator.requestDeployment(deploymentRequest())

    expect(submitted).toMatchObject({
      submitRunId: 1001,
      submitRunUrl:
        'https://github.com/DEFRA/ai-platform-tenants/actions/runs/1001'
    })
    expect(Object.keys(body).sort((a, b) => a.localeCompare(b))).toEqual([
      'inputs',
      'ref'
    ])
  })

  test('dispatches with Actions write on the tenants repository only, and reads with read-only status permissions', async () => {
    const orchestrator = await loadOrchestrator()

    nock(GITHUB_API)
      .post(`${TENANTS}/actions/workflows/submit.yml/dispatches`)
      .reply(200, github.dispatchedRun())
    replyWithPulls([])
    nock(GITHUB_API)
      .get(`${TENANTS}/actions/runs/1001`)
      .reply(200, github.workflowRun())

    await orchestrator.requestDeployment(deploymentRequest())
    await orchestrator.getDeploymentStatus(entry())

    expect(tokenRequests).toEqual([
      {
        repositories: ['ai-platform-tenants'],
        permissions: { actions: 'write' }
      },
      {
        repositories: ['ai-platform-tenants'],
        permissions: {
          actions: 'read',
          checks: 'read',
          contents: 'read',
          deployments: 'read',
          pull_requests: 'read'
        }
      }
    ])
  })
})

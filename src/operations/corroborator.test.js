import { exampleEvent } from '#/common/test-helpers/gitops-messages.js'
import { createCorroborator } from '#/operations/corroborator.js'

const TENANTS = 'DEFRA/ai-platform-tenants'
const DEPLOYMENTS = 'DEFRA/ai-platform-deployments'
const OPERATION = {
  _id: 'op-7f3c9a1e',
  target: { repository: TENANTS, team: 'alpha' }
}
const SUBMIT = '.github/workflows/submit.yml'
const APPLY = '.github/workflows/apply.yml'
const RECONCILE_ALL = '.github/workflows/reconcile-all.yml'
const PAUSE = '.github/workflows/pause.yml'

function runOf(overrides = {}) {
  return {
    id: 25000000001,
    name: 'Submit alpha (op-7f3c9a1e)',
    path: SUBMIT,
    headBranch: 'main',
    status: 'completed',
    conclusion: 'failure',
    runStartedAt: '2026-10-26T12:00:00Z',
    actor: 'alice',
    triggeringActor: 'alice',
    ...overrides
  }
}

describe('corroborator', () => {
  let runReader
  let corroborator

  function readerReturning({
    run = runOf(),
    report,
    permission = 'admin',
    onMain = true
  } = {}) {
    return {
      getRun: vi.fn().mockResolvedValue(run),
      getRunReport: vi.fn().mockResolvedValue(report),
      getActorPermission: vi.fn().mockResolvedValue(permission),
      isOnMain: vi.fn().mockResolvedValue(onMain)
    }
  }

  function setUp(options) {
    runReader = readerReturning(options)
    corroborator = createCorroborator({
      runReader,
      repositories: { tenants: TENANTS, deployments: DEPLOYMENTS }
    })
  }

  beforeEach(() => setUp())

  describe('corroborateFailure', () => {
    describe('a checks-failed event from a submit run', () => {
      const event = exampleEvent('checks-failed')

      test('is corroborated by a failed run of submit on main named for the operation', async () => {
        const verdict = await corroborator.corroborateFailure(event, OPERATION)

        expect(verdict).toEqual({ ok: true, run: runOf() })
        expect(runReader.getRun).toHaveBeenCalledWith({
          repository: TENANTS,
          runId: event.runId
        })
      })

      test('does not read a run report', async () => {
        await corroborator.corroborateFailure(event, OPERATION)

        expect(runReader.getRunReport).not.toHaveBeenCalled()
      })

      test('is refused when its repository is not the operation target, without reading the run', async () => {
        const verdict = await corroborator.corroborateFailure(
          { ...event, repository: DEPLOYMENTS },
          OPERATION
        )

        expect(verdict).toEqual({ ok: false, reason: 'repository-differs' })
        expect(runReader.getRun).not.toHaveBeenCalled()
      })

      test('is refused when the target is not a state repository', async () => {
        const verdict = await corroborator.corroborateFailure(
          { ...event, repository: 'someone/else' },
          { ...OPERATION, target: { repository: 'someone/else' } }
        )

        expect(verdict).toEqual({ ok: false, reason: 'unknown-repository' })
        expect(runReader.getRun).not.toHaveBeenCalled()
      })

      test('is refused when the run is not found', async () => {
        setUp({ run: null })

        expect(await corroborator.corroborateFailure(event, OPERATION)).toEqual(
          { ok: false, reason: 'run-not-found' }
        )
      })

      test('is refused when the run was not on main', async () => {
        setUp({ run: runOf({ headBranch: 'feature' }) })

        expect(await corroborator.corroborateFailure(event, OPERATION)).toEqual(
          { ok: false, reason: 'not-on-main' }
        )
      })

      test.each([APPLY, PAUSE, RECONCILE_ALL, '.github/workflows/other.yml'])(
        'is refused when the run is of the workflow %s, not submit',
        async (path) => {
          setUp({ run: runOf({ path }) })

          expect(
            await corroborator.corroborateFailure(event, OPERATION)
          ).toEqual({ ok: false, reason: 'unexpected-workflow' })
        }
      )

      test('is refused when the run is named for another operation', async () => {
        setUp({ run: runOf({ name: 'Submit alpha (op-other-one)' }) })

        expect(await corroborator.corroborateFailure(event, OPERATION)).toEqual(
          { ok: false, reason: 'run-is-for-another-operation' }
        )
      })

      test('is refused when the run has no name', async () => {
        setUp({ run: runOf({ name: null }) })

        expect(await corroborator.corroborateFailure(event, OPERATION)).toEqual(
          { ok: false, reason: 'run-is-for-another-operation' }
        )
      })

      test.each([
        'action_required',
        'cancelled',
        'failure',
        'stale',
        'startup_failure',
        'timed_out'
      ])('accepts a run that concluded %s', async (conclusion) => {
        setUp({ run: runOf({ conclusion }) })

        expect(
          (await corroborator.corroborateFailure(event, OPERATION)).ok
        ).toBe(true)
      })

      test.each(['success', 'skipped', 'neutral'])(
        'refuses a permanent failure on a run that concluded %s',
        async (conclusion) => {
          setUp({ run: runOf({ conclusion }) })

          expect(
            await corroborator.corroborateFailure(event, OPERATION)
          ).toEqual({ ok: false, reason: 'run-did-not-fail' })
        }
      )

      test('accepts a permanent failure on a run still in progress', async () => {
        setUp({ run: runOf({ status: 'in_progress', conclusion: null }) })

        expect(
          (await corroborator.corroborateFailure(event, OPERATION)).ok
        ).toBe(true)
      })

      test('accepts a retryable refusal on a run that passed', async () => {
        setUp({ run: runOf({ conclusion: 'success' }) })

        const retryable = exampleEvent('checks-failed', {
          failureReason: {
            code: 'stale-revision',
            message: 'The file moved',
            retryable: true
          }
        })

        expect(
          (await corroborator.corroborateFailure(retryable, OPERATION)).ok
        ).toBe(true)
      })
    })

    describe('a deploy-failed event from an apply run', () => {
      const event = exampleEvent('deploy-failed')
      const applyRun = runOf({
        path: APPLY,
        name: 'Apply infradev',
        id: event.runId
      })

      test('is refused as transient when the run report is not there yet', async () => {
        setUp({ run: applyRun, report: null })

        expect(await corroborator.corroborateFailure(event, OPERATION)).toEqual(
          { ok: false, reason: 'report-unavailable', transient: true }
        )
        expect(runReader.getRunReport).toHaveBeenCalledWith({
          repository: TENANTS,
          runId: event.runId,
          environment: 'infradev'
        })
      })

      test('is corroborated when the report lists the failing teams of the event', async () => {
        setUp({
          run: applyRun,
          report: { outcome: 'failed', failingTeams: ['alpha', 'beta'] }
        })

        expect(await corroborator.corroborateFailure(event, OPERATION)).toEqual(
          { ok: true, run: applyRun }
        )
      })

      test('is refused when the report lists none of the failing teams', async () => {
        setUp({ run: applyRun, report: { failingTeams: ['beta'] } })

        expect(await corroborator.corroborateFailure(event, OPERATION)).toEqual(
          { ok: false, reason: 'failing-teams-differ' }
        )
      })

      test('is refused when the event names a team the report does not', async () => {
        setUp({ run: applyRun, report: { failingTeams: ['alpha'] } })

        expect(
          await corroborator.corroborateFailure(
            { ...event, failingTeams: ['alpha', 'beta'] },
            OPERATION
          )
        ).toEqual({ ok: false, reason: 'failing-teams-differ' })
      })

      test('is refused when the report lists no failing teams at all', async () => {
        setUp({ run: applyRun, report: { outcome: 'failed' } })

        expect(await corroborator.corroborateFailure(event, OPERATION)).toEqual(
          { ok: false, reason: 'failing-teams-differ' }
        )
      })

      test('is corroborated for an event that names no failing team', async () => {
        setUp({ run: applyRun, report: { failingTeams: ['beta'] } })

        expect(
          (
            await corroborator.corroborateFailure(
              { ...event, failingTeams: [] },
              OPERATION
            )
          ).ok
        ).toBe(true)
      })

      test('is refused when the run is of submit, not an apply workflow', async () => {
        setUp({
          run: runOf({ path: SUBMIT }),
          report: { failingTeams: ['alpha'] }
        })

        expect(await corroborator.corroborateFailure(event, OPERATION)).toEqual(
          { ok: false, reason: 'unexpected-workflow' }
        )
        expect(runReader.getRunReport).not.toHaveBeenCalled()
      })

      test('accepts a run of reconcile-all', async () => {
        const reconcileRun = runOf({ path: RECONCILE_ALL })

        setUp({ run: reconcileRun, report: { failingTeams: ['alpha'] } })

        expect(await corroborator.corroborateFailure(event, OPERATION)).toEqual(
          { ok: true, run: reconcileRun }
        )
      })

      test('does not need the run to be named for the operation', async () => {
        setUp({
          run: { ...applyRun, name: 'Apply infradev' },
          report: { failingTeams: ['alpha'] }
        })

        expect(
          (await corroborator.corroborateFailure(event, OPERATION)).ok
        ).toBe(true)
      })

      describe('when the failure is retryable because the environment is paused', () => {
        const paused = exampleEvent('deploy-failed', {
          failureReason: {
            code: 'paused',
            message: 'The environment is paused',
            retryable: true
          },
          failingTeams: [],
          attributable: false
        })

        test('is corroborated by a report with the outcome paused', async () => {
          setUp({
            run: applyRun,
            report: { outcome: 'paused', failingTeams: [] }
          })

          expect(
            await corroborator.corroborateFailure(paused, OPERATION)
          ).toEqual({ ok: true, run: applyRun })
        })

        test('is refused when the report says anything else', async () => {
          setUp({
            run: applyRun,
            report: { outcome: 'failed', failingTeams: ['alpha'] }
          })

          expect(
            await corroborator.corroborateFailure(paused, OPERATION)
          ).toEqual({ ok: false, reason: 'report-not-paused' })
        })

        test('is refused as transient when there is no report yet', async () => {
          setUp({ run: applyRun, report: null })

          expect(
            await corroborator.corroborateFailure(paused, OPERATION)
          ).toMatchObject({ ok: false, transient: true })
        })

        test('is accepted even when the run went on to pass', async () => {
          setUp({
            run: { ...applyRun, conclusion: 'success' },
            report: { outcome: 'paused' }
          })

          expect(
            (await corroborator.corroborateFailure(paused, OPERATION)).ok
          ).toBe(true)
        })
      })

      test('refuses a permanent failure on an apply run that passed', async () => {
        setUp({
          run: { ...applyRun, conclusion: 'success' },
          report: { failingTeams: ['alpha'] }
        })

        expect(await corroborator.corroborateFailure(event, OPERATION)).toEqual(
          { ok: false, reason: 'run-did-not-fail' }
        )
        expect(runReader.getRunReport).not.toHaveBeenCalled()
      })
    })

    describe('an event from another source', () => {
      test('accepts the run of any workflow the portal knows', async () => {
        const event = exampleEvent('checks-failed', { source: 'reconciler' })

        for (const path of [SUBMIT, APPLY, RECONCILE_ALL, PAUSE]) {
          setUp({ run: runOf({ path }) })

          expect(
            (await corroborator.corroborateFailure(event, OPERATION)).ok
          ).toBe(true)
        }
      })

      test('refuses the run of a workflow it does not know', async () => {
        setUp({ run: runOf({ path: '.github/workflows/other.yml' }) })

        expect(
          await corroborator.corroborateFailure(
            exampleEvent('checks-failed', { source: 'reconciler' }),
            OPERATION
          )
        ).toEqual({ ok: false, reason: 'unexpected-workflow' })
      })
    })
  })

  describe('corroborateRun', () => {
    const event = exampleEvent('requested', { operationId: null })

    test('accepts a run of submit on main in a state repository', async () => {
      setUp({ run: runOf({ conclusion: 'success' }) })

      expect(await corroborator.corroborateRun(event)).toEqual({
        ok: true,
        run: runOf({ conclusion: 'success' })
      })
    })

    test('accepts a run in the deployments repository', async () => {
      expect(
        (
          await corroborator.corroborateRun({
            ...event,
            repository: DEPLOYMENTS
          })
        ).ok
      ).toBe(true)
      expect(runReader.getRun).toHaveBeenCalledWith({
        repository: DEPLOYMENTS,
        runId: event.runId
      })
    })

    test('refuses an unknown repository without reading the run', async () => {
      expect(
        await corroborator.corroborateRun({ ...event, repository: 'x/y' })
      ).toEqual({ ok: false, reason: 'unknown-repository' })
      expect(runReader.getRun).not.toHaveBeenCalled()
    })

    test('refuses a run that is not found', async () => {
      setUp({ run: null })

      expect(await corroborator.corroborateRun(event)).toEqual({
        ok: false,
        reason: 'run-not-found'
      })
    })

    test('refuses a run that is not on main', async () => {
      setUp({ run: runOf({ headBranch: 'feature' }) })

      expect(await corroborator.corroborateRun(event)).toEqual({
        ok: false,
        reason: 'not-on-main'
      })
    })

    test('refuses a run of a workflow the portal does not know', async () => {
      setUp({ run: runOf({ path: '.github/workflows/other.yml' }) })

      expect(await corroborator.corroborateRun(event)).toEqual({
        ok: false,
        reason: 'unexpected-workflow'
      })
    })

    test('holds an event to the workflow of its source', async () => {
      setUp({ run: runOf({ path: APPLY }) })

      expect(await corroborator.corroborateRun(event)).toEqual({
        ok: false,
        reason: 'unexpected-workflow'
      })
      expect(
        (
          await corroborator.corroborateRun(
            exampleEvent('deploying', { operationId: null })
          )
        ).ok
      ).toBe(true)
    })

    test('holds a pause event to the pause workflow', async () => {
      const pause = exampleEvent('paused', { operationId: null })

      setUp({ run: runOf({ path: PAUSE }) })
      expect((await corroborator.corroborateRun(pause)).ok).toBe(true)

      setUp({ run: runOf({ path: SUBMIT }) })
      expect(await corroborator.corroborateRun(pause)).toEqual({
        ok: false,
        reason: 'unexpected-workflow'
      })
    })
  })

  describe('corroboratePause', () => {
    const event = exampleEvent('paused')
    const pauseRun = runOf({
      path: PAUSE,
      name: 'Pause infradev',
      conclusion: 'success',
      actor: 'alice',
      triggeringActor: 'bob'
    })

    test('accepts a successful pause run on main when both actors are admins', async () => {
      setUp({ run: pauseRun })

      expect(await corroborator.corroboratePause(event)).toEqual({
        ok: true,
        run: pauseRun
      })
      expect(runReader.getActorPermission).toHaveBeenCalledWith({
        repository: TENANTS,
        username: 'alice'
      })
      expect(runReader.getActorPermission).toHaveBeenCalledWith({
        repository: TENANTS,
        username: 'bob'
      })
    })

    test('checks an actor who is also the triggering actor once', async () => {
      setUp({ run: { ...pauseRun, triggeringActor: 'alice' } })

      await corroborator.corroboratePause(event)

      expect(runReader.getActorPermission).toHaveBeenCalledTimes(1)
    })

    test('refuses an actor who is not an admin', async () => {
      setUp({ run: pauseRun, permission: 'write' })

      expect(await corroborator.corroboratePause(event)).toEqual({
        ok: false,
        reason: 'actor-not-admin'
      })
    })

    test('refuses when only the triggering actor is not an admin', async () => {
      setUp({ run: pauseRun })
      runReader.getActorPermission.mockImplementation(({ username }) =>
        Promise.resolve(username === 'alice' ? 'admin' : 'read')
      )

      expect(await corroborator.corroboratePause(event)).toEqual({
        ok: false,
        reason: 'actor-not-admin'
      })
    })

    test('refuses an actor with no permission on the repository', async () => {
      setUp({ run: pauseRun, permission: null })

      expect(await corroborator.corroboratePause(event)).toMatchObject({
        reason: 'actor-not-admin'
      })
    })

    test('refuses a run with no known actor, without asking about one', async () => {
      setUp({ run: { ...pauseRun, actor: null, triggeringActor: null } })

      expect(await corroborator.corroboratePause(event)).toEqual({
        ok: false,
        reason: 'actor-not-admin'
      })
      expect(runReader.getActorPermission).not.toHaveBeenCalled()
    })

    test.each(['failure', 'cancelled', 'skipped'])(
      'refuses a run that completed as %s',
      async (conclusion) => {
        setUp({ run: { ...pauseRun, conclusion } })

        expect(await corroborator.corroboratePause(event)).toEqual({
          ok: false,
          reason: 'run-did-not-succeed'
        })
        expect(runReader.getActorPermission).not.toHaveBeenCalled()
      }
    )

    test('allows a run still in progress', async () => {
      setUp({
        run: { ...pauseRun, status: 'in_progress', conclusion: null }
      })

      expect((await corroborator.corroboratePause(event)).ok).toBe(true)
    })

    test('refuses a run of another workflow', async () => {
      setUp({ run: { ...pauseRun, path: APPLY } })

      expect(await corroborator.corroboratePause(event)).toEqual({
        ok: false,
        reason: 'unexpected-workflow'
      })
    })

    test('refuses a run that is not on main', async () => {
      setUp({ run: { ...pauseRun, headBranch: 'feature' } })

      expect(await corroborator.corroboratePause(event)).toEqual({
        ok: false,
        reason: 'not-on-main'
      })
    })

    test('refuses an unknown repository and a run that is not found', async () => {
      expect(
        await corroborator.corroboratePause({ ...event, repository: 'x/y' })
      ).toEqual({ ok: false, reason: 'unknown-repository' })

      setUp({ run: null })

      expect(await corroborator.corroboratePause(event)).toEqual({
        ok: false,
        reason: 'run-not-found'
      })
    })
  })

  describe('corroborateCommit', () => {
    const SHA = '0123456789abcdef0123456789abcdef01234567'
    const event = { repository: TENANTS, commitSha: SHA }

    test('accepts a commit that is on main', async () => {
      expect(await corroborator.corroborateCommit(event)).toEqual({ ok: true })
      expect(runReader.isOnMain).toHaveBeenCalledWith({
        repository: TENANTS,
        sha: SHA
      })
    })

    test('refuses a commit that is not on main', async () => {
      setUp({ onMain: false })

      expect(await corroborator.corroborateCommit(event)).toEqual({
        ok: false,
        reason: 'commit-not-on-main'
      })
    })

    test('refuses an unknown repository without asking GitHub', async () => {
      expect(
        await corroborator.corroborateCommit({ ...event, repository: 'x/y' })
      ).toEqual({ ok: false, reason: 'unknown-repository' })
      expect(runReader.isOnMain).not.toHaveBeenCalled()
    })

    test('accepts the deployments repository too', async () => {
      expect(
        (
          await corroborator.corroborateCommit({
            ...event,
            repository: DEPLOYMENTS
          })
        ).ok
      ).toBe(true)
    })
  })
})

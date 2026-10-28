import { exampleEvent } from '#/common/test-helpers/gitops-messages.js'
import {
  RANK,
  decideEvent,
  deadlineFor,
  failurePolicy,
  heldDeadline,
  isRetryableRefusal,
  nextResubmitAt,
  overdueAction,
  rankOf,
  verifyOutcome
} from '#/operations/operation-state-machine.js'

function operation(state, extra = {}) {
  return { state, attempt: 1, gitops: {}, history: [], ...extra }
}

const retryable = (code) => ({
  failureReason: { code, message: 'm', retryable: true }
})

describe('#operation-state-machine', () => {
  describe('ranks', () => {
    test.each([
      ['queued', 0],
      ['requested', 1],
      ['committed', 2],
      ['checks-failed', 2],
      ['deploying', 3],
      ['deployed', 4],
      ['deploy-failed', 4],
      ['verified', 5],
      ['active', 6],
      ['removed', 6]
    ])('%s has rank %i', (state, rank) => {
      expect(RANK[state]).toBe(rank)
    })

    test('timed-out ranks as the state it left', () => {
      expect(rankOf({ state: 'timed-out', leftState: 'committed' })).toBe(2)
    })
  })

  describe('an event of a higher rank', () => {
    test.each([
      ['queued', 'requested'],
      ['requested', 'committed'],
      ['committed', 'deploying'],
      ['deploying', 'deployed'],
      ['requested', 'deployed'],
      ['requested', 'checks-failed'],
      ['deploying', 'deploy-failed']
    ])('moves %s to %s with the event’s facts', (from, status) => {
      const decision = decideEvent(operation(from), exampleEvent(status))

      expect(decision).toMatchObject({ kind: 'advance', state: status })
      expect(
        decision.facts.applyRunId ?? decision.facts.submitRunId
      ).toBeTruthy()
    })
  })

  describe('an event of a lower or equal rank', () => {
    test('fills only the facts that are missing (a commit after a redrive)', () => {
      const current = operation('deploying', {
        gitops: { submitRunId: 5, commitSha: null }
      })

      const decision = decideEvent(current, exampleEvent('committed'))

      expect(decision.kind).toBe('fill')
      expect(decision.facts).toMatchObject({ commitSha: expect.any(String) })
      expect(decision.facts).not.toHaveProperty('submitRunId')
    })

    test('never regresses the state, even for a checks-failed after the commit', () => {
      expect(
        decideEvent(operation('committed'), exampleEvent('checks-failed')).kind
      ).toBe('fill')
      expect(
        decideEvent(operation('active'), exampleEvent('requested')).kind
      ).toBe('fill')
    })

    test('a timed-out operation moves on only for a higher rank than the state it left', () => {
      const timedOut = operation('timed-out', { leftState: 'committed' })

      expect(decideEvent(timedOut, exampleEvent('deploying')).kind).toBe(
        'advance'
      )
      expect(decideEvent(timedOut, exampleEvent('committed')).kind).toBe('fill')
    })
  })

  test('a repeated event ID is a duplicate', () => {
    const event = exampleEvent('committed')

    expect(
      decideEvent(
        operation('committed', { history: [{ eventId: event.eventId }] }),
        event
      )
    ).toEqual({ kind: 'duplicate' })
  })

  describe('exception 1: a retryable checks-failed', () => {
    test.each(['stale-revision', 'paused', 'commit-conflict'])(
      'holds the operation for %s',
      (code) => {
        const event = exampleEvent('checks-failed', retryable(code))

        expect(isRetryableRefusal(event)).toBe(true)
        expect(decideEvent(operation('requested'), event)).toMatchObject({
          kind: 'hold',
          code
        })
      }
    )

    test('a non-retryable refusal ends the operation', () => {
      expect(
        decideEvent(operation('requested'), exampleEvent('checks-failed'))
      ).toMatchObject({ kind: 'advance', state: 'checks-failed' })
    })

    test('a retryable flag on any other code is not retried', () => {
      expect(
        isRetryableRefusal(exampleEvent('checks-failed', retryable('other')))
      ).toBe(false)
    })
  })

  describe('exception 2: a retryable deploy-failed (paused)', () => {
    test('changes no state and defers the apply', () => {
      const event = exampleEvent('deploy-failed', retryable('paused'))

      expect(decideEvent(operation('deploying'), event).kind).toBe('defer')
    })

    test('is ignored once the operation is past the apply', () => {
      const event = exampleEvent('deploy-failed', retryable('paused'))

      expect(decideEvent(operation('verified'), event).kind).toBe('fill')
    })
  })

  describe('exception 3: a deploying event from a newer run', () => {
    test('replaces the recorded apply run without moving the state', () => {
      const current = operation('deploying', {
        gitops: { applyRunId: 25000000005, applyRunUrl: 'old' }
      })

      expect(decideEvent(current, exampleEvent('deploying'))).toMatchObject({
        kind: 'replace-run',
        facts: { applyRunId: 25000000010 }
      })
    })

    test('replaces the run during a retry of a deploy-failed operation', () => {
      const current = operation('deploy-failed', {
        gitops: { applyRunId: 25000000005 },
        retrying: true
      })

      expect(decideEvent(current, exampleEvent('deploying')).kind).toBe(
        'replace-run'
      )
    })

    test('an older or the same run only fills', () => {
      const current = operation('deploying', {
        gitops: { applyRunId: 25000000010 }
      })

      expect(decideEvent(current, exampleEvent('deploying')).kind).toBe('fill')
    })
  })

  describe('exception 4: deployed replaces deploy-failed', () => {
    test('from the recorded run, whatever its attempt', () => {
      const current = operation('deploy-failed', {
        gitops: { applyRunId: 25000000010 }
      })

      expect(
        decideEvent(current, exampleEvent('deployed', { runAttempt: 2 }))
      ).toMatchObject({ kind: 'advance', state: 'deployed', recovered: true })
    })

    test('from a later run', () => {
      const current = operation('deploy-failed', {
        gitops: { applyRunId: 25000000001 }
      })

      expect(decideEvent(current, exampleEvent('deployed')).recovered).toBe(
        true
      )
    })

    test('not from an earlier run', () => {
      const current = operation('deploy-failed', {
        gitops: { applyRunId: 25000000099 }
      })

      expect(decideEvent(current, exampleEvent('deployed'))).toEqual({
        kind: 'ignore',
        reason: 'older-run'
      })
    })
  })

  describe('deploy-failed counts only from the recorded apply run', () => {
    test('an older run’s failure is ignored', () => {
      const current = operation('deploying', {
        gitops: { applyRunId: 25000000099 }
      })

      expect(decideEvent(current, exampleEvent('deploy-failed')).kind).toBe(
        'ignore'
      )
    })

    test('the retry’s own failure counts again, once per run attempt', () => {
      const failedOnce = operation('deploy-failed', {
        attempt: 2,
        retrying: true,
        gitops: { applyRunId: 25000000010 },
        lastFailure: { runId: 25000000007, runAttempt: 1 }
      })

      expect(
        decideEvent(failedOnce, exampleEvent('deploy-failed'))
      ).toMatchObject({ kind: 'advance', recount: true })
      expect(
        decideEvent(
          { ...failedOnce, lastFailure: { runId: 25000000010, runAttempt: 1 } },
          exampleEvent('deploy-failed')
        ).kind
      ).toBe('fill')
    })

    test('a failure after a failure with no retry in flight does not count twice', () => {
      expect(
        decideEvent(
          operation('deploy-failed', { gitops: { applyRunId: 25000000010 } }),
          exampleEvent('deploy-failed', { runAttempt: 2 })
        ).kind
      ).toBe('fill')
    })
  })

  describe('the failure policy', () => {
    test.each([
      [1, true, 'retry-apply'],
      [2, true, 'revert'],
      [1, false, 'alert'],
      [2, false, 'alert']
    ])('attempt %i, attributable %s: %s', (attempt, attributable, expected) => {
      expect(failurePolicy({ attempt }, { attributable })).toBe(expected)
    })
  })

  describe('deadlines', () => {
    const settings = { deadlines: { requested: 600000, active: 0 } }

    test('are set from entering a state that has one', () => {
      expect(deadlineFor('requested', settings, 0)).toBe(
        '1970-01-01T00:10:00.000Z'
      )
      expect(deadlineFor('active', settings, 0)).toBeNull()
      expect(deadlineFor('verified', settings, 0)).toBeNull()
    })

    test('an overdue operation is reconciled once, then timed out', () => {
      const past = new Date(Date.now() - 1000).toISOString()
      const future = new Date(Date.now() + 60000).toISOString()

      expect(overdueAction({ deadlineAt: future })).toBe('wait')
      expect(overdueAction({})).toBe('wait')
      expect(overdueAction({ deadlineAt: past, reconcileCount: 0 })).toBe(
        'reconcile'
      )
      expect(overdueAction({ deadlineAt: past })).toBe('reconcile')
      expect(overdueAction({ deadlineAt: past, reconcileCount: 1 })).toBe(
        'time-out'
      )
    })
  })

  describe('verification retries', () => {
    test.each([
      [1, 30000],
      [2, 60000],
      [3, 120000],
      [4, 240000]
    ])('after failed attempt %i it retries %i ms later', (attempts, delay) => {
      expect(verifyOutcome(attempts, 5, 0)).toEqual({
        kind: 'retry',
        nextAt: new Date(delay).toISOString()
      })
    })

    test('the fifth failed attempt ends it', () => {
      expect(verifyOutcome(5, 5, 0)).toEqual({ kind: 'fail' })
    })

    test('a higher bound keeps the longest delay', () => {
      expect(verifyOutcome(6, 8, 0).nextAt).toBe(new Date(240000).toISOString())
    })
  })

  describe('resubmission and the held deadline', () => {
    test('resubmits after 10, 30 and 90 seconds, then gives up', () => {
      expect(nextResubmitAt(0, 3, 0)).toBe(new Date(10000).toISOString())
      expect(nextResubmitAt(1, 3, 0)).toBe(new Date(30000).toISOString())
      expect(nextResubmitAt(2, 3, 0)).toBe(new Date(90000).toISOString())
      expect(nextResubmitAt(3, 3, 0)).toBeNull()
    })

    test('the held deadline doubles up to four hours', () => {
      const base = 1800000

      expect(heldDeadline(base, 0, 0)).toBe(new Date(base).toISOString())
      expect(heldDeadline(base, 1, 0)).toBe(new Date(2 * base).toISOString())
      expect(heldDeadline(base, 5, 0)).toBe(
        new Date(4 * 60 * 60 * 1000).toISOString()
      )
    })
  })
})

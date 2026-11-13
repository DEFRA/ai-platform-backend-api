import { isRetryable } from '#/operations/operations-retry.js'

describe('#operations-retry isRetryable', () => {
  test.each([
    ['an apply that failed', { state: 'deploy-failed' }, true],
    ['an operation that timed out', { state: 'timed-out' }, true],
    ['a held write', { state: 'queued', held: { since: 'now' } }, true],
    ['a change that failed its checks', { state: 'checks-failed' }, false],
    ['an operation that is waiting for the file', { state: 'queued' }, false],
    ['an operation that is deploying', { state: 'deploying' }, false],
    ['an active deployment', { state: 'active' }, false]
  ])('says %s is retryable: %s', (_name, operation, expected) => {
    expect(isRetryable(operation)).toBe(expected)
  })
})

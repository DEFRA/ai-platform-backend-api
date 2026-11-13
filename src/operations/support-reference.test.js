import {
  failureLogFields,
  supportReferenceOf
} from '#/operations/support-reference.js'

describe('supportReferenceOf', () => {
  test('is AIP- and the last five characters of the operation id, in upper case', () => {
    expect(supportReferenceOf('0192f7a0-7c3e-7b1a-9d4e-5f6a7b8c9d0e')).toBe(
      'AIP-C9D0E'
    )
  })

  test.each([null, undefined, '', 42])('is null for %s', (id) => {
    expect(supportReferenceOf(id)).toBeNull()
  })
})

describe('failureLogFields', () => {
  test('keys the operation, team, models, error and trace ids by the reference', () => {
    const fields = failureLogFields(
      {
        _id: 'op-abcde12345',
        type: 'team-file.write',
        teamId: 'team-1',
        environment: 'infradev',
        items: [
          { entryId: 'e1', modelSlug: 'gpt-4o', change: 'add', extra: 'x' }
        ],
        state: 'deploy-failed',
        attempt: 2,
        reconcileCount: 0,
        error: { code: 'operation-deploy-failed', message: 'boom' },
        gitops: { applyRunUrl: 'https://github.com/run/1', commitSha: 'abc' },
        requestedByUserId: 'user-1',
        traceparent: '00-trace',
        cdpRequestId: 'cdp-1'
      },
      'deploying'
    )

    expect(fields).toEqual({
      supportReference: 'AIP-12345',
      operationId: 'op-abcde12345',
      operationType: 'team-file.write',
      teamId: 'team-1',
      environment: 'infradev',
      entries: [{ entryId: 'e1', modelSlug: 'gpt-4o', change: 'add' }],
      state: 'deploy-failed',
      previousState: 'deploying',
      leftState: null,
      attempt: 2,
      reconcileCount: 0,
      errorCode: 'operation-deploy-failed',
      errorMessage: 'boom',
      submitRunUrl: null,
      applyRunUrl: 'https://github.com/run/1',
      commitSha: 'abc',
      requestedByUserId: 'user-1',
      traceparent: '00-trace',
      cdpRequestId: 'cdp-1'
    })
  })

  test('lists only the model changes as entries, not a limits change', () => {
    const fields = failureLogFields(
      {
        _id: 'op-1',
        state: 'deploy-failed',
        items: [
          { entryId: 'e1', modelSlug: 'gpt-4o', change: 'add' },
          { kind: 'limits', change: 'set', limits: {} }
        ]
      },
      'deploying'
    )

    expect(fields.entries).toEqual([
      { entryId: 'e1', modelSlug: 'gpt-4o', change: 'add' }
    ])
  })

  test('has null for what the operation does not have', () => {
    expect(
      failureLogFields({ _id: 'op-1', state: 'timed-out' }, 'committed')
    ).toMatchObject({
      entries: [],
      errorCode: null,
      commitSha: null,
      traceparent: null,
      cdpRequestId: null
    })
  })
})

import { isPolicyRefusal, withSubmit } from '#/operations/operations-support.js'

describe('isPolicyRefusal', () => {
  test.each([
    'desired-state-unavailable',
    'desired-state-too-large',
    'invalid-path',
    'limits-out-of-bounds',
    'model-not-eligible',
    'service-code-required'
  ])(
    'treats %s as a request that can never be submitted as it stands',
    (code) => {
      expect(isPolicyRefusal({ data: { code } })).toBe(true)
      expect(isPolicyRefusal({ code })).toBe(true)
    }
  )

  test.each([
    [{ data: { code: 'team-file-busy' } }],
    [new Error('GitHub is down')],
    [undefined]
  ])('treats %j as a failure to retry', (error) => {
    expect(isPolicyRefusal(error)).toBe(false)
  })
})

describe('withSubmit', () => {
  const submission = { document: { revision: 4 } }

  test('submits the built document as the operation’s own attempt by default', () => {
    const { set, push } = withSubmit({ attempt: 2 }, submission)

    expect(set).toMatchObject({ revision: 4, outboxPending: true })
    expect(push.outbox).toMatchObject({ type: 'submit', attempt: 2 })
  })

  test('submits as the attempt it is given', () => {
    const { push } = withSubmit({ attempt: 2 }, submission, 3)

    expect(push.outbox).toMatchObject({ type: 'submit', attempt: 3 })
  })

  test('records no revision for a document that has none', () => {
    const { set } = withSubmit({ attempt: 1 }, { document: {} })

    expect(set.revision).toBeNull()
  })
})

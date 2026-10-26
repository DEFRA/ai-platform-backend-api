import {
  exampleCommand,
  exampleEvent
} from '#/common/test-helpers/gitops-messages.js'
import {
  validateCommand,
  validateEvent
} from '#/contracts/message-validators.js'

describe('#message-validators', () => {
  describe('commands', () => {
    test('accepts a submit, a reconcile and an apply', () => {
      expect(validateCommand(exampleCommand())).toEqual({
        valid: true,
        errors: []
      })
      expect(
        validateCommand(
          exampleCommand({
            type: 'reconcile',
            state: 'requested'
          })
        ).valid
      ).toBe(true)
      expect(
        validateCommand({
          ...exampleCommand({
            type: 'apply',
            operationId: null,
            team: null,
            path: null
          }),
          action: undefined,
          document: undefined,
          expectedRevision: undefined
        }).valid
      ).toBe(true)
    })

    test.each([
      ['an unknown field', { surprise: true }],
      ['a bad schema identifier', { schema: 'aip.gitops.command/2' }],
      ['a commandId that is not a UUIDv7', { commandId: 'abc' }],
      ['a requester that is a name', { requestedBy: 'Jo Bloggs' }],
      ['a write with no document', { document: undefined }]
    ])('refuses %s, naming the path and not the data', (_name, change) => {
      const { valid, errors } = validateCommand(exampleCommand(change))

      expect(valid).toBe(false)
      expect(errors.length).toBeGreaterThan(0)
      expect(JSON.stringify(errors)).not.toContain('Jo Bloggs')
    })
  })

  describe('events', () => {
    test.each([
      'requested',
      'checks-failed',
      'committed',
      'deploying',
      'deployed',
      'deploy-failed'
    ])('accepts a %s event', (status) => {
      expect(validateEvent(exampleEvent(status)).valid).toBe(true)
    })

    test('accepts a pause and a resume', () => {
      for (const status of ['paused', 'resumed']) {
        expect(
          validateEvent(
            exampleEvent(status, {
              action: 'pause',
              operationId: null,
              team: null,
              path: null
            })
          ).valid
        ).toBe(true)
      }
    })

    test.each([
      ['an extra field', { surprise: 1 }],
      ['a status the contract does not have', { status: 'merged' }],
      ['no event ID', { eventId: undefined }],
      ['a run URL on another host', { runUrl: 'https://example.com/runs/1' }],
      [
        'a retryable flag on a code that is never retryable',
        {
          status: 'checks-failed',
          failureReason: { code: 'x-y', message: 'm', retryable: true }
        }
      ]
    ])('refuses %s', (_name, change) => {
      const event = exampleEvent('requested', change)

      expect(validateEvent(event).valid).toBe(false)
    })
  })
})

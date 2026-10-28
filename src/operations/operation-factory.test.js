import { messageGroupId } from '#/adapters/command-publisher.js'
import { canonicalJson } from '#/common/helpers/canonical-json.js'
import { OID, SHA, TRACEPARENT } from '#/common/test-helpers/gitops-messages.js'
import { validateCommand } from '#/contracts/message-validators.js'
import {
  buildCommand,
  buildOperation,
  canonicalDocument,
  newOutboxEntry,
  submissionFields
} from '#/operations/operation-factory.js'

const NOW = '2026-10-26T12:00:00.000Z'
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const TEAM_TARGET = {
  repository: 'DEFRA/ai-platform-tenants',
  team: 'alpha',
  path: 'environments/infradev/alpha.json'
}
const PIN_TARGET = {
  repository: 'DEFRA/ai-platform-deployments',
  team: 'platform',
  path: 'environments/infradev/platform.json'
}
const ITEMS = [{ entryId: 'entry-1', modelSlug: 'gpt-4o', change: 'add' }]

function teamOperation(overrides = {}) {
  return {
    ...buildOperation({
      type: 'team-file.write',
      state: 'requested',
      teamId: 'team-1',
      environment: 'infradev',
      target: TEAM_TARGET,
      items: ITEMS,
      slot: 'active',
      requestedBy: `entra:${OID}`,
      requestedByUserId: 'user-1',
      now: NOW
    }),
    ...submissionFields({
      document: { revision: 4, environment: 'infradev' },
      expectedRevision: 3
    }),
    ...overrides
  }
}

function pinOperation(overrides = {}) {
  return {
    ...buildOperation({
      type: 'pin.write',
      state: 'requested',
      teamId: 'platform',
      environment: 'infradev',
      target: PIN_TARGET,
      items: [],
      slot: 'active',
      requestedBy: 'app:ai-platform-backend',
      now: NOW
    }),
    ...submissionFields({
      document: { pins: { alpha: SHA } },
      expectedBase: SHA
    }),
    ...overrides
  }
}

function entryOf(type, overrides = {}) {
  return { ...newOutboxEntry(type, { attempt: 1 }, { now: NOW }), ...overrides }
}

describe('newOutboxEntry', () => {
  test('creates an unclaimed, unpublished entry with a UUIDv7 command ID', () => {
    const entry = newOutboxEntry('submit', { attempt: 2 }, { now: NOW })

    expect(entry).toEqual({
      commandId: expect.stringMatching(UUID_V7),
      type: 'submit',
      attempt: 2,
      createdAt: NOW,
      claimedUntil: null,
      publishedAt: null
    })
  })

  test('gives every entry its own command ID', () => {
    const first = newOutboxEntry('apply', { attempt: 1 })
    const second = newOutboxEntry('apply', { attempt: 1 })

    expect(first.commandId).not.toBe(second.commandId)
  })

  test('keeps the state of a reconcile entry', () => {
    const entry = newOutboxEntry(
      'reconcile',
      { attempt: 1 },
      { state: 'deploying', now: NOW }
    )

    expect(entry.state).toBe('deploying')
  })

  test('leaves the state out of an entry that has none', () => {
    expect(newOutboxEntry('submit', { attempt: 1 })).not.toHaveProperty('state')
  })

  test('stamps the current time when none is given', () => {
    const before = Date.now()
    const { createdAt } = newOutboxEntry('submit', { attempt: 1 })

    expect(Date.parse(createdAt)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(createdAt)).toBeLessThanOrEqual(Date.now())
  })
})

describe('canonicalDocument', () => {
  test('returns the canonical bytes: sorted keys, two-space indent, one trailing newline', () => {
    const text = canonicalDocument({ b: 1, a: { d: 2, c: [3] } })

    expect(text).toBe(
      '{\n  "a": {\n    "c": [\n      3\n    ],\n    "d": 2\n  },\n  "b": 1\n}\n'
    )
    expect(text).toBe(canonicalJson({ a: { c: [3], d: 2 }, b: 1 }))
  })

  // `{\n  "a": "` and `"\n}\n` around the value are 14 bytes.
  test('accepts a document of exactly 60 KB', () => {
    const text = canonicalDocument({ a: 'x'.repeat(60 * 1024 - 14) })

    expect(Buffer.byteLength(text)).toBe(60 * 1024)
  })

  test('refuses a document one byte over 60 KB with a coded error', () => {
    const attempt = () => canonicalDocument({ a: 'x'.repeat(60 * 1024 - 13) })

    expect(attempt).toThrow('The desired-state document is too large')
    expect(attempt).toThrow(
      expect.objectContaining({ code: 'desired-state-too-large' })
    )
  })

  test('measures bytes rather than characters', () => {
    const document = { a: 'é'.repeat(31000) }

    expect(JSON.stringify(document).length).toBeLessThan(60 * 1024)
    expect(() => canonicalDocument(document)).toThrow(
      expect.objectContaining({ code: 'desired-state-too-large' })
    )
  })
})

describe('buildOperation', () => {
  test('builds an active operation at version 0 with its history, an empty outbox and no optional fields', () => {
    const operation = buildOperation({
      type: 'team-file.write',
      state: 'requested',
      teamId: 'team-1',
      environment: 'infradev',
      target: TEAM_TARGET,
      items: ITEMS,
      slot: 'active',
      idempotencyKeys: ['key-1'],
      requestedBy: `entra:${OID}`,
      requestedByUserId: 'user-1',
      now: NOW
    })

    expect(operation).toEqual({
      _id: expect.stringMatching(UUID_V7),
      type: 'team-file.write',
      teamId: 'team-1',
      environment: 'infradev',
      target: TEAM_TARGET,
      items: ITEMS,
      action: 'write',
      requestedBy: `entra:${OID}`,
      requestedByUserId: 'user-1',
      traceparent: null,
      cdpRequestId: null,
      state: 'requested',
      stateVersion: 0,
      attempt: 1,
      reconcileCount: 0,
      verify: { attempts: 0, nextAt: null },
      gitops: {},
      history: [
        {
          state: 'requested',
          at: NOW,
          receivedAt: NOW,
          source: 'backend',
          eventId: null
        }
      ],
      outbox: [],
      outboxPending: false,
      createdAt: NOW,
      updatedAt: NOW,
      slot: 'active',
      idempotencyKeys: ['key-1']
    })
    expect(operation).not.toHaveProperty('held')
    expect(operation).not.toHaveProperty('parentId')
  })

  test('builds a waiting operation as queued in the waiting slot, holding items only', () => {
    const operation = buildOperation({
      type: 'team-file.write',
      state: 'queued',
      teamId: 'team-1',
      environment: 'infradev',
      target: TEAM_TARGET,
      items: ITEMS,
      slot: 'waiting',
      requestedBy: `entra:${OID}`,
      now: NOW
    })

    expect(operation).toMatchObject({ state: 'queued', slot: 'waiting' })
    expect(operation.history[0].state).toBe('queued')
    expect(operation).not.toHaveProperty('document')
    expect(operation).not.toHaveProperty('idempotencyKeys')
  })

  test('records a parent on a revert and the held reason of a held operation', () => {
    const operation = buildOperation({
      type: 'team-file.revert',
      state: 'queued',
      teamId: 'team-1',
      environment: 'infradev',
      target: TEAM_TARGET,
      items: ITEMS,
      parentId: 'parent-op-1',
      held: { reason: 'paused' },
      action: 'revert',
      requestedBy: 'app:ai-platform-backend',
      now: NOW
    })

    expect(operation).toMatchObject({
      parentId: 'parent-op-1',
      held: { reason: 'paused' },
      action: 'revert'
    })
    expect(operation).not.toHaveProperty('slot')
  })

  test('carries the trace identifiers of the request', () => {
    const operation = buildOperation({
      type: 'team-file.write',
      state: 'requested',
      teamId: 'team-1',
      environment: 'infradev',
      target: TEAM_TARGET,
      items: ITEMS,
      requestedBy: `entra:${OID}`,
      traceparent: TRACEPARENT,
      cdpRequestId: 'request-1'
    })

    expect(operation.traceparent).toBe(TRACEPARENT)
    expect(operation.cdpRequestId).toBe('request-1')
  })

  test('records the outcome a mock request forces, and nothing otherwise', () => {
    const params = {
      type: 'team-file.write',
      state: 'requested',
      teamId: 'team-1',
      environment: 'infradev',
      target: TEAM_TARGET,
      items: ITEMS,
      requestedBy: `entra:${OID}`
    }

    expect(
      buildOperation({ ...params, mockOutcome: 'deploy-failed' }).mockOutcome
    ).toBe('deploy-failed')
    expect(buildOperation(params)).not.toHaveProperty('mockOutcome')
  })

  test('gives each operation its own ID and stamps the current time by default', () => {
    const params = {
      type: 'team-file.write',
      state: 'requested',
      teamId: 'team-1',
      environment: 'infradev',
      target: TEAM_TARGET,
      items: ITEMS,
      requestedBy: `entra:${OID}`
    }
    const first = buildOperation(params)
    const second = buildOperation(params)

    expect(first._id).not.toBe(second._id)
    expect(first.createdAt).toBe(first.history[0].at)
    expect(Number.isNaN(Date.parse(first.createdAt))).toBe(false)
  })
})

describe('submissionFields', () => {
  test('returns the canonical document and the revision it was built on', () => {
    expect(
      submissionFields({ document: { b: 1, a: 2 }, expectedRevision: 3 })
    ).toEqual({
      document: '{\n  "a": 2,\n  "b": 1\n}\n',
      expectedRevision: 3
    })
  })

  test('keeps a revision of 0 for a new file', () => {
    expect(
      submissionFields({ document: { a: 1 }, expectedRevision: 0 })
    ).toHaveProperty('expectedRevision', 0)
  })

  test('keeps a null base for the first pin of an environment', () => {
    const fields = submissionFields({ document: { a: 1 }, expectedBase: null })

    expect(fields).toHaveProperty('expectedBase', null)
    expect(fields).not.toHaveProperty('expectedRevision')
  })

  test('keeps the blob SHA a pin was built on', () => {
    expect(
      submissionFields({ document: { a: 1 }, expectedBase: SHA }).expectedBase
    ).toBe(SHA)
  })

  test('refuses a document that is too large to dispatch', () => {
    expect(() =>
      submissionFields({ document: { a: 'x'.repeat(61 * 1024) } })
    ).toThrow(expect.objectContaining({ code: 'desired-state-too-large' }))
  })
})

describe('buildCommand', () => {
  describe('a submit for a team file', () => {
    test('passes the command contract, carrying the action, document and expected revision', () => {
      const operation = teamOperation()
      const entry = entryOf('submit')
      const command = buildCommand(operation, entry)

      expect(validateCommand(command)).toEqual({ valid: true, errors: [] })
      expect(command).toEqual({
        schema: 'aip.gitops.command/1',
        type: 'submit',
        commandId: entry.commandId,
        operationId: operation._id,
        environment: 'infradev',
        team: 'alpha',
        repository: 'DEFRA/ai-platform-tenants',
        path: 'environments/infradev/alpha.json',
        action: 'write',
        document: operation.document,
        expectedRevision: 3,
        attempt: 1,
        requestedBy: `entra:${OID}`,
        traceparent: null,
        cdpRequestId: null,
        createdAt: NOW
      })
    })

    test('uses 0 as the expected revision of a file the operation has not read', () => {
      const operation = teamOperation({ expectedRevision: undefined })
      const command = buildCommand(operation, entryOf('submit'))

      expect(command.expectedRevision).toBe(0)
      expect(validateCommand(command).valid).toBe(true)
    })

    test('carries no base, state or pin field', () => {
      const command = buildCommand(teamOperation(), entryOf('submit'))

      expect(command).not.toHaveProperty('expectedBase')
      expect(command).not.toHaveProperty('state')
    })

    test('carries the trace identifiers of the operation', () => {
      const command = buildCommand(
        teamOperation({ traceparent: TRACEPARENT, cdpRequestId: 'request-1' }),
        entryOf('submit')
      )

      expect(command).toMatchObject({
        traceparent: TRACEPARENT,
        cdpRequestId: 'request-1'
      })
      expect(validateCommand(command).valid).toBe(true)
    })

    test('defaults the trace identifiers to null when the operation has none', () => {
      const operation = teamOperation()

      delete operation.traceparent
      delete operation.cdpRequestId

      const command = buildCommand(operation, entryOf('submit'))

      expect(command.traceparent).toBeNull()
      expect(command.cdpRequestId).toBeNull()
    })

    test('carries the attempt of the entry, not the operation', () => {
      const command = buildCommand(
        teamOperation(),
        entryOf('submit', { attempt: 3 })
      )

      expect(command.attempt).toBe(3)
    })

    test('is grouped by environment and team', () => {
      const command = buildCommand(teamOperation(), entryOf('submit'))

      expect(messageGroupId(command)).toBe('infradev/alpha')
    })

    test('carries a remove with no document', () => {
      const operation = teamOperation({ action: 'remove' })

      delete operation.document

      const command = buildCommand(operation, entryOf('submit'))

      expect(command).toMatchObject({ action: 'remove' })
      expect(command).not.toHaveProperty('document')
      expect(validateCommand(command).valid).toBe(true)
    })
  })

  describe('a submit for a pin', () => {
    test('passes the command contract, carrying the expected base and no revision', () => {
      const operation = pinOperation()
      const command = buildCommand(operation, entryOf('submit'))

      expect(validateCommand(command)).toEqual({ valid: true, errors: [] })
      expect(command).toMatchObject({
        team: 'platform',
        repository: 'DEFRA/ai-platform-deployments',
        path: 'environments/infradev/platform.json',
        expectedBase: SHA,
        requestedBy: 'app:ai-platform-backend'
      })
      expect(command).not.toHaveProperty('expectedRevision')
    })

    test('carries a null base for the first pin of an environment', () => {
      const command = buildCommand(
        pinOperation({ expectedBase: null }),
        entryOf('submit')
      )

      expect(command.expectedBase).toBeNull()
      expect(validateCommand(command).valid).toBe(true)
    })

    test('carries a null base when the operation never read one', () => {
      const command = buildCommand(
        pinOperation({ expectedBase: undefined }),
        entryOf('submit')
      )

      expect(command.expectedBase).toBeNull()
      expect(validateCommand(command).valid).toBe(true)
    })

    test('treats the tenants pin as a pin too', () => {
      const command = buildCommand(
        pinOperation({
          target: {
            ...PIN_TARGET,
            team: 'tenants',
            path: 'environments/infradev/tenants.json'
          }
        }),
        entryOf('submit')
      )

      expect(command).toHaveProperty('expectedBase', SHA)
      expect(command).not.toHaveProperty('expectedRevision')
      expect(validateCommand(command).valid).toBe(true)
    })

    test('is grouped by environment and the platform team', () => {
      const command = buildCommand(pinOperation(), entryOf('submit'))

      expect(messageGroupId(command)).toBe('infradev/platform')
    })
  })

  describe('a reconcile from requested', () => {
    test('carries the action, document and base so the worker can dispatch again', () => {
      const operation = teamOperation()
      const entry = entryOf('reconcile', { state: 'requested' })
      const command = buildCommand(operation, entry)

      expect(validateCommand(command)).toEqual({ valid: true, errors: [] })
      expect(command).toMatchObject({
        type: 'reconcile',
        state: 'requested',
        action: 'write',
        document: operation.document,
        expectedRevision: 3
      })
    })

    test('carries the expected base of a pin', () => {
      const command = buildCommand(
        pinOperation(),
        entryOf('reconcile', { state: 'requested' })
      )

      expect(command.expectedBase).toBe(SHA)
      expect(validateCommand(command).valid).toBe(true)
    })

    describe('submittedAt', () => {
      const FIRST = '2026-10-26T12:00:00.000Z'
      const RESUBMITTED = '2026-10-26T12:20:00.000Z'
      const RECONCILE_AT = '2026-10-26T12:30:00.000Z'

      function submittedTwice() {
        return teamOperation({
          attempt: 2,
          outbox: [
            entryOf('submit', { createdAt: FIRST }),
            entryOf('reconcile', {
              state: 'requested',
              createdAt: '2026-10-26T12:10:00.000Z'
            }),
            entryOf('submit', { attempt: 2, createdAt: RESUBMITTED })
          ]
        })
      }

      test('is the creation time of the latest submit entry, not the first, after a resubmission', () => {
        const command = buildCommand(
          submittedTwice(),
          entryOf('reconcile', { state: 'requested', createdAt: RECONCILE_AT })
        )

        expect(command.submittedAt).toBe(RESUBMITTED)
        expect(command.createdAt).toBe(RECONCILE_AT)
        expect(validateCommand(command)).toEqual({ valid: true, errors: [] })
      })

      test('is the time of the only submit entry when there was no resubmission', () => {
        const operation = teamOperation({
          outbox: [entryOf('submit', { createdAt: FIRST })]
        })
        const command = buildCommand(
          operation,
          entryOf('reconcile', { state: 'requested' })
        )

        expect(command.submittedAt).toBe(FIRST)
      })

      test('is left out when the operation has no submit entry', () => {
        const command = buildCommand(
          teamOperation({ outbox: [] }),
          entryOf('reconcile', { state: 'requested' })
        )

        expect(command).not.toHaveProperty('submittedAt')
        expect(validateCommand(command).valid).toBe(true)
      })

      test.each(['committed', 'deploying', 'deployed'])(
        'is left out of a reconcile from %s',
        (state) => {
          const command = buildCommand(
            submittedTwice(),
            entryOf('reconcile', { state })
          )

          expect(command).not.toHaveProperty('submittedAt')
          expect(validateCommand(command).valid).toBe(true)
        }
      )

      test.each(['submit', 'apply'])('is left out of a %s', (type) => {
        const command = buildCommand(submittedTwice(), entryOf(type))

        expect(command).not.toHaveProperty('submittedAt')
        expect(validateCommand(command).valid).toBe(true)
      })
    })
  })

  describe('a reconcile from a later state', () => {
    test.each(['committed', 'deploying', 'deployed'])(
      'carries the state %s and no document, action or base',
      (state) => {
        const command = buildCommand(
          teamOperation(),
          entryOf('reconcile', { state })
        )

        expect(validateCommand(command)).toEqual({ valid: true, errors: [] })
        expect(command.state).toBe(state)
        expect(command).not.toHaveProperty('document')
        expect(command).not.toHaveProperty('action')
        expect(command).not.toHaveProperty('expectedRevision')
        expect(command).not.toHaveProperty('expectedBase')
      }
    )
  })

  describe('an apply', () => {
    test('passes the command contract with no submission fields or state', () => {
      const command = buildCommand(teamOperation(), entryOf('apply'))

      expect(validateCommand(command)).toEqual({ valid: true, errors: [] })
      expect(command.type).toBe('apply')
      expect(command).not.toHaveProperty('action')
      expect(command).not.toHaveProperty('document')
      expect(command).not.toHaveProperty('expectedRevision')
      expect(command).not.toHaveProperty('state')
    })

    test('carries the attempt of the entry', () => {
      const command = buildCommand(
        teamOperation(),
        entryOf('apply', { attempt: 2 })
      )

      expect(command.attempt).toBe(2)
    })
  })
})

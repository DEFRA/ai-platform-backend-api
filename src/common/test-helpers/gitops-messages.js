import { uuidv7 } from '#/common/helpers/uuid-v7.js'

// Valid `aip.gitops.command/1` and `aip.gitops.event/1` messages for tests,
// built from the shapes in ai-platform-infra's `schemas/messages/examples/`.

export const SHA = '0123456789abcdef0123456789abcdef01234567'
export const OID = '00000000-0000-0000-0000-000000000001'
export const TRACEPARENT =
  '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'

/**
 * A valid submit command; `overrides` replace any field.
 * @param {object} [overrides]
 */
export function exampleCommand(overrides = {}) {
  return {
    schema: 'aip.gitops.command/1',
    type: 'submit',
    commandId: uuidv7(),
    operationId: 'op-7f3c9a1e',
    environment: 'infradev',
    team: 'alpha',
    repository: 'DEFRA/ai-platform-tenants',
    path: 'environments/infradev/alpha.json',
    action: 'write',
    document: '{\n  "environment": "infradev",\n  "revision": 4\n}\n',
    expectedRevision: 3,
    attempt: 1,
    requestedBy: `entra:${OID}`,
    traceparent: TRACEPARENT,
    cdpRequestId: '3f2b8d1c-6a4e-4c7b-9d2a-1e5f0a7b8c9d',
    createdAt: '2026-10-26T12:00:00Z',
    ...overrides
  }
}

const RUNS = {
  submit: 25000000001,
  apply: 25000000010,
  pause: 25000000020,
  reconciler: 25000000030
}

const SOURCE_OF = {
  requested: 'submit',
  'checks-failed': 'submit',
  committed: 'submit',
  deploying: 'apply',
  deployed: 'apply',
  'deploy-failed': 'apply',
  paused: 'pause',
  resumed: 'pause'
}

const REPOSITORY = 'DEFRA/ai-platform-tenants'

// The fields a status carries beyond the common ones (plan 5, event table).
function statusFields(status) {
  if (['committed', 'deploying', 'deployed'].includes(status)) {
    return { commitSha: SHA, committedAt: '2026-10-26T12:00:24Z' }
  }

  return {}
}

const FAILURES = {
  'checks-failed': {
    failureReason: {
      code: 'validation-failed',
      message: 'The file failed validation',
      retryable: false
    }
  },
  'deploy-failed': {
    failureReason: {
      code: 'apply-failed',
      message: 'The apply failed',
      retryable: false
    },
    failingTeams: ['alpha'],
    attributable: true
  },
  deployed: {
    appliedSha: SHA,
    resources: [
      {
        type: 'azapi_resource.foundry_project',
        name: 'aip-alpha',
        id: '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/example/providers/Microsoft.CognitiveServices/accounts/example/projects/aip-alpha'
      }
    ]
  }
}

/**
 * A valid event for a status; `overrides` replace any field. The run ID is
 * per source, and the event ID follows the contract.
 * @param {string} status
 * @param {object} [overrides]
 */
export function exampleEvent(status, overrides = {}) {
  const source = overrides.source ?? SOURCE_OF[status]
  const runId = overrides.runId ?? RUNS[source]
  const runAttempt = overrides.runAttempt ?? 1
  const operationId =
    'operationId' in overrides ? overrides.operationId : 'op-7f3c9a1e'
  const subject = operationId ?? overrides.environment ?? 'infradev'

  return {
    schema: 'aip.gitops.event/1',
    eventId: `${subject}:${status}:${runId}:${runAttempt}`,
    environment: 'infradev',
    team: 'alpha',
    path: 'environments/infradev/alpha.json',
    action: 'write',
    status,
    timestamp: '2026-10-26T12:00:05Z',
    source,
    requestedBy: `entra:${OID}`,
    repository: REPOSITORY,
    traceparent: TRACEPARENT,
    cdpRequestId: '3f2b8d1c-6a4e-4c7b-9d2a-1e5f0a7b8c9d',
    operationId,
    runId,
    runAttempt,
    runUrl: `https://github.com/${REPOSITORY}/actions/runs/${runId}`,
    ...statusFields(status),
    ...FAILURES[status],
    ...overrides
  }
}

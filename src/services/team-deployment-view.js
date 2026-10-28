import { credentialIssuerRegistry } from '#/adapters/credential-issuer-registry.js'
import {
  REMOVED,
  REMOVING,
  TERMINAL_FAILURE_STATUSES
} from '#/services/team-deployment-entries.js'

// User-facing progress steps for the team's "being set up" wait page - the
// mapping from the operation's states (never shown to the user directly) to
// these five friendly labels is a business rule, so it lives here rather than
// being guessed at again in the frontend. The team tier is OAuth only, so its
// last step prepares an OAuth client secret. The label does not claim the
// secret is made in Entra while that issuer is mocked. Each step starts when
// the entry first reaches its status (`entry.statusTimes`); a step ends when
// the next one starts, the last when the deployment turns `active`.
const PROGRESS_STEPS = [
  { label: () => 'Request recorded', statuses: ['requested'] },
  { label: () => 'Change committed', statuses: ['committed'] },
  {
    label: (modelName) => `Setting up ${modelName} in Azure`,
    statuses: ['deploying']
  },
  {
    // The apply has finished: what remains is the ARM check, which can retry
    // for several minutes.
    label: () => 'Checking your resources in Azure',
    statuses: ['deployed']
  },
  { label: () => 'Preparing your client secret', statuses: ['verified'] }
]

const PROGRESS_STEP_INDEX_BY_STATUS = {
  requested: 0,
  committed: 1,
  deploying: 2,
  deployed: 3,
  verified: 4,
  // Past the last step: every step reads done.
  active: PROGRESS_STEPS.length
}

// A held operation has no steps either: the frontend shows its own messaging.
const NO_STEPS = new Set([...TERMINAL_FAILURE_STATUSES, 'timed-out'])

function stepState(index, currentIndex) {
  if (index < currentIndex) {
    return 'done'
  }

  return index === currentIndex ? 'current' : 'pending'
}

// When each step started, then when the last one ended (so one more than
// there are steps), from the times the entry recorded. A step the entry went
// past without seeing it takes the start of the next, so it reads as instant,
// and no step starts after the next one does (a retry that records
// `deploying` after `deployed` was reached must not move the steps before
// it); entries from before times were recorded fall back to when they were
// created and activated, and otherwise have none (null).
function stepBoundaries(entry) {
  const times = entry.statusTimes ?? {}
  const boundaries = [times.active ?? entry.activatedAt ?? null]

  for (const step of [...PROGRESS_STEPS].reverse()) {
    const next = boundaries[0]
    const starts = step.statuses.map((status) => times[status]).filter(Boolean)
    const start = starts.sort()[0] ?? next

    boundaries.unshift(next && next < start ? next : start)
  }

  boundaries[0] = times.requested ?? entry.createdAt ?? boundaries[0]

  return boundaries
}

/**
 * Builds the five progress steps shown on the team-request wait page,
 * marking each `done`/`current`/`pending` relative to the deployment's
 * current status, and giving each an `at` (ISO time): when a `done` step
 * finished, when the `current` one started, null for a `pending` one. The
 * third label names the model. Returns `null` for a failure status (a
 * timed-out operation included) or a removal - the frontend shows its own
 * messaging there.
 * @param {{status: string, statusTimes?: Record<string, string>, createdAt?: string, activatedAt?: string|null}} entry
 * @param {string} modelName - the model's display name
 * @returns {Array<{label: string, state: string, at: string|null}>|null}
 */
export function buildProgressSteps(entry, modelName) {
  const { status } = entry

  if (NO_STEPS.has(status) || status === REMOVING || status === REMOVED) {
    return null
  }

  const currentIndex = PROGRESS_STEP_INDEX_BY_STATUS[status] ?? 0
  const boundaries = stepBoundaries(entry)

  return PROGRESS_STEPS.map(({ label }, index) => {
    const state = stepState(index, currentIndex)
    const timeIndex = state === 'done' ? index + 1 : index

    return {
      label: label(modelName),
      state,
      at: state === 'pending' ? null : boundaries[timeIndex]
    }
  })
}

/**
 * Maps a `teamDeployments` document + one of its `deployments[]` entries to
 * the flat shape routes/frontend already expect (an `_id` per deployment,
 * as if it still had its own document). The entry carries what its
 * operation's projection wrote (`operation`, `links`, `resources`,
 * `appRegistration`, `verificationFailure`); the view only names it.
 * @param {{teamId: string, environment: string}} doc
 * @param {object} entry
 * @param {import('#/adapters/credential-issuer-registry.js').CredentialIssuerRegistry} [registry]
 * @param {string} [modelName] - the model's display name, for the step labels; the slug when not given
 * @returns {object}
 */
export function toDeploymentView(
  doc,
  entry,
  registry = credentialIssuerRegistry,
  modelName = entry.modelSlug
) {
  return {
    _id: entry.id,
    teamId: doc.teamId,
    environment: doc.environment,
    modelSlug: entry.modelSlug,
    status: entry.status,
    progressSteps: buildProgressSteps(entry, modelName),
    // True while the team's client secret is a mock, so pages can say so
    // before one exists (R5; removed when Phase 5 B18's Graph issuer lands).
    credentialPlaceholder: registry.isMockedFor('team'),
    operationId: entry.operationId,
    operation: entry.operation ?? null,
    requestedBy: entry.requestedBy,
    idempotencyKey: entry.idempotencyKey,
    createdAt: entry.createdAt,
    activatedAt: entry.activatedAt,
    removedAt: entry.removedAt ?? null,
    failureReason: entry.failureReason,
    verificationFailure: entry.verificationFailure ?? null,
    resources: entry.resources ?? [],
    appRegistration: entry.appRegistration ?? null,
    links: entry.links ?? {}
  }
}

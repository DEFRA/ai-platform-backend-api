import { credentialIssuerRegistry } from '#/adapters/credential-issuer-registry.js'
import {
  REMOVED,
  REMOVING,
  TERMINAL_FAILURE_STATUSES
} from '#/services/team-deployment-entries.js'

// User-facing progress steps for the team's "being set up" wait page - the
// mapping from design C's real GitOps states (never shown to the user
// directly) to these four friendly labels is a business rule, so it lives
// here rather than being guessed at again in the frontend. The team tier is
// OAuth only, so its last step prepares an OAuth client secret. The label
// does not claim the secret is made in Entra while that issuer is mocked.
// Each step starts when the entry first reaches one of its statuses
// (`entry.statusTimes`); a step ends when the next one starts, the last when
// the deployment turns `active`.
const PROGRESS_STEPS = [
  { label: () => 'Request recorded', statuses: ['requested'] },
  { label: () => 'Team checked', statuses: ['pr-raised'] },
  {
    label: (modelName) => `Setting up ${modelName} in Azure`,
    statuses: ['merged', 'deploying']
  },
  {
    label: () => 'Preparing your client secret',
    // The apply has finished, so the Azure step is done: what remains is the
    // ARM check and activation, which can wait a whole poll interval.
    statuses: ['deployed', 'verified']
  }
]

const PROGRESS_STEP_INDEX_BY_STATUS = {
  requested: 0,
  'pr-raised': 1,
  merged: 2,
  deploying: 2,
  deployed: 3,
  verified: 3,
  // Past the last step: every step reads done.
  active: PROGRESS_STEPS.length
}

function stepState(index, currentIndex) {
  if (index < currentIndex) {
    return 'done'
  }

  return index === currentIndex ? 'current' : 'pending'
}

// When each step started, then when the last one ended (so one more than
// there are steps), from the times the entry recorded. A step the entry went
// past without a poll seeing it takes the start of the next, so it reads as
// instant, and no step starts after the next one does (a retry that records
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
 * Builds the four progress steps shown on the team-request wait page,
 * marking each `done`/`current`/`pending` relative to the deployment's
 * current raw status, and giving each an `at` (ISO time): when a `done` step
 * finished, when the `current` one started, null for a `pending` one. The
 * third label names the model. Returns `null` for a terminal failure status
 * or a removal - the frontend shows its own messaging there.
 * @param {{status: string, statusTimes?: Record<string, string>, createdAt?: string, activatedAt?: string|null}} entry
 * @param {string} modelName - the model's display name
 * @returns {Array<{label: string, state: string, at: string|null}>|null}
 */
export function buildProgressSteps(entry, modelName) {
  const { status } = entry

  if (
    TERMINAL_FAILURE_STATUSES.has(status) ||
    status === REMOVING ||
    status === REMOVED
  ) {
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

// Links to the GitHub runs and pull request behind a GitOps operation, for
// support; only those that exist yet. While a removal is in progress they
// are the removal's.
function linksOf(gitops) {
  const trail = gitops?.remove?.dispatchedAt ? gitops.remove : gitops

  return Object.fromEntries(
    Object.entries({
      submitRun: trail?.submitRunUrl,
      pullRequest: trail?.pullRequestUrl,
      applyRun: trail?.applyRunUrl
    }).filter(([, url]) => url)
  )
}

// The statuses at which ARM has confirmed the team's resources exist. Not
// `removing`: a failed-verification deployment can be removed unverified.
const VERIFIED_STATUSES = new Set(['verified', 'active'])

function named(resource, kind, verified) {
  return typeof resource?.name === 'string'
    ? [{ name: resource.name, kind, verified }]
    : []
}

// What the team has in Azure, from the apply's run report: names and kinds
// only, never an ID, so nothing here identifies a subscription or resource.
function resourceList(entry) {
  const resources = entry.gitops?.resources
  const verified = VERIFIED_STATUSES.has(entry.status)

  if (!resources) {
    return []
  }

  return [
    ...named(resources.project, 'Foundry project', verified),
    ...Object.values(resources.deployments ?? {}).flatMap((deployment) =>
      named(deployment, 'Model deployment', verified)
    ),
    ...named(resources.api, 'API in API Management', verified)
  ]
}

// Whether the apply made the team an Entra app registration: it did not
// where Entra is off or `entra.teamRegistrations` is false. Null before the
// run report is in.
function appRegistrationState(entry) {
  const resources = entry.gitops?.resources

  if (!resources) {
    return null
  }

  return resources.registration ? 'created' : 'skipped'
}

// Why ARM has not confirmed the resources, while it is still trying or once
// it has given up.
function verificationFailureOf(entry) {
  const verification = entry.gitops?.verification

  return verification && ['deployed', 'deploy-failed'].includes(entry.status)
    ? { reason: verification.reason, attempts: verification.attempts }
    : null
}

/**
 * Maps a `teamDeployments` document + one of its `deployments[]` entries to
 * the flat shape routes/frontend already expect (an `_id` per deployment,
 * as if it still had its own document).
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
    requestedBy: entry.requestedBy,
    idempotencyKey: entry.idempotencyKey,
    createdAt: entry.createdAt,
    activatedAt: entry.activatedAt,
    removedAt: entry.removedAt ?? null,
    failureReason: entry.failureReason,
    verificationFailure: verificationFailureOf(entry),
    resources: resourceList(entry),
    appRegistration: appRegistrationState(entry),
    links: linksOf(entry.gitops)
  }
}

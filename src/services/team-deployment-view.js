import {
  REMOVED,
  REMOVING,
  TERMINAL_FAILURE_STATUSES
} from '#/services/team-deployment-entries.js'

// User-facing progress steps for the team's "being set up" wait page - the
// mapping from design C's real GitOps states (never shown to the user
// directly) to these four friendly, fixed labels is a business rule, so it
// lives here rather than being guessed at again in the frontend. The team
// tier is OAuth only, so its last step creates an OAuth client secret.
const PROGRESS_STEP_LABELS = [
  'Request recorded',
  'Team checked',
  'Setting up access in Azure',
  'Creating your client secret'
]

const PROGRESS_STEP_INDEX_BY_STATUS = {
  requested: 0,
  'pr-raised': 1,
  merged: 2,
  deploying: 2,
  deployed: 2,
  verified: 3,
  active: 3
}

function stepState(index, currentIndex) {
  if (index < currentIndex) {
    return 'done'
  }

  return index === currentIndex ? 'current' : 'pending'
}

/**
 * Builds the four fixed-label progress steps shown on the team-request wait
 * page, marking each `done`/`current`/`pending` relative to the deployment's
 * current raw status. Returns `null` for a terminal failure status or a
 * removal - the frontend shows its own messaging there.
 * @param {string} status
 * @returns {Array<{label: string, state: string}>|null}
 */
export function buildProgressSteps(status) {
  if (
    TERMINAL_FAILURE_STATUSES.has(status) ||
    status === REMOVING ||
    status === REMOVED
  ) {
    return null
  }

  const currentIndex = PROGRESS_STEP_INDEX_BY_STATUS[status] ?? 0

  return PROGRESS_STEP_LABELS.map((label, index) => ({
    label,
    state: stepState(index, currentIndex)
  }))
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

/**
 * Maps a `teamDeployments` document + one of its `deployments[]` entries to
 * the flat shape routes/frontend already expect (an `_id` per deployment,
 * as if it still had its own document).
 * @param {{teamId: string, environment: string}} doc
 * @param {object} entry
 * @returns {object}
 */
export function toDeploymentView(doc, entry) {
  return {
    _id: entry.id,
    teamId: doc.teamId,
    environment: doc.environment,
    modelSlug: entry.modelSlug,
    status: entry.status,
    progressSteps: buildProgressSteps(entry.status),
    operationId: entry.operationId,
    requestedBy: entry.requestedBy,
    idempotencyKey: entry.idempotencyKey,
    createdAt: entry.createdAt,
    activatedAt: entry.activatedAt,
    removedAt: entry.removedAt ?? null,
    failureReason: entry.failureReason,
    links: linksOf(entry.gitops)
  }
}

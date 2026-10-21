import { GITHUB_ORCHESTRATOR } from '#/adapters/tenant-orchestrator-registry.js'
import {
  CHECKS_FAILED,
  NON_TERMINAL_STATUSES,
  QUEUED,
  auditDeployment
} from '#/services/team-deployment-entries.js'
import { claimableFieldQuery } from '#/services/team-deployment-gitops-steps.js'
import {
  githubTrailOf,
  prepareSubmission,
  submissionRequest
} from '#/services/team-deployment-submission.js'

// `submit` allows one open operation per team file (`file-locked`), so a
// team's requests for one environment wait their turn here. Every entry for
// a team and environment sits in one document, so a single atomic update can
// both check that nothing holds the file and claim the next request.

// Requests that can never be submitted as they stand: their document
// cannot be built (no builder, no team SKU for the model, no service code),
// or is too large or for the wrong file. They end `checks-failed` so the
// queue moves on; anything else is retried.
const UNSUBMITTABLE = new Set([
  'desired-state-unavailable',
  'desired-state-too-large',
  'invalid-path',
  'model-not-eligible',
  'service-code-required'
])

function unfinished(field) {
  return {
    $or: [
      { [`${field}.dispatchedAt`]: null },
      { [`${field}.status`]: { $in: NON_TERMINAL_STATUSES } }
    ]
  }
}

// An entry holds its team file while its own operation is in progress,
// while a revert of it is still to dispatch or in progress, while a failed
// revert's pull request is still open (the backend never abandons one; an
// engineer closes it), while its removal is in progress, and while a failed
// pull request of its is still to abandon or being abandoned.
function holdingClauses() {
  return [
    { status: { $in: NON_TERMINAL_STATUSES } },
    { 'gitops.revert': { $ne: null }, ...unfinished('gitops.revert') },
    {
      'gitops.revert.status': CHECKS_FAILED,
      'gitops.revert.pullRequestNumber': { $ne: null },
      'gitops.revert.pullRequestOpen': true
    },
    { 'gitops.remove': { $ne: null }, ...unfinished('gitops.remove') },
    {
      status: CHECKS_FAILED,
      'gitops.pullRequestNumber': { $ne: null },
      ...unfinished('gitops.abandon')
    }
  ]
}

/**
 * Whether a new request for a team and environment must queue: an
 * operation holds the team file, or earlier requests are already waiting.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, environment: string}} params
 * @returns {Promise<boolean>}
 */
export async function mustQueue(db, { teamId, environment }) {
  const busy = await db.collection('teamDeployments').countDocuments(
    {
      teamId,
      environment,
      deployments: {
        $elemMatch: { $or: [...holdingClauses(), { status: QUEUED }] }
      }
    },
    { limit: 1 }
  )

  return busy > 0
}

function now() {
  return new Date().toISOString()
}

// Records the outcome of this poll's claim on a queued entry - unless its
// lease ran out and another poll has claimed it since.
async function settleDispatch(db, doc, entry, claim, fields) {
  await db.collection('teamDeployments').updateOne(
    {
      _id: doc._id,
      deployments: {
        $elemMatch: {
          id: entry.id,
          status: QUEUED,
          'dispatch.claimedAt': claim.claimedAt
        }
      }
    },
    {
      $set: Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [
          `deployments.$.${key}`,
          value
        ])
      )
    }
  )
}

async function failedDispatch(db, doc, entry, claim, { error, logger }) {
  const code = error.data?.code ?? error.code ?? null

  if (!UNSUBMITTABLE.has(code)) {
    await settleDispatch(db, doc, entry, claim, {
      dispatch: { ...claim, claimedAt: null }
    })
    logger?.error(
      { code, operationId: entry.operationId },
      'Queued team deployment could not be dispatched, retrying on the next poll'
    )

    return null
  }

  const failed = {
    status: CHECKS_FAILED,
    failureReason: error.message,
    dispatch: claim
  }

  await settleDispatch(db, doc, entry, claim, failed)
  await auditDeployment(db, entry, {
    action: 'teamDeployment.dispatch',
    outcome: 'failure',
    code
  })

  return { ...entry, ...failed }
}

// Builds the queued request's document now, from the latest file on
// `main`, and submits it as the person who asked for it.
async function dispatchQueued(db, doc, entry, claim, settings) {
  const { registry, logger, buildDesiredState } = settings
  const isGithub = entry.orchestrator === GITHUB_ORCHESTRATOR
  let submission
  let submitted

  try {
    submission = await prepareSubmission(
      db,
      { isGithub, buildDesiredState },
      {
        teamId: doc.teamId,
        environment: doc.environment,
        modelSlug: entry.modelSlug,
        operationId: entry.operationId,
        requestedBy: entry.requestedBy
      },
      entry.requestedByPrincipal
    )
    submitted = await registry.forEntry(entry).requestDeployment(
      submissionRequest(
        {
          environment: doc.environment,
          operationId: entry.operationId,
          principal: entry.requestedByPrincipal
        },
        submission
      )
    )
  } catch (error) {
    return failedDispatch(db, doc, entry, claim, { error, logger })
  }

  const dispatchedAt = now()
  const dispatched = {
    status: 'requested',
    statusTimes: { ...entry.statusTimes, requested: dispatchedAt },
    dispatch: { ...claim, dispatchedAt },
    gitops: isGithub
      ? {
          ...githubTrailOf(submission, entry.operationId),
          submitRunId: submitted.submitRunId,
          submitRunUrl: submitted.submitRunUrl
        }
      : null
  }

  await settleDispatch(db, doc, entry, claim, dispatched)
  await auditDeployment(db, entry, {
    action: 'teamDeployment.dispatch',
    reason: `${QUEUED} -> requested`
  })

  return { ...entry, ...dispatched }
}

/**
 * Dispatches the oldest queued request for a team and environment once
 * nothing holds the team file. The claim is one atomic update on the team's
 * document that matches only while nothing holds the file and the request is
 * unclaimed, so two polls or instances never dispatch two at once; a claim
 * never dispatched within the lease is claimed again, and the request keeps
 * its operation ID, so `submit` reports `existing` rather than a second one.
 * Returns the entry it dispatched (or found unsubmittable), else null.
 * @param {import('mongodb').Db} db
 * @param {{_id: import('mongodb').ObjectId}} doc
 * @param {{registry: object, logger?: import('pino').Logger, claimLeaseMs: number, buildDesiredState?: Function}} settings
 * @returns {Promise<object|null>}
 */
export async function releaseQueue(db, doc, settings) {
  const fresh = await db.collection('teamDeployments').findOne({ _id: doc._id })
  const next = fresh?.deployments?.find((entry) => entry.status === QUEUED)

  if (!next) {
    return null
  }

  const claim = { claimedAt: now() }
  const { modifiedCount } = await db.collection('teamDeployments').updateOne(
    {
      _id: doc._id,
      deployments: {
        $elemMatch: {
          id: next.id,
          status: QUEUED,
          ...claimableFieldQuery('dispatch', settings.claimLeaseMs)
        }
      },
      $nor: [{ deployments: { $elemMatch: { $or: holdingClauses() } } }]
    },
    { $set: { 'deployments.$[next].dispatch': claim } },
    { arrayFilters: [{ 'next.id': next.id }] }
  )

  return modifiedCount === 1
    ? dispatchQueued(db, fresh, next, claim, settings)
    : null
}

import { ObjectId } from 'mongodb'

import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { config } from '#/config.js'
import {
  tenantOrchestratorRegistry,
  GITHUB_ORCHESTRATOR
} from '#/adapters/tenant-orchestrator-registry.js'
import { requireUserPrincipal } from '#/services/user-service.js'
import { acquireLockWithRetry } from '#/common/helpers/mongo-lock.js'
import {
  DEPLOY_FAILED,
  QUEUED,
  REMOVED,
  REMOVING,
  auditDeployment,
  entryFields,
  entryFilter,
  findEntry
} from '#/services/team-deployment-entries.js'
import { claimableFieldQuery } from '#/services/team-deployment-gitops-steps.js'
import { mustQueue } from '#/services/team-deployment-queue.js'
import {
  buildSubmission,
  submissionRequest
} from '#/services/team-deployment-submission.js'
import { teamDesiredStateBuilder } from '#/services/team-desired-state.js'
import { toDeploymentView } from '#/services/team-deployment-view.js'

const UPSTREAM_UNAVAILABLE = 'upstream-unavailable'
const REMOVE_ACTION = 'teamDeployment.remove'

// Entries whose model never reached the team file on main: a removal is a
// record change only, with nothing to submit.
const NEVER_APPLIED = new Set([QUEUED, 'checks-failed'])

/**
 * Removes one of a team's model deployments, for a team admin (design C
 * #actions: remove a dedicated deployment is GitOps). The team file is
 * submitted whole without the model as a `remove` follow-up on the entry,
 * followed through the GitOps states like a revert; the entry is `removing`
 * until the apply has destroyed the deployment, then `removed` with its
 * grant withdrawn, or `active` again with a reason if the removal failed.
 * A model that never reached `main` is marked removed at once. Idempotent:
 * an entry already removing or removed is returned as it is. Refuses an
 * entry whose own operation is still in progress
 * (`409 deployment-in-progress`) and a team file another operation holds
 * (`409 team-file-busy`), so no two operations race on one file.
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {{teamId: string, id: string, requestedBy: string, traceParent?: string}} params
 * @param {{registry?: import('#/adapters/tenant-orchestrator-registry.js').TenantOrchestratorRegistry, buildDesiredState?: Function}} [deps]
 * @returns {Promise<object|null>} The deployment view, or null for a non-member or unknown entry.
 */
export async function removeDeployment(
  db,
  locker,
  { teamId, id, requestedBy, traceParent },
  {
    registry = tenantOrchestratorRegistry,
    buildDesiredState = teamDesiredStateBuilder
  } = {}
) {
  const membership = await db
    .collection('teamMembers')
    .findOne({ teamId, userId: requestedBy, status: 'active' })

  if (!membership) {
    return null
  }

  if (membership.role !== 'admin') {
    throw boomWithCode(
      Boom.forbidden,
      'Only a team admin can remove a model',
      'admin-required'
    )
  }

  const located = await db
    .collection('teamDeployments')
    .findOne({ teamId, 'deployments.id': id })

  if (!located || !findEntry(located, id)) {
    return null
  }

  const principal = await requireUserPrincipal(db, requestedBy)
  const lock = await acquireLockWithRetry(
    locker,
    `team-deployment:${teamId}:${located.environment}`
  )

  try {
    const doc = await db
      .collection('teamDeployments')
      .findOne({ _id: located._id })
    const entry = findEntry(doc, id)

    return await removeEntry(
      db,
      doc,
      entry,
      { requestedBy, principal, traceParent },
      { registry, buildDesiredState }
    )
  } finally {
    await lock.free()
  }
}

function inProgress() {
  return boomWithCode(
    Boom.conflict,
    'The deployment is still being set up; try again once it is active',
    'deployment-in-progress'
  )
}

// The locked part of `removeDeployment`.
async function removeEntry(db, doc, entry, actor, deps) {
  if (entry.status === REMOVING || entry.status === REMOVED) {
    return toDeploymentView(doc, entry)
  }

  if (NEVER_APPLIED.has(entry.status)) {
    return markRemoved(db, doc, entry, actor)
  }

  if (entry.status !== 'active' && entry.status !== DEPLOY_FAILED) {
    throw inProgress()
  }

  if (await mustQueue(db, doc)) {
    throw boomWithCode(
      Boom.conflict,
      'Another change to this team is in progress; try again shortly',
      'team-file-busy'
    )
  }

  if (deps.registry.key !== GITHUB_ORCHESTRATOR || !entry.gitops) {
    return markRemoved(db, doc, entry, actor)
  }

  return submitRemoval(db, doc, entry, actor, deps)
}

// A removal with nothing to apply: the record changes, audited. A queued
// request is left alone while a poll holds a live claim on it, because that
// poll may already be submitting it to GitHub; the match fails and the
// caller is told to try again once the dispatch has settled.
async function markRemoved(db, doc, entry, { requestedBy }) {
  const removedAt = new Date().toISOString()
  const filter = entryFilter(doc, entry)

  if (entry.status === QUEUED) {
    Object.assign(
      filter.deployments.$elemMatch,
      claimableFieldQuery('dispatch', config.get('gitops.claimLeaseMs'))
    )
  }

  const { matchedCount } = await db
    .collection('teamDeployments')
    .updateOne(filter, {
      $set: entryFields({ status: REMOVED, removedAt }),
      $pull: { 'gateway.allowedDeployments': entry.modelSlug }
    })

  if (matchedCount === 0) {
    throw inProgress()
  }

  await auditDeployment(db, entry, {
    action: REMOVE_ACTION,
    actorUserId: requestedBy,
    code: 'record-only'
  })

  return toDeploymentView(doc, { ...entry, status: REMOVED, removedAt })
}

// Asks the orchestrator to submit the file without the model; a refusal is
// audited and reported as upstream trouble, with nothing to unwind.
async function dispatchRemoval(db, entry, actor, deps, operation, submission) {
  try {
    return await deps.registry.orchestrator.requestDeployment(
      submissionRequest(operation, submission)
    )
  } catch (error) {
    await auditDeployment(db, entry, {
      action: REMOVE_ACTION,
      actorUserId: actor.requestedBy,
      outcome: 'failure',
      code: error.code ?? UPSTREAM_UNAVAILABLE
    })

    throw boomWithCode(
      Boom.badGateway,
      'Failed to request the removal',
      UPSTREAM_UNAVAILABLE
    )
  }
}

// Builds the team file without the model and submits it as the requester,
// as a new operation tracked under the entry's `gitops.remove`. The entry
// is `removing` only once the submit run exists; a submit that fails leaves
// it active with nothing to unwind.
async function submitRemoval(db, doc, entry, actor, deps) {
  const { requestedBy, principal, traceParent } = actor
  const operationId = new ObjectId().toString()
  const requestedAt = new Date().toISOString()
  const submission = await buildSubmission(
    deps.buildDesiredState,
    db,
    {
      teamId: doc.teamId,
      environment: doc.environment,
      modelSlug: entry.modelSlug,
      operationId,
      requestedBy,
      change: 'remove'
    },
    principal
  )
  const submitted = await dispatchRemoval(
    db,
    entry,
    actor,
    deps,
    { environment: doc.environment, operationId, principal, traceParent },
    submission
  )

  const remove = {
    operationId,
    requestedAt,
    requestedBy: principal,
    action: 'write',
    revision: submission.document.revision,
    expectedRevision: submission.expectedRevision,
    submitRunId: submitted.submitRunId,
    submitRunUrl: submitted.submitRunUrl,
    dispatchedAt: requestedAt,
    status: 'requested'
  }

  await db.collection('teamDeployments').updateOne(entryFilter(doc, entry), {
    $set: entryFields({
      status: REMOVING,
      failureReason: null,
      'gitops.remove': remove
    })
  })
  await auditDeployment(db, entry, {
    action: REMOVE_ACTION,
    actorUserId: requestedBy,
    reason: `remove operation ${operationId}`
  })

  return toDeploymentView(doc, {
    ...entry,
    status: REMOVING,
    failureReason: null,
    gitops: { ...entry.gitops, remove }
  })
}

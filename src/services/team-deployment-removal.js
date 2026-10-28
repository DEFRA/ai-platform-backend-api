import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { uuidv7 } from '#/common/helpers/uuid-v7.js'
import { requireUserPrincipal } from '#/services/user-service.js'
import { acquireLockWithRetry } from '#/common/helpers/mongo-lock.js'
import {
  findSlotHolder,
  isDuplicateKey
} from '#/operations/operation-repository.js'
import { projectOperation } from '#/operations/operation-projection.js'
import {
  CHECKS_FAILED,
  DEPLOY_FAILED,
  REMOVED,
  REMOVING,
  auditDeployment,
  entryFields,
  entryFilter,
  findEntry
} from '#/services/team-deployment-entries.js'
import { refusalOf, traceOf } from '#/services/team-deployment-submission.js'
import { resolveTeamTarget } from '#/services/team-desired-state.js'
import { resolveTeamId } from '#/services/team-service.js'
import { toDeploymentView } from '#/services/team-deployment-view.js'

const REMOVE_ACTION = 'teamDeployment.remove'
const UPSTREAM_UNAVAILABLE = 'upstream-unavailable'

/**
 * Removes one of a team's model deployments, for a team admin (design C
 * #actions: remove a dedicated deployment is GitOps). The team file is
 * submitted whole without the model as an operation, followed through the
 * same states as an add; the entry is `removing` until the apply has
 * destroyed the deployment, then `removed` with its grant withdrawn, or
 * `active` again with a reason if the removal failed. A model whose request
 * was refused by the checks never reached `main`, so it is marked removed at
 * once. Idempotent: an entry already removing or removed is returned as it
 * is. Refuses an entry whose own operation is still in progress or waiting
 * (`409 deployment-in-progress`) and a team file another operation holds
 * (`409 team-file-busy`), so no two operations race on one file.
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {{teamId: string, id: string, requestedBy: string, traceParent?: string, cdpRequestId?: string}} params - `teamId` is the team's id or slug
 * @param {{operations: ReturnType<typeof import('#/operations/operations-service.js').createOperationsService>}} deps
 * @returns {Promise<object|null>} The deployment view, or null for a non-member or unknown entry.
 */
export async function removeDeployment(
  db,
  locker,
  { teamId: teamRef, id, requestedBy, traceParent, cdpRequestId },
  { operations }
) {
  const teamId = await resolveTeamId(db, teamRef)
  const membership = teamId
    ? await db
        .collection('teamMembers')
        .findOne({ teamId, userId: requestedBy, status: 'active' })
    : null

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

    return await removeEntry(
      db,
      doc,
      findEntry(doc, id),
      { requestedBy, principal, ...traceOf({ traceParent, cdpRequestId }) },
      operations
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

function fileBusy() {
  return boomWithCode(
    Boom.conflict,
    'Another change to this team is in progress; try again shortly',
    'team-file-busy'
  )
}

// The locked part of `removeDeployment`.
async function removeEntry(db, doc, entry, actor, operations) {
  if (entry.status === REMOVING || entry.status === REMOVED) {
    return toDeploymentView(doc, entry)
  }

  if (entry.status === CHECKS_FAILED) {
    return markRemoved(db, doc, entry, actor)
  }

  if (entry.status !== 'active' && entry.status !== DEPLOY_FAILED) {
    throw inProgress()
  }

  const file = { environment: doc.environment, teamId: doc.teamId }

  if (
    (await findSlotHolder(db, { ...file, slot: 'active' })) ||
    (await findSlotHolder(db, { ...file, slot: 'waiting' }))
  ) {
    throw fileBusy()
  }

  return submitRemoval(db, doc, entry, actor, operations)
}

// A removal with nothing to apply: the record changes, audited. The entry
// only goes if nothing has moved it since it was read.
async function markRemoved(db, doc, entry, { requestedBy }) {
  const removedAt = new Date().toISOString()
  const { matchedCount } = await db
    .collection('teamDeployments')
    .updateOne(entryFilter(doc, entry), {
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

// Asks for an operation whose document is the team file without the model; a
// refusal is audited and reported, with nothing to unwind: the entry stays as
// it was.
async function requestRemoval(db, doc, entry, actor, operations) {
  const { requestedBy, principal, traceparent, cdpRequestId } = actor

  try {
    const target = await resolveTeamTarget(db, {
      teamId: doc.teamId,
      environment: doc.environment
    })
    const { operation } = await operations.request({
      teamId: doc.teamId,
      environment: doc.environment,
      target,
      items: [
        { entryId: entry.id, modelSlug: entry.modelSlug, change: 'remove' }
      ],
      requestedBy: principal,
      requestedByUserId: requestedBy,
      // A removal has no key of its own: the entry's state is what makes a
      // repeat harmless, and each removal is its own operation.
      idempotencyKey: `remove:${uuidv7()}`,
      traceparent,
      cdpRequestId
    })

    return operation
  } catch (error) {
    const refusal = isDuplicateKey(error)
      ? fileBusy()
      : refusalOf(error, 'Failed to request the removal')

    await auditDeployment(db, entry, {
      action: REMOVE_ACTION,
      actorUserId: requestedBy,
      outcome: 'failure',
      code: refusal.data?.code ?? UPSTREAM_UNAVAILABLE
    })

    throw refusal
  }
}

// Builds the team file without the model and submits it as the requester,
// as an operation of its own. The entry is `removing` once the operation is
// recorded; a request that fails leaves it active with nothing to unwind.
async function submitRemoval(db, doc, entry, actor, operations) {
  const operation = await requestRemoval(db, doc, entry, actor, operations)

  await projectOperation(db, operation)
  await auditDeployment(db, entry, {
    action: REMOVE_ACTION,
    actorUserId: actor.requestedBy,
    reason: `remove operation ${operation._id}`
  })

  const current = await db
    .collection('teamDeployments')
    .findOne({ _id: doc._id })

  return toDeploymentView(current, findEntry(current, entry.id))
}

import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { uuidv7 } from '#/common/helpers/uuid-v7.js'
import { principalOf } from '#/services/user-service.js'
import { TEAM_ADMIN, requireTeamRole } from '#/common/helpers/auth/access.js'
import { acquireLockWithRetry } from '#/common/helpers/mongo-lock.js'
import {
  findSlotHolder,
  isDuplicateKey
} from '#/operations/operation-repository.js'
import { projectOperation } from '#/operations/operation-projection.js'
import {
  REMOVED,
  REMOVING,
  auditDeployment,
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
 * @param {{teamId: string, id: string, actor: {userId: string, oid: string}, traceParent?: string, cdpRequestId?: string}} params - `teamId` is the team's id or slug
 * @param {{operations: ReturnType<typeof import('#/operations/operations-service.js').createOperationsService>}} deps
 * @returns {Promise<object|null>} The deployment view, or null for an unknown team or entry; a team the actor is not a member of is a refused 404, audited.
 */
export async function removeDeployment(
  db,
  locker,
  { teamId: teamRef, id, actor, traceParent, cdpRequestId },
  { operations }
) {
  const teamId = await resolveTeamId(db, teamRef)

  if (!teamId) {
    return null
  }

  const role = await requireTeamRole(db, actor, teamId, {
    role: TEAM_ADMIN,
    action: 'remove a model'
  })

  const located = await db
    .collection('teamDeployments')
    .findOne({ teamId, 'deployments.id': id })

  if (!located || !findEntry(located, id)) {
    return null
  }

  const principal = principalOf(actor)
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
      {
        actor,
        role,
        requestedBy: actor.userId,
        principal,
        ...traceOf({ traceParent, cdpRequestId })
      },
      operations
    )
  } finally {
    await lock.free()
  }
}

function notRemovable() {
  return boomWithCode(
    Boom.conflict,
    'Only a model that has been set up and is ready can be removed',
    'deployment-not-removable'
  )
}

function fileBusy() {
  return boomWithCode(
    Boom.conflict,
    'Another change to this team is in progress; try again shortly',
    'team-file-busy'
  )
}

// The locked part of `removeDeployment`. `context` is who asks and how to trace it.
async function removeEntry(db, doc, entry, context, operations) {
  if (entry.status === REMOVING || entry.status === REMOVED) {
    return toDeploymentView(doc, entry)
  }

  if (entry.status !== 'active') {
    throw notRemovable()
  }

  const file = { environment: doc.environment, teamId: doc.teamId }

  if (
    (await findSlotHolder(db, { ...file, slot: 'active' })) ||
    (await findSlotHolder(db, { ...file, slot: 'waiting' }))
  ) {
    throw fileBusy()
  }

  return submitRemoval(db, doc, entry, context, operations)
}

// Asks for an operation whose document is the team file without the model; a
// refusal is audited and reported, with nothing to unwind: the entry stays as
// it was.
async function requestRemoval(db, doc, entry, context, operations) {
  const { requestedBy, principal, traceparent, cdpRequestId } = context

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
      actor: context.actor,
      role: context.role,
      outcome: 'failure',
      code: refusal.data?.code ?? UPSTREAM_UNAVAILABLE
    })

    throw refusal
  }
}

// Builds the team file without the model and submits it as the requester,
// as an operation of its own. The entry is `removing` once the operation is
// recorded; a request that fails leaves it active with nothing to unwind.
async function submitRemoval(db, doc, entry, context, operations) {
  const operation = await requestRemoval(db, doc, entry, context, operations)

  await projectOperation(db, operation)
  await auditDeployment(db, entry, {
    action: REMOVE_ACTION,
    actor: context.actor,
    role: context.role,
    reason: `remove operation ${operation._id}`
  })

  const current = await db
    .collection('teamDeployments')
    .findOne({ _id: doc._id })

  return toDeploymentView(current, findEntry(current, entry.id))
}

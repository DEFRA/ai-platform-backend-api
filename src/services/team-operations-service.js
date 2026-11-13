import { ObjectId } from 'mongodb'

import { Boom } from '#/common/helpers/boom-with-code.js'
import { requireTeamRole } from '#/common/helpers/auth/access.js'
import {
  findTeamOperation,
  findTeamOperations
} from '#/operations/operation-repository.js'
import { toOperationView } from '#/operations/operation-view.js'
import { requireTeamId } from '#/services/team-service.js'

/**
 * How many operations a list returns when the caller does not say.
 */
export const DEFAULT_OPERATIONS_LIMIT = 10

/**
 * The most operations one list returns.
 */
export const MAX_OPERATIONS_LIMIT = 50

/**
 * The display names of the people who asked for the operations, from their
 * `users` records, keyed by user id. A name is for the team's own members to
 * see, as the members list shows it; a change the platform made, or a person
 * whose record has gone, has none.
 * @param {import('mongodb').Db} db
 * @param {Array<{requestedByUserId?: string|null}>} operations
 * @returns {Promise<Map<string, string>>}
 */
export async function requesterNamesOf(db, operations) {
  const ids = [
    ...new Set(
      operations
        .map(({ requestedByUserId }) => requestedByUserId)
        .filter((id) => id && ObjectId.isValid(id))
    )
  ]

  if (ids.length === 0) {
    return new Map()
  }

  const users = await db
    .collection('users')
    .find(
      { _id: { $in: ids.map((id) => new ObjectId(id)) } },
      { projection: { displayName: 1 } }
    )
    .toArray()

  return new Map(
    users
      .filter(({ displayName }) => displayName)
      .map(({ _id, displayName }) => [_id.toString(), displayName])
  )
}

/**
 * The operations as a team's members see them, with who asked.
 * @param {import('mongodb').Db} db
 * @param {object[]} operations
 * @returns {Promise<object[]>}
 */
export async function viewsOf(db, operations) {
  const names = await requesterNamesOf(db, operations)

  return operations.map((operation) =>
    toOperationView(operation, {
      requesterName: names.get(operation.requestedByUserId) ?? null
    })
  )
}

/**
 * A team's recent and open changes to its files, newest first, for any
 * member. A non-member is refused as `404 not-a-member`, audited, so the
 * team's existence is not disclosed; a team nobody has is `404` too.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, actor: {userId: string}, environment?: string, status?: 'open'|'recent', limit?: number}} params - `teamId` is the team's id or slug
 * @returns {Promise<{items: object[]}>}
 */
export async function listTeamOperations(
  db,
  {
    teamId: teamRef,
    actor,
    environment,
    status,
    limit = DEFAULT_OPERATIONS_LIMIT
  }
) {
  const teamId = await requireTeamId(db, teamRef)

  await requireTeamRole(db, actor, teamId)

  const operations = await findTeamOperations(db, {
    teamId,
    environment,
    status,
    limit
  })

  return { items: await viewsOf(db, operations) }
}

/**
 * One of a team's changes, for any member; `404` for another team's
 * operation id, a team nobody has, or a non-member (audited).
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, operationId: string, actor: {userId: string}}} params - `teamId` is the team's id or slug
 * @returns {Promise<object>}
 */
export async function getTeamOperation(
  db,
  { teamId: teamRef, operationId, actor }
) {
  const teamId = await requireTeamId(db, teamRef)

  await requireTeamRole(db, actor, teamId)

  const operation = await findTeamOperation(db, { teamId, id: operationId })

  if (!operation) {
    throw Boom.notFound()
  }

  const [view] = await viewsOf(db, [operation])

  return view
}

import { requireTeamRole } from '#/common/helpers/auth/access.js'
import { requireTeamId } from '#/services/team-service.js'

/** Changes on a read of a team's status changes when no limit is asked for. */
export const DEFAULT_STATUS_CHANGES_LIMIT = 10

/** The most changes one read returns. */
export const MAX_STATUS_CHANGES_LIMIT = 50

// What the audit log calls each change, and what the team is told.
const CHANGE_OF_ACTION = new Map([
  ['admin.team.disable', 'disabled'],
  ['admin.team.enable', 'enabled']
])

/**
 * When a Platform Admin disabled or enabled the team, for any member: newest
 * first, the changes that were made only, each with what changed and when.
 * The audit rows hold the reason and the admin; neither is read, so neither
 * can reach a team. A non-member is refused `404`, audited. `environment`
 * keeps the changes that name it.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, actor: {userId: string}, environment?: string, limit?: number}} params - `teamId` is the team's id or slug
 * @returns {Promise<{items: Array<{change: 'disabled'|'enabled', environments: string[], at: string}>}>}
 */
export async function listStatusChanges(
  db,
  { teamId: teamRef, actor, environment, limit = DEFAULT_STATUS_CHANGES_LIMIT }
) {
  const teamId = await requireTeamId(db, teamRef)

  await requireTeamRole(db, actor, teamId)

  const found = await db
    .collection('auditEvents')
    .find(
      {
        teamId,
        action: { $in: [...CHANGE_OF_ACTION.keys()] },
        outcome: 'success',
        ...(environment && { environments: environment })
      },
      { projection: { _id: 0, at: 1, action: 1, environments: 1 } }
    )
    .sort({ at: -1, _id: -1 })
    .limit(limit)
    .toArray()

  return {
    items: found.map(({ at, action, environments }) => ({
      change: CHANGE_OF_ACTION.get(action),
      environments: environments ?? [],
      at: at.toISOString()
    }))
  }
}

import { ObjectId } from 'mongodb'

import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { refuse } from '#/common/helpers/auth/access.js'
import { TEAM_STATUS, statusOf } from '#/services/team-status.js'

/** The code a refused change carries (`409`), and the audit row with it. */
export const TEAM_DISABLED = 'team-disabled'

/**
 * What a change is locked by: the team (while it is disabled, whatever
 * environments were chosen) or one environment (while it is in the team's
 * disabled environments, whether or not the team still is).
 */
export const LOCK_SCOPE = Object.freeze({
  team: 'team',
  environment: 'environment'
})

// Says that the team can be viewed, never why it is locked.
const REFUSAL_MESSAGE =
  'This team is disabled. You can view it but not change it.'

/**
 * The environments a Platform Admin disabled for the team; none for a team
 * that never had any.
 * @param {{disabledEnvironments?: string[]}|null|undefined} team
 * @returns {string[]}
 */
export function disabledEnvironmentsOf(team) {
  return team?.disabledEnvironments ?? []
}

/**
 * Whether the team is disabled: a Platform Admin made it view-only.
 * @param {{status?: string}|null|undefined} team
 * @returns {boolean}
 */
export function isTeamDisabled(team) {
  return statusOf(team) === TEAM_STATUS.disabled
}

/**
 * Whether the environment is one of the team's disabled environments.
 * @param {{disabledEnvironments?: string[]}|null|undefined} team
 * @param {string} environment
 * @returns {boolean}
 */
export function isEnvironmentDisabled(team, environment) {
  return disabledEnvironmentsOf(team).includes(environment)
}

// A team id that is not an object id names no team, so nothing locks it.
function findLockState(db, teamId) {
  if (!ObjectId.isValid(teamId)) {
    return null
  }

  return db
    .collection('teams')
    .findOne(
      { _id: new ObjectId(teamId) },
      { projection: { status: 1, disabledEnvironments: 1 } }
    )
}

/**
 * Refuses a change a team's member asks for while a Platform Admin has
 * disabled the team (team scope) or the environment (environment scope): `409
 * team-disabled`, audited as an `access.denied` of the team and the
 * environment. The caller's right to act has been checked first, so a
 * non-member never learns the team is disabled. The refusal says nothing of
 * why: the reason is only in the disable's own audit event. Read the team
 * again here, so a disable that landed since the caller looked is seen.
 * @param {import('mongodb').Db} db
 * @param {{actor: object, role?: string, teamId: string, environment?: string, scope: 'team'|'environment'}} params - `role` is the right the actor holds, for the audit row; `environment` is needed for the environment scope
 * @returns {Promise<void>}
 */
export async function requireTeamChangeAllowed(
  db,
  { actor, role, teamId, environment, scope }
) {
  const team = await findLockState(db, teamId)
  const locked =
    scope === LOCK_SCOPE.team
      ? isTeamDisabled(team)
      : isEnvironmentDisabled(team, environment)

  if (!locked) {
    return
  }

  throw await refuse(db, actor, {
    resource: 'team',
    resourceId: teamId,
    teamId,
    environment,
    role,
    code: TEAM_DISABLED,
    error: boomWithCode(Boom.conflict, REFUSAL_MESSAGE, TEAM_DISABLED)
  })
}

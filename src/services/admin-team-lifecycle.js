import { Boom, boomWithCode } from '#/common/helpers/boom-with-code.js'
import { PLATFORM_ADMIN_ROLE } from '#/common/helpers/auth/access.js'
import { acquireLockWithRetry } from '#/common/helpers/mongo-lock.js'
import { eventIdOf, isReplay } from '#/services/admin-idempotency.js'
import {
  environmentRank,
  requireTeamForPlatformAdmin
} from '#/services/admin-team-service.js'
import { recordAuditEvent } from '#/services/audit-service.js'
import { teamEnvironments } from '#/services/team-deployment-service.js'
import { disabledEnvironmentsOf, isTeamDisabled } from '#/services/team-lock.js'
import { TEAM_STATUS, statusOf } from '#/services/team-status.js'

// A Platform Admin's Disable team and Enable team (B31, design F). Disabling
// makes the team view-only in the portal, and may also disable chosen
// environments; nothing at the gateway, in Entra or in GitOps changes. The
// team's `status` is its own flag, never `adminBlocked`. Each call is one
// update of the team and at most one audit event, under one lock per team.

const DISABLE_ACTION = 'admin.team.disable'
const ENABLE_ACTION = 'admin.team.enable'

function environmentNotFound() {
  return boomWithCode(
    Boom.notFound,
    'This environment is not available',
    'environment-not-found'
  )
}

// Only environments this instance offers can be chosen; a stray code is
// refused, not stored.
function requireOfferedEnvironments(environments) {
  const offered = teamEnvironments()

  if (environments.some((environment) => !offered.includes(environment))) {
    throw environmentNotFound()
  }
}

// Without repeats, in the order this instance lists them.
function inListedOrder(environments) {
  return [...new Set(environments)].sort(
    (a, b) => environmentRank(a) - environmentRank(b) || a.localeCompare(b)
  )
}

function viewOf(team) {
  return {
    team: {
      id: team._id.toString(),
      status: statusOf(team),
      disabledEnvironments: disabledEnvironmentsOf(team)
    }
  }
}

async function withStatusLock(locker, teamId, work) {
  const lock = await acquireLockWithRetry(locker, `team-status:${teamId}`)

  try {
    return await work()
  } finally {
    await lock.free()
  }
}

function readTeam(db, { _id }) {
  return db.collection('teams').findOne({ _id })
}

function updateTeam(db, { _id }, changes) {
  return db
    .collection('teams')
    .findOneAndUpdate({ _id }, { $set: changes }, { returnDocument: 'after' })
}

function auditEvent(db, { actor, teamId, ...event }) {
  return recordAuditEvent(db, {
    actor,
    role: PLATFORM_ADMIN_ROLE,
    resource: 'team',
    resourceId: teamId,
    teamId,
    outcome: 'success',
    ...event
  })
}

/**
 * Disables a team: its status becomes `disabled` and the environments chosen
 * (none is allowed) join its disabled environments. Members can still view
 * it; every change in the lock map is refused until it is enabled. One
 * `admin.team.disable` event holds the reason and the environments this call
 * added. A team that is already disabled and has nothing to add, a repeat of
 * the same Idempotency-Key and reason included, changes and records nothing;
 * the same key with another reason is `409 idempotency-key-reused`.
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {{actor: object, id: string, reason: string, idempotencyKey: string, environments?: string[]}} params - `id` is the team's id or slug; `actor` is the token's credentials; `reason` is kept in the audit event only
 * @returns {Promise<{team: {id: string, status: string, disabledEnvironments: string[]}}>}
 */
export async function disableTeam(
  db,
  locker,
  { actor, id, reason, idempotencyKey, environments = [] }
) {
  const found = await requireTeamForPlatformAdmin(db, actor, id)

  requireOfferedEnvironments(environments)

  const teamId = found._id.toString()
  const eventId = eventIdOf(DISABLE_ACTION, { teamId, idempotencyKey })

  return withStatusLock(locker, teamId, async () => {
    const team = await readTeam(db, found)

    if (await isReplay(db, eventId, reason)) {
      return viewOf(team)
    }

    const held = disabledEnvironmentsOf(team)
    const added = inListedOrder(environments).filter(
      (environment) => !held.includes(environment)
    )

    if (isTeamDisabled(team) && added.length === 0) {
      return viewOf(team)
    }

    const updated = await updateTeam(db, found, {
      status: TEAM_STATUS.disabled,
      disabledEnvironments: inListedOrder([...held, ...added])
    })

    await auditEvent(db, {
      action: DISABLE_ACTION,
      actor,
      teamId,
      environments: added,
      reason,
      eventId
    })

    return viewOf(updated)
  })
}

/**
 * Enables a team: it lifts the team lock, and unlocks the environments
 * chosen (every disabled environment when none is named); an environment not
 * chosen stays disabled. It takes no reason and never touches the block of
 * the team's credentials. A team that is not disabled and has no environment
 * to unlock is left as it is, with no event.
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {{actor: object, id: string, environments?: string[]}} params - `id` is the team's id or slug; `actor` is the token's credentials
 * @returns {Promise<{team: {id: string, status: string, disabledEnvironments: string[]}}>}
 */
export async function enableTeam(db, locker, { actor, id, environments }) {
  const found = await requireTeamForPlatformAdmin(db, actor, id)

  requireOfferedEnvironments(environments ?? [])

  const teamId = found._id.toString()

  return withStatusLock(locker, teamId, async () => {
    const team = await readTeam(db, found)
    const held = disabledEnvironmentsOf(team)
    const chosen = environments ?? held
    const unlocked = held.filter((environment) => chosen.includes(environment))
    const lifted = isTeamDisabled(team)

    if (!lifted && unlocked.length === 0) {
      return viewOf(team)
    }

    const updated = await updateTeam(db, found, {
      ...(lifted && { status: TEAM_STATUS.active }),
      disabledEnvironments: held.filter(
        (environment) => !chosen.includes(environment)
      )
    })

    await auditEvent(db, {
      action: ENABLE_ACTION,
      actor,
      teamId,
      environments: unlocked
    })

    return viewOf(updated)
  })
}

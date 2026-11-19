import { Boom, boomWithCode } from '#/common/helpers/boom-with-code.js'
import { PLATFORM_ADMIN_ROLE } from '#/common/helpers/auth/access.js'
import { acquireLockWithRetry } from '#/common/helpers/mongo-lock.js'
import { eventIdOf, isReplay } from '#/services/admin-idempotency.js'
import { requireTeamForPlatformAdmin } from '#/services/admin-team-service.js'
import {
  pendingMarker,
  settlePendingAudits,
  stageAudit
} from '#/services/admin-pending-audit.js'
import { disabledEnvironmentsOf, isTeamDisabled } from '#/services/team-lock.js'
import { TEAM_STATUS, statusOf } from '#/services/team-status.js'

// A Platform Admin's Disable team and Enable team (B31, design F). A team is
// environment-agnostic, so these change the team alone: Disable makes its
// details and members view-only, and nothing at the gateway, in Entra, in
// GitOps or in any environment changes. An environment is disabled only by
// Disable credentials (`credential-block.js`). The team's `status` is its own
// flag, never `adminBlocked`. Each call is one update of the team and at most
// one audit event, under one lock per team.

const DISABLE_ACTION = 'admin.team.disable'
const ENABLE_ACTION = 'admin.team.enable'

// A team waiting to be removed keeps that status: Disable would replace it with
// `disabled`, and a later Enable would make the team `active` while its removal
// is pending. So Disable is refused and the status the removal set stays.
function requireNotPendingRemoval(team) {
  if (statusOf(team) === TEAM_STATUS.pendingRemoval) {
    throw boomWithCode(
      Boom.conflict,
      'This team is waiting to be removed',
      'team-pending-removal'
    )
  }
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

function auditRecord({ actor, teamId, ...event }) {
  return {
    actor,
    role: PLATFORM_ADMIN_ROLE,
    resource: 'team',
    resourceId: teamId,
    teamId,
    outcome: 'success',
    ...event
  }
}

// Records an event a change under this lock staged and did not get to record
// (the audit insert failed), before this request looks at the team.
async function settleTeamAudits(db, found) {
  await settlePendingAudits(db, 'teams', { _id: found._id })
}

// Stages the event, updates the team (which marks it with the staged id) and
// records the event, so a failure between the update and the record is
// repaired by the next request for the team.
async function updateAndAudit(db, found, { changes, event }) {
  const id = `team-status:${found._id}`

  await stageAudit(db, id, auditRecord(event))

  const updated = await updateTeam(db, found, {
    ...changes,
    ...pendingMarker(id)
  })

  await settleTeamAudits(db, found)

  return updated
}

/**
 * Disables a team: its status becomes `disabled`. Members can still view it;
 * every team-scope change in the lock map (details, members) is refused until
 * it is enabled. No environment changes: its models, credentials and
 * deployments keep working and can still be changed. One `admin.team.disable`
 * event holds the reason. A team that is already disabled, or a repeat of the
 * same Idempotency-Key and reason, changes and records nothing; the same key
 * with another reason is `409 idempotency-key-reused`. A team waiting to be
 * removed is `409 team-pending-removal`.
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {{actor: object, id: string, reason: string, idempotencyKey: string}} params - `id` is the team's id or slug; `actor` is the token's credentials; `reason` is kept in the audit event only
 * @returns {Promise<{team: {id: string, status: string, disabledEnvironments: string[]}}>}
 */
export async function disableTeam(
  db,
  locker,
  { actor, id, reason, idempotencyKey }
) {
  const found = await requireTeamForPlatformAdmin(db, actor, id)
  const teamId = found._id.toString()
  const eventId = eventIdOf(DISABLE_ACTION, { teamId, idempotencyKey })

  return withStatusLock(locker, teamId, async () => {
    await settleTeamAudits(db, found)

    const team = await readTeam(db, found)

    if (await isReplay(db, eventId, reason)) {
      return viewOf(team)
    }

    requireNotPendingRemoval(team)

    if (isTeamDisabled(team)) {
      return viewOf(team)
    }

    const updated = await updateAndAudit(db, found, {
      changes: { status: TEAM_STATUS.disabled },
      event: { action: DISABLE_ACTION, actor, teamId, reason, eventId }
    })

    return viewOf(updated)
  })
}

/**
 * Enables a team: it lifts the team lock. It takes no reason and never
 * touches an environment or the block of the team's credentials, which Enable
 * credentials lifts. A team that is not disabled is left as it is, with no
 * event.
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {{actor: object, id: string}} params - `id` is the team's id or slug; `actor` is the token's credentials
 * @returns {Promise<{team: {id: string, status: string, disabledEnvironments: string[]}}>}
 */
export async function enableTeam(db, locker, { actor, id }) {
  const found = await requireTeamForPlatformAdmin(db, actor, id)
  const teamId = found._id.toString()

  return withStatusLock(locker, teamId, async () => {
    await settleTeamAudits(db, found)

    const team = await readTeam(db, found)

    if (!isTeamDisabled(team)) {
      return viewOf(team)
    }

    const updated = await updateAndAudit(db, found, {
      changes: { status: TEAM_STATUS.active },
      event: { action: ENABLE_ACTION, actor, teamId }
    })

    return viewOf(updated)
  })
}

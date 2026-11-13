import {
  PLATFORM_ADMIN_ROLE,
  requireNotSelfAdd
} from '#/common/helpers/auth/access.js'
import { requireTeamForPlatformAdmin } from '#/services/admin-team-service.js'
import { removeTeamMember } from '#/services/team-service.js'
import {
  addTeamMember,
  findAddablePeople
} from '#/services/team-people-service.js'

// A Platform Admin manages any team's members whatever the team's status
// (B31 "Members while stopped"): these functions check the Platform Admin
// right and the team, then run the same member core a team Admin's routes use,
// with the right they used recorded as `platform-admin`.

/**
 * Searches the directory for people a Platform Admin can add to the team,
 * current members left out. The search text is never logged or stored.
 * @param {import('mongodb').Db} db
 * @param {{id: string, actor: object, search: string, userAssertion?: string}} params - `id` is the team's id or slug; `actor` is the token's credentials
 * @param {{directory?: import('#/adapters/directory.js').Directory, allowedDomains?: string[]}} [deps]
 */
export async function searchPeopleAsPlatformAdmin(
  db,
  { id, actor, search, userAssertion },
  deps
) {
  const team = await requireTeamForPlatformAdmin(db, actor, id)

  return findAddablePeople(
    db,
    { teamId: team._id.toString(), search, userAssertion },
    deps
  )
}

/**
 * Adds a person from the directory to any team as a Platform Admin. They may
 * not add themselves (`403 self-add-refused`, audited, nothing written); the
 * rest is the team Admin's add (a current member is `409 member-exists`, an
 * ineligible person `422 person-not-eligible`, a repeated Idempotency-Key the
 * same membership).
 * @param {import('mongodb').Db} db
 * @param {{id: string, actor: object, oid: string, role: 'admin'|'user', idempotencyKey: string, userAssertion?: string}} params - `id` is the team's id or slug
 * @param {{directory?: import('#/adapters/directory.js').Directory, allowedDomains?: string[]}} [deps]
 */
export async function addMemberAsPlatformAdmin(
  db,
  { id, actor, oid, role, idempotencyKey, userAssertion },
  deps
) {
  const team = await requireTeamForPlatformAdmin(db, actor, id)
  const teamId = team._id.toString()

  await requireNotSelfAdd(db, actor, { teamId, oid })

  return addTeamMember(
    db,
    {
      teamId,
      actor,
      actingRole: PLATFORM_ADMIN_ROLE,
      oid,
      role,
      idempotencyKey,
      userAssertion
    },
    deps
  )
}

/**
 * Removes a member from any team as a Platform Admin. A team keeps at least
 * one admin (`409 last-admin`); a person who is not an active member is `404
 * member-not-found`.
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {{id: string, actor: object, memberId: string}} params - `id` is the team's id or slug
 */
export async function removeMemberAsPlatformAdmin(
  db,
  locker,
  { id, actor, memberId }
) {
  const team = await requireTeamForPlatformAdmin(db, actor, id)

  await removeTeamMember(db, locker, {
    teamId: team._id.toString(),
    actor,
    actingRole: PLATFORM_ADMIN_ROLE,
    memberId
  })
}

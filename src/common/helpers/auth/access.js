import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { existingTeamId } from '#/common/helpers/team-id.js'
import { recordAuditEvent } from '#/services/audit-service.js'

// Design F: Platform Admin is a portal role held in the portal's database,
// outside team roles; it is neither a cloud role nor a team credential.
export const PLATFORM_ADMIN_ROLE = 'platform-admin'

export const TEAM_ADMIN = 'admin'
export const TEAM_MEMBER = 'member'

/**
 * What a route declares in `options.app.access` (design E #portal). The auth
 * layer enforces the token side (`public` takes none, `catalogue` also takes
 * the frontend's own token, `sign-in` may arrive before the person has a
 * record, everything else needs a recorded person); the rest names the right
 * a service then checks, against the resource, with the functions below.
 */
export const ACCESS = Object.freeze({
  public: 'public',
  catalogue: 'catalogue',
  signIn: 'sign-in',
  user: 'user',
  teamMember: 'team-member',
  teamAdmin: 'team-admin',
  credentialOwner: 'credential-owner',
  credentialOwnerOrTeamMember: 'credential-owner-or-team-member',
  credentialOwnerOrTeamAdmin: 'credential-owner-or-team-admin',
  platformAdmin: 'platform-admin'
})

/**
 * The actor's role in a team, `'admin'` or `'user'`, or null when they are
 * not an active member. The one reader of a team membership for a right.
 * @param {import('mongodb').Db} db
 * @param {{userId: string}} actor
 * @param {string} teamId
 * @returns {Promise<'admin'|'user'|null>}
 */
export async function getTeamRole(db, actor, teamId) {
  const membership = await db
    .collection('teamMembers')
    .findOne({ teamId, userId: actor.userId, status: 'active' })

  return membership?.role ?? null
}

/**
 * The ids of the teams the actor is an active member of.
 * @param {import('mongodb').Db} db
 * @param {{userId: string}} actor
 * @returns {Promise<string[]>}
 */
export async function getActiveTeamIds(db, actor) {
  const memberships = await db
    .collection('teamMembers')
    .find({ userId: actor.userId, status: 'active' })
    .toArray()

  return memberships.map((membership) => membership.teamId)
}

/**
 * Records a refused action and returns the error to throw. Every refusal of a
 * right, a 404 that hides a resource included, goes through here.
 * @param {import('mongodb').Db} db
 * @param {object} actor
 * @param {{resource: string, resourceId: string, code: string, role?: string|null, teamId?: string, error: Error}} refusal - `teamId` is the id of the team the refusal is about, for a refusal of a team's right
 */
export async function refuse(
  db,
  actor,
  { resource, resourceId, code, role = null, teamId, error }
) {
  await recordAuditEvent(db, {
    actor,
    role,
    action: 'access.denied',
    resource,
    resourceId: String(resourceId),
    teamId,
    outcome: 'failure',
    code
  })

  return error
}

/**
 * The actor must be an active member of the team, or an admin of it. A
 * non-member is told only that there is nothing there (404), so membership is
 * never disclosed; a member without the right gets `403 admin-required`.
 * Either refusal is audited.
 * @param {import('mongodb').Db} db
 * @param {{userId: string}} actor
 * @param {string} teamId
 * @param {{role?: 'member'|'admin', action?: string}} [options] - `action` completes "Only a team admin can ..."
 * @returns {Promise<'admin'|'user'>} the role the actor holds
 */
export async function requireTeamRole(
  db,
  actor,
  teamId,
  { role = TEAM_MEMBER, action = 'do this' } = {}
) {
  const held = await getTeamRole(db, actor, teamId)

  if (!held) {
    // A refusal of someone who is not a member says nothing of whether the
    // team exists, so it names the team only when there is one: a made-up id
    // or a slug must never reach the audit log as a team.
    throw await refuse(db, actor, {
      resource: 'team',
      resourceId: teamId,
      teamId: await existingTeamId(db, teamId),
      code: 'not-a-member',
      error: Boom.notFound()
    })
  }

  if (role === TEAM_ADMIN && held !== TEAM_ADMIN) {
    throw await refuse(db, actor, {
      resource: 'team',
      resourceId: teamId,
      teamId,
      code: 'admin-required',
      role: held,
      error: boomWithCode(
        Boom.forbidden,
        `Only a team admin can ${action}`,
        'admin-required'
      )
    })
  }

  return held
}

/**
 * Whether the actor holds the Platform Admin role, as read from the portal's
 * database when the token was validated on this request, so a role removed
 * since the last call is already gone. The one answer the admin routes and
 * `/v1/users/me` share (design F "Who can use it").
 * @param {{isPlatformAdmin?: boolean}|undefined} actor
 * @returns {boolean}
 */
export function isPlatformAdmin(actor) {
  return actor?.isPlatformAdmin === true
}

/**
 * The actor must hold the Platform Admin role, as read from the portal's
 * database when the token was validated; otherwise `403
 * platform-admin-required`, audited.
 * @param {import('mongodb').Db} db
 * @param {{isPlatformAdmin?: boolean}} actor
 * @param {{resource?: string, resourceId?: string}} [target]
 */
export async function requirePlatformAdmin(
  db,
  actor,
  { resource = 'platform', resourceId = 'platform' } = {}
) {
  if (!isPlatformAdmin(actor)) {
    throw await refuse(db, actor, {
      resource,
      resourceId,
      code: 'platform-admin-required',
      error: boomWithCode(
        Boom.forbidden,
        'Only a Platform Admin can do this',
        'platform-admin-required'
      )
    })
  }
}

/**
 * A Platform Admin may not add themselves to a team (B31 "No self-add"): the
 * add would give them a team role they could then use as a member. Refused as
 * `403 self-add-refused`, audited, and nothing is written.
 * @param {import('mongodb').Db} db
 * @param {{oid?: string}} actor
 * @param {{teamId: string, oid: string}} target - the team and the Entra object ID being added
 */
export async function requireNotSelfAdd(db, actor, { teamId, oid }) {
  if (actor.oid?.toLowerCase() !== oid.toLowerCase()) {
    return
  }

  throw await refuse(db, actor, {
    resource: 'team',
    resourceId: teamId,
    teamId,
    code: 'self-add-refused',
    role: PLATFORM_ADMIN_ROLE,
    error: boomWithCode(
      Boom.forbidden,
      'A Platform Admin cannot add themselves to a team',
      'self-add-refused'
    )
  })
}

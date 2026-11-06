import { ObjectId } from 'mongodb'

import { Boom } from '#/common/helpers/boom-with-code.js'
import {
  TEAM_ADMIN,
  getActiveTeamIds,
  getTeamRole,
  refuse,
  requireTeamRole
} from '#/common/helpers/auth/access.js'
import {
  ROLE_OWNER,
  credentialsCollection
} from '#/services/credential-common.js'
import { presentCredential } from '#/services/credential-presenter.js'

/**
 * Lists a user's own credentials plus any shared team credentials for teams
 * they're an active member of (never includes secrets), applying lazy expiry.
 * @param {import('mongodb').Db} db
 * @param {{actor: {userId: string}}} params
 */
export async function listCredentials(db, { actor }) {
  const { userId } = actor
  const teamIds = await getActiveTeamIds(db, actor)

  // The membership side is restricted to tier:'team' because research
  // credentials also persist a teamId - without it a teammate's personal
  // credential would be listed as if it were shared.
  const query =
    teamIds.length > 0
      ? { $or: [{ userId }, { teamId: { $in: teamIds }, tier: 'team' }] }
      : { userId }

  const items = await credentialsCollection(db).find(query).toArray()

  return Promise.all(items.map((item) => presentCredential(db, item)))
}

async function findCredentialById(db, id) {
  return ObjectId.isValid(id)
    ? credentialsCollection(db).findOne({ _id: new ObjectId(id) })
    : null
}

// A credential that exists but is not the actor's to see: refused as not
// found, so its existence is not disclosed, and audited.
function refuseCredential(db, actor, id, code) {
  return refuse(db, actor, {
    resource: 'credential',
    resourceId: id,
    code,
    error: Boom.notFound()
  })
}

/**
 * Finds one of the actor's own credentials by id, applying lazy expiry.
 * Returns null for an id that matches nothing; another person's credential is
 * a refused 404, audited.
 * @param {import('mongodb').Db} db
 * @param {{id: string, actor: {userId: string}}} params
 */
export async function findCredentialForUser(db, { id, actor }) {
  const credential = await findCredentialById(db, id)

  if (!credential) {
    return null
  }

  if (credential.userId !== actor.userId) {
    throw await refuseCredential(db, actor, id, 'not-owner')
  }

  return presentCredential(db, credential)
}

/**
 * Finds a credential for read-only viewing - the actor's own credential, OR a
 * shared team credential for a team they're an active member of (mirrors
 * `listCredentials`' access rule). Used only by the GET-by-id route; renew
 * stays owner-only via `findCredentialForUser` above (team credentials
 * don't renew as a concept - they don't expire on the research TTL/cap).
 * Rotate/revoke use the role-aware `loadCredentialForAction` below instead,
 * since any admin member (not just the original requester) may act on a
 * shared team credential. Returns null for an id that matches nothing;
 * a credential the actor may not see is a refused 404, audited.
 * @param {import('mongodb').Db} db
 * @param {{id: string, actor: {userId: string}}} params
 */
export async function findCredentialForViewing(db, { id, actor }) {
  const credential = await findCredentialById(db, id)

  if (!credential) {
    return null
  }

  const isOwner = credential.userId === actor.userId
  const isTeamMember =
    credential.tier === 'team' &&
    (await getTeamRole(db, actor, credential.teamId)) !== null

  if (!isOwner && !isTeamMember) {
    throw await refuseCredential(db, actor, id, 'not-owner-or-member')
  }

  return presentCredential(db, credential)
}

/**
 * Loads a credential for an admin-gated action (rotate/revoke/reveal): the
 * owner of a research credential, or an admin of the team a team credential
 * belongs to - the requester need not be the original requester. Returns null
 * for an id that matches nothing. Anyone else gets a refused 404 (not a
 * member, so existence isn't disclosed) or, for a team member who is not an
 * admin, a refused 403; both are audited. The right used comes back
 * with the credential, for the audit record.
 * @param {import('mongodb').Db} db
 * @param {{id: string, actor: {userId: string}}} params
 * @returns {Promise<{credential: object, role: string}|null>}
 */
export async function loadCredentialForAction(db, { id, actor }) {
  const credential = await findCredentialById(db, id)

  if (!credential) {
    return null
  }

  if (credential.tier !== 'team') {
    if (credential.userId !== actor.userId) {
      throw await refuseCredential(db, actor, id, 'not-owner')
    }

    return { credential, role: ROLE_OWNER }
  }

  const role = await requireTeamRole(db, actor, credential.teamId, {
    role: TEAM_ADMIN
  })

  return { credential, role }
}

import { config } from '#/config.js'
import { recordAuditEvent } from '#/services/audit-service.js'
import { systemActor } from '#/common/helpers/auth/system-actor.js'
import { grantedModelSlugs } from '#/services/team-deployment-gateway.js'
import { credentialsCollection } from '#/services/credential-common.js'
import { withoutPendingMarker } from '#/services/admin-pending-audit.js'

/**
 * Marks a credential `expired` if its `expiresAt` has passed, auditing the transition.
 * @param {import('mongodb').Db} db
 * @param {object} credential
 */
async function applyLazyExpiry(db, credential) {
  if (
    credential.status !== 'active' ||
    !credential.expiresAt ||
    new Date(credential.expiresAt) > new Date()
  ) {
    return credential
  }

  await credentialsCollection(db).updateOne(
    { _id: credential._id },
    { $set: { status: 'expired' } }
  )

  await recordAuditEvent(db, {
    actor: systemActor,
    action: 'credential.expire',
    resource: 'credential',
    resourceId: credential._id.toString(),
    outcome: 'success'
  })

  return { ...credential, status: 'expired' }
}

/**
 * Adds the derived `renewalsRemaining` allowance field the frontend account page displays.
 * @param {object} credential
 */
export function withRenewalsRemaining(credential) {
  return {
    ...credential,
    renewalsRemaining: Math.max(
      0,
      config.get('research.renewalCap') - credential.renewalCount
    )
  }
}

/**
 * Gives a team credential its coverage. While it is active that is the
 * team's live gateway grants for its environment, read from the team's
 * deployments rather than kept as a copy, so a model removed from the team
 * leaves the credential at once; once revoked, it is what was frozen on the
 * record at that moment (`revokeCredential`). A research credential has
 * its one `modelSlug` and is returned as is.
 * @param {import('mongodb').Db} db
 * @param {object} credential
 * @returns {Promise<object>}
 */
export async function withTeamGrants(db, credential) {
  if (credential.tier !== 'team' || credential.status !== 'active') {
    return credential
  }

  return {
    ...credential,
    allowedDeployments: await grantedModelSlugs(db, credential)
  }
}

/**
 * A team credential's `name` (an Admin's short label for a secret) reads as
 * `null` where it has none, so documents made before names existed need no
 * backfill. A research credential has no such field and is returned as is.
 * @param {object} credential
 */
export function withTeamName(credential) {
  return credential.tier === 'team'
    ? { ...credential, name: credential.name ?? null }
    : credential
}

// How every credential leaves the service: lazily expired, with its
// allowance and, for a team's, its name and coverage, and never the marker
// of an unaudited admin change.
export async function presentCredential(db, credential) {
  return withTeamGrants(
    db,
    withTeamName(
      withRenewalsRemaining(
        withoutPendingMarker(await applyLazyExpiry(db, credential))
      )
    )
  )
}

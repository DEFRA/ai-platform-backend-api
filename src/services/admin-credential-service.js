import { Boom, boomWithCode } from '#/common/helpers/boom-with-code.js'
import {
  PLATFORM_ADMIN_ROLE,
  requirePlatformAdmin
} from '#/common/helpers/auth/access.js'
import { acquireLockWithRetry } from '#/common/helpers/mongo-lock.js'
import { forEachSequentially } from '#/common/helpers/sequential.js'
import { credentialIssuerRegistry } from '#/adapters/credential-issuer-registry.js'
import { credentialVault } from '#/adapters/credential-vault-registry.js'
import {
  findTeamDeployment,
  readCredentialStatus
} from '#/services/admin-deployment-service.js'
import { recordAuditEvent } from '#/services/audit-service.js'
import {
  blockCredentials,
  credentialsAccessChanged,
  unblockCredentials,
  withCredentialsBlockLock
} from '#/services/credential-block.js'
import {
  TEAM_CREDENTIAL_FILTER,
  credentialLockName,
  credentialsCollection
} from '#/services/credential-common.js'
import { revokeCredentialRecord } from '#/services/credential-lifecycle.js'

// A Platform Admin's Disable, Enable and Revoke of a team's non-federated
// credentials in one environment (B31). One environment per call: a person
// who ticks several makes one call for each, so each is idempotent and a
// failure names the one environment. Federations, the gateway and Entra are
// not touched; `credentialsAccessChanged` is the hook where they will be.

const ADMIN_REVOKED = 'admin-revoked'
const UPSTREAM_UNAVAILABLE = 'upstream-unavailable'

/**
 * @typedef {object} CredentialActionDeps
 * @property {(db: import('mongodb').Db, change: object) => Promise<void>} [accessChanged] - called once after each change
 * @property {import('pino').Logger} [logger]
 * @property {import('#/adapters/credential-issuer-registry.js').CredentialIssuerRegistry} [registry]
 * @property {import('#/adapters/credential-vault.js').CredentialVault} [vault]
 */

// The platform admin's right to act on the team in the environment, and the
// team's document there; a refused person learns nothing of which exist.
async function authorise(db, { actor, teamId, environment }) {
  await requirePlatformAdmin(db, actor, {
    resource: 'teamDeployment',
    resourceId: teamId
  })
  await findTeamDeployment(db, { teamId, environment })
}

function auditEvent(db, event) {
  const { action, actor, teamId, ...rest } = event

  return recordAuditEvent(db, {
    actor,
    role: PLATFORM_ADMIN_ROLE,
    action,
    resource: 'teamDeployment',
    resourceId: teamId,
    teamId,
    ...rest
  })
}

function eventIdOf(action, { teamId, environment, idempotencyKey }) {
  return `${action}:${teamId}:${environment}:${idempotencyKey}`
}

/**
 * Whether this Idempotency-Key already did this action: the success event it
 * wrote is the record. The same key with another reason is another request:
 * `409 idempotency-key-reused`, so a caller is never told their reason was
 * saved when another was.
 */
async function isReplay(db, eventId, reason) {
  const earlier = await db
    .collection('auditEvents')
    .findOne({ _id: eventId }, { projection: { reason: 1 } })

  if (!earlier) {
    return false
  }

  if (earlier.reason !== reason) {
    throw boomWithCode(
      Boom.conflict,
      'This idempotency key was used for a different request',
      'idempotency-key-reused'
    )
  }

  return true
}

/**
 * Blocks the team's credentials in one environment: no credential is created
 * there, and the team cannot reveal or rotate its secrets, until a Platform
 * Admin enables it again. No credential record changes. Repeating the request
 * (the same Idempotency-Key and reason), or disabling an environment already
 * disabled, changes and records nothing; the same key with another reason is
 * `409 idempotency-key-reused`.
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {{actor: object, teamId: string, environment: string, reason: string, idempotencyKey: string}} params - `actor` is the token's credentials; `reason` is kept in the audit event only
 * @param {CredentialActionDeps} [deps]
 * @returns {Promise<{environment: string, credential: {status: string, blockedAt?: string}}>}
 */
export async function disableCredentials(
  db,
  locker,
  { actor, teamId, environment, reason, idempotencyKey },
  { accessChanged = credentialsAccessChanged } = {}
) {
  await authorise(db, { actor, teamId, environment })

  const action = 'admin.credentials.disable'
  const eventId = eventIdOf(action, { teamId, environment, idempotencyKey })

  await withCredentialsBlockLock(locker, { teamId, environment }, async () => {
    if (await isReplay(db, eventId, reason)) {
      return
    }

    const { changed } = await blockCredentials(db, {
      teamId,
      environment,
      actor
    })

    if (changed) {
      await auditEvent(db, {
        action,
        actor,
        teamId,
        environment,
        outcome: 'success',
        reason,
        eventId
      })
      await accessChanged(db, {
        teamId,
        environment,
        change: 'disabled',
        actor
      })
    }
  })

  return {
    environment,
    credential: await readCredentialStatus(db, { teamId, environment })
  }
}

/**
 * Clears the block on the team's credentials in one environment. A revoked
 * credential stays revoked. An environment that is not disabled is left as it
 * is, with no event.
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {{actor: object, teamId: string, environment: string}} params - `actor` is the token's credentials
 * @param {CredentialActionDeps} [deps]
 * @returns {Promise<{environment: string, credential: {status: string, blockedAt?: string}}>}
 */
export async function enableCredentials(
  db,
  locker,
  { actor, teamId, environment },
  { accessChanged = credentialsAccessChanged } = {}
) {
  await authorise(db, { actor, teamId, environment })

  await withCredentialsBlockLock(locker, { teamId, environment }, async () => {
    const { changed } = await unblockCredentials(db, { teamId, environment })

    if (changed) {
      await auditEvent(db, {
        action: 'admin.credentials.enable',
        actor,
        teamId,
        environment,
        outcome: 'success'
      })
      await accessChanged(db, {
        teamId,
        environment,
        change: 'enabled',
        actor
      })
    }
  })

  return {
    environment,
    credential: await readCredentialStatus(db, { teamId, environment })
  }
}

// Revokes one record under its own lock, read again inside it: a record that
// was revoked meanwhile is left. Returns whether this call revoked it.
async function revokeRecord(db, locker, { id, actor }, deps) {
  const lock = await acquireLockWithRetry(locker, credentialLockName(id))

  try {
    const current = await credentialsCollection(db).findOne({
      _id: id,
      status: 'active'
    })

    if (!current) {
      return false
    }

    await revokeCredentialRecord(
      db,
      current,
      {
        actor,
        role: PLATFORM_ADMIN_ROLE,
        revokedReason: ADMIN_REVOKED,
        audit: false
      },
      deps.registry,
      deps.vault
    )

    return true
  } finally {
    await lock.free()
  }
}

// What a failed revoke leaves: the failure audited against the environment,
// a log line of codes only, and the error the page shows. The issuer's own
// message is never carried, nor is the reason.
async function failRevoke(db, { actor, teamId, environment, reason }, logger) {
  logger?.warn(
    { code: UPSTREAM_UNAVAILABLE, teamId, environment },
    'Revoking the team credentials failed'
  )

  await auditEvent(db, {
    action: 'admin.credentials.revoke',
    actor,
    teamId,
    environment,
    outcome: 'failure',
    code: UPSTREAM_UNAVAILABLE,
    reason
  })

  throw boomWithCode(
    Boom.badGateway,
    'The credentials could not be revoked, try again',
    UPSTREAM_UNAVAILABLE
  )
}

/**
 * Revokes the team's active non-federated credentials in one environment,
 * each through the built revoke path (the gateway subscription deleted, the
 * secret removed from the vault, the record `revoked` with the reason
 * `admin-revoked`). One `admin.credentials.revoke` event covers the
 * environment. A failure stops at that record, leaves it active, audits a
 * `failure` and answers `502 upstream-unavailable`; repeating the request
 * revokes the rest. A repeat with nothing left to revoke, or with the same
 * Idempotency-Key, writes no event.
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {{actor: object, teamId: string, environment: string, reason: string, idempotencyKey: string}} params - `actor` is the token's credentials; `reason` is kept in the audit event only
 * @param {CredentialActionDeps} [deps]
 * @returns {Promise<{environment: string, revoked: number}>}
 */
export async function revokeCredentials(
  db,
  locker,
  { actor, teamId, environment, reason, idempotencyKey },
  {
    accessChanged = credentialsAccessChanged,
    logger,
    registry = credentialIssuerRegistry,
    vault = credentialVault
  } = {}
) {
  await authorise(db, { actor, teamId, environment })

  const action = 'admin.credentials.revoke'
  const eventId = eventIdOf(action, { teamId, environment, idempotencyKey })

  return withCredentialsBlockLock(locker, { teamId, environment }, async () => {
    if (await isReplay(db, eventId, reason)) {
      return { environment, revoked: 0 }
    }

    const records = await credentialsCollection(db)
      .find(
        { ...TEAM_CREDENTIAL_FILTER, teamId, environment, status: 'active' },
        { projection: { _id: 1 } }
      )
      .toArray()
    let revoked = 0

    try {
      await forEachSequentially(records, async ({ _id }) => {
        if (
          await revokeRecord(
            db,
            locker,
            { id: _id, actor },
            { registry, vault }
          )
        ) {
          revoked += 1
        }
      })
    } catch {
      return failRevoke(db, { actor, teamId, environment, reason }, logger)
    }

    if (revoked > 0) {
      await auditEvent(db, {
        action,
        actor,
        teamId,
        environment,
        outcome: 'success',
        reason,
        eventId
      })
      await accessChanged(db, { teamId, environment, change: 'revoked', actor })
    }

    return { environment, revoked }
  })
}

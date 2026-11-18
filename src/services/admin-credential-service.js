import { ObjectId } from 'mongodb'

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
  claimsOf,
  discardStagedAudit,
  settlePendingAudits,
  stageAudit,
  stagedAuditsOf
} from '#/services/admin-pending-audit.js'
import { eventIdOf, isReplay } from '#/services/admin-idempotency.js'
import {
  blockCredentials,
  isEnvironmentBlocked,
  unblockCredentials,
  withCredentialsBlockLock
} from '#/services/credential-block.js'
import { credentialsAccessChanged } from '#/services/credential-access-effects.js'
import {
  TEAM_CREDENTIAL_FILTER,
  credentialLockName,
  credentialsCollection
} from '#/services/credential-common.js'
import { revokeCredentialRecord } from '#/services/credential-lifecycle.js'

// A Platform Admin's Disable, Enable and Revoke (one secret) of a team's
// non-federated credentials in one environment (B31). One environment per call:
// a person who ticks several makes one call for each, so each is idempotent and
// a failure names the one environment. Disable and Enable also change the
// team's access window and service principal through `credentialsAccessChanged`
// (R-D3): Disable sets the flag, then the effects; Enable does the effects, then
// clears the flag. A failed effect keeps or sets the block, audits a `failure`
// and answers 502, and a retry repeats the idempotent effects.

const ADMIN_REVOKED = 'admin-revoked'
const UPSTREAM_UNAVAILABLE = 'upstream-unavailable'
const REVOKE_ONE_ACTION = 'admin.credential.revoke'

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

function auditRecord(event) {
  const { action, actor, teamId, ...rest } = event

  return {
    actor,
    role: PLATFORM_ADMIN_ROLE,
    action,
    resource: 'teamDeployment',
    resourceId: teamId,
    teamId,
    ...rest
  }
}

// The id a block's or an unblock's staged event is kept under: one per team and
// environment, as the block lock allows one change at a time.
function blockAuditId(teamId, environment) {
  return `credentials-block:${teamId}:${environment}`
}

function revokeAuditId(credentialId) {
  return `credential-revoke:${credentialId}`
}

function accessNotAvailable(change) {
  return boomWithCode(
    Boom.badGateway,
    `Credentials could not be ${change}, try again`,
    UPSTREAM_UNAVAILABLE
  )
}

// Makes the gateway and Entra changes of a Disable or an Enable. A failure is
// logged by code only, audited as `failedEvent` and answered 502; the issuer's
// message and the reason never leave this function.
async function applyAccessEffects(
  db,
  { teamId, environment, change, actor, failedEvent },
  { accessChanged, logger }
) {
  try {
    await accessChanged(db, { teamId, environment, change, actor })
  } catch {
    logger?.warn(
      { code: UPSTREAM_UNAVAILABLE, teamId, environment, change },
      'Changing the team’s access failed'
    )

    await recordAuditEvent(db, {
      ...failedEvent,
      outcome: 'failure',
      code: UPSTREAM_UNAVAILABLE
    })

    throw accessNotAvailable(change)
  }
}

// A Disable whose block is set but whose event is not yet recorded still owes
// the gateway and Entra their change: make it before the event is recorded, so
// a failure is never audited as a success and a retry finds it again.
async function applyOwedDisables(db, target, deps) {
  const owed = (await stagedAuditsOf(db, 'teamDeployments', target)).filter(
    ({ change }) => change === 'disabled'
  )

  await forEachSequentially(owed, (staged) => {
    const failedEvent = { ...staged.event, actor: staged.actor }

    delete failedEvent.eventId

    return applyAccessEffects(
      db,
      { ...target, change: 'disabled', actor: staged.actor, failedEvent },
      deps
    )
  })
}

// Records every event an earlier change under this lock staged and did not get
// to record (the audit insert failed), after the access effects a Disable owes,
// before this request looks at its own. Returns the ids it recorded. A Disable
// and an Enable have made their effects by then; the hook is told only of a
// revoke here.
async function settleCredentialAudits(db, target, deps) {
  const { teamId, environment } = target
  const { accessChanged } = deps
  const notify = async (staged) => {
    if (staged.change === 'revoked') {
      await accessChanged(db, {
        teamId,
        environment,
        change: staged.change,
        actor: staged.actor
      })
    }
  }

  await applyOwedDisables(db, target, deps)

  const settled = await settlePendingAudits(
    db,
    'teamDeployments',
    target,
    notify
  )

  return [
    ...settled,
    ...(await settlePendingAudits(
      db,
      'credentials',
      { ...target, tier: 'team' },
      notify
    ))
  ]
}

// Stages the event, makes the change (which marks its document with the
// staged id) and records the event; a change that changed nothing drops the
// event it staged.
async function changeAndAudit(db, target, { id, staged, change }, deps) {
  await stageAudit(db, id, staged)

  const { changed } = await change(id)

  if (changed) {
    await settleCredentialAudits(db, target, deps)
  } else {
    await discardStagedAudit(db, id)
  }
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
  { accessChanged = credentialsAccessChanged, logger } = {}
) {
  await authorise(db, { actor, teamId, environment })

  const action = 'admin.credentials.disable'
  const eventId = eventIdOf(action, { teamId, environment, idempotencyKey })
  const target = { teamId, environment }
  const deps = { accessChanged, logger }

  await withCredentialsBlockLock(locker, target, async () => {
    await settleCredentialAudits(db, target, deps)

    if (await isReplay(db, eventId, reason)) {
      return
    }

    const id = blockAuditId(teamId, environment)

    await changeAndAudit(
      db,
      target,
      {
        id,
        staged: {
          ...auditRecord({
            action,
            actor,
            teamId,
            environment,
            outcome: 'success',
            reason,
            eventId
          }),
          change: 'disabled'
        },
        change: (pendingAuditId) =>
          blockCredentials(db, { ...target, actor, pendingAuditId })
      },
      deps
    )
  })

  return {
    environment,
    credential: await readCredentialStatus(db, { teamId, environment })
  }
}

/**
 * Clears the block on the team's credentials in one environment, after the
 * service principal is switched on and the ordinary window restored; a failure
 * of either keeps the block, audits a `failure` and answers `502
 * upstream-unavailable`. A revoked credential stays revoked. An environment
 * that is not disabled is left as it is, with no event.
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
  { accessChanged = credentialsAccessChanged, logger } = {}
) {
  await authorise(db, { actor, teamId, environment })

  const target = { teamId, environment }
  const deps = { accessChanged, logger }

  await withCredentialsBlockLock(locker, target, async () => {
    await settleCredentialAudits(db, target, deps)

    if (await isEnvironmentBlocked(db, target)) {
      await applyAccessEffects(
        db,
        {
          ...target,
          change: 'enabled',
          actor: claimsOf(actor),
          failedEvent: auditRecord({
            action: 'admin.credentials.enable',
            actor,
            teamId,
            environment
          })
        },
        deps
      )
    }

    await changeAndAudit(
      db,
      target,
      {
        id: blockAuditId(teamId, environment),
        staged: {
          ...auditRecord({
            action: 'admin.credentials.enable',
            actor,
            teamId,
            environment,
            outcome: 'success'
          }),
          change: 'enabled'
        },
        change: (pendingAuditId) =>
          unblockCredentials(db, { ...target, pendingAuditId })
      },
      deps
    )
  })

  return {
    environment,
    credential: await readCredentialStatus(db, { teamId, environment })
  }
}

// Revokes one record under its own lock, read again inside it: a record that
// was revoked meanwhile is left. The event is staged before the record changes
// and the record is marked with it in the same update. Returns whether this
// call revoked it.
async function revokeRecord(db, locker, { id, actor, staged }, deps) {
  const lock = await acquireLockWithRetry(locker, credentialLockName(id))
  const pendingAuditId = revokeAuditId(id)

  try {
    const current = await credentialsCollection(db).findOne({
      _id: id,
      status: 'active'
    })

    if (!current) {
      return false
    }

    await stageAudit(db, pendingAuditId, staged)

    try {
      await revokeCredentialRecord(
        db,
        current,
        {
          actor,
          role: PLATFORM_ADMIN_ROLE,
          revokedReason: ADMIN_REVOKED,
          audit: false,
          pendingAuditId
        },
        deps.registry,
        deps.vault
      )
    } catch (error) {
      await discardStagedAudit(db, pendingAuditId)
      throw error
    }

    return true
  } finally {
    await lock.free()
  }
}

// What a failed revoke leaves: the failure audited against the secret, a log
// line of codes only, and the error the page shows. The issuer's own message is
// never carried, nor is the reason.
async function failRevoke(
  db,
  { actor, teamId, environment, reason, credentialId },
  logger
) {
  logger?.warn(
    { code: UPSTREAM_UNAVAILABLE, teamId, environment },
    'Revoking the team credential failed'
  )

  await recordAuditEvent(
    db,
    auditRecord({
      action: REVOKE_ONE_ACTION,
      actor,
      teamId,
      environment,
      outcome: 'failure',
      code: UPSTREAM_UNAVAILABLE,
      reason,
      resource: 'credential',
      resourceId: credentialId
    })
  )

  throw boomWithCode(
    Boom.badGateway,
    'The credential could not be revoked, try again',
    UPSTREAM_UNAVAILABLE
  )
}

function credentialNotFound() {
  return boomWithCode(
    Boom.notFound,
    'This credential is not available',
    'credential-not-found'
  )
}

// The id of a team's own client secret in the environment, or a refusal that
// says nothing of whether another team or environment has it.
async function findTeamSecretId(db, { teamId, environment, credentialId }) {
  if (!ObjectId.isValid(credentialId)) {
    throw credentialNotFound()
  }

  const record = await credentialsCollection(db).findOne(
    {
      ...TEAM_CREDENTIAL_FILTER,
      _id: new ObjectId(credentialId),
      teamId,
      environment
    },
    { projection: { _id: 1 } }
  )

  if (!record) {
    throw credentialNotFound()
  }

  return record._id
}

/**
 * Revokes one of the team's client secrets in an environment through the
 * built revoke path (the gateway subscription deleted, the secret removed from
 * the vault, the record `revoked` with the reason `admin-revoked`), leaving
 * the team's other secrets and the environment's block as they are. One
 * `admin.credential.revoke` event is about the secret. A secret already
 * revoked, a repeat with the same Idempotency-Key and reason, changes and
 * records nothing; the same key with another reason is `409
 * idempotency-key-reused`. A failure leaves the secret active, audits a
 * `failure` and answers `502 upstream-unavailable`.
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {{actor: object, teamId: string, environment: string, credentialId: string, reason: string, idempotencyKey: string}} params - `actor` is the token's credentials; `reason` is kept in the audit event only
 * @param {CredentialActionDeps} [deps]
 * @returns {Promise<{environment: string, credentialId: string, revoked: boolean}>}
 */
export async function revokeCredential(
  db,
  locker,
  { actor, teamId, environment, credentialId, reason, idempotencyKey },
  {
    accessChanged = credentialsAccessChanged,
    logger,
    registry = credentialIssuerRegistry,
    vault = credentialVault
  } = {}
) {
  await authorise(db, { actor, teamId, environment })

  const id = await findTeamSecretId(db, { teamId, environment, credentialId })
  const eventId = eventIdOf(REVOKE_ONE_ACTION, {
    teamId,
    environment,
    resourceId: credentialId,
    idempotencyKey
  })

  const target = { teamId, environment }
  const effects = { accessChanged, logger }

  return withCredentialsBlockLock(locker, target, async () => {
    const recorded = await settleCredentialAudits(db, target, effects)

    if (await isReplay(db, eventId, reason)) {
      // A retry that recorded the event the first attempt left unrecorded did
      // revoke the secret, as far as the person who retried can tell.
      return { environment, credentialId, revoked: recorded.includes(eventId) }
    }

    let revoked

    try {
      revoked = await revokeRecord(
        db,
        locker,
        {
          id,
          actor,
          staged: {
            ...auditRecord({
              action: REVOKE_ONE_ACTION,
              actor,
              teamId,
              environment,
              outcome: 'success',
              reason,
              eventId,
              resource: 'credential',
              resourceId: credentialId
            }),
            change: 'revoked'
          }
        },
        { registry, vault }
      )
    } catch {
      return failRevoke(
        db,
        { actor, teamId, environment, reason, credentialId },
        logger
      )
    }

    if (revoked) {
      await settleCredentialAudits(db, target, effects)
    }

    return { environment, credentialId, revoked }
  })
}

import { config } from '#/config.js'
import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { TEAM_ADMIN } from '#/common/helpers/auth/access.js'
import { isDuplicateKeyError } from '#/common/helpers/mongo-errors.js'
import { acquireLockWithRetry } from '#/common/helpers/mongo-lock.js'
import { credentialIssuerRegistry } from '#/adapters/credential-issuer-registry.js'
import { credentialVault } from '#/adapters/credential-vault-registry.js'
import { tenantOrchestratorRegistry } from '#/adapters/tenant-orchestrator-registry.js'
import { recordAuditEvent } from '#/services/audit-service.js'
import {
  ADMIN_ADDED,
  SUBSCRIPTION_TYPE,
  TEAM_CREDENTIAL_FILTER,
  TEAM_CREDENTIAL_TYPE,
  UNFINISHED_STATUSES,
  credentialsCollection,
  resolveIssuer,
  withCredentialRow
} from '#/services/credential-common.js'
import { issueAndActivate } from '#/services/credential-issuance.js'
import {
  MAX_CLIENT_SECRETS,
  countUnexpiredSecrets
} from '#/services/team-client-secrets.js'
import { teamEnvironments } from '#/services/team-deployment-service.js'
import {
  findMemberTeam,
  requireAvailableEnvironment
} from '#/services/team-environments-service.js'
import { clientSecretsAllowedIn } from '#/services/team-oauth-block.js'
import { readTeamFiles } from '#/services/team-service.js'

const MS_PER_DAY = 24 * 60 * 60 * 1000
const ISSUE_ACTION = 'credential.issue'
const TEAM_TIER = 'team'

// Refusals of a request that may not be made, each recorded against the team
// with the code, so the audit shows who asked for what and why not.
const REFUSALS = {
  notAllowed: {
    make: Boom.conflict,
    message:
      'Client secrets are not allowed in this environment: applications there federate instead',
    code: 'client-secrets-not-allowed'
  },
  notSetUp: {
    make: Boom.conflict,
    message:
      'This environment is not set up for the team yet, so it has no registration to hold a secret',
    code: 'environment-not-set-up'
  },
  limit: {
    make: Boom.conflict,
    message: `The team already holds ${MAX_CLIENT_SECRETS} client secrets in this environment that have not expired`,
    code: 'credential-limit-reached'
  },
  keyReused: {
    make: Boom.conflict,
    message: 'This idempotency key was used for a different request',
    code: 'idempotency-key-reused'
  }
}

async function auditRefusal(db, context, code) {
  await recordAuditEvent(db, {
    actor: context.actor,
    role: context.role,
    action: ISSUE_ACTION,
    resource: 'team',
    resourceId: context.teamId,
    outcome: 'failure',
    code,
    reason: context.environment
  })
}

async function refuse(db, context, { make, message, code }) {
  await auditRefusal(db, context, code)

  return boomWithCode(make, message, code)
}

// An environment this instance does not offer is refused as the team's
// environments read refuse it (`404 environment-not-available`), and, as every
// other refusal here, audited first.
async function requireOfferedEnvironment(db, context) {
  try {
    requireAvailableEnvironment(context.environment)
  } catch (error) {
    await auditRefusal(db, context, error.data.code)

    throw error
  }
}

// What is shown of a secret that was made: never the value.
function viewOf(credential) {
  return {
    id: credential._id.toString(),
    keyHint: credential.keyHint,
    expiresAt: credential.expiresAt ?? null,
    environment: credential.environment
  }
}

// The team's file in the environment, from `main`: the environment is set up
// when there is one.
async function isSetUp(registry, team, environment) {
  const others = teamEnvironments().filter((name) => name !== environment)
  const files = await readTeamFiles(registry, team.slug, others)

  return files.some((file) => file.environment === environment)
}

function buildPending(
  { actor, teamId, environment, idempotencyKey },
  issuerKey
) {
  return {
    userId: actor.userId,
    teamId,
    modelSlug: null,
    credentialType: TEAM_CREDENTIAL_TYPE,
    tier: TEAM_TIER,
    origin: ADMIN_ADDED,
    environment,
    purpose: null,
    type: SUBSCRIPTION_TYPE,
    status: 'pending',
    idempotencyKey,
    issuerKey,
    // A team secret spans every model the team holds there.
    provider: null,
    offering: null,
    cloud: null,
    gateway: null,
    createdAt: new Date().toISOString(),
    renewalCount: 0
  }
}

// Whether an earlier record is this very request: the team's secret in this
// environment, whoever asked.
function isSameRequest(earlier, { teamId, environment }) {
  return (
    earlier.teamId === teamId &&
    earlier.tier === TEAM_TIER &&
    earlier.credentialType === TEAM_CREDENTIAL_TYPE &&
    earlier.environment === environment
  )
}

// What the key was used for already: a replay answers with that secret, a key
// made for anything else is not this request's (another environment, another
// team, or a research credential: the unique index holds one per person and
// key, whatever it was for), and an attempt that did not finish is made again
// on the same record.
async function earlierRequest(db, context) {
  const { actor, teamId, idempotencyKey } = context
  const found = await credentialsCollection(db)
    .find({
      idempotencyKey,
      $or: [{ teamId, ...TEAM_CREDENTIAL_FILTER }, { userId: actor.userId }]
    })
    .toArray()

  if (!found.every((earlier) => isSameRequest(earlier, context))) {
    throw await refuse(db, context, REFUSALS.keyReused)
  }

  return found[0] ?? null
}

// The issuer for the team tier. When none is enabled the resolution refuses
// (`501 gateway-not-enabled`) before `issueAndActivate` can audit anything, so
// it is audited here, as every other refusal, and rethrown.
async function resolveTeamIssuer(db, context, issuerRegistry) {
  try {
    return resolveIssuer(issuerRegistry, null, TEAM_TIER)
  } catch (error) {
    await auditRefusal(db, context, error.data?.code ?? 'credential-failed')

    throw error
  }
}

async function issue(db, locker, context, earlier, { issuerRegistry, vault }) {
  const { actor, teamId, environment } = context
  const { issuerKey, issuer } = await resolveTeamIssuer(
    db,
    context,
    issuerRegistry
  )
  const pending = buildPending(context, issuerKey)
  const unfinished = UNFINISHED_STATUSES.includes(earlier?.status)
    ? earlier
    : null
  const expiresAt = new Date(
    Date.now() + config.get('teamDeployment.clientSecretTtlDays') * MS_PER_DAY
  ).toISOString()

  return withCredentialRow(db, locker, unfinished, ({ reusable, rowId }) =>
    issueAndActivate(db, vault, {
      issuer,
      pending,
      reusable,
      insertId: rowId,
      actor,
      role: context.role,
      expiresAt,
      issueParams: {
        userId: actor.userId,
        modelSlug: null,
        tier: TEAM_TIER,
        teamId,
        environment,
        credentialId: rowId.toString(),
        expiresAt
      }
    })
  )
}

// Everything that depends on what the team holds, under the lock the team's
// credential in the environment has always had, so requests asked together
// see one another's and the team never holds more than three.
async function addUnderLock(db, locker, context, deps) {
  const earlier = await earlierRequest(db, context)

  if (earlier && !UNFINISHED_STATUSES.includes(earlier.status)) {
    return { credential: viewOf(earlier), replay: true }
  }

  if ((await countUnexpiredSecrets(db, context)) >= MAX_CLIENT_SECRETS) {
    throw await refuse(db, context, REFUSALS.limit)
  }

  const { credential, secret } = await issue(db, locker, context, earlier, deps)

  return { credential: viewOf(credential), secret, replay: false }
}

/**
 * Adds a client secret to a team's registration in an environment, for a team
 * Admin: made by the issuer, expiring after `CLIENT_SECRET_TTL_DAYS` (90), its
 * value written to the vault and returned this once, never kept in the record.
 * The team holds at most three that have not expired in an environment, the
 * one made with its first model included (`409 credential-limit-reached`);
 * only where `CLIENT_SECRET_ENVIRONMENTS` allows (`409
 * client-secrets-not-allowed`: there applications federate, and no
 * exception is recorded yet) and where the team has a file (`409
 * environment-not-set-up`). Replaying an `Idempotency-Key` answers with the
 * credential and no value; a key made for another environment, team or kind
 * of credential is `409 idempotency-key-reused`. A Member is refused with a
 * `403` and a non-member `404`; every refusal (an environment the instance
 * does not offer, `404 environment-not-available`, included) and the
 * addition are audited.
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {{teamId: string, environment: string, actor: {userId: string}, idempotencyKey: string}} params - `teamId` is the team's id or slug
 * @param {{registry?: import('#/adapters/tenant-orchestrator-registry.js').TenantOrchestratorRegistry, issuerRegistry?: import('#/adapters/credential-issuer-registry.js').CredentialIssuerRegistry, vault?: import('#/adapters/credential-vault.js').CredentialVault}} [deps]
 * @returns {Promise<{credential: {id: string, keyHint: string, expiresAt: string|null, environment: string}, secret?: string, replay: boolean}>}
 */
export async function addTeamClientSecret(
  db,
  locker,
  { teamId: teamRef, environment, actor, idempotencyKey },
  {
    registry = tenantOrchestratorRegistry,
    issuerRegistry = credentialIssuerRegistry,
    vault = credentialVault
  } = {}
) {
  const { teamId, role, team } = await findMemberTeam(db, teamRef, actor, {
    role: TEAM_ADMIN,
    action: 'add a client secret'
  })

  const context = { actor, role, teamId, environment, idempotencyKey }

  await requireOfferedEnvironment(db, context)

  if (!clientSecretsAllowedIn(environment)) {
    throw await refuse(db, context, REFUSALS.notAllowed)
  }

  if (!(await isSetUp(registry, team, environment))) {
    throw await refuse(db, context, REFUSALS.notSetUp)
  }

  // The key is reserved for the team across its environments before the
  // environment's own lock is taken (always in this order), so two requests
  // with one key meet one another's record whichever environment each is for.
  const keyLock = await acquireLockWithRetry(
    locker,
    `team-credential-key:${teamId}:${idempotencyKey}`
  )

  try {
    return await addUnderEnvironmentLock(db, locker, context, {
      issuerRegistry,
      vault
    })
  } finally {
    await keyLock.free()
  }
}

async function addUnderEnvironmentLock(db, locker, context, deps) {
  const lock = await acquireLockWithRetry(
    locker,
    `team-credential:${context.teamId}:${context.environment}`
  )

  try {
    return await addUnderLock(db, locker, context, deps)
  } catch (error) {
    // The key is also held by the same person elsewhere (another team): the
    // unique index decides it, before anything was issued.
    if (isDuplicateKeyError(error)) {
      throw await refuse(db, context, REFUSALS.keyReused)
    }

    throw error
  } finally {
    await lock.free()
  }
}

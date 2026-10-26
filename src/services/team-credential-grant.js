import {
  ensureTeamCredential,
  teamCredentialNeedsRetry
} from '#/services/credential-service.js'
import {
  auditDeployment,
  findEntry
} from '#/services/team-deployment-entries.js'

// Stable codes a team credential failure is audited under.
const VAULT_WRITE_FAILED = 'vault-write-failed'
const CREDENTIAL_FAILED = 'credential-failed'

const DEFAULT_RETRY_AFTER_MS = 30000

function settingsOf({
  ensureCredential = ensureTeamCredential,
  locker,
  logger,
  retryAfterMs = DEFAULT_RETRY_AFTER_MS
}) {
  return { ensureCredential, locker, logger, retryAfterMs }
}

/**
 * Grants a model that has turned `active` to the team's credential for its
 * environment, creating the credential (its secret going to the vault, never
 * returned) if the team has none. The grant itself is the
 * `allowedDeployments` entry already written with the activation. A failure
 * never fails the caller or undoes the activation: it is logged and audited
 * against the deployment's operation with a stable code (once, on the
 * activation; a retry only logs at debug, so a standing outage does not
 * repeat itself) and retried by `retryTeamCredential`. Logs and audit events
 * carry operation IDs and codes only.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, environment: string}} doc - the team's document
 * @param {object} entry - the active deployment entry
 * @param {{ensureCredential?: Function, locker: import('mongo-locks').LockManager, logger?: import('pino').Logger, retryAfterMs?: number}} settings
 * @param {{retry?: boolean}} [options] - `retry` for a later attempt, not the activation
 * @returns {Promise<boolean>} whether a credential was created
 */
export async function grantTeamCredential(
  db,
  doc,
  entry,
  settings,
  { retry = false } = {}
) {
  const { ensureCredential, locker, logger, retryAfterMs } =
    settingsOf(settings)

  try {
    const { created, vaultWritten } = await ensureCredential(db, locker, {
      teamId: doc.teamId,
      environment: doc.environment,
      modelSlug: entry.modelSlug,
      requestedBy: entry.requestedBy,
      operationId: entry.operationId,
      activatedAt: entry.activatedAt ?? null,
      ...(retry && { retryAfterMs })
    })

    // A credential that was created but whose secret is not in the vault is
    // a one-off, not a standing failure, so even a retry reports it.
    if (vaultWritten === false) {
      await reportCredentialFailure(db, entry, logger, {
        code: VAULT_WRITE_FAILED,
        message:
          'The team secret could not be written to the vault, reconciliation will retry it',
        retry: false
      })
    }

    return created === true
  } catch (error) {
    await reportCredentialFailure(db, entry, logger, {
      code: error.data?.code ?? error.code ?? CREDENTIAL_FAILED,
      message: 'Creating the team credential failed, retrying on a later poll',
      retry
    })

    return false
  }
}

async function reportCredentialFailure(
  db,
  entry,
  logger,
  { code, message, retry }
) {
  logger?.[retry ? 'debug' : 'warn'](
    { code, operationId: entry.operationId },
    message
  )

  if (retry) {
    return
  }

  try {
    await auditDeployment(db, entry, {
      action: 'teamDeployment.credential',
      outcome: 'failure',
      code
    })
  } catch {
    logger?.warn(
      { code, operationId: entry.operationId },
      'The team credential failure could not be audited'
    )
  }
}

/**
 * Creates the function the operations runtime calls once an operation has
 * made models active (plan 6.1): it grants the team's credential for the
 * environment once for the whole operation, from the first model it added -
 * `ensureCredential` creates the team's one credential and leaves it alone
 * after. An operation that only removes models grants nothing. It never
 * throws, as `grantTeamCredential`.
 * @param {{db: import('mongodb').Db, ensureCredential?: Function, locker: import('mongo-locks').LockManager, logger?: import('pino').Logger, retryAfterMs?: number}} deps
 * @returns {(operation: {teamId: string, environment: string, items: Array<{entryId: string, change: string}>}) => Promise<void>}
 */
export function createCredentialGranter({ db, ...settings }) {
  return async function grantCredentials(operation) {
    const doc = await db.collection('teamDeployments').findOne({
      teamId: operation.teamId,
      environment: operation.environment
    })
    const added = operation.items
      .filter(({ change }) => change !== 'remove')
      .map(({ entryId }) => findEntry(doc, entryId))
      .find(Boolean)

    if (added) {
      await grantTeamCredential(db, doc, added, settings)
    }
  }
}

// The team's newest active deployment: the one whose activation a missing
// credential is owed to, and so the one a retry is made for.
function newestActive(doc, fallback) {
  const active = doc.deployments.filter(({ status }) => status === 'active')

  // The document read before this change may not show the entry as active yet.
  if (fallback && !active.some(({ id }) => id === fallback.id)) {
    active.push(fallback)
  }

  return active.reduce((newest, entry) =>
    (entry.activatedAt ?? '') > (newest.activatedAt ?? '') ? entry : newest
  )
}

/**
 * Creates a credential still missing for a team with an active entry: none
 * recorded, an earlier attempt that did not finish, or one revoked before
 * the newest activation (`teamCredentialNeedsRetry`), at most once per retry
 * interval.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, environment: string, deployments: object[]}} doc - the team's document
 * @param {{ensureCredential?: Function, locker: import('mongo-locks').LockManager, logger?: import('pino').Logger, retryAfterMs?: number}} settings
 * @param {object} [entry] - an entry known to be active that `doc` may not show as such yet
 * @returns {Promise<boolean>} whether a credential was created
 */
export async function retryTeamCredential(db, doc, settings, entry) {
  const resolved = settingsOf(settings)
  const newest = newestActive(doc, entry)
  const needed = await teamCredentialNeedsRetry(db, doc, {
    retryAfterMs: resolved.retryAfterMs,
    activatedAt: newest.activatedAt ?? null
  })

  return (
    needed && grantTeamCredential(db, doc, newest, resolved, { retry: true })
  )
}

/**
 * The maintenance step that gives every team with an active deployment the
 * credential it is missing - one whose creation failed when the model turned
 * active, or never ran - without polling GitHub. Each team and environment
 * is tried at most once per retry interval, and a credential an admin
 * revoked is left alone (`teamCredentialNeedsRetry`).
 * @param {import('mongodb').Db} db
 * @param {{logger?: import('pino').Logger, locker?: import('mongo-locks').LockManager, retryAfterMs?: number, ensureCredential?: Function}} [deps]
 * @returns {Promise<number>} how many credentials were created
 */
export async function recoverTeamCredentials(db, deps = {}) {
  const docs = await db
    .collection('teamDeployments')
    .find({ deployments: { $elemMatch: { status: 'active' } } })
    .toArray()
  let created = 0

  // Sequential by design: one team's attempt holds its credential lock.
  for (const doc of docs) {
    if (await retryTeamCredential(db, doc, deps)) {
      created += 1
    }
  }

  return created
}

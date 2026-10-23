import {
  auditDeployment,
  entryFields
} from '#/services/team-deployment-entries.js'

// The statuses in which the backend is waiting on GitHub's apply, so a long
// stay is worth a warning. Earlier ones wait on a person or on checks.
const WAITING_ON_APPLY = new Set(['merged', 'deploying'])

/**
 * Whether an entry has waited on the apply for longer than `afterMs`, and
 * has not been warned about at that status yet.
 * @param {{status: string, statusTimes?: Record<string, string>, gitops?: {stalled?: {status: string}}|null}} entry
 * @param {number} afterMs - 0 turns the warning off
 * @param {number} [now]
 * @returns {boolean}
 */
export function looksStalled(entry, afterMs, now = Date.now()) {
  const since = Date.parse(entry.statusTimes?.[entry.status])

  return (
    afterMs > 0 &&
    WAITING_ON_APPLY.has(entry.status) &&
    Boolean(entry.gitops) &&
    entry.gitops.stalled?.status !== entry.status &&
    Number.isFinite(since) &&
    now - since >= afterMs
  )
}

// Atomically sets fields on the entry while `matching` holds, so overlapping
// polls act once. Whether this call won.
async function claim(db, doc, entry, matching, fields) {
  const { matchedCount } = await db.collection('teamDeployments').updateOne(
    {
      _id: doc._id,
      deployments: { $elemMatch: { id: entry.id, ...matching } }
    },
    { $set: entryFields(fields) }
  )

  return matchedCount === 1
}

// A stall warned about whose audit event is still owed: the insert failed.
// Owed whatever the deployment's status is by now.
function auditOwed(entry) {
  return entry.gitops?.stalled?.audited === false
}

// Delivers the audit event of a stall once, using the status and time saved
// with the stall. A failed insert is logged and retried on a later poll.
async function deliverAudit(db, doc, entry, logger) {
  const { status, since } = entry.gitops.stalled
  const owed = { 'gitops.stalled.audited': false }

  if (
    !(await claim(db, doc, entry, owed, { 'gitops.stalled.audited': true }))
  ) {
    return
  }

  try {
    await auditDeployment(db, entry, {
      action: 'teamDeployment.stalled',
      outcome: 'failure',
      code: 'stalled',
      reason: `${status} since ${since}`
    })
  } catch {
    logger?.error(
      { operationId: entry.operationId, status },
      'The stalled deployment audit event could not be recorded, retrying on a later poll'
    )
    await claim(
      db,
      doc,
      entry,
      { 'gitops.stalled.audited': true },
      { 'gitops.stalled.audited': false }
    ).catch(() => false)
  }
}

async function raiseStall(db, doc, entry, settings) {
  const { stallWarnAfterMs, logger } = settings

  if (auditOwed(entry)) {
    await deliverAudit(db, doc, entry, logger)

    return false
  }

  if (!looksStalled(entry, stallWarnAfterMs)) {
    return false
  }

  const since = entry.statusTimes[entry.status]
  const warned = await claim(
    db,
    doc,
    entry,
    {
      status: entry.status,
      'gitops.stalled.status': { $ne: entry.status }
    },
    { 'gitops.stalled': { status: entry.status, since, audited: false } }
  )

  if (!warned) {
    return false
  }

  logger?.warn(
    {
      operationId: entry.operationId,
      environment: doc.environment,
      status: entry.status,
      since,
      applyRunId: entry.gitops.applyRunId ?? null
    },
    'Team deployment looks stalled: still waiting on the apply, so it needs a platform engineer to look at it'
  )

  await deliverAudit(
    db,
    doc,
    {
      ...entry,
      gitops: { ...entry.gitops, stalled: { status: entry.status, since } }
    },
    logger
  )

  return true
}

/**
 * Warns, and audits, once per status when a deployment has sat at `merged`
 * or `deploying` for too long. It records `gitops.stalled` atomically while
 * the entry still has the status read, so overlapping polls warn once, warns
 * before it audits, and retries an audit event that failed to record - at
 * any later status - without warning again. This is diagnostics only: it
 * never changes the deployment's status, and a failure of its own database
 * writes is logged and never fails the poll. Logs carry the operation ID,
 * status, run ID and the time only.
 * @param {import('mongodb').Db} db
 * @param {{_id: import('mongodb').ObjectId, environment: string}} doc
 * @param {{id: string, operationId: string, status: string, statusTimes?: Record<string, string>, gitops?: object|null}} entry
 * @param {{stallWarnAfterMs: number, logger?: import('pino').Logger}} settings
 * @returns {Promise<boolean>} Whether this call raised the warning.
 */
export async function reportStall(db, doc, entry, settings) {
  try {
    return await raiseStall(db, doc, entry, settings)
  } catch (error) {
    settings.logger?.warn(
      { operationId: entry.operationId, message: error.message },
      'Stall reporting failed, the deployment poll carries on'
    )

    return false
  }
}

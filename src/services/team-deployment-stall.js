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

/**
 * Warns, and audits, once per status when a deployment has sat at `merged`
 * or `deploying` for too long. It records `gitops.stalled` atomically while
 * the entry still has the status read, so overlapping polls warn once, and
 * never changes the deployment's status. Logs carry the operation ID,
 * status, run ID and the time only.
 * @param {import('mongodb').Db} db
 * @param {{_id: import('mongodb').ObjectId, environment: string}} doc
 * @param {{id: string, operationId: string, status: string, statusTimes?: Record<string, string>, gitops?: object|null}} entry
 * @param {{stallWarnAfterMs: number, logger?: import('pino').Logger}} settings
 * @returns {Promise<boolean>} Whether this call raised the warning.
 */
export async function reportStall(db, doc, entry, settings) {
  const { stallWarnAfterMs, logger } = settings

  if (!looksStalled(entry, stallWarnAfterMs)) {
    return false
  }

  const since = entry.statusTimes[entry.status]
  const { matchedCount } = await db.collection('teamDeployments').updateOne(
    {
      _id: doc._id,
      deployments: {
        $elemMatch: {
          id: entry.id,
          status: entry.status,
          'gitops.stalled.status': { $ne: entry.status }
        }
      }
    },
    {
      $set: entryFields({
        'gitops.stalled': { status: entry.status, since }
      })
    }
  )

  if (matchedCount === 0) {
    return false
  }

  await auditDeployment(db, entry, {
    action: 'teamDeployment.stalled',
    outcome: 'failure',
    code: 'stalled',
    reason: `${entry.status} since ${since}`
  })

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

  return true
}

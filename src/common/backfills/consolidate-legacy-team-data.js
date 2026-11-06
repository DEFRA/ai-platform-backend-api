import { mapSequentially } from '#/common/helpers/sequential.js'

const SUBSCRIPTION_KEY = 'subscription-key'

/**
 * Groups legacy one-row-per-model documents by team and environment, renaming
 * the legacy `dev` environment to `sandbox`.
 * @param {Array<object>} legacyDocs
 * @returns {Array<{teamId: string, environment: string, docs: Array<object>}>}
 */
function groupByTeamEnvironment(legacyDocs) {
  const groups = new Map()

  for (const doc of legacyDocs) {
    const environment = doc.environment === 'dev' ? 'sandbox' : doc.environment
    const key = `${doc.teamId}::${environment}`

    if (!groups.has(key)) {
      groups.set(key, { teamId: doc.teamId, environment, docs: [] })
    }

    groups.get(key).docs.push(doc)
  }

  return [...groups.values()]
}

function toDeploymentEntry(doc) {
  return {
    id: doc._id.toString(),
    modelSlug: doc.modelSlug,
    status: doc.status,
    operationId: doc.operationId,
    requestedBy: doc.requestedBy,
    idempotencyKey: doc.idempotencyKey,
    createdAt: doc.createdAt,
    activatedAt: doc.activatedAt ?? null,
    failureReason: doc.failureReason ?? null
  }
}

function consolidatedDeploymentOps(group, entries) {
  const allowedDeployments = [
    ...new Set(
      entries
        .filter((entry) => entry.status === 'active')
        .map((entry) => entry.modelSlug)
    )
  ]
  const earliestCreatedAt = entries.map((entry) => entry.createdAt).sort()[0]
  const now = new Date().toISOString()

  const updateOps = {
    $push: { deployments: { $each: entries } },
    $setOnInsert: {
      teamId: group.teamId,
      environment: group.environment,
      'gateway.credentialType': null,
      'gateway.limits': {},
      oauthClient: { enabled: false, appRoles: [] },
      createdAt: earliestCreatedAt ?? now
    },
    $set: { updatedAt: now }
  }

  if (allowedDeployments.length > 0) {
    updateOps.$addToSet = {
      'gateway.allowedDeployments': { $each: allowedDeployments }
    }
  } else {
    updateOps.$setOnInsert['gateway.allowedDeployments'] = []
  }

  return updateOps
}

/**
 * Merges legacy one-row-per-model `teamDeployments` docs into one
 * `deployments[]` doc per team+environment, renaming `dev` to `sandbox`.
 * Groups are written one after another, in order.
 * @param {import('mongodb').Db} db
 * @returns {Promise<{teamsMigrated: number, deploymentsMigrated: number}>}
 */
export async function consolidateLegacyTeamDeployments(db) {
  const teamDeployments = db.collection('teamDeployments')
  const legacyDocs = await teamDeployments
    .find({ deployments: { $exists: false } })
    .toArray()

  const entryCounts = await mapSequentially(
    groupByTeamEnvironment(legacyDocs),
    async (group) => {
      const entries = group.docs.map(toDeploymentEntry)

      await teamDeployments.updateOne(
        { teamId: group.teamId, environment: group.environment },
        consolidatedDeploymentOps(group, entries),
        { upsert: true }
      )

      await teamDeployments.deleteMany({
        _id: { $in: group.docs.map((doc) => doc._id) }
      })

      return entries.length
    }
  )

  return {
    teamsMigrated: entryCounts.length,
    deploymentsMigrated: entryCounts.reduce((total, count) => total + count, 0)
  }
}

/**
 * Merges legacy one-per-model team credentials into one per team+environment
 * (the active doc, else the most recent) carrying `allowedDeployments` and
 * `credentialType`, retires the superseded rows and seeds the matching
 * `teamDeployments` doc's `gateway.credentialType`. Groups are written one
 * after another, in order.
 * @param {import('mongodb').Db} db
 * @returns {Promise<{teamsMigrated: number, credentialsRetired: number}>}
 */
export async function consolidateLegacyTeamCredentials(db) {
  const credentials = db.collection('credentials')
  const legacyDocs = await credentials
    .find({ tier: 'team', allowedDeployments: { $exists: false } })
    .toArray()

  const retiredCounts = await mapSequentially(
    groupByTeamEnvironment(legacyDocs),
    async (group) => {
      const docs = [...group.docs].sort((a, b) =>
        a.createdAt < b.createdAt ? -1 : 1
      )
      const canonical =
        docs.find((doc) => doc.status === 'active') ?? docs.at(-1)
      const allowedDeployments = [
        ...new Set(docs.map((doc) => doc.modelSlug).filter(Boolean))
      ]

      await credentials.updateOne(
        { _id: canonical._id },
        {
          $set: {
            environment: group.environment,
            modelSlug: null,
            allowedDeployments,
            credentialType: SUBSCRIPTION_KEY,
            expiresAt: null
          }
        }
      )

      const supersededIds = docs
        .filter((doc) => !doc._id.equals(canonical._id))
        .map((doc) => doc._id)

      if (supersededIds.length > 0) {
        await credentials.deleteMany({ _id: { $in: supersededIds } })
      }

      await db.collection('teamDeployments').updateOne(
        {
          teamId: group.teamId,
          environment: group.environment,
          'gateway.credentialType': null
        },
        {
          $set: {
            'gateway.credentialType': SUBSCRIPTION_KEY,
            'oauthClient.enabled': false,
            updatedAt: new Date().toISOString()
          }
        }
      )

      return supersededIds.length
    }
  )

  return {
    teamsMigrated: retiredCounts.length,
    credentialsRetired: retiredCounts.reduce((total, count) => total + count, 0)
  }
}

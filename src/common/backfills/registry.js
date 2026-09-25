/**
 * Ordered registry of one-off data backfills applied by `runBackfills` on
 * every server start. Each entry is applied at most once per environment
 * (tracked in the `schemaMigrations` collection), so `run` only needs to be
 * idempotent against documents it hasn't reached yet - not against re-runs
 * of the whole backfill.
 *
 * Add a new entry when a schema change needs existing documents updated to
 * the new shape (the "backfill" step of expand -> backfill -> contract).
 * Keep entries after they've shipped - they double as a changelog of what
 * ran, and re-ordering/removing a shipped entry has no effect since its id
 * is already recorded as applied.
 *
 * @type {Array<{
 *   id: string,
 *   description: string,
 *   run: (db: import('mongodb').Db) => Promise<object|void>
 * }>}
 */
export const backfillRegistry = [
  // Pre-refactor `teamDeployments` docs were one row per team+model+environment
  // with no `deployments[]` (see git history for the exact shape). The new
  // unique `{teamId, environment}` index means every model for a team+
  // environment must live in one document's `deployments[]` array instead -
  // this merges the legacy rows into that shape and renames the legacy
  // `dev` environment value to `sandbox` (Phase 1, confirmed 24 Sept 2026).
  // Must run before `createIndexes` creates that unique index (see
  // `src/plugins/mongodb.js`), since duplicate `{teamId, environment}` keys
  // across legacy rows would otherwise fail index creation.
  {
    id: '2026-09-25-consolidate-legacy-team-deployments',
    description:
      'Merges legacy one-row-per-model teamDeployments docs into one deployments[] doc per team+environment, renaming dev to sandbox',
    async run(db) {
      const legacyDocs = await db
        .collection('teamDeployments')
        .find({ deployments: { $exists: false } })
        .toArray()

      const groups = new Map()

      for (const doc of legacyDocs) {
        const environment = doc.environment === 'dev' ? 'sandbox' : doc.environment
        const key = `${doc.teamId}::${environment}`

        if (!groups.has(key)) {
          groups.set(key, { teamId: doc.teamId, environment, docs: [] })
        }

        groups.get(key).docs.push(doc)
      }

      let teamsMigrated = 0
      let deploymentsMigrated = 0

      for (const group of groups.values()) {
        const entries = group.docs.map((doc) => ({
          id: doc._id.toString(),
          modelSlug: doc.modelSlug,
          status: doc.status,
          operationId: doc.operationId,
          requestedBy: doc.requestedBy,
          idempotencyKey: doc.idempotencyKey,
          createdAt: doc.createdAt,
          activatedAt: doc.activatedAt ?? null,
          failureReason: doc.failureReason ?? null
        }))

        const allowedDeployments = [
          ...new Set(
            entries
              .filter((entry) => entry.status === 'active')
              .map((entry) => entry.modelSlug)
          )
        ]
        const earliestCreatedAt = entries
          .map((entry) => entry.createdAt)
          .sort()[0]
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

        await db
          .collection('teamDeployments')
          .updateOne(
            { teamId: group.teamId, environment: group.environment },
            updateOps,
            { upsert: true }
          )

        await db.collection('teamDeployments').deleteMany({
          _id: { $in: group.docs.map((doc) => doc._id) }
        })

        teamsMigrated += 1
        deploymentsMigrated += entries.length
      }

      return { teamsMigrated, deploymentsMigrated }
    }
  },
  // Pre-refactor team credentials were one document per team+model (always
  // `type: 'apim-subscription'`, no `allowedDeployments`/`credentialType`).
  // The new one-credential-per-team+environment shape needs these merged:
  // keeps one canonical doc (the active one, or the most recent), merges
  // every legacy row's model into its `allowedDeployments`, sets
  // `credentialType: 'subscription-key'` (the only type that existed
  // before), renames `dev` to `sandbox`, retires the superseded rows, and
  // clears `expiresAt` (team credentials don't expire/renew - see
  // `credential-service.js`). Also seeds the matching `teamDeployments`
  // doc's `gateway.credentialType` so `reserveCredentialType` recognises
  // the team already uses `subscription-key`. Must run after the
  // `teamDeployments` consolidation above.
  {
    id: '2026-09-25-consolidate-legacy-team-credentials',
    description:
      'Merges legacy one-per-model team credentials into one per team+environment with allowedDeployments/credentialType, renaming dev to sandbox',
    async run(db) {
      const legacyDocs = await db
        .collection('credentials')
        .find({ tier: 'team', allowedDeployments: { $exists: false } })
        .toArray()

      const groups = new Map()

      for (const doc of legacyDocs) {
        const environment = doc.environment === 'dev' ? 'sandbox' : doc.environment
        const key = `${doc.teamId}::${environment}`

        if (!groups.has(key)) {
          groups.set(key, { teamId: doc.teamId, environment, docs: [] })
        }

        groups.get(key).docs.push(doc)
      }

      let teamsMigrated = 0
      let credentialsRetired = 0

      for (const group of groups.values()) {
        const docs = [...group.docs].sort((a, b) =>
          a.createdAt < b.createdAt ? -1 : 1
        )
        const canonical =
          docs.find((doc) => doc.status === 'active') ?? docs[docs.length - 1]
        const allowedDeployments = [
          ...new Set(docs.map((doc) => doc.modelSlug).filter(Boolean))
        ]

        await db.collection('credentials').updateOne(
          { _id: canonical._id },
          {
            $set: {
              environment: group.environment,
              modelSlug: null,
              allowedDeployments,
              credentialType: 'subscription-key',
              expiresAt: null
            }
          }
        )

        const supersededIds = docs
          .filter((doc) => !doc._id.equals(canonical._id))
          .map((doc) => doc._id)

        if (supersededIds.length > 0) {
          await db
            .collection('credentials')
            .deleteMany({ _id: { $in: supersededIds } })
        }

        await db.collection('teamDeployments').updateOne(
          {
            teamId: group.teamId,
            environment: group.environment,
            'gateway.credentialType': null
          },
          {
            $set: {
              'gateway.credentialType': 'subscription-key',
              'oauthClient.enabled': false,
              updatedAt: new Date().toISOString()
            }
          }
        )

        teamsMigrated += 1
        credentialsRetired += supersededIds.length
      }

      return { teamsMigrated, credentialsRetired }
    }
  },
  // `environment` was added to every credential doc when Route 2 introduced
  // team-tier credentials; research-tier credentials issued before that
  // never got the field (nothing reads it today, but a future query/report
  // filtering by environment would silently skip these docs otherwise).
  {
    id: '2026-09-25-credentials-environment-default',
    description: 'Sets environment: null on credentials docs missing it',
    async run(db) {
      const { modifiedCount } = await db
        .collection('credentials')
        .updateMany(
          { environment: { $exists: false } },
          { $set: { environment: null } }
        )

      return { modifiedCount }
    }
  }
]

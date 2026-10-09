import { invalidateModelsCache } from '#/services/models-service.js'
import { DEFAULT_GATEWAY } from '#/adapters/gateway-keys.js'

// Pinned data-plane api-version per apiProfile, verified against the sandbox
// gateway (docs/plans/integration/research-tier-integration-plan.md in
// ai-platform-frontend): `responses` 404s on the chat-completions default.
// Takes precedence over whatever the source supplies for that profile (see
// normalizeModel below) - a source has been seen shipping a stale generic
// apiVersion even on a model explicitly marked apiProfile: 'responses'.
const DEFAULT_API_VERSION_BY_PROFILE = { responses: '2025-03-01-preview' }
const DEFAULT_API_VERSION = '2024-05-01-preview'

// Catalogue releases up to v0.1.1 predate `cloud`/`adapter` and were Azure-only.
const LEGACY_CLOUD = 'azure'

const PLATFORM_BY_CLOUD = { azure: 'foundry', aws: 'bedrock' }

function legacyHosting(cloud) {
  const resolvedCloud = cloud ?? LEGACY_CLOUD

  return {
    platform: PLATFORM_BY_CLOUD[resolvedCloud] ?? 'foundry',
    cloud: resolvedCloud,
    provider: null
  }
}

// Permanent, not migration scaffolding: environments pin `CATALOGUE_REF`
// independently, so a flat v0.1.x offering (`{id, cloud, adapter}`) or a
// plain-string one must keep working for as long as any environment pins one.
function normalizeOffering(offering) {
  if (typeof offering === 'string') {
    return {
      id: offering,
      hosting: legacyHosting(),
      gateway: DEFAULT_GATEWAY
    }
  }

  if (offering.hosting) {
    return {
      id: offering.id,
      hosting: {
        platform: offering.hosting.platform,
        cloud: offering.hosting.cloud ?? null,
        provider: offering.hosting.provider ?? null
      },
      gateway: offering.gateway ?? DEFAULT_GATEWAY
    }
  }

  return {
    id: offering.id,
    hosting: legacyHosting(offering.cloud),
    gateway: offering.adapter ?? offering.gateway ?? DEFAULT_GATEWAY
  }
}

// `provider/offering` -> `{id, hosting, gateway}`, plus any offering id a
// provider lists more than once.
function indexOfferings(providers) {
  const index = new Map()
  const duplicates = []

  for (const provider of providers) {
    for (const offering of provider.offerings ?? []) {
      const entry = normalizeOffering(offering)
      const key = `${provider.id}/${entry.id}`

      if (index.has(key)) {
        duplicates.push(key)
      }

      index.set(key, entry)
    }
  }

  return { index, duplicates }
}

// The github source passes `ai-platform-infra`'s raw catalogue/models/*.json
// through unmodified (pinned by its own tests), which nests eligibility as
// `{eligibility: {eligible, reason}}`, only carries a `regions` array, and
// has no `apiVersion` field at all - whereas the rest of this codebase
// (queries, routes, the frontend) reads flat `eligible`/`eligibilityReason`/
// `region`/`apiVersion`, the shape the file fixture already uses. Normalise
// here, at the single write path both sources go through, rather than
// changing either adapter's pinned output shape.
function normalizeModel(model, offering) {
  // The offering owns hosting and gateway; a model's own flat `cloud`/`adapter`
  // is only tolerated as input from a stale v0.1.x release, never re-emitted.
  const { cloud, adapter, ...rest } = model

  return {
    ...rest,
    hosting: offering?.hosting ?? model.hosting ?? legacyHosting(cloud),
    gateway: offering?.gateway ?? model.gateway ?? adapter ?? DEFAULT_GATEWAY,
    eligible: model.eligible ?? model.eligibility?.eligible,
    eligibilityReason: model.eligibilityReason ?? model.eligibility?.reason,
    region: model.region ?? model.regions?.[0],
    apiVersion:
      DEFAULT_API_VERSION_BY_PROFILE[model.apiProfile] ??
      model.apiVersion ??
      DEFAULT_API_VERSION
  }
}

/**
 * Syncs the model catalogue from a `CatalogueSource` into MongoDB: upserts
 * every model by slug with `catalogueSha`/`release`/`syncedAt`, and retires
 * (never deletes - credentials reference slugs) any model no longer present
 * in the source. Guarded by a `mongo-locks` lock so replicas starting at the
 * same time don't duplicate the work; a replica that misses the lock simply
 * skips, relying on whichever instance won.
 *
 * A source returning zero models is treated as a misconfiguration, not an
 * intentionally empty catalogue, and is skipped rather than retiring every
 * existing model - this matters today because `ai-platform-infra`'s
 * `catalogue/` is still empty.
 * @param {import('mongodb').Db} db
 * @param {import('#/adapters/catalogue-source.js').CatalogueSource} source
 * @param {import('mongo-locks').LockManager} locker
 * @param {import('pino').Logger} logger
 */
export async function syncCatalogue(db, source, locker, logger) {
  const lock = await locker.lock('catalogue-sync')

  if (!lock) {
    return { synced: 0, retired: 0, skipped: true }
  }

  try {
    const { models, providers, catalogueSha, release } =
      await source.fetchCatalogue()

    if (models.length === 0) {
      logger.warn(
        'Catalogue source returned zero models - skipping sync rather than retiring the existing catalogue'
      )
      return { synced: 0, retired: 0, skipped: true }
    }

    const { index: offerings, duplicates } = indexOfferings(providers)

    // Skip rather than throw: a throw would reach startup, whereas skipping
    // keeps the last good catalogue like every other guard here.
    if (duplicates.length > 0) {
      logger.error(
        `Catalogue has duplicate offering ids (${duplicates.join(', ')}) - skipping sync`
      )
      return { synced: 0, retired: 0, skipped: true }
    }

    const now = new Date().toISOString()
    const modelsCollection = db.collection('models')
    let synced = 0

    for (const rawModel of models) {
      const offering = offerings.get(
        `${rawModel.provider}/${rawModel.offering}`
      )
      const model = normalizeModel(rawModel, offering)

      // A model naming a provider/offering the catalogue doesn't define would
      // otherwise fall back to Azure/APIM - keep the last good copy instead.
      if (rawModel.provider && rawModel.offering && !offering) {
        logger.warn(
          `Skipping catalogue model ${model.slug}: unknown offering ${rawModel.provider}/${rawModel.offering}`
        )
        continue
      }

      // A stale release whose model still declares its own `cloud`/`adapter`
      // contradicting the offering would issue credentials through the wrong
      // gateway - keep the last good copy rather than sync it.
      if (
        offering &&
        ((rawModel.cloud && rawModel.cloud !== offering.hosting.cloud) ||
          (rawModel.adapter && rawModel.adapter !== offering.gateway))
      ) {
        logger.warn(
          `Skipping catalogue model ${model.slug}: cloud/adapter disagree with offering ${model.provider}/${model.offering}`
        )
        continue
      }

      synced++
      await modelsCollection.updateOne(
        { slug: model.slug },
        {
          $set: {
            ...model,
            catalogueSha,
            release,
            syncedAt: now,
            updatedAt: now
          },
          // `$set` alone would leave the old flat fields on an already-synced doc.
          $unset: { cloud: '', adapter: '' }
        },
        { upsert: true }
      )
    }

    for (const { $schema, ...provider } of providers) {
      // `$schema` is editor metadata and a `$`-prefixed key Mongo rejects in `$set`.
      await db
        .collection('providers')
        .updateOne(
          { id: provider.id },
          { $set: { ...provider, catalogueSha, release, syncedAt: now } },
          { upsert: true }
        )
    }

    const seenSlugs = models.map((model) => model.slug)
    const { modifiedCount: retired } = await modelsCollection.updateMany(
      { slug: { $nin: seenSlugs }, 'lifecycle.status': { $ne: 'retired' } },
      {
        $set: {
          eligible: false,
          'lifecycle.status': 'retired',
          updatedAt: now
        }
      }
    )

    invalidateModelsCache()

    logger.info(
      `Synced ${synced} catalogue models (release ${release}), retired ${retired}`
    )

    return { synced, retired }
  } finally {
    await lock.free()
  }
}

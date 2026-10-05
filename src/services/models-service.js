const cacheTtlMs = 5 * 60 * 1000
const cache = new Map()

function cacheKey(prefix, params) {
  return `${prefix}:${JSON.stringify(params)}`
}

function readCache(key) {
  const entry = cache.get(key)

  if (!entry || entry.expiresAt <= Date.now()) {
    cache.delete(key)
    return undefined
  }

  return entry.value
}

function writeCache(key, value) {
  cache.set(key, { value, expiresAt: Date.now() + cacheTtlMs })
}

/**
 * Clears the in-process models cache, e.g. after reloading the seed data.
 */
export function invalidateModelsCache() {
  cache.clear()
}

/**
 * Lists models, optionally filtered by provider and/or tier. Excludes
 * ineligible/retired models unless `includeIneligible` is set - the connect
 * journeys rely on the default (eligible-only) so people can never pick a
 * model they can't actually use; the catalogue browse page passes
 * `includeIneligible: true` so it can grey ineligible ones out instead of
 * hiding them (Phase 5 item 2). Reads are cached in-process for 5 minutes,
 * keyed by the filters used.
 * @param {import('mongodb').Db} db
 * @param {{provider?: string, tier?: string, includeIneligible?: boolean}} [filters]
 */
export async function listModels(
  db,
  { provider, tier, includeIneligible = false } = {}
) {
  const key = cacheKey('list', { provider, tier, includeIneligible })
  const cached = readCache(key)

  if (cached) {
    return cached
  }

  const query = includeIneligible ? {} : { eligible: true }

  if (provider) {
    query.provider = provider
  }

  if (tier) {
    query.tiers = tier
  }

  const items = await db
    .collection('models')
    .find(query, { projection: { _id: 0 } })
    .toArray()

  writeCache(key, items)

  return items
}

/**
 * Finds a single model by its slug. Reads are cached in-process for 5 minutes.
 * @param {import('mongodb').Db} db
 * @param {string} slug
 */
export async function findModelBySlug(db, slug) {
  const key = cacheKey('slug', { slug })
  const cached = readCache(key)

  if (cached !== undefined) {
    return cached
  }

  const model = await db
    .collection('models')
    .findOne({ slug }, { projection: { _id: 0 } })

  writeCache(key, model)

  return model
}

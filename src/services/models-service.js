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
 * Lists eligible models, optionally filtered by provider and/or tier.
 * Reads are cached in-process for 5 minutes, keyed by the filters used.
 * @param {import('mongodb').Db} db
 * @param {{provider?: string, tier?: string}} [filters]
 */
export async function listEligibleModels(db, { provider, tier } = {}) {
  const key = cacheKey('list', { provider, tier })
  const cached = readCache(key)

  if (cached) {
    return cached
  }

  const query = { eligible: true }

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

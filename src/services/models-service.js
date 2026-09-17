/**
 * Lists eligible models, optionally filtered by provider and/or tier.
 * @param {import('mongodb').Db} db
 * @param {{provider?: string, tier?: string}} [filters]
 */
export function listEligibleModels(db, { provider, tier } = {}) {
  const query = { eligible: true }

  if (provider) {
    query.provider = provider
  }

  if (tier) {
    query.tiers = tier
  }

  return db
    .collection('models')
    .find(query, { projection: { _id: 0 } })
    .toArray()
}

/**
 * Finds a single model by its slug.
 * @param {import('mongodb').Db} db
 * @param {string} slug
 */
export function findModelBySlug(db, slug) {
  return db.collection('models').findOne({ slug }, { projection: { _id: 0 } })
}

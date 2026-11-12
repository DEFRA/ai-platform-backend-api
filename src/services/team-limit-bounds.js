import { findModelBySlug } from '#/services/models-service.js'
import { teamSkuOf } from '#/services/catalogue-service.js'

// The bounds a team's limits sit within in one environment (plan D5, design
// C: limits sit "within the catalogue `capacityPolicy` for this
// environment"). One capacity unit is 1,000 tokens a minute and 6 requests a
// minute per 1,000 (the Azure quota page); a team's ceiling is what the
// catalogue lets it hold of the models it has there. B17 agrees bounds per
// environment later; the team file's schema stays the backstop.

/**
 * The tokens a minute one capacity unit allows.
 */
export const TOKENS_PER_CAPACITY_UNIT = 1000

/**
 * The requests a minute one capacity unit allows.
 */
export const REQUESTS_PER_CAPACITY_UNIT = 6

/**
 * What the bounds are when a team holds no model the catalogue knows: there
 * is nothing to bound, and so nothing to change.
 */
export const LIMIT_BOUNDS_UNAVAILABLE = null

const MINIMUM = 1

// The most capacity the catalogue lets a team hold of the model here: the
// environment's own maximum, else the model's, else what its team SKU lists,
// else one unit (the order `deploymentOf` takes the default in).
function capacityMaxOf(model, environment) {
  const policy = model.capacityPolicy ?? {}

  return (
    policy.environments?.[environment]?.max ??
    policy.max ??
    teamSkuOf(model)?.capacity ??
    1
  )
}

/**
 * The bounds for the models a team holds in an environment: tokens a minute
 * from 1 to 1,000 for each capacity unit the models allow together; requests
 * a minute from 1 to the larger of the models' default requests added up and
 * 6 a minute per 1,000 of that token ceiling. A model the catalogue no longer
 * holds counts for nothing.
 * @param {Array<object|null>} models - the catalogue entries of the team's models
 * @param {string} environment
 * @returns {{tokensPerMinute: {min: number, max: number}, requestsPerMinute: {min: number, max: number}}|null}
 */
export function limitBoundsOf(models, environment) {
  const known = models.filter(Boolean)

  if (known.length === 0) {
    return LIMIT_BOUNDS_UNAVAILABLE
  }

  const units = known.reduce(
    (total, model) => total + capacityMaxOf(model, environment),
    0
  )
  const defaults = known.reduce(
    (total, model) => total + (model.limitsDefault?.requestsPerMinute ?? 0),
    0
  )

  return {
    tokensPerMinute: {
      min: MINIMUM,
      max: units * TOKENS_PER_CAPACITY_UNIT
    },
    requestsPerMinute: {
      min: MINIMUM,
      max: Math.max(defaults, units * REQUESTS_PER_CAPACITY_UNIT)
    }
  }
}

/**
 * The bounds for the models a team file holds, from the synced catalogue.
 * @param {import('mongodb').Db} db
 * @param {{environment: string, document: {deployments?: Array<{slug: string}>}}} file
 * @returns {Promise<ReturnType<typeof limitBoundsOf>>}
 */
export async function limitBoundsFor(db, { environment, document }) {
  const models = await Promise.all(
    (document.deployments ?? []).map(({ slug }) => findModelBySlug(db, slug))
  )

  return limitBoundsOf(models, environment)
}

/**
 * Whether both limits sit within the bounds.
 * @param {NonNullable<ReturnType<typeof limitBoundsOf>>} bounds
 * @param {{tokensPerMinute: number, requestsPerMinute: number}} limits
 * @returns {boolean}
 */
export function withinBounds(bounds, { tokensPerMinute, requestsPerMinute }) {
  return (
    tokensPerMinute >= bounds.tokensPerMinute.min &&
    tokensPerMinute <= bounds.tokensPerMinute.max &&
    requestsPerMinute >= bounds.requestsPerMinute.min &&
    requestsPerMinute <= bounds.requestsPerMinute.max
  )
}

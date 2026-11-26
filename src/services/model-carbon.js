// Example carbon factors for an estimate only. The method, the factors and
// whether Defra offsets are not agreed (HVE #52), so teams do not see carbon
// until `USAGE_CARBON_ENABLED` is on, and every figure says it is an estimate.
// A model with no factor has no carbon, never a guessed one.
export const CARBON_FACTOR_VERSION = '2026-11-26-example'
export const GRID_GRAMS_PER_KWH = 200

/** Grams of CO2e for a thousand tokens, input and output alike. */
export const MODEL_CARBON = Object.freeze({
  'gpt-4o': { gramsPerThousandTokens: 0.12 },
  'gpt-4-1-nano': { gramsPerThousandTokens: 0.01 },
  'gpt-5-nano': { gramsPerThousandTokens: 0.01 },
  'gpt-5-mini': { gramsPerThousandTokens: 0.03 }
})

const TOKENS_PER_THOUSAND = 1000
const GRAMS_PER_KILOGRAM = 1000

/**
 * The carbon and electricity a model's tokens come to, or `null` when the
 * model has no factor.
 * @param {string} modelSlug
 * @param {number} totalTokens
 * @param {Record<string, {gramsPerThousandTokens: number}>} [factors]
 * @returns {{kilograms: number, kilowattHours: number}|null}
 */
export function estimatedCarbonOf(
  modelSlug,
  totalTokens,
  factors = MODEL_CARBON
) {
  const factor = Object.hasOwn(factors, modelSlug)
    ? factors[modelSlug]
    : undefined

  if (!factor) {
    return null
  }

  const grams =
    (totalTokens / TOKENS_PER_THOUSAND) * factor.gramsPerThousandTokens

  return {
    kilograms: grams / GRAMS_PER_KILOGRAM,
    kilowattHours: grams / GRID_GRAMS_PER_KWH
  }
}

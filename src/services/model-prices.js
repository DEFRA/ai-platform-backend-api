// Indicative Azure OpenAI list prices, USD per million tokens, for an estimate
// only. The tariff and period are not yet agreed with the chargeback owners
// (design G, B19), so a cost is always labelled an estimate and a model with no
// entry here has no cost rather than a guessed one. Replace with the agreed
// tariff, or read it from the catalogue, when it exists.
export const PRICE_VERSION = '2026-11-26-indicative'
export const PRICE_CURRENCY = 'USD'

/** @type {Record<string, {inputPerMillion: number, outputPerMillion: number}>} */
export const MODEL_PRICES = Object.freeze({
  'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10 },
  'gpt-4-1-nano': { inputPerMillion: 0.1, outputPerMillion: 0.4 },
  'gpt-5-nano': { inputPerMillion: 0.05, outputPerMillion: 0.4 }
})

const TOKENS_PER_MILLION = 1_000_000

/**
 * What a model's tokens cost at the indicative price, or `null` when it has
 * none.
 * @param {string} modelSlug
 * @param {{promptTokens: number, completionTokens: number}} tokens
 * @param {Record<string, {inputPerMillion: number, outputPerMillion: number}>} [prices]
 * @returns {number|null}
 */
export function estimatedCostOf(modelSlug, tokens, prices = MODEL_PRICES) {
  const price = Object.hasOwn(prices, modelSlug) ? prices[modelSlug] : undefined

  if (!price) {
    return null
  }

  return (
    (tokens.promptTokens / TOKENS_PER_MILLION) * price.inputPerMillion +
    (tokens.completionTokens / TOKENS_PER_MILLION) * price.outputPerMillion
  )
}

import { MODEL_PRICES, estimatedCostOf } from '#/services/model-prices.js'

const MS_PER_DAY = 86_400_000
const DAY_LENGTH = 10

function isoDay(milliseconds) {
  return new Date(milliseconds).toISOString().slice(0, DAY_LENGTH)
}

/**
 * The calendar window for the last `days` days, today included: `from` is
 * inclusive and `to` (tomorrow) exclusive, both UTC dates.
 * @param {Date} now
 * @param {number} days
 * @returns {{from: string, to: string, days: number}}
 */
export function usagePeriod(now, days) {
  const today = Date.parse(`${isoDay(now.getTime())}T00:00:00Z`)
  const end = today + MS_PER_DAY

  return { from: isoDay(end - days * MS_PER_DAY), to: isoDay(end), days }
}

function daysOf({ from, to }) {
  const start = Date.parse(`${from}T00:00:00Z`)
  const count = (Date.parse(`${to}T00:00:00Z`) - start) / MS_PER_DAY

  return Array.from({ length: count }, (_, index) =>
    isoDay(start + index * MS_PER_DAY)
  )
}

function zero() {
  return { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 }
}

function add(total, row) {
  total.requests += row.requests
  total.promptTokens += row.promptTokens
  total.completionTokens += row.completionTokens
  total.totalTokens += row.promptTokens + row.completionTokens
}

/**
 * The model a deployment serves: deployments are named `{team}-{model}`.
 * @param {string} deployment
 * @param {string} teamSlug
 * @returns {string}
 */
export function modelSlugOf(deployment, teamSlug) {
  const prefix = `${teamSlug}-`

  return deployment.startsWith(prefix)
    ? deployment.slice(prefix.length)
    : deployment
}

/**
 * Totals, a figure for every day of the period and one per model, with an
 * estimated cost where the model has a price. A model with no price has no
 * cost, and so the total cost is `null` whenever any model is unpriced, never
 * a sum that leaves usage out.
 * @param {import('#/adapters/usage-reader.js').UsageRow[]} rows
 * @param {{period: {from: string, to: string}, teamSlug: string, prices?: typeof MODEL_PRICES}} options
 */
export function summariseUsage(
  rows,
  { period, teamSlug, prices = MODEL_PRICES }
) {
  const byDay = new Map(daysOf(period).map((day) => [day, zero()]))
  const byModel = new Map()

  for (const row of rows) {
    const day = byDay.get(row.day)

    if (!day) {
      continue
    }

    const modelSlug = modelSlugOf(row.deployment, teamSlug)

    if (!byModel.has(modelSlug)) {
      byModel.set(modelSlug, zero())
    }

    add(day, row)
    add(byModel.get(modelSlug), row)
  }

  const models = [...byModel.entries()]
    .map(([modelSlug, tokens]) => ({
      modelSlug,
      ...tokens,
      estimatedCost: estimatedCostOf(modelSlug, tokens, prices)
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens)
  const totals = zero()

  for (const day of byDay.values()) {
    totals.requests += day.requests
    totals.promptTokens += day.promptTokens
    totals.completionTokens += day.completionTokens
    totals.totalTokens += day.totalTokens
  }

  const priced = models.filter((model) => model.estimatedCost !== null)
  const unpriced = models.filter((model) => model.estimatedCost === null)

  return {
    totals: {
      ...totals,
      estimatedCost:
        unpriced.length > 0
          ? null
          : priced.reduce((sum, model) => sum + model.estimatedCost, 0)
    },
    byDay: [...byDay.entries()].map(([day, tokens]) => ({ day, ...tokens })),
    byModel: models,
    unpricedModels: unpriced.map((model) => model.modelSlug)
  }
}

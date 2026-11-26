import { MODEL_PRICES, estimatedCostOf } from '#/services/model-prices.js'
import { MODEL_CARBON, estimatedCarbonOf } from '#/services/model-carbon.js'
import { modelSlugOf } from '#/services/usage-summary.js'

const MS_PER_DAY = 86_400_000
const DAY_LENGTH = 10
const ATTENTION_DAYS = 7
const TOKENS_PER_MILLION = 1_000_000
const GRAMS_PER_KILOGRAM = 1000

function isoDay(milliseconds) {
  return new Date(milliseconds).toISOString().slice(0, DAY_LENGTH)
}

function monthKeyOf(year, month) {
  return `${year}-${String(month + 1).padStart(2, '0')}`
}

/**
 * The calendar window that holds the last `months` months, this one included:
 * from the first day of the earliest to tomorrow (exclusive), UTC dates.
 * @param {Date} now
 * @param {number} months
 * @returns {{from: string, to: string}}
 */
export function monthsWindow(now, months) {
  const first = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth() - (months - 1),
    1
  )
  const today = Date.parse(`${isoDay(now.getTime())}T00:00:00Z`)

  return { from: isoDay(first), to: isoDay(today + MS_PER_DAY) }
}

function monthKeys(now, months) {
  return Array.from({ length: months }, (_, index) => {
    const date = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth() - (months - 1 - index),
        1
      )
    )

    return monthKeyOf(date.getUTCFullYear(), date.getUTCMonth())
  })
}

function tokensOf() {
  return { requests: 0, promptTokens: 0, completionTokens: 0, tokens: 0 }
}

function add(total, row) {
  total.requests += row.requests
  total.promptTokens += row.promptTokens
  total.completionTokens += row.completionTokens
  total.tokens += row.promptTokens + row.completionTokens
}

// What a set of models' tokens come to: a total is `null` as soon as one model
// has no price (or no factor), never a sum that leaves usage out.
function figuresOf(models, { prices, carbon }) {
  const unpriced = []
  let cost = 0
  let kilograms = 0
  let kilowattHours = 0
  let carbonKnown = carbon.enabled

  for (const [modelSlug, tokens] of models) {
    const price = estimatedCostOf(modelSlug, tokens, prices)

    if (price === null) {
      unpriced.push(modelSlug)
    } else {
      cost += price
    }

    const footprint = carbon.enabled
      ? estimatedCarbonOf(modelSlug, tokens.tokens, carbon.factors)
      : null

    if (footprint === null) {
      carbonKnown = false
    } else {
      kilograms += footprint.kilograms
      kilowattHours += footprint.kilowattHours
    }
  }

  return {
    unpriced,
    cost: unpriced.length > 0 ? null : cost,
    carbonKg: carbonKnown ? kilograms : null,
    electricityKwh: carbonKnown ? kilowattHours : null
  }
}

function modelMapOf(rows, teamSlug) {
  const models = new Map()

  for (const row of rows) {
    const slug = modelSlugOf(row.deployment, teamSlug)

    if (!models.has(slug)) {
      models.set(slug, tokensOf())
    }

    add(models.get(slug), row)
  }

  return models
}

function mergeModelMaps(maps) {
  const merged = new Map()

  for (const map of maps) {
    for (const [slug, tokens] of map) {
      if (!merged.has(slug)) {
        merged.set(slug, tokensOf())
      }

      add(merged.get(slug), {
        ...tokens,
        promptTokens: tokens.promptTokens,
        completionTokens: tokens.completionTokens,
        requests: tokens.requests
      })
    }
  }

  return merged
}

function perMillion(value, tokens) {
  return value === null || tokens === 0
    ? null
    : (value / tokens) * TOKENS_PER_MILLION
}

function scale(value, factor) {
  return value === null ? null : value * factor
}

function attentionOf(refusals, today) {
  const since = isoDay(
    Date.parse(`${today}T00:00:00Z`) - (ATTENTION_DAYS - 1) * MS_PER_DAY
  )

  return refusals
    .map(({ environment, days }) => ({
      kind: 'calls-refused',
      environment,
      count: days
        .filter(({ day }) => day >= since && day <= today)
        .reduce((sum, { refused }) => sum + refused, 0),
      days: ATTENTION_DAYS
    }))
    .filter(({ count }) => count > 0)
    .sort((a, b) => b.count - a.count)
}

/**
 * What a team's Usage pages show, from its usage rows in each environment over
 * the last few months: a figure for every month, and for this month the
 * totals, a forecast at the rate so far, a share by environment and by model,
 * the tokens of each day, and what needs attention. Cost and carbon follow the
 * rule above; there is no budget until it exists (HVE #103).
 * @param {Record<string, import('#/adapters/usage-reader.js').UsageRow[]>} rowsByEnvironment
 * @param {{now: Date, months: number, teamSlug: string, prices?: typeof MODEL_PRICES, carbon?: {enabled: boolean, factors?: typeof MODEL_CARBON}, unavailable: string[], refusals: Array<{environment: string, days: Array<{day: string, refused: number}>}>}} options
 */
export function overviewOf(
  rowsByEnvironment,
  {
    now,
    months,
    teamSlug,
    prices = MODEL_PRICES,
    carbon = { enabled: false, factors: MODEL_CARBON },
    unavailable,
    refusals
  }
) {
  const rules = { prices, carbon: { factors: MODEL_CARBON, ...carbon } }
  const window = monthsWindow(now, months)
  const today = isoDay(now.getTime())
  const keys = monthKeys(now, months)
  const currentKey = keys.at(-1)
  const daysInMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)
  ).getUTCDate()
  const daysElapsed = now.getUTCDate()
  const inWindow = Object.entries(rowsByEnvironment).map(
    ([environment, rows]) => [
      environment,
      rows.filter((row) => row.day >= window.from && row.day < window.to)
    ]
  )

  const monthsView = keys.map((key) => {
    const rows = inWindow.flatMap(([, list]) =>
      list.filter((row) => row.day.startsWith(key))
    )
    const total = tokensOf()

    rows.forEach((row) => add(total, row))

    const { cost, carbonKg } = figuresOf(modelMapOf(rows, teamSlug), rules)

    return {
      key,
      requests: total.requests,
      tokens: total.tokens,
      cost,
      carbonKg
    }
  })

  const currentByEnvironment = inWindow.map(([environment, list]) => [
    environment,
    list.filter((row) => row.day.startsWith(currentKey))
  ])
  const currentRows = currentByEnvironment.flatMap(([, list]) => list)
  const totals = tokensOf()

  currentRows.forEach((row) => add(totals, row))

  const currentModels = modelMapOf(currentRows, teamSlug)
  const figures = figuresOf(currentModels, rules)
  const factor = daysInMonth / daysElapsed

  const byEnvironment = currentByEnvironment
    .map(([environment, list]) => {
      const tokens = tokensOf()

      list.forEach((row) => add(tokens, row))

      const env = figuresOf(modelMapOf(list, teamSlug), rules)

      return {
        environment,
        ...tokens,
        share: totals.tokens === 0 ? 0 : tokens.tokens / totals.tokens,
        cost: env.cost,
        carbonKg: env.carbonKg
      }
    })
    .sort((a, b) => b.tokens - a.tokens)

  const byModel = [...currentModels.entries()]
    .map(([modelSlug, tokens]) => {
      const one = figuresOf(new Map([[modelSlug, tokens]]), rules)

      return {
        modelSlug,
        ...tokens,
        share: totals.tokens === 0 ? 0 : tokens.tokens / totals.tokens,
        price: Object.hasOwn(prices, modelSlug) ? prices[modelSlug] : null,
        cost: one.cost,
        carbonKg: one.carbonKg
      }
    })
    .sort((a, b) => b.tokens - a.tokens)

  const byDay = Array.from({ length: daysElapsed }, (_, index) => {
    const day = `${currentKey}-${String(index + 1).padStart(2, '0')}`
    const perEnvironment = {}
    let tokens = 0

    for (const [environment, list] of currentByEnvironment) {
      const sum = list
        .filter((row) => row.day === day)
        .reduce(
          (total, row) => total + row.promptTokens + row.completionTokens,
          0
        )

      if (sum > 0) {
        perEnvironment[environment] = sum
      }

      tokens += sum
    }

    return { day, tokens, byEnvironment: perEnvironment }
  })

  const unpricedModels = [
    ...new Set(
      figuresOf(
        mergeModelMaps(inWindow.map(([, list]) => modelMapOf(list, teamSlug))),
        rules
      ).unpriced
    )
  ]

  return {
    window,
    month: { key: currentKey, daysElapsed, daysInMonth },
    months: monthsView,
    current: {
      totals: {
        ...totals,
        cost: figures.cost,
        carbonKg: figures.carbonKg,
        electricityKwh: figures.electricityKwh,
        costPerMillionTokens: perMillion(figures.cost, totals.tokens),
        carbonGramsPerMillionTokens: perMillion(
          scale(figures.carbonKg, GRAMS_PER_KILOGRAM),
          totals.tokens
        )
      },
      forecast: {
        tokens: totals.tokens * factor,
        cost: scale(figures.cost, factor),
        carbonKg: scale(figures.carbonKg, factor)
      },
      byEnvironment,
      byModel,
      byDay
    },
    carbonBasis: { enabled: Boolean(carbon.enabled) },
    unavailable,
    unpricedModels,
    attention: attentionOf(refusals, today),
    budget: null
  }
}

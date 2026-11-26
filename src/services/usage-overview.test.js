import { overviewOf, monthsWindow } from '#/services/usage-overview.js'

const PRICES = { 'gpt-4o': { inputPerMillion: 2, outputPerMillion: 8 } }
const FACTORS = { 'gpt-4o': { gramsPerThousandTokens: 0.1 } }
const NOW = new Date('2026-11-23T10:00:00Z')

const row = (day, model, requests, prompt, completion) => ({
  day,
  teamSlug: 'team-a',
  deployment: `team-a-${model}`,
  requests,
  promptTokens: prompt,
  completionTokens: completion
})

function overview(rows, options = {}) {
  return overviewOf(
    { infradev: rows, ...(options.extra ?? {}) },
    {
      now: NOW,
      months: 3,
      teamSlug: 'team-a',
      prices: PRICES,
      carbon: { enabled: true, factors: FACTORS },
      unavailable: [],
      refusals: [],
      ...options
    }
  )
}

describe('#monthsWindow', () => {
  test('runs from the first day of the earliest month to tomorrow', () => {
    expect(monthsWindow(NOW, 3)).toEqual({
      from: '2026-09-01',
      to: '2026-11-24'
    })
  })

  test('crosses a year', () => {
    expect(monthsWindow(new Date('2027-01-05T00:00:00Z'), 3)).toEqual({
      from: '2026-11-01',
      to: '2027-01-06'
    })
  })
})

describe('#overviewOf', () => {
  test('gives a figure for every month in the window, oldest first, empty ones included', () => {
    const result = overview([row('2026-11-02', 'gpt-4o', 1, 1_000_000, 0)])

    expect(result.months.map((month) => month.key)).toEqual([
      '2026-09',
      '2026-10',
      '2026-11'
    ])
    expect(result.months[0]).toMatchObject({ requests: 0, tokens: 0, cost: 0 })
    expect(result.months[2]).toMatchObject({
      requests: 1,
      tokens: 1_000_000,
      cost: 2
    })
  })

  test('puts this month in its own totals and leaves earlier months out of them', () => {
    const result = overview([
      row('2026-10-15', 'gpt-4o', 9, 9_000_000, 0),
      row('2026-11-02', 'gpt-4o', 1, 500_000, 500_000)
    ])

    expect(result.current.totals).toMatchObject({
      requests: 1,
      promptTokens: 500_000,
      completionTokens: 500_000,
      tokens: 1_000_000,
      cost: 5
    })
  })

  test('forecasts the month at the rate so far, over the days that have passed', () => {
    const result = overview([row('2026-11-02', 'gpt-4o', 1, 1_000_000, 0)])

    expect(result.month).toMatchObject({
      key: '2026-11',
      daysElapsed: 23,
      daysInMonth: 30
    })
    expect(result.current.forecast.tokens).toBeCloseTo((1_000_000 * 30) / 23)
    expect(result.current.forecast.cost).toBeCloseTo((2 * 30) / 23)
  })

  test('shares tokens and cost by environment and by model, and tokens by day', () => {
    const result = overview([row('2026-11-02', 'gpt-4o', 1, 1_000_000, 0)], {
      extra: { qa: [row('2026-11-02', 'gpt-4o', 1, 3_000_000, 0)] }
    })

    expect(
      result.current.byEnvironment.map((e) => [
        e.environment,
        e.tokens,
        e.share
      ])
    ).toEqual([
      ['qa', 3_000_000, 0.75],
      ['infradev', 1_000_000, 0.25]
    ])
    expect(result.current.byModel).toEqual([
      expect.objectContaining({
        modelSlug: 'gpt-4o',
        tokens: 4_000_000,
        share: 1,
        price: PRICES['gpt-4o']
      })
    ])
    expect(result.current.byDay.find((d) => d.day === '2026-11-02')).toEqual({
      day: '2026-11-02',
      tokens: 4_000_000,
      byEnvironment: { infradev: 1_000_000, qa: 3_000_000 }
    })
    expect(result.current.byDay).toHaveLength(23)
  })

  test('works out cost and carbon for a million tokens', () => {
    const result = overview([row('2026-11-02', 'gpt-4o', 1, 2_000_000, 0)])

    expect(result.current.totals.costPerMillionTokens).toBeCloseTo(2)
    expect(result.current.totals.carbonGramsPerMillionTokens).toBeCloseTo(100)
  })

  test('has no cost, not zero, when a model has no price, and names it', () => {
    const result = overview([
      row('2026-11-02', 'gpt-4o', 1, 1_000_000, 0),
      row('2026-11-02', 'mystery', 1, 1000, 0)
    ])

    expect(result.current.totals.cost).toBeNull()
    expect(result.current.forecast.cost).toBeNull()
    expect(result.months[2].cost).toBeNull()
    expect(result.unpricedModels).toEqual(['mystery'])
  })

  test('has carbon only where the flag is on and every model has a factor', () => {
    const rows = [row('2026-11-02', 'gpt-4o', 1, 1_000_000, 0)]

    expect(overview(rows).current.totals.carbonKg).toBeCloseTo(0.1)
    expect(overview(rows).current.totals.electricityKwh).toBeCloseTo(
      0.0005 * 1000
    )
    expect(
      overview(rows, { carbon: { enabled: false, factors: FACTORS } }).current
        .totals.carbonKg
    ).toBeNull()
    expect(
      overview([...rows, row('2026-11-02', 'mystery', 1, 1000, 0)]).current
        .totals.carbonKg
    ).toBeNull()
    expect(
      overview(rows, { carbon: { enabled: false, factors: FACTORS } })
        .carbonBasis.enabled
    ).toBe(false)
  })

  test('says which environments had no usage source, and ignores rows outside the window', () => {
    const result = overview([row('2026-01-01', 'gpt-4o', 5, 5, 5)], {
      unavailable: ['qa']
    })

    expect(result.unavailable).toEqual(['qa'])
    expect(result.current.totals.requests).toBe(0)
    expect(result.months.every((m) => m.requests === 0)).toBe(true)
  })

  test('turns refused calls in the last 7 days into attention items, busiest first', () => {
    const result = overview([], {
      refusals: [
        {
          environment: 'qa',
          days: [
            { day: '2026-11-20', refused: 30 },
            { day: '2026-11-22', refused: 7 }
          ]
        },
        { environment: 'infradev', days: [{ day: '2026-11-22', refused: 5 }] },
        { environment: 'prod', days: [] }
      ]
    })

    expect(result.attention).toEqual([
      { kind: 'calls-refused', environment: 'qa', count: 37, days: 7 },
      { kind: 'calls-refused', environment: 'infradev', count: 5, days: 7 }
    ])
  })

  test('has no budget yet', () => {
    expect(overview([]).budget).toBeNull()
  })
})

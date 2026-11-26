import { usagePeriod, summariseUsage } from '#/services/usage-summary.js'

const PRICES = {
  'gpt-4o': { inputPerMillion: 2, outputPerMillion: 8 }
}

describe('#usagePeriod', () => {
  const now = new Date('2026-11-26T15:30:00Z')

  test('ends tomorrow so today is counted, and starts that many days back', () => {
    expect(usagePeriod(now, 7)).toEqual({
      from: '2026-11-20',
      to: '2026-11-27',
      days: 7
    })
  })

  test('crosses a month and a year', () => {
    expect(usagePeriod(new Date('2027-01-02T00:00:00Z'), 30)).toEqual({
      from: '2026-12-04',
      to: '2027-01-03',
      days: 30
    })
  })
})

describe('#summariseUsage', () => {
  const period = { from: '2026-11-01', to: '2026-11-04', days: 3 }
  const row = (day, deployment, requests, promptTokens, completionTokens) => ({
    day,
    teamSlug: 'team-a',
    deployment,
    requests,
    promptTokens,
    completionTokens
  })

  test('has every day of the period, with zero for a quiet one', () => {
    const summary = summariseUsage(
      [row('2026-11-02', 'team-a-gpt-4o', 2, 100, 50)],
      {
        period,
        teamSlug: 'team-a',
        prices: PRICES
      }
    )

    expect(summary.byDay).toEqual([
      {
        day: '2026-11-01',
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0
      },
      {
        day: '2026-11-02',
        requests: 2,
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150
      },
      {
        day: '2026-11-03',
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0
      }
    ])
  })

  test('adds the same day and model across rows, and names the model without the team', () => {
    const summary = summariseUsage(
      [
        row('2026-11-02', 'team-a-gpt-4o', 1, 100, 10),
        row('2026-11-02', 'team-a-gpt-4o', 2, 200, 20),
        row('2026-11-03', 'team-a-gpt-4o', 1, 50, 5)
      ],
      { period, teamSlug: 'team-a', prices: PRICES }
    )

    expect(summary.byModel).toEqual([
      {
        modelSlug: 'gpt-4o',
        requests: 4,
        promptTokens: 350,
        completionTokens: 35,
        totalTokens: 385,
        estimatedCost: (350 / 1e6) * 2 + (35 / 1e6) * 8
      }
    ])
    expect(summary.totals).toMatchObject({
      requests: 4,
      promptTokens: 350,
      completionTokens: 35,
      totalTokens: 385
    })
  })

  test('gives a model with no price no cost, and says the total is incomplete', () => {
    const summary = summariseUsage(
      [
        row('2026-11-02', 'team-a-gpt-4o', 1, 1_000_000, 0),
        row('2026-11-02', 'team-a-mystery', 1, 1000, 0)
      ],
      { period, teamSlug: 'team-a', prices: PRICES }
    )

    expect(
      summary.byModel.find((m) => m.modelSlug === 'mystery').estimatedCost
    ).toBeNull()
    expect(summary.totals.estimatedCost).toBe(2)
    expect(summary.unpricedModels).toEqual(['mystery'])
  })

  test('has no cost at all when nothing is priced, rather than zero', () => {
    const summary = summariseUsage(
      [row('2026-11-02', 'team-a-mystery', 1, 10, 1)],
      {
        period,
        teamSlug: 'team-a',
        prices: PRICES
      }
    )

    expect(summary.totals.estimatedCost).toBeNull()
  })

  test('is all zeros and no models for a team that has made no calls', () => {
    const summary = summariseUsage([], {
      period,
      teamSlug: 'team-a',
      prices: PRICES
    })

    expect(summary.totals).toMatchObject({
      requests: 0,
      totalTokens: 0,
      estimatedCost: 0
    })
    expect(summary.byModel).toEqual([])
    expect(summary.unpricedModels).toEqual([])
    expect(summary.byDay).toHaveLength(3)
  })

  test('keeps a deployment that does not carry the team prefix whole', () => {
    const summary = summariseUsage(
      [row('2026-11-02', 'shared-model', 1, 10, 1)],
      {
        period,
        teamSlug: 'team-a',
        prices: PRICES
      }
    )

    expect(summary.byModel[0].modelSlug).toBe('shared-model')
  })

  test('orders models by tokens, largest first', () => {
    const summary = summariseUsage(
      [
        row('2026-11-02', 'team-a-small', 1, 10, 1),
        row('2026-11-02', 'team-a-gpt-4o', 1, 900, 100)
      ],
      { period, teamSlug: 'team-a', prices: PRICES }
    )

    expect(summary.byModel.map((m) => m.modelSlug)).toEqual(['gpt-4o', 'small'])
  })

  test('ignores a row outside the period rather than invent a day', () => {
    const summary = summariseUsage(
      [row('2026-10-01', 'team-a-gpt-4o', 9, 9, 9)],
      {
        period,
        teamSlug: 'team-a',
        prices: PRICES
      }
    )

    expect(summary.totals.requests).toBe(0)
  })
})

import {
  LIMIT_BOUNDS_UNAVAILABLE,
  REQUESTS_PER_CAPACITY_UNIT,
  TOKENS_PER_CAPACITY_UNIT,
  limitBoundsOf,
  withinBounds
} from '#/services/team-limit-bounds.js'

function model(slug, { max, perEnvironment, requests, sku } = {}) {
  return {
    slug,
    tiers: ['team'],
    regions: ['uksouth'],
    skus: [{ name: 'DataZoneStandard', tiers: ['team'], capacity: sku }],
    capacityPolicy: {
      max,
      ...(perEnvironment ? { environments: perEnvironment } : {})
    },
    limitsDefault:
      requests === undefined ? undefined : { requestsPerMinute: requests }
  }
}

describe('limitBoundsOf', () => {
  test('counts 1,000 tokens and 6 requests a minute to a capacity unit, as the platform sells quota', () => {
    expect(TOKENS_PER_CAPACITY_UNIT).toBe(1000)
    expect(REQUESTS_PER_CAPACITY_UNIT).toBe(6)
  })

  test('takes the tokens from the environment’s capacity maximum, for gpt-4o in Infradev', () => {
    const bounds = limitBoundsOf(
      [
        model('gpt-4o', {
          max: 100,
          perEnvironment: { infradev: { min: 1, max: 5, default: 1 } },
          requests: 60
        })
      ],
      'infradev'
    )

    expect(bounds).toEqual({
      tokensPerMinute: { min: 1, max: 5000 },
      requestsPerMinute: { min: 1, max: 60 }
    })
  })

  test('falls back to the model’s own maximum outside a named environment', () => {
    const bounds = limitBoundsOf(
      [model('a', { max: 50, requests: 60 })],
      'sandbox'
    )

    expect(bounds.tokensPerMinute.max).toBe(50000)
  })

  test('adds the capacity of every model the team holds in the environment', () => {
    const bounds = limitBoundsOf(
      [
        model('a', { max: 5, requests: 60 }),
        model('b', { max: 10, requests: 90 })
      ],
      'infradev'
    )

    expect(bounds.tokensPerMinute.max).toBe(15000)
    // 6 a minute per 1,000 tokens is 90; the catalogue defaults add up to 150.
    expect(bounds.requestsPerMinute.max).toBe(150)
  })

  test('takes the larger of the catalogue defaults and 6 requests per 1,000 tokens', () => {
    const bounds = limitBoundsOf(
      [model('a', { max: 50, requests: 60 })],
      'sandbox'
    )

    // 50 capacity units are 300 requests a minute, more than the default 60.
    expect(bounds.requestsPerMinute.max).toBe(300)
  })

  test('treats a model that states no default requests as asking for none', () => {
    const bounds = limitBoundsOf([model('a', { max: 2 })], 'sandbox')

    expect(bounds.requestsPerMinute.max).toBe(12)
  })

  test('uses the team SKU capacity, then 1, when the catalogue states no maximum', () => {
    expect(
      limitBoundsOf([model('a', { sku: 8, requests: 0 })], 'sandbox')
        .tokensPerMinute.max
    ).toBe(8000)
    expect(
      limitBoundsOf([model('a', { requests: 0 })], 'sandbox').tokensPerMinute
        .max
    ).toBe(1000)
  })

  test('skips a model the catalogue no longer holds', () => {
    const bounds = limitBoundsOf(
      [null, model('a', { max: 3, requests: 0 })],
      'sandbox'
    )

    expect(bounds.tokensPerMinute.max).toBe(3000)
  })

  test.each([[[]], [[null]]])(
    'is %j when no model of the team is in the catalogue: nothing to bound',
    (models) => {
      expect(limitBoundsOf(models, 'infradev')).toBe(LIMIT_BOUNDS_UNAVAILABLE)
      expect(LIMIT_BOUNDS_UNAVAILABLE).toBeNull()
    }
  )
})

describe('withinBounds', () => {
  const bounds = {
    tokensPerMinute: { min: 1, max: 5000 },
    requestsPerMinute: { min: 1, max: 60 }
  }

  test.each([
    [{ tokensPerMinute: 1, requestsPerMinute: 1 }, true],
    [{ tokensPerMinute: 5000, requestsPerMinute: 60 }, true],
    [{ tokensPerMinute: 5001, requestsPerMinute: 60 }, false],
    [{ tokensPerMinute: 5000, requestsPerMinute: 61 }, false],
    [{ tokensPerMinute: 0, requestsPerMinute: 60 }, false],
    [{ tokensPerMinute: 1000, requestsPerMinute: 0 }, false],
    [{ tokensPerMinute: -1, requestsPerMinute: 10 }, false]
  ])('limits %j within bounds: %s', (limits, expected) => {
    expect(withinBounds(bounds, limits)).toBe(expected)
  })
})

import {
  ITEM_KINDS,
  isFederationItem,
  isLimitsItem,
  isModelItem,
  itemKindOf,
  requestedLimitsOf
} from '#/operations/operation-items.js'

const LIMITS = { tokensPerMinute: 2000, requestsPerMinute: 30 }

describe('operation items', () => {
  test('an item with no kind is a model item, so nothing needs backfilling', () => {
    const item = { entryId: 'e1', modelSlug: 'gpt-4o', change: 'add' }

    expect(itemKindOf(item)).toBe(ITEM_KINDS.MODEL)
    expect(isModelItem(item)).toBe(true)
    expect(isLimitsItem(item)).toBe(false)
  })

  test('a limits item is a limits item and not a model item', () => {
    const item = { kind: 'limits', change: 'set', limits: LIMITS }

    expect(itemKindOf(item)).toBe('limits')
    expect(isLimitsItem(item)).toBe(true)
    expect(isModelItem(item)).toBe(false)
  })

  test('a federation item is a federation item and neither a model nor a limits item', () => {
    const item = {
      kind: 'federation',
      entryId: 'f1',
      change: 'add',
      federation: { host: 'cdp', name: 'beta-api', service: 'beta-api' }
    }

    expect(itemKindOf(item)).toBe('federation')
    expect(isFederationItem(item)).toBe(true)
    expect(isModelItem(item)).toBe(false)
    expect(isLimitsItem(item)).toBe(false)
    expect(isFederationItem({ entryId: 'e1', change: 'add' })).toBe(false)
  })

  test('the limits asked for are the last limits item, and none when no item asks', () => {
    const later = { tokensPerMinute: 4000, requestsPerMinute: 60 }

    expect(
      requestedLimitsOf([
        { kind: 'limits', change: 'set', limits: LIMITS },
        { entryId: 'e1', modelSlug: 'gpt-4o', change: 'add' },
        { kind: 'limits', change: 'set', limits: later }
      ])
    ).toEqual(later)
    expect(
      requestedLimitsOf([{ entryId: 'e1', modelSlug: 'gpt-4o', change: 'add' }])
    ).toBeUndefined()
    expect(requestedLimitsOf([])).toBeUndefined()
  })
})

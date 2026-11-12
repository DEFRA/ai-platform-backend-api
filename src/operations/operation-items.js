// The kinds of change an operation's `items` carry. A model item is what every
// operation held before a team's limits could change, so an item with no
// `kind` is a model item: nothing is backfilled.

export const ITEM_KINDS = Object.freeze({
  MODEL: 'model',
  LIMITS: 'limits'
})

/**
 * The kind of change an item is.
 * @param {{kind?: string}} item
 * @returns {string}
 */
export function itemKindOf(item) {
  return item.kind ?? ITEM_KINDS.MODEL
}

/**
 * @param {{kind?: string}} item
 * @returns {boolean}
 */
export function isModelItem(item) {
  return itemKindOf(item) === ITEM_KINDS.MODEL
}

/**
 * @param {{kind?: string}} item
 * @returns {boolean}
 */
export function isLimitsItem(item) {
  return itemKindOf(item) === ITEM_KINDS.LIMITS
}

/**
 * The limits a list of items asks for: the last limits item's, as a later
 * request replaces an earlier one that is still waiting. Undefined when no
 * item changes the limits.
 * @param {Array<{kind?: string, limits?: {tokensPerMinute: number, requestsPerMinute: number}}>} items
 * @returns {{tokensPerMinute: number, requestsPerMinute: number}|undefined}
 */
export function requestedLimitsOf(items) {
  return items.findLast(isLimitsItem)?.limits
}

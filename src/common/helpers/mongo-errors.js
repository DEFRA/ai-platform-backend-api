// MongoDB's error code for a write that violates a unique index.
const DUPLICATE_KEY_ERROR = 11000

/**
 * Whether a MongoDB write failed because a unique index was already taken.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isDuplicateKeyError(error) {
  return error?.code === DUPLICATE_KEY_ERROR
}

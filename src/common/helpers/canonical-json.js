/**
 * Compares two strings by UTF-16 code unit, the order `sort()` uses by
 * default and the workflows' canonical serialiser relies on. Never
 * `localeCompare`: locale order would change the canonical bytes.
 * @param {string} a
 * @param {string} b
 * @returns {number} Negative, zero or positive, as `sort()` expects.
 */
export function compareCodeUnits(a, b) {
  const sharedLength = Math.min(a.length, b.length)

  for (let index = 0; index < sharedLength; index += 1) {
    const difference = a.charCodeAt(index) - b.charCodeAt(index)

    if (difference !== 0) {
      return difference
    }
  }

  return a.length - b.length
}

/**
 * Sorts object keys recursively so equal documents serialise to equal bytes.
 * @param {unknown} value - Any JSON value.
 * @returns {unknown} The same value with every object's keys sorted.
 */
export function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys)
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareCodeUnits)
        .map((key) => [key, sortKeys(value[key])])
    )
  }

  return value
}

/**
 * The GitOps contract's canonical serialisation for every machine-written
 * file: keys sorted at every level, two-space indent, LF line endings and one
 * trailing newline. Must stay byte-identical to `ai-platform-infra`'s
 * `checks/src/canonical-json.js`, which the submit workflow uses.
 * @param {unknown} value - The document to serialise.
 * @returns {string} The canonical JSON text.
 */
export function canonicalJson(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`
}

/**
 * Whether a file's text is already in canonical form.
 * @param {string} text - The file contents.
 * @returns {boolean} True when re-serialising changes nothing.
 */
export function isCanonical(text) {
  try {
    return canonicalJson(JSON.parse(text)) === text
  } catch {
    return false
  }
}

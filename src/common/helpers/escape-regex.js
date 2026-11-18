/**
 * Escapes the characters that mean something in a regular expression, so text
 * a person typed can be matched literally in a MongoDB `$regex`.
 * @param {string} text
 * @returns {string}
 */
export function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

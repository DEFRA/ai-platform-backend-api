// A credential's hint is the last characters of its secret - enough to tell
// two keys apart without ever storing or showing the whole thing.
const KEY_HINT_LENGTH = 4

/**
 * The hint shown for a secret everywhere but at creation and rotation.
 * @param {string} secret
 * @returns {string} The last four characters of the secret.
 */
export function keyHintFor(secret) {
  return secret.slice(-KEY_HINT_LENGTH)
}

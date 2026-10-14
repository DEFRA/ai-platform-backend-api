import { config } from '#/config.js'
import { mockServiceCodeVerifier } from '#/adapters/mock-service-code-verifier.js'

/**
 * Picks the `ServiceCodeVerifier` for a mode. Only `mock` exists while the
 * authoritative source is unagreed; a real adapter is registered here and
 * selected with `SERVICE_CODE_VERIFIER` once there is one to call, and the
 * prod guard every other port has belongs here then too.
 * @param {Record<string, import('#/adapters/service-code-verifier.js').ServiceCodeVerifier>} verifiersByMode
 * @param {string} mode
 * @returns {import('#/adapters/service-code-verifier.js').ServiceCodeVerifier}
 */
export function selectServiceCodeVerifier(verifiersByMode, mode) {
  const verifier = verifiersByMode[mode]

  if (!verifier) {
    throw new Error(`No service code verifier registered for "${mode}"`)
  }

  return verifier
}

/**
 * The verifier team service codes are checked against.
 * @type {import('#/adapters/service-code-verifier.js').ServiceCodeVerifier}
 */
export const serviceCodeVerifier = selectServiceCodeVerifier(
  { mock: mockServiceCodeVerifier },
  config.get('serviceCode.verifier')
)

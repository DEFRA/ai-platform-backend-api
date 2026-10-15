import { config } from '#/config.js'

/**
 * Verifies a service code against the codes this environment has been told
 * about (`SERVICE_CODE_KNOWN_CODES`), which is empty until CDP or the Cloud
 * Centre of Excellence publishes a list - so by default no code verifies and
 * every team carries "to be verified".
 * @type {import('#/adapters/service-code-verifier.js').ServiceCodeVerifier}
 */
export const mockServiceCodeVerifier = {
  async verify(serviceCode) {
    const known = config
      .get('serviceCode.knownCodes')
      .map((code) => code.trim().toUpperCase())

    return known.includes(serviceCode)
      ? { verified: true, source: 'known-codes' }
      : { verified: false, source: null }
  }
}

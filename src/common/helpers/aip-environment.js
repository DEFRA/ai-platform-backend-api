import { config } from '#/config.js'

/**
 * @typedef {object} AipEnvironment
 * @property {string} subscriptionId
 * @property {string} resourceGroup
 * @property {string} apimName
 * @property {string[]} foundryAccounts
 * @property {string} tenantsVault
 */

/**
 * Looks an environment up in `AIP_ENVIRONMENTS`, failing closed when it is
 * missing so a credential is never issued against a guessed resource.
 * @param {string|null|undefined} name
 * @param {Record<string, AipEnvironment>} [environments]
 * @returns {AipEnvironment}
 */
export function resolveAipEnvironment(
  name,
  environments = config.get('aipEnvironments')
) {
  const environment =
    name && Object.hasOwn(environments, name) ? environments[name] : undefined

  if (!environment) {
    const error = new Error(
      `Environment "${name}" is not configured in AIP_ENVIRONMENTS`
    )
    error.code = 'environment-not-configured'
    throw error
  }

  return environment
}

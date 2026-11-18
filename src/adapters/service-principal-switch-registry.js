import { config } from '#/config.js'
import { mockServicePrincipalSwitch } from '#/adapters/mock-service-principal-switch.js'

export const MOCK_SERVICE_PRINCIPAL_SWITCH = 'mock'

/**
 * Picks the `ServicePrincipalSwitch` for a mode. Refuses the mock in the prod
 * environment, where a Platform Admin's block would be recorded but Entra
 * would still issue tokens. Only `mock` is registered until Entra admin
 * consent lets the Graph adapter arrive (R-D2).
 * @param {Record<string, import('#/adapters/service-principal-switch.js').ServicePrincipalSwitch>} switchesByMode
 * @param {string} mode
 * @param {string} cdpEnvironment
 * @returns {import('#/adapters/service-principal-switch.js').ServicePrincipalSwitch}
 */
export function selectServicePrincipalSwitch(
  switchesByMode,
  mode,
  cdpEnvironment
) {
  if (cdpEnvironment === 'prod' && mode === MOCK_SERVICE_PRINCIPAL_SWITCH) {
    throw new Error(
      'SERVICE_PRINCIPAL_SWITCH must not be "mock" in the prod environment'
    )
  }

  const selected = switchesByMode[mode]

  if (!selected) {
    throw new Error(`No service principal switch for mode "${mode}"`)
  }

  return selected
}

/**
 * The live switch, built from config at startup.
 * @type {import('#/adapters/service-principal-switch.js').ServicePrincipalSwitch}
 */
export const servicePrincipalSwitch = selectServicePrincipalSwitch(
  { [MOCK_SERVICE_PRINCIPAL_SWITCH]: mockServicePrincipalSwitch },
  config.get('servicePrincipalSwitch'),
  config.get('cdpEnvironment')
)

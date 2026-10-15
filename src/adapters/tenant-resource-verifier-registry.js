import { config } from '#/config.js'
import { mockTenantResourceVerifier } from '#/adapters/mock-tenant-resource-verifier.js'
import { createArmTenantResourceVerifier } from '#/adapters/azure/arm-tenant-resource-verifier.js'

/**
 * Picks the `TenantResourceVerifier` for a provisioning mode, the same switch
 * the credential issuer and vault use: `mock` never calls Azure, `live`
 * reads ARM.
 * @param {Record<'mock'|'live', import('#/adapters/tenant-resource-verifier.js').TenantResourceVerifier>} verifiersByMode
 * @param {'mock'|'live'} mode
 * @returns {import('#/adapters/tenant-resource-verifier.js').TenantResourceVerifier}
 */
export function selectTenantResourceVerifier(verifiersByMode, mode) {
  const verifier = verifiersByMode[mode]

  if (!verifier) {
    throw new Error(
      `No tenant resource verifier for provisioning mode "${mode}"`
    )
  }

  return verifier
}

/**
 * The live verifier, chosen from `PROVISIONING_MODE` at startup. The ARM
 * client is built lazily, so this is safe with ARM config unset in mock mode.
 * @type {import('#/adapters/tenant-resource-verifier.js').TenantResourceVerifier}
 */
export const tenantResourceVerifier = selectTenantResourceVerifier(
  {
    mock: mockTenantResourceVerifier,
    live: createArmTenantResourceVerifier()
  },
  config.get('provisioning.mode')
)

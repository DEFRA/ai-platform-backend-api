import { ClientSecretCredential } from '@azure/identity'

import { config } from '#/config.js'

let cachedCredential = null

/**
 * Lazily builds the single `ClientSecretCredential` for backend-to-Azure-ARM
 * calls (`armAuth.*` - a separate app registration from SSO's `azureAd.*` in
 * the frontend). Construction is deferred to first use so importing this
 * module is safe even when `PROVISIONING_MODE` is "mock" and `armAuth.*` is
 * unset. Isolated here, rather than inlined in `arm-client.js`, so swapping
 * to a certificate or managed identity later is a one-line change; Phase 3's
 * Key Vault adapter imports this same module since the credential is shared
 * across both Azure planes.
 * @returns {import('@azure/identity').ClientSecretCredential}
 */
export function getArmCredential() {
  if (!cachedCredential) {
    cachedCredential = new ClientSecretCredential(
      config.get('armAuth.tenantId'),
      config.get('armAuth.clientId'),
      config.get('armAuth.clientSecret')
    )
  }

  return cachedCredential
}

import {
  ClientAssertionCredential,
  ClientSecretCredential
} from '@azure/identity'
import { WebIdentityTokenProvider } from '@defra/hapi-auth-oidc'

import { config } from '#/config.js'
import { createLogger } from '#/common/helpers/logging/logger.js'

let cachedCredential = null

/**
 * Lazily builds the single credential for backend-to-Azure-ARM calls
 * (`armAuth.*` - a separate app registration from SSO's `azureAd.*` in the
 * frontend). Construction is deferred to first use so importing this module
 * is safe even when `PROVISIONING_MODE` is "mock" and `armAuth.*` is unset.
 * Isolated here, rather than inlined in `arm-client.js`, so swapping the
 * credential type is a one-line change; Phase 3's Key Vault adapter imports
 * this same module since the credential is shared across both Azure planes.
 *
 * `armAuth.authMethod` picks the credential type: "federated" exchanges a
 * short-lived AWS STS web identity token for an Entra token (every deployed
 * CDP environment - no client secret involved), "client-secret" is the local
 * dev fallback, since local has no AWS STS to federate from.
 * @param {Object} [deps]
 * @param {{ getCredentials: (logger: object) => Promise<string> }} [deps.tokenProvider] - injectable for tests, defaults to `WebIdentityTokenProvider`
 * @returns {import('@azure/identity').TokenCredential}
 */
export function getArmCredential({ tokenProvider } = {}) {
  if (!cachedCredential) {
    const authMethod = config.get('armAuth.authMethod')
    createLogger().info(
      { armAuth: { authMethod } },
      `Building ARM credential using "${authMethod}" auth`
    )

    if (authMethod === 'federated') {
      const provider =
        tokenProvider ??
        new WebIdentityTokenProvider({
          audience: config.get('armAuth.federatedAudience')
        })

      cachedCredential = new ClientAssertionCredential(
        config.get('armAuth.tenantId'),
        config.get('armAuth.clientId'),
        () => provider.getCredentials(createLogger())
      )
    } else {
      cachedCredential = new ClientSecretCredential(
        config.get('armAuth.tenantId'),
        config.get('armAuth.clientId'),
        config.get('armAuth.clientSecret')
      )
    }
  }

  return cachedCredential
}

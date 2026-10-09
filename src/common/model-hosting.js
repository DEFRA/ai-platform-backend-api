import { DEFAULT_GATEWAY } from '#/adapters/gateway-keys.js'

const LEGACY_HOSTING = Object.freeze({
  platform: 'foundry',
  cloud: 'azure',
  provider: null
})

/**
 * The gateway credentials for a model are issued through.
 * @param {{gateway?: string}} [model]
 * @returns {string}
 */
export function gatewayOf(model) {
  return model?.gateway ?? DEFAULT_GATEWAY
}

/**
 * Where a model is hosted. A model not yet backfilled is Azure/Foundry.
 * @param {{hosting?: {platform: string, cloud: string|null, provider: string|null}}} [model]
 * @returns {{platform: string, cloud: string|null, provider: string|null}}
 */
export function hostingOf(model) {
  return model?.hosting ?? LEGACY_HOSTING
}

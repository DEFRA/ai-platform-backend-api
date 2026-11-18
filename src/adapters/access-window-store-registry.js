import { config } from '#/config.js'
import { mockAccessWindowStore } from '#/adapters/mock-access-window-store.js'
import { createApimAccessWindowStore } from '#/adapters/azure/apim-access-window-store.js'

export const MOCK_ACCESS_WINDOW_STORE = 'mock'
export const APIM_ACCESS_WINDOW_STORE = 'apim'

/**
 * Picks the `AccessWindowStore` for an access window mode. Refuses the mock in
 * the prod environment, where a Platform Admin's block would be recorded but
 * never reach the gateway.
 * @param {Record<string, import('#/adapters/access-window-store.js').AccessWindowStore>} storesByMode
 * @param {string} mode - `mock` or `apim`
 * @param {string} cdpEnvironment
 * @returns {import('#/adapters/access-window-store.js').AccessWindowStore}
 */
export function selectAccessWindowStore(storesByMode, mode, cdpEnvironment) {
  if (cdpEnvironment === 'prod' && mode === MOCK_ACCESS_WINDOW_STORE) {
    throw new Error(
      'ACCESS_WINDOW_STORE must not be "mock" in the prod environment'
    )
  }

  const selected = storesByMode[mode]

  if (!selected) {
    throw new Error(`No access window store for mode "${mode}"`)
  }

  return selected
}

/**
 * The live store, built from config at startup. The APIM store reaches Azure
 * only when called, so it is safe to construct in mock mode.
 * @type {import('#/adapters/access-window-store.js').AccessWindowStore}
 */
export const accessWindowStore = selectAccessWindowStore(
  {
    [MOCK_ACCESS_WINDOW_STORE]: mockAccessWindowStore,
    [APIM_ACCESS_WINDOW_STORE]: createApimAccessWindowStore()
  },
  config.get('accessWindowStore'),
  config.get('cdpEnvironment')
)

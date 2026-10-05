/**
 * Port for reading the model catalogue - which models exist, their tiers,
 * lifecycle and policy fields - from wherever it's authored. Services depend
 * on this shape only, so the `github` adapter (reading `ai-platform-infra`
 * at a pinned release) can be swapped for the `file` adapter used in local
 * dev and tests with no service changes.
 * @typedef {object} CatalogueSource
 * @property {(params?: {ref?: string}) => Promise<{models: object[], providers: object[], catalogueSha: string, release: string}>} fetchCatalogue
 */

export {}

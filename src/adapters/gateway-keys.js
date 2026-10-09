// Catalogue gateway ids - how a model's credentials are issued and stored.
// Dependency-free so `config.js` can import it without a cycle.
export const AZURE_APIM = 'azure-apim'

// What a model/credential from before the catalogue carried a gateway used.
export const DEFAULT_GATEWAY = AZURE_APIM

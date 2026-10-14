import Joi from 'joi'

const environmentSchema = Joi.object({
  subscriptionId: Joi.string()
    .pattern(/^[0-9a-fA-F-]{36}$/)
    .required(),
  resourceGroup: Joi.string().required(),
  apimName: Joi.string().required(),
  foundryAccounts: Joi.array().items(Joi.string()).min(1).required(),
  tenantsVault: Joi.string().required()
}).unknown(false)

const environmentsSchema = Joi.object().pattern(
  Joi.string().pattern(/^[a-z][a-z0-9-]*$/),
  environmentSchema
)

/**
 * Convict format for `AIP_ENVIRONMENTS`: a JSON object keyed by environment
 * name, giving each environment's Azure subscription, resource group, APIM
 * instance, Foundry accounts and tenants Key Vault.
 */
export const convictValidateAipEnvironments = {
  name: 'aip-environments',
  validate: function validateAipEnvironments(value) {
    Joi.assert(value, environmentsSchema)
  },
  coerce: function parseAipEnvironments(value) {
    return JSON.parse(value)
  }
}

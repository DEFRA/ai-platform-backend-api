import Joi from 'joi'

/**
 * An Entra object or tenant ID, stored lowercase so `entra:{oid}` always
 * matches the GitOps contract's principal pattern.
 */
export const entraIdField = Joi.string()
  .lowercase()
  .pattern(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    'GUID'
  )

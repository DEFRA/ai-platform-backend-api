import Joi from 'joi'

/**
 * An environment name as the environment registry and the team file schema
 * spell it: a letter, then letters and digits, 2 to 16 characters. Which
 * names this portal instance offers is configuration, never part of this
 * shape. Joi schemas are immutable, so a route adds `.required()` or
 * `.optional()` to it.
 */
export const environmentName = Joi.string().pattern(/^[a-z][a-z0-9]{1,15}$/)

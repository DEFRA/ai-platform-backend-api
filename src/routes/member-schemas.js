import Joi from 'joi'

import { entraIdField } from '#/common/helpers/entra-id.js'

// What an Admin types to find a person in the directory.
const MIN_SEARCH_LENGTH = 2
const MAX_SEARCH_LENGTH = 100

/** The roles a member can hold, always stated on an add. */
export const memberRoleField = Joi.string().valid('admin', 'user')

/** `Idempotency-Key`, a version 4 UUID; other transport headers are allowed. */
export const idempotentHeaders = Joi.object({
  'idempotency-key': Joi.string().guid({ version: 'uuidv4' }).required()
}).unknown(true)

/** The body of a directory search a team's members can be added from. */
export const personSearchPayload = Joi.object({
  search: Joi.string()
    .trim()
    .min(MIN_SEARCH_LENGTH)
    .max(MAX_SEARCH_LENGTH)
    .required()
}).unknown(false)

/** The body of an add: the person by Entra object ID, and their role. */
export const addMemberPayload = Joi.object({
  oid: entraIdField.required(),
  role: memberRoleField.required()
}).unknown(false)

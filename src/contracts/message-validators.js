import { readFileSync } from 'node:fs'

import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

// Validates the vendored `aip.gitops.command/1` and `aip.gitops.event/1`
// schemas (JSON Schema 2020-12, `additionalProperties: false`). The schemas
// use `format: date-time`, hence `ajv-formats`.

function loadSchema(file) {
  return JSON.parse(
    readFileSync(new URL(`./aip-gitops/${file}`, import.meta.url), 'utf8')
  )
}

// `strictRequired` is off because the schemas' conditional branches require
// properties that the enclosing object defines.
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: false
})

addFormats(ajv)

const validateCommandSchema = ajv.compile(loadSchema('command.schema.json'))
const validateEventSchema = ajv.compile(loadSchema('event.schema.json'))

// The errors as short paths and messages only: never the data, which can
// hold a whole desired-state document.
function summarise(errors) {
  return (errors ?? []).map(
    ({ instancePath, message }) => `${instancePath || '/'} ${message}`
  )
}

/**
 * Checks a command against `aip.gitops.command/1`.
 * @param {unknown} command
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateCommand(command) {
  const valid = validateCommandSchema(command)

  return { valid, errors: valid ? [] : summarise(validateCommandSchema.errors) }
}

/**
 * Checks an event against `aip.gitops.event/1`.
 * @param {unknown} event
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateEvent(event) {
  const valid = validateEventSchema(event)

  return { valid, errors: valid ? [] : summarise(validateEventSchema.errors) }
}

import { TEAM_SLUG_PATTERN } from '#/common/helpers/team-slug.js'

export const NO_ENTRIES = 'none'
export const UNTIL_REVOKED = 'untilRevoked'
export const ACCESS_STATUSES = ['active', 'suspended']

// A named value holds 4,096 characters; 40 entries of at most 97 fit (design E, "Gateway data").
export const MAX_ENTRIES = 40
export const MAX_VALUE_LENGTH = 4096

const ENTRY_SEPARATOR = ';'
const FIELD_SEPARATOR = '|'
const FIELD_COUNT = 4
const GUID_PATTERN = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const UTC_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
const SECONDS_PRECISION = 19

/**
 * One client's access window as the gateway's `aip-team-grant` fragment reads it.
 * @typedef {object} AccessWindowEntry
 * @property {string} clientId - the calling registration's client ID (a GUID)
 * @property {'active'|'suspended'} status
 * @property {string} validFrom - ISO 8601 UTC time
 * @property {string} expiresAt - ISO 8601 UTC time, or `untilRevoked`
 */

function invalidWindow(message) {
  const error = new Error(message)
  error.code = 'invalid-access-window'
  return error
}

/**
 * The only named value the Portal API writes for a team: `aip-{slug}-access`,
 * built from a valid team slug so no other name can be reached through it.
 * @param {unknown} teamSlug
 * @returns {string}
 */
export function accessWindowNamedValueName(teamSlug) {
  if (typeof teamSlug !== 'string' || !TEAM_SLUG_PATTERN.test(teamSlug)) {
    const error = new Error('An access window needs a valid team slug')
    error.code = 'invalid-team-slug'
    throw error
  }

  return `aip-${teamSlug}-access`
}

// A real calendar time: the round trip rejects 30 February and 24:00, which Date rolls over.
function isUtcTime(value) {
  if (typeof value !== 'string' || !UTC_TIME_PATTERN.test(value)) {
    return false
  }

  const time = new Date(value)

  return (
    !Number.isNaN(time.getTime()) &&
    time.toISOString().slice(0, SECONDS_PRECISION) ===
      value.slice(0, SECONDS_PRECISION)
  )
}

function validateEntry(entry) {
  if (!GUID_PATTERN.test(entry?.clientId)) {
    throw invalidWindow('clientId must be a GUID')
  }

  if (!ACCESS_STATUSES.includes(entry.status)) {
    throw invalidWindow('status must be active or suspended')
  }

  if (!isUtcTime(entry.validFrom)) {
    throw invalidWindow('validFrom must be an ISO 8601 UTC time')
  }

  if (entry.expiresAt !== UNTIL_REVOKED && !isUtcTime(entry.expiresAt)) {
    throw invalidWindow(
      'expiresAt must be an ISO 8601 UTC time or untilRevoked'
    )
  }

  if (
    entry.expiresAt !== UNTIL_REVOKED &&
    new Date(entry.expiresAt) <= new Date(entry.validFrom)
  ) {
    throw invalidWindow('expiresAt must be after validFrom')
  }
}

function validateEntries(entries) {
  if (!Array.isArray(entries)) {
    throw invalidWindow('An access window is a list of entries')
  }

  if (entries.length > MAX_ENTRIES) {
    throw invalidWindow(`An access window holds at most ${MAX_ENTRIES} clients`)
  }

  entries.forEach(validateEntry)

  const clients = new Set(entries.map(({ clientId }) => clientId.toLowerCase()))

  if (clients.size !== entries.length) {
    throw invalidWindow('A client appears once in an access window')
  }
}

/**
 * Writes the fixed format the gateway substitutes into its policy expression
 * (`clientId|status|validFrom|expiresAt`, entries joined by `;`, `none` when
 * empty). Refuses anything else, because a named value can hold a policy
 * expression.
 * @param {AccessWindowEntry[]} entries
 * @returns {string}
 */
export function formatAccessWindow(entries) {
  validateEntries(entries)

  if (entries.length === 0) {
    return NO_ENTRIES
  }

  return entries
    .map(({ clientId, status, validFrom, expiresAt }) =>
      [clientId, status, validFrom, expiresAt].join(FIELD_SEPARATOR)
    )
    .join(ENTRY_SEPARATOR)
}

/**
 * Reads a named value back into entries, refusing a value that is not in the
 * fixed format so a caller never rewrites what it cannot understand.
 * @param {unknown} value
 * @returns {AccessWindowEntry[]}
 */
export function parseAccessWindow(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidWindow('An access window value is text')
  }

  if (value === NO_ENTRIES) {
    return []
  }

  const entries = value.split(ENTRY_SEPARATOR).map((text) => {
    const fields = text.split(FIELD_SEPARATOR)

    if (fields.length !== FIELD_COUNT) {
      throw invalidWindow('An access window entry has four fields')
    }

    const [clientId, status, validFrom, expiresAt] = fields

    return { clientId, status, validFrom, expiresAt }
  })

  validateEntries(entries)

  return entries
}

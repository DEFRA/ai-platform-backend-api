import { config } from '#/config.js'

// The gateway's own APIs that are not a team's: the Research tier's. A team
// that took one of these as its slug would read, or be billed for, what is
// not its own.
const NON_TEAM_API_IDS = ['research']

/**
 * Whether a slug is the id of a gateway API no team owns, so a team may not
 * hold it and its usage is never read as a team's.
 * @param {string} slug
 * @returns {boolean}
 */
export function isReservedApiSlug(slug) {
  return [...NON_TEAM_API_IDS, config.get('apim.researchApiId')].includes(slug)
}

/**
 * Port for a team's access window at the gateway: the entries API Management's
 * `aip-team-grant` fragment checks on every request (design E, "Gateway data").
 * A window is read and written as a whole, so the caller changes one client's
 * entry between the two, under the block lock. The store holds only the
 * fixed format and refuses anything else; it never decides what a window
 * should say.
 * @typedef {import('#/adapters/access-window-format.js').AccessWindowEntry} AccessWindowEntry
 *
 * @typedef {object} AccessWindowStore
 * @property {(params: {environment: string, teamSlug: string}) => Promise<AccessWindowEntry[]>} read - the team's entries in the environment, empty for a window nobody has written
 * @property {(params: {environment: string, teamSlug: string, entries: AccessWindowEntry[]}) => Promise<void>} write - replaces the whole window
 */

export {}

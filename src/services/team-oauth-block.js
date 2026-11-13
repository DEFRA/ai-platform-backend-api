import { config } from '#/config.js'
import { isFederationItem } from '#/operations/operation-items.js'
import { fileEntryOf } from '#/services/team-federation-entries.js'

// The `oauth` block of a team file: the applications federated to the team's
// registration, its external clients, and whether client secrets are allowed
// there (design E, plan D6). A change to the models or the limits leaves the
// federations and the external clients as they are.

/**
 * Whether the backend allows client secrets in an environment
 * (`CLIENT_SECRET_ENVIRONMENTS`); the team file's `secretsAllowed` says so.
 * @param {string} environment
 * @returns {boolean}
 */
export function clientSecretsAllowedIn(environment) {
  return config
    .get('teamDeployment.clientSecretEnvironments')
    .includes(environment)
}

// One federation change on the file's entries, by name: an add (or a repeat
// of one) puts the entry in its place or at the end, a change replaces the
// entry it names, a removal takes it out. A change that finds nothing adds.
function withFederationApplied(held, { change, name, federation }) {
  if (change === 'remove') {
    return held.filter((existing) => existing.name !== name)
  }

  const entry = fileEntryOf(federation)

  return held.some((existing) => existing.name === name)
    ? held.map((existing) => (existing.name === name ? entry : existing))
    : [...held, entry]
}

/**
 * The file's federations after the operation's federation changes, in turn.
 * @param {Array<{name: string}>} held - the file's federations now
 * @param {object[]} items - the operation's items
 * @returns {object[]}
 */
export function federationsAfter(held, items) {
  return items
    .filter(isFederationItem)
    .reduce((entries, item) => withFederationApplied(entries, item), held)
}

/**
 * The file's `oauth` block for a build: everything the file holds (its
 * external clients and any exception) kept, the federations changed by the
 * operation's items, and `secretsAllowed` written from the backend's own
 * client-secret environments. A new file starts with no federations.
 * @param {{oauth?: object}|null|undefined} current - the file on `main`, if any
 * @param {object[]} items
 * @param {string} environment
 * @returns {object}
 */
export function oauthBlockOf(current, items, environment) {
  return {
    ...current?.oauth,
    federations: federationsAfter(current?.oauth?.federations ?? [], items),
    externalClients: current?.oauth?.externalClients ?? [],
    secretsAllowed: clientSecretsAllowedIn(environment)
  }
}

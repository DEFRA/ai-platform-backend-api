import { config } from '#/config.js'
import {
  FEDERATION_HOSTS,
  FEDERATION_STATUS,
  MAX_FEDERATIONS
} from '#/services/team-federation-constants.js'

export { FEDERATION_HOSTS, FEDERATION_STATUS, MAX_FEDERATIONS }

// A team's federated applications as the backend keeps them: one entry per
// application per environment in the team's `teamDeployments` document,
// projected from the operation that makes, changes or removes it (design E,
// plan D1). The team file stays the truth the builder writes from; these
// helpers turn what a person asked for into the file's entry and into the
// key two registrations share when they trust the same workload.

// An application takes a place in the registration from the moment it is
// asked for until it is removed; a failed or removed one holds none.
const OCCUPYING = new Set([
  FEDERATION_STATUS.SETTING_UP,
  FEDERATION_STATUS.READY,
  FEDERATION_STATUS.REMOVING
])

/**
 * Whether an application with this status holds a place in the registration.
 * @param {string} status
 * @returns {boolean}
 */
export function isOccupying(status) {
  return OCCUPYING.has(status)
}

/**
 * The Defra tenant's v2 issuer, which an Azure workload's token carries and
 * the registration trusts (the infra checks refuse any other).
 * @returns {string}
 */
export function defraIssuer() {
  return `https://login.microsoftonline.com/${config.get('portalAuth.tenantId')}/v2.0`
}

/**
 * What a person asked to federate, in the form the operation holds: a CDP
 * service is named by its service; an Azure workload by its name and the
 * principal ID of its managed identity (a GUID, kept lower case).
 * @param {{host: string, service?: string, principalId?: string, name?: string}} request
 * @returns {{host: string, name: string, service?: string, principalId?: string}}
 */
export function definitionOf({ host, service, principalId, name }) {
  return host === FEDERATION_HOSTS.CDP
    ? { host, name: service, service }
    : { host, name, principalId: principalId.toLowerCase() }
}

/**
 * The entry the team file holds for an application: a CDP one only its name,
 * host and service (Terraform derives the rest); an Azure one the Defra
 * tenant's issuer and the principal ID as subject.
 * @param {{host: string, name: string, service?: string, principalId?: string}} definition
 * @returns {object}
 */
export function fileEntryOf({ host, name, service, principalId }) {
  return host === FEDERATION_HOSTS.CDP
    ? { name, host, service }
    : { name, host, issuer: defraIssuer(), subject: principalId }
}

/**
 * What two applications share when they trust the same workload, as the infra
 * checks key it: a CDP service, or an issuer and a subject. Takes an
 * application as asked for, as the team file holds it, or as this document
 * records it.
 * @param {{host: string, service?: string, principalId?: string, issuer?: string, subject?: string}} application
 * @returns {string}
 */
export function trustKeyOf({ host, service, principalId, issuer, subject }) {
  return host === FEDERATION_HOSTS.CDP
    ? `CDP service ${service}`
    : `${issuer ?? defraIssuer()} ${subject ?? principalId}`
}

/**
 * A request's identity for an `Idempotency-Key`, so a key replayed for another
 * request is told apart.
 * @param {string} change - `add`, `change` or `remove`
 * @param {string} scope - the environment, or the application's id
 * @param {{name: string}} definition
 * @returns {string}
 */
export function federationFingerprintOf(change, scope, definition) {
  return `federation:${change}:${scope}:${trustKeyOf(definition)}:${definition.name}`
}

/**
 * The application as the API shows it.
 * @param {object} entry - one of the document's `federations[]`
 * @returns {{id: string, name: string, host: string, service?: string, principalId?: string, status: string, operationId: string|null, failureReason: string|null}}
 */
export function federationViewOf(entry) {
  return {
    id: entry.id,
    name: entry.name,
    host: entry.host,
    ...(entry.service ? { service: entry.service } : {}),
    ...(entry.principalId ? { principalId: entry.principalId } : {}),
    status: entry.status,
    operationId: entry.operationId ?? null,
    failureReason: entry.failureReason ?? null,
    ...(entry.pending && entry.status === FEDERATION_STATUS.SETTING_UP
      ? { changingTo: changingToOf(entry.pending) }
      : {})
  }
}

// What an application is being changed to, as the person asked for it.
function changingToOf({ name, service, principalId }) {
  return {
    name,
    ...(service ? { service } : {}),
    ...(principalId ? { principalId } : {})
  }
}

/**
 * The applications of an environment, not removed.
 * @param {{federations?: object[]}|null|undefined} doc
 * @returns {object[]}
 */
export function liveFederationsOf(doc) {
  return (doc?.federations ?? []).filter(
    ({ status }) => status !== FEDERATION_STATUS.REMOVED
  )
}

/**
 * The trust keys held in a registration: the applications asked for and not
 * failed or removed, and the team file's own (an engineer may have added
 * some). `except` leaves out one application, to compare a change with every
 * other one: its entry by id, and its place in the file by name.
 * @param {{federations?: object[]}|null|undefined} doc
 * @param {{oauth?: {federations?: object[]}}|null|undefined} file
 * @param {{id?: string, name?: string}} [except]
 * @returns {Set<string>}
 */
export function heldTrustKeys(doc, file, except = {}) {
  return new Set(heldApplications(doc, file, except).map(trustKeyOf))
}

/**
 * What the registration holds or is about to hold, for telling a duplicate:
 * the trust keys and names held, and those a change in progress is changing
 * an application to (an application keeps its old definition until the
 * change is applied, so both are reserved).
 * @param {{federations?: object[]}|null|undefined} doc
 * @param {{oauth?: {federations?: object[]}}|null|undefined} file
 * @param {{id?: string, name?: string}} [except]
 * @returns {{trustKeys: Set<string>, names: Set<string>}}
 */
export function reservedBy(doc, file, except = {}) {
  const applications = [
    ...heldApplications(doc, file, except),
    ...(doc?.federations ?? [])
      .filter(
        (entry) =>
          entry.pending &&
          entry.status === FEDERATION_STATUS.SETTING_UP &&
          entry.id !== except.id
      )
      .map(({ host, pending }) => ({ host, ...pending }))
  ]

  return {
    trustKeys: new Set(applications.map(trustKeyOf)),
    names: new Set(applications.map(({ name }) => name))
  }
}

function heldApplications(doc, file, { id, name }) {
  return [
    ...(doc?.federations ?? []).filter(
      (entry) => isOccupying(entry.status) && entry.id !== id
    ),
    ...(file?.oauth?.federations ?? []).filter((entry) => entry.name !== name)
  ]
}

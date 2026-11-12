import { teamEnvironments } from '#/services/team-deployment-service.js'
import {
  FEDERATION_STATUS,
  MAX_FEDERATIONS,
  heldNames,
  heldTrustKeys,
  trustKeyOf
} from '#/services/team-federation-entries.js'
import { readTeamFiles } from '#/services/team-service.js'

// The refusals of a request to federate an application in an environment
// (design E, plan D10), each a stable code the frontend puts in words. The
// checks are the same for a dry run and for the request itself, and never
// name another team.

/**
 * The codes an environment can be refused with, in the order they are tried.
 */
export const FEDERATION_REFUSALS = Object.freeze({
  NOT_AVAILABLE: 'environment-not-available',
  NOT_SET_UP: 'environment-not-set-up',
  EXISTS: 'federation-exists',
  TRUSTED_ELSEWHERE: 'federation-trusted-elsewhere',
  LIMIT_REACHED: 'federation-limit-reached'
})

const OCCUPYING_STATUSES = [
  FEDERATION_STATUS.SETTING_UP,
  FEDERATION_STATUS.READY,
  FEDERATION_STATUS.REMOVING
]

/**
 * What the team holds in each of the environments asked about that this
 * instance offers: the team file on `main` (null when there is none) and the
 * team's document with the applications asked for. An environment not
 * offered is not in the map. A failed read of the files is `502
 * upstream-unavailable`.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, team: {slug: string}, environments: string[], registry: import('#/adapters/tenant-orchestrator-registry.js').TenantOrchestratorRegistry}} params
 * @returns {Promise<Map<string, {file: object|null, doc: object|null}>>}
 */
export async function readRegistrations(
  db,
  { teamId, team, environments, registry }
) {
  const offered = teamEnvironments()
  const asked = environments.filter((environment) =>
    offered.includes(environment)
  )
  const [files, docs] = await Promise.all([
    readTeamFiles(
      registry,
      team.slug,
      offered.filter((environment) => !asked.includes(environment))
    ),
    db
      .collection('teamDeployments')
      .find({ teamId, environment: { $in: asked } })
      .toArray()
  ])

  return new Map(
    asked.map((environment) => [
      environment,
      {
        file:
          files.find((found) => found.environment === environment)?.document ??
          null,
        doc: docs.find((found) => found.environment === environment) ?? null
      }
    ])
  )
}

// Whether another team's registration in the environment trusts the workload:
// another team's application asked for and not failed or removed. The other
// team is never named, nor counted; the infra checks refuse the same file.
async function isTrustedElsewhere(db, { teamId, environment, trustKey }) {
  const other = await db.collection('teamDeployments').findOne(
    {
      environment,
      teamId: { $ne: teamId },
      federations: {
        $elemMatch: { trustKey, status: { $in: OCCUPYING_STATUSES } }
      }
    },
    { projection: { _id: 1 } }
  )

  return other !== null
}

/**
 * Why an application cannot be federated in an environment, or null. An
 * environment this instance does not offer, or the team has not set up, is
 * refused first; then an application the team's registration holds already
 * (by workload or by name); then a workload another team trusts; then a
 * registration that is full. A change names the application it is about in
 * `except`, which is left out of what the registration holds, and so cannot
 * fill it.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, environment: string, registration?: {file: object|null, doc: object|null}, definition: {host: string, name: string, service?: string, principalId?: string}, except?: {id?: string, name?: string}}} params
 * @returns {Promise<string|null>}
 */
export async function refusalFor(
  db,
  { teamId, environment, registration, definition, except = {} }
) {
  if (!registration) {
    return FEDERATION_REFUSALS.NOT_AVAILABLE
  }

  const { file, doc } = registration

  if (!file) {
    return FEDERATION_REFUSALS.NOT_SET_UP
  }

  const trustKey = trustKeyOf(definition)
  const keys = heldTrustKeys(doc, file, except)

  if (keys.has(trustKey) || heldNames(doc, file, except).has(definition.name)) {
    return FEDERATION_REFUSALS.EXISTS
  }

  if (await isTrustedElsewhere(db, { teamId, environment, trustKey })) {
    return FEDERATION_REFUSALS.TRUSTED_ELSEWHERE
  }

  return !except.id && keys.size >= MAX_FEDERATIONS
    ? FEDERATION_REFUSALS.LIMIT_REACHED
    : null
}

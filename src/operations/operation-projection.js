import { REMOVED, withStatusTime } from '#/services/team-deployment-entries.js'

// The projection of an operation onto the `teamDeployments` entries of its
// items (plan 5, "Projection to teamDeployments entries"; contract C6): the
// operation's state names, `removing` for a removal until it is `removed`,
// and `operation {id, state, attempt, runUrl, commitSha, failureReason}`. The
// operation is the truth; this is recomputed from it, so a repeat is harmless.

const FAILED_STATES = new Set(['checks-failed', 'deploy-failed'])

/**
 * The stable failure codes an operation records (plan 5, C6).
 */
export const FAILURE_CODES = Object.freeze({
  CHECKS_FAILED: 'operation-checks-failed',
  DEPLOY_FAILED: 'operation-deploy-failed',
  REVERTED: 'operation-reverted',
  TIMED_OUT: 'operation-timed-out',
  VERIFY_FAILED: 'operation-verify-failed',
  REVERT_CANCELLED: 'operation-revert-cancelled'
})

const REVERT_FAILED_TEXT =
  'The apply failed again after a fresh retry and reverting the change failed too, so platform engineers have been alerted'
const REMOVE_FAILED_TEXT =
  'The model could not be removed, so it is still deployed; platform engineers have been alerted'

// The text the view shows for a failure code; the event's own message (from
// the workflows) is used for a refused change.
const FAILURE_TEXT = {
  [FAILURE_CODES.DEPLOY_FAILED]:
    'The apply failed and platform engineers have been alerted',
  [FAILURE_CODES.REVERTED]:
    'The apply failed again after a fresh retry, so the change was reverted',
  [FAILURE_CODES.TIMED_OUT]:
    'The change has not progressed in time and platform engineers have been alerted',
  [FAILURE_CODES.REVERT_CANCELLED]:
    'The apply failed and the revert was cancelled; platform engineers have been alerted'
}

const VERIFY_REASON_TEXT = {
  'environment-not-configured': 'this environment is not set up in the portal',
  'no-resources': 'the apply reported no resources for the team',
  'resource-outside-environment':
    'a resource was created outside this environment',
  'unsupported-resource-type':
    'a resource is of a type the portal cannot check',
  'resource-unavailable': 'a resource could not be found in Azure',
  'resource-not-succeeded': 'a resource had not finished being created'
}

/**
 * The text a failed ARM verification is shown with.
 * @param {string} reason - the verifier's stable code
 * @returns {string}
 */
export function verificationFailureText(reason) {
  const text = VERIFY_REASON_TEXT[reason] ?? 'the cause is not known'

  return `Your team's resources were created but could not be confirmed: ${text} (${reason}). Ask the AI Platform team to check and retry.`
}

function failureTextOf(operation) {
  const code = operation.error?.code

  if (code === FAILURE_CODES.CHECKS_FAILED) {
    return operation.error.message
  }

  if (code === FAILURE_CODES.VERIFY_FAILED) {
    return verificationFailureText(operation.error.message)
  }

  return FAILURE_TEXT[code] ?? null
}

/**
 * The status an entry shows for its operation: the state's own name, except a
 * removal, which is `removing` until `removed` and goes back to `active`
 * when it failed (the model is still deployed).
 * @param {{state: string}} operation
 * @param {{change: string}} item
 * @returns {string}
 */
export function entryStatusOf(operation, item) {
  const { state } = operation

  if (state === 'timed-out' || item.change !== 'remove') {
    return state
  }

  if (state === REMOVED) {
    return REMOVED
  }

  return FAILED_STATES.has(state) ? 'active' : 'removing'
}

/**
 * The failure text an entry shows, or null.
 * @param {object} operation
 * @param {{change: string}} item
 * @returns {string|null}
 */
export function entryFailureReasonOf(operation, item) {
  if (item.change === 'remove') {
    return FAILED_STATES.has(operation.state) ? REMOVE_FAILED_TEXT : null
  }

  if (operation.state === 'deploy-failed' && operation.revertFailed) {
    return REVERT_FAILED_TEXT
  }

  return failureTextOf(operation)
}

const RESOURCE_KINDS = [
  [/project/i, 'Foundry project'],
  [/deployment/i, 'Model deployment'],
  [/apim|api_management|(^|[._])api($|[._])/i, 'API in API Management']
]

/**
 * What the team has in Azure, from the apply's resources: names and kinds
 * only, never an ID, so nothing here identifies a subscription or resource.
 * @param {Array<{type: string, name: string}>|undefined} resources
 * @param {boolean} verified - ARM has confirmed them
 * @returns {Array<{name: string, kind: string, verified: boolean}>}
 */
export function resourceListOf(resources, verified) {
  return (resources ?? []).flatMap(({ type, name }) => {
    const kind = RESOURCE_KINDS.find(([pattern]) => pattern.test(type))?.[1]

    return kind ? [{ name, kind, verified }] : []
  })
}

/**
 * The team's Entra app registration identifiers from the apply's resources,
 * or null when Entra skipped it. Identifiers only, never a secret.
 * @param {Array<{type: string, id: string}>|undefined} resources
 * @returns {{clientId: null, objectId: string, servicePrincipalObjectId: string|null}|null}
 */
export function appRegistrationOf(resources) {
  const application = resources?.find(({ type }) =>
    /azuread_application/.test(type)
  )

  if (!application) {
    return null
  }

  return {
    clientId: null,
    objectId: application.id,
    servicePrincipalObjectId:
      resources.find(({ type }) => /azuread_service_principal/.test(type))
        ?.id ?? null
  }
}

const VERIFIED_STATES = ['verified', 'active', 'removed']

function operationSummaryOf(operation, gitops) {
  return {
    id: operation._id,
    state: operation.state,
    attempt: operation.attempt,
    runUrl: gitops.applyRunUrl ?? gitops.submitRunUrl ?? null,
    commitSha: gitops.commitSha ?? null,
    failureReason: operation.error?.code ?? null
  }
}

function linksOf(gitops) {
  return Object.fromEntries(
    Object.entries({
      submitRun: gitops.submitRunUrl,
      applyRun: gitops.applyRunUrl
    }).filter(([, url]) => url)
  )
}

function registrationStatusOf(resources) {
  if (!resources) {
    return null
  }

  return appRegistrationOf(resources) ? 'created' : 'skipped'
}

function verificationFailureOf(operation, verify) {
  return verify?.reason && operation.state === 'deployed'
    ? { reason: verify.reason, attempts: verify.attempts }
    : null
}

/**
 * The fields of one entry as its operation now stands.
 * @param {object} operation
 * @param {{change: string}} item
 * @param {{statusTimes?: Record<string, string>}} entry - the entry as stored
 * @param {string} at - ISO time of the projection
 * @returns {Record<string, unknown>}
 */
export function entryFieldsOf(operation, item, entry, at) {
  const status = entryStatusOf(operation, item)
  const { gitops = {}, verify } = operation
  const verified = VERIFIED_STATES.includes(operation.state)
  const fields = {
    status,
    statusTimes: withStatusTime(entry.statusTimes, status, at),
    failureReason: entryFailureReasonOf(operation, item),
    projectedVersion: operation.stateVersion,
    operationId: operation._id,
    operation: operationSummaryOf(operation, gitops),
    links: linksOf(gitops),
    resources: resourceListOf(gitops.resources, verified),
    appRegistration: registrationStatusOf(gitops.resources),
    verificationFailure: verificationFailureOf(operation, verify)
  }

  if (status === 'active' && item.change !== 'remove') {
    fields.activatedAt = entry.activatedAt ?? at
  }

  if (status === REMOVED) {
    fields.removedAt = entry.removedAt ?? at
  }

  return fields
}

/**
 * Writes an operation's state onto the entries of its items, behind a
 * version guard so a slower projection never overwrites a newer one. A model
 * turning active is granted to the team's gateway, one removed is withdrawn,
 * and the team's Entra registration is kept when the resources verify.
 * @param {import('mongodb').Db} db
 * @param {object} operation
 * @returns {Promise<void>}
 */
export async function projectOperation(db, operation) {
  const doc = await db
    .collection('teamDeployments')
    .findOne({ teamId: operation.teamId, environment: operation.environment })

  if (!doc || !operation.items?.length) {
    return
  }

  const at = new Date().toISOString()
  const set = {}
  const addToSet = []
  const pull = []
  const arrayFilters = []

  operation.items.forEach((item, index) => {
    const entry = doc.deployments?.find(({ id }) => id === item.entryId)

    if (!entry) {
      return
    }

    const key = `e${index}`
    const fields = entryFieldsOf(operation, item, entry, at)

    // A version guard per entry: a slower projection of the same operation
    // never overwrites a newer one. An entry last projected from another
    // operation (a removal of an added model) takes this one at once, since
    // state versions only order the writes of one operation.
    arrayFilters.push({
      [`${key}.id`]: item.entryId,
      $or: [
        { [`${key}.projectedVersion`]: { $exists: false } },
        {
          [`${key}.operation.id`]: { $exists: true, $ne: operation._id }
        },
        { [`${key}.projectedVersion`]: { $lt: operation.stateVersion } }
      ]
    })

    for (const [field, value] of Object.entries(fields)) {
      set[`deployments.$[${key}].${field}`] = value
    }

    if (fields.status === 'active' && item.change !== 'remove') {
      addToSet.push(item.modelSlug)
    }

    if (fields.status === REMOVED) {
      pull.push(item.modelSlug)
    }
  })

  const registration = appRegistrationOf(operation.gitops?.resources)

  if (registration && ['verified', 'active'].includes(operation.state)) {
    set['oauthClient.registration'] = registration
  }

  if (arrayFilters.length === 0) {
    return
  }

  const update = { $set: { ...set, updatedAt: at } }

  if (addToSet.length > 0) {
    update.$addToSet = { 'gateway.allowedDeployments': { $each: addToSet } }
  }

  if (pull.length > 0) {
    update.$pull = { 'gateway.allowedDeployments': { $in: pull } }
  }

  await db
    .collection('teamDeployments')
    .updateOne({ _id: doc._id }, update, { arrayFilters })
}

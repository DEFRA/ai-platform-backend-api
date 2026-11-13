import { supportReferenceOf } from '#/operations/support-reference.js'
import { isFederationItem } from '#/operations/operation-items.js'
import { RANK as STATE_RANK } from '#/operations/operation-state-machine.js'
import { REMOVED, withStatusTime } from '#/services/team-deployment-entries.js'
import { FEDERATION_STATUS } from '#/services/team-federation-constants.js'

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
  'The deployment failed again after a fresh retry and reverting the change failed too'

// The text the view shows for a failure code; the event's own message (from
// the workflows) is used for a refused change.
const FAILURE_TEXT = {
  [FAILURE_CODES.DEPLOY_FAILED]: 'The deployment failed',
  [FAILURE_CODES.REVERTED]:
    'The deployment failed again after a fresh retry, so the change was reverted',
  [FAILURE_CODES.TIMED_OUT]: 'The setup did not finish in time',
  [FAILURE_CODES.REVERT_CANCELLED]:
    'The deployment failed and the revert was cancelled'
}

const VERIFY_REASON_TEXT = {
  'environment-not-configured': 'this environment is not set up in the portal',
  'no-resources': 'the apply reported no resources for the team',
  'resource-outside-environment':
    'a resource was created outside this environment',
  'unsupported-resource-type':
    'a resource is of a type the portal cannot check',
  'resource-unavailable': 'a resource could not be found',
  'resource-not-succeeded': 'a resource had not finished being created'
}

/**
 * The text a failed ARM verification is shown with.
 * @param {string} reason - the verifier's stable code
 * @returns {string}
 */
export function verificationFailureText(reason) {
  const text = VERIFY_REASON_TEXT[reason] ?? 'the cause is not known'

  return `Your team's resources were created but could not be confirmed: ${text} (${reason}).`
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

// A removal that failed leaves the model deployed: the person is told who to
// contact, and the reference to quote.
function removeFailedText(operation) {
  return `The model could not be removed, so it is still deployed. Contact AI Platform Support, quoting reference ${supportReferenceOf(operation._id)}`
}

/**
 * The failure text an entry shows, or null.
 * @param {object} operation
 * @param {{change: string}} item
 * @returns {string|null}
 */
export function entryFailureReasonOf(operation, item) {
  if (item.change === 'remove') {
    return FAILED_STATES.has(operation.state)
      ? removeFailedText(operation)
      : null
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
 * What the team has, from the apply's resources: names and kinds
 * only, never an ID, so nothing here identifies a subscription or resource.
 * @param {Array<{type: string, name: string}>|undefined} resources
 * @param {boolean} verified - the platform has confirmed them
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

const VERIFIED_STATES = new Set(['verified', 'active', 'removed'])

/**
 * The run a person follows for an operation: the apply's, else the submit's.
 * @param {{gitops?: {applyRunUrl?: string, submitRunUrl?: string}}} operation
 * @returns {string|null}
 */
export function runUrlOf({ gitops = {} }) {
  return gitops.applyRunUrl ?? gitops.submitRunUrl ?? null
}

function operationSummaryOf(operation, gitops) {
  return {
    id: operation._id,
    state: operation.state,
    attempt: operation.attempt,
    runUrl: runUrlOf(operation),
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
  const verified = VERIFIED_STATES.has(operation.state)
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

  await projectDeployments(db, doc, operation)
  await projectFederations(db, doc, operation)
}

// A version guard per entry: a slower projection of the same operation never
// overwrites a newer one. An entry last projected from another operation (a
// removal of an added model) takes this one at once, since state versions
// only order the writes of one operation.
function versionGuardOf(key, operation, entryId) {
  return {
    [`${key}.id`]: entryId,
    $or: [
      { [`${key}.projectedVersion`]: { $exists: false } },
      { [`${key}.operation.id`]: { $exists: true, $ne: operation._id } },
      { [`${key}.projectedVersion`]: { $lt: operation.stateVersion } }
    ]
  }
}

// The guard for an application: as for a model, except that another operation
// takes the entry only if it is newer than the one that last projected onto
// it. Operation ids are version 7 UUIDs, which sort by the time they were
// made, so an event of an earlier operation redelivered after a later change
// or removal took the application is not projected over it.
function federationGuardOf(key, operation, entryId) {
  const recorded = `${key}.operation.id`
  const version = `${key}.projectedVersion`

  return {
    [`${key}.id`]: entryId,
    $or: [
      { [version]: { $exists: false } },
      { [recorded]: { $lt: operation._id } },
      { [recorded]: operation._id, [version]: { $lt: operation.stateVersion } },
      {
        [recorded]: { $exists: false },
        [version]: { $lt: operation.stateVersion }
      }
    ]
  }
}

async function projectDeployments(db, doc, operation) {
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

    arrayFilters.push(versionGuardOf(key, operation, item.entryId))

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

const ACTIVE_STATES = new Set(['active', REMOVED])
const FEDERATION_FAILED_STATES = new Set([
  'checks-failed',
  'deploy-failed',
  'timed-out'
])

/**
 * The status an application shows for its operation: an addition or a change
 * is setting up until the operation is active, then ready, or failed; a
 * removal is removing until it is done, then removed, and ready again with a
 * reason if it failed (the application is still federated).
 * @param {{state: string, leftState?: string, error?: {code: string}, gitops?: {commitSha?: string}}} operation
 * @param {{change: string}} item
 * @param {{statusBefore?: string}} [entry] - the application as stored
 * @returns {string}
 */
export function federationStatusOf(operation, item, entry = {}) {
  const done = ACTIVE_STATES.has(operation.state)
  const failed = FEDERATION_FAILED_STATES.has(operation.state)

  if (item.change === 'remove') {
    if (done) {
      return FEDERATION_STATUS.REMOVED
    }

    return failed ? FEDERATION_STATUS.READY : FEDERATION_STATUS.REMOVING
  }

  if (done) {
    return FEDERATION_STATUS.READY
  }

  if (!failed) {
    return FEDERATION_STATUS.SETTING_UP
  }

  // A change that failed before it committed, or was reverted, leaves the
  // application as it was: whatever it was before the change (still
  // federated, or an addition that failed), with the reason. One that failed
  // after it committed holds the new definition in the file, so it shows as
  // failed, as an addition does.
  if (
    item.change === 'change' &&
    (isReverted(operation) || !hasCommitted(operation))
  ) {
    return entry.statusBefore ?? FEDERATION_STATUS.READY
  }

  return FEDERATION_STATUS.FAILED
}

function isReverted(operation) {
  return operation.error?.code === FAILURE_CODES.REVERTED
}

// What a person is told when an application could not be removed.
function removeFederationFailedText(operation) {
  return `The application could not be removed, so it is still federated. Contact AI Platform Support, quoting reference ${supportReferenceOf(operation._id)}`
}

function federationFailureReasonOf(operation, item) {
  if (item.change === 'remove') {
    return FEDERATION_FAILED_STATES.has(operation.state)
      ? removeFederationFailedText(operation)
      : null
  }

  return entryFailureReasonOf(operation, { change: item.change })
}

// A change is applied to the entry once it has committed: it is active, its
// deploy failed after the commit, or it timed out after one (it left a state
// at or past `committed`, or a commit is recorded). Until then the entry
// keeps the definition the team file still holds, and what it is changing to
// waits in `pending` (also through a failure before the commit, or a timeout
// before it, in case it recovers).
const COMMITTED_CHANGE_STATES = new Set(['active', 'deploy-failed'])

function hasCommitted(operation) {
  if (COMMITTED_CHANGE_STATES.has(operation.state)) {
    return true
  }

  return (
    operation.state === 'timed-out' &&
    ((STATE_RANK[operation.leftState] ?? 0) >= STATE_RANK.committed ||
      operation.gitops?.commitSha != null)
  )
}

function definitionFieldsOf({ name, service, principalId, trustKey }) {
  return {
    name,
    trustKey,
    ...(service ? { service } : {}),
    ...(principalId ? { principalId } : {})
  }
}

function pendingAppliedOf(entry) {
  return entry.pending
    ? { ...definitionFieldsOf(entry.pending), pending: null }
    : {}
}

// The definition a revert brings back: the one the entry held before the
// change that failed in its deploy was applied to it.
function revertedFieldsOf(entry) {
  return entry.previous
    ? { ...definitionFieldsOf(entry.previous), previous: null }
    : {}
}

function appliedFieldsOf(operation, item, entry) {
  if (item.change !== 'change') {
    return {}
  }

  if (isReverted(operation)) {
    return revertedFieldsOf(entry)
  }

  // Once active the change stands: nothing is left to restore.
  if (operation.state === 'active') {
    return { ...pendingAppliedOf(entry), previous: null, statusBefore: null }
  }

  return hasCommitted(operation) && entry.pending
    ? { ...pendingAppliedOf(entry), previous: definitionFieldsOf(entry) }
    : {}
}

function federationFieldsOf(operation, item, entry, at) {
  const status = federationStatusOf(operation, item, entry)

  return {
    status,
    statusTimes: withStatusTime(entry.statusTimes, status, at),
    failureReason: federationFailureReasonOf(operation, item),
    projectedVersion: operation.stateVersion,
    operationId: operation._id,
    operation: operationSummaryOf(operation, operation.gitops ?? {}),
    ...appliedFieldsOf(operation, item, entry)
  }
}

// Writes an operation's state onto the applications its federation items
// name, in the team's document. A removed application stays as a record, so a
// removal repeated is answered, and holds no place in the registration.
async function projectFederations(db, doc, operation) {
  const at = new Date().toISOString()
  const set = {}
  const arrayFilters = []

  operation.items.filter(isFederationItem).forEach((item, index) => {
    const entry = doc.federations?.find(({ id }) => id === item.entryId)

    if (!entry) {
      return
    }

    const key = `f${index}`

    arrayFilters.push(federationGuardOf(key, operation, item.entryId))

    for (const [field, value] of Object.entries(
      federationFieldsOf(operation, item, entry, at)
    )) {
      set[`federations.$[${key}].${field}`] = value
    }
  })

  if (arrayFilters.length > 0) {
    await db
      .collection('teamDeployments')
      .updateOne(
        { _id: doc._id },
        { $set: { ...set, updatedAt: at } },
        { arrayFilters }
      )
  }
}

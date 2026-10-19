import {
  DEPLOY_FAILED,
  auditDeployment
} from '#/services/team-deployment-entries.js'

const REASON_TEXT = {
  'environment-not-configured': 'this environment is not set up in the portal',
  'no-resources': 'the apply reported no resources for the team',
  'resource-outside-environment':
    'a resource was created outside this environment',
  'unsupported-resource-type':
    'a resource is of a type the portal cannot check',
  'resource-unavailable': 'a resource could not be found in Azure',
  'resource-not-succeeded': 'a resource had not finished being created'
}

function failureReasonOf(reason) {
  const text = REASON_TEXT[reason] ?? 'the cause is not known'

  return `Your team's resources were created but could not be confirmed: ${text} (${reason}). Ask the AI Platform team to check and retry.`
}

/**
 * Counts a failed ARM verification against the entry and, once it has failed
 * `maxAttempts` times, ends the deployment as failed with the verifier's
 * reason rather than re-verifying for ever. An earlier attempt's count lives
 * on `gitops.verification`.
 * @param {{gitops: {verification?: {attempts: number}}}} entry
 * @param {{status: string, verificationFailure: {reason: string}, polledAt?: string}} result
 * @param {number} maxAttempts
 * @returns {object} The result with `verification` set, and failed once the bound is reached.
 */
export function applyVerificationPolicy(entry, result, maxAttempts) {
  const { reason } = result.verificationFailure
  const verification = {
    reason,
    attempts: (entry.gitops.verification?.attempts ?? 0) + 1,
    lastAttemptAt: result.polledAt ?? new Date().toISOString()
  }

  return verification.attempts >= maxAttempts
    ? {
        ...result,
        status: DEPLOY_FAILED,
        failureReason: failureReasonOf(reason),
        verification
      }
    : { ...result, verification }
}

/**
 * Audits and logs one failed verification: the signal that says why a
 * deployed team is not activating. Carries the stable reason code and the
 * operation ID only.
 * @param {import('mongodb').Db} db
 * @param {{environment: string}} doc
 * @param {{id: string, operationId: string}} entry
 * @param {{status: string, verification: {reason: string, attempts: number}}} result
 * @param {{maxAttempts: number, logger?: import('pino').Logger}} options
 */
export async function reportVerificationFailure(
  db,
  doc,
  entry,
  result,
  { maxAttempts, logger }
) {
  const { reason, attempts } = result.verification
  const final = result.status === DEPLOY_FAILED

  await auditDeployment(db, entry, {
    action: 'teamDeployment.verificationFailed',
    outcome: 'failure',
    code: reason,
    reason: `attempt ${attempts} of ${maxAttempts}`
  })

  logger?.[final ? 'error' : 'warn'](
    {
      operationId: entry.operationId,
      environment: doc.environment,
      reason,
      attempts,
      maxAttempts
    },
    final
      ? 'Team deployment verification failed for good and needs a platform engineer'
      : 'Team deployment verification failed, will verify again'
  )
}

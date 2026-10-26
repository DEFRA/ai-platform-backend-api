import { findOperation } from '#/operations/operation-repository.js'
import { FAILURE_CODES } from '#/operations/operation-projection.js'
import {
  ACTIVE,
  DEPLOYED,
  DEPLOY_FAILED,
  OPERATION_TYPES,
  REMOVED,
  VERIFIED,
  verifyOutcome
} from '#/operations/operation-state-machine.js'
import { writeOperation } from '#/operations/operation-writer.js'
import { auditDeployment } from '#/services/team-deployment-entries.js'

/**
 * ARM verification of a `deployed` operation (plan 5, "Deadlines, reconcile
 * and verification"): the handler verifies once, within its timeout; on a
 * miss it sets `verify.nextAt` and the sweeper retries at 30, 60, 120 and
 * 240 s, up to `GITOPS_VERIFY_MAX_ATTEMPTS` (5), then `deploy-failed` with
 * `operation-verify-failed`. A verified operation becomes `active` (or
 * `removed`), ends, and its models are granted to the team's credential.
 * @param {object} deps
 * @param {{db: import('mongodb').Db, settings: object, logger?: import('pino').Logger}} deps.ctx
 * @param {import('#/adapters/tenant-resource-verifier.js').TenantResourceVerifier} deps.verifier
 * @param {{finish: (operation: object) => Promise<void>}} deps.operations
 * @param {(operation: object) => Promise<void>} deps.grantCredentials - gives a team its credential once a model is active; never throws
 */
export function createOperationVerifier({
  ctx,
  verifier,
  operations,
  grantCredentials
}) {
  const { db, settings, logger } = ctx

  // Only a write of a team file creates resources to read back: a removal, a
  // revert or a pin has nothing team-specific to confirm.
  function needsReadBack(operation) {
    return (
      operation.type === OPERATION_TYPES.WRITE &&
      operation.items.some(({ change }) => change !== 'remove')
    )
  }

  async function complete(operation) {
    const verified = await writeOperation(ctx, operation, { state: VERIFIED })

    if (!verified) {
      return null
    }

    const removal =
      verified.items.length > 0 &&
      verified.items.every(({ change }) => change === 'remove')
    const ended = await writeOperation(ctx, verified, {
      state: removal ? REMOVED : ACTIVE,
      set: { verify: { attempts: 0, nextAt: null } },
      deadlineAt: null
    })

    if (!ended) {
      return null
    }

    await operations.finish(ended)

    if (!removal) {
      await grantCredentials(ended)
    }

    return ended
  }

  async function report(operation, reason, attempts, final) {
    const max = settings.verifyMaxAttempts

    for (const { entryId } of operation.items) {
      await auditDeployment(
        db,
        { id: entryId },
        {
          action: 'teamDeployment.verificationFailed',
          outcome: 'failure',
          code: reason,
          reason: `attempt ${attempts} of ${max}`
        }
      )
    }

    logger?.[final ? 'error' : 'warn'](
      {
        operationId: operation._id,
        environment: operation.environment,
        reason,
        attempts,
        maxAttempts: max
      },
      final
        ? 'Team deployment verification failed for good and needs a platform engineer'
        : 'Team deployment verification failed, will verify again'
    )
  }

  async function failed(operation, reason) {
    const attempts = (operation.verify?.attempts ?? 0) + 1
    const outcome = verifyOutcome(attempts, settings.verifyMaxAttempts)
    const verify = {
      attempts,
      reason,
      lastAttemptAt: new Date().toISOString(),
      nextAt: outcome.kind === 'retry' ? outcome.nextAt : null
    }

    if (outcome.kind === 'retry') {
      const written = await writeOperation(ctx, operation, { set: { verify } })

      if (written) {
        await report(written, reason, attempts, false)
      }

      return written
    }

    const ended = await writeOperation(ctx, operation, {
      state: DEPLOY_FAILED,
      set: {
        verify,
        error: {
          code: FAILURE_CODES.VERIFY_FAILED,
          message: reason,
          retryable: false
        }
      },
      deadlineAt: null,
      source: 'backend'
    })

    if (ended) {
      await report(ended, reason, attempts, true)
      await operations.finish(ended)
    }

    return ended
  }

  /**
   * Verifies a `deployed` operation once. Safe to call from the handler and
   * the sweeper together: only one write of a version wins.
   * @param {string} operationId
   * @returns {Promise<object|null>} The operation as written, or null when it was not `deployed` any longer.
   */
  async function verify(operationId) {
    const operation = await findOperation(db, operationId)

    if (operation?.state !== DEPLOYED) {
      return null
    }

    if (!needsReadBack(operation)) {
      return complete(operation)
    }

    const { verified, reason } = await verifier.verify({
      environment: operation.environment,
      resources: operation.gitops.resources ?? null
    })

    return verified
      ? complete(operation)
      : failed(operation, reason ?? 'unknown')
  }

  return { verify }
}

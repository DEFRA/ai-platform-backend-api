/**
 * Port interface for provisioning a team's dedicated model access via the
 * GitOps pipeline (commit -> PR -> checks -> merge -> deploy -> verify),
 * using design C's real operation state names so a real adapter driving the
 * GitHub App + `tenant.bicep` deploy workflow is a drop-in replacement later
 * with no service/route changes.
 * @typedef {object} TenantOrchestrator
 * @property {(params: {teamId: string, modelSlug: string, environment: string, operationId: string, requestedBy: string}) => Promise<{operationId: string, status: string}>} requestDeployment
 * @property {(params: {operationId: string, requestedAt: string}) => Promise<{operationId: string, status: string, failureReason?: string}>} getDeploymentStatus
 */

export {}

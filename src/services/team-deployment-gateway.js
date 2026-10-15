/**
 * Finds the active deployment entry for a team+model+environment, used by
 * `credential-service.js` to gate team-tier credential issuance. Does not
 * refresh status itself - the requester's poll of `getDeployment` in
 * `team-deployment-service.js` is what keeps the persisted record up to date.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, modelSlug: string, environment: string}} params
 */
export async function findActiveDeployment(
  db,
  { teamId, modelSlug, environment }
) {
  const doc = await db.collection('teamDeployments').findOne({
    teamId,
    environment,
    deployments: { $elemMatch: { modelSlug, status: 'active' } }
  })

  return (
    doc?.deployments?.find(
      (deployment) =>
        deployment.modelSlug === modelSlug && deployment.status === 'active'
    ) ?? null
  )
}

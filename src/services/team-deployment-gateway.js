/**
 * The models a team's gateway grants in one environment: the backend's
 * mirror of the team file's `gateway.allowedDeployments`, kept in step as
 * deployments become `active` and `removed`. A team credential covers
 * exactly these, so it never carries a copy of its own.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, environment: string|null}} params
 * @returns {Promise<string[]>}
 */
export async function grantedModelSlugs(db, { teamId, environment }) {
  const doc = await db
    .collection('teamDeployments')
    .findOne(
      { teamId, environment },
      { projection: { 'gateway.allowedDeployments': 1 } }
    )

  return doc?.gateway?.allowedDeployments ?? []
}

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

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

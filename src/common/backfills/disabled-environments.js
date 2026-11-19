import { ObjectId } from 'mongodb'

/**
 * Makes each team's `disabledEnvironments` the environments whose credentials
 * a Platform Admin blocked (`teamDeployments.adminBlocked`), in alphabetical
 * order, and empties it for every other team that held any.
 * @param {import('mongodb').Db} db
 * @returns {Promise<{modifiedCount: number}>}
 */
export async function rebuildDisabledEnvironments(db) {
  const blocked = await db
    .collection('teamDeployments')
    .aggregate([
      { $match: { adminBlocked: true } },
      {
        $group: { _id: '$teamId', environments: { $addToSet: '$environment' } }
      }
    ])
    .toArray()
  const teams = db.collection('teams')
  const cleared = await teams.updateMany(
    { 'disabledEnvironments.0': { $exists: true } },
    { $set: { disabledEnvironments: [] } }
  )
  let modifiedCount = cleared.modifiedCount

  for (const { _id: teamId, environments } of blocked) {
    if (!ObjectId.isValid(teamId)) {
      continue
    }

    const { modifiedCount: changed } = await teams.updateOne(
      { _id: new ObjectId(teamId) },
      { $set: { disabledEnvironments: environments.sort() } }
    )

    modifiedCount += changed
  }

  return { modifiedCount }
}

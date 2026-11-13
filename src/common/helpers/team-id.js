import { ObjectId } from 'mongodb'

const TEAM_ID_PATTERN = /^[0-9a-f]{24}$/

/**
 * The id of the team that holds it, or null: text that is not shaped like a
 * team id (a slug, say) and an id no team holds are both null. The one place
 * that decides whether an id names a team, for `resolveTeamId` and for the
 * audit of a refusal, which names a team only when there is one.
 * @param {import('mongodb').Db} db
 * @param {string} id
 * @returns {Promise<string|null>}
 */
export async function existingTeamId(db, id) {
  if (!TEAM_ID_PATTERN.test(id)) {
    return null
  }

  const team = await db
    .collection('teams')
    .findOne({ _id: new ObjectId(id) }, { projection: { _id: 1 } })

  return team ? id : null
}

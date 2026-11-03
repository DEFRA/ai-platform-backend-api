import { ObjectId } from 'mongodb'

const SYSTEM_ACTOR = 'app:ai-platform-backend'

/**
 * Marks memberships removed the way an Admin's removal does (a status change,
 * so the history survives), by the system.
 * @param {import('mongodb').Collection} members
 * @param {object} filter
 * @returns {Promise<number>}
 */
async function removeMemberships(members, filter) {
  const { modifiedCount } = await members.updateMany(filter, {
    $set: {
      status: 'removed',
      removedAt: new Date().toISOString(),
      removedBy: SYSTEM_ACTOR
    }
  })

  return modifiedCount
}

/**
 * Among one person's duplicate active memberships of a team, the one to
 * keep: an Admin if there is one, else the earliest.
 * @param {{_id: import('mongodb').ObjectId, role: string, createdAt?: string}[]} rows
 */
function pickKeeper(rows) {
  const byAge = (a, b) =>
    (a.createdAt ?? '').localeCompare(b.createdAt ?? '') ||
    a._id.toString().localeCompare(b._id.toString())
  const admins = rows.filter((row) => row.role === 'admin')

  return [...(admins.length > 0 ? admins : rows)].sort(byAge)[0]
}

async function removeDuplicateActiveMemberships(members) {
  const groups = await members
    .aggregate([
      { $match: { status: 'active', userId: { $type: 'string' } } },
      {
        $group: {
          _id: { teamId: '$teamId', userId: '$userId' },
          rows: {
            $push: { _id: '$_id', role: '$role', createdAt: '$createdAt' }
          },
          count: { $sum: 1 }
        }
      },
      { $match: { count: { $gt: 1 } } }
    ])
    .toArray()

  const losers = groups.flatMap(({ rows }) => {
    const keeper = pickKeeper(rows)

    return rows.filter((row) => row._id !== keeper._id).map((row) => row._id)
  })

  return losers.length === 0
    ? 0
    : removeMemberships(members, { _id: { $in: losers } })
}

async function deletePeopleWithNoOid(db) {
  const people = await db
    .collection('users')
    .find({ oid: null }, { projection: { _id: 1 } })
    .toArray()

  if (people.length === 0) {
    return { usersDeleted: 0, membershipsRemoved: 0, credentialsOrphaned: 0 }
  }

  const ids = people.map((person) => person._id)
  const userIds = ids.map(String)
  // Credentials are keyed by `userId` and are not touched: they stay as the
  // audit trail, and this count tells an operator how many now belong to
  // nobody who can sign in.
  const credentialsOrphaned = await db
    .collection('credentials')
    .countDocuments({ userId: { $in: userIds } })
  const membershipsRemoved = await removeMemberships(
    db.collection('teamMembers'),
    { userId: { $in: userIds }, status: 'active' }
  )
  const { deletedCount } = await db
    .collection('users')
    .deleteMany({ _id: { $in: ids } })

  return { usersDeleted: deletedCount, membershipsRemoved, credentialsOrphaned }
}

async function countTeamsWithoutActiveAdmin(db) {
  const teamIdsWithAdmin = await db
    .collection('teamMembers')
    .distinct('teamId', { role: 'admin', status: 'active' })

  return db.collection('teams').countDocuments({
    _id: {
      $nin: teamIdsWithAdmin
        .filter((teamId) => ObjectId.isValid(teamId))
        .map((teamId) => new ObjectId(teamId))
    }
  })
}

/**
 * Team membership is by person from the directory only (design F,
 * `#membership`): invitations, the email field and the sign-in binds are
 * gone, so existing data is brought to that shape. Sets `invited` rows to
 * removed; keeps one active membership per person and team (an Admin, else
 * the earliest), which the new unique index needs; unsets `email`; deletes
 * people with no `oid` (nothing binds them now) and removes their active
 * memberships. Returns counts only - never an address or a name - including
 * the credentials left owned by a deleted person (kept, not deleted) and the
 * number of teams left with no active Admin, to restore by hand.
 * @param {import('mongodb').Db} db
 */
export async function makeTeamMembersDirectoryOnly(db) {
  const members = db.collection('teamMembers')

  const invitationsRemoved = await removeMemberships(members, {
    status: 'invited'
  })
  const duplicatesRemoved = await removeDuplicateActiveMemberships(members)
  const { modifiedCount: emailsUnset } = await members.updateMany(
    { email: { $exists: true } },
    { $unset: { email: '' } }
  )
  const { usersDeleted, membershipsRemoved, credentialsOrphaned } =
    await deletePeopleWithNoOid(db)

  return {
    invitationsRemoved,
    duplicatesRemoved,
    emailsUnset,
    usersDeleted,
    membershipsRemoved,
    credentialsOrphaned,
    teamsWithoutAdmin: await countTeamsWithoutActiveAdmin(db)
  }
}

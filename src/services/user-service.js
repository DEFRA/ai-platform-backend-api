import { config } from '#/config.js'
import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'

function normaliseTeamName(teamName) {
  return teamName.trim().toLowerCase().replace(/\s+/g, '-')
}

function isAllowedEmailDomain(email) {
  const domain = email.split('@')[1]
  const allowedDomains = config
    .get('allowedEmailDomains')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean)

  return allowedDomains.includes(domain)
}

/**
 * Upserts the team and user for the self-declared sign-in journey (J1).
 * @param {import('mongodb').Db} db
 * @param {{email: string, displayName: string, teamName: string}} params
 */
export async function upsertUser(db, { email, displayName, teamName }) {
  const lowerEmail = email.toLowerCase()

  if (!isAllowedEmailDomain(lowerEmail)) {
    throw boomWithCode(
      Boom.forbidden,
      'Email domain is not allowed',
      'domain-not-allowed'
    )
  }

  const now = new Date().toISOString()
  const normalisedName = normaliseTeamName(teamName)

  const team = await db
    .collection('teams')
    .findOneAndUpdate(
      { normalisedName },
      { $setOnInsert: { name: teamName, normalisedName, createdAt: now } },
      { upsert: true, returnDocument: 'after' }
    )

  const user = await db.collection('users').findOneAndUpdate(
    { email: lowerEmail },
    {
      $set: {
        displayName,
        teamId: team._id,
        lastSignInAt: now,
        updatedAt: now
      },
      $setOnInsert: {
        email: lowerEmail,
        roles: ['research-user'],
        createdAt: now
      }
    },
    { upsert: true, returnDocument: 'after' }
  )

  return { user, team }
}

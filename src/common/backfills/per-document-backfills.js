import { deriveTeamSlug, firstFreeSlug } from '#/common/helpers/team-slug.js'
import { forEachSequentially } from '#/common/helpers/sequential.js'

const AZURE = 'azure'
const AZURE_APIM = 'azure-apim'

/**
 * Snapshots provider/offering/cloud/adapter onto credentials docs missing
 * them, from the credential's model (azure/azure-apim if unknown). Documents
 * are updated one after another.
 * @param {import('mongodb').Db} db
 * @returns {Promise<{modifiedCount: number}>}
 */
export async function snapshotCredentialProviderCloudAdapter(db) {
  const models = new Map(
    (await db.collection('models').find({}).toArray()).map((model) => [
      model.slug,
      model
    ])
  )
  const credentials = db.collection('credentials')
  const pending = await credentials
    .find({ adapter: { $exists: false } })
    .toArray()

  await forEachSequentially(pending, (credential) => {
    const isTeam = credential.tier === 'team'
    const model = models.get(
      credential.modelSlug ?? credential.allowedDeployments?.[0]
    )

    return credentials.updateOne(
      { _id: credential._id },
      {
        $set: {
          provider: isTeam ? null : (model?.provider ?? null),
          offering: isTeam ? null : (model?.offering ?? null),
          cloud: model?.cloud ?? AZURE,
          adapter: model?.adapter ?? AZURE_APIM
        }
      }
    )
  })

  return { modifiedCount: pending.length }
}

/**
 * Derives `slug` from `name` on teams docs missing it. Each slug is checked
 * against the ones already taken, so teams are updated one after another.
 * @param {import('mongodb').Db} db
 * @returns {Promise<{modifiedCount: number}>}
 */
export async function addTeamSlugs(db) {
  const teams = db.collection('teams')
  const missing = await teams.find({ slug: { $exists: false } }).toArray()

  const taken = new Set(
    (
      await teams
        .find({ slug: { $type: 'string' } }, { projection: { slug: 1 } })
        .toArray()
    ).map((team) => team.slug)
  )

  await forEachSequentially(missing, async (team) => {
    const slug = firstFreeSlug(deriveTeamSlug(team.name), (candidate) =>
      taken.has(candidate)
    )

    await teams.updateOne({ _id: team._id }, { $set: { slug } })

    taken.add(slug)
  })

  return { modifiedCount: missing.length }
}

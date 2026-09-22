import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { invalidateModelsCache } from '#/services/models-service.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const modelsSeed = JSON.parse(
  readFileSync(path.join(dirname, 'models.seed.json'), 'utf8')
)

/**
 * Idempotently applies the versioned model catalogue seed to MongoDB.
 * @param {import('mongodb').Db} db
 * @param {import('pino').Logger} logger
 */
export async function seedModels(db, logger) {
  const collection = db.collection('models')
  const now = new Date().toISOString()

  for (const model of modelsSeed) {
    await collection.updateOne(
      { slug: model.slug },
      { $set: { ...model, updatedAt: now } },
      { upsert: true }
    )
  }

  invalidateModelsCache()

  logger.info(
    `Seeded ${modelsSeed.length} models (seedVersion ${modelsSeed[0]?.seedVersion})`
  )
}

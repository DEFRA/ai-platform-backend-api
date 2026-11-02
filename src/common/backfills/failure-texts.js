import { supportReferenceOf } from '#/operations/support-reference.js'

// The failure texts stored on `teamDeployments` entries before 2 November
// 2026, and what they say now: no "platform engineers have been alerted", no
// cloud or tool names. The page tells people to contact AI Platform Support.
const REWRITES = new Map([
  [
    'The apply failed and platform engineers have been alerted',
    'The deployment failed'
  ],
  [
    'The apply failed again after a fresh retry, so the change was reverted',
    'The deployment failed again after a fresh retry, so the change was reverted'
  ],
  [
    'The change has not progressed in time and platform engineers have been alerted',
    'The setup did not finish in time'
  ],
  [
    'The apply failed and the revert was cancelled; platform engineers have been alerted',
    'The deployment failed and the revert was cancelled'
  ],
  [
    'The apply failed again after a fresh retry and reverting the change failed too, so platform engineers have been alerted',
    'The deployment failed again after a fresh retry and reverting the change failed too'
  ]
])

const OLD_REMOVE_FAILED =
  'The model could not be removed, so it is still deployed; platform engineers have been alerted'

/**
 * The failure text an entry should show now, or null when it already does.
 * @param {string} text - the stored `failureReason`
 * @param {string|undefined} operationId - the entry's operation, for the support reference
 * @returns {string|null}
 */
export function currentFailureText(text, operationId) {
  const rewritten =
    text === OLD_REMOVE_FAILED
      ? `The model could not be removed, so it is still deployed. Contact AI Platform Support, quoting reference ${supportReferenceOf(operationId)}`
      : (REWRITES.get(text) ??
        text
          .replace(' in Azure (', ' (')
          .replace('be found in Azure', 'be found')
          .replace(' Ask the AI Platform team to check and retry.', ''))

  return rewritten === text ? null : rewritten
}

function updatesFor(doc) {
  return doc.deployments.flatMap((entry) => {
    const text =
      typeof entry.failureReason === 'string'
        ? currentFailureText(entry.failureReason, entry.operationId)
        : null

    return text
      ? [
          {
            updateOne: {
              filter: { _id: doc._id },
              update: { $set: { 'deployments.$[entry].failureReason': text } },
              arrayFilters: [
                {
                  'entry.id': entry.id,
                  'entry.failureReason': entry.failureReason
                }
              ]
            }
          }
        ]
      : []
  })
}

/**
 * Rewrites the stored failure text of every entry that still has an old one.
 * Each entry is updated only while it still holds the text read, so a
 * projection that wrote a newer one meanwhile is left alone.
 * @param {import('mongodb').Db} db
 * @returns {Promise<{modifiedCount: number}>}
 */
export async function rewriteFailureTexts(db) {
  const docs = await db
    .collection('teamDeployments')
    .find({ 'deployments.failureReason': { $type: 'string' } })
    .toArray()
  const operations = docs.flatMap(updatesFor)

  if (operations.length === 0) {
    return { modifiedCount: 0 }
  }

  const { modifiedCount } = await db
    .collection('teamDeployments')
    .bulkWrite(operations)

  return { modifiedCount }
}

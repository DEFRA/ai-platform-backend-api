// Persistence of the `operations` collection (plan 5): one document per
// operation, written by compare-and-set on `stateVersion` so a slower writer
// never overwrites a newer one. Every function takes the `db`; none holds a
// connection, so the handler, the relay and the sweeper share it freely.

const COLLECTION = 'operations'
const DUPLICATE_KEY = 11000

/**
 * @param {import('mongodb').Db} db
 */
export function operationsOf(db) {
  return db.collection(COLLECTION)
}

/**
 * Whether a write failed on a unique index.
 * @param {Error & {code?: number}} error
 * @returns {boolean}
 */
export function isDuplicateKey(error) {
  return error?.code === DUPLICATE_KEY
}

/**
 * The indexes of the collection (plan 5, "operations collection").
 * @param {import('mongodb').Db} db
 */
export async function createOperationIndexes(db) {
  const operations = operationsOf(db)

  // A replay of any merged request finds its operation. Partial: external
  // operations and reverts carry no keys.
  await operations.createIndex(
    { teamId: 1, idempotencyKeys: 1 },
    {
      unique: true,
      partialFilterExpression: { idempotencyKeys: { $type: 'string' } }
    }
  )
  // One active and one waiting operation per team file.
  await operations.createIndex(
    { environment: 1, teamId: 1, slot: 1 },
    { unique: true, partialFilterExpression: { slot: { $exists: true } } }
  )
  // An external operation is recorded once per run.
  await operations.createIndex(
    { externalKey: 1 },
    {
      unique: true,
      partialFilterExpression: { externalKey: { $type: 'string' } }
    }
  )
  await operations.createIndex({ teamId: 1, environment: 1, state: 1 })
  // The sweeps.
  await operations.createIndex(
    { outboxPending: 1 },
    { partialFilterExpression: { outboxPending: true } }
  )
  await operations.createIndex(
    { deadlineAt: 1 },
    { partialFilterExpression: { slot: { $exists: true } } }
  )
  // An ended operation whose follow-up (freeing its file) is not done yet.
  await operations.createIndex(
    { followUp: 1, deadlineAt: 1 },
    { partialFilterExpression: { followUp: { $exists: true } } }
  )
  await operations.createIndex(
    { 'verify.nextAt': 1 },
    { partialFilterExpression: { state: 'deployed' } }
  )
}

/**
 * Inserts a new operation. A duplicate key (a second operation for a slot,
 * a replayed idempotency key, a repeated external run) throws; see
 * `isDuplicateKey`.
 * @param {import('mongodb').Db} db
 * @param {object} operation
 * @returns {Promise<object>}
 */
export async function insertOperation(db, operation) {
  await operationsOf(db).insertOne(operation)

  return operation
}

/**
 * @param {import('mongodb').Db} db
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export function findOperation(db, id) {
  return operationsOf(db).findOne({ _id: id })
}

/**
 * The operation a request's idempotency key already created or joined.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, key: string}} params
 * @returns {Promise<object|null>}
 */
export function findByIdempotencyKey(db, { teamId, key }) {
  return operationsOf(db).findOne({ teamId, idempotencyKeys: key })
}

/**
 * The operation holding a file's `active` or `waiting` slot.
 * @param {import('mongodb').Db} db
 * @param {{environment: string, teamId: string, slot: 'active'|'waiting'}} params
 * @returns {Promise<object|null>}
 */
export function findSlotHolder(db, { environment, teamId, slot }) {
  return operationsOf(db).findOne({ environment, teamId, slot })
}

/**
 * Applies changes to an operation only while it is still at the
 * `stateVersion` read, and bumps the version: of two writers on the same
 * read, one wins and the other gets null and must re-read.
 * @param {import('mongodb').Db} db
 * @param {{_id: string, stateVersion: number}} operation
 * @param {{set?: object, unset?: string[], push?: object, addToSet?: object}} changes
 * @returns {Promise<object|null>} The operation as written, or null when it had moved.
 */
export async function compareAndSet(
  db,
  operation,
  { set = {}, unset = [], push, addToSet }
) {
  const update = { $set: set, $inc: { stateVersion: 1 } }

  if (unset.length > 0) {
    update.$unset = Object.fromEntries(unset.map((field) => [field, '']))
  }

  if (push) {
    update.$push = push
  }

  if (addToSet) {
    update.$addToSet = addToSet
  }

  return operationsOf(db).findOneAndUpdate(
    { _id: operation._id, stateVersion: operation.stateVersion },
    update,
    { returnDocument: 'after' }
  )
}

/**
 * Claims one outbox entry for `leaseMs` by compare-and-set, so two instances
 * never publish the same entry together (plan 5, DD2). An entry already
 * published, or claimed and not yet expired, is not claimable.
 * @param {import('mongodb').Db} db
 * @param {{operationId: string, commandId: string, leaseMs: number, now?: number}} params
 * @returns {Promise<boolean>} Whether this call holds the claim.
 */
export async function claimOutboxEntry(
  db,
  { operationId, commandId, leaseMs, now = Date.now() }
) {
  const { modifiedCount } = await operationsOf(db).updateOne(
    {
      _id: operationId,
      outbox: {
        $elemMatch: {
          commandId,
          publishedAt: null,
          $or: [
            { claimedUntil: null },
            { claimedUntil: { $lte: new Date(now).toISOString() } }
          ]
        }
      }
    },
    {
      $set: {
        'outbox.$.claimedUntil': new Date(now + leaseMs).toISOString()
      }
    }
  )

  return modifiedCount === 1
}

/**
 * Records an entry as published and clears `outboxPending` once none is left.
 * @param {import('mongodb').Db} db
 * @param {{operationId: string, commandId: string, at?: string}} params
 */
export async function markOutboxPublished(
  db,
  { operationId, commandId, at = new Date().toISOString() }
) {
  const operations = operationsOf(db)

  await operations.updateOne(
    { _id: operationId, 'outbox.commandId': commandId },
    { $set: { 'outbox.$.publishedAt': at, 'outbox.$.claimedUntil': null } }
  )
  await operations.updateOne(
    {
      _id: operationId,
      outbox: { $not: { $elemMatch: { publishedAt: null } } }
    },
    { $set: { outboxPending: false } }
  )
}

/**
 * Operations with an outbox entry still to publish.
 * @param {import('mongodb').Db} db
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
export function findPendingOutbox(db, limit = 100) {
  return operationsOf(db)
    .find({ outboxPending: true })
    .sort({ _id: 1 })
    .limit(limit)
    .toArray()
}

/**
 * Operations holding a slot whose deadline has passed.
 * @param {import('mongodb').Db} db
 * @param {{now?: number, limit?: number}} [params]
 * @returns {Promise<object[]>}
 */
export function findOverdue(db, { now = Date.now(), limit = 100 } = {}) {
  const due = { $lte: new Date(now).toISOString() }

  return operationsOf(db)
    .find({
      $or: [
        { slot: { $exists: true }, deadlineAt: due },
        { followUp: { $exists: true }, deadlineAt: due }
      ]
    })
    .sort({ deadlineAt: 1 })
    .limit(limit)
    .toArray()
}

/**
 * `deployed` operations whose ARM verification retry is due.
 * @param {import('mongodb').Db} db
 * @param {{now?: number, limit?: number}} [params]
 * @returns {Promise<object[]>}
 */
export function findVerificationDue(
  db,
  { now = Date.now(), limit = 100 } = {}
) {
  return operationsOf(db)
    .find({
      state: 'deployed',
      'verify.nextAt': { $lte: new Date(now).toISOString() }
    })
    .limit(limit)
    .toArray()
}

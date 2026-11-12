import { readFileSync } from 'node:fs'

import { operationsOf } from '#/operations/operation-repository.js'
import {
  CHECKS_FAILED,
  COMMITTED,
  RANK,
  TIMED_OUT
} from '#/operations/operation-state-machine.js'

// The platform-owned research team file, `environments/{env}/research.json`,
// served for any environment; a copy of infradev's in the GitOps fixtures
// (only gpt-4o deployed) so research is usable in local development.
const RESEARCH_FILE_PATH = /^environments\/([^/]+)\/research\.json$/
const PLACEHOLDER_SHA = '0000000000000000000000000000000000000001'
const researchFixture = JSON.parse(
  readFileSync(
    new URL(
      '../common/fixtures/gitops/ai-platform-tenants/environments/infradev/research.json',
      import.meta.url
    ),
    'utf8'
  )
)

// The operations whose change is on `main` for a path: those ranked from
// `committed` up, except a refused change, which ranks as high but never
// reached `main`, and a timed-out one that had got that far. Derived from the
// state table, never restated.
const COMMITTED_STATES = Object.entries(RANK)
  .filter(([state, rank]) => rank >= RANK[COMMITTED] && state !== CHECKS_FAILED)
  .map(([state]) => state)

// Newest commit first: a retried operation can commit after a newer one, so
// creation order is only the tie-break.
const NEWEST_COMMIT_FIRST = { 'gitops.committedAt': -1, createdAt: -1, _id: -1 }

let attachedDatabase = null

/**
 * Gives the shared mock reader the database the mock transport runs on: the
 * mock keeps no files, so what `main` would hold is what its operations
 * committed. The mock transport calls this when the server starts.
 * @param {import('mongodb').Db|null} db
 */
export function attachMockTeamFileDatabase(db) {
  attachedDatabase = db
}

function committedOn(path, extra = {}) {
  return {
    'target.path': path,
    $or: [
      { state: { $in: COMMITTED_STATES } },
      { state: TIMED_OUT, leftState: { $in: COMMITTED_STATES } }
    ],
    ...extra
  }
}

// The file after the newest commit that matches: its document, or none when
// that commit deleted the file (a revert of a new file has none) or there is
// no commit.
async function fileAfterNewest(db, filter) {
  const operation = await operationsOf(db)
    .find(filter, { projection: { document: 1, 'gitops.commitSha': 1 } })
    .sort(NEWEST_COMMIT_FIRST)
    .limit(1)
    .next()

  return operation?.document
    ? {
        document: JSON.parse(operation.document),
        sha: operation.gitops?.commitSha ?? PLACEHOLDER_SHA
      }
    : { document: null, sha: null }
}

// The file as it was before the commit: after the newest change committed
// before it. Null when the commit made the file, or is not one the mock made.
async function fileBefore(db, path, commitSha) {
  const commit = await operationsOf(db).findOne(
    { 'target.path': path, 'gitops.commitSha': commitSha },
    { projection: { 'gitops.committedAt': 1 } }
  )
  const committedAt = commit?.gitops?.committedAt

  if (!committedAt) {
    return { document: null }
  }

  const { document } = await fileAfterNewest(
    db,
    committedOn(path, { 'gitops.committedAt': { $lt: committedAt } })
  )

  return { document }
}

/**
 * Creates a mock `TeamFileReader` for local development and tests: no
 * network. It serves the research file as the platform holds it, and for any
 * other file what the newest committed change left (a change refused by the
 * checks is never served; a committed deletion leaves no file), so a team's
 * second change is built on its first, and a revert restores the file before
 * the commit, as against `main`. With no database, or no such operation, a
 * team starts from nothing (revision 1).
 * @param {{getDatabase?: () => import('mongodb').Db|null}} [options]
 * @returns {import('./team-file-reader.js').TeamFileReader}
 */
export function createMockTeamFileReader({
  getDatabase = () => attachedDatabase
} = {}) {
  return {
    async getCurrentDocument({ path } = {}) {
      const environment = RESEARCH_FILE_PATH.exec(path ?? '')?.[1]

      if (environment) {
        return {
          document: { ...structuredClone(researchFixture), environment },
          sha: PLACEHOLDER_SHA
        }
      }

      const db = getDatabase()

      return path && db
        ? fileAfterNewest(db, committedOn(path))
        : { document: null, sha: null }
    },

    async getPreviousDocument({ path, commitSha } = {}) {
      const db = getDatabase()

      return path && db ? fileBefore(db, path, commitSha) : { document: null }
    }
  }
}

/**
 * The shared mock reader, on the database the mock transport attached.
 * @type {import('./team-file-reader.js').TeamFileReader}
 */
export const mockTeamFileReader = createMockTeamFileReader()

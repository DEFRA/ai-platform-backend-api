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

// The states of an operation whose document is on `main`: those ranked from
// `committed` up, except a refused change, which ranks as high but never
// reached `main`. Derived from the state table, never restated.
const COMMITTED_STATES = Object.entries(RANK)
  .filter(([state, rank]) => rank >= RANK[COMMITTED] && state !== CHECKS_FAILED)
  .map(([state]) => state)

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

// The newest document an operation on this path committed, as `main` would
// hold it: operations on one file never overlap, so the newest by creation is
// the newest commit. A timed-out operation counts when it had got that far.
async function newestCommitted(db, path) {
  const operation = await operationsOf(db)
    .find(
      {
        'target.path': path,
        document: { $exists: true },
        $or: [
          { state: { $in: COMMITTED_STATES } },
          { state: TIMED_OUT, leftState: { $in: COMMITTED_STATES } }
        ]
      },
      { projection: { document: 1, 'gitops.commitSha': 1 } }
    )
    .sort({ createdAt: -1, _id: -1 })
    .limit(1)
    .next()

  return operation
    ? {
        document: JSON.parse(operation.document),
        sha: operation.gitops?.commitSha ?? PLACEHOLDER_SHA
      }
    : { document: null, sha: null }
}

/**
 * Creates a mock `TeamFileReader` for local development and tests: no
 * network. It serves the research file as the platform holds it, and for any
 * other file the document of the newest operation that reached `committed`
 * (a change refused by the checks is never served), so a team's second change
 * is built on its first, as against `main`. With no database, or no such
 * operation, a team starts from nothing (revision 1).
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
        ? newestCommitted(db, path)
        : { document: null, sha: null }
    },

    async getPreviousDocument() {
      return { document: null }
    }
  }
}

/**
 * The shared mock reader, on the database the mock transport attached.
 * @type {import('./team-file-reader.js').TeamFileReader}
 */
export const mockTeamFileReader = createMockTeamFileReader()

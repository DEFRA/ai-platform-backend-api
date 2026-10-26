import { readFileSync } from 'node:fs'

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

/**
 * Mock `TeamFileReader` for local development and tests: no network. It
 * keeps no files, so every team starts from nothing (a document built
 * against it is always revision 1), except the research file it serves.
 * @type {import('./team-file-reader.js').TeamFileReader}
 */
export const mockTeamFileReader = {
  async getCurrentDocument({ path } = {}) {
    const environment = RESEARCH_FILE_PATH.exec(path ?? '')?.[1]

    return environment
      ? {
          document: { ...structuredClone(researchFixture), environment },
          sha: PLACEHOLDER_SHA
        }
      : { document: null, sha: null }
  },

  async getPreviousDocument() {
    return { document: null }
  }
}

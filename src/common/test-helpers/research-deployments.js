import { vi } from 'vitest'

import { mockTeamFileReader } from '#/adapters/mock-team-file-reader.js'
import { clearResearchDeploymentsCache } from '#/services/research-deployments.js'

const RESEARCH_FILE_PATH = /^environments\/[^/]+\/research\.json$/

let spy = null

/**
 * Test helper: makes the mock team file reader's research file deploy
 * exactly these catalogue slugs (each `active`), in place of its default
 * (gpt-4o), and forgets the cached read. Every other file is served as the
 * mock always does. Undo with `restoreResearchDeployments`.
 * @param {string[]} slugs
 */
export function deployInResearch(slugs) {
  restoreResearchDeployments()

  const original =
    mockTeamFileReader.getCurrentDocument.bind(mockTeamFileReader)

  spy = vi
    .spyOn(mockTeamFileReader, 'getCurrentDocument')
    .mockImplementation(async (params) => {
      const { document } = await original(params)

      if (!RESEARCH_FILE_PATH.test(params?.path ?? '')) {
        return { document }
      }

      return {
        document: {
          ...document,
          deployments: slugs.map((slug) => ({
            slug,
            sku: 'Standard',
            capacity: 1,
            status: 'active'
          }))
        }
      }
    })
  clearResearchDeploymentsCache()
}

/**
 * Test helper: makes reading the research file fail, as a GitHub outage
 * would, and forgets the cached read. Undo with `restoreResearchDeployments`.
 */
export function failResearchRead() {
  restoreResearchDeployments()

  spy = vi
    .spyOn(mockTeamFileReader, 'getCurrentDocument')
    .mockRejectedValue(new Error('GitHub is down'))
}

/**
 * Test helper: puts the mock reader back as it was and forgets the
 * cached research deployments.
 */
export function restoreResearchDeployments() {
  spy?.mockRestore()
  spy = null
  clearResearchDeploymentsCache()
}

import { mockTeamFileReader } from '#/adapters/mock-team-file-reader.js'
import { describeTeamFileReaderContract } from '#/adapters/team-file-reader-contract.js'

describeTeamFileReaderContract('mock', () => mockTeamFileReader)

describe('#mockTeamFileReader', () => {
  test('serves the research file for any environment with a placeholder sha', async () => {
    const current = await mockTeamFileReader.getCurrentDocument({
      path: 'environments/sandbox/research.json'
    })

    expect(current.document.environment).toBe('sandbox')
    expect(current.document.deployments).toEqual(expect.any(Array))
    expect(current.sha).toMatch(/^[0-9a-f]{40}$/)
  })

  test('returns a fresh document on every read', async () => {
    const path = 'environments/infradev/research.json'
    const first = await mockTeamFileReader.getCurrentDocument({ path })

    first.document.environment = 'changed'

    const second = await mockTeamFileReader.getCurrentDocument({ path })

    expect(second.document.environment).toBe('infradev')
  })

  test.each(['environments/infradev/alpha.json', undefined])(
    'returns nulls for %s',
    async (path) => {
      await expect(
        mockTeamFileReader.getCurrentDocument(path ? { path } : undefined)
      ).resolves.toEqual({ document: null, sha: null })
    }
  )
})

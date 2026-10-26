/**
 * Shared `TeamFileReader` contract suite, run against every implementation
 * (the nocked GitHub reader, the mock reader) so each is a drop-in for the
 * other: a missing file reads as nulls, never an error, and a result has
 * exactly the port's keys.
 * @param {string} name
 * @param {() => import('./team-file-reader.js').TeamFileReader} createReader
 * @param {{arrange?: () => void}} [options] - `arrange` makes the backing store hold no team file and no previous version
 */
export function describeTeamFileReaderContract(
  name,
  createReader,
  { arrange = () => {} } = {}
) {
  const path = 'environments/infradev/contract-team.json'

  describe(`TeamFileReader contract: ${name}`, () => {
    test('getCurrentDocument returns a null document and sha for a team with no file', async () => {
      arrange()

      const current = await createReader().getCurrentDocument({ path })

      expect(current).toEqual({ document: null, sha: null })
      expect(Object.keys(current).sort()).toEqual(['document', 'sha'])
    })

    test('getPreviousDocument returns a null document for a file that did not exist before the commit', async () => {
      arrange()

      const previous = await createReader().getPreviousDocument({
        path,
        commitSha: 'contract-commit-sha'
      })

      expect(previous).toEqual({ document: null })
      expect(Object.keys(previous)).toEqual(['document'])
    })
  })
}

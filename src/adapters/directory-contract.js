/**
 * Shared `Directory` contract suite, run against every implementation (the
 * mock, the nocked Graph adapter) so each is a drop-in for the other: a
 * result has exactly the port's keys, nobody matching reads as an empty list,
 * and an unknown person reads as null, never an error.
 * @param {string} name
 * @param {(params: {people: import('./directory.js').DirectoryPerson[]}) => import('./directory.js').Directory} createDirectory - a directory that holds exactly these people
 */
export function describeDirectoryContract(name, createDirectory) {
  const userAssertion = 'user-token'
  const byName = (a, b) => a.localeCompare(b, 'en')
  const ada = {
    oid: '11111111-2222-4333-8444-555555555555',
    displayName: 'Ada Contract',
    mail: 'ada.contract@defra.gov.uk',
    userPrincipalName: 'ada.contract@defra.gov.uk'
  }
  const portKeys = ['displayName', 'mail', 'oid', 'userPrincipalName']

  describe(`Directory contract: ${name}`, () => {
    test('searchPeople returns a matching person with exactly the port keys', async () => {
      const directory = createDirectory({ people: [ada] })

      const people = await directory.searchPeople({
        userAssertion,
        query: 'ada'
      })

      expect(people).toEqual([ada])
      expect(Object.keys(people[0]).sort(byName)).toEqual(portKeys)
    })

    test('searchPeople returns an empty list when nobody matches', async () => {
      const directory = createDirectory({ people: [] })

      await expect(
        directory.searchPeople({ userAssertion, query: 'zzzz' })
      ).resolves.toEqual([])
    })

    test('getPerson returns the person with exactly the port keys', async () => {
      const directory = createDirectory({ people: [ada] })

      const person = await directory.getPerson({ userAssertion, oid: ada.oid })

      expect(person).toEqual(ada)
      expect(Object.keys(person).sort(byName)).toEqual(portKeys)
    })

    test('getPerson returns null for a person the directory does not hold', async () => {
      const directory = createDirectory({ people: [] })

      await expect(
        directory.getPerson({ userAssertion, oid: ada.oid })
      ).resolves.toBeNull()
    })
  })
}

/**
 * The checks every `UsageReader` must pass, so the mock and the Log Analytics
 * reader are interchangeable. `arrange` seeds the reader for `team-a` in
 * `infradev` with one call on 2026-11-02.
 * @param {string} name
 * @param {() => import('#/adapters/usage-reader.js').UsageReader} createReader
 * @param {{arrange?: () => void}} [options]
 */
export function describeUsageReaderContract(
  name,
  createReader,
  { arrange = () => {} } = {}
) {
  describe(`UsageReader contract: ${name}`, () => {
    const window = {
      environment: 'infradev',
      from: '2026-11-01',
      to: '2026-11-08'
    }

    beforeEach(arrange)

    test('names where its figures come from', () => {
      expect(['log-analytics', 'mock']).toContain(createReader().source)
    })

    test('returns rows of counts only, inside the window', async () => {
      const rows = await createReader().readUsage({
        ...window,
        teamSlug: 'team-a'
      })

      expect(Array.isArray(rows)).toBe(true)

      for (const row of rows) {
        expect(Object.keys(row).sort((a, b) => a.localeCompare(b))).toEqual([
          'completionTokens',
          'day',
          'deployment',
          'promptTokens',
          'requests',
          'teamSlug'
        ])
        expect(row.day.localeCompare(window.from)).toBeGreaterThanOrEqual(0)
        expect(row.day.localeCompare(window.to)).toBeLessThan(0)
        expect(row.teamSlug).toBe('team-a')
        expect(row.deployment.startsWith('team-a-')).toBe(true)
        expect(Number.isInteger(row.requests)).toBe(true)
        expect(Number.isInteger(row.promptTokens)).toBe(true)
        expect(Number.isInteger(row.completionTokens)).toBe(true)
      }
    })

    test('reads another team as a different set of rows', async () => {
      const rows = await createReader().readUsage({
        ...window,
        teamSlug: 'team-b'
      })

      expect(rows.every((row) => row.teamSlug === 'team-b')).toBe(true)
    })
  })
}

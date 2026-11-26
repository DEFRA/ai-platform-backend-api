import { createMockUsageReader } from '#/adapters/mock-usage-reader.js'
import { describeUsageReaderContract } from '#/adapters/usage-reader-contract.js'

describeUsageReaderContract('mock', createMockUsageReader)

describe('#createMockUsageReader', () => {
  const window = {
    environment: 'infradev',
    from: '2026-11-01',
    to: '2026-11-04'
  }

  test('gives the same figures every time for the same team', async () => {
    const reader = createMockUsageReader()
    const first = await reader.readUsage({ ...window, teamSlug: 'team-a' })
    const second = await reader.readUsage({ ...window, teamSlug: 'team-a' })

    expect(first).toEqual(second)
    expect(first.length).toBeGreaterThan(0)
  })

  test('has a row per day and model across the window, end excluded', async () => {
    const rows = await createMockUsageReader().readUsage({
      ...window,
      teamSlug: 'team-a'
    })

    expect(new Set(rows.map((row) => row.day))).toEqual(
      new Set(['2026-11-01', '2026-11-02', '2026-11-03'])
    )
  })

  test('invents no team: every API at once is empty', async () => {
    expect(await createMockUsageReader().readUsage(window)).toEqual([])
  })

  test('refuses an environment name that is not one', async () => {
    await expect(
      createMockUsageReader().readUsage({ ...window, environment: 'No Way' })
    ).rejects.toMatchObject({ code: 'usage-not-available' })
  })

  test('serves a personal key as calls through the Research API', async () => {
    const rows = await createMockUsageReader().readUsage({
      ...window,
      subscriptionId: 'sub-1'
    })

    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => row.teamSlug === 'research')).toBe(true)
  })

  test('has a few refused days, the same every time, inside the window', async () => {
    const reader = createMockUsageReader()
    const wide = {
      environment: 'infradev',
      from: '2026-11-01',
      to: '2026-12-01'
    }
    const first = await reader.readRefusals({ ...wide, teamSlug: 'team-a' })

    expect(first).toEqual(
      await reader.readRefusals({ ...wide, teamSlug: 'team-a' })
    )
    expect(
      first.every(
        (row) => row.day >= wide.from && row.day < wide.to && row.refused > 0
      )
    ).toBe(true)
  })

  test('refuses an environment name that is not one when counting refusals', async () => {
    await expect(
      createMockUsageReader().readRefusals({
        ...window,
        environment: 'No Way',
        teamSlug: 'x'
      })
    ).rejects.toMatchObject({ code: 'usage-not-available' })
  })
})

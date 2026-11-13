import { connectionDetailsOf } from '#/adapters/team-connection-details-registry.js'

const params = { team: { slug: 'alpha' }, environment: 'infradev' }

describe('#connectionDetailsOf', () => {
  test('gives the fixture’s placeholder details while the team’s credentials are mocked', async () => {
    const fixture = {
      detailsFor: vi.fn().mockResolvedValue({ placeholder: true })
    }
    const issuers = { isMockedFor: vi.fn().mockReturnValue(true) }

    await expect(
      connectionDetailsOf(params, { issuers, fixture })
    ).resolves.toEqual({ placeholder: true })
    expect(issuers.isMockedFor).toHaveBeenCalledWith('team')
    expect(fixture.detailsFor).toHaveBeenCalledWith(params)
  })

  test('gives none, not invented ones, once the team’s credentials are real', async () => {
    const fixture = { detailsFor: vi.fn() }
    const issuers = { isMockedFor: vi.fn().mockReturnValue(false) }

    await expect(
      connectionDetailsOf(params, { issuers, fixture })
    ).resolves.toBeNull()
    expect(fixture.detailsFor).not.toHaveBeenCalled()
  })

  test('uses the configured credential issuers and the fixture by default, which the tests mock', async () => {
    const details = await connectionDetailsOf(params)

    expect(details).toMatchObject({ placeholder: true })
  })
})

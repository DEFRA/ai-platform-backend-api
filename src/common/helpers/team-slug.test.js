import {
  TEAM_SLUG_PATTERN,
  deriveTeamSlug,
  withSlugSuffix
} from '#/common/helpers/team-slug.js'

describe('#deriveTeamSlug', () => {
  test.each([
    ['Flood Risk Team', 'flood-risk-team'],
    ['  Spaced   Out  ', 'spaced-out'],
    ['Data Team!', 'data-team'],
    ['Équipe Données', 'equipe-donnees'],
    ['2026 Rainfall Team', 'rainfall-team'],
    [
      'A Very Long Team Name That Runs Past The Limit',
      'a-very-long-team-name-th'
    ]
  ])('derives %s as %s', (name, expected) => {
    expect(deriveTeamSlug(name)).toBe(expected)
    expect(deriveTeamSlug(name)).toMatch(TEAM_SLUG_PATTERN)
  })

  test.each(['123', '!!!', 'ab'])(
    'falls back to team when %s leaves too little to use',
    (name) => {
      expect(deriveTeamSlug(name)).toBe('team')
    }
  )
})

describe('#withSlugSuffix', () => {
  test('numbers a short slug', () => {
    expect(withSlugSuffix('data-team', 2)).toBe('data-team-2')
  })

  test('keeps a numbered slug within the pattern', () => {
    const numbered = withSlugSuffix('a-very-long-team-name', 10)

    expect(numbered).toBe('a-very-long-team-name-10')
    expect(numbered).toMatch(TEAM_SLUG_PATTERN)
  })

  test('does not leave a trailing hyphen before the number', () => {
    expect(withSlugSuffix('team-name-x-truncated-he', 2)).toBe(
      'team-name-x-truncated-2'
    )
  })
})

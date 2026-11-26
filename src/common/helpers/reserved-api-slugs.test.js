import { config } from '#/config.js'
import { isReservedApiSlug } from '#/common/helpers/reserved-api-slugs.js'

describe('#isReservedApiSlug', () => {
  test('reserves the Research tier, by name', () => {
    expect(isReservedApiSlug('research')).toBe(true)
  })

  test('reserves whichever API the research tier is configured on', () => {
    const configured = config.get('apim.researchApiId')

    config.set('apim.researchApiId', 'shared-research')

    try {
      expect(isReservedApiSlug('shared-research')).toBe(true)
    } finally {
      config.set('apim.researchApiId', configured)
    }
  })

  test.each(['flood', 'research-2', 'my-research', ''])(
    'leaves %j to a team',
    (slug) => {
      expect(isReservedApiSlug(slug)).toBe(false)
    }
  )
})

import { uuidv7 } from '#/common/helpers/uuid-v7.js'

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('#uuidv7', () => {
  test('has the version 7 and variant bits', () => {
    expect(uuidv7()).toMatch(UUID_V7)
  })

  test('starts with the millisecond time, so later IDs sort later', () => {
    const earlier = uuidv7(1_700_000_000_000)
    const later = uuidv7(1_700_000_000_001)

    expect(earlier.replace('-', '').slice(0, 12)).toBe(
      (1_700_000_000_000).toString(16).padStart(12, '0')
    )
    expect(earlier < later).toBe(true)
  })

  test('does not repeat within one millisecond', () => {
    const ids = new Set(Array.from({ length: 200 }, () => uuidv7(1)))

    expect(ids.size).toBe(200)
  })
})

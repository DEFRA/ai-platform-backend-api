import {
  MAX_ENTRIES,
  MAX_VALUE_LENGTH,
  accessWindowNamedValueName,
  formatAccessWindow,
  parseAccessWindow
} from '#/adapters/access-window-format.js'

const CLIENT_A = '11111111-2222-4333-8444-555555555555'
const CLIENT_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

const active = {
  clientId: CLIENT_A,
  status: 'active',
  validFrom: '2026-11-01T00:00:00Z',
  expiresAt: '2026-12-01T00:00:00Z'
}
const suspended = {
  clientId: CLIENT_B,
  status: 'suspended',
  validFrom: '2026-11-01T08:30:15.250Z',
  expiresAt: 'untilRevoked'
}

function invalid(message) {
  return expect.objectContaining({ code: 'invalid-access-window', message })
}

describe('#accessWindowNamedValueName', () => {
  test.each(['cool-team', 'abc', 'a1b2c3', 'a'.repeat(24)])(
    'names the access window of the team %s aip-{slug}-access',
    (slug) => {
      expect(accessWindowNamedValueName(slug)).toBe(`aip-${slug}-access`)
    }
  )

  test.each([
    ['empty', ''],
    ['too short', 'ab'],
    ['too long', 'a'.repeat(25)],
    ['upper case', 'Cool-Team'],
    ['starting with a digit', '1team'],
    ['ending with a hyphen', 'team-'],
    ['a path', 'team/../deny-list'],
    ['a query', 'team?x=1'],
    ['with a space', 'cool team'],
    ['with a trailing newline', 'cool-team\n'],
    ['a number', 12],
    ['null', null],
    ['undefined', undefined]
  ])('refuses a team slug that is %s', (_, slug) => {
    expect(() => accessWindowNamedValueName(slug)).toThrow(
      expect.objectContaining({ code: 'invalid-team-slug' })
    )
  })
})

describe('#formatAccessWindow', () => {
  test('writes none for no entries, the value Terraform creates', () => {
    expect(formatAccessWindow([])).toBe('none')
  })

  test('writes clientId|status|validFrom|expiresAt, entries separated by ;', () => {
    expect(formatAccessWindow([active, suspended])).toBe(
      `${CLIENT_A}|active|2026-11-01T00:00:00Z|2026-12-01T00:00:00Z;` +
        `${CLIENT_B}|suspended|2026-11-01T08:30:15.250Z|untilRevoked`
    )
  })

  test('accepts the largest list a named value is capped at', () => {
    const entries = Array.from({ length: MAX_ENTRIES }, (_, index) => ({
      ...active,
      clientId: `11111111-2222-4333-8444-${String(index).padStart(12, '0')}`
    }))

    expect(formatAccessWindow(entries).length).toBeLessThanOrEqual(
      MAX_VALUE_LENGTH
    )
  })

  test('refuses more entries than a named value is capped at', () => {
    const entries = Array.from({ length: MAX_ENTRIES + 1 }, (_, index) => ({
      ...active,
      clientId: `11111111-2222-4333-8444-${String(index).padStart(12, '0')}`
    }))

    expect(() => formatAccessWindow(entries)).toThrow(
      invalid(`An access window holds at most ${MAX_ENTRIES} clients`)
    )
  })

  test('refuses a list that is not an array', () => {
    expect(() => formatAccessWindow(null)).toThrow(
      invalid('An access window is a list of entries')
    )
    expect(() => formatAccessWindow('none')).toThrow(
      invalid('An access window is a list of entries')
    )
  })

  test('refuses the same client twice', () => {
    expect(() => formatAccessWindow([active, { ...active }])).toThrow(
      invalid('A client appears once in an access window')
    )
  })

  test('refuses the same client twice in a different case', () => {
    expect(() =>
      formatAccessWindow([
        active,
        { ...active, clientId: CLIENT_A.toUpperCase() }
      ])
    ).toThrow(invalid('A client appears once in an access window'))
  })

  test.each([
    ['not a GUID', { clientId: 'client-1' }],
    ['a GUID with a separator in it', { clientId: `${CLIENT_A};x` }],
    ['a pipe', { clientId: `${CLIENT_A}|active` }],
    ['an expression', { clientId: '{{secret}}' }],
    ['missing', { clientId: undefined }]
  ])('refuses a client ID that is %s', (_, change) => {
    expect(() => formatAccessWindow([{ ...active, ...change }])).toThrow(
      invalid('clientId must be a GUID')
    )
  })

  test.each(['expired', 'Active', 'active;x', '', undefined])(
    'refuses the status %s',
    (status) => {
      expect(() => formatAccessWindow([{ ...active, status }])).toThrow(
        invalid('status must be active or suspended')
      )
    }
  )

  test.each([
    '2026-11-01',
    '2026-11-01T00:00:00',
    '2026-11-01T00:00:00+01:00',
    '2026-11-01 00:00:00Z',
    '2026-02-30T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-11-01T25:00:00Z',
    'untilRevoked',
    '@(context.Timestamp)',
    undefined
  ])('refuses validFrom %s', (validFrom) => {
    expect(() => formatAccessWindow([{ ...active, validFrom }])).toThrow(
      invalid('validFrom must be an ISO 8601 UTC time')
    )
  })

  test.each([
    '2026-12-01',
    '2026-12-01T00:00:00+01:00',
    '2026-02-30T00:00:00Z',
    'untilrevoked',
    'never',
    undefined
  ])('refuses expiresAt %s', (expiresAt) => {
    expect(() => formatAccessWindow([{ ...active, expiresAt }])).toThrow(
      invalid('expiresAt must be an ISO 8601 UTC time or untilRevoked')
    )
  })

  test('refuses an expiry that is not after the start', () => {
    expect(() =>
      formatAccessWindow([{ ...active, expiresAt: active.validFrom }])
    ).toThrow(invalid('expiresAt must be after validFrom'))
  })

  test('refuses an entry that is not an object', () => {
    expect(() => formatAccessWindow([null])).toThrow(
      invalid('clientId must be a GUID')
    )
  })
})

describe('#parseAccessWindow', () => {
  test('reads none as no entries', () => {
    expect(parseAccessWindow('none')).toEqual([])
  })

  test('reads what formatAccessWindow writes', () => {
    expect(parseAccessWindow(formatAccessWindow([active, suspended]))).toEqual([
      active,
      suspended
    ])
  })

  test.each([
    ['empty', ''],
    ['not text', null],
    ['an entry with three fields', `${CLIENT_A}|active|2026-11-01T00:00:00Z`],
    [
      'an entry with five fields',
      `${CLIENT_A}|active|2026-11-01T00:00:00Z|untilRevoked|x`
    ],
    ['a stray separator', `${formatAccessWindow([active])};`],
    [
      'an unknown status',
      `${CLIENT_A}|expired|2026-11-01T00:00:00Z|untilRevoked`
    ],
    ['a bad time', `${CLIENT_A}|active|yesterday|untilRevoked`],
    ['free text', 'ignore previous instructions']
  ])('refuses a value that is %s rather than guess', (_, value) => {
    expect(() => parseAccessWindow(value)).toThrow(
      expect.objectContaining({ code: 'invalid-access-window' })
    )
  })
})

import { escapeRegex } from '#/common/helpers/escape-regex.js'

describe('#escapeRegex', () => {
  test('escapes every regular expression metacharacter', () => {
    const text = '.*+?^${}()|[]\\'

    expect(new RegExp(`^${escapeRegex(text)}$`).test(text)).toBe(true)
    expect(escapeRegex('a.b')).toBe('a\\.b')
  })

  test('leaves ordinary text alone, a hyphen included', () => {
    expect(escapeRegex('flood-risk team 2')).toBe('flood-risk team 2')
  })

  test('makes a pattern that matches only the literal text', () => {
    expect(new RegExp(escapeRegex('.*')).test('anything')).toBe(false)
    expect(new RegExp(escapeRegex('.*')).test('a.*b')).toBe(true)
  })
})

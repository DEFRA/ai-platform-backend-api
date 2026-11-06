import { describe, expect, test } from 'vitest'

import { keyHintFor } from '#/adapters/key-hint.js'

describe('keyHintFor', () => {
  test('is the last four characters of the secret', () => {
    expect(keyHintFor('abcdefgh')).toBe('efgh')
  })

  test('is the whole secret when it is shorter than four characters', () => {
    expect(keyHintFor('ab')).toBe('ab')
  })
})

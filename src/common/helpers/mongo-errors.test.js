import { isDuplicateKeyError } from '#/common/helpers/mongo-errors.js'

describe('#isDuplicateKeyError', () => {
  test('recognises MongoDB code 11000', () => {
    expect(isDuplicateKeyError({ code: 11000 })).toBe(true)
  })

  test('is false for any other error, or none', () => {
    expect(isDuplicateKeyError({ code: 121 })).toBe(false)
    expect(isDuplicateKeyError(new Error('boom'))).toBe(false)
    expect(isDuplicateKeyError(undefined)).toBe(false)
  })
})

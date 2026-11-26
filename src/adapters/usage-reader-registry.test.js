import { selectUsageReader } from '#/adapters/usage-reader-registry.js'

const mock = { source: 'mock' }
const live = { source: 'log-analytics' }
const readers = { mock, 'log-analytics': live }

describe('#selectUsageReader', () => {
  test('picks the reader for the mode', () => {
    expect(selectUsageReader(readers, 'mock', 'dev')).toBe(mock)
    expect(selectUsageReader(readers, 'log-analytics', 'prod')).toBe(live)
  })

  test('refuses the mock in prod, where invented figures must never show', () => {
    expect(() => selectUsageReader(readers, 'mock', 'prod')).toThrow(
      'USAGE_MODE must not be "mock" in the prod environment'
    )
  })

  test('refuses a mode with no reader, including an inherited property name', () => {
    expect(() => selectUsageReader(readers, 'nope', 'dev')).toThrow(
      'No usage reader for usage mode "nope"'
    )
    expect(() => selectUsageReader(readers, 'toString', 'dev')).toThrow(
      'No usage reader'
    )
  })
})

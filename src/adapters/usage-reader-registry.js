import { config } from '#/config.js'
import { mockUsageReader } from '#/adapters/mock-usage-reader.js'
import { createLogAnalyticsUsageReader } from '#/adapters/azure/log-analytics-usage-reader.js'

/**
 * Picks the `UsageReader` for a usage mode, as the directory registry does:
 * the mock is refused in the prod environment, where invented figures must
 * never stand beside real ones.
 * @param {Record<string, import('#/adapters/usage-reader.js').UsageReader>} readersByMode
 * @param {string} mode - `mock` or `log-analytics`
 * @param {string} cdpEnvironment
 * @returns {import('#/adapters/usage-reader.js').UsageReader}
 */
export function selectUsageReader(readersByMode, mode, cdpEnvironment) {
  if (cdpEnvironment === 'prod' && mode === 'mock') {
    throw new Error('USAGE_MODE must not be "mock" in the prod environment')
  }

  const selected = Object.hasOwn(readersByMode, mode)
    ? readersByMode[mode]
    : undefined

  if (!selected) {
    throw new Error(`No usage reader for usage mode "${mode}"`)
  }

  return selected
}

export const usageReaderRegistry = {
  current: selectUsageReader(
    {
      mock: mockUsageReader,
      'log-analytics': createLogAnalyticsUsageReader()
    },
    config.get('usage.mode'),
    config.get('cdpEnvironment')
  )
}

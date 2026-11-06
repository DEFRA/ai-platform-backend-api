import { describe, expect, test } from 'vitest'

import { forEachSequentially, mapSequentially } from './sequential.js'

const tick = () => new Promise((resolve) => setTimeout(resolve, 1))

describe('mapSequentially', () => {
  test('runs steps one at a time, in order, and returns results in order', async () => {
    const events = []

    const results = await mapSequentially([3, 1, 2], async (item, index) => {
      events.push(`start-${item}`)
      await tick()
      events.push(`end-${item}`)
      return `${index}:${item}`
    })

    expect(results).toEqual(['0:3', '1:1', '2:2'])
    expect(events).toEqual([
      'start-3',
      'end-3',
      'start-1',
      'end-1',
      'start-2',
      'end-2'
    ])
  })

  test('resolves to an empty array for no items', async () => {
    expect(await mapSequentially([], () => 1)).toEqual([])
  })

  test('stops at the first rejection and runs no later step', async () => {
    const seen = []

    await expect(
      mapSequentially([1, 2, 3], async (item) => {
        seen.push(item)
        if (item === 2) {
          throw new Error('boom')
        }
      })
    ).rejects.toThrow('boom')

    expect(seen).toEqual([1, 2])
  })
})

describe('forEachSequentially', () => {
  test('runs every step in order and resolves with nothing', async () => {
    const seen = []

    const result = await forEachSequentially(
      new Set(['a', 'b']),
      async (item) => {
        await tick()
        seen.push(item)
      }
    )

    expect(result).toBeUndefined()
    expect(seen).toEqual(['a', 'b'])
  })
})

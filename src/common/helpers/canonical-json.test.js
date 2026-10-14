import { readFileSync } from 'node:fs'

import {
  canonicalJson,
  compareCodeUnits,
  isCanonical,
  sortKeys
} from '#/common/helpers/canonical-json.js'

// Byte-exact copies of ai-platform-infra's examples/, the GitOps contract's
// shared fixtures - the backend must reproduce their bytes exactly.
const EXAMPLES = [
  'ai-platform-tenants/environments/infradev/alpha.json',
  'ai-platform-tenants/environments/infradev/beta.json',
  'ai-platform-deployments/environments/infradev/platform.json'
]

function readExample(path) {
  return readFileSync(
    new URL(`../fixtures/gitops/${path}`, import.meta.url),
    'utf8'
  )
}

function shuffleKeys(value) {
  if (Array.isArray(value)) {
    return value.map(shuffleKeys)
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .reverse()
        .map((key) => [key, shuffleKeys(value[key])])
    )
  }

  return value
}

describe('#canonicalJson', () => {
  test.each(EXAMPLES)(
    'reproduces the infra example %s byte for byte from a reordered document',
    (path) => {
      const text = readExample(path)

      expect(canonicalJson(shuffleKeys(JSON.parse(text)))).toBe(text)
    }
  )

  test('sorts keys at every level, keeps array order and ends with one LF', () => {
    const text = canonicalJson({ b: [{ z: 1, a: 2 }, 'x'], a: null })

    expect(text).toBe(
      '{\n  "a": null,\n  "b": [\n    {\n      "a": 2,\n      "z": 1\n    },\n    "x"\n  ]\n}\n'
    )
    expect(text).not.toContain('\r')
  })

  test('orders keys by UTF-16 code unit, as the workflows do, not by locale', () => {
    const keys = ['b', 'é', 'aa', 'Z', '_', 'a', 'B', 'A']

    expect(
      Object.keys(
        JSON.parse(canonicalJson(Object.fromEntries(keys.map((k) => [k, 1]))))
      )
    ).toEqual(['A', 'B', 'Z', '_', 'a', 'aa', 'b', 'é'])
  })
})

describe('#isCanonical', () => {
  test('accepts the infra example text as already canonical', () => {
    expect(isCanonical(readExample(EXAMPLES[0]))).toBe(true)
  })

  test('rejects text with unsorted keys, CRLF line endings or invalid JSON', () => {
    expect(isCanonical('{\n  "b": 1,\n  "a": 2\n}\n')).toBe(false)
    expect(isCanonical('{\r\n  "a": 1\r\n}\r\n')).toBe(false)
    expect(isCanonical('{not json')).toBe(false)
  })
})

describe('#sortKeys', () => {
  test('returns primitives unchanged', () => {
    expect(sortKeys('text')).toBe('text')
    expect(sortKeys(3)).toBe(3)
    expect(sortKeys(null)).toBeNull()
  })
})

describe('#compareCodeUnits', () => {
  test('orders exactly as the default sort does, and ties equal strings', () => {
    const keys = ['b', 'é', 'aa', 'Z', '_', 'a', 'B', 'A']

    expect([...keys].sort(compareCodeUnits)).toEqual([...keys].sort())
    expect(compareCodeUnits('a', 'a')).toBe(0)
  })
})

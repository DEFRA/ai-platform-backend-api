import nock from 'nock'
import { Octokit } from 'octokit'

import {
  createConditionalReader,
  isRateLimited
} from '#/adapters/github/github-conditional-reader.js'

// The repo's global test setup (.vite/setup-files.js) replaces global.fetch
// with vitest-fetch-mock for every file - undo that here so nock, which
// intercepts at the undici level, actually sees Octokit's requests.
const realFetch = globalThis.fetch

beforeAll(() => {
  globalThis.fetch = realFetch
})

const GITHUB_API = 'https://api.github.com'
const ROUTE = 'GET /repos/{owner}/{repo}/actions/runs/{run_id}'

function createOctokit() {
  return new Octokit({ request: { retries: 0 }, throttle: { enabled: false } })
}

function params(runId = 1) {
  return { owner: 'DEFRA', repo: 'ai-platform-tenants', run_id: runId }
}

function runPath(runId = 1) {
  return `/repos/DEFRA/ai-platform-tenants/actions/runs/${runId}`
}

describe('#createConditionalReader', () => {
  let clock

  beforeEach(() => {
    clock = 1_000_000
  })

  afterEach(() => {
    nock.cleanAll()
  })

  function createReader(options = {}) {
    return createConditionalReader({ now: () => clock, ...options })
  }

  test('revalidates with the last ETag and returns the cached body on 304', async () => {
    const reader = createReader()
    const octokit = createOctokit()
    let revalidatedWith

    nock(GITHUB_API)
      .get(runPath())
      .reply(200, { status: 'in_progress' }, { etag: '"etag-1"' })
    nock(GITHUB_API)
      .get(runPath())
      .reply(function () {
        revalidatedWith = this.req.headers['if-none-match']
        return [304, '']
      })

    await reader.read(octokit, ROUTE, params())
    const second = await reader.read(octokit, ROUTE, params())

    expect(revalidatedWith).toBe('"etag-1"')
    expect(second).toEqual({ status: 'in_progress' })
  })

  describe('after a secondary rate limit', () => {
    let reader
    let octokit

    beforeEach(async () => {
      reader = createReader()
      octokit = createOctokit()

      nock(GITHUB_API)
        .get(runPath())
        .reply(
          403,
          { message: 'secondary rate limit' },
          { 'retry-after': '120' }
        )

      await expect(reader.read(octokit, ROUTE, params())).rejects.toMatchObject(
        {
          code: 'github-rate-limited',
          retryAt: new Date(1_000_000 + 120_000).toISOString()
        }
      )
    })

    test('fails fast without calling GitHub until the wait is over', async () => {
      const call = nock(GITHUB_API).get(runPath()).reply(200, {})

      clock += 119_000

      await expect(reader.read(octokit, ROUTE, params())).rejects.toMatchObject(
        { code: 'github-rate-limited' }
      )
      expect(call.isDone()).toBe(false)
    })

    test('calls GitHub again once the wait is over', async () => {
      nock(GITHUB_API).get(runPath()).reply(200, { status: 'completed' })

      clock += 120_000

      await expect(reader.read(octokit, ROUTE, params())).resolves.toEqual({
        status: 'completed'
      })
    })

    test('doubles the wait when GitHub limits the next call too', async () => {
      nock(GITHUB_API)
        .get(runPath())
        .reply(429, {}, { 'x-ratelimit-remaining': '0' })

      clock += 120_000

      await expect(reader.read(octokit, ROUTE, params())).rejects.toMatchObject(
        {
          retryAt: new Date(clock + 240_000).toISOString()
        }
      )
    })
  })

  test('waits until the primary rate limit resets', async () => {
    const reader = createReader()
    const resetAtSeconds = clock / 1000 + 300

    nock(GITHUB_API)
      .get(runPath())
      .reply(
        403,
        {},
        {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(resetAtSeconds)
        }
      )

    await expect(
      reader.read(createOctokit(), ROUTE, params())
    ).rejects.toMatchObject({
      retryAt: new Date(resetAtSeconds * 1000).toISOString()
    })
  })

  test('forgets the oldest URL once the cache is full', async () => {
    const reader = createReader({ maxCachedUrls: 1 })
    const octokit = createOctokit()
    let revalidatedWith = 'not-called'

    nock(GITHUB_API).get(runPath(1)).reply(200, {}, { etag: '"etag-1"' })
    nock(GITHUB_API).get(runPath(2)).reply(200, {}, { etag: '"etag-2"' })
    nock(GITHUB_API)
      .get(runPath(1))
      .reply(function () {
        revalidatedWith = this.req.headers['if-none-match']
        return [200, {}]
      })

    await reader.read(octokit, ROUTE, params(1))
    await reader.read(octokit, ROUTE, params(2))
    await reader.read(octokit, ROUTE, params(1))

    expect(revalidatedWith).toBeUndefined()
  })

  test('passes other errors through without backing off', async () => {
    const reader = createReader()
    const octokit = createOctokit()

    nock(GITHUB_API).get(runPath()).reply(500, { message: 'outage' })
    nock(GITHUB_API).get(runPath()).reply(200, { status: 'queued' })

    await expect(reader.read(octokit, ROUTE, params())).rejects.toMatchObject({
      status: 500
    })
    await expect(reader.read(octokit, ROUTE, params())).resolves.toEqual({
      status: 'queued'
    })
  })
})

describe('#isRateLimited', () => {
  test('treats a 403 with no rate limit headers as a permission error', () => {
    expect(isRateLimited({ status: 403, response: { headers: {} } })).toBe(
      false
    )
  })

  test('treats a 429 with retry-after as a rate limit', () => {
    expect(
      isRateLimited({
        status: 429,
        response: { headers: { 'retry-after': '1' } }
      })
    ).toBe(true)
  })
})

import { Boom } from '#/common/helpers/boom-with-code.js'
import { config } from '#/config.js'
import { mockTenantOrchestrator } from '#/adapters/mock-tenant-orchestrator.js'
import {
  clearResearchDeploymentsCache,
  readResearchDeployments
} from '#/services/research-deployments.js'

const RESEARCH_PATH = 'environments/infradev/research.json'

function registryServing(document) {
  return {
    key: 'test',
    orchestrator: {
      getCurrentDocument: vi.fn(async () => ({ document }))
    }
  }
}

// A registry whose read stays pending until `finish` is called.
function registryWithDeferredRead(document) {
  let finish
  const registry = {
    key: 'test',
    orchestrator: {
      getCurrentDocument: vi.fn(
        () =>
          new Promise((resolve) => {
            finish = () => resolve({ document })
          })
      )
    }
  }

  return { registry, finish: () => finish() }
}

function researchFile(deployments) {
  return { team: { slug: 'research' }, deployments }
}

describe('#readResearchDeployments', () => {
  beforeEach(() => {
    clearResearchDeploymentsCache()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('reads the research file of the research environment from the orchestrator', async () => {
    const registry = registryServing(researchFile([]))

    await readResearchDeployments({ registry })

    expect(registry.orchestrator.getCurrentDocument).toHaveBeenCalledWith({
      path: RESEARCH_PATH
    })
  })

  test('returns the slugs of the active deployments only', async () => {
    const registry = registryServing(
      researchFile([
        { slug: 'gpt-4o', status: 'active' },
        { slug: 'gpt-5-nano', status: 'pending' },
        { slug: 'gpt-4-1-nano', status: 'removed' },
        { slug: 'no-status' }
      ])
    )

    expect(await readResearchDeployments({ registry })).toEqual(
      new Set(['gpt-4o'])
    )
  })

  test('reads the mock orchestrator’s research file as gpt-4o only', async () => {
    const slugs = await readResearchDeployments({
      registry: { key: 'mock', orchestrator: mockTenantOrchestrator }
    })

    expect(slugs).toEqual(new Set(['gpt-4o']))
  })

  test.each([
    ['no file', null],
    ['a file without deployments', {}]
  ])('treats %s as nothing deployed', async (_name, document) => {
    expect(
      await readResearchDeployments({ registry: registryServing(document) })
    ).toEqual(new Set())
  })

  describe('cache', () => {
    test('reads once while the cache is fresh, then again once it has expired', async () => {
      vi.useFakeTimers()
      const registry = registryServing(
        researchFile([{ slug: 'gpt-4o', status: 'active' }])
      )

      await readResearchDeployments({ registry })
      vi.advanceTimersByTime(59_999)
      await readResearchDeployments({ registry })

      expect(registry.orchestrator.getCurrentDocument).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(1)
      await readResearchDeployments({ registry })

      expect(registry.orchestrator.getCurrentDocument).toHaveBeenCalledTimes(2)
    })

    test('shares one read between requests made at the same time', async () => {
      const registry = registryServing(researchFile([]))

      await Promise.all([
        readResearchDeployments({ registry }),
        readResearchDeployments({ registry })
      ])

      expect(registry.orchestrator.getCurrentDocument).toHaveBeenCalledTimes(1)
    })

    test('keeps sharing a slow read that outlasts the cache duration, counting the duration from when it succeeds', async () => {
      vi.useFakeTimers()
      const { registry, finish } = registryWithDeferredRead(
        researchFile([{ slug: 'gpt-4o', status: 'active' }])
      )

      const first = readResearchDeployments({ registry })
      vi.advanceTimersByTime(120_000)
      const second = readResearchDeployments({ registry })
      finish()

      expect(await first).toEqual(new Set(['gpt-4o']))
      expect(await second).toEqual(new Set(['gpt-4o']))
      expect(registry.orchestrator.getCurrentDocument).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(59_999)
      await readResearchDeployments({ registry })

      expect(registry.orchestrator.getCurrentDocument).toHaveBeenCalledTimes(1)
    })

    describe('with the cache off', () => {
      beforeEach(() => {
        config.set('research.deploymentsCacheMs', 0)
      })

      afterEach(() => {
        config.set('research.deploymentsCacheMs', 60000)
      })

      test('still shares a read made at the same time, and reads again once it has finished', async () => {
        const { registry, finish } = registryWithDeferredRead(researchFile([]))

        const first = readResearchDeployments({ registry })
        const second = readResearchDeployments({ registry })
        finish()
        await Promise.all([first, second])

        expect(registry.orchestrator.getCurrentDocument).toHaveBeenCalledTimes(
          1
        )

        const third = readResearchDeployments({ registry })
        finish()
        await third

        expect(registry.orchestrator.getCurrentDocument).toHaveBeenCalledTimes(
          2
        )
      })
    })

    test('does not share a read between orchestrators', async () => {
      const first = registryServing(
        researchFile([{ slug: 'gpt-4o', status: 'active' }])
      )
      const second = registryServing(null)

      await readResearchDeployments({ registry: first })

      expect(await readResearchDeployments({ registry: second })).toEqual(
        new Set()
      )
    })
  })

  describe('when the file cannot be read', () => {
    function failingRegistry() {
      return {
        key: 'test',
        orchestrator: {
          getCurrentDocument: vi.fn(async () => {
            throw new Error('GitHub is down')
          })
        }
      }
    }

    test('refuses as 502 research-deployments-unavailable', async () => {
      const error = await readResearchDeployments({
        registry: failingRegistry()
      }).catch((caught) => caught)

      expect(Boom.isBoom(error, 502)).toBe(true)
      expect(error.data.code).toBe('research-deployments-unavailable')
      expect(error.message).not.toContain('GitHub is down')
    })

    test('does not cache the failure, so the next read tries again', async () => {
      const registry = failingRegistry()

      await expect(readResearchDeployments({ registry })).rejects.toThrow()
      registry.orchestrator.getCurrentDocument.mockResolvedValueOnce({
        document: researchFile([{ slug: 'gpt-4o', status: 'active' }])
      })

      expect(await readResearchDeployments({ registry })).toEqual(
        new Set(['gpt-4o'])
      )
      expect(registry.orchestrator.getCurrentDocument).toHaveBeenCalledTimes(2)
    })
  })
})

import { describeAccessWindowStoreContract } from '#/adapters/access-window-store-contract.js'
import {
  createMockAccessWindowStore,
  mockAccessWindowStore
} from '#/adapters/mock-access-window-store.js'

describeAccessWindowStoreContract('mock', createMockAccessWindowStore)

describe('#createMockAccessWindowStore', () => {
  const entry = {
    clientId: '11111111-2222-4333-8444-555555555555',
    status: 'active',
    validFrom: '2026-11-01T00:00:00Z',
    expiresAt: 'untilRevoked'
  }

  test('hands out a copy, so changing what it read does not change the window', async () => {
    const store = createMockAccessWindowStore()

    await store.write({
      environment: 'infradev',
      teamSlug: 'cool-team',
      entries: [entry]
    })

    const read = await store.read({
      environment: 'infradev',
      teamSlug: 'cool-team'
    })
    read[0].status = 'suspended'

    await expect(
      store.read({ environment: 'infradev', teamSlug: 'cool-team' })
    ).resolves.toEqual([entry])
  })

  test('is one store for the whole process, so a write is seen by the next read', async () => {
    await mockAccessWindowStore.write({
      environment: 'infradev',
      teamSlug: 'shared-team',
      entries: [entry]
    })

    await expect(
      mockAccessWindowStore.read({
        environment: 'infradev',
        teamSlug: 'shared-team'
      })
    ).resolves.toEqual([entry])
  })

  test('refuses a missing environment', async () => {
    await expect(
      createMockAccessWindowStore().read({ teamSlug: 'cool-team' })
    ).rejects.toMatchObject({ code: 'environment-not-configured' })
  })
})

import { randomUUID } from 'node:crypto'

import { describeServicePrincipalSwitchContract } from '#/adapters/service-principal-switch-contract.js'
import {
  createMockServicePrincipalSwitch,
  mockServicePrincipalSwitch
} from '#/adapters/mock-service-principal-switch.js'

describeServicePrincipalSwitchContract('mock', createMockServicePrincipalSwitch)

describe('#createMockServicePrincipalSwitch', () => {
  test('records the last state it was set to, per environment and object', async () => {
    const objectId = randomUUID()
    const switchBoard = createMockServicePrincipalSwitch()

    expect(switchBoard.enabledState('infradev', objectId)).toBeUndefined()

    await switchBoard.setAccountEnabled({
      environment: 'infradev',
      objectId,
      enabled: false
    })

    expect(switchBoard.enabledState('infradev', objectId)).toBe(false)
    expect(switchBoard.enabledState('sandbox', objectId)).toBeUndefined()

    await switchBoard.setAccountEnabled({
      environment: 'infradev',
      objectId,
      enabled: true
    })

    expect(switchBoard.enabledState('infradev', objectId)).toBe(true)
  })

  test('keeps a refused request from changing anything', async () => {
    const objectId = randomUUID()
    const switchBoard = createMockServicePrincipalSwitch()

    await switchBoard.setAccountEnabled({
      environment: 'infradev',
      objectId,
      enabled: false
    })
    await switchBoard
      .setAccountEnabled({ environment: 'infradev', objectId, enabled: 'yes' })
      .catch(() => {})

    expect(switchBoard.enabledState('infradev', objectId)).toBe(false)
  })

  test('is one switch for the whole process', async () => {
    const objectId = randomUUID()

    await mockServicePrincipalSwitch.setAccountEnabled({
      environment: 'infradev',
      objectId,
      enabled: false
    })

    expect(mockServicePrincipalSwitch.enabledState('infradev', objectId)).toBe(
      false
    )
  })
})

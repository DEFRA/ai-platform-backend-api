import { eventIdOf } from '#/services/admin-idempotency.js'

describe('#admin-idempotency', () => {
  describe('eventIdOf', () => {
    test('names the action, the team, the environment and the key', () => {
      expect(
        eventIdOf('admin.credentials.disable', {
          teamId: 't1',
          environment: 'dev',
          idempotencyKey: 'k1'
        })
      ).toBe('admin.credentials.disable:t1:dev:k1')
    })

    test('leaves the environment out for an action of the whole team', () => {
      expect(
        eventIdOf('admin.team.disable', { teamId: 't1', idempotencyKey: 'k1' })
      ).toBe('admin.team.disable:t1:k1')
    })
  })
})

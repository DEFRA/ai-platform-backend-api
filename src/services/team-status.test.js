import { TEAM_STATUS, statusOf } from '#/services/team-status.js'

describe('#team-status', () => {
  test('names the three statuses', () => {
    expect(TEAM_STATUS).toEqual({
      active: 'active',
      disabled: 'disabled',
      pendingRemoval: 'pending-removal'
    })
    expect(Object.isFrozen(TEAM_STATUS)).toBe(true)
  })

  test('reads the status a team holds', () => {
    expect(statusOf({ status: 'disabled' })).toBe('disabled')
    expect(statusOf({ status: 'pending-removal' })).toBe('pending-removal')
  })

  test('reads an absent status, and no team, as active', () => {
    expect(statusOf({})).toBe('active')
    expect(statusOf({ status: undefined })).toBe('active')
    expect(statusOf(null)).toBe('active')
    expect(statusOf(undefined)).toBe('active')
  })
})

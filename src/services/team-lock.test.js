import { randomUUID } from 'node:crypto'

import { ObjectId } from 'mongodb'

import {
  LOCK_SCOPE,
  TEAM_DISABLED,
  disabledEnvironmentsOf,
  isEnvironmentDisabled,
  isTeamDisabled,
  requireTeamChangeAllowed
} from '#/services/team-lock.js'
import { actorFor } from '#/common/test-helpers/portal-token.js'

describe('#team-lock', () => {
  describe('disabledEnvironmentsOf', () => {
    test.each([
      ['no team', null, []],
      ['a team with no list (never disabled)', { status: 'active' }, []],
      ['an empty list', { disabledEnvironments: [] }, []],
      ['a list', { disabledEnvironments: ['dev', 'test'] }, ['dev', 'test']]
    ])('reads %s', (_name, team, expected) => {
      expect(disabledEnvironmentsOf(team)).toEqual(expected)
    })
  })

  describe('isTeamDisabled', () => {
    test.each([
      ['no team', null, false],
      ['a team with no status', {}, false],
      ['an active team', { status: 'active' }, false],
      ['a team pending removal', { status: 'pending-removal' }, false],
      ['a disabled team', { status: 'disabled' }, true]
    ])('is %s', (_name, team, expected) => {
      expect(isTeamDisabled(team)).toBe(expected)
    })
  })

  describe('isEnvironmentDisabled', () => {
    test('is true only for an environment in the list, whatever the status', () => {
      const team = { status: 'active', disabledEnvironments: ['dev'] }

      expect(isEnvironmentDisabled(team, 'dev')).toBe(true)
      expect(isEnvironmentDisabled(team, 'test')).toBe(false)
    })

    test('is false for a team with no list, and for no team', () => {
      expect(isEnvironmentDisabled({ status: 'disabled' }, 'dev')).toBe(false)
      expect(isEnvironmentDisabled(null, 'dev')).toBe(false)
    })
  })

  describe('requireTeamChangeAllowed', () => {
    let server
    let db

    beforeAll(async () => {
      // Dynamic import needed due to config being updated by vitest-mongodb
      const { createServer } = await import('#/server.js')

      server = await createServer()
      await server.initialize()
      db = server.db
    })

    afterAll(async () => {
      await server.stop({ timeout: 0 })
    })

    const actor = actorFor('lock-member')

    async function teamWith(fields) {
      const name = `Lock team ${randomUUID().slice(0, 8)}`
      const { insertedId } = await db.collection('teams').insertOne({
        name,
        normalisedName: name.toLowerCase().replaceAll(' ', '-'),
        slug: name.toLowerCase().replaceAll(' ', '-'),
        ...fields
      })

      return insertedId.toString()
    }

    function attempt(teamId, scope, environment = 'dev') {
      return requireTeamChangeAllowed(db, {
        actor,
        role: 'admin',
        teamId,
        environment,
        scope
      })
    }

    function denials(teamId) {
      return db
        .collection('auditEvents')
        .find({ action: 'access.denied', teamId })
        .toArray()
    }

    test.each([
      ['a team that was never disabled', {}],
      ['an active team', { status: 'active', disabledEnvironments: [] }],
      ['a team pending removal', { status: 'pending-removal' }]
    ])('allows a team change for %s', async (_name, fields) => {
      const teamId = await teamWith(fields)

      await expect(attempt(teamId, LOCK_SCOPE.team)).resolves.toBeUndefined()
      expect(await denials(teamId)).toEqual([])
    })

    test('refuses a team change for a disabled team, with or without environments', async () => {
      const bare = await teamWith({ status: 'disabled' })
      const listed = await teamWith({
        status: 'disabled',
        disabledEnvironments: ['dev']
      })

      for (const teamId of [bare, listed]) {
        await expect(attempt(teamId, LOCK_SCOPE.team)).rejects.toMatchObject({
          output: { statusCode: 409 },
          data: { code: TEAM_DISABLED }
        })
      }
    })

    test('refuses an environment change only in a disabled environment', async () => {
      const teamId = await teamWith({
        status: 'disabled',
        disabledEnvironments: ['dev']
      })

      await expect(
        attempt(teamId, LOCK_SCOPE.environment, 'dev')
      ).rejects.toMatchObject({ data: { code: TEAM_DISABLED } })
      await expect(
        attempt(teamId, LOCK_SCOPE.environment, 'test')
      ).resolves.toBeUndefined()
    })

    test('refuses an environment change after a partial enable left the environment disabled', async () => {
      const teamId = await teamWith({
        status: 'active',
        disabledEnvironments: ['dev']
      })

      await expect(
        attempt(teamId, LOCK_SCOPE.environment, 'dev')
      ).rejects.toMatchObject({ data: { code: TEAM_DISABLED } })
      await expect(attempt(teamId, LOCK_SCOPE.team)).resolves.toBeUndefined()
    })

    test('allows an environment change for a team disabled with no environment', async () => {
      const teamId = await teamWith({ status: 'disabled' })

      await expect(
        attempt(teamId, LOCK_SCOPE.environment, 'dev')
      ).resolves.toBeUndefined()
    })

    test('says the team can be viewed but not changed, and never why', async () => {
      const teamId = await teamWith({
        status: 'disabled',
        disabledEnvironments: ['dev']
      })
      const error = await attempt(teamId, LOCK_SCOPE.team).catch((e) => e)

      expect(error.message).toBe(
        'This team is disabled. You can view it but not change it.'
      )
      expect(error.output.payload).not.toHaveProperty('reason')
      expect(error.data).toEqual({ code: TEAM_DISABLED })
    })

    test('audits the refusal as an access.denied of the team and the environment', async () => {
      const teamId = await teamWith({
        status: 'disabled',
        disabledEnvironments: ['dev']
      })

      await attempt(teamId, LOCK_SCOPE.environment, 'dev').catch(() => null)

      expect(await denials(teamId)).toEqual([
        expect.objectContaining({
          resource: 'team',
          resourceId: teamId,
          teamId,
          environment: 'dev',
          role: 'admin',
          outcome: 'failure',
          code: TEAM_DISABLED,
          actorUserId: actor.userId,
          reason: null
        })
      ])
    })

    test('reads the team when it is called, so a disable that landed since the caller looked is seen, and a check that passed does not hold a later disable off (best effort, not a lock)', async () => {
      const teamId = await teamWith({ status: 'active' })

      await expect(attempt(teamId, LOCK_SCOPE.team)).resolves.toBeUndefined()

      await db
        .collection('teams')
        .updateOne(
          { _id: new ObjectId(teamId) },
          { $set: { status: 'disabled' } }
        )

      await expect(attempt(teamId, LOCK_SCOPE.team)).rejects.toMatchObject({
        data: { code: TEAM_DISABLED }
      })
    })

    test('allows the change when the team has gone, or the id names no team', async () => {
      await expect(
        attempt(new ObjectId().toString(), LOCK_SCOPE.team)
      ).resolves.toBeUndefined()
      await expect(
        attempt('not-an-object-id', LOCK_SCOPE.team)
      ).resolves.toBeUndefined()
    })
  })
})

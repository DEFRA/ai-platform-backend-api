import { ObjectId } from 'mongodb'

import {
  SYSTEM_ACTOR,
  auditDeployment
} from '#/services/team-deployment-entries.js'
import {
  SYSTEM_PRINCIPAL_ID,
  systemActor
} from '#/common/helpers/auth/system-actor.js'
import { actorFor } from '#/common/test-helpers/portal-token.js'

describe('#auditDeployment', () => {
  let server
  let db

  beforeAll(async () => {
    const { createServer } = await import('#/server.js')

    server = await createServer()
    await server.initialize()
    db = server.db
  })

  afterAll(async () => {
    await server.stop({ timeout: 0 })
  })

  const eventFor = (id) =>
    db.collection('auditEvents').findOne({ resourceId: id })

  test('names the same principal as the system actor', () => {
    expect(SYSTEM_ACTOR).toBe(SYSTEM_PRINCIPAL_ID)
    expect(systemActor.userId).toBe(SYSTEM_ACTOR)
  })

  test("records the backend's own step as the system, with no person or tenant", async () => {
    await auditDeployment(
      db,
      { id: 'entry-system' },
      { action: 'deployment.step' }
    )

    expect(await eventFor('entry-system')).toMatchObject({
      actorUserId: SYSTEM_PRINCIPAL_ID,
      role: 'system',
      oid: null,
      tid: null,
      azp: null,
      uti: null
    })
  })

  test('records a step that names the system principal as the system, too', async () => {
    await auditDeployment(
      db,
      { id: 'entry-system-id' },
      { action: 'deployment.step', actorUserId: SYSTEM_ACTOR }
    )

    expect(await eventFor('entry-system-id')).toMatchObject({
      actorUserId: SYSTEM_PRINCIPAL_ID,
      role: 'system',
      oid: null
    })
  })

  test('records a step on behalf of a named person by that person, not as the system', async () => {
    await auditDeployment(
      db,
      { id: 'entry-named' },
      { action: 'deployment.step', actorUserId: 'person-2' }
    )

    expect(await eventFor('entry-named')).toMatchObject({
      actorUserId: 'person-2',
      role: null
    })
  })

  test("records a person's request by that person, with the role it used", async () => {
    await auditDeployment(
      db,
      { id: 'entry-person' },
      {
        action: 'deployment.request',
        actor: actorFor('person-1'),
        role: 'admin'
      }
    )

    expect(await eventFor('entry-person')).toMatchObject({
      actorUserId: 'person-1',
      role: 'admin'
    })
  })

  describe('the team and environment of the event', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })
    async function insertFile(entryId) {
      const teamId = new ObjectId().toString()

      await db.collection('teamDeployments').insertOne({
        teamId,
        environment: 'sandbox',
        deployments: [{ id: entryId }]
      })

      return teamId
    }

    test('are read from the team file holding the entry when a caller passes only its id', async () => {
      const teamId = await insertFile('entry-located')

      await auditDeployment(
        db,
        { id: 'entry-located' },
        { action: 'deployment.step' }
      )

      expect(await eventFor('entry-located')).toMatchObject({
        teamId,
        environment: 'sandbox'
      })
    })

    test('are the ones the caller passes, without a read, when it knows them', async () => {
      const findOne = vi.spyOn(
        db.collection('teamDeployments').constructor.prototype,
        'findOne'
      )

      await auditDeployment(
        db,
        { id: 'entry-told' },
        {
          action: 'deployment.request',
          teamId: 'team-told',
          environment: 'dev'
        }
      )

      expect(findOne).not.toHaveBeenCalled()
      expect(await eventFor('entry-told')).toMatchObject({
        teamId: 'team-told',
        environment: 'dev'
      })
    })

    test('are left out, and the event is still written, when no team file holds the entry', async () => {
      await auditDeployment(
        db,
        { id: 'entry-gone' },
        { action: 'deployment.step' }
      )

      const event = await eventFor('entry-gone')

      expect(event).toMatchObject({ action: 'deployment.step' })
      expect(event).not.toHaveProperty('teamId')
      expect(event).not.toHaveProperty('environment')
    })

    test('are left out, and the event is still written, when the read fails', async () => {
      await insertFile('entry-unreadable')
      vi.spyOn(
        db.collection('teamDeployments').constructor.prototype,
        'findOne'
      ).mockRejectedValueOnce(new Error('read failed'))

      await auditDeployment(
        db,
        { id: 'entry-unreadable' },
        { action: 'deployment.step' }
      )

      const event = await eventFor('entry-unreadable')

      expect(event).toMatchObject({ action: 'deployment.step' })
      expect(event).not.toHaveProperty('teamId')
    })
  })
})

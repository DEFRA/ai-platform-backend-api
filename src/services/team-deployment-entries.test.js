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
})

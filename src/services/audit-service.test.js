import { recordAuditEvent } from '#/services/audit-service.js'
import {
  SYSTEM_PRINCIPAL_ID,
  systemActor
} from '#/common/helpers/auth/system-actor.js'

describe('#recordAuditEvent', () => {
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

  const actor = {
    kind: 'user',
    userId: 'user-record-1',
    oid: 'oid-1',
    tid: 'tid-1',
    azp: 'azp-1',
    uti: 'uti-1',
    email: 'someone@defra.gov.uk',
    name: 'Someone',
    // A token, were one ever carried on the credentials, must not be copied
    token: 'eyJ.secret.token',
    authorization: 'Bearer eyJ.secret.token'
  }

  async function lastEvent(resourceId) {
    return db.collection('auditEvents').findOne({ resourceId })
  }

  test('records who acted, from the token, with the role used', async () => {
    await recordAuditEvent(db, {
      actor,
      role: 'admin',
      action: 'team.addMember',
      resource: 'team',
      resourceId: 'audit-actor',
      outcome: 'success'
    })

    expect(await lastEvent('audit-actor')).toMatchObject({
      actorUserId: 'user-record-1',
      oid: 'oid-1',
      tid: 'tid-1',
      azp: 'azp-1',
      uti: 'uti-1',
      role: 'admin',
      action: 'team.addMember',
      outcome: 'success'
    })
  })

  test('never records a token, or anything else the credentials carry', async () => {
    await recordAuditEvent(db, {
      actor,
      action: 'team.create',
      resource: 'team',
      resourceId: 'audit-no-token',
      outcome: 'success'
    })

    const event = await lastEvent('audit-no-token')

    expect(JSON.stringify(event)).not.toContain('eyJ')
    expect(JSON.stringify(event)).not.toContain('Bearer')
    expect(event).not.toHaveProperty('token')
    expect(event).not.toHaveProperty('authorization')
    expect(event).not.toHaveProperty('email')
  })

  test('records background work by the user it acts for, with no token fields', async () => {
    await recordAuditEvent(db, {
      actorUserId: 'user-record-2',
      action: 'credential.expire',
      resource: 'credential',
      resourceId: 'audit-background',
      outcome: 'success'
    })

    expect(await lastEvent('audit-background')).toMatchObject({
      actorUserId: 'user-record-2',
      oid: null,
      tid: null,
      azp: null,
      uti: null,
      role: null
    })
  })

  test("records the backend's own step as the system, with no person, tenant or token", async () => {
    await recordAuditEvent(db, {
      actor: systemActor,
      action: 'credential.expire',
      resource: 'credential',
      resourceId: 'audit-system',
      outcome: 'success'
    })

    expect(await lastEvent('audit-system')).toMatchObject({
      actorUserId: SYSTEM_PRINCIPAL_ID,
      role: 'system',
      oid: null,
      tid: null,
      azp: null,
      uti: null
    })
  })

  test('an explicit role wins over the system role', async () => {
    await recordAuditEvent(db, {
      actor: systemActor,
      role: 'owner',
      action: 'credential.expire',
      resource: 'credential',
      resourceId: 'audit-system-role',
      outcome: 'success'
    })

    expect((await lastEvent('audit-system-role')).role).toBe('owner')
  })

  test('records the person an action was done to as subjectOid, apart from the actor’s own oid, and none when there is none', async () => {
    const subject = '5eed0000-0000-4000-8000-000000000001'

    await recordAuditEvent(db, {
      actor,
      role: 'admin',
      action: 'team.addMember',
      resource: 'team',
      resourceId: 'audit-subject',
      outcome: 'success',
      subjectOid: subject
    })
    await recordAuditEvent(db, {
      actor,
      action: 'team.create',
      resource: 'team',
      resourceId: 'audit-no-subject',
      outcome: 'success'
    })

    expect(await lastEvent('audit-subject')).toMatchObject({
      oid: 'oid-1',
      subjectOid: subject
    })
    expect(await lastEvent('audit-no-subject')).not.toHaveProperty('subjectOid')
  })

  test('an explicit actorUserId wins over the actor', async () => {
    await recordAuditEvent(db, {
      actor,
      actorUserId: 'someone-else',
      action: 'credential.issue',
      resource: 'credential',
      resourceId: 'audit-explicit',
      outcome: 'failure',
      code: 'upstream-unavailable'
    })

    expect(await lastEvent('audit-explicit')).toMatchObject({
      actorUserId: 'someone-else',
      oid: 'oid-1',
      code: 'upstream-unavailable'
    })
  })
})

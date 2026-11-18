import { randomUUID } from 'node:crypto'

import { actorFor } from '#/common/test-helpers/portal-token.js'

const ACTOR = actorFor('pending-audit-admin', { isPlatformAdmin: true })

describe('#admin-pending-audit', () => {
  let server
  let db
  let pending

  beforeAll(async () => {
    // Dynamic imports needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')

    server = await createServer()
    await server.initialize()
    db = server.db
    pending = await import('#/services/admin-pending-audit.js')
  })

  afterAll(async () => {
    await server.stop({ timeout: 0 })
  })

  beforeEach(async () => {
    await Promise.all(
      ['pendingAudits', 'auditEvents', 'pendingAuditHolders'].map((name) =>
        db.collection(name).deleteMany({})
      )
    )
  })

  async function holder(fields = {}) {
    const { insertedId } = await db
      .collection('pendingAuditHolders')
      .insertOne({ group: randomUUID(), ...fields })

    return insertedId
  }

  const record = (fields = {}) => ({
    actor: ACTOR,
    role: 'platform-admin',
    action: 'admin.test.change',
    resource: 'test',
    resourceId: 'r-1',
    outcome: 'success',
    ...fields
  })

  test('records a staged event under the id it was given, with its time and only the actor’s claims, then clears the marker and the stage', async () => {
    const id = `stage-${randomUUID()}`
    const _id = await holder(pending.pendingMarker(id))

    await pending.stageAudit(db, id, record({ eventId: 'event-1' }))

    const settled = await pending.settlePendingAudits(
      db,
      'pendingAuditHolders',
      { _id }
    )

    expect(settled).toEqual(['event-1'])

    const [event] = await db.collection('auditEvents').find().toArray()

    expect(event).toMatchObject({
      _id: 'event-1',
      action: 'admin.test.change',
      actorUserId: ACTOR.userId,
      oid: ACTOR.oid,
      tid: ACTOR.tid,
      azp: ACTOR.azp,
      uti: ACTOR.uti
    })
    expect(JSON.stringify(event)).not.toContain(ACTOR.email)
    expect(
      await db.collection('pendingAuditHolders').findOne({ _id })
    ).not.toHaveProperty('pendingAuditId')
    expect(await db.collection('pendingAudits').countDocuments()).toBe(0)
  })

  test('gives an event with no id one, so recording it twice cannot write it twice', async () => {
    const id = `stage-${randomUUID()}`
    const _id = await holder(pending.pendingMarker(id))
    const notify = vi.fn().mockRejectedValueOnce(new Error('down'))

    await pending.stageAudit(db, id, record())

    await expect(
      pending.settlePendingAudits(db, 'pendingAuditHolders', { _id }, notify)
    ).rejects.toThrow('down')
    await pending.settlePendingAudits(
      db,
      'pendingAuditHolders',
      { _id },
      notify
    )

    expect(await db.collection('auditEvents').countDocuments()).toBe(1)
    expect(notify).toHaveBeenCalledTimes(2)
  })

  test('hands the staged change and actor to the hook', async () => {
    const id = `stage-${randomUUID()}`
    const _id = await holder(pending.pendingMarker(id))
    const notify = vi.fn()

    await pending.stageAudit(db, id, record({ change: 'disabled' }))
    await pending.settlePendingAudits(
      db,
      'pendingAuditHolders',
      { _id },
      notify
    )

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        change: 'disabled',
        actor: {
          userId: ACTOR.userId,
          oid: ACTOR.oid,
          tid: ACTOR.tid,
          azp: ACTOR.azp,
          uti: ACTOR.uti
        }
      })
    )
  })

  test('a marker whose staged event is gone is cleared and records nothing', async () => {
    const _id = await holder(pending.pendingMarker('never-staged'))

    expect(
      await pending.settlePendingAudits(db, 'pendingAuditHolders', { _id })
    ).toEqual([])
    expect(await db.collection('auditEvents').countDocuments()).toBe(0)
    expect(
      await db.collection('pendingAuditHolders').findOne({ _id })
    ).not.toHaveProperty('pendingAuditId')
  })

  test('leaves alone a document with no marker and one that does not match', async () => {
    const id = `stage-${randomUUID()}`
    const plain = await holder()
    const other = await holder(pending.pendingMarker(id))

    await pending.stageAudit(db, id, record())

    expect(
      await pending.settlePendingAudits(db, 'pendingAuditHolders', {
        _id: plain
      })
    ).toEqual([])
    expect(await db.collection('auditEvents').countDocuments()).toBe(0)
    expect(
      await db.collection('pendingAuditHolders').findOne({ _id: other })
    ).toHaveProperty('pendingAuditId', id)
  })

  test('a discarded stage is not recorded', async () => {
    const id = `stage-${randomUUID()}`
    const _id = await holder(pending.pendingMarker(id))

    await pending.stageAudit(db, id, record())
    await pending.discardStagedAudit(db, id)

    expect(
      await pending.settlePendingAudits(db, 'pendingAuditHolders', { _id })
    ).toEqual([])
    expect(await db.collection('auditEvents').countDocuments()).toBe(0)
  })

  test('recordStagedAudit records the event once and drops the stage, and a missing stage records nothing', async () => {
    const id = `stage-${randomUUID()}`

    await pending.stageAudit(db, id, record({ eventId: 'event-staged' }))
    await pending.recordStagedAudit(db, id)
    await pending.recordStagedAudit(db, id)
    await pending.recordStagedAudit(db, 'never-staged')

    expect(await db.collection('auditEvents').countDocuments()).toBe(1)
    expect(await db.collection('pendingAudits').countDocuments()).toBe(0)
  })
})

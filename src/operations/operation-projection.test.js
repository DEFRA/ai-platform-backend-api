import { MongoClient } from 'mongodb'

import {
  appRegistrationOf,
  entryFailureReasonOf,
  entryFieldsOf,
  entryStatusOf,
  FAILURE_CODES,
  projectOperation,
  resourceListOf,
  verificationFailureText
} from '#/operations/operation-projection.js'

const AT = '2026-10-26T12:00:00.000Z'
const EARLIER = '2026-10-26T11:00:00.000Z'
const ADD = { entryId: 'entry-1', modelSlug: 'gpt-4o', change: 'add' }
const REMOVE = { entryId: 'entry-1', modelSlug: 'gpt-4o', change: 'remove' }

function operationAt(state, overrides = {}) {
  return {
    _id: 'op-1',
    teamId: 'team-1',
    environment: 'infradev',
    state,
    stateVersion: 5,
    attempt: 1,
    items: [ADD],
    gitops: {},
    ...overrides
  }
}

const PROJECT = {
  type: 'azapi_resource.foundry_project',
  name: 'aip-alpha',
  id: 'project-id'
}
const APPLICATION = {
  type: 'azuread_application.team',
  name: 'team-app',
  id: 'application-object-id'
}
const PRINCIPAL = {
  type: 'azuread_service_principal.team',
  name: 'team-sp',
  id: 'principal-object-id'
}

describe('entryStatusOf', () => {
  test.each([
    'queued',
    'requested',
    'committed',
    'deploying',
    'deployed',
    'verified',
    'active',
    'checks-failed',
    'deploy-failed',
    'timed-out'
  ])('shows the state %s of an addition as it is', (state) => {
    expect(entryStatusOf({ state }, ADD)).toBe(state)
  })

  test.each(['requested', 'committed', 'deploying', 'deployed', 'verified'])(
    'shows a removal as removing while it is %s',
    (state) => {
      expect(entryStatusOf({ state }, REMOVE)).toBe('removing')
    }
  )

  test('shows a removal as removed once it is removed', () => {
    expect(entryStatusOf({ state: 'removed' }, REMOVE)).toBe('removed')
  })

  test.each(['checks-failed', 'deploy-failed'])(
    'shows a removal that ended as %s as active, because the model is still deployed',
    (state) => {
      expect(entryStatusOf({ state }, REMOVE)).toBe('active')
    }
  )

  test('shows a timed-out removal as timed-out', () => {
    expect(entryStatusOf({ state: 'timed-out' }, REMOVE)).toBe('timed-out')
  })
})

describe('entryFailureReasonOf', () => {
  test.each([
    [FAILURE_CODES.DEPLOY_FAILED, 'The apply failed and platform engineers'],
    [FAILURE_CODES.REVERTED, 'so the change was reverted'],
    [FAILURE_CODES.TIMED_OUT, 'has not progressed in time'],
    [FAILURE_CODES.REVERT_CANCELLED, 'the revert was cancelled']
  ])('gives the text of the failure code %s', (code, text) => {
    expect(
      entryFailureReasonOf(
        { state: 'deploy-failed', error: { code, message: 'ignored' } },
        ADD
      )
    ).toContain(text)
  })

  test('gives the refusal message of the workflows for a failed check', () => {
    expect(
      entryFailureReasonOf(
        {
          state: 'checks-failed',
          error: {
            code: FAILURE_CODES.CHECKS_FAILED,
            message: 'The file failed validation'
          }
        },
        ADD
      )
    ).toBe('The file failed validation')
  })

  test('explains a failed verification from the verifier reason', () => {
    expect(
      entryFailureReasonOf(
        {
          state: 'deploy-failed',
          error: {
            code: FAILURE_CODES.VERIFY_FAILED,
            message: 'resource-unavailable'
          }
        },
        ADD
      )
    ).toBe(verificationFailureText('resource-unavailable'))
  })

  test('says a failed revert alerted engineers', () => {
    const reason = entryFailureReasonOf(
      {
        state: 'deploy-failed',
        revertFailed: true,
        error: { code: FAILURE_CODES.DEPLOY_FAILED }
      },
      ADD
    )

    expect(reason).toContain('reverting the change failed too')
    expect(reason).not.toContain('The apply failed and platform engineers')
  })

  test('ignores a failed revert once the operation is no longer deploy-failed', () => {
    expect(
      entryFailureReasonOf({ state: 'timed-out', revertFailed: true }, ADD)
    ).toBeNull()
  })

  test('has no text for an unknown code or no error', () => {
    expect(
      entryFailureReasonOf(
        { state: 'deploy-failed', error: { code: 'something-else' } },
        ADD
      )
    ).toBeNull()
    expect(entryFailureReasonOf({ state: 'requested' }, ADD)).toBeNull()
  })

  test.each(['checks-failed', 'deploy-failed'])(
    'says a removal that ended as %s left the model deployed',
    (state) => {
      expect(
        entryFailureReasonOf(
          { state, error: { code: FAILURE_CODES.DEPLOY_FAILED } },
          REMOVE
        )
      ).toBe(
        'The model could not be removed, so it is still deployed; platform engineers have been alerted'
      )
    }
  )

  test('has no failure text for a removal in flight', () => {
    expect(entryFailureReasonOf({ state: 'deploying' }, REMOVE)).toBeNull()
  })
})

describe('verificationFailureText', () => {
  test('names the reason in words and by code', () => {
    const text = verificationFailureText('no-resources')

    expect(text).toContain('the apply reported no resources for the team')
    expect(text).toContain('(no-resources)')
    expect(text).toContain('Ask the AI Platform team to check and retry.')
  })

  test('says the cause is not known for a code it has no words for', () => {
    expect(verificationFailureText('brand-new-code')).toContain(
      'the cause is not known (brand-new-code)'
    )
  })
})

describe('resourceListOf', () => {
  test('lists a Foundry project, a model deployment and an API by name and kind', () => {
    expect(
      resourceListOf(
        [
          PROJECT,
          { type: 'azapi_resource.model_deployment', name: 'gpt-4o' },
          { type: 'azurerm_api_management_api.team', name: 'alpha-api' },
          { type: 'azapi_resource.api', name: 'plain-api' }
        ],
        true
      )
    ).toEqual([
      { name: 'aip-alpha', kind: 'Foundry project', verified: true },
      { name: 'gpt-4o', kind: 'Model deployment', verified: true },
      { name: 'alpha-api', kind: 'API in API Management', verified: true },
      { name: 'plain-api', kind: 'API in API Management', verified: true }
    ])
  })

  test('never carries an ID', () => {
    expect(JSON.stringify(resourceListOf([PROJECT], false))).not.toContain(
      'project-id'
    )
  })

  test('leaves out a resource of a kind the portal does not show', () => {
    expect(resourceListOf([APPLICATION, PRINCIPAL, PROJECT], false)).toEqual([
      { name: 'aip-alpha', kind: 'Foundry project', verified: false }
    ])
  })

  test('is empty when the apply reported no resources', () => {
    expect(resourceListOf(undefined, true)).toEqual([])
  })
})

describe('appRegistrationOf', () => {
  test('returns the object IDs of the application and its service principal', () => {
    expect(appRegistrationOf([PROJECT, APPLICATION, PRINCIPAL])).toEqual({
      clientId: null,
      objectId: 'application-object-id',
      servicePrincipalObjectId: 'principal-object-id'
    })
  })

  test('has no service principal ID when the apply created none', () => {
    expect(appRegistrationOf([APPLICATION])).toEqual({
      clientId: null,
      objectId: 'application-object-id',
      servicePrincipalObjectId: null
    })
  })

  test('is null when Entra skipped the registration or there are no resources', () => {
    expect(appRegistrationOf([PROJECT, PRINCIPAL])).toBeNull()
    expect(appRegistrationOf(undefined)).toBeNull()
  })
})

describe('entryFieldsOf', () => {
  test('records the operation sub-document of the entry', () => {
    const fields = entryFieldsOf(
      operationAt('deploying', {
        attempt: 2,
        gitops: {
          submitRunUrl: 'https://github.test/submit/1',
          applyRunUrl: 'https://github.test/apply/2',
          commitSha: 'abc123'
        },
        error: { code: FAILURE_CODES.DEPLOY_FAILED }
      }),
      ADD,
      {},
      AT
    )

    expect(fields.operation).toEqual({
      id: 'op-1',
      state: 'deploying',
      attempt: 2,
      runUrl: 'https://github.test/apply/2',
      commitSha: 'abc123',
      failureReason: FAILURE_CODES.DEPLOY_FAILED
    })
    expect(fields).toMatchObject({
      status: 'deploying',
      projectedVersion: 5,
      operationId: 'op-1'
    })
  })

  test('falls back to the submit run URL and nulls what is missing', () => {
    const fields = entryFieldsOf(
      operationAt('requested', {
        gitops: { submitRunUrl: 'https://github.test/submit/1' }
      }),
      ADD,
      {},
      AT
    )

    expect(fields.operation).toEqual({
      id: 'op-1',
      state: 'requested',
      attempt: 1,
      runUrl: 'https://github.test/submit/1',
      commitSha: null,
      failureReason: null
    })
  })

  test('has a null run URL before any run is known', () => {
    expect(
      entryFieldsOf(operationAt('requested'), ADD, {}, AT).operation.runUrl
    ).toBeNull()
  })

  test('links only the runs it knows', () => {
    expect(
      entryFieldsOf(
        operationAt('committed', {
          gitops: { submitRunUrl: 'https://github.test/submit/1' }
        }),
        ADD,
        {},
        AT
      ).links
    ).toEqual({ submitRun: 'https://github.test/submit/1' })
    expect(entryFieldsOf(operationAt('requested'), ADD, {}, AT).links).toEqual(
      {}
    )
  })

  test('keeps the time an entry first reached a status and adds the new one', () => {
    const fields = entryFieldsOf(
      operationAt('deploying'),
      ADD,
      { statusTimes: { requested: EARLIER, deploying: EARLIER } },
      AT
    )

    expect(fields.statusTimes).toEqual({
      requested: EARLIER,
      deploying: EARLIER
    })
    expect(
      entryFieldsOf(
        operationAt('deployed'),
        ADD,
        { statusTimes: { requested: EARLIER } },
        AT
      ).statusTimes
    ).toEqual({ requested: EARLIER, deployed: AT })
  })

  test.each([
    ['deployed', false],
    ['verified', true],
    ['active', true]
  ])('marks resources verified only from the state: %s is %s', (state, ok) => {
    expect(
      entryFieldsOf(
        operationAt(state, { gitops: { resources: [PROJECT] } }),
        ADD,
        {},
        AT
      ).resources
    ).toEqual([{ name: 'aip-alpha', kind: 'Foundry project', verified: ok }])
  })

  test('says whether the Entra registration was created, skipped or not yet known', () => {
    const registration = (gitops) =>
      entryFieldsOf(operationAt('deployed', { gitops }), ADD, {}, AT)
        .appRegistration

    expect(registration({ resources: [PROJECT, APPLICATION] })).toBe('created')
    expect(registration({ resources: [PROJECT] })).toBe('skipped')
    expect(registration({})).toBeNull()
  })

  test('reports a verification failure only while deployed', () => {
    const verify = { reason: 'resource-unavailable', attempts: 2 }

    expect(
      entryFieldsOf(operationAt('deployed', { verify }), ADD, {}, AT)
        .verificationFailure
    ).toEqual({ reason: 'resource-unavailable', attempts: 2 })
    expect(
      entryFieldsOf(operationAt('deploy-failed', { verify }), ADD, {}, AT)
        .verificationFailure
    ).toBeNull()
    expect(
      entryFieldsOf(
        operationAt('deployed', { verify: { attempts: 1 } }),
        ADD,
        {},
        AT
      ).verificationFailure
    ).toBeNull()
  })

  test('stamps activatedAt when an addition turns active and keeps one already set', () => {
    expect(entryFieldsOf(operationAt('active'), ADD, {}, AT).activatedAt).toBe(
      AT
    )
    expect(
      entryFieldsOf(operationAt('active'), ADD, { activatedAt: EARLIER }, AT)
        .activatedAt
    ).toBe(EARLIER)
    expect(
      entryFieldsOf(operationAt('verified'), ADD, {}, AT)
    ).not.toHaveProperty('activatedAt')
  })

  test('does not stamp activatedAt on a failed removal, which shows active', () => {
    const fields = entryFieldsOf(
      operationAt('deploy-failed', { items: [REMOVE] }),
      REMOVE,
      {},
      AT
    )

    expect(fields.status).toBe('active')
    expect(fields).not.toHaveProperty('activatedAt')
  })

  test('stamps removedAt when a removal is removed and keeps one already set', () => {
    expect(
      entryFieldsOf(operationAt('removed'), REMOVE, {}, AT).removedAt
    ).toBe(AT)
    expect(
      entryFieldsOf(operationAt('removed'), REMOVE, { removedAt: EARLIER }, AT)
        .removedAt
    ).toBe(EARLIER)
    expect(
      entryFieldsOf(operationAt('deployed'), REMOVE, {}, AT)
    ).not.toHaveProperty('removedAt')
  })
})

describe('projectOperation', () => {
  const DATABASE = 'operation-projection-test'
  let client
  let db

  function entry(id, modelSlug, overrides = {}) {
    return {
      id,
      modelSlug,
      status: 'requested',
      statusTimes: { requested: EARLIER },
      ...overrides
    }
  }

  async function seed(deployments, gateway = ['other-model']) {
    await db.collection('teamDeployments').insertOne({
      teamId: 'team-1',
      environment: 'infradev',
      gateway: { allowedDeployments: gateway },
      deployments
    })
  }

  function read() {
    return db
      .collection('teamDeployments')
      .findOne({ teamId: 'team-1', environment: 'infradev' })
  }

  beforeAll(async () => {
    client = await MongoClient.connect(process.env.MONGO_URI)
    db = client.db(DATABASE)
  })

  afterAll(async () => {
    await client.db(DATABASE).dropDatabase()
    await client.close()
  })

  beforeEach(async () => {
    await db.collection('teamDeployments').deleteMany({})
  })

  test('projects the state, the operation sub-document and the status time onto the entry', async () => {
    await seed([entry('entry-1', 'gpt-4o')])

    await projectOperation(
      db,
      operationAt('committed', {
        gitops: { submitRunUrl: 'https://github.test/submit/1' }
      })
    )

    const [projected] = (await read()).deployments

    expect(projected).toMatchObject({
      id: 'entry-1',
      status: 'committed',
      projectedVersion: 5,
      failureReason: null,
      operation: {
        id: 'op-1',
        state: 'committed',
        runUrl: 'https://github.test/submit/1'
      },
      links: { submitRun: 'https://github.test/submit/1' }
    })
    expect(projected.statusTimes).toMatchObject({ requested: EARLIER })
    expect(projected.statusTimes.committed).toEqual(expect.any(String))
  })

  test('projects both items of an operation in one write', async () => {
    await seed([entry('entry-1', 'gpt-4o'), entry('entry-2', 'phi-4')])

    let writes = 0
    const counting = {
      collection(name) {
        const collection = db.collection(name)

        if (name === 'teamDeployments') {
          const original = collection.updateOne.bind(collection)

          collection.updateOne = (...args) => {
            writes += 1
            return original(...args)
          }
        }

        return collection
      }
    }

    await projectOperation(
      counting,
      operationAt('active', {
        items: [ADD, { entryId: 'entry-2', modelSlug: 'phi-4', change: 'add' }]
      })
    )

    const doc = await read()

    expect(writes).toBe(1)
    expect(doc.deployments.map(({ status }) => status)).toEqual([
      'active',
      'active'
    ])
    expect(
      doc.deployments.map(({ projectedVersion }) => projectedVersion)
    ).toEqual([5, 5])
    expect(doc.gateway.allowedDeployments).toEqual([
      'other-model',
      'gpt-4o',
      'phi-4'
    ])
  })

  test('leaves the entries of other models untouched', async () => {
    await seed([entry('entry-1', 'gpt-4o'), entry('entry-9', 'other-model')])

    await projectOperation(db, operationAt('deployed'))

    const [, untouched] = (await read()).deployments

    expect(untouched).toEqual(entry('entry-9', 'other-model'))
  })

  test('grants an active model to the gateway once, however often it is projected', async () => {
    await seed([entry('entry-1', 'gpt-4o')])

    await projectOperation(db, operationAt('active', { stateVersion: 5 }))
    await projectOperation(db, operationAt('active', { stateVersion: 6 }))

    const doc = await read()

    expect(doc.gateway.allowedDeployments).toEqual(['other-model', 'gpt-4o'])
    expect(doc.deployments[0].projectedVersion).toBe(6)
    expect(doc.deployments[0].activatedAt).toEqual(expect.any(String))
  })

  test('keeps the first activation time when a later projection repeats it', async () => {
    await seed([entry('entry-1', 'gpt-4o')])

    await projectOperation(db, operationAt('active', { stateVersion: 5 }))

    const first = (await read()).deployments[0].activatedAt

    await projectOperation(db, operationAt('active', { stateVersion: 6 }))

    expect((await read()).deployments[0].activatedAt).toBe(first)
  })

  test('does not grant a model that is not yet active', async () => {
    await seed([entry('entry-1', 'gpt-4o')])

    await projectOperation(db, operationAt('verified'))

    expect((await read()).gateway.allowedDeployments).toEqual(['other-model'])
  })

  test('withdraws a removed model from the gateway and stamps removedAt', async () => {
    await seed(
      [entry('entry-1', 'gpt-4o', { status: 'active' })],
      ['other-model', 'gpt-4o']
    )

    await projectOperation(
      db,
      operationAt('removed', { items: [REMOVE], stateVersion: 6 })
    )

    const doc = await read()

    expect(doc.deployments[0].status).toBe('removed')
    expect(doc.deployments[0].removedAt).toEqual(expect.any(String))
    expect(doc.gateway.allowedDeployments).toEqual(['other-model'])
  })

  test('keeps a model granted while its removal is in flight or has failed', async () => {
    await seed(
      [entry('entry-1', 'gpt-4o', { status: 'active' })],
      ['other-model', 'gpt-4o']
    )

    await projectOperation(
      db,
      operationAt('deploying', { items: [REMOVE], stateVersion: 6 })
    )

    expect((await read()).deployments[0].status).toBe('removing')

    await projectOperation(
      db,
      operationAt('deploy-failed', { items: [REMOVE], stateVersion: 7 })
    )

    const doc = await read()

    expect(doc.deployments[0].status).toBe('active')
    expect(doc.deployments[0].failureReason).toContain('still deployed')
    expect(doc.gateway.allowedDeployments).toEqual(['other-model', 'gpt-4o'])
  })

  describe('the version guard', () => {
    test('never overwrites a newer projection with an older one', async () => {
      await seed([entry('entry-1', 'gpt-4o')])

      await projectOperation(db, operationAt('deploying', { stateVersion: 7 }))
      await projectOperation(db, operationAt('committed', { stateVersion: 3 }))

      const [projected] = (await read()).deployments

      expect(projected.status).toBe('deploying')
      expect(projected.projectedVersion).toBe(7)
      expect(projected.operation.state).toBe('deploying')
      expect(projected.statusTimes).not.toHaveProperty('committed')
    })

    test('does not rewrite an entry at the same version', async () => {
      await seed([entry('entry-1', 'gpt-4o')])

      await projectOperation(db, operationAt('deploying', { stateVersion: 7 }))
      await projectOperation(
        db,
        operationAt('deploying', {
          stateVersion: 7,
          gitops: { commitSha: 'changed' }
        })
      )

      expect((await read()).deployments[0].operation.commitSha).toBeNull()
    })

    test('guards each entry on its own version', async () => {
      await seed([
        entry('entry-1', 'gpt-4o', { projectedVersion: 9, status: 'active' }),
        entry('entry-2', 'phi-4')
      ])

      await projectOperation(
        db,
        operationAt('deployed', {
          stateVersion: 5,
          items: [
            ADD,
            { entryId: 'entry-2', modelSlug: 'phi-4', change: 'add' }
          ]
        })
      )

      const { deployments } = await read()

      expect(deployments[0]).toMatchObject({
        status: 'active',
        projectedVersion: 9
      })
      expect(deployments[1]).toMatchObject({
        status: 'deployed',
        projectedVersion: 5
      })
    })
  })

  describe('what it ignores', () => {
    test('does nothing when the team has no deployments document', async () => {
      await expect(
        projectOperation(db, operationAt('active'))
      ).resolves.toBeUndefined()

      expect(await db.collection('teamDeployments').countDocuments()).toBe(0)
    })

    test('does nothing for an operation with no items', async () => {
      await seed([entry('entry-1', 'gpt-4o')])
      const before = await read()

      await projectOperation(db, operationAt('active', { items: [] }))
      await projectOperation(db, operationAt('active', { items: undefined }))

      expect(await read()).toEqual(before)
    })

    test('does nothing for an item whose entry is not in the document', async () => {
      await seed([entry('entry-1', 'gpt-4o')])
      const before = await read()

      await projectOperation(
        db,
        operationAt('active', {
          items: [{ entryId: 'missing', modelSlug: 'phi-4', change: 'add' }]
        })
      )

      expect(await read()).toEqual(before)
    })

    test('projects the entries it knows and skips the ones it does not', async () => {
      await seed([entry('entry-1', 'gpt-4o')])

      await projectOperation(
        db,
        operationAt('active', {
          items: [
            { entryId: 'missing', modelSlug: 'phi-4', change: 'add' },
            ADD
          ]
        })
      )

      const doc = await read()

      expect(doc.deployments[0].status).toBe('active')
      expect(doc.gateway.allowedDeployments).toEqual(['other-model', 'gpt-4o'])
    })

    test('does nothing for the same team in another environment', async () => {
      await seed([entry('entry-1', 'gpt-4o')])

      await projectOperation(
        db,
        operationAt('active', { environment: 'infraprod' })
      )

      expect((await read()).deployments[0].status).toBe('requested')
    })

    test('tolerates a document with no deployments', async () => {
      await db.collection('teamDeployments').insertOne({
        teamId: 'team-1',
        environment: 'infradev'
      })

      await expect(
        projectOperation(db, operationAt('active'))
      ).resolves.toBeUndefined()
    })
  })

  describe('the Entra registration', () => {
    const resources = [PROJECT, APPLICATION, PRINCIPAL]

    test.each(['verified', 'active'])(
      'is kept on the document once the operation is %s',
      async (state) => {
        await seed([entry('entry-1', 'gpt-4o')])

        await projectOperation(
          db,
          operationAt(state, { gitops: { resources } })
        )

        expect((await read()).oauthClient.registration).toEqual({
          clientId: null,
          objectId: 'application-object-id',
          servicePrincipalObjectId: 'principal-object-id'
        })
      }
    )

    test('is not kept before the resources are verified', async () => {
      await seed([entry('entry-1', 'gpt-4o')])

      await projectOperation(
        db,
        operationAt('deployed', { gitops: { resources } })
      )

      expect((await read()).oauthClient).toBeUndefined()
    })

    test('is not kept when Entra skipped it', async () => {
      await seed([entry('entry-1', 'gpt-4o')])

      await projectOperation(
        db,
        operationAt('verified', { gitops: { resources: [PROJECT] } })
      )

      expect((await read()).oauthClient).toBeUndefined()
    })
  })
})

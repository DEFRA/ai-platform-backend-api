import { createLogAnalyticsUsageReader } from '#/adapters/azure/log-analytics-usage-reader.js'
import { describeUsageReaderContract } from '#/adapters/usage-reader-contract.js'

const ENVIRONMENTS = {
  infradev: {
    subscriptionId: '00000000-0000-0000-0000-000000000005',
    resourceGroup: 'rg-test',
    apimName: 'apim-test',
    foundryAccounts: ['aif-test'],
    tenantsVault: 'kv-test',
    logAnalyticsWorkspace: 'law-test'
  },
  sandbox: {
    subscriptionId: '00000000-0000-0000-0000-000000000006',
    resourceGroup: 'rg-sandbox',
    apimName: 'apim-sandbox',
    foundryAccounts: ['aif-sandbox'],
    tenantsVault: 'kv-sandbox'
  }
}

const COLUMNS = [
  'Day',
  'ApiId',
  'DeploymentName',
  'Requests',
  'PromptTokens',
  'CompletionTokens'
].map((name) => ({ ColumnName: name }))

function tableOf(rows) {
  return { Tables: [{ Columns: COLUMNS, Rows: rows }] }
}

// The reader's answer for a query: rows for whichever team the query names.
function answerFor(rowsByTeam) {
  return vi.fn(async (_method, _path, { body }) => {
    const team = /ApiId == '([^']+)'/.exec(body.query)?.[1]

    return tableOf(
      (team ? [team] : Object.keys(rowsByTeam)).flatMap(
        (slug) => rowsByTeam[slug] ?? []
      )
    )
  })
}

const ROWS = {
  'team-a': [['2026-11-02T00:00:00Z', 'team-a', 'team-a-gpt-4o', 3, 1200, 340]],
  'team-b': []
}

describeUsageReaderContract('log analytics', () =>
  createLogAnalyticsUsageReader({
    armClient: { request: answerFor(ROWS) },
    environments: ENVIRONMENTS
  })
)

describe('#createLogAnalyticsUsageReader', () => {
  const window = {
    environment: 'infradev',
    from: '2026-11-01',
    to: '2026-11-08'
  }

  function readerOver(request) {
    return createLogAnalyticsUsageReader({
      armClient: { request },
      environments: ENVIRONMENTS
    })
  }

  test('queries the environment workspace through ARM', async () => {
    const request = answerFor(ROWS)

    await readerOver(request).readUsage({ ...window, teamSlug: 'team-a' })

    expect(request).toHaveBeenCalledTimes(1)
    const [method, path, options] = request.mock.calls[0]

    expect(method).toBe('POST')
    expect(path).toBe(
      '/subscriptions/00000000-0000-0000-0000-000000000005/resourceGroups/rg-test/providers/Microsoft.OperationalInsights/workspaces/law-test/api/query?api-version=2017-01-01-preview'
    )
    expect(Object.keys(options.body)).toEqual(['query'])
  })

  test('joins the LLM log to the gateway log by correlation ID, one row per request', async () => {
    const request = answerFor(ROWS)

    await readerOver(request).readUsage({ ...window, teamSlug: 'team-a' })

    const { query } = request.mock.calls[0][2].body

    expect(query).toContain('ApiManagementGatewayLlmLog')
    expect(query).toContain('ApiManagementGatewayLogs')
    expect(query).toContain('join kind=inner')
    expect(query).toContain('by CorrelationId')
    expect(query).toContain("ApiId == 'team-a'")
    expect(query).toContain('datetime(2026-11-01)')
    expect(query).toContain('datetime(2026-11-08)')
  })

  test('reads every API when no team is named', async () => {
    const request = answerFor(ROWS)

    await readerOver(request).readUsage(window)

    expect(request.mock.calls[0][2].body.query).not.toContain('ApiId ==')
  })

  test('never reads a message, name or address', async () => {
    const request = answerFor(ROWS)

    await readerOver(request).readUsage(window)

    const { query } = request.mock.calls[0][2].body

    for (const field of [
      'RequestMessages',
      'ResponseMessages',
      'CallerIpAddress',
      'UserId',
      'RequestBody'
    ]) {
      expect(query).not.toContain(field)
    }
  })

  test('maps the table into rows with a UTC date', async () => {
    const rows = await readerOver(answerFor(ROWS)).readUsage({
      ...window,
      teamSlug: 'team-a'
    })

    expect(rows).toEqual([
      {
        day: '2026-11-02',
        teamSlug: 'team-a',
        deployment: 'team-a-gpt-4o',
        requests: 3,
        promptTokens: 1200,
        completionTokens: 340
      }
    ])
  })

  test('accepts the lower-case table keys ARM may return', async () => {
    const request = vi.fn(async () => ({
      tables: [
        {
          columns: COLUMNS.map(({ ColumnName }) => ({ name: ColumnName })),
          rows: ROWS['team-a']
        }
      ]
    }))

    const rows = await readerOver(request).readUsage({
      ...window,
      teamSlug: 'team-a'
    })

    expect(rows).toHaveLength(1)
  })

  test('returns no rows for an empty table or an empty answer', async () => {
    expect(await readerOver(async () => tableOf([])).readUsage(window)).toEqual(
      []
    )
    expect(await readerOver(async () => null).readUsage(window)).toEqual([])
    expect(await readerOver(async () => ({})).readUsage(window)).toEqual([])
  })

  test('refuses a team slug that is not a slug, before asking Azure', async () => {
    const request = answerFor(ROWS)

    await expect(
      readerOver(request).readUsage({
        ...window,
        teamSlug: "x' or 1 == 1 //"
      })
    ).rejects.toThrow('team slug')

    expect(request).not.toHaveBeenCalled()
  })

  test.each([
    ['from', { from: '2026-11-01; drop' }],
    ['to', { to: '2026-13-45' }],
    ['from', { from: '2026-11-8' }]
  ])(
    'refuses a %s that is not a date, before asking Azure',
    async (_name, bad) => {
      const request = answerFor(ROWS)

      await expect(
        readerOver(request).readUsage({ ...window, ...bad })
      ).rejects.toThrow('date')

      expect(request).not.toHaveBeenCalled()
    }
  )

  test('refuses a window that does not end after it starts', async () => {
    const request = answerFor(ROWS)

    await expect(
      readerOver(request).readUsage({
        ...window,
        from: '2026-11-08',
        to: '2026-11-08'
      })
    ).rejects.toThrow('window')
  })

  test('says an environment with no workspace has no usage, without asking Azure', async () => {
    const request = answerFor(ROWS)

    await expect(
      readerOver(request).readUsage({ ...window, environment: 'sandbox' })
    ).rejects.toMatchObject({ code: 'usage-not-available' })
    await expect(
      readerOver(request).readUsage({ ...window, environment: 'qa' })
    ).rejects.toMatchObject({ code: 'usage-not-available' })

    expect(request).not.toHaveBeenCalled()
  })

  test('passes the caller signal to ARM', async () => {
    const request = answerFor(ROWS)
    const signal = AbortSignal.timeout(1000)

    await readerOver(request).readUsage({ ...window, signal })

    expect(request.mock.calls[0][2].signal).toBe(signal)
  })

  test("limits both tables to this environment's own API Management", async () => {
    const request = answerFor(ROWS)

    await readerOver(request).readUsage({ ...window, teamSlug: 'team-a' })

    const { query } = request.mock.calls[0][2].body
    const filter =
      "_ResourceId =~ '/subscriptions/00000000-0000-0000-0000-000000000005/resourcegroups/rg-test/providers/microsoft.apimanagement/service/apim-test'"

    expect(query.split(filter)).toHaveLength(3)
    expect(
      query.indexOf(filter) < query.indexOf('ApiManagementGatewayLlmLog')
    ).toBe(true)
  })

  test('keeps two environments that log to one workspace apart', async () => {
    const request = answerFor(ROWS)
    const reader = createLogAnalyticsUsageReader({
      armClient: { request },
      environments: {
        infradev: ENVIRONMENTS.infradev,
        other: {
          ...ENVIRONMENTS.infradev,
          apimName: 'apim-other',
          logAnalyticsWorkspace: 'law-test'
        }
      }
    })

    await reader.readUsage({ ...window, environment: 'infradev' })
    await reader.readUsage({ ...window, environment: 'other' })

    const [first, second] = request.mock.calls.map(
      ([, , { body }]) => body.query
    )

    expect(first).toContain('service/apim-test')
    expect(first).not.toContain('apim-other')
    expect(second).toContain('service/apim-other')
    expect(second).not.toContain('apim-test')
  })

  test.each([
    ['an API Management name with a quote', { apimName: "apim' or 1==1" }],
    ['no API Management name', { apimName: undefined }],
    ['a resource group with a slash', { resourceGroup: 'rg/../x' }]
  ])('refuses %s, before asking Azure', async (_name, override) => {
    const request = answerFor(ROWS)
    const reader = createLogAnalyticsUsageReader({
      armClient: { request },
      environments: { infradev: { ...ENVIRONMENTS.infradev, ...override } }
    })

    await expect(reader.readUsage(window)).rejects.toMatchObject({
      code: 'usage-not-available'
    })
    expect(request).not.toHaveBeenCalled()
  })

  test.each([
    ['an error', { error: { code: 'PartialError' } }],
    ['an Error', { Error: { code: 'PartialError' } }]
  ])(
    'refuses an answer that carries %s beside rows, never showing partial totals',
    async (_name, extra) => {
      const request = vi.fn(async () => ({
        ...tableOf(ROWS['team-a']),
        ...extra
      }))

      await expect(
        readerOver(request).readUsage({ ...window, teamSlug: 'team-a' })
      ).rejects.toThrow('partial or failed')
    }
  )

  test('lets an ARM failure reach the caller', async () => {
    const request = vi.fn().mockRejectedValue(new Error('ARM request failed'))

    await expect(readerOver(request).readUsage(window)).rejects.toThrow(
      'ARM request failed'
    )
  })

  test('narrows to one subscription for a personal key, after checking it', async () => {
    const request = answerFor(ROWS)

    await readerOver(request).readUsage({
      ...window,
      subscriptionId: 'sub-abc_123'
    })

    expect(request.mock.calls[0][2].body.query).toContain(
      "| where ApimSubscriptionId == 'sub-abc_123'"
    )
  })

  test.each(["x' or 1==1", '', 'a b', '-lead'])(
    'refuses the subscription %j before asking Azure',
    async (subscriptionId) => {
      const request = answerFor(ROWS)

      await expect(
        readerOver(request).readUsage({ ...window, subscriptionId })
      ).rejects.toThrow('subscription')
      expect(request).not.toHaveBeenCalled()
    }
  )

  describe('refused calls', () => {
    const refusals = vi.fn(async () => ({
      Tables: [
        {
          Columns: [{ ColumnName: 'Day' }, { ColumnName: 'Refused' }],
          Rows: [['2026-11-02T00:00:00Z', 37]]
        }
      ]
    }))

    test('counts the 429s of one team API, a day at a time', async () => {
      const rows = await readerOver(refusals).readRefusals({
        ...window,
        teamSlug: 'team-a'
      })
      const { query } = refusals.mock.calls[0][2].body

      expect(rows).toEqual([{ day: '2026-11-02', refused: 37 }])
      expect(query).toContain('ResponseCode == 429')
      expect(query).toContain("ApiId == 'team-a'")
      expect(query).toContain("_ResourceId =~ '/subscriptions/")
    })

    test.each(["x' or 1==1", undefined, ''])(
      'refuses the team %j before asking Azure',
      async (teamSlug) => {
        const request = vi.fn()

        await expect(
          readerOver(request).readRefusals({ ...window, teamSlug })
        ).rejects.toThrow('team slug')
        expect(request).not.toHaveBeenCalled()
      }
    )

    test('says an environment with no workspace has none', async () => {
      await expect(
        readerOver(vi.fn()).readRefusals({
          ...window,
          environment: 'sandbox',
          teamSlug: 'team-a'
        })
      ).rejects.toMatchObject({ code: 'usage-not-available' })
    })
  })
})

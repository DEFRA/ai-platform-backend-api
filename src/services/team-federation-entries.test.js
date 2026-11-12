import {
  FEDERATION_STATUS,
  MAX_FEDERATIONS,
  definitionOf,
  defraIssuer,
  federationFingerprintOf,
  federationViewOf,
  fileEntryOf,
  heldNames,
  heldTrustKeys,
  isOccupying,
  liveFederationsOf,
  trustKeyOf
} from '#/services/team-federation-entries.js'

const PRINCIPAL = '6F504113-6B64-43F2-ADE9-242E05780007'
const LOWER = PRINCIPAL.toLowerCase()

describe('team federation entries', () => {
  test('the registration holds at most 20 applications, as the team file schema allows', () => {
    expect(MAX_FEDERATIONS).toBe(20)
  })

  describe('definitionOf', () => {
    test('names a CDP application by its service, for name and service alike', () => {
      expect(definitionOf({ host: 'cdp', service: 'beta-api' })).toEqual({
        host: 'cdp',
        name: 'beta-api',
        service: 'beta-api'
      })
    })

    test('keeps an Azure workload’s name and its principal ID in lower case', () => {
      expect(
        definitionOf({
          host: 'azure',
          name: 'data-app',
          principalId: PRINCIPAL
        })
      ).toEqual({ host: 'azure', name: 'data-app', principalId: LOWER })
    })
  })

  describe('fileEntryOf', () => {
    test('is only the name, host and service for a CDP application', () => {
      expect(
        fileEntryOf({ host: 'cdp', name: 'beta-api', service: 'beta-api' })
      ).toEqual({ name: 'beta-api', host: 'cdp', service: 'beta-api' })
    })

    test('is the Defra tenant’s issuer and the principal ID as subject for an Azure one', () => {
      expect(
        fileEntryOf({ host: 'azure', name: 'data-app', principalId: LOWER })
      ).toEqual({
        name: 'data-app',
        host: 'azure',
        issuer: defraIssuer(),
        subject: LOWER
      })
      expect(defraIssuer()).toMatch(
        /^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]{36}\/v2\.0$/
      )
    })
  })

  describe('trustKeyOf', () => {
    test('is the infra checks’ key: a CDP service, or an issuer and a subject', () => {
      expect(trustKeyOf({ host: 'cdp', service: 'beta-api' })).toBe(
        'CDP service beta-api'
      )
      expect(
        trustKeyOf({ host: 'azure', issuer: 'https://i/v2.0', subject: 's' })
      ).toBe('https://i/v2.0 s')
    })

    test('is the same for an Azure application as asked for, as recorded and as the file holds it', () => {
      const asked = trustKeyOf({ host: 'azure', principalId: LOWER })
      const filed = trustKeyOf(
        fileEntryOf({ host: 'azure', name: 'x', principalId: LOWER })
      )

      expect(asked).toBe(filed)
    })
  })

  test('a fingerprint tells an add in one environment from a change of one application', () => {
    const definition = { host: 'cdp', name: 'beta-api', service: 'beta-api' }

    expect(federationFingerprintOf('add', 'infradev', definition)).toBe(
      'federation:add:infradev:CDP service beta-api:beta-api'
    )
    expect(federationFingerprintOf('change', 'f1', definition)).not.toBe(
      federationFingerprintOf('add', 'f1', definition)
    )
  })

  describe('what the registration holds', () => {
    const doc = {
      federations: [
        { id: 'f1', name: 'one', host: 'cdp', service: 'one', status: 'ready' },
        {
          id: 'f2',
          name: 'two',
          host: 'cdp',
          service: 'two',
          status: 'setting-up'
        },
        {
          id: 'f3',
          name: 'three',
          host: 'cdp',
          service: 'three',
          status: 'failed'
        },
        {
          id: 'f4',
          name: 'four',
          host: 'cdp',
          service: 'four',
          status: 'removed'
        },
        {
          id: 'f5',
          name: 'five',
          host: 'cdp',
          service: 'five',
          status: 'removing'
        }
      ]
    }
    const file = {
      oauth: {
        federations: [
          { name: 'one', host: 'cdp', service: 'one' },
          { name: 'six', host: 'cdp', service: 'six' }
        ]
      }
    }

    test('counts the asked-for and filed ones once, not the failed or removed', () => {
      expect([...heldTrustKeys(doc, file)].sort()).toEqual([
        'CDP service five',
        'CDP service one',
        'CDP service six',
        'CDP service two'
      ])
      expect([...heldNames(doc, file)].sort()).toEqual([
        'five',
        'one',
        'six',
        'two'
      ])
    })

    test('leaves out the application a change is about, by entry and by place in the file', () => {
      const except = { id: 'f1', name: 'one' }

      expect(heldTrustKeys(doc, file, except).has('CDP service one')).toBe(
        false
      )
      expect(heldNames(doc, file, except).has('one')).toBe(false)
      expect(heldNames(doc, file, except).has('six')).toBe(true)
    })

    test('holds nothing for no document and no file', () => {
      expect(heldTrustKeys(null, null).size).toBe(0)
      expect(heldNames(undefined, undefined).size).toBe(0)
    })

    test('lists the applications not removed', () => {
      expect(liveFederationsOf(doc).map(({ id }) => id)).toEqual([
        'f1',
        'f2',
        'f3',
        'f5'
      ])
      expect(liveFederationsOf(null)).toEqual([])
    })

    test.each([
      ['setting-up', true],
      ['ready', true],
      ['removing', true],
      ['failed', false],
      ['removed', false]
    ])('%s holds a place: %s', (status, expected) => {
      expect(isOccupying(status)).toBe(expected)
      expect(Object.values(FEDERATION_STATUS)).toContain(status)
    })
  })

  describe('federationViewOf', () => {
    test('shows a CDP application by its service and an Azure one by its principal ID', () => {
      expect(
        federationViewOf({
          id: 'f1',
          name: 'beta-api',
          host: 'cdp',
          service: 'beta-api',
          status: 'ready',
          operationId: 'op-1',
          trustKey: 'internal',
          requestedBy: 'user-1'
        })
      ).toEqual({
        id: 'f1',
        name: 'beta-api',
        host: 'cdp',
        service: 'beta-api',
        status: 'ready',
        operationId: 'op-1',
        failureReason: null
      })
      expect(
        federationViewOf({
          id: 'f2',
          name: 'data-app',
          host: 'azure',
          principalId: LOWER,
          status: 'failed',
          failureReason: 'It failed'
        })
      ).toEqual({
        id: 'f2',
        name: 'data-app',
        host: 'azure',
        principalId: LOWER,
        status: 'failed',
        operationId: null,
        failureReason: 'It failed'
      })
    })
  })
})

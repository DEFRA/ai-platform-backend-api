import { emailOf, isEligible } from '#/services/directory-eligibility.js'

const DOMAINS = ['defra.gov.uk', 'defra.onmicrosoft.com']

describe('#emailOf', () => {
  test('is the mail, trimmed, when the person has one', () => {
    expect(
      emailOf({
        userPrincipalName: 'ada@defra.onmicrosoft.com',
        mail: '  Ada@defra.gov.uk '
      })
    ).toBe('Ada@defra.gov.uk')
  })

  test.each([undefined, null, '', '   ', '\t'])(
    'is the user principal name when the mail is %j, never a blank (thread 3)',
    (mail) => {
      expect(emailOf({ userPrincipalName: 'ada@defra.gov.uk', mail })).toBe(
        'ada@defra.gov.uk'
      )
    }
  )
})

describe('#isEligible', () => {
  // The shared rule table. The frontend runs the same table against its
  // `isEligible` (src/server/common/helpers/eligibility-rule.test.js); change
  // one, change the other, so the two sides keep deciding alike.
  describe('the shared rule table', () => {
    test.each([
      ['a defra.gov.uk name', 'ada@defra.gov.uk', undefined],
      ['a defra.onmicrosoft.com name', 'ada@defra.onmicrosoft.com', null],
      ['an upper-case name', 'ADA@DEFRA.GOV.UK', undefined],
      ['a padded name', '  ada@defra.gov.uk\t', undefined],
      [
        'a name and a mail on allowed domains',
        'ada@defra.onmicrosoft.com',
        'Ada@Defra.gov.uk'
      ],
      ['an empty mail, as no mail', 'ada@defra.gov.uk', ''],
      ['a blank mail, as no mail', 'ada@defra.gov.uk', ' \t\n']
    ])('accepts %s', (_name, userPrincipalName, mail) => {
      expect(isEligible({ userPrincipalName, mail }, DOMAINS)).toBe(true)
    })

    test.each([
      ['a subdomain', 'ada@sub.defra.gov.uk', undefined],
      ['a look-alike suffix', 'ada@defra.gov.uk.example.com', undefined],
      ['a look-alike prefix', 'ada@notdefra.gov.uk', undefined],
      ['a trailing dot', 'ada@defra.gov.uk.', undefined],
      ['a guest name', 'ada_example.com#EXT#@defra.onmicrosoft.com', undefined],
      [
        'a guest name in lower case',
        'ada_example.com#ext#@defra.onmicrosoft.com',
        undefined
      ],
      [
        'a guest mail',
        'ada@defra.gov.uk',
        'ada_example.com#EXT#@defra.onmicrosoft.com'
      ],
      ['another domain', 'ada@example.com', undefined],
      ['a mail on another domain', 'ada@defra.gov.uk', 'ada@example.com'],
      ['a second @, Defra last', 'ada@example.com@defra.gov.uk', undefined],
      ['a second @, Defra first', 'ada@defra.gov.uk@example.com', undefined],
      ['no local part', '@defra.gov.uk', undefined],
      ['no @', 'defra.gov.uk', undefined],
      ['an empty name', '', undefined],
      ['no name', undefined, undefined],
      ['a name that is not text', 42, undefined],
      ['a mail that is not text', 'ada@defra.gov.uk', 42],
      ['a Cyrillic look-alike', 'ada@defrа.gov.uk', undefined],
      ['a space in the domain', 'ada@defra.gov.uk .example.com', undefined]
    ])('refuses %s', (_name, userPrincipalName, mail) => {
      expect(isEligible({ userPrincipalName, mail }, DOMAINS)).toBe(false)
    })
  })

  test.each([
    ['a defra.gov.uk UPN', 'ada.lovelace@defra.gov.uk'],
    ['a defra.onmicrosoft.com UPN', 'ada.lovelace@defra.onmicrosoft.com'],
    ['a UPN in upper case', 'ADA.LOVELACE@DEFRA.GOV.UK']
  ])('accepts %s', (_, userPrincipalName) => {
    expect(isEligible({ userPrincipalName, mail: null }, DOMAINS)).toBe(true)
  })

  test('accepts a person whose mail is on an allowed domain too', () => {
    expect(
      isEligible(
        {
          userPrincipalName: 'ada@defra.onmicrosoft.com',
          mail: 'Ada.Lovelace@Defra.gov.uk'
        },
        DOMAINS
      )
    ).toBe(true)
  })

  test.each([undefined, null, '', '   ', '\t\n'])(
    'accepts mail %j as absent',
    (mail) => {
      expect(
        isEligible({ userPrincipalName: 'ada@defra.gov.uk', mail }, DOMAINS)
      ).toBe(true)
    }
  )

  test('refuses a mail that is not text, as it is not absent', () => {
    expect(
      isEligible({ userPrincipalName: 'ada@defra.gov.uk', mail: 42 }, DOMAINS)
    ).toBe(false)
  })

  test.each([
    ['a subdomain', 'ada@sub.defra.gov.uk'],
    ['a look-alike suffix', 'ada@defra.gov.uk.example.com'],
    ['a look-alike prefix', 'ada@notdefra.gov.uk'],
    ['a guest', 'ada_example.com#EXT#@defra.onmicrosoft.com'],
    ['a guest in any case', 'ada_example.com#ext#@defra.onmicrosoft.com'],
    ['another domain', 'ada@supplier.example.com'],
    ['two at signs', 'ada@example.com@defra.gov.uk'],
    ['no local part', '@defra.gov.uk'],
    ['no at sign', 'defra.gov.uk'],
    ['an empty UPN', ''],
    ['a missing UPN', undefined],
    ['a non-string UPN', 42]
  ])('refuses %s', (_, userPrincipalName) => {
    expect(isEligible({ userPrincipalName, mail: null }, DOMAINS)).toBe(false)
  })

  test('refuses a person whose mail is on another domain', () => {
    expect(
      isEligible(
        { userPrincipalName: 'ada@defra.gov.uk', mail: 'ada@example.com' },
        DOMAINS
      )
    ).toBe(false)
  })

  test('refuses a guest mail address', () => {
    expect(
      isEligible(
        {
          userPrincipalName: 'ada@defra.gov.uk',
          mail: 'ada_example.com#EXT#@defra.onmicrosoft.com'
        },
        DOMAINS
      )
    ).toBe(false)
  })

  test('refuses everyone when no domain is allowed', () => {
    expect(
      isEligible({ userPrincipalName: 'ada@defra.gov.uk', mail: null }, [])
    ).toBe(false)
  })

  test('ignores blank and padded entries in the domain list', () => {
    expect(
      isEligible({ userPrincipalName: 'ada@defra.gov.uk', mail: null }, [
        ' DEFRA.gov.uk ',
        ''
      ])
    ).toBe(true)
  })

  test('refuses a missing person', () => {
    expect(isEligible(null, DOMAINS)).toBe(false)
  })
})

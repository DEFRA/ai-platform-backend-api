describe('#mockServiceCodeVerifier', () => {
  let mockServiceCodeVerifier
  let config

  beforeAll(async () => {
    // Dynamic import needed due to config being updated by vitest-mongodb
    ;({ mockServiceCodeVerifier } =
      await import('#/adapters/mock-service-code-verifier.js'))
    ;({ config } = await import('#/config.js'))
  })

  afterEach(() => {
    config.set('serviceCode.knownCodes', [])
  })

  test('verifies nothing while no codes are published', async () => {
    await expect(mockServiceCodeVerifier.verify('ABC')).resolves.toEqual({
      verified: false,
      source: null
    })
  })

  test('verifies a code the environment has been told about', async () => {
    config.set('serviceCode.knownCodes', ['aip', 'XYZ'])

    await expect(mockServiceCodeVerifier.verify('AIP')).resolves.toEqual({
      verified: true,
      source: 'known-codes'
    })
    await expect(mockServiceCodeVerifier.verify('ZZZ')).resolves.toEqual({
      verified: false,
      source: null
    })
  })
})

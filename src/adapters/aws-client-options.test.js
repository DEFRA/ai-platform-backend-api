import { awsClientOptions } from '#/adapters/aws-client-options.js'

describe('#awsClientOptions', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('with an endpoint, uses it with the standard test credentials', () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', undefined)
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', undefined)

    expect(
      awsClientOptions({
        endpoint: 'http://aws.test:4566',
        region: 'eu-west-1'
      })
    ).toEqual({
      region: 'eu-west-1',
      endpoint: 'http://aws.test:4566',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' }
    })
  })

  test('reads local credentials from the standard environment when set', () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'local-key')
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'local-secret')

    expect(
      awsClientOptions({ endpoint: 'http://aws.test:4566' })
    ).toMatchObject({
      credentials: {
        accessKeyId: 'local-key',
        secretAccessKey: 'local-secret'
      }
    })
  })

  test('without an endpoint, leaves the endpoint and credentials to the AWS defaults', () => {
    vi.stubEnv('AWS_REGION', 'eu-west-2')

    expect(awsClientOptions()).toEqual({ region: 'eu-west-2' })
  })

  test('defaults the region from AWS_REGION, then to eu-west-2', () => {
    vi.stubEnv('AWS_REGION', 'eu-west-1')

    expect(awsClientOptions().region).toBe('eu-west-1')

    vi.stubEnv('AWS_REGION', undefined)

    expect(awsClientOptions().region).toBe('eu-west-2')
  })
})

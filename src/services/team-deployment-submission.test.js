import {
  createDocumentBuilder,
  refusalOf,
  traceOf
} from '#/services/team-deployment-submission.js'
import { Boom, boomWithCode } from '#/common/helpers/boom-with-code.js'

const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'

describe('team-deployment-submission', () => {
  describe('traceOf', () => {
    test('passes on a W3C traceparent and a request ID the command contract allows', () => {
      expect(
        traceOf({ traceParent: TRACEPARENT, cdpRequestId: 'req-1.a:b_c' })
      ).toEqual({ traceparent: TRACEPARENT, cdpRequestId: 'req-1.a:b_c' })
    })

    test.each([
      [undefined, undefined],
      ['not-a-traceparent', 'has spaces'],
      ['', 'x'.repeat(129)]
    ])('drops %j and %j', (traceParent, cdpRequestId) => {
      expect(traceOf({ traceParent, cdpRequestId })).toEqual({
        traceparent: null,
        cdpRequestId: null
      })
    })
  })

  describe('createDocumentBuilder', () => {
    const operation = {
      _id: 'op-1',
      teamId: 'team-1',
      environment: 'infradev',
      items: [{ entryId: 'e1', modelSlug: 'gpt-4o', change: 'add' }],
      requestedBy: 'entra:00000000-0000-0000-0000-000000000001'
    }
    const db = {}

    test('builds the operation’s items into the whole document, as the requester', async () => {
      const buildDesiredState = vi.fn().mockResolvedValue({
        document: { team: { slug: 'alpha' }, revision: 5 },
        expectedRevision: 4
      })
      const build = createDocumentBuilder(db, { buildDesiredState })

      expect(await build(operation)).toEqual({
        document: {
          team: { slug: 'alpha' },
          revision: 5,
          updatedBy: operation.requestedBy
        },
        expectedRevision: 4
      })
      expect(buildDesiredState).toHaveBeenCalledWith(db, {
        teamId: 'team-1',
        environment: 'infradev',
        items: operation.items,
        operationId: 'op-1'
      })
    })

    test('builds from revision 0 when the builder names none', async () => {
      const build = createDocumentBuilder(db, {
        buildDesiredState: async () => ({ document: { team: { slug: 'a1' } } })
      })

      expect((await build(operation)).expectedRevision).toBe(0)
    })

    test.each([
      ['no document', async () => null],
      ['a document with no team slug', async () => ({ document: {} })]
    ])('refuses %s as desired-state-unavailable', async (_name, builder) => {
      const build = createDocumentBuilder(db, { buildDesiredState: builder })

      await expect(build(operation)).rejects.toMatchObject({
        output: { statusCode: 501 },
        data: { code: 'desired-state-unavailable' }
      })
    })
  })

  describe('refusalOf', () => {
    test('passes on a refusal that already is an API error', () => {
      const refusal = boomWithCode(Boom.conflict, 'Busy', 'team-file-busy')

      expect(refusalOf(refusal, 'Failed')).toBe(refusal)
    })

    test('reports a document too large as 422', () => {
      const error = Object.assign(new Error('large'), {
        code: 'desired-state-too-large'
      })

      expect(refusalOf(error, 'Failed')).toMatchObject({
        output: { statusCode: 422 },
        data: { code: 'desired-state-too-large' }
      })
    })

    test('reports anything else as 502 upstream-unavailable with the message given', () => {
      expect(
        refusalOf(new Error('GitHub is down'), 'Failed to do it')
      ).toMatchObject({
        output: { statusCode: 502 },
        message: 'Failed to do it',
        data: { code: 'upstream-unavailable' }
      })
    })
  })
})

import Joi from 'joi'

import { createLogger } from './logging/logger.js'
import { failAction, failActionWithCode } from './fail-action.js'

describe('#fail-action', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('Should throw expected error', () => {
    const mockRequest = {}
    const mockToolkit = {}
    const mockError = Error('Something terrible has happened!')

    expect(() => failAction(mockRequest, mockToolkit, mockError)).toThrow(
      'Something terrible has happened!'
    )
  })

  test('logs an error that is not a validation error as it is', () => {
    const warn = vi.spyOn(createLogger(), 'warn').mockImplementation(() => {})
    const error = Error('Something terrible has happened!')

    expect(() => failAction({}, {}, error)).toThrow()
    expect(warn).toHaveBeenCalledWith(error, 'Something terrible has happened!')
  })

  test('logs no key of the payload, so an email sent as an unknown key never reaches the log (thread 1)', () => {
    const warn = vi.spyOn(createLogger(), 'warn').mockImplementation(() => {})
    const { error } = Joi.object({ search: Joi.string().min(3).required() })
      .unknown(false)
      .validate(
        { search: 'ab', 'alice@example.com': true },
        { abortEarly: false }
      )

    expect(() => failAction({}, {}, error)).toThrow(error)

    const logged = JSON.stringify(warn.mock.calls)

    expect(logged).not.toContain('alice')
    expect(logged).not.toContain('example.com')
    expect(logged).not.toContain('"ab"')
    expect(warn).toHaveBeenCalledWith(
      {
        validation: [{ type: 'string.min' }, { type: 'object.unknown' }]
      },
      'Request validation failed'
    )
  })

  test('logs no key of a wrapped validation error either', () => {
    const warn = vi.spyOn(createLogger(), 'warn').mockImplementation(() => {})
    const wrapped = Object.assign(new Error('bad'), {
      data: {
        details: [
          { path: ['payload', 'bob@example.com'], type: 'object.unknown' }
        ]
      }
    })

    expect(() => failAction({}, {}, wrapped)).toThrow('bad')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('bob@')
  })

  test('logs only the rules of a validation error, never the values it refused (F1)', () => {
    const warn = vi.spyOn(createLogger(), 'warn').mockImplementation(() => {})
    const { error } = Joi.object({
      search: Joi.string().min(2).required(),
      oid: Joi.string().pattern(/^x+$/)
    }).validate({ search: 'g', oid: 'secret-oid-value' }, { abortEarly: false })

    expect(() => failAction({}, {}, error)).toThrow(error)

    const logged = JSON.stringify(warn.mock.calls)

    expect(logged).not.toContain('"g"')
    expect(logged).not.toContain('secret-oid-value')
    expect(logged).not.toContain('_original')
    expect(warn).toHaveBeenCalledWith(
      {
        validation: [{ type: 'string.min' }, { type: 'string.pattern.base' }]
      },
      'Request validation failed'
    )
  })

  test('finds the details on a wrapped validation error too', () => {
    const warn = vi.spyOn(createLogger(), 'warn').mockImplementation(() => {})
    const wrapped = Object.assign(new Error('bad'), {
      data: { details: [{ path: ['payload', 'search'], type: 'any.required' }] }
    })

    expect(() => failAction({}, {}, wrapped)).toThrow('bad')
    expect(warn).toHaveBeenCalledWith(
      { validation: [{ type: 'any.required' }] },
      'Request validation failed'
    )
  })

  test('copes with a detail that has no path', () => {
    const warn = vi.spyOn(createLogger(), 'warn').mockImplementation(() => {})
    const error = Object.assign(new Error('bad'), {
      details: [{ type: 'object.unknown' }]
    })

    expect(() => failAction({}, {}, error)).toThrow('bad')
    expect(warn).toHaveBeenCalledWith(
      { validation: [{ type: 'object.unknown' }] },
      'Request validation failed'
    )
  })

  describe('failActionWithCode', () => {
    test('answers 400 with the stable code, never the refused value, and logs only the rule', () => {
      const warn = vi.spyOn(createLogger(), 'warn').mockImplementation(() => {})
      const { error } = Joi.object({ search: Joi.string().min(2) }).validate(
        { search: 'q' },
        { abortEarly: false }
      )
      const refuse = failActionWithCode('invalid-query', 'The query is invalid')

      let thrown

      try {
        refuse({}, {}, error)
      } catch (caught) {
        thrown = caught
      }

      expect(thrown.output.statusCode).toBe(400)
      expect(thrown.data).toEqual({ code: 'invalid-query' })
      expect(thrown.message).toBe('The query is invalid')
      expect(JSON.stringify(warn.mock.calls)).not.toContain('"q"')
      expect(warn).toHaveBeenCalledWith(
        { validation: [{ type: 'string.min' }] },
        'Request validation failed'
      )
    })
  })
})

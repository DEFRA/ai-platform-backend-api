import Joi from 'joi'

import { createLogger } from './logging/logger.js'
import { failAction } from './fail-action.js'

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

  test('logs only the paths and rules of a validation error, never the values it refused (F1)', () => {
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
        validation: [
          { path: 'search', type: 'string.min' },
          { path: 'oid', type: 'string.pattern.base' }
        ]
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
      { validation: [{ path: 'payload.search', type: 'any.required' }] },
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
      { validation: [{ path: undefined, type: 'object.unknown' }] },
      'Request validation failed'
    )
  })
})

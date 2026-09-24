import { acquireLock, requireLock, acquireLockWithRetry } from './mongo-lock.js'

describe('Lock Functions', () => {
  let locker
  let logger

  beforeEach(() => {
    locker = {
      lock: vi.fn()
    }
    logger = {
      error: vi.fn()
    }
  })

  describe('acquireLock', () => {
    test('should acquire lock and return it', async () => {
      const resource = 'testResource'
      const mockLock = { id: 'lockId' }

      locker.lock.mockResolvedValue(mockLock) // Mocking lock method to resolve a lock

      const result = await acquireLock(locker, resource, logger)

      expect(result).toEqual(mockLock)
      expect(logger.error).not.toHaveBeenCalled()
      expect(locker.lock).toHaveBeenCalledWith(resource)
    })

    test('should log error and return null if lock cannot be acquired', async () => {
      const resource = 'testResource'

      locker.lock.mockResolvedValue(null) // Mocking lock method to resolve to null

      const result = await acquireLock(locker, resource, logger)

      expect(result).toBeNull()
      expect(logger.error).toHaveBeenCalledWith(
        `Failed to acquire lock for ${resource}`
      )
      expect(locker.lock).toHaveBeenCalledWith(resource)
    })
  })

  describe('requireLock', () => {
    test('should acquire lock and return it', async () => {
      const resource = 'testResource'
      const mockLock = { id: 'lockId' }

      locker.lock.mockResolvedValue(mockLock) // Mocking lock method to resolve a lock

      const result = await requireLock(locker, resource)

      expect(result).toEqual(mockLock)
      expect(locker.lock).toHaveBeenCalledWith(resource)
    })

    test('should throw error if lock cannot be acquired', async () => {
      const resource = 'testResource'

      locker.lock.mockResolvedValue(null) // Mocking lock method to resolve to null

      await expect(requireLock(locker, resource)).rejects.toThrow(
        `Failed to acquire lock for ${resource}`
      )
      expect(locker.lock).toHaveBeenCalledWith(resource)
    })
  })

  describe('acquireLockWithRetry', () => {
    test('returns the lock on the first attempt when it is free', async () => {
      const mockLock = { id: 'lockId' }

      locker.lock.mockResolvedValue(mockLock)

      await expect(acquireLockWithRetry(locker, 'testResource')).resolves.toBe(
        mockLock
      )
      expect(locker.lock).toHaveBeenCalledTimes(1)
    })

    test('retries while the lock is held, then returns it', async () => {
      const mockLock = { id: 'lockId' }

      locker.lock
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValue(mockLock)

      await expect(
        acquireLockWithRetry(locker, 'testResource', { delayMs: 1 })
      ).resolves.toBe(mockLock)
      expect(locker.lock).toHaveBeenCalledTimes(3)
    })

    test('throws once the attempts are exhausted', async () => {
      locker.lock.mockResolvedValue(null)

      await expect(
        acquireLockWithRetry(locker, 'testResource', {
          attempts: 3,
          delayMs: 1
        })
      ).rejects.toThrow('Failed to acquire lock for testResource')
      expect(locker.lock).toHaveBeenCalledTimes(3)
    })
  })
})

import { randomBytes } from 'node:crypto'

/**
 * A UUID version 7: a 48-bit millisecond timestamp, then random bits, so IDs
 * sort by creation time. Used for operation IDs and command IDs (plan 5),
 * where the command ID is also the SQS deduplication ID.
 * @param {number} [now] - milliseconds since the epoch
 * @returns {string}
 */
export function uuidv7(now = Date.now()) {
  const bytes = randomBytes(16)

  bytes.writeUIntBE(now, 0, 6)
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  const hex = bytes.toString('hex')

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join('-')
}

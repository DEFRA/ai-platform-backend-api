import { randomBytes } from 'node:crypto'

const UUID_BYTES = 16
const TIMESTAMP_BYTES = 6
const VERSION_BYTE = 6
const VARIANT_BYTE = 8
const LOW_NIBBLE_MASK = 0x0f
const VERSION_7 = 0x70
const LOW_SIX_BITS_MASK = 0x3f
const VARIANT_RFC_9562 = 0x80
// Hex digits in each dash-separated group of a UUID.
const UUID_GROUP_LENGTHS = [8, 4, 4, 4, 12]

function groupHex(hex) {
  let offset = 0

  return UUID_GROUP_LENGTHS.map((length) => {
    const group = hex.slice(offset, offset + length)

    offset += length

    return group
  }).join('-')
}

/**
 * A UUID version 7: a 48-bit millisecond timestamp, then random bits, so IDs
 * sort by creation time. Used for operation IDs and command IDs (plan 5),
 * where the command ID is also the SQS deduplication ID.
 * @param {number} [now] - milliseconds since the epoch
 * @returns {string}
 */
export function uuidv7(now = Date.now()) {
  const bytes = randomBytes(UUID_BYTES)

  bytes.writeUIntBE(now, 0, TIMESTAMP_BYTES)
  bytes[VERSION_BYTE] = (bytes[VERSION_BYTE] & LOW_NIBBLE_MASK) | VERSION_7
  bytes[VARIANT_BYTE] =
    (bytes[VARIANT_BYTE] & LOW_SIX_BITS_MASK) | VARIANT_RFC_9562

  return groupHex(bytes.toString('hex'))
}

import {
  COMPRESSION_ENVELOPE_HEADER_SIZE,
  type CompressionAlgorithm,
  type CompressionResult,
  getCompressionAlgorithmById,
  getCompressionAlgorithmId,
} from './compression.mjs';

/**
 * Offset of the 4-byte magic marker in an envelope.
 */
export const COMPRESSION_ENVELOPE_MAGIC_OFFSET = 0;

/**
 * Size of the magic marker in bytes.
 */
export const COMPRESSION_ENVELOPE_MAGIC_SIZE = 4;

/**
 * Offset of the algorithm id field in an envelope.
 */
export const COMPRESSION_ENVELOPE_ALGORITHM_ID_OFFSET = 4;

/**
 * Offset of the original payload size field in an envelope.
 */
export const COMPRESSION_ENVELOPE_ORIGINAL_SIZE_OFFSET = 5;

/**
 * Offset of the compressed payload size field in an envelope.
 */
export const COMPRESSION_ENVELOPE_COMPRESSED_SIZE_OFFSET = 9;

/**
 * Encodes a compressed payload into the standard compression envelope format.
 *
 * Envelope v1 layout (13 bytes metadata):
 * - 4 bytes magic
 * - 1 byte algorithm id
 * - 4 bytes original size (UInt32LE)
 * - 4 bytes compressed size (UInt32LE)
 *
 * @param {Buffer} magic - 4-byte format marker.
 * @param {CompressionResult} result - Compression metadata and payload.
 * @returns {Buffer} Serialized envelope bytes.
 */
export function serializeCompressionEnvelope(magic: Buffer, result: CompressionResult): Buffer {
  if (magic.length !== COMPRESSION_ENVELOPE_MAGIC_SIZE) {
    throw new Error(`Envelope magic must be ${COMPRESSION_ENVELOPE_MAGIC_SIZE} bytes`);
  }

  const metadata = Buffer.alloc(COMPRESSION_ENVELOPE_HEADER_SIZE);
  const algorithmId = getCompressionAlgorithmId(result.algorithm);

  magic.copy(metadata, COMPRESSION_ENVELOPE_MAGIC_OFFSET);
  metadata.writeUInt8(algorithmId, COMPRESSION_ENVELOPE_ALGORITHM_ID_OFFSET);
  metadata.writeUInt32LE(result.originalSize >>> 0, COMPRESSION_ENVELOPE_ORIGINAL_SIZE_OFFSET);
  metadata.writeUInt32LE(result.compressedSize >>> 0, COMPRESSION_ENVELOPE_COMPRESSED_SIZE_OFFSET);

  return Buffer.concat([metadata, result.payload]);
}

/**
 * Decodes a standard compression envelope (v1 metadata layout).
 *
 * @param {Buffer} payload - Envelope bytes to decode.
 * @param {Buffer} expectedMagic - Expected 4-byte format marker.
 * @returns {CompressionResult | null} Parsed compression result, or null when payload does not match the format.
 */
export function deserializeCompressionEnvelope(payload: Buffer, expectedMagic: Buffer): CompressionResult | null {
  if (expectedMagic.length !== COMPRESSION_ENVELOPE_MAGIC_SIZE) {
    throw new Error(`Envelope magic must be ${COMPRESSION_ENVELOPE_MAGIC_SIZE} bytes`);
  }

  if (payload.length < COMPRESSION_ENVELOPE_HEADER_SIZE) {
    return null;
  }

  if (!payload.subarray(COMPRESSION_ENVELOPE_MAGIC_OFFSET, COMPRESSION_ENVELOPE_MAGIC_SIZE).equals(expectedMagic)) {
    return null;
  }

  const algorithmId = payload.readUInt8(COMPRESSION_ENVELOPE_ALGORITHM_ID_OFFSET);
  let algorithm: CompressionAlgorithm;
  try {
    algorithm = getCompressionAlgorithmById(algorithmId);
  } catch {
    return null;
  }

  const originalSize = payload.readUInt32LE(COMPRESSION_ENVELOPE_ORIGINAL_SIZE_OFFSET);
  const compressedSize = payload.readUInt32LE(COMPRESSION_ENVELOPE_COMPRESSED_SIZE_OFFSET);
  const payloadStart = COMPRESSION_ENVELOPE_HEADER_SIZE;
  const payloadEnd = payloadStart + compressedSize;

  if (payloadEnd !== payload.length) {
    return null;
  }

  return {
    algorithm,
    originalSize,
    compressedSize,
    payload: Buffer.from(payload.subarray(payloadStart, payloadEnd)),
  };
}

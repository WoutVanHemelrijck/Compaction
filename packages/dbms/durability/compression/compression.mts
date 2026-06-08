// @author Tijn Gommers
// @date 2026-03-03

import {
  brotliCompressSync,
  brotliDecompressSync,
  deflateSync,
  gunzipSync,
  gzipSync,
  inflateSync,
  zstdCompressSync,
  zstdDecompressSync,
} from 'node:zlib';

export type CompressionAlgorithm = 'zstd' | 'gzip' | 'brotli' | 'deflate';

// Compression envelope layout (13 bytes total):
// - 4 bytes magic marker to identify compressed payload format
// - 1 byte algorithm id (currently zstd = 1)
// - 4 bytes original (uncompressed) payload size (UInt32LE)
// - 4 bytes compressed payload size (UInt32LE)
export const COMPRESSION_ALGORITHM_ZSTD_ID: number = 1;
export const COMPRESSION_ALGORITHM_GZIP_ID: number = 2;
export const COMPRESSION_ALGORITHM_BROTLI_ID: number = 3;
export const COMPRESSION_ALGORITHM_DEFLATE_ID: number = 4;

export const COMPRESSION_ENVELOPE_MAGIC_SIZE: number = 4;
export const COMPRESSION_ENVELOPE_ALGORITHM_ID_SIZE: number = 1;
export const COMPRESSION_ENVELOPE_SIZE_FIELD_SIZE: number = 4;
export const COMPRESSION_ENVELOPE_HEADER_SIZE: number =
  COMPRESSION_ENVELOPE_MAGIC_SIZE +
  COMPRESSION_ENVELOPE_ALGORITHM_ID_SIZE +
  COMPRESSION_ENVELOPE_SIZE_FIELD_SIZE +
  COMPRESSION_ENVELOPE_SIZE_FIELD_SIZE;
// Magic markers are custom format identifiers:
// - FBC1: FreeBlock compressed payload envelope, version 1
// - ZST1: Node-storage zstd payload envelope, version 1
export const FREEBLOCK_COMPRESSED_PAYLOAD_MAGIC: Buffer = Buffer.from('FBC1', 'ascii');
export const NODE_STORAGE_COMPRESSED_PAYLOAD_MAGIC: Buffer = Buffer.from('ZST1', 'ascii');
export const DEFAULT_COMPRESSION_ALGORITHM: CompressionAlgorithm = 'zstd';
export const COMPRESSION_ALGORITHM_ENV_VAR = 'COMPRESSION_ALGO';
export const COMPRESSION_ALGORITHMS: CompressionAlgorithm[] = ['zstd', 'gzip', 'brotli', 'deflate'];
let hasLoggedCompressionAlgorithmSelection = false;

const COMPRESSION_ALGORITHM_ID_MAP: Record<CompressionAlgorithm, number> = {
  zstd: COMPRESSION_ALGORITHM_ZSTD_ID,
  gzip: COMPRESSION_ALGORITHM_GZIP_ID,
  brotli: COMPRESSION_ALGORITHM_BROTLI_ID,
  deflate: COMPRESSION_ALGORITHM_DEFLATE_ID,
};

const COMPRESSION_ID_ALGORITHM_MAP: Record<number, CompressionAlgorithm> = {
  [COMPRESSION_ALGORITHM_ZSTD_ID]: 'zstd',
  [COMPRESSION_ALGORITHM_GZIP_ID]: 'gzip',
  [COMPRESSION_ALGORITHM_BROTLI_ID]: 'brotli',
  [COMPRESSION_ALGORITHM_DEFLATE_ID]: 'deflate',
};

/**
 * Gets the numeric envelope ID for a compression algorithm.
 *
 * @param {CompressionAlgorithm} algorithm - The compression algorithm name.
 * @returns {number} The numeric algorithm ID used in envelope headers.
 * @throws {Error} If the algorithm is unknown.
 */
export function getCompressionAlgorithmId(algorithm: CompressionAlgorithm): number {
  if (!(algorithm in COMPRESSION_ALGORITHM_ID_MAP)) {
    throw new Error(`Unknown compression algorithm '${algorithm}'`);
  }
  return COMPRESSION_ALGORITHM_ID_MAP[algorithm];
}

/**
 * Resolves a numeric envelope ID to a compression algorithm.
 *
 * @param {number} id - The numeric algorithm ID stored in an envelope header.
 * @returns {CompressionAlgorithm} The mapped algorithm.
 * @throws {Error} If the algorithm ID is unknown.
 */
export function getCompressionAlgorithmById(id: number): CompressionAlgorithm {
  if (!(id in COMPRESSION_ID_ALGORITHM_MAP)) {
    throw new Error(`Unknown compression algorithm ID '${id}' in envelope header`);
  }
  return COMPRESSION_ID_ALGORITHM_MAP[id];
}

/**
 * Parses and validates a compression algorithm string from configuration.
 *
 * @param {string | undefined} value - Raw algorithm value (e.g. from environment variables).
 * @param {CompressionAlgorithm} fallback - Fallback algorithm when input is empty or invalid.
 * @returns {CompressionAlgorithm} A valid compression algorithm.
 */
export function parseCompressionAlgorithm(
  value: string | undefined,
  fallback: CompressionAlgorithm = DEFAULT_COMPRESSION_ALGORITHM,
): CompressionAlgorithm {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (COMPRESSION_ALGORITHMS.includes(normalized as CompressionAlgorithm)) {
    return normalized as CompressionAlgorithm;
  }

  return fallback;
}

/**
 * Resolves the compression algorithm from environment configuration and logs the
 * selected value once per process.
 *
 * @param {NodeJS.ProcessEnv} env - Environment variables to read from.
 * @returns {CompressionAlgorithm} The selected compression algorithm.
 */
export function resolveCompressionAlgorithmFromEnvironment(env: NodeJS.ProcessEnv = process.env): CompressionAlgorithm {
  const raw = env[COMPRESSION_ALGORITHM_ENV_VAR];
  const selected = parseCompressionAlgorithm(raw, DEFAULT_COMPRESSION_ALGORITHM);

  if (!hasLoggedCompressionAlgorithmSelection) {
    const normalized = raw?.trim().toLowerCase();
    if (raw && normalized !== selected) {
      console.warn(`[compression] Invalid ${COMPRESSION_ALGORITHM_ENV_VAR}='${raw}'. Falling back to '${selected}'.`);
    }
    hasLoggedCompressionAlgorithmSelection = true;
  }

  return selected;
}

export interface CompressionOptions {
  algorithm: CompressionAlgorithm;
  minSizeBytes?: number;
}

export interface CompressionResult {
  algorithm: CompressionAlgorithm;
  originalSize: number;
  compressedSize: number;
  payload: Buffer;
}

export class CompressionService {
  private readonly options: CompressionOptions;

  /**
   * Creates a new compression service.
   *
   * @param {CompressionOptions} options - Compression settings for this instance.
   */
  constructor(options: CompressionOptions = { algorithm: DEFAULT_COMPRESSION_ALGORITHM, minSizeBytes: 0 }) {
    this.options = options;
  }

  /**
   * Returns the active compression options.
   *
   * @returns {CompressionOptions} The configured compression options.
   */
  getOptions(): CompressionOptions {
    return this.options;
  }

  /**
   * Compresses a buffer using the configured algorithm.
   *
   * @param {Buffer} data - The input buffer to compress.
   * @returns {CompressionResult} Compression metadata and compressed payload.
   * @throws {Error} If the input is not a Buffer.
   */
  compress(data: Buffer): CompressionResult {
    if (!Buffer.isBuffer(data)) {
      throw new Error('CompressionService.compress expects a Buffer');
    }

    const algorithm = this.options.algorithm;
    let compressed: Buffer;

    switch (algorithm) {
      case 'zstd':
        compressed = zstdCompressSync(data);
        break;
      case 'gzip':
        compressed = gzipSync(data);
        break;
      case 'brotli':
        compressed = brotliCompressSync(data);
        break;
      case 'deflate':
        compressed = deflateSync(data);
        break;
      default:
        throw new Error(`Compression algorithm '${String(algorithm)}' is not supported`);
    }

    return {
      algorithm,
      originalSize: data.length,
      compressedSize: compressed.length,
      payload: compressed,
    };
  }

  /**
   * Decompresses a previously compressed payload.
   *
   * @param {CompressionResult} compressed - Compressed payload and metadata.
   * @returns {Buffer} The decompressed payload.
   * @throws {Error} If the payload type is invalid, algorithm is unsupported, or sizes do not match.
   */
  decompress(compressed: CompressionResult): Buffer {
    if (!Buffer.isBuffer(compressed.payload)) {
      throw new Error('CompressionService.decompress expects CompressionResult.payload to be a Buffer');
    }

    if (compressed.payload.length !== compressed.compressedSize) {
      throw new Error('CompressionResult.compressedSize does not match payload length');
    }

    let decompressed: Buffer;
    switch (compressed.algorithm) {
      case 'zstd':
        decompressed = zstdDecompressSync(compressed.payload);
        break;
      case 'gzip':
        decompressed = gunzipSync(compressed.payload);
        break;
      case 'brotli':
        decompressed = brotliDecompressSync(compressed.payload);
        break;
      case 'deflate':
        decompressed = inflateSync(compressed.payload);
        break;
      default:
        throw new Error(`Decompression algorithm '${compressed.algorithm as string}' is not supported`);
    }

    if (decompressed.length !== compressed.originalSize) {
      throw new Error('Decompressed payload size does not match originalSize');
    }
    return decompressed;
  }
}

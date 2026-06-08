// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { LogEntry, LogEntryType } from '../log/LogEntry';
import { StorageError } from '../util/Error';

/** Atomic key-value storage mutation operation descriptor. */
export interface StorageOperation {
  type: 'set' | 'delete';
  key: string;
  value?: Buffer;
}

/** Numeric conversion helpers with safety checks for storage boundaries. */
export class StorageNumberUtil {
  /** Throws when value is not a JS safe integer. */
  static assertSafeInteger(value: number, field: string): void {
    if (!Number.isSafeInteger(value)) {
      throw new StorageError(`${field} must be a safe integer, got ${value}`);
    }
  }

  /** Converts bigint to safe number or throws when outside safe range. */
  static bigIntToSafeNumber(value: bigint, field: string): number {
    const num = Number(value);
    if (!Number.isSafeInteger(num)) {
      throw new StorageError(`${field} is outside JS safe integer range: ${value.toString()}`);
    }
    return num;
  }
}

/**
 * Serialization and encoding helpers used by storage implementations.
 */
export class StorageCodec {
  static readonly encoding: BufferEncoding = 'utf-8';

  /** Encodes a safe integer into 8-byte big-endian buffer. */
  static encodeNumber(num: number): Buffer {
    if (!Number.isSafeInteger(num)) {
      throw new StorageError(`Number ${num} must be a safe integer`);
    }

    const buffer = Buffer.alloc(8);
    buffer.writeBigInt64BE(BigInt(num), 0);

    return buffer;
  }

  /** Decodes 8-byte big-endian buffer into safe integer. */
  static decodeNumber(buffer: Buffer): number {
    if (buffer.length !== 8) {
      throw new StorageError(`Buffer length must be 8 bytes to decode a number, got ${buffer.length}`);
    }

    const bigIntValue = buffer.readBigInt64BE(0);
    const num = Number(bigIntValue);

    if (!Number.isSafeInteger(num)) {
      throw new StorageError(`Decoded number ${num} is not a safe integer`);
    }

    return num;
  }

  /** Encodes string using configured storage encoding. */
  static encodeString(str: string): Buffer {
    if (typeof str !== 'string') {
      throw new StorageError(`Value must be a string, got ${typeof str}`);
    }
    return Buffer.from(str, StorageCodec.encoding);
  }

  /** Decodes string buffer using configured storage encoding. */
  static decodeString(buffer: Buffer): string {
    if (!Buffer.isBuffer(buffer)) {
      throw new StorageError(`Value must be a Buffer, got ${typeof buffer}`);
    }

    return buffer.toString(StorageCodec.encoding);
  }

  /** Encodes JSON-serializable object into buffer. */
  static encodeJSON(obj: unknown): Buffer {
    try {
      const jsonString = JSON.stringify(obj);
      return Buffer.from(jsonString, StorageCodec.encoding);
    } catch (error) {
      throw new StorageError(`Failed to encode JSON: ${(error as Error).message}`); // json.stringify can only throw syntax errors
    }
  }

  /** Decodes JSON buffer into typed object. */
  static decodeJSON<T>(buffer: Buffer): T {
    try {
      const bufStr = buffer.toString(StorageCodec.encoding);
      const parsed: unknown = JSON.parse(bufStr);
      return parsed as T;
    } catch (error) {
      throw new StorageError(`Failed to decode JSON: ${(error as Error).message}`); // idem
    }
  }

  /** Serializes log entry into storage-friendly raw object representation. */
  static serializeLogEntry(entry: LogEntry): object {
    if (entry.type === LogEntryType.CONFIG) {
      return {
        term: entry.term,
        index: entry.index,
        type: entry.type,
        config: JSON.stringify(entry.config),
      };
    }

    if (entry.type === LogEntryType.NOOP) {
      return {
        term: entry.term,
        index: entry.index,
        type: entry.type,
      };
    }

    if (entry.type === LogEntryType.DROPLOG) {
      return {
        index: entry.index,
        term: entry.term,
        type: entry.type,
        startIdx: entry.startIdx,
        finalIdx: entry.finalIdx,
      };
    }

    if (!entry.command) {
      throw new StorageError('COMMAND entry is missing command payload');
    }

    return {
      term: entry.term,
      index: entry.index,
      type: entry.type,
      command: {
        type: entry.command.type,
        payload: Buffer.from(JSON.stringify(entry.command.payload)),
      },
    };
  }

  /** Deserializes raw storage object into typed LogEntry. */
  static deserializeLogEntry(raw: unknown): LogEntry {
    if (typeof raw !== 'object' || raw === null) {
      throw new StorageError('Expected object for deserialization');
    }

    const obj = raw as Record<string, unknown>;
    if (obj.type === LogEntryType.CONFIG) {
      let config: LogEntry['config'];
      if (typeof obj.config === 'string') {
        const parsedConfig: unknown = JSON.parse(obj.config);
        config = parsedConfig as LogEntry['config'];
      } else {
        config = obj.config as LogEntry['config'];
      }

      return {
        term: obj.term as number,
        index: obj.index as number,
        type: LogEntryType.CONFIG,
        config,
      };
    }

    if (obj.type === LogEntryType.NOOP) {
      return {
        term: obj.term as number,
        index: obj.index as number,
        type: LogEntryType.NOOP,
      };
    }

    if (obj.type === LogEntryType.DROPLOG) {
      return {
        index: obj.index as number,
        term: obj.term as number,
        type: obj.type as LogEntryType.DROPLOG,
        startIdx: obj.startIdx as number,
        finalIdx: obj.finalIdx as number,
      };
    }

    const cmd = obj.command as Record<string, unknown>;
    const payloadRaw = cmd.payload;
    let payloadText: string;
    if (Buffer.isBuffer(payloadRaw)) {
      payloadText = payloadRaw.toString();
    } else if (typeof payloadRaw === 'string') {
      payloadText = payloadRaw;
    } else {
      throw new StorageError('COMMAND payload must be a Buffer or string');
    }

    const commandPayload: unknown = JSON.parse(payloadText);

    return {
      term: obj.term as number,
      index: obj.index as number,
      type: LogEntryType.COMMAND,
      command: {
        type: cmd.type as string,
        payload: commandPayload,
      },
    };
  }
}

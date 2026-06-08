// @author: Frederick Hillen
// @date: 2026-05-02

/**
 * Index Builder Worker Thread
 *
 * Runs in a worker thread and collects/sorts index entries for a single field.
 */

import { parentPort } from 'node:worker_threads';
import type { Document } from '../core/simpledbms.mjs';

interface WorkerInitMessage {
  type: 'init';
  fieldName: string;
  batchSize: number;
}

interface WorkerDocumentMessage {
  type: 'document';
  document: Omit<Document, 'id'> & { id: string };
  startBlockId?: number;
}

interface WorkerFinalizeMessage {
  type: 'finalize';
}

type WorkerMessage = WorkerInitMessage | WorkerDocumentMessage | WorkerFinalizeMessage;

interface IndexEntry {
  key: string;
  value: number;
  directBlockId?: number;
}

function serializeFieldValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';

  if (typeof value === 'boolean') {
    return value ? 'boolT' : 'boolF';
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      if (Number.isNaN(value)) return 'num:NaN';
      return value === Infinity ? 'num:+Inf' : 'num:-Inf';
    }

    const sign = value < 0 ? '-' : '+';
    const abs = Math.abs(value);
    const intPart = Math.floor(abs).toString().padStart(16, '0');
    const fracPart = Math.round((abs - Math.floor(abs)) * 1e8)
      .toString()
      .padStart(8, '0');
    return `num:${sign}${intPart}.${fracPart}`;
  }

  if (typeof value === 'bigint') {
    const sign = value < 0n ? '-' : '+';
    const abs = value < 0n ? -value : value;
    return `bigint:${sign}${abs.toString().padStart(20, '0')}`;
  }

  if (typeof value === 'object' && value !== null) {
    return `str:${JSON.stringify(value)}`;
  }

  if (value === undefined) {
    return 'str:undefined';
  }

  return `str:${value as string | number | boolean | bigint}`;
}

let fieldName: string = '';
let batchSize: number = 1000;
let entries: IndexEntry[] = [];

/**
 * Process a single document and extract the field value.
 */
function processDocument(doc: Omit<Document, 'id'> & { id: string }, startBlockId?: number): void {
  const fieldValue = doc[fieldName];
  if (fieldValue !== undefined && fieldValue !== null) {
    const indexKey = serializeFieldValue(fieldValue) + ':' + doc.id;
    const resolvedBlockId = typeof startBlockId === 'number' ? startBlockId : 0;
    entries.push({
      key: indexKey,
      value: resolvedBlockId,
      directBlockId: typeof startBlockId === 'number' ? startBlockId : undefined,
    });

    // Send batch if we've accumulated enough
    if (entries.length >= batchSize) {
      sendBatch();
    }
  }
}

/**
 * Send a batch of collected entries to the main thread.
 */
function sendBatch(): void {
  if (entries.length === 0) return;

  // Sort before sending
  entries.sort((a, b) => {
    if (a.key < b.key) return -1;
    if (a.key > b.key) return 1;
    return 0;
  });

  if (parentPort) {
    parentPort.postMessage({
      type: 'batch',
      entries: entries.splice(0, entries.length), // Send and clear
    });
  }
}

/**
 * Handle messages from the main thread.
 */
if (parentPort) {
  parentPort.on('message', (msg: WorkerMessage) => {
    switch (msg.type) {
      case 'init':
        fieldName = msg.fieldName;
        batchSize = msg.batchSize;
        entries = [];
        break;

      case 'document':
        if (msg.document) {
          processDocument(msg.document, msg.startBlockId);
        }
        break;

      case 'finalize':
        // Sort remaining entries and send
        if (entries.length > 0) {
          entries.sort((a, b) => {
            if (a.key < b.key) return -1;
            if (a.key > b.key) return 1;
            return 0;
          });
          parentPort?.postMessage({
            type: 'done',
            entries,
          });
        } else {
          parentPort?.postMessage({
            type: 'done',
            entries: [],
          });
        }
        break;

      default:
        parentPort?.postMessage({
          type: 'error',
          error: `Unknown message type`,
        });
    }
  });

  parentPort.on('error', (err: Error) => {
    parentPort?.postMessage({
      type: 'error',
      error: err.message,
    });
  });
}

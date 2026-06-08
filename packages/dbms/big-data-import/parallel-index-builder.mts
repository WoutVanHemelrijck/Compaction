// @author: Frederick Hillen
// @date: 2026-05-02

/**
 * Parallel Index Builder for Wikipedia import
 *
 * Builds secondary indexes concurrently during document import.
 * Each worker thread collects entries for one field, sorts them in batches,
 * and returns pre-sorted data for efficient B+ tree construction.
 */

import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Document } from '../core/simpledbms.mjs';
import { DiskBackedIndexStorage } from './disk-backed-index-builder.mjs';

export interface IndexBuilderWorkerMessage {
  type: 'init' | 'document' | 'finalize';
  fieldName?: string;
  document?: Omit<Document, 'id'> & { id: string };
  startBlockId?: number;
  batchSize?: number;
}

export interface WorkerResultMessage {
  type: 'batch' | 'done' | 'error';
  entries?: Array<{ key: string; value: number; directBlockId?: number }>;
  error?: string;
}

/**
 * Manages multiple worker threads for parallel index entry collection.
 */
export class ParallelIndexBuilder {
  private workers: Map<string, Worker> = new Map();
  private workerPromises: Map<string, Promise<void>> = new Map();
  private collectedEntries: Map<string, DiskBackedIndexStorage> = new Map();
  private workerScript: string | null = null;
  private readonly BATCH_SIZE = 50000;
  private isRecoveryMode = false;

  constructor() {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const compiledWorker = path.join(moduleDir, 'index-builder-worker.mjs');
    const sourceWorker = path.join(moduleDir, 'index-builder-worker.mts');

    if (existsSync(compiledWorker)) {
      this.workerScript = compiledWorker;
    } else if (existsSync(sourceWorker)) {
      this.workerScript = sourceWorker;
    }
  }

  /**
   * Recover from existing index chunk files.
   * Skips document insertion and goes straight to finalization.
   * @param {Record<string, string[]>} fieldToChunkFiles - Map of field name to chunk file paths
   */
  recoverFromExistingChunks(fieldToChunkFiles: Record<string, string[]>): void {
    this.isRecoveryMode = true;
    for (const [fieldName, chunkFiles] of Object.entries(fieldToChunkFiles)) {
      const storage = DiskBackedIndexStorage.fromExistingChunks(chunkFiles);
      this.collectedEntries.set(fieldName, storage);
      // In recovery mode, we skip worker initialization since we have the chunks already
      this.workerPromises.set(fieldName, Promise.resolve());
    }
    console.log(`Recovered ${this.collectedEntries.size} field index chunk files`);
  }

  /**
   * Check if recovery mode is active (no document processing needed)
   */
  isInRecoveryMode(): boolean {
    return this.isRecoveryMode;
  }

  /**
   * Initialize workers for the given field names.
   * @param {string[]} fieldNames - The field names to index
   */
  initialize(fieldNames: string[]): void {
    if (!this.workerScript) {
      throw new Error('Parallel index worker script not found.');
    }

    for (const fieldName of fieldNames) {
      const worker = new Worker(this.workerScript);
      this.workers.set(fieldName, worker);
      this.collectedEntries.set(fieldName, new DiskBackedIndexStorage());

      // Set up worker promise that resolves when worker signals done
      const promise = new Promise<void>((resolve, reject) => {
        const rejectWithError = (reason: unknown): void => {
          reject(reason instanceof Error ? reason : new Error(String(reason)));
        };

        worker.on('message', (msg: WorkerResultMessage) => {
          if (msg.type === 'error') {
            reject(new Error(msg.error || 'Worker error'));
          } else if (msg.type === 'done') {
            // Store final entries before resolving
            void (async () => {
              if (msg.entries && msg.entries.length > 0) {
                const storage = this.collectedEntries.get(fieldName);
                if (storage) {
                  await storage.add(msg.entries);
                }
              }
              resolve();
            })().catch((err) => {
              console.error(`Error storing final batch for field ${fieldName}:`, err);
              rejectWithError(err);
            });
          } else if (msg.type === 'batch') {
            // Batch of entries collected by worker
            void (async () => {
              if (msg.entries) {
                // Store in disk-backed storage to prevent memory overflow
                const storage = this.collectedEntries.get(fieldName);
                if (storage) {
                  await storage.add(msg.entries);
                }
              }
            })().catch((err) => {
              console.error(`Error storing batch for field ${fieldName}:`, err);
              rejectWithError(err);
            });
          }
        });

        worker.on('error', reject);
        worker.on('exit', (code) => {
          if (code !== 0) {
            reject(new Error(`Worker exited with code ${code}`));
          }
        });
      });

      this.workerPromises.set(fieldName, promise);

      // Initialize the worker with the field name
      const initMsg: IndexBuilderWorkerMessage = {
        type: 'init',
        fieldName,
        batchSize: this.BATCH_SIZE,
      };
      worker.postMessage(initMsg);
    }
  }

  /**
   * Send a document to be processed by all workers.
   * Skipped in recovery mode.
   * @param {Document} doc - The document to process
   */
  sendDocument(doc: Omit<Document, 'id'> & { id: string }, startBlockId?: number): void {
    if (this.isRecoveryMode) {
      // Skip in recovery mode
      return;
    }
    for (const worker of this.workers.values()) {
      const msg: IndexBuilderWorkerMessage = {
        type: 'document',
        document: doc,
        startBlockId,
      };
      worker.postMessage(msg);
    }
  }

  /**
   * Finalize indexing and retrieve the disk-backed entry sources per field.
   * The caller should stream entries from the returned storages before cleanup.
   * In recovery mode, simply returns the recovered storages.
   */
  async finalize(): Promise<Map<string, DiskBackedIndexStorage>> {
    if (!this.isRecoveryMode) {
      // Send finalize message to all workers
      for (const worker of this.workers.values()) {
        const msg: IndexBuilderWorkerMessage = { type: 'finalize' };
        worker.postMessage(msg);
      }
    }

    // Wait for all workers to complete
    const resultMap = new Map<string, DiskBackedIndexStorage>();
    const promises = Array.from(this.workerPromises.entries()).map(async ([fieldName, promise]) => {
      try {
        await promise;

        const storage = this.collectedEntries.get(fieldName);
        if (storage) {
          resultMap.set(fieldName, storage);
        }
      } catch (error) {
        console.error(`Error from worker for field ${fieldName}:`, error);
      }
    });

    await Promise.all(promises);

    // Terminate all workers (in recovery mode, there are none)
    for (const worker of this.workers.values()) {
      await worker.terminate();
    }

    return resultMap;
  }
}

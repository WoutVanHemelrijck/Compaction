// @author Maarten Haine, Jari Daemen, William Ragnarsson
// @date 2025-04-10

import 'dotenv/config';
import express from 'express';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';
import {
  SimpleDBMS,
  type DocumentValue,
  type Document,
  type AggregateQuery,
  type FilterOperators,
  Collection,
} from '../../packages/dbms/core/simpledbms.mjs';
import { RealFile } from '../../packages/dbms/storage/file/file.mjs';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  authenticateToken,
  addTokenToResponse,
  generateToken,
  validateAndRefreshToken,
  type AuthenticatedRequest,
} from '../../packages/auth/authentication.mjs';
import { PasswordHasher } from '../../packages/auth/password-hashing.mjs';
import { readFile } from 'fs/promises';
import { rename, writeFile, unlink, access } from 'node:fs/promises';
import {
  compactDatabase,
  shrinkDatabase,
  buildBlockMap,
  inspectIndexContents,
} from '../../packages/dbms/durability/compaction/compaction.mjs';
import { RWLock } from '../../packages/dbms/durability/compaction/rw-lock.mjs';
import {
  AutoCompactor,
  readAutoCompactionConfigFromEnv,
} from '../../packages/dbms/durability/compaction/auto-compaction.mjs';
import { existsSync } from 'fs';
import { RagAgent } from '../../packages/nlp/rag/agent.mjs';

import {
  debug_getFnCallCounts,
  debug_getDiskReadCount,
  debug_getOverwriteSources,
  debug_getAllocWriteSources,
  debug_getWriteCounts,
} from '../../packages/dbms/core/debug-global-constants.mjs';

import { RaftNode, DiskNodeStorage, Command } from '@maboke123/raft-core';
import { GrpcTransport } from '@maboke123/raft-grpc';

import { randomUUID } from 'node:crypto';
import { Interpreter } from '../../packages/query-language/index.mjs';
import { deepEqual } from 'node:assert';

import fs from 'fs/promises';

/**
 * Needs access to the `db` to write to it
 */
export class daemonFSM {
  private counter: number = 0;
  private TRESHOLD: number = 1; // TRESHOLD for when to sseparate logs (a.i., do not replay)
  private bufferedCommands: Command[] = [];
  incrementCounter(): void {
    this.counter += 1;
    return;
  }
  resetCounter(): void {
    this.counter = 0;
    return;
  }

  private raftNode: RaftNode | null = null;

  setRaftNode(node: RaftNode): void {
    this.raftNode = node;
  }

  private db: SimpleDBMS | null = null;
  setDB(db: SimpleDBMS): void {
    this.db = db;
  }

  private onSnapshotInstalled?: () => Promise<void>;
  setOnSnapshotInstalled(callback: () => Promise<void>): void {
    this.onSnapshotInstalled = callback;
  }

  /**
   * [[ SNAPSHOTTING ]]
   */
  /**
   * Take snapshot by copying the files directly to snapshot files.
   *
   * We need to capture both the .db (index) and the .heap (data) files.
   * We also must perform a checkpoint to ensure WAL is flushed to disk.
   */
  async takeSnapshot(): Promise<Buffer> {
    if (!this.raftNode) {
      throw Error('raft node is null/undefined...');
    }
    if (!this.db) {
      throw Error('db is null/undefined during snapshot...');
    }

    const nodeId = this.raftNode.getNodeId();
    console.log(`[daemonFSM] Node ${nodeId} taking snapshot...`);

    // 1. Flush WAL to disk
    await this.db.checkpoint();
    console.log(`[daemonFSM] Node ${nodeId} checkpointed successfully.`);

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const defaultDataDir = path.resolve(__dirname, '../data/generated-database');

    // 2. Read .db and .heap files
    const dbPath = path.join(defaultDataDir, 'wikipedia.db' + nodeId);
    const heapPath = dbPath + '.heap';

    console.log(`[daemonFSM] Reading files for snapshot: ${dbPath} and ${heapPath}`);
    const dbBuffer = (await fs.readFile(dbPath)) as Buffer;
    const heapBuffer = (await fs.readFile(heapPath)) as Buffer;

    // 3. Combine into one buffer: [4 bytes DB length] + [DB data] + [Heap data]
    const combined = Buffer.alloc(4 + dbBuffer.length + heapBuffer.length);
    combined.writeUInt32BE(dbBuffer.length, 0);
    dbBuffer.copy(combined, 4);
    heapBuffer.copy(combined, 4 + dbBuffer.length);

    console.log(
      `[daemonFSM] Snapshot created. DB size: ${dbBuffer.length}, Heap size: ${heapBuffer.length}, Total snapshot size: ${combined.length}`,
    );

    return combined;
  }

  async installSnapshot(data: Buffer): Promise<void> {
    if (!this.raftNode) {
      throw Error('raft node is null/undefined...');
    }

    const nodeId = this.raftNode.getNodeId();
    console.log(`[daemonFSM] Node ${nodeId} installing snapshot of size ${data.length}...`);

    if (data.length < 4) {
      throw new Error(`[daemonFSM] Snapshot data too small: ${data.length}`);
    }

    // 1. Extract DB and Heap data
    const dbLength = data.readUInt32BE(0);
    const dbBuffer = data.subarray(4, 4 + dbLength);
    const heapBuffer = data.subarray(4 + dbLength);

    console.log(
      `[daemonFSM] Extracted DB (${dbBuffer.length} bytes) and Heap (${heapBuffer.length} bytes) from snapshot.`,
    );

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const defaultDataDir = path.resolve(__dirname, '../data/generated-database');

    const dbPath = path.join(defaultDataDir, 'wikipedia.db' + nodeId);
    const heapPath = dbPath + '.heap';

    // 2. Close current DB if it exists before overwriting files
    if (this.db) {
      console.log(`[daemonFSM] Closing existing DB before installing snapshot...`);
      await this.db.close();
      this.db = null;
    }

    // 3. Write files to disk
    console.log(`[daemonFSM] Writing snapshot to ${dbPath} and ${heapPath}...`);
    await fs.writeFile(dbPath, dbBuffer);
    await fs.writeFile(heapPath, heapBuffer);

    // 3b. Delete stale WAL files so initDB() opens a clean DB instead of replaying old entries
    const walPath = path.join(defaultDataDir, 'wikipedia.wal' + nodeId);
    const heapWalPath = walPath + '.heap';
    for (const p of [walPath, heapWalPath]) {
      try {
        await fs.unlink(p);
      } catch {
        /* file may not exist */
      }
    }

    // 4. Re-open DB via callback
    console.log(`[daemonFSM] Snapshot installed successfully. Notifying daemon to re-open DB...`);
    if (this.onSnapshotInstalled) {
      await this.onSnapshotInstalled();
    }

    this.data = data;
  }

  private data: Buffer = Buffer.alloc(0);
  getState(): Buffer {
    return this.data;
    // -> just here for the interface because of how we take snapshots.
  }

  // State machine — your application logic. Raft calls apply() on it for every committed command
  /**
   * So just have a big switch / if-else tree for each of the commands you have set to be possible.
   */
  async apply(command: {
    type: string;
    payload: {
      name?: string;
      doc?: Document;
      documents?: Document[];
      id?: string;
      updates?: Partial<Document>;
      query?: string;
      ids?: string[];
      // for bulk
      operations?: { type: string; document?: Document; id?: string; updates?: Partial<Document> }[];
      // for demo user
      username?: string;
      password?: string;
      collections?: string[];
      createdAt?: string;
      // for force flushing/executing buffered commands
      force?: boolean;
      userId?: string;
    };
  }): Promise<void> {
    if (!this.raftNode) {
      throw Error(`RaftNode was ${this.raftNode}`);
    }

    if (!this.db) {
      throw Error(`db of ${this.raftNode.getNodeId()} was ${this.db}`);
    }

    this.incrementCounter();
    const forceFlush = command['payload']['force'] === true; // {undefined, false} == false

    if (forceFlush) {
      delete command['payload']['force'];
    }
    this.bufferedCommands.push(command);

    if (this.counter < this.TRESHOLD && !forceFlush) {
      console.log(
        `${this.counter} of ${this.TRESHOLD} required commands are now buffered on node=${this.raftNode.getNodeId()}`,
      );
      return;
    }

    // Playing buffered commands and truncating LOG
    this.resetCounter();

    //
    console.log(`executing buffered commands on node=${this.raftNode.getNodeId()}`);

    for (const cmd of this.bufferedCommands) {
      const payload: {
        name?: string;
        doc?: Document;
        documents?: Document[];
        id?: string;
        updates?: Partial<Document>;
        query?: string;
        ids?: string[];
        // for bulk
        operations?: { type: string; document?: Document; id?: string; updates?: Partial<Document> }[];
        // for demo user
        username?: string;
        password?: string;
        collections?: string[];
        createdAt?: string;
        // for force flushing/executing buffered commands
        force?: boolean;
        userId?: string;
      } = cmd['payload'] as {
        name?: string;
        doc?: Document;
        documents?: Document[];
        id?: string;
        updates?: Partial<Document>;
        query?: string;
        ids?: string[];
        // for bulk
        operations?: { type: string; document?: Document; id?: string; updates?: Partial<Document> }[];
        // for demo user
        username?: string;
        password?: string;
        collections?: string[];
        createdAt?: string;
        // for force flushing/executing buffered commands
        force?: boolean;
        userId?: string;
      };

      /**
       * - Creating a document (insert)
       * - Creating many documents (insertMany)
       * - Creating a new collection
       */
      if (cmd.type === 'CREATE') {
        const paramCount: number = Object.keys(payload).length;

        // Differentiate which create command
        const IS_CREATE_COLL = paramCount === 1;
        const IS_INSERT_DOC = paramCount === 2 && payload.doc !== undefined;
        const IS_INSERT_MANY = paramCount === 2 && payload.documents !== undefined;
        if ([IS_CREATE_COLL, IS_INSERT_DOC, IS_INSERT_MANY].filter((x) => x === true).length !== 1) {
          throw new Error(`Only 1 command should be true, but this was not the case`);
        }

        //
        if (IS_CREATE_COLL) {
          if (!payload['name']) {
            throw new Error('payload did not have a name field');
          }
          const name: string = payload['name'];
          const existingCollections: string[] = await this.db.getCollectionNames();
          if (existingCollections.includes(name)) {
            console.log(`collection ${name} already exists!`);
            return;
          }
          await this.db.createCollection(name);
        }

        //
        if (IS_INSERT_DOC) {
          if (!payload['name']) {
            throw new Error('payload did not have a name field');
          }
          if (!payload['doc']) {
            throw new Error('payload did not have a doc field');
          }
          const collectionName: string = payload['name'];
          const doc: Document = payload['doc'];

          let collection: Collection;
          try {
            collection = await this.db.getCollection(collectionName);
          } catch (error) {
            if (error instanceof Error && error.message.includes('not found')) {
              collection = await this.db.createCollection(collectionName);
            } else {
              throw error;
            }
          }
          //
          await collection.insert(doc);
        }
        //
        if (IS_INSERT_MANY) {
          if (!payload['name']) {
            throw new Error('payload did not have a name field');
          }
          if (!payload['documents']) {
            throw new Error('payload did not have a documents field');
          }
          const collectionName = payload['name'];
          const documents = payload['documents'];

          // Auto-create the collection if missing, mirroring the single-insert path.
          let collection: Collection;
          try {
            collection = await this.db.getCollection(collectionName);
          } catch (error) {
            if (error instanceof Error && error.message.includes('not found')) {
              collection = await this.db.createCollection(collectionName);
            } else {
              throw error;
            }
          }
          // Ensure secondary indexes are created during bulk insert
          collection.setAutoCreateSecondaryIndexesOnInsert(true);
          await collection.insertMany(documents as Array<Omit<Document, 'id'> & { id?: string }>);
        }

        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      /**
       * - Deleting a document from a collection
       * - Deleting a collection
       */
      if (cmd.type === 'DELETE') {
        const paramCount = Object.keys(payload).length;

        const IS_DELETE_COLL: boolean = paramCount === 1;
        const IS_DELETE_DOC: boolean = paramCount === 2;
        if (IS_DELETE_COLL) {
          if (!payload['name']) {
            throw new Error('payload did not have a name field');
          }
          const collectionName: string = payload['name'];
          await this.db.deleteCollection(collectionName);
        }
        if (IS_DELETE_DOC) {
          if (!payload['name']) {
            throw new Error('payload did not have a name field');
          }
          if (!payload['id']) {
            throw new Error('payload did not have an id field');
          }
          const collectionName: string = payload['name'];
          const id: string = payload['id'];

          const collection: Collection = await this.db.getCollection(collectionName);
          await collection.delete(id);
        }
      }

      if (cmd.type === 'UPDATE') {
        if (!payload['name']) {
          throw new Error('payload did not have a name field');
        }
        if (!payload['id']) {
          throw new Error('payload did not have a id field');
        }
        if (!payload['updates']) {
          throw new Error('payload did not have an updates field');
        }

        const collectionName: string = payload['name'];
        const id: string = payload['id'];
        const updates: Partial<Document> = payload['updates'];
        console.log(collectionName, id, updates);

        const collection: Collection = await this.db.getCollection(collectionName);
        await collection.update(id, updates);
      }

      // Only mutating commands are replicated
      if (cmd.type === 'SQL') {
        if (!payload['query']) {
          throw new Error('payload did not have a query field');
        }
        if (!payload['ids']) {
          throw new Error('payload did not have an ids field');
        }

        const query: string = payload['query'];
        const ids: string[] = payload['ids'];
        const userId: string = payload['userId']!;

        // Separate flow for INSERT SQL queries to have the same UUID replicated in documents.
        const interpreter: Interpreter = new Interpreter(query, this.db.getQueryLanguageStorageAdapter());
        if (interpreter.identifyType() === 'INSERT') {
          await this.db.executeSqlQuery(query, ids, userId);
        } else {
          await this.db.executeSqlQuery(query);
        }
      }

      // BULK operations are 1 big command to be replayed whenever
      // valid operation types are: "insert", "update", "delete"
      if (cmd.type === 'BULK') {
        if (!payload['name']) {
          throw new Error('payload did not have a name field');
        }
        if (!payload['operations']) {
          throw new Error('payload did not have an operations field');
        }

        const collectionName = payload['name'];
        const operations = payload['operations'];
        for (const op of operations) {
          if (op.type === 'insert') {
            console.log('insert bulk');
            if (!op['document']) {
              throw new Error('bulk operation did not have a document field');
            }
            const doc: Document = op['document'];

            let collection: Collection;
            try {
              collection = await this.db.getCollection(collectionName);
            } catch (error) {
              if (error instanceof Error && error.message.includes('not found')) {
                collection = await this.db.createCollection(collectionName);
              } else {
                throw error;
              }
            }
            //
            await collection.insert(doc);
          } else if (op.type === 'update') {
            if (!op['id']) {
              throw new Error('obulk peration did not have a id field');
            }
            if (!op['updates']) {
              throw new Error('bulk operation did not have an updates field');
            }

            const id: string = op['id'];
            const updates: Partial<Document> = op['updates'];

            const collection: Collection = await this.db.getCollection(collectionName);
            await collection.update(id, updates);
          } else if (op.type === 'delete') {
            if (!op['id']) {
              throw new Error('bulk operation did not have an id field');
            }

            const id: string = op['id'];
            const collection: Collection = await this.db.getCollection(collectionName);
            await collection.delete(id);
          } else {
            // NOOP
          }
        }
      }
    }

    // empty out the in-memory buffered commands
    this.bufferedCommands = [];

    // Persist changes to disk (WAL)
    await this.db.commit();

    // DROPLOG (drops the persisted buffered commands)
    if (this.raftNode.isLeader()) {
      await this.raftNode.appendDropLogEntry(this.raftNode.getCurrentTerm(), 1, this.raftNode.getLastLogIndex());
    }
    console.log(
      `(post) node=${this.raftNode.getNodeId()} (lastlogidx=${this.raftNode.getLastLogIndex()}, getCommittedIndex()=${this.raftNode.getCommittedIndex()})`,
    ); // always seem to be equal
  }
}

export function spawnDaemon(port: number, nodeId: string, wellKnownPeers: { id: string; address: string }[]) {
  let node: RaftNode;
  let fsm: daemonFSM | null = null;

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const app = express();
  //const port = 3000;
  const passwordHasher = new PasswordHasher();

  /**
   * Marker file used to make the two-rename compaction swap recoverable.
   * The swap protocol is:
   *   1. Write marker file (records temp paths)
   *   2. rename(tempDb → db)
   *   3. rename(tempWal → wal)
   *   4. Delete marker file
   *
   * On startup, if the marker exists we know the swap was interrupted and
   * can complete or roll back.
   */
  const COMPACT_MARKER_SUFFIX = '.compact-swap';

  function compactMarkerPath(dbPath: string): string {
    return dbPath + COMPACT_MARKER_SUFFIX;
  }

  async function fileExists(p: string): Promise<boolean> {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Atomically swap temp compaction files into the original paths.
   * Uses a marker file so the operation is recoverable after a crash.
   */
  async function atomicCompactionSwap(
    tempDbPath: string,
    tempWalPath: string,
    targetDbPath: string,
    targetWalPath: string,
    tempHeapPath?: string,
    tempHeapWalPath?: string,
    targetHeapPath?: string,
    targetHeapWalPath?: string,
  ): Promise<void> {
    const marker = compactMarkerPath(targetDbPath);

    // Step 1: write marker (fsync-safe intent record)
    await writeFile(
      marker,
      JSON.stringify({
        tempDbPath,
        tempWalPath,
        targetDbPath,
        targetWalPath,
        tempHeapPath,
        tempHeapWalPath,
        targetHeapPath,
        targetHeapWalPath,
      }),
    );

    // Step 2: rename DB file (atomic on POSIX within same FS)
    await rename(tempDbPath, targetDbPath);

    // Step 3: rename WAL file
    await rename(tempWalPath, targetWalPath);

    if (tempHeapPath !== undefined && targetHeapPath !== undefined) {
      await rename(tempHeapPath, targetHeapPath);
    }

    if (tempHeapWalPath !== undefined && targetHeapWalPath !== undefined) {
      await rename(tempHeapWalPath, targetHeapWalPath);
    }

    // Step 4: remove marker — swap is complete
    await unlink(marker);
  }

  /**
   * On startup, check if a compaction swap was interrupted and finish it.
   * - If the marker exists and the temp DB is gone (rename #1 succeeded),
   *   complete the WAL rename.
   * - If the marker exists and the temp DB still exists (rename #1 didn't
   *   happen), roll back by removing temp files.
   */
  async function recoverCompactionSwap(dbPath: string): Promise<void> {
    const marker = compactMarkerPath(dbPath);
    if (!(await fileExists(marker))) return;

    console.log('Detected interrupted compaction swap, recovering...');

    let info: {
      tempDbPath: string;
      tempWalPath: string;
      targetDbPath: string;
      targetWalPath: string;
      tempHeapPath?: string;
      tempHeapWalPath?: string;
      targetHeapPath?: string;
      targetHeapWalPath?: string;
    };
    try {
      const raw = await readFile(marker, 'utf-8');
      info = JSON.parse(raw) as typeof info;
    } catch {
      // Corrupt marker — delete it and let normal startup proceed
      await unlink(marker).catch(() => {});
      return;
    }

    const tempDbExists = await fileExists(info.tempDbPath);
    if (!tempDbExists) {
      // rename #1 succeeded — complete the WAL rename
      if (await fileExists(info.tempWalPath)) {
        await rename(info.tempWalPath, info.targetWalPath);
      }
      if (info.tempHeapPath && info.targetHeapPath && (await fileExists(info.tempHeapPath))) {
        await rename(info.tempHeapPath, info.targetHeapPath);
      }
      if (info.tempHeapWalPath && info.targetHeapWalPath && (await fileExists(info.tempHeapWalPath))) {
        await rename(info.tempHeapWalPath, info.targetHeapWalPath);
      }
    } else {
      // rename #1 didn't happen — roll back by removing temp files
      await unlink(info.tempDbPath).catch(() => {});
      await unlink(info.tempWalPath).catch(() => {});
      if (info.tempHeapPath) {
        await unlink(info.tempHeapPath).catch(() => {});
      }
      if (info.tempHeapWalPath) {
        await unlink(info.tempHeapWalPath).catch(() => {});
      }
    }

    await unlink(marker).catch(() => {});
    console.log('Compaction swap recovery complete.');
  }

  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  // Serve static frontend assets (HTML, CSS) from src, scripts from build
  app.use('/components', express.static(path.join(__dirname, '../src/frontend/components')));
  app.use('/styles', express.static(path.join(__dirname, '../src/frontend/styles')));
  app.use('/scripts', express.static(path.join(__dirname, 'frontend/scripts')));

  // Redirect root to the main webclient UI
  app.get('/', (_req, res) => {
    res.redirect('/components/simpledbmswebclient.html');
  });

  let db!: SimpleDBMS;

  const ragAgentCache = new Map<string, RagAgent>();
  const ragAgentInitPromises = new Map<string, Promise<RagAgent>>();

  async function getOrCreateRagAgent(collectionName: string): Promise<RagAgent> {
    const existing = ragAgentCache.get(collectionName);
    if (existing) return existing;
    const pending = ragAgentInitPromises.get(collectionName);
    if (pending) return pending;
    const promise = (async () => {
      const hnsw = db.getHnswIndex();
      if (!hnsw) throw new Error('HNSW index unavailable on this database instance');
      const agent = new RagAgent({ hnswIndex: hnsw, skipHnswInit: true });
      await agent.init();
      ragAgentCache.set(collectionName, agent);
      ragAgentInitPromises.delete(collectionName);
      return agent;
    })();
    ragAgentInitPromises.set(collectionName, promise);
    return promise;
  }

  let currentDbPath = '';
  let currentWalPath = '';
  let currentHeapPath = '';
  let currentHeapWalPath = '';

  // Global read-write lock for DB-touching routes. GETs share readLock so they
  // can run concurrently; mutating verbs serialize via writeLock. AutoCompactor
  // is wired into the same lock (see initDB) — without that, shrinkDatabase
  // would interleave with INSERTs and corrupt the FreeBlockFile.
  const dbLock = new RWLock();
  let autoCompactor: AutoCompactor | undefined;

  // Single middleware: every /db and /api request acquires the right lock,
  // then holds it until the response finishes (or the connection closes). This
  // replaces per-route wrappers so new routes are covered automatically. Note:
  // `app.use('/api', …)` does NOT match '/api-docs' (Express requires a '/'
  // or end-of-string after the mount path), so Swagger UI is left unlocked.
  app.use(['/db', '/api'], (req, res, next) => {
    const acquire = req.method === 'GET' ? dbLock.readLock.bind(dbLock) : dbLock.writeLock.bind(dbLock);

    void acquire(
      () =>
        new Promise<void>((resolve) => {
          // Any of these means the handler is done with the response. Promise
          // resolve is idempotent so multiple events are harmless.
          res.on('finish', () => resolve());
          res.on('close', () => resolve());
          res.on('error', () => resolve());
          next();
        }),
    ).then(
      () => {
        // Only writes change fragmentation; reads can skip the (debounced) check.
        if (req.method !== 'GET') autoCompactor?.scheduleCheck();
      },
      () => {
        /* lock already released by writeLock/readLock's finally; nothing to do */
      },
    );
  });

  async function initDB(
    customDbPath?: string,
    customWalPath?: string,
    customHeapPath?: string,
    customHeapWalPath?: string,
  ) {
    try {
      const defaultDataDir = path.resolve(__dirname, '../data/generated-database');
      await fs.mkdir(defaultDataDir, { recursive: true });
      const dbPath = customDbPath || path.join(defaultDataDir, 'wikipedia.db' + nodeId);
      const walPath = customWalPath || path.join(defaultDataDir, 'wikipedia.wal' + nodeId);
      const heapPath = customHeapPath || `${dbPath}.heap`;
      const heapWalPath = customHeapWalPath || `${walPath}.heap`;
      const hnswPath = `${dbPath}.hnsw`;
      const hnswWalPath = `${walPath}.hnsw`;
      const hnswTreePath = `${dbPath}.hnsw.tree`;
      const hnswTreeWalPath = `${walPath}.hnsw.tree`;
      const hnswStorageWalPath = `${walPath}.hnsw.storage`;

      // Store paths globally for compaction endpoints
      currentDbPath = dbPath;
      currentWalPath = walPath;
      currentHeapPath = heapPath;
      currentHeapWalPath = heapWalPath;

      // Recover any interrupted compaction swap if present
      await recoverCompactionSwap(dbPath);

      const heapFile = new RealFile(heapPath);
      if (!existsSync(heapPath)) {
        await heapFile.create();
        await heapFile.close();
      }

      const heapWalFile = new RealFile(heapWalPath);
      if (!existsSync(heapWalPath)) {
        await heapWalFile.create();
        await heapWalFile.close();
      }

      const hnswFile = new RealFile(hnswPath);
      if (!existsSync(hnswPath)) {
        await hnswFile.create();
        await hnswFile.close();
      }
      const hnswWalFile = new RealFile(hnswWalPath);
      if (!existsSync(hnswWalPath)) {
        await hnswWalFile.create();
        await hnswWalFile.close();
      }
      const hnswTreeFile = new RealFile(hnswTreePath);
      if (!existsSync(hnswTreePath)) {
        await hnswTreeFile.create();
        await hnswTreeFile.close();
      }
      const hnswTreeWalFile = new RealFile(hnswTreeWalPath);
      if (!existsSync(hnswTreeWalPath)) {
        await hnswTreeWalFile.create();
        await hnswTreeWalFile.close();
      }
      const hnswStorageWalFile = new RealFile(hnswStorageWalPath);
      if (!existsSync(hnswStorageWalPath)) {
        await hnswStorageWalFile.create();
        await hnswStorageWalFile.close();
      }

      const walFile = new RealFile(walPath);
      if (!existsSync(walPath)) {
        await walFile.create();
        await walFile.close();
      }

      const dbFile = new RealFile(dbPath);
      if (!existsSync(dbPath)) {
        await dbFile.create();
        await dbFile.close();
      }

      try {
        db = await SimpleDBMS.open(
          dbFile,
          walFile,
          heapFile,
          heapWalFile,
          hnswFile,
          hnswWalFile,
          hnswTreeFile,
          hnswTreeWalFile,
          hnswStorageWalFile,
        );
        console.log('Database opened successfully.');
      } catch (openError) {
        const hasDb = existsSync(dbPath);
        const hasWal = existsSync(walPath);
        const hasHeap = existsSync(heapPath);
        const hasHeapWal = existsSync(heapWalPath);

        // Never recreate when primary data files already exist: that would overwrite persisted data.
        if (hasDb && hasHeap) {
          if (!hasWal) {
            await walFile.create();
            await walFile.close();
          }
          if (!hasHeapWal) {
            await heapWalFile.create();
            await heapWalFile.close();
          }

          db = await SimpleDBMS.open(
            dbFile,
            walFile,
            heapFile,
            heapWalFile,
            hnswFile,
            hnswWalFile,
            hnswTreeFile,
            hnswTreeWalFile,
            hnswStorageWalFile,
          );
          console.log('Database opened successfully after restoring missing WAL files.');
        } else {
          if (hasDb || hasHeap || hasWal || hasHeapWal) {
            console.error('Partial database file set detected. Refusing to recreate to avoid data loss.');
            throw openError;
          }

          console.log('Database files missing, creating new database...');
          await dbFile.create();
          await dbFile.close();
          await walFile.create();
          await walFile.close();
          await heapFile.create();
          await heapFile.close();
          await heapWalFile.create();
          await heapWalFile.close();
          db = await SimpleDBMS.create(
            dbFile,
            walFile,
            heapFile,
            heapWalFile,
            hnswFile,
            hnswWalFile,
            hnswTreeFile,
            hnswTreeWalFile,
            hnswStorageWalFile,
          );
          console.log('Database created successfully.');
        }
      }

      // Ensure core system collection always exists for REST/auth flows.
      try {
        await db.getCollection('users');
      } catch (error) {
        if (error instanceof Error && error.message.includes("Collection 'users' not found")) {
          await db.createCollection('users');
        } else {
          throw error;
        }
      }

      // Wire AutoCompactor. runExclusively grabs the same dbLock's writeLock,
      // which excludes both writers and in-flight readers — without this,
      // shrinkDatabase would interleave with INSERTs (or concurrent reads
      // mid-relocation) and corrupt the FreeBlockFile.
      autoCompactor = new AutoCompactor(readAutoCompactionConfigFromEnv(), {
        getFreeBlockFile: () => db.getFreeBlockFile(),
        onShrinkComplete: async () => {
          await db.close();
          const reopenedDbFile = new RealFile(currentDbPath);
          const reopenedWalFile = new RealFile(currentWalPath);
          const reopenedHeapFile = new RealFile(currentHeapPath);
          const reopenedHeapWalFile = new RealFile(currentHeapWalPath);
          db = await SimpleDBMS.open(reopenedDbFile, reopenedWalFile, reopenedHeapFile, reopenedHeapWalFile);
        },
        runExclusively: (fn) => dbLock.writeLock(fn),
      });
    } catch (error) {
      console.error('Failed to initialize database:', error);
      throw error;
    }
  }

  const swaggerOptions = {
    definition: {
      openapi: '3.0.0',
      info: {
        title: 'SimpleDBMS API',
        version: '1.0.0',
        description: 'A simple database management system API',
      },
      servers: [
        {
          url: `http://localhost:${port}`,
        },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
    },
    apis: ['./src/simpledbmsd.mts'],
  };

  const swaggerSpec = swaggerJsdoc(swaggerOptions);
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

  /***************************************** *


      SIMPLEDBMS FUNCTIONALITY ENDPOINTS 


*********************************************/

  /**
   * @swagger
   * /api/query/sql:
   *   post:
   *     summary: Execute a query-language SQL statement
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               query:
   *                 type: string
   *               sql:
   *                 type: string
   *     responses:
   *       200:
   *         description: Query execution result
   */
  app.post(['/api/query/sql', '/api/query-language/sql'], authenticateToken, async (req: AuthenticatedRequest, res) => {
    try {
      const query = db.extractQueryText(req.body);

      console.log(req);

      const userId = req.user!.userId;

      const usersCollection = await db.getCollection('users');
      const user = await usersCollection.findById(req.user!.userId);

      if (!user) {
        res.status(404).json({ success: false, message: 'User not found' });
        return;
      }
      if (!query) {
        res.status(400).json({ success: false, message: 'query is required' });
        return;
      }

      if (!node) {
        throw Error('node was null or undefined - (SQL)');
      }

      // Only replicate mutating operations
      const ids: string[] = [];
      let result;
      const interpreter = new Interpreter(query, db.getQueryLanguageStorageAdapter());
      if (interpreter.identifyType() === 'SELECT') {
        result = await db.executeSqlQuery(query);
        res.json({ success: true, query, result });
      } else if (interpreter.identifyType() === 'INSERT') {
        for (let i = 0; i < interpreter.amountOfRows(); i++) {
          ids.push(randomUUID());
        }
        await node.submitCommand({ type: 'SQL', payload: { query: query, ids: ids, userId: userId } });
      } else {
        await node.submitCommand({ type: 'SQL', payload: { query: query, ids: [], userId: 'NO_USER' } });
      }

      //console.log(result["rows"]);
      res.status(200);
    } catch (error) {
      console.log(error);
      //res.json({ success: false });
      res.status(500); //json({ success: false, message: (error as Error).message });
    }
  });

  /**
   * @swagger
   * /api/query/natural-language:
   *   post:
   *     summary: Execute a natural-language request through the query-language executor
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               prompt:
   *                 type: string
   *               query:
   *                 type: string
   *               model:
   *                 type: string
   *               schemaContext:
   *                 type: string
   *               allowedStatements:
   *                 type: array
   *                 items:
   *                   type: string
   *     responses:
   *       200:
   *         description: Query execution result
   */
  app.post(
    ['/api/query/natural-language', '/api/query-language/natural-language'],
    authenticateToken,
    async (req: AuthenticatedRequest, res) => {
      try {
        const body = req.body as Record<string, unknown>;

        if (typeof body !== 'object' || body === null) {
          res.status(400).json({ success: false, message: 'prompt is required' });
          return;
        }

        const prompt = db.extractQueryText(body);

        const userId = req.user!.userId;

        const usersCollection = await db.getCollection('users');
        const user = await usersCollection.findById(req.user!.userId);

        if (!user) {
          res.status(404).json({ success: false, message: 'User not found' });
          return;
        }

        if (!prompt) {
          res.status(400).json({ success: false, message: 'prompt is required' });
          return;
        }

        const query = (await db.NLtoSQL(body)) as string;

        // Can now use the SQL command
        if (!node) {
          throw Error('node was null or undefined - (NL)');
        }
        // Only replicate mutating operations
        const ids: string[] = [];
        let result: unknown;
        const interpreter = new Interpreter(query, db.getQueryLanguageStorageAdapter());
        if (interpreter.identifyType() === 'SELECT') {
          result = await db.executeSqlQuery(query);
          res.json({ success: true, query, result });
        } else if (interpreter.identifyType() === 'INSERT') {
          for (let i = 0; i < interpreter.amountOfRows(); i++) {
            ids.push(randomUUID());
          }
          await node.submitCommand({ type: 'SQL', payload: { query: query, ids: ids, userId: userId } });
        } else {
          await node.submitCommand({ type: 'SQL', payload: { query: query, ids: [], userId: 'NO_USER' } });
        }

        // console.log(result["rows"]);
        res.status(200);
      } catch {
        console.log('ERR');
        res.status(500);
        //res.status(message.includes('OPENAI_API_KEY') ? 503 : 500).json({ success: false, message });
      }
    },
  );

  app.post('/db/demo/loadDummy', async (_req, res) => {
    try {
      const dummyDataPath = path.join(__dirname, '../data/dummy-accounts/dummy-account-wiki.json');
      if (!existsSync(dummyDataPath)) {
        console.log('No dummy-account.json found, skipping demo data initialization.');
        res.status(200).json({});
        return;
      }

      const dummyDataContent = await readFile(dummyDataPath, 'utf-8');
      const dummyData = JSON.parse(dummyDataContent) as {
        username: string;
        password: string;
        collections: Array<{
          name: string;
          documents: Array<{
            name: string;
            content: Record<string, unknown>;
          }>;
        }>;
      };

      // Check if demo user already exists
      const usersCollection = await db.getCollection('users');
      const existingUsers = await usersCollection.find({
        filterOps: {
          username: {
            $eq: dummyData.username,
          },
        },
        limit: 1,
      });
      const demoUserExists = existingUsers.length > 0;

      if (demoUserExists) {
        console.log('Demo user already exists, skipping initialization.');
        res.status(200).json({});
        return;
      }

      console.log('Creating demo account...');

      // Hash the password
      const hashedPassword = await passwordHasher.hashPassword(dummyData.password);

      // Create collections list
      const collectionNames = dummyData.collections.map((col) => col.name);

      // Create the demo user

      //const demoUser = await usersCollection.insert({
      //  username: dummyData.username,
      //  password: hashedPassword,
      //  collections: collectionNames,
      //  createdAt: new Date().toISOString(),
      //});

      if (!node) {
        throw Error('node was null or undefined - (INSERT 1)');
      }

      const demoUserId = randomUUID();
      const userDoc = {
        username: dummyData.username,
        password: hashedPassword,
        collections: collectionNames,
        createdAt: new Date().toISOString(),
        id: demoUserId,
      };
      await node!.submitCommand({ type: 'CREATE', payload: { name: 'users', doc: userDoc, force: true } });

      //
      console.log(`Demo user '${dummyData.username}' created with ID: ${demoUserId}`);

      // Create collections and insert documents
      for (const collectionData of dummyData.collections) {
        //let collection;
        //try {
        //  collection = await db.getCollection(collectionData.name);
        //} catch (error) {
        //  if (error instanceof Error && error.message.includes('not found')) {
        //    collection = await db.createCollection(collectionData.name);
        //  } else {
        //    throw error;
        //  }
        //}
        //console.log(`  Creating collection: ${collectionData.name}`);
        await node.submitCommand({ type: 'CREATE', payload: { name: collectionData.name, force: true } });

        const docs = [];
        for (const docData of collectionData.documents) {
          // await collection.insert({
          //   name: docData.name,
          //   userId: demoUser.id,
          //   createdAt: new Date().toISOString(),
          //   content: encryptedBuffer.toString('base64') as unknown as Record<string, DocumentValue>,
          // });
          //
          const doc = {
            name: docData.name,
            userId: demoUserId,
            createdAt: new Date().toISOString(),
            content: docData.content as unknown as Record<string, DocumentValue>,
            id: randomUUID(),
          };
          docs.push(doc);
        }
        await node!.submitCommand({
          type: 'CREATE',
          payload: { name: collectionData.name, documents: docs, force: true },
        });

        console.log(`    Added ${collectionData.documents.length} documents to ${collectionData.name}`);
      }

      console.log(
        `Demo account setup complete! Login with username: '${dummyData.username}' password: '${dummyData.password}'`,
      );
    } catch (error) {
      console.error('Failed to load dummy account:', error);
      // Don't throw - this is optional initialization
    }

    res.json({});
  });

  /**
   * @swagger
   * /db/{collection}:
   *   post:
   *     summary: Insert a document into a collection
   *     parameters:
   *       - in: path
   *         name: collection
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   * /db:
   *   get:
   *     summary: List all collections in the database
   *     responses:
   *       200:
   *         description: A list of collection names
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 collections:
   *                   type: array
   *                   items:
   *                     type: string
   *               example:
   *                 collections: ["users", "products", "orders"]
   */
  app.get('/db', async (_req, res) => {
    try {
      const collections = await db.getCollectionNames();
      res.json({ collections });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  /**
   * @swagger
   * /db/{collection}/paged:
   *   get:
   *     summary: Find documents in a collection with keyset pagination
   *     parameters:
   *       - in: path
   *         name: collection
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: limit
   *         schema:
   *           type: integer
   *           minimum: 1
   *         description: Maximum number of documents to return
   *       - in: query
   *         name: after
   *         schema:
   *           type: string
   *         description: Cursor id; returns documents strictly after this id (keyset pagination)
   *     responses:
   *       200:
   *         description: Paged documents with metadata
   */
  app.get('/db/:collection/paged', async (req, res) => {
    try {
      const collectionName = req.params.collection;
      const collection = await db.getCollection(collectionName);
      const rawLimit = req.query['limit'];
      const rawAfter = req.query['after'];
      const rawNextCursor = req.query['nextCursor'];

      const limit = typeof rawLimit === 'string' && rawLimit.length > 0 ? Number.parseInt(rawLimit, 10) : undefined;
      const cursorInput =
        typeof rawAfter === 'string' && rawAfter.length > 0
          ? rawAfter
          : typeof rawNextCursor === 'string' && rawNextCursor.length > 0
            ? rawNextCursor
            : undefined;
      const after =
        cursorInput !== undefined
          ? cursorInput.replace(/^\s*"/, '').replace(/"\s*$/, '').trim() || undefined
          : undefined;

      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
        res.status(400).json({ error: 'Invalid limit. Expected integer >= 1.' });
        return;
      }

      const resolvedLimit = limit ?? 25;
      const pagePlusOne = await collection.findPagedAfter(resolvedLimit + 1, after);
      const hasNextPage = pagePlusOne.length > resolvedLimit;
      const docs = hasNextPage ? pagePlusOne.slice(0, resolvedLimit) : pagePlusOne;
      const nextCursor = hasNextPage ? (docs[docs.length - 1]?.id ?? null) : null;
      const decodedDocs = docs.map((doc) => {
        const docData = doc as unknown as { content?: string };

        if (typeof docData.content !== 'string' || docData.content.length === 0) {
          return doc;
        }

        try {
          return {
            ...doc,
            content: docData.content,
          };
        } catch {
          return doc;
        }
      });

      res.json({
        items: decodedDocs,
        limit: resolvedLimit,
        after: after ?? null,
        mode: 'keyset',
        hasNextPage,
        nextCursor,
      });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  /**
   * @swagger
   * /db/{collection}:
   *   get:
   *     summary: Find documents in a collection
   *     parameters:
   *       - in: path
   *         name: collection
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: List of documents
   */
  app.get('/db/:collection', async (req, res) => {
    try {
      const collectionName = req.params.collection;
      const filterQuery = req.query['filter'];
      const limitQuery = req.query['limit'];
      const skipQuery = req.query['skip'];
      const sortFieldQuery = req.query['sortField'];
      const sortOrderQuery = req.query['sortOrder'];

      let filterOps: FilterOperators | undefined = undefined;
      if (typeof filterQuery === 'string') {
        try {
          filterOps = JSON.parse(filterQuery) as FilterOperators;
        } catch {
          res.status(400).json({ error: 'Invalid JSON in filter query parameter' });
          return;
        }
      }

      let limit: number | undefined = undefined;
      let skip: number | undefined = undefined;
      if (typeof limitQuery === 'string') limit = parseInt(limitQuery, 10);
      if (typeof skipQuery === 'string') skip = parseInt(skipQuery, 10);

      let sort: { field: string; order: 'asc' | 'desc' } | undefined = undefined;
      if (typeof sortFieldQuery === 'string') {
        sort = { field: sortFieldQuery, order: sortOrderQuery === 'desc' ? 'desc' : 'asc' };
      }

      const collection: Collection = await db.getCollection(collectionName);
      const docs = await collection.find({ filterOps, limit, skip, sort });
      res.json(docs);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Comparison operators')) {
        res.status(400).json({ error: error.message });
        return;
      }
      res.status(500).json({ error: (error as Error).message });
    }
  });

  /**
   * @swagger
   * /db/{collection}/indexes:
   *   get:
   *     summary: List all indexes for a collection
   *     parameters:
   *       - in: path
   *         name: collection
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: List of indexed fields
   */
  app.get('/db/:collection/indexes', async (req, res) => {
    try {
      const collectionName = req.params.collection;
      const collection: Collection = await db.getCollection(collectionName);
      const indexes = collection.getIndexedFields();
      res.json({ indexes });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  /**
   * @swagger
   * /db/{collection}/{id}:
   *   get:
   *     summary: Get a document by ID
   *     parameters:
   *       - in: path
   *         name: collection
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: The document
   *       404:
   *         description: Not found
   */
  app.get('/db/:collection/:id', async (req, res) => {
    try {
      const collectionName = req.params.collection;
      const id = req.params.id;
      const collection: Collection = await db.getCollection(collectionName);
      const doc = await collection.findById(id);
      if (doc) {
        res.json(doc);
      } else {
        res.status(404).json({ error: 'Document not found' });
      }
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  /**
   * @swagger
   * /db:
   *   post:
   *     summary: Create a new collection
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - name
   *             properties:
   *               name:
   *                 type: string
   *                 description: The name of the new collection
   *             example:
   *               name: "new_collection"
   *     responses:
   *       201:
   *         description: Collection created successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 message:
   *                   type: string
   *                 collection:
   *                   type: string
   *               example:
   *                 message: "Collection 'new_collection' created"
   *                 collection: "new_collection"
   *       400:
   *         description: Bad request (missing name)
   */
  app.post('/db', async (req, res) => {
    try {
      const { name } = req.body as { name?: string };
      if (!name || typeof name !== 'string') {
        res.status(400).json({ error: 'Collection name is required and must be a string' });
        return;
      }

      //
      if (!node) {
        res.status(400).json({ error: 'node was undefined or null' });
        return;
      }

      await node.submitCommand({ type: 'CREATE', payload: { name: name } });

      //
      // const existingCollections = await db.getCollectionNames();
      // if (existingCollections.includes(name)) {
      //   res.status(400).json({ error: `Collection '${name}' already exists` });
      //   return;
      // }
      // await db.createCollection(name);

      res.status(201).json({ message: `Collection '${name}' created`, collection: name });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  /**
   * @swagger
   * /db/{collection}:
   *   post:
   *     summary: Insert a document into a collection
   *     parameters:
   *       - in: path
   *         name: collection
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             example:
   *               name: "John Doe"
   *               age: 25
   *               isActive: true
   *     responses:
   *       201:
   *         description: Created
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   */
  app.post('/db/:collection', async (req, res) => {
    try {
      const collectionName = req.params.collection;
      const doc = req.body as Omit<Document, 'id'> & { id?: string };

      doc['id'] = randomUUID();
      if (!node) {
        throw Error('node was null or undefined - (INSERT 1)');
      }
      await node!.submitCommand({ type: 'CREATE', payload: { name: collectionName, doc: doc } });

      res.status(201).json({ success: true });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  /**
   * @swagger
   * /db/{collection}/insertMany:
   *   post:
   *     summary: Insert multiple documents into a collection (optimized batch insert)
   *     parameters:
   *       - in: path
   *         name: collection
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               documents:
   *                 type: array
   *                 items:
   *                   type: object
   *             example:
   *               documents:
   *                 - name: "John Doe"
   *                   age: 25
   *                   isActive: true
   *                 - name: "Jane Smith"
   *                   age: 30
   *                   isActive: false
   *     responses:
   *       201:
   *         description: Documents inserted successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 type: object
   */
  app.post('/db/:collection/insertMany', async (req, res) => {
    try {
      const name: string | undefined = req.params.collection;
      if (!name || typeof name !== 'string') {
        res.status(400).json({ error: 'Collection name is required and must be a string' });
        return;
      }
      const body = req.body as { documents?: unknown[] };
      const documents = body['documents'] as Document[];

      if (!documents || !Array.isArray(documents)) {
        res.status(400).json({ error: 'documents array is required' });
        return;
      }

      if (documents.length === 0) {
        res.status(400).json({ error: 'documents array must not be empty' });
        return;
      }

      // Add UUIDs here (leader) for proper RAFT replication
      documents.forEach((doc) => (doc['id'] = randomUUID()));

      //
      if (!node) {
        throw Error('node was null or undefined - (INSERT MANY)');
      }
      await node!.submitCommand({ type: 'CREATE', payload: { name: name, documents: documents } });

      //
      res.status(200).json({ success: true });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  /**
   * @swagger
   * /db/{collection}/paged:
   *   get:
   *     summary: Find documents in a collection with keyset pagination
   *     parameters:
   *       - in: path
   *         name: collection
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: limit
   *         schema:
   *           type: integer
   *           minimum: 1
   *         description: Maximum number of documents to return
   *       - in: query
   *         name: after
   *         schema:
   *           type: string
   *         description: Cursor id; returns documents strictly after this id (keyset pagination)
   *     responses:
   *       200:
   *         description: Paged documents with metadata
   */
  app.get('/db/:collection/paged', async (req, res) => {
    try {
      const collectionName = req.params.collection;
      const collection: Collection = await db.getCollection(collectionName);
      const rawLimit = req.query['limit'];
      const rawAfter = req.query['after'];

      const limit = typeof rawLimit === 'string' && rawLimit.length > 0 ? Number.parseInt(rawLimit, 10) : undefined;
      const rawNextCursor = req.query['nextCursor'];
      const cursorInput =
        typeof rawAfter === 'string' && rawAfter.length > 0
          ? rawAfter
          : typeof rawNextCursor === 'string' && rawNextCursor.length > 0
            ? rawNextCursor
            : undefined;
      const after =
        cursorInput !== undefined
          ? cursorInput.replace(/^\s*"/, '').replace(/"\s*$/, '').trim() || undefined
          : undefined;

      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
        res.status(400).json({ error: 'Invalid limit. Expected integer >= 1.' });
        return;
      }

      const resolvedLimit = limit ?? 25;
      const pagePlusOne = await collection.findPagedAfter(resolvedLimit + 1, after);
      const hasNextPage = pagePlusOne.length > resolvedLimit;
      const docs = hasNextPage ? pagePlusOne.slice(0, resolvedLimit) : pagePlusOne;
      const nextCursor = hasNextPage ? (docs[docs.length - 1]?.id ?? null) : null;
      const decodedDocs = docs.map((doc) => {
        const docData = doc as unknown as { content?: string };

        if (typeof docData.content !== 'string' || docData.content.length === 0) {
          return doc;
        }

        try {
          return {
            ...doc,
            content: docData.content,
          };
        } catch {
          return doc;
        }
      });

      res.json({
        items: decodedDocs,
        limit: resolvedLimit,
        after: after ?? null,
        mode: 'keyset',
        hasNextPage,
        nextCursor,
      });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  /**
   * @swagger
   * /db/{collection}/aggregate:
   *   post:
   *     summary: Perform aggregation on a collection
   *     parameters:
   *       - in: path
   *         name: collection
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             example:
   *               groupBy: "category"
   *               operations:
   *                 count: "totalProducts"
   *                 avg:
   *                   - field: "price"
   *                     as: "averagePrice"
   *                 max:
   *                   - field: "price"
   *                     as: "highestPrice"
   *                 sum:
   *                   - field: "stockQuantity"
   *                     as: "totalStock"
   *     responses:
   *       200:
   *         description: Aggregation results
   */
  app.post('/db/:collection/aggregate', async (req, res) => {
    try {
      const collectionName = req.params.collection;
      const body = req.body as { groupBy?: string | null; operations: AggregateQuery['operations'] };
      const { groupBy, operations } = body;

      if (!operations) {
        res.status(400).json({ error: 'operations are required' });
        return;
      }

      const collection: Collection = await db.getCollection(collectionName);
      const results = await collection.aggregate({ groupBy, operations });
      res.json(results);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  /**
   * @swagger
   * /db/{collection}/bulk:
   *   post:
   *     summary: Perform bulk operations
   *     parameters:
   *       - in: path
   *         name: collection
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             example:
   *               operations:
   *                 - type: "insert"
   *                   document:
   *                     name: "Alice"
   *                     age: 30
   *                 - type: "update"
   *                   id: "123e4567-e89b-12d3-a456-426614174000"
   *                   updates:
   *                     age: 31
   *                 - type: "delete"
   *                   id: "987fcdeb-51a2-43d7-9012-3456789abcde"
   *     responses:
   *       200:
   *         description: Bulk operation results
   */
  app.post('/db/:collection/bulk', async (req, res) => {
    try {
      //
      const name = req.params.collection;
      if (!name || typeof name !== 'string') {
        res.status(400).json({ error: 'Collection name is required and must be a string' });
        return;
      }
      const body = req.body as { operations?: unknown[] };
      const { operations } = body;

      if (!operations || !Array.isArray(operations)) {
        res.status(400).json({ error: 'operations array is required' });
        return;
      }

      //
      if (!node) {
        throw Error('node was null or undefined - (/bulk endpoint)');
      }

      await node!.submitCommand({ type: 'BULK', payload: { name: name, operations: operations } });

      //const collection = await db.getCollection(collectionName);
      //const results: Array<{
      //  success: boolean;
      //  type?: string;
      //  id?: string;
      //  found?: boolean;
      //  deleted?: boolean;
      //  error?: string;
      //}> = [];
      //
      //res.json({ results });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  /**
   * POST /db/:collection/wikipedia
   * Bulk insert endpoint specially for large wikipedia imports.
   * This endpoint submits a RAFT command so the insert is replicated to all nodes.
   * Expects body: { documents: Document[] }
   */
  app.post('/db/:collection/wikipedia', async (req, res) => {
    try {
      const name: string | undefined = req.params.collection;
      if (!name || typeof name !== 'string') {
        res.status(400).json({ error: 'Collection name is required and must be a string' });
        return;
      }

      const body = req.body as { documents?: unknown[] };
      const documents = body['documents'] as Document[];

      if (!documents || !Array.isArray(documents)) {
        res.status(400).json({ error: 'documents array is required' });
        return;
      }

      if (documents.length === 0) {
        res.status(400).json({ error: 'documents array must not be empty' });
        return;
      }

      // Add UUIDs here (leader) for proper RAFT replication
      documents.forEach((doc) => (doc['id'] = randomUUID()));

      if (!node) {
        throw Error('node was null or undefined - (WIKIPEDIA)');
      }

      await node!.submitCommand({ type: 'CREATE', payload: { name: name, documents: documents, force: true } });

      res.status(200).json({ success: true });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  /**
   * @swagger
   * /db/{collection}/join:
   *   post:
   *     summary: Join two collections on a common field
   *     parameters:
   *       - in: path
   *         name: collection
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             example:
   *               collection: "departments"
   *               on: "departmentId"
   *               rightOn: "id"
   *     responses:
   *       200:
   *         description: Join results
   */
  app.post('/db/:collection/join', async (req, res) => {
    try {
      const leftCollection = req.params.collection;
      const body = req.body as {
        collection?: string;
        on?: string;
        rightOn?: string;
        type?: 'inner' | 'left' | 'right';
      };
      const { collection: rightCollection, on, rightOn, type } = body;

      if (!rightCollection || !on) {
        res.status(400).json({ error: 'collection and on fields are required' });
        return;
      }

      const results = await db.join({
        leftCollection,
        rightCollection,
        on,
        rightOn,
        type: type || 'inner',
      });

      res.json(results);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  /**
   * @swagger
   * /db/{collection}/{id}:
   *   put:
   *     summary: Update a document
   *     parameters:
   *       - in: path
   *         name: collection
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             example:
   *               age: 26
   *               isActive: false
   *     responses:
   *       200:
   *         description: Updated document
   *       404:
   *         description: Not found
   */
  app.put('/db/:collection/:id', async (req, res) => {
    try {
      //
      const name: string | undefined = req.params.collection;
      if (!name || typeof name !== 'string') {
        res.status(400).json({ error: 'Collection name is required and must be a string' });
        return;
      }
      const id: string | undefined = req.params.id;
      if (!id || typeof id !== 'string') {
        res.status(400).json({ error: 'id is required and must be a string' });
        return;
      }

      const updates: Partial<Document> = req.body as Partial<Document>;

      // add UUID for proper RAFT replication
      if (!node) {
        throw Error('node was null or undefined - (UPDATE DOCUMENTS)');
      }
      await node.submitCommand({ type: 'UPDATE', payload: { name: name, id: id, updates: updates } });
      //
      res.status(200).json({ success: true });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  /**
   * @swagger
   * /db/{collection}/{id}:
   *   delete:
   *     summary: Delete a document
   *     parameters:
   *       - in: path
   *         name: collection
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Deleted
   *       404:
   *         description: Not found
   */
  app.delete('/db/:collection/:id', async (req, res) => {
    try {
      const name = req.params.collection;
      if (!name || typeof name !== 'string') {
        res.status(400).json({ error: 'Collection name is required and must be a string' });
        return;
      }

      const id: string | undefined = req.params.id;
      if (!id) {
        res.status(400).json({ error: 'document id is required' });
        return;
      }

      if (!node) {
        throw Error('node was null or undefined - (DELETE DOCUMENT)');
      }
      await node.submitCommand({ type: 'DELETE', payload: { name: name, id: id } });

      // Checking if it already exists to avoid silently overwriting (though getCollection should be able to handle this, just tob e sure)
      // const existingCollections = db.getCollectionNames();
      //if (existingCollections.includes(name)) {
      //  res.status(400).json({ error: `Collection '${name}' already exists` });
      //  return;
      //}
      res.status(201).json({ message: `Deleted document with id=${id} from collection '${name}'` });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  /**
   * Deletes collection
   */
  app.delete('/db/', async (req, res) => {
    try {
      const { name } = req.body as { name?: string };
      if (!name || typeof name !== 'string') {
        res.status(400).json({ error: 'Collection name is required and must be a string' });
        return;
      }

      if (!node) {
        throw Error('node was null - (DELETE COLLECTION)');
      }

      await node.submitCommand({ type: 'DELETE', payload: { name: name } });

      // Checking if it already exists to avoid silently overwriting (though getCollection should be able to handle this, just tob e sure)
      // const existingCollections = db.getCollectionNames();
      //if (existingCollections.includes(name)) {
      //  res.status(400).json({ error: `Collection '${name}' already exists` });
      //  return;
      //}
      res.status(201).json({ message: `Collection '${name}' deleted`, collection: name });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  /********************************************************************


              DEBUG ENDPOINTS (not present in the Swagger)


*******************************************************************/

  //
  app.get('/debug/0', async (_req, res) => {
    console.log('+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++');
    console.log();

    //
    // console.log(db.catalogTree);
    const NON_EXISTING_COLLECTION = "'IGNORE_THIS_STRING_ITS_INTENDED'";
    await db.debug_printOnDiskTreeSLOW(NON_EXISTING_COLLECTION);

    console.log();
    console.log('+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++');

    res.status(200);
    res.json({});
  });

  app.get('/debug/0/:collection', async (req, res) => {
    //
    const collectionName = req.params.collection;

    //
    console.log('+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++');
    console.log();

    await db.debug_printOnDiskTreeSLOW(collectionName);

    console.log();
    console.log('+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++');

    //
    res.status(200);
    res.json({});
  });

  // Prints the catalog tree
  app.get('/debug/1', (_req, res) => {
    console.log('+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++');
    console.log();

    //
    db.debug_printCatalogTreeNodeBlockIds();
    //

    console.log();
    console.log('+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++');

    res.status(200);
    res.json({});
  });
  app.get('/debug/1/:collection', (_req, _res) => {
    throw new Error('IMPLEMENT ME! /debug/0/:collection');
  });

  // Prints the block tree of the catalog tree
  app.get('/debug/2', (_req, res) => {
    console.log('+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++');
    console.log();

    //
    db.debug_printCatalogTreeKeys();
    //

    console.log();
    console.log('+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++');

    res.status(200);
    res.json({});
  });
  app.get('/debug/2/:collection', (_req, _res) => {
    throw new Error('IMPLEMENT ME! /debug/0/:collection');
  });

  //Gives tree stats:
  //- #internal
  //- #leaf
  //- #nodes
  //- #items
  //- depth
  //
  // app.get('/debug/3', (_req, res) => {
  //   //
  //   const stats = db.debug_catalogTreeStats();
  //   //
  //   res.status(200);
  //   res.json(stats);
  // });

  app.get('/debug/4', (_req, res) => {
    //
    db.debug_assertCatalogTreeInvariants();
    //
    res.status(200);
    res.json({});
  });

  app.get('/debug/4/:collection', (_req, _res) => {
    throw new Error('IMPLEMENT ME! (/debug/4/:collection)');
    //
    /**
  const collectionName = req.params.collection;
  res.status(200);
  res.json({});
  */
  });

  app.get('/debug/5', async (_req, res) => {
    //
    console.log('+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++');
    console.log();

    const contents = await db.debug_readHeader();
    console.log(contents);

    //
    //`indexes: [Object]`  ->  an array of blockIDs. (uints)
    //
    console.log(contents['collections']);

    console.log();

    console.log(
      "NOTE: if indexes={} and/or documentCount = 0 or is weird, check saveIndexMetadata() and saveDocumentCountMetadata() to see if they haven't been disables temporarily",
    );

    console.log();
    console.log('+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++');
    //
    res.status(200);
    res.json({});
  });

  //
  //Illustrates:
  //- # disk accesses
  //- # docs added (according to metadata, may be false information)
  //- source of the disk accesses
  //
  app.get('/debug/6', async (_req, res) => {
    //
    console.log('+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++');
    console.log();

    const sumValues = (obj: Record<string, number>): number =>
      Object.values(obj).reduce((a: number, b: number) => a + b, 0);

    console.log(
      `WROTE to disk ${sumValues(debug_getWriteCounts())} times this run... (originating from below sources)`,
    );
    console.log(debug_getWriteCounts());

    console.log('\n overwiteBlock() calls (approx.) originated from:');
    console.log(debug_getOverwriteSources());

    console.log('\n allocateAndWrite() calls (approx.) originated from:');
    console.log(debug_getAllocWriteSources());

    console.log('\n Tracked function call counts are:');
    console.log(debug_getFnCallCounts());
    console.log(
      `NOTE, IF ORDER=50 (so no collection-tree will be split yet): #tree.insert() = #collections + #docCount * 5 (1 primary index and 4 secondary indices per collection) = 6 + 52 * 5 = 260 + 6 = 266`,
    );
    console.log();
    console.log(`READ from disk ${debug_getDiskReadCount()} times this run... (based on readBlob())`);

    //
    const contents = await db.debug_readHeader();
    let docCount = 0;
    for (const [_, value] of Object.entries(contents['collections'])) {
      docCount += value['documentCount'];
    }

    console.log();
    console.log(`dbheader metadata documentCount -> ${docCount} (should =52 on DB initialization)`);
    //

    console.log();
    console.log('+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++');
    //
    res.status(200);
    res.json({});
  });

  /***************************************** *


        AUTHENTICATION ENDPOINTS 


*********************************************/
  /**
   * GET /db/demo/index-inspect/:collection
   * Read-only snapshot of the B+ tree INDEX file (the FreeBlockFile that
   * shrinkDatabase actually relocates and truncates). Classifies every block
   * exactly as shrink does — header, free-list hole, orphan, or live B+ tree
   * node (catalog / collection / secondary index) — and also lists the
   * documents in the given collection so the demo can offer them for deletion.
   * No authentication required — intended for the compaction demo UI.
   */
  app.get('/db/demo/index-inspect/:collection', async (req, res) => {
    try {
      const collectionName = req.params.collection;
      const fbf = db.getFreeBlockFile();
      const map = await buildBlockMap(fbf);

      const blockSize = fbf.blockSize;
      const totalBlocks = map.totalBlocks;
      const fileSizeBytes = totalBlocks * blockSize;

      // ── Decode the actual contents of each block (not just bits) ──────────
      // inspectIndexContents walks the real B+ trees from the header roots and
      // decodes each node accurately (keys, values, child pointers) — independent
      // of shrink's relocation walk, which can mis-tag index nodes as document
      // blobs in separate-heap setups.
      const KEY_LIMIT = 64;
      const nodeContents = await inspectIndexContents(fbf);

      type BlockContent = Record<string, unknown>;
      const content = new Map<number, BlockContent>();

      // Header block 0
      const freeListHead = await fbf.debug_getFreeListHead();
      content.set(0, {
        role: 'header',
        description: 'Stores the free-list head pointer and the database header (B+ tree roots).',
        freeListHead,
        header: map.header,
      });

      // Live B+ tree nodes (catalog / primary / secondary), decoded accurately.
      for (const [startId, node] of nodeContents) {
        const keys = node.keys.slice(0, KEY_LIMIT);
        const decoded: BlockContent = {
          role: 'btree-node',
          tree: node.tree,
          field: node.field,
          nodeType: node.nodeType,
          keyCount: node.keys.length,
          keys,
          chain: node.chain,
        };
        if (node.nodeType === 'leaf') {
          decoded['values'] = (node.values ?? []).slice(0, KEY_LIMIT);
          decoded['nextLeafBlockId'] = node.nextLeafBlockId;
          decoded['prevLeafBlockId'] = node.prevLeafBlockId;
        } else if (node.nodeType === 'internal') {
          decoded['childBlockIds'] = node.childBlockIds ?? [];
        }
        if (node.keys.length > KEY_LIMIT) decoded['keysTruncated'] = true;
        content.set(startId, decoded);
        for (let i = 1; i < node.chain.length; i++) {
          content.set(node.chain[i], {
            role: 'continuation',
            description: `Continuation of the B+ tree node blob starting at block ${startId}.`,
            blobStart: startId,
            chain: node.chain,
          });
        }
      }

      // Free-list holes and orphans
      for (const id of map.freeListIds) {
        const raw = await fbf.readRawBlock(id);
        content.set(id, {
          role: 'free',
          description: 'A hole on the free list, reused on the next allocation.',
          nextFreePointer: raw.readUInt32LE(0),
        });
      }
      for (let id = 1; id < totalBlocks; id++) {
        if (map.blockKind[id] === 'orphan') {
          content.set(id, {
            role: 'orphan',
            description: 'Abandoned by the B+ tree without being re-linked into the free list; only shrink reclaims it.',
          });
        }
      }

      // Colour each block by its accurate tree role (from inspectIndexContents)
      // rather than buildBlockMap's relocation-walk tag, which mis-labels index
      // nodes as 'document'/'live' in separate-heap setups. Free/orphan/header
      // classification still comes from buildBlockMap so the grid agrees with
      // exactly what shrink reclaims.
      const treeToKind: Record<string, string> = {
        catalog: 'catalog',
        'primary index': 'collection',
        'secondary index': 'index',
      };
      const nodeKind = new Map<number, string>();
      for (const node of nodeContents.values()) {
        const kind = treeToKind[node.tree] ?? 'live';
        for (const blockId of node.chain) nodeKind.set(blockId, kind);
      }
      const blocks = Array.from({ length: totalBlocks }, (_, id) => {
        const mapKind = map.blockKind[id] ?? 'free';
        let kind: string;
        if (id === 0) kind = 'header';
        else if (mapKind === 'free') kind = 'free';
        else if (mapKind === 'orphan') kind = 'orphan';
        else kind = nodeKind.get(id) ?? 'live';
        let c = content.get(id) ?? null;
        if (!c && kind !== 'free' && kind !== 'orphan') {
          c = { role: 'live', description: 'Live block that shrink preserves (may be relocated to a lower slot).' };
        }
        return { id, kind, content: c };
      });

      const orphanCount = blocks.filter((b) => b.kind === 'orphan').length;
      const freeListCount = map.freeListIds.length;
      const reclaimableCount = map.freeBlockIds.size; // free-list holes + orphans
      const liveCount = totalBlocks - 1 - reclaimableCount; // exclude header
      const usableBlocks = totalBlocks - 1; // exclude header
      const fragmentationPct = usableBlocks > 0 ? Math.round((reclaimableCount / usableBlocks) * 100) : 0;

      // List documents in the demo collection (for the delete picker) plus the
      // total payload stored in the SEPARATE heap file where blobs actually live.
      // (The heap's block count is read from its summed blob sizes, since the
      // heap commits lazily and its on-disk size lags behind live writes.)
      const documents: Array<{ docId: string; sizeBytes: number; data: Record<string, unknown> | null }> = [];
      let heapPayloadBytes = 0;
      const collectionNames = await db.getCollectionNames();
      if (collectionNames.includes(collectionName)) {
        const collection = await db.getCollection(collectionName);
        const heap = collection.getDocumentHeap();
        const docEntries = await collection.getDocumentBlockIds();
        for (const { docId, startBlockId } of docEntries) {
          let data: Record<string, unknown> | null = null;
          let sizeBytes = 0;
          try {
            const buf = await heap.readBlob(startBlockId);
            sizeBytes = buf.length;
            heapPayloadBytes += sizeBytes;
            if (buf.length > 0) data = JSON.parse(buf.toString()) as Record<string, unknown>;
          } catch {
            /* skip unreadable blob */
          }
          documents.push({ docId, sizeBytes, data });
        }
      }

      res.json({
        ok: true,
        collectionName,
        totalBlocks,
        blockSize,
        fileSizeBytes,
        freeListIds: map.freeListIds,
        freeListCount,
        orphanCount,
        reclaimableCount,
        liveCount,
        fragmentationPct,
        blocks,
        documents,
        heap: { docCount: documents.length, payloadBytes: heapPayloadBytes },
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: (error as Error).message });
    }
  });

  /**
   * @swagger
   * /db/compact:
   *   post:
   *     summary: Compact the database
   *     description: >
   *       Defragments the database file by rebuilding it from scratch.
   *       Removes accumulated empty space from deletions and updates,
   *       reducing the physical file size. This is a blocking maintenance
   *       operation — no other requests should be in progress.
   *     responses:
   *       200:
   *         description: Compaction completed successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                 collectionsCompacted:
   *                   type: number
   *                 totalDocuments:
   *                   type: number
   *                 sizeBefore:
   *                   type: number
   *                 sizeAfter:
   *                   type: number
   *       500:
   *         description: Compaction failed
   */
  app.post('/db/compact', async (_req, res) => {
    try {
      const tempDbPath = currentDbPath + '.compact.tmp';
      const tempWalPath = currentWalPath + '.compact.tmp';
      const tempHeapPath = currentHeapPath + '.compact.tmp';
      const tempHeapWalPath = currentHeapWalPath + '.compact.tmp';
      const dbFile = new RealFile(currentDbPath);
      const walFile = new RealFile(currentWalPath);
      const tempDbFile = new RealFile(tempDbPath);
      const tempWalFile = new RealFile(tempWalPath);
      const heapFile = new RealFile(currentHeapPath);
      const heapWalFile = new RealFile(currentHeapWalPath);
      const tempHeapFile = new RealFile(tempHeapPath);
      const tempHeapWalFile = new RealFile(tempHeapWalPath);

      // Streaming compaction: old DB → temp files, then swap
      const { db: newDb, result } = await compactDatabase(
        db,
        dbFile,
        walFile,
        tempDbFile,
        tempWalFile,
        heapFile,
        heapWalFile,
        tempHeapFile,
        tempHeapWalFile,
      );

      // Close the new DB so we can swap files
      await newDb.close();

      // Swap temp files into original paths (recoverable across crashes)
      await atomicCompactionSwap(
        tempDbPath,
        tempWalPath,
        currentDbPath,
        currentWalPath,
        tempHeapPath,
        tempHeapWalPath,
        currentHeapPath,
        currentHeapWalPath,
      );

      // Reopen the compacted database from the original paths
      const reopenedDbFile = new RealFile(currentDbPath);
      const reopenedWalFile = new RealFile(currentWalPath);
      const reopenedHeapFile = new RealFile(currentHeapPath);
      const reopenedHeapWalFile = new RealFile(currentHeapWalPath);
      db = await SimpleDBMS.open(reopenedDbFile, reopenedWalFile, reopenedHeapFile, reopenedHeapWalFile);
      if (fsm) fsm.setDB(db);

      console.log(
        `Database compacted: ${result.sizeBefore} -> ${result.sizeAfter} bytes ` +
          `(${result.collectionsCompacted} collections, ${result.totalDocuments} documents)`,
      );

      res.json(result);
    } catch (error) {
      console.error('Compaction error:', error);
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  /**
   * @swagger
   * /db/demo/shrink:
   *   post:
   *     summary: Shrink the database file by reclaiming unused space
   *     description: >
   *       Reclaims free and orphaned blocks by relocating live blocks into
   *       free slots, then truncating the file. Requires zero extra disk space.
   *       This is a blocking maintenance operation.
   *     responses:
   *       200:
   *         description: Shrink completed successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                 blocksTotal:
   *                   type: number
   *                 blocksFree:
   *                   type: number
   *                 blocksRelocated:
   *                   type: number
   *                 sizeBefore:
   *                   type: number
   *                 sizeAfter:
   *                   type: number
   *       500:
   *         description: Shrink failed
   */
  // NOTE: registered under /db/demo/ so the multi-segment path does not collide
  // with the single-segment `POST /db/:collection` insert route defined earlier
  // (which would otherwise treat "shrink" as a collection name and insert a doc).
  app.post('/db/demo/shrink', async (_req, res) => {
    try {
      const result = await shrinkDatabase(db.getFreeBlockFile());

      // Close and reopen the DB (in-memory caches hold stale block IDs)
      await db.close();
      const reopenedDbFile = new RealFile(currentDbPath);
      const reopenedWalFile = new RealFile(currentWalPath);
      const reopenedHeapFile = new RealFile(currentHeapPath);
      const reopenedHeapWalFile = new RealFile(currentHeapWalPath);
      db = await SimpleDBMS.open(reopenedDbFile, reopenedWalFile, reopenedHeapFile, reopenedHeapWalFile);
      if (fsm) fsm.setDB(db);

      console.log(
        `Database shrunk: ${result.sizeBefore} -> ${result.sizeAfter} bytes ` +
          `(${result.blocksRelocated} blocks relocated, ${result.blocksFree} free blocks reclaimed)`,
      );

      res.json(result);
    } catch (error) {
      console.error('Shrink error:', error);
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  /**
   * William Ragnarsson
   * Frontend webapp routing endpoints
   * Note: These endpoints are not included in public API documentation for security reasons
   */

  /**
   * POST /api/signup
   * Register a new user account
   * @param {string} username - The desired username
   * @param {string} password - The user's password (TODO: should be hashed)
   * @returns {object} { success: boolean, message: string, token: string }
   */
  app.post('/api/signup', async (req, res) => {
    try {
      const { username, password } = req.body as { username?: string; password?: string };

      // Validate input
      if (!username || !password) {
        res.status(400).json({ success: false, message: 'Username and password are required' });
        return;
      }

      // Get users collection (this internally uses db.getCollection())
      const usersCollection = await db.getCollection('users');

      // Check if user already exists
      const existingUsers = await usersCollection.find();
      const userExists = existingUsers.some((user) => {
        const userData = user as unknown as { username: string };
        return userData.username && userData.username.toLowerCase() === username.toLowerCase();
      });

      if (userExists) {
        res.status(400).json({ success: false, message: 'Username already exists' });
        return;
      }

      // Hash the password before storing
      const hashedPassword = await passwordHasher.hashPassword(password);

      // Create new user via RAFT so all nodes replicate it
      if (!node) {
        throw new Error('node was null or undefined');
      }
      const newUserId = randomUUID();
      const userDoc = {
        username,
        password: hashedPassword,
        collections: [],
        createdAt: new Date().toISOString(),
        id: newUserId,
      };
      await node.submitCommand({ type: 'CREATE', payload: { name: 'users', doc: userDoc } });

      // Create JWT token (expires in 30 minutes)
      const token = generateToken(newUserId, username);

      res.status(201).json({
        success: true,
        message: 'User created successfully',
        token,
      });
    } catch (error) {
      console.error('Signup error:', error);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  /**
   * POST /api/login
   * Authenticate a user with credentials or validate an existing token
   * @param {string} [username] - Username for credential-based login
   * @param {string} [password] - Password for credential-based login
   * @param {string} [token] - Existing JWT token for validation
   * @returns {object} { success: boolean, message: string, token: string }
   */
  app.post('/api/login', async (req, res) => {
    try {
      const {
        username,
        password,
        token: existingToken,
      } = req.body as {
        username?: string;
        password?: string;
        token?: string;
      };

      const hasCredentials = typeof username === 'string' && username.length > 0 && typeof password === 'string';

      // Only use token-only auto-login when credentials are not provided.
      if (existingToken && !hasCredentials) {
        const validation = validateAndRefreshToken(existingToken);

        if (validation.valid) {
          res.json({
            success: true,
            message: 'Already authenticated',
            token: validation.newToken || existingToken,
          });
          return;
        }
        // Token invalid or expired, fall through to username/password login
      }

      // Validate input
      if (!hasCredentials || !password) {
        res.status(400).json({ success: false, message: 'Username and password are required' });
        return;
      }

      // Get users collection
      const usersCollection = await db.getCollection('users');
      const users = await usersCollection.find();

      // Find user
      const user = users.find((u) => {
        const userData = u as unknown as { username?: string };
        return userData.username && userData.username.toLowerCase() === username.toLowerCase();
      }) as { id: string; username: string; password: string } | undefined;

      if (!user) {
        res.status(401).json({ success: false, message: 'Invalid username or password' });
        return;
      }

      // Verify the password against the stored hash
      const isPasswordValid = await passwordHasher.verifyPassword(password, user.password);

      if (!isPasswordValid) {
        res.status(401).json({ success: false, message: 'Invalid username or password' });
        return;
      }

      // Create JWT token
      const token = generateToken(user.id, user.username);

      res.json({
        success: true,
        message: 'Login successful',
        token,
      });
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  /**
   * GET /api/getUserData
   * Retrieve the authenticated user's personal data (GDPR compliance)
   * @requires Authentication - Bearer token in Authorization header
   * @returns {object} { success: boolean, message: string, userData: { userId: string, username: string, hashedPassword: string }, token?: string }
   */
  app.get('/api/getUserData', authenticateToken, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        res.status(401).json({ success: false, message: 'User not authenticated' });
        return;
      }

      const userId = req.user.userId;

      // Get users collection
      const usersCollection = await db.getCollection('users');

      // Find user by ID
      const user = await usersCollection.findById(userId);

      if (!user) {
        res.status(404).json({ success: false, message: 'User not found' });
        return;
      }

      // Extract user data
      const userData = user as unknown as { id: string; username: string; password: string };

      // Return user data (including hashed password for GDPR transparency)
      const responseData = addTokenToResponse(req, {
        success: true,
        message: 'User data retrieved successfully',
        userData: {
          userId: userData.id,
          username: userData.username,
          hashedPassword: userData.password, // Show hashed password for transparency
        },
      });

      res.json(responseData);
    } catch (error) {
      console.error('Get user data error:', error);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  /**
   * GET /api/getAllUserData
   * Retrieve all user data including collections and documents (GDPR data export)
   * @requires Authentication - Bearer token in Authorization header
   * @returns {object} Complete user data export including all collections and documents
   */
  app.get('/api/getAllUserData', authenticateToken, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        res.status(401).json({ success: false, message: 'User not authenticated' });
        return;
      }

      const userId = req.user.userId;

      // Get users collection
      const usersCollection = await db.getCollection('users');
      const user = await usersCollection.findById(userId);

      if (!user) {
        res.status(404).json({ success: false, message: 'User not found' });
        return;
      }

      const userData = user as unknown as {
        id: string;
        username: string;
        password: string;
        collections?: string[];
      };

      // Build collections data structure
      const collectionsData: Record<string, Array<Record<string, unknown>>> = {};

      if (userData.collections && Array.isArray(userData.collections)) {
        for (const collectionName of userData.collections) {
          try {
            const collection: Collection = await db.getCollection(collectionName);
            const userDocs = await collection.find({
              filterOps: {
                userId: { $eq: userId },
              },
            });

            collectionsData[collectionName] = userDocs as Array<Record<string, unknown>>;
          } catch (error) {
            console.error(`Error fetching collection ${collectionName}:`, error);
            collectionsData[collectionName] = [];
          }
        }
      }

      // Build complete data export
      const completeData = {
        userId: userData.id,
        username: userData.username,
        password: userData.password,
        collections: collectionsData,
      };

      res.json(completeData);
    } catch (error) {
      console.error('Get all user data error:', error);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  /**
   * POST /api/createCollection
   * Create a new collection for the authenticated user
   * @requires Authentication - Bearer token in Authorization header
   * @param {string} collectionName - Name of the collection to create
   * @returns {object} { success: boolean, message: string, token?: string }
   */
  // PROPOSED [1/5]
  app.post('/api/createCollection', authenticateToken, async (req: AuthenticatedRequest, res) => {
    try {
      const { collectionName } = req.body as { collectionName?: string };

      if (!collectionName) {
        res.status(400).json({ success: false, message: 'collectionName is required' });
        return;
      }

      // Check if user already has this collection
      const usersCollection = await db.getCollection('users');
      const user = await usersCollection.findById(req.user!.userId);

      if (user) {
        const userData = user as unknown as { collections?: string[] };

        // Initialize collections array if it doesn't exist
        if (!userData.collections) {
          userData.collections = [];
        }

        // Check if collection already exists for this user
        if (userData.collections.includes(collectionName)) {
          res.status(400).json({ success: false, message: 'Collection already exists' });
          return;
        }

        // Create the collection and add to user's list
        if (!node) {
          res.status(400).json({ error: 'node was undefined or null' });
          return;
        }

        await node.submitCommand({ type: 'CREATE', payload: { name: collectionName } });
        userData.collections.push(collectionName);
        await node.submitCommand({
          type: 'UPDATE',
          payload: { name: 'users', id: req.user!.userId, updates: { collections: userData.collections } },
        });
      }

      const response = addTokenToResponse(req, {
        success: true,
        message: `Collection created succesfully and assigned to: ${req.user!.username}`,
      });

      res.status(201).json(response);
    } catch (error) {
      console.error('Create collection error:', error);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  /**
   * GET /api/fetchCollections
   * Retrieve all collections owned by the authenticated user
   * @requires Authentication - Bearer token in Authorization header
   * @returns {object} { success: boolean, message: string, collections: string[], token?: string }
   */
  app.get('/api/fetchCollections', authenticateToken, async (req: AuthenticatedRequest, res) => {
    try {
      // Get user's collections list
      const usersCollection = await db.getCollection('users');
      const user = await usersCollection.findById(req.user!.userId);

      // if user is null or undefined, return 404
      if (!user) {
        res.status(404).json({ success: false, message: 'User not found' });
        return;
      }

      const userData = user as unknown as { collections?: string[] };
      const collections = Array.isArray(userData.collections) ? userData.collections : [];

      const response = addTokenToResponse(req, {
        success: true,
        message: 'collections fetched succesfully',
        collections,
      });

      res.json(response);
    } catch (error) {
      console.error('Get collections error:', error);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  /**
   * DELETE /api/deleteCollection
   * Delete a collection from the authenticated user's account
   * @requires Authentication - Bearer token in Authorization header
   * @param {string} collectionName - Name of the collection to delete
   * @returns {object} { success: boolean, message: string, token?: string }
   */
  // PROPOSED [2/5]
  app.delete('/api/deleteCollection', authenticateToken, async (req: AuthenticatedRequest, res) => {
    try {
      const { collectionName } = req.body as { collectionName?: string };

      if (!collectionName) {
        res.status(400).json({ success: false, message: 'collectionName is required' });
        return;
      }

      // Get user document
      const usersCollection = await db.getCollection('users');
      const user = await usersCollection.findById(req.user!.userId);

      if (!user) {
        res.status(404).json({ success: false, message: 'User not found' });
        return;
      }

      const userData = user as unknown as { collections: string[] };

      // Check if collection exists in user's list
      if (!userData.collections.includes(collectionName)) {
        res.status(400).json({ success: false, message: 'Collection not found in user collections' });
        return;
      }

      // Delete all documents in the collection that belong to this user
      const collection: Collection = await db.getCollection(collectionName);
      const allDocuments = await collection.find();

      const userDocuments = allDocuments.filter((doc) => {
        const docData = doc as unknown as { userId?: string };
        return docData.userId === req.user!.userId;
      });

      // Delete each document
      if (!node) {
        throw Error('node was null or undefined');
      }
      for (const doc of userDocuments) {
        await node.submitCommand({ type: 'DELETE', payload: { name: collectionName, id: doc.id } });
      }
      console.log(
        `Deleted ${userDocuments.length} documents from collection '${collectionName}' for user ${req.user!.userId}`,
      );

      // Remove collection from user's list
      userData.collections = userData.collections.filter((name) => name !== collectionName);
      await node.submitCommand({
        type: 'UPDATE',
        payload: { name: 'users', id: req.user!.userId, updates: { collections: userData.collections } },
      });

      const response = addTokenToResponse(req, {
        success: true,
        message: `Collection '${collectionName}' and ${userDocuments.length} associated document(s) deleted successfully`,
      });

      res.json(response);
    } catch (error) {
      console.error('Delete collection error:', error);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  /**
   * POST /api/createDocument
   * Create a new document in a collection for the authenticated user
   * @requires Authentication - Bearer token in Authorization header
   * @param {string} collectionName - Name of the collection
   * @param {string} documentName - Name of the document (must be unique per user per collection)
   * @param {object} documentContent - JSON object containing the document data
   * @returns {object} { success: boolean, message: string, token?: string }
   */
  // PROPOSED [3/5]
  app.post('/api/createDocument', authenticateToken, async (req: AuthenticatedRequest, res) => {
    try {
      const { collectionName, documentName, documentContent } = req.body as {
        collectionName?: string;
        documentName?: string;
        documentContent?: Record<string, unknown>;
      };

      if (!collectionName || !documentName) {
        res.status(400).json({ success: false, message: 'collectionName and documentName are required' });
        return;
      }

      // Verify user has access to this collection
      const usersCollection = await db.getCollection('users');
      const user = await usersCollection.findById(req.user!.userId);

      if (!user) {
        res.status(404).json({ success: false, message: 'User not found' });
        return;
      }

      const userData = user as unknown as { collections?: string[] };

      // Check if collection exists in user's list
      if (!userData.collections || !userData.collections.includes(collectionName)) {
        res.status(400).json({ success: false, message: 'Collection not found in user collections' });
        return;
      }

      // Get the collection and check for duplicate document names
      let collection;
      try {
        collection = await db.getCollection(collectionName);
      } catch (error) {
        if (error instanceof Error && error.message.includes('not found')) {
          res.status(400).json({ success: false, message: 'Collection does not exist' });
          return;
        } else {
          throw error;
        }
      }

      const existingDocuments = await collection.find();

      // Check if a document with this name already exists for this user in this collection
      const documentExists = existingDocuments.some((doc) => {
        const docData = doc as unknown as { name?: string; userId?: string };
        return docData.name === documentName && docData.userId === req.user!.userId;
      });

      if (documentExists) {
        res.status(400).json({ success: false, message: 'A document with this name already exists in the collection' });
        return;
      }

      // Create the document in the collection with encrypted content
      const doc = {
        name: documentName,
        userId: req.user!.userId,
        createdAt: new Date().toISOString(),
        content: documentContent as unknown as Record<string, DocumentValue>,
        id: randomUUID(),
      };
      if (!node) {
        throw Error('node was null or undefined');
      }
      await node!.submitCommand({ type: 'CREATE', payload: { name: collectionName, doc: doc } });

      const response = addTokenToResponse(req, {
        success: true,
        message: `Document '${documentName}' created successfully in collection '${collectionName}'`,
      });

      res.status(201).json(response);
    } catch (error) {
      console.error('Create document error:', error);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  /**
   * GET /api/fetchDocumentsPaged
   * Retrieve a page of document names from a collection for the authenticated user.
   * Uses keyset pagination — O(page size) for the page fetch, O(n) for the total count.
   * All three DB operations run in parallel.
   * @requires Authentication - Bearer token in Authorization header
   * @param {string} collectionName - Name of the collection (query parameter)
   * @param {number} [limit=25] - Maximum number of documents to return
   * @param {string} [after] - Cursor id; returns documents strictly after this id
   */
  app.get('/api/fetchDocumentsPaged', authenticateToken, async (req: AuthenticatedRequest, res) => {
    try {
      const collectionName = req.query['collectionName'] as string | undefined;

      if (!collectionName) {
        res.status(400).json({ success: false, message: 'collectionName is required' });
        return;
      }

      const rawLimit = req.query['limit'];
      const rawAfter = req.query['after'];
      const limit = typeof rawLimit === 'string' && rawLimit.length > 0 ? Number.parseInt(rawLimit, 10) : 25;
      const after = typeof rawAfter === 'string' && rawAfter.length > 0 ? rawAfter : null;

      if (!Number.isInteger(limit) || limit < 1) {
        res.status(400).json({ success: false, message: 'limit must be an integer >= 1' });
        return;
      }

      const usersCollection = await db.getCollection('users');
      const user = await usersCollection.findById(req.user!.userId);

      if (!user) {
        res.status(404).json({ success: false, message: 'User not found' });
        return;
      }

      const userData = user as unknown as { collections?: string[] };

      if (!userData.collections || !userData.collections.includes(collectionName)) {
        res.status(400).json({ success: false, message: 'Collection not found in user collections' });
        return;
      }

      const collection = await db.getCollection(collectionName);
      const userId = req.user!.userId;
      const userFilter = (doc: Document) => (doc as unknown as { userId?: string }).userId === userId;

      const [pagePlusOne, total, priorCount] = await Promise.all([
        collection.findPagedAfterWithFilter(limit + 1, userFilter, after ?? undefined),
        collection.countWhere(userFilter),
        after !== null ? collection.countWhereUpTo(userFilter, after) : Promise.resolve(0),
      ]);

      const hasNextPage = pagePlusOne.length > limit;
      const pageDocs = hasNextPage ? pagePlusOne.slice(0, limit) : pagePlusOne;

      const documentNames = pageDocs
        .map((doc) => (doc as unknown as { name?: string }).name ?? '')
        .filter((name) => name !== '');

      const nextCursor = hasNextPage ? (pageDocs[pageDocs.length - 1]?.id ?? null) : null;

      const response = addTokenToResponse(req, {
        success: true,
        message: 'Documents fetched successfully',
        documentNames,
        hasNextPage,
        nextCursor,
        limit,
        total,
        rangeStart: total === 0 ? 0 : priorCount + 1,
        rangeEnd: priorCount + documentNames.length,
      });

      res.json(response);
    } catch (error) {
      console.error('Fetch documents paged error:', error);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  /**
   * DELETE /api/deleteDocument
   * Delete a document from a collection
   * @requires Authentication - Bearer token in Authorization header
   * @param {string} collectionName - Name of the collection
   * @param {string} documentName - Name of the document to delete
   * @returns {object} { success: boolean, message: string, token?: string }
   */
  // PROPOSED [4/5]
  app.delete('/api/deleteDocument', authenticateToken, async (req: AuthenticatedRequest, res) => {
    try {
      const { collectionName, documentName } = req.body as {
        collectionName?: string;
        documentName?: string;
      };

      if (!collectionName || !documentName) {
        res.status(400).json({ success: false, message: 'collectionName and documentName are required' });
        return;
      }

      // Verify user has access to this collection
      const usersCollection = await db.getCollection('users');
      const user = await usersCollection.findById(req.user!.userId);

      if (!user) {
        res.status(404).json({ success: false, message: 'User not found' });
        return;
      }

      const userData = user as unknown as { collections?: string[] };

      // Check if collection exists in user's list
      if (!userData.collections || !userData.collections.includes(collectionName)) {
        res.status(400).json({ success: false, message: 'Collection not found in user collections' });
        return;
      }

      // Find and delete the document
      const collection: Collection = await db.getCollection(collectionName);
      const documents = await collection.find();

      // Find the document by name and userId
      const document = documents.find((doc) => {
        const docData = doc as unknown as { name?: string; userId?: string };
        return docData.name === documentName && docData.userId === req.user!.userId;
      });

      if (!document) {
        res.status(404).json({ success: false, message: 'Document not found' });
        return;
      }

      // Delete the document
      if (!node) {
        throw Error('node was null or undefined');
      }
      await node.submitCommand({ type: 'DELETE', payload: { name: collectionName, id: document.id } });

      const response = addTokenToResponse(req, {
        success: true,
        message: `Document '${documentName}' deleted successfully from collection '${collectionName}'`,
      });

      res.json(response);
    } catch (error) {
      console.error('Delete document error:', error);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  /**
   * GET /api/fetchDocuments
   * Retrieve all document names from a collection for the authenticated user
   * @requires Authentication - Bearer token in Authorization header
   * @param {string} collectionName - Name of the collection (query parameter)
   * @returns {object} { success: boolean, message: string, documentNames: string[], token?: string }
   */
  app.get('/api/fetchDocuments', authenticateToken, async (req: AuthenticatedRequest, res) => {
    try {
      const collectionName = req.query['collectionName'] as string | undefined;

      if (!collectionName) {
        res.status(400).json({ success: false, message: 'collectionName is required' });
        return;
      }

      // Verify user has access to this collection
      const usersCollection = await db.getCollection('users');
      const user = await usersCollection.findById(req.user!.userId);

      if (!user) {
        res.status(404).json({ success: false, message: 'User not found' });
        return;
      }

      const userData = user as unknown as { collections?: string[] };

      // Check if collection exists in user's list
      if (!userData.collections || !userData.collections.includes(collectionName)) {
        // Try to get the collection, return 400 if it does not exist
        let fallbackCollection;
        try {
          fallbackCollection = await db.getCollection(collectionName);
        } catch (error) {
          if (error instanceof Error && error.message.includes('not found')) {
            res.status(400).json({ success: false, message: 'Collection does not exist' });
            return;
          } else {
            throw error;
          }
        }
        const ownedDocuments = await fallbackCollection.find({
          filterOps: {
            userId: { $eq: req.user!.userId },
          },
          limit: 1,
        });

        if (ownedDocuments.length === 0) {
          res.status(400).json({ success: false, message: 'Collection not found in user collections' });
          return;
        }

        const updatedCollections = Array.from(new Set([...(userData.collections || []), collectionName]));
        await usersCollection.update(req.user!.userId, { collections: updatedCollections });
        userData.collections = updatedCollections;
      }

      // Get all documents from the collection that belong to this user
      let collection;
      try {
        collection = await db.getCollection(collectionName);
      } catch (error) {
        if (error instanceof Error && error.message.includes('not found')) {
          res.status(400).json({ success: false, message: 'Collection does not exist' });
          return;
        } else {
          throw error;
        }
      }
      const userDocuments = await collection.find({
        filterOps: {
          userId: { $eq: req.user!.userId },
        },
      });

      // Extract names for this user's documents only
      const documentNames = Array.from(
        new Set(
          userDocuments
            .map((doc) => {
              const docData = doc as unknown as { name?: string };
              return docData.name || '';
            })
            .filter((name) => name !== ''),
        ),
      );

      const response = addTokenToResponse(req, {
        success: true,
        message: 'Documents fetched successfully',
        documentNames,
      });

      res.json(response);
    } catch (error) {
      console.error('Fetch documents error:', error);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  /**
   * GET /api/fetchDocumentContent
   * Retrieve the full content of a specific document
   * @requires Authentication - Bearer token in Authorization header
   * @param {string} collectionName - Name of the collection (query parameter)
   * @param {string} documentName - Name of the document (query parameter)
   * @returns {object} { success: boolean, message: string, documentContent: object, token?: string }
   */
  app.get('/api/fetchDocumentContent', authenticateToken, async (req: AuthenticatedRequest, res) => {
    try {
      const collectionName = req.query['collectionName'] as string | undefined;
      const documentName = req.query['documentName'] as string | undefined;

      if (!collectionName || !documentName) {
        res.status(400).json({ success: false, message: 'collectionName and documentName are required' });
        return;
      }

      // Verify user has access to this collection
      const usersCollection = await db.getCollection('users');
      const user = await usersCollection.findById(req.user!.userId);

      if (!user) {
        res.status(404).json({ success: false, message: 'User not found' });
        return;
      }

      const userData = user as unknown as { collections?: string[] };

      // Check if collection exists in user's list
      if (!userData.collections || !userData.collections.includes(collectionName)) {
        res.status(400).json({ success: false, message: 'Collection not found in user collections' });
        return;
      }

      // Find the document in the collection
      const collection: Collection = await db.getCollection(collectionName);
      const matchingDocuments = await collection.find({
        filterOps: {
          userId: { $eq: req.user!.userId },
          name: { $eq: documentName },
        },
        limit: 1,
      });
      const document = matchingDocuments[0];

      if (!document) {
        res.status(404).json({ success: false, message: 'Document not found' });
        return;
      }

      const docData = document as unknown as { content?: Record<string, unknown> };

      const response = addTokenToResponse(req, {
        success: true,
        message: 'Document content fetched successfully',
        documentContent: docData.content ?? {},
      });

      res.json(response);
    } catch (error) {
      console.error('Fetch document content error:', error);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  /**
   * PUT /api/updateDocument
   * Update the content of an existing document
   * @requires Authentication - Bearer token in Authorization header
   * @param {string} collectionName - Name of the collection
   * @param {string} documentName - Name of the document to update
   * @param {object} newDocumentContent - New JSON object to replace the document content
   * @returns {object} { success: boolean, message: string, token?: string }
   * @note The name and userId fields are preserved during update
   */
  // PROPOSED [5/5]
  app.put('/api/updateDocument', authenticateToken, async (req: AuthenticatedRequest, res) => {
    try {
      const { collectionName, documentName, newDocumentContent } = req.body as {
        collectionName?: string;
        documentName?: string;
        newDocumentContent?: Record<string, unknown>;
      };

      if (!collectionName || !documentName || !newDocumentContent) {
        res
          .status(400)
          .json({ success: false, message: 'collectionName, documentName, and newDocumentContent are required' });
        return;
      }

      // Verify user has access to this collection
      const usersCollection = await db.getCollection('users');
      const user = await usersCollection.findById(req.user!.userId);

      if (!user) {
        res.status(404).json({ success: false, message: 'User not found' });
        return;
      }

      const userData = user as unknown as { collections?: string[] };

      // Check if collection exists in user's list
      if (!userData.collections || !userData.collections.includes(collectionName)) {
        res.status(400).json({ success: false, message: 'Collection not found in user collections' });
        return;
      }

      // Find the document in the collection
      const collection: Collection = await db.getCollection(collectionName);
      const allDocuments = await collection.find();

      // Find the document by name and userId
      const document = allDocuments.find((doc) => {
        const docData = doc as unknown as { name?: string; userId?: string };
        return docData.name === documentName && docData.userId === req.user!.userId;
      });

      if (!document) {
        res.status(404).json({ success: false, message: 'Document not found' });
        return;
      }

      // Update the document content while preserving all system fields
      const docData = document as unknown as { createdAt?: string };
      await node.submitCommand({
        type: 'UPDATE',
        payload: {
          name: collectionName,
          id: document.id,
          updates: {
            name: documentName,
            userId: req.user!.userId,
            createdAt: docData.createdAt || new Date().toISOString(),
            content: newDocumentContent as unknown as Record<string, DocumentValue>,
          },
        },
      });

      const response = addTokenToResponse(req, {
        success: true,
        message: `Document '${documentName}' updated successfully in collection '${collectionName}'`,
      });

      res.json(response);
    } catch (error) {
      console.error('Update document error:', error);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  app.post(
    '/api/collections/:collectionName/hnsw-search',
    authenticateToken,
    async (req: AuthenticatedRequest, res) => {
      try {
        const collectionName = req.params['collectionName'] as string;
        const { query, k: rawK } = req.body as { query?: string; k?: number };

        if (!collectionName) {
          res.status(400).json({ success: false, message: 'collectionName is required' });
          return;
        }
        if (!query || typeof query !== 'string' || query.trim() === '') {
          res.status(400).json({ success: false, message: 'query must be a non-empty string' });
          return;
        }
        const k = typeof rawK === 'number' && Number.isInteger(rawK) && rawK >= 1 ? rawK : 5;

        const usersCollection = await db.getCollection('users');
        const user = await usersCollection.findById(req.user!.userId);
        if (!user) {
          res.status(404).json({ success: false, message: 'User not found' });
          return;
        }
        const userData = user as unknown as { collections?: string[] };
        if (!userData.collections || !userData.collections.includes(collectionName)) {
          res.status(403).json({ success: false, message: 'Collection not found in user collections' });
          return;
        }

        const collection = await db.getCollection(collectionName);

        const rawIds = await collection.hnswSearch(query.trim(), k);
        const docIds: string[] = Array.isArray(rawIds) ? rawIds : rawIds ? [rawIds] : [];

        const results: Array<{ name: string; content: Record<string, unknown> }> = [];
        for (const docId of docIds) {
          const doc = await collection.findById(docId);
          if (!doc) continue;
          const docData = doc as unknown as { name?: string; content?: Record<string, unknown> };
          const content = docData.content ?? {};
          results.push({ name: docData.name ?? docId, content });
        }

        const response = addTokenToResponse(req, { success: true, results });
        res.json(response);
      } catch (error) {
        console.error('HNSW search error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
      }
    },
  );

  app.post('/api/collections/:collectionName/rag-chat', authenticateToken, async (req: AuthenticatedRequest, res) => {
    try {
      const collectionName = req.params['collectionName'] as string;
      const { message } = req.body as { message?: string };

      if (!collectionName) {
        res.status(400).json({ success: false, message: 'collectionName is required' });
        return;
      }
      if (!message || typeof message !== 'string' || message.trim() === '') {
        res.status(400).json({ success: false, message: 'message must be a non-empty string' });
        return;
      }

      const usersCollection = await db.getCollection('users');
      const user = await usersCollection.findById(req.user!.userId);
      if (!user) {
        res.status(404).json({ success: false, message: 'User not found' });
        return;
      }
      const userData = user as unknown as { collections?: string[] };
      if (!userData.collections || !userData.collections.includes(collectionName)) {
        res.status(403).json({ success: false, message: 'Collection not found in user collections' });
        return;
      }

      // Point the shared HNSW index at this collection before the agent runs retrieval.
      await db.getCollection(collectionName);

      const conversationId = `${req.user!.userId}:${collectionName}`;
      const agent = await getOrCreateRagAgent(collectionName);
      const result = await agent.answer(message.trim(), conversationId);

      const response = addTokenToResponse(req, {
        success: true,
        answer: result.answer,
        sources: result.sources,
      });
      res.json(response);
    } catch (error) {
      console.error('RAG chat error:', error);
      res.status(500).json({ success: false, message: (error as Error).message });
    }
  });

  /**
   * dbms daemon processes and RAFT nodes are merged. Used by proxy to ask who the leader is.
   */
  app.get('/RAFT/getLeader', (_req, res) => {
    try {
      if (!node) {
        throw Error('node was null or undefined - (/RAFT/getLeader');
      }
      if (!db) {
        throw Error('db was null or undefined - (/RAFT/getLeader');
      }

      console.log('+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++');
      console.log();

      const leader: string | null = node.getLeaderId();
      console.log(`The leader is ${leader}`);

      // The endpoint to be targeted by the proxy.
      const endpoint: number = 3000 + Number(leader?.substring(4)); // Use a peerlist. Currently assumption that node with id nodeX is at 3000+X for the proxy, and 50000 + X for the RAFT.

      console.log();
      console.log('+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++');

      res.status(200);
      res.json({ leaderID: leader, leaderEndpoint: endpoint });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  /** Asserts that everything has been properly replicated. */
  app.get('/RAFT/1', async (_req, res) => {
    try {
      if (!node) {
        throw Error('node was null or undefined - (/RAFT/1');
      }
      if (!db) {
        throw Error('db was null or undefined - (/RAFT/1');
      }

      console.log('+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++');

      let url: string;
      let response: Response;

      const collections: string[][] = new Array<string[]>();

      for (const p of node.getPeerList()) {
        const isDifferentNode: boolean = p['NodeId'] !== node.getNodeId();
        if (isDifferentNode) {
          //const grpcAddress = p.address;
          const apiAddress: number = 3000 + Number(p.NodeId.substring(4));
          url = `http://localhost:${apiAddress}/RAFT/GET/collections`;
          response = await fetch(url);
          if (!response.ok) {
            throw new Error(`Response status: ${response.status}`);
          }
          const result: string[] = (await response.json()) as string[];
          collections.push(result);

          /**
           * Gather all data here that you want to check for proper replication.
           * - All collection names. (catalog trees should match).
           * - All items within each of the collections should match.
           */
        }
      }

      // add this node's collections as well
      collections.push(await db.getCollectionNames());
      console.log(collections);

      // Equality for collection names is defined as the same strings in the same order
      console.log('TEST 1: CHECKING IF COLLECTION NAMES ARE REPLICATED');

      const test1Passed: boolean = (function allEqual(collections: string[][]): boolean {
        const refCollection: string[] = collections[0];
        for (const c of collections) {
          if (c.length !== refCollection.length) {
            return false;
          }

          for (let i = 0; i < c.length; i++) {
            if (c[i] !== refCollection[i]) {
              return false;
            }
          }
        }
        //
        return true;
      })(collections);

      if (!test1Passed) {
        throw new Error('Collection names were not replicated properly...');
      }
      console.log('TEST 1 PASSED ->', collections[0]);
      //

      //
      console.log('TEST 2: CHECKING IF DOCUMENT COUNTS ARE EQUAL ON ALL NODES FOR ALL COLLECTIONS');

      //

      const c: string[] = Array.from(collections[0]); // collection names are already replicated properly at this point. So taking [0] suffices.
      //console.log(c);

      // For each collection, make sure all docCounts are replicated properly.
      for (const name of c) {
        //console.log(`CHECKING COLLECTION DOC COUNT: ${name}...`)
        const docCounts: number[] = [];

        for (const p of node.getPeerList()) {
          const isDifferentNode: boolean = p['NodeId'] !== node.getNodeId();
          if (isDifferentNode) {
            const apiAddress = 3000 + Number(p.NodeId.substring(4));
            url = `http://localhost:${apiAddress}/RAFT/GET/documentCount/${name}`;
            response = await fetch(url);
            if (!response.ok) {
              throw new Error(`Response status: ${response.status}`);
            }
            const result: { count: number; node: string; collection: string } = (await response.json()) as {
              count: number;
              node: string;
              collection: string;
            };
            docCounts.push(result['count']);
            //console.log(result);
            //console.log("documents, result:",documents, result);
          }
        }

        // add documents from this node as well
        const collection: Collection = await db.getCollection(name);
        const docCount: number = await collection.countDocuments();

        docCounts.push(docCount);

        console.log(name, docCounts);

        //
      }

      console.log('TEST 2 PASSED');

      //
      console.log('TEST 3: CHECKING IF DOCUMENTS ARE CORRECTLY REPLICATED');

      // {nodeId: {name: [doc1, doc2,...]}}
      for (const name of c) {
        const documents: Document[][] = [];

        //console.log(`CHECKING COLLECTION DOC COUNT: ${name}...`)

        for (const p of node.getPeerList()) {
          const isDifferentNode: boolean = p['NodeId'] !== node.getNodeId();
          if (isDifferentNode) {
            const apiAddress: number = 3000 + Number(p.NodeId.substring(4));
            url = `http://localhost:${apiAddress}/RAFT/GET/documents/${name}`;
            response = await fetch(url);
            if (!response.ok) {
              throw new Error(`Response status: ${response.status}`);
            }
            const result: { docs: Document[] } = (await response.json()) as { docs: Document[] };
            documents.push(result['docs']);
            //console.log(result);
            //console.log("documents, result:",documents, result);
          }
        }

        // add documents from this node as well
        const collection: Collection = await db.getCollection(name);
        const allDocuments: Document[] = await collection.find();
        documents.push(allDocuments);

        // Make sure documents are deep equal
        for (let i = 0; i < documents[0].length; i++) {
          // i'th document
          const refDoc: Document = documents[0][i];
          for (const arr of documents) {
            try {
              //console.log("deepeq?", refDoc, arr[i])
              deepEqual(refDoc, arr[i]);
            } catch {
              // first collection where they were not equal. Most likely cause is different UUIDs.
              // if they have the same UUIDs, they will be in the same order, so you can assume different UUIDs if different documents conceptually.
              //console.log(refDoc, arr[i]);
              throw new Error(`TEST 3 FAILED: Documents were not equal in collection ${name}`);
            }
          }
        }

        //
        //console.log(name, documents);
      }

      console.log('TEST 3 PASSED!');

      console.log('+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++');

      //
      res.status(200);
      res.json({});
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.get('/RAFT/GET/collections', async (_req, res) => {
    try {
      //console.log("+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++")
      if (!node) {
        throw Error('node was null or undefined - (/RAFT/GET/collections');
      }
      if (!db) {
        throw Error('db was null or undefined - (/RAFT/GET/collections');
      }

      const names: string[] = await db.getCollectionNames();
      //console.log(names);

      //console.log("+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++")

      res.status(200);
      res.json(names);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  //
  app.get('/RAFT/GET/documents/:name', async (req, res) => {
    //console.log("+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++")
    try {
      if (!node) {
        throw Error('node was null or undefined - (/RAFT/GET/documents');
      }
      if (!db) {
        throw Error('db was null or undefined - (/RAFT/GET/documents');
      }
      //
      const collectionName: string = req.params.name;
      //console.log(`getting documents from collection ${collectionName} in ${node?.getNodeId()}`);
      const collection: Collection = await db.getCollection(collectionName);
      const allDocuments: Document[] = await collection.find();
      //console.log("+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++")
      res.status(200);
      res.json({ docs: allDocuments });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.get('/RAFT/GET/documentCount/:name', async (req, res) => {
    try {
      if (!node) {
        throw Error('node was null or undefined - (SQL)');
      }

      //console.log("+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++")
      const collectionName = req.params.name;
      //console.log(`getting document count from collection ${collectionName} in ${node?.getNodeId()}`);
      const c: Collection = await db.getCollection(collectionName);
      const docCount: number = await c.countDocuments();

      //console.log("+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++")
      res.status(200);
      res.json({ count: docCount, node: node.getNodeId(), collection: collectionName });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Start server

  if (process.env['NODE_ENV'] !== 'test') {
    initDB()
      .then(async () => {
        //
        const nodeIds = wellKnownPeers.map((p) => p['id']);

        console.log(`Setting up dbms daemon ${nodeId} as a RAFT node...`);

        const number: number = Number(nodeId.substring(4)); // nodeXYZ -> XYZ
        // const peers   = nodeIds.map((id, i) => ({ id, address: `localhost:${50000 + i+1}` })).filter((x) => x['id'] != nodeId);
        const peers = nodeIds
          .map((id, i) => ({ id, address: `localhost:${50000 + i + 1}` }))
          .filter((x) => x['id'] !== nodeId);

        const converted: Record<string, string> = {};
        for (const p of peers) {
          converted[p['id']] = p['address'];
        }
        console.log('converted', converted);

        const grpcPort: number = 50000 + number; // find an open port to use on this (virtualized) machine
        const address: string = `localhost:${grpcPort}`; // localhost:port for GRPC

        const logpath: string = `./data/generated-database/${nodeId}`;
        const FSM: daemonFSM = new daemonFSM();
        fsm = FSM;
        node = new RaftNode({
          //
          config: {
            nodeId: nodeId,
            address: address,
            peers: peers,
            electionTimeoutMinMs: 1500,
            electionTimeoutMaxMs: 3000,
            heartbeatIntervalMs: 500,
          },
          storage: new DiskNodeStorage(logpath), // for the RAFT logs. Not the underlying DB data.
          transport: new GrpcTransport(`${nodeId}`, grpcPort, converted), // Record<string, string>
          stateMachine: FSM,
        });
        //
        ////
        FSM.setRaftNode(node);
        FSM.setDB(db);
        FSM.setOnSnapshotInstalled(async () => {
          console.log(`[daemon] Re-initializing DB after snapshot installation...`);
          await initDB();
          FSM.setDB(db);
          console.log(`[daemon] DB re-initialized and FSM updated.`);
        });
        //
        //// Uncommenting this line silences [INFO] and [WARNING]s from the logger
        node.toggleLogger();
        await node.start();
        //
        /////await node.debug_printNodeVariables();
        /////const entr = await node.getEntries(1, node.getLastLogIndex());
        /////console.log(entr)
        /////throw new Error("intentional crash");
        //
        console.log(`Node with (nodeId, node.getNodeId, port)=(${nodeId}, ${node.getNodeId()}, ${port}) has started`);

        const server = app.listen(port, () => {
          console.log(`SimpleDBMS Daemon listening at http://localhost:${port}`);
          console.log(`Swagger UI available at http://localhost:${port}/api-docs`);
        });

        // wait for leader to be elected
        await new Promise((resolve) => setTimeout(resolve, 500));

        //

        let shuttingDown = false;
        const shutdown = async (signal: string) => {
          if (shuttingDown === true) {
            return;
          }
          shuttingDown = true;

          console.log(`Received ${signal}, shutting down...`);
          try {
            // close db if it still exists
            if (db) {
              await db.close();
            }
            server.close(() => {
              process.exit(0);
            });
          } catch (error) {
            console.error('Error during shutdown:', error);
            process.exit(1);
          }
        };

        process.on('SIGINT', () => {
          void shutdown('SIGINT');
        });

        process.on('SIGTERM', () => {
          void shutdown('SIGTERM');
        });
      })
      .catch((err) => {
        console.error('Failed to start daemon:', err);
        process.exit(1);
      });
  }
}

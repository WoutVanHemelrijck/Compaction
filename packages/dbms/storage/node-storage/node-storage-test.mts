// @author Mathias Bouhon Keulen
// @date 2025-11-13

import { FBNodeStorage, FBInternalNode } from './fb-node-storage.mjs';
import { FreeBlockFile, NO_BLOCK } from '../../storage/freeblockfile.mjs';
import { MockFile } from '../../storage/file/mockfile.mjs';

class TestAtomicFile {
  file: MockFile;
  private inTransaction = false;
  private stagedWrites: { position: number; buffer: Buffer }[] = [];
  private opened = false;

  constructor(file: MockFile) {
    this.file = file;
  }

  async open() {}

  async close() {}

  async begin(): Promise<void> {
    if (this.inTransaction) throw new Error('Transaction already in progress.');
    this.inTransaction = true;
    this.stagedWrites = [];
    return Promise.resolve();
  }

  async journalWrite(offset: number, data: Uint8Array): Promise<void> {
    if (!this.inTransaction) throw new Error('No active transaction.');
    this.stagedWrites.push({ position: offset, buffer: Buffer.from(data) });
    return Promise.resolve();
  }

  async commitDataToWal(): Promise<void> {
    if (!this.inTransaction) throw new Error('No active transaction.');
    // No-op for mock; in real implementation this writes to WAL
    return Promise.resolve();
  }

  async checkpoint(): Promise<void> {
    for (const w of this.stagedWrites) {
      await this.file.writev([w.buffer], w.position);
    }
    if (typeof this.file.sync === 'function') await this.file.sync();
    this.stagedWrites = [];
    this.inTransaction = false;
  }

  getOpenAndInTransaction(): boolean {
    return this.inTransaction && this.opened;
  }

  async sync() {
    await this.file.sync();
  }
}

async function dumpBufferInfo(buf: Buffer | null | undefined, label = 'buffer') {
  await Promise.resolve();
  if (!Buffer.isBuffer(buf)) {
    console.log(label, 'is not a Buffer:', buf);
    return;
  }
  console.log(`${label}.length = ${buf.length}`);
  const preview = buf.slice(0, 256).toString('utf8').replace(/\0/g, '\\0');
  console.log(`${label} preview (utf8, first 256 chars, \\0 shown as \\0):`);
  console.log(preview);
  console.log(
    `${label} hex (first 128 bytes):`,
    buf
      .slice(0, 128)
      .toString('hex')
      .match(/.{1,32}/g)
      ?.join(' ') ?? '',
  );
}

async function run() {
  console.log('=== fb-node-storage test ===');

  const mf = new MockFile(512);
  const atomic = new TestAtomicFile(mf);
  const fb = new FreeBlockFile(mf, atomic, 4096);
  await fb.open();
  console.log('FreeBlockFile opened');

  const storage = new FBNodeStorage<number, string>(
    (a, b) => a - b,
    (_k) => 8,
    fb,
    64,
  );

  const leaf = await storage.createLeaf();
  console.log('Created leaf node');

  const c1 = leaf.getCursorBeforeFirst();
  await c1.insert(10, 'v10');
  await c1.insert(5, 'v5');
  await c1.insert(20, 'v20');
  console.log('Inserted keys into leaf. Leaf blockId:', leaf.blockId);

  await storage.commitAndReclaim();
  console.log('Committed staged writes to mock file');

  const persistedId = leaf.blockId;
  console.log('Persisted leaf block id:', persistedId);

  if (typeof persistedId === 'number' && persistedId !== NO_BLOCK) {
    const raw = await fb.readBlob(persistedId);
    await dumpBufferInfo(raw, `raw blob for block ${persistedId}`);

    try {
      const parsed = JSON.parse(raw.toString('utf8')) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        console.log('Manual JSON.parse succeeded. Parsed object keys:', Object.keys(parsed as Record<string, unknown>));
      } else {
        console.log('Manual JSON.parse succeeded but value is not an object:', parsed);
      }
    } catch (err) {
      console.error('Manual JSON.parse failed for raw blob:', err);
      await dumpBufferInfo(raw, `raw blob for block ${persistedId}`);
    }

    try {
      const loaded = await storage.loadNode(persistedId);
      console.log('storage.loadNode succeeded. isLeaf =', loaded.isLeaf);
      if (loaded.isLeaf) {
        const l = loaded;
        console.log('Loaded leaf keys:', l.keys);
        console.log('Loaded leaf values:', l.values);
      }
    } catch (err) {
      console.error('storage.loadNode threw an error:', err);
      const raw2 = await fb.readBlob(persistedId);
      await dumpBufferInfo(raw2, `raw blob re-read after loadNode failure for block ${persistedId}`);
    }
  } else {
    console.warn('Leaf did not get a persisted block id — something went wrong.');
  }

  const leaf2 = await storage.createLeaf();
  await leaf2.getCursorBeforeFirst().insert(30, 'v30');
  await leaf2.getCursorBeforeFirst().insert(40, 'v40');

  await storage.commitAndReclaim();
  console.log('Committed second leaf. blockIds:', leaf.blockId, leaf2.blockId);

  const internal = await storage.allocateInternalNodeStorage([leaf, leaf2], [30]);
  console.log('Created internal node. blockId =', internal.blockId);

  await storage.commitAndReclaim();
  console.log('Committed internal node and children to file');

  if (typeof internal.blockId === 'number') {
    try {
      const loadedInternal = (await storage.loadNode(internal.blockId)) as FBInternalNode<number, string>;
      console.log('Loaded internal node keys =', loadedInternal.keys);
      console.log('Loaded internal childBlockIds =', loadedInternal.childBlockIds);
    } catch (err) {
      console.error('Failed to load internal node:', err);
    }
  }

  console.log('Demonstrating update of existing leaf node:');
  const cur = leaf.getCursorBeforeFirst();
  await cur.insert(7, 'v7');
  console.log('Inserted 7 into first leaf; new blockId:', leaf.blockId);

  await storage.commitAndReclaim();
  const freeHead = await fb.debug_getFreeListHead();
  console.log('Free list head after update (should be previous leaf block id):', freeHead);

  const reAlloc = await fb.allocateBlocks(1);
  console.log('Allocated block (should reuse freed id):', reAlloc);

  if (typeof leaf.blockId === 'number' && leaf.blockId !== NO_BLOCK) {
    const raw = await fb.readBlob(leaf.blockId);
    if (!Buffer.isBuffer(raw)) {
      console.warn('readBlob returned non-buffer:', raw);
    } else {
      console.log('Deserialized payload of latest leaf block (raw JSON):', raw.toString('utf8'));
    }
  }

  await fb.close();
  console.log('FreeBlockFile closed. Test completed.');
}

await run();

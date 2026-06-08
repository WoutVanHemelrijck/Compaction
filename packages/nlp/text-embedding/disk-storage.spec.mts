// @author Arwin Gorissen
// @date 2026-05-04

import { describe, it, expect, beforeEach } from 'vitest';
import { hnswIndexImpl } from './hnsw-index.mjs';
import fs from 'fs/promises';
import path from 'path';
import { FreeBlockFile } from '../../dbms/storage/freeblockfile.mjs';
import type { File as FileInterface } from '../../dbms/storage/file/file.mjs';
import { AtomicFile } from '../../dbms/storage/freeblockfile.mjs';
import { MockFile } from '../../dbms/storage/file/mockfile.mjs';
import { randomUUID } from 'crypto';
import { diskStorageImpl } from './disk-storage.mjs';
import { pipeline } from '@huggingface/transformers';
import { Node } from './node.mjs';

const insertManyCount = 100;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const BLOCK_SIZE: number = 4096 * 4;

type CsvRow = {
  answers: string;
  passages: string;
  query: string;
  query_id: string;
  query_type: string;
  wellFormedAnswers: string;
};

class TestAtomicFile {
  private file: FileInterface;
  private inTransaction = false;
  private stagedWrites: { position: number; buffer: Buffer }[] = [];
  private opened = false;

  constructor(file: FileInterface) {
    this.file = file;
  }

  async open(): Promise<void> {
    if (typeof this.file.open === 'function') await this.file.open();
  }

  async close(): Promise<void> {
    if (typeof this.file.close === 'function') await this.file.close();
  }

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

  async sync(): Promise<void> {
    if (typeof this.file.sync === 'function') await this.file.sync();
  }
}

interface SimpleExtractor {
  (
    text: string,
    options?: { pooling?: string; normalize?: boolean },
  ): Promise<{
    data: Float32Array | number[];
  }>;
}

async function getVectorEmbedding(txt: string, extractor: SimpleExtractor): Promise<Float32Array> {
  const out = await extractor(txt, { pooling: 'mean', normalize: true });
  return out.data as Float32Array;
}

async function makeFreeBlockFile() {
  const mf: MockFile = new MockFile(512);
  const atomic: TestAtomicFile = new TestAtomicFile(mf as unknown as FileInterface);
  const fb: FreeBlockFile = new FreeBlockFile(
    mf as unknown as FileInterface,
    atomic as unknown as AtomicFile,
    BLOCK_SIZE,
  );
  await fb.open();
  return { fb, mf, atomic };
}

function extractFirstStringArrayValue(input: string): string {
  try {
    const cleaned: string = input.replace(/^"\[/, '[').replace(/\]"$/, ']').replace(/'/g, '"');

    const arr: unknown = JSON.parse(cleaned) as unknown;
    return Array.isArray(arr) ? String(arr[0]) : '';
  } catch {
    return '';
  }
}

function parseCsv(content: string): CsvRow[] {
  const lines: Array<string> = content.trim().split('\n');
  const headers: Array<string> = lines[0].split(',');

  return lines.slice(1).map((line) => {
    const values: RegExpMatchArray | [] = line.match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g) || [];

    const row: Record<string, string | undefined> = {};
    headers.forEach((h, i) => {
      row[h.replace(/"/g, '')] = values[i];
    });

    return row as CsvRow;
  });
}

async function insertMany(hnsw: hnswIndexImpl, n: number) {
  const filePath: string = path.resolve(__dirname, './test.csv');
  const content: string = await fs.readFile(filePath, 'utf-8');
  const rows: CsvRow[] = parseCsv(content);

  for (let i = 0; i < n; i++) {
    const id: string = randomUUID();
    const passage: string = extractFirstStringArrayValue(rows[i].query);

    if (!passage) continue;

    await hnsw.insert(passage, id);
  }
}

describe('init() and open() tests', () => {
  let hnsw: hnswIndexImpl;
  let storage: diskStorageImpl;
  let fbFile: FreeBlockFile;

  beforeEach(async () => {
    const { fb } = await makeFreeBlockFile();
    fbFile = fb;
    const { fb: fb2 } = await makeFreeBlockFile();
    const file: MockFile = new MockFile(512);
    await file.create();

    hnsw = new hnswIndexImpl(4, 48, 96, 64, 64, fb, fb2, file);
    await hnsw.init();
    storage = hnsw.diskStorage;
  });

  it('stages the metadata block with initialized=1', async () => {
    const metadataBuffer: Buffer<ArrayBufferLike> = await fbFile.readRawBlock(1); //Metadatablock will always be block 1
    const initMarker: number = metadataBuffer.readUint32LE();
    expect(initMarker).toEqual(1);
  }, 60000);

  it('stages the metadata block with the correct currentblock', async () => {
    const metadataBuffer: Buffer<ArrayBufferLike> = await fbFile.readRawBlock(1);
    const id: number = metadataBuffer.readUint32LE(4);
    expect(id).toBe(2); //The first currentblock is always block 2
  }, 60000);

  it('stages the metadata block with NIL UUID for the entry node', async () => {
    const metadataBuffer: Buffer<ArrayBufferLike> = await fbFile.readRawBlock(1);
    const uuid: string = storage.readUUID(metadataBuffer, 8);
    expect(uuid).toBe(NIL_UUID);
  }, 60000);

  it('sets currentblock after open()', async () => {
    const buffer: Buffer = Buffer.alloc(BLOCK_SIZE);
    buffer.writeUint32LE(10, 4);
    await fbFile.stageRawBlock(2, buffer);

    const blockBuffer: Buffer<ArrayBufferLike> = await fbFile.readRawBlock(2);
    const id: number = blockBuffer.readUInt32LE(4);
    expect(id).toBe(10);
  }, 60000);

  it('sets hnswIndex entryNode to null when metadata UUID is NIL', async () => {
    await storage.open();
    expect(hnsw.entryNode).toEqual(null);
  }, 60000);

  it('sets hnswIndex entryNode correctly when not null', async () => {
    await hnsw.open();
    await hnsw.insert(
      'Et creavit deus hominem ad imaginem suam, ad imaginem dei creavit illum, masculum et feminam creavit eos.',
      'genesis',
    );
    await hnsw.close();
    hnsw.docIDMap.clear();
    await hnsw.open();

    expect(hnsw.entryNode?.docID).toEqual('genesis');
  }, 60000);
});

describe('readUUID() and addNode() tests', () => {
  let hnsw: hnswIndexImpl;
  let storage: diskStorageImpl;
  let extractor: SimpleExtractor;
  let entryID: string;

  beforeEach(async () => {
    extractor = (await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      dtype: 'fp32',
    })) as unknown as SimpleExtractor;

    const { fb } = await makeFreeBlockFile();
    const { fb: fb2 } = await makeFreeBlockFile();
    const file: MockFile = new MockFile(512);
    await file.create();

    hnsw = new hnswIndexImpl(4, 48, 96, 64, 64, fb, fb2, file);
    await hnsw.init();
    await hnsw.open();

    storage = hnsw.diskStorage;

    entryID = randomUUID();
    await hnsw.insert('Demosthenes', entryID);
  });

  it('reconstructs a UUID from bytes at offset 0', () => {
    const buffer: Buffer = Buffer.alloc(16);
    const uuidBytes: Buffer<ArrayBuffer> = Buffer.from(entryID.replace(/-/g, ''), 'hex');
    uuidBytes.copy(buffer);

    expect(storage.readUUID(buffer)).toBe(entryID);
  });

  it('reconstructs a UUID from bytes at a non-zero offset', () => {
    const buffer: Buffer = Buffer.alloc(100);
    const uuidBytes: Buffer<ArrayBuffer> = Buffer.from(entryID.replace(/-/g, ''), 'hex');
    uuidBytes.copy(buffer, 70);

    expect(storage.readUUID(buffer, 70)).toBe(entryID);
  });

  it('returns the NIL UUID when bytes are all zero', () => {
    const buffer: Buffer = Buffer.alloc(100);
    expect(storage.readUUID(buffer, 50)).toBe(NIL_UUID);
  });

  it('adds a node to nodeMap', () => {
    expect(hnsw.diskStorage.nodeMap.has(entryID)).toBe(true);
  });

  it('stores the exact node reference', async () => {
    const emb: Array<number> = Array.from(
      await getVectorEmbedding('What s in a name, a rose by any other name would smell as sweet.', extractor),
    );
    const node: Node = new Node(emb, randomUUID(), 5);
    storage.addNode(node);

    expect(storage.nodeMap.get(node.docID)).toBe(node);
  });

  it('overwrites an existing entry with the same docID', async () => {
    const emb: Array<number> = Array.from(await getVectorEmbedding('Perikles', extractor));
    const node2: Node = new Node(emb, entryID, 5);
    storage.addNode(node2);
    expect(storage.nodeMap.get(entryID)).toBe(node2);
  }, 60000);

  it('addNode() test', async () => {
    await insertMany(hnsw, insertManyCount);
    expect(hnsw.diskStorage.nodeMap.size).toEqual(insertManyCount + 1);
  }, 60000);
});

describe('commitToDisk(), loadFromDisk() and close() tests', () => {
  let hnsw: hnswIndexImpl;
  let fbFile: FreeBlockFile;
  let storage: diskStorageImpl;
  let extractor: SimpleExtractor;
  const layerCount = 3;

  beforeEach(async () => {
    extractor = (await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      dtype: 'fp32',
    })) as unknown as SimpleExtractor;

    const { fb } = await makeFreeBlockFile();
    fbFile = fb;
    const { fb: fb2 } = await makeFreeBlockFile();
    const file: MockFile = new MockFile(512);
    await file.create();

    hnsw = new hnswIndexImpl(layerCount, 48, 96, 64, 64, fb, fb2, file);
    await hnsw.init();
    await hnsw.open();

    storage = hnsw.diskStorage;
  });

  it('committed nodes are written to disk', async () => {
    const emb: Float32Array<ArrayBufferLike> = await getVectorEmbedding('EEEE', extractor);
    const node: Node = new Node(Array.from(emb), randomUUID(), layerCount);
    storage.addNode(node);
    await storage.commitToDisk();

    expect(await storage.loadFromDisk(node.docID)).toBeDefined();

    const id: string = randomUUID();
    await hnsw.insert('Geef me nog wat wijn want het leven is niets.', id);
    await hnsw.commitToDisk();

    expect(await storage.loadFromDisk(id)).toBeDefined();
  }, 60000);

  it('overwrite older version of a node that has not been committed', async () => {
    const id: string = randomUUID();
    await hnsw.insert('Tityre tu patulae, recubans sub tegmine fagi, et musam avena', id);
    await hnsw.insert('Horum omnum fortissimum sunt Belgae', id);

    await storage.commitToDisk();

    expect(await storage.loadFromDisk(id)).toBeDefined();

    const buffer: Buffer<ArrayBufferLike> = await fbFile.readRawBlock(2);
    const readID: string = storage.readUUID(buffer, 8);
    expect(readID).toEqual(id);
  }, 60000);

  it('overwrite older version of a node that has been committed', async () => {
    const emb: Float32Array<ArrayBufferLike> = await getVectorEmbedding('EEEE', extractor);
    const node: Node = new Node(Array.from(emb), randomUUID(), layerCount);
    storage.addNode(node);
    await storage.commitToDisk();

    node.setLayer(2);
    await storage.commitToDisk();

    expect(await storage.loadFromDisk(node.docID)).toBeDefined();

    const buffer: Buffer<ArrayBufferLike> = await fbFile.readRawBlock(2);
    const layer: number = buffer.readUint16LE(24); //Layer of node in first place in first block
    expect(layer).toEqual(2);
  }, 60000);

  it('overwrite deleted node', async () => {
    const id: string = randomUUID();
    await hnsw.insert('L enfer c est les autres', id);
    await storage.commitToDisk();
    await storage.delete(id);

    await hnsw.insert(
      'Über allen Gipfeln is ruh. In allen Wipfeln spürest du. Kaum einen Hauch. Die vögelein schweigen im Walde. Warte nur; balde. Ruhest du auch?',
      id,
    );
    await storage.commitToDisk();

    expect(await storage.loadFromDisk(id)).toBeDefined();

    const buffer: Buffer<ArrayBufferLike> = await fbFile.readRawBlock(2);
    const readID: string = storage.readUUID(buffer, 8);
    expect(readID).toEqual(id);
  }, 60000);

  it('handles combination of write and overwrite correctly', async () => {
    const id: string = randomUUID();
    await hnsw.insert('L enfer c est les autres', id);
    await storage.commitToDisk();
    await storage.delete(id);

    await hnsw.insert(
      'Über allen Gipfeln is ruh. In allen Wipfeln spürest du. Kaum einen Hauch. Die vögelein schweigen im Walde. Warte nur; balde. Ruhest du auch?',
      id,
    );
    const id2: string = randomUUID();
    await hnsw.insert('Wer reitet so spät durch Nacht und Wind, es ist der Vater mit seinem Kind.', id2);
    await storage.commitToDisk();

    expect(await storage.loadFromDisk(id)).toBeDefined();

    const buffer: Buffer<ArrayBufferLike> = await fbFile.readRawBlock(2);
    const readID: string = storage.readUUID(buffer, 8);
    expect(readID).toEqual(id);
    const readID2: string = storage.readUUID(buffer, 7324);
    expect(readID2).toEqual(id2);
  }, 60000);

  it('reads over multiple block correctly', async () => {
    await insertMany(hnsw, 1);
    const id: string = randomUUID();
    await hnsw.insert('Joseph K', id);
    await hnsw.commitToDisk();

    const node: Node = await storage.loadFromDisk(id);
    expect(node.vector).toEqual(Array.from(await getVectorEmbedding('Joseph K', extractor)));
  }, 60000);

  it('loads all nodes in a block to memory', async () => {
    await insertMany(hnsw, 1);
    const id: string = randomUUID();
    await hnsw.insert('Joseph K', id);
    await hnsw.commitToDisk();
    hnsw.docIDMap.clear();

    await storage.loadFromDisk(id);
    expect(hnsw.docIDMap.size).toEqual(2);
  }, 60000);

  it('everything is written to disk in close', async () => {
    await insertMany(hnsw, 10);
    const IDs: Array<string> = [];
    for (const id of hnsw.docIDMap.keys()) {
      IDs.push(id);
    }
    await hnsw.close();
    hnsw.docIDMap.clear();

    await hnsw.open();
    for (const id of IDs) {
      const node: Node = await storage.loadFromDisk(id);
      expect(node).toBeDefined();
    }
  }, 60000);

  it('metadatablock is updated in close', async () => {
    await insertMany(hnsw, 5);
    await hnsw.close();

    const buffer: Buffer<ArrayBufferLike> = await fbFile.readRawBlock(1);
    const currentBlock: number = buffer.readUInt32LE(4);
    expect(currentBlock).toEqual(4);
  }, 60000);
});

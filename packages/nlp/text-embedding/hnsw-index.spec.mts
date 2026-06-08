// @author Arwin Gorissen
// @date 2025-05-05

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { hnswIndexImpl } from './hnsw-index.mjs';
import fs from 'fs/promises';
import path from 'path';
import { FreeBlockFile } from '../../dbms/storage/freeblockfile.mjs';
import type { File as FileInterface } from '../../dbms/storage/file/file.mjs';
import { AtomicFile } from '../../dbms/storage/freeblockfile.mjs';
import { MockFile } from '../../dbms/storage/file/mockfile.mjs';
import { randomUUID } from 'crypto';
import { Node } from './node.mjs';
import { Collection } from '../../dbms/core/simpledbms.mjs';
import { Document } from '../../dbms/core/simpledbms.mjs';

const insertManyCount = 100;

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

class testCollection {
  public IDs: Set<string> = new Set();

  async insert(doc: Omit<Document, 'id'> & { id?: string }) {
    this.IDs.add(
      Object.values(doc)
        .filter((v): v is string => typeof v === 'string')
        .join(' '),
    );
    await Promise.resolve();
  }

  async findById(id: string): Promise<Document | null> {
    if (this.IDs.has(id)) {
      return await Promise.resolve({ id: id, txt: 'randomtext' } as Document);
    }
    return await Promise.resolve(null);
  }
}

async function makeFreeBlockFile() {
  const mf: MockFile = new MockFile(512);
  const atomic: TestAtomicFile = new TestAtomicFile(mf as unknown as FileInterface);
  const fb: FreeBlockFile = new FreeBlockFile(
    mf as unknown as FileInterface,
    atomic as unknown as AtomicFile,
    4096 * 4,
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

describe('insert() tests', () => {
  let hnsw: hnswIndexImpl;

  beforeEach(async () => {
    const { fb } = await makeFreeBlockFile();
    const { fb: fb2 } = await makeFreeBlockFile();
    const file: MockFile = new MockFile(512);
    await file.create();

    hnsw = new hnswIndexImpl(4, 48, 96, 64, 64, fb, fb2, file);
    await hnsw.init();
    await hnsw.open();

    await hnsw.insert('trajanus', '1');
  });

  it('sets entryNode to the inserted node', async () => {
    expect(hnsw.entryNode).not.toBeNull();
    expect(hnsw.entryNode!.docID).toBe('1');

    await hnsw.insert('hadrianus', '2');
    expect(['1', '2']).toContain(hnsw.entryNode!.docID);
  }, 60000);

  it('records the nodes in docIDMap', async () => {
    expect(hnsw.docIDMap.has('1')).toBe(true);
    expect(hnsw.docIDMap.get('1')!.docID).toBe('1');

    await hnsw.insert('hadrianus', '2');
    expect(hnsw.docIDMap.size).toBe(2);
  }, 60000);

  it('stores a vector on the node', () => {
    const node: Node = hnsw.docIDMap.get('1')!;
    expect(node.vector).toBeInstanceOf(Array);
    expect(node.vector.length).toBeGreaterThan(0);
    node.vector.forEach((v) => expect(typeof v).toBe('number'));
  }, 60000);

  it('re-insert same docID overwrites correctly', async () => {
    await hnsw.insert('hadrianus', '2');
    const firstVector: Array<number> = [...hnsw.docIDMap.get('2')!.vector];

    await hnsw.insert('marcus aurelius', '2');
    const secondVector: Array<number> = [...hnsw.docIDMap.get('2')!.vector];
    expect(secondVector).not.toEqual(firstVector);
    expect(hnsw.docIDMap.size).toBe(2);
  }, 60000);

  it('every node has a layer within [0, layerCount-1]', async () => {
    await insertMany(hnsw, insertManyCount);
    for (const [, node] of hnsw.docIDMap) {
      expect(node.layer).toBeGreaterThanOrEqual(0);
      expect(node.layer).toBeLessThanOrEqual(4);
    }
  }, 60000);

  it('entryNode is always on the highest layer', async () => {
    await insertMany(hnsw, insertManyCount);
    for (const [, node] of hnsw.docIDMap) {
      expect(hnsw.entryNode!.layer).toBeGreaterThanOrEqual(node.layer);
    }
  }, 60000);

  it('every neighbour reference points to an existing node', async () => {
    await insertMany(hnsw, insertManyCount);
    for (const [, node] of hnsw.docIDMap) {
      for (let l = 0; l <= node.layer; l++) {
        for (const nid of node.neighbours[l].getData()) {
          expect(hnsw.docIDMap.has(nid)).toBe(true);
        }
      }
    }
  }, 60000);

  it('no node lists itself as its own neighbour', async () => {
    await insertMany(hnsw, insertManyCount);
    for (const [, node] of hnsw.docIDMap) {
      for (let l = 0; l <= node.layer; l++) {
        expect(node.neighbours[l].getData()).not.toContain(node.docID);
      }
    }
  }, 60000);

  it('neighbour count does not exceed Mmax per layer', async () => {
    const dbFile: MockFile = new MockFile(512);
    const walFile: MockFile = new MockFile(512);
    await dbFile.create();
    await walFile.create();

    const { fb } = await makeFreeBlockFile();
    const { fb: fb2 } = await makeFreeBlockFile();
    const file: MockFile = new MockFile(512);
    await file.create();

    const hnsw: hnswIndexImpl = new hnswIndexImpl(4, 2, 3, 64, 64, fb, fb2, file);
    await hnsw.init();
    await hnsw.open();

    await insertMany(hnsw, insertManyCount);
    for (const [, node] of hnsw.docIDMap) {
      for (let l = 0; l <= node.layer; l++) {
        expect(node.neighbours[l].size()).toBeLessThanOrEqual(3);
      }
    }
  }, 60000);

  it('connections are bidirectional (if A knows B, B likely knows A for small sets)', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9999);
    for (let i = 0; i < 5; i++) await hnsw.insert(`doc ${i}`, randomUUID());
    vi.restoreAllMocks();

    for (const [id, node] of hnsw.docIDMap) {
      for (const nid of node.neighbours[0].getData()) {
        const neighbour = hnsw.docIDMap.get(nid)!;
        expect(neighbour.neighbours[0].getData()).toContain(id);
      }
    }
  }, 60000);
});

describe('search() tests 1', () => {
  let hnsw: hnswIndexImpl;

  beforeEach(async () => {
    const { fb } = await makeFreeBlockFile();
    const { fb: fb2 } = await makeFreeBlockFile();
    const file = new MockFile(512);
    await file.create();

    hnsw = new hnswIndexImpl(4, 48, 96, 64, 64, fb, fb2, file);
    await hnsw.init();
    await hnsw.open();
  }, 60000);

  it('throws when the index is empty', async () => {
    await expect(hnsw.search('Qualis artifex pereo.')).rejects.toThrow('HNSW is empty.');
  }, 60000);

  it('returns the only node regardless of query', async () => {
    await hnsw.insert(
      'Odi et amo, quare id faciam, fortasse requiris, nescio, sed fieri sentio, et excrucior.',
      'Catullus',
    );
    const result: Array<string> = await hnsw.search('Test');
    expect(result[0]).toBe('Catullus');
  }, 60000);
});

describe('search() tests 2', () => {
  let hnsw: hnswIndexImpl;

  beforeEach(async () => {
    const { fb } = await makeFreeBlockFile();
    const { fb: fb2 } = await makeFreeBlockFile();
    const file: MockFile = new MockFile(512);
    await file.create();

    hnsw = new hnswIndexImpl(4, 48, 96, 64, 64, fb, fb2, file);
    await hnsw.init();
    await hnsw.open();
    await insertMany(hnsw, insertManyCount);
  }, 60000);

  it('returns nBestMatches results when asked', async () => {
    let result: Array<string> = await hnsw.search('banaan');
    expect(result).toHaveLength(1);

    result = await hnsw.search('pizza', 5);
    expect(result).toHaveLength(5);
  }, 60000);

  it('valid docIDs in results exist in the index', async () => {
    const result = await hnsw.search('Numa Pompilius', 5);
    for (const id of result) {
      if (id !== undefined) {
        expect(hnsw.docIDMap.has(id)).toBe(true);
      }
    }
  }, 60000);

  it('returned docIDs are unique', async () => {
    const result: Array<string> = await hnsw.search('Cicero', 5);
    const unique: Set<string> = new Set(result);
    expect(unique.size).toBe(result.length);
  }, 60000);

  it('querying with the exact text of an inserted doc returns that doc', async () => {
    const txt1: string =
      'Passer, deliciae meae puellae, quicum ludere, quem in sinu tenere et cui primum digitum dare appetenti';
    await hnsw.insert(txt1, 'a');
    let result: Array<string> = await hnsw.search(txt1);
    expect(result[0]).toBe('a');

    await insertMany(hnsw, insertManyCount);
    const txt2: string = 'Nemo censetur ignorare legem.';
    await hnsw.insert(txt2, 'b');
    result = await hnsw.search(txt2);
    expect(result[0]).toBe('b');

    await insertMany(hnsw, insertManyCount);
    const txt3: string =
      'Toch lang bewaart, dit zeg ik u, t en ware ik t al verloze, mijn hert drie dierbre beelden, u, dien avond, en die roze';
    await hnsw.insert(txt3, 'c');
    result = await hnsw.search(txt3);
    expect(result[0]).toBe('c');
  }, 180000);

  it('querying a description returns an associated doc', async () => {
    const txt1: string =
      'Mix meat and ... sauce over and bake at 325 to 350 degrees for about 1 hour and 15 minutes. Mix well, pour over meat mixture and bake as directed above. In a large pot, over high heat, add the olive oil. In a mixing bowl, toss the venison with flour and Essence. When the oil is hot, sear the meat for 2 to 3 minutes, stirring occasionally. Add the onions and saute for 2 minutes. Add the celery and carrots. Season with salt and pepper. Saute for 2 minutes. Directions. Put the sausages into the middle of the oven. Turn them over after 15 minutes. Continue cooking them for another 10 to 15 minutes, until they reach 160 F at center, as measured by an instant-read thermometer. Tip. 1  Try this sweet venison sausage preparation. 2  Melt two pats of butter in a large skillet over medium heat and stir in brown sugar and cinnamon to taste. 3  Lay large chunks of apple and pear in the pan and saute them for about 5 minutes.';
    await hnsw.insert(txt1, 'a');
    let result: Array<string> = await hnsw.search('I want a recipe for cooking something.');
    expect(result[0]).toBe('a');

    await insertMany(hnsw, insertManyCount);
    const txt2: string =
      'The scientific name of zebu cattle was originally Bos indicus, but they are now more commonly classified within the species Bos taurus as Bos taurus indicus, together with taurine cattle (Bos taurus taurus) and the ancestor of both of them, the extinct aurochs (Bos taurus primigenius). Zebu are used as draught oxen, as dairy cattle and as beef cattle, as well as for by-products such as hides, dung for fuel and manure, and bone for knife handles and the like. Zebu Facts. Zebu is one of the oldest breeds of cattle in the world. There are 75 different species of zebu that differ from one another by size, color and type of habitat which they inhabit. Zebus are the only type of cattle that lives in tropical rainforests. They can be also found in open plains. Animal: Zebu Species: The scientific name for the Zebu is Bos Primigenius Indicus. There are about 75 different breeds of Zebu. Lifespan: The average lifespan of a Zebu is 12-16 years. Size & Weight: Zebus are very small for being cattle. They are about 3ft tall and weigh 300-440lbs. Habitat: Zebus are the only species of cattle that can inhabit tropical rainforests.';
    await hnsw.insert(txt2, 'b');
    result = await hnsw.search('Tell me about animals that are bred for their meat and graze grass in fields.');
    expect(result[0]).toBe('b');

    await insertMany(hnsw, insertManyCount);
    const txt3: string =
      'The Aztec. The last of the great MesoAmerican cultures were the Aztec, they were a Nahuatl-speaking people, who in the 15th and early 16th centuries, ruled a large empire in what is now central and southern Mexico. Then there were the Toltecs, who dominated much of central Mexico around 1200 A.D. Their language “Nahuatl”, was also spoken by the Aztecs. They were a militaristic nomadic people, and they or their ancestors may have sacked the city of Teotihuacan in 750 A.D.';
    await hnsw.insert(txt3, 'c');
    result = await hnsw.search('Tell me about a native American tribe.');
    expect(result[0]).toBe('c');
  }, 180000);

  it('repeated identical searches return the same top result', async () => {
    const r1: Array<string> = await hnsw.search('Servius Tullius');
    const r2: Array<string> = await hnsw.search('Servius Tullius');
    expect(r1[0]).toBe(r2[0]);
  }, 60000);
});

describe('delete() tests', () => {
  let hnsw: hnswIndexImpl;

  beforeEach(async () => {
    const { fb } = await makeFreeBlockFile();
    const { fb: fb2 } = await makeFreeBlockFile();
    const file: MockFile = new MockFile(512);
    await file.create();

    hnsw = new hnswIndexImpl(4, 48, 96, 64, 64, fb, fb2, file);
    await hnsw.init();
    await hnsw.open();
  }, 60000);

  it('deletes docID from docIdmap', async () => {
    await insertMany(hnsw, insertManyCount);
    await hnsw.insert('Quo usque utabantur, catilina, patientia nostra?', 'a');
    await hnsw.insert('Quo usque utabantur, catilina, patientia nostra?', 'b');
    expect(hnsw.docIDMap.has('a')).toBeTruthy();
    expect(hnsw.docIDMap.has('b')).toBeTruthy();

    await hnsw.delete('a');
    expect(hnsw.docIDMap.has('a')).toBeFalsy();
    await hnsw.delete('b');
    expect(hnsw.docIDMap.has('b')).toBeFalsy();
  }, 180000);

  it('search cannot get a deleted element', async () => {
    await hnsw.insert('Gallia est omnis divisa in partes tres, quarum unam incolunt belgae, aliam acquitam', 'a');
    expect(hnsw.docIDMap.has('a')).toBeTruthy();

    await hnsw.delete('a');
    await expect(hnsw.search('test')).rejects.toThrow('No node with DocID a found.');
  }, 60000);

  it('neighbours also deleted the node', async () => {
    await insertMany(hnsw, insertManyCount);
    await hnsw.insert('Gallia est omnis divisa in partes tres, quarum unam incolunt belgae, aliam acquitam', 'a');
    expect(hnsw.docIDMap.has('a')).toBeTruthy();

    await hnsw.delete('a');

    for (const n of hnsw.docIDMap.values()) {
      for (const h of n.neighbours) {
        for (const docID of h.getData()) {
          expect(docID).not.toEqual('a');
        }
      }
    }
  }, 120000);
});

describe('crash consistency tests', () => {
  let hnsw: hnswIndexImpl;
  let file: MockFile;

  beforeEach(async () => {
    const { fb } = await makeFreeBlockFile();
    const { fb: fb2 } = await makeFreeBlockFile();
    file = new MockFile(512);
    await file.create();

    hnsw = new hnswIndexImpl(4, 48, 96, 64, 64, fb, fb2, file);
    await hnsw.init();
    await hnsw.open();
    hnsw.collection = new testCollection() as unknown as Collection;
  }, 60000);

  it('no commit and crash means data lost', async () => {
    const id: string = randomUUID();
    await hnsw.insert('It was the best of times, it was the worst of times.', id);
    hnsw.docIDMap.clear();
    await expect(hnsw.search(id)).rejects.toThrow();
  }, 60000);

  it('restore data from wall', async () => {
    await hnsw.close();

    const ID: string = randomUUID();
    const idBuf: Buffer<ArrayBuffer> = Buffer.from(ID.replace(/-/g, ''), 'hex');
    await file.writev([idBuf], 0);
    const ID2: string = randomUUID();
    const idBuf2: Buffer<ArrayBuffer> = Buffer.from(ID2.replace(/-/g, ''), 'hex');
    await file.writev([idBuf2], 16);

    const NIL_UUID: string = '00000000-0000-0000-0000-000000000000';
    const marker: Buffer<ArrayBuffer> = Buffer.from(NIL_UUID.replace(/-/g, ''), 'hex');
    await file.writev([marker], 32);

    await hnsw.collection.insert({ txt: ID });
    await hnsw.collection.insert({ txt: ID2 });
    await hnsw.collection.insert({ txt: NIL_UUID });

    await hnsw.open();
    const iter: MapIterator<string> = hnsw.docIDMap.keys();
    expect(iter.next().value).toEqual(ID);
    expect(iter.next().value).toEqual(ID2);
  }, 60000);

  it('restore data from wall', async () => {
    await insertMany(hnsw, 10);
    await hnsw.commitToWal();
  }, 60000);
});

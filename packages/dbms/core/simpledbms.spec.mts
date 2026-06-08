// @author MaartenHaine, Jari Daemen, Arwin Gorissen
// @date 2025-11-22

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  Collection,
  SimpleDBMS,
  type DocumentValue,
  type FilterOperators,
  serializeFieldValue,
  deserializeFieldValue,
} from '../core/simpledbms.mjs';
import { MockFile } from '../storage/file/mockfile.mjs';
import { DiskBackedIndexStorage } from '../big-data-import/disk-backed-index-builder.mjs';
import { FBNodeStorage } from '../storage/node-storage/fb-node-storage.mjs';
import {
  COMPRESSION_ALGORITHM_ZSTD_ID,
  COMPRESSION_ENVELOPE_HEADER_SIZE,
  CompressionService,
} from '../durability/compression/compression.mjs';

describe('Collection', () => {
  let db: SimpleDBMS;
  let collection: Collection;
  let dbFile: MockFile;
  let walFile: MockFile;
  let heapFile: MockFile;
  let heapWalFile: MockFile;

  const createIndexStorage = () =>
    new FBNodeStorage<string, number>(
      (a, b) => (a < b ? -1 : a > b ? 1 : 0),
      (key) => key.length,
      db.getFreeBlockFile(),
      4096,
    );

  beforeEach(async () => {
    dbFile = new MockFile(512);
    walFile = new MockFile(512);
    heapFile = new MockFile(512);
    heapWalFile = new MockFile(512);
    db = await SimpleDBMS.create(dbFile, walFile, heapFile, heapWalFile);
    console.log('beforeeach');
    collection = await db.createCollection('users');
  });

  afterEach(async () => {
    await db.close();
  });

  it('should insert and find documents with generated id', async () => {
    const doc = await collection.insert({ name: 'maarten', age: 25 });
    expect(doc.id).toBeDefined();
    expect(doc['name']).toBe('maarten');
    expect(doc['age']).toBe(25);
    const found = await collection.findById(doc.id);
    expect(found).toEqual(doc);
  });

  it('should respect provided ids on insert', async () => {
    const doc = await collection.insert({ id: 'user-1', name: 'random' });
    expect(doc.id).toBe('user-1');
    const found = await collection.findById('user-1');
    expect(found).toEqual(doc);
  });

  it('should update documents and keep indexes in sync', async () => {
    const storage = createIndexStorage();
    await collection.createIndex('age', storage);

    const doc = await collection.insert({ name: 'random', age: 25 });
    expect(doc['age']).toBe(25);
    const updated = await collection.update(doc.id, { age: 26 });
    expect(updated).toBeDefined();
    expect(updated!['age']).toBe(26);
    expect(await collection.findById(doc.id)).toEqual(updated);

    const stale = await collection.find({ filterOps: { age: { $eq: 25 } } });
    const fresh = await collection.find({ filterOps: { age: { $eq: 26 } } });

    expect(stale).toHaveLength(0);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toEqual(updated);
  });

  it('should isolate nested objects between insert and update (deep copy)', async () => {
    const doc = await collection.insert({
      name: 'alice',
      settings: { theme: 'dark', notifications: true },
    });

    const updated = await collection.update(doc.id, { name: 'Alice' });
    expect(updated).toBeDefined();

    const updatedSettings = updated!['settings'] as { [key: string]: DocumentValue };
    updatedSettings['theme'] = 'light';
    updatedSettings['notifications'] = false;

    const docSettings = doc['settings'] as { [key: string]: DocumentValue };
    expect(docSettings['theme']).toBe('dark');
    expect(docSettings['notifications']).toBe(true);

    const stored = await collection.findById(doc.id);
    const storedSettings = stored!['settings'] as { [key: string]: DocumentValue };
    expect(storedSettings['theme']).toBe('dark');
    expect(storedSettings['notifications']).toBe(true);
  });

  it('should delete documents and remove index entries', async () => {
    const storage = createIndexStorage();
    await collection.createIndex('age', storage);

    const doc = await collection.insert({ name: 'random', age: 25 });
    const deleted = await collection.delete(doc.id);
    expect(deleted).toBe(true);

    const found = await collection.findById(doc.id);
    expect(found).toBeNull();

    const indexed = await collection.find({ filterOps: { age: { $eq: 25 } } });
    expect(indexed).toHaveLength(0);
  });

  it('should reject indexing reserved fields', async () => {
    const storage = createIndexStorage();
    await expect(collection.createIndex('_private', storage)).rejects.toThrow();
    await expect(collection.createIndex('id', storage)).rejects.toThrow();
  });

  it('should create index on existing documents', async () => {
    await collection.insert({ id: 'u1', name: 'alice', age: 30 });
    await collection.insert({ id: 'u2', name: 'bob', age: 25 });
    await collection.insert({ id: 'u3', name: 'charlie', age: 30 });

    await collection.dropIndex('age');

    const storage = createIndexStorage();
    await collection.createIndex('age', storage);

    const results = await collection.find({ filterOps: { age: { $eq: 30 } } });
    expect(results).toHaveLength(2);
    expect(results.map((d) => d.id).sort()).toEqual(['u1', 'u3']);
  });

  it('should handle createIndex idempotency by throwing', async () => {
    const storage1 = createIndexStorage();
    const storage2 = createIndexStorage();

    await collection.createIndex('age', storage1);
    await expect(collection.createIndex('age', storage2)).rejects.toThrow('Index already exists');

    await collection.insert({ name: 'test', age: 40 });
    const results = await collection.find({ filterOps: { age: { $eq: 40 } } });
    expect(results).toHaveLength(1);
  });

  it('should maintain index when inserting new documents', async () => {
    const storage = createIndexStorage();
    await collection.createIndex('status', storage);

    await collection.insert({ id: 'd1', status: 'active' });
    await collection.insert({ id: 'd2', status: 'inactive' });
    await collection.insert({ id: 'd3', status: 'active' });

    const active = await collection.find({ filterOps: { status: { $eq: 'active' } } });
    const inactive = await collection.find({ filterOps: { status: { $eq: 'inactive' } } });

    expect(active).toHaveLength(2);
    expect(inactive).toHaveLength(1);
    expect(active.map((d) => d.id).sort()).toEqual(['d1', 'd3']);
  });

  it('should handle null and undefined values in indexed fields', async () => {
    const storage = createIndexStorage();
    await collection.createIndex('optionalField', storage);

    await collection.insert({ id: 'd1', optionalField: 'value1' });
    await collection.insert({ id: 'd2', optionalField: null });
    await collection.insert({ id: 'd3' });
    await collection.insert({ id: 'd4', optionalField: 'value2' });

    const withValue1 = await collection.find({ filterOps: { optionalField: { $eq: 'value1' } } });
    const withValue2 = await collection.find({ filterOps: { optionalField: { $eq: 'value2' } } });

    expect(withValue1).toHaveLength(1);
    expect(withValue1[0].id).toBe('d1');
    expect(withValue2).toHaveLength(1);
    expect(withValue2[0].id).toBe('d4');

    const allDocs = await collection.find({});
    expect(allDocs).toHaveLength(4);
  });

  it('should support multiple indexes on different fields', async () => {
    const ageStorage = createIndexStorage();
    const nameStorage = createIndexStorage();

    await collection.createIndex('age', ageStorage);
    await collection.createIndex('name', nameStorage);

    await collection.insert({ id: 'u1', name: 'alice', age: 30 });
    await collection.insert({ id: 'u2', name: 'bob', age: 25 });
    await collection.insert({ id: 'u3', name: 'charlie', age: 30 });

    const age30 = await collection.find({ filterOps: { age: { $eq: 30 } } });
    expect(age30).toHaveLength(2);

    const bob = await collection.find({ filterOps: { name: { $eq: 'bob' } } });
    expect(bob).toHaveLength(1);
    expect(bob[0].id).toBe('u2');
  });

  it('should produce identical final results with online indexing vs post-load indexing', async () => {
    const online = await db.createCollection('users_online_idx');
    const postload = await db.createCollection('users_postload_idx');
    const secondaryFields = ['status', 'age', 'score'];

    for (const field of secondaryFields) {
      await online.createIndex(field, createIndexStorage());
    }

    const docs = [
      { id: 'u1', name: 'alice', status: 'active', age: 30, score: 10 },
      { id: 'u2', name: 'bob', status: 'inactive', age: 22, score: 20 },
      { id: 'u3', name: 'charlie', status: 'active', age: 30, score: 30 },
      { id: 'u4', name: 'dana', status: 'active', age: 40, score: 40 },
    ];

    await online.insertMany(docs);
    await postload.insertMany(docs);

    const normalize = (results: Array<Record<string, unknown>>) =>
      results.map((doc) => ({ ...doc })).sort((a, b) => String(a['id']).localeCompare(String(b['id'])));

    const onlineAll = await online.find({ sort: { field: 'id', order: 'asc' } });
    const postloadAll = await postload.find({ sort: { field: 'id', order: 'asc' } });
    expect(normalize(onlineAll)).toEqual(normalize(postloadAll));

    const onlineFiltered = await online.find({
      filterOps: {
        status: { $eq: 'active' },
        age: { $gte: 30 },
      },
      sort: { field: 'id', order: 'asc' },
    });
    const postloadFiltered = await postload.find({
      filterOps: {
        status: { $eq: 'active' },
        age: { $gte: 30 },
      },
      sort: { field: 'id', order: 'asc' },
    });
    expect(normalize(onlineFiltered)).toEqual(normalize(postloadFiltered));
  });

  it('should end with the same secondary index set after post-load one-pass build', async () => {
    const online = await db.createCollection('users_online_idx_set');
    const postload = await db.createCollection('users_postload_idx_set');
    const secondaryFields = ['status', 'age', 'score'];

    for (const field of secondaryFields) {
      await online.createIndex(field, createIndexStorage());
    }

    const docs = [
      { id: 'a1', status: 'active', age: 25, score: 1 },
      { id: 'a2', status: 'inactive', age: 35, score: 2 },
    ];

    await online.insertMany(docs);
    await postload.insertMany(docs);

    expect(online.getIndexedFields().sort()).toEqual(postload.getIndexedFields().sort());
  });

  it('insertMany fastPath should produce the same final persisted data as safe path', async () => {
    const safeCollection = await db.createCollection('users_safe_batch');
    const fastCollection = await db.createCollection('users_fast_batch');

    const docs = [
      { id: 'p1', status: 'active', age: 29, score: 5 },
      { id: 'p2', status: 'inactive', age: 41, score: 7 },
      { id: 'p3', status: 'active', age: 29, score: 9 },
    ];

    await safeCollection.insertMany(docs);

    await fastCollection.insertMany(docs);

    const safeAll = await safeCollection.find({ sort: { field: 'id', order: 'asc' } });
    const fastAll = await fastCollection.find({ sort: { field: 'id', order: 'asc' } });
    expect(safeAll).toEqual(fastAll);

    const safeFiltered = await safeCollection.find({
      filterOps: { status: { $eq: 'active' }, age: { $eq: 29 } },
      sort: { field: 'id', order: 'asc' },
    });
    const fastFiltered = await fastCollection.find({
      filterOps: { status: { $eq: 'active' }, age: { $eq: 29 } },
      sort: { field: 'id', order: 'asc' },
    });
    expect(safeFiltered).toEqual(fastFiltered);
  });

  it('insertMany fastPath should persist a stable snapshot even if caller mutates input afterward', async () => {
    const inputDoc: Omit<import('./simpledbms.mjs').Document, 'id'> & { id?: string } = {
      id: 'snap-1',
      profile: { role: 'reader', visits: 1 },
    };

    await collection.insertMany([inputDoc]);

    const mutableProfile = inputDoc['profile'] as { role: string; visits: number };
    mutableProfile.role = 'admin';
    mutableProfile.visits = 999;

    const stored = await collection.findById('snap-1');
    expect(stored).not.toBeNull();
    expect(stored!['profile']).toEqual({ role: 'reader', visits: 1 });
  });

  it('should build secondary indexes from pre-sorted entries without collecting docId mappings in memory', async () => {
    const collectionWithIndexes = await db.createCollection('users_sorted_build');
    collectionWithIndexes.setAutoCreateSecondaryIndexesOnInsert(false);

    await collectionWithIndexes.insertMany([
      { id: '1', title: 'Alpha', timestamp: 1000, pageId: 10, name: 'Alpha', userId: 'u1' },
      { id: '2', title: 'Beta', timestamp: 2000, pageId: 11, name: 'Beta', userId: 'u2' },
      { id: '3', title: 'Gamma', timestamp: 3000, pageId: 12, name: 'Gamma', userId: 'u3' },
    ]);

    const sortedEntriesByField = new Map<string, Array<{ key: string; value: number }>>([
      [
        'title',
        [
          { key: `${serializeFieldValue('Alpha')}:1`, value: 0 },
          { key: `${serializeFieldValue('Beta')}:2`, value: 0 },
          { key: `${serializeFieldValue('Gamma')}:3`, value: 0 },
        ],
      ],
      [
        'timestamp',
        [
          { key: `${serializeFieldValue(1000)}:1`, value: 0 },
          { key: `${serializeFieldValue(2000)}:2`, value: 0 },
          { key: `${serializeFieldValue(3000)}:3`, value: 0 },
        ],
      ],
      [
        'pageId',
        [
          { key: `${serializeFieldValue(10)}:1`, value: 0 },
          { key: `${serializeFieldValue(11)}:2`, value: 0 },
          { key: `${serializeFieldValue(12)}:3`, value: 0 },
        ],
      ],
    ]);

    const created = await collectionWithIndexes.buildSecondaryIndexesFromSortedEntries(sortedEntriesByField);
    expect([...created].sort()).toEqual(['pageId', 'timestamp', 'title']);

    const byTitle = await collectionWithIndexes.find({ filterOps: { title: { $eq: 'Beta' } } });
    const byTimestamp = await collectionWithIndexes.find({ filterOps: { timestamp: { $eq: 3000 } } });
    const byPageId = await collectionWithIndexes.find({ filterOps: { pageId: { $eq: 10 } } });

    expect(byTitle.map((doc) => doc.id)).toEqual(['2']);
    expect(byTimestamp.map((doc) => doc.id)).toEqual(['3']);
    expect(byPageId.map((doc) => doc.id)).toEqual(['1']);
  });

  it('should build secondary indexes from disk-backed entry sources without materializing full arrays', async () => {
    const collectionWithIndexes = await db.createCollection('users_streaming_build');
    collectionWithIndexes.setAutoCreateSecondaryIndexesOnInsert(false);

    await collectionWithIndexes.insertMany([
      { id: '10', title: 'Delta', timestamp: 4000, pageId: 20, name: 'Delta', userId: 'u10' },
      { id: '11', title: 'Echo', timestamp: 5000, pageId: 21, name: 'Echo', userId: 'u11' },
      { id: '12', title: 'Foxtrot', timestamp: 6000, pageId: 22, name: 'Foxtrot', userId: 'u12' },
    ]);

    const titleStorage = new DiskBackedIndexStorage();
    const timestampStorage = new DiskBackedIndexStorage();

    await titleStorage.add([
      { key: `${serializeFieldValue('Echo')}:11`, value: 0 },
      { key: `${serializeFieldValue('Delta')}:10`, value: 0 },
      { key: `${serializeFieldValue('Foxtrot')}:12`, value: 0 },
    ]);

    await timestampStorage.add([
      { key: `${serializeFieldValue(5000)}:11`, value: 0 },
      { key: `${serializeFieldValue(4000)}:10`, value: 0 },
      { key: `${serializeFieldValue(6000)}:12`, value: 0 },
    ]);

    const created = await collectionWithIndexes.buildSecondaryIndexesFromEntrySources(
      new Map([
        ['title', titleStorage],
        ['timestamp', timestampStorage],
      ]),
    );

    expect([...created].sort()).toEqual(['timestamp', 'title']);

    const byTitle = await collectionWithIndexes.find({ filterOps: { title: { $eq: 'Echo' } } });
    const byTimestamp = await collectionWithIndexes.find({ filterOps: { timestamp: { $eq: 6000 } } });

    expect(byTitle.map((doc) => doc.id)).toEqual(['11']);
    expect(byTimestamp.map((doc) => doc.id)).toEqual(['12']);
  });

  it('should apply projection, sorting, skip, and limit', async () => {
    await collection.insert({ id: 'a', name: 'alpha', score: 10 });
    await collection.insert({ id: 'b', name: 'bravo', score: 30 });
    await collection.insert({ id: 'c', name: 'charlie', score: 20 });
    await collection.insert({ id: 'd', name: 'delta', score: 40 });

    const results = await collection.find({
      sort: { field: 'score', order: 'desc' },
      projection: ['name'],
      skip: 1,
      limit: 2,
    });

    expect(results).toHaveLength(2);
    expect(results.map((d) => d.id)).toEqual(['b', 'c']);
    expect(results.map((d) => d['name'])).toEqual(['bravo', 'charlie']);
    expect(results.every((d) => d['score'] === undefined)).toBe(true);
  });

  it('should honor id ranges', async () => {
    await collection.insert({ id: 'a', value: 1 });
    await collection.insert({ id: 'b', value: 2 });
    await collection.insert({ id: 'c', value: 3 });
    await collection.insert({ id: 'd', value: 4 });

    const results = await collection.find({ idRange: { min: 'b', max: 'c' } });
    expect(results.map((d) => d.id)).toEqual(['b', 'c']);
  });

  it('should aggregate by group with count, sum, avg, and min', async () => {
    await collection.insert({ id: 'd1', team: 'red', points: 10 });
    await collection.insert({ id: 'd2', team: 'red', points: 20 });
    await collection.insert({ id: 'd3', team: 'blue', points: 7 });

    const aggregateResults = await collection.aggregate({
      groupBy: 'team',
      operations: {
        count: 'count',
        sum: [{ field: 'points', as: 'total' }],
        avg: [{ field: 'points', as: 'avgPoints' }],
        min: [{ field: 'points', as: 'minPoints' }],
      },
    });

    const byTeam = new Map(aggregateResults.map((r) => [r['team'], r]));
    expect(aggregateResults).toHaveLength(2);
    expect(byTeam.get('red')).toBeDefined();
    expect(byTeam.get('blue')).toBeDefined();
    expect(byTeam.get('red')!).toMatchObject({ count: 2, total: 30, avgPoints: 15, minPoints: 10 });
    expect(byTeam.get('blue')!).toMatchObject({ count: 1, total: 7, avgPoints: 7, minPoints: 7 });
  });

  it('applyFilterOps should return null when no supported indexed field exists in filter', async () => {
    await collection.insert({ id: 'd1', age: 10 });
    await collection.insert({ id: 'd2', age: 20 });

    const applyFilterOps = (
      collection as unknown as {
        applyFilterOps: (ops: FilterOperators) => Promise<Set<number> | null>;
      }
    ).applyFilterOps.bind(collection);

    // applyFilterOps explicitly ignores the primary id index.
    const result = await applyFilterOps({ id: { $eq: 'd1' } });
    expect(result).toBeNull();
  });

  it('applyFilterOps should resolve pointers for $eq and $in on indexed fields', async () => {
    const storage = createIndexStorage();
    await collection.createIndex('status', storage);

    await collection.insert({ id: 'd1', status: 'active' });
    await collection.insert({ id: 'd2', status: 'inactive' });
    await collection.insert({ id: 'd3', status: 'active' });

    const applyFilterOps = (
      collection as unknown as {
        applyFilterOps: (ops: FilterOperators) => Promise<Set<number> | null>;
      }
    ).applyFilterOps.bind(collection);

    const readIdsFromPointers = async (pointers: Set<number>): Promise<string[]> => {
      const ids: string[] = [];
      for (const pointer of pointers) {
        const buf = await collection.getDocumentHeap().readBlob(pointer);
        const doc = JSON.parse(buf.toString()) as { id: string };
        ids.push(doc.id);
      }
      return ids.sort();
    };

    const eqPointers = await applyFilterOps({ status: { $eq: 'active' } });
    expect(eqPointers).not.toBeNull();
    expect(await readIdsFromPointers(eqPointers!)).toEqual(['d1', 'd3']);

    const inPointers = await applyFilterOps({ status: { $in: ['inactive'] } });
    expect(inPointers).not.toBeNull();
    expect(await readIdsFromPointers(inPointers!)).toEqual(['d2']);
  });

  it('applyFilterOps should intersect multi-field indexed operators', async () => {
    await collection.createIndex('status', createIndexStorage());
    await collection.createIndex('score', createIndexStorage());

    await collection.insert({ id: 'd1', status: 'active', score: 10 });
    await collection.insert({ id: 'd2', status: 'inactive', score: 20 });
    await collection.insert({ id: 'd3', status: 'active', score: 30 });
    await collection.insert({ id: 'd4', status: 'active', score: 40 });

    const applyFilterOps = (
      collection as unknown as {
        applyFilterOps: (ops: FilterOperators) => Promise<Set<number> | null>;
      }
    ).applyFilterOps.bind(collection);

    const pointers = await applyFilterOps({
      status: { $eq: 'active' },
      score: { $gte: 25, $lt: 35 },
    });

    expect(pointers).not.toBeNull();
    const ids: string[] = [];
    for (const pointer of pointers!) {
      const buf = await collection.getDocumentHeap().readBlob(pointer);
      const doc = JSON.parse(buf.toString()) as { id: string };
      ids.push(doc.id);
    }
    expect(ids.sort()).toEqual(['d3']);
  });

  it('applyFilterOps should return null for $includes-only indexed queries', async () => {
    await collection.createIndex('name', createIndexStorage());
    await collection.insert({ id: 'd1', name: 'alice' });
    await collection.insert({ id: 'd2', name: 'bob' });

    const applyFilterOps = (
      collection as unknown as {
        applyFilterOps: (ops: FilterOperators) => Promise<Set<number> | null>;
      }
    ).applyFilterOps.bind(collection);

    const result = await applyFilterOps({ name: { $includes: 'ali' } });
    expect(result).toBeNull();
  });

  it('find should use id asc fast path with skip and limit', async () => {
    await collection.insert({ id: 'a', value: 1 });
    await collection.insert({ id: 'b', value: 2 });
    await collection.insert({ id: 'c', value: 3 });
    await collection.insert({ id: 'd', value: 4 });

    const results = await collection.find({
      sort: { field: 'id', order: 'asc' },
      skip: 1,
      limit: 2,
    });

    expect(results.map((d) => d.id)).toEqual(['b', 'c']);
  });

  it('find should return descending id order when requested', async () => {
    await collection.insert({ id: 'a', value: 1 });
    await collection.insert({ id: 'b', value: 2 });
    await collection.insert({ id: 'c', value: 3 });

    const results = await collection.find({ sort: { field: 'id', order: 'desc' } });
    expect(results.map((d) => d.id)).toEqual(['c', 'b', 'a']);
  });

  it('find should honor idRange with max-only bound', async () => {
    await collection.insert({ id: 'a', value: 1 });
    await collection.insert({ id: 'b', value: 2 });
    await collection.insert({ id: 'c', value: 3 });
    await collection.insert({ id: 'd', value: 4 });

    const results = await collection.find({ idRange: { max: 'b' } });
    expect(results.map((d) => d.id)).toEqual(['a', 'b']);
  });

  it('find should apply full-scan filterOps when no index exists', async () => {
    await collection.insert({ id: 'd1', name: 'alice', age: 30 });
    await collection.insert({ id: 'd2', name: 'bob', age: 40 });
    await collection.insert({ id: 'd3', name: 'charlie', age: 35 });

    const results = await collection.find({
      filterOps: {
        age: { $nin: [40] },
        name: { $includes: 'a' },
      },
      sort: { field: 'id', order: 'asc' },
    });

    expect(results.map((d) => d.id)).toEqual(['d1', 'd3']);
  });

  it('find should throw on string comparison operators', async () => {
    await collection.insert({ id: 'd1', name: 'alice' });

    await expect(
      collection.find({
        filterOps: {
          name: { $gt: 'a' },
        },
      }),
    ).rejects.toThrow('Comparison operators ($gt, $lt, etc.) are only supported for numbers');
  });

  it('find should return correct results for indexed numeric range filters', async () => {
    await collection.createIndex('score', createIndexStorage());

    await collection.insert({ id: 'd1', score: 10 });
    await collection.insert({ id: 'd2', score: 20 });
    await collection.insert({ id: 'd3', score: 30 });
    await collection.insert({ id: 'd4', score: 40 });

    const results = await collection.find({
      filterOps: { score: { $gte: 20, $lte: 30 } },
      sort: { field: 'id', order: 'asc' },
    });

    expect(results.map((d) => d.id)).toEqual(['d2', 'd3']);
  });

  it('find should evaluate filterOps via selective candidate pointer scan path', async () => {
    await collection.createIndex('status', createIndexStorage());

    await collection.insert({ id: 'd1', status: 'active', score: 10 });
    await collection.insert({ id: 'd2', status: 'inactive', score: 20 });
    await collection.insert({ id: 'd3', status: 'inactive', score: 30 });

    const results = await collection.find({
      filterOps: {
        status: { $eq: 'active' },
        score: { $gte: 10 },
      },
    });

    expect(results.map((d) => d.id)).toEqual(['d1']);
  });

  it('find should evaluate filterOps via broad candidate primary-tree scan path', async () => {
    await collection.createIndex('status', createIndexStorage());

    await collection.insert({ id: 'd1', status: 'active', score: 10 });
    await collection.insert({ id: 'd2', status: 'active', score: 20 });
    await collection.insert({ id: 'd3', status: 'inactive', score: 30 });

    const results = await collection.find({
      filterOps: {
        status: { $in: ['active', 'inactive'] },
        score: { $gt: 15 },
      },
      sort: { field: 'id', order: 'asc' },
    });

    expect(results.map((d) => d.id)).toEqual(['d2', 'd3']);
  });

  it('find should honor idRange with min-only bound', async () => {
    await collection.insert({ id: 'a', value: 1 });
    await collection.insert({ id: 'b', value: 2 });
    await collection.insert({ id: 'c', value: 3 });
    await collection.insert({ id: 'd', value: 4 });

    const results = await collection.find({ idRange: { min: 'c' } });
    expect(results.map((d) => d.id)).toEqual(['c', 'd']);
  });

  it('applyFilterOps should support upper-bound-only indexed ranges', async () => {
    await collection.createIndex('score', createIndexStorage());

    await collection.insert({ id: 'd1', score: 10 });
    await collection.insert({ id: 'd2', score: 20 });
    await collection.insert({ id: 'd3', score: 30 });

    const applyFilterOps = (
      collection as unknown as {
        applyFilterOps: (ops: FilterOperators) => Promise<Set<number> | null>;
      }
    ).applyFilterOps.bind(collection);

    const pointers = await applyFilterOps({ score: { $lt: 21 } });
    expect(pointers).not.toBeNull();

    const ids: string[] = [];
    for (const pointer of pointers!) {
      const buf = await collection.getDocumentHeap().readBlob(pointer);
      const doc = JSON.parse(buf.toString()) as { id: string };
      ids.push(doc.id);
    }

    expect(ids.sort()).toEqual(['d1', 'd2']);
  });

  it('applyFilterOps should evaluate rest-field $eq mismatches during intersection', async () => {
    await collection.createIndex('status', createIndexStorage());
    await collection.createIndex('tier', createIndexStorage());

    await collection.insert({ id: 'd1', status: 'active', tier: 'gold' });
    await collection.insert({ id: 'd2', status: 'active', tier: 'silver' });
    await collection.insert({ id: 'd3', status: 'inactive', tier: 'gold' });

    const applyFilterOps = (
      collection as unknown as {
        applyFilterOps: (ops: FilterOperators) => Promise<Set<number> | null>;
      }
    ).applyFilterOps.bind(collection);

    const pointers = await applyFilterOps({
      status: { $eq: 'active' },
      tier: { $eq: 'gold' },
    });

    expect(pointers).not.toBeNull();
    const ids: string[] = [];
    for (const pointer of pointers!) {
      const buf = await collection.getDocumentHeap().readBlob(pointer);
      const doc = JSON.parse(buf.toString()) as { id: string };
      ids.push(doc.id);
    }
    expect(ids).toEqual(['d1']);
  });

  it('applyFilterOps should handle $in values with duplicates and preserve matching pointers', async () => {
    await collection.createIndex('status', createIndexStorage());

    await collection.insert({ id: 'd1', status: 'alpha' });
    await collection.insert({ id: 'd2', status: 'zeta' });
    await collection.insert({ id: 'd3', status: 'beta' });

    const applyFilterOps = (
      collection as unknown as {
        applyFilterOps: (ops: FilterOperators) => Promise<Set<number> | null>;
      }
    ).applyFilterOps.bind(collection);

    const pointers = await applyFilterOps({ status: { $in: ['zeta', 'alpha', 'alpha'] } });
    expect(pointers).not.toBeNull();

    const ids: string[] = [];
    for (const pointer of pointers!) {
      const buf = await collection.getDocumentHeap().readBlob(pointer);
      const doc = JSON.parse(buf.toString()) as { id: string };
      ids.push(doc.id);
    }

    expect(ids.sort()).toEqual(['d1', 'd2']);
  });

  it('find should enforce $ne in indexed candidate path', async () => {
    await collection.createIndex('status', createIndexStorage());

    await collection.insert({ id: 'd1', status: 'active', age: 30 });
    await collection.insert({ id: 'd2', status: 'active', age: 20 });
    await collection.insert({ id: 'd3', status: 'inactive', age: 25 });

    const results = await collection.find({
      filterOps: {
        status: { $eq: 'active' },
        age: { $ne: 30 },
      },
      sort: { field: 'id', order: 'asc' },
    });

    expect(results.map((d) => d.id)).toEqual(['d2']);
  });

  it('find should enforce $ne in full scan filterOps path', async () => {
    await collection.insert({ id: 'd1', name: 'alpha' });
    await collection.insert({ id: 'd2', name: 'bravo' });

    const results = await collection.find({
      filterOps: { id: { $ne: 'd1' } },
      sort: { field: 'id', order: 'asc' },
    });

    expect(results.map((d) => d.id)).toEqual(['d2']);
  });

  it('should drop index and fall back to full scan for subsequent queries', async () => {
    const storage = createIndexStorage();
    await collection.createIndex('age', storage);

    await collection.insert({ id: 'u1', name: 'alice', age: 30 });
    await collection.insert({ id: 'u2', name: 'bob', age: 25 });
    await collection.insert({ id: 'u3', name: 'charlie', age: 30 });

    expect(collection.getIndexedFields()).toContain('age');

    await collection.dropIndex('age');

    expect(collection.getIndexedFields()).not.toContain('age');

    // After dropping index, queries should still work via full scan
    const results = await collection.find({ filterOps: { age: { $eq: 30 } } });
    expect(results).toHaveLength(2);
    expect(results.map((d) => d.id).sort()).toEqual(['u1', 'u3']);
  });

  it('should be able to re-create an index after dropping it', async () => {
    const storage1 = createIndexStorage();
    await collection.createIndex('score', storage1);

    await collection.insert({ id: 'd1', score: 10 });
    await collection.insert({ id: 'd2', score: 20 });
    await collection.insert({ id: 'd3', score: 30 });

    await collection.dropIndex('score');

    // Re-create the index — should back-fill from existing documents
    const storage2 = createIndexStorage();
    await collection.createIndex('score', storage2);

    expect(collection.getIndexedFields()).toContain('score');

    const results = await collection.find({ filterOps: { score: { $gte: 20 } } });
    expect(results).toHaveLength(2);
    expect(results.map((d) => d.id).sort()).toEqual(['d2', 'd3']);
  });

  it('should throw when dropping an index that does not exist', async () => {
    await expect(collection.dropIndex('nonexistent')).rejects.toThrow('Index does not exist');
  });

  it('should throw when dropping the primary id index', async () => {
    await expect(collection.dropIndex('id')).rejects.toThrow('Cannot drop the primary ID index');
  });

  it('should keep other indexes intact when dropping one index', async () => {
    await collection.createIndex('age', createIndexStorage());
    await collection.createIndex('name', createIndexStorage());

    await collection.insert({ id: 'u1', name: 'alice', age: 30 });
    await collection.insert({ id: 'u2', name: 'bob', age: 25 });

    await collection.dropIndex('age');

    expect(collection.getIndexedFields()).not.toContain('age');
    expect(collection.getIndexedFields()).toContain('name');

    // name index still works
    const results = await collection.find({ filterOps: { name: { $eq: 'alice' } } });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('u1');
  });

  it('should insert documents after dropping an index and query them correctly', async () => {
    await collection.createIndex('status', createIndexStorage());

    await collection.insert({ id: 'd1', status: 'active' });
    await collection.dropIndex('status');

    // Insert new docs after index is dropped
    await collection.insert({ id: 'd2', status: 'active' });
    await collection.insert({ id: 'd3', status: 'inactive' });

    const all = await collection.find({});
    expect(all).toHaveLength(3);

    const filtered = await collection.find({ filter: (doc) => doc['status'] === 'active' });
    expect(filtered.map((d) => d.id).sort()).toEqual(['d1', 'd2']);
  });

  // --- serializeFieldValue / deserializeFieldValue ---

  it('serializeFieldValue should handle booleans', () => {
    expect(serializeFieldValue(true)).toBe('boolT');
    expect(serializeFieldValue(false)).toBe('boolF');
  });

  it('serializeFieldValue should handle special numbers', () => {
    expect(serializeFieldValue(NaN)).toBe('num:NaN');
    expect(serializeFieldValue(Infinity)).toBe('num:+Inf');
    expect(serializeFieldValue(-Infinity)).toBe('num:-Inf');
  });

  it('serializeFieldValue should handle negative numbers', () => {
    const serialized = serializeFieldValue(-42);
    expect(serialized).toMatch(/^num:-/);
    const deserialized = deserializeFieldValue(serialized);
    expect(deserialized).toBe(-42);
  });

  it('serializeFieldValue should handle bigints', () => {
    expect(serializeFieldValue(123n)).toMatch(/^bigint:\+/);
    expect(serializeFieldValue(-99n)).toMatch(/^bigint:-/);
    const roundTrip = deserializeFieldValue(serializeFieldValue(42n));
    expect(roundTrip).toBe(42n);
    const roundTripNeg = deserializeFieldValue(serializeFieldValue(-7n));
    expect(roundTripNeg).toBe(-7n);
  });

  it('serializeFieldValue should handle objects and arrays', () => {
    const obj = { a: 1, b: 'two' };
    const serialized = serializeFieldValue(obj);
    expect(serialized).toMatch(/^str:/);
    const deserialized = deserializeFieldValue(serialized);
    expect(deserialized).toEqual(obj);
  });

  it('serializeFieldValue should handle null and undefined', () => {
    expect(serializeFieldValue(null)).toBe('null');
    expect(serializeFieldValue(undefined)).toBe('null');
  });

  it('deserializeFieldValue should handle empty string and unknown prefixes', () => {
    expect(deserializeFieldValue('')).toBeNull();
    expect(deserializeFieldValue('null')).toBeNull();
    expect(deserializeFieldValue('unknownPrefix')).toBe('unknownPrefix');
  });

  it('deserializeFieldValue should handle invalid bigint gracefully', () => {
    // 'bigint:+notanumber' should return null from the catch block
    expect(deserializeFieldValue('bigint:+notanumber')).toBeNull();
  });

  it('deserializeFieldValue should handle non-JSON str: prefix', () => {
    expect(deserializeFieldValue('str:hello')).toBe('hello');
  });

  // --- findPagedAfter ---

  it('findPagedAfter should return first page without afterId', async () => {
    await collection.insert({ id: 'a', value: 1 });
    await collection.insert({ id: 'b', value: 2 });
    await collection.insert({ id: 'c', value: 3 });

    const page = await collection.findPagedAfter(2);
    expect(page).toHaveLength(2);
    expect(page.map((d) => d.id)).toEqual(['a', 'b']);
  });

  it('findPagedAfter should return next page with afterId', async () => {
    await collection.insert({ id: 'a', value: 1 });
    await collection.insert({ id: 'b', value: 2 });
    await collection.insert({ id: 'c', value: 3 });

    const page = await collection.findPagedAfter(2, 'a');
    expect(page).toHaveLength(2);
    expect(page.map((d) => d.id)).toEqual(['b', 'c']);
  });

  it('findPagedAfter should return fewer docs when limit exceeds remaining', async () => {
    await collection.insert({ id: 'a', value: 1 });
    await collection.insert({ id: 'b', value: 2 });

    const page = await collection.findPagedAfter(10);
    expect(page).toHaveLength(2);
  });

  // --- countDocuments ---

  it('countDocuments should return correct count', async () => {
    expect(await collection.countDocuments()).toBe(0);

    await collection.insert({ id: 'a' });
    await collection.insert({ id: 'b' });
    expect(await collection.countDocuments()).toBe(2);

    await collection.delete('a');
    expect(await collection.countDocuments()).toBe(1);
  });

  // --- aggregate max ---

  it('should aggregate with max operation', async () => {
    await collection.insert({ id: 'd1', team: 'red', points: 10 });
    await collection.insert({ id: 'd2', team: 'red', points: 20 });
    await collection.insert({ id: 'd3', team: 'blue', points: 7 });

    const results = await collection.aggregate({
      groupBy: 'team',
      operations: {
        max: [{ field: 'points', as: 'maxPoints' }],
      },
    });

    const byTeam = new Map(results.map((r) => [r['team'], r]));
    expect(byTeam.get('red')!['maxPoints']).toBe(20);
    expect(byTeam.get('blue')!['maxPoints']).toBe(7);
  });

  it('should aggregate without groupBy (global aggregation)', async () => {
    await collection.insert({ id: 'd1', points: 10 });
    await collection.insert({ id: 'd2', points: 20 });

    const results = await collection.aggregate({
      groupBy: undefined as unknown as string,
      operations: {
        count: 'total',
        sum: [{ field: 'points', as: 'sumPoints' }],
      },
    });

    expect(results).toHaveLength(1);
    expect(results[0]['total']).toBe(2);
    expect(results[0]['sumPoints']).toBe(30);
  });

  // --- full-scan filterOps comparison branches ---

  it('find full-scan should handle $gte on non-indexed field', async () => {
    await collection.insert({ id: 'd1', score: 10 });
    await collection.insert({ id: 'd2', score: 20 });
    await collection.insert({ id: 'd3', score: 30 });

    // drop auto-created index to force full-scan
    await collection.dropIndex('score');

    const results = await collection.find({
      filterOps: { score: { $gte: 20 } },
    });
    expect(results.map((d) => d.id).sort()).toEqual(['d2', 'd3']);
  });

  it('find full-scan should handle $lt on non-indexed field', async () => {
    await collection.insert({ id: 'd1', score: 10 });
    await collection.insert({ id: 'd2', score: 20 });
    await collection.insert({ id: 'd3', score: 30 });
    await collection.dropIndex('score');

    const results = await collection.find({
      filterOps: { score: { $lt: 20 } },
    });
    expect(results.map((d) => d.id)).toEqual(['d1']);
  });

  it('find full-scan should handle $lte on non-indexed field', async () => {
    await collection.insert({ id: 'd1', score: 10 });
    await collection.insert({ id: 'd2', score: 20 });
    await collection.insert({ id: 'd3', score: 30 });
    await collection.dropIndex('score');

    const results = await collection.find({
      filterOps: { score: { $lte: 20 } },
    });
    expect(results.map((d) => d.id).sort()).toEqual(['d1', 'd2']);
  });

  it('find full-scan should handle $in on non-indexed field', async () => {
    await collection.insert({ id: 'd1', status: 'a' });
    await collection.insert({ id: 'd2', status: 'b' });
    await collection.insert({ id: 'd3', status: 'c' });
    await collection.dropIndex('status');

    const results = await collection.find({
      filterOps: { status: { $in: ['a', 'c'] } },
    });
    expect(results.map((d) => d.id).sort()).toEqual(['d1', 'd3']);
  });

  it('find full-scan should handle $nin on non-indexed field', async () => {
    await collection.insert({ id: 'd1', status: 'a' });
    await collection.insert({ id: 'd2', status: 'b' });
    await collection.insert({ id: 'd3', status: 'c' });
    await collection.dropIndex('status');

    const results = await collection.find({
      filterOps: { status: { $nin: ['b'] } },
    });
    expect(results.map((d) => d.id).sort()).toEqual(['d1', 'd3']);
  });

  it('find full-scan should handle $includes on non-indexed field', async () => {
    await collection.insert({ id: 'd1', name: 'alice' });
    await collection.insert({ id: 'd2', name: 'bob' });
    await collection.insert({ id: 'd3', name: 'charlie' });
    await collection.dropIndex('name');

    const results = await collection.find({
      filterOps: { name: { $includes: 'li' } },
    });
    expect(results.map((d) => d.id).sort()).toEqual(['d1', 'd3']);
  });

  it('find full-scan should throw on $gte with string values', async () => {
    await collection.insert({ id: 'd1', name: 'alice' });
    await collection.dropIndex('name');

    await expect(collection.find({ filterOps: { name: { $gte: 'a' } } })).rejects.toThrow('Comparison operators');
  });

  it('find full-scan should throw on $lt with string values', async () => {
    await collection.insert({ id: 'd1', name: 'alice' });
    await collection.dropIndex('name');

    await expect(collection.find({ filterOps: { name: { $lt: 'z' } } })).rejects.toThrow('Comparison operators');
  });

  it('find full-scan should throw on $lte with string values', async () => {
    await collection.insert({ id: 'd1', name: 'alice' });
    await collection.dropIndex('name');

    await expect(collection.find({ filterOps: { name: { $lte: 'z' } } })).rejects.toThrow('Comparison operators');
  });

  // --- update / delete edge cases ---

  it('update should return null for nonexistent document', async () => {
    const result = await collection.update('nonexistent', { name: 'test' });
    expect(result).toBeNull();
  });

  it('delete should return false for nonexistent document', async () => {
    const result = await collection.delete('nonexistent');
    expect(result).toBe(false);
  });
});

describe('SimpleDBMS', () => {
  let dbFile: MockFile;
  let walFile: MockFile;
  let heapFile: MockFile;
  let heapWalFile: MockFile;

  beforeEach(() => {
    dbFile = new MockFile(512);
    walFile = new MockFile(512);
    heapFile = new MockFile(512);
    heapWalFile = new MockFile(512);
  });

  it('create a new database and collection', async () => {
    const db = await SimpleDBMS.create(dbFile, walFile, heapFile, heapWalFile);
    const collection = await db.createCollection('users');
    expect(collection).toBeDefined();
    await db.close();
  });

  it('insert and find documents', async () => {
    const db = await SimpleDBMS.create(dbFile, walFile, heapFile, heapWalFile);
    const collection = await db.createCollection('users');

    const doc = await collection.insert({ name: 'maarten', age: 25 });
    expect(doc.id).toBeDefined();
    expect(doc['name']).toBe('maarten');

    const found = await collection.findById(doc.id);
    expect(found).toEqual(doc);

    const results = await collection.find({ filter: (d) => d['name'] === 'maarten' });
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(doc);

    await db.close();
  });

  it('update documents', async () => {
    const db = await SimpleDBMS.create(dbFile, walFile, heapFile, heapWalFile);
    const collection = await db.createCollection('users');

    const doc = await collection.insert({ name: 'random', age: 25 });
    const updated = await collection.update(doc.id, { age: 26 });

    expect(updated).toBeDefined();
    expect(updated!['age']).toBe(26);

    const found = await collection.findById(doc.id);
    expect(found!['age']).toBe(26);

    await db.close();
  });

  it('delete documents', async () => {
    const db = await SimpleDBMS.create(dbFile, walFile, heapFile, heapWalFile);
    const collection = await db.createCollection('users');

    const doc = await collection.insert({ name: 'random', age: 25 });
    const deleted = await collection.delete(doc.id);
    expect(deleted).toBe(true);

    const found = await collection.findById(doc.id);
    expect(found).toBeNull();

    await db.close();
  });

  it('should persist data across close/open', async () => {
    // Create and populate
    let db = await SimpleDBMS.create(dbFile, walFile, heapFile, heapWalFile);
    let collection = await db.createCollection('users');
    await collection.insert({ id: 'user1', name: 'random' });
    await db.close();

    // Reopen
    db = await SimpleDBMS.open(dbFile, walFile, heapFile, heapWalFile);
    collection = await db.getCollection('users');
    const found = await collection.findById('user1');
    expect(found).toBeDefined();
    expect(found!['name']).toBe('random');
    await db.close();
  });

  it('should preserve committed batch and discard uncommitted batch after crash', async () => {
    let db = await SimpleDBMS.create(dbFile, walFile, heapFile, heapWalFile);
    db.setCatalogAutoCommitEnabled(false);

    const collection = await db.createCollection('users');

    await collection.insertMany([
      { id: 'c1', name: 'committed-1' },
      { id: 'c2', name: 'committed-2' },
    ]);
    await db.commit();

    await collection.insertMany([
      { id: 'u1', name: 'uncommitted-1' },
      { id: 'u2', name: 'uncommitted-2' },
    ]);

    // Simulate abrupt crash by discarding unsynced writes only.
    dbFile.getnewSectors().clear();
    walFile.getnewSectors().clear();
    heapFile.getnewSectors().clear();
    heapWalFile.getnewSectors().clear();

    db = await SimpleDBMS.open(dbFile, walFile, heapFile, heapWalFile);
    const reopened = await db.getCollection('users');

    expect(await reopened.findById('c1')).toBeDefined();
    expect(await reopened.findById('c2')).toBeDefined();
    expect(await reopened.findById('u1')).toBeNull();
    expect(await reopened.findById('u2')).toBeNull();

    await db.close();
  });

  it('insertMany rolls back if an error is thrown', async () => {
    const db = await SimpleDBMS.create(dbFile, walFile, heapFile, heapWalFile);
    const collection = await db.createCollection('users');

    await collection.insert({ id: 'ok-1', name: 'should-stay' });

    const idIndex = collection['indexes'].get('id');
    if (!idIndex) throw new Error('id index not found');
    const originalInsert = idIndex.insert.bind(idIndex);
    let callCount = 0;
    idIndex.insert = async (key: string, value: number) => {
      callCount++;
      if (callCount === 2) throw new Error('Simulated failure');
      return originalInsert(key, value);
    };

    await expect(
      collection.insertMany([
        { id: 'fail-1', name: 'should-not-exist' },
        { id: 'fail-2', name: 'should-not-exist' },
      ]),
    ).rejects.toThrow('Simulated failure');

    expect(await collection.findById('fail-1')).toBeNull();
    expect(await collection.findById('fail-2')).toBeNull();
    expect(await collection.findById('ok-1')).not.toBeNull();

    idIndex.insert = originalInsert;
    await db.close();
  });

  it('should handle multiple collections', async () => {
    let db = await SimpleDBMS.create(dbFile, walFile, heapFile, heapWalFile);
    const users = await db.createCollection('users');
    const posts = await db.createCollection('posts');

    await users.insert({ id: 'u1', name: 'random' });
    await posts.insert({ id: 'p1', title: 'randomtitle' });
    await db.close();

    db = await SimpleDBMS.open(dbFile, walFile, heapFile, heapWalFile);
    const users2 = await db.getCollection('users');
    const posts2 = await db.getCollection('posts');

    expect(await users2.findById('u1')).toBeDefined();
    expect(await posts2.findById('p1')).toBeDefined();
    await db.close();
  });

  it('should persist and reopen with compressed db header', async () => {
    let db = await SimpleDBMS.create(dbFile, walFile, heapFile, heapWalFile);
    const compressionService = new CompressionService({ algorithm: 'zstd' });

    await db.createCollection('users');

    const freeBlockFile = db.getFreeBlockFile();
    const currentHeader = await freeBlockFile.readHeader();

    let parsedHeader: unknown;
    if (currentHeader.subarray(0, 4).equals(Buffer.from('DBH1', 'ascii'))) {
      const compressedSize = currentHeader.readUInt32LE(9);
      const compressedPayload = currentHeader.subarray(
        COMPRESSION_ENVELOPE_HEADER_SIZE,
        COMPRESSION_ENVELOPE_HEADER_SIZE + compressedSize,
      );
      const decoded = compressionService.decompress({
        algorithm: 'zstd',
        originalSize: currentHeader.readUInt32LE(5),
        compressedSize,
        payload: Buffer.from(compressedPayload),
      });
      parsedHeader = JSON.parse(decoded.toString());
    } else {
      parsedHeader = JSON.parse(currentHeader.toString());
    }

    const headerJson = Buffer.from(JSON.stringify(parsedHeader));
    const compressedHeader = compressionService.compress(headerJson);
    const metadata = Buffer.alloc(COMPRESSION_ENVELOPE_HEADER_SIZE);
    Buffer.from('DBH1', 'ascii').copy(metadata, 0);
    metadata.writeUInt8(COMPRESSION_ALGORITHM_ZSTD_ID, 4);
    metadata.writeUInt32LE(compressedHeader.originalSize, 5);
    metadata.writeUInt32LE(compressedHeader.compressedSize, 9);

    await freeBlockFile.writeHeader(Buffer.concat([metadata, compressedHeader.payload]));
    await freeBlockFile.commit();

    await db.close();

    db = await SimpleDBMS.open(dbFile, walFile, heapFile, heapWalFile);
    const collection = await db.getCollection('users');
    await collection.insert({ id: 'doc-header-test', value: 'ok' });
    const found = await collection.findById('doc-header-test');
    expect(found).toBeDefined();
    expect(found!['value']).toBe('ok');
    await db.close();
  });

  it('should reopen with legacy plain JSON header', async () => {
    let db = await SimpleDBMS.create(dbFile, walFile, heapFile, heapWalFile);

    const users = await db.createCollection('users');
    await users.insert({ id: 'legacy-user', name: 'legacy' });

    const freeBlockFile = db.getFreeBlockFile();
    const header = await freeBlockFile.readHeader();

    let parsedHeader: unknown;
    if (header.subarray(0, 4).equals(Buffer.from('DBH1', 'ascii'))) {
      const compressedSize = header.readUInt32LE(9);
      const payload = header.subarray(
        COMPRESSION_ENVELOPE_HEADER_SIZE,
        COMPRESSION_ENVELOPE_HEADER_SIZE + compressedSize,
      );
      const service = new CompressionService({ algorithm: 'zstd' });
      const decoded = service.decompress({
        algorithm: 'zstd',
        originalSize: header.readUInt32LE(5),
        compressedSize,
        payload: Buffer.from(payload),
      });
      parsedHeader = JSON.parse(decoded.toString());
    } else {
      parsedHeader = JSON.parse(header.toString());
    }

    await freeBlockFile.writeHeader(Buffer.from(JSON.stringify(parsedHeader)));
    await freeBlockFile.commit();
    await db.close();

    db = await SimpleDBMS.open(dbFile, walFile, heapFile, heapWalFile);
    const reopenedUsers = await db.getCollection('users');
    const found = await reopenedUsers.findById('legacy-user');
    expect(found).toBeDefined();
    expect(found!['name']).toBe('legacy');
    await db.close();
  });

  it('should persist dropped index — index should not reload after close/open', async () => {
    let db = await SimpleDBMS.create(dbFile, walFile, heapFile, heapWalFile);
    let collection = await db.createCollection('items');

    await collection.insert({ id: 'i1', category: 'A' });
    await collection.insert({ id: 'i2', category: 'B' });
    await collection.insert({ id: 'i3', category: 'A' });

    // After insert, 'category' is auto-indexed
    expect(collection.getIndexedFields()).toContain('category');

    await collection.dropIndex('category');
    expect(collection.getIndexedFields()).not.toContain('category');

    await db.close();

    // Reopen — the dropped index must NOT come back
    db = await SimpleDBMS.open(dbFile, walFile, heapFile, heapWalFile);
    collection = await db.getCollection('items');

    expect(collection.getIndexedFields()).not.toContain('category');

    // Full-scan query must still work correctly
    const results = await collection.find({ filter: (d) => d['category'] === 'A' });
    expect(results.map((d) => d.id).sort()).toEqual(['i1', 'i3']);

    await db.close();
  });

  it('should persist re-created index after drop+recreate+close/open', async () => {
    let db = await SimpleDBMS.create(dbFile, walFile, heapFile, heapWalFile);
    let collection = await db.createCollection('products');

    await collection.insert({ id: 'p1', price: 10 });
    await collection.insert({ id: 'p2', price: 20 });

    // Auto-indexed on insert; drop it
    await collection.dropIndex('price');
    expect(collection.getIndexedFields()).not.toContain('price');

    await db.close();

    // Reopen — price index should still be gone
    db = await SimpleDBMS.open(dbFile, walFile, heapFile, heapWalFile);
    collection = await db.getCollection('products');
    expect(collection.getIndexedFields()).not.toContain('price');

    // Insert a new document — this auto-recreates the 'price' index
    await collection.insert({ id: 'p3', price: 30 });
    expect(collection.getIndexedFields()).toContain('price');

    await db.close();

    // Reopen — the re-created index must persist
    db = await SimpleDBMS.open(dbFile, walFile, heapFile, heapWalFile);
    collection = await db.getCollection('products');
    expect(collection.getIndexedFields()).toContain('price');

    const results = await collection.find({ filterOps: { price: { $gte: 20 } } });
    expect(results.map((d) => d.id).sort()).toEqual(['p2', 'p3']);

    await db.close();
  });

  it('should list indexed fields after drop via REST-style index endpoint flow', async () => {
    let db = await SimpleDBMS.create(dbFile, walFile, heapFile, heapWalFile);
    let collection = await db.createCollection('orders');

    await collection.insert({ id: 'o1', status: 'pending', amount: 100 });
    await collection.insert({ id: 'o2', status: 'shipped', amount: 200 });

    // Both 'status' and 'amount' were auto-indexed
    const before = collection.getIndexedFields();
    expect(before).toContain('status');
    expect(before).toContain('amount');

    await collection.dropIndex('status');
    const after = collection.getIndexedFields();
    expect(after).not.toContain('status');
    expect(after).toContain('amount');

    await db.close();

    db = await SimpleDBMS.open(dbFile, walFile, heapFile, heapWalFile);
    collection = await db.getCollection('orders');

    const reopened = collection.getIndexedFields();
    expect(reopened).not.toContain('status');
    expect(reopened).toContain('amount');

    await db.close();
  });

  // --- getCollectionNames ---

  it('should list collection names', async () => {
    const db = await SimpleDBMS.create(dbFile, walFile, heapFile, heapWalFile);
    await db.createCollection('alpha');
    await db.createCollection('beta');

    const names = await db.getCollectionNames();
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
    await db.close();
  });

  // --- createCollection duplicate ---

  it('should throw when creating a duplicate collection', async () => {
    const db = await SimpleDBMS.create(dbFile, walFile, heapFile, heapWalFile);
    await db.createCollection('unique');
    await expect(db.createCollection('unique')).rejects.toThrow('already exists');
    await db.close();
  });

  // --- join ---

  it('should inner join two collections', async () => {
    const db = await SimpleDBMS.create(dbFile, walFile, heapFile, heapWalFile);
    const employees = await db.createCollection('employees');
    const departments = await db.createCollection('departments');

    await employees.insert({ id: 'e1', name: 'Alice', deptId: 'd1' });
    await employees.insert({ id: 'e2', name: 'Bob', deptId: 'd2' });
    await employees.insert({ id: 'e3', name: 'Charlie', deptId: 'd1' });

    await departments.insert({ id: 'd1', deptName: 'Engineering' });
    await departments.insert({ id: 'd2', deptName: 'Marketing' });

    const results = await db.join({
      leftCollection: 'employees',
      rightCollection: 'departments',
      on: 'deptId',
      rightOn: 'id',
    });

    expect(results).toHaveLength(3);
    const alice = results.find((r) => r['name'] === 'Alice');
    expect(alice).toBeDefined();
    expect(alice!['deptName']).toBe('Engineering');
    await db.close();
  });

  it('should left join with unmatched left rows', async () => {
    const db = await SimpleDBMS.create(dbFile, walFile, heapFile, heapWalFile);
    const orders = await db.createCollection('orders');
    const customers = await db.createCollection('customers');

    await orders.insert({ id: 'o1', custId: 'c1', total: 100 });
    await orders.insert({ id: 'o2', custId: 'c99', total: 200 }); // no matching customer

    await customers.insert({ id: 'c1', custName: 'Alice' });

    const results = await db.join({
      leftCollection: 'orders',
      rightCollection: 'customers',
      on: 'custId',
      rightOn: 'id',
      type: 'left',
    });

    expect(results).toHaveLength(2);
    const unmatched = results.find((r) => r.id === 'o2');
    expect(unmatched).toBeDefined();
    // Left join: unmatched rows are included without right-side fields
    expect(unmatched!['custName']).toBeUndefined();
    await db.close();
  });

  it('should prefix colliding fields during join', async () => {
    const db = await SimpleDBMS.create(dbFile, walFile, heapFile, heapWalFile);
    const left = await db.createCollection('left');
    const right = await db.createCollection('right');

    await left.insert({ id: 'l1', key: 'k1', name: 'LeftName' });
    await right.insert({ id: 'r1', key: 'k1', name: 'RightName' });

    const results = await db.join({
      leftCollection: 'left',
      rightCollection: 'right',
      on: 'key',
      rightOn: 'key',
    });

    expect(results).toHaveLength(1);
    expect(results[0]['name']).toBe('LeftName');
    expect(results[0]['right_name']).toBe('RightName');
    await db.close();
  });
});

describe('HNSW functionalities', () => {
  let db: SimpleDBMS;
  let collection: Collection;
  let dbFile: MockFile;
  let walFile: MockFile;
  let heapFile: MockFile;
  let heapWalFile: MockFile;
  let hnswFile: MockFile;
  let hnswWalFile: MockFile;
  let hnswTreeFile: MockFile;
  let hnswTreeWalFile: MockFile;
  let diskStorageWalFile: MockFile;

  beforeEach(async () => {
    dbFile = new MockFile(512);
    walFile = new MockFile(512);
    heapFile = new MockFile(512);
    heapWalFile = new MockFile(512);
    hnswFile = new MockFile(512);
    hnswWalFile = new MockFile(512);
    hnswTreeFile = new MockFile(512);
    hnswTreeWalFile = new MockFile(512);
    diskStorageWalFile = new MockFile(512);

    db = await SimpleDBMS.create(
      dbFile,
      walFile,
      heapFile,
      heapWalFile,
      hnswFile,
      hnswWalFile,
      hnswTreeFile,
      hnswTreeWalFile,
      diskStorageWalFile,
    );
    collection = await db.createCollection('users');
  }, 60000);

  it('search works properly', async () => {
    await collection.insert({ txt: 'driekantpezium', id: 'a' });
    await collection.insert({ txt: 'test2', id: 'b' });
    await collection.insert({ txt: 'test3', id: 'c' });
    await collection.insert({ txt: 'test4', id: 'd' });
    await collection.insert({ txt: 'test5', id: 'e' });

    const nbest: string[] = (await collection.hnswSearch('parallellopruit', 5)) as string[];
    expect(nbest.length).toEqual(5);
  }, 60000);
});

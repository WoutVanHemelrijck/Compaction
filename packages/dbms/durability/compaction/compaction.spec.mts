// @author Wout Van Hemelrijck
// @date 2026-02-24

import { describe, it, expect, beforeEach } from 'vitest';
import { SimpleDBMS } from '../../core/simpledbms.mjs';
import { MockFile } from '../../storage/file/mockfile.mjs';
import { compactDatabase, shrinkDatabase } from './compaction.mjs';
import { FBNodeStorage } from '../../storage/node-storage/fb-node-storage.mjs';

describe('Database Compaction & Shrink', () => {
  let dbFile: MockFile;
  let walFile: MockFile;

  beforeEach(() => {
    dbFile = new MockFile(512);
    walFile = new MockFile(512);
  });

  describe('compactDatabase (same-file mode)', () => {
    it('should compact an empty database', async () => {
      const db = await SimpleDBMS.create(dbFile, walFile);

      const { db: newDb, result } = await compactDatabase(db, dbFile, walFile);

      expect(result.success).toBe(true);
      expect(result.collectionsCompacted).toBe(0);
      expect(result.totalDocuments).toBe(0);

      await newDb.close();
    });

    it('should preserve all documents after compaction', async () => {
      let db = await SimpleDBMS.create(dbFile, walFile);
      const users = await db.createCollection('users');
      await users.insert({ id: 'u1', name: 'Alice', age: 30 });
      await users.insert({ id: 'u2', name: 'Bob', age: 25 });
      await users.insert({ id: 'u3', name: 'Charlie', age: 35 });

      const { db: newDb } = await compactDatabase(db, dbFile, walFile);
      db = newDb;

      const newUsers = await db.getCollection('users');

      const alice = await newUsers.findById('u1');
      expect(alice).toBeDefined();
      expect(alice!['name']).toBe('Alice');
      expect(alice!['age']).toBe(30);

      const bob = await newUsers.findById('u2');
      expect(bob).toBeDefined();
      expect(bob!['name']).toBe('Bob');

      const charlie = await newUsers.findById('u3');
      expect(charlie).toBeDefined();
      expect(charlie!['name']).toBe('Charlie');

      const all = await newUsers.find();
      expect(all).toHaveLength(3);

      await db.close();
    });

    it('should preserve multiple collections after compaction', async () => {
      let db = await SimpleDBMS.create(dbFile, walFile);

      const users = await db.createCollection('users');
      await users.insert({ id: 'u1', name: 'Alice' });

      const posts = await db.createCollection('posts');
      await posts.insert({ id: 'p1', title: 'Hello', userId: 'u1' });

      const { db: newDb } = await compactDatabase(db, dbFile, walFile);
      db = newDb;

      const newUsers = await db.getCollection('users');
      const newPosts = await db.getCollection('posts');

      expect(await newUsers.findById('u1')).toBeDefined();
      expect(await newPosts.findById('p1')).toBeDefined();

      const post = await newPosts.findById('p1');
      expect(post!['title']).toBe('Hello');

      await db.close();
    });

    it('should reduce file size after deletions', async () => {
      let db = await SimpleDBMS.create(dbFile, walFile);
      const users = await db.createCollection('users');

      // Insert many documents (>50 to exceed B+ tree order and force splits)
      for (let i = 0; i < 55; i++) {
        await users.insert({ id: `user-${i}`, name: `User ${i}`, data: 'x'.repeat(100) });
      }

      // Delete most of them to create free space
      for (let i = 10; i < 55; i++) {
        await users.delete(`user-${i}`);
      }

      const sizeBefore = (await dbFile.stat()).size;

      const { db: newDb, result } = await compactDatabase(db, dbFile, walFile);
      db = newDb;

      expect(result.success).toBe(true);
      expect(result.sizeBefore).toBe(sizeBefore);
      expect(result.sizeAfter).toBeLessThan(result.sizeBefore);

      // Verify remaining data is intact
      const newUsers = await db.getCollection('users');
      const remaining = await newUsers.find();
      expect(remaining).toHaveLength(10);

      for (let i = 0; i < 10; i++) {
        const user = await newUsers.findById(`user-${i}`);
        expect(user).toBeDefined();
        expect(user!['name']).toBe(`User ${i}`);
      }

      await db.close();
    });

    it('should allow normal operations after compaction', async () => {
      let db = await SimpleDBMS.create(dbFile, walFile);
      const users = await db.createCollection('users');
      await users.insert({ id: 'u1', name: 'Alice' });

      const { db: newDb } = await compactDatabase(db, dbFile, walFile);
      db = newDb;

      const newUsers = await db.getCollection('users');

      // Verify existing data survived compaction
      const alice = await newUsers.findById('u1');
      expect(alice).toBeDefined();
      expect(alice!['name']).toBe('Alice');

      // Insert new documents after compaction
      await newUsers.insert({ id: 'u2', name: 'Bob' });
      const bob = await newUsers.findById('u2');
      expect(bob).toBeDefined();
      expect(bob!['name']).toBe('Bob');

      // Update existing documents after compaction
      const updated = await newUsers.update('u1', { age: 31 });
      expect(updated).toBeDefined();
      expect(updated!['age']).toBe(31);

      // Delete a document after compaction
      const deleted = await newUsers.delete('u2');
      expect(deleted).toBe(true);
      const gone = await newUsers.findById('u2');
      expect(gone).toBeNull();

      await db.close();
    });

    it('should persist data across close/open after compaction', async () => {
      const db = await SimpleDBMS.create(dbFile, walFile);
      const users = await db.createCollection('users');
      await users.insert({ id: 'u1', name: 'Alice' });
      await users.insert({ id: 'u2', name: 'Bob' });

      const { db: compactedDb } = await compactDatabase(db, dbFile, walFile);
      await compactedDb.close();

      // Reopen the compacted database
      const reopened = await SimpleDBMS.open(dbFile, walFile);
      const reopenedUsers = await reopened.getCollection('users');

      expect(await reopenedUsers.findById('u1')).toBeDefined();
      expect(await reopenedUsers.findById('u2')).toBeDefined();
      expect((await reopenedUsers.findById('u1'))!['name']).toBe('Alice');

      await reopened.close();
    });
  });

  describe('compactDatabase (streaming with temp files)', () => {
    it('should stream documents to temp files without loading all into memory', async () => {
      let db = await SimpleDBMS.create(dbFile, walFile);
      const users = await db.createCollection('users');

      // Insert documents
      for (let i = 0; i < 20; i++) {
        await users.insert({ id: `user-${i}`, name: `User ${i}`, data: 'x'.repeat(50) });
      }

      // Delete half to create fragmentation
      for (let i = 10; i < 20; i++) {
        await users.delete(`user-${i}`);
      }

      const sizeBefore = (await dbFile.stat()).size;

      // Use separate temp files (streaming mode)
      const tempDbFile = new MockFile(512);
      const tempWalFile = new MockFile(512);

      const { db: newDb, result } = await compactDatabase(db, dbFile, walFile, tempDbFile, tempWalFile);
      db = newDb;

      expect(result.success).toBe(true);
      expect(result.sizeBefore).toBe(sizeBefore);
      expect(result.totalDocuments).toBe(10);
      expect(result.collectionsCompacted).toBe(1);

      // Verify data is in the new (temp) database
      const newUsers = await db.getCollection('users');
      const remaining = await newUsers.find();
      expect(remaining).toHaveLength(10);

      for (let i = 0; i < 10; i++) {
        const user = await newUsers.findById(`user-${i}`);
        expect(user).toBeDefined();
        expect(user!['name']).toBe(`User ${i}`);
      }

      await db.close();
    });

    it('should stream multiple collections with temp files', async () => {
      let db = await SimpleDBMS.create(dbFile, walFile);

      const users = await db.createCollection('users');
      await users.insert({ id: 'u1', name: 'Alice' });
      await users.insert({ id: 'u2', name: 'Bob' });

      const posts = await db.createCollection('posts');
      await posts.insert({ id: 'p1', title: 'Hello' });

      const tempDbFile = new MockFile(512);
      const tempWalFile = new MockFile(512);

      const { db: newDb, result } = await compactDatabase(db, dbFile, walFile, tempDbFile, tempWalFile);
      db = newDb;

      expect(result.collectionsCompacted).toBe(2);
      expect(result.totalDocuments).toBe(3);

      const newUsers = await db.getCollection('users');
      const newPosts = await db.getCollection('posts');

      expect(await newUsers.findById('u1')).toBeDefined();
      expect(await newUsers.findById('u2')).toBeDefined();
      expect(await newPosts.findById('p1')).toBeDefined();

      await db.close();
    });

    it('should reduce file size with streaming compaction', async () => {
      let db = await SimpleDBMS.create(dbFile, walFile);
      const users = await db.createCollection('users');

      // Insert many documents then delete most (>50 to exceed B+ tree order and force splits)
      for (let i = 0; i < 55; i++) {
        await users.insert({ id: `user-${i}`, name: `User ${i}`, data: 'x'.repeat(100) });
      }
      for (let i = 5; i < 55; i++) {
        await users.delete(`user-${i}`);
      }

      const tempDbFile = new MockFile(512);
      const tempWalFile = new MockFile(512);

      const { db: newDb, result } = await compactDatabase(db, dbFile, walFile, tempDbFile, tempWalFile);
      db = newDb;

      expect(result.sizeAfter).toBeLessThan(result.sizeBefore);

      const newUsers = await db.getCollection('users');
      expect(await newUsers.find()).toHaveLength(5);

      await db.close();
    });
  });

  describe('Collection.entries()', () => {
    it('should stream documents lazily', async () => {
      const db = await SimpleDBMS.create(dbFile, walFile);
      const users = await db.createCollection('users');
      await users.insert({ id: 'u1', name: 'Alice' });
      await users.insert({ id: 'u2', name: 'Bob' });
      await users.insert({ id: 'u3', name: 'Charlie' });

      const docs: string[] = [];
      for await (const { key, value } of users.entries()) {
        docs.push(key);
        expect(value).toBeDefined();
        expect(value.id).toBe(key);
      }

      expect(docs).toHaveLength(3);
      expect(docs).toContain('u1');
      expect(docs).toContain('u2');
      expect(docs).toContain('u3');

      await db.close();
    });
  });

  describe('getCollectionNames', () => {
    it('should return empty array for new database', async () => {
      const db = await SimpleDBMS.create(dbFile, walFile);
      const names = await db.getCollectionNames();
      expect(names).toHaveLength(0);
      await db.close();
    });

    it('should return all collection names', async () => {
      const db = await SimpleDBMS.create(dbFile, walFile);
      await db.createCollection('users');
      await db.createCollection('posts');
      await db.createCollection('comments');

      const names = await db.getCollectionNames();
      expect(names).toHaveLength(3);
      expect(names).toContain('users');
      expect(names).toContain('posts');
      expect(names).toContain('comments');

      await db.close();
    });
  });

  describe('shrinkDatabase', () => {
    it('should be a no-op on an empty database', async () => {
      const db = await SimpleDBMS.create(dbFile, walFile);
      const fbf = db.getFreeBlockFile();

      const result = await shrinkDatabase(fbf);

      expect(result.success).toBe(true);
      expect(result.blocksRelocated).toBe(0);

      await db.close();
    });

    it('should handle a database with no deletions', async () => {
      let db = await SimpleDBMS.create(dbFile, walFile);
      const users = await db.createCollection('users');
      await users.insert({ id: 'u1', name: 'Alice' });

      const fbf = db.getFreeBlockFile();
      const result = await shrinkDatabase(fbf);

      expect(result.success).toBe(true);

      // Close and reopen to verify integrity
      await db.close();
      db = await SimpleDBMS.open(dbFile, walFile);
      const newUsers = await db.getCollection('users');
      const alice = await newUsers.findById('u1');
      expect(alice).toBeDefined();
      expect(alice!['name']).toBe('Alice');

      await db.close();
    });

    it('should shrink the file after deletions and preserve remaining data', async () => {
      let db = await SimpleDBMS.create(dbFile, walFile);
      const users = await db.createCollection('users');

      // Insert more than B+ tree order (50) to force splits
      for (let i = 0; i < 55; i++) {
        await users.insert({ id: `user-${i}`, name: `User ${i}`, data: 'x'.repeat(50) });
      }

      // Delete most documents to create free space
      for (let i = 10; i < 55; i++) {
        await users.delete(`user-${i}`);
      }

      const sizeBefore = (await dbFile.stat()).size;
      const fbf = db.getFreeBlockFile();

      const result = await shrinkDatabase(fbf);

      expect(result.success).toBe(true);
      expect(result.sizeAfter).toBeLessThan(sizeBefore);
      expect(result.blocksFree).toBeGreaterThan(0);

      // Close and reopen to verify data integrity
      await db.close();
      db = await SimpleDBMS.open(dbFile, walFile);

      const newUsers = await db.getCollection('users');
      const remaining = await newUsers.find();
      expect(remaining).toHaveLength(10);

      for (let i = 0; i < 10; i++) {
        const user = await newUsers.findById(`user-${i}`);
        expect(user).toBeDefined();
        expect(user!['name']).toBe(`User ${i}`);
      }

      await db.close();
    });

    it('should preserve multiple collections after shrink', async () => {
      let db = await SimpleDBMS.create(dbFile, walFile);

      const users = await db.createCollection('users');
      await users.insert({ id: 'u1', name: 'Alice' });
      await users.insert({ id: 'u2', name: 'Bob' });

      const posts = await db.createCollection('posts');
      await posts.insert({ id: 'p1', title: 'Hello' });
      await posts.insert({ id: 'p2', title: 'World' });

      // Delete some to create fragmentation
      await users.delete('u2');
      await posts.delete('p2');

      const fbf = db.getFreeBlockFile();
      const result = await shrinkDatabase(fbf);
      expect(result.success).toBe(true);

      // Close and reopen
      await db.close();
      db = await SimpleDBMS.open(dbFile, walFile);

      const newUsers = await db.getCollection('users');
      const newPosts = await db.getCollection('posts');

      expect(await newUsers.findById('u1')).toBeDefined();
      expect((await newUsers.findById('u1'))!['name']).toBe('Alice');
      expect(await newPosts.findById('p1')).toBeDefined();
      expect((await newPosts.findById('p1'))!['title']).toBe('Hello');

      await db.close();
    });

    it('should preserve secondary indexes after shrink', async () => {
      let db = await SimpleDBMS.create(dbFile, walFile);
      const users = await db.createCollection('users');
      users.setAutoCreateSecondaryIndexesOnInsert(false);

      for (let i = 0; i < 10; i++) {
        await users.insert({ id: `user-${i}`, name: `User ${i}`, age: 20 + i });
      }

      // Create a secondary index
      const indexStorage = new FBNodeStorage<string, number>(
        (a, b) => (a < b ? -1 : a > b ? 1 : 0),
        () => 1024,
        db.getFreeBlockFile(),
        4096,
      );
      await users.createIndex('name', indexStorage);

      // Delete some to create free space
      for (let i = 5; i < 10; i++) {
        await users.delete(`user-${i}`);
      }

      const fbf = db.getFreeBlockFile();
      const result = await shrinkDatabase(fbf);
      expect(result.success).toBe(true);

      // Close and reopen
      await db.close();
      db = await SimpleDBMS.open(dbFile, walFile);

      const newUsers = await db.getCollection('users');
      const remaining = await newUsers.find();
      expect(remaining).toHaveLength(5);

      for (let i = 0; i < 5; i++) {
        const user = await newUsers.findById(`user-${i}`);
        expect(user).toBeDefined();
        expect(user!['name']).toBe(`User ${i}`);
      }

      await db.close();
    });

    it('should persist data across close/reopen after shrink', async () => {
      let db = await SimpleDBMS.create(dbFile, walFile);
      const users = await db.createCollection('users');
      await users.insert({ id: 'u1', name: 'Alice' });
      await users.insert({ id: 'u2', name: 'Bob' });
      await users.insert({ id: 'u3', name: 'Charlie' });

      // Delete one to create fragmentation
      await users.delete('u2');

      const fbf = db.getFreeBlockFile();
      await shrinkDatabase(fbf);

      await db.close();

      // Reopen and verify
      db = await SimpleDBMS.open(dbFile, walFile);
      const reopenedUsers = await db.getCollection('users');

      expect(await reopenedUsers.findById('u1')).toBeDefined();
      expect((await reopenedUsers.findById('u1'))!['name']).toBe('Alice');
      expect(await reopenedUsers.findById('u3')).toBeDefined();
      expect((await reopenedUsers.findById('u3'))!['name']).toBe('Charlie');
      expect(await reopenedUsers.findById('u2')).toBeNull();

      await db.close();
    });

    it('should allow normal operations after shrink', async () => {
      let db = await SimpleDBMS.create(dbFile, walFile);
      const users = await db.createCollection('users');
      await users.insert({ id: 'u1', name: 'Alice' });
      await users.insert({ id: 'u2', name: 'Bob' });

      // Delete to create fragmentation
      await users.delete('u2');

      const fbf = db.getFreeBlockFile();
      await shrinkDatabase(fbf);

      // Close and reopen (required after shrink)
      await db.close();
      db = await SimpleDBMS.open(dbFile, walFile);

      const newUsers = await db.getCollection('users');

      // Verify existing data
      const alice = await newUsers.findById('u1');
      expect(alice).toBeDefined();
      expect(alice!['name']).toBe('Alice');

      // Insert new documents
      await newUsers.insert({ id: 'u3', name: 'Charlie' });
      const charlie = await newUsers.findById('u3');
      expect(charlie).toBeDefined();
      expect(charlie!['name']).toBe('Charlie');

      // Update existing documents
      const updated = await newUsers.update('u1', { age: 31 });
      expect(updated).toBeDefined();
      expect(updated!['age']).toBe(31);

      // Delete a document
      const deleted = await newUsers.delete('u3');
      expect(deleted).toBe(true);
      expect(await newUsers.findById('u3')).toBeNull();

      await db.close();
    });
  });
});

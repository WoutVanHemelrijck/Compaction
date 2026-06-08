// @author Tijn Gommers
// @date 2026-04-20

import { beforeEach, describe, expect, it } from 'vitest';
import { MockFile } from '../../../dbms/storage/file/mockfile.mjs';
import { SimpleDBMS } from '../../../dbms/core/simpledbms.mjs';
import { SimpleDBMSStorageAdapter } from '../../storage-adapter/simpledbms-storage-adapter.mjs';
import type { Document } from '../../../dbms/core/simpledbms.mjs';
import type { StoragePredicate, StorageRow } from '../../storage-adapter/storage-adapter-types.mjs';

describe('SimpleDBMSStorageAdapter', () => {
  let dbFile: MockFile;
  let walFile: MockFile;
  let heapFile: MockFile;
  let heapWalFile: MockFile;
  let db: SimpleDBMS;
  let adapter: SimpleDBMSStorageAdapter;

  beforeEach(async () => {
    dbFile = new MockFile(512);
    walFile = new MockFile(512);
    heapFile = new MockFile(512);
    heapWalFile = new MockFile(512);
    db = await SimpleDBMS.create(dbFile, walFile, heapFile, heapWalFile);
    adapter = new SimpleDBMSStorageAdapter(db);
    await db.createCollection('users');
  });

  async function seedUsers(docs: Array<Omit<Document, 'id'> & { id: string }>): Promise<void> {
    const users = await db.getCollection('users');
    for (const doc of docs) {
      await users.insert(doc);
    }
  }

  async function userCount(): Promise<number> {
    const users = await db.getCollection('users');
    return users.countDocuments();
  }

  function byId(rows: StorageRow[]): StorageRow[] {
    const toSortableId = (id: StorageRow['ID']): string => {
      if (typeof id === 'string' || typeof id === 'number' || typeof id === 'boolean' || id === null) {
        return String(id);
      }

      return JSON.stringify(id);
    };

    return [...rows].sort((a, b) => toSortableId(a['ID']).localeCompare(toSortableId(b['ID'])));
  }

  describe('read()', () => {
    it('should read wildcard rows and normalize keys to uppercase including ID', async () => {
      await seedUsers([
        { id: 'u1', name: 'Alice', age: 30, active: true },
        { id: 'u2', name: 'Bob', age: 19, active: false },
      ]);

      const rows = byId(await adapter.read('users', ['*']));

      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({ ID: 'u1', NAME: 'Alice', AGE: 30, ACTIVE: true });
      expect(rows[1]).toEqual({ ID: 'u2', NAME: 'Bob', AGE: 19, ACTIVE: false });
    });

    it('should read with projection and comparison predicate', async () => {
      await seedUsers([
        { id: 'u1', name: 'Alice', age: 30 },
        { id: 'u2', name: 'Bob', age: 18 },
      ]);

      const where: StoragePredicate = {
        type: 'ComparisonExpression',
        operator: '>',
        left: 'AGE',
        right: 20,
      };

      const rows = await adapter.read('USERS', ['NAME'], where);
      expect(rows).toEqual([{ ID: 'u1', NAME: 'Alice' }]);
    });

    it('should keep stable output when projecting missing fields', async () => {
      await seedUsers([{ id: 'u1', name: 'Alice' }]);

      const rows = await adapter.read('users', ['MISSING'], undefined);
      expect(rows).toEqual([{ ID: 'u1' }]);
    });

    it('should treat missing and null fields as nullish in NullCheckExpression', async () => {
      await seedUsers([
        { id: 'u1', name: 'A', city: null },
        { id: 'u2', name: 'B' },
        { id: 'u3', name: 'C', city: 'AMS' },
      ]);

      const rows = await adapter.read('users', ['ID'], {
        type: 'NullCheckExpression',
        column: 'CITY',
        isNegated: false,
      });

      expect(rows.map((r) => r['ID']).sort()).toEqual(['u1', 'u2']);
    });

    it('should support arithmetic expressions in read predicates', async () => {
      await seedUsers([
        { id: 'u1', age: 30 },
        { id: 'u2', age: 20 },
      ]);

      const rows = await adapter.read('users', ['ID'], {
        type: 'ComparisonExpression',
        operator: '=',
        left: {
          type: 'ArithmeticExpression',
          operator: '+',
          left: 'AGE',
          right: 1,
        },
        right: 31,
      });

      expect(rows).toEqual([{ ID: 'u1' }]);
    });

    it('should surface storage-layer bigint serialization errors during insert setup', async () => {
      await expect(
        seedUsers([
          {
            id: 'u1',
            balance: BigInt('9007199254740993123456789'),
          },
        ]),
      ).rejects.toThrow('Do not know how to serialize a BigInt');
    });

    it('should return empty array for empty collection', async () => {
      const rows = await adapter.read('users', ['*']);
      expect(rows).toEqual([]);
    });
  });

  describe('write()', () => {
    it('should write one row and persist lowercase field names internally', async () => {
      await adapter.write('users', [{ ID: 'u1', NAME: 'Alice', AGE: 30 }]);

      const users = await db.getCollection('users');
      const doc = await users.findById('u1');

      expect(doc).toBeDefined();
      expect(doc!['name']).toBe('Alice');
      expect(doc!['age']).toBe(30);
      expect((doc as Record<string, unknown>)['NAME']).toBeUndefined();
    });

    it('should generate an id when the row does not provide one', async () => {
      await adapter.write('users', [{ NAME: 'Alice', AGE: 30 } as StorageRow]);

      const rows = await adapter.read('users', ['*']);

      expect(rows).toHaveLength(1);
      expect(rows[0]['ID']).toBeDefined();
      expect(rows[0]['ID']).not.toBe('');
      expect(rows[0]['NAME']).toBe('Alice');
      expect(rows[0]['AGE']).toBe(30);
    });

    it('should write multiple rows in one call', async () => {
      await adapter.write('users', [
        { ID: 'u1', NAME: 'Alice' },
        { ID: 'u2', NAME: 'Bob' },
        { ID: 'u3', NAME: 'Cara' },
      ]);

      expect(await userCount()).toBe(3);
    });

    it('should support nested objects and arrays', async () => {
      await adapter.write('users', [
        {
          ID: 'u1',
          PROFILE: { CITY: 'AMS', STATS: { LEVEL: 4 } },
          TAGS: ['a', 'b'],
        },
      ]);

      const rows = await adapter.read('users', ['*']);
      expect(rows[0]['PROFILE']).toEqual({ CITY: 'AMS', STATS: { LEVEL: 4 } });
      expect(rows[0]['TAGS']).toEqual(['a', 'b']);
    });

    it('should treat empty write payload as a no-op', async () => {
      await seedUsers([{ id: 'u1', name: 'Alice' }]);
      await adapter.write('users', []);
      expect(await userCount()).toBe(1);
    });

    it('should reject bigint payloads on write when storage cannot serialize bigint', async () => {
      await expect(
        adapter.write('users', [{ ID: 'u1', SCORE: BigInt(99) as unknown as number } as unknown as StorageRow]),
      ).rejects.toThrow('Do not know how to serialize a BigInt');
    });
  });

  describe('filter()', () => {
    it('should filter using all comparison operators on numeric and string values', async () => {
      await seedUsers([
        { id: 'u1', age: 10, name: 'ALICE' },
        { id: 'u2', age: 20, name: 'BOB' },
      ]);

      expect(
        (
          await adapter.filter('users', {
            type: 'ComparisonExpression',
            operator: '>',
            left: 'AGE',
            right: 10,
          })
        ).map((r) => r['ID']),
      ).toEqual(['u2']);

      expect(
        (
          await adapter.filter('users', {
            type: 'ComparisonExpression',
            operator: '<=',
            left: 'NAME',
            right: 'ALICE',
          })
        ).map((r) => r['ID']),
      ).toEqual(['u1']);

      expect(
        (
          await adapter.filter('users', {
            type: 'ComparisonExpression',
            operator: '!=',
            left: 'ID',
            right: 'u1',
          })
        ).map((r) => r['ID']),
      ).toEqual(['u2']);
    });

    it('should support logical AND/OR and NOT expressions', async () => {
      await seedUsers([
        { id: 'u1', age: 30, active: 1 },
        { id: 'u2', age: 30, active: 0 },
        { id: 'u3', age: 10, active: 0 },
      ]);

      const rows = await adapter.filter('users', {
        type: 'LogicalExpression',
        operator: 'AND',
        left: {
          type: 'NotExpression',
          operator: 'NOT',
          expression: {
            type: 'ComparisonExpression',
            operator: '=',
            left: 'ACTIVE',
            right: 1,
          },
        },
        right: {
          type: 'ComparisonExpression',
          operator: '>=',
          left: 'AGE',
          right: 18,
        },
      });

      expect(rows).toEqual([{ ID: 'u2', AGE: 30, ACTIVE: 0 }]);
    });

    it('should support IN predicates', async () => {
      await seedUsers([
        { id: 'u1', age: 30 },
        { id: 'u2', age: 20 },
        { id: 'u3', age: 10 },
      ]);

      const rows = await adapter.filter('users', {
        type: 'InExpression',
        column: 'ID',
        values: ['u1', 'u3'],
      });

      expect(rows.map((r) => r['ID']).sort()).toEqual(['u1', 'u3']);
    });

    it('should return no rows for mixed-type comparison mismatches', async () => {
      await seedUsers([{ id: 'u1', age: 30 }]);

      const rows = await adapter.filter('users', {
        type: 'ComparisonExpression',
        operator: '>',
        left: 'AGE',
        right: '20' as unknown as number,
      });

      expect(rows).toEqual([]);
    });

    it('should throw for invalid arithmetic operands', async () => {
      await seedUsers([{ id: 'u1', age: 'thirty' as unknown as number }]);

      await expect(
        adapter.filter('users', {
          type: 'ComparisonExpression',
          operator: '=',
          left: {
            type: 'ArithmeticExpression',
            operator: '+',
            left: 'AGE',
            right: 1,
          },
          right: 31,
        }),
      ).rejects.toThrow('Invalid arithmetic operands');
    });

    it('should throw on division by zero', async () => {
      await seedUsers([{ id: 'u1', age: 10 }]);

      await expect(
        adapter.filter('users', {
          type: 'ComparisonExpression',
          operator: '=',
          left: {
            type: 'ArithmeticExpression',
            operator: '/',
            left: 'AGE',
            right: 0,
          },
          right: 2,
        }),
      ).rejects.toThrow('Division by zero');
    });

    it('should return empty on unknown fields', async () => {
      await seedUsers([{ id: 'u1', age: 10 }]);

      const rows = await adapter.filter('users', {
        type: 'ComparisonExpression',
        operator: '=',
        left: 'UNKNOWN_FIELD',
        right: 1,
      });

      expect(rows).toEqual([]);
    });
  });

  describe('project()', () => {
    it('should project selected columns and always include ID', async () => {
      await seedUsers([{ id: 'u1', name: 'Alice', age: 30 }]);

      const rows = await adapter.project('users', ['NAME']);
      expect(rows).toEqual([{ ID: 'u1', NAME: 'Alice' }]);
    });

    it('should support wildcard projection', async () => {
      await seedUsers([{ id: 'u1', name: 'Alice', age: 30 }]);

      const rows = await adapter.project('users', ['*']);
      expect(rows).toEqual([{ ID: 'u1', NAME: 'Alice', AGE: 30 }]);
    });

    it('should return only ID when projecting absent fields', async () => {
      await seedUsers([{ id: 'u1', name: 'Alice' }]);

      const rows = await adapter.project('users', ['NOT_THERE']);
      expect(rows).toEqual([{ ID: 'u1' }]);
    });

    it('should return empty array when projecting empty dataset', async () => {
      const rows = await adapter.project('users', ['NAME']);
      expect(rows).toEqual([]);
    });
  });

  describe('update()', () => {
    it('should update only rows matching where predicate', async () => {
      await seedUsers([
        { id: 'u1', status: 'INACTIVE' },
        { id: 'u2', status: 'INACTIVE' },
      ]);

      await adapter.update(
        'users',
        { STATUS: 'ACTIVE' },
        {
          type: 'ComparisonExpression',
          operator: '=',
          left: 'ID',
          right: 'u1',
        },
      );

      const rows = byId(await adapter.read('users', ['*']));
      expect(rows).toEqual([
        { ID: 'u1', STATUS: 'ACTIVE' },
        { ID: 'u2', STATUS: 'INACTIVE' },
      ]);
    });

    it('should update all rows when where is undefined', async () => {
      await seedUsers([
        { id: 'u1', active: false },
        { id: 'u2', active: false },
      ]);

      await adapter.update('users', { ACTIVE: true }, undefined);

      const rows = byId(await adapter.read('users', ['*']));
      expect(rows).toEqual([
        { ID: 'u1', ACTIVE: true },
        { ID: 'u2', ACTIVE: true },
      ]);
    });

    it('should be a no-op when update predicate matches no rows', async () => {
      await seedUsers([{ id: 'u1', active: false }]);

      await adapter.update(
        'users',
        { ACTIVE: true },
        {
          type: 'ComparisonExpression',
          operator: '=',
          left: 'ID',
          right: 'missing',
        },
      );

      const rows = await adapter.read('users', ['*']);
      expect(rows).toEqual([{ ID: 'u1', ACTIVE: false }]);
    });

    it('should keep real document id unchanged when updating ID in set payload', async () => {
      await seedUsers([{ id: 'u1', name: 'Alice' }]);

      await adapter.update(
        'users',
        { ID: 'u999' },
        {
          type: 'ComparisonExpression',
          operator: '=',
          left: 'ID',
          right: 'u1',
        },
      );

      const users = await db.getCollection('users');
      const foundOriginal = await users.findById('u1');
      const foundNew = await users.findById('u999');

      expect(foundOriginal).toBeDefined();
      expect(foundNew).toBeNull();
    });

    it('should normalize identifier references to lowercase field names in update payload', async () => {
      await seedUsers([{ id: 'u1', age: 42 }]);

      await adapter.update(
        'users',
        {
          COPY_AGE: { type: 'Identifier', name: 'AGE' },
        },
        {
          type: 'ComparisonExpression',
          operator: '=',
          left: 'ID',
          right: 'u1',
        },
      );

      const users = await db.getCollection('users');
      const found = await users.findById('u1');

      expect(found).toBeDefined();
      expect(found!['copy_age']).toBe(42);
    });

    it('should reject bigint updates when storage cannot serialize bigint', async () => {
      await seedUsers([{ id: 'u1', score: 1 }]);

      await expect(
        adapter.update(
          'users',
          { SCORE: BigInt(7) as unknown as number },
          {
            type: 'ComparisonExpression',
            operator: '=',
            left: 'ID',
            right: 'u1',
          },
        ),
      ).rejects.toThrow('Do not know how to serialize a BigInt');
    });
  });

  describe('delete()', () => {
    it('should delete rows matching a where predicate', async () => {
      await seedUsers([
        { id: 'u1', age: 30 },
        { id: 'u2', age: 20 },
      ]);

      await adapter.delete('users', {
        type: 'ComparisonExpression',
        operator: '=',
        left: 'ID',
        right: 'u2',
      });

      const rows = await adapter.read('users', ['*']);
      expect(rows).toEqual([{ ID: 'u1', AGE: 30 }]);
    });

    it('should delete all rows when where is undefined', async () => {
      await seedUsers([
        { id: 'u1', age: 30 },
        { id: 'u2', age: 20 },
      ]);

      await adapter.delete('users', undefined);

      const rows = await adapter.read('users', ['*']);
      expect(rows).toEqual([]);
    });

    it('should be a no-op when delete predicate matches no rows', async () => {
      await seedUsers([{ id: 'u1', age: 30 }]);

      await adapter.delete('users', {
        type: 'ComparisonExpression',
        operator: '=',
        left: 'ID',
        right: 'missing',
      });

      const rows = await adapter.read('users', ['*']);
      expect(rows).toEqual([{ ID: 'u1', AGE: 30 }]);
    });

    it('should not fail deleting from empty collection', async () => {
      await adapter.delete('users', undefined);
      expect(await userCount()).toBe(0);
    });
  });

  describe('cross-method invariants', () => {
    it('should preserve semantic row values across write -> read', async () => {
      await adapter.write('users', [
        {
          ID: 'u1',
          NAME: 'Alice',
          ACTIVE: true,
          PROFILE: { CITY: 'AMS' },
          TAGS: ['A', 'B'],
        },
      ]);

      const rows = await adapter.read('users', ['*']);
      expect(rows).toEqual([
        {
          ID: 'u1',
          NAME: 'Alice',
          ACTIVE: true,
          PROFILE: { CITY: 'AMS' },
          TAGS: ['A', 'B'],
        },
      ]);
    });

    it('should remain consistent after update then delete sequence', async () => {
      await seedUsers([
        { id: 'u1', status: 'A' },
        { id: 'u2', status: 'A' },
      ]);

      await adapter.update(
        'users',
        { STATUS: 'B' },
        {
          type: 'ComparisonExpression',
          operator: '=',
          left: 'ID',
          right: 'u2',
        },
      );

      await adapter.delete('users', {
        type: 'ComparisonExpression',
        operator: '=',
        left: 'STATUS',
        right: 'A',
      });

      const rows = await adapter.read('users', ['*']);
      expect(rows).toEqual([{ ID: 'u2', STATUS: 'B' }]);
    });
  });

  describe('bug-hunting edge cases (may fail intentionally)', () => {
    it('should distinguish string literal operands from identifier operands', async () => {
      await seedUsers([
        { id: 'u1', value: 'age', age: 30 },
        { id: 'u2', value: 'other', age: 40 },
      ]);

      const rows = await adapter.filter('users', {
        type: 'ComparisonExpression',
        operator: '=',
        left: 'VALUE',
        right: { type: 'Literal', value: 'age' },
      });

      expect(rows.map((r) => r['ID']).sort()).toEqual(['u1']);
    });

    it('BUG-HUNT should copy value for identifier reference update semantics', async () => {
      await seedUsers([{ id: 'u1', age: 32 }]);

      await adapter.update(
        'users',
        {
          COPY_AGE: { type: 'Identifier', name: 'AGE' },
        },
        {
          type: 'ComparisonExpression',
          operator: '=',
          left: 'ID',
          right: 'u1',
        },
      );

      const rows = await adapter.read('users', ['*']);
      expect(rows).toEqual([{ ID: 'u1', AGE: 32, COPY_AGE: 32 }]);
    });
  });
});

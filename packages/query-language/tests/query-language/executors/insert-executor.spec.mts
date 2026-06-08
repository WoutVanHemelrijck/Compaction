//@author Tijn Gommers
// @date 2026-03-31

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InsertExecutor } from '../../../src/executors/insert.mjs';
import type { InsertStatement } from '../../../src/types/index.mjs';
import type { StorageAdapter } from '../../../storage-adapter/storage-adapter.mjs';

describe('InsertExecutor', () => {
  let insertExecutor: InsertExecutor;

  beforeEach(() => {
    insertExecutor = new InsertExecutor();
  });

  it('should execute INSERT with a single row', async () => {
    const node: InsertStatement = {
      type: 'InsertStatement',
      table: { type: 'Table', name: 'USERS' },
      columns: [
        { type: 'Identifier', name: 'ID' },
        { type: 'Identifier', name: 'NAME' },
      ],
      values: [
        [
          { type: 'Literal', valueType: 'number', value: 1 },
          { type: 'Literal', valueType: 'string', value: 'Alice' },
        ],
      ],
    };

    const result = await Promise.resolve(insertExecutor.executeInsert(node));

    expect(result.type).toBe('InsertResult');
    expect(result.insertedCount).toBe(1);
    expect(result.rows).toEqual([{ ID: 1, NAME: 'Alice' }]);
  });

  it('should execute INSERT with multiple rows', async () => {
    const node: InsertStatement = {
      type: 'InsertStatement',
      table: { type: 'Table', name: 'USERS' },
      columns: [
        { type: 'Identifier', name: 'ID' },
        { type: 'Identifier', name: 'NAME' },
      ],
      values: [
        [
          { type: 'Literal', valueType: 'number', value: 1 },
          { type: 'Literal', valueType: 'string', value: 'Alice' },
        ],
        [
          { type: 'Literal', valueType: 'number', value: 2 },
          { type: 'Literal', valueType: 'string', value: 'Bob' },
        ],
      ],
    };

    const result = await Promise.resolve(insertExecutor.executeInsert(node));

    expect(result.insertedCount).toBe(2);
    expect(result.rows).toEqual([
      { ID: 1, NAME: 'Alice' },
      { ID: 2, NAME: 'Bob' },
    ]);
  });

  it('should append inserted rows to provided inputRows', async () => {
    const existingRows = [{ ID: 99, NAME: 'Existing' }];

    const node: InsertStatement = {
      type: 'InsertStatement',
      table: { type: 'Table', name: 'USERS' },
      columns: [{ type: 'Identifier', name: 'ID' }],
      values: [[{ type: 'Literal', valueType: 'number', value: 1 }]],
    };

    await Promise.resolve(insertExecutor.executeInsert(node, existingRows));

    expect(existingRows).toEqual([{ ID: 99, NAME: 'Existing' }, { ID: 1 }]);
  });

  it('should write inserted rows through the storage adapter', async () => {
    const write = vi.fn(() => Promise.resolve());
    const adapter: StorageAdapter = {
      read: () => Promise.resolve([]),
      write,
      filter: () => Promise.resolve([]),
      project: () => Promise.resolve([]),
      delete: () => Promise.resolve(),
      update: () => Promise.resolve(),
    };

    const adapterInsertExecutor = new InsertExecutor(adapter);
    const node: InsertStatement = {
      type: 'InsertStatement',
      table: { type: 'Table', name: 'USERS' },
      columns: [{ type: 'Identifier', name: 'ID' }],
      values: [[{ type: 'Literal', valueType: 'number', value: 42 }]],
    };

    const result = await adapterInsertExecutor.executeInsert(node);

    expect(write).toHaveBeenCalledWith('USERS', [{ ID: 42 }], [], 'NO_USER');
    expect(result.rows).toEqual([{ ID: 42 }]);
    expect(result.insertedCount).toBe(1);
  });

  it('should throw for missing columns', () => {
    const node = {
      type: 'InsertStatement',
      table: { type: 'Table', name: 'USERS' },
      columns: [],
      values: [[{ type: 'Literal', valueType: 'number', value: 1 }]],
    } as unknown as InsertStatement;

    expect(() => insertExecutor.executeInsert(node)).toThrow('Invalid INSERT: no columns specified');
  });

  it('should throw for missing table', () => {
    const node = {
      type: 'InsertStatement',
      table: undefined,
      columns: [{ type: 'Identifier', name: 'ID' }],
      values: [[{ type: 'Literal', valueType: 'number', value: 1 }]],
    } as unknown as InsertStatement;

    expect(() => insertExecutor.executeInsert(node)).toThrow('Invalid INSERT: no table specified');
  });

  it('should throw for missing values', () => {
    const node = {
      type: 'InsertStatement',
      table: { type: 'Table', name: 'USERS' },
      columns: [{ type: 'Identifier', name: 'ID' }],
      values: [],
    } as unknown as InsertStatement;

    expect(() => insertExecutor.executeInsert(node)).toThrow('Invalid INSERT: no values specified');
  });

  it('should throw for column/value length mismatch', () => {
    const node: InsertStatement = {
      type: 'InsertStatement',
      table: { type: 'Table', name: 'USERS' },
      columns: [
        { type: 'Identifier', name: 'ID' },
        { type: 'Identifier', name: 'NAME' },
      ],
      values: [[{ type: 'Literal', valueType: 'number', value: 1 }]],
    };

    expect(() => insertExecutor.executeInsert(node)).toThrow(
      'Invalid INSERT: column count 2 does not match values count 1',
    );
  });

  it('should resolve identifier values when building inserted rows', async () => {
    const node: InsertStatement = {
      type: 'InsertStatement',
      table: { type: 'Table', name: 'USERS' },
      columns: [
        { type: 'Identifier', name: 'ID' },
        { type: 'Identifier', name: 'NAME' },
      ],
      values: [
        [
          { type: 'Literal', valueType: 'number', value: 1 },
          { type: 'Identifier', name: 'ALICE' },
        ],
      ],
    };

    const result = await Promise.resolve(insertExecutor.executeInsert(node));

    expect(result.rows).toEqual([{ ID: 1, NAME: 'ALICE' }]);
  });
});

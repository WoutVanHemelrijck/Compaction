//@author Tijn Gommers
//@date 2026-04-02

import { describe, expect, it, vi } from 'vitest';
import { SelectExecutor } from '../../../src/executors/select.mjs';
import { DeleteExecutor } from '../../../src/executors/delete.mjs';
import { UpdateExecutor } from '../../../src/executors/update.mjs';
import { InsertExecutor } from '../../../src/executors/insert.mjs';
import type { StorageAdapter } from '../../../storage-adapter/storage-adapter.mjs';
import type { StoragePredicate } from '../../../storage-adapter/storage-adapter-types.mjs';
import type { SelectStatement, DeleteStatement, UpdateStatement, InsertStatement } from '../../../src/types/index.mjs';

describe('StorageAdapter-backed executors', () => {
  it('should read SELECT rows through the adapter', async () => {
    const read = vi.fn((table: string, columns: string[], where?: StoragePredicate) => {
      expect(table).toBe('USERS');
      expect(columns).toEqual(['NAME', 'ID']);
      expect(where).toEqual({
        type: 'ComparisonExpression',
        operator: '=',
        left: { type: 'Identifier', name: 'ID' },
        right: { type: 'Literal', value: 1 },
      });

      return Promise.resolve([{ NAME: 'Alice' }]);
    });

    const adapter: StorageAdapter = {
      read,
      write: () => Promise.resolve(),
      filter: () => Promise.resolve([]),
      project: () => Promise.resolve([]),
      delete: () => Promise.resolve(),
      update: () => Promise.resolve(),
    };

    const selectExecutor = new SelectExecutor(adapter);
    const node: SelectStatement = {
      type: 'SelectStatement',
      distinct: false,
      columns: [{ type: 'Identifier', name: 'NAME' }],
      from: [{ type: 'Table', name: 'USERS' }],
      where: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'ID' },
        operator: '=',
        right: { type: 'Literal', valueType: 'number', value: 1 },
      },
      orderBy: undefined,
      limit: undefined,
    };

    const result = await selectExecutor.executeSelect(node);

    expect(result.rows).toEqual([{ NAME: 'Alice' }]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('should delete rows through the adapter', async () => {
    const filter = vi.fn(() => Promise.resolve([{ ID: 1 }, { ID: 2 }]));
    const deleteRows = vi.fn(() => Promise.resolve());

    const adapter: StorageAdapter = {
      read: () => Promise.resolve([]),
      write: () => Promise.resolve(),
      filter,
      project: () => Promise.resolve([]),
      delete: deleteRows,
      update: () => Promise.resolve(),
    };

    const deleteExecutor = new DeleteExecutor(adapter);
    const node: DeleteStatement = {
      type: 'DeleteStatement',
      from: [{ type: 'Table', name: 'USERS' }],
      where: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'ACTIVE' },
        operator: '=',
        right: { type: 'Literal', valueType: 'number', value: 0 },
      },
    };

    const result = await deleteExecutor.executeDelete(node);

    expect(result.deletedCount).toBe(2);
    expect(filter).toHaveBeenCalledTimes(1);
    expect(deleteRows).toHaveBeenCalledWith('USERS', {
      type: 'ComparisonExpression',
      operator: '=',
      left: { type: 'Identifier', name: 'ACTIVE' },
      right: { type: 'Literal', value: 0 },
    });
  });

  it('should update rows through the adapter', async () => {
    const filter = vi.fn(() => Promise.resolve([{ ID: 1, STATUS: 'INACTIVE' }]));
    const updateRows = vi.fn(() => Promise.resolve());

    const adapter: StorageAdapter = {
      read: () => Promise.resolve([]),
      write: () => Promise.resolve(),
      filter,
      project: () => Promise.resolve([]),
      delete: () => Promise.resolve(),
      update: updateRows,
    };

    const updateExecutor = new UpdateExecutor(adapter);
    const node: UpdateStatement = {
      type: 'UpdateStatement',
      table: { type: 'Table', name: 'USERS' },
      set: [
        {
          column: { type: 'Identifier', name: 'STATUS' },
          value: { type: 'Literal', valueType: 'string', value: 'ACTIVE' },
        },
      ],
      where: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'ID' },
        operator: '=',
        right: { type: 'Literal', valueType: 'number', value: 1 },
      },
    };

    const result = await updateExecutor.executeUpdate(node);

    expect(result.updatedCount).toBe(1);
    expect(result.rows).toEqual([{ ID: 1, STATUS: 'ACTIVE' }]);
    expect(updateRows).toHaveBeenCalledWith(
      'USERS',
      { STATUS: 'ACTIVE' },
      {
        type: 'ComparisonExpression',
        operator: '=',
        left: { type: 'Identifier', name: 'ID' },
        right: { type: 'Literal', value: 1 },
      },
    );
  });

  it('should update identifier values through the adapter', async () => {
    const filter = vi.fn(() => Promise.resolve([{ ID: 1, AGE: 10 }]));
    const updateRows = vi.fn(() => Promise.resolve());

    const adapter: StorageAdapter = {
      read: () => Promise.resolve([]),
      write: () => Promise.resolve(),
      filter,
      project: () => Promise.resolve([]),
      delete: () => Promise.resolve(),
      update: updateRows,
    };

    const updateExecutor = new UpdateExecutor(adapter);
    const node: UpdateStatement = {
      type: 'UpdateStatement',
      table: { type: 'Table', name: 'USERS' },
      set: [
        {
          column: { type: 'Identifier', name: 'COPY_AGE' },
          value: { type: 'Identifier', name: 'AGE' },
        },
      ],
      where: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'ID' },
        operator: '=',
        right: { type: 'Literal', valueType: 'number', value: 1 },
      },
    };

    const result = await updateExecutor.executeUpdate(node);

    expect(result.updatedCount).toBe(1);
    expect(updateRows).toHaveBeenCalledWith(
      'USERS',
      { COPY_AGE: { type: 'Identifier', name: 'AGE' } },
      {
        type: 'ComparisonExpression',
        operator: '=',
        left: { type: 'Identifier', name: 'ID' },
        right: { type: 'Literal', value: 1 },
      },
    );
  });

  it('should write rows through the adapter on INSERT', async () => {
    const write = vi.fn(() => Promise.resolve());

    const adapter: StorageAdapter = {
      read: () => Promise.resolve([]),
      write,
      filter: () => Promise.resolve([]),
      project: () => Promise.resolve([]),
      delete: () => Promise.resolve(),
      update: () => Promise.resolve(),
    };

    const insertExecutor = new InsertExecutor(adapter);
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

    const result = await insertExecutor.executeInsert(node);

    expect(result.insertedCount).toBe(1);
    expect(write).toHaveBeenCalledWith('USERS', [{ ID: 1, NAME: 'Alice' }], [], 'NO_USER');
  });
});

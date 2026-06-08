//@author Tijn Gommers
// @date 2026-03-27

import { DeleteExecutor } from '../../../src/executors/delete.mjs';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DeleteStatement } from '../../../src/types/index.mjs';

describe('DeleteExecutor', () => {
  let deleteExecutor: DeleteExecutor;

  beforeEach(() => {
    deleteExecutor = new DeleteExecutor();
  });

  it('should execute a simple DELETE statement', async () => {
    const deleteNode: DeleteStatement = {
      type: 'DeleteStatement',
      from: [{ type: 'Table', name: 'USERS' }],
      where: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'ID' },
        operator: '=',
        right: { type: 'Literal', valueType: 'number', value: 1 },
      },
    };

    const result = await Promise.resolve(deleteExecutor.executeDelete(deleteNode));

    expect(result.type).toBe('DeleteResult');
    expect(result.from).toEqual([{ type: 'Table', name: 'USERS' }]);
    expect(result.where).toBeDefined();
  });

  it('should execute DELETE with multiple tables', async () => {
    const deleteNode: DeleteStatement = {
      type: 'DeleteStatement',
      from: [
        { type: 'Table', name: 'USERS' },
        { type: 'Table', name: 'ORDERS' },
      ],
      where: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'ACTIVE' },
        operator: '=',
        right: { type: 'Literal', valueType: 'number', value: 0 },
      },
    };

    const result = await Promise.resolve(deleteExecutor.executeDelete(deleteNode));

    expect(result.from).toHaveLength(2);
    expect(result.from).toEqual([
      { type: 'Table', name: 'USERS' },
      { type: 'Table', name: 'ORDERS' },
    ]);
  });

  it('should execute DELETE with WHERE clause', async () => {
    const deleteNode: DeleteStatement = {
      type: 'DeleteStatement',
      from: [{ type: 'Table', name: 'USERS' }],
      where: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'AGE' },
        operator: '<',
        right: { type: 'Literal', valueType: 'number', value: 18 },
      },
    };

    const result = await Promise.resolve(deleteExecutor.executeDelete(deleteNode));

    expect(result.where).toEqual({
      type: 'ComparisonExpression',
      left: { type: 'Identifier', name: 'AGE' },
      operator: '<',
      right: { type: 'Literal', valueType: 'number', value: 18 },
    });
  });

  it('should throw error for DELETE without FROM', () => {
    const deleteNode = {
      type: 'DeleteStatement',
      from: [],
      where: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'ID' },
        operator: '=',
        right: { type: 'Literal', valueType: 'number', value: 1 },
      },
    } as unknown as DeleteStatement;

    expect(() => deleteExecutor.executeDelete(deleteNode)).toThrow('Invalid DELETE: no FROM clause');
  });

  it('should throw error when FROM is null', () => {
    const deleteNode = {
      type: 'DeleteStatement',
      from: null,
      where: undefined,
    } as unknown as DeleteStatement;

    expect(() => deleteExecutor.executeDelete(deleteNode)).toThrow('Invalid DELETE: no FROM clause');
  });

  it('should identify safe DELETE (with WHERE clause)', () => {
    const deleteNode: DeleteStatement = {
      type: 'DeleteStatement',
      from: [{ type: 'Table', name: 'USERS' }],
      where: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'ID' },
        operator: '=',
        right: { type: 'Literal', valueType: 'number', value: 5 },
      },
    };

    const isSafe = deleteExecutor.isSafeDelete(deleteNode);

    expect(isSafe).toBe(true);
  });

  it('should identify unsafe DELETE (without WHERE clause)', () => {
    const deleteNode: DeleteStatement = {
      type: 'DeleteStatement',
      from: [{ type: 'Table', name: 'USERS' }],
      where: undefined,
    };

    const isSafe = deleteExecutor.isSafeDelete(deleteNode);

    expect(isSafe).toBe(false);
  });

  it('should execute DELETE with complex WHERE condition', async () => {
    const deleteNode: DeleteStatement = {
      type: 'DeleteStatement',
      from: [{ type: 'Table', name: 'USERS' }],
      where: {
        type: 'LogicalExpression',
        operator: 'AND',
        left: {
          type: 'ComparisonExpression',
          left: { type: 'Identifier', name: 'STATUS' },
          operator: '=',
          right: { type: 'Literal', valueType: 'string', value: 'inactive' },
        },
        right: {
          type: 'ComparisonExpression',
          left: { type: 'Identifier', name: 'DELETED_AT' },
          operator: '!=',
          right: { type: 'Literal', valueType: 'null', value: null },
        },
      },
    };

    const result = await Promise.resolve(deleteExecutor.executeDelete(deleteNode));

    expect(result.where).toEqual({
      type: 'LogicalExpression',
      operator: 'AND',
      left: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'STATUS' },
        operator: '=',
        right: { type: 'Literal', valueType: 'string', value: 'inactive' },
      },
      right: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'DELETED_AT' },
        operator: '!=',
        right: { type: 'Literal', valueType: 'null', value: null },
      },
    });
    expect(result.type).toBe('DeleteResult');
  });

  it('should preserve FROM table names in result', async () => {
    const deleteNode: DeleteStatement = {
      type: 'DeleteStatement',
      from: [
        { type: 'Table', name: 'ARCHIVED_USERS' },
        { type: 'Table', name: 'ARCHIVED_ORDERS' },
      ],
      where: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'ARCHIVED' },
        operator: '=',
        right: { type: 'Literal', valueType: 'number', value: 1 },
      },
    };

    const result = await Promise.resolve(deleteExecutor.executeDelete(deleteNode));

    expect(result.from).toEqual([
      { type: 'Table', name: 'ARCHIVED_USERS' },
      { type: 'Table', name: 'ARCHIVED_ORDERS' },
    ]);
  });

  it('should handle DELETE with IS NULL condition', async () => {
    const deleteNode: DeleteStatement = {
      type: 'DeleteStatement',
      from: [{ type: 'Table', name: 'USERS' }],
      where: {
        type: 'NullCheckExpression',
        left: { type: 'Identifier', name: 'DELETED_AT' },
        isNegated: false,
      },
    };

    const result = await Promise.resolve(deleteExecutor.executeDelete(deleteNode));

    expect(result.where).toEqual({
      type: 'NullCheckExpression',
      left: { type: 'Identifier', name: 'DELETED_AT' },
      isNegated: false,
    });
    expect(result.type).toBe('DeleteResult');
  });

  it('should validate DELETE statement correctly', () => {
    const validDeleteNode: DeleteStatement = {
      type: 'DeleteStatement',
      from: [{ type: 'Table', name: 'USERS' }],
      where: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'ID' },
        operator: '=',
        right: { type: 'Literal', valueType: 'number', value: 1 },
      },
    };

    // Should not throw
    expect(() => deleteExecutor.executeDelete(validDeleteNode)).not.toThrow();
  });

  it('should execute DELETE from single table with safe WHERE', async () => {
    const deleteNode: DeleteStatement = {
      type: 'DeleteStatement',
      from: [{ type: 'Table', name: 'SESSIONS' }],
      where: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'EXPIRES_AT' },
        operator: '<',
        right: { type: 'Literal', valueType: 'number', value: 1711699200 },
      },
    };

    const result = await Promise.resolve(deleteExecutor.executeDelete(deleteNode));
    const isSafe = deleteExecutor.isSafeDelete(deleteNode);

    expect(result.type).toBe('DeleteResult');
    expect(isSafe).toBe(true);
  });

  it('should execute DELETE with IN expression in WHERE clause', async () => {
    const deleteNode: DeleteStatement = {
      type: 'DeleteStatement',
      from: [{ type: 'Table', name: 'USERS' }],
      where: {
        type: 'InExpression',
        left: { type: 'Identifier', name: 'ID' },
        values: [
          { type: 'Literal', valueType: 'number', value: 10 },
          { type: 'Literal', valueType: 'number', value: 20 },
          { type: 'Literal', valueType: 'number', value: 30 },
        ],
      },
    };

    const result = await Promise.resolve(deleteExecutor.executeDelete(deleteNode));

    expect(result.where).toEqual({
      type: 'InExpression',
      left: { type: 'Identifier', name: 'ID' },
      values: [
        { type: 'Literal', valueType: 'number', value: 10 },
        { type: 'Literal', valueType: 'number', value: 20 },
        { type: 'Literal', valueType: 'number', value: 30 },
      ],
    });
  });

  it('should normalize NOT expressions in DELETE WHERE clause', async () => {
    const deleteNode: DeleteStatement = {
      type: 'DeleteStatement',
      from: [{ type: 'Table', name: 'USERS' }],
      where: {
        type: 'NotExpression',
        operator: 'NOT',
        expression: {
          type: 'ComparisonExpression',
          left: { type: 'Identifier', name: 'ACTIVE' },
          operator: '=',
          right: { type: 'Literal', valueType: 'number', value: 1 },
        },
      },
    };

    const result = await Promise.resolve(deleteExecutor.executeDelete(deleteNode));

    expect(result.where).toEqual({
      type: 'NotExpression',
      operator: 'NOT',
      expression: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'ACTIVE' },
        operator: '=',
        right: { type: 'Literal', valueType: 'number', value: 1 },
      },
    });
  });

  it('should use adapter read and delete with undefined predicate when WHERE is missing', async () => {
    const read = vi.fn(() => Promise.resolve([{ ID: 1 }, { ID: 2 }, { ID: 3 }]));
    const filter = vi.fn(() => Promise.resolve([]));
    const deleteRows = vi.fn(() => Promise.resolve());

    const adapterDeleteExecutor = new DeleteExecutor({
      read,
      write: () => Promise.resolve(),
      filter,
      project: () => Promise.resolve([]),
      delete: deleteRows,
      update: () => Promise.resolve(),
    });

    const deleteNode: DeleteStatement = {
      type: 'DeleteStatement',
      from: [{ type: 'Table', name: 'USERS' }],
      where: undefined,
    };

    const result = await Promise.resolve(adapterDeleteExecutor.executeDelete(deleteNode));

    expect(read).toHaveBeenCalledWith('USERS', ['*']);
    expect(filter).not.toHaveBeenCalled();
    expect(deleteRows).toHaveBeenCalledWith('USERS', undefined);
    expect(result.where).toBeUndefined();
    expect(result.deletedCount).toBe(3);
  });

  it('should use adapter filter and delete with compiled predicate when WHERE exists', async () => {
    const read = vi.fn(() => Promise.resolve([]));
    const filter = vi.fn(() => Promise.resolve([{ ID: 1 }]));
    const deleteRows = vi.fn(() => Promise.resolve());

    const adapterDeleteExecutor = new DeleteExecutor({
      read,
      write: () => Promise.resolve(),
      filter,
      project: () => Promise.resolve([]),
      delete: deleteRows,
      update: () => Promise.resolve(),
    });

    const deleteNode: DeleteStatement = {
      type: 'DeleteStatement',
      from: [{ type: 'Table', name: 'USERS' }],
      where: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'ID' },
        operator: '=',
        right: { type: 'Literal', valueType: 'number', value: 1 },
      },
    };

    const result = await Promise.resolve(adapterDeleteExecutor.executeDelete(deleteNode));

    expect(filter).toHaveBeenCalledWith('USERS', {
      type: 'ComparisonExpression',
      operator: '=',
      left: { type: 'Identifier', name: 'ID' },
      right: { type: 'Literal', value: 1 },
    });
    expect(read).not.toHaveBeenCalled();
    expect(deleteRows).toHaveBeenCalledWith('USERS', {
      type: 'ComparisonExpression',
      operator: '=',
      left: { type: 'Identifier', name: 'ID' },
      right: { type: 'Literal', value: 1 },
    });
    expect(result.deletedCount).toBe(1);
  });
});

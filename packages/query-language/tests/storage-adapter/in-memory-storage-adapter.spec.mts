//@author Tijn Gommers
//@date 2026-04-02

import { describe, expect, it } from 'vitest';
import { InMemoryStorageAdapter } from '../../storage-adapter/in-memory-storage-adapter.mjs';
import { Interpreter } from '../../src/interpreter/interpreter.mjs';
import type { InsertResult, QueryExecutionResult, SelectResult } from '../../src/types/execution-results.mjs';

function asSelectResult(result: QueryExecutionResult): SelectResult {
  if (result.type !== 'SelectResult') {
    throw new Error(`Expected SelectResult but got ${result.type}`);
  }

  return result;
}

function asInsertResult(result: QueryExecutionResult): InsertResult {
  if (result.type !== 'InsertResult') {
    throw new Error(`Expected InsertResult but got ${result.type}`);
  }

  return result;
}

describe('InMemoryStorageAdapter', () => {
  it('should read with projection and comparison predicate', async () => {
    const adapter = new InMemoryStorageAdapter({
      USERS: [
        { ID: 1, NAME: 'Alice', AGE: 29 },
        { ID: 2, NAME: 'Bob', AGE: 18 },
      ],
    });

    const rows = await adapter.read('users', ['NAME'], {
      type: 'ComparisonExpression',
      operator: '>',
      left: 'AGE',
      right: 20,
    });

    expect(rows).toEqual([{ NAME: 'Alice' }]);
  });

  it('should update and delete rows with predicates', async () => {
    const adapter = new InMemoryStorageAdapter({
      USERS: [
        { ID: 1, STATUS: 'INACTIVE' },
        { ID: 2, STATUS: 'INACTIVE' },
      ],
    });

    await adapter.update(
      'USERS',
      { STATUS: 'ACTIVE' },
      {
        type: 'ComparisonExpression',
        operator: '=',
        left: 'ID',
        right: 1,
      },
    );

    await adapter.delete('USERS', {
      type: 'ComparisonExpression',
      operator: '=',
      left: 'ID',
      right: 2,
    });

    const snapshot = adapter.getSnapshot();
    expect(snapshot['USERS']).toEqual([{ ID: 1, STATUS: 'ACTIVE' }]);
  });

  it('should support identifier set payloads during update', async () => {
    const adapter = new InMemoryStorageAdapter({
      USERS: [{ ID: 1, AGE: 32 }],
    });

    await adapter.update(
      'USERS',
      {
        COPY_AGE: { type: 'Identifier', name: 'AGE' },
      },
      undefined,
    );

    const snapshot = adapter.getSnapshot();
    expect(snapshot['USERS'][0]['COPY_AGE']).toBe(32);
  });

  it('should integrate with interpreter for in-memory query testing', async () => {
    const adapter = new InMemoryStorageAdapter({
      USERS: [
        { ID: 1, NAME: 'Alice', ACTIVE: 1 },
        { ID: 2, NAME: 'Bob', ACTIVE: 0 },
      ],
    });

    const selectInterpreter = new Interpreter('SELECT name FROM users WHERE active = 1', adapter);
    const selectResult = asSelectResult(await selectInterpreter.execute());

    expect(selectResult.rows).toEqual([{ NAME: 'Alice', ACTIVE: 1 }]);

    const insertInterpreter = new Interpreter("INSERT INTO users (id, name, active) VALUES (3, 'Cara', 1)", adapter);
    const insertResult = asInsertResult(await insertInterpreter.execute());

    expect(insertResult.insertedCount).toBe(1);

    const snapshot = adapter.getSnapshot();
    expect(snapshot['USERS']).toHaveLength(3);
  });

  it('should support logical, null-check, and IN predicates', async () => {
    const adapter = new InMemoryStorageAdapter({
      USERS: [
        { ID: 1, NAME: 'Alice', ACTIVE: 1, CITY: null },
        { ID: 2, NAME: 'Bob', ACTIVE: 0, CITY: 'AMS' },
        { ID: 3, NAME: 'Cara', ACTIVE: 1, CITY: 'RTM' },
      ],
    });

    const rows = await adapter.filter('USERS', {
      type: 'LogicalExpression',
      operator: 'OR',
      left: {
        type: 'NullCheckExpression',
        column: 'CITY',
        isNegated: false,
      },
      right: {
        type: 'InExpression',
        column: 'ID',
        values: [2],
      },
    });

    expect(rows.map((row) => row['ID']).sort()).toEqual([1, 2]);
  });

  it('should update all rows when where is empty and support arithmetic predicates', async () => {
    const adapter = new InMemoryStorageAdapter({
      USERS: [
        { ID: 1, AGE: 20, ACTIVE: 0 },
        { ID: 2, AGE: 30, ACTIVE: 0 },
      ],
    });

    await adapter.update('USERS', { ACTIVE: 1 }, undefined);

    const rows = await adapter.filter('USERS', {
      type: 'ComparisonExpression',
      operator: '=',
      left: {
        type: 'ArithmeticExpression',
        operator: '+',
        left: 'AGE',
        right: 1,
      },
      right: 21,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]['ID']).toBe(1);
    expect((await adapter.read('USERS', ['*'])).every((row) => row['ACTIVE'] === 1)).toBe(true);
  });

  it('should throw on unknown table and invalid arithmetic operand', async () => {
    const adapter = new InMemoryStorageAdapter({ USERS: [{ ID: 1, AGE: 'x' }] });

    await expect(adapter.read('UNKNOWN', ['*'])).rejects.toThrow('Unknown table: UNKNOWN');

    await expect(
      adapter.filter('USERS', {
        type: 'ComparisonExpression',
        operator: '=',
        left: {
          type: 'ArithmeticExpression',
          operator: '+',
          left: 'AGE',
          right: 1,
        },
        right: 2,
      }),
    ).rejects.toThrow('Invalid arithmetic operands');
  });

  it('should throw on division by zero in arithmetic predicates', async () => {
    const adapter = new InMemoryStorageAdapter({ USERS: [{ ID: 1, AGE: 10 }] });

    await expect(
      adapter.filter('USERS', {
        type: 'ComparisonExpression',
        operator: '>',
        left: {
          type: 'ArithmeticExpression',
          operator: '/',
          left: 'AGE',
          right: 0,
        },
        right: 1,
      }),
    ).rejects.toThrow('Division by zero');
  });

  it('should clear all rows when delete predicate is empty', async () => {
    const adapter = new InMemoryStorageAdapter({
      USERS: [{ ID: 1 }, { ID: 2 }],
    });

    await adapter.delete('USERS', undefined);

    const snapshot = adapter.getSnapshot();
    expect(snapshot['USERS']).toEqual([]);
  });

  it('should write into a new table and read with wildcard projection', async () => {
    const adapter = new InMemoryStorageAdapter();

    await adapter.write('USERS', [{ ID: 1, NAME: 'Alice' }]);

    const rows = await adapter.read('users', ['*']);
    expect(rows).toEqual([{ ID: 1, NAME: 'Alice' }]);
  });

  it('should resolve existing tables case-insensitively', async () => {
    const adapter = new InMemoryStorageAdapter({
      Users: [{ ID: 1, NAME: 'Alice' }],
    });

    const rows = await adapter.read('USERS', ['*']);
    expect(rows).toEqual([{ ID: 1, NAME: 'Alice' }]);
  });

  it('should project missing identifiers as null and support project()', async () => {
    const adapter = new InMemoryStorageAdapter({
      USERS: [{ ID: 1, PROFILE: { CITY: 'AMS', TAGS: ['A', 'B'] } }],
    });

    const rows = await adapter.project('USERS', ['PROFILE', 'MISSING']);
    expect(rows).toEqual([{ PROFILE: { CITY: 'AMS', TAGS: ['A', 'B'] }, MISSING: null }]);
  });

  it('should treat empty predicates as no-op filters for read/filter/update', async () => {
    const adapter = new InMemoryStorageAdapter({
      USERS: [
        { ID: 1, ACTIVE: 0 },
        { ID: 2, ACTIVE: 0 },
      ],
    });

    const readRows = await adapter.read('USERS', ['ID'], {} as never);
    expect(readRows).toEqual([{ ID: 1 }, { ID: 2 }]);

    const filteredRows = await adapter.filter('USERS', {} as never);
    expect(filteredRows).toHaveLength(2);

    await adapter.update('USERS', { ACTIVE: 1 }, {} as never);
    const updated = await adapter.read('USERS', ['*']);
    expect(updated.every((row) => row['ACTIVE'] === 1)).toBe(true);
  });

  it('should support NOT and AND logical predicates', async () => {
    const adapter = new InMemoryStorageAdapter({
      USERS: [
        { ID: 1, ACTIVE: 1, AGE: 30 },
        { ID: 2, ACTIVE: 0, AGE: 30 },
        { ID: 3, ACTIVE: 0, AGE: 10 },
      ],
    });

    const rows = await adapter.filter('USERS', {
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

    expect(rows).toEqual([{ ID: 2, ACTIVE: 0, AGE: 30 }]);
  });

  it('should evaluate all comparison operators and mixed-type fallback', async () => {
    const adapter = new InMemoryStorageAdapter({
      USERS: [
        { ID: 1, AGE: 10, NAME: 'ALICE' },
        { ID: 2, AGE: 20, NAME: 'BOB' },
      ],
    });

    expect(
      await adapter.filter('USERS', {
        type: 'ComparisonExpression',
        operator: '<',
        left: 'AGE',
        right: 15,
      }),
    ).toHaveLength(1);

    expect(
      await adapter.filter('USERS', {
        type: 'ComparisonExpression',
        operator: '<=',
        left: 'NAME',
        right: 'ALICE',
      }),
    ).toHaveLength(1);

    expect(
      await adapter.filter('USERS', {
        type: 'ComparisonExpression',
        operator: '!=',
        left: 'AGE',
        right: 10,
      }),
    ).toHaveLength(1);

    expect(
      await adapter.filter('USERS', {
        type: 'ComparisonExpression',
        operator: '>',
        left: 'AGE',
        right: '10',
      }),
    ).toHaveLength(0);

    expect(
      await adapter.filter('USERS', {
        type: 'ComparisonExpression',
        operator: '<>' as never,
        left: 'AGE',
        right: 10,
      }),
    ).toHaveLength(0);
  });

  it('should support arithmetic operators -, *, and / in predicates', async () => {
    const adapter = new InMemoryStorageAdapter({
      USERS: [
        { ID: 1, AGE: 10 },
        { ID: 2, AGE: 20 },
      ],
    });

    const minusRows = await adapter.filter('USERS', {
      type: 'ComparisonExpression',
      operator: '=',
      left: {
        type: 'ArithmeticExpression',
        operator: '-',
        left: 'AGE',
        right: 5,
      },
      right: 5,
    });

    const multiplyRows = await adapter.filter('USERS', {
      type: 'ComparisonExpression',
      operator: '=',
      left: {
        type: 'ArithmeticExpression',
        operator: '*',
        left: 'AGE',
        right: 2,
      },
      right: 40,
    });

    const divideRows = await adapter.filter('USERS', {
      type: 'ComparisonExpression',
      operator: '=',
      left: {
        type: 'ArithmeticExpression',
        operator: '/',
        left: 'AGE',
        right: 2,
      },
      right: 5,
    });

    expect(minusRows.map((row) => row['ID'])).toEqual([1]);
    expect(multiplyRows.map((row) => row['ID'])).toEqual([2]);
    expect(divideRows.map((row) => row['ID'])).toEqual([1]);
  });

  it('should throw for unsupported arithmetic operator in predicate', async () => {
    const adapter = new InMemoryStorageAdapter({ USERS: [{ ID: 1, AGE: 10 }] });

    await expect(
      adapter.filter('USERS', {
        type: 'ComparisonExpression',
        operator: '=',
        left: {
          type: 'ArithmeticExpression',
          operator: '%',
          left: 'AGE',
          right: 2,
        } as never,
        right: 0,
      }),
    ).rejects.toThrow('Unsupported arithmetic operator: %');
  });

  it('should resolve identifier references in predicates and set values with null fallback', async () => {
    const adapter = new InMemoryStorageAdapter({
      USERS: [
        { ID: 1, AGE: 10, MIN_AGE: 10 },
        { ID: 2, AGE: 20, MIN_AGE: 10 },
      ],
    });

    const filtered = await adapter.filter('USERS', {
      type: 'ComparisonExpression',
      operator: '=',
      left: 'AGE',
      right: 'MIN_AGE',
    });
    expect(filtered.map((row) => row['ID'])).toEqual([1]);

    await adapter.update('USERS', { COPY_MISSING: { type: 'Identifier', name: 'NOT_PRESENT' } }, undefined);
    const rows = await adapter.read('USERS', ['*']);
    expect(rows.every((row) => row['COPY_MISSING'] === null)).toBe(true);
  });

  it('should coerce unsupported set values to null', async () => {
    const adapter = new InMemoryStorageAdapter({ USERS: [{ ID: 1 }] });

    await adapter.update('USERS', { BAD_VALUE: Symbol('x') as never }, undefined);

    const rows = await adapter.read('USERS', ['*']);
    expect(rows[0]['BAD_VALUE']).toBeNull();
  });

  it('should return no rows for unsupported predicate type', async () => {
    const adapter = new InMemoryStorageAdapter({ USERS: [{ ID: 1 }] });

    const rows = await adapter.filter('USERS', {
      type: 'UnsupportedPredicate',
    } as never);

    expect(rows).toEqual([]);
  });
});

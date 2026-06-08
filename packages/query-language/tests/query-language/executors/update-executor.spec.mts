//@author Tijn Gommers
// @date 2026-03-31

import { describe, it, expect, beforeEach } from 'vitest';
import { UpdateExecutor } from '../../../src/executors/update.mjs';
import type { UpdateStatement } from '../../../src/types/index.mjs';
import type { StorageRow } from '../../../storage-adapter/storage-adapter-types.mjs';

describe('UpdateExecutor', () => {
  let updateExecutor: UpdateExecutor;

  beforeEach(() => {
    updateExecutor = new UpdateExecutor();
  });

  it('should update all rows when WHERE is omitted', async () => {
    const node: UpdateStatement = {
      type: 'UpdateStatement',
      table: { type: 'Table', name: 'USERS' },
      set: [
        {
          column: { type: 'Identifier', name: 'STATUS' },
          value: { type: 'Literal', valueType: 'string', value: 'ACTIVE' },
        },
      ],
      where: undefined,
    };

    const rows = [
      { ID: 1, STATUS: 'INACTIVE' },
      { ID: 2, STATUS: 'INACTIVE' },
    ];

    const result = await Promise.resolve(updateExecutor.executeUpdate(node, rows));

    expect(result.type).toBe('UpdateResult');
    expect(result.updatedCount).toBe(2);
    expect(rows).toEqual([
      { ID: 1, STATUS: 'ACTIVE' },
      { ID: 2, STATUS: 'ACTIVE' },
    ]);
  });

  it('should update only matching rows with WHERE clause', async () => {
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
        right: { type: 'Literal', valueType: 'number', value: 2 },
      },
    };

    const rows = [
      { ID: 1, STATUS: 'INACTIVE' },
      { ID: 2, STATUS: 'INACTIVE' },
    ];

    const result = await Promise.resolve(updateExecutor.executeUpdate(node, rows));

    expect(result.updatedCount).toBe(1);
    expect(rows).toEqual([
      { ID: 1, STATUS: 'INACTIVE' },
      { ID: 2, STATUS: 'ACTIVE' },
    ]);
  });

  it('should resolve identifier assignments from current row', () => {
    const node: UpdateStatement = {
      type: 'UpdateStatement',
      table: { type: 'Table', name: 'USERS' },
      set: [
        {
          column: { type: 'Identifier', name: 'COPY_AGE' },
          value: { type: 'Identifier', name: 'AGE' },
        },
      ],
      where: undefined,
    };

    const rows: StorageRow[] = [{ ID: 1, AGE: 35 }];

    void updateExecutor.executeUpdate(node, rows);

    expect(rows[0]['COPY_AGE']).toBe(35);
  });

  it('should throw for missing SET assignments', () => {
    const node = {
      type: 'UpdateStatement',
      table: { type: 'Table', name: 'USERS' },
      set: [],
      where: undefined,
    } as unknown as UpdateStatement;

    expect(() => updateExecutor.executeUpdate(node, [{ ID: 1 }])).toThrow(
      'Invalid UPDATE: no SET assignments specified',
    );
  });

  it('should update rows matching AND logical where condition', async () => {
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
        type: 'LogicalExpression',
        operator: 'AND',
        left: {
          type: 'ComparisonExpression',
          left: { type: 'Identifier', name: 'AGE' },
          operator: '>=',
          right: { type: 'Literal', valueType: 'number', value: 18 },
        },
        right: {
          type: 'ComparisonExpression',
          left: { type: 'Identifier', name: 'COUNTRY' },
          operator: '=',
          right: { type: 'Literal', valueType: 'string', value: 'NL' },
        },
      },
    };

    const rows = [
      { ID: 1, AGE: 17, COUNTRY: 'NL', STATUS: 'INACTIVE' },
      { ID: 2, AGE: 20, COUNTRY: 'BE', STATUS: 'INACTIVE' },
      { ID: 3, AGE: 25, COUNTRY: 'NL', STATUS: 'INACTIVE' },
    ];

    const result = await Promise.resolve(updateExecutor.executeUpdate(node, rows));

    expect(result.updatedCount).toBe(1);
    expect(rows[2].STATUS).toBe('ACTIVE');
  });

  it('should update rows matching IN expression', async () => {
    const node: UpdateStatement = {
      type: 'UpdateStatement',
      table: { type: 'Table', name: 'USERS' },
      set: [
        {
          column: { type: 'Identifier', name: 'FLAGGED' },
          value: { type: 'Literal', valueType: 'number', value: 1 },
        },
      ],
      where: {
        type: 'InExpression',
        left: { type: 'Identifier', name: 'ID' },
        values: [
          { type: 'Literal', valueType: 'number', value: 1 },
          { type: 'Literal', valueType: 'number', value: 3 },
        ],
      },
    };

    const rows: StorageRow[] = [{ ID: 1 }, { ID: 2 }, { ID: 3 }];

    const result = await Promise.resolve(updateExecutor.executeUpdate(node, rows));

    expect(result.updatedCount).toBe(2);
    expect(rows).toEqual([{ ID: 1, FLAGGED: 1 }, { ID: 2 }, { ID: 3, FLAGGED: 1 }]);
  });

  it('should update rows matching IS NULL where condition', async () => {
    const node: UpdateStatement = {
      type: 'UpdateStatement',
      table: { type: 'Table', name: 'USERS' },
      set: [
        {
          column: { type: 'Identifier', name: 'STATUS' },
          value: { type: 'Literal', valueType: 'string', value: 'PENDING' },
        },
      ],
      where: {
        type: 'NullCheckExpression',
        left: { type: 'Identifier', name: 'DELETED_AT' },
        isNegated: false,
      },
    };

    const rows: StorageRow[] = [
      { ID: 1, DELETED_AT: null, STATUS: 'UNKNOWN' },
      { ID: 2, DELETED_AT: 100, STATUS: 'UNKNOWN' },
      { ID: 3, STATUS: 'UNKNOWN' },
    ];

    const result = await Promise.resolve(updateExecutor.executeUpdate(node, rows));

    expect(result.updatedCount).toBe(2);
    expect(rows[0]['STATUS']).toBe('PENDING');
    expect(rows[1]['STATUS']).toBe('UNKNOWN');
    expect(rows[2]['STATUS']).toBe('PENDING');
  });

  it('should throw for invalid arithmetic operands in WHERE', () => {
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
        left: {
          type: 'ArithmeticExpression',
          operator: '+',
          left: { type: 'Identifier', name: 'AGE' },
          right: { type: 'Literal', valueType: 'number', value: 2 },
        },
        operator: '>',
        right: { type: 'Literal', valueType: 'number', value: 10 },
      },
    };

    expect(() => updateExecutor.executeUpdate(node, [{ AGE: 'bad' }])).toThrow('Invalid arithmetic operands: bad + 2');
  });

  it('should throw for division by zero in WHERE', () => {
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
        left: {
          type: 'ArithmeticExpression',
          operator: '/',
          left: { type: 'Identifier', name: 'AGE' },
          right: { type: 'Literal', valueType: 'number', value: 0 },
        },
        operator: '>',
        right: { type: 'Literal', valueType: 'number', value: 1 },
      },
    };

    expect(() => updateExecutor.executeUpdate(node, [{ AGE: 10 }])).toThrow('Division by zero');
  });

  it('should throw for missing table', () => {
    const node = {
      type: 'UpdateStatement',
      table: null,
      set: [
        {
          column: { type: 'Identifier', name: 'STATUS' },
          value: { type: 'Literal', valueType: 'string', value: 'ACTIVE' },
        },
      ],
      where: undefined,
    } as unknown as UpdateStatement;

    expect(() => updateExecutor.executeUpdate(node, [{ ID: 1 }])).toThrow('Invalid UPDATE: no table specified');
  });

  it('should support NOT expression and update non-matching rows', async () => {
    const node: UpdateStatement = {
      type: 'UpdateStatement',
      table: { type: 'Table', name: 'USERS' },
      set: [
        {
          column: { type: 'Identifier', name: 'FLAGGED' },
          value: { type: 'Literal', valueType: 'number', value: 1 },
        },
      ],
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

    const rows: StorageRow[] = [{ ACTIVE: 1 }, { ACTIVE: 0 }];
    const result = await Promise.resolve(updateExecutor.executeUpdate(node, rows));

    expect(result.updatedCount).toBe(1);
    expect(rows).toEqual([{ ACTIVE: 1 }, { ACTIVE: 0, FLAGGED: 1 }]);
  });

  it('should support OR expression and comparison operators !=, >, <, <=', async () => {
    const node: UpdateStatement = {
      type: 'UpdateStatement',
      table: { type: 'Table', name: 'USERS' },
      set: [
        {
          column: { type: 'Identifier', name: 'MATCHED' },
          value: { type: 'Literal', valueType: 'number', value: 1 },
        },
      ],
      where: {
        type: 'LogicalExpression',
        operator: 'OR',
        left: {
          type: 'ComparisonExpression',
          left: { type: 'Identifier', name: 'AGE' },
          operator: '>',
          right: { type: 'Literal', valueType: 'number', value: 40 },
        },
        right: {
          type: 'ComparisonExpression',
          left: { type: 'Identifier', name: 'AGE' },
          operator: '<=',
          right: { type: 'Literal', valueType: 'number', value: 20 },
        },
      },
    };

    const rows: StorageRow[] = [{ AGE: 45 }, { AGE: 20 }, { AGE: 30 }];

    void updateExecutor.executeUpdate(node, rows);
    expect(rows).toEqual([{ AGE: 45, MATCHED: 1 }, { AGE: 20, MATCHED: 1 }, { AGE: 30 }]);

    const node2: UpdateStatement = {
      ...node,
      where: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'AGE' },
        operator: '!=',
        right: { type: 'Literal', valueType: 'number', value: 30 },
      },
    };

    const rows2: StorageRow[] = [{ AGE: 30 }, { AGE: 10 }];
    const result2 = await Promise.resolve(updateExecutor.executeUpdate(node2, rows2));
    expect(result2.updatedCount).toBe(1);
  });

  it('should support IS NOT NULL branch', async () => {
    const node: UpdateStatement = {
      type: 'UpdateStatement',
      table: { type: 'Table', name: 'USERS' },
      set: [
        {
          column: { type: 'Identifier', name: 'STATUS' },
          value: { type: 'Literal', valueType: 'string', value: 'ARCHIVED' },
        },
      ],
      where: {
        type: 'NullCheckExpression',
        left: { type: 'Identifier', name: 'DELETED_AT' },
        isNegated: true,
      },
    };

    const rows: StorageRow[] = [
      { DELETED_AT: null, STATUS: 'LIVE' },
      { DELETED_AT: 123, STATUS: 'LIVE' },
    ];

    const result = await Promise.resolve(updateExecutor.executeUpdate(node, rows));
    expect(result.updatedCount).toBe(1);
    expect(rows[1]['STATUS']).toBe('ARCHIVED');
  });

  it('should resolve nested identifier paths case-insensitively', () => {
    const node: UpdateStatement = {
      type: 'UpdateStatement',
      table: { type: 'Table', name: 'USERS' },
      set: [
        {
          column: { type: 'Identifier', name: 'TOTAL_COPY' },
          value: { type: 'Identifier', name: 'orders.total' },
        },
      ],
      where: undefined,
    };

    const rows: StorageRow[] = [{ ORDERS: { TOTAL: 99 } }];
    void updateExecutor.executeUpdate(node, rows);

    expect(rows[0]['TOTAL_COPY']).toBe(99);
  });

  it('should compare string operands with ordered comparison operators', async () => {
    const node: UpdateStatement = {
      type: 'UpdateStatement',
      table: { type: 'Table', name: 'USERS' },
      set: [
        {
          column: { type: 'Identifier', name: 'MATCHED' },
          value: { type: 'Literal', valueType: 'number', value: 1 },
        },
      ],
      where: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'NAME' },
        operator: '<=',
        right: { type: 'Literal', valueType: 'string', value: 'M' },
      },
    };

    const rows: StorageRow[] = [{ NAME: 'ALICE' }, { NAME: 'ZOE' }];

    const result = await Promise.resolve(updateExecutor.executeUpdate(node, rows));

    expect(result.updatedCount).toBe(1);
    expect(rows).toEqual([{ NAME: 'ALICE', MATCHED: 1 }, { NAME: 'ZOE' }]);
  });

  it('should treat mixed-type ordered comparisons as false', async () => {
    const node: UpdateStatement = {
      type: 'UpdateStatement',
      table: { type: 'Table', name: 'USERS' },
      set: [
        {
          column: { type: 'Identifier', name: 'MATCHED' },
          value: { type: 'Literal', valueType: 'number', value: 1 },
        },
      ],
      where: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'AGE' },
        operator: '>',
        right: { type: 'Literal', valueType: 'string', value: '18' },
      },
    };

    const rows: StorageRow[] = [{ AGE: 20 }];

    const result = await Promise.resolve(updateExecutor.executeUpdate(node, rows));

    expect(result.updatedCount).toBe(0);
    expect(rows).toEqual([{ AGE: 20 }]);
  });

  it('should compare numeric operands with <', async () => {
    const node: UpdateStatement = {
      type: 'UpdateStatement',
      table: { type: 'Table', name: 'USERS' },
      set: [
        {
          column: { type: 'Identifier', name: 'MATCHED' },
          value: { type: 'Literal', valueType: 'number', value: 1 },
        },
      ],
      where: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'AGE' },
        operator: '<',
        right: { type: 'Literal', valueType: 'number', value: 20 },
      },
    };

    const rows: StorageRow[] = [{ AGE: 10 }, { AGE: 30 }];

    const result = await Promise.resolve(updateExecutor.executeUpdate(node, rows));

    expect(result.updatedCount).toBe(1);
    expect(rows).toEqual([{ AGE: 10, MATCHED: 1 }, { AGE: 30 }]);
  });

  it('should evaluate arithmetic expressions with all supported operators in WHERE', async () => {
    const node: UpdateStatement = {
      type: 'UpdateStatement',
      table: { type: 'Table', name: 'USERS' },
      set: [
        {
          column: { type: 'Identifier', name: 'MATCHED' },
          value: { type: 'Literal', valueType: 'number', value: 1 },
        },
      ],
      where: {
        type: 'ComparisonExpression',
        left: {
          type: 'ArithmeticExpression',
          operator: '/',
          left: {
            type: 'ArithmeticExpression',
            operator: '*',
            left: {
              type: 'ArithmeticExpression',
              operator: '-',
              left: {
                type: 'ArithmeticExpression',
                operator: '+',
                left: { type: 'Identifier', name: 'BASE' },
                right: { type: 'Literal', valueType: 'number', value: 2 },
              },
              right: { type: 'Literal', valueType: 'number', value: 1 },
            },
            right: { type: 'Literal', valueType: 'number', value: 3 },
          },
          right: { type: 'Literal', valueType: 'number', value: 2 },
        },
        operator: '>',
        right: { type: 'Literal', valueType: 'number', value: 10 },
      },
    };

    const rows: StorageRow[] = [{ BASE: 8 }];

    const result = await Promise.resolve(updateExecutor.executeUpdate(node, rows));

    expect(result.updatedCount).toBe(1);
    expect(rows).toEqual([{ BASE: 8, MATCHED: 1 }]);
  });

  it('should delete a property when array conversion encounters an unsupported value', async () => {
    const node = {
      type: 'UpdateStatement',
      table: { type: 'Table', name: 'USERS' },
      set: [
        {
          column: { type: 'Identifier', name: 'TAGS' },
          value: {
            type: 'Literal',
            valueType: 'array',
            value: [1, () => 2],
          },
        },
      ],
      where: undefined,
    } as unknown as UpdateStatement;

    const rows: StorageRow[] = [{ ID: 1, TAGS: ['existing'] }];

    const result = await Promise.resolve(updateExecutor.executeUpdate(node, rows));

    expect(result.updatedCount).toBe(1);
    expect(rows[0]).toEqual({ ID: 1 });
  });

  it('should delete a property when a top-level unsupported literal cannot be converted', async () => {
    const node = {
      type: 'UpdateStatement',
      table: { type: 'Table', name: 'USERS' },
      set: [
        {
          column: { type: 'Identifier', name: 'PROFILE' },
          value: {
            type: 'Literal',
            valueType: 'object',
            value: () => 1,
          },
        },
      ],
      where: undefined,
    } as unknown as UpdateStatement;

    const rows: StorageRow[] = [{ ID: 1, PROFILE: 'existing' }];

    const result = await Promise.resolve(updateExecutor.executeUpdate(node, rows));

    expect(result.updatedCount).toBe(1);
    expect(rows[0]).toEqual({ ID: 1 });
  });

  it('should convert array literal values when updating rows', async () => {
    const node = {
      type: 'UpdateStatement',
      table: { type: 'Table', name: 'USERS' },
      set: [
        {
          column: { type: 'Identifier', name: 'TAGS' },
          value: {
            type: 'Literal',
            valueType: 'array',
            value: ['A', 1, true],
          },
        },
      ],
      where: undefined,
    } as unknown as UpdateStatement;

    const rows: StorageRow[] = [{ ID: 1 }];

    const result = await Promise.resolve(updateExecutor.executeUpdate(node, rows));

    expect(result.updatedCount).toBe(1);
    expect(rows[0]['TAGS']).toEqual(['A', 1, true]);
  });

  it('should convert object literal values when updating rows', async () => {
    const node = {
      type: 'UpdateStatement',
      table: { type: 'Table', name: 'USERS' },
      set: [
        {
          column: { type: 'Identifier', name: 'PROFILE' },
          value: {
            type: 'Literal',
            valueType: 'object',
            value: { ACTIVE: true, SCORE: 7 },
          },
        },
      ],
      where: undefined,
    } as unknown as UpdateStatement;

    const rows: StorageRow[] = [{ ID: 1 }];

    const result = await Promise.resolve(updateExecutor.executeUpdate(node, rows));

    expect(result.updatedCount).toBe(1);
    expect(rows[0]['PROFILE']).toEqual({ ACTIVE: true, SCORE: 7 });
  });

  it('should delete a property when an unsupported literal value cannot be converted', async () => {
    const node = {
      type: 'UpdateStatement',
      table: { type: 'Table', name: 'USERS' },
      set: [
        {
          column: { type: 'Identifier', name: 'PROFILE' },
          value: {
            type: 'Literal',
            valueType: 'object',
            value: { ACTIVE: true, CALLBACK: () => 1 },
          },
        },
      ],
      where: undefined,
    } as unknown as UpdateStatement;

    const rows: StorageRow[] = [{ ID: 1, PROFILE: 'existing' }];

    const result = await Promise.resolve(updateExecutor.executeUpdate(node, rows));

    expect(result.updatedCount).toBe(1);
    expect(rows[0]).toEqual({ ID: 1 });
  });

  it('should ignore comparison when expression value type is unsupported', async () => {
    const node = {
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
        left: { type: 'AggregateFunction', functionName: 'COUNT', argument: { type: 'Wildcard', value: '*' } },
        operator: '=',
        right: { type: 'Literal', valueType: 'number', value: 1 },
      },
    } as unknown as UpdateStatement;

    const rows: StorageRow[] = [{ STATUS: 'INACTIVE' }];
    const result = await Promise.resolve(updateExecutor.executeUpdate(node, rows));

    expect(result.updatedCount).toBe(0);
    expect(rows[0]['STATUS']).toBe('INACTIVE');
  });

  it('should hit defensive defaults for private helpers', () => {
    const internalExecutor = updateExecutor as unknown as {
      applyArithmetic: (left: unknown, right: unknown, operator: string) => number;
      compareValues: (left: unknown, right: unknown, operator: string) => boolean;
      evaluateWhereExpression: (expression: unknown, row: StorageRow) => boolean;
      normalizeWhereExpression: (where: unknown) => unknown;
      resolveExpressionValue: (value: unknown, row: StorageRow) => unknown;
      resolveIdentifierValue: (row: StorageRow, identifier: { type: 'Identifier'; name: string }) => unknown;
    };

    expect(() => internalExecutor.applyArithmetic(1, 2, '%')).toThrow('Unsupported arithmetic operator');
    expect(internalExecutor.compareValues(1, 1, '??')).toBe(false);
    expect(
      internalExecutor.normalizeWhereExpression({
        type: 'LogicalExpression',
        operator: 'AND',
        left: undefined,
        right: {
          type: 'Literal',
          valueType: 'number',
          value: 1,
        },
      }),
    ).toEqual({
      type: 'LogicalExpression',
      operator: 'AND',
      left: undefined,
      right: {
        type: 'Literal',
        valueType: 'number',
        value: 1,
      },
    });
    expect(
      internalExecutor.normalizeWhereExpression({
        type: 'NotExpression',
        operator: 'NOT',
        expression: undefined,
      }),
    ).toEqual({
      type: 'NotExpression',
      operator: 'NOT',
      expression: undefined,
    });
    expect(internalExecutor.resolveExpressionValue({ type: 'UnsupportedExpression' }, { ID: 1 })).toBeUndefined();
    expect(
      internalExecutor.resolveIdentifierValue({ OUTER: 5 }, { type: 'Identifier', name: 'OUTER.INNER' }),
    ).toBeUndefined();
    expect(internalExecutor.evaluateWhereExpression({ type: 'UnsupportedExpression' }, { ID: 1 })).toBe(false);
  });
});

import { InMemoryStorageAdapter } from '../../../storage-adapter/in-memory-storage-adapter.mjs';

it('reproduces bug: storage-backed UPDATE resolves identifier SET from first matched row for all rows', async () => {
  const adapter = new InMemoryStorageAdapter({
    USERS: [
      { ID: 1, AGE: 10 },
      { ID: 2, AGE: 20 },
    ],
  });

  const executor = new UpdateExecutor(adapter);

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
      operator: '>=',
      right: { type: 'Literal', valueType: 'number', value: 1 },
    },
  };

  await executor.executeUpdate(node);

  const rows = await adapter.read('USERS', ['*']);

  expect(rows).toEqual([
    { ID: 1, AGE: 10, COPY_AGE: 10 },
    { ID: 2, AGE: 20, COPY_AGE: 20 },
  ]);
});

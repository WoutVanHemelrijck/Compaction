//@author Tijn Gommers
// @date 2026-03-27

import { SelectExecutor } from '../../../src/executors/select.mjs';
import { describe, it, expect, beforeEach } from 'vitest';
import type { SelectStatement, FromNode } from '../../../src/types/index.mjs';
import type { SelectResult } from '../../../src/types/execution-results.mjs';

type SyncSelectExecutor = Omit<SelectExecutor, 'executeSelect'> & {
  executeSelect(node: SelectStatement, inputRows?: Record<string, unknown>[]): SelectResult;
};

describe('SelectExecutor', () => {
  let selectExecutor: SyncSelectExecutor;

  beforeEach(() => {
    selectExecutor = new SelectExecutor() as SyncSelectExecutor;
  });

  it('should execute a simple SELECT statement', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: false,
      columns: [{ type: 'Identifier', name: 'NAME' }],
      from: [{ type: 'Table', name: 'USERS' }],
      where: undefined,
      orderBy: undefined,
      limit: undefined,
    };

    const result = selectExecutor.executeSelect(selectNode);

    expect(result.type).toBe('SelectResult');
    expect(result.columns).toEqual([{ type: 'Identifier', name: 'NAME' }]);
    expect(result.from).toEqual([{ type: 'Table', name: 'USERS' }]);
  });

  it('should execute SELECT with WHERE clause', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: false,
      columns: [{ type: 'Identifier', name: 'NAME' }],
      from: [{ type: 'Table', name: 'USERS' }],
      where: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'AGE' },
        operator: '>',
        right: { type: 'Literal', valueType: 'number', value: 30 },
      },
      orderBy: undefined,
      limit: undefined,
    };

    const result = selectExecutor.executeSelect(selectNode);

    expect(result.where).toEqual({
      type: 'ComparisonExpression',
      left: { type: 'Identifier', name: 'AGE' },
      operator: '>',
      right: { type: 'Literal', valueType: 'number', value: 30 },
    });
  });

  it('should execute SELECT with ORDER BY clause', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: false,
      columns: [{ type: 'Identifier', name: 'NAME' }],
      from: [{ type: 'Table', name: 'USERS' }],
      where: undefined,
      orderBy: {
        type: 'OrderByStatement',
        items: [{ column: { type: 'Identifier', name: 'NAME' }, direction: 'ASC' }],
      },
      limit: undefined,
    };

    const result = selectExecutor.executeSelect(selectNode);

    expect(result.orderBy).toEqual({
      type: 'OrderByStatement',
      items: [{ column: { type: 'Identifier', name: 'NAME' }, direction: 'ASC' }],
    });
  });

  it('should execute SELECT with LIMIT clause', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: false,
      columns: [{ type: 'Identifier', name: '*' }],
      from: [{ type: 'Table', name: 'USERS' }],
      where: undefined,
      orderBy: undefined,
      limit: {
        type: 'LimitOffset',
        limit: 10,
        offset: undefined,
      },
    };

    const result = selectExecutor.executeSelect(selectNode);

    expect(result.limit).toEqual({
      type: 'LimitOffset',
      limit: 10,
      offset: undefined,
    });
  });

  it('should execute SELECT with LIMIT and OFFSET', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: false,
      columns: [{ type: 'Identifier', name: '*' }],
      from: [{ type: 'Table', name: 'USERS' }],
      where: undefined,
      orderBy: undefined,
      limit: {
        type: 'LimitOffset',
        limit: 10,
        offset: 5,
      },
    };

    const result = selectExecutor.executeSelect(selectNode);

    expect(result.limit).toEqual({
      type: 'LimitOffset',
      limit: 10,
      offset: 5,
    });
  });

  it('should execute SELECT with JOIN', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: false,
      columns: [{ type: 'Identifier', name: '*' }],
      from: [
        { type: 'Table', name: 'USERS' },
        {
          type: 'Join',
          table: { type: 'Table', name: 'ORDERS' },
          joinType: 'INNER',
          on: {
            type: 'ComparisonExpression',
            left: { type: 'Identifier', name: 'USERS.ID' },
            operator: '=',
            right: { type: 'Identifier', name: 'ORDERS.USER_ID' },
          },
        },
      ] as FromNode[],
      where: undefined,
      orderBy: undefined,
      limit: undefined,
    };

    const result = selectExecutor.executeSelect(selectNode);

    expect(result.from).toHaveLength(2);
    expect(result.from).toEqual([
      { type: 'Table', name: 'USERS' },
      {
        type: 'Join',
        table: { type: 'Table', name: 'ORDERS' },
        joinType: 'INNER',
        on: {
          type: 'ComparisonExpression',
          left: { type: 'Identifier', name: 'USERS.ID' },
          operator: '=',
          right: { type: 'Identifier', name: 'ORDERS.USER_ID' },
        },
      },
    ]);
  });

  it('should execute SELECT with multiple JOINs', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: false,
      columns: [{ type: 'Identifier', name: '*' }],
      from: [
        { type: 'Table', name: 'USERS' },
        {
          type: 'Join',
          table: { type: 'Table', name: 'ORDERS' },
          joinType: 'INNER',
          on: {
            type: 'ComparisonExpression',
            left: { type: 'Identifier', name: 'USERS.ID' },
            operator: '=',
            right: { type: 'Identifier', name: 'ORDERS.USER_ID' },
          },
        },
        {
          type: 'Join',
          table: { type: 'Table', name: 'PRODUCTS' },
          joinType: 'INNER',
          on: {
            type: 'ComparisonExpression',
            left: { type: 'Identifier', name: 'ORDERS.PRODUCT_ID' },
            operator: '=',
            right: { type: 'Identifier', name: 'PRODUCTS.ID' },
          },
        },
      ] as FromNode[],
      where: undefined,
      orderBy: undefined,
      limit: undefined,
    };

    const result = selectExecutor.executeSelect(selectNode);

    expect(result.from).toHaveLength(3);
    expect(result.from).toEqual([
      { type: 'Table', name: 'USERS' },
      {
        type: 'Join',
        table: { type: 'Table', name: 'ORDERS' },
        joinType: 'INNER',
        on: {
          type: 'ComparisonExpression',
          left: { type: 'Identifier', name: 'USERS.ID' },
          operator: '=',
          right: { type: 'Identifier', name: 'ORDERS.USER_ID' },
        },
      },
      {
        type: 'Join',
        table: { type: 'Table', name: 'PRODUCTS' },
        joinType: 'INNER',
        on: {
          type: 'ComparisonExpression',
          left: { type: 'Identifier', name: 'ORDERS.PRODUCT_ID' },
          operator: '=',
          right: { type: 'Identifier', name: 'PRODUCTS.ID' },
        },
      },
    ]);
  });

  it('should execute SELECT with all clauses', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: false,
      columns: [
        { type: 'Identifier', name: 'NAME' },
        { type: 'Identifier', name: 'EMAIL' },
      ],
      from: [{ type: 'Table', name: 'USERS' }],
      where: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'ACTIVE' },
        operator: '=',
        right: { type: 'Literal', valueType: 'number', value: 1 },
      },
      orderBy: {
        type: 'OrderByStatement',
        items: [{ column: { type: 'Identifier', name: 'NAME' }, direction: 'ASC' }],
      },
      limit: {
        type: 'LimitOffset',
        limit: 50,
        offset: 10,
      },
    };

    const result = selectExecutor.executeSelect(selectNode);

    expect(result.type).toBe('SelectResult');
    expect(result.columns).toHaveLength(2);
    expect(result.where).toBeDefined();
    expect(result.orderBy).toBeDefined();
    expect(result.limit).toBeDefined();
  });

  it('should throw error for SELECT without columns', () => {
    const selectNode = {
      type: 'SelectStatement',
      columns: [],
      from: [{ type: 'Table', name: 'USERS' }],
      where: undefined,
    } as unknown as SelectStatement;

    expect(() => selectExecutor.validateSelect(selectNode)).toThrow('Invalid SELECT: no columns specified');
  });

  it('should throw error for SELECT without FROM', () => {
    const selectNode = {
      type: 'SelectStatement',
      columns: [{ type: 'Identifier', name: 'NAME' }],
      from: [],
      where: undefined,
    } as unknown as SelectStatement;

    expect(() => selectExecutor.validateSelect(selectNode)).toThrow('Invalid SELECT: no FROM clause');
  });

  it('should validate valid SELECT statement', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: false,
      columns: [{ type: 'Identifier', name: 'NAME' }],
      from: [{ type: 'Table', name: 'USERS' }],
      where: undefined,
      orderBy: undefined,
      limit: undefined,
    };

    expect(() => selectExecutor.validateSelect(selectNode)).not.toThrow();
  });

  it('should process FROM clause with tables only', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: false,
      columns: [{ type: 'Identifier', name: '*' }],
      from: [
        { type: 'Table', name: 'USERS' },
        { type: 'Table', name: 'ORDERS' },
      ],
      where: undefined,
      orderBy: undefined,
      limit: undefined,
    };

    const result = selectExecutor.executeSelect(selectNode);

    expect(result.from).toHaveLength(2);
    expect(result.from).toEqual([
      { type: 'Table', name: 'USERS' },
      { type: 'Table', name: 'ORDERS' },
    ]);
  });

  it('should handle LEFT JOIN in SELECT', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: false,
      columns: [{ type: 'Identifier', name: '*' }],
      from: [
        { type: 'Table', name: 'USERS' },
        {
          type: 'Join',
          table: { type: 'Table', name: 'ORDERS' },
          joinType: 'LEFT',
          on: {
            type: 'ComparisonExpression',
            left: { type: 'Identifier', name: 'USERS.ID' },
            operator: '=',
            right: { type: 'Identifier', name: 'ORDERS.USER_ID' },
          },
        },
      ] as FromNode[],
      where: undefined,
      orderBy: undefined,
      limit: undefined,
    };

    const result = selectExecutor.executeSelect(selectNode);

    expect(result.from).toEqual([
      { type: 'Table', name: 'USERS' },
      {
        type: 'Join',
        table: { type: 'Table', name: 'ORDERS' },
        joinType: 'LEFT',
        on: {
          type: 'ComparisonExpression',
          left: { type: 'Identifier', name: 'USERS.ID' },
          operator: '=',
          right: { type: 'Identifier', name: 'ORDERS.USER_ID' },
        },
      },
    ]);
  });

  it('should execute SELECT DISTINCT', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: true,
      columns: [{ type: 'Identifier', name: 'NAME' }],
      from: [{ type: 'Table', name: 'USERS' }],
      where: undefined,
      orderBy: undefined,
      limit: undefined,
    };

    const result = selectExecutor.executeSelect(selectNode);

    expect(result.type).toBe('SelectResult');
    expect(result.distinct).toBe(true);
    expect(result.columns).toEqual([{ type: 'Identifier', name: 'NAME' }]);
  });

  it('should execute SELECT without DISTINCT', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: false,
      columns: [{ type: 'Identifier', name: 'EMAIL' }],
      from: [{ type: 'Table', name: 'USERS' }],
      where: undefined,
      orderBy: undefined,
      limit: undefined,
    };

    const result = selectExecutor.executeSelect(selectNode);

    expect(result.distinct).toBe(false);
  });

  it('should execute SELECT DISTINCT with multiple columns', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: true,
      columns: [
        { type: 'Identifier', name: 'NAME' },
        { type: 'Identifier', name: 'EMAIL' },
      ],
      from: [{ type: 'Table', name: 'USERS' }],
      where: undefined,
      orderBy: undefined,
      limit: undefined,
    };

    const result = selectExecutor.executeSelect(selectNode);

    expect(result.distinct).toBe(true);
    expect(result.columns).toHaveLength(2);
  });

  it('should execute SELECT DISTINCT * ', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: true,
      columns: [{ type: 'Identifier', name: '*' }],
      from: [{ type: 'Table', name: 'PRODUCTS' }],
      where: undefined,
      orderBy: undefined,
      limit: undefined,
    };

    const result = selectExecutor.executeSelect(selectNode);

    expect(result.distinct).toBe(true);
    expect(result.columns).toEqual([{ type: 'Identifier', name: '*' }]);
  });

  it('should execute SELECT DISTINCT with WHERE clause', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: true,
      columns: [{ type: 'Identifier', name: 'EMAIL' }],
      from: [{ type: 'Table', name: 'USERS' }],
      where: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'VERIFIED' },
        operator: '=',
        right: { type: 'Literal', valueType: 'number', value: 1 },
      },
      orderBy: undefined,
      limit: undefined,
    };

    const result = selectExecutor.executeSelect(selectNode);

    expect(result.distinct).toBe(true);
    expect(result.where).toBeDefined();
  });

  it('should execute SELECT DISTINCT with ORDER BY', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: true,
      columns: [{ type: 'Identifier', name: 'CATEGORY' }],
      from: [{ type: 'Table', name: 'PRODUCTS' }],
      where: undefined,
      orderBy: {
        type: 'OrderByStatement',
        items: [{ column: { type: 'Identifier', name: 'CATEGORY' }, direction: 'ASC' }],
      },
      limit: undefined,
    };

    const result = selectExecutor.executeSelect(selectNode);

    expect(result.distinct).toBe(true);
    expect(result.orderBy).toBeDefined();
  });

  it('should execute SELECT DISTINCT with LIMIT', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: true,
      columns: [{ type: 'Identifier', name: 'COUNTRY' }],
      from: [{ type: 'Table', name: 'USERS' }],
      where: undefined,
      orderBy: undefined,
      limit: {
        type: 'LimitOffset',
        limit: 10,
        offset: undefined,
      },
    };

    const result = selectExecutor.executeSelect(selectNode);

    expect(result.distinct).toBe(true);
    expect(result.limit).toEqual({
      type: 'LimitOffset',
      limit: 10,
      offset: undefined,
    });
  });

  it('should execute SELECT DISTINCT with all clauses', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: true,
      columns: [{ type: 'Identifier', name: 'DEPARTMENT' }],
      from: [{ type: 'Table', name: 'EMPLOYEES' }],
      where: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'ACTIVE' },
        operator: '=',
        right: { type: 'Literal', valueType: 'number', value: 1 },
      },
      orderBy: {
        type: 'OrderByStatement',
        items: [{ column: { type: 'Identifier', name: 'DEPARTMENT' }, direction: 'DESC' }],
      },
      limit: {
        type: 'LimitOffset',
        limit: 50,
        offset: 5,
      },
    };

    const result = selectExecutor.executeSelect(selectNode);

    expect(result.distinct).toBe(true);
    expect(result.where).toBeDefined();
    expect(result.orderBy).toBeDefined();
    expect(result.limit).toBeDefined();
  });

  it('should preserve distinct flag in result', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: true,
      columns: [{ type: 'Identifier', name: 'ID' }],
      from: [{ type: 'Table', name: 'TRANSACTIONS' }],
      where: undefined,
      orderBy: undefined,
      limit: undefined,
    };

    const result = selectExecutor.executeSelect(selectNode);

    expect(result.distinct).toBe(true);
    expect(result.type).toBe('SelectResult');
  });

  it('should execute SELECT with IN expression in WHERE clause', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: false,
      columns: [{ type: 'Identifier', name: 'NAME' }],
      from: [{ type: 'Table', name: 'USERS' }],
      where: {
        type: 'InExpression',
        left: { type: 'Identifier', name: 'ID' },
        values: [
          { type: 'Literal', valueType: 'number', value: 1 },
          { type: 'Literal', valueType: 'number', value: 2 },
          { type: 'Literal', valueType: 'number', value: 3 },
        ],
      },
      orderBy: undefined,
      limit: undefined,
    };

    const result = selectExecutor.executeSelect(selectNode);

    expect(result.where).toEqual({
      type: 'InExpression',
      left: { type: 'Identifier', name: 'ID' },
      values: [
        { type: 'Literal', valueType: 'number', value: 1 },
        { type: 'Literal', valueType: 'number', value: 2 },
        { type: 'Literal', valueType: 'number', value: 3 },
      ],
    });
  });

  it('should apply DISTINCT to result rows', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: true,
      columns: [{ type: 'Identifier', name: 'NAME' }],
      from: [{ type: 'Table', name: 'USERS' }],
      where: undefined,
      orderBy: undefined,
      limit: undefined,
    };

    const result = selectExecutor.executeSelect(selectNode, [{ NAME: 'Alice' }, { NAME: 'Alice' }, { NAME: 'Bob' }]);

    expect(result.rows).toEqual([{ NAME: 'Alice' }, { NAME: 'Bob' }]);
  });

  it('should apply ORDER BY to result rows', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: false,
      columns: [{ type: 'Identifier', name: 'AGE' }],
      from: [{ type: 'Table', name: 'USERS' }],
      where: undefined,
      orderBy: {
        type: 'OrderByStatement',
        items: [{ column: { type: 'Identifier', name: 'AGE' }, direction: 'DESC' }],
      },
      limit: undefined,
    };

    const result = selectExecutor.executeSelect(selectNode, [{ AGE: 10 }, { AGE: 30 }, { AGE: 20 }]);

    expect(result.rows).toEqual([{ AGE: 30 }, { AGE: 20 }, { AGE: 10 }]);
  });

  it('should apply LIMIT and OFFSET to result rows', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: false,
      columns: [{ type: 'Identifier', name: 'ID' }],
      from: [{ type: 'Table', name: 'USERS' }],
      where: undefined,
      orderBy: undefined,
      limit: {
        type: 'LimitOffset',
        limit: 2,
        offset: 1,
      },
    };

    const result = selectExecutor.executeSelect(selectNode, [{ ID: 1 }, { ID: 2 }, { ID: 3 }, { ID: 4 }]);

    expect(result.rows).toEqual([{ ID: 2 }, { ID: 3 }]);
  });

  it('should throw when mixing aggregate and non-aggregate columns without GROUP BY', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: false,
      columns: [
        { type: 'Identifier', name: 'CITY' },
        {
          type: 'AggregateFunction',
          functionName: 'COUNT',
          argument: { type: 'Wildcard', value: '*' },
        },
      ],
      from: [{ type: 'Table', name: 'USERS' }],
      where: undefined,
      orderBy: undefined,
      limit: undefined,
    };

    expect(() => selectExecutor.executeSelect(selectNode)).toThrow(
      'Invalid SELECT: cannot mix aggregate and non-aggregate columns without GROUP BY',
    );
  });

  it('should execute mixed aggregate and non-aggregate columns with GROUP BY', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: false,
      columns: [
        { type: 'Identifier', name: 'CITY' },
        {
          type: 'AggregateFunction',
          functionName: 'COUNT',
          argument: { type: 'Wildcard', value: '*' },
        },
      ],
      groupBy: [{ type: 'Identifier', name: 'CITY' }],
      from: [{ type: 'Table', name: 'USERS' }],
      where: undefined,
      orderBy: undefined,
      limit: undefined,
    };

    const result = selectExecutor.executeSelect(selectNode, [{ CITY: 'AMS' }, { CITY: 'AMS' }, { CITY: 'RTM' }]);

    expect(result.rows).toEqual([
      { CITY: 'AMS', 'COUNT(*)': 2 },
      { CITY: 'RTM', 'COUNT(*)': 1 },
    ]);
  });

  it('should execute aggregate-only GROUP BY queries', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: false,
      columns: [
        {
          type: 'AggregateFunction',
          functionName: 'COUNT',
          argument: { type: 'Wildcard', value: '*' },
        },
      ],
      groupBy: [{ type: 'Identifier', name: 'CITY' }],
      from: [{ type: 'Table', name: 'USERS' }],
      where: undefined,
      orderBy: undefined,
      limit: undefined,
    };

    const result = selectExecutor.executeSelect(selectNode, [{ CITY: 'AMS' }, { CITY: 'AMS' }, { CITY: 'RTM' }]);

    expect(result.rows).toEqual([{ 'COUNT(*)': 2 }, { 'COUNT(*)': 1 }]);
  });

  it('should execute GROUP BY with HAVING clause', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: false,
      columns: [
        { type: 'Identifier', name: 'CITY' },
        {
          type: 'AggregateFunction',
          functionName: 'COUNT',
          argument: { type: 'Wildcard', value: '*' },
        },
      ],
      groupBy: [{ type: 'Identifier', name: 'CITY' }],
      having: {
        type: 'ComparisonExpression',
        left: {
          type: 'AggregateFunction',
          functionName: 'COUNT',
          argument: { type: 'Wildcard', value: '*' },
        },
        operator: '>',
        right: { type: 'Literal', valueType: 'number', value: 1 },
      },
      from: [{ type: 'Table', name: 'USERS' }],
      where: undefined,
      orderBy: undefined,
      limit: undefined,
    };

    const result = selectExecutor.executeSelect(selectNode, [{ CITY: 'AMS' }, { CITY: 'AMS' }, { CITY: 'RTM' }]);

    expect(result.rows).toEqual([{ CITY: 'AMS', 'COUNT(*)': 2 }]);
  });

  it('should execute GROUP BY with ORDER BY and LIMIT', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: false,
      columns: [
        { type: 'Identifier', name: 'CITY' },
        {
          type: 'AggregateFunction',
          functionName: 'COUNT',
          argument: { type: 'Wildcard', value: '*' },
        },
      ],
      groupBy: [{ type: 'Identifier', name: 'CITY' }],
      from: [{ type: 'Table', name: 'USERS' }],
      where: undefined,
      orderBy: {
        type: 'OrderByStatement',
        items: [{ column: { type: 'Identifier', name: 'CITY' }, direction: 'DESC' }],
      },
      limit: {
        type: 'LimitOffset',
        limit: 1,
        offset: 0,
      },
    };

    const result = selectExecutor.executeSelect(selectNode, [{ CITY: 'AMS' }, { CITY: 'RTM' }, { CITY: 'RTM' }]);

    expect(result.rows).toEqual([{ CITY: 'RTM', 'COUNT(*)': 2 }]);
  });

  it('should throw when selected non-aggregate column is not in GROUP BY', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: false,
      columns: [
        { type: 'Identifier', name: 'CITY' },
        { type: 'Identifier', name: 'COUNTRY' },
        {
          type: 'AggregateFunction',
          functionName: 'COUNT',
          argument: { type: 'Wildcard', value: '*' },
        },
      ],
      groupBy: [{ type: 'Identifier', name: 'CITY' }],
      from: [{ type: 'Table', name: 'USERS' }],
      where: undefined,
      orderBy: undefined,
      limit: undefined,
    };

    expect(() => selectExecutor.executeSelect(selectNode)).toThrow(
      'Invalid SELECT: non-aggregate column COUNTRY must appear in GROUP BY',
    );
  });

  it('should defensively reject wildcard argument for non-COUNT aggregate', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: false,
      columns: [
        {
          type: 'AggregateFunction',
          functionName: 'SUM',
          argument: { type: 'Wildcard', value: '*' },
        },
      ],
      from: [{ type: 'Table', name: 'USERS' }],
      where: undefined,
      orderBy: undefined,
      limit: undefined,
    };

    expect(() => selectExecutor.executeSelect(selectNode)).toThrow('Only COUNT supports wildcard argument');
  });

  it('should compute aggregate rows for COUNT and SUM with WHERE filter', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: false,
      columns: [
        {
          type: 'AggregateFunction',
          functionName: 'COUNT',
          argument: { type: 'Wildcard', value: '*' },
        },
        {
          type: 'AggregateFunction',
          functionName: 'SUM',
          argument: { type: 'Identifier', name: 'AGE' },
        },
      ],
      from: [{ type: 'Table', name: 'USERS' }],
      where: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'ACTIVE' },
        operator: '=',
        right: { type: 'Literal', valueType: 'number', value: 1 },
      },
      orderBy: undefined,
      limit: undefined,
    };

    const result = selectExecutor.executeSelect(selectNode, [
      { ACTIVE: 1, AGE: 20 },
      { ACTIVE: 0, AGE: 40 },
      { ACTIVE: 1, AGE: 30 },
    ]);

    expect(result.rows).toEqual([
      {
        'COUNT(*)': 2,
        'SUM(AGE)': 50,
      },
    ]);
  });

  it('should compute AVG, MIN and MAX over identifier values', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: false,
      columns: [
        {
          type: 'AggregateFunction',
          functionName: 'AVG',
          argument: { type: 'Identifier', name: 'AGE' },
        },
        {
          type: 'AggregateFunction',
          functionName: 'MIN',
          argument: { type: 'Identifier', name: 'AGE' },
        },
        {
          type: 'AggregateFunction',
          functionName: 'MAX',
          argument: { type: 'Identifier', name: 'AGE' },
        },
      ],
      from: [{ type: 'Table', name: 'USERS' }],
      where: undefined,
      orderBy: undefined,
      limit: undefined,
    };

    const result = selectExecutor.executeSelect(selectNode, [{ AGE: 10 }, { AGE: 20 }, { AGE: 30 }]);

    expect(result.rows).toEqual([
      {
        'AVG(AGE)': 20,
        'MIN(AGE)': 10,
        'MAX(AGE)': 30,
      },
    ]);
  });

  it('should return COUNT(identifier) as non-null count', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: false,
      columns: [
        {
          type: 'AggregateFunction',
          functionName: 'COUNT',
          argument: { type: 'Identifier', name: 'AGE' },
        },
      ],
      from: [{ type: 'Table', name: 'USERS' }],
      where: undefined,
      orderBy: undefined,
      limit: undefined,
    };

    const result = selectExecutor.executeSelect(selectNode, [{ AGE: 10 }, { AGE: null }, {}, { AGE: 20 }]);

    expect(result.rows).toEqual([
      {
        'COUNT(AGE)': 2,
      },
    ]);
  });

  it('should throw when SUM receives non-numeric values', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: false,
      columns: [
        {
          type: 'AggregateFunction',
          functionName: 'SUM',
          argument: { type: 'Identifier', name: 'AGE' },
        },
      ],
      from: [{ type: 'Table', name: 'USERS' }],
      where: undefined,
      orderBy: undefined,
      limit: undefined,
    };

    expect(() => selectExecutor.executeSelect(selectNode, [{ AGE: 'twenty' }])).toThrow(
      'SUM requires numeric values for AGE',
    );
  });

  it('should apply NOT expression in aggregate WHERE filter', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: false,
      columns: [
        {
          type: 'AggregateFunction',
          functionName: 'COUNT',
          argument: { type: 'Wildcard', value: '*' },
        },
      ],
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
      orderBy: undefined,
      limit: undefined,
    };

    const result = selectExecutor.executeSelect(selectNode, [{ ACTIVE: 1 }, { ACTIVE: 0 }, { ACTIVE: 0 }]);

    expect(result.rows).toEqual([{ 'COUNT(*)': 2 }]);
  });

  it('should apply NULL check expression in aggregate WHERE filter', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: false,
      columns: [
        {
          type: 'AggregateFunction',
          functionName: 'COUNT',
          argument: { type: 'Wildcard', value: '*' },
        },
      ],
      from: [{ type: 'Table', name: 'USERS' }],
      where: {
        type: 'NullCheckExpression',
        left: { type: 'Identifier', name: 'DELETED_AT' },
        isNegated: false,
      },
      orderBy: undefined,
      limit: undefined,
    };

    const result = selectExecutor.executeSelect(selectNode, [{ DELETED_AT: null }, { DELETED_AT: 12345 }, {}]);

    expect(result.rows).toEqual([{ 'COUNT(*)': 2 }]);
  });

  it('should resolve nested identifiers case-insensitively in aggregates', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: false,
      columns: [
        {
          type: 'AggregateFunction',
          functionName: 'SUM',
          argument: { type: 'Identifier', name: 'orders.total' },
        },
      ],
      from: [{ type: 'Table', name: 'USERS' }],
      where: undefined,
      orderBy: undefined,
      limit: undefined,
    };

    const result = selectExecutor.executeSelect(selectNode, [{ ORDERS: { TOTAL: 10 } }, { orders: { total: 15 } }]);

    expect(result.rows).toEqual([{ 'SUM(orders.total)': 25 }]);
  });

  it('should throw for invalid arithmetic operands in WHERE evaluation', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: false,
      columns: [
        {
          type: 'AggregateFunction',
          functionName: 'COUNT',
          argument: { type: 'Wildcard', value: '*' },
        },
      ],
      from: [{ type: 'Table', name: 'USERS' }],
      where: {
        type: 'ComparisonExpression',
        left: {
          type: 'ArithmeticExpression',
          operator: '+',
          left: { type: 'Identifier', name: 'AGE' },
          right: { type: 'Literal', valueType: 'number', value: 1 },
        },
        operator: '>',
        right: { type: 'Literal', valueType: 'number', value: 10 },
      },
      orderBy: undefined,
      limit: undefined,
    };

    expect(() => selectExecutor.executeSelect(selectNode, [{ AGE: 'not-a-number' }])).toThrow(
      'Invalid arithmetic operands: not-a-number + 1',
    );
  });

  it('should throw for division by zero in WHERE evaluation', () => {
    const selectNode: SelectStatement = {
      type: 'SelectStatement',
      distinct: false,
      columns: [
        {
          type: 'AggregateFunction',
          functionName: 'COUNT',
          argument: { type: 'Wildcard', value: '*' },
        },
      ],
      from: [{ type: 'Table', name: 'USERS' }],
      where: {
        type: 'ComparisonExpression',
        left: {
          type: 'ArithmeticExpression',
          operator: '/',
          left: { type: 'Identifier', name: 'AGE' },
          right: { type: 'Literal', valueType: 'number', value: 0 },
        },
        operator: '>',
        right: { type: 'Literal', valueType: 'number', value: 10 },
      },
      orderBy: undefined,
      limit: undefined,
    };

    expect(() => selectExecutor.executeSelect(selectNode, [{ AGE: 10 }])).toThrow('Division by zero');
  });
});

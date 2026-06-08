//@author Tijn Gommers
// @date 2026-03-25

import { Interpreter } from '../../src/interpreter/interpreter.mjs';
import { describe, it, expect } from 'vitest';
import type {
  InsertResult,
  QueryExecutionResult,
  SelectResult,
  UpdateResult,
} from '../../src/types/execution-results.mjs';

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

function asUpdateResult(result: QueryExecutionResult): UpdateResult {
  if (result.type !== 'UpdateResult') {
    throw new Error(`Expected UpdateResult but got ${result.type}`);
  }

  return result;
}

describe('Interpreter', () => {
  it('should execute a simple SELECT query', async () => {
    const query = "SELECT name, age FROM users WHERE age > 30 AND city = 'New York'";
    const interpreter = new Interpreter(query);
    const result = await interpreter.execute();
    expect(result).toEqual({
      type: 'SelectResult',
      distinct: false,
      columns: [
        { type: 'Identifier', name: 'NAME' },
        { type: 'Identifier', name: 'AGE' },
      ],
      from: [{ type: 'Table', name: 'USERS' }],
      where: {
        type: 'LogicalExpression',
        operator: 'AND',
        left: {
          type: 'ComparisonExpression',
          operator: '>',
          left: { type: 'Identifier', name: 'AGE' },
          right: { type: 'Literal', valueType: 'number', value: 30 },
        },
        right: {
          type: 'ComparisonExpression',
          operator: '=',
          left: { type: 'Identifier', name: 'CITY' },
          right: { type: 'Literal', valueType: 'string', value: 'New York' },
        },
      },
      orderBy: undefined,
      limit: undefined,
    });
  });

  it('should execute a SELECT query with parenthesized WHERE expression', async () => {
    const query = "SELECT name FROM users WHERE (age > 18 AND city = 'AMS') OR status = 'active'";
    const interpreter = new Interpreter(query);
    const result = await interpreter.execute();

    expect(result).toEqual({
      type: 'SelectResult',
      distinct: false,
      columns: [{ type: 'Identifier', name: 'NAME' }],
      from: [{ type: 'Table', name: 'USERS' }],
      where: {
        type: 'LogicalExpression',
        operator: 'OR',
        left: {
          type: 'LogicalExpression',
          operator: 'AND',
          left: {
            type: 'ComparisonExpression',
            operator: '>',
            left: { type: 'Identifier', name: 'AGE' },
            right: { type: 'Literal', valueType: 'number', value: 18 },
          },
          right: {
            type: 'ComparisonExpression',
            operator: '=',
            left: { type: 'Identifier', name: 'CITY' },
            right: { type: 'Literal', valueType: 'string', value: 'AMS' },
          },
        },
        right: {
          type: 'ComparisonExpression',
          operator: '=',
          left: { type: 'Identifier', name: 'STATUS' },
          right: { type: 'Literal', valueType: 'string', value: 'active' },
        },
      },
      orderBy: undefined,
      limit: undefined,
    });
  });

  it('should execute a SELECT query with arithmetic comparison in WHERE clause', async () => {
    const query = 'SELECT name FROM users WHERE age + 2 * score > 100';
    const interpreter = new Interpreter(query);
    const result = await interpreter.execute();

    expect(result).toEqual({
      type: 'SelectResult',
      distinct: false,
      columns: [{ type: 'Identifier', name: 'NAME' }],
      from: [{ type: 'Table', name: 'USERS' }],
      where: {
        type: 'ComparisonExpression',
        left: {
          type: 'ArithmeticExpression',
          operator: '+',
          left: { type: 'Identifier', name: 'AGE' },
          right: {
            type: 'ArithmeticExpression',
            operator: '*',
            left: { type: 'Literal', valueType: 'number', value: 2 },
            right: { type: 'Identifier', name: 'SCORE' },
          },
        },
        operator: '>',
        right: { type: 'Literal', valueType: 'number', value: 100 },
      },
      orderBy: undefined,
      limit: undefined,
    });
  });

  it('should execute a simple DELETE query', async () => {
    const query = 'DELETE FROM users WHERE id = 10';
    const interpreter = new Interpreter(query);
    const result = await interpreter.execute();
    expect(result).toEqual({
      type: 'DeleteResult',
      from: [{ type: 'Table', name: 'USERS' }],
      where: {
        type: 'ComparisonExpression',
        operator: '=',
        left: { type: 'Identifier', name: 'ID' },
        right: { type: 'Literal', valueType: 'number', value: 10 },
      },
    });
  });

  it('should execute a SELECT query with IS NOT NULL', async () => {
    const query = 'SELECT name FROM users WHERE city IS NOT NULL';
    const interpreter = new Interpreter(query);
    const result = await interpreter.execute();

    expect(result).toEqual({
      type: 'SelectResult',
      distinct: false,
      columns: [{ type: 'Identifier', name: 'NAME' }],
      from: [{ type: 'Table', name: 'USERS' }],
      where: {
        type: 'NullCheckExpression',
        left: { type: 'Identifier', name: 'CITY' },
        isNegated: true,
      },
      orderBy: undefined,
      limit: undefined,
    });
  });

  it('should execute a SELECT query with ORDER BY multiple columns', async () => {
    const query = 'SELECT name FROM users ORDER BY age DESC, city';
    const interpreter = new Interpreter(query);
    const result = await interpreter.execute();

    expect(result).toEqual({
      type: 'SelectResult',
      distinct: false,
      columns: [{ type: 'Identifier', name: 'NAME' }],
      from: [{ type: 'Table', name: 'USERS' }],
      where: undefined,
      orderBy: {
        type: 'OrderByStatement',
        items: [
          { column: { type: 'Identifier', name: 'AGE' }, direction: 'DESC' },
          { column: { type: 'Identifier', name: 'CITY' }, direction: 'ASC' },
        ],
      },
      limit: undefined,
    });
  });

  it('should execute a SELECT with CROSS JOIN', async () => {
    const query = 'SELECT * FROM users CROSS JOIN orders';
    const interpreter = new Interpreter(query);
    const result = await interpreter.execute();

    expect(result).toEqual({
      type: 'SelectResult',
      distinct: false,
      columns: [{ type: 'Identifier', name: '*' }],
      from: [
        { type: 'Table', name: 'USERS' },
        {
          type: 'Join',
          table: { type: 'Table', name: 'ORDERS' },
          joinType: 'CROSS',
        },
      ],
      where: undefined,
      orderBy: undefined,
      limit: undefined,
    });
  });

  it('should execute a SELECT with comma-separated tables', async () => {
    const query = 'SELECT * FROM users, orders, products';
    const interpreter = new Interpreter(query);
    const result = await interpreter.execute();

    expect(result).toEqual({
      type: 'SelectResult',
      distinct: false,
      columns: [{ type: 'Identifier', name: '*' }],
      from: [
        { type: 'Table', name: 'USERS' },
        { type: 'Table', name: 'ORDERS' },
        { type: 'Table', name: 'PRODUCTS' },
      ],
      where: undefined,
      orderBy: undefined,
      limit: undefined,
    });
  });

  it('should execute a DELETE with multiple comma-separated tables', async () => {
    const query = 'DELETE FROM users, orders WHERE active = 1';
    const interpreter = new Interpreter(query);
    const result = await interpreter.execute();

    expect(result).toEqual({
      type: 'DeleteResult',
      from: [
        { type: 'Table', name: 'USERS' },
        { type: 'Table', name: 'ORDERS' },
      ],
      where: {
        type: 'ComparisonExpression',
        operator: '=',
        left: { type: 'Identifier', name: 'ACTIVE' },
        right: { type: 'Literal', valueType: 'number', value: 1 },
      },
    });
  });

  it('should execute a SELECT with JOIN ... ON', async () => {
    const query = 'SELECT * FROM users JOIN orders ON users.id = orders.user_id';
    const interpreter = new Interpreter(query);
    const result = await interpreter.execute();

    expect(result).toEqual({
      type: 'SelectResult',
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
      ],
      where: undefined,
      orderBy: undefined,
      limit: undefined,
    });
  });

  it('should execute a SELECT with INNER JOIN ... ON', async () => {
    const query = 'SELECT * FROM users INNER JOIN orders ON users.id = orders.user_id';
    const interpreter = new Interpreter(query);
    const result = await interpreter.execute();

    expect(result.type).toBe('SelectResult');
    expect(asSelectResult(result).from[1]).toEqual({
      type: 'Join',
      table: { type: 'Table', name: 'ORDERS' },
      joinType: 'INNER',
      on: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'USERS.ID' },
        operator: '=',
        right: { type: 'Identifier', name: 'ORDERS.USER_ID' },
      },
    });
  });

  it('should execute a SELECT with LEFT JOIN ... ON', async () => {
    const query = 'SELECT * FROM users LEFT JOIN orders ON users.id = orders.user_id';
    const interpreter = new Interpreter(query);
    const result = await interpreter.execute();

    expect(result.type).toBe('SelectResult');
    expect(asSelectResult(result).from[1]).toEqual({
      type: 'Join',
      table: { type: 'Table', name: 'ORDERS' },
      joinType: 'LEFT',
      on: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'USERS.ID' },
        operator: '=',
        right: { type: 'Identifier', name: 'ORDERS.USER_ID' },
      },
    });
  });

  it('should execute a SELECT with RIGHT JOIN ... ON', async () => {
    const query = 'SELECT * FROM users RIGHT JOIN orders ON users.id = orders.user_id';
    const interpreter = new Interpreter(query);
    const result = await interpreter.execute();

    expect(result.type).toBe('SelectResult');
    expect(asSelectResult(result).from[1]).toEqual({
      type: 'Join',
      table: { type: 'Table', name: 'ORDERS' },
      joinType: 'RIGHT',
      on: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'USERS.ID' },
        operator: '=',
        right: { type: 'Identifier', name: 'ORDERS.USER_ID' },
      },
    });
  });

  it('should execute a SELECT with LIMIT clause', async () => {
    const query = 'SELECT * FROM users LIMIT 10';
    const interpreter = new Interpreter(query);
    const result = await interpreter.execute();

    expect(result.type).toBe('SelectResult');
    expect(asSelectResult(result).limit).toEqual({
      type: 'LimitOffset',
      limit: 10,
      offset: undefined,
    });
  });

  it('should execute a SELECT with LIMIT and OFFSET', async () => {
    const query = 'SELECT * FROM users LIMIT 10 OFFSET 5';
    const interpreter = new Interpreter(query);
    const result = await interpreter.execute();

    expect(result.type).toBe('SelectResult');
    expect(asSelectResult(result).limit).toEqual({
      type: 'LimitOffset',
      limit: 10,
      offset: 5,
    });
  });

  it('should execute a SELECT with LEFT OUTER JOIN ... ON', async () => {
    const query = 'SELECT * FROM users LEFT OUTER JOIN orders ON users.id = orders.user_id';
    const interpreter = new Interpreter(query);
    const result = await interpreter.execute();

    expect(result.type).toBe('SelectResult');
    expect(asSelectResult(result).from[1]).toEqual({
      type: 'Join',
      table: { type: 'Table', name: 'ORDERS' },
      joinType: 'LEFT',
      on: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'USERS.ID' },
        operator: '=',
        right: { type: 'Identifier', name: 'ORDERS.USER_ID' },
      },
    });
  });

  it('should execute a SELECT with RIGHT OUTER JOIN ... ON', async () => {
    const query = 'SELECT * FROM users RIGHT OUTER JOIN orders ON users.id = orders.user_id';
    const interpreter = new Interpreter(query);
    const result = await interpreter.execute();

    expect(result.type).toBe('SelectResult');
    expect(asSelectResult(result).from[1]).toEqual({
      type: 'Join',
      table: { type: 'Table', name: 'ORDERS' },
      joinType: 'RIGHT',
      on: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'USERS.ID' },
        operator: '=',
        right: { type: 'Identifier', name: 'ORDERS.USER_ID' },
      },
    });
  });

  it('should execute a SELECT with multiple JOINs', async () => {
    const query =
      'SELECT * FROM users JOIN orders ON users.id = orders.user_id JOIN products ON orders.product_id = products.id';
    const interpreter = new Interpreter(query);
    const result = await interpreter.execute();

    expect(result.type).toBe('SelectResult');
    expect(asSelectResult(result).from.length).toBe(3);
    expect(asSelectResult(result).from[0]).toEqual({ type: 'Table', name: 'USERS' });
    expect(asSelectResult(result).from[1]).toEqual({
      type: 'Join',
      table: { type: 'Table', name: 'ORDERS' },
      joinType: 'INNER',
      on: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'USERS.ID' },
        operator: '=',
        right: { type: 'Identifier', name: 'ORDERS.USER_ID' },
      },
    });
    expect(asSelectResult(result).from[2]).toEqual({
      type: 'Join',
      table: { type: 'Table', name: 'PRODUCTS' },
      joinType: 'INNER',
      on: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'ORDERS.PRODUCT_ID' },
        operator: '=',
        right: { type: 'Identifier', name: 'PRODUCTS.ID' },
      },
    });
  });

  it('should execute a SELECT with JOIN and WHERE clause', async () => {
    const query = "SELECT * FROM users JOIN orders ON users.id = orders.user_id WHERE orders.status = 'completed'";
    const interpreter = new Interpreter(query);
    const result = await interpreter.execute();

    expect(result.type).toBe('SelectResult');
    expect(asSelectResult(result).from[1]).toEqual({
      type: 'Join',
      table: { type: 'Table', name: 'ORDERS' },
      joinType: 'INNER',
      on: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'USERS.ID' },
        operator: '=',
        right: { type: 'Identifier', name: 'ORDERS.USER_ID' },
      },
    });
    expect(asSelectResult(result).where).toEqual({
      type: 'ComparisonExpression',
      operator: '=',
      left: { type: 'Identifier', name: 'ORDERS.STATUS' },
      right: { type: 'Literal', valueType: 'string', value: 'completed' },
    });
  });

  it('should execute a SELECT with JOIN, WHERE and ORDER BY', async () => {
    const query =
      'SELECT * FROM users JOIN orders ON users.id = orders.user_id WHERE users.active = 1 ORDER BY orders.created_at DESC';
    const interpreter = new Interpreter(query);
    const result = await interpreter.execute();

    expect(result.type).toBe('SelectResult');
    expect(asSelectResult(result).from[0]).toEqual({ type: 'Table', name: 'USERS' });
    expect(asSelectResult(result).from[1].type).toBe('Join');
    expect(asSelectResult(result).where).toBeDefined();
    expect(asSelectResult(result).orderBy).toBeDefined();
    expect(asSelectResult(result).orderBy?.items).toEqual([
      { column: { type: 'Identifier', name: 'ORDERS.CREATED_AT' }, direction: 'DESC' },
    ]);
  });

  it('should execute SELECT DISTINCT', async () => {
    const query = 'SELECT DISTINCT name FROM users';
    const interpreter = new Interpreter(query);
    const result = await interpreter.execute();

    expect(result.type).toBe('SelectResult');
    expect(asSelectResult(result).distinct).toBe(true);
    expect(asSelectResult(result).columns).toEqual([{ type: 'Identifier', name: 'NAME' }]);
  });

  it('should execute SELECT without DISTINCT', async () => {
    const query = 'SELECT name FROM users';
    const interpreter = new Interpreter(query);
    const result = await interpreter.execute();

    expect(result.type).toBe('SelectResult');
    expect(asSelectResult(result).distinct).toBe(false);
  });

  it('should execute SELECT DISTINCT with multiple columns', async () => {
    const query = 'SELECT DISTINCT name, email FROM users';
    const interpreter = new Interpreter(query);
    const result = await interpreter.execute();

    expect(result.type).toBe('SelectResult');
    expect(asSelectResult(result).distinct).toBe(true);
    expect(asSelectResult(result).columns).toEqual([
      { type: 'Identifier', name: 'NAME' },
      { type: 'Identifier', name: 'EMAIL' },
    ]);
  });

  it('should execute SELECT DISTINCT * FROM users', async () => {
    const query = 'SELECT DISTINCT * FROM users';
    const interpreter = new Interpreter(query);
    const result = await interpreter.execute();

    expect(result.type).toBe('SelectResult');
    expect(asSelectResult(result).distinct).toBe(true);
    expect(asSelectResult(result).columns).toEqual([{ type: 'Identifier', name: '*' }]);
  });

  it('should execute SELECT DISTINCT with WHERE clause', async () => {
    const query = 'SELECT DISTINCT email FROM users WHERE active = 1';
    const interpreter = new Interpreter(query);
    const result = await interpreter.execute();

    expect(result.type).toBe('SelectResult');
    expect(asSelectResult(result).distinct).toBe(true);
    expect(asSelectResult(result).where).toBeDefined();
  });

  it('should execute SELECT DISTINCT with ORDER BY', async () => {
    const query = 'SELECT DISTINCT name FROM users ORDER BY name DESC';
    const interpreter = new Interpreter(query);
    const result = await interpreter.execute();

    expect(result.type).toBe('SelectResult');
    expect(asSelectResult(result).distinct).toBe(true);
    expect(asSelectResult(result).orderBy?.items).toEqual([
      { column: { type: 'Identifier', name: 'NAME' }, direction: 'DESC' },
    ]);
  });

  it('should execute SELECT DISTINCT with LIMIT', async () => {
    const query = 'SELECT DISTINCT category FROM products LIMIT 5';
    const interpreter = new Interpreter(query);
    const result = await interpreter.execute();

    expect(result.type).toBe('SelectResult');
    expect(asSelectResult(result).distinct).toBe(true);
    expect(asSelectResult(result).limit?.limit).toBe(5);
  });

  it('should execute SELECT DISTINCT with WHERE, ORDER BY and LIMIT', async () => {
    const query = 'SELECT DISTINCT email FROM users WHERE verified = 1 ORDER BY email ASC LIMIT 100';
    const interpreter = new Interpreter(query);
    const result = await interpreter.execute();

    expect(result.type).toBe('SelectResult');
    expect(asSelectResult(result).distinct).toBe(true);
    expect(asSelectResult(result).where).toBeDefined();
    expect(asSelectResult(result).orderBy).toBeDefined();
    expect(asSelectResult(result).limit).toBeDefined();
  });

  it('should execute SELECT DISTINCT with JOIN', async () => {
    const query = 'SELECT DISTINCT users.name FROM users JOIN orders ON users.id = orders.user_id';
    const interpreter = new Interpreter(query);
    const result = await interpreter.execute();

    expect(result.type).toBe('SelectResult');
    expect(asSelectResult(result).distinct).toBe(true);
    expect(asSelectResult(result).from).toHaveLength(2);
  });

  it('should execute SELECT with IN operator in WHERE clause', async () => {
    const query = 'SELECT name FROM users WHERE id IN (1, 2, 3)';
    const interpreter = new Interpreter(query);
    const result = await interpreter.execute();

    expect(result.type).toBe('SelectResult');
    expect(asSelectResult(result).distinct).toBe(false);
    expect(asSelectResult(result).where).toEqual({
      type: 'InExpression',
      left: { type: 'Identifier', name: 'ID' },
      values: [
        { type: 'Literal', valueType: 'number', value: 1 },
        { type: 'Literal', valueType: 'number', value: 2 },
        { type: 'Literal', valueType: 'number', value: 3 },
      ],
    });
  });

  it('should execute SELECT with aggregate columns and return computed aggregate rows', async () => {
    const query = 'SELECT COUNT(*), AVG(age) FROM users';
    const interpreter = new Interpreter(query);
    const result = await interpreter.execute();

    expect(result.type).toBe('SelectResult');
    expect(asSelectResult(result).columns).toEqual([
      {
        type: 'AggregateFunction',
        functionName: 'COUNT',
        argument: { type: 'Wildcard', value: '*' },
      },
      {
        type: 'AggregateFunction',
        functionName: 'AVG',
        argument: { type: 'Identifier', name: 'AGE' },
      },
    ]);
    expect(asSelectResult(result).rows).toEqual([
      {
        'COUNT(*)': 0,
        'AVG(AGE)': null,
      },
    ]);
  });

  it('should execute SELECT with SUM and MAX aggregates on empty input as null', async () => {
    const query = 'SELECT SUM(age), MAX(age) FROM users';
    const interpreter = new Interpreter(query);
    const result = await interpreter.execute();

    expect(asSelectResult(result).rows).toEqual([
      {
        'SUM(AGE)': null,
        'MAX(AGE)': null,
      },
    ]);
  });

  it('should throw when mixing aggregate and non-aggregate columns without GROUP BY', () => {
    const query = 'SELECT city, COUNT(*) FROM users';
    const interpreter = new Interpreter(query);

    expect(() => interpreter.execute()).toThrow(
      'Invalid SELECT: cannot mix aggregate and non-aggregate columns without GROUP BY',
    );
  });

  it('should execute grouped aggregate queries', async () => {
    const query = 'SELECT city, COUNT(*) FROM users GROUP BY city';
    const interpreter = new Interpreter(query);

    const result = await interpreter.execute();

    expect(result.type).toBe('SelectResult');
    expect(asSelectResult(result).rows).toEqual([]);
  });

  it('should execute INSERT and return inserted row payload', async () => {
    const query = "INSERT INTO users (id, name, age) VALUES (1, 'Alice', 30)";
    const interpreter = new Interpreter(query);
    const result = await interpreter.execute();

    expect(result).toEqual({
      type: 'InsertResult',
      table: { type: 'Table', name: 'USERS' },
      columns: [
        { type: 'Identifier', name: 'ID' },
        { type: 'Identifier', name: 'NAME' },
        { type: 'Identifier', name: 'AGE' },
      ],
      values: [
        [
          { type: 'Literal', valueType: 'number', value: 1 },
          { type: 'Literal', valueType: 'string', value: 'Alice' },
          { type: 'Literal', valueType: 'number', value: 30 },
        ],
      ],
      insertedCount: 1,
      rows: [{ ID: 1, NAME: 'Alice', AGE: 30 }],
    });
  });

  it('should throw for unknown AST node type during dispatch', () => {
    const interpreter = new Interpreter('SELECT id FROM users');
    const interpreterWithAst = interpreter as unknown as { ast: unknown };
    interpreterWithAst.ast = { type: 'UnknownStatement' };

    expect(() => interpreter.execute()).toThrow('Unknown AST node');
  });

  it('should execute INSERT with multiple tuples', async () => {
    const query = "INSERT INTO users (id, name) VALUES (1, 'Alice'), (2, 'Bob')";
    const interpreter = new Interpreter(query);
    const result = await interpreter.execute();

    expect(result.type).toBe('InsertResult');
    expect(asInsertResult(result).insertedCount).toBe(2);
    expect(asInsertResult(result).rows).toEqual([
      { ID: 1, NAME: 'Alice' },
      { ID: 2, NAME: 'Bob' },
    ]);
  });

  it('should execute UPDATE and return update metadata', async () => {
    const query = "UPDATE users SET status = 'ACTIVE' WHERE id = 2";
    const interpreter = new Interpreter(query);
    const result = await interpreter.execute();

    expect(result).toEqual({
      type: 'UpdateResult',
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
      updatedCount: 0,
      rows: [],
    });
  });

  it('should execute UPDATE without WHERE clause', async () => {
    const query = "UPDATE users SET status = 'ACTIVE'";
    const interpreter = new Interpreter(query);
    const result = await interpreter.execute();

    expect(result.type).toBe('UpdateResult');
    expect(asUpdateResult(result).where).toBeUndefined();
    expect(asUpdateResult(result).updatedCount).toBe(0);
  });
});

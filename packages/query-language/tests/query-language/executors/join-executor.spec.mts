//@author Tijn Gommers
// @date 2026-03-27

import { JoinExecutor } from '../../../src/executors/join.mjs';
import { describe, it, expect, beforeEach } from 'vitest';
import type { JoinNode } from '../../../src/types/index.mjs';

describe('JoinExecutor', () => {
  let joinExecutor: JoinExecutor;

  beforeEach(() => {
    joinExecutor = new JoinExecutor();
  });

  it('should execute a basic INNER JOIN', () => {
    const joinNode: JoinNode = {
      type: 'Join',
      table: { type: 'Table', name: 'ORDERS' },
      joinType: 'INNER',
      on: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'USERS.ID' },
        operator: '=',
        right: { type: 'Identifier', name: 'ORDERS.USER_ID' },
      },
    };

    const result = joinExecutor.executeJoin(joinNode);

    expect(result).toEqual({
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

  it('should execute a LEFT JOIN', () => {
    const joinNode: JoinNode = {
      type: 'Join',
      table: { type: 'Table', name: 'ORDERS' },
      joinType: 'LEFT',
      on: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'USERS.ID' },
        operator: '=',
        right: { type: 'Identifier', name: 'ORDERS.USER_ID' },
      },
    };

    const result = joinExecutor.executeJoin(joinNode);

    expect(result.joinType).toBe('LEFT');
    expect(result.table.name).toBe('ORDERS');
  });

  it('should execute a RIGHT JOIN', () => {
    const joinNode: JoinNode = {
      type: 'Join',
      table: { type: 'Table', name: 'PRODUCTS' },
      joinType: 'RIGHT',
      on: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'ORDERS.PRODUCT_ID' },
        operator: '=',
        right: { type: 'Identifier', name: 'PRODUCTS.ID' },
      },
    };

    const result = joinExecutor.executeJoin(joinNode);

    expect(result.joinType).toBe('RIGHT');
    expect(result.table.name).toBe('PRODUCTS');
  });

  it('should execute a CROSS JOIN', () => {
    const joinNode: JoinNode = {
      type: 'Join',
      table: { type: 'Table', name: 'CATEGORIES' },
      joinType: 'CROSS',
    };

    const result = joinExecutor.executeJoin(joinNode);

    expect(result.joinType).toBe('CROSS');
    expect(result.on).toBeUndefined();
  });

  it('should execute multiple JOINs sequentially', () => {
    const joins: JoinNode[] = [
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
    ];

    const results = joinExecutor.executeMultipleJoins(joins);

    expect(results).toHaveLength(2);
    expect(results[0].table.name).toBe('ORDERS');
    expect(results[1].table.name).toBe('PRODUCTS');
  });

  it('should validate valid JOIN node', () => {
    const joinNode: JoinNode = {
      type: 'Join',
      table: { type: 'Table', name: 'ORDERS' },
      joinType: 'INNER',
      on: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'USERS.ID' },
        operator: '=',
        right: { type: 'Identifier', name: 'ORDERS.USER_ID' },
      },
    };

    expect(() => joinExecutor.validateJoin(joinNode)).not.toThrow();
  });

  it('should throw error for invalid JOIN (missing table)', () => {
    const invalidJoin = {
      type: 'Join',
      table: null,
      joinType: 'INNER',
      on: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'USERS.ID' },
        operator: '=',
        right: { type: 'Identifier', name: 'ORDERS.USER_ID' },
      },
    } as unknown as JoinNode;

    expect(() => joinExecutor.validateJoin(invalidJoin)).toThrow('Invalid JOIN: missing table');
  });

  it('should throw error for invalid JOIN (missing ON condition)', () => {
    const invalidJoin = {
      type: 'Join',
      table: { type: 'Table', name: 'ORDERS' },
      joinType: 'INNER',
      on: null,
    } as unknown as JoinNode;

    expect(() => joinExecutor.validateJoin(invalidJoin)).toThrow('Invalid JOIN: missing ON condition');
  });

  it('should validate CROSS JOIN without ON condition', () => {
    const joinNode: JoinNode = {
      type: 'Join',
      table: { type: 'Table', name: 'CATEGORIES' },
      joinType: 'CROSS',
    };

    expect(() => joinExecutor.validateJoin(joinNode)).not.toThrow();
  });

  it('should handle LEFT OUTER JOIN correctly', () => {
    const joinNode: JoinNode = {
      type: 'Join',
      table: { type: 'Table', name: 'ORDERS' },
      joinType: 'LEFT',
      on: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'USERS.ID' },
        operator: '=',
        right: { type: 'Identifier', name: 'ORDERS.USER_ID' },
      },
    };

    const result = joinExecutor.executeJoin(joinNode);

    expect(result.joinType).toBe('LEFT');
    expect(result.type).toBe('Join');
  });

  it('should handle RIGHT OUTER JOIN correctly', () => {
    const joinNode: JoinNode = {
      type: 'Join',
      table: { type: 'Table', name: 'PRODUCTS' },
      joinType: 'RIGHT',
      on: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'ORDERS.PRODUCT_ID' },
        operator: '=',
        right: { type: 'Identifier', name: 'PRODUCTS.ID' },
      },
    };

    const result = joinExecutor.executeJoin(joinNode);

    expect(result.joinType).toBe('RIGHT');
    expect(result.type).toBe('Join');
  });

  it('should preserve ON condition in execution result', () => {
    const onCondition = {
      type: 'ComparisonExpression' as const,
      left: { type: 'Identifier' as const, name: 'USERS.ID' },
      operator: '=' as const,
      right: { type: 'Identifier' as const, name: 'ORDERS.USER_ID' },
    };

    const joinNode: JoinNode = {
      type: 'Join',
      table: { type: 'Table', name: 'ORDERS' },
      joinType: 'INNER',
      on: onCondition,
    };

    const result = joinExecutor.executeJoin(joinNode);

    expect(result.on).toEqual(onCondition);
  });
});

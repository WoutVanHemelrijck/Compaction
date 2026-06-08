//@author Tijn Gommers
//@date 2026-04-02

import { describe, expect, it } from 'vitest';
import {
  buildSelectProjection,
  compileStorageValueExpression,
  compileStorageValueNode,
  compileStorageWherePredicate,
  getSingleTableName,
  hasJoinNodes,
} from '../../../src/executors/storage-adapter-helpers.mjs';

describe('storage-adapter-helpers', () => {
  it('should compile all supported where expression shapes', () => {
    expect(compileStorageWherePredicate(undefined)).toBeUndefined();

    const logical = compileStorageWherePredicate({
      type: 'LogicalExpression',
      operator: 'AND',
      left: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'AGE' },
        operator: '>=',
        right: { type: 'Literal', valueType: 'number', value: 18 },
      },
      right: {
        type: 'NotExpression',
        operator: 'NOT',
        expression: {
          type: 'NullCheckExpression',
          left: { type: 'Identifier', name: 'NAME' },
          isNegated: false,
        },
      },
    });

    expect(logical).toEqual({
      type: 'LogicalExpression',
      operator: 'AND',
      left: {
        type: 'ComparisonExpression',
        operator: '>=',
        left: { type: 'Identifier', name: 'AGE' },
        right: { type: 'Literal', value: 18 },
      },
      right: {
        type: 'NotExpression',
        operator: 'NOT',
        expression: {
          type: 'NullCheckExpression',
          column: 'NAME',
          isNegated: false,
        },
      },
    });

    const inExpression = compileStorageWherePredicate({
      type: 'InExpression',
      left: { type: 'Identifier', name: 'ID' },
      values: [
        { type: 'Literal', valueType: 'number', value: 1 },
        { type: 'Identifier', name: 'OTHER_ID' },
      ],
    });

    expect(inExpression).toEqual({
      type: 'InExpression',
      column: 'ID',
      values: [1, 'OTHER_ID'],
    });
  });

  it('should compile storage value expressions and value nodes', () => {
    expect(compileStorageValueExpression({ type: 'Identifier', name: 'USERS.AGE' })).toEqual({
      type: 'Identifier',
      name: 'USERS.AGE',
    });
    expect(compileStorageValueExpression({ type: 'Literal', valueType: 'string', value: 'A' })).toEqual({
      type: 'Literal',
      value: 'A',
    });

    expect(
      compileStorageValueExpression({
        type: 'AggregateFunction',
        functionName: 'COUNT',
        argument: { type: 'Wildcard', value: '*' },
      }),
    ).toEqual({
      type: 'AggregateFunction',
      functionName: 'COUNT',
      argument: '*',
    });

    expect(
      compileStorageValueExpression({
        type: 'ArithmeticExpression',
        operator: '+',
        left: { type: 'Identifier', name: 'A' },
        right: { type: 'Literal', valueType: 'number', value: 10 },
      }),
    ).toEqual({
      type: 'ArithmeticExpression',
      operator: '+',
      left: { type: 'Identifier', name: 'A' },
      right: { type: 'Literal', value: 10 },
    });

    expect(compileStorageValueNode({ type: 'Literal', valueType: 'null', value: null })).toBeNull();
    expect(compileStorageValueNode({ type: 'Identifier', name: 'ID' })).toBe('ID');
  });

  it('should build projection and table-source helper outputs', () => {
    expect(buildSelectProjection([{ type: 'Identifier', name: '*' }])).toEqual(['*']);
    expect(buildSelectProjection([])).toEqual(['*']);
    expect(
      buildSelectProjection([
        { type: 'Identifier', name: 'NAME' },
        { type: 'Identifier', name: 'NAME' },
        {
          type: 'AggregateFunction',
          functionName: 'SUM',
          argument: { type: 'Identifier', name: 'AGE' },
        },
      ]),
    ).toEqual(['NAME', 'AGE']);

    expect(
      buildSelectProjection([
        {
          type: 'AggregateFunction',
          functionName: 'COUNT',
          argument: { type: 'Wildcard', value: '*' },
        },
      ]),
    ).toEqual(['*']);

    expect(getSingleTableName([{ type: 'Table', name: 'USERS' }])).toBe('USERS');
    expect(
      getSingleTableName([
        { type: 'Table', name: 'USERS' },
        { type: 'Table', name: 'ORDERS' },
      ]),
    ).toBeUndefined();
    expect(
      getSingleTableName([
        {
          type: 'Join',
          joinType: 'INNER',
          table: { type: 'Table', name: 'ORDERS' },
          on: {
            type: 'ComparisonExpression',
            left: { type: 'Identifier', name: 'USERS.ID' },
            operator: '=',
            right: { type: 'Identifier', name: 'ORDERS.USER_ID' },
          },
        },
      ]),
    ).toBeUndefined();

    expect(hasJoinNodes([{ type: 'Table', name: 'USERS' }])).toBe(false);
    expect(
      hasJoinNodes([
        {
          type: 'Join',
          joinType: 'INNER',
          table: { type: 'Table', name: 'ORDERS' },
          on: {
            type: 'ComparisonExpression',
            left: { type: 'Identifier', name: 'USERS.ID' },
            operator: '=',
            right: { type: 'Identifier', name: 'ORDERS.USER_ID' },
          },
        },
      ]),
    ).toBe(true);
  });
});

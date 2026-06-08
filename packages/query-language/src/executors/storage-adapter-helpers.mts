//@author Tijn Gommers
//@date 2026-04-02

import type { ExpressionNode, FromNode, SelectColumn, ValueExpressionNode, ValueNode } from '../types/index.mjs';
import type { StorageOperand, StoragePredicate } from '../../storage-adapter/storage-adapter-types.mjs';

/**
 * Compiles an AST WHERE expression into a storage-adapter predicate shape.
 * @param expression Optional expression tree from the parser.
 * @returns {StoragePredicate | undefined} Storage-adapter predicate object or undefined when no predicate is present.
 */
export function compileStorageWherePredicate(expression?: ExpressionNode): StoragePredicate | undefined {
  if (!expression) {
    return undefined;
  }

  switch (expression.type) {
    case 'LogicalExpression':
      return {
        type: 'LogicalExpression',
        operator: expression.operator === 'AND' ? 'AND' : 'OR',
        left: compileStorageWherePredicate(expression.left),
        right: compileStorageWherePredicate(expression.right),
      };
    case 'NotExpression':
      return {
        type: 'NotExpression',
        operator: expression.operator,
        expression: compileStorageWherePredicate(expression.expression),
      };
    case 'ComparisonExpression':
      return {
        type: 'ComparisonExpression',
        operator: expression.operator,
        left: compileStorageValueExpression(expression.left),
        right: compileStorageValueExpression(expression.right),
      };
    case 'NullCheckExpression':
      return {
        type: 'NullCheckExpression',
        column: expression.left.name,
        isNegated: expression.isNegated,
      };
    case 'InExpression':
      return {
        type: 'InExpression',
        column: expression.left.name,
        values: expression.values.map((value) => compileStorageValueNode(value)),
      };
    default:
      return undefined;
  }
}

/**
 * Compiles a value expression into a storage-adapter operand shape.
 * @param expression AST value expression.
 * @returns {StorageOperand} Primitive value, identifier path, or expression object compatible with adapter evaluation.
 */
export function compileStorageValueExpression(expression: ValueExpressionNode): StorageOperand {
  switch (expression.type) {
    case 'Identifier':
      return {
        type: 'Identifier',
        name: expression.name,
      };
    case 'Literal':
      return {
        type: 'Literal',
        value: expression.value,
      };
    case 'AggregateFunction':
      return {
        type: 'AggregateFunction',
        functionName: expression.functionName,
        argument: expression.argument.type === 'Wildcard' ? '*' : expression.argument.name,
      };
    case 'ArithmeticExpression':
      return {
        type: 'ArithmeticExpression',
        operator: expression.operator,
        left: compileStorageValueExpression(expression.left),
        right: compileStorageValueExpression(expression.right),
      };
    default:
      return undefined as never;
  }
}

/**
 * Converts a value node to a primitive value used by storage predicates.
 * @param value Literal or identifier value node.
 * @returns {string | number | null} Primitive literal value or identifier name.
 */
export function compileStorageValueNode(value: ValueNode): string | number | null {
  if (value.type === 'Literal') {
    return value.value;
  }

  return value.name;
}

/**
 * Builds a projection list from SELECT columns.
 * @param columns Columns specified in the SELECT clause.
 * @returns {string[]} Projected column names or wildcard when projection cannot be narrowed.
 */
export function buildSelectProjection(columns: SelectColumn[]): string[] {
  const projection = new Set<string>();

  for (const column of columns) {
    if (column.type === 'Identifier') {
      if (column.name === '*') {
        return ['*'];
      }

      projection.add(column.name);
      continue;
    }

    if (column.argument.type === 'Wildcard') {
      return ['*'];
    }

    projection.add(column.argument.name);
  }

  return projection.size > 0 ? Array.from(projection) : ['*'];
}

/**
 * Resolves a table name when the FROM clause references exactly one table and no joins.
 * @param from FROM clause nodes.
 * @returns {string | undefined} Single table name or undefined when query is multi-source.
 */
export function getSingleTableName(from: FromNode[]): string | undefined {
  if (from.length !== 1) {
    return undefined;
  }

  const firstNode = from[0];
  if (firstNode.type !== 'Table') {
    return undefined;
  }

  return firstNode.name;
}

/**
 * Checks whether a FROM clause contains at least one join node.
 * @param from FROM clause nodes.
 * @returns {boolean} True when a join node is present.
 */
export function hasJoinNodes(from: FromNode[]): boolean {
  return from.some((node) => node.type === 'Join');
}

// @author Tijn Gommers
// @date 2026-04-03

import type { ArithmeticOperator, ComparisonOperator } from '../src/types/index.mjs';

/**
 * Primitive value types supported by storage adapter payloads.
 */
export type StorageScalar = string | number | boolean | null;

/**
 * Recursive row value accepted by adapters.
 */
export type StorageValue = StorageScalar | StorageRow | StorageValue[];

/**
 * Generic row shape used by adapters.
 * @interface StorageRow
 * @property {StorageValue} [key: string] - Column values can be primitives, nested objects, or arrays.
 */
export interface StorageRow {
  [key: string]: StorageValue;
}

/**
 * Identifier reference used in adapter set payloads for per-row resolution.
 */
export interface StorageIdentifierReference {
  type: 'Identifier';
  name: string;
}

/**
 * Value accepted in adapter update set payloads.
 */
export type StorageSetValue = StorageValue | StorageIdentifierReference;

/**
 * Payload shape used for adapter update operations.
 */
export type StorageSetPayload = Record<string, StorageSetValue>;

/**
 * Storage adapter operand for query predicate pushdown.
 */
export type StorageOperand =
  | {
      type: 'Identifier';
      name: string;
    }
  | {
      type: 'Literal';
      value: string | number | null;
    }
  | string
  | number
  | null
  | {
      type: 'AggregateFunction';
      functionName: string;
      argument: string;
    }
  | {
      type: 'ArithmeticExpression';
      operator: ArithmeticOperator;
      left: StorageOperand;
      right: StorageOperand;
    };

/**
 * Storage adapter predicate tree produced from query WHERE clauses.
 */
export type StoragePredicate =
  | {
      type: 'LogicalExpression';
      operator: 'AND' | 'OR';
      left?: StoragePredicate;
      right?: StoragePredicate;
    }
  | {
      type: 'NotExpression';
      operator: 'NOT';
      expression?: StoragePredicate;
    }
  | {
      type: 'ComparisonExpression';
      operator: ComparisonOperator;
      left: StorageOperand;
      right: StorageOperand;
    }
  | {
      type: 'NullCheckExpression';
      column: string;
      isNegated: boolean;
    }
  | {
      type: 'InExpression';
      column: string;
      values: Array<string | number | null>;
    };

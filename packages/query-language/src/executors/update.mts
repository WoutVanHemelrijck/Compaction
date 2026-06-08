//@author Tijn Gommers
//@date 2026-04-02

import type {
  ArithmeticOperator,
  ComparisonOperator,
  ExpressionNode,
  IdentifierNode,
  UpdateStatement,
  ValueNode,
} from '../types/index.mjs';
import type { UpdateResult } from '../types/execution-results.mjs';
import type { StorageAdapter } from '../../storage-adapter/storage-adapter.mjs';
import type {
  StorageIdentifierReference,
  StorageRow,
  StorageSetPayload,
  StorageValue,
} from '../../storage-adapter/storage-adapter-types.mjs';
import { compileStorageWherePredicate } from './storage-adapter-helpers.mjs';

/**
 * Executes UPDATE statements with optional storage-adapter pushdown.
 */
export class UpdateExecutor {
  private storageAdapter?: StorageAdapter;

  /**
   * Creates an UPDATE executor.
   * @param storageAdapter Optional storage adapter for adapter-backed execution.
   */
  constructor(storageAdapter?: StorageAdapter) {
    this.storageAdapter = storageAdapter;
  }

  /**
   * Executes an UPDATE statement and returns updated row metadata.
   * @param node The UPDATE statement AST node to execute.
   * @param inputRows Optional input rows for in-memory execution (used when no storage adapter is available or when executing on a subquery result).
   * @returns {UpdateResult | Promise<UpdateResult>} An object containing metadata about the update operation, including the number of rows updated and the updated row data. If a storage adapter is used, this method returns a promise that resolves to the update result after the asynchronous update operation completes.
   * @throws {Error} If the UPDATE statement is invalid (e.g., missing table or SET assignments).
   */
  executeUpdate(node: UpdateStatement, inputRows: StorageRow[] = []): UpdateResult | Promise<UpdateResult> {
    this.validateUpdate(node);

    if (!this.storageAdapter || inputRows.length > 0) {
      return this.executeInMemory(node, inputRows);
    }

    const where = this.normalizeWhereExpression(node.where);

    return (async () => {
      const predicate = compileStorageWherePredicate(where);
      const matchingRows = predicate
        ? await this.storageAdapter!.filter(node.table.name, predicate)
        : await this.storageAdapter!.read(node.table.name, ['*']);
      const updatedRows = this.buildUpdatedRows(node, matchingRows);

      await this.storageAdapter!.update(node.table.name, this.buildStorageSet(node), predicate);

      return {
        type: 'UpdateResult',
        table: node.table,
        set: node.set,
        where: node.where,
        updatedCount: updatedRows.length,
        rows: updatedRows,
      };
    })();
  }

  /**
   * Executes UPDATE logic directly on provided in-memory rows.
   * @param node Parsed UPDATE statement.
   * @param inputRows Candidate rows to mutate.
   * @returns {UpdateResult} Update metadata including mutated rows.
   */
  private executeInMemory(node: UpdateStatement, inputRows: StorageRow[]): UpdateResult {
    const updatedRows: StorageRow[] = [];

    inputRows.forEach((row) => {
      if (!node.where || this.evaluateWhereExpression(node.where, row)) {
        node.set.forEach((assignment) => {
          const resolvedValue = this.resolveValueNode(assignment.value, row);
          if (resolvedValue !== undefined) {
            row[assignment.column.name] = resolvedValue;
            return;
          }

          delete row[assignment.column.name];
        });

        updatedRows.push(row);
      }
    });

    return {
      type: 'UpdateResult',
      table: node.table,
      set: node.set,
      where: node.where,
      updatedCount: updatedRows.length,
      rows: updatedRows,
    };
  }

  /**
   * Computes updated row snapshots from source rows and SET assignments.
   * @param node Parsed UPDATE statement.
   * @param rows Rows that match the UPDATE predicate.
   * @returns {StorageRow[]} Updated row snapshots.
   */
  private buildUpdatedRows(node: UpdateStatement, rows: StorageRow[]): StorageRow[] {
    return rows.map((row) => {
      const updatedRow = { ...row };

      node.set.forEach((assignment) => {
        const resolvedValue = this.resolveValueNode(assignment.value, row);
        if (resolvedValue !== undefined) {
          updatedRow[assignment.column.name] = resolvedValue;
          return;
        }

        delete updatedRow[assignment.column.name];
      });

      return updatedRow;
    });
  }

  /**
   * Builds the payload passed to the storage adapter update call.
   * @param node Parsed UPDATE statement.
   * @returns {StorageSetPayload} Column-value map for adapter update.
   */
  private buildStorageSet(node: UpdateStatement): StorageSetPayload {
    const setPayload: StorageSetPayload = {};

    node.set.forEach((assignment) => {
      if (assignment.value.type === 'Literal') {
        const literalValue = this.toStorageValue(assignment.value.value);
        if (literalValue !== undefined) {
          setPayload[assignment.column.name] = literalValue;
        }
        return;
      }

      const identifierReference: StorageIdentifierReference = {
        type: 'Identifier',
        name: assignment.value.name,
      };

      setPayload[assignment.column.name] = identifierReference;
    });

    return setPayload;
  }

  /**
   * Validates basic UPDATE statement requirements.
   * @param node Parsed UPDATE statement.
   * @returns {void}
   * @throws {Error} When table or SET assignments are missing.
   */
  private validateUpdate(node: UpdateStatement): void {
    if (!node.table) {
      throw new Error('Invalid UPDATE: no table specified');
    }

    if (!node.set || node.set.length === 0) {
      throw new Error('Invalid UPDATE: no SET assignments specified');
    }
  }

  /**
   * Normalizes nested WHERE expressions to a consistently cloned tree.
   * @param where Optional WHERE expression.
   * @returns {ExpressionNode | undefined} Normalized expression tree.
   */
  private normalizeWhereExpression(where?: ExpressionNode): ExpressionNode | undefined {
    if (!where) {
      return undefined;
    }

    if (where.type === 'LogicalExpression') {
      const left = this.normalizeWhereExpression(where.left);
      const right = this.normalizeWhereExpression(where.right);

      if (!left || !right) {
        return where;
      }

      return {
        ...where,
        left,
        right,
      };
    }

    if (where.type === 'NotExpression') {
      const expression = this.normalizeWhereExpression(where.expression);

      if (!expression) {
        return where;
      }

      return {
        ...where,
        expression,
      };
    }

    return where;
  }

  /**
   * Resolves a value node to a concrete value for a specific row.
   * @param value Value node from SET assignment.
   * @param row Source row used for identifier resolution.
   * @returns {StorageValue | undefined} Resolved assignment value.
   */
  private resolveValueNode(value: ValueNode, row: StorageRow): StorageValue | undefined {
    if (value.type === 'Literal') {
      return this.toStorageValue(value.value);
    }

    return this.toStorageValue(this.resolveIdentifierValue(row, value));
  }

  /**
   * Evaluates a WHERE expression against a row.
   * @param expression WHERE expression AST node.
   * @param row Row being tested.
   * @returns {boolean} True when the row matches the expression.
   */
  private evaluateWhereExpression(expression: ExpressionNode, row: StorageRow): boolean {
    switch (expression.type) {
      case 'LogicalExpression':
        if (expression.operator === 'AND') {
          return (
            this.evaluateWhereExpression(expression.left, row) && this.evaluateWhereExpression(expression.right, row)
          );
        }
        return (
          this.evaluateWhereExpression(expression.left, row) || this.evaluateWhereExpression(expression.right, row)
        );
      case 'NotExpression':
        return !this.evaluateWhereExpression(expression.expression, row);
      case 'ComparisonExpression': {
        const left = this.resolveExpressionValue(expression.left, row);
        const right = this.resolveExpressionValue(expression.right, row);
        return this.compareValues(left, right, expression.operator);
      }
      case 'NullCheckExpression': {
        const value = this.resolveIdentifierValue(row, expression.left);
        const isNullish = value === null || value === undefined;
        return expression.isNegated ? !isNullish : isNullish;
      }
      case 'InExpression': {
        const leftValue = this.resolveIdentifierValue(row, expression.left);
        const values = expression.values.map((valueNode) => this.resolveExpressionValue(valueNode, row));
        return values.some((value) => value === leftValue);
      }
      default:
        return false;
    }
  }

  /**
   * Resolves an expression node to a runtime value.
   * @param value Expression node or literal-compatible value.
   * @param row Row context for identifier and arithmetic evaluation.
   * @returns {unknown} Resolved expression value.
   */
  private resolveExpressionValue(value: unknown, row: StorageRow): unknown {
    if (this.isLiteralNode(value)) {
      return value.value;
    }

    if (this.isIdentifierNode(value)) {
      return this.resolveIdentifierValue(row, value);
    }

    if (this.isArithmeticExpressionNode(value)) {
      const left = this.resolveExpressionValue(value.left, row);
      const right = this.resolveExpressionValue(value.right, row);
      return this.applyArithmetic(left, right, value.operator);
    }

    return undefined;
  }

  /**
   * Resolves an identifier path against a row, including case-insensitive key fallback.
   * @param row Row object containing source values.
   * @param identifier Identifier to resolve.
   * @returns {StorageValue | undefined} Resolved value, or undefined when not found.
   */
  private resolveIdentifierValue(row: StorageRow, identifier: IdentifierNode): StorageValue | undefined {
    const path = identifier.name.split('.');
    let current: unknown = row;

    for (const segment of path) {
      if (!this.isRecord(current)) {
        return undefined;
      }

      if (segment in current) {
        current = current[segment];
        continue;
      }

      const key = Object.keys(current).find((existingKey) => existingKey.toUpperCase() === segment.toUpperCase());
      if (!key) {
        return undefined;
      }

      current = current[key];
    }

    return this.toStorageValue(current);
  }

  /**
   * Applies arithmetic to two operands.
   * @param left Left operand.
   * @param right Right operand.
   * @param operator Arithmetic operator.
   * @returns {number} Arithmetic result.
   * @throws {Error} When operands are non-numeric, division by zero is attempted, or operator is unsupported.
   */
  private applyArithmetic(left: unknown, right: unknown, operator: ArithmeticOperator): number {
    if (typeof left !== 'number' || typeof right !== 'number') {
      throw new Error(`Invalid arithmetic operands: ${String(left)} ${operator} ${String(right)}`);
    }

    switch (operator) {
      case '+':
        return left + right;
      case '-':
        return left - right;
      case '*':
        return left * right;
      case '/':
        if (right === 0) {
          throw new Error('Division by zero');
        }
        return left / right;
      default:
        throw new Error('Unsupported arithmetic operator');
    }
  }

  /**
   * Compares two values with a SQL-style comparison operator.
   * @param left Left operand.
   * @param right Right operand.
   * @param operator Comparison operator.
   * @returns {boolean} Comparison result.
   */
  private compareValues(left: unknown, right: unknown, operator: ComparisonOperator): boolean {
    switch (operator) {
      case '=':
        return left === right;
      case '!=':
        return left !== right;
      case '>':
        return this.compareOrder(left, right, (a, b) => a > b);
      case '<':
        return this.compareOrder(left, right, (a, b) => a < b);
      case '>=':
        return this.compareOrder(left, right, (a, b) => a >= b);
      case '<=':
        return this.compareOrder(left, right, (a, b) => a <= b);
      default:
        return false;
    }
  }

  /**
   * Compares two orderable values using a supplied comparator.
   * @param left Left operand.
   * @param right Right operand.
   * @param comparator Comparison function for same-typed values.
   * @returns {boolean} True when comparison succeeds for compatible value types.
   */
  private compareOrder(
    left: unknown,
    right: unknown,
    comparator: (leftValue: number | string, rightValue: number | string) => boolean,
  ): boolean {
    if (typeof left === 'number' && typeof right === 'number') {
      return comparator(left, right);
    }

    if (typeof left === 'string' && typeof right === 'string') {
      return comparator(left, right);
    }

    return false;
  }

  /**
   * Type guard for plain object records.
   * @param value Candidate runtime value.
   * @returns {value is Record<string, unknown>} True when value is a non-null object.
   */
  private isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object';
  }

  /**
   * Converts an unknown runtime value into a storage-compatible value.
   * @param value Runtime value to normalize.
   * @returns {StorageValue | undefined} Storage-compatible value, or undefined when conversion is not possible.
   */
  private toStorageValue(value: unknown): StorageValue | undefined {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }

    if (Array.isArray(value)) {
      const convertedArray: StorageValue[] = [];

      for (const item of value) {
        const convertedItem = this.toStorageValue(item);
        if (convertedItem === undefined) {
          return undefined;
        }
        convertedArray.push(convertedItem);
      }

      return convertedArray;
    }

    if (this.isRecord(value)) {
      const convertedObject: StorageRow = {};

      for (const [key, nestedValue] of Object.entries(value)) {
        const convertedNestedValue = this.toStorageValue(nestedValue);
        if (convertedNestedValue === undefined) {
          return undefined;
        }
        convertedObject[key] = convertedNestedValue;
      }

      return convertedObject;
    }

    return undefined;
  }

  /**
   * Type guard for literal AST nodes.
   * @param value Candidate runtime value.
   * @returns {value is { type: 'Literal'; value: unknown }} True when value is a literal AST node.
   */
  private isLiteralNode(value: unknown): value is { type: 'Literal'; value: unknown } {
    return this.isRecord(value) && value['type'] === 'Literal' && 'value' in value;
  }

  /**
   * Type guard for identifier AST nodes.
   * @param value Candidate runtime value.
   * @returns {value is IdentifierNode} True when value is an identifier AST node.
   */
  private isIdentifierNode(value: unknown): value is IdentifierNode {
    return this.isRecord(value) && value['type'] === 'Identifier' && typeof value['name'] === 'string';
  }

  /**
   * Type guard for arithmetic expression AST nodes.
   * @param value Candidate runtime value.
   * @returns {value is { type: 'ArithmeticExpression'; left: unknown; right: unknown; operator: ArithmeticOperator }} True when value is an arithmetic expression AST node.
   */
  private isArithmeticExpressionNode(
    value: unknown,
  ): value is { type: 'ArithmeticExpression'; left: unknown; right: unknown; operator: ArithmeticOperator } {
    if (!this.isRecord(value) || value['type'] !== 'ArithmeticExpression') {
      return false;
    }

    return (
      'left' in value &&
      'right' in value &&
      'operator' in value &&
      (value['operator'] === '+' || value['operator'] === '-' || value['operator'] === '*' || value['operator'] === '/')
    );
  }
}

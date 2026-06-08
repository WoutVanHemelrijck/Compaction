//@author Tijn Gommers
//@date 2026-04-02

import type {
  AggregateFunctionNode,
  ArithmeticOperator,
  ComparisonOperator,
  ExpressionNode,
  FromNode,
  IdentifierNode,
  SelectColumn,
  SelectStatement,
  ValueExpressionNode,
} from '../types/index.mjs';
import type { SelectResult, SelectFromItem } from '../types/execution-results.mjs';
import { JoinExecutor } from './join.mjs';
import type { StorageAdapter } from '../../storage-adapter/storage-adapter.mjs';
import {
  buildSelectProjection,
  compileStorageWherePredicate,
  getSingleTableName,
  hasJoinNodes,
} from './storage-adapter-helpers.mjs';
import type { SelectOptimizationResult } from './select-optimizer.mjs';
import { SelectOptimizer } from './select-optimizer.mjs';

/**
 * Executes SELECT statements with optional storage-adapter pushdown and aggregate handling.
 */
export class SelectExecutor {
  private joinExecutor: JoinExecutor;
  private storageAdapter?: StorageAdapter;
  private selectOptimizer: SelectOptimizer;

  constructor(storageAdapter?: StorageAdapter) {
    this.joinExecutor = new JoinExecutor();
    this.storageAdapter = storageAdapter;
    this.selectOptimizer = new SelectOptimizer();
  }

  /**
   * Validates and executes a SELECT statement.
   * @returns {SelectResult | Promise<SelectResult>} The result of the SELECT execution, either synchronously or as a promise if storage adapter is used.
   */
  executeSelect(
    node: SelectStatement,
    inputRows: Record<string, unknown>[] = [],
  ): SelectResult | Promise<SelectResult> {
    this.validateSelect(node);
    const optimization = this.optimizeSelect(node);

    const columns = node.columns;
    const distinct = node.distinct;
    const from = this.processFromClause(optimization.optimizedFrom);
    const where = optimization.optimizedWhere;
    const orderBy = node.orderBy;
    const limit = node.limit;
    const hasGroupedQuery = Boolean(node.groupBy && node.groupBy.length > 0);

    const hasAggregateColumns = this.hasAggregateColumns(columns);
    const canUseStorageAdapter =
      this.storageAdapter !== undefined &&
      inputRows.length === 0 &&
      !hasJoinNodes(optimization.optimizedFrom) &&
      !hasGroupedQuery;
    const singleTableName = getSingleTableName(optimization.optimizedFrom);

    const result: SelectResult = {
      type: 'SelectResult',
      columns,
      distinct,
      from,
      where,
      orderBy,
      limit,
    };

    if (!canUseStorageAdapter || !singleTableName) {
      const filteredRows = this.applyWhereFilter(inputRows, where);

      if (hasGroupedQuery) {
        const groupedRows = this.executeGroupedSelect(node, filteredRows);
        result.rows = this.applyRowPostProcessing(groupedRows, distinct, orderBy, limit);
        return result;
      }

      if (hasAggregateColumns) {
        result.rows = [this.computeAggregateRow(columns, filteredRows)];
      } else if (filteredRows.length > 0) {
        result.rows = this.applyRowPostProcessing(filteredRows, distinct, orderBy, limit);
      }

      return result;
    }

    return (async () => {
      const projection = optimization.projectionByTable[singleTableName] ?? buildSelectProjection(columns);
      const filteredRows = await this.storageAdapter!.read(
        singleTableName,
        projection,
        compileStorageWherePredicate(where),
      );

      if (hasAggregateColumns) {
        result.rows = [this.computeAggregateRow(columns, filteredRows)];
      } else {
        result.rows = this.applyRowPostProcessing(filteredRows, distinct, orderBy, limit);
      }

      return result;
    })();
  }

  /**
   * Applies the optimizer pipeline to a SELECT AST node.
   * @param node Parsed SELECT statement AST node to optimize.
   * @returns {SelectOptimizationResult} The result of the optimization process, including transformed AST nodes and metadata for execution.
   */
  optimizeSelect(node: SelectStatement): SelectOptimizationResult {
    return this.selectOptimizer.optimize(node);
  }

  /**
   * Processes the FROM clause of a SELECT statement, normalizing JOIN nodes into executable metadata and validating their structure.
   * @param fromNodes fromNodes array of FROM clause nodes, which can include table references and JOIN nodes, to be processed into a normalized form for execution.
   * @returns {SelectFromItem[]} An array of normalized FROM clause items, where JOIN nodes have been transformed into executable metadata objects and table references are returned as-is.
   */
  private processFromClause(fromNodes: FromNode[]): SelectFromItem[] {
    return fromNodes.map((node) => {
      if (node.type === 'Join') {
        return this.joinExecutor.executeJoin(node);
      }
      return node;
    });
  }

  /**
   * Validates SELECT clause structure and aggregate usage rules.
   * @param node Parsed SELECT statement AST node.
   * @returns {void}
   * @throws {Error} When SELECT clause structure is invalid.
   */
  validateSelect(node: SelectStatement): void {
    if (!node.columns || node.columns.length === 0) {
      throw new Error('Invalid SELECT: no columns specified');
    }

    if (!node.from || node.from.length === 0) {
      throw new Error('Invalid SELECT: no FROM clause');
    }

    node.from.forEach((fromNode) => {
      if (fromNode.type === 'Join') {
        this.joinExecutor.validateJoin(fromNode);
      }
    });

    if (node.having && (!node.groupBy || node.groupBy.length === 0)) {
      throw new Error('Invalid SELECT: HAVING clause requires GROUP BY');
    }

    const hasGroupBy = Boolean(node.groupBy && node.groupBy.length > 0);
    this.validateAggregateColumns(node.columns, hasGroupBy);

    if (hasGroupBy) {
      this.validateGroupedSelectColumns(node.columns, node.groupBy ?? []);
    }
  }

  /**
   * Validates that aggregate functions are used correctly in the SELECT clause.
   * @param columns Array of selected columns.
   * @returns {void}
   * @throws {Error} When aggregate usage rules are violated.
   */
  private validateAggregateColumns(columns: SelectColumn[], hasGroupBy: boolean): void {
    const hasAggregate = this.hasAggregateColumns(columns);
    const hasNonAggregate = columns.some((column) => column.type !== 'AggregateFunction');

    if (hasAggregate && hasNonAggregate && !hasGroupBy) {
      throw new Error('Invalid SELECT: cannot mix aggregate and non-aggregate columns without GROUP BY');
    }

    columns.forEach((column) => {
      if (column.type !== 'AggregateFunction') {
        return;
      }

      if (column.argument.type === 'Wildcard' && column.functionName !== 'COUNT') {
        throw new Error('Only COUNT supports wildcard argument');
      }
    });
  }

  /**
   * Ensures all selected non-aggregate identifiers are part of the GROUP BY clause.
   * @param columns SELECT columns.
   * @param groupBy GROUP BY identifiers.
   * @returns {void}
   * @throws {Error} When a selected non-aggregate column is not grouped.
   */
  private validateGroupedSelectColumns(columns: SelectColumn[], groupBy: IdentifierNode[]): void {
    const groupedNames = new Set(groupBy.map((identifier) => identifier.name.toUpperCase()));

    columns.forEach((column) => {
      if (column.type !== 'Identifier') {
        return;
      }

      if (column.name === '*') {
        throw new Error('Invalid SELECT: wildcard cannot be used with GROUP BY');
      }

      if (!groupedNames.has(column.name.toUpperCase())) {
        throw new Error(`Invalid SELECT: non-aggregate column ${column.name} must appear in GROUP BY`);
      }
    });
  }

  /**
   * Helper to check if any columns in the SELECT clause are aggregate functions.
   * @param columns columns to check for aggregate functions.
   * @returns {boolean} True if at least one column is an aggregate function, false otherwise.
   */
  private hasAggregateColumns(columns: SelectColumn[]): boolean {
    return columns.some((column) => column.type === 'AggregateFunction');
  }

  /**
   * Applies the WHERE clause filter to a set of rows.
   * @param rows rows to filter based on the WHERE expression.
   * @param where where expression to evaluate for each row. If undefined, no filtering is applied.
   * @returns {Record<string, any>[]} Filtered rows that satisfy the WHERE condition.
   */
  private applyWhereFilter(rows: Record<string, unknown>[], where?: ExpressionNode): Record<string, unknown>[] {
    if (!where) {
      return rows;
    }

    return rows.filter((row) => this.evaluateWhereExpression(where, row));
  }

  /**
   * Executes grouped aggregation flow for a SELECT statement.
   * @param node SELECT statement with GROUP BY/HAVING clauses.
   * @param rows Rows after WHERE filtering.
   * @returns {Record<string, unknown>[]} Aggregated rows, optionally filtered by HAVING.
   */
  private executeGroupedSelect(node: SelectStatement, rows: Record<string, unknown>[]): Record<string, unknown>[] {
    const groupBy = node.groupBy;

    if (!groupBy || groupBy.length === 0) {
      return [];
    }

    const groupedPartitions = this.partitionRowsByGroupIdentifiers(rows, groupBy);

    const groupedRows = groupedPartitions.map((partition) =>
      this.buildGroupedResultRow(node.columns, partition.groupValues, partition.rows),
    );

    if (!node.having) {
      return groupedRows;
    }

    return this.applyHavingClause(groupedRows, node.having);
  }

  /**
   * Partitions rows by GROUP BY identifier values.
   * @param rows Source rows.
   * @param groupBy GROUP BY identifiers.
   * @returns {{ rows: Record<string, unknown>[]; groupValues: Record<string, unknown> }[]} Group partitions.
   */
  private partitionRowsByGroupIdentifiers(
    rows: Record<string, unknown>[],
    groupBy: IdentifierNode[],
  ): Array<{ rows: Record<string, unknown>[]; groupValues: Record<string, unknown> }> {
    const partitions = new Map<string, { rows: Record<string, unknown>[]; groupValues: Record<string, unknown> }>();

    rows.forEach((row) => {
      const groupValues: Record<string, unknown> = {};
      const keyParts: unknown[] = [];

      groupBy.forEach((identifier) => {
        const value = this.resolveIdentifierValue(row, identifier);
        groupValues[identifier.name] = value;
        keyParts.push(value ?? null);
      });

      const key = JSON.stringify(keyParts);
      const existing = partitions.get(key);

      if (existing) {
        existing.rows.push(row);
        return;
      }

      partitions.set(key, {
        rows: [row],
        groupValues,
      });
    });

    return Array.from(partitions.values());
  }

  /**
   * Applies HAVING filtering to grouped result rows.
   * @param rows Grouped result rows.
   * @param having HAVING expression.
   * @returns {Record<string, unknown>[]} Rows that satisfy HAVING.
   */
  private applyHavingClause(rows: Record<string, unknown>[], having: ExpressionNode): Record<string, unknown>[] {
    return rows.filter((row) => this.evaluateWhereExpression(having, row));
  }

  /**
   * Builds one grouped result row for a partition.
   * @param columns SELECT columns.
   * @param groupValues Group key values for this partition.
   * @param rows Partition rows.
   * @returns {Record<string, unknown>} Grouped output row.
   */
  private buildGroupedResultRow(
    columns: SelectColumn[],
    groupValues: Record<string, unknown>,
    rows: Record<string, unknown>[],
  ): Record<string, unknown> {
    const groupedRow: Record<string, unknown> = {};
    const aggregateValues = this.computeAggregateRow(columns, rows);

    columns.forEach((column) => {
      if (column.type === 'AggregateFunction') {
        const key = this.getAggregateOutputKey(column);
        groupedRow[key] = aggregateValues[key];
        return;
      }

      groupedRow[column.name] = groupValues[column.name];
    });

    return groupedRow;
  }

  /**
   * Evaluates a WHERE clause expression against a single row of data.
   * @param expression expression node representing the WHERE clause condition to evaluate.
   * @param row row of data against which the expression should be evaluated, with column names as keys.
   * @returns {boolean} True if the row satisfies the expression condition, false otherwise.
   */
  private evaluateWhereExpression(expression: ExpressionNode, row: Record<string, unknown>): boolean {
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
        const left = this.evaluateValueExpression(expression.left, row);
        const right = this.evaluateValueExpression(expression.right, row);
        return this.compareValues(left, right, expression.operator);
      }
      case 'NullCheckExpression': {
        const value = this.resolveIdentifierValue(row, expression.left);
        const isNullish = value === null || value === undefined;
        return expression.isNegated ? !isNullish : isNullish;
      }
      case 'InExpression': {
        const leftValue = this.resolveIdentifierValue(row, expression.left);
        const values = expression.values.map((valueNode) => this.evaluateValueExpression(valueNode, row));
        return values.some((value) => value === leftValue);
      }
      default:
        return false;
    }
  }

  /**
   * Evaluates a value expression (identifier, literal, arithmetic expression, or aggregate function) against a single row of data.
   * @param expression expression node representing the value to evaluate, which can be an identifier, literal, arithmetic expression, or aggregate function.
   * @param row row of data against which the expression should be evaluated, with column names as keys.
   * @returns {any} The evaluated value of the expression for the given row, which can be a primitive value or an aggregate result depending on the expression type.
   */
  private evaluateValueExpression(expression: ValueExpressionNode, row: Record<string, unknown>): unknown {
    switch (expression.type) {
      case 'Identifier':
        return this.resolveIdentifierValue(row, expression);
      case 'Literal':
        return expression.value;
      case 'AggregateFunction':
        return this.resolveAggregateValue(row, expression);
      case 'ArithmeticExpression': {
        const left = this.evaluateValueExpression(expression.left, row);
        const right = this.evaluateValueExpression(expression.right, row);
        return this.applyArithmetic(left, right, expression.operator);
      }
      default:
        return undefined;
    }
  }

  /**
   * Resolves an aggregate function value from a grouped result row.
   * @param row Aggregated output row.
   * @param aggregate Aggregate function expression.
   * @returns {unknown} Aggregate value when present.
   */
  private resolveAggregateValue(row: Record<string, unknown>, aggregate: AggregateFunctionNode): unknown {
    const key = this.getAggregateOutputKey(aggregate);

    if (key in row) {
      return row[key];
    }

    const actualKey = Object.keys(row).find((existingKey) => existingKey.toUpperCase() === key.toUpperCase());
    if (!actualKey) {
      return undefined;
    }

    return row[actualKey];
  }

  /**
   * Resolves the value of an identifier from a row of data, supporting nested properties using dot notation.
   * @param row row of data with column names as keys, potentially containing nested objects for dot notation access.
   * @param identifier identifier node whose value should be resolved from the row, where the name can include dot notation for nested properties (e.g., "table.column").
   * @returns {any} The resolved value of the identifier from the row, or undefined if any part of the path does not exist.
   */
  private resolveIdentifierValue(row: Record<string, unknown>, identifier: IdentifierNode): unknown {
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

    return current;
  }

  /**
   * Applies an arithmetic operation to two values based on the specified operator.
   * @param left left operand value, expected to be a number for valid operations.
   * @param right right operand value, expected to be a number for valid operations.
   * @param operator one of the supported arithmetic operators: '+', '-', '*', or '/'.
   * @returns {number} The result of applying the arithmetic operator to the left and right operand values.
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
   * Compares two values based on a comparison operator.
   * @param left left operand value, which can be a number, string, or null.
   * @param right right operand value, which can be a number, string, or null.
   * @param operator one of the supported comparison operators: '=', '!=', '>', '<', '>=', or '<='.
   * @returns {boolean} The result of the comparison between the left and right operand values based on the specified operator.
   * @throws {Error} When an unsupported operator is provided.
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
        throw new Error('Unsupported comparison operator');
    }
  }

  /**
   * Computes the result of aggregate functions for a set of rows based on the specified aggregate columns.
   * @param columns columns from the SELECT clause, which may include aggregate function nodes that specify the type of aggregation and the argument to aggregate.
   * @param rows rows of data to aggregate, where each row is an object with column names as keys and their corresponding values.
   * @returns {Record<string, any>} An object representing the computed aggregate values for each aggregate column, where the keys are derived from the aggregate function and its argument (e.g., "COUNT(columnName)") and the values are the results of the aggregation.
   */
  private computeAggregateRow(columns: SelectColumn[], rows: Record<string, unknown>[]): Record<string, unknown> {
    const aggregateRow: Record<string, unknown> = {};

    columns.forEach((column) => {
      if (column.type !== 'AggregateFunction') {
        return;
      }

      const key = this.getAggregateOutputKey(column);
      aggregateRow[key] = this.computeAggregateValue(column, rows);
    });

    return aggregateRow;
  }

  /**
   * generates a unique key for the output of an aggregate function based on its type and argument, which is used as the column name in the result set for the computed aggregate value.
   * @param column column node representing the aggregate function, which includes the function name (e.g., COUNT, SUM) and its argument (which can be an identifier or a wildcard).
   * @returns {string} A string key that uniquely identifies the aggregate function and its argument, formatted as "FUNCTION(argument)" (e.g., "COUNT(columnName)" or "SUM(columnName)"), which is used as the column name in the result set for the computed aggregate value.
   */
  private getAggregateOutputKey(column: AggregateFunctionNode): string {
    if (column.argument.type === 'Wildcard') {
      return `${column.functionName}(*)`;
    }

    return `${column.functionName}(${column.argument.name})`;
  }

  /**
   * Computes the value of an aggregate function for a set of rows based on the specified column and function.
   * @param column column node representing the aggregate function, which includes the function name (e.g., COUNT, SUM) and its argument (which can be an identifier or a wildcard).
   * @param rows rows of data to aggregate, where each row is an object with column names as keys and their corresponding values.
   * @returns {number | string | null} The computed aggregate value based on the specified function and argument.
   */
  private computeAggregateValue(
    column: AggregateFunctionNode,
    rows: Record<string, unknown>[],
  ): number | string | null {
    if (column.argument.type === 'Wildcard') {
      if (column.functionName !== 'COUNT') {
        throw new Error('Only COUNT supports wildcard argument');
      }
      return rows.length;
    }

    const identifierArgument = column.argument;

    const values = rows
      .map((row) => this.resolveIdentifierValue(row, identifierArgument))
      .filter((value) => value !== null && value !== undefined);

    switch (column.functionName) {
      case 'COUNT':
        return values.length;
      case 'SUM': {
        this.assertAllNumeric(values, column.functionName, identifierArgument.name);
        if (values.length === 0) {
          return null;
        }
        return values.reduce((sum, value) => sum + value, 0);
      }
      case 'AVG': {
        this.assertAllNumeric(values, column.functionName, identifierArgument.name);
        if (values.length === 0) {
          return null;
        }
        const total = values.reduce((sum, value) => sum + value, 0);
        return total / values.length;
      }
      case 'MIN': {
        const comparableValues = values.filter(
          (value): value is number | string => typeof value === 'number' || typeof value === 'string',
        );
        return comparableValues.length === 0
          ? null
          : comparableValues.reduce((min, value) => (value < min ? value : min));
      }
      case 'MAX': {
        const comparableValues = values.filter(
          (value): value is number | string => typeof value === 'number' || typeof value === 'string',
        );
        return comparableValues.length === 0
          ? null
          : comparableValues.reduce((max, value) => (value > max ? value : max));
      }
      default:
        return null;
    }
  }

  /**
   * Asserts that all values in an array are numeric, throwing an error if any non-numeric value is found. This is used to validate arguments for aggregate functions like SUM and AVG that require numeric input.
   * @param values values to check for numeric type, which are the results of evaluating the argument of an aggregate function across all rows being aggregated.
   * @param functionName functionName is the name of the aggregate function for which the values are being validated (e.g., "SUM" or "AVG"), used in the error message if validation fails.
   * @param identifierName identifierName is the name of the identifier argument being aggregated (e.g., "columnName"), used in the error message if validation fails to indicate which column has non-numeric values.
   */
  private assertAllNumeric(
    values: unknown[],
    functionName: string,
    identifierName: string,
  ): asserts values is number[] {
    const hasNonNumeric = values.some((value) => typeof value !== 'number');
    if (hasNonNumeric) {
      throw new Error(`${functionName} requires numeric values for ${identifierName}`);
    }
  }

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
   * Applies ORDER BY and LIMIT/OFFSET to result rows.
   * @param rows Result rows.
   * @param orderBy ORDER BY clause.
   * @param limit LIMIT/OFFSET clause.
   * @returns {Record<string, unknown>[]} Processed rows.
   */
  private applyRowPostProcessing(
    rows: Record<string, unknown>[],
    distinct: boolean,
    orderBy?: SelectStatement['orderBy'],
    limit?: SelectStatement['limit'],
  ): Record<string, unknown>[] {
    let processedRows = rows;

    if (distinct) {
      processedRows = this.applyDistinctRows(processedRows);
    }

    if (orderBy && orderBy.items.length > 0) {
      processedRows = this.sortRows(processedRows, orderBy);
    }

    if (!limit) {
      return processedRows;
    }

    const offset = limit.offset ?? 0;
    return processedRows.slice(offset, offset + limit.limit);
  }

  /**
   * Removes duplicate rows while preserving first occurrence order.
   * @param rows Input rows.
   * @returns {Record<string, unknown>[]} Distinct rows.
   */
  private applyDistinctRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    const seen = new Set<string>();
    const distinctRows: Record<string, unknown>[] = [];

    rows.forEach((row) => {
      const signature = JSON.stringify(row);
      if (seen.has(signature)) {
        return;
      }

      seen.add(signature);
      distinctRows.push(row);
    });

    return distinctRows;
  }

  /**
   * Sorts result rows according to ORDER BY configuration.
   * @param rows Result rows to sort.
   * @param orderBy ORDER BY clause.
   * @returns {Record<string, unknown>[]} Sorted rows.
   */
  private sortRows(
    rows: Record<string, unknown>[],
    orderBy: NonNullable<SelectStatement['orderBy']>,
  ): Record<string, unknown>[] {
    return [...rows].sort((leftRow, rightRow) => {
      for (const item of orderBy.items) {
        const left = this.resolveIdentifierValue(leftRow, item.column);
        const right = this.resolveIdentifierValue(rightRow, item.column);

        const comparison = this.compareSortValues(left, right);
        if (comparison !== 0) {
          return item.direction === 'DESC' ? -comparison : comparison;
        }
      }

      return 0;
    });
  }

  /**
   * Compares two values for ORDER BY sorting.
   * @param left Left value.
   * @param right Right value.
   * @returns {number} Negative when left comes first, positive when right comes first, zero when equal.
   */
  private compareSortValues(left: unknown, right: unknown): number {
    if (left === right) {
      return 0;
    }

    if (left === undefined || left === null) {
      return 1;
    }

    if (right === undefined || right === null) {
      return -1;
    }

    if (typeof left === 'number' && typeof right === 'number') {
      return left - right;
    }

    if (typeof left === 'string' && typeof right === 'string') {
      return left.localeCompare(right);
    }

    return 0;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object';
  }
}

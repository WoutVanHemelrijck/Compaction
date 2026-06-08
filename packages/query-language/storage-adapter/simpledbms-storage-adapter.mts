//@author Tijn Gommers
//@date 2026-04-20

import type { StorageAdapter } from './storage-adapter.mjs';
import type {
  StorageIdentifierReference,
  StorageOperand,
  StoragePredicate,
  StorageRow,
  StorageSetPayload,
  StorageValue,
} from './storage-adapter-types.mjs';
import type { Document, DocumentValue, SimpleDBMS } from '../../dbms/core/simpledbms.mjs';

/**
 * SimpleDBMS-backed storage adapter for Querylib.
 *
 * Translates between Querylib's abstract storage interface and SimpleDBMS collection operations.
 * Handles case normalization (uppercase ↔ lowercase) and predicate evaluation.
 */
export class SimpleDBMSStorageAdapter implements StorageAdapter {
  constructor(private db: SimpleDBMS) {}

  // ============================================
  // PUBLIC ADAPTER METHODS
  // ============================================

  /**
   * Reads rows from a table with optional filtering and projection.
   * @param table Target collection name (case-insensitive).
   * @param columns Column names to project or ['*'] for all.
   * @param where Optional predicate for filtering.
   * @returns {Promise<StorageRow[]>} Promise of rows matching the criteria.
   */
  async read(table: string, columns: string[], where?: StoragePredicate): Promise<StorageRow[]> {
    const collection = await this.db.getCollection(table.toLowerCase());
    const filterFn = this.buildFilterFunction(where);
    const projectionFields = columns.map((c) => c.toLowerCase());

    const docs = await collection.find({
      filter: filterFn,
      projection: projectionFields.includes('*') ? undefined : projectionFields,
    });

    return docs.map((doc) => this.normalizeRowToUpperCase(doc));
  }

  /**
   * Writes (inserts) rows into a table.
   * @param table Target collection name.
   * @param rows Rows to insert.
   * @returns {Promise<void>} Promise that resolves when insertion completes.
   */
  async write(table: string, rows: StorageRow[], ids: string[] = [], userId: string = 'NO_USER'): Promise<void> {
    const collection = await this.db.getCollection(table.toLowerCase());

    if (ids.length === 0) {
      for (const row of rows) {
        const doc = this.storageRowToDocument(row);
        if (userId !== 'NO_USER') {
          doc['userId'] = userId;
        }
        await collection.insert(doc);
      }
    } else if (ids.length !== rows.length) {
      throw new Error('Amount of IDs provided does not match amount of rows to insert!');
    } else {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const doc = this.storageRowToDocument(row);
        doc['id'] = ids[i];
        //
        if (userId !== 'NO_USER') {
          doc['userId'] = userId;
        }
        //
        await collection.insert(doc);
      }
    }
  }

  /**
   * Filters rows in a table using a predicate.
   * @param table Target collection name.
   * @param where Predicate for filtering.
   * @returns {Promise<StorageRow[]>} Promise of matching rows.
   */
  async filter(table: string, where: StoragePredicate): Promise<StorageRow[]> {
    const collection = await this.db.getCollection(table.toLowerCase());
    const filterFn = this.buildFilterFunction(where);

    const docs = await collection.find({
      filter: filterFn,
    });

    return docs.map((doc) => this.normalizeRowToUpperCase(doc));
  }

  /**
   * Projects specific columns from all rows in a table.
   * @param table Target collection name.
   * @param columns Column names to keep.
   * @returns {Promise<StorageRow[]>} Promise of rows with only projected columns.
   */
  async project(table: string, columns: string[]): Promise<StorageRow[]> {
    const collection = await this.db.getCollection(table.toLowerCase());
    const projectionFields = columns.map((c) => c.toLowerCase());

    const docs = await collection.find({
      projection: projectionFields.includes('*') ? undefined : projectionFields,
    });

    return docs.map((doc) => this.normalizeRowToUpperCase(doc));
  }

  /**
   * Updates rows matching a predicate.
   * @param table Target collection name.
   * @param set Partial row with updates.
   * @param where Optional predicate; if omitted, updates all rows.
   * @returns {Promise<void>} Promise that resolves when updates complete.
   */
  async update(table: string, set: StorageSetPayload | Partial<StorageRow>, where?: StoragePredicate): Promise<void> {
    const collection = await this.db.getCollection(table.toLowerCase());
    const filterFn = this.buildFilterFunction(where);

    const docs = await collection.find({
      filter: filterFn,
    });

    for (const doc of docs) {
      const updatePayload = this.convertSetPayloadToDocument(set, doc);
      await collection.update(doc.id, updatePayload);
    }
  }

  /**
   * Deletes rows matching a predicate.
   * @param table Target collection name.
   * @param where Optional predicate; if omitted, deletes all rows.
   * @returns {Promise<void>} Promise that resolves when deletion completes.
   */
  async delete(table: string, where?: StoragePredicate): Promise<void> {
    const collection = await this.db.getCollection(table.toLowerCase());
    const filterFn = this.buildFilterFunction(where);

    const docs = await collection.find({
      filter: filterFn,
    });

    const matchingIds = docs.map((doc) => doc.id);

    for (const id of matchingIds) {
      await collection.delete(id);
    }
  }

  // ============================================
  // PRIVATE HELPER METHODS
  // ============================================

  /**
   * Recursively evaluates a predicate against a document.
   * @param predicate Predicate tree to evaluate.
   * @param doc Document to test.
   * @returns {boolean} True if document matches predicate; false otherwise.
   */
  private evaluatePredicate(predicate: StoragePredicate | undefined, doc: Document): boolean {
    if (!predicate) {
      return true; // No predicate = match all
    }

    switch (predicate.type) {
      case 'LogicalExpression': {
        const left = this.evaluatePredicate(predicate.left, doc);
        const right = this.evaluatePredicate(predicate.right, doc);

        if (predicate.operator === 'AND') {
          return left && right;
        }
        return left || right;
      }

      case 'NotExpression': {
        return !this.evaluatePredicate(predicate.expression, doc);
      }

      case 'ComparisonExpression': {
        const left = this.resolveOperand(predicate.left, doc);
        const right = this.resolveOperand(predicate.right, doc);
        return this.compareValues(left, right, predicate.operator);
      }

      case 'NullCheckExpression': {
        const value = this.resolveFieldValue(doc, String(predicate.column));
        const isNullish = value === null || value === undefined;
        return predicate.isNegated ? !isNullish : isNullish;
      }

      case 'InExpression': {
        const fieldValue = this.resolveFieldValue(doc, String(predicate.column));
        return (
          Array.isArray(predicate.values) && predicate.values.some((val: string | number | null) => val === fieldValue)
        );
      }

      default:
        return false;
    }
  }

  /**
   * Resolves an operand to a concrete value for comparison.
   * @param operand Operand (literal, identifier, or expression).
   * @param doc Document context for field resolution.
   * @returns {unknown} Resolved operand value.
   * @throws Error if arithmetic operation is invalid.
   */
  private resolveOperand(operand: StorageOperand, doc: Document): unknown {
    // Primitive: number, null
    if (typeof operand === 'number' || operand === null) {
      return operand;
    }

    if (typeof operand === 'string') {
      const resolved = this.resolveFieldValue(doc, operand);
      return resolved !== undefined ? resolved : operand;
    }

    // Field identifier
    if (typeof operand === 'object') {
      const obj = operand as Record<string, unknown>;

      if (obj['type'] === 'Literal' && 'value' in obj) {
        return obj['value'];
      }

      if (obj['type'] === 'Identifier' && 'name' in obj) {
        const name = obj['name'] as string;
        return this.resolveFieldValue(doc, name);
      }

      // Arithmetic expression
      if (obj['type'] === 'ArithmeticExpression') {
        const arithExpr = operand as Extract<StorageOperand, { type: 'ArithmeticExpression' }>;
        const left = this.resolveOperand(arithExpr.left, doc);
        const right = this.resolveOperand(arithExpr.right, doc);
        return this.applyArithmetic(left, right, arithExpr.operator);
      }
    }

    return operand;
  }

  /**
   * Resolves a field value from a document with case-insensitive lookup.
   * @param doc Document to search.
   * @param fieldName Field name (case-insensitive).
   * @returns {unknown} Field value or undefined if not found.
   */
  private resolveFieldValue(doc: Document, fieldName: string): unknown {
    // Exact match
    if (fieldName in doc) {
      return doc[fieldName];
    }

    // Lowercase match
    const lowercase = fieldName.toLowerCase();
    if (lowercase in doc) {
      return doc[lowercase];
    }

    // Case-insensitive match
    const key = Object.keys(doc).find((k) => k.toLowerCase() === lowercase);
    if (key) {
      return doc[key];
    }

    return undefined;
  }

  /**
   * Builds a filter function from a storage predicate.
   * @param where Predicate tree (optional).
   * @returns {((doc: Document) => boolean) | undefined} Filter function or undefined if no predicate.
   */
  private buildFilterFunction(where?: StoragePredicate): ((doc: Document) => boolean) | undefined {
    if (!where) {
      return undefined;
    }

    return (doc: Document) => this.evaluatePredicate(where, doc);
  }

  /**
   * Normalizes a document to uppercase field names (StorageRow format).
   * @param doc Source document with lowercase field names.
   * @returns {StorageRow} StorageRow with uppercase field names.
   */
  private normalizeRowToUpperCase(doc: Document): StorageRow {
    const row: StorageRow = {};

    for (const [key, value] of Object.entries(doc)) {
      // Map 'id' to 'ID'
      const upperKey = key === 'id' ? 'ID' : key.toUpperCase();
      row[upperKey] = this.convertDocumentValueToStorageValue(value) as StorageValue;
    }

    return row;
  }

  /**
   * Converts a DocumentValue to StorageValue, handling bigint conversion.
   * @param value Document value that may include bigint.
   * @returns {unknown} StorageValue-compatible value.
   */
  private convertDocumentValueToStorageValue(value: unknown): unknown {
    // bigint to string conversion
    if (typeof value === 'bigint') {
      return value.toString();
    }

    // Array: recursively convert elements
    if (Array.isArray(value)) {
      return value.map((item) => this.convertDocumentValueToStorageValue(item));
    }

    // Object: recursively convert properties
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const converted: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        converted[k] = this.convertDocumentValueToStorageValue(v);
      }
      return converted;
    }

    return value;
  }

  /**
   * Compares two values using a comparison operator.
   * @param left Left operand.
   * @param right Right operand.
   * @param operator Comparison operator (=, !=, >, <, >=, <=).
   * @returns {boolean} True if comparison is true; false otherwise.
   * @throws Error if operator is unsupported.
   */
  private compareValues(left: unknown, right: unknown, operator: string): boolean {
    const areBothNumbers = typeof left === 'number' && typeof right === 'number';
    const areBothStrings = typeof left === 'string' && typeof right === 'string';

    switch (operator) {
      case '=':
        return left === right;
      case '!=':
        return left !== right;
      case '>':
        if (areBothNumbers || areBothStrings) {
          return left > right;
        }
        return false;
      case '<':
        if (areBothNumbers || areBothStrings) {
          return left < right;
        }
        return false;
      case '>=':
        if (areBothNumbers || areBothStrings) {
          return left >= right;
        }
        return false;
      case '<=':
        if (areBothNumbers || areBothStrings) {
          return left <= right;
        }
        return false;
      default:
        throw new Error(`Unsupported comparison operator: ${operator}`);
    }
  }

  /**
   * Applies an arithmetic operation to numeric operands.
   * @param left Left operand (must be number).
   * @param right Right operand (must be number).
   * @param operator Arithmetic operator (+, -, *, /).
   * @returns {number} Result of operation.
   * @throws Error if operands are non-numeric or divide-by-zero.
   */
  private applyArithmetic(left: unknown, right: unknown, operator: string): number {
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
        throw new Error(`Unsupported arithmetic operator: ${operator}`);
    }
  }

  /**
   * Converts a StorageRow (uppercase field names) to a Document (lowercase field names).
   * @param row StorageRow from adapter.
   * @returns {Document} Document for SimpleDBMS storage.
   */
  private storageRowToDocument(row: StorageRow): Omit<Document, 'id'> & { id?: string } {
    const doc: Omit<Document, 'id'> & { id?: string } = {};

    for (const [key, value] of Object.entries(row)) {
      // Map 'ID' to 'id'
      if (key === 'ID') {
        if (typeof value === 'string' && value.trim().length > 0) {
          doc.id = value;
        }
        continue;
      }

      doc[key.toLowerCase()] = value as DocumentValue;
    }

    return doc;
  }

  /**
   * Converts a StorageSetPayload (update values) to a Document Partial.
   * @param set Set payload from storage adapter.
   * @returns {Partial<Document>} Partial document for SimpleDBMS update.
   */
  private convertSetPayloadToDocument(set: StorageSetPayload | Partial<StorageRow>, doc?: Document): Partial<Document> {
    const updates: Partial<Document> = {};

    for (const [key, value] of Object.entries(set)) {
      // Map 'ID' to 'id'
      const lowerKey = key === 'ID' ? 'id' : key.toLowerCase();

      updates[lowerKey] = this.resolveSetValue(value, doc) as DocumentValue;
    }

    return updates;
  }

  /**
   * Resolves a SET value against the current row document.
   * @param value Raw SET value.
   * @param doc Current row document.
   * @returns Resolved document value.
   */
  private resolveSetValue(
    value: StorageIdentifierReference | StorageValue | undefined,
    doc?: Document,
  ): DocumentValue | StorageValue {
    if (value === undefined) {
      return null;
    }

    if (
      typeof value === 'object' &&
      value !== null &&
      'type' in value &&
      value.type === 'Identifier' &&
      'name' in value
    ) {
      if (!doc) {
        return null;
      }

      const referenceName = value.name;
      if (typeof referenceName !== 'string') {
        return null;
      }

      const resolved = this.resolveFieldValue(doc, referenceName);
      return (resolved === undefined ? null : resolved) as DocumentValue;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.resolveSetValue(item, doc)) as StorageValue;
    }

    if (typeof value === 'object' && value !== null) {
      const resolvedObject: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        resolvedObject[key] = this.resolveSetValue(item as StorageIdentifierReference | StorageValue | undefined, doc);
      }
      return resolvedObject as StorageValue;
    }

    return value as DocumentValue;
  }
}

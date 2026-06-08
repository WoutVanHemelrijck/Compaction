//@author Tijn Gommers
//@date 2026-03-31

import type { StoragePredicate, StorageRow, StorageSetPayload } from './storage-adapter-types.mjs';

/**
 * Storage adapter contract for Querylib.
 *
 * The adapter can be parameterized with a row shape and predicate shape so
 * DBMS-backed integrations can stay type-safe while still supporting the
 * default query-language predicate structure.
 */
export interface StorageAdapter<TRow extends StorageRow = StorageRow, TPredicate = StoragePredicate> {
  /**
   * Read rows from a table with optional pushdown filtering and projection.
   * @param {string} table Target table or collection name.
   * @param {string[]} columns Column names to project. Use all known columns to emulate SELECT *.
   * @param {TPredicate} [where] Optional filter predicate in adapter format.
   * @returns {Promise<TRow[]>} Rows matching the read criteria.
   */
  read(table: string, columns: string[], where?: TPredicate): Promise<TRow[]>;

  /**
   * Append rows to a table.
   * @param {string} table Target table or collection name.
   * @param {TRow[]} rows Rows to insert.
   * @returns {Promise<void>} Resolves when write operation has completed.
   */
  write(table: string, rows: TRow[], ids?: string[], userId?: string): Promise<void>;

  /**
   * Filter rows in a table using adapter-native predicate pushdown.
   * @param {string} table Target table or collection name.
   * @param {TPredicate} where Predicate object used by the adapter to filter rows.
   * @returns {Promise<TRow[]>} Matching rows.
   */
  filter(table: string, where: TPredicate): Promise<TRow[]>;

  /**
   * Project only the requested columns from a table.
   * @param {string} table Target table or collection name.
   * @param {string[]} columns Columns to keep in each returned row.
   * @returns {Promise<TRow[]>} Rows containing only projected columns.
   */
  project(table: string, columns: string[]): Promise<TRow[]>;

  /**
   * Delete rows that match a predicate.
   * @param {string} table Target table or collection name.
   * @param {TPredicate} [where] Optional predicate describing which rows to delete. When omitted, all rows are deleted.
   * @returns {Promise<void>} Resolves when delete operation has completed.
   */
  delete(table: string, where?: TPredicate): Promise<void>;

  /**
   * Update rows matching a predicate.
   * @param {string} table Target table or collection name.
   * @param {StorageSetPayload | Partial<TRow>} set Partial row values to write onto matched rows.
   * @param {TPredicate} [where] Optional predicate describing which rows to update. When omitted, all rows are updated.
   * @returns {Promise<void>} Resolves when update operation has completed.
   */
  update(table: string, set: StorageSetPayload | Partial<TRow>, where?: TPredicate): Promise<void>;
}

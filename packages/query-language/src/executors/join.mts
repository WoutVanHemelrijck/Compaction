//@author Tijn Gommers
//@date 2026-03-30

import type { JoinNode } from '../types/index.mjs';
import type { SelectJoinItem } from '../types/execution-results.mjs';

/**
 * Normalizes and validates JOIN nodes used by SELECT execution.
 * @class JoinExecutor
 */
export class JoinExecutor {
  /**
   * Processes a single JOIN node into executable metadata.
   * @param joinNode Join node to normalize.
   * @returns  {SelectJoinItem} Serializable join metadata used by select execution results.
   */
  executeJoin(joinNode: JoinNode): SelectJoinItem {
    return this.processJoin(joinNode);
  }

  /**
   * Processes multiple JOIN nodes.
   * @param joinNodes Join nodes to normalize.
   * @returns {SelectJoinItem[]} Array of normalized join metadata objects.
   */
  executeMultipleJoins(joinNodes: JoinNode[]): SelectJoinItem[] {
    return joinNodes.map((join) => this.processJoin(join));
  }

  /**
   * Internal join-node normalizer.
   * @param node Join node to transform.
   * @returns {SelectJoinItem} Join metadata object.
   */
  private processJoin(node: JoinNode): SelectJoinItem {
    const { table, joinType, on } = node;

    return {
      type: 'Join',
      table,
      joinType,
      on,
    };
  }

  /**
   * Validates JOIN shape based on join type.
   * @param joinNode Join node to validate.
   * @returns {void}
   * @throws {Error} When table is missing, or ON is missing for non-CROSS joins.
   */
  validateJoin(joinNode: JoinNode): void {
    if (!joinNode.table) {
      throw new Error('Invalid JOIN: missing table');
    }

    if (joinNode.joinType !== 'CROSS' && !joinNode.on) {
      throw new Error('Invalid JOIN: missing ON condition');
    }
  }
}

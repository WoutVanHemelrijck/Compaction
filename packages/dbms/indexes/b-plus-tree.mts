// @author Mathias Bouhon Keulen, Frederick Hillen
// @date 2025-11-10

import { debug_incrementFnCallCount } from '../core/debug-global-constants.mjs';
import type { NodeStorage, LeafNodeStorage, InternalNodeStorage } from '../storage/node-storage/node-storage.mjs';

// import { lfs, int } from '../core/invariants.mjs';

/**
 * A B+ tree implementation.
 *
 * @template KeysType - The type of the keys in the B+ tree.
 * @template ValuesType - The type of the values in the B+ tree.
 * @template LeafNodeStorageType - The type of the leaf node storage.
 * @template InternalNodeStorageType - The type of the internal node storage.
 *
 */
export class BPlusTree<
  KeysType,
  ValuesType,
  LeafNodeStorageType extends LeafNodeStorage<KeysType, ValuesType, LeafNodeStorageType, InternalNodeStorageType>,
  InternalNodeStorageType extends InternalNodeStorage<
    KeysType,
    ValuesType,
    LeafNodeStorageType,
    InternalNodeStorageType
  >,
> {
  private root!: LeafNodeStorageType | InternalNodeStorageType;
  private readonly storage: NodeStorage<KeysType, ValuesType, LeafNodeStorageType, InternalNodeStorageType>;
  private readonly order: number;

  /**
   * Creates a new B+ tree.
   *
   * @param {NodeStorage} storage - The node storage to use.
   * @param {number} order - The order of the B+ tree (maximum number of keys per node).
   * @throws {Error} If the order is less than 1.
   */
  constructor(storage: NodeStorage<KeysType, ValuesType, LeafNodeStorageType, InternalNodeStorageType>, order: number) {
    if (order < 1) throw new Error('order must be >= 1');
    this.storage = storage;
    this.order = order;
  }

  /**
   * Initializes the B+ tree.
   *
   * @returns {Promise<void>} A promise that resolves when the tree is initialized.
   */
  async init(): Promise<void> {
    this.root = await this.storage.createTree();
  }

  /**
   * Loads the B+ tree from an existing root node.
   *
   * @param {LeafNodeStorageType | InternalNodeStorageType} root - The root node to load.
   */
  load(root: LeafNodeStorageType | InternalNodeStorageType): void {
    this.root = root;
  }

  /**
   * Gets the current root node of the B+ tree.
   *
   * @returns {LeafNodeStorageType | InternalNodeStorageType} The root node.
   */
  getRoot(): LeafNodeStorageType | InternalNodeStorageType {
    return this.root;
  }

  getStorage(): NodeStorage<KeysType, ValuesType, LeafNodeStorageType, InternalNodeStorageType> {
    return this.storage;
  }

  beginTransaction(): void {
    // Check if storage supports transactions
    if (this.storage.beginTransaction) {
      this.storage.beginTransaction();
    } else {
      console.log('Storage does not support transactions.');
    }
  }

  async commitTransaction(): Promise<void> {
    // Check if storage supports transactions
    if (this.storage.commitTransaction) {
      await this.storage.commitTransaction();
    } else {
      console.log('Storage does not support transactions.');
    }
  }

  abortTransaction(): void {
    // Check if storage supports transactions
    if (this.storage.abortTransaction) {
      this.storage.abortTransaction();
    } else {
      console.log('Storage does not support transactions.');
    }
  }

  /**
   * Inserts a key-value pair into the B+ tree.
   *
   * @param {KeysType} key - The key to insert.
   * @param {ValuesType} value - The value to insert.
   * @returns {Promise<void>} A promise that resolves when the insertion is complete.
   */
  async insert(key: KeysType, value: ValuesType): Promise<void> {
    // [DEBUG]
    debug_incrementFnCallCount('tree.insert()');
    //

    //
    if (this.getRoot().isLeaf) {
      //lfs({leaf: this.getRoot()});
    } else {
      //int({internal: this.getRoot()})
    }
    //

    //
    const { leaf, parents, parentIndices } = await this.findLeafWithPath(key);
    //for(const p of parents){
    //  int({internal: p, tree: this});
    //}
    //

    //
    await this.insertInLeaf(leaf, key, value);
    //lfs({leaf: leaf, key: key, value: value});
    //for(const p of parents){
    //  int({internal: p});
    //}
    //

    if (leaf.keys.length > this.order) {
      const parent = parents.length > 0 ? parents[parents.length - 1] : null;
      const idx = parentIndices.length > 0 ? parentIndices[parentIndices.length - 1] : -1;

      const redistributed = await this.tryRedistributeLeafBeforeSplit(
        leaf,
        parent ?? undefined,
        idx >= 0 ? idx : undefined,
      );

      // redistribute never changes block ids
      //lfs({leaf: leaf, key: key, value: value});
      //for(const p of parents){
      //  int({internal: p});
      //}

      if (!redistributed) {
        await this.splitLeaf(leaf, parents, parentIndices);
      }
    }
  }

  /**
   * Searches for a key in the B+ tree and returns its associated value.
   *
   * @param {KeysType} key - The key to search for.
   * @returns {Promise<ValuesType | null>} A promise that resolves to the value associated with the key, or null if not found.
   */
  async search(key: KeysType): Promise<ValuesType | null> {
    const leaf = await this.findLeaf(key);
    const result = await leaf.getCursorBeforeKey(key);
    const { cursor, isAtKey } = result;

    if (!isAtKey) return null;
    const pair = cursor.getKeyValuePairAfter();
    return pair ? pair.value : null;
  }

  //
  // Add update function to update a (K,V) pair to (K,V').
  // - search for leaf containing K -> change V to V' -> persist the change (should only overwrite, not allocateAndWrite)
  async update(key: KeysType, value: ValuesType): Promise<void> {
    // NOTE: current implementation just does a delete followed by a insert. This is to not make the keys in internal nodes become wrong.
    await this.delete(key);
    await this.insert(key, value);
  }

  /**
   * Deletes a key-value pair from the B+ tree.
   *
   * @param {KeysType} key - The key to delete.
   * @returns {Promise<void>} A promise that resolves when the deletion is complete.
   */
  async delete(key: KeysType): Promise<void> {
    const { leaf, parents, parentIndices } = await this.findLeafWithPath(key);

    //
    //lfs({leaf:leaf, key: key})
    //for(const p of parents){
    //  int({internal: p});
    //}
    //

    const { cursor, isAtKey } = await leaf.getCursorBeforeKey(key);
    if (!isAtKey) return;

    await cursor.removeKeyValuePairAfter();

    const minKeys = Math.ceil(this.order / 2);

    if (leaf === this.root) {
      if (leaf.keys.length === 0) {
        this.root = await this.storage.createLeaf(); // created leaf is not persisted
      }
      return;
    }

    //
    //lfs({leaf:leaf, key: key})
    // for(const p of parents){
    //   int({internal: p});
    // }
    //

    if (leaf.keys.length < minKeys) {
      await this.handleUnderflow(leaf, parents, parentIndices);
    }

    //
    // lfs({leaf:leaf, key: key})
    //for(const p of parents){
    //   int({internal: p});
    //}
    //
  }

  /**
   * Prints a simple text representation of the B+ tree to the console.
   *
   * @returns {void}
   */
  printTree(): void {
    if (!this.root) {
      console.log('<empty>');
      return;
    }

    const q: (LeafNodeStorageType | InternalNodeStorageType)[] = [this.root];
    while (q.length) {
      const levelCount = q.length;
      const parts: string[] = [];
      for (let i = 0; i < levelCount; i++) {
        const n = q.shift()!;
        if (n.isLeaf) {
          parts.push(`Leaf(${n.keys.map((k) => String(k)).join(',')})`);
        } else {
          const inNode = n;
          parts.push(`Internal(keys:${inNode.keys.map((k) => String(k)).join(',')})`);
          for (const c of inNode.children) q.push(c);
        }
      }
      console.log(parts.join(' | '));
    }
  }

  /**
   * Prints an ASCII representation of the B+ tree to the console.
   *
   * @returns {void}
   *
   * @example
   *         [15,20]
   *    --------|-------
   *    |       |      |
   * [5,10]   [15]   [20]
   */
  ascii(): void {
    if (!this.root) {
      console.log('<empty>');
      return;
    }

    const nodeText = (n: LeafNodeStorageType | InternalNodeStorageType) =>
      `[${n.keys.map((k) => String(k)).join(',')}]`;

    function layout(node: LeafNodeStorageType | InternalNodeStorageType): {
      lines: string[];
      width: number;
      middle: number;
    } {
      const text = nodeText(node);
      const textWidth = Math.max(1, text.length);

      if (node.isLeaf) {
        return { lines: [text], width: textWidth, middle: Math.floor(textWidth / 2) };
      }

      const internal = node;
      const childrenLayouts = internal.children.map((c) => layout(c));

      const gap = 3;
      const childrenWidth = childrenLayouts.reduce((s, cl) => s + cl.width, 0);
      const totalChildrenWidth = childrenWidth + Math.max(0, childrenLayouts.length - 1) * gap;
      let width = Math.max(textWidth, totalChildrenWidth);

      let childStarts: number[] = [];
      const computeChildStarts = () => {
        childStarts = [];
        let cur = Math.floor((width - totalChildrenWidth) / 2);
        for (const cl of childrenLayouts) {
          childStarts.push(cur);
          cur += cl.width + gap;
        }
      };
      computeChildStarts();

      let parentMiddle: number;
      if (childrenLayouts.length % 2 === 1) {
        const midIndex = Math.floor(childrenLayouts.length / 2);
        parentMiddle = childStarts[midIndex] + childrenLayouts[midIndex].middle;
        const leftNeeded = Math.max(0, Math.floor(textWidth / 2) - parentMiddle);
        const rightNeeded = Math.max(0, parentMiddle + Math.ceil(textWidth / 2) - (width - 1));
        if (leftNeeded > 0 || rightNeeded > 0) {
          width += leftNeeded + rightNeeded;
          computeChildStarts();
          parentMiddle = childStarts[midIndex] + childrenLayouts[midIndex].middle;
        }
      } else {
        parentMiddle = Math.floor(width / 2);
        const leftNeeded = Math.max(0, Math.floor(textWidth / 2) - parentMiddle);
        const rightNeeded = Math.max(0, parentMiddle + Math.ceil(textWidth / 2) - (width - 1));
        if (leftNeeded > 0 || rightNeeded > 0) {
          width += leftNeeded + rightNeeded;
          computeChildStarts();
          parentMiddle = Math.floor(width / 2);
        }
      }

      const parentStart = parentMiddle - Math.floor(text.length / 2);
      const parentLine =
        ' '.repeat(Math.max(0, parentStart)) + text + ' '.repeat(Math.max(0, width - parentStart - text.length));

      const childMiddles = childrenLayouts.map((cl, i) => childStarts[i] + cl.middle);
      const bridgeLeft = Math.min(...childMiddles);
      const bridgeRight = Math.max(...childMiddles);

      const bridgeRowArr = new Array(width).fill(' ');
      for (let c = bridgeLeft; c <= bridgeRight; c++) bridgeRowArr[c] = '-';
      bridgeRowArr[parentMiddle] = '|';

      const dropRowArr = new Array(width).fill(' ');
      for (const cm of childMiddles) dropRowArr[cm] = '|';

      const connectorLines = [bridgeRowArr.join(''), dropRowArr.join('')];

      const maxChildHeight = Math.max(...childrenLayouts.map((c) => c.lines.length));
      const childLines: string[] = [];
      for (let row = 0; row < maxChildHeight; row++) {
        let line = '';
        for (let i = 0; i < childrenLayouts.length; i++) {
          const cl = childrenLayouts[i];
          const clLine = cl.lines[row] ?? ' '.repeat(cl.width);
          const needPad = childStarts[i] - line.length;
          if (needPad > 0) line += ' '.repeat(needPad);
          line += clLine;
        }
        if (line.length < width) line += ' '.repeat(width - line.length);
        childLines.push(line);
      }

      const lines = [parentLine, ...connectorLines, ...childLines];
      return { lines, width, middle: parentMiddle };
    }

    const picture = layout(this.root);
    for (const l of picture.lines) console.log(l);
  }

  /**
   *  Same as ascii(), but prints values instead of keys
   */
  asciiValues(): void {
    if (!this.root) {
      console.log('<empty>');
      return;
    }

    const nodeText = (n: LeafNodeStorageType | InternalNodeStorageType) => {
      if (n.isLeaf && n.values !== undefined) {
        return `[${n.values.map((k) => String(k)).join(',')}]`;
      } else {
        return `[${n.keys.map((_) => '_').join(',')}]`;
      }
    };

    function layout(node: LeafNodeStorageType | InternalNodeStorageType): {
      lines: string[];
      width: number;
      middle: number;
    } {
      const text = nodeText(node);
      const textWidth = Math.max(1, text.length);

      if (node.isLeaf) {
        return { lines: [text], width: textWidth, middle: Math.floor(textWidth / 2) };
      }

      const internal = node;
      const childrenLayouts = internal.children.map((c) => layout(c));

      const gap = 3;
      const childrenWidth = childrenLayouts.reduce((s, cl) => s + cl.width, 0);
      const totalChildrenWidth = childrenWidth + Math.max(0, childrenLayouts.length - 1) * gap;
      let width = Math.max(textWidth, totalChildrenWidth);

      let childStarts: number[] = [];
      const computeChildStarts = () => {
        childStarts = [];
        let cur = Math.floor((width - totalChildrenWidth) / 2);
        for (const cl of childrenLayouts) {
          childStarts.push(cur);
          cur += cl.width + gap;
        }
      };
      computeChildStarts();

      let parentMiddle: number;
      if (childrenLayouts.length % 2 === 1) {
        const midIndex = Math.floor(childrenLayouts.length / 2);
        parentMiddle = childStarts[midIndex] + childrenLayouts[midIndex].middle;
        const leftNeeded = Math.max(0, Math.floor(textWidth / 2) - parentMiddle);
        const rightNeeded = Math.max(0, parentMiddle + Math.ceil(textWidth / 2) - (width - 1));
        if (leftNeeded > 0 || rightNeeded > 0) {
          width += leftNeeded + rightNeeded;
          computeChildStarts();
          parentMiddle = childStarts[midIndex] + childrenLayouts[midIndex].middle;
        }
      } else {
        parentMiddle = Math.floor(width / 2);
        const leftNeeded = Math.max(0, Math.floor(textWidth / 2) - parentMiddle);
        const rightNeeded = Math.max(0, parentMiddle + Math.ceil(textWidth / 2) - (width - 1));
        if (leftNeeded > 0 || rightNeeded > 0) {
          width += leftNeeded + rightNeeded;
          computeChildStarts();
          parentMiddle = Math.floor(width / 2);
        }
      }

      const parentStart = parentMiddle - Math.floor(text.length / 2);
      const parentLine =
        ' '.repeat(Math.max(0, parentStart)) + text + ' '.repeat(Math.max(0, width - parentStart - text.length));

      const childMiddles = childrenLayouts.map((cl, i) => childStarts[i] + cl.middle);
      const bridgeLeft = Math.min(...childMiddles);
      const bridgeRight = Math.max(...childMiddles);

      const bridgeRowArr = new Array(width).fill(' ');
      for (let c = bridgeLeft; c <= bridgeRight; c++) bridgeRowArr[c] = '-';
      bridgeRowArr[parentMiddle] = '|';

      const dropRowArr = new Array(width).fill(' ');
      for (const cm of childMiddles) dropRowArr[cm] = '|';

      const connectorLines = [bridgeRowArr.join(''), dropRowArr.join('')];

      const maxChildHeight = Math.max(...childrenLayouts.map((c) => c.lines.length));
      const childLines: string[] = [];
      for (let row = 0; row < maxChildHeight; row++) {
        let line = '';
        for (let i = 0; i < childrenLayouts.length; i++) {
          const cl = childrenLayouts[i];
          const clLine = cl.lines[row] ?? ' '.repeat(cl.width);
          const needPad = childStarts[i] - line.length;
          if (needPad > 0) line += ' '.repeat(needPad);
          line += clLine;
        }
        if (line.length < width) line += ' '.repeat(width - line.length);
        childLines.push(line);
      }

      const lines = [parentLine, ...connectorLines, ...childLines];
      return { lines, width, middle: parentMiddle };
    }

    const picture = layout(this.root);
    for (const l of picture.lines) console.log(l);
  }

  /**
   * Similar to ascii(), but prints representation of node blockIDs in the FS instead of the node.keys
   */

  asciiBlocks(): void {
    if (!this.root) {
      console.log('<empty>');
      return;
    }

    // const nodeText = (n: LeafNodeStorageType | InternalNodeStorageType) =>
    //   `[${n.keys.map((k) => String(k)).join(',')}]`;
    const nodeText = (n: LeafNodeStorageType | InternalNodeStorageType) => {
      if (n.isLeaf) {
        return `[<- ${String((n as unknown as { prevBlockId: number }).prevBlockId)} | ~${String((n as unknown as { blockId: number }).blockId)}~  | ${String((n as unknown as { nextBlockId: number }).nextBlockId)} ->]`;
      } else {
        if (n.children !== undefined) {
          return `[~${String((n as unknown as { blockId: number }).blockId)}~  | [${(n as unknown as { childBlockIds: number[] }).childBlockIds.map(String).join(', ')}]] ]`;
        } else {
          return `[~${String((n as unknown as { blockId: number }).blockId)}~]`;
        }
      }
    };

    function layout(node: LeafNodeStorageType | InternalNodeStorageType): {
      lines: string[];
      width: number;
      middle: number;
    } {
      const text = nodeText(node);
      const textWidth = Math.max(1, text.length);
      if (node.isLeaf) {
        return { lines: [text], width: textWidth, middle: Math.floor(textWidth / 2) };
      }
      const internal = node;
      const childrenLayouts = internal.children.map((c) => layout(c));
      const gap = 3;
      const childrenWidth = childrenLayouts.reduce((s, cl) => s + cl.width, 0);
      const totalChildrenWidth = childrenWidth + Math.max(0, childrenLayouts.length - 1) * gap;
      let width = Math.max(textWidth, totalChildrenWidth);
      let childStarts: number[] = [];
      const computeChildStarts = () => {
        childStarts = [];
        let cur = Math.floor((width - totalChildrenWidth) / 2);
        for (const cl of childrenLayouts) {
          childStarts.push(cur);
          cur += cl.width + gap;
        }
      };
      computeChildStarts();
      let parentMiddle: number;
      if (childrenLayouts.length % 2 === 1) {
        const midIndex = Math.floor(childrenLayouts.length / 2);
        parentMiddle = childStarts[midIndex] + childrenLayouts[midIndex].middle;
        const leftNeeded = Math.max(0, Math.floor(textWidth / 2) - parentMiddle);
        const rightNeeded = Math.max(0, parentMiddle + Math.ceil(textWidth / 2) - (width - 1));
        if (leftNeeded > 0 || rightNeeded > 0) {
          width += leftNeeded + rightNeeded;
          computeChildStarts();
          parentMiddle = childStarts[midIndex] + childrenLayouts[midIndex].middle;
        }
      } else {
        parentMiddle = Math.floor(width / 2);
        const leftNeeded = Math.max(0, Math.floor(textWidth / 2) - parentMiddle);
        const rightNeeded = Math.max(0, parentMiddle + Math.ceil(textWidth / 2) - (width - 1));
        if (leftNeeded > 0 || rightNeeded > 0) {
          width += leftNeeded + rightNeeded;
          computeChildStarts();
          parentMiddle = Math.floor(width / 2);
        }
      }
      const parentStart = parentMiddle - Math.floor(text.length / 2);
      const parentLine =
        ' '.repeat(Math.max(0, parentStart)) + text + ' '.repeat(Math.max(0, width - parentStart - text.length));
      const childMiddles = childrenLayouts.map((cl, i) => childStarts[i] + cl.middle);
      const bridgeLeft = Math.min(...childMiddles);
      const bridgeRight = Math.max(...childMiddles);
      const bridgeRowArr = new Array(width).fill(' ');
      for (let c = bridgeLeft; c <= bridgeRight; c++) bridgeRowArr[c] = '-';
      bridgeRowArr[parentMiddle] = '|';
      const dropRowArr = new Array(width).fill(' ');
      for (const cm of childMiddles) dropRowArr[cm] = '|';
      const connectorLines = [bridgeRowArr.join(''), dropRowArr.join('')];
      const maxChildHeight = Math.max(...childrenLayouts.map((c) => c.lines.length));
      const childLines: string[] = [];
      for (let row = 0; row < maxChildHeight; row++) {
        let line = '';
        for (let i = 0; i < childrenLayouts.length; i++) {
          const cl = childrenLayouts[i];
          const clLine = cl.lines[row] ?? ' '.repeat(cl.width);
          const needPad = childStarts[i] - line.length;
          if (needPad > 0) line += ' '.repeat(needPad);
          line += clLine;
        }
        if (line.length < width) line += ' '.repeat(width - line.length);
        childLines.push(line);
      }
      const lines = [parentLine, ...connectorLines, ...childLines];
      return { lines, width, middle: parentMiddle };
    }
    const picture = layout(this.root);
    for (const l of picture.lines) console.log(l);
  }

  /**
   * Returns an async generator that yields all key-value pairs in the B+ tree in order.
   *
   * @returns {AsyncGenerator<{ key: KeysType; value: ValuesType }, void, unknown>} An async generator yielding key-value pairs.
   */
  public async *entries(): AsyncGenerator<{ key: KeysType; value: ValuesType }, void, unknown> {
    if (!this.root) return;
    let leaf: LeafNodeStorageType | null = await this.getLeftmostLeaf();
    while (leaf) {
      for (let i = 0; i < leaf.keys.length; i++) {
        yield { key: leaf.keys[i], value: leaf.values[i] };
      }
      leaf = (await leaf.getNextLeaf()) as LeafNodeStorageType | null;
    }
  }

  /**
   * Returns an async generator that yields all key-value pairs in the B+ tree in reverse order.
   *
   * @returns {AsyncGenerator<{ key: KeysType; value: ValuesType }, void, unknown>} An async generator yielding key-value pairs in reverse order.
   */
  public async *reverseEntries(): AsyncGenerator<{ key: KeysType; value: ValuesType }, void, unknown> {
    if (!this.root) return;
    let leaf: LeafNodeStorageType | null = await this.getRightmostLeaf();
    while (leaf) {
      for (let i = leaf.keys.length - 1; i >= 0; i--) {
        yield { key: leaf.keys[i], value: leaf.values[i] };
      }
      leaf = (await leaf.getPrevLeaf()) as LeafNodeStorageType | null;
    }
  }

  /**
   * Returns an async iterator that yields all key-value pairs in the B+ tree in order.
   *
   * @returns {AsyncGenerator<{ key: KeysType; value: ValuesType }, void, unknown>} An async generator yielding key-value pairs.
   */
  public async *[Symbol.asyncIterator](): AsyncGenerator<{ key: KeysType; value: ValuesType }, void, unknown> {
    for await (const entry of this.entries()) {
      yield entry;
    }
  }

  /**
   * Returns an async generator that yields all keys in the B+ tree in order.
   *
   * @returns {AsyncGenerator<KeysType, void, unknown>} An async generator yielding keys.
   */
  public async *keys(): AsyncGenerator<KeysType, void, unknown> {
    for await (const entry of this.entries()) {
      yield entry.key;
    }
  }

  /**
   * Returns an async generator that yields all values in the B+ tree in order.
   *
   * @returns {AsyncGenerator<ValuesType, void, unknown>} An async generator yielding values.
   */
  public async *values(): AsyncGenerator<ValuesType, void, unknown> {
    for await (const entry of this.entries()) {
      yield entry.value;
    }
  }

  /**
   * Returns an async generator that yields all key-value pairs starting from the specified key.
   *
   * @param {KeysType} startKey - The key to start from.
   * @returns {AsyncGenerator<{ key: KeysType; value: ValuesType }, void, unknown>} An async generator yielding key-value pairs.
   */
  public async *entriesFrom(startKey: KeysType): AsyncGenerator<{ key: KeysType; value: ValuesType }, void, unknown> {
    if (!this.root) return;
    let leaf: LeafNodeStorageType | null = await this.findLeaf(startKey);
    let firstLeaf = true;

    while (leaf) {
      const startIdx = firstLeaf ? leaf.getLowerBoundIndex(startKey) : 0;
      firstLeaf = false;

      if (startIdx >= leaf.keys.length) {
        leaf = (await leaf.getNextLeaf()) as LeafNodeStorageType | null;
        continue;
      }

      for (let i = startIdx; i < leaf.keys.length; i++) {
        yield { key: leaf.keys[i], value: leaf.values[i] };
      }
      leaf = (await leaf.getNextLeaf()) as LeafNodeStorageType | null;
    }
  }

  /**
   * Returns an async generator that yields all key-value pairs within the specified key range.
   *
   * @param {KeysType} startKey - The start key of the range.
   * @param {KeysType} endKey - The end key of the range.
   * @param {Object} [options] - Options for the range query.
   * @param {boolean} [options.inclusiveStart=true] - Whether to include the start key.
   * @param {boolean} [options.inclusiveEnd=false] - Whether to include the end key.
   * @param {(a: KeysType, b: KeysType) => number} [options.comparator] - A custom comparator function for keys.
   * @returns {AsyncGenerator<{ key: KeysType; value: ValuesType }, void, unknown>} An async generator yielding key-value pairs within the range.
   */
  public async *range(
    startKey: KeysType,
    endKey: KeysType,
    options?: { inclusiveStart?: boolean; inclusiveEnd?: boolean; comparator?: (a: KeysType, b: KeysType) => number },
  ): AsyncGenerator<{ key: KeysType; value: ValuesType }, void, unknown> {
    const inclusiveStart = options?.inclusiveStart ?? true;
    const inclusiveEnd = options?.inclusiveEnd ?? false;
    const comparator = options?.comparator ?? ((a: KeysType, b: KeysType) => (a < b ? -1 : a > b ? 1 : 0));

    const startLeafGenerator = this.entriesFrom(startKey);
    for await (const { key, value } of startLeafGenerator) {
      const cmpStart = comparator(key, startKey);
      if (!inclusiveStart && cmpStart === 0) {
        continue;
      }
      const cmpEnd = comparator(key, endKey);
      if (cmpEnd > 0 || (!inclusiveEnd && cmpEnd === 0)) {
        break;
      }
      yield { key: key, value: value };
    }
  }

  /**
   * Executes a provided function once for each key-value pair in the B+ tree.
   *
   * @param {(key: KeysType, value: ValuesType) => void | Promise<void>} callback - The function to execute for each key-value pair.
   * @returns {Promise<void>} A promise that resolves when all key-value pairs have been processed.
   */
  public async forEach(callback: (key: KeysType, value: ValuesType) => void | Promise<void>): Promise<void> {
    for await (const { key, value } of this.entries()) {
      await callback(key, value);
    }
  }

  /**
   * Clears the B+ tree, removing all key-value pairs.
   *
   * @returns {Promise<void>} A promise that resolves when the tree is cleared.
   */
  public async clear(): Promise<void> {
    this.root = await this.storage.createTree();
  }

  private upperBoundKey(keys: KeysType[], key: KeysType): number {
    let lo = 0;
    let hi = keys.length;
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (this.storage.compareKeys(keys[mid], key) <= 0) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  private async getChildAt(
    internal: InternalNodeStorageType,
    index: number,
  ): Promise<LeafNodeStorageType | InternalNodeStorageType> {
    const childCount = internal.keys.length + 1;
    if (index < 0 || index >= childCount) {
      throw new Error('Child index out of bounds');
    }

    const inMemory = internal.children[index];
    if (inMemory) return inMemory;

    const cursor = await internal.getChildCursorAtFirstChild();
    const child = await cursor.getChild(index);
    internal.children[index] = child;
    return child;
  }

  private async materializeChildren(internal: InternalNodeStorageType): Promise<void> {
    const childCount = internal.keys.length + 1;
    const loaded: (LeafNodeStorageType | InternalNodeStorageType)[] = [];
    const cursor = await internal.getChildCursorAtFirstChild();
    for (let i = 0; i < childCount; i++) {
      loaded.push(await cursor.getChild());
      if (i < childCount - 1) cursor.moveNext();
    }
    internal.children = loaded;
  }

  private async findChildIndexInParent(
    parent: InternalNodeStorageType,
    node: LeafNodeStorageType | InternalNodeStorageType,
  ): Promise<number> {
    const childCount = parent.keys.length + 1;
    const cursor = await parent.getChildCursorAtFirstChild();
    for (let i = 0; i < childCount; i++) {
      const current = await cursor.getChild();
      if (current === node) return i;
      if (i < childCount - 1) cursor.moveNext();
    }
    return -1;
  }

  /**
   * Retrieves the leftmost leaf node of the B+ tree.
   *
   * @returns {Promise<LeafNodeStorageType>} A promise that resolves to the leftmost leaf node.
   * @throws {Error} If the tree is not initialized.
   */
  private async getLeftmostLeaf(): Promise<LeafNodeStorageType> {
    if (!this.root) throw new Error('Tree is not initialized');
    let node: LeafNodeStorageType | InternalNodeStorageType = this.root;
    while (!node.isLeaf) {
      const internal = node;
      node = await this.getChildAt(internal, 0);
    }
    return Promise.resolve(node);
  }

  /**
   * Retrieves the rightmost leaf node of the B+ tree.
   *
   * @returns {Promise<LeafNodeStorageType>} A promise that resolves to the rightmost leaf node.
   * @throws {Error} If the tree is not initialized.
   */
  private async getRightmostLeaf(): Promise<LeafNodeStorageType> {
    if (!this.root) throw new Error('Tree is not initialized');
    let node: LeafNodeStorageType | InternalNodeStorageType = this.root;
    while (!node.isLeaf) {
      const internal = node;
      node = await this.getChildAt(internal, internal.keys.length);
    }
    return Promise.resolve(node);
  }

  /**
   * Handles underflow in a node by borrowing or merging with siblings.
   *
   * Accepts optional parent stack (parents from root..parent and parentIndices) to avoid repeated findParent calls.
   *
   * @param {LeafNodeStorageType | InternalNodeStorageType} node - The node that is underflowing.
   * @param {InternalNodeStorageType[] | undefined} parents - Optional parent stack (root..parent of node).
   * @param {number[] | undefined} parentIndices - Optional indices for each parent in the stack.
   * @returns {Promise<void>} A promise that resolves when the underflow is handled.
   * @throws {Error} If the parent does not contain the node in its children.
   */
  private async handleUnderflow(
    node: LeafNodeStorageType | InternalNodeStorageType,
    parents?: InternalNodeStorageType[],
    parentIndices?: number[],
  ): Promise<void> {
    //
    let parent: InternalNodeStorageType | undefined;
    if (parents && parents.length > 0) {
      parent = parents[parents.length - 1];
    } else {
      parent = await this.findParent(node);
    }

    if (!parent) {
      return;
    }
    //

    let index: number;
    if (parentIndices && parentIndices.length > 0) {
      const stackIdx = parentIndices[parentIndices.length - 1];
      if (stackIdx >= 0 && (await this.getChildAt(parent, stackIdx)) === node) {
        index = stackIdx;
      } else {
        index = await this.findChildIndexInParent(parent, node);
      }
    } else {
      index = await this.findChildIndexInParent(parent, node);
    }
    if (index === -1) throw new Error('Parent does not contain node in children');
    //

    //
    await this.materializeChildren(parent);
    //

    //
    const childCount = parent.keys.length + 1;
    const leftSibling = index > 0 ? parent.children[index - 1] : null;
    const rightSibling = index < childCount - 1 ? parent.children[index + 1] : null;
    //

    const minKeys = Math.ceil(this.order / 2);

    //
    if (leftSibling && leftSibling.keys.length > minKeys) {
      if (node.isLeaf) {
        const ls = leftSibling as LeafNodeStorageType;
        const borrowedKey = ls.keys.pop() as KeysType;
        const borrowedValue = ls.values.pop() as ValuesType;
        node.keys.unshift(borrowedKey);
        node.values.unshift(borrowedValue);
        parent.keys[index - 1] = node.keys[0];
        await this.storage.persistNode(ls);
        await this.storage.persistNode(node);
        await this.storage.persistNode(parent);
      } else {
        const ls = leftSibling as InternalNodeStorageType;
        const newSeparator = await ls.moveLastChildTo(parent.keys[index - 1], node);
        parent.keys[index - 1] = newSeparator;
        await this.storage.persistNode(parent);
      }
      return;
    }
    //

    //
    if (rightSibling && rightSibling.keys.length > minKeys) {
      if (node.isLeaf) {
        const rs = rightSibling as LeafNodeStorageType;
        const borrowedKey = rs.keys.shift() as KeysType;
        const borrowedValue = rs.values.shift() as ValuesType;
        node.keys.push(borrowedKey);
        node.values.push(borrowedValue);
        parent.keys[index] = rs.keys[0];
        await this.storage.persistNode(rs);
        await this.storage.persistNode(node);
        await this.storage.persistNode(parent);
      } else {
        const rs = rightSibling as InternalNodeStorageType;
        const newSeparator = await rs.moveFirstChildTo(node, parent.keys[index]);
        parent.keys[index] = newSeparator;
        await this.storage.persistNode(parent);
      }
      return;
    }
    //

    //
    if (leftSibling) {
      const separatorKey = parent.keys[index - 1];
      await leftSibling.mergeWithNext(separatorKey, node);

      //
      parent.keys.splice(index - 1, 1);
      parent.children.splice(index, 1);
      parent.childBlockIds!.splice(index, 1);
      //

      await this.storage.persistNode(parent);
    } else if (rightSibling) {
      const separatorKey = parent.keys[index];
      await node.mergeWithNext(separatorKey, rightSibling);
      //
      parent.keys.splice(index, 1);
      parent.children.splice(index + 1, 1);
      parent.childBlockIds!.splice(index + 1, 1);
      //
      await this.storage.persistNode(parent);
    }
    //

    //
    if (parent === this.root) {
      if (!parent.isLeaf && parent.keys.length === 0) {
        this.root = await this.getChildAt(parent, 0);
      }
      return;
    }
    //

    if (parent.keys.length < minKeys) {
      if (parents && parents.length > 0) {
        const parentsUp = parents.slice(0, -1);
        const parentIndicesUp = parentIndices ? parentIndices.slice(0, -1) : undefined;
        await this.handleUnderflow(parent, parentsUp, parentIndicesUp);
      } else {
        await this.handleUnderflow(parent);
      }
    }
  }

  /**
   * Finds the leaf node that should contain the specified key.
   *
   * This function is kept for simple calls, but the preferred fast variant returning the parent path
   * is findLeafWithPath (used on insert to avoid repeated parent searches).
   *
   * @param {KeysType} key - The key to find the leaf for.
   * @returns {Promise<LeafNodeStorageType>} A promise that resolves to the leaf node.
   * @throws {Error} If the child node cannot be found while descending.
   */
  private async findLeaf(key: KeysType): Promise<LeafNodeStorageType> {
    const { leaf } = await this.findLeafWithPath(key);
    return leaf;
  }

  /**
   * Finds the leaf node and returns the path (parents and indices) from the root to that leaf.
   *
   * This avoids calling findParent repeatedly. Each parent in `parents` corresponds to the index
   * in `parentIndices` for the child used to descend.
   */
  private async findLeafWithPath(key: KeysType): Promise<{
    leaf: LeafNodeStorageType;
    parents: InternalNodeStorageType[];
    parentIndices: number[];
  }> {
    if (!this.root) throw new Error('Tree is not initialized');
    const parents: InternalNodeStorageType[] = [];
    const parentIndices: number[] = [];

    let node: LeafNodeStorageType | InternalNodeStorageType = this.root;
    while (!node.isLeaf) {
      const internal = node;
      const { cursor } = await internal.getChildCursorAtKey(key);
      const child = await cursor.getChild();
      if (!child) throw new Error('Child not found while descending');

      const idx = this.upperBoundKey(internal.keys, key);
      parents.push(internal);
      parentIndices.push(idx);

      node = child;
    }

    return { leaf: node, parents, parentIndices };
  }

  /**
   * Finds the parent of a given node.
   *
   * Kept as a fallback for places that don't have the path handy; avoid calling this from hot paths.
   *
   * @param {LeafNodeStorageType | InternalNodeStorageType} child - The child node whose parent is to be found.
   * @returns {Promise<InternalNodeStorageType | undefined>} A promise that resolves to the parent node, or null if the child is the root.
   */
  private async findParent(
    child: LeafNodeStorageType | InternalNodeStorageType,
  ): Promise<InternalNodeStorageType | undefined> {
    if (child === this.root) return undefined;
    if (this.root.isLeaf) return undefined;
    return this.findParentRecursive(this.root, child);
  }

  /**
   * Recursively finds the parent of a given child node starting from a specified node.
   *
   * @param {InternalNodeStorageType} node - The current node to search from.
   * @param {LeafNodeStorageType | InternalNodeStorageType} child - The child node whose parent is to be found.
   * @returns {Promise<InternalNodeStorageType | undefined>} A promise that resolves to the parent node, or undefined if not found.
   */
  private async findParentRecursive(
    node: InternalNodeStorageType,
    child: LeafNodeStorageType | InternalNodeStorageType,
  ): Promise<InternalNodeStorageType | undefined> {
    const cursor = await node.getChildCursorAtFirstChild();
    const childCount = node.keys.length + 1;

    for (let i = 0; i < childCount; i++) {
      const currentChild = await cursor.getChild();
      if (currentChild === child) {
        return node;
      }
      if (!currentChild.isLeaf) {
        const parent = await this.findParentRecursive(currentChild, child);
        if (parent) return parent;
      }
      if (i < childCount - 1) cursor.moveNext();
    }
    return undefined;
  }

  /**
   * Inserts a key-value pair into a leaf node.
   *
   * @param {LeafNodeStorageType} leaf - The leaf node to insert into.
   * @param {KeysType} key - The key to insert.
   * @param {ValuesType} value - The value to insert.
   * @returns {Promise<void>} A promise that resolves when the insertion is complete.
   */
  private async insertInLeaf(leaf: LeafNodeStorageType, key: KeysType, value: ValuesType): Promise<void> {
    //lfs({leaf: leaf, key: key, value: value});
    const result = await leaf.getCursorBeforeKey(key);
    const { cursor } = result;
    await cursor.insert(key, value);
    //lfs({leaf: leaf, key: key, value: value});
  }

  /**
   * Attempt to redistribute keys from an overfull leaf into an adjacent sibling
   * so we can avoid splitting the leaf. Returns true when redistribution happened.
   *
   * Accepts an optional parent and index (index of leaf inside parent.children) to avoid a findParent call.
   *
   * @param {LeafNodeStorageType} leaf - The leaf node to redistribute from.
   * @param {InternalNodeStorageType | undefined} parent - Optional parent of the leaf.
   * @param {number | undefined} idx - Optional index of the leaf inside parent's children.
   * @returns {Promise<boolean>} A promise that resolves to true if redistribution occurred, false otherwise.
   */
  private async tryRedistributeLeafBeforeSplit(
    leaf: LeafNodeStorageType,
    parent?: InternalNodeStorageType,
    idx?: number,
  ): Promise<boolean> {
    if (!parent) {
      parent = await this.findParent(leaf);
      if (!parent) return false;
      idx = await this.findChildIndexInParent(parent, leaf);
      if (idx === -1) throw new Error('Parent does not contain leaf in children');
    } else {
      if (idx === undefined) {
        idx = await this.findChildIndexInParent(parent, leaf);
        if (idx === -1) throw new Error('Parent does not contain leaf in children');
      }
    }

    //int({internal: parent})
    //lfs({leaf: leaf})

    const childIndex = idx;

    const childCount = parent.keys.length + 1;

    const left = childIndex > 0 ? ((await this.getChildAt(parent, childIndex - 1)) as LeafNodeStorageType) : null;
    const right =
      childIndex < childCount - 1 ? ((await this.getChildAt(parent, childIndex + 1)) as LeafNodeStorageType) : null;

    if (left && left.keys.length < this.order) {
      const movedKey = leaf.keys.shift() as KeysType;
      const movedVal = leaf.values.shift() as ValuesType;
      left.keys.push(movedKey);
      left.values.push(movedVal);
      parent.keys[childIndex - 1] = leaf.keys[0];

      leaf.prevLeaf = left;
      leaf.prevBlockId = left.blockId;

      left.nextLeaf = leaf;
      left.nextBlockId = leaf.blockId;

      await this.storage.persistNode(left);
      await this.storage.persistNode(leaf);
      await this.storage.persistNode(parent);
      return true;
    }

    if (right && right.keys.length < this.order) {
      const movedKey = leaf.keys.pop() as KeysType;
      const movedVal = leaf.values.pop() as ValuesType;
      right.keys.unshift(movedKey);
      right.values.unshift(movedVal);
      parent.keys[childIndex] = right.keys[0];

      leaf.nextLeaf = right;
      leaf.nextBlockId = right.blockId;

      right.prevLeaf = leaf;
      right.prevBlockId = leaf.blockId;

      await this.storage.persistNode(right);
      await this.storage.persistNode(leaf);
      await this.storage.persistNode(parent);
      return true;
    }

    return false;
  }

  /**
   * Splits a leaf node that has exceeded the maximum number of keys.
   *
   * Accepts optional parent stack (parents, parentIndices) to avoid repeated findParent calls.
   *
   * @param {LeafNodeStorageType} leaf - The leaf node to split.
   * @param {InternalNodeStorageType[] | undefined} parents - Optional parent stack (root..parent).
   * @param {number[] | undefined} parentIndices - Optional indices for each parent.
   * @returns {Promise<void>} A promise that resolves when the split is complete.
   */
  private async splitLeaf(
    leaf: LeafNodeStorageType,
    parents?: InternalNodeStorageType[],
    parentIndices?: number[],
  ): Promise<void> {
    //lfs({leaf: leaf});

    const mid = Math.ceil(leaf.keys.length / 2);
    const newLeaf = await this.storage.createLeaf(); // created leaf is not yet persisted, has no ID.

    newLeaf.keys = leaf.keys.splice(mid);
    newLeaf.values = leaf.values.splice(mid);

    newLeaf.nextLeaf = leaf.nextLeaf;

    newLeaf.prevLeaf = leaf;

    leaf.nextLeaf = newLeaf;

    if (newLeaf.nextLeaf) {
      newLeaf.nextLeaf.prevLeaf = newLeaf;
    }

    const promotedKey = newLeaf.keys[0];

    const parent = parents && parents.length > 0 ? parents[parents.length - 1] : undefined;
    const idx = parentIndices && parentIndices.length > 0 ? parentIndices[parentIndices.length - 1] : undefined;

    // newLeaf is not yet persisted at this point, so it has no ID.
    // lfs({leaf: newLeaf})
    // lfs({leaf: leaf});

    await this.insertInParent(leaf, promotedKey, newLeaf, parent, idx, parents, parentIndices);
  }

  /**
   * Attempt to redistribute children from an overfull internal node into an adjacent sibling
   * so we can avoid splitting the internal node. Returns true when redistribution happened.
   *
   * This function still uses findParent if parent is not provided.
   *
   * @param {InternalNodeStorageType} internal - The internal node to redistribute from.
   * @param {InternalNodeStorageType | undefined} parent - Optional parent of `internal`.
   * @param {number | undefined} idx - Optional index of `internal` in parent's children.
   * @returns {Promise<boolean>} A promise that resolves to true if redistribution occurred, false otherwise.
   */
  private async tryRedistributeInternalBeforeSplit(
    internal: InternalNodeStorageType,
    parent?: InternalNodeStorageType,
    idx?: number,
  ): Promise<boolean> {
    if (!parent) {
      parent = await this.findParent(internal);
      if (!parent) return false;
      idx = await this.findChildIndexInParent(parent, internal);
      if (idx === -1) throw new Error('Parent does not contain internal node in children');
    } else {
      if (idx === undefined) {
        idx = await this.findChildIndexInParent(parent, internal);
        if (idx === -1) throw new Error('Parent does not contain internal node in children');
      }
    }

    //
    //int({internal: parent});
    //int({internal: internal});
    //

    await this.materializeChildren(internal);

    const childCount = parent.keys.length + 1;
    const left = idx > 0 ? ((await this.getChildAt(parent, idx - 1)) as InternalNodeStorageType) : null;
    const right = idx < childCount - 1 ? ((await this.getChildAt(parent, idx + 1)) as InternalNodeStorageType) : null;

    //console.log(parent.childBlockIds, !left || left.blockId, internal.blockId, !right || right.blockId)

    if (left) await this.materializeChildren(left);
    if (right) await this.materializeChildren(right);

    if (left) {
      //int({internal: left});
    }
    if (right) {
      //int({internal: right});
    }

    if (left && left.keys.length < this.order) {
      /**
       * A B
       *
       * We're splitting B.
       *
       * A ~ [1,2,3]
       * B ~ [4,5,6]
       *
       * We take 4 from B. (key, child, childBlockId)
       * And append it to A.
       *
       * s.t. A' ~ [1,2,3,4] and B' ~ [5,6]
       *
       */
      //
      const sepFromParent = parent.keys[idx - 1];
      const movedBlockId = internal.childBlockIds!.shift();
      const movedChild = internal.children.shift() as LeafNodeStorageType | InternalNodeStorageType;
      const newParentSep = internal.keys.shift() as KeysType;
      //
      left.keys.push(sepFromParent);
      left.children.push(movedChild);
      left.childBlockIds!.push(movedBlockId);

      //
      parent.keys[idx - 1] = newParentSep;

      await this.storage.persistNode(internal);
      await this.storage.persistNode(left);
      await this.storage.persistNode(parent);
      return true;
    }

    if (right && right.keys.length < this.order) {
      /**
       * B C
       *
       * We're splitting B.
       *
       * B ~ [4,5,6]
       * C ~ [7,8,9]
       *
       * We take 6 from B. (key, child, childBlockId)
       * And prepend it to C.
       *
       * s.t. C' ~ [6,7,8,9] and B' ~ [4,5]
       *
       */
      const sepFromParent = parent.keys[idx];
      //
      const movedBlockId = internal.childBlockIds!.pop();
      const movedChild = internal.children.pop() as LeafNodeStorageType | InternalNodeStorageType;
      const newParentSep = internal.keys.pop() as KeysType;
      //
      right.keys.unshift(sepFromParent);
      right.children.unshift(movedChild);
      right.childBlockIds!.unshift(movedBlockId);
      //
      parent.keys[idx] = newParentSep;

      await this.storage.persistNode(internal);
      await this.storage.persistNode(right);
      await this.storage.persistNode(parent);
      return true;
    }

    return false;
  }

  /**
   * Splits an internal node that has exceeded the maximum number of keys.
   *
   * @param {InternalNodeStorageType} internal - The internal node to split.
   * @param {InternalNodeStorageType[] | undefined} parents - Optional parent stack (root..parent).
   * @param {number[] | undefined} parentIndices - Optional indices for each parent.
   * @returns {Promise<void>} A promise that resolves when the split is complete.
   */
  private async splitInternalNode(
    internal: InternalNodeStorageType,
    parents?: InternalNodeStorageType[],
    parentIndices?: number[],
  ): Promise<void> {
    const parent = parents && parents.length > 0 ? parents[parents.length - 1] : undefined;
    const idx = parentIndices && parentIndices.length > 0 ? parentIndices[parentIndices.length - 1] : undefined;

    //
    //if(parent){
    //  int({internal: parent});
    //}
    //int({internal: internal})
    //

    const redistributed = await this.tryRedistributeInternalBeforeSplit(internal, parent, idx);
    if (redistributed) return;

    await this.materializeChildren(internal);

    const mid = Math.floor(internal.keys.length / 2);
    const promotedKey = internal.keys[mid];

    //console.log("BFR KEYS", internal.keys);
    const leftKeys = internal.keys.slice(0, mid);
    const rightKeys = internal.keys.slice(mid + 1);
    //console.log("AFTR KEYS", leftKeys, rightKeys);

    // throw new Error("NOT AN ERR, SPLIT INTERNAL CALLED!");

    const leftChildren = internal.children.slice(0, mid + 1);
    const rightChildren = internal.children.slice(mid + 1);
    const leftBlockIds = internal.childBlockIds!.slice(0, mid + 1);

    internal.keys = leftKeys;
    internal.children = leftChildren;
    internal.childBlockIds = leftBlockIds;

    //int({internal: internal})
    await this.storage.persistNode(internal);
    //int({internal: internal})

    const newInternal = await this.storage.allocateInternalNodeStorage(rightChildren, rightKeys);
    if (!newInternal.childBlockIds) {
      newInternal.childBlockIds = newInternal.children.map((c) => c.blockId);
    }
    //int({internal: newInternal})
    //int({internal: internal})

    await this.insertInParent(internal, promotedKey, newInternal, parent, idx, parents, parentIndices);
  }

  /**
   * Inserts a promoted key and new node into the parent of a given node.
   *
   * Accepts optional parent and idx so callers that already have the parent/path don't need to call findParent.
   *
   * @param {LeafNodeStorageType | InternalNodeStorageType} node - The node whose parent will receive the promoted key and new node.
   * @param {KeysType} promotedKey - The key to promote to the parent.
   * @param {LeafNodeStorageType | InternalNodeStorageType} newNode - The new node to insert into the parent.
   * @param {InternalNodeStorageType | undefined} parent - Optional parent of node.
   * @param {number | undefined} idx - Optional index of node in parent.children.
   * @returns {Promise<void>} A promise that resolves when the insertion is complete.
   * @throws {Error} If the parent node cannot be found.
   * @throws {Error} If the parent does not contain the node as a child.
   */
  private async insertInParent(
    node: LeafNodeStorageType | InternalNodeStorageType,
    promotedKey: KeysType,
    newNode: LeafNodeStorageType | InternalNodeStorageType,
    parent?: InternalNodeStorageType,
    idx?: number,
    parentsPath?: InternalNodeStorageType[],
    parentIndicesPath?: number[],
  ): Promise<void> {
    // parent may still be undefined at this point

    //
    if (node === this.root) {
      //console.log("rooted~")
      const newRoot = await this.storage.allocateInternalNodeStorage([node, newNode], [promotedKey]);
      if (!newRoot.childBlockIds) {
        newRoot.childBlockIds = newRoot.children.map((x) => x.blockId);
      }
      this.root = newRoot;
      //int({internal: newRoot})
      return;
    }
    //

    //
    if (!parent) {
      parent = await this.findParent(node);
      if (!parent) throw new Error('Parent not found while inserting in parent');
      idx = await this.findChildIndexInParent(parent, node);
      if (idx === -1) throw new Error('Parent does not contain node as child');
    } else {
      if (idx === undefined) {
        idx = await this.findChildIndexInParent(parent, node);
        if (idx === -1) throw new Error('Parent does not contain node as child');
      }
    }
    //
    if (!parent.childBlockIds) {
      parent.childBlockIds = [];
    }

    //
    const childIndex = idx;
    //int({internal: parent})
    await this.materializeChildren(parent);
    //int({internal: parent})
    //

    //
    await this.storage.persistNode(newNode);
    //

    parent.keys.splice(childIndex, 0, promotedKey);
    parent.children.splice(childIndex + 1, 0, newNode);
    parent.childBlockIds.splice(childIndex + 1, 0, newNode.blockId);
    //int({internal: parent})

    if (parent.keys.length > this.order) {
      const parentsUp = parentsPath && parentsPath.length > 0 ? parentsPath.slice(0, -1) : undefined;
      const parentIndicesUp =
        parentIndicesPath && parentIndicesPath.length > 0 ? parentIndicesPath.slice(0, -1) : undefined;
      await this.splitInternalNode(parent, parentsUp, parentIndicesUp);
    } else {
      await this.storage.persistNode(parent);
    }
  }
}

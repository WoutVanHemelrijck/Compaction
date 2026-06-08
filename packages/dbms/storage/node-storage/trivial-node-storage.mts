// @author Mathias Bouhon Keulen
// @date 2025-11-13

import type {
  NodeStorage,
  NodeBaseStorage,
  LeafNodeStorage,
  InternalNodeStorage,
  LeafCursor,
  ChildCursor,
} from './node-storage.mjs';

/**
 * TrivialNodeStorage is a simple in-memory implementation of the NodeStorage interface.
 *
 * @template KeysType - The type of keys used in the nodes.
 * @template ValuesType - The type of values stored in the leaf nodes.
 */
export class TrivialNodeStorage<KeysType, ValuesType>
  implements
    NodeStorage<KeysType, ValuesType, TrivialLeafNode<KeysType, ValuesType>, TrivialInternalNode<KeysType, ValuesType>>
{
  constructor(
    public compareKeys: (a: KeysType, b: KeysType) => number,
    public keySize: (key: KeysType) => number,
  ) {}

  getMaxKeySize(): number {
    return Infinity;
  }

  async createTree(): Promise<TrivialLeafNode<KeysType, ValuesType>> {
    return Promise.resolve(this.createLeaf());
  }

  async createLeaf(): Promise<TrivialLeafNode<KeysType, ValuesType>> {
    return Promise.resolve(new TrivialLeafNode(this));
  }

  async createInternalNode(
    children: (TrivialLeafNode<KeysType, ValuesType> | TrivialInternalNode<KeysType, ValuesType>)[],
    keys: KeysType[],
  ): Promise<TrivialInternalNode<KeysType, ValuesType>> {
    return Promise.resolve(new TrivialInternalNode(this, children, keys));
  }

  async allocateInternalNodeStorage(
    children: (TrivialLeafNode<KeysType, ValuesType> | TrivialInternalNode<KeysType, ValuesType>)[],
    keys: KeysType[],
  ): Promise<TrivialInternalNode<KeysType, ValuesType>> {
    return Promise.resolve(this.createInternalNode(children, keys));
  }

  async persistNode(
    _node: TrivialLeafNode<KeysType, ValuesType> | TrivialInternalNode<KeysType, ValuesType>,
  ): Promise<void> {
    // No-op for in-memory storage
    return Promise.resolve();
  }
}

/**
 * TrivialNodeBase is the base class for nodes in the TrivialNodeStorage implementation.
 *
 * @template KeysType - The type of keys used in the nodes.
 * @template ValuesType - The type of values stored in the leaf nodes.
 */
export abstract class TrivialNodeBase<KeysType, ValuesType>
  implements
    NodeBaseStorage<
      KeysType,
      ValuesType,
      TrivialLeafNode<KeysType, ValuesType>,
      TrivialInternalNode<KeysType, ValuesType>
    >
{
  abstract readonly isLeaf: boolean;

  constructor(protected storage: TrivialNodeStorage<KeysType, ValuesType>) {}

  public getStorage(): TrivialNodeStorage<KeysType, ValuesType> {
    return this.storage;
  }

  canMergeWithNext(
    _key: KeysType,
    _nextNode: TrivialLeafNode<KeysType, ValuesType> | TrivialInternalNode<KeysType, ValuesType>,
  ): boolean {
    return false;
  }

  async mergeWithNext(
    _key: KeysType,
    _nextNode: TrivialLeafNode<KeysType, ValuesType> | TrivialInternalNode<KeysType, ValuesType>,
  ): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * TrivialLeafNode is the implementation of a leaf node in the TrivialNodeStorage.
 *
 * @template KeysType - The type of keys used in the nodes.
 * @template ValuesType - The type of values stored in the leaf nodes.
 */
export class TrivialLeafNode<KeysType, ValuesType>
  extends TrivialNodeBase<KeysType, ValuesType>
  implements
    LeafNodeStorage<
      KeysType,
      ValuesType,
      TrivialLeafNode<KeysType, ValuesType>,
      TrivialInternalNode<KeysType, ValuesType>
    >
{
  readonly isLeaf = true;
  keys: KeysType[] = [];
  values: ValuesType[] = [];

  nextLeaf: TrivialLeafNode<KeysType, ValuesType> | null = null;
  prevLeaf: TrivialLeafNode<KeysType, ValuesType> | null = null;

  constructor(storage: TrivialNodeStorage<KeysType, ValuesType>) {
    super(storage);
  }

  getCursorBeforeFirst(): TrivialLeafCursor<KeysType, ValuesType> {
    return new TrivialLeafCursor(this);
  }

  getLowerBoundIndex(key: KeysType): number {
    let lo = 0;
    let hi = this.keys.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (this.storage.compareKeys(this.keys[mid], key) < 0) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  getCursorBeforeKey(key: KeysType) {
    const index = this.getLowerBoundIndex(key);
    const cursor = new TrivialLeafCursor(this, index - 1);
    const isAtKey = index < this.keys.length && this.storage.compareKeys(this.keys[index], key) === 0;
    return { cursor, isAtKey };
  }

  async getNextLeaf(): Promise<TrivialLeafNode<KeysType, ValuesType> | null> {
    return Promise.resolve(this.nextLeaf);
  }

  async getPrevLeaf(): Promise<TrivialLeafNode<KeysType, ValuesType> | null> {
    return Promise.resolve(this.prevLeaf);
  }

  override canMergeWithNext(
    _key: KeysType,
    _nextNode: TrivialLeafNode<KeysType, ValuesType> | TrivialInternalNode<KeysType, ValuesType>,
  ): boolean {
    return this.keys.length + (_nextNode.isLeaf ? _nextNode.keys.length : 0) <= Number.MAX_SAFE_INTEGER;
  }

  override async mergeWithNext(
    _key: KeysType,
    nextNode: TrivialLeafNode<KeysType, ValuesType> | TrivialInternalNode<KeysType, ValuesType>,
  ): Promise<void> {
    await Promise.resolve();
    if (nextNode.isLeaf) {
      this.keys.push(...nextNode.keys);
      this.values.push(...nextNode.values);

      const successor = nextNode.nextLeaf ?? null;
      this.nextLeaf = successor;

      if (successor) {
        successor.prevLeaf = this;
      }
    }
  }
}

/**
 * TrivialInternalNode is the implementation of an internal node in the TrivialNodeStorage.
 *
 * @template KeysType - The type of keys used in the nodes.
 * @template ValuesType - The type of values stored in the leaf nodes.
 */
export class TrivialInternalNode<KeysType, ValuesType>
  extends TrivialNodeBase<KeysType, ValuesType>
  implements
    InternalNodeStorage<
      KeysType,
      ValuesType,
      TrivialLeafNode<KeysType, ValuesType>,
      TrivialInternalNode<KeysType, ValuesType>
    >
{
  readonly isLeaf = false;
  keys: KeysType[];
  children: (TrivialLeafNode<KeysType, ValuesType> | TrivialInternalNode<KeysType, ValuesType>)[];

  constructor(
    storage: TrivialNodeStorage<KeysType, ValuesType>,
    children: (TrivialLeafNode<KeysType, ValuesType> | TrivialInternalNode<KeysType, ValuesType>)[] = [],
    keys: KeysType[] = [],
  ) {
    super(storage);
    this.children = children;
    this.keys = keys;
  }

  async getChildCursorAtFirstChild(): Promise<TrivialChildCursor<KeysType, ValuesType>> {
    return Promise.resolve(new TrivialChildCursor(this));
  }

  async getChildCursorAtKey(
    key: KeysType,
  ): Promise<{ cursor: TrivialChildCursor<KeysType, ValuesType>; isAtKey: boolean }> {
    let index = 0;
    while (index < this.keys.length && this.storage.compareKeys(key, this.keys[index]) >= 0) {
      index++;
    }

    const cursor = new TrivialChildCursor<KeysType, ValuesType>(this);
    cursor.setPosition(index);

    const isAtKey = index > 0 && this.storage.compareKeys(key, this.keys[index - 1]) === 0;
    return Promise.resolve({ cursor, isAtKey });
  }

  isUnderfull(): boolean {
    const minKeys = Math.floor(this.keys.length / 2);
    return this.keys.length < minKeys;
  }

  async deallocateUnderfull(): Promise<
    TrivialLeafNode<KeysType, ValuesType> | TrivialInternalNode<KeysType, ValuesType>
  > {
    return Promise.resolve(this);
  }

  async moveLastChildTo(
    separatorKey: KeysType,
    nextNode: TrivialInternalNode<KeysType, ValuesType>,
  ): Promise<KeysType> {
    const lastChild = this.children.pop()!;
    const lastKey = this.keys.pop()!;
    nextNode.children.unshift(lastChild);
    nextNode.keys.unshift(separatorKey);
    return Promise.resolve(lastKey);
  }

  async moveFirstChildTo(
    previousNode: TrivialInternalNode<KeysType, ValuesType>,
    separatorKey: KeysType,
  ): Promise<KeysType> {
    const firstChild = this.children.shift()!;
    const firstKey = this.keys.shift()!;
    previousNode.children.push(firstChild);
    previousNode.keys.push(separatorKey);
    return Promise.resolve(firstKey);
  }

  override canMergeWithNext(
    _key: KeysType,
    _nextNode: TrivialLeafNode<KeysType, ValuesType> | TrivialInternalNode<KeysType, ValuesType>,
  ): boolean {
    return this.keys.length + (_nextNode.isLeaf ? 0 : _nextNode.keys.length) <= Number.MAX_SAFE_INTEGER;
  }

  override async mergeWithNext(
    key: KeysType,
    nextNode: TrivialLeafNode<KeysType, ValuesType> | TrivialInternalNode<KeysType, ValuesType>,
  ): Promise<void> {
    await Promise.resolve();
    if (!nextNode.isLeaf) {
      this.keys.push(key, ...nextNode.keys);
      this.children.push(...nextNode.children);
    }
  }
}

/**
 * TrivialLeafCursor is the implementation of a cursor for leaf nodes in the TrivialNodeStorage.
 *
 * @template KeysType - The type of keys used in the nodes.
 * @template ValuesType - The type of values stored in the leaf nodes.
 */
export class TrivialLeafCursor<KeysType, ValuesType>
  implements
    LeafCursor<KeysType, ValuesType, TrivialLeafNode<KeysType, ValuesType>, TrivialInternalNode<KeysType, ValuesType>>
{
  private position: number;

  constructor(
    public readonly leaf: TrivialLeafNode<KeysType, ValuesType>,
    startPos: number = -1,
  ) {
    this.position = startPos;
  }

  reset(): void {
    this.position = -1;
  }
  isAfterLast(): boolean {
    return this.position >= this.leaf.keys.length - 1;
  }
  getKeyValuePairAfter(): { key: KeysType; value: ValuesType } {
    return { key: this.leaf.keys[this.position + 1], value: this.leaf.values[this.position + 1] };
  }

  moveNext(): void {
    this.position++;
  }
  movePrev(): void {
    this.position--;
  }

  async insert(
    key: KeysType,
    value: ValuesType,
  ): Promise<{ nodes: TrivialLeafNode<KeysType, ValuesType>[]; keys: KeysType[] }> {
    const index = this.leaf.keys.findIndex((k) => this.leaf.getStorage().compareKeys(k, key) >= 0);
    const insertPos = index === -1 ? this.leaf.keys.length : index;
    this.leaf.keys.splice(insertPos, 0, key);
    this.leaf.values.splice(insertPos, 0, value);
    return Promise.resolve({ nodes: [this.leaf], keys: this.leaf.keys });
  }

  async removeKeyValuePairAfter(): Promise<void> {
    await Promise.resolve();
    this.leaf.keys.splice(this.position + 1, 1);
    this.leaf.values.splice(this.position + 1, 1);
  }
}

/**
 * TrivialChildCursor is the implementation of a cursor for child nodes in internal nodes of the TrivialNodeStorage.
 *
 * @template KeysType - The type of keys used in the nodes.
 * @template ValuesType - The type of values stored in the leaf nodes.
 */
export class TrivialChildCursor<KeysType, ValuesType>
  implements
    ChildCursor<KeysType, ValuesType, TrivialLeafNode<KeysType, ValuesType>, TrivialInternalNode<KeysType, ValuesType>>
{
  private position: number = 0;

  constructor(public readonly parent: TrivialInternalNode<KeysType, ValuesType>) {}

  setPosition(pos: number): void {
    this.position = pos;
  }

  reset(): void {
    this.position = 0;
  }

  isFirstChild(): boolean {
    return this.position === 0;
  }

  isLastChild(): boolean {
    return this.position === this.parent.children.length - 1;
  }

  async getChild(
    offset: number = 0,
  ): Promise<TrivialLeafNode<KeysType, ValuesType> | TrivialInternalNode<KeysType, ValuesType>> {
    const pos = this.position + offset;
    if (pos < 0 || pos >= this.parent.children.length) {
      throw new Error('Cursor position out of bounds');
    }
    return Promise.resolve(this.parent.children[pos]);
  }

  getKeyAfter(): KeysType {
    return this.parent.keys[this.position];
  }

  moveNext(): void {
    this.position++;
  }

  movePrev(): void {
    this.position--;
  }

  async replaceKeysAndChildrenAfterBy(
    count: number,
    replacementKeys: KeysType[],
    replacementChildren: (TrivialLeafNode<KeysType, ValuesType> | TrivialInternalNode<KeysType, ValuesType>)[],
  ): Promise<{
    nodes: (TrivialLeafNode<KeysType, ValuesType> | TrivialInternalNode<KeysType, ValuesType>)[];
    keys: KeysType[];
  }> {
    this.parent.keys.splice(this.position, count, ...replacementKeys);
    this.parent.children.splice(this.position, count + 1, ...replacementChildren);

    return Promise.resolve({ nodes: this.parent.children, keys: this.parent.keys });
  }
}

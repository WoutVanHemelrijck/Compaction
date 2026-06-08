// @author Mathias Bouhon Keulen
// @date 2025-11-13

/**
 * NodeStorage defines the abstraction for storage and management of nodes in a tree structure.
 * this can be implemented for various storage backends, such as in-memory, file-based, or database storage.
 * It provides methods for creating and managing leaf and internal nodes, as well as for comparing keys and determining key sizes.
 *
 * @template KeysType - The type of keys used in the nodes.
 * @template ValuesType - The type of values stored in the leaf nodes.
 * @template LeafNodeStorageType - The type of leaf node storage, extending LeafNodeStorage interface.
 * @template InternalNodeStorageType - The type of internal node storage, extending InternalNodeStorage interface.
 */
export interface NodeStorage<
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
  readonly compareKeys: (a: KeysType, b: KeysType) => number;
  readonly keySize: (key: KeysType) => number;
  getMaxKeySize(): number;
  createTree(): Promise<LeafNodeStorageType>;
  createLeaf(): Promise<LeafNodeStorageType>;
  createInternalNode(
    children: (LeafNodeStorageType | InternalNodeStorageType)[],
    keys: KeysType[],
  ): Promise<InternalNodeStorageType>;

  allocateInternalNodeStorage(
    children: (LeafNodeStorageType | InternalNodeStorageType)[],
    keys: KeysType[],
  ): Promise<InternalNodeStorageType>;

  persistNode(node: LeafNodeStorageType | InternalNodeStorageType): Promise<void>;
  beginTransaction?(): void;
  commitTransaction?(): Promise<void>;
  abortTransaction?(): void;
}

/**
 * NodeBaseStorage defines the base interface for nodes in a tree structure.
 * It provides methods for merging nodes and checking if merging is possible.
 *
 * @template KeysType - The type of keys used in the nodes.
 * @template ValuesType - The type of values stored in the leaf nodes.
 * @template LeafNodeStorageType - The type of leaf node storage, extending LeafNodeStorage interface.
 * @template InternalNodeStorageType - The type of internal node storage, extending InternalNodeStorage interface.
 */
export interface NodeBaseStorage<
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
  readonly isLeaf: boolean;
  canMergeWithNext(key: KeysType, nextNode: LeafNodeStorageType | InternalNodeStorageType): boolean;
  mergeWithNext(key: KeysType, nextNode: LeafNodeStorageType | InternalNodeStorageType): Promise<void>;
}

/**
 * LeafNodeStorage defines the interface for leaf nodes in a tree structure.
 * It extends NodeBaseStorage and provides methods for cursor management and leaf node traversal.
 *
 * @template KeysType - The type of keys used in the nodes.
 * @template ValuesType - The type of values stored in the leaf nodes.
 * @template leafNodeStorageType - The type of leaf node storage, extending LeafNodeStorage interface.
 * @template InternalNodeStorageType - The type of internal node storage, extending InternalNodeStorage interface.
 */
export interface LeafNodeStorage<
  KeysType,
  ValuesType,
  leafNodeStorageType extends LeafNodeStorage<KeysType, ValuesType, leafNodeStorageType, InternalNodeStorageType>,
  InternalNodeStorageType extends InternalNodeStorage<
    KeysType,
    ValuesType,
    leafNodeStorageType,
    InternalNodeStorageType
  >,
> extends NodeBaseStorage<KeysType, ValuesType, leafNodeStorageType, InternalNodeStorageType> {
  readonly isLeaf: true;
  keys: KeysType[];
  values: ValuesType[];
  nextLeaf: leafNodeStorageType | null;
  prevLeaf: leafNodeStorageType | null;
  blockId?: number;
  prevBlockId?: number;
  nextBlockId?: number;

  getCursorBeforeFirst(): LeafCursor<KeysType, ValuesType, leafNodeStorageType, InternalNodeStorageType>;
  getLowerBoundIndex(key: KeysType): number;
  getCursorBeforeKey(key: KeysType):
    | { cursor: LeafCursor<KeysType, ValuesType, leafNodeStorageType, InternalNodeStorageType>; isAtKey: boolean }
    | PromiseLike<{
        cursor: LeafCursor<KeysType, ValuesType, leafNodeStorageType, InternalNodeStorageType>;
        isAtKey: boolean;
      }>;

  getNextLeaf(): Promise<LeafNodeStorage<KeysType, ValuesType, leafNodeStorageType, InternalNodeStorageType> | null>;
  getPrevLeaf(): Promise<LeafNodeStorage<KeysType, ValuesType, leafNodeStorageType, InternalNodeStorageType> | null>;
}

/**
 * InternalNodeStorage defines the interface for internal nodes in a tree structure.
 * It extends NodeBaseStorage and provides methods for cursor management and child node traversal.
 *
 * @template KeysType - The type of keys used in the nodes.
 * @template ValuesType - The type of values stored in the leaf nodes.
 * @template leafNodeStorageType - The type of leaf node storage, extending LeafNodeStorage interface.
 * @template InternalNodeStorageType - The type of internal node storage, extending InternalNodeStorage interface.
 */
export interface InternalNodeStorage<
  KeysType,
  ValuesType,
  leafNodeStorageType extends LeafNodeStorage<KeysType, ValuesType, leafNodeStorageType, InternalNodeStorageType>,
  InternalNodeStorageType extends InternalNodeStorage<
    KeysType,
    ValuesType,
    leafNodeStorageType,
    InternalNodeStorageType
  >,
> extends NodeBaseStorage<KeysType, ValuesType, leafNodeStorageType, InternalNodeStorageType> {
  readonly isLeaf: false;
  keys: KeysType[];
  blockId?: number;
  childBlockIds?: (undefined | number)[];
  children: (leafNodeStorageType | InternalNodeStorageType)[];
  getChildCursorAtFirstChild(): Promise<
    ChildCursor<KeysType, ValuesType, leafNodeStorageType, InternalNodeStorageType>
  >;
  getChildCursorAtKey(key: KeysType): Promise<{
    cursor: ChildCursor<KeysType, ValuesType, leafNodeStorageType, InternalNodeStorageType>;
    isAtKey: boolean;
  }>;
  isUnderfull(): boolean;
  deallocateUnderfull(): Promise<leafNodeStorageType | InternalNodeStorageType>;
  moveLastChildTo(separatorKey: KeysType, nextNode: InternalNodeStorageType): Promise<KeysType>;
  moveFirstChildTo(previousNode: InternalNodeStorageType, separatorKey: KeysType): Promise<KeysType>;
}

/**
 * LeafCursor defines the interface for cursors that navigate through leaf nodes in a tree structure.
 * It provides methods for moving the cursor, accessing key-value pairs, and modifying the leaf node.
 *
 * @template KeysType - The type of keys used in the nodes.
 * @template ValuesType - The type of values stored in the leaf nodes.
 * @template leafNodeStorageType - The type of leaf node storage, extending LeafNodeStorage interface.
 * @template InternalNodeStorageType - The type of internal node storage, extending InternalNodeStorage interface.
 */
export interface LeafCursor<
  KeysType,
  ValuesType,
  leafNodeStorageType extends LeafNodeStorage<KeysType, ValuesType, leafNodeStorageType, InternalNodeStorageType>,
  InternalNodeStorageType extends InternalNodeStorage<
    KeysType,
    ValuesType,
    leafNodeStorageType,
    InternalNodeStorageType
  >,
> {
  readonly leaf: leafNodeStorageType;
  reset(): void;
  isAfterLast(): boolean;
  getKeyValuePairAfter(): { key: KeysType; value: ValuesType };
  moveNext(): void;
  movePrev(): void;
  insert(key: KeysType, value: ValuesType): Promise<{ nodes: leafNodeStorageType[]; keys: KeysType[] }>;
  removeKeyValuePairAfter(): Promise<void>;
}

/**
 * ChildCursor defines the interface for cursors that navigate through child nodes in an internal node of a tree structure.
 * It provides methods for moving the cursor, accessing child nodes, and modifying the internal node.
 *
 * @template KeysType - The type of keys used in the nodes.
 * @template ValuesType - The type of values stored in the leaf nodes.
 * @template leafNodeStorageType - The type of leaf node storage, extending LeafNodeStorage interface.
 * @template InternalNodeStorageType - The type of internal node storage, extending InternalNodeStorage interface.
 */
export interface ChildCursor<
  KeysType,
  ValuesType,
  leafNodeStorageType extends LeafNodeStorage<KeysType, ValuesType, leafNodeStorageType, InternalNodeStorageType>,
  InternalNodeStorageType extends InternalNodeStorage<
    KeysType,
    ValuesType,
    leafNodeStorageType,
    InternalNodeStorageType
  >,
> {
  reset(): void;
  isFirstChild(): boolean;
  isLastChild(): boolean;
  getChild(offset?: number): Promise<leafNodeStorageType | InternalNodeStorageType>;
  getKeyAfter(): KeysType;
  moveNext(): void;
  movePrev(): void;
  replaceKeysAndChildrenAfterBy(
    count: number,
    replacementKeys: KeysType[],
    replacementChildren: (leafNodeStorageType | InternalNodeStorageType)[],
  ): Promise<{ nodes: (leafNodeStorageType | InternalNodeStorageType)[]; keys: KeysType[] }>;
}

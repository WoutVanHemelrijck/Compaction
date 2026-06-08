// @author Mathias Bouhon Keulen, Frederick Hillen
// @date 2025-11-03

import assert from 'node:assert';

/*

This file provides an outline and test suite for an implementation of a 2-3-tree algorithm. Completing this algorithm is a
good way to bootstrap your B-tree implementation. (A 2-3-tree is a special case of a B-tree.)

Note: this outline and test suite is for an implementation where the values in the interior nodes are duplicates of values
that also appear in leaf nodes. It therefore corresponds to a B+-tree rather than a B-tree. For this project, you may choose
to implement either a B-tree or a B+-tree (or any other data structure that offers the specified performance). In the material
we provide, we often use "B-tree" and "B+-tree" interchangeably. Both are perfectly balanced trees with a variable number of
children per interior node.

*/
type LeafNode = string;
/**
 * An interior node is an array of odd length, where the elements at even indices are either string (i.e. leaf nodes)
 * or child interior nodes, and each element at odd index i is a string value v such that the values in the subtree rooted
 * at index i - 1 are not greater than v, and the values in the subtree rooted at index i + 1 are greater than v.
 *
 * In a 2-3-tree, all interior nodes have either two or three children.
 */
type InteriorNode = (Node | string)[];
type Node = LeafNode | InteriorNode;
/**
 * `null` represents the empty tree.
 */
type Tree = Node | null;

export function isLeaf(node: Node): node is LeafNode {
  return typeof node === 'string';
}

export function isFull(node: InteriorNode): boolean {
  return node.length > 5;
}

/**
 * Returns an updated version of the interior node, which may be overfull (more than 3 children/5 elements).
 *
 * If the node's children are themselves interior nodes, this function calls itself recursively on the appropriate child.
 * Then, it replaces the child by the recursive call's result (after splitting it if it is overfull).
 *
 * @param {InteriorNode} node - The interior node to insert into.
 * @param {string} value - The value to insert.
 * @returns {InteriorNode} - The updated interior node.
 */
function insertIntoSubtree(node: InteriorNode, value: string): InteriorNode {
  let idx = 0;
  while (idx < node.length) {
    if (idx % 2 === 1 && value < (node[idx] as string)) {
      break;
    }
    idx++;
  }

  const childIdx = idx % 2 === 0 ? idx : Math.max(idx - 1, 0);

  const child = node[childIdx];

  if (isLeaf(child)) {
    const newLeaf: LeafNode[] = [child, value].sort();
    if (newLeaf.length === 2) {
      node.splice(childIdx, 1, newLeaf[0], newLeaf[0], newLeaf[1]);
    } else if (newLeaf.length === 3) {
      node.splice(childIdx, 1, ...newLeaf);
    } else {
      node[childIdx] = newLeaf;
    }
  } else {
    const updatedChild = insertIntoSubtree(child, value);
    node[childIdx] = updatedChild;

    if (isFull(updatedChild)) {
      const mid = Math.floor(updatedChild.length / 2);
      const left = updatedChild.slice(0, mid);
      const right = updatedChild.slice(mid + 1);
      const midValue = updatedChild[mid];

      node.splice(childIdx, 1, left, midValue, right);
    }
  }

  return node;
}

/**
 * If the tree is an interior node, calls insertIntoSubtree on it. Then, if the result is overfull, it splits it into multiple nodes.
 *
 * @param {Tree} tree - The tree to insert into.
 * @param {string} value - The value to insert.
 * @returns {Tree} - The updated tree.
 */
function insert(tree: Tree, value: string): Tree {
  if (tree === null) {
    return value;
  }

  if (isLeaf(tree)) {
    const leaves = [tree, value].sort();
    if (leaves.length <= 2) return [leaves[0], leaves[0], leaves[1]]; // simple 2-element leaf
    // split leaf
    const left: LeafNode[] = [leaves[0], leaves[0]];
    const right: LeafNode[] = [leaves[2], leaves[2]];
    const middle = leaves[1];
    return [left, middle, right];
  }

  const updatedRoot = insertIntoSubtree(tree, value);

  if (isFull(updatedRoot)) {
    const mid = Math.floor(updatedRoot.length / 2);
    const left = updatedRoot.slice(0, mid);
    const right = updatedRoot.slice(mid + 1);
    const midValue = updatedRoot[mid];
    return [left, midValue, right];
  }

  return updatedRoot;
}

/**
 * Returns an updated version of the interior node, which may be underfull (just 1 child/element).
 *
 * If the node's children are themselves interior nodes, this function calls itself recursively on the appropriate child.
 * Then, if the child is underfull:
 * - if it has a predecessor and the predecessor has size 2, it is merged with the predecessor
 * - if it has a predecessor and the predecessor has size 3, the predecessor's last child is split off and added to the front of the child.
 * - otherwise, it must have a successor. If it has size 2, it is merged with the successor.
 * - otherwise, the successor has size 3. The successor's first child is split off and added to the end of the child.
 */
function deleteFromSubtree(node: InteriorNode, value: string): InteriorNode {
  const newNode: InteriorNode = [];

  // recurse into children, remove matching leaf children
  for (let i = 0; i < node.length; i += 2) {
    const child = node[i];
    const sep = node[i + 1] as string | undefined;

    if (Array.isArray(child)) {
      const updatedChild = deleteFromSubtree(child, value);
      // keep interior nodes (even if length === 1) so parent can decide how to merge/inline
      if (updatedChild.length > 0) newNode.push(updatedChild);
    } else {
      // leaf
      if (child !== value) {
        newNode.push(child);
      } else {
        // drop this leaf (and its following separator) by continuing
        continue;
      }
    }

    if (sep !== undefined) newNode.push(sep);
  }

  // ensure node ends with a child (odd length)
  if (newNode.length % 2 === 0) newNode.pop();
  if (newNode.length === 0) return newNode;

  // helpers
  const toArray = (n: Node): InteriorNode => (Array.isArray(n) ? n : [n]);

  type Part = { child: Node; sep?: string };
  const parts: Part[] = [];
  for (let i = 0; i < newNode.length; i += 2) {
    parts.push({ child: newNode[i], sep: newNode[i + 1] as string | undefined });
  }

  // compact adjacent interior <-> leaf by moving parent separator into interior when safe
  for (let i = 0; i < parts.length - 1; i++) {
    const cur = parts[i];
    const nxt = parts[i + 1];

    // interior followed by leaf -> try append leaf into interior (move cur.sep inside)
    if (Array.isArray(cur.child) && typeof nxt.child === 'string') {
      const merged: InteriorNode = [...cur.child];
      if (cur.sep !== undefined) merged.push(cur.sep);
      merged.push(nxt.child);
      if (merged.length <= 5) {
        cur.child = merged;
        cur.sep = nxt.sep;
        parts.splice(i + 1, 1);
        i--;
        continue;
      }
    }

    // leaf followed by interior -> try prepend leaf into interior
    if (typeof cur.child === 'string' && Array.isArray(nxt.child)) {
      const merged: InteriorNode = [cur.child];
      if (cur.sep !== undefined) merged.push(cur.sep);
      merged.push(...nxt.child);
      if (merged.length <= 5) {
        cur.child = merged;
        cur.sep = nxt.sep;
        parts.splice(i + 1, 1);
        i--;
        continue;
      }
    }
  }

  // fix underfull interior children (length === 1): borrow or merge with predecessor/successor
  for (let k = 0; k < parts.length; k++) {
    const part = parts[k];
    if (!Array.isArray(part.child)) continue;
    if (part.child.length !== 1) continue; // only handle underfull interior child

    // try predecessor
    if (k > 0 && Array.isArray(parts[k - 1].child)) {
      const pred = parts[k - 1].child;

      // pred has 2 children -> merge pred + predSep + part
      if (pred.length === 3) {
        const predSep = parts[k - 1].sep;
        const merged: InteriorNode = [...pred];
        if (predSep !== undefined) merged.push(predSep);
        merged.push(...toArray(part.child));
        parts[k - 1].child = merged;
        parts[k - 1].sep = part.sep;
        parts.splice(k, 1);
        k--;
        continue;
      }

      // pred has 3 children -> borrow last child from pred
      if (pred.length === 5) {
        const s2 = pred[pred.length - 2] as string;
        const c2 = pred[pred.length - 1];
        const newPred = pred.slice(0, pred.length - 2);
        const parentSep = parts[k - 1].sep;
        const childArr = toArray(part.child);
        const c2Arr = toArray(c2);
        const newChild: InteriorNode = [...c2Arr];
        if (parentSep !== undefined) newChild.push(parentSep);
        newChild.push(...childArr);
        parts[k - 1].child = newPred;
        parts[k - 1].sep = s2;
        parts[k].child = newChild;
        continue;
      }
    }

    // try successor
    if (k + 1 < parts.length && Array.isArray(parts[k + 1].child)) {
      const succ = parts[k + 1].child;

      // succ has 2 children -> merge part + part.sep + succ
      if (succ.length === 3) {
        const merged: InteriorNode = [...toArray(part.child)];
        if (part.sep !== undefined) merged.push(part.sep);
        merged.push(...succ);
        parts[k].child = merged;
        parts[k].sep = parts[k + 1].sep;
        parts.splice(k + 1, 1);
        k--;
        continue;
      }

      // succ has 3 children -> borrow first child from succ
      if (succ.length === 5) {
        const s0 = succ[1] as string;
        const c0 = succ[0];
        const newSucc = succ.slice(2);
        const parentSep = part.sep;
        const childArr = toArray(part.child);
        const c0Arr = toArray(c0);
        const newChild: InteriorNode = [...childArr];
        if (parentSep !== undefined) newChild.push(parentSep);
        newChild.push(...c0Arr);
        parts[k].child = newChild;
        parts[k].sep = s0;
        parts[k + 1].child = newSucc;
        continue;
      }
    }
  }

  // reconstruct final node array from parts
  const finalNode: InteriorNode = [];
  for (const { child, sep } of parts) {
    finalNode.push(child);
    if (sep !== undefined) finalNode.push(sep);
  }
  if (finalNode.length % 2 === 0) finalNode.pop();

  return finalNode;
}

function delete_(tree: Tree, value: string): Tree {
  // deletion on leaf root
  if (tree === null) return null;
  if (!Array.isArray(tree)) {
    return tree === value ? null : tree;
  }

  // interior root
  const newTree = deleteFromSubtree(tree, value);
  if (newTree.length === 0) return null;
  if (newTree.length === 1) return newTree[0];
  return newTree;
}

process.nextTick(() => {
  let tree: Tree = null;
  tree = insert(tree, 'hello');
  assert.deepEqual(tree, 'hello');
  tree = insert(tree, 'world');
  assert.deepEqual(tree, ['hello', 'hello', 'world']);
  tree = insert(tree, 'zzz');
  assert.deepEqual(tree, ['hello', 'hello', 'world', 'world', 'zzz']);
  tree = insert(tree, 'lazy');
  assert.deepEqual(tree, [['hello', 'hello', 'lazy'], 'lazy', ['world', 'world', 'zzz']]);
  tree = insert(tree, 'my');
  assert.deepEqual(tree, [['hello', 'hello', 'lazy'], 'lazy', ['my', 'my', 'world', 'world', 'zzz']]);
  tree = insert(tree, 'sweet');
  assert.deepEqual(tree, [
    ['hello', 'hello', 'lazy'],
    'lazy',
    ['my', 'my', 'sweet'],
    'sweet',
    ['world', 'world', 'zzz'],
  ]);
  tree = insert(tree, 'so');
  assert.deepEqual(tree, [
    ['hello', 'hello', 'lazy'],
    'lazy',
    ['my', 'my', 'so', 'so', 'sweet'],
    'sweet',
    ['world', 'world', 'zzz'],
  ]);
  tree = insert(tree, 'oh');
  assert.deepEqual(tree, [
    [['hello', 'hello', 'lazy'], 'lazy', ['my', 'my', 'oh']],
    'oh',
    [['so', 'so', 'sweet'], 'sweet', ['world', 'world', 'zzz']],
  ]);

  tree = delete_(tree, 'oh');
  assert.deepEqual(tree, [
    ['hello', 'hello', 'lazy', 'lazy', 'my'],
    'oh',
    ['so', 'so', 'sweet'],
    'sweet',
    ['world', 'world', 'zzz'],
  ]);
  tree = delete_(tree, 'so');
  assert.deepEqual(tree, [
    ['hello', 'hello', 'lazy'],
    'lazy',
    ['my', 'oh', 'sweet'],
    'sweet',
    ['world', 'world', 'zzz'],
  ]);
  if (Array.isArray(tree)) {
    insertIntoSubtree(tree, 'zzz');
    deleteFromSubtree(tree, 'hello');
  }
});

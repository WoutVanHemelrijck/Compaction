/*
import { BPlusTree } from '../indexes/b-plus-tree.mjs';
import { NO_BLOCK } from '../storage/freeblockfile.mjs';
import assert from 'node:assert/strict';
import { FBLeafNode, FBInternalNode } from '../storage/node-storage/fb-node-storage.mjs';

const ASSERT_MODE = true;


export function lfs(
  payload: {
    leaf: any,
  }
){

  //
  if(!ASSERT_MODE){
    return;
  }

  const leaf = payload["leaf"] 

  // 
  if(leaf.nextLeaf && leaf.nextLeaf.blockId !== leaf.nextBlockId){
    assert(!leaf.nextLeaf || leaf.nextLeaf.blockId === leaf.nextBlockId)

  }
  if(leaf.prevLeaf && leaf.prevLeaf.blockId !== leaf.prevBlockId){
    assert(!leaf.prevLeaf || leaf.prevLeaf.blockId === leaf.prevBlockId)

  if (leaf.prevLeaf && leaf.prevLeaf.blockId !== leaf.prevBlockId) {
    console.log(key, value, `leaf.prevLeaf.blockId=${leaf.prevLeaf.blockId}`, `leaf.prevBlockId=${leaf.prevBlockId}`);
    assert(!leaf.prevLeaf || leaf.prevLeaf.blockId === leaf.prevBlockId);
  }
}


export function int(
  payload: {
    internal: FBInternalNode<any, any>,
  }
){
  
  if(!ASSERT_MODE){
    return;
  }

  // ternary operator for default values
  const internal = payload['internal'];
  // ...

   //It's ok if not all children are loaded in at all times. But the childBlockIds must always be correct!

  // #children = #keys + 1 (property of B+ trees)
  if(internal.childBlockIds.length !== internal.keys.length + 1)
  {
    console.log(internal.childBlockIds, internal.keys)
    assert(internal.childBlockIds.length === internal.keys.length + 1); 
  }
}

// This function is O(n). Disable for efficiency.
export function debug_checkInvariants(
  tree: BPlusTree<any, any, FBLeafNode<any, any>, FBInternalNode<any, any>>,
) {
  if (!ASSERT_MODE) {
    return;
  }
  leafInvariants(tree);
  console.log('LEAF INVARIANTS OK!');
  internInvariants(tree);
  console.log('INTERNAL INVARIANTS OK!');
  console.log('INVARIANTS OK!');
}

function leafInvariants(tree: BPlusTree<any, any, FBLeafNode<any, any>, FBInternalNode<any, any>>) {
  // gather leaf nodes in order

  const root = tree.getRoot();
  // stack
  const leaves: FBLeafNode<string, number>[] = [];
  const stack = [root];
  let current = null;
  while (stack.length > 0) {
    current = stack.pop();
    if (current?.isLeaf) {
      leaves.push(current);
    } else if (current !== undefined) {
      //internal node
      for (const internal of current.children) {
        stack.push(internal);
      }
    }
  }

  const firstLeaf: FBLeafNode<string, number> = leaves[0];

  if (firstLeaf.nextBlockId && firstLeaf.nextBlockId !== NO_BLOCK) {
    assert(firstLeaf.nextLeaf!.blockId === firstLeaf.nextBlockId);
  }

  const lastLeaf: FBLeafNode<string, number> = leaves[leaves.length - 1];
  if (lastLeaf.prevBlockId && lastLeaf.prevBlockId !== NO_BLOCK) {
    assert(lastLeaf.prevLeaf!.blockId === lastLeaf.prevBlockId);
  }

  //
  let leaf: FBLeafNode<string, number>;
  for (let i = 1; i < leaves.length - 1; i++) {
    leaf = leaves[i];

    // ptr-based
    assert(leaf.prevLeaf!.nextLeaf === leaf);
    assert(leaf.nextLeaf!.prevLeaf === leaf);

    // block-based
    assert(leaf.prevBlockId === leaf.prevLeaf!.blockId);
    assert(leaf.nextBlockId === leaf.nextLeaf!.blockId);
  }
}

function internInvariants(tree: BPlusTree<any, any, FBLeafNode<any, any>, FBInternalNode<any, any>>,) {
  const root = tree.getRoot();

  // just check them as you encounter them
  const stack: [FBLeafNode<any, any> | FBInternalNode<any, any> | any] = [root];
  let current: FBLeafNode<any, any> | FBInternalNode<any, any> | any;
  while (stack.length > 0) {
    current = stack.pop();

    // is internal
    if (!current!.isLeaf) {
      // make sure all ptrs match
      assert(current?.children.length === current?.childBlockIds.length);
      for (let j = 0; j < current!.children.length; j++) {
        assert(current?.children[j].blockId === current?.childBlockIds[j]);
      }
      //
      for (const child of current!.children) {
        stack.push(child);
      }
    }
  }
}

interface DebugInvariantStats {
  '#internal': number;
  '#leaf': number;
  '#nodes': number;
  '#items': number;
  depth: number;
}

//
// WARNING: O(n) operation! (n = #items). Implemented using DFS tree traversal.
//
// [A | B | C] is 1 node containing 3 items.
//
// Gives the following statistics of a bplustree:
//   - amount of internal nodes.
//   - amount of leaf nodes.
//   - amount of items. (= #documents)
//   - tree depth set. (should be a set of size 1)
//
//
export function debug_treeStats(
  tree: BPlusTree<any, any, FBLeafNode<any, any>, FBInternalNode<any, any>>,
): DebugInvariantStats {
  const root: FBLeafNode<any, any> | FBInternalNode<any, any> = tree.getRoot();
  //
  let internalCount: number = 0;
  let leafCount: number = 0;
  let itemCount: number = 0;
  const depths: Set<number> = new Set<number>();
  //

  function dfs(node: FBLeafNode<any, any> | FBInternalNode<any, any>, d: number) {
    if (node.isLeaf) {
      depths.add(d);
      leafCount += 1;
      itemCount += node.keys.length;
    } else {
      //internal node
      internalCount += 1;
      for (const child of node.children) {
        dfs(child, d + 1);
      }
      // for(let i = 0; i < node.children.length; i++){
      //     dfs(node.children[i], d+1);
      // }
    }
  }
  dfs(root, 0);
  //
  assert(depths.size === 1);
  //
  console.log(`+++++++++++++++++++++++++++++++++++++++++++++++++++++++++`);
  console.log();

  console.log(`#internal=${internalCount}`);
  console.log(`#leaf=${leafCount}`);
  console.log(`#nodes=${leafCount + internalCount}`);
  console.log(`#items=${itemCount}`);
  console.log(`depth=${Array.from(depths)[0]}`);

  console.log();
  console.log(`+++++++++++++++++++++++++++++++++++++++++++++++++++++++++`);

  return {
    '#internal': internalCount,
    '#leaf': leafCount,
    '#nodes': leafCount + internalCount,
    '#items': itemCount,
    depth: Array.from(depths)[0],
  };
}
*/

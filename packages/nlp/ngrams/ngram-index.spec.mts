// @author Arwin Gorissen
// @date 2026-02-22

import { describe, it, expect } from 'vitest';
import { NgramIndex } from './ngram-index.mjs';
import { BPlusTree } from '../../dbms/indexes/b-plus-tree.mjs';
import {
  TrivialNodeStorage,
  TrivialLeafNode,
  TrivialInternalNode,
} from '../../dbms/storage/node-storage/trivial-node-storage.mjs';

type DocID = number;

describe('ngramtree', () => {
  it('test', async () => {
    const storage: TrivialNodeStorage<string, Map<DocID, number>> = new TrivialNodeStorage<string, Map<DocID, number>>(
      (a, b) => a.localeCompare(b),
      (key) => key.length,
    );

    const bplustree: BPlusTree<
      string,
      Map<DocID, number>,
      TrivialLeafNode<string, Map<DocID, number>>,
      TrivialInternalNode<string, Map<DocID, number>>
    > = new BPlusTree(storage, 3);

    await bplustree.init();

    const ngramindex: NgramIndex<
      TrivialLeafNode<string, Map<DocID, number>>,
      TrivialInternalNode<string, Map<DocID, number>>
    > = new NgramIndex(bplustree);

    await ngramindex.addDocument(1, 'Tests');
    await ngramindex.addDocument(2, 'tesp');

    let result: Map<number, number> = await ngramindex.getNgramCount('tes');
    expect(result).toEqual(
      new Map([
        [1, 1],
        [2, 1],
      ]),
    );
    result = await ngramindex.getNgramCount('est');
    expect(result).toEqual(new Map([[1, 1]]));
    result = await ngramindex.getNgramCount('sts');
    expect(result).toEqual(new Map([]));
  });
});

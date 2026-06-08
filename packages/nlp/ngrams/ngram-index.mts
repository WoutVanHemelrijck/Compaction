// @author Arwin Gorissen
// @date 2026-02-22

import { BPlusTree } from '../../dbms/indexes/b-plus-tree.mjs';
import type { LeafNodeStorage, InternalNodeStorage } from '../../dbms/storage/node-storage/node-storage.mjs';
import { nGramCountingVector } from './tools/ngram.mjs';

type DocID = number;

/**
 * A secondary index using the B+ tree architecture to store the number of occurences of ngrams in each file.
 *
 * @template LeafStorageType - The type of the leaf node storage.
 * @template InternalStorageType - The type of the internal node storage.
 */

export class NgramIndex<
  LeafStorageType extends LeafNodeStorage<string, Map<DocID, number>, LeafStorageType, InternalStorageType>,
  InternalStorageType extends InternalNodeStorage<string, Map<DocID, number>, LeafStorageType, InternalStorageType>,
> {
  public ngramLength: number = 3;

  /**
   * Constructor
   *
   * @param {BPlusTree} tree - The B+ tree for the secondary index.
   */
  constructor(private tree: BPlusTree<string, Map<DocID, number>, LeafStorageType, InternalStorageType>) {}

  /**
   * Add document ngram count to tree.
   *
   * @param {DocID} docID - docID
   * @param {string} content - content ???? NOG IN ORDE BRENGEN
   */
  async addDocument(docID: DocID, content: string) {
    const ngrams: Map<string, number> = nGramCountingVector(content, this.ngramLength, 'nl'); //TIJDELIJK NL HARDCODED

    for (const [ngram, count] of ngrams.entries()) {
      const exists: Map<DocID, number> | null = await this.tree.search(ngram);

      if (exists) {
        exists.set(docID, count);
        await this.tree.insert(ngram, exists);
      } else {
        const res: Map<DocID, number> = new Map();
        res.set(docID, count);
        await this.tree.insert(ngram, res);
      }
    }
  }

  /**
   * Returns a map that maps the docID's to the number of times a certain ngram appears in the related document.
   *
   * @param {string} ngram - Ngram to search of length ngramLength
   * @returns {Map<DocID, number>} - A map that maps docID's to the number of times
   *                                 a certain ngram appears in the related document.
   * @throws {Error} If ngram.length != 3.
   */
  async getNgramCount(ngram: string): Promise<Map<DocID, number>> {
    if (ngram.length !== this.ngramLength)
      throw new Error(`ngram length ${ngram.length} must equal ${this.ngramLength}`);
    return (await this.tree.search(ngram)) ?? new Map<DocID, number>();
  }
}

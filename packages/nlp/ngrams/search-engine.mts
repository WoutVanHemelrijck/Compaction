// @author Arwin Gorissen
// @date 2026-02-22

import type { LeafNodeStorage, InternalNodeStorage } from '../../dbms/storage/node-storage/node-storage.mjs';
import type { NgramIndex } from './ngram-index.mjs';
import { nGramCountingVector } from './tools/ngram.mjs';

type DocID = number;

/**
 * A class to enter natural language queries to search the database.
 *
 * @template LeafStorageType - The type of the leaf node storage.
 * @template InternalStorageType - The type of the internal node storage.
 */

export class SearchEngine<
  LeafStorageType extends LeafNodeStorage<string, Map<DocID, number>, LeafStorageType, InternalStorageType>,
  InternalStorageType extends InternalNodeStorage<string, Map<DocID, number>, LeafStorageType, InternalStorageType>,
> {
  /**
   * Constructor
   *
   * @param {NgramIndex} index - The NgramIndex keeping track of the ngram counts of documents.
   */
  constructor(private index: NgramIndex<LeafStorageType, InternalStorageType>) {}

  /**
   * Search the database using a natural language query.
   *
   * @param {string} query - A natural language query to search the database of length >= 3.
   * @param {string} lang - The language of the query, nl or eng.
   * @returns {number} The best match
   * @throws {Error} If !(lang == nl || lang == eng).
   * @throws {Error} If the query length < 3.
   */
  async search(query: string, lang: string): Promise<number> {
    if (!(lang === 'nl' || lang === 'eng')) {
      throw new Error(`Language needs to be nl or eng, you gave ${lang}.`);
    }

    const ngrams: Map<string, number> = nGramCountingVector(query, this.index.ngramLength, lang);
    const ngramCount: Map<DocID, [number, number]> = new Map<DocID, [number, number]>();

    for (const g of ngrams.keys()) {
      const temp: Map<number, number> = await this.index.getNgramCount(g);
      for (const [docId, count] of temp) {
        const [existingDocs, existingCounts] = ngramCount.get(docId) ?? [0, 0];
        ngramCount.set(docId, [existingDocs + 1, existingCounts + count]);
      }
    }

    let sortedArray: [DocID, [number, number]][] = Array.from(ngramCount.entries()).sort((a, b) => {
      if (b[1][0] !== a[1][0]) return b[1][0] - a[1][0];
      return b[1][1] - a[1][1];
    });

    if (sortedArray.length === 0) {
      return 0;
    }

    const bestMatchesAmount: number = sortedArray[0][1][0];
    let count: number = 0;
    for (const i of sortedArray) {
      if (i[1][0] > bestMatchesAmount * 0.9) {
        count++;
        continue;
      }
      break;
    }
    sortedArray = sortedArray.slice(0, count);
    return sortedArray[0][0];
  }
}

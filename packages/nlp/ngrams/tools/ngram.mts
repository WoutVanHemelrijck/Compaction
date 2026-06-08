// @author dn, Arwin Gorissen
// @date 2025-02-22

import { applyFilters } from './filters-streamify.mjs';

/**
 * Return a list of the n-grams in a given string or array of strings (in order of occurance).
 *
 * @param s is a string or an array of strings
 * @param n size of the n-gram (n>0)
 *
 * @returns a string or an array of strings with the n-gram representation
 */
export function nGramRepresentation(s: string | Array<string>, n: number): Array<string | Array<string>> {
  if (n < 1) throw new RangeError(`n needs to be strictly positive, you gave n=${n}`);
  const result: Array<string | Array<string>> = new Array<string | Array<string>>();

  if (typeof s === 'string') {
    for (let i = 0; i <= s.length - n; ++i) {
      result.push(s.substring(i, i + n));
    }
  } else {
    for (let i = 0; i <= s.length - n; ++i) {
      result.push(s.slice(i, i + n));
    }
  }
  return result;
}

/**
 * Return a map of n-gram strings and their count in a given string or array of strings (in order of occurance).
 *
 * @param s is a string or an array of strings
 * @param n size of the n-gram (n>0)
 *
 * @returns a map of the n-grams in order of occurance to the number of occurances
 */
export function nGramCountingVector(s: string | Array<string>, n: number, lang: string): Map<string, number> {
  const result: Map<string, number> = new Map<string, number>();
  const input: string | string[] = typeof s === 'string' ? applyFilters(s, lang) : s;

  const nGrams = nGramRepresentation(input, n);

  for (const nGram of nGrams) {
    const key = Array.isArray(nGram) ? nGram.join(' ') : nGram;
    result.set(key, (result.get(key) ?? 0) + 1);
  }

  return result;
}

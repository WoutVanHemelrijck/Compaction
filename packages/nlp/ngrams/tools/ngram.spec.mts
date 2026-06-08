// @author dn, Arwin Gorissen
// @date 2025-10-13

import { it, expect, describe } from 'vitest';
import { nGramRepresentation, nGramCountingVector } from '../tools/ngram.mjs';

describe('nGramRepresentation', () => {
  it('should return the correct list of n-grams', () => {
    expect(nGramRepresentation('', 2)).toEqual([]);
    expect(nGramRepresentation('dog', 2)).toEqual(['do', 'og']);
    expect(nGramRepresentation('dog', 3)).toEqual(['dog']);
    expect(nGramRepresentation('dog', 4)).toEqual([]);
    expect(nGramRepresentation('cat', 2)).toEqual(['ca', 'at']);
    expect(nGramRepresentation('cat cat', 2)).toEqual(['ca', 'at', 't ', ' c', 'ca', 'at']);
    expect(() => nGramRepresentation('boem', -3)).toThrow();
  });

  it('correct n-grams array input', () => {
    const testArray: string[] = ['Qualis', 'artifex', 'pereo'];
    expect(nGramRepresentation(['', ''], 1)).toEqual([[''], ['']]);
    expect(nGramRepresentation(testArray, 1)).toEqual([['Qualis'], ['artifex'], ['pereo']]);
    expect(nGramRepresentation(testArray, 2)).toEqual([
      ['Qualis', 'artifex'],
      ['artifex', 'pereo'],
    ]);
    expect(nGramRepresentation(testArray, 3)).toEqual([['Qualis', 'artifex', 'pereo']]);
    expect(nGramRepresentation(testArray, 4)).toEqual([]);
  });
});

describe('nGramCountingVector', () => {
  it('should return the correct count of n-grams', () => {
    expect(nGramCountingVector('dog', 2, 'nl')).toEqual(
      new Map<string, number>([
        ['do', 1],
        ['og', 1],
      ]),
    );
    expect(nGramCountingVector('dog', 3, 'nl')).toEqual(new Map<string, number>([['dog', 1]]));
    expect(nGramCountingVector('dog', 4, 'nl')).toEqual(new Map<string, number>());
    expect(nGramCountingVector('cat', 2, 'nl')).toEqual(
      new Map<string, number>([
        ['ca', 1],
        ['at', 1],
      ]),
    );
    expect(nGramCountingVector('cat cat', 2, 'nl')).toEqual(
      new Map<string, number>([
        ['ca', 2],
        ['at', 2],
        ['t ', 1],
        [' c', 1],
      ]),
    );
    expect(() => nGramCountingVector('boem', 0, 'nl')).toThrow();
  });

  it('correct count array input', () => {
    const testArray: string[] = ['Aeschylus', 'Sophocles', 'Euripides', 'Aeschylus', 'Sophocles'];
    expect(nGramCountingVector(['', ''], 1, 'nl')).toEqual(new Map<string, number>([['', 2]]));
    expect(nGramCountingVector(testArray, 1, 'nl')).toEqual(
      new Map<string, number>([
        ['Aeschylus', 2],
        ['Sophocles', 2],
        ['Euripides', 1],
      ]),
    );
    expect(nGramCountingVector(testArray, 2, 'nl')).toEqual(
      new Map<string, number>([
        ['Aeschylus Sophocles', 2],
        ['Sophocles Euripides', 1],
        ['Euripides Aeschylus', 1],
      ]),
    );
  });
});

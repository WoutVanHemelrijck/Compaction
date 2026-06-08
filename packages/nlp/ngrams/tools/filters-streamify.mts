// @author mh, AG
// @date 2025-02-22
import dutch from '../filterwords/dutch.js';
import english from '../filterwords/english.js';
import natural from 'natural';

/**
 * Check if a value is an async iterable
 * @param {unknown} obj - The object to check
 * @returns {AsyncIterable<T>} true if obj is an AsyncIterable
 */
function isAsyncIterable<T>(obj: unknown): obj is AsyncIterable<T> {
  if (obj === null || typeof obj !== 'object') {
    return false;
  }
  return Symbol.asyncIterator in obj;
}

/**
 * This function applies all the filters from left to right:
 * lowerCase -> removeNumbers -> removePunctuation -> removeCommonWords -> normalizeSpaces
 * Works with strings, sync iterables, and async iterables.
 * The removePunctuation needs to be before removeCommonWords:
 * don't -> not detected by removeCommonWords
 * dont -> detected by removeCommonWords
 * @param {string} text - string, Iterable<string>, or AsyncIterable<string>
 * @returns {string} text with all filters applied
 */
export function applyFilters(text: string, lang: string): string;
export function applyFilters(text: Iterable<string>, lang: string): Generator<string>;
export function applyFilters(text: AsyncIterable<string>, lang: string): AsyncGenerator<string>;
export function applyFilters(
  text: string | Iterable<string> | AsyncIterable<string>,
  lang: string,
): string | Generator<string> | AsyncGenerator<string> {
  if (typeof text === 'string') {
    const step1: string = text.toLowerCase();
    const step2: string = step1.replace(/\d+/g, ' ').replace(/  +/g, ' ').trim();
    const step3: string = step2
      .replace(/[^\w\s]|_/g, '')
      .replace(/  +/g, ' ')
      .trim();
    const words: string[] = step3.split(/\s+/).filter((word) => word.length > 0);
    const filtered: string[] = words.filter((word) => !english.includes(word) && !dutch.includes(word));

    const stemmer = lang === 'nl' ? natural.PorterStemmerNl : natural.PorterStemmer;
    const stemmed: string[] = filtered.map((word) => stemmer.stem(word));
    return stemmed.join(' ').replace(/  +/g, ' ').trim();
  }

  if (isAsyncIterable(text)) {
    return (async function* () {
      for await (const chunk of text) {
        const step1: string = chunk.toLowerCase();
        const step2: string = step1.replace(/\d+/g, ' ').replace(/  +/g, ' ').trim();
        const step3: string = step2
          .replace(/[^\w\s]|_/g, '')
          .replace(/  +/g, ' ')
          .trim();
        const words: string[] = step3.split(/\s+/).filter((word) => word.length > 0);
        const filtered: string[] = words.filter((word) => !english.includes(word) && !dutch.includes(word));
        yield filtered.join(' ').replace(/  +/g, ' ').trim();
      }
    })();
  }

  return (function* () {
    for (const chunk of text) {
      const step1: string = chunk.toLowerCase();
      const step2: string = step1.replace(/\d+/g, ' ').replace(/  +/g, ' ').trim();
      const step3: string = step2
        .replace(/[^\w\s]|_/g, '')
        .replace(/  +/g, ' ')
        .trim();
      const words: string[] = step3.split(/\s+/).filter((word) => word.length > 0);
      const filtered: string[] = words.filter((word) => !english.includes(word) && !dutch.includes(word));
      yield filtered.join(' ').replace(/  +/g, ' ').trim();
    }
  })();
}

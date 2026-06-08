import { describe, expect, it } from 'vitest';
import { getTagName, parseCommand } from './wiki-import.mjs';

describe('wiki-import', () => {
  describe('getTagName', () => {
    it('returns the string directly if input is already a string', () => {
      expect(getTagName('page')).toBe('page');
      expect(getTagName('mediawiki')).toBe('mediawiki');
    });

    it('returns the name property when input is an object with a name key', () => {
      expect(getTagName({ name: 'page' })).toBe('page');
      expect(getTagName({ name: 'mediawiki' })).toBe('mediawiki');
    });

    it('stringifies number, bigint, and boolean names', () => {
      expect(getTagName({ name: 42 })).toBe('42');
      expect(getTagName({ name: 42n })).toBe('42');
      expect(getTagName({ name: false })).toBe('false');
    });

    it('returns empty string for non-object or null input', () => {
      expect(getTagName(undefined)).toBe('');
      expect(getTagName(12)).toBe('');
      expect(getTagName(null)).toBe('');
    });

    it('returns empty string when name is an unsupported type', () => {
      expect(getTagName({})).toBe('');
      expect(getTagName({ name: {} })).toBe('');
      expect(getTagName({ name: ['page'] })).toBe('');
      expect(getTagName({ name: Symbol('page') })).toBe('');
    });
  });

  describe('parseCommand', () => {
    it('parses --daemon-url flag with userId and wikipediaXmlFile', () => {
      const parsed = parseCommand([
        'node',
        'wiki-import.mts',
        '--daemon-url',
        'http://localhost:4000',
        'my-user-id',
        'enwiki.xml',
      ]);

      expect(parsed).toEqual({
        daemonUrl: 'http://localhost:4000',
        userId: 'my-user-id',
        wikipediaFileName: 'enwiki.xml',
      });
    });

    it('throws when --daemon-url has no value', () => {
      expect(() => parseCommand(['node', 'wiki-import.mts', '--daemon-url'])).toThrow('Missing value for --daemon-url');
    });

    it('throws when --daemon-url is missing', () => {
      expect(() => parseCommand(['node', 'wiki-import.mts', 'my-user-id', 'enwiki.xml'])).toThrow(
        '--daemon-url is required',
      );
    });

    it('throws on incorrect number of positional arguments', () => {
      expect(() =>
        parseCommand(['node', 'wiki-import.mts', '--daemon-url', 'http://localhost:4000', 'only-file.xml']),
      ).toThrow('Usage:');

      expect(() =>
        parseCommand(['node', 'wiki-import.mts', '--daemon-url', 'http://localhost:4000', 'user', 'file.xml', 'extra']),
      ).toThrow('Usage:');
    });

    it('accepts daemon URLs with and without trailing slashes', () => {
      const parsed1 = parseCommand([
        'node',
        'wiki-import.mts',
        '--daemon-url',
        'http://localhost:4000',
        'user-id',
        'file.xml',
      ]);
      const parsed2 = parseCommand([
        'node',
        'wiki-import.mts',
        '--daemon-url',
        'http://localhost:4000/',
        'user-id',
        'file.xml',
      ]);

      expect(parsed1.daemonUrl).toBe('http://localhost:4000');
      expect(parsed2.daemonUrl).toBe('http://localhost:4000/');
    });

    it('throws on --help', () => {
      expect(() => parseCommand(['node', 'wiki-import.mts', '--help'])).toThrow('Usage:');
      expect(() => parseCommand(['node', 'wiki-import.mts', '-h'])).toThrow('Usage:');
    });
  });
});

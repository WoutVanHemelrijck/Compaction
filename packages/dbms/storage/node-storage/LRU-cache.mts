//@author Tijn Gommers
//@date 2026-04-21

/**
 * A simple implementation of a Least Recently Used (LRU) cache.
 * This cache evicts the least recently used item when the capacity is exceeded.
 * It provides O(1) time complexity for get and set operations.
 */
export class LRUCache<K, V> {
  private cache: Map<K, V>;
  private capacity: number;

  /**
   * Creates a new LRU cache with a fixed maximum capacity.
   * @param {number} capacity Maximum number of entries to keep in memory.
   * @throws {Error} If capacity is less than or equal to 0.
   */
  constructor(capacity: number) {
    if (capacity <= 0) {
      throw new Error('LRUCache: Capacity must be greater than 0.');
    }

    this.capacity = capacity;
    this.cache = new Map();
  }

  /**
   * Gets a value by key and marks it as most recently used.
   * @param {K} key The cache key.
   * @returns {V | undefined} The cached value, or undefined if not found.
   */
  get(key: K): V | undefined {
    if (!this.has(key)) {
      return undefined;
    }
    const value = this.cache.get(key)!;
    // Move the accessed key to the end to show that it was recently used
    this.delete(key);
    this.set(key, value);
    return value;
  }

  /**
   * Adds or updates a cache entry and evicts the least recently used item when full.
   * @param {K} key The cache key.
   * @param {V} value The value to store.
   * @throws {Error} If the least recently used key cannot be determined during eviction.
   */
  set(key: K, value: V): void {
    if (this.has(key)) {
      // If the key already exists, delete it so that we can add it to the end
      this.delete(key);
    } else if (this.size() >= this.capacity) {
      // Remove the least recently used item (the first item in the Map)
      const lruKey = this.cache.keys().next().value;
      if (typeof lruKey !== 'undefined') {
        this.delete(lruKey);
      } else {
        throw new Error('LRUCache: Unable to determine least recently used key.');
      }
    }
    this.cache.set(key, value);
  }

  /**
   * Removes an entry from the cache.
   * @param {K} key The key to remove.
   */
  delete(key: K): void {
    this.cache.delete(key);
  }

  /**
   * Removes all entries from the cache.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Checks whether a key exists in the cache.
   * @param {K} key The key to check.
   * @returns {boolean} True if the key exists, otherwise false.
   */
  has(key: K): boolean {
    return this.cache.has(key);
  }

  /**
   * Gets the current number of entries in the cache.
   * @returns {number} Current cache size.
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Gets cache usage statistics.
   * @returns {{ size: number; capacity: number }} Cache size and configured capacity.
   */
  stats(): { size: number; capacity: number } {
    return {
      size: this.size(),
      capacity: this.capacity,
    };
  }
}

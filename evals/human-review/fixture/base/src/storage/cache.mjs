/** Small bounded read cache. Values are owned by the cache. */
export class ReadCache {
  constructor(capacity = 128) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('invalid capacity');
    this.capacity = capacity;
    this.entries = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get(id) {
    const value = this.entries.get(id);
    if (value === undefined) {
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    this.entries.delete(id);
    this.entries.set(id, value);
    return structuredClone(value);
  }

  set(id, value) {
    this.entries.delete(id);
    this.entries.set(id, structuredClone(value));
    while (this.entries.size > this.capacity) {
      this.entries.delete(this.entries.keys().next().value);
    }
  }

  delete(id) {
    return this.entries.delete(id);
  }

  clear() {
    this.entries.clear();
  }

  stats() {
    return { size: this.entries.size, hits: this.hits, misses: this.misses };
  }
}

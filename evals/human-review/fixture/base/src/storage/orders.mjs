import { ReadCache } from './cache.mjs';

/** Repository boundary: callers never receive a stored object by reference. */
export class OrderStore {
  constructor({ capacity = 128 } = {}) {
    this.rows = new Map();
    this.tokens = new Map();
    this.cache = new ReadCache(capacity);
  }

  find(id) {
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached;
    const row = this.rows.get(id);
    if (!row) return undefined;
    this.cache.set(id, row);
    return structuredClone(row);
  }

  insert(order, token) {
    if (this.rows.has(order.id)) throw new Error('duplicate order');
    this.rows.set(order.id, structuredClone(order));
    if (token) this.tokens.set(token, order.id);
    return this.find(order.id);
  }

  findByToken(token) {
    const id = this.tokens.get(token);
    return id ? this.find(id) : undefined;
  }

  save(order, expectedVersion) {
    const current = this.rows.get(order.id);
    if (!current) throw new Error('order not found');
    if (current.version !== expectedVersion) throw new Error('version conflict');
    this.rows.set(order.id, structuredClone(order));
    this.cache.delete(order.id);
    return this.find(order.id);
  }

  list({ after = '', limit = 50 } = {}) {
    return [...this.rows.values()]
      .filter(row => row.id > after)
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, limit)
      .map(row => structuredClone(row));
  }

  count() {
    return this.rows.size;
  }
}

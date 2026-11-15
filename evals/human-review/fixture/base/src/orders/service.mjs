import { randomUUID } from 'node:crypto';
import { createOrder, transition } from './model.mjs';

/** Application operations shared by HTTP handlers and background work. */
export class OrderService {
  constructor(store, { clock = Date.now, nextId = randomUUID } = {}) {
    this.store = store;
    this.clock = clock;
    this.nextId = nextId;
  }

  submit(input, token) {
    if (token) {
      const existing = this.store.findByToken(token);
      if (existing) return { order: existing, created: false };
    }
    const order = createOrder(input, this.nextId(), this.clock());
    return { order: this.store.insert(order, token), created: true };
  }

  get(id) {
    return this.store.find(id);
  }

  changeStatus(id, status) {
    const current = this.store.find(id);
    if (!current) throw new Error('order not found');
    const updated = transition(current, status, this.clock());
    return this.store.save(updated, current.version);
  }

  list(options) {
    return this.store.list(options);
  }
}

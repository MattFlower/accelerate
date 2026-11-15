/** Order records use integer cents throughout the service. */
export function createOrder(input, id, now) {
  if (!input.customer || typeof input.customer !== 'string') {
    throw new Error('customer is required');
  }
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new Error('items are required');
  }
  const items = input.items.map(normalizeItem);
  return {
    id,
    customer: input.customer,
    items,
    total: items.reduce((sum, item) => sum + item.price * item.quantity, 0),
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
}

function normalizeItem(item) {
  if (!item.sku || typeof item.sku !== 'string') throw new Error('sku is required');
  if (!Number.isSafeInteger(item.price) || item.price < 0) {
    throw new Error('price must be nonnegative integer cents');
  }
  if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) {
    throw new Error('quantity must be a positive integer');
  }
  if (!Number.isSafeInteger(item.price * item.quantity)) {
    throw new Error('line total exceeds supported range');
  }
  return { sku: item.sku, price: item.price, quantity: item.quantity };
}

export function transition(order, status, now) {
  const allowed = {
    pending: ['paid', 'cancelled'],
    paid: ['shipped'],
    shipped: [],
    cancelled: [],
  };
  if (!allowed[order.status]?.includes(status)) {
    throw new Error(`cannot move ${order.status} to ${status}`);
  }
  return { ...order, status, updatedAt: now, version: order.version + 1 };
}

export function publicOrder(order) {
  return structuredClone(order);
}

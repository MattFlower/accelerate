import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.mjs';

const input = { customer: 'Maple Books', items: [{ sku: 'box', price: 125, quantity: 2 }] };
const setup = () => createApp({ clock: () => 1000, nextId: () => 'order-1' });

test('intake returns the stored order', () => {
  const { handlers } = setup();
  const response = handlers.create({ body: input });
  assert.equal(response.status, 201);
  assert.equal(response.body.total, 250);
  assert.equal(response.body.status, 'pending');
});

test('replayed intake returns the existing order', () => {
  const { handlers, store } = setup();
  const request = { body: input, headers: { 'idempotency-token': 'request-1' } };
  assert.equal(handlers.create(request).status, 201);
  assert.equal(handlers.create(request).status, 200);
  assert.equal(store.count(), 1);
});

test('paid orders can ship', () => {
  const { service } = setup();
  const { order } = service.submit(input);
  assert.equal(service.changeStatus(order.id, 'paid').version, 2);
  assert.equal(service.changeStatus(order.id, 'shipped').status, 'shipped');
  assert.throws(() => service.changeStatus(order.id, 'cancelled'));
});

test('invalid quantities produce a client response', () => {
  const { handlers } = setup();
  const response = handlers.create({ body: { ...input, items: [{ sku: 'box', price: 1, quantity: 0 }] } });
  assert.equal(response.status, 400);
});

test('missing orders return 404', () => {
  assert.equal(setup().handlers.get({ params: { id: 'absent' } }).status, 404);
});

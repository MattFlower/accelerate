import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signCapability, readCapability, permits } from '../src/security/access.mjs';
import { exportOrders, summarizeOrders } from '../src/reporting/export.mjs';
import { loadSettings } from '../src/config/settings.mjs';
import { ReadCache } from '../src/storage/cache.mjs';

test('capabilities expire at their deadline', () => {
  const token = signCapability({ scopes: ['reports'], expiresAt: 100 }, 'secret');
  assert.equal(permits(readCapability(token, 'secret', 99), 'reports'), true);
  assert.equal(readCapability(token, 'secret', 100), undefined);
  assert.equal(readCapability(token, 'other', 0), undefined);
});

test('exports quote customer names', () => {
  const store = { list: ({ after }) => after ? [] : [{ id: 'a', customer: 'A,B', status: 'paid', total: 2 }] };
  assert.deepEqual([...exportOrders(store)], ['id,customer,status,total_cents', 'a,"A,B",paid,2']);
  assert.equal(summarizeOrders(store.list({})).revenue, 2);
});

test('settings reject a retry ceiling below the starting delay', () => {
  assert.throws(() => loadSettings({ RETRY_CAP_MS: '1' }));
  assert.equal(loadSettings({}).port, 8080);
});

test('cache evicts the least recently used entry', () => {
  const cache = new ReadCache(2);
  cache.set('a', { value: 1 });
  cache.set('b', { value: 2 });
  cache.get('a');
  cache.set('c', { value: 3 });
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a').value, 1);
});

// Journal exports can be checked independently by a downstream adapter.
test('journal segments preserve their digest chain', async () => {
  const { Journal, verifySegment } = await import('../src/audit/journal.mjs');
  const journal = new Journal({ clock: () => 1 });
  journal.append('accepted', 'a');
  journal.append('paid', 'a', { cents: 20 });
  const events = journal.read();
  assert.equal(verifySegment(events), true);
  events[1].details.cents = 21;
  assert.equal(verifySegment(events), false);
});

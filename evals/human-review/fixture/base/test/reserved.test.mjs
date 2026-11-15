import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupRevenue, selectOrders, reportWindow, redactCustomers } from '../src/reporting/export.mjs';
import { CapabilityIssuer, authorize } from '../src/security/access.mjs';
import { loadAdapterSettings, mergeEnvironment, settingsForLog, loadSettings } from '../src/config/settings.mjs';
import { Journal, exportSegment, summarizeEvents, verifySegment, readSubjectHistory } from '../src/audit/journal.mjs';

const rows = [
  { id: 'a', customer: 'A', status: 'paid', total: 10, createdAt: 1 },
  { id: 'b', customer: 'B', status: 'pending', total: 20, createdAt: 2 },
  { id: 'c', customer: 'A', status: 'shipped', total: 30, createdAt: 3 },
];
const store = { list: ({ after, limit }) => rows.filter(row => row.id > after).slice(0, limit) };

test('reports page through windows and aggregate paid revenue', () => {
  assert.deepEqual([...selectOrders(store, { pageSize: 1, from: 2, until: 3 })], [rows[1]]);
  assert.deepEqual(groupRevenue(rows), [
    { name: 'A', count: 2, revenue: 40 }, { name: 'B', count: 1, revenue: 0 },
  ]);
  assert.equal(reportWindow(store, { status: 'shipped' }).revenue, 30);
  assert.equal(redactCustomers(rows)[0].customer, '[redacted]');
  assert.equal(rows[0].customer, 'A');
  assert.throws(() => [...selectOrders(store, { pageSize: 0 })]);
});

test('capability rotation and revocation retain scope and audience checks', () => {
  const old = new CapabilityIssuer('old');
  const token = old.issue({ subject: 'worker', scopes: ['report'], audience: 'desk' }, 0);
  const issuer = new CapabilityIssuer('new', ['old']);
  const claims = issuer.read(token, 1);
  assert.equal(authorize(claims, ['report'], { audience: 'desk' }), true);
  assert.equal(authorize(claims, ['write']), false);
  assert.equal(authorize(claims, ['report'], { audience: 'other' }), false);
  issuer.revokeSubject('worker');
  assert.equal(issuer.read(token, 1), undefined);
  issuer.restoreSubject('worker');
  assert.equal(issuer.read(token, 60000), undefined);
});

test('adapter settings reject malformed input and isolate caller arrays', () => {
  const settings = loadAdapterSettings({ ALLOWED_ORIGINS: 'https://a.test,https://a.test' });
  assert.deepEqual(settings.origins, ['https://a.test']);
  assert.equal(settings.allowAnonymousReports, false);
  assert.throws(() => loadAdapterSettings({ ALLOW_ANONYMOUS_REPORTS: 'yes' }));
  assert.throws(() => loadAdapterSettings({ ALLOWED_ORIGINS: 'file:///tmp' }));
  assert.throws(() => loadAdapterSettings({ REPORT_PAGE_SIZE: '101' }));
  assert.deepEqual(mergeEnvironment({ PORT: '80' }, { PORT: undefined }), { PORT: '80' });
  assert.throws(() => mergeEnvironment({}, { PORT: 80 }));
  const core = loadSettings({});
  settingsForLog(core).retry.baseMs = 1;
  assert.equal(core.retry.baseMs, 100);
});

test('retained journal exports carry a verifiable incoming anchor', () => {
  const journal = new Journal({ capacity: 2, clock: () => 10 });
  journal.append('created', 'a');
  journal.append('paid', 'a');
  journal.append('created', 'b');
  assert.throws(() => journal.read({ after: 0 }), /expired/);
  const segment = exportSegment(journal, { after: 1 });
  assert.equal(verifySegment(segment.events, segment.previousDigest), true);
  assert.deepEqual(summarizeEvents(segment.events).counts, { paid: 1, created: 1 });
  assert.equal(readSubjectHistory(journal, 'a', { after: 1 }).length, 1);
  segment.events[0].details.changed = true;
  assert.equal(verifySegment(segment.events, segment.previousDigest), false);
});

test('journal consumer retries the same batch until acknowledged', async () => {
  const { JournalCursor } = await import('../src/audit/journal.mjs');
  const journal = new Journal();
  journal.append('created', 'a');
  const cursor = new JournalCursor(journal);
  const first = cursor.poll(1);
  journal.append('paid', 'a');
  first[0].details.edited = true;
  assert.equal(cursor.poll()[0].details.edited, undefined);
  assert.equal(cursor.poll().length, 1);
  assert.throws(() => cursor.acknowledge(2));
  assert.equal(cursor.acknowledge(1), 1);
  assert.equal(cursor.poll()[0].sequence, 2);
  assert.deepEqual(cursor.snapshot(), { after: 1, pendingThrough: 2, pendingCount: 1 });
  assert.equal(cursor.abandon(), true);
  assert.equal(cursor.abandon(), false);
  assert.equal(cursor.poll()[0].sequence, 2);
  cursor.acknowledge(2);
  assert.deepEqual(cursor.poll(), []);
  assert.throws(() => cursor.acknowledge(2));
});

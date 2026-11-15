/** Streaming-friendly CSV encoding; callers decide where the rows go. */
function cell(value) {
  const text = String(value ?? '');
  if (/^[=+@-]/.test(text)) return `"'${text.replaceAll('"', '""')}"`;
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

export function* exportOrders(store, { limit = 500 } = {}) {
  yield 'id,customer,status,total_cents';
  let after = '';
  let emitted = 0;
  while (emitted < limit) {
    const rows = store.list({ after, limit: Math.min(50, limit - emitted) });
    if (!rows.length) return;
    for (const row of rows) {
      yield [row.id, row.customer, row.status, row.total].map(cell).join(',');
      after = row.id;
      emitted += 1;
    }
  }
}

export function summarizeOrders(rows) {
  const totals = { count: 0, revenue: 0, pending: 0 };
  for (const row of rows) {
    totals.count += 1;
    if (row.status === 'paid' || row.status === 'shipped') totals.revenue += row.total;
    if (row.status === 'pending') totals.pending += 1;
  }
  return totals;
}

/** Group revenue without retaining order records in the report. */
export function groupRevenue(rows, dimension = 'customer') {
  if (!['customer', 'status'].includes(dimension)) throw new Error('invalid dimension');
  const groups = new Map();
  for (const row of rows) {
    const name = row[dimension];
    const group = groups.get(name) ?? { name, count: 0, revenue: 0 };
    group.count += 1;
    if (['paid', 'shipped'].includes(row.status)) group.revenue += row.total;
    groups.set(name, group);
  }
  return [...groups.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export function* selectOrders(store, { status, from = 0, until = Infinity, pageSize = 50 } = {}) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new Error('invalid page size');
  }
  if (from > until) throw new Error('invalid time window');
  let after = '';
  while (true) {
    const rows = store.list({ after, limit: pageSize });
    if (!rows.length) return;
    for (const row of rows) {
      if (row.createdAt >= from && row.createdAt < until &&
          (status === undefined || row.status === status)) yield row;
    }
    const next = rows.at(-1).id;
    if (next <= after) throw new Error('report cursor did not advance');
    after = next;
  }
}

export function reportWindow(store, options = {}) {
  const rows = selectOrders(store, options);
  return summarizeOrders(rows);
}

export function redactCustomers(rows) {
  return rows.map(({ customer, ...row }) => ({ ...structuredClone(row), customer: '[redacted]' }));
}

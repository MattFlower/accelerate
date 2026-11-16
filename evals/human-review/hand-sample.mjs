import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runPages } from './run-data.mjs';
import { assertDev } from './calibrate.mjs';
import { hash, writeJSON, options, isMain } from './runtime.mjs';
import { writeFileSync } from 'node:fs';

export function handSample(pages, { seed = 'matt', count = 20 } = {}) {
  count = Number(count);
  if (!Number.isInteger(count) || count < 1) throw new Error('invalid --count');
  for (const p of pages) assertDev(p.key);
  const strata = [[], [], []];
  for (const { trial, page, coverage, key } of pages) {
    if (!page || !coverage) continue;
    for (const point of key.points) {
      const c = coverage.consensus.points.find(p => p.id === point.id);
      if (!c || c.labels.some(x => x === null)) continue;
      const stratum = c.label === 'covered' ? 0 : c.label === 'disagree' ? 1 : 2;
      strata[stratum].push({ pageId: trial.pageId, point, page, labels: c.labels });
    }
  }
  for (const s of strata) s.sort((a, b) => hash([seed, a.pageId, a.point.id]).localeCompare(hash([seed, b.pageId, b.point.id])));
  const selected = [];
  // Round-robin draws stay balanced when strata have enough candidates, then fill available slots.
  while (selected.length < count && strata.some(s => s.length)) for (const s of strata) {
    if (s.length && selected.length < count) selected.push(s.shift());
  }
  const answers = selected.map((s, i) => ({ sampleId: 'm' + (i + 1), pageId: s.pageId, pointId: s.point.id,
    claude: s.labels[0], codex: s.labels[1] }));
  const rows = selected.map((s, i) => ({ sample_id: 'm' + (i + 1), page_text: s.page.text, statement: s.point.statement,
    covered_if: s.point.covered_if, partial_if: s.point.partial_if, matt_label: '' }));
  return { rows, answers };
}
export function sampleCSV(rows) {
  const fields = ['sample_id', 'page_text', 'statement', 'covered_if', 'partial_if', 'matt_label'];
  const quote = s => '"' + String(s).replace(/"/g, '""') + '"';
  return [fields.join(','), ...rows.map(r => fields.map(k => quote(r[k])).join(','))].join('\n') + '\n';
}
if (isMain(import.meta.url)) {
  try { const o = options(process.argv.slice(2));
    if (!o.out || existsSync(o.out)) throw new Error('--out must name a new directory');
    const r = handSample(runPages(o._[0], { ...o, withKeys: true }), o);
    mkdirSync(o.out, { recursive: true }); writeFileSync(join(o.out, 'matt.csv'), sampleCSV(r.rows));
    writeJSON(join(o.out, 'answers.json'), r.answers); console.log('sample written');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}

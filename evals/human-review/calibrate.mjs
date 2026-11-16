import { existsSync } from 'node:fs';
import { stripPoint, stripPayload, stripSentences, STRIP_RULE, schema as stripSchema } from './strip-point.mjs';
import { judgePage, judgePayload, JUDGE_RULE, schema as judgeSchema } from './judge-coverage.mjs';
import { callBudget, cachePath } from './model-call.mjs';
import { runPages } from './run-data.mjs';
import { writeJSON, readJSON, options, isMain } from './runtime.mjs';

export function calibrationPass(original, stripped) {
  return original.length === 3 && stripped.length === 3 &&
    original.filter(x => x === 'covered').length >= 2 && stripped.filter(x => x === 'absent').length >= 2;
}
export function assertDev(key) { if (key.split !== 'dev') throw new Error('calibration requires dev keys'); }
export function selectPages(pages, n = 1) {
  n = Number(n);
  if (!Number.isInteger(n) || n < 1) throw new Error('invalid --pages-per-case');
  const counts = new Map();
  return [...pages].sort((a, b) => (a.dir ?? '').localeCompare(b.dir ?? '')).filter(p => {
    if (p.trial.status !== 'ok') return false;
    const id = p.key.case_id, count = counts.get(id) ?? 0;
    counts.set(id, count + 1); return count < n;
  });
}
export function plannedCalls(pages, opts) {
  const pending = new Map(); let unknown = 0;
  const cached = (rule, schema, payload, runtime, run, attempts) => {
    const path = cachePath({ rule, schema, payload, target: { runtime,
      model: opts[runtime + 'Model'] ?? (rule === JUDGE_RULE && runtime === 'claude' ? 'sonnet' : undefined),
      effort: opts.effort }, run, cacheDir: opts.cacheDir });
    if (existsSync(path)) return readJSON(path);
    pending.set(path, attempts); return null;
  };
  for (const { page, key, coverage } of pages) {
    if (!page || !coverage) throw new Error('page text and coverage required');
    for (const point of key.points.filter(p => coverage.consensus.points.some(x => x.id === p.id && x.label === 'covered'))) {
      const strips = ['claude', 'codex'].map(runtime => cached(STRIP_RULE, stripSchema, stripPayload(page, point), runtime, 1, 1));
      if (strips.some(r => r && r.status !== 'ok')) continue;
      const omitted = strips.every(Boolean) ? stripSentences(page, [...new Set(strips.flatMap(r => r.value.sentenceIds))]) : null;
      if (omitted && omitted.sentences.length === page.sentences.length) continue;
      for (const runtime of ['claude', 'codex']) for (let run = 1; run <= 3; run++) {
        cached(JUDGE_RULE, judgeSchema, judgePayload(page, key), runtime, run, 2);
        if (omitted) cached(JUDGE_RULE, judgeSchema, judgePayload(omitted, key), runtime, run, 2);
        else unknown += 2; // Reserve both attempts until the stripped payload is known.
      }
    }
  }
  return [...pending.values()].reduce((a, b) => a + b, unknown);
}
export async function calibrate(pages, opts = {}) {
  for (const p of pages) assertDev(p.key); // Preflight all keys before spending.
  if (!opts.cacheDir) throw new Error('--cache-dir required');
  pages = selectPages(pages, opts.pagesPerCase);
  const planned = plannedCalls(pages, opts);
  console.log(`Planned model calls (maximum including retries): ${planned}`);
  const preflightBudget = opts.budget ?? callBudget(opts.maxCalls);
  if (planned > preflightBudget.max - preflightBudget.used) throw new Error('planned model calls exceed --max-calls');
  const result = { split: 'dev', judges: Object.fromEntries(['claude', 'codex'].map(j => [j,
    { tested: 0, passed: 0, failed: [], notStrippable: [], errors: [] }])), points: [] };
  const budget = preflightBudget;
  for (const { trial, key, page, coverage } of pages) {
    if (!page || !coverage) throw new Error('page text and coverage required');
    for (const point of key.points.filter(p => coverage.consensus.points.some(x => x.id === p.id && x.label === 'covered'))) {
      const identity = { pageId: trial.pageId, pointId: point.id };
      const stripped = await stripPoint({ ...opts, page, point, budget });
      const record = { ...identity, stripped, judgments: {} }; result.points.push(record);
      if (stripped.status !== 'ok') {
        for (const j of Object.values(result.judges)) (stripped.status === 'not-strippable' ? j.notStrippable : j.errors).push(identity);
        continue;
      }
      for (const runtime of ['claude', 'codex']) {
        const original = [], omitted = [];
        for (const [variant, input, dest] of [['original', page, original], ['stripped', stripped.page, omitted]]) {
          for (let run = 1; run <= 3; run++) {
            const judged = await judgePage({ ...opts, page: input, key, runtime, run, budget,
              model: opts[runtime + 'Model'], bin: opts[runtime + 'Bin'] });
            dest.push(judged);
          }
          record.judgments[runtime + ':' + variant] = dest;
        }
        const labels = a => a.map(j => j.status === 'ok' ? j.value.points.find(p => p.id === point.id)?.label : 'error');
        const j = result.judges[runtime]; j.tested++;
        if ([...original, ...omitted].some(r => r.status !== 'ok')) j.errors.push(identity);
        if (calibrationPass(labels(original), labels(omitted))) j.passed++; else j.failed.push(identity);
      }
    }
  }
  result.plannedModelCalls = planned;
  result.modelCalls = budget.used;
  return result;
}
if (isMain(import.meta.url)) {
  try { const o = options(process.argv.slice(2), ['confirmSpend', 'passAuth']);
    if (!o.cacheDir) throw new Error('--cache-dir required');
    if (!o.out || !o._[0]) throw new Error('usage: calibrate.mjs RUN-DIR --out FILE');
    const pages = runPages(o._[0], { ...o, withKeys: true });
    const r = await calibrate(pages, { ...o, cacheDir: o.cacheDir });
    writeJSON(o.out, r); console.log(JSON.stringify(r.judges, null, 2));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}

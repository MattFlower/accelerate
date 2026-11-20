import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const file = name => fileURLToPath(new URL('../' + name, import.meta.url));
const run = (script, ...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'qr-report-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function report(t, script, trials) {
  const dir = scratch(t);
  writeFileSync(join(dir, 'trials.jsonl'), trials.map(trial => JSON.stringify(trial)).join('\n') + '\n');
  const result = run(file(script), '--trials', dir);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('schema generator reproduces the checked-in bytes and rejects a tampered copy', t => {
  const generator = 'gen-dropped-schema.mjs', schema = 'findings-dropped.schema.json';
  const checked = run(file(generator), '--check');
  assert.equal(checked.status, 0, checked.stderr);
  const dir = scratch(t);
  for (const name of [generator, 'findings.schema.json']) copyFileSync(file(name), join(dir, name));
  const generated = run(join(dir, generator));
  assert.equal(generated.status, 0, generated.stderr);
  const copy = join(dir, schema);
  assert.deepEqual(readFileSync(copy), readFileSync(file(schema)));
  writeFileSync(copy, readFileSync(copy, 'utf8') + '\n');
  const tampered = run(join(dir, generator), '--check');
  assert.equal(tampered.status, 1);
  assert.match(tampered.stderr, /differs/);
});

test('dropped report counts references, prose-only evidence, and empty evidence', t => {
  const on = { caseId: 'fixture', runtime: 'claude', modelRequested: 'm', droppedField: 'on', status: 'ok' };
  const result = report(t, 'dropped-report.mjs', [
    { ...on, sample: 1, dropped: [
      { evidence: 'See missing/path.js:99 and file.js:3' }, { evidence: '' }, { evidence: 'Prose only' },
      { evidence: ' \t\n' },
    ] },
    { ...on, sample: 2, dropped: [] },
    { ...on, status: 'error' },
    { status: 'ok' },
  ]);
  assert.deepEqual(result, {
    rows: [
      { caseId: 'fixture', runtime: 'claude', modelRequested: 'm', sample: 1, dropped: 4, referenced: 1, proseOnly: 1, empty: 2 },
      { caseId: 'fixture', runtime: 'claude', modelRequested: 'm', sample: 2, dropped: 0, referenced: 0, proseOnly: 0, empty: 0 },
    ],
    trials: 2, meanDroppedPerTrial: 2, shareReferenced: 1 / 4, shareProseOnly: 1 / 4,
    shareEmpty: 1 / 2, shareWithoutCodeProof: 3 / 4, emptyTrials: 1,
  });

  assert.deepEqual(report(t, 'dropped-report.mjs', [{ ...on, sample: 2, dropped: [] }]), {
    rows: [result.rows[1]],
    trials: 1, meanDroppedPerTrial: 0, shareReferenced: null, shareProseOnly: null,
    shareEmpty: null, shareWithoutCodeProof: null, emptyTrials: 1,
  });
});

test('models report groups sorted observed model names by requested model', t => {
  assert.deepEqual(report(t, 'models-report.mjs', [
    { modelRequested: 'A', modelsObserved: { B: {}, A: {} }, extraModels: true },
    { modelRequested: 'A', modelsObserved: { A: {}, B: {} }, extraModels: true },
    { modelRequested: 'B', modelsObserved: { A: {}, B: {} }, extraModels: true },
    { modelRequested: 'A' },
  ]), {
    groups: [
      { modelRequested: 'A', modelsObserved: ['A', 'B'], trials: 2 },
      { modelRequested: 'B', modelsObserved: ['A', 'B'], trials: 1 },
      { modelRequested: 'A', modelsObserved: [], trials: 1 },
    ],
    extraModels: 3,
  });
});

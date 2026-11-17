import test from 'node:test';
import assert from 'node:assert/strict';
import { auc, bestThreshold, main } from '../shortcut-gate.mjs';
import { callBudget, takeCall, planCalls } from '../call-budget.mjs';
test('Mann-Whitney AUC includes ties and missing classes', () => {
  assert.equal(auc([1, 2, 3, 4], [false, false, true, true]), 1);
  assert.equal(auc([1, 2, 2, 3], [true, true, false, false]), .125);
  assert.equal(auc([2, 2], [true, false]), .5);
  assert.equal(auc([1], [true]), null);
});
test('best threshold checks both directions and majority endpoints', () => {
  assert.equal(bestThreshold([1, 2, 3, 4], [false, false, true, true]).accuracy, 1);
  assert.equal(bestThreshold([1, 2, 3, 4], [true, true, false, false]).direction, '<');
  assert.equal(bestThreshold([1, 1, 1], [true, true, false]).accuracy, 2 / 3);
  assert.equal(bestThreshold([], []), null);
});
test('call caps validate, preflight, and count each launch', () => {
  for (const v of [-1, 1.2, 'no', Infinity]) assert.throws(() => callBudget(v), /invalid/);
  const budget = callBudget(1); takeCall(budget); assert.throws(() => takeCall(budget), /exhausted/);
  assert.throws(() => takeCall(callBudget()), /explicit cap/);
  assert.throws(() => planCalls(2, 1), /exceed/);
  assert.throws(() => planCalls(1), /explicit cap/);
  assert.equal(planCalls(0).max, 0);
});

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { git } from '../case-repo.mjs';
test('shortcut report uses prepared diffs and rejects non-exported splits before git', t => {
  const root = mkdtempSync(join(tmpdir(), 'qr-shortcut-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'); mkdirSync(source); git(source, 'init', '-q', '--template=');
  writeFileSync(join(source, 'x.md'), 'old\n'); git(source, 'add', '.'); git(source, 'commit', '-qm', 'base');
  const base = git(source, 'rev-parse', 'HEAD');
  writeFileSync(join(source, 'x.md'), 'new\nmore\n'); writeFileSync(join(source, 'AGENTS.md'), 'rules\n');
  git(source, 'add', '.'); git(source, 'commit', '-qm', 'head'); const head = git(source, 'rev-parse', 'HEAD');
  const cases = join(root, 'cases.json'), out = join(root, 'report.json');
  const entry = { id: 'clean', kind: 'clean', split: 'dev', base, head, defects: [] };
  const run = () => main(['--cases', cases, '--limitless', source, '--out', out]);
  for (const patch of [{ split: 'heldout' }, { split: 'escapes-heldout' }, { kind: 'real' }]) {
    writeFileSync(cases, JSON.stringify({ cases: [{ ...entry, ...patch }] }));
    assert.throws(run, /Only exported/); assert.equal(existsSync(out), false);
  }
  writeFileSync(cases, JSON.stringify({ cases: [entry] }));
  const r = run();
  assert.deepEqual(r.cases[0], { caseId: 'clean', label: 'clean', linesAdded: 3, linesRemoved: 1, filesChanged: 2, extensions: 1, testChanged: false, instructionChanged: true, onlyDocs: true });
  assert.equal(r.majorityAccuracy, 1);
});

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { keyFor, secretsForAuth, targetOf } from '../judge.mjs';
import { main } from '../sample-overlap.mjs';

const targets = ['codex:judge-a', 'claude:judge-b'];

function finding(overrides = {}) {
  return {
    file: 'src/cache.js', line: 10, title: 'Discard stale cache entry',
    failure_scenario: 'Invalidation leaves stale values', detail: 'A stale value persists.',
    suggestion: 'Invalidate the entry.', severity: 'major', security: false,
    category: 'correctness', confidence: 1, introduced_by_diff: true, ...overrides,
  };
}

function fixture(t, defects = []) {
  const dir = mkdtempSync(join(tmpdir(), 'qr-overlap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cache = join(dir, 'cache');
  const cases = join(dir, 'cases.json');
  const out = join(dir, 'report.json');
  const item = { id: 'case', kind: 'real', defects };
  mkdirSync(cache);
  writeFileSync(cases, JSON.stringify({ cases: [item] }));
  return {
    trial(sample, findings, overrides = {}) {
      return {
        caseId: item.id, runtime: 'codex', modelRequested: 'reviewer', effortRequested: 'high',
        promptSha256: 'prompt-a', sample, status: 'ok', findings, ...overrides,
      };
    },
    cache(trial, judgeIndex, ids) {
      const judge = targetOf(targets[judgeIndex]);
      const matches = ids.map((id, i) => ({
        gold: `G${i + 1}`, finding: id, confidence: 1, reason: 'fixture',
      }));
      const key = keyFor(judge, item, trial.findings, secretsForAuth(false));
      writeFileSync(join(cache, key + '.json'), JSON.stringify({ matches, judge, cost: null }));
    },
    report(...trials) {
      writeFileSync(join(dir, 'trials.jsonl'), trials.map(trial => JSON.stringify(trial)).join('\n') + '\n');
      const report = main([
        '--trials', dir, '--cases', cases, '--judge', targets[0], '--judge', targets[1],
        '--cache', cache, '--out', out,
      ]);
      assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), report);
      return report;
    },
  };
}

function defect(i) {
  return { file: 'src/cache.js', lines: [i, i], summary: `Defect ${i}`, required: true };
}

test('identical findings ignore key order but preserve array order', t => {
  const f = fixture(t);
  const a = finding();
  const reordered = Object.fromEntries(Object.entries(a).reverse());
  const report = f.report(f.trial(2, [reordered]), f.trial(1, [a]));
  assert.equal(report.pairs[0].identicalFindings, true);
  assert.equal(report.summary.identicalPairs, 1);
  assert.deepEqual(report.pairs[0].all, { s1: 1, s2: 1, withPartner: 1, matched: 1, overlap: 1 });
  assert.deepEqual(report.summary.blocking, { mean: 1, median: 1, emptyPairs: 0 });
  const b = finding({ line: 50 });
  assert.equal(f.report(f.trial(1, [a, b]), f.trial(2, [b, a])).pairs[0].identicalFindings, false);
});

test('disjoint samples have zero overlap', t => {
  const f = fixture(t);
  const report = f.report(f.trial(1, [finding()]), f.trial(2, [finding({ file: 'other.js' })]));
  assert.deepEqual(report.pairs[0].all, { s1: 1, s2: 1, withPartner: 0, matched: 0, overlap: 0 });
  assert.deepEqual(report.summary.all, { mean: 0, median: 0, emptyPairs: 0 });
});

test('both-empty finding sets count separately and are excluded from overlap statistics', t => {
  const f = fixture(t);
  const first = f.trial(1, []);
  const second = f.trial(2, []);
  const minor = finding({ severity: 'minor' });
  const report = f.report(
    first, second,
    f.trial(1, [minor], { promptSha256: 'prompt-b' }),
    f.trial(2, [minor], { promptSha256: 'prompt-b' }),
  );
  assert.equal(report.pairs[0].identicalFindings, true);
  assert.equal(report.pairs[0].all.overlap, null);
  assert.equal(report.pairs[0].blocking.overlap, null);
  assert.deepEqual(report.summary.all, { mean: 1, median: 1, emptyPairs: 1 });
  assert.deepEqual(report.summary.blocking, { mean: null, median: null, emptyPairs: 2 });
});

test('sameClaim accepts 20 lines and sufficient token overlap, but rejects 21 lines and category changes', t => {
  const f = fixture(t);
  const first = f.trial(1, [finding()]);
  const near = finding({ line: 30, title: 'Discard stale cache entry promptly' });
  assert.equal(f.report(first, f.trial(2, [near])).pairs[0].all.overlap, 1);
  assert.equal(f.report(first, f.trial(2, [{ ...near, line: 31 }])).pairs[0].all.overlap, 0);
  assert.equal(f.report(first, f.trial(2, [{ ...near, category: 'reliability' }])).pairs[0].all.overlap, 0);
});

test('directional partners can share a match, while symmetric overlap uses one-to-one matches', t => {
  const f = fixture(t);
  const report = f.report(
    f.trial(1, [finding(), finding({ line: 11, severity: 'minor' })]),
    f.trial(2, [finding()]),
  );
  assert.deepEqual(report.pairs[0].all, { s1: 2, s2: 1, withPartner: 2, matched: 1, overlap: 0.5 });
  assert.equal(report.pairs[0].blocking.overlap, 1);
});

test('gold buckets share judged recall rules for required, contested, and nonblocking catches', t => {
  const f = fixture(t, [1, 2, 3, 4].map(defect).concat({ ...defect(5), required: false }));
  const findings = [finding(), finding({ line: 20 }), finding({ line: 30, severity: 'minor' }), finding({ line: 40 })];
  const first = f.trial(1, findings);
  const second = f.trial(2, findings.map(entry => ({ ...entry, file: 'other.js' })));
  f.cache(first, 0, ['F1', 'F2', 'F4', 'F3', null]);
  f.cache(first, 1, ['F1', 'F2', null, 'F3', 'F4']);
  f.cache(second, 0, ['F1', null, 'F2', 'F3', 'F4']);
  f.cache(second, 1, ['F1', null, 'F2', 'F3', 'F4']);
  const report = f.report(first, second);
  assert.deepEqual(report.pairs[0].gold, [
    { id: 'G1', bucket: 'both' }, { id: 'G2', bucket: 'onlyS1' },
    { id: 'G3', bucket: 'onlyS2' }, { id: 'G4', bucket: 'neither' },
  ]);
  assert.deepEqual(report.summary.goldTotals, { both: 1, onlyS1: 1, onlyS2: 1, neither: 1 });
  assert.equal(report.summary.singleSampleRecall, 0.5);
  assert.equal(report.summary.unionOfJudgments, 0.75);
});

test('a missing judge cache entry counts the sample as unjudged and excludes the pair from catch metrics', t => {
  const f = fixture(t, [defect(1)]);
  const first = f.trial(1, [finding()]);
  const second = f.trial(2, [finding({ line: 20 })]);
  f.cache(first, 0, ['F1']);
  f.cache(first, 1, ['F1']);
  f.cache(second, 0, ['F1']);
  const report = f.report(first, second);
  assert.equal(report.summary.unjudged, 1);
  assert.equal(report.pairs[0].unjudged, 1);
  assert.equal(report.pairs[0].all.overlap, 1);
  assert.deepEqual(report.pairs[0].gold, []);
  assert.equal(report.summary.unionOfJudgments, null);
});

test('missing and failed samples, distinct prompts, and duplicate samples leave groups incomplete', t => {
  const f = fixture(t);
  const first = f.trial(1, [finding()]);
  assert.equal(f.report(first).summary.incompleteGroups, 1);
  const report = f.report(
    first, f.trial(2, null, { status: 'error' }),
    f.trial(2, [finding()], { promptSha256: 'prompt-b' }),
    f.trial(1, [finding()], { promptSha256: 'prompt-c' }),
    f.trial(1, [finding()], { promptSha256: 'prompt-c' }),
    f.trial(2, [finding()], { promptSha256: 'prompt-c' }),
  );
  assert.equal(report.summary.pairs, 0);
  assert.equal(report.summary.incompleteGroups, 3);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCaseRepo, assertNoFuture, git } from '../case-repo.mjs';
import { selectCases, exportCases } from '../export-cases.mjs';
import { verifyCase } from '../verify-cases.mjs';
import { isolatedEnv, instructionManifest } from '../isolated-env.mjs';

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'qr-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function fixture(t) {
  const root = scratch(t), source = join(root, 'source');
  mkdirSync(source); git(source, 'init', '-q', '--template=');
  mkdirSync(join(source, 'evals'));
  const commit = (text, message) => {
    writeFileSync(join(source, 'file.txt'), text);
    writeFileSync(join(source, 'evals/labels.json'), text);
    git(source, 'add', '.'); git(source, 'commit', '-q', '-m', message);
    return git(source, 'rev-parse', 'HEAD');
  };
  const base = commit('base', 'original base'), head = commit('head', 'original head');
  const secret = 'SECRET_FUTURE_FIX_928734';
  const fix = commit(secret, secret);
  return { root, source, base, head, fix, secret };
}
test('two deterministic snapshots strip labels and exclude all future objects', t => {
  const { root, source, base, head, fix, secret } = fixture(t);
  const dest = join(root, 'case');
  const pins = buildCaseRepo({ sourceRepo: source, base, head, dest });
  assertNoFuture(dest, Object.values(pins));
  assert.equal(git(dest, 'rev-list', '--count', '--all'), '2');
  assert.equal(git(dest, 'rev-parse', 'HEAD'), pins.head);
  assert.equal(git(dest, 'for-each-ref'), '');
  assert.equal(git(dest, 'log', '--format=%s', '--all'), 'Snapshot head\nSnapshot base');
  assert.equal(git(dest, 'rev-parse', `${pins.head}^`), pins.base);
  assert.equal(readFileSync(join(dest, 'file.txt'), 'utf8'), 'head');
  assert.equal(existsSync(join(dest, '.git/objects/info/alternates')), false);
  for (const sha of Object.values(pins)) assert.equal(git(dest, 'ls-tree', '-r', '--name-only', sha), 'file.txt');
  assert.ok(!git(dest, 'log', '--all').includes(secret));
  const objects = git(dest, 'cat-file', '--batch-all-objects', '--batch-check');
  assert.ok(!objects.includes(fix)); assert.ok(!objects.includes(secret));
  for (const line of objects.split('\n')) assert.ok(!git(dest, 'cat-file', '-p', line.split(' ')[0]).includes(secret));
  assert.deepEqual(buildCaseRepo({ sourceRepo: source, base, head, dest: join(root, 'second') }), pins);
  // A detached unreachable future commit must also trigger the reusable guard.
  const extra = git(dest, 'commit-tree', `${pins.head}^{tree}`, '-m', secret);
  assert.throws(() => assertNoFuture(dest, Object.values(pins)), /Check 5/);
  assert.notEqual(extra, pins.head);
});
test('heldout is excluded, forced inclusion refuses, export reads pinned data', t => {
  const { root, source } = fixture(t);
  const cases = [
    { id: 'b', split: 'dev', kind: 'clean', defects: [] },
    { id: 'a', split: 'escapes-dev', kind: 'real', defects: [{ required: true, adjudication: 'verbatim' }] },
    { id: 'heldout-secret', split: 'heldout', kind: 'clean', input: 'PRIVATE' },
    { id: 'escapes-secret', split: 'escapes-heldout', kind: 'real', input: 'PRIVATE' },
    { id: 'wrong-kind', split: 'dev', kind: 'real' },
  ];
  assert.deepEqual(selectCases({ cases }).map(c => c.id), ['a', 'b']);
  for (const split of ['heldout', 'escapes-heldout']) assert.throws(() => selectCases({ cases }, c => c.split === split), /heldout/);
  mkdirSync(join(source, 'evals/review'));
  writeFileSync(join(source, 'evals/review/cases.json'), JSON.stringify({ cases }));
  git(source, 'add', '.'); git(source, 'commit', '-q', '-m', 'dataset');
  const commit = git(source, 'rev-parse', 'HEAD');
  writeFileSync(join(source, 'evals/review/cases.json'), 'not JSON');
  const out = join(root, 'export.json');
  exportCases({ limitless: source, commit: commit.slice(0, 7), out });
  const first = readFileSync(out, 'utf8');
  assert.match(JSON.parse(first).source.commit, /^[a-f0-9]{40}$/);
  assert.equal(JSON.parse(first).source.commit, commit);
  assert.ok(!first.includes('PRIVATE')); assert.ok(!first.includes('heldout-secret'));
  assert.deepEqual(JSON.parse(first).cases[0].defects, cases[1].defects);
  exportCases({ limitless: source, commit: commit.slice(0, 7), out });
  assert.equal(readFileSync(out, 'utf8'), first);
});
test('isolated environment is fresh, explicit auth only, instructions hashed', t => {
  const root = scratch(t), dest = join(root, 'case'); mkdirSync(dest);
  mkdirSync(join(dest, '.codex')); writeFileSync(join(dest, '.codex/config.toml'), 'config');
  writeFileSync(join(dest, 'AGENTS.md'), 'rules');
  for (const [key, value] of Object.entries({ FOO_SECRET: 'hidden', ANTHROPIC_API_KEY: 'test-key' })) {
    const previous = process.env[key];
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    process.env[key] = value;
  }
  const isolated = isolatedEnv({ scratchRoot: root, dest });
  assert.equal(isolated.env.FOO_SECRET, undefined); assert.equal(isolated.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(isolated.env.PATH, process.env.PATH);
  for (const dir of Object.values(isolated.dirs)) assert.deepEqual(readdirSync(dir), []);
  assert.deepEqual(isolated.manifest, instructionManifest(dest));
  assert.equal(isolated.manifest.length, 3);
  assert.ok(isolated.manifest.every(e => /^[a-f0-9]{64}$/.test(e.sha256)));
  const second = isolatedEnv({ scratchRoot: root, passAuth: ['ANTHROPIC_API_KEY'] });
  assert.equal(second.env.ANTHROPIC_API_KEY, 'test-key'); assert.notEqual(second.dirs.HOME, isolated.dirs.HOME);
});
test('limitless first exported case passes check 5', { skip: !process.env.QR_EVAL_LIMITLESS }, t => {
  const root = scratch(t);
  const data = JSON.parse(readFileSync(new URL('../cases.json', import.meta.url)));
  const first = data.cases[0];
  const result = verifyCase({ limitless: process.env.QR_EVAL_LIMITLESS, case: first, scratch: root });
  assert.equal(result.ok, true, result.error);
  assert.ok(Array.isArray(result.manifest));
  assert.deepEqual(readdirSync(root), []);
  console.log(`Integration: ${first.id}, check 5 passed`);
});

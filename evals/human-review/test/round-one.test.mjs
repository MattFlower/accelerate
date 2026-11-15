import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, cpSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { buildCaseRepo, assertNoLeakage, git, root } from '../build-case-repo.mjs';
import { validateSchema, validateCase, validatePatchShape } from '../validate-keys.mjs';

function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hr-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const key = id => JSON.parse(readFileSync(join(root, 'keys', `${id}.json`), 'utf8'));

test('builds reproduce all SHAs with exactly two refs and no working changes', t => {
  const temp = temporary(t);
  for (const id of ['dev-1', 'dev-2', 'dev-3', 'dev-4']) {
    const a = buildCaseRepo({ caseId: id, dest: join(temp, `${id}-a`) });
    const b = buildCaseRepo({ caseId: id, dest: join(temp, `${id}-b`) });
    assert.deepEqual(existsSync(join(a.dest, '.git/hooks')) ? readdirSync(join(a.dest, '.git/hooks')) : [], []);
    assert.equal(a.base, b.base);
    assert.equal(a.head, b.head);
    assert.deepEqual(git(a.dest, 'for-each-ref', '--format=%(refname)').split('\n').sort(),
      [`refs/heads/${key(id).branch}`, 'refs/heads/main'].sort());
    assert.equal(git(a.dest, 'branch', '--show-current'), key(id).branch);
    assert.equal(git(a.dest, 'status', '--porcelain'), '');
    // All case heads preserve the existing fixture suite too.
    execFileSync(process.execPath, ['--test'], { cwd: a.dest, stdio: 'pipe' });
  }
});

test('leakage scan rejects prohibited text case insensitively', t => {
  const temp = temporary(t);
  for (const text of ['KEYS/private', 'EVALS/private', 'Planted', 'DEFECT', 'Key Point']) {
    writeFileSync(join(temp, 'note.txt'), text);
    assert.throws(() => assertNoLeakage(temp), /leakage/);
  }
});

test('builder rejects leakage introduced by a case patch', t => {
  const temp = temporary(t);
  const cases = join(temp, 'cases');
  cpSync(join(root, 'fixture/cases'), cases, { recursive: true });
  const patch = join(cases, 'dev-1/change.patch');
  writeFileSync(patch, readFileSync(patch, 'utf8').replace('Read hits avoid allocating another object.', 'Planted text.'));
  assert.throws(() => buildCaseRepo({ caseId: 'dev-1', dest: join(temp, 'repo'), casesDir: cases }), /leakage/);
});

test('schema rejects too few points', () => {
  const value = key('dev-1');
  value.points = value.points.slice(0, 5);
  assert.throws(() => validateSchema(value, 'dev-1'), /6–10/);
});

test('evidence rejects missing paths, reversed ranges, and out-of-range lines', t => {
  const temp = temporary(t);
  const { dest } = buildCaseRepo({ caseId: 'dev-1', dest: join(temp, 'repo') });
  for (const ref of ['src/missing.mjs:1', 'src/storage/cache.mjs:9999', 'src/storage/cache.mjs:20-2']) {
    const value = key('dev-1');
    value.points[0].evidence[0].ref = ref;
    assert.throws(() => validateCase(value, dest), /evidence/);
  }
});

test('quiet validation exposes only counts, including on failure', t => {
  const temp = temporary(t);
  const keysDir = join(temp, 'keys');
  cpSync(join(root, 'keys'), keysDir, { recursive: true });
  const sentinel = 'SECRET_PROSE_MUST_NOT_APPEAR';
  const value = key('dev-1');
  value.points[0].statement = sentinel;
  writeFileSync(join(keysDir, 'dev-1.json'), JSON.stringify(value));
  const invoke = () => spawnSync(process.execPath, [join(root, 'validate-keys.mjs'), '--quiet', '--keys-dir', keysDir], { encoding: 'utf8' });
  const good = invoke();
  assert.equal(good.status, 0, good.stdout);
  assert.equal(good.stderr, '');
  assert.equal(good.stdout.includes(sentinel), false);
  assert.equal(good.stdout.trim().split('\n').length, 5);
  assert.match(good.stdout, /total=4 ok=4 errors=0/);
  for (const line of good.stdout.trim().split('\n').slice(0, -1)) {
    assert.match(line, /^dev-\d kind=[a-z-]+ points=\d+ traps=\d+ ok$/);
  }
  value.points[0].evidence[0].ref = `${sentinel}:1`;
  writeFileSync(join(keysDir, 'dev-1.json'), JSON.stringify(value));
  const bad = invoke();
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout.includes(sentinel), false);
  assert.equal(bad.stderr, '');
  assert.match(bad.stdout, /dev-1 error: evidence failed/);
});

test('patch limits count complete combined patches and enforce touched files', () => {
  for (const kind of ['planted-defect', 'mostly-clean']) {
    const value = { kind };
    const patch = n => 'line\n'.repeat(n);
    const files = ['a', 'b', 'c'];
    validatePatchShape(value, [patch(40), patch(40)], files);
    validatePatchShape(value, [patch(250)], files);
    assert.throws(() => validatePatchShape(value, [patch(79)], files), /80–250/);
    assert.throws(() => validatePatchShape(value, [patch(125), patch(126)], files), /80–250/);
    assert.throws(() => validatePatchShape(value, [patch(100)], ['a', 'b']), /at least 3/);
  }
  assert.throws(() => validatePatchShape({ kind: 'mechanical-heavy' }, [], Array(7)), /at least 8/);
  validatePatchShape({ kind: 'mechanical-heavy' }, [], Array(8));
});

test('intent evidence requires a body, head comment or docs, and resolves commit indexes', t => {
  const temp = temporary(t);
  const { dest } = buildCaseRepo({ caseId: 'dev-1', dest: join(temp, 'repo') });
  const checkRef = (ref, side = 'head') => {
    const value = key('dev-1');
    value.points[0].evidence = [{ ref, side }];
    return () => validateCase(value, dest);
  };
  checkRef('commit:1')();
  checkRef('README.md:1')();
  checkRef('src/storage/cache.mjs:1')();
  assert.throws(checkRef('commit:2'), /commit missing/);
  assert.throws(checkRef('commit:0'), /invalid commit/);
  assert.throws(checkRef('commit:1', 'base'), /invalid commit/);
  assert.throws(checkRef('src/storage/cache.mjs:2'), /why evidence/);
  assert.throws(checkRef('src/storage/cache.mjs:1', 'base'), /why evidence/);
  git(dest, 'commit', '--amend', '-m', 'Add batch order reads and cache telemetry');
  assert.throws(checkRef('commit:1'), /requires a body/);
});

test('schema rejects commit refs on base and malformed commit indexes', () => {
  for (const evidence of [
    { ref: 'commit:1', side: 'base' },
    { ref: 'commit:0', side: 'head' },
    { ref: 'commit:1-2', side: 'head' },
  ]) {
    const value = key('dev-1');
    value.points[0].evidence = [evidence];
    assert.throws(() => validateSchema(value, 'dev-1'), /evidence/);
  }
});

test('reserved base areas have room and remain outside development diffs', t => {
  const temp = temporary(t);
  const areas = ['reporting', 'security', 'config', 'audit'];
  for (const area of areas) {
    const file = { reporting: 'export', security: 'access', config: 'settings', audit: 'journal' }[area];
    const source = readFileSync(join(root, `fixture/base/src/${area}/${file}.mjs`), 'utf8');
    const logic = source.split('\n').filter(line => line.trim() && !/^\s*(\/\/|\/\*|\*)/.test(line));
    assert.ok(logic.length >= 60, `${area} needs at least 60 non-comment lines`);
  }
  for (const id of ['dev-1', 'dev-2', 'dev-3', 'dev-4']) {
    const { dest } = buildCaseRepo({ caseId: id, dest: join(temp, id) });
    const touched = git(dest, 'diff', '--name-only', 'main..HEAD').split('\n');
    assert.ok(!touched.some(path => areas.some(area => path.startsWith(`src/${area}/`))));
    if (id !== 'dev-4') {
      assert.ok(touched.length >= 3 && touched.length <= 6);
      assert.ok(touched.some(path => path.startsWith('test/')));
      assert.ok(key(id).points.length >= 7);
    }
  }
});

test('builder rejects prohibited commit prose as well as tree contents', t => {
  const temp = temporary(t);
  const cases = join(temp, 'cases');
  cpSync(join(root, 'fixture/cases'), cases, { recursive: true });
  const manifest = join(cases, 'dev-1/commits.json');
  const commits = JSON.parse(readFileSync(manifest, 'utf8'));
  commits[0].message += '\n\nA defect example';
  writeFileSync(manifest, JSON.stringify(commits));
  assert.throws(() => buildCaseRepo({ caseId: 'dev-1', dest: join(temp, 'repo'), casesDir: cases }), /leakage in commit message/);
});


test('leakage scan checks committed messages including the base', t => {
  const temp = temporary(t);
  for (const ref of ['HEAD', 'main']) {
    const { dest } = buildCaseRepo({ caseId: 'dev-1', dest: join(temp, ref) });
    git(dest, 'checkout', ref);
    git(dest, 'commit', '--amend', '-m', 'Contains defect text');
    assert.throws(() => assertNoLeakage(dest), /leakage in commit message/);
  }
});

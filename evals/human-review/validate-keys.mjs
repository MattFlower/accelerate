import { readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildCaseRepo, git, root } from './build-case-repo.mjs';

function check(condition, message) {
  if (!condition) throw new Error(message);
}
const categories = new Set(['invariant', 'why', 'mechanical', 'unchanged-file', 'defect', 'behavior']);
const kinds = new Set(['planted-defect', 'mostly-clean', 'mechanical-heavy']);
function fields(value, required, location) {
  check(value && typeof value === 'object' && !Array.isArray(value), `${location}: expected object`);
  check(Object.keys(value).every(k => required.includes(k)), `${location}: unknown field`);
  check(required.every(k => Object.hasOwn(value, k)), `${location}: missing field`);
}
function prose(value, location) {
  check(typeof value === 'string' && value.trim().length > 0, `${location}: expected nonempty string`);
}
export function validateSchema(key, caseId) {
  fields(key, ['case_id', 'split', 'kind', 'branch', 'summary_for_maintainers', 'points', 'false_claim_traps'], 'key');
  check(key.case_id === caseId && /^[a-z0-9-]+$/.test(caseId), 'case id mismatch');
  check(['dev', 'held-out'].includes(key.split), 'invalid split');
  check(kinds.has(key.kind), 'invalid kind');
  prose(key.branch, 'branch');
  prose(key.summary_for_maintainers, 'summary');
  check(Array.isArray(key.points) && key.points.length >= 6 && key.points.length <= 10, 'expected 6–10 points');
  check(Array.isArray(key.false_claim_traps) && key.false_claim_traps.length >= 2 && key.false_claim_traps.length <= 4, 'expected 2–4 traps');
  const ids = new Set();
  for (const [type, entries] of [['point', key.points], ['trap', key.false_claim_traps]]) {
    for (const [index, entry] of entries.entries()) {
      const location = `${type}[${index}]`;
      fields(entry, type === 'point' ? ['id', 'category', 'statement', 'covered_if', 'partial_if', 'evidence'] : ['id', 'statement', 'why_false', 'evidence'], location);
      for (const name of type === 'point' ? ['id', 'statement', 'covered_if', 'partial_if'] : ['id', 'statement', 'why_false']) prose(entry[name], `${location}.${name}`);
      check(entry.id.startsWith(`${caseId}.`) && !ids.has(entry.id), `${location}: invalid or duplicate id`);
      ids.add(entry.id);
      if (type === 'point') check(categories.has(entry.category), `${location}: invalid category`);
      check(Array.isArray(entry.evidence) && entry.evidence.length > 0, `${location}: evidence required`);
      for (const evidence of entry.evidence) {
        fields(evidence, ['ref', 'side'], `${location}.evidence`);
        check(['base', 'head'].includes(evidence.side), `${location}: invalid evidence side`);
        check(typeof evidence.ref === 'string' && /^(?:commit:[1-9]\d*|[^:\\]+:[1-9]\d*(?:-[1-9]\d*)?)$/.test(evidence.ref), `${location}: invalid evidence ref`);
        if (evidence.ref.startsWith('commit:')) {
          check(/^commit:[1-9]\d*$/.test(evidence.ref) && evidence.side === 'head', `${location}: invalid commit evidence`);
        }
      }
    }
  }
  const has = category => key.points.some(p => p.category === category);
  check(has('invariant') || has('why'), 'invariant or why point required');
  if (key.kind === 'planted-defect') check(has('defect'), 'defect point required');
  if (key.kind === 'mostly-clean') check(!has('defect'), 'mostly-clean cannot contain defect points');
  if (key.kind === 'mechanical-heavy') check(has('mechanical'), 'mechanical point required');
  if (caseId === 'dev-2') check(has('unchanged-file'), 'dev-2 requires unchanged-file point');
}
export function validatePatchShape(key, patches, touched) {
  if (key.kind === 'mechanical-heavy') {
    check(touched.length >= 8, 'mechanical-heavy must touch at least 8 files');
  } else {
    const lines = patches.reduce((count, patch) =>
      count + patch.replace(/\n$/, '').split('\n').length, 0);
    check(lines >= 80 && lines <= 250, 'patch must contain 80–250 lines');
    check(touched.length >= 3, 'feature must touch at least 3 files');
  }
}

export function validateCase(key, repo, casesDir = join(root, 'fixture/cases')) {
  const touched = git(repo, 'diff', '--name-only', '--no-renames', 'main..HEAD').split('\n').filter(Boolean);
  const caseDir = join(casesDir, key.case_id);
  const manifest = JSON.parse(readFileSync(join(caseDir, 'commits.json'), 'utf8'));
  const patches = [...new Set(manifest.map(commit => commit.patch_file))]
    .map(file => readFileSync(join(caseDir, file), 'utf8'));
  validatePatchShape(key, patches, touched);
  const commits = git(repo, 'rev-list', '--reverse', 'main..HEAD').split('\n').filter(Boolean);
  for (const [i, entry] of [...key.points, ...key.false_claim_traps].entries()) {
    let hasIntent = false;
    for (const evidence of entry.evidence) {
      if (evidence.ref.startsWith('commit:')) {
        check(/^commit:[1-9]\d*$/.test(evidence.ref) && evidence.side === 'head', `entry[${i}]: invalid commit evidence`);
        const commit = commits[Number(evidence.ref.slice(7)) - 1];
        check(commit, `entry[${i}]: evidence commit missing`);
        check(git(repo, 'show', '-s', '--format=%b', commit).length > 0, `entry[${i}]: evidence commit requires a body`);
        hasIntent = true;
        continue;
      }
      const match = /^(.*):([0-9]+)(?:-([0-9]+))?$/.exec(evidence.ref);
      check(match, `entry[${i}]: invalid evidence ref`);
      const [, path, first, last = first] = match;
      check(!path.startsWith('/') && !path.split('/').some(p => p === '..' || p === '.' || p === '.git'), `entry[${i}]: invalid evidence path`);
      let text;
      try { text = git(repo, 'show', `${evidence.side === 'base' ? 'main' : 'HEAD'}:${path}`); }
      catch { throw new Error(`entry[${i}]: evidence file missing`); }
      const lines = text.split('\n');
      check(Number(first) <= Number(last) && Number(last) <= lines.length, `entry[${i}]: evidence line out of range`);
      if (evidence.side === 'head') {
        const docs = /(?:^|\/)README(?:\.[^/]*)?$|\.(?:md|mdx|rst|txt)$|(?:^|\/)docs\//i.test(path);
        // Track block comments from the start of the file, including interior lines.
        let inBlock = false;
        for (const [index, line] of lines.entries()) {
          const trimmed = line.trim();
          const comment = inBlock || /^(?:\/\/|\/\*)/.test(trimmed);
          if (trimmed.startsWith('/*') && !trimmed.includes('*/')) inBlock = true;
          if (trimmed.includes('*/')) inBlock = false;
          if (index + 1 >= Number(first) && index + 1 <= Number(last) &&
              trimmed && (docs || comment)) hasIntent = true;
        }
      }
    }
    if (entry.category === 'why') check(hasIntent, `entry[${i}]: why evidence must cite a commit body or head comment/docs`);
  }
  // Verify the dependency really is outside dev-2's patch.
  if (key.case_id === 'dev-2') {
    const refs = key.points.filter(p => p.category === 'unchanged-file').flatMap(p => p.evidence);
    check(refs.some(e => !touched.includes(e.ref.replace(/:\d+(?:-\d+)?$/, ''))), 'unchanged-file evidence must include an unchanged path');
  }
}
export function validateAll({ keysDir = join(root, 'keys'), casesDir = join(root, 'fixture/cases'), quiet = false } = {}) {
  const files = readdirSync(keysDir).filter(f => f.endsWith('.json')).sort();
  let failures = 0;
  for (const file of files) {
    const id = file.slice(0, -5);
    const temp = mkdtempSync(join(tmpdir(), 'hr-check-'));
    let stage = 'schema';
    try {
      const key = JSON.parse(readFileSync(join(keysDir, file), 'utf8'));
      validateSchema(key, id);
      stage = 'build';
      const { dest } = buildCaseRepo({ caseId: id, dest: join(temp, 'repo'), keysDir, casesDir });
      stage = 'evidence';
      validateCase(key, dest, casesDir);
      stage = 'base tests';
      git(dest, 'checkout', 'main');
      const tests = readdirSync(join(dest, 'test')).filter(p => p.endsWith('.test.mjs')).map(p => join('test', p));
      check(tests.length > 0, 'base tests required');
      execFileSync(process.execPath, ['--test', ...tests], { cwd: dest, stdio: 'pipe' });
      console.log(`${id} kind=${key.kind} points=${key.points.length} traps=${key.false_claim_traps.length} ok`);
    } catch (error) {
      failures++;
      // Build/test diagnostics can contain fixture prose: never expose them in sealed mode.
      console.log(`${id} error: ${quiet ? `${stage} failed` : error.message}`);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }
  console.log(`total=${files.length} ok=${files.length - failures} errors=${failures}`);
  return failures;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    const args = process.argv.slice(2);
    while (args.length) {
      const arg = args.shift();
      if (arg === '--quiet') options.quiet = true;
      else if (['--keys-dir', '--cases-dir'].includes(arg)) {
        check(args.length && !args[0].startsWith('--'), 'option requires directory');
        options[arg === '--keys-dir' ? 'keysDir' : 'casesDir'] = resolve(args.shift());
      } else throw new Error('unknown option');
    }
    process.exitCode = validateAll(options) ? 1 : 0;
  } catch { console.log('validation setup error'); process.exitCode = 1; }
}

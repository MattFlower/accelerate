import { cpSync, existsSync, readdirSync, readFileSync, lstatSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const root = dirname(fileURLToPath(import.meta.url));
const env = {
  PATH: process.env.PATH,
  HOME: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Parcel Team', GIT_AUTHOR_EMAIL: 'team@parcel.example',
  GIT_COMMITTER_NAME: 'Parcel Team', GIT_COMMITTER_EMAIL: 'team@parcel.example',
  GIT_AUTHOR_DATE: '2025-01-01T12:00:00Z', GIT_COMMITTER_DATE: '2025-01-01T12:00:00Z',
  LC_ALL: 'C',
};
export function git(dest, ...args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd: dest, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
export function assertNoLeakage(dest) {
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const path = join(dir, entry.name);
      if (lstatSync(path).isSymbolicLink()) throw new Error('fixture symlink rejected');
      if (entry.isDirectory()) walk(path);
      else if (/keys\/|evals\/|planted|defect|key point/i.test(readFileSync(path, 'utf8'))) {
        throw new Error(`leakage in ${path}`);
      }
    }
  }
  walk(dest);
  if (existsSync(join(dest, '.git'))) {
    // main is the root commit, so main^ does not exist: scan it separately.
    const messages = git(dest, 'log', '--format=%B', 'main..HEAD') +
      '\n' + git(dest, 'show', '-s', '--format=%B', 'main');
    if (/keys\/|evals\/|planted|defect|key point/i.test(messages)) {
      throw new Error('leakage in commit message');
    }
  }
}
export function buildCaseRepo({ caseId, dest, keysDir = join(root, 'keys'), casesDir = join(root, 'fixture/cases') }) {
  if (!/^[a-z0-9-]+$/.test(caseId)) throw new Error('invalid case id');
  dest = resolve(dest);
  if (existsSync(dest)) throw new Error('destination must not exist');
  const key = JSON.parse(readFileSync(join(keysDir, `${caseId}.json`), 'utf8'));
  git(root, 'check-ref-format', '--branch', key.branch);
  if (key.branch === 'main') throw new Error('case branch must differ from main');
  cpSync(join(root, 'fixture/base'), dest, { recursive: true });
  assertNoLeakage(dest);
  git(dest, 'init', '--template=', '--initial-branch=main');
  git(dest, 'add', '.');
  git(dest, 'commit', '-m', 'Initialize Parcel Desk service');
  git(dest, 'checkout', '-b', key.branch);
  const caseDir = join(casesDir, caseId);
  const commits = JSON.parse(readFileSync(join(caseDir, 'commits.json'), 'utf8'));
  if (!Array.isArray(commits) || commits.length < 1 || commits.length > 3) throw new Error('expected 1–3 commits');
  for (const commit of commits) {
    if (typeof commit.message !== 'string' || !commit.message.trim()) throw new Error('missing commit message');
    if (/keys\/|evals\/|planted|defect|key point/i.test(commit.message)) throw new Error('leakage in commit message');
    if (!/^[\w.-]+\.patch$/.test(commit.patch_file)) throw new Error('invalid patch file');
    git(dest, 'apply', '--index', join(resolve(caseDir), commit.patch_file));
    assertNoLeakage(dest);
    git(dest, 'commit', '-m', commit.message);
  }
  const refs = git(dest, 'for-each-ref', '--format=%(refname)').split('\n').sort();
  const expected = [`refs/heads/main`, `refs/heads/${key.branch}`].sort();
  if (JSON.stringify(refs) !== JSON.stringify(expected)) throw new Error('unexpected refs');
  if (git(dest, 'branch', '--show-current') !== key.branch) throw new Error('wrong checkout');
  assertNoLeakage(dest);
  return { dest, base: git(dest, 'rev-parse', 'main'), head: git(dest, 'rev-parse', 'HEAD') };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [caseId, dest] = process.argv.slice(2);
    if (!caseId || !dest) throw new Error('usage: node build-case-repo.mjs CASE_ID DEST');
    console.log(JSON.stringify(buildCaseRepo({ caseId, dest })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

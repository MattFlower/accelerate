import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Ignore runner git configuration, hooks, templates, and inherited Git overrides.
const gitEnv = () => ({ PATH: process.env.PATH, HOME: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1',
  GIT_AUTHOR_NAME: 'Quality Review', GIT_AUTHOR_EMAIL: 'quality-review@localhost', GIT_AUTHOR_DATE: '1000000000 +0000',
  GIT_COMMITTER_NAME: 'Quality Review', GIT_COMMITTER_EMAIL: 'quality-review@localhost', GIT_COMMITTER_DATE: '1000000000 +0000' });
export function git(repo, ...args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], { env: gitEnv(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}
export function assertNoFuture(dest, expectedShas) {
  const fail = message => { throw new Error(`Check 5 (no future history): ${message}`); };
  if (expectedShas.length !== 2 || new Set(expectedShas).size !== 2) fail('expected two distinct snapshot SHAs');
  if (existsSync(join(dest, '.git/objects/info/alternates'))) fail('alternates file exists');
  if (/^alternate[s]?:/m.test(git(dest, 'count-objects', '-v'))) fail('borrowed objects detected');
  const reachable = git(dest, 'rev-list', '--all').split('\n').sort();
  if (JSON.stringify(reachable) !== JSON.stringify([...expectedShas].sort())) fail('reachable commits differ from the two snapshots');
  const fsck = git(dest, 'fsck', '--unreachable', '--no-reflogs');
  if (/\bcommit\b/.test(fsck)) fail(`unexpected unreachable commits: ${fsck}`);
  const commits = git(dest, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)').split('\n').filter(s => s.endsWith(' commit')).map(s => s.split(' ')[0]).sort();
  if (JSON.stringify(commits) !== JSON.stringify([...expectedShas].sort())) fail('object database contains extra commits');
}
export function buildCaseRepo({ sourceRepo, base, head, dest, stripPaths = ['evals/'] }) {
  dest = resolve(dest);
  if (existsSync(dest)) throw new Error(`Destination must not exist: ${dest}`);
  for (const pin of [base, head]) {
    if (!/^[a-f0-9]{7,64}$/i.test(pin)) throw new Error(`Invalid commit pin: ${pin}`);
    try { git(sourceRepo, 'cat-file', '-e', `${pin}^{commit}`); }
    catch { throw new Error(`Pinned commit ${pin} missing in ${sourceRepo}; no fetch attempted`); }
  }
  const staging = mkdtempSync(join(tmpdir(), 'qr-staging-'));
  try {
    const format = git(sourceRepo, 'rev-parse', '--show-object-format');
    git(staging, 'init', '-q', '--template=', `--object-format=${format}`);
    writeFileSync(join(staging, '.git/objects/info/alternates'), `${git(sourceRepo, 'rev-parse', '--path-format=absolute', '--git-path', 'objects')}\n`);
    const snapshot = (pin, message, parent) => {
      git(staging, 'read-tree', `${pin}^{tree}`);
      if (stripPaths.length) git(staging, 'rm', '-r', '-f', '-q', '--cached', '--ignore-unmatch', '--', ...stripPaths.map(p => `:(top,literal)${p.replace(/\/$/, '')}`));
      const tree = git(staging, 'write-tree');
      return git(staging, 'commit-tree', '--no-gpg-sign', tree, ...(parent ? ['-p', parent] : []), '-m', message);
    };
    const snapshotBase = snapshot(base, 'Snapshot base');
    const snapshotHead = snapshot(head, 'Snapshot head', snapshotBase);
    mkdirSync(dest, { recursive: true });
    git(dest, 'init', '-q', '--template=', `--object-format=${format}`);
    git(staging, 'push', '--no-follow-tags', '-q', dest, `${snapshotBase}:refs/eval/base`, `${snapshotHead}:refs/eval/head`);
    git(dest, 'checkout', '-q', '--detach', snapshotHead);
    for (const ref of git(dest, 'for-each-ref', '--format=%(refname)').split('\n').filter(Boolean)) git(dest, 'update-ref', '-d', ref);
    git(dest, 'reflog', 'expire', '--expire=now', '--all');
    git(dest, 'gc', '--prune=now', '-q');
    assertNoFuture(dest, [snapshotBase, snapshotHead]);
    return { base: snapshotBase, head: snapshotHead };
  } catch (error) { rmSync(dest, { recursive: true, force: true }); throw error; }
  finally { rmSync(staging, { recursive: true, force: true }); }
}

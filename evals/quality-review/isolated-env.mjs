import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { git } from './case-repo.mjs';

// Symlinks are recorded as links and never followed outside the case checkout.
export function instructionManifest(dest) {
  const entries = [];
  function walk(dir, prefix = '', insideConfig = false) {
    for (const name of readdirSync(dir).sort()) {
      if (name === '.git') continue;
      const path = prefix ? `${prefix}/${name}` : name;
      const full = join(dir, name);
      const stat = lstatSync(full);
      const config = insideConfig || name === '.claude' || name === '.codex' || name === '.agents';
      const instruction = config || name === 'AGENTS.md' || name === 'CLAUDE.md';
      if (instruction) {
        const type = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file';
        const bytes = type === 'symlink' ? Buffer.from(readlinkSync(full)) : type === 'directory' ? Buffer.alloc(0) : readFileSync(full);
        entries.push({ path, type, sha256: createHash('sha256').update(bytes).digest('hex') });
      }
      if (stat.isDirectory()) walk(full, path, config);
    }
  }
  walk(resolve(dest));
  return entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export function isolatedEnv({ scratchRoot, dest, passAuth = false, runtime }) {
  mkdirSync(scratchRoot, { recursive: true });
  const root = mkdtempSync(join(resolve(scratchRoot), 'qr-env-'));
  const dirs = Object.fromEntries(['HOME', 'XDG_CONFIG_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'TMPDIR'].map(key => [key, join(root, key.toLowerCase())]));
  for (const dir of Object.values(dirs)) mkdirSync(dir);
  const env = {};
  for (const key of ['PATH', 'LANG', 'TERM']) if (process.env[key] !== undefined) env[key] = process.env[key];
  const names = authNames(passAuth);
  requireAuth(passAuth, runtime);
  if (names.length && runtime === 'codex') dirs.CODEX_HOME = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
  if (runtime !== 'codex') for (const key of names) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, dirs);
  for (const path of ['.claude/CLAUDE.md', '.codex/AGENTS.md', '.codex/config.toml'])
    if (existsSync(join(dirs.HOME, path))) throw new Error(`Check 6 (isolated agent config): unexpected ${path}`);
  return { env, dirs, manifest: dest ? instructionManifest(dest) : [] };
}

// Prepared repositories contain exactly base <- head. Disable rename detection so
// both sides of instruction renames are reported as additions/deletions.
export function changedInstructionFiles(caseRepo) {
  return git(caseRepo, 'diff', '--name-status', '--no-renames', '-z', 'HEAD^', 'HEAD')
    .split('\0').reduce((entries, value, i, parts) => {
      if (i % 2 === 0 && parts[i + 1]) {
        const path = parts[i + 1];
        if (/(^|\/)(AGENTS\.md|CLAUDE\.md)$/.test(path) || /(^|\/)\.(claude|codex|agents)\//.test(path))
          entries.push({ status: value, path });
      }
      return entries;
    }, []);
}

export function authNames(passAuth = false) {
  const names = passAuth === true ? ['CLAUDE_CODE_OAUTH_TOKEN'] : passAuth || [];
  if (!Array.isArray(names) || names.some(k => k !== 'CLAUDE_CODE_OAUTH_TOKEN')) throw new Error('invalid auth variable');
  return names;
}
export function authSecrets(passAuth = false) {
  authNames(passAuth);
  return [process.env.CLAUDE_CODE_OAUTH_TOKEN].filter(Boolean);
}
export function redact(text, secrets = []) {
  for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
  return text;
}

export function requireAuth(passAuth, runtime) {
  if (authNames(passAuth).length && runtime === 'claude' && !process.env.CLAUDE_CODE_OAUTH_TOKEN)
    throw new Error('CLAUDE_CODE_OAUTH_TOKEN not set (run claude setup-token)');
}

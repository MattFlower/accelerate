import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Symlinks are recorded as links and never followed outside the case checkout.
export function instructionManifest(dest) {
  const entries = [];
  function walk(dir, prefix = '', insideConfig = false) {
    for (const name of readdirSync(dir).sort()) {
      if (name === '.git') continue;
      const path = prefix ? `${prefix}/${name}` : name;
      const full = join(dir, name);
      const stat = lstatSync(full);
      const config = insideConfig || name === '.claude' || name === '.codex';
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

export function isolatedEnv({ scratchRoot, dest, passAuth = [] }) {
  mkdirSync(scratchRoot, { recursive: true });
  const root = mkdtempSync(join(resolve(scratchRoot), 'qr-env-'));
  const dirs = Object.fromEntries(['HOME', 'XDG_CONFIG_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'TMPDIR'].map(key => [key, join(root, key.toLowerCase())]));
  for (const dir of Object.values(dirs)) mkdirSync(dir);
  const env = {};
  for (const key of ['PATH', 'LANG', 'TERM']) if (process.env[key] !== undefined) env[key] = process.env[key];
  for (const key of passAuth) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || Object.hasOwn(dirs, key)) throw new Error(`Invalid auth variable: ${key}`);
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, dirs);
  for (const path of ['.claude/CLAUDE.md', '.codex/AGENTS.md', '.codex/config.toml'])
    if (existsSync(join(dirs.HOME, path))) throw new Error(`Check 6 (isolated agent config): unexpected ${path}`);
  return { env, dirs, manifest: dest ? instructionManifest(dest) : [] };
}

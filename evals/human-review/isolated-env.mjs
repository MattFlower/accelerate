import { mkdirSync, mkdtempSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// Adapted from quality-review's allowlist; credentials require explicit opt-in.
export function isolatedEnv({ scratchRoot, passAuth = false }) {
  mkdirSync(scratchRoot, { recursive: true });
  const root = mkdtempSync(join(resolve(scratchRoot), 'hr-env-'));
  const dirs = Object.fromEntries(['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'TMPDIR']
    .map(k => [k, join(root, k.toLowerCase())]));
  for (const dir of Object.values(dirs)) mkdirSync(dir);
  const env = {};
  for (const k of ['PATH', 'LANG', 'TERM']) if (process.env[k] !== undefined) env[k] = process.env[k];
  if (passAuth === true) dirs.CODEX_HOME = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
  for (const k of (passAuth === true ? ['CLAUDE_CODE_OAUTH_TOKEN'] : passAuth || [])) {
    if (!['CLAUDE_CODE_OAUTH_TOKEN'].includes(k)) throw new Error('invalid auth variable');
    if (process.env[k]) env[k] = process.env[k];
  }
  return { env: { ...env, ...dirs }, dirs };
}
export function redact(value, secrets = []) {
  let text = String(value);
  for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
  return text;
}

export function requireClaudeAuth(passAuth) {
  if (passAuth && !process.env.CLAUDE_CODE_OAUTH_TOKEN) throw new Error('CLAUDE_CODE_OAUTH_TOKEN not set (run claude setup-token)');
}

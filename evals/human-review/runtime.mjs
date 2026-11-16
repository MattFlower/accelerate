import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const hash = v => createHash('sha256').update(typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v)).digest('hex');
export const readJSON = p => JSON.parse(readFileSync(p, 'utf8'));
export const writeJSON = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
export const isMain = url => process.argv[1] && resolve(process.argv[1]) === fileURLToPath(url);
export function options(args, booleans = []) {
  const opts = { _: [] };
  while (args.length) {
    const a = args.shift();
    if (!a.startsWith('--')) { opts._.push(a); continue; }
    const k = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (booleans.includes(k)) opts[k] = true;
    else {
      if (!args.length || args[0].startsWith('--')) throw new Error(a + ' needs a value');
      opts[k] = args.shift();
    }
  }
  return opts;
}
export async function execute(bin, argv, { cwd, env, prompt, timeoutMs = 600_000 }) {
  return new Promise(done => {
    let stdout = '', stderr = '', launchError, timedOut = false;
    const child = spawn(bin, argv, { cwd, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    child.stdout.on('data', b => { stdout += b; });
    child.stderr.on('data', b => { stderr += b; });
    child.stdin.on('error', () => {});
    child.on('error', e => { launchError = e.message; });
    child.on('close', (code, signal) => { clearTimeout(timer); done({ stdout, stderr, code, signal, timedOut, launchError }); });
    child.stdin.end(prompt);
  });
}
export function parseTranscript(stdout, runtime) {
  let final, modelReported = null, cost = null, error = null;
  const toolCalls = {}, seen = new Set();
  let events;
  try { const v = JSON.parse(stdout); events = Array.isArray(v) ? v : [v]; }
  catch { events = stdout.split('\n').filter(s => s.trim()).map(s => { try { return JSON.parse(s); } catch { error = 'invalid transcript'; return {}; } }); }
  for (const e of events) {
    if (typeof e.model === 'string') modelReported = e.model;
    if (typeof e.total_cost_usd === 'number') cost = e.total_cost_usd;
    if (e.is_error || ['error', 'turn.failed'].includes(e.type)) error = 'model request failed';
    for (const b of e.message?.content ?? []) if (b.type === 'tool_use' && !seen.has(b.id)) {
      seen.add(b.id); toolCalls[b.name] = (toolCalls[b.name] ?? 0) + 1;
    }
    if (runtime === 'codex' && e.type === 'item.completed' && e.item?.type === 'agent_message') final = e.item.text;
    if (e.type === 'result') {
      final = e.structured_output ?? e.result;
      if (e.subtype && e.subtype !== 'success') error = 'model request failed';
    }
  }
  return { final, modelReported, cost, toolCalls, error };
}

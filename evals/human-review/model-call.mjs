import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedEnv, redact, requireClaudeAuth } from './isolated-env.mjs';
import { execute, parseTranscript, hash, readJSON, writeJSON } from './runtime.mjs';

export function judgeArgv({ runtime, model, effort, cwd, schema, schemaPath }) {
  if (runtime === 'codex') return ['exec', '--json', '--skip-git-repo-check', '-C', cwd,
    ...(model ? ['-m', model] : []), '-c', 'approval_policy="never"',
    ...(effort && effort !== 'default' ? ['-c', 'model_reasoning_effort=' + JSON.stringify(effort)] : []),
    '--ephemeral', '--ignore-user-config', '--strict-config',
    ...['shell_tool', 'multi_agent', 'apps', 'plugins', 'code_mode', 'view_image'].flatMap(x => ['--disable', x]),
    '-c', 'orchestrator.mcp.enabled=false', '-c', 'web_search="disabled"', '--output-schema', schemaPath, '-'];
  if (runtime === 'claude') return ['-p', '--output-format', 'stream-json', '--verbose',
    ...(model ? ['--model', model] : []), '--setting-sources', '', '--no-session-persistence', '--tools', '',
    ...(effort && effort !== 'default' ? ['--effort', effort] : []), '--json-schema', JSON.stringify(schema)];
  throw new Error('invalid runtime');
}
export function callBudget(n = Infinity) {
  const max = Number(n);
  if (!(max === Infinity || Number.isInteger(max) && max >= 0)) throw new Error('invalid --max-calls');
  return { max, used: 0 };
}
export async function modelCall({ rule, payload, schema, validate, target, run = 1, cacheDir, confirmSpend = false,
  budget = callBudget(), bin, passAuth = false, attempts = 2, timeoutMs }) {
  if (!Number.isInteger(run) || run < 1) throw new Error('invalid run');
  const version = hash([rule, schema]);
  const path = cachePath({ rule, payload, schema, target, run, cacheDir });
  if (existsSync(path)) {
    const cached = readJSON(path);
    if (cached.status === 'ok') validate(cached.value);
    return { ...cached, reused: true, modelCalls: 0 };
  }
  if (!confirmSpend) throw new Error('--confirm-spend required for uncached call');
  if (target.runtime === 'claude') requireClaudeAuth(passAuth);
  const secrets = [process.env.CLAUDE_CODE_OAUTH_TOKEN].filter(Boolean);
  let error, cost = 0, calls = 0;
  const transcripts = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (budget.used >= budget.max) throw new Error('--max-calls exhausted');
    budget.used++; calls++;
    const scratch = mkdtempSync(join(tmpdir(), 'hr-judge-'));
    try {
      const cwd = join(scratch, 'empty'); mkdirSync(cwd);
      const { env } = isolatedEnv({ scratchRoot: scratch, passAuth });
      const schemaPath = join(scratch, 'schema.json'); writeJSON(schemaPath, schema);
      const result = await execute(bin ?? target.runtime, judgeArgv({ ...target, cwd, schema, schemaPath }),
        { cwd, env, prompt: rule + '\n\n' + JSON.stringify(payload), timeoutMs });
      transcripts.push({ stdout: redact(result.stdout, secrets), stderr: redact(result.stderr, secrets), exitCode: result.code });
      const parsed = parseTranscript(result.stdout, target.runtime); cost += parsed.cost ?? 0;
      if (result.code !== 0 || result.timedOut || result.launchError || parsed.error) throw new Error('judge request failed');
      const value = typeof parsed.final === 'string' ? JSON.parse(parsed.final) : parsed.final;
      validate(value);
      const record = { status: 'ok', value: JSON.parse(redact(JSON.stringify(value), secrets)), target, run, promptVersion: version, cost, transcripts };
      mkdirSync(cacheDir, { recursive: true }); writeJSON(path, record);
      return { ...record, reused: false, modelCalls: calls };
    } catch (e) { error = redact(e.message, secrets); }
    finally { rmSync(scratch, { recursive: true, force: true }); }
  }
  const record = { status: 'error', error, target, run, promptVersion: version, cost, transcripts };
  mkdirSync(cacheDir, { recursive: true }); writeJSON(path, record);
  return { ...record, reused: false, modelCalls: calls };
}
export function strictObject(v, required, optional = []) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || required.some(k => !Object.hasOwn(v, k)) ||
      Object.keys(v).some(k => ![...required, ...optional].includes(k))) throw new Error('invalid judgment schema');
}

export function cachePath({ rule, schema, payload, target, run = 1, cacheDir }) {
  if (!cacheDir) throw new Error('--cache-dir required');
  return join(cacheDir, hash([hash([rule, schema]), payload, { runtime: target.runtime, model: target.model ?? null, effort: target.effort ?? 'default' }, run]) + '.json');
}

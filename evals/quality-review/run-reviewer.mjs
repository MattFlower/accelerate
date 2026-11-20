import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoFuture, git } from './case-repo.mjs';
import { callBudget, takeCall } from './call-budget.mjs';
import { isolatedEnv, changedInstructionFiles, authSecrets, redact } from './isolated-env.mjs';

export const schemaPath = fileURLToPath(new URL('./findings.schema.json', import.meta.url));
const schema = JSON.parse(readFileSync(schemaPath));
const droppedSchemaPath = fileURLToPath(new URL('./findings-dropped.schema.json', import.meta.url));
const droppedSchema = JSON.parse(readFileSync(droppedSchemaPath));

export function buildArgv({ runtime, caseRepo, model, effort, promptMetadata }) {
  const dropped = promptMetadata?.droppedField === 'on';
  if (runtime === 'codex') return ['exec', '--json', '--skip-git-repo-check', '-C', resolve(caseRepo), '-m', model,
    '-c', 'approval_policy="never"', '-c', `model_reasoning_effort=${JSON.stringify(effort)}`,
    '--ignore-user-config', '--strict-config', '-s', 'read-only', '-c', 'orchestrator.mcp.enabled=false',
    '--disable', 'apps', '--disable', 'plugins', '--disable', 'multi_agent', '--disable', 'code_mode',
    '-c', 'web_search="disabled"', '--output-schema', dropped ? droppedSchemaPath : schemaPath, '-'];
  if (runtime === 'claude') return ['-p', '--output-format', 'stream-json', '--verbose', '--model', model,
    '--setting-sources', '', '--permission-mode', 'dontAsk', '--tools', 'Read,Grep,Glob,Bash',
    '--allowedTools', 'Read', 'Grep', 'Glob', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git status:*)',
    '--disallowedTools', 'Bash(git diff --output:*)', 'Bash(git diff --output=*)',
    'Bash(git log --output:*)', 'Bash(git log --output=*)', 'Bash(git show --output:*)', 'Bash(git show --output=*)',
    '--effort', effort, '--json-schema', JSON.stringify(dropped ? droppedSchema : schema)];
  throw new Error(`Unknown runtime: ${runtime}`);
}
export function validateFindings(value, droppedField = 'off') {
  function check(v, s, path) {
    if (s.enum && !s.enum.includes(v)) throw new Error(`Invalid enum at ${path}`);
    if (s.type === 'object') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`Expected object at ${path}`);
      for (const key of s.required) if (!Object.hasOwn(v, key)) throw new Error(`Missing ${path}.${key}`);
      for (const key of Object.keys(v)) {
        if (!Object.hasOwn(s.properties, key)) throw new Error(`Unknown ${path}.${key}`);
        check(v[key], s.properties[key], `${path}.${key}`);
      }
    } else if (s.type === 'array') {
      if (!Array.isArray(v)) throw new Error(`Expected array at ${path}`);
      v.forEach((item, i) => check(item, s.items, `${path}[${i}]`));
    } else if (s.type === 'integer' ? !Number.isInteger(v) : s.type && (typeof v !== s.type || (s.type === 'number' && !Number.isFinite(v)))) {
      throw new Error(`Invalid type at ${path}`);
    }
  }
  check(value, droppedField === 'on' ? droppedSchema : schema, 'review');
  // limitless src/pipeline/schemas.ts:133–136 clamps confidence after parsing.
  return value.findings.map(f => ({ ...f, confidence: Math.min(1, Math.max(0, f.confidence)) }));
}
export function parseTranscript(stdout, runtime) {
  const toolCalls = {}, seen = new Set();
  const models = new Map();
  function observe(model, events, costUsd) {
    if (typeof model !== 'string') return;
    const usage = models.get(model) ?? { events: 0, costUsd: null };
    usage.events += events;
    if (Number.isFinite(costUsd)) usage.costUsd = (usage.costUsd ?? 0) + costUsd;
    models.set(model, usage);
  }
  let final, modelReported = null, error = null, cost = null;
  const count = (id, name) => { const key = `${name}:${id}`; if (!seen.has(key)) { seen.add(key); toolCalls[name] = (toolCalls[name] ?? 0) + 1; } };
  for (const line of stdout.split('\n').filter(s => s.trim())) {
    let e; try { e = JSON.parse(line); } catch { error = 'Unparseable transcript JSONL'; continue; }
    if (!e || typeof e !== 'object') { error = 'Invalid transcript event'; continue; }
    if (runtime === 'codex') {
      if (typeof e.model === 'string') modelReported = e.model;
      observe(e.model, 1);
      observe(e.item?.model, 1);
      if (e.type === 'error' || e.type === 'turn.failed') error = e.message ?? e.error?.message ?? 'Reviewer failed';
      if (['item.started', 'item.completed'].includes(e.type) && e.item) {
        const i = e.item;
        const name = { command_execution: 'shell', file_change: 'apply_patch', web_search: 'web_search' }[i.type]
          ?? (i.type === 'mcp_tool_call' ? `${i.server}.${i.tool}` : null);
        if (name) count(i.id, name);
        if (e.type === 'item.completed' && i.type === 'agent_message') final = i.text;
      }
    } else {
      if (e.type === 'system' && e.subtype === 'init' && typeof e.model === 'string') {
        modelReported = e.model;
        observe(e.model, 0);
      }
      if (e.type === 'assistant') {
        observe(e.message?.model, 1);
        const content = e.message?.content;
        for (const b of Array.isArray(content) ? content : []) {
          if (b?.type !== 'tool_use') continue;
          count(b.id, b.name);
          if (b.name === 'Bash' && typeof b.input?.command === 'string') {
            const words = b.input.command.trim().split(/\s+/).slice(0, 2).join(' ');
            if (words) count(b.id, `Bash:${words}`);
          }
        }
      }
      if (e.type === 'result') {
        if (e.modelUsage && typeof e.modelUsage === 'object' && !Array.isArray(e.modelUsage)) {
          for (const [model, usage] of Object.entries(e.modelUsage)) observe(model, 0, usage?.costUSD);
        }
        if (Number.isFinite(e.total_cost_usd)) cost = (cost ?? 0) + e.total_cost_usd;
        if (e.is_error || (e.subtype && e.subtype !== 'success')) error = `Claude result: ${e.subtype ?? 'error'}`;
        final = e.structured_output ?? e.result;
      }
    }
  }
  const modelsObserved = Object.fromEntries(models);
  const extraModels = Object.keys(modelsObserved).some(model => model !== modelReported);
  return { toolCalls, modelReported, modelsObserved, extraModels, final, error, cost };
}
export async function runReviewer(opts) {
  const { caseId, caseRepo, expectedShas: { base, head }, runtime, model, effort, sample, promptFile, outDir,
    scratchRoot, passAuth = false, bin = runtime, timeoutMs = 20 * 60 * 1000 } = opts;
  assertNoFuture(caseRepo, [base, head]);
  if (git(caseRepo, 'rev-parse', 'HEAD') !== head) throw new Error('Case checkout must be at expected head');
  if (!/^[A-Za-z0-9_-]+$/.test(caseId) || !Number.isInteger(sample) || sample < 1) throw new Error('Invalid trial identity');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid timeoutMs');
  const argv = buildArgv(opts), { env, manifest } = isolatedEnv({ scratchRoot, dest: caseRepo, passAuth, runtime });
  const secrets = authSecrets(passAuth);
  const prompt = readFileSync(promptFile);
  const { promptMetadata } = opts;
  const record = { caseId, repo: opts.repo ?? resolve(caseRepo), base, head, runtime, modelRequested: model,
    effortRequested: effort, modelReported: null, sample, promptSha256: createHash('sha256').update(prompt).digest('hex'),
    ...(promptMetadata && {
      promptBuilder: promptMetadata.promptBuilder, verifierClause: promptMetadata.verifierClause,
      promptSourcePin: promptMetadata.promptSourcePin, omitRequest: promptMetadata.omitRequest,
      ...(promptMetadata.droppedField === 'on' && { droppedField: 'on' }),
    }),
    instructionManifest: manifest, instructionFilesChanged: changedInstructionFiles(caseRepo), toolCalls: {},
    cost: null, durationMs: 0, exitCode: null, status: 'error', findings: null, error: null };
  mkdirSync(outDir, { recursive: true });
  const prefix = join(outDir, `${caseId}.${runtime}.s${sample}`), start = performance.now();
  const stdoutChunks = [], stderrChunks = [];
  let timedOut = false, launchError;
  takeCall(opts.budget ?? callBudget());
  await new Promise(done => {
    const child = spawn(bin, argv, { cwd: caseRepo, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    child.stdout.on('data', b => { stdoutChunks.push(b); }); child.stderr.on('data', b => { stderrChunks.push(b); });
    child.stdin.on('error', () => {});
    child.on('error', e => { launchError = e.message; });
    child.on('close', code => { clearTimeout(timer); record.exitCode = code; done(); });
    child.stdin.end(prompt);
  });
  record.durationMs = Math.round(performance.now() - start);
  const stdout = redact(Buffer.concat(stdoutChunks).toString(), secrets);
  writeFileSync(`${prefix}.jsonl`, stdout); writeFileSync(`${prefix}.stderr`, redact(Buffer.concat(stderrChunks).toString(), secrets));
  try {
    const parsed = parseTranscript(stdout.toString('utf8'), runtime);
    record.cost = parsed.cost; record.toolCalls = parsed.toolCalls; record.modelReported = parsed.modelReported;
    record.modelsObserved = parsed.modelsObserved; record.extraModels = parsed.extraModels;
    if (timedOut) throw new Error(`Timeout after ${timeoutMs}ms`);
    if (launchError) throw new Error(launchError);
    if (record.exitCode !== 0) throw new Error(`Reviewer exit code ${record.exitCode}`);
    if (parsed.error) throw new Error(parsed.error);
    if (parsed.final === undefined) throw new Error('Missing final message');
    const review = typeof parsed.final === 'string' ? JSON.parse(parsed.final) : parsed.final;
    record.findings = validateFindings(review, record.droppedField);
    if (record.droppedField === 'on') record.dropped = review.dropped;
    record.status = 'ok';
  } catch (e) { record.error = timedOut ? `Timeout after ${timeoutMs}ms` : e.message; record.status = timedOut ? 'cancelled' : 'error'; }
  Object.assign(record, JSON.parse(redact(JSON.stringify(record), secrets)));
  writeFileSync(`${prefix}.json`, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPrompt, DEFAULT_VERIFIER_CLAUSE, PROMPT_BUILDER, PROMPT_SOURCE_PIN } from './build-prompt.mjs';
import { planCalls } from './call-budget.mjs';
import { buildCaseRepo } from './case-repo.mjs';
import { isolatedEnv, requireAuth } from './isolated-env.mjs';
import { buildArgv, runReviewer } from './run-reviewer.mjs';

export async function main(args) {
  const opts = { case: [] };
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '');
    if (['dry-run', 'confirm-spend', 'pass-auth', 'omit-request'].includes(key)) opts[key] = true;
    else if (['cases', 'limitless', 'runtime', 'model', 'effort', 'prompt', 'prompt-builder', 'verifier-clause', 'dropped-field', 'k', 'out', 'case', 'max-calls'].includes(key) && args[i + 1] && !args[i + 1].startsWith('--')) {
      const value = args[++i]; if (key === 'case') opts.case.push(value); else opts[key] = value;
    } else throw new Error(`Invalid argument: ${args[i]}`);
  }
  // Guard precedes even preparation, and never resolves or invokes a reviewer binary.
  if (!opts['dry-run'] && !opts['confirm-spend']) throw new Error('Refusing reviewer launch: --confirm-spend required (or use --dry-run)');
  for (const key of ['cases', 'limitless', 'runtime', 'model', 'effort', 'k', 'out']) if (!opts[key]) throw new Error(`Required: --${key}`);
  const promptBuilder = opts['prompt-builder'];
  const verifierClause = opts['verifier-clause'] ?? DEFAULT_VERIFIER_CLAUSE;
  const droppedField = opts['dropped-field'] ?? 'off';
  if (!['on', 'off'].includes(droppedField)) throw new Error('Invalid --dropped-field');
  if (droppedField === 'on' && !promptBuilder) throw new Error('--dropped-field on requires --prompt-builder');
  const omitRequest = Boolean(opts['omit-request']);
  if (Boolean(opts.prompt) === Boolean(promptBuilder)) throw new Error('Specify exactly one of --prompt and --prompt-builder');
  if (promptBuilder && promptBuilder !== PROMPT_BUILDER) throw new Error('Invalid --prompt-builder');
  if (!['keep', 'drop'].includes(verifierClause)) throw new Error('Invalid --verifier-clause');
  if (!promptBuilder && (omitRequest || opts['verifier-clause']))
    throw new Error('--omit-request and --verifier-clause require --prompt-builder');
  const k = Number(opts.k);
  if (!Number.isSafeInteger(k) || k < 1) throw new Error('--k must be a positive integer');
  if (!['codex', 'claude'].includes(opts.runtime)) throw new Error('Invalid --runtime');
  if (opts.prompt) readFileSync(opts.prompt); // Fail before preparing cases if the prompt is absent.
  const data = JSON.parse(readFileSync(opts.cases));
  for (const id of opts.case) if (!data.cases.some(c => c.id === id)) throw new Error(`Unknown case: ${id}`);
  const cases = data.cases.filter(c => !opts.case.length || opts.case.includes(c.id));
  if (cases.some(c => !['dev', 'escapes-dev'].includes(c.split))) throw new Error('Only dev/escapes-dev cases may run');
  if (cases.some(c => !/^[A-Za-z0-9_-]+$/.test(c.id))) throw new Error('Invalid trial identity');
  requireAuth(opts['pass-auth'], opts.runtime);
  const budget = planCalls(cases.length * k, opts['max-calls'], opts['dry-run']);
  const outDir = resolve(opts.out);
  const promptMetadata = promptBuilder ? {
    promptBuilder, verifierClause, promptSourcePin: PROMPT_SOURCE_PIN, omitRequest,
    ...(droppedField === 'on' && { droppedField }),
  } : undefined;
  mkdirSync(outDir, { recursive: true });
  for (const entry of cases) {
    const root = mkdtempSync(join(tmpdir(), 'qr-trials-'));
    try {
      const caseRepo = join(root, 'case');
      const expectedShas = buildCaseRepo({ sourceRepo: resolve(opts.limitless), base: entry.base, head: entry.head, dest: caseRepo, runtime: opts.runtime, passAuth: opts['pass-auth'] });
      const promptFile = promptBuilder ? join(outDir, `${entry.id}.prompt.txt`) : resolve(opts.prompt);
      if (promptBuilder) writeFileSync(promptFile, buildPrompt(entry, { caseRepo, ...expectedShas, verifierClause, omitRequest, droppedField }));
      for (let sample = 1; sample <= k; sample++) {
        const trial = { caseId: entry.id, repo: entry.repo, caseRepo, expectedShas, runtime: opts.runtime,
          model: opts.model, effort: opts.effort, promptFile, sample, outDir, scratchRoot: root, budget, passAuth: opts['pass-auth'], promptMetadata };
        if (opts['dry-run']) {
          const { env } = isolatedEnv({ scratchRoot: root, dest: caseRepo, runtime: opts.runtime, passAuth: opts['pass-auth'] });
          console.log(JSON.stringify({ caseId: entry.id, sample, ...promptMetadata, argv: [opts.runtime, ...buildArgv(trial)], prompt: '<elided stdin>', envKeys: Object.keys(env).sort() }));
        } else {
          const record = await runReviewer(trial);
          appendFileSync(join(outDir, 'trials.jsonl'), `${JSON.stringify(record)}\n`);
        }
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1; });

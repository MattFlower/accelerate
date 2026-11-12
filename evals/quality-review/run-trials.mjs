import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildCaseRepo } from './case-repo.mjs';
import { isolatedEnv } from './isolated-env.mjs';
import { buildArgv, runReviewer } from './run-reviewer.mjs';

export async function main(args) {
  const opts = { case: [] };
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '');
    if (['dry-run', 'confirm-spend'].includes(key)) opts[key] = true;
    else if (['cases', 'limitless', 'runtime', 'model', 'effort', 'prompt', 'k', 'out', 'case'].includes(key) && args[i + 1] && !args[i + 1].startsWith('--')) {
      const value = args[++i]; if (key === 'case') opts.case.push(value); else opts[key] = value;
    } else throw new Error(`Invalid argument: ${args[i]}`);
  }
  // Guard precedes even preparation, and never resolves or invokes a reviewer binary.
  if (!opts['dry-run'] && !opts['confirm-spend']) throw new Error('Refusing reviewer launch: --confirm-spend required (or use --dry-run)');
  for (const key of ['cases', 'limitless', 'runtime', 'model', 'effort', 'prompt', 'k', 'out']) if (!opts[key]) throw new Error(`Required: --${key}`);
  const k = Number(opts.k);
  if (!Number.isSafeInteger(k) || k < 1) throw new Error('--k must be a positive integer');
  if (!['codex', 'claude'].includes(opts.runtime)) throw new Error('Invalid --runtime');
  readFileSync(opts.prompt); // Fail before preparing cases if the prompt is absent.
  const data = JSON.parse(readFileSync(opts.cases));
  for (const id of opts.case) if (!data.cases.some(c => c.id === id)) throw new Error(`Unknown case: ${id}`);
  const cases = data.cases.filter(c => !opts.case.length || opts.case.includes(c.id));
  if (cases.some(c => !['dev', 'escapes-dev'].includes(c.split))) throw new Error('Only dev/escapes-dev cases may run');
  mkdirSync(resolve(opts.out), { recursive: true });
  for (const entry of cases) {
    const root = mkdtempSync(join(tmpdir(), 'qr-trials-'));
    try {
      const caseRepo = join(root, 'case');
      const expectedShas = buildCaseRepo({ sourceRepo: resolve(opts.limitless), base: entry.base, head: entry.head, dest: caseRepo });
      for (let sample = 1; sample <= k; sample++) {
        const trial = { caseId: entry.id, repo: entry.repo, caseRepo, expectedShas, runtime: opts.runtime,
          model: opts.model, effort: opts.effort, promptFile: resolve(opts.prompt), sample, outDir: resolve(opts.out), scratchRoot: root };
        if (opts['dry-run']) {
          const { env } = isolatedEnv({ scratchRoot: root, dest: caseRepo });
          console.log(JSON.stringify({ caseId: entry.id, sample, argv: [opts.runtime, ...buildArgv(trial)], prompt: '<elided stdin>', envKeys: Object.keys(env).sort() }));
        } else {
          const record = await runReviewer(trial);
          appendFileSync(join(resolve(opts.out), 'trials.jsonl'), `${JSON.stringify(record)}\n`);
        }
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1; });

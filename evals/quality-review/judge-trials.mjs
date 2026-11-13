import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isolatedEnv } from './isolated-env.mjs';
import { targetOf, judgingTrials, cachedJudgment, keyFor, judgeArgv, runJudge, metricsReport, secretsForAuth } from './judge.mjs';

export function readInputs(opts) {
  return { trials: readFileSync(join(opts.trials, 'trials.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse),
    cases: JSON.parse(readFileSync(opts.cases ?? new URL('./cases.json', import.meta.url))).cases };
}
export async function main(args) {
  const opts = { judge: [], passAuth: [] };
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '');
    if (['dry-run', 'confirm-spend'].includes(key)) opts[key] = true;
    else if (['trials', 'cases', 'judge', 'cache', 'out', 'pass-auth'].includes(key) && args[i + 1] && !args[i + 1].startsWith('--')) {
      const value = args[++i]; if (key === 'judge') opts.judge.push(targetOf(value)); else if (key === 'pass-auth') opts.passAuth.push(value); else opts[key] = value;
    } else throw new Error(`Invalid argument: ${args[i]}`);
  }
  if (opts.judge.length !== 2) throw new Error('exactly two --judge flags are required');
  for (const key of ['trials', 'cache', 'out']) if (!opts[key]) throw new Error(`Required: --${key}`);
  const secrets = secretsForAuth(opts.passAuth);
  const { trials, cases } = readInputs(opts), pending = new Map();
  for (const { item, output } of judgingTrials(trials, cases)) for (const judge of opts.judge) {
    if (!cachedJudgment(opts.cache, judge, item, output, secrets)) pending.set(keyFor(judge, item, output, secrets), { judge, item, findings: output });
  }
  if (pending.size && !opts['dry-run'] && !opts['confirm-spend']) throw new Error('Refusing judge launch: --confirm-spend required (or use --dry-run)');
  if (opts['dry-run']) {
    const root = mkdtempSync(join(tmpdir(), 'qr-judge-plan-'));
    try {
      const cwd = join(root, 'empty'); mkdirSync(cwd);
      const { env } = isolatedEnv({ scratchRoot: root, passAuth: opts.passAuth });
      console.log(JSON.stringify({ judgeCalls: pending.size, maxAttempts: pending.size * 2, plans: [...pending.values()].map(({ judge, item }) => ({ caseId: item.id, argv: [judge.runtime, ...judgeArgv({ ...judge, cwd })], envKeys: Object.keys(env).sort() })) }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  const errors = [];
  if (!opts['dry-run']) for (const job of pending.values()) {
    try { await runJudge({ ...job, passAuth: opts.passAuth, cacheDir: opts.cache, confirmSpend: opts['confirm-spend'] }); }
    catch (e) { errors.push({ caseId: job.item.id, judge: job.judge, error: e.message }); }
  }
  const report = { ...metricsReport(trials, cases, opts.judge, opts.cache, secrets), dryRun: Boolean(opts['dry-run']), pendingJudgeCalls: pending.size, errors };
  writeFileSync(opts.out, JSON.stringify(report, null, 2) + '\n');
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1; });

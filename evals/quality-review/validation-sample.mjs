import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readInputs } from './judge-trials.mjs';
import { judgingTrials, cachedJudgment, targetOf, secretsForAuth } from './judge.mjs';

// Secondary hand-validation sampling only; never affects judge.ts scoring.
export function validationSample(trials, cases, judges, cacheDir, n = 50, seed = 1, secrets = []) {
  if (!Number.isSafeInteger(n) || n < 1 || !Number.isSafeInteger(seed)) throw new Error('Invalid sample size or seed');
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
  const pools = { matched: [], contested: [], bothNull: [] };
  for (const { trial, item, output } of judgingTrials(trials, cases)) {
    const judgments = judges.map(j => cachedJudgment(cacheDir, j, item, output, secrets)?.matches);
    if (judgments.some(j => !j)) continue;
    for (const [i, gold] of item.defects.entries()) {
      const decisions = judgments.map(j => j.find(m => m.gold === `G${i + 1}`).finding);
      const stratum = decisions.every(Boolean) ? 'matched' : decisions.some(Boolean) ? 'contested' : 'bothNull';
      const ids = [...new Set(decisions.filter(Boolean))];
      // Both-null: prefer same file, then nearest line, stable original finding order.
      const closest = [...output.findings].sort((a, b) => Number(b.file === gold.file) - Number(a.file === gold.file) || Math.abs(a.line - gold.lines[0]) - Math.abs(b.line - gold.lines[0]))[0];
      for (const f of ids.length ? ids.map(id => output.findings[Number(id.slice(1)) - 1]) : [closest]) {
        pools[stratum].push({ caseId: item.id, sample: trial.sample, stratum, goldSummary: gold.summary, goldFile: gold.file, goldLines: gold.lines,
          findingTitle: f?.title ?? '', findingDetail: f?.detail ?? '', findingFile: f?.file ?? '', findingLine: f?.line ?? '', judgeA: decisions[0], judgeB: decisions[1], human: '' });
      }
    }
  }
  const quotas = { matched: Math.floor(n / 2), contested: Math.floor(n / 4), bothNull: n - Math.floor(n / 2) - Math.floor(n / 4) };
  const rows = [];
  for (const [stratum, pool] of Object.entries(pools)) {
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    rows.push(...pool.slice(0, quotas[stratum]));
  }
  return { seed, requested: n, quotas, available: Object.fromEntries(Object.entries(pools).map(([k, v]) => [k, v.length])), rows };
}
export function main(args) {
  const opts = { judge: [], passAuth: [] };
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '');
    if (!['trials', 'cases', 'judge', 'cache', 'out', 'n', 'seed', 'pass-auth'].includes(key) || !args[i + 1]) throw new Error(`Invalid argument: ${args[i]}`);
    const value = args[++i]; if (key === 'judge') opts.judge.push(targetOf(value)); else if (key === 'pass-auth') opts.passAuth.push(value); else opts[key] = value;
  }
  if (opts.judge.length !== 2 || !opts.trials || !opts.cache || !opts.out) throw new Error('Required: --trials --judge (twice) --cache --out');
  const { trials, cases } = readInputs(opts), report = validationSample(trials, cases, opts.judge, opts.cache, Number(opts.n ?? 50), Number(opts.seed ?? 1), secretsForAuth(opts.passAuth));
  writeFileSync(opts.out + '.json', JSON.stringify(report, null, 2) + '\n');
  const columns = ['caseId', 'sample', 'stratum', 'goldSummary', 'goldFile', 'goldLines', 'findingTitle', 'findingDetail', 'findingFile', 'findingLine', 'judgeA', 'judgeB', 'human'];
  const cell = v => '"' + String(Array.isArray(v) ? JSON.stringify(v) : v ?? '').replaceAll('"', '""') + '"';
  writeFileSync(opts.out + '.csv', [columns.map(cell).join(','), ...report.rows.map(r => columns.map(k => cell(r[k])).join(','))].join('\n') + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; }

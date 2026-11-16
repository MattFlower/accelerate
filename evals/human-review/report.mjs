import { runPages } from './run-data.mjs';
import { quietLine } from './judge-coverage.mjs';
import { options, isMain, writeJSON } from './runtime.mjs';

export function report(pages) {
  const splits = {};
  for (const split of ['dev', 'held-out']) {
    const subset = pages.filter(p => p.trial.split === split);
    const perPage = subset.map(({ trial, coverage }) => ({
      caseId: trial.caseId, pageId: trial.pageId, generator: trial.modelRequested ?? 'default', generatorReported: trial.modelReported,
      skillTreeSha: trial.skillTreeSha, promptSha256: trial.promptSha256, status: trial.status,
      covered: coverage?.consensus.covered ?? null, points: coverage ? coverage.consensus.eligiblePoints ?? coverage.consensus.points.length - (coverage.consensus.pointErrors ?? 0) : null,
      totalPoints: coverage?.consensus.points.length ?? null,
      disagree: coverage ? coverage.consensus.disagree ?? 0 : null, partial: coverage?.consensus.partial ?? null, absent: coverage?.consensus.absent ?? null,
      falseClaims: coverage?.consensus.falseClaims ?? null, judgeErrors: coverage?.consensus.errors ?? 0,
      pointErrors: coverage?.consensus.pointErrors ?? null, unjudged: !coverage,
      cost: (trial.total_cost_usd ?? 0) + (coverage?.cost ?? 0), costUnknown: typeof trial.total_cost_usd !== 'number',
    }));
    const cases = [...new Set(perPage.map(p => p.caseId))].map(caseId => {
      const group = perPage.filter(p => p.caseId === caseId), scored = group.filter(p => !p.unjudged);
      const sum = k => scored.reduce((n, p) => n + p[k], 0);
      return { caseId, pages: group.length, scoredPages: scored.length, covered: sum('covered'), points: sum('points'),
        disagree: sum('disagree'), partial: sum('partial'), absent: sum('absent'), falseClaims: sum('falseClaims'), judgeErrors: sum('judgeErrors'),
        pointErrors: sum('pointErrors'), cost: group.reduce((n, p) => n + p.cost, 0) };
    });
    const groups = new Map();
    for (const p of perPage.filter(p => !p.unjudged && !p.pointErrors && p.status === 'ok')) {
      // The invocation prefix is fixed; branch names differ by case, so group by model + skill tree.
      const id = JSON.stringify([p.caseId, p.generator, p.generatorReported, p.skillTreeSha]);
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(p);
    }
    const spread = [...groups.values()].filter(g => g.length === 2).map(g => ({
      caseId: g[0].caseId, generator: g[0].generator, pageIds: g.map(p => p.pageId),
      absoluteDifference: Math.abs(g[0].covered / g[0].points - g[1].covered / g[1].points),
    }));
    splits[split] = { pages: perPage, cases, aaSpread: spread,
      aaMean: spread.length ? spread.reduce((n, p) => n + p.absoluteDifference, 0) / spread.length : null };
  }
  if (pages.some(p => !['dev', 'held-out'].includes(p.trial.split))) throw new Error('invalid split');
  return splits;
}
if (isMain(import.meta.url)) {
  let o;
  try { o = options(process.argv.slice(2), ['quiet']); const r = report(runPages(o._[0]));
    if (o.out) writeJSON(o.out, r);
    if (o.quiet) for (const split of ['dev', 'held-out']) for (const c of r[split].cases) {
      console.log(quietLine({ caseId: c.caseId, pages: c.pages, consensus: {
        covered: c.covered, points: Array(c.points), partial: c.partial, absent: c.absent, disagree: c.disagree, falseClaims: c.falseClaims, errors: c.judgeErrors,
      } }));
    } else console.log(JSON.stringify(r, null, 2));
  } catch (e) { console.error(o?.quiet ? 'report error' : e.message); process.exitCode = 1; }
}

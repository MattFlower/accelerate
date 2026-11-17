import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, extname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildCaseRepo, git } from './case-repo.mjs';

// Scores increase toward defect; ties contribute half a pair.
export function auc(values, labels) {
  let wins = 0, pairs = 0;
  values.forEach((x, i) => { if (labels[i]) values.forEach((y, j) => {
    if (!labels[j]) { pairs++; wins += x > y ? 1 : x === y ? .5 : 0; }
  }); });
  return pairs ? wins / pairs : null;
}
export function bestThreshold(values, labels) {
  if (!values.length) return null;
  let best = { accuracy: -1 };
  for (const threshold of [...new Set(values)].sort((a, b) => a - b).concat(Infinity)) {
    for (const direction of ['>=', '<']) {
      const correct = values.filter((x, i) => (direction === '>=' ? x >= threshold : x < threshold) === Boolean(labels[i])).length;
      if (correct / values.length > best.accuracy) best = { accuracy: correct / values.length, threshold: Number.isFinite(threshold) ? threshold : null, boundary: threshold === Infinity ? 'above-all' : 'value', direction };
    }
  }
  return best;
}
export function diffFeatures(repo, base, head) {
  const rows = git(repo, 'diff', '--no-renames', '--numstat', '-z', base, head).split('\0').filter(Boolean).map(row => {
    const [added, removed, ...path] = row.split('\t');
    return { added: added === '-' ? 0 : Number(added), removed: removed === '-' ? 0 : Number(removed), path: path.join('\t') };
  });
  return {
    linesAdded: rows.reduce((n, r) => n + r.added, 0), linesRemoved: rows.reduce((n, r) => n + r.removed, 0),
    filesChanged: rows.length, extensions: new Set(rows.map(r => extname(r.path))).size,
    testChanged: rows.some(r => /test|spec/i.test(r.path)),
    instructionChanged: rows.some(r => ['AGENTS.md', 'CLAUDE.md', 'SKILL.md', 'REVIEW.md', 'GEMINI.md', '.cursorrules'].includes(basename(r.path))),
    onlyDocs: rows.length > 0 && rows.every(r => /(^|\/)(docs?|documentation)\//i.test(r.path) || /\.(md|markdown|mdx|rst|txt)$/i.test(r.path)),
  };
}
export function main(args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '');
    if (!['cases', 'limitless', 'out'].includes(key) || !args[i + 1]) throw new Error(`Invalid argument: ${args[i]}`);
    opts[key] = args[++i];
  }
  if (!opts.limitless || !opts.out) throw new Error('Required: --limitless --out');
  const cases = JSON.parse(readFileSync(opts.cases ?? new URL('./cases.json', import.meta.url))).cases;
  if (cases.some(c => !(c.split === 'escapes-dev' && c.kind === 'real' || c.split === 'dev' && c.kind === 'clean' && !c.defects.length)))
    throw new Error('Only exported escapes-dev and dev clean cases may be read');
  const rows = cases.map(c => {
    const root = mkdtempSync(join(tmpdir(), 'qr-shortcut-'));
    try {
      const repo = join(root, 'case'), pins = buildCaseRepo({ sourceRepo: resolve(opts.limitless), base: c.base, head: c.head, dest: repo });
      return { caseId: c.id, label: c.defects.length ? 'defect' : 'clean', ...diffFeatures(repo, pins.base, pins.head) };
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  const labels = rows.map(r => r.label === 'defect'), defects = labels.filter(Boolean).length;
  const report = { cases: rows, majorityAccuracy: rows.length ? Math.max(defects, rows.length - defects) / rows.length : null, numeric: {}, boolean: {} };
  for (const key of ['linesAdded', 'linesRemoved', 'filesChanged', 'extensions']) {
    const values = rows.map(r => r[key]); report.numeric[key] = { auc: auc(values, labels), bestThreshold: bestThreshold(values, labels) };
  }
  for (const key of ['testChanged', 'instructionChanged', 'onlyDocs']) {
    const counts = { defect: { true: 0, false: 0 }, clean: { true: 0, false: 0 } };
    rows.forEach(r => counts[r.label][r[key]]++); report.boolean[key] = counts;
  }
  writeFileSync(opts.out, JSON.stringify(report, null, 2) + '\n');
  console.log(`Majority-class accuracy: ${report.majorityAccuracy ?? 'n/a'}`);
  console.log('Feature\tAUC\tBest threshold accuracy');
  for (const [key, value] of Object.entries(report.numeric)) console.log(`${key}\t${value.auc ?? 'n/a'}\t${value.bestThreshold?.accuracy ?? 'n/a'}`);
  console.log('Feature\tdefect true/false\tclean true/false');
  for (const [key, value] of Object.entries(report.boolean)) console.log(`${key}\t${value.defect.true}/${value.defect.false}\t${value.clean.true}/${value.clean.false}`);
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; }

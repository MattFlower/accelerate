import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function selectCases(data, select = c =>
  (c.split === 'escapes-dev' && c.kind === 'real') || (c.split === 'dev' && c.kind === 'clean')) {
  const selected = data.cases.filter(select);
  if (selected.some(c => ['heldout', 'escapes-heldout'].includes(c.split)))
    throw new Error('Refusing to export heldout cases');
  return selected.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(c =>
    Object.fromEntries(['id', 'kind', 'split', 'repo', 'base', 'head', 'snapshot', 'input', 'defects']
      .filter(key => Object.hasOwn(c, key)).map(key => [key, c[key]])));
}

export function exportCases({ limitless, commit, out }) {
  if (!/^[a-f0-9]{7,40}$/i.test(commit)) throw new Error('Expected a commit SHA');
  commit = execFileSync('git', ['-C', limitless, 'rev-parse', '--verify', `${commit}^{commit}`], { encoding: 'utf8' }).trim();
  const data = JSON.parse(execFileSync('git', ['-C', limitless, 'show', `${commit}:evals/review/cases.json`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  const cases = selectCases(data);
  const real = cases.filter(c => c.kind === 'real');
  const counts = { escapes_dev: real.length, defects: real.reduce((n, c) => n + c.defects.length, 0), required_defects: real.reduce((n, c) => n + c.defects.filter(d => d.required).length, 0), dev_clean: cases.filter(c => c.kind === 'clean').length };
  const result = { source: { repo: 'MattFlower/limitless', path: 'evals/review/cases.json', commit }, generated_by: 'evals/quality-review/export-cases.mjs', counts, cases };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(counts));
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--limitless', '--commit', '--out'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: --limitless <path> --commit <sha> --out <path>');
      options[args[i].slice(2)] = args[i + 1];
    }
    if (!options.limitless || !options.commit || !options.out) throw new Error('Required: --limitless, --commit, --out');
    exportCases(options);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

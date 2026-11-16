import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { root } from './build-case-repo.mjs';
import { hash, readJSON } from './runtime.mjs';
import { pageText } from './page-text.mjs';

export function runPages(runDir, { keysDir = join(root, 'keys'), withKeys = false } = {}) {
  const pages = [];
  function walk(dir) {
    if (existsSync(join(dir, 'trial.json'))) {
      const trial = readJSON(join(dir, 'trial.json'));
      const coverage = existsSync(join(dir, 'coverage.json')) ? readJSON(join(dir, 'coverage.json')) : null;
      if (coverage && (coverage.caseId !== trial.caseId || coverage.split !== trial.split)) throw new Error('trial/coverage identity mismatch');
      const page = existsSync(join(dir, 'page-text.json')) ? readJSON(join(dir, 'page-text.json'))
        : existsSync(join(dir, 'recap.json')) ? pageText(readJSON(join(dir, 'recap.json'))) : null;
      if (coverage?.pageSha256 && page && coverage.pageSha256 !== hash(page)) throw new Error('coverage/page mismatch');
      const key = withKeys ? readJSON(join(keysDir, trial.caseId + '.json')) : undefined;
      if (key && (key.case_id !== trial.caseId || key.split !== trial.split)) throw new Error('trial/key identity mismatch');
      pages.push({ dir, trial, coverage, page, key }); return;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && !['repo', '.cache'].includes(entry.name)) walk(join(dir, entry.name));
    }
  }
  walk(resolve(runDir)); return pages;
}

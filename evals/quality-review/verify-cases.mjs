import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildCaseRepo, assertNoFuture } from './case-repo.mjs';
import { instructionManifest, changedInstructionFiles } from './isolated-env.mjs';

export function verifyCase({ limitless, case: entry, scratch = tmpdir() }) {
  const result = { id: entry.id, ok: false, error: null, base: entry.base, head: entry.head,
    snapshotBase: null, snapshotHead: null, manifest: null, instructionFilesChanged: null };
  let root;
  try {
    root = mkdtempSync(join(resolve(scratch), 'qr-verify-'));
    const dest = join(root, 'case');
    const pins = buildCaseRepo({ sourceRepo: limitless, base: entry.base, head: entry.head, dest });
    result.snapshotBase = pins.base;
    result.snapshotHead = pins.head;
    assertNoFuture(dest, [pins.base, pins.head]);
    result.manifest = instructionManifest(dest);
    result.instructionFilesChanged = changedInstructionFiles(dest);
    result.ok = true;
  } catch (error) {
    result.error = error.message;
  } finally {
    if (root) {
      try { rmSync(root, { recursive: true, force: true }); }
      catch (error) { result.ok = false; result.error = error.message; }
    }
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = { cases: 'evals/quality-review/cases.json' };
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i += 2) {
      if (!['--limitless', '--cases', '--scratch', '--out'].includes(args[i]) || !args[i + 1])
        throw new Error('Usage: --limitless <path> [--cases <file>] [--scratch <dir>] [--out <file>]');
      options[args[i].slice(2)] = args[i + 1];
    }
    if (!options.limitless) throw new Error('Required: --limitless');
    const { cases } = JSON.parse(readFileSync(options.cases, 'utf8'));
    const results = [];
    for (const entry of cases) {
      const result = verifyCase({ limitless: options.limitless, case: entry, scratch: options.scratch });
      results.push(result);
      console.log(result.ok
        ? `${result.id} ok ${result.snapshotHead} instr=${result.manifest.length}`
        : `${result.id} FAIL ${result.error.replace(/[\r\n]+/g, ' ')}`);
    }
    const ok = results.filter(result => result.ok).length;
    console.log(`verified ${ok}/${results.length}`);
    if (options.out) writeFileSync(options.out, `${JSON.stringify({ summary: { total: results.length, ok, instructionFilesChanged: results.filter(r => r.instructionFilesChanged?.length).length }, cases: results }, null, 2)}\n`);
    if (ok !== results.length) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

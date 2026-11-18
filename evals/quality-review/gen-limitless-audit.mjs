import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildCaseRepo, git } from './case-repo.mjs';

const pin = 'e42003a';
const sourceRepo = process.env.QR_EVAL_LIMITLESS;
const args = process.argv.slice(2);
if (!sourceRepo || args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
  console.error('Usage: QR_EVAL_LIMITLESS=/path/to/limitless bun gen-limitless-audit.mjs [--check]');
  process.exit(1);
}

const env = {
  PATH: process.env.PATH, HOME: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1',
};
const auditFile = new URL('./limitless-audit.json', import.meta.url);
const { cases } = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'));
const scratch = mkdtempSync(join(tmpdir(), 'qr-limitless-audit-'));

function exportSource(path) {
  const dest = join(scratch, 'pinned', path);
  const bytes = execFileSync('git', ['-C', sourceRepo, 'show', `${pin}:${path}`], { env });
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, bytes);
  return bytes.toString('utf8').split('\n');
}

function slice(lines, first, last) {
  return lines.slice(first - 1, last).join('\n');
}

// Load the pinned functions verbatim without importing the factory runtime.
// The adapter runs local Git on the disposable case repos and preserves raw stdout.
function sh(cmd, { cwd, env: overrides, encoding = 'utf8', signal, timeoutMs, stdin } = {}) {
  if (cmd[0] !== 'git') throw new Error('The audit adapter only runs Git');
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.attributesFile=/dev/null', ...cmd.slice(1)],
      { cwd, env: { ...env, ...overrides }, signal });
    const stdout = [];
    const stderr = [];
    const timer = timeoutMs && setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: Buffer.concat(stdout).toString(encoding) });
      else reject(new Error(`${cmd.join(' ')} failed (${signal ?? code}): ${Buffer.concat(stderr).toString().trim()}`));
    });
    child.stdin.end(stdin);
  });
}

async function loadPinnedAudit() {
  const repos = exportSource('src/git/repos.ts');
  const prepare = exportSource('src/evals/prepare.ts');
  const command = exportSource('src/git/command.ts');
  const gateOutput = exportSource('src/gates/output.ts');
  exportSource('src/core/allow.ts');
  exportSource('src/gates/audit.ts');
  exportSource('src/gates/detect.ts');
  exportSource('src/gates/media.ts');
  exportSource('src/util/credential-matcher.ts');
  exportSource('src/util/terminal-redaction.ts');

  const src = join(scratch, 'pinned', 'src');
  // Audit inputs specify empty private strings and registered credentials.
  writeFileSync(join(src, 'gates/private.ts'), `
    export const loadPrivateStrings = () => [];
    export const privateMatches = () => [];
    export function privateReason() { throw new Error('Unexpected private match'); }
    export class PrivateError extends Error {}
  `);
  writeFileSync(join(src, 'util/proc.ts'),
    'import { credentialRegistry } from "./credential-matcher.ts";\n' +
    'export const registeredCredentials = () => credentialRegistry.values();\n');
  writeFileSync(join(src, 'gates/output.ts'),
    'import { terminalRedactor } from "../util/terminal-redaction.ts";\n' +
    slice(gateOutput, 47, 47) + '\n');

  const entry = join(src, 'audit-entry.ts');
  writeFileSync(entry, [
    `import * as fs from 'node:fs';
    import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { dirname, join, resolve } from 'node:path';
    import { attributeRules, INERT_MEDIA_PATH, newlyHidden, SOURCE_PATH, unquote } from './gates/audit.ts';
    import { detectGates } from './gates/detect.ts';
    import { isForbiddenFormat, isInertMedia, MEDIA_LIMIT } from './gates/media.ts';
    import * as privacy from './gates/private.ts';
    export { auditDiff } from './gates/audit.ts';
    export { gateScriptNames, pickScripts } from './gates/detect.ts';
    export { parseAllow } from './core/allow.ts';
    const worktreeGit = (...args) => sh(...args);
    const emptyTreeId = (opts) => hashEmptyTree(['git'], opts, sh);
    const unexpected = () => { throw new Error('Unexpected three-dot or private blob scan'); };
    const mergeBase = unexpected;
    const blobPrivateEntries = unexpected;
    export let sh;
    export const setGitAdapter = adapter => { sh = adapter; };`,
    slice(command, 22, 22), // NO_BIG_FILES
    slice(command, 307, 318), // hashEmptyTree
    slice(repos, 495, 504), // readFileAt
    slice(repos, 889, 987), // diffSince
    slice(repos, 1025, 1035), // localLfsPayload
    slice(repos, 1253, 1575), // attribute inspection
    slice(repos, 1590, 1598), // parseNameStatus
    slice(prepare, 32, 61), // gatesAt
  ].join('\n'));
  const pinned = await import(pathToFileURL(entry).href);
  pinned.setGitAdapter(sh);
  return pinned;
}

async function regenerate() {
  const { auditDiff, diffSince, gatesAt, gateScriptNames, parseAllow, pickScripts, readFileAt } = await loadPinnedAudit();
  const result = {};
  const signal = new AbortController().signal;
  const caseRepo = join(scratch, 'case');
  for (const entry of cases) {
    try {
      const { base, head } = buildCaseRepo({ sourceRepo, base: entry.base, head: entry.head, dest: caseRepo });
      const diff = await diffSince(caseRepo, base, env, false, []);
      if (diff.attributeErrors?.length) throw new Error(diff.attributeErrors.join('\n'));
      const gates = await gatesAt(caseRepo, base, signal);
      const names = gateScriptNames(gates);
      result[entry.id] = {
        baseTree: git(caseRepo, 'rev-parse', `${base}^{tree}`),
        headTree: git(caseRepo, 'rev-parse', `${head}^{tree}`),
        audit: auditDiff(diff, {
          allow: parseAllow(entry.input.prompt),
          taskClass: null,
          protectedPaths: gates.protectedPaths,
          toolCommands: [],
          gateScripts: {
            before: pickScripts(await readFileAt(caseRepo, base, 'package.json'), names),
            after: pickScripts(await readFileAt(caseRepo, 'HEAD', 'package.json'), names),
          },
        }),
      };
    } catch (error) {
      throw new Error(`${entry.id}: ${error.message}`, { cause: error });
    } finally {
      rmSync(caseRepo, { recursive: true, force: true });
    }
  }
  return result;
}

try {
  const result = await regenerate();
  const generated = Buffer.from(JSON.stringify(result, null, 2) + '\n');
  const check = args[0] === '--check';
  const existing = check || existsSync(auditFile) ? readFileSync(auditFile) : null;
  if (existing && !generated.equals(existing)) {
    console.error('limitless-audit.json differs from regeneration');
    const expected = JSON.parse(existing);
    for (const id of new Set([...Object.keys(expected), ...Object.keys(result)])) {
      if (JSON.stringify(expected[id]) !== JSON.stringify(result[id])) {
        console.error(`${id}\n  existing: ${JSON.stringify(expected[id])}\n  generated: ${JSON.stringify(result[id])}`);
      }
    }
    process.exitCode = 1;
  } else if (check) {
    console.log(`limitless-audit.json matches byte for byte for ${cases.length} cases`);
  } else {
    writeFileSync(auditFile, generated);
    console.log(`Wrote limitless-audit.json for ${cases.length} cases`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

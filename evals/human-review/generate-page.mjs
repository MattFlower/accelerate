import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { buildCaseRepo, git, root } from './build-case-repo.mjs';
import { isolatedEnv, redact, requireClaudeAuth } from './isolated-env.mjs';
import { hash, readJSON, writeJSON, execute, parseTranscript, options, isMain } from './runtime.mjs';

export function generationArgv({ repo, skill, model, maxUsd, budgetSupported, branch, head }) {
  const script = join(skill, 'scripts/human-review.mjs');
  const slug = ref => {
    const s = ref.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'review';
    return s === ref ? s : s.slice(0, 50) + '-' + hash(ref).slice(0, 6);
  };
  const dirs = [branch && slug(branch), head?.slice(0, 12)].filter(Boolean).map(s => join(repo, '.human-review', s));
  const scriptRules = ['node', 'bun'].flatMap(bin => [script, '"' + script + '"'].flatMap(file => [
    ...['', ' --base main', ...(branch ? [' --base main --head ' + branch, ' --base main --head ' + branch + ' --no-uncommitted'] : [])]
      .map(flags => `Bash(${bin} ${file} collect${flags})`),
    ...dirs.flatMap(dir => [dir, '"' + dir + '"'].flatMap(d => ['', ' --check'].map(flags => `Bash(${bin} ${file} build ${d}${flags})`))),
  ]));
  return ['-p', '--output-format', 'json', '--no-session-persistence', '--setting-sources', 'user',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-mode', 'dontAsk',
    '--tools', 'Read,Grep,Glob,Bash,Write,Edit,Skill',
    '--allowedTools', 'Read', 'Grep', 'Glob', 'Skill(human-review)',
    'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git status:*)', 'Bash(command -v:*)',
    ...scriptRules,
    `Write(${repo}/.human-review/**)`, `Edit(${repo}/.human-review/**)`,
    '--disallowedTools', 'WebFetch', 'WebSearch', 'Bash(git diff --output:*)', 'Bash(git diff --output=*)',
    'Bash(git log --output:*)', 'Bash(git log --output=*)', 'Bash(git show --output:*)', 'Bash(git show --output=*)',
    ...(model ? ['--model', model] : []),
    ...(maxUsd !== undefined && budgetSupported ? ['--max-budget-usd', String(maxUsd)] : [])];
}
export async function generatePage(opts) {
  if (!opts.confirmSpend && !opts.dryRun) throw new Error('--confirm-spend required');
  if (!opts.caseId || !opts.out) throw new Error('caseId and --out required');
  const out = resolve(opts.out), repo = join(out, 'repo');
  if (existsSync(out)) throw new Error('--out must not exist');
  if (opts.maxUsd !== undefined && (!Number.isFinite(Number(opts.maxUsd)) || Number(opts.maxUsd) <= 0)) throw new Error('invalid --max-usd');
  if (!opts.dryRun) requireClaudeAuth(opts.passAuth);
  const scratch = mkdtempSync(join(tmpdir(), 'hr-generate-'));
  const secrets = [process.env.CLAUDE_CODE_OAUTH_TOKEN].filter(Boolean);
  const clean = v => redact(v, secrets);
  try {
    const { env } = isolatedEnv({ scratchRoot: scratch, passAuth: opts.passAuth ? ['CLAUDE_CODE_OAUTH_TOKEN'] : [] });
    const skill = join(env.CLAUDE_CONFIG_DIR, 'skills/human-review');
    const help = await execute(opts.claudeBin ?? 'claude', ['--help'], { cwd: scratch, env, prompt: '' });
    const key = readJSON(join(opts.keysDir ?? join(root, 'keys'), opts.caseId + '.json'));
    let argv = generationArgv({ ...opts, repo, skill, branch: key.branch, budgetSupported: help.stdout.includes('--max-budget-usd') });
    if (opts.dryRun) { console.log(clean(JSON.stringify({ argv, envKeys: Object.keys(env).sort() }))); return; }
    mkdirSync(out);
    const built = buildCaseRepo({ caseId: opts.caseId, dest: repo, keysDir: opts.keysDir, casesDir: opts.casesDir });
    argv = generationArgv({ ...opts, repo, skill, branch: key.branch, head: built.head, budgetSupported: help.stdout.includes('--max-budget-usd') });
    const sourceRoot = resolve(root, '../..');
    const archive = execFileSync('git', ['archive', 'HEAD', 'skills/human-review'], { cwd: sourceRoot, maxBuffer: 128 * 1024 * 1024 });
    const unpack = join(scratch, 'archive'); mkdirSync(unpack);
    execFileSync('tar', ['-xf', '-', '-C', unpack], { input: archive });
    mkdirSync(dirname(skill), { recursive: true });
    execFileSync('cp', ['-R', join(unpack, 'skills/human-review'), skill]);
    const script = join(skill, 'scripts/human-review.mjs');
    const version = execFileSync(process.execPath, [script, '--version'], { encoding: 'utf8', env, cwd: repo }).split('\n')[0];
    const prompt = `/human-review main..${key.branch}\nDo not open a browser.`;
    const trial = { caseId: opts.caseId, split: key.split, branch: key.branch, base: built.base, head: built.head,
      modelRequested: opts.model ?? null, modelReported: null, total_cost_usd: null, durationMs: 0, exitCode: null,
      status: 'error', promptSha256: hash(prompt), skillVersion: version,
      skillTreeSha: git(sourceRoot, 'rev-parse', 'HEAD:skills/human-review'),
      skillSha256: hash(readFileSync(join(skill, 'SKILL.md'))), toolCalls: {}, buildCheck: 'failed',
      pageId: randomBytes(6).toString('hex') };
    const start = performance.now();
    const result = await execute(opts.claudeBin ?? 'claude', argv, { cwd: repo, env, prompt, timeoutMs: opts.timeoutMs });
    trial.durationMs = Math.round(performance.now() - start); trial.exitCode = result.code;
    writeFileSync(join(out, 'transcript.json'), clean(result.stdout));
    writeFileSync(join(out, 'stderr.txt'), clean(result.stderr));
    const parsed = parseTranscript(result.stdout, 'claude');
    Object.assign(trial, { modelReported: parsed.modelReported, total_cost_usd: parsed.cost, toolCalls: parsed.toolCalls });
    try {
      if (result.timedOut || result.signal) { trial.status = 'cancelled'; throw new Error('generation cancelled'); }
      if (result.code !== 0 || result.launchError || parsed.error) throw new Error(result.launchError ?? parsed.error ?? 'generation failed');
      if (parsed.final === undefined) throw new Error('missing final result');
      if (opts.maxUsd !== undefined && (parsed.cost === null || parsed.cost > Number(opts.maxUsd))) throw new Error('budget exceeded or cost unavailable');
      const reviewRoot = join(repo, '.human-review');
      const recaps = existsSync(reviewRoot) ? readdirSync(reviewRoot).filter(n => {
        const dir = join(reviewRoot, n);
        return !lstatSync(dir).isSymbolicLink() && lstatSync(dir).isDirectory() && existsSync(join(dir, 'recap.json'));
      }).map(n => join(reviewRoot, n)) : [];
      if (recaps.length !== 1) throw new Error('expected exactly one recap.json');
      const dir = recaps[0];
      for (const name of ['recap.json', 'review.html']) if (existsSync(join(dir, name))) {
        if (!lstatSync(join(dir, name)).isFile() || lstatSync(join(dir, name)).isSymbolicLink()) throw new Error('invalid page file');
        writeFileSync(join(out, name), clean(readFileSync(join(dir, name), 'utf8')));
      }
      execFileSync(process.execPath, [script, 'build', dir, '--check'], { cwd: repo, env, stdio: 'pipe' });
      trial.buildCheck = 'ok'; trial.status = 'ok';
    } catch (e) { trial.error = clean(e.message); }
    // Scrub generated artifacts too, including any accidental credential echoes.
    function scrub(dir) {
      for (const name of readdirSync(dir)) {
        if (name === '.git') continue;
        const p = join(dir, name), st = lstatSync(p);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) scrub(p);
        else { const b = readFileSync(p); if (secrets.some(s => b.includes(Buffer.from(s)))) writeFileSync(p, clean(b.toString('utf8'))); }
      }
    }
    scrub(out);
    writeJSON(join(out, 'trial.json'), JSON.parse(clean(JSON.stringify(trial))));
    return trial;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
if (isMain(import.meta.url)) {
  try { const o = options(process.argv.slice(2), ['passAuth', 'confirmSpend', 'dryRun']); o.caseId = o._[0];
    const trial = await generatePage(o); if (trial) { console.log(`${trial.caseId} status=${trial.status}`); if (trial.status !== 'ok') process.exitCode = 1; }
  } catch (e) { console.error(redact(e.message, [process.env.CLAUDE_CODE_OAUTH_TOKEN])); process.exitCode = 1; }
}

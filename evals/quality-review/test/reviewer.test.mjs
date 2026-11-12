import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { git, buildCaseRepo } from '../case-repo.mjs';
import { changedInstructionFiles } from '../isolated-env.mjs';
import { buildArgv, runReviewer, parseTranscript, validateFindings } from '../run-reviewer.mjs';

const finding = { severity: 'major', security: false, file: 'x', line: 1, title: 'Broken', detail: 'Details', suggestion: 'Fix',
  failure_scenario: 'Input x', category: 'correctness', confidence: 0.9, introduced_by_diff: true };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'qr-review-test-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'); mkdirSync(source); git(source, 'init', '-q', '--template=');
  writeFileSync(join(source, 'AGENTS.md'), 'base'); git(source, 'add', '.'); git(source, 'commit', '-qm', 'base');
  const base = git(source, 'rev-parse', 'HEAD');
  writeFileSync(join(source, 'AGENTS.md'), 'head'); mkdirSync(join(source, '.claude')); writeFileSync(join(source, '.claude/settings.json'), '{}');
  mkdirSync(join(source, '.agents')); writeFileSync(join(source, '.agents/rules'), 'rules');
  git(source, 'add', '.'); git(source, 'commit', '-qm', 'head'); const head = git(source, 'rev-parse', 'HEAD');
  const caseRepo = join(root, 'case'), expectedShas = buildCaseRepo({ sourceRepo: source, base, head, dest: caseRepo });
  const promptFile = join(root, 'prompt'); writeFileSync(promptFile, Buffer.from('exact prompt\r\n\u00e9\n\0'));
  return { root, source, base, head, caseRepo, expectedShas, promptFile, caseId: 'test-1', model: 'fake-model', effort: 'high', sample: 1, outDir: join(root, 'out'), scratchRoot: root };
}
function fake(opts, runtime, mode) {
  const bin = join(opts.root, runtime), marker = join(opts.root, 'received.json');
  writeFileSync(bin, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
const chunks=[]; for await (const b of process.stdin) chunks.push(b);
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({env: process.env, prompt:Buffer.concat(chunks).toString('base64'), argv:process.argv.slice(2)}));
const emit = e => console.log(JSON.stringify(e));
const runtime=${JSON.stringify(runtime)}, mode=${JSON.stringify(mode)};
if(mode==='hang') { setInterval(()=>{},1000); } else {
const output=mode==='invalid'?{findings:[{severity:'critical'}]}:mode==='finding'?{findings:[${JSON.stringify(finding)}]}:{findings:[]};
if(runtime==='codex') {
emit({type:'thread.started',thread_id:'t'});
for(const phase of ['item.started','item.completed']) emit({type:phase,item:{id:'s1',type:'command_execution',command:'git diff'}});
emit({type:'item.completed',item:{id:'s2',type:'command_execution',command:'git show'}});
emit({type:'item.started',item:{id:'m1',type:'mcp_tool_call',server:'test',tool:'read'}});
emit({type:'item.completed',item:{id:'m1',type:'mcp_tool_call',server:'test',tool:'read'}});
if(mode!=='missing') emit({type:'item.completed',item:{id:'a',type:'agent_message',text:mode==='garbage'?'garbage':JSON.stringify(output)}});
emit({type:'turn.completed',usage:{}});
} else {
emit({type:'system',subtype:'init',model:'reported-model'});
emit({type:'assistant',message:{content:[{type:'tool_use',id:'r1',name:'Read',input:{}},{type:'tool_use',id:'g1',name:'Grep',input:{}},{type:'tool_use',id:'r2',name:'Read',input:{}}]}});
if(mode!=='missing') emit({type:'result',subtype:'success',is_error:false,...(mode==='garbage'?{result:'garbage'}:{structured_output:output})});
}
if(mode==='rawgarbage') console.log('not JSONL');
console.error('fake stderr'); process.exitCode=mode==='exit'?7:0;
}
`, { mode: 0o755 });
  return { bin, marker };
}
test('changed instructions include edits and added configuration, including .agents', t => {
  const f = fixture(t);
  assert.deepEqual(changedInstructionFiles(f.caseRepo), [
    { status: 'A', path: '.agents/rules' }, { status: 'A', path: '.claude/settings.json' }, { status: 'M', path: 'AGENTS.md' },
  ]);
  // Deleted and nested instructions are reported too, without touching checkout.
  mkdirSync(join(f.source, 'nested')); writeFileSync(join(f.source, 'nested/CLAUDE.md'), 'rules');
  rmSync(join(f.source, 'AGENTS.md')); git(f.source, 'add', '.'); git(f.source, 'commit', '-qm', 'delete');
  assert.deepEqual(changedInstructionFiles(f.source), [{ status: 'D', path: 'AGENTS.md' }, { status: 'A', path: 'nested/CLAUDE.md' }]);
});
for (const runtime of ['codex', 'claude']) {
  test(`${runtime}: isolated child, exact prompt bytes, provenance and tool counts`, async t => {
    const f = fixture(t), { bin, marker } = fake(f, runtime, 'empty');
    const old = process.env.FOO_SECRET; process.env.FOO_SECRET = 'parent-only-secret';
    t.after(() => { if (old === undefined) delete process.env.FOO_SECRET; else process.env.FOO_SECRET = old; });
    const result = await runReviewer({ ...f, runtime, bin });
    assert.equal(result.status, 'ok', result.error); assert.deepEqual(result.findings, []);
    const received = JSON.parse(readFileSync(marker));
    for (const key of ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) assert.ok(received.env[key].startsWith(f.root + '/qr-env-'));
    assert.equal(received.env.FOO_SECRET, undefined);
    const bytes = readFileSync(f.promptFile);
    assert.deepEqual(Buffer.from(received.prompt, 'base64'), bytes);
    assert.equal(result.promptSha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(received.argv, buildArgv({ ...f, runtime }));
    assert.equal(result.base, f.expectedShas.base); assert.equal(result.head, f.expectedShas.head);
    assert.equal(result.modelReported, runtime === 'claude' ? 'reported-model' : null);
    assert.deepEqual(result.toolCalls, runtime === 'codex' ? { shell: 2, 'test.read': 1 } : { Read: 2, Grep: 1 });
    assert.ok(result.instructionManifest.some(e => e.path === '.agents/rules'));
    assert.equal(result.instructionFilesChanged.length, 3);
    const prefix = join(f.outDir, `test-1.${runtime}.s1`);
    assert.deepEqual(JSON.parse(readFileSync(prefix + '.json')), result);
    assert.match(readFileSync(prefix + '.stderr', 'utf8'), /fake stderr/);
    assert.match(readFileSync(prefix + '.jsonl', 'utf8'), /result|turn.completed/);
  });
  for (const mode of ['finding', 'garbage', 'rawgarbage', 'invalid', 'missing', 'exit', 'hang']) test(`${runtime}: ${mode}`, async t => {
    const f = fixture(t), { bin } = fake(f, runtime, mode);
    const r = await runReviewer({ ...f, runtime, bin, timeoutMs: mode === 'hang' ? 100 : 5000 });
    assert.equal(r.status, mode === 'finding' ? 'ok' : mode === 'hang' ? 'cancelled' : 'error', r.error);
    assert.deepEqual(r.findings, mode === 'finding' ? [finding] : null);
    if (mode !== 'finding') assert.equal(typeof r.error, 'string');
    if (mode === 'exit') assert.equal(r.exitCode, 7);
  });
}
test('future history refuses before fake launch', async t => {
  const f = fixture(t), { bin, marker } = fake(f, 'codex', 'empty');
  git(f.caseRepo, 'commit', '--allow-empty', '-qm', 'future');
  await assert.rejects(runReviewer({ ...f, runtime: 'codex', bin }), /Check 5/);
  assert.equal(existsSync(marker), false);
});
test('argv is explicit about read-only, effort, schema and unattended settings', () => {
  const codex = buildArgv({ runtime: 'codex', caseRepo: '/tmp/case', model: 'm', effort: 'high' });
  assert.ok(codex.includes('read-only')); assert.ok(codex.includes('approval_policy="never"'));
  assert.ok(codex.includes('model_reasoning_effort="high"')); assert.ok(codex.includes('--output-schema')); assert.equal(codex.at(-1), '-');
  const claude = buildArgv({ runtime: 'claude', model: 'm', effort: 'high' });
  assert.equal(claude[claude.indexOf('--setting-sources') + 1], '');
  assert.equal(claude[claude.indexOf('--tools') + 1], 'Read,Grep,Glob,Bash');
  assert.equal(claude[claude.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.deepEqual(claude.slice(claude.indexOf('--allowedTools') + 1, claude.indexOf('--disallowedTools')),
    ['Read', 'Grep', 'Glob', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git status:*)']);
  assert.deepEqual(claude.slice(claude.indexOf('--disallowedTools') + 1, claude.indexOf('--effort')),
    ['Bash(git diff --output:*)', 'Bash(git diff --output=*)', 'Bash(git log --output:*)',
      'Bash(git log --output=*)', 'Bash(git show --output:*)', 'Bash(git show --output=*)']);
});
test('CLI refuses spend and dry-run prints keys without environment or prompt values', t => {
  const f = fixture(t), { bin, marker } = fake(f, 'codex', 'empty');
  const casesFile = join(f.root, 'cases.json');
  writeFileSync(casesFile, JSON.stringify({ cases: [{ id: f.caseId, repo: 'fixture/repo', split: 'dev', base: f.base, head: f.head }] }));
  const args = [resolve('evals/quality-review/run-trials.mjs'), '--cases', casesFile, '--limitless', f.source, '--runtime', 'codex', '--model', 'm', '--effort', 'high', '--prompt', f.promptFile, '--k', '2', '--out', f.outDir];
  const env = { ...process.env, PATH: `${f.root}:${process.env.PATH}`, FOO_SECRET: 'SECRET_VALUE_DO_NOT_PRINT', LANG: 'PRIVATE_LANG_VALUE' };
  const denied = spawnSync(process.execPath, args, { env, encoding: 'utf8' });
  assert.notEqual(denied.status, 0); assert.match(denied.stderr, /confirm-spend/); assert.equal(existsSync(marker), false);
  const dry = spawnSync(process.execPath, [...args, '--dry-run'], { env, encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr); assert.equal(existsSync(marker), false);
  assert.ok(!dry.stdout.includes(env.FOO_SECRET)); assert.ok(!dry.stdout.includes(env.LANG)); assert.ok(!dry.stdout.includes('exact prompt'));
  const plans = dry.stdout.trim().split('\n').map(JSON.parse); assert.deepEqual(plans.map(p => p.sample), [1, 2]);
  assert.ok(plans[0].envKeys.includes('HOME')); assert.ok(!plans[0].envKeys.includes('FOO_SECRET'));
  assert.ok(plans[0].argv.includes('--json'));
  assert.equal(existsSync(join(f.outDir, 'trials.jsonl')), false);
  assert.equal(bin, join(f.root, 'codex'));
});

test('parser rejects runtime failures and keeps counts on malformed output', () => {
  const codex = parseTranscript([
    {type:'item.completed',item:{id:'a',type:'command_execution'}},
    {type:'turn.failed',error:{message:'failure'}},
  ].map(JSON.stringify).join('\n'), 'codex');
  assert.equal(codex.error, 'failure'); assert.deepEqual(codex.toolCalls, {shell:1});
  assert.ok(parseTranscript('{"type":"result","is_error":true,"subtype":"error_max_turns"}', 'claude').error);
  const malformed = parseTranscript('{"type":"assistant","message":{"content":[{"type":"tool_use","id":"a","name":"Read"}]}}\ninvalid', 'claude');
  assert.deepEqual(malformed.toolCalls, {Read:1}); assert.match(malformed.error, /Unparseable/);
});
test('schema requires every ported field and checks types, enums and confidence clamp', () => {
  for (const key of Object.keys(finding)) {
    const value = {...finding}; delete value[key];
    assert.throws(() => validateFindings({findings:[value]}), /Missing/);
  }
  for (const patch of [{line:1.5}, {confidence:'high'}, {security:'false'}, {category:'invented'}, {severity:'critical'}, {extra:true}])
    assert.throws(() => validateFindings({findings:[{...finding,...patch}]}));
  assert.equal(validateFindings({findings:[{...finding,confidence:2}]})[0].confidence, 1);
  assert.equal(validateFindings({findings:[{...finding,confidence:-1}]})[0].confidence, 0);
});

test('Claude Bash counts include the first two command words and deduplicate call ids', () => {
  const calls = [
    { id: 'd1', command: 'git diff HEAD^ HEAD' },
    { id: 'd1', command: 'git diff HEAD^ HEAD' },
    { id: 'd2', command: '  git\t diff --stat' },
    { id: 'l1', command: 'git log --oneline' },
    { id: 's1', command: 'git show HEAD' },
    { id: 's2', command: 'git status --short' },
    { id: 'empty', command: '   ' },
    { id: 'missing' },
  ].map(({ id, command }) => ({ type: 'tool_use', id, name: 'Bash', input: { command } }));
  const transcript = JSON.stringify({ type: 'assistant', message: { content: calls } });
  assert.deepEqual(parseTranscript(transcript, 'claude').toolCalls,
    { Bash: 7, 'Bash:git diff': 2, 'Bash:git log': 1, 'Bash:git show': 1, 'Bash:git status': 1 });
});

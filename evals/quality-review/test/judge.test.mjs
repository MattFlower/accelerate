import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { JUDGE_RULE, TEMPLATE, judgePayload, normalizeJudgment, keyFor, runJudge, judgeArgv, judgedMetrics, cleanMetrics, wilson } from '../judge.mjs';
import { validationSample } from '../validation-sample.mjs';
const item = { id: 'real', kind: 'real', defects: [{ file: 'x', lines: [1, 2], summary: 'Broken', required: true }] };
const finding = { severity: 'major', security: false, file: 'x', line: 1, title: 'Broken', detail: 'Details', suggestion: 'Fix', failure_scenario: 'Input x', category: 'correctness', confidence: .9, introduced_by_diff: true };
const judges = ['codex:fake:high', 'claude:fake:high'];
const match = (finding = 'F1', gold = 'G1', confidence = .9) => ({ gold, finding, confidence, reason: 'same' });
function scratch(t) { const root = mkdtempSync(join(tmpdir(), 'qr-judge-test-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
const source = spawnSync('git', ['-C', '../repos/limitless', 'show', 'e42003a:src/evals/judge.ts'], { encoding: 'utf8' });
test('exact pinned prompt text', { skip: source.status !== 0 }, () => {
  assert.equal(JUDGE_RULE, source.stdout.match(/export const JUDGE_RULE = `([\s\S]*?)`;/)[1]);
  assert.equal(TEMPLATE, JSON.parse(source.stdout.match(/const TEMPLATE = (".*");/)[1]));
});
test('strict normalization rejects ids and deduplicates by confidence then gold order', () => {
  for (const matches of [[], [match('F2')], [match(null, 'G2')], [match(), match()]]) assert.throws(() => normalizeJudgment({ matches }, item, [finding]));
  assert.throws(() => normalizeJudgment({ matches: [{ ...match(), extra: true }] }, item, [finding]));
  const two = { ...item, defects: [...item.defects, ...item.defects] };
  assert.throws(() => normalizeJudgment({ matches: [match(), match()] }, two, [finding]));
  assert.deepEqual(normalizeJudgment({ matches: [match('F1', 'G2', 1), match()] }, two, [finding]).map(m => m.finding), [null, 'F1']);
  assert.deepEqual(normalizeJudgment({ matches: [match('F1', 'G2'), match()] }, two, [finding]).map(m => m.finding), ['F1', null]);
});
for (const runtime of ['codex', 'claude']) test(`${runtime}: fake PATH binary, isolated env, redaction, cache reuse and no tools`, async t => {
  const root = scratch(t), marker = join(root, 'received'), bin = join(root, runtime);
  writeFileSync(bin, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';
let prompt='';for await(const b of process.stdin)prompt+=b;
writeFileSync(${JSON.stringify(marker)},JSON.stringify({prompt,env:process.env,argv:process.argv.slice(2),cwd:process.cwd()}));
const output={matches:[${JSON.stringify(match())}]};
console.log(JSON.stringify(${runtime === 'codex' ? "{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(output)}}" : "{type:'result',subtype:'success',structured_output:output,total_cost_usd:.01}"}));\n`, { mode: 0o755 });
  const previous = { PATH: process.env.PATH, AUTH_TEST: process.env.AUTH_TEST, PARENT_SECRET: process.env.PARENT_SECRET };
  Object.assign(process.env, { PATH: `${root}:${process.env.PATH}`, AUTH_TEST: 'auth-secret-value', PARENT_SECRET: 'parent-secret-value' });
  t.after(() => { for (const [k, v] of Object.entries(previous)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  const findings = [{ ...finding, detail: 'auth-secret-value auth-secret-value' }];
  const opts = { judge: `${runtime}:fake:high`, item, findings, cacheDir: join(root, 'cache'), passAuth: ['AUTH_TEST'], confirmSpend: true };
  const first = await runJudge(opts); assert.equal(first.modelCalls, 1);
  const received = JSON.parse(readFileSync(marker));
  assert.equal(received.env.PARENT_SECRET, undefined); assert.equal(received.env.AUTH_TEST, 'auth-secret-value');
  assert.ok(!received.prompt.includes('auth-secret-value')); assert.ok(received.prompt.includes('[redacted] [redacted]'));
  assert.equal(received.prompt, `${JUDGE_RULE}\n\n${TEMPLATE}${JSON.stringify(judgePayload(item, findings, ['auth-secret-value']))}`);
  const argv = [...received.argv];
  if (runtime === 'codex') argv[argv.indexOf('-C') + 1] = argv[argv.indexOf('-C') + 1].replace(/^\/var\//, '/private/var/');
  assert.deepEqual(argv, judgeArgv({ runtime, model: 'fake', effort: 'high', cwd: received.cwd }));
  if (runtime === 'codex') { assert.ok(received.argv.includes('shell_tool')); assert.ok(received.argv.includes('--ephemeral')); }
  else assert.equal(received.argv[received.argv.indexOf('--tools') + 1], '');
  rmSync(bin);
  assert.equal((await runJudge({ ...opts, confirmSpend: false })).modelCalls, 0);
});
function cache(root, judge, findings, matches) { writeFileSync(join(root, keyFor(judge, item, findings) + '.json'), JSON.stringify({ judge, matches })); }
test('scoring preserves caught, contested, underRated and missing semantics', t => {
  const root = scratch(t);
  for (const [severity, a, b, expected] of [['major', 'F1', 'F1', 'caught'], ['major', 'F1', null, 'contested'], ['minor', 'F1', 'F1', 'underRated']]) {
    const findings = [{ ...finding, severity }], trials = [{ caseId: item.id, status: 'ok', findings }];
    cache(root, judges[0], findings, [match(a)]); cache(root, judges[1], findings, [match(b)]);
    const m = judgedMetrics(trials, [item], judges, root);
    assert.equal(expected === 'caught' ? m.recall.numerator : m[expected], 1);
    assert.equal(m.recall.denominator, 1); assert.equal(m.agreement.rate, expected === 'contested' ? 0 : 1);
    const sample = validationSample(trials, [item], judges, root, 4, 42);
    assert.deepEqual(sample, validationSample(trials, [item], judges, root, 4, 42));
  }
  const clean = { id: 'clean', kind: 'clean' };
  const m = cleanMetrics([{ caseId: 'clean', status: 'error', findings: null }, { caseId: 'clean', status: 'ok', findings: [finding] }], [clean]);
  assert.equal(m.errors, 1); assert.equal(m.denominator, 1); assert.equal(m.numerator, 1);
  assert.equal(wilson(0, 0), null); assert.throws(() => wilson(2, 1));
});
test('CLI refuses unconfirmed spend, requires two judges, dry-run never launches', t => {
  const root = scratch(t), trials = join(root, 'trials'); mkdirSync(trials);
  writeFileSync(join(trials, 'trials.jsonl'), JSON.stringify({ caseId: item.id, status: 'ok', findings: [finding] }) + '\n');
  const cases = join(root, 'cases.json'); writeFileSync(cases, JSON.stringify({ cases: [item] }));
  const args = [resolve('evals/quality-review/judge-trials.mjs'), '--trials', trials, '--cases', cases, '--cache', join(root, 'cache'), '--out', join(root, 'report.json'), '--judge', judges[0], '--judge', judges[1]];
  const denied = spawnSync(process.execPath, args, { encoding: 'utf8' }); assert.notEqual(denied.status, 0); assert.match(denied.stderr, /confirm-spend/);
  const dry = spawnSync(process.execPath, [...args, '--dry-run'], { encoding: 'utf8' }); assert.equal(dry.status, 0, dry.stderr); assert.equal(JSON.parse(dry.stdout).judgeCalls, 2);
  assert.ok(JSON.parse(dry.stdout).plans.every(p => p.envKeys.includes('HOME')));
  const one = spawnSync(process.execPath, args.slice(0, -2), { encoding: 'utf8' }); assert.match(one.stderr, /exactly two/);
});

test('malformed responses retry once; cached and failed trials never improve recall', async t => {
  const root = scratch(t), count = join(root, 'count'), bin = join(root, 'codex');
  writeFileSync(bin, `#!${process.execPath}
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
for await(const b of process.stdin){}
const path=${JSON.stringify(count)};const n=existsSync(path)?Number(readFileSync(path)):0;writeFileSync(path,String(n+1));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:n===0?'malformed':JSON.stringify({matches:[${JSON.stringify(match())}]})}}));
`, { mode: 0o755 });
  const cacheDir = join(root, 'cache');
  const result = await runJudge({ judge: judges[0], item, findings: [finding], cacheDir, bin, confirmSpend: true });
  assert.equal(result.modelCalls, 2); assert.equal(readFileSync(count, 'utf8'), '2');
  const trials = [{ caseId: item.id, status: 'ok', findings: [finding] }, { caseId: item.id, status: 'error', findings: null }];
  const metrics = judgedMetrics(trials, [item], judges, cacheDir);
  assert.equal(metrics.unjudged, 1); assert.equal(metrics.recall.denominator, 0); assert.equal(metrics.recall.rate, null);
});

for (const runtime of ['codex', 'claude']) test(`${runtime}: default effort is recorded but omitted from argv`, () => {
  const args = judgeArgv({ runtime, model: 'fake', cwd: '/tmp' });
  assert.ok(!args.some(arg => arg.includes('model_reasoning_effort')));
  assert.ok(!args.includes('--effort'));
  assert.deepEqual(args, judgeArgv({ runtime, model: 'fake', effort: 'default', cwd: '/tmp' }));
  assert.equal(keyFor(`${runtime}:fake`, item, [finding]), keyFor(`${runtime}:fake:default`, item, [finding]));
  const explicit = judgeArgv({ runtime, model: 'fake', effort: 'high', cwd: '/tmp' });
  assert.ok(explicit.includes(runtime === 'codex' ? 'model_reasoning_effort="high"' : '--effort'));
});

test('passed secrets share cache keys across judging, metrics, sampling and CLI reuse', t => {
  const root = scratch(t), trialsDir = join(root, 'trials'), cacheDir = join(root, 'cache'), count = join(root, 'calls');
  mkdirSync(trialsDir);
  const secret = 'passed-secret-value', findings = [{ ...finding, detail: secret }];
  const trials = [{ caseId: item.id, status: 'ok', findings }];
  writeFileSync(join(trialsDir, 'trials.jsonl'), trials.map(JSON.stringify).join('\n') + '\n');
  const cases = join(root, 'cases.json'), out = join(root, 'report.json');
  writeFileSync(cases, JSON.stringify({ cases: [item] }));
  for (const runtime of ['codex', 'claude']) writeFileSync(join(root, runtime), `#!${process.execPath}
import {appendFileSync} from 'node:fs';
let prompt='';for await(const b of process.stdin)prompt+=b;
if(prompt.includes(${JSON.stringify(secret)}) || process.env.AUTH_TEST!==${JSON.stringify(secret)})process.exit(1);
appendFileSync(${JSON.stringify(count)},'call\\n');
const output={matches:[${JSON.stringify(match())}]};
console.log(JSON.stringify(${runtime === 'codex' ? "{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(output)}}" : "{type:'result',subtype:'success',structured_output:output}"}));
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${root}:${process.env.PATH}`, AUTH_TEST: secret };
  const args = [resolve('evals/quality-review/judge-trials.mjs'), '--trials', trialsDir, '--cases', cases, '--cache', cacheDir, '--out', out, '--judge', judges[0], '--judge', judges[1], '--pass-auth', 'AUTH_TEST', '--pass-auth', 'OTHER_AUTH'];
  const first = spawnSync(process.execPath, [...args, '--confirm-spend'], { env, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(readFileSync(count, 'utf8'), 'call\ncall\n');
  const report = JSON.parse(readFileSync(out));
  assert.deepEqual(report.errors, []); assert.equal(report.unjudged, 0); assert.equal(report.withoutReview224.unjudged, 0);
  assert.equal(judgedMetrics(trials, [item], judges, cacheDir, [secret]).unjudged, 0);
  assert.equal(validationSample(trials, [item], judges, cacheDir, 4, 42, [secret]).rows.length, 1);
  const sampleOut = join(root, 'sample');
  const sample = spawnSync(process.execPath, [resolve('evals/quality-review/validation-sample.mjs'), ...args.slice(1), '--out', sampleOut, '--n', '4'], { env, encoding: 'utf8' });
  assert.equal(sample.status, 0, sample.stderr); assert.equal(JSON.parse(readFileSync(sampleOut + '.json')).rows.length, 1);
  const second = spawnSync(process.execPath, args, { env, encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(readFileSync(out)).pendingJudgeCalls, 0);
  assert.equal(readFileSync(count, 'utf8'), 'call\ncall\n');
  for (const name of ['bad-name', 'HOME']) {
    const invalid = spawnSync(process.execPath, [...args, '--pass-auth', name, '--dry-run'], { env, encoding: 'utf8' });
    assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /Invalid auth variable/);
  }
});

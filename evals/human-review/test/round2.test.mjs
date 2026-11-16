import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generatePage, generationArgv } from '../generate-page.mjs';
import { pageText, splitSentences } from '../page-text.mjs';
import { judgePage, scorePage, consensus, judgePayload, quietLine } from '../judge-coverage.mjs';
import { stripPoint, stripSentences } from '../strip-point.mjs';
import { calibrate, calibrationPass, selectPages, plannedCalls } from '../calibrate.mjs';
import { report } from '../report.mjs';
import { handSample, sampleCSV } from '../hand-sample.mjs';
import { judgeArgv, callBudget } from '../model-call.mjs';
import { hash } from '../runtime.mjs';
import { git, root } from '../build-case-repo.mjs';

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hr-r2-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
}
function fake(dir, name, body) {
  const p = join(dir, name);
  writeFileSync(p, '#!' + process.execPath + '\n' + body, { mode: 0o755 }); return p;
}
const page = { text: 'Expiry is fixed.\nOther behavior stays.', sentences: [
  { id: 's1', text: 'Expiry is fixed.' }, { id: 's2', text: 'Other behavior stays.' },
] };
const key = { case_id: 'dev-x', split: 'dev', branch: 'SECRET_BRANCH', summary_for_maintainers: 'SECRET_MAINTAINER',
  points: [{ id: 'dev-x.p1', statement: 'SECRET_POINT fixed expiry', covered_if: 'Names fixed expiry', partial_if: 'Mentions expiry', evidence: ['SECRET_EVIDENCE'] }],
  false_claim_traps: [{ id: 'dev-x.t1', statement: 'Sliding expiry', why_false: 'Fixed', evidence: ['SECRET_EVIDENCE'] }] };
const judgment = (label = 'covered', asserted = false) => ({
  points: [{ id: 'P1', rationale: 's1: Expiry is fixed.', label }],
  traps: [{ id: 'T1', rationale: 'No sliding claim.', asserted }],
});
function judgeFake(dir, name, value, extra = '') {
  const runtime = name.includes('claude') ? 'claude' : 'codex';
  return fake(dir, name, `
    const fs = require('node:fs'); let input = '';
    process.stdin.on('data', b => input += b);
    process.stdin.on('end', () => {
      ${extra}
      const value = ${JSON.stringify(value)};
      console.log(JSON.stringify(${runtime === 'claude'
        ? "{type:'result',subtype:'success',structured_output:value,total_cost_usd:0.01}"
        : "{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(value)}}"}));
    });
  `);
}
function generationFake(dir, { duplicate = false, missing = false } = {}) {
  return fake(dir, 'claude', `
    const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
    if (process.argv.includes('--help')) { console.log('--max-budget-usd'); process.exit(0); }
    let prompt = ''; process.stdin.on('data', b => prompt += b);
    process.stdin.on('end', () => {
      const skill = path.join(process.env.CLAUDE_CONFIG_DIR, 'skills/human-review');
      const script = path.join(skill, 'scripts/human-review.mjs');
      if (!fs.existsSync(path.join(skill, 'SKILL.md'))) throw Error('skill missing');
      if (skill.startsWith(process.cwd() + path.sep)) throw Error('skill in repo');
      ${!missing ? `
      cp.execFileSync(process.execPath, [script, 'collect', '--base', 'main', '--head', 'HEAD'], {stdio:'pipe'});
      const parent = path.join(process.cwd(), '.human-review');
      const folder = path.join(parent, fs.readdirSync(parent)[0]);
      const recap = JSON.parse(fs.readFileSync(path.join(folder, 'recap.json')));
      recap.title = 'Order token lifecycle';
      fs.writeFileSync(path.join(folder, 'recap.json'), JSON.stringify(recap));
      ${duplicate ? "fs.mkdirSync(path.join(parent,'duplicate')); fs.copyFileSync(path.join(folder,'recap.json'),path.join(parent,'duplicate/recap.json'));" : ''}
      ` : ''}
      fs.writeFileSync('.human-review-observation.tmp', JSON.stringify({prompt, secret: process.env.FOO_SECRET,
        auth: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null, skill}));
      // Observation stays under the only permitted output directory.
      fs.mkdirSync('.human-review', {recursive:true});
      fs.renameSync('.human-review-observation.tmp', '.human-review/observation.json');
      console.error(process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '');
      console.log(JSON.stringify({type:'result',subtype:'success',result:'done',model:'fake',
        total_cost_usd:0.01, echo: process.env.CLAUDE_CODE_OAUTH_TOKEN}));
    });
  `);
}
function allFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? allFiles(join(dir, e.name)) : [join(dir, e.name)]);
}

test('generation refuses before building, and dry-run exposes keys only', async t => {
  const dir = temp(t), bin = generationFake(dir), out = join(dir, 'out');
  await assert.rejects(generatePage({ caseId: 'dev-2', out, claudeBin: bin }), /confirm-spend/);
  assert.equal(existsSync(out), false);
  const result = spawnSync(process.execPath, [join(root, 'generate-page.mjs'), 'dev-2', '--out', out, '--dry-run', '--claude-bin', bin, '--pass-auth'],
    { encoding: 'utf8', env: { ...process.env, FOO_SECRET: 'parent-private', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test-secret' } });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert(output.envKeys.includes('CLAUDE_CODE_OAUTH_TOKEN'));
  assert(!result.stdout.includes('oauth-test-secret'));
  assert(!result.stdout.includes('parent-private'));
  assert.equal(existsSync(out), false);
});

test('generation installs committed skill externally, exact prompt, isolates auth and redacts all files', async t => {
  const dir = temp(t), bin = generationFake(dir);
  const previous = { token: process.env.CLAUDE_CODE_OAUTH_TOKEN, secret: process.env.FOO_SECRET };
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-test-token-value'; process.env.FOO_SECRET = 'do-not-pass';
  t.after(() => {
    for (const [k, v] of [['CLAUDE_CODE_OAUTH_TOKEN', previous.token], ['FOO_SECRET', previous.secret]])
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
  for (const passAuth of [false, true]) {
    const out = join(dir, String(passAuth));
    const trial = await generatePage({ caseId: 'dev-2', out, claudeBin: bin, confirmSpend: true, passAuth });
    assert.equal(trial.status, 'ok', trial.error);
    assert.equal(trial.buildCheck, 'ok');
    assert.match(trial.pageId, /^[0-9a-f]{12}$/);
    assert.equal(trial.skillTreeSha, git(root, 'rev-parse', 'HEAD:skills/human-review'));
    assert.equal(trial.skillSha256, hash(git(root, 'show', 'HEAD:skills/human-review/SKILL.md') + '\n'));
    const observation = JSON.parse(readFileSync(join(out, 'repo/.human-review/observation.json')));
    assert.equal(observation.prompt, '/human-review main..feature/token-normalization\nDo not open a browser.');
    assert.equal(observation.secret, undefined);
    assert.equal(observation.auth, passAuth ? '[redacted]' : null);
    assert(!observation.skill.startsWith(join(out, 'repo')));
    assert(!existsSync(join(out, 'repo/keys')));
    assert.equal(git(join(out, 'repo'), 'status', '--porcelain').replace(/\?\? \.human-review\//g, '').trim(), '');
    for (const file of allFiles(out)) assert(!readFileSync(file).includes(Buffer.from('oauth-test-token-value')), file);
    await assert.rejects(generatePage({ caseId: 'dev-2', out, claudeBin: bin, confirmSpend: true }), /must not exist/);
  }
});

test('missing or duplicate recap becomes a trial error', async t => {
  const dir = temp(t);
  for (const variant of ['missing', 'duplicate']) {
    const bins = join(dir, variant); mkdirSync(bins);
    const trial = await generatePage({ caseId: 'dev-1', out: join(dir, variant + '-out'),
      claudeBin: generationFake(bins, { [variant]: true }), confirmSpend: true });
    assert.equal(trial.status, 'error'); assert.match(trial.error, /exactly one/);
  }
});

test('prose extraction is deterministic and excludes git/code/structural content', () => {
  const recap = JSON.parse(readFileSync(resolve(root, '../../skills/human-review/references/example-recap.json')));
  const a = pageText(recap); assert.deepEqual(a, pageText(recap));
  assert.equal(a.text, a.sentences.map(s => s.text).join('\n'));
  assert(a.text.includes('Never'));
  assert(a.text.includes('Only owners'));
  assert(a.text.includes('The HTTP routes.'));
  assert(!a.text.includes('display:flex'));
  assert(!a.text.includes('header-compare'));
  const minimal = pageText({ title: 'Useful title', hunks: ['GIT_SENTINEL'], diff: { text: 'GIT_SENTINEL' },
    focus: [{ title: 'Start', why: 'Explain.', ref: 'REF_SENTINEL' }],
    sections: [{ blocks: [{ type: 'code', file: 'FILE_SENTINEL', code: 'CODE_SENTINEL', summary: 'Useful summary.',
      annotations: [{ text: 'Useful annotation.', line: 99 }] },
    { type: 'markdown', md: 'Prose.\n```js\nCODE_SENTINEL\n```\nMore prose.' }] }],
    files: { FILE_SENTINEL: { review: 'careful', note: 'Useful note.' } } });
  for (const s of ['GIT_SENTINEL', 'CODE_SENTINEL', 'FILE_SENTINEL', 'REF_SENTINEL']) assert(!minimal.text.includes(s));
  assert(minimal.text.includes('Useful annotation.'));
  assert.deepEqual(splitSentences('One. Two? Three! src/foo.mjs stays. `x. Y` stays. 1.25 is decimal.'),
    ['One.', 'Two?', 'Three!', 'src/foo.mjs stays.', '`x. Y` stays.', '1.25 is decimal.']);
});

test('judge payload omits metadata and neutralizes case-bearing ids', () => {
  const payload = JSON.stringify(judgePayload(page, key));
  for (const s of ['dev-x', 'SECRET_BRANCH', 'SECRET_MAINTAINER', 'SECRET_EVIDENCE']) assert(!payload.includes(s));
  assert(payload.includes('SECRET_POINT'));
});

test('missing point retries then errors, hard cap prevents extra launches', async t => {
  const dir = temp(t), count = join(dir, 'count');
  const bin = judgeFake(dir, 'claude', { points: [], traps: [] },
    `fs.appendFileSync(${JSON.stringify(count)}, 'x');`);
  const opts = { page, key, runtime: 'claude', bin, cacheDir: join(dir, 'cache'), confirmSpend: true };
  const result = await judgePage(opts);
  assert.equal(result.status, 'error'); assert.equal(result.modelCalls, 2);
  assert.equal(readFileSync(count, 'utf8'), 'xx');
  const cached = await judgePage({ ...opts, confirmSpend: false });
  assert.equal(cached.modelCalls, 0);
  await assert.rejects(judgePage({ ...opts, run: 2, budget: callBudget(1) }), /max-calls/);
  assert.equal(readFileSync(count, 'utf8'), 'xxx');
});

test('two vendor consensus, repetition majority, caching and spend refusal', async t => {
  const dir = temp(t), count = join(dir, 'count');
  const extra = `fs.appendFileSync(${JSON.stringify(count)}, 'x'); if(process.env.FOO_SECRET) throw Error('leaked');`;
  const claudeBin = judgeFake(dir, 'claude', judgment('covered', true), extra);
  const codexBin = judgeFake(dir, 'codex', judgment('partial', false), extra);
  const opts = { page, key, claudeBin, codexBin, cacheDir: join(dir, 'cache') };
  await assert.rejects(scorePage(opts), /confirm-spend/);
  const scored = await scorePage({ ...opts, confirmSpend: true });
  assert.equal(scored.consensus.covered, 0); assert.equal(scored.consensus.disagree, 1);
  assert.equal(scored.consensus.falseClaims, 0); assert.equal(readFileSync(count, 'utf8'), 'xx');
  const cached = await scorePage(opts);
  assert(cached.judgments.every(j => j.modelCalls === 0)); assert.equal(readFileSync(count, 'utf8'), 'xx');
  const judged = (runtime, label, status = 'ok') => ({ target: { runtime }, status,
    value: { points: [{ id: key.points[0].id, rationale: '', label }], traps: [{ id: key.false_claim_traps[0].id, rationale: '', asserted: true }] } });
  const majority = consensus([judged('claude', 'covered'), judged('claude', 'covered'), judged('claude', 'absent'),
    judged('codex', 'covered'), judged('codex', 'covered'), judged('codex', 'partial')], key);
  assert.equal(majority.covered, 1);
  const error = consensus([judged('claude', 'covered'), judged('codex', null, 'error')], key);
  assert.equal(error.covered, 0); assert.equal(error.absent, 0); assert.equal(error.pointErrors, 1); assert.equal(error.eligiblePoints, 0);
  assert.match(quietLine({caseId: 'dev-x', consensus: error}), /covered=0\/0/);
  assert(!quietLine(scored).includes('SECRET_POINT'));
  const p = join(dir, 'page.json'), k = join(dir, 'key.json');
  writeFileSync(p, JSON.stringify(page)); writeFileSync(k, JSON.stringify(key));
  const cli = spawnSync(process.execPath, [join(root, 'judge-coverage.mjs'), p, k, '--quiet', '--cache-dir', opts.cacheDir,
    '--out', join(dir, 'coverage.json')], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert(!cli.stdout.includes('SECRET_POINT')); assert.equal(cli.stdout.trim().split('\n').length, 1);
});

test('judge argv uses ephemeral no-tools mode and omits default effort/model', () => {
  const codex = judgeArgv({ runtime: 'codex', cwd: '/tmp', schemaPath: '/schema' });
  assert(codex.includes('--ephemeral')); assert(!codex.includes('-m')); assert(!codex.some(s => s.includes('model_reasoning_effort')));
  const claude = judgeArgv({ runtime: 'claude', model: 'sonnet', effort: 'default', schema: {} });
  assert(claude.includes('--no-session-persistence')); assert(!claude.includes('--effort'));
  assert.equal(claude[claude.indexOf('--tools') + 1], '');
  const gen = generationArgv({ repo: '/repo', skill: '/skill', maxUsd: 1, budgetSupported: true });
  assert(gen.includes('--max-budget-usd')); assert(!gen.includes('WebSearch,WebFetch'));
});

test('strip preserves all remaining sentence bytes and ids; empty extraction is not-strippable', async t => {
  const dir = temp(t), bin = judgeFake(dir, 'codex', { sentenceIds: ['s1'] });
  const opts = { page, point: key.points[0], codexBin: bin, claudeBin: judgeFake(dir, 'claude-strip', { sentenceIds: [] }), cacheDir: join(dir, 'cache'), confirmSpend: true };
  const stripped = await stripPoint(opts);
  assert.deepEqual(stripped.page, { text: 'Other behavior stays.', sentences: [page.sentences[1]] });
  assert.equal((await stripPoint({ ...opts, confirmSpend: false })).modelCalls, 0);
  assert.throws(() => stripSentences(page, ['s9']), /invalid/);
  assert.throws(() => stripSentences(page, ['s1', 's1']), /invalid/);
  const empty = judgeFake(dir, 'codex-empty', { sentenceIds: [] });
  assert.equal((await stripPoint({ ...opts, codexBin: empty, run: 2 })).status, 'not-strippable');
});

test('calibration enforces dev and exact two-of-three thresholds', async t => {
  assert(calibrationPass(['covered', 'covered', 'partial'], ['absent', 'absent', 'covered']));
  assert(!calibrationPass(['covered', 'partial', 'partial'], ['absent', 'absent', 'absent']));
  assert(!calibrationPass(['covered', 'covered', 'covered'], ['absent', 'partial', 'partial']));
  await assert.rejects(calibrate([{ key: { ...key, split: 'held-out' } }]), /dev/);
  const dir = temp(t);
  const body = runtime => `
    let input=''; process.stdin.on('data', b=>input+=b); process.stdin.on('end',()=>{
      const payload=JSON.parse(input.slice(input.indexOf('\\n\\n')+2));
      let value;
      if (payload.point) value={sentenceIds:['s1']};
      else value={points:[{id:'P1',rationale:'s1',label: payload.page.some(s=>s.id==='s1')?'covered':'absent'}],
        traps:[{id:'T1',rationale:'none',asserted:false}]};
      console.log(JSON.stringify(${runtime === 'claude' ? "{type:'result',structured_output:value}" :
        "{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(value)}}"}));
    });`;
  const claudeBin = fake(dir, 'claude', body('claude')), codexBin = fake(dir, 'codex', body('codex'));
  const result = await calibrate([{ trial: { pageId: 'a', status: 'ok' }, key, page,
    coverage: { consensus: { points: [{ id: key.points[0].id, label: 'covered' }] } } }],
  { claudeBin, codexBin, cacheDir: join(dir, 'cache'), confirmSpend: true });
  for (const j of Object.values(result.judges)) { assert.equal(j.tested, 1); assert.equal(j.passed, 1); assert.equal(j.failed.length, 0); }
});

test('reports separate splits, retain errors and compute A/A coverage rate spread; dev sample hides answers', () => {
  const make = (split, id, covered) => ({
    trial: { caseId: id, split, pageId: id + covered, status: 'ok', modelRequested: 'same', total_cost_usd: 0.1 },
    coverage: { consensus: { covered, points: [{ id: key.points[0].id, label: covered ? 'covered' : 'absent',
      labels: covered ? ['covered', 'covered'] : ['absent', 'absent'] }], partial: 0, absent: 1 - covered, falseClaims: 0, errors: 0, pointErrors: 0 }, cost: 0.02 },
    page, key: { ...key, split },
  });
  const pages = [make('dev', 'dev-x', 1), make('dev', 'dev-x', 0), make('held-out', 'sealed', 0)];
  const r = report(pages); assert.deepEqual(Object.keys(r), ['dev', 'held-out']);
  assert.equal(r.dev.cases[0].covered, 1); assert.equal(r['held-out'].cases[0].covered, 0);
  assert.equal(r.dev.aaMean, 1); assert.equal(r['held-out'].aaMean, null);
  assert.throws(() => handSample(pages), /dev/);
  const sampled = handSample(pages.slice(0, 2), { seed: 'fixed' });
  assert.deepEqual(sampled, handSample(pages.slice(0, 2), { seed: 'fixed' }));
  assert.equal(sampled.rows.length, 2); assert.equal(sampled.rows[0].matt_label, '');
  assert(!sampleCSV(sampled.rows).includes('"covered"'));
  assert.equal(sampled.answers.length, 2);
});

test('generation enforces reported budget even if executable lacks the budget flag', async t => {
  const dir = temp(t), bin = generationFake(dir);
  writeFileSync(bin, readFileSync(bin, 'utf8').replace("console.log('--max-budget-usd')", "console.log('fake help')"), { mode: 0o755 });
  const trial = await generatePage({ caseId: 'dev-1', out: join(dir, 'out'), claudeBin: bin,
    confirmSpend: true, maxUsd: 0.001 });
  assert.equal(trial.status, 'error'); assert.match(trial.error, /budget/);
  const argv = generationArgv({ repo: '/repo', skill: '/skill', maxUsd: 1, budgetSupported: false });
  assert(!argv.includes('--max-budget-usd'));
});

test('quiet report CLI prints count lines, keeps dev and held-out separate in JSON', t => {
  const dir = temp(t), runs = join(dir, 'runs'); mkdirSync(runs);
  for (const split of ['dev', 'held-out']) {
    const folder = join(runs, split); mkdirSync(folder);
    writeFileSync(join(folder, 'trial.json'), JSON.stringify({ caseId: split + '-case', split, pageId: split,
      status: 'ok', modelRequested: 'fake', total_cost_usd: 0 }));
    const judgments = ['claude', 'codex'].map(runtime => ({ target: { runtime }, status: 'ok', value: {
      points: [{ id: key.points[0].id, rationale: 'SECRET_POINT must never print', label: 'covered' }],
      traps: [{ id: key.false_claim_traps[0].id, rationale: '', asserted: false }],
    } }));
    writeFileSync(join(folder, 'coverage.json'), JSON.stringify({ caseId: split + '-case', split,
      judgments, consensus: consensus(judgments, key), cost: 0 }));
  }
  const out = join(dir, 'report.json');
  const result = spawnSync(process.execPath, [join(root, 'report.mjs'), runs, '--quiet', '--out', out], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert(!result.stdout.includes('SECRET_POINT'));
  assert.equal(result.stdout.trim().split('\n').length, 2);
  const reportFile = JSON.parse(readFileSync(out));
  assert.deepEqual(Object.keys(reportFile), ['dev', 'held-out']);
  assert.equal(reportFile.dev.cases[0].pages, 1);
  assert.equal(reportFile['held-out'].cases[0].pages, 1);
});


test('consensus distinguishes disagreement from agreeing partial and reports counts', () => {
  for (const [a, b, expected] of [['covered', 'absent', 'disagree'], ['covered', 'partial', 'disagree'], ['partial', 'partial', 'partial']]) {
    const judgments = [a, b].map((label, i) => ({ status: 'ok', target: { runtime: ['claude', 'codex'][i] },
      value: { points: [{ id: key.points[0].id, label }], traps: [{ id: key.false_claim_traps[0].id, asserted: false }] } }));
    const c = consensus(judgments, key);
    assert.equal(c.points[0].label, expected); assert.deepEqual(c.points[0].labels, [a, b]);
    assert.equal(c.eligiblePoints, 1); assert.equal(c[expected], 1);
    const r = report([{ trial: { caseId: key.case_id, split: 'dev' }, coverage: { consensus: c } }]);
    assert.equal(r.dev.pages[0][expected], 1); assert.equal(r.dev.cases[0][expected], 1);
    assert.match(quietLine({ caseId: key.case_id, consensus: c }), /absent=0 disagree=/);
  }
});

test('auth uses real CODEX_HOME only on opt-in; Claude missing token fails before calls', async t => {
  const dir = temp(t), real = join(dir, 'real-codex'), previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = real;
  t.after(() => { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; });
  const bin = judgeFake(dir, 'codex-auth', judgment(), 'console.error(process.env.CODEX_HOME);');
  for (const passAuth of [false, true]) {
    const r = await judgePage({ page, key, runtime: 'codex', bin, passAuth, confirmSpend: true, cacheDir: join(dir, String(passAuth)) });
    const home = r.transcripts[0].stderr.trim();
    if (passAuth) assert.equal(home, real); else { assert.notEqual(home, real); assert.match(home, /codex_home$/); }
  }
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN; delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  t.after(() => { if (token !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = token; });
  const budget = callBudget(5);
  await assert.rejects(judgePage({ page, key, runtime: 'claude', passAuth: true, confirmSpend: true,
    cacheDir: join(dir, 'missing'), budget, bin: '/nonexistent' }), /CLAUDE_CODE_OAUTH_TOKEN not set \(run claude setup-token\)/);
  assert.equal(budget.used, 0);
  await assert.rejects(generatePage({ caseId: 'dev-1', out: join(dir, 'out'), passAuth: true, confirmSpend: true }), /CLAUDE_CODE_OAUTH_TOKEN not set/);
});

test('strip uses both vendor lists and their union, and either vendor error fails', async t => {
  const dir = temp(t), opts = { page, point: key.points[0], confirmSpend: true, cacheDir: join(dir, 'cache'),
    claudeBin: judgeFake(dir, 'claude-union', { sentenceIds: ['s1'] }),
    codexBin: judgeFake(dir, 'codex-union', { sentenceIds: ['s2'] }) };
  const r = await stripPoint(opts);
  assert.deepEqual(r.sentenceIds, { claude: ['s1'], codex: ['s2'] });
  assert.deepEqual(r.union, ['s1', 's2']); assert.equal(r.page.text, ''); assert.equal(r.modelCalls, 2);
  const bad = judgeFake(dir, 'codex-bad', { sentenceIds: ['s999'] });
  assert.equal((await stripPoint({ ...opts, codexBin: bad, run: 2 })).status, 'error');
});

test('calibration selects first ok pages, preflights cap, and shares scoring run 1–3 caches', async t => {
  const dir = temp(t), entry = { dir: 'b', trial: { pageId: 'b', status: 'ok' }, key, page,
    coverage: { consensus: { points: [{ id: key.points[0].id, label: 'covered' }] } } };
  assert.deepEqual(selectPages([entry, { ...entry, dir: 'a' }, { ...entry, dir: '0', trial: { status: 'error' } }]).map(p => p.dir), ['a']);
  assert.equal(selectPages([entry, { ...entry, dir: 'a' }], 2).length, 2);
  const opts = { cacheDir: join(dir, 'cache'), confirmSpend: true,
    claudeBin: judgeFake(dir, 'claude-cache', judgment()), codexBin: judgeFake(dir, 'codex-cache', judgment()) };
  const budget = callBudget(0);
  await assert.rejects(calibrate([entry], { ...opts, budget }), /exceed --max-calls/);
  assert.equal(budget.used, 0); assert.equal(existsSync(opts.cacheDir), false);
  const before = plannedCalls([entry], opts);
  await scorePage({ ...opts, page, key, runs: 3 });
  assert.equal(plannedCalls([entry], opts), before - 12);
  const stripOpts = { ...opts, claudeBin: judgeFake(dir, 'claude-strip-cache', { sentenceIds: ['s1'] }),
    codexBin: judgeFake(dir, 'codex-strip-cache', { sentenceIds: ['s1'] }) };
  await stripPoint({ ...stripOpts, page, point: key.points[0] });
  const result = await calibrate([entry], opts);
  for (const runtime of ['claude', 'codex']) assert(result.points[0].judgments[runtime + ':original'].every(j => j.reused));
  assert.equal(plannedCalls([entry], opts), 0);
});

test('model CLIs require explicit cache directory', () => {
  for (const script of ['judge-coverage', 'strip-point', 'calibrate']) {
    const r = spawnSync(process.execPath, [join(root, script + '.mjs')], { encoding: 'utf8' });
    assert.equal(r.status, 1); assert.match(r.stderr, /--cache-dir required/);
  }
});

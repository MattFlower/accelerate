import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  AUTHOR, CHECKS, FINDER_FRAMING, FINDING_RULES, ORIGINAL_CHECKS, ORIGINAL_SUMMARY_CLAUSE,
  ORIGINAL_VERDICT_RULE, OUTPUT_CONTRACT, RUBRIC, VERIFIER_CLAUSE, buildPrompt, changeInstructions,
  empty, fence, opener, quoteRequest, sections,
} from '../build-prompt.mjs';
import { buildCaseRepo, git } from '../case-repo.mjs';

const sourceRepo = process.env.QR_EVAL_LIMITLESS;
const pinnedOnly = { skip: !sourceRepo && 'Set QR_EVAL_LIMITLESS to verify against the pinned Limitless source and case snapshots' };
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const pinnedPrompts = () => execFileSync('git', ['-C', sourceRepo, 'show', 'e42003a:src/pipeline/prompts.ts'], { encoding: 'utf8' });
const { cases } = JSON.parse(read('../cases.json'));
const audits = JSON.parse(read('../limitless-audit.json'));

function scratch(t) {
  const path = mkdtempSync(join(tmpdir(), 'qr-prompt-test-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test('ported template strings are verbatim at e42003a', pinnedOnly, () => {
  const source = pinnedPrompts();
  for (const fragment of [
    AUTHOR, FINDER_FRAMING, VERIFIER_CLAUSE, ORIGINAL_CHECKS, ORIGINAL_SUMMARY_CLAUSE,
    ORIGINAL_VERDICT_RULE, RUBRIC, FINDING_RULES, ...Object.values(sections), ...Object.values(empty),
    changeInstructions.toString().split('\n').at(-1).trim().slice(1, -1),
    ...[fence, quoteRequest].map(fn => fn.toString().split('\n').slice(1, -1).join('\n')),
  ]) assert.ok(source.includes(fragment), fragment);
  assert.ok(source.includes('You are ${input.finder.startsWith("adversarial") ? "an adversarial" : "a"} code reviewer.'));
});

function referencePrompt(source) {
  const review = source.slice(source.indexOf('export function reviewPrompt('), source.indexOf('const CONSEQUENCE_SEVERITY'));
  const helpers = [
    source.slice(source.indexOf('function fence('), source.indexOf('export function triagePrompt(')),
    'const redactGateData = input => input;',
    source.slice(source.indexOf('function gateTable('), source.indexOf('const PATCH_LIMIT')),
    source.slice(source.indexOf('const THOROUGH'), source.indexOf('export function reviewPrompt(')),
  ];
  return new Function(stripTypeScriptTypes(helpers.join('\n') + '\n' + review.replace('export function', 'function')) +
    '\nreturn reviewPrompt;')();
}

function goldText(value) {
  if (typeof value === 'string') return value.length >= 12 ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(goldText);
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, field]) =>
      ['file', 'path', 'filePath', 'line', 'lines', 'startLine', 'endLine'].includes(key) ? [] : goldText(field));
  }
  return [];
}

function assertPinnedRendering(t, entry, reference) {
  const caseRepo = join(scratch(t), 'case');
  const { base, head } = buildCaseRepo({ sourceRepo, base: entry.base, head: entry.head, dest: caseRepo });
  const options = { caseRepo, base, head };
  const keep = buildPrompt(entry, options);
  const stat = git(caseRepo, 'diff', '--stat', `${base}..${head}`);
  const expected = reference({
    ...entry.input, baseSha: base, stat, finder: 'adversarial', audit: audits[entry.id].audit,
  }).replace(ORIGINAL_SUMMARY_CLAUSE, '').replace(ORIGINAL_VERDICT_RULE, OUTPUT_CONTRACT);
  assert.equal(keep, expected, entry.id);
  return { base, keep, options };
}

test('two real cases match pinned rendering, with no defect prose', pinnedOnly, t => {
  const reference = referencePrompt(pinnedPrompts());
  // review-178 exercises audit flags, review-138 exercises the empty audit branch.
  assert.ok(audits['review-178'].audit.length > 0);
  assert.equal(audits['review-138'].audit.length, 0);
  for (const id of ['review-178', 'review-138']) {
    const entry = cases.find(item => item.id === id);
    assert.equal(entry.kind, 'real');
    const { base, keep, options } = assertPinnedRendering(t, entry, reference);
    assert.ok(keep.includes(quoteRequest(entry.input.prompt)));
    assert.ok(keep.includes(`Base commit: ${base}.`));
    assert.ok(keep.includes(`\`git diff ${base}..HEAD\`, \`git log ${base}..HEAD\``));
    const texts = goldText([entry.gold, entry.defects]);
    assert.ok(texts.length > 0);
    for (const gold of texts) {
      assert.ok(!keep.includes(gold), `${id} leaked a gold value`);
      assert.ok(!keep.includes(quoteRequest(gold)), `${id} leaked a quoted gold value`);
    }
    assert.equal(buildPrompt(entry, { ...options, verifierClause: 'drop' }), keep.replace(VERIFIER_CLAUSE, ''));
    assert.equal(buildPrompt(entry, { ...options, omitRequest: true }), keep.replace(quoteRequest(entry.input.prompt), '> '));
  }
});

test('all exported cases match pinned rendering', {
  skip: pinnedOnly.skip || (process.env.QR_EVAL_FULL !== '1' && 'Set QR_EVAL_FULL=1 to compare every exported case'),
}, async t => {
  const reference = referencePrompt(pinnedPrompts());
  for (const entry of cases) {
    await t.test(entry.id, subtest => assertPinnedRendering(subtest, entry, reference));
  }
});

test('the skill shares the builder instructions byte for byte', () => {
  const skill = read('../../../skills/quality-review/SKILL.md');
  const body = skill.split('\n---\n')[1].trimEnd();
  assert.equal(body, '\n' + [
    opener('drop'),
    sections.change + '\n' + changeInstructions({ baseSha: '<base>' }, '<base>..<head>'),
    CHECKS,
    sections.rubric + '\n\n' + RUBRIC,
    FINDING_RULES,
    'This review judges code behaviour. When the change edits instruction files (SKILL.md, AGENTS.md, CLAUDE.md and similar), it does not vouch that their prose is complete, current or warranted.',
    OUTPUT_CONTRACT,
  ].join('\n\n'));
});

test('trial builder writes the omitted-request prompt in dry-run and honors call refusals', pinnedOnly, t => {
  const out = join(scratch(t), 'out');
  const args = [fileURLToPath(new URL('../run-trials.mjs', import.meta.url)),
    '--cases', fileURLToPath(new URL('../cases.json', import.meta.url)), '--limitless', sourceRepo,
    '--runtime', 'codex', '--model', 'fake', '--effort', 'high', '--prompt-builder', 'limitless-adversarial',
    '--omit-request', '--k', '2', '--out', out, '--case', 'review-134'];
  const run = (...flags) => spawnSync(process.execPath, [...args, ...flags], { encoding: 'utf8' });
  const noConfirm = run('--max-calls', '2');
  assert.equal(noConfirm.status, 1);
  assert.match(noConfirm.stderr, /--confirm-spend required/);
  const noCap = run('--confirm-spend');
  assert.equal(noCap.status, 1);
  assert.match(noCap.stderr, /--max-calls/);
  const overCap = run('--dry-run', '--max-calls', '1');
  assert.equal(overCap.status, 1);
  assert.match(overCap.stderr, /--max-calls/);
  assert.equal(existsSync(out), false);

  const dry = run('--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  const plans = dry.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  assert.equal(plans.length, 2);
  for (const plan of plans) {
    assert.equal(plan.prompt, '<elided stdin>');
    assert.equal(plan.promptBuilder, 'limitless-adversarial');
    assert.equal(plan.verifierClause, 'keep');
    assert.equal(plan.promptSourcePin, 'e42003a');
    assert.equal(plan.omitRequest, true);
  }
  assert.deepEqual(readdirSync(out), ['review-134.prompt.txt']);
  const prompt = readFileSync(join(out, 'review-134.prompt.txt'), 'utf8');
  assert.match(prompt, /# Original request\n> \n\n# Specification/);
  assert.ok(!prompt.includes(quoteRequest(cases.find(c => c.id === 'review-134').input.prompt)));

  const fakeBinDir = scratch(t);
  writeFileSync(join(fakeBinDir, 'codex'), `#!${process.execPath}
import { createHash } from 'node:crypto';
const hash = createHash('sha256');
for await (const chunk of process.stdin) hash.update(chunk);
const findings = [];
console.log(JSON.stringify({ type: 'item.completed', item: {
  type: 'agent_message', text: JSON.stringify({ findings })
} }));
console.error(hash.digest('hex'));
`, { mode: 0o755 });
  const fake = spawnSync(process.execPath, [...args, '--confirm-spend', '--max-calls', '2', '--verifier-clause', 'drop'], {
    encoding: 'utf8', env: { ...process.env, PATH: [fakeBinDir, process.env.PATH].join(delimiter) },
  });
  assert.equal(fake.status, 0, fake.stderr);
  const built = readFileSync(join(out, 'review-134.prompt.txt'));
  const hash = createHash('sha256').update(built).digest('hex');
  assert.equal(built.toString(), prompt.replace(VERIFIER_CLAUSE, ''));
  const records = readFileSync(join(out, 'trials.jsonl'), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  assert.equal(records.length, 2);
  for (const record of records) {
    assert.equal(record.status, 'ok', record.error);
    assert.equal(record.promptBuilder, 'limitless-adversarial');
    assert.equal(record.verifierClause, 'drop');
    assert.equal(record.promptSourcePin, 'e42003a');
    assert.equal(record.omitRequest, true);
    assert.equal(record.promptSha256, hash);
    const prefix = join(out, `review-134.codex.s${record.sample}`);
    assert.deepEqual(JSON.parse(readFileSync(prefix + '.json', 'utf8')), record);
    assert.equal(readFileSync(prefix + '.stderr', 'utf8').trimEnd(), hash);
  }
});

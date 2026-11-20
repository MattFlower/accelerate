import { readFileSync } from 'node:fs';
import { git } from './case-repo.mjs';

export const PROMPT_BUILDER = 'limitless-adversarial';
export const PROMPT_SOURCE_PIN = 'e42003a';
export const DEFAULT_VERIFIER_CLAUSE = 'keep';
export const VERIFIER_CLAUSE = '; a separate step verifies each finding';
export const OUTPUT_CONTRACT = 'Return JSON matching findings.schema.json, with a single top-level findings array.';
const DROPPED_PARAGRAPH = "Also return `dropped`: every candidate problem you investigated and ruled out, each with `why_dropped` and `evidence`. `evidence` is the `path:line` locations that show it cannot happen; write an empty string if you have no code proof. Return an empty list if you ruled nothing out.";
export const ORIGINAL_SUMMARY_CLAUSE = '; mention them in your summary as checks you could not run';
export const ORIGINAL_VERDICT_RULE = "Return your assessment in verdict; the pipeline derives its decision from findings.";

export const REVIEWER_ROLE = 'You are an adversarial code reviewer.';
export const AUTHOR = "A different AI model implemented the change below.";
export const FINDER_FRAMING =
  "Assume the change can fail, and find out how. Trace bad and boundary inputs, retries, partial failure, ordering, restarts, and version skew between old and new code or data. Give no credit for intent: judge what the code does, not what its comments, names or commit messages say. Report every issue you believe is real, with your confidence; a separate step verifies each finding.";
export const opener = (verifierClause) =>
  `${REVIEWER_ROLE} ${AUTHOR} ${verifierClause === 'drop' ? FINDER_FRAMING.replace(VERIFIER_CLAUSE, '') : FINDER_FRAMING}`;

export const changeInstructions = (input, range) =>
  `Base commit: ${input.baseSha}. Inspect it with \`git diff ${range}\`, \`git log ${input.externalChange ? "--right-only " : ""}${range}\`, and by reading the surrounding code.`;

export const ORIGINAL_CHECKS = `Run targeted tests and commands for the behavior you are checking. A targeted check that fails with an assertion failure or a wrong result is a finding: include the exact command and its output, and set severity by the consequence of the defect. Errors that come from your own sandbox (permission denied, read-only filesystem, no network, port unavailable, missing tool) are not findings; mention them in your summary as checks you could not run.`;
export const CHECKS = ORIGINAL_CHECKS.replace(ORIGINAL_SUMMARY_CLAUSE, '');
export const RUBRIC = `- Correctness: bugs, edge cases, error handling, races, off-by-one errors.
- Completeness: every requirement and acceptance criterion is actually implemented.
- Tests: new behavior is genuinely exercised; nothing was weakened, skipped, or special-cased to pass.
- Security: injection, secrets, unsafe handling of external input.
- Scope: unrelated changes or needless churn. Code mandated by the specification but unnecessary to the request may be flagged as unnecessary scope (minor or nit); specification text alone is not a reason to keep it.
- Maintainability: clarity and consistency with the codebase.`;
export const FINDING_RULES = `Severity: blocker = must fix (bug, unmet requirement, security issue, test gaming); major = should fix before merge; minor/nit = optional polish.
Every finding must name a concrete defect in the change: what is wrong, where, and why. A request for verification you could not perform yourself (rendering in a real browser, layout at viewport widths, behaviour against live services) is not a defect: report it as minor at most, never blocker or major, and say what you could and could not check.
Do not modify files. You may run read-only commands and targeted tests. Create temporary fixtures and redirect supported build/test outputs only under TMPDIR (also TMP and TEMP); the worktree is read-only.
Explicitly mark security findings with security: true (otherwise false). For every finding also set failure_scenario (the concrete inputs or state that produce the wrong output or crash), category (one of correctness, security, reliability, data, concurrency, compatibility, test-gap, cleanup, conventions), confidence (0 to 1: how sure you are the defect is real) and introduced_by_diff (true if the change under review introduced it, false if it predates the change).`;

export const sections = {
  request: '# Original request',
  spec: '# Specification',
  change: '# Change under review',
  report: "# Implementer's own report (treat claims as unverified)",
  checks: '# Automated check results',
  audit: '# Automated audit flags — scrutinize these',
  rubric: '# Rubric',
};

export const empty = {
  spec: '(no separate spec; judge against the request)',
  diff: '(empty diff)',
  report: '(none)',
  gates: '(no automated checks)',
  audit: '(none)',
};

export function fence(text) {
  const ticks = text.includes("```") ? "~~~~" : "```";
  return `${ticks}\n${text}\n${ticks}`;
}

export function quoteRequest(prompt) {
  return prompt
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
}

const audits = JSON.parse(readFileSync(new URL('./limitless-audit.json', import.meta.url), 'utf8'));

export function buildPrompt(entry, { caseRepo, base, head, verifierClause = DEFAULT_VERIFIER_CLAUSE, omitRequest = false, droppedField = 'off' }) {
  if (!['on', 'off'].includes(droppedField)) throw new Error('Invalid droppedField');
  if (!['keep', 'drop'].includes(verifierClause)) throw new Error('Invalid verifierClause');
  const { prompt, spec, implementerReport, gates } = entry.input;
  if (spec !== null || implementerReport !== '' || gates.length !== 0)
    throw new Error('Expected the exported review input with empty spec, implementer report, and gates');
  if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(base) || !/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(head))
    throw new Error('Expected snapshot SHAs');
  const pinned = Object.hasOwn(audits, entry.id) && audits[entry.id];
  if (!pinned || git(caseRepo, 'rev-parse', base + '^{tree}') !== pinned.baseTree ||
      git(caseRepo, 'rev-parse', head + '^{tree}') !== pinned.headTree ||
      git(caseRepo, 'rev-parse', 'HEAD') !== head)
    throw new Error(`Snapshots do not match the pinned audit for ${entry.id}`);
  const range = `${base}..HEAD`;
  const emptyTree = git(caseRepo, 'hash-object', '-t', 'tree', '/dev/null');
  const stat = git(caseRepo, `--attr-source=${emptyTree}`, '-c', 'core.bigFileThreshold=9223372036854775807',
    'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', '--stat', range);
  const warnings = pinned.audit.length
    ? pinned.audit.map((f) => `- [${f.rule}/${f.severity}] ${f.file ? `${f.file}: ` : ""}${f.detail}`).join("\n")
    : empty.audit;
  const outputContract = droppedField === 'on'
    ? OUTPUT_CONTRACT.replace('findings.schema.json', 'findings-dropped.schema.json') + '\n\n' + DROPPED_PARAGRAPH
    : OUTPUT_CONTRACT;
  return `${opener(verifierClause)}

${sections.request}
${quoteRequest(omitRequest ? '' : prompt)}

${sections.spec}
${empty.spec}

${sections.change}
${changeInstructions({ baseSha: base }, range)}
${fence(stat.trim() || empty.diff)}


${sections.report}
${fence(empty.report)}

${sections.checks}
${empty.gates}
${CHECKS}

${sections.audit}
${warnings}

${sections.rubric}

${RUBRIC}

${FINDING_RULES}
${outputContract}`;
}

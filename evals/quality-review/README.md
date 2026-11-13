# Quality-review eval — rounds 1 and 2

Case preparation for the planned quality-review skill (backlog item A1).
Round 1 makes no model calls, uses Node 25 built-ins only, and requires no
network access. The source clone is read-only; missing pins are errors, never
an invitation to fetch.

`export-cases.mjs` reads the dataset at a git commit, selects exactly real
`escapes-dev` cases and clean `dev` cases, sorts by id, and copies defect
fields verbatim. Heldout splits are excluded; any forced selection of a
`heldout` or `escapes-heldout` case throws before writing an export.
The committed export contains 51 real cases, 80 defects (all required), and
16 clean cases.

From the repository root, re-export with:

```sh
node evals/quality-review/export-cases.mjs \
  --limitless /path/to/limitless --commit e42003a \
  --out evals/quality-review/cases.json
```

`buildCaseRepo({sourceRepo, base, head, dest, stripPaths: ['evals/']})`
requires a nonexistent destination and returns `{base, head}` snapshot SHAs.
It builds trees through a temporary index, removes the specified literal paths
from both trees, creates fixed-identity commits, and pushes only those commits
into a fresh standalone repo. It checks out a detached head, deletes refs,
expires reflogs, prunes objects, and cleans up staging even on failure.
The source's refs, objects, and working tree are never modified.

Check 5, `assertNoFuture(dest, [base, head])`, verifies exactly two reachable
commits, no alternates, no unreachable commits, and no extra commit objects in
the object database. A reviewer with full history could otherwise read the
later fix with `git log --all`, invalidating the eval.

Check 6, `isolatedEnv({scratchRoot, dest, passAuth: []})`, creates distinct empty
HOME, XDG_CONFIG_HOME, CODEX_HOME, CLAUDE_CONFIG_DIR, and TMPDIR directories.
It returns `{env, dirs, manifest}`. Only PATH, LANG, TERM, and explicitly named
auth variables pass through. The scratch HOME is checked for runner config
files. Pass `dest` to inventory case instructions; without it the manifest is
empty. `instructionManifest(dest)` records relative paths and SHA-256 hashes
for AGENTS.md, CLAUDE.md, and .claude/.codex/.agents directories and their contents,
skipping .git. Directory hashes represent empty bytes; symlink hashes represent
the link target text, without traversing links. Keep this manifest with future
run records: loading the runner's own CLAUDE.md or memory would make a reviewer
apply the wrong rules. Later reviewer processes must use the returned env.

Run tests:

```sh
node --test 'evals/quality-review/test/*.test.mjs'
QR_EVAL_LIMITLESS=/path/to/limitless node --test 'evals/quality-review/test/*.test.mjs'
```

Unit fixtures use the system temp directory (respecting TMPDIR). The integration
test is skipped unless QR_EVAL_LIMITLESS is set, and verifies the first exported
case with the same per-case function as the verification CLI.

Verify all exported cases sequentially, without model calls or network access:

```sh
node evals/quality-review/verify-cases.mjs --limitless /path/to/limitless
```

Optional flags: `--cases <file>` (default `evals/quality-review/cases.json`),
`--scratch <dir>` (default system temp directory), and `--out <file>` for JSON
per-case results. Each temporary case repo is deleted after verification.

## Not yet built

- A/A drift
- Paired PR-clustered bootstrap
- Stage-level scoring
- The A5 stub skill / reviewer prompt

## Round 2: invocation harness (fake runs only)

Round 2 adds instruction-change flags, a one-sample reviewer runner, schema
validation, transcript/provenance records, and a sequential trial CLI. Development
and verification make **no model calls and no network calls**. Tests only execute
Node fake CLI binaries. No reviewer prompt or skill is supplied yet.

`changedInstructionFiles(caseRepo)` compares `HEAD^` and `HEAD` in the prepared
two-commit repo with rename detection disabled. It returns `{status, path}` entries
for added, modified, and deleted AGENTS.md/CLAUDE.md at any depth and files under
.claude/, .codex/, or .agents/ at any depth. Instruction manifests now include
.agents/ too. These are flags only: checkout instructions remain at head.
`verify-cases.mjs --out <file>` now writes `{summary, cases}`; each case includes
`instructionFilesChanged`, and `summary.instructionFilesChanged` counts affected
cases. This changes the round-1 report's top-level array to an object.

`runReviewer(opts)` in `run-reviewer.mjs` checks history before any launch, sends
the prompt file's exact bytes on stdin, and runs in the case cwd with the isolated
environment. `expectedShas` are the **snapshot** SHAs from `buildCaseRepo`, recorded
as `base` and `head`; the optional `repo` option supplies the dataset repo identity
(the direct-call fallback is the absolute case repo path). The trial CLI passes
that identity. Each sample writes `<caseId>.<runtime>.s<sample>.jsonl`, `.stderr`,
and `.json`. Valid empty findings mean `ok`; failures retain `findings: null` and
an error string. The default timeout is 20 minutes; timeout kills the process group
and records `cancelled`. A failed preflight throws before launching or writing a
trial. Scratch config directories are fresh per sample; the CLI deletes its
case/scratch tree after the case, and direct callers own scratch cleanup.

The JSON schema ports the **finding object** from limitless `e42003a`
`src/pipeline/schemas.ts:116–153`, including all four v2 evidence fields. The
wrapper intentionally contains only `findings`, without limitless's verdict,
summary, or summary-length refinement. Confidence is clamped to [0,1] after type
validation, matching `schemas.ts:133–136`; integer lines have no invented minimum.
Unknown fields are rejected, as required by our strict output schema.

### Invocation reference and deliberate differences

All line references below are in the read-only limitless clone at `e42003a`.
`buildArgv` returns arguments excluding the executable; `bin` overrides it for
fake tests. `<schema-json>` is the exact contents of `findings.schema.json` encoded
as JSON; neither command includes prompt contents in argv.

```text
codex exec --json --skip-git-repo-check -C <caseRepo> -m <model>
  -c 'approval_policy="never"' -c 'model_reasoning_effort="<effort>"'
  --ignore-user-config --strict-config -s read-only
  -c orchestrator.mcp.enabled=false
  --disable apps --disable plugins --disable multi_agent --disable code_mode
  -c 'web_search="disabled"' --output-schema <absolute-schema-path> -

claude -p --output-format stream-json --verbose --model <model>
  --setting-sources '' --permission-mode dontAsk
  --tools Read,Grep,Glob,Bash
  --allowedTools Read Grep Glob 'Bash(git diff:*)' 'Bash(git log:*)'
    'Bash(git show:*)' 'Bash(git status:*)'
  --disallowedTools 'Bash(git diff --output:*)' 'Bash(git diff --output=*)'
    'Bash(git log --output:*)' 'Bash(git log --output=*)'
    'Bash(git show --output:*)' 'Bash(git show --output=*)'
  --effort <effort> --json-schema <schema-json>
```

| Arguments | Limitless reference | Difference |
| --- | --- | --- |
| Codex `exec --json --skip-git-repo-check -C <cwd> -m <model> -c approval_policy=...` | `src/harness/codex.ts:804–815` | None |
| Codex `-c model_reasoning_effort=...` | `codex.ts:817` | Always passed; eval requires effort |
| Codex `--ignore-user-config` | `codex.ts:819–820` | None |
| Codex `--strict-config` | `codex.ts:849` | None |
| Codex `-s read-only` | `codex.ts:867` | Uses the legacy read-only mode; tool-enabled limitless uses named filesystem profiles at 845–853 |
| Codex `-c orchestrator.mcp.enabled=false`, four `--disable` flags | `codex.ts:854–863` | None |
| Codex `-c web_search=...` | `codex.ts:865` | None |
| Codex `--output-schema` | `codex.ts:869–872` | Static schema file instead of per-log schema file |
| Codex trailing `-` (stdin) | `codex.ts:874–875` | No resume support |
| Claude `-p --output-format stream-json --verbose --model` | `src/harness/claude.ts:191–198` | None |
| Claude `--setting-sources '' --permission-mode dontAsk` | `claude.ts:201–206` | Always the readonly settings branch |
| Claude `--tools`, `--allowedTools`, `--disallowedTools` | `claude.ts:211–262,287–294` | Read/Grep/Glob plus Bash restricted to read-only git diff/log/show/status via permission rules; denies their file-writing `--output` forms. No OS sandbox ported |
| Claude `--effort` | `claude.ts:320–325` | Always passed; eval requires effort |
| Claude `--json-schema` | `claude.ts:328` | Uses findings-only schema |

Other deliberate omissions: no browser MCP, edit/no-tools modes, fast tier,
resume/session-id, ephemeral/private-session flags, auth/key helper injection,
additional directories, system-prompt append, telemetry or live sandbox probes.
Codex uses completed `agent_message` events for its final answer instead of a
last-message file (the referenced builder also uses the stream). Claude uses
`result.structured_output`, falling back to `result.result` JSON text; no result
event means an error. Scratch env auth is opt-in through direct `passAuth`; the
CLI currently passes no auth variables. Claude's `dontAsk` refuses commands outside
the allowed permission rules. Codex rules are
loaded from the case (no `--ignore-rules`, unlike `codex.ts:850`) so we can
inventory and later study instruction effects.

**Confinement limitation:** this round does not port limitless's outer OS sandbox,
reader profiles, denied-path controls or live confinement probes. The Codex legacy
read-only flag and Claude permission rules express read-only intent. Permission-rule
matching is prefix-based, leaving residual risk from additional arguments or shell
syntax; these rules are not OS confinement. The case repo is a disposable two-commit
copy and HOME is a scratch directory. Fake tests
cannot establish security confinement or real CLI compatibility. In particular,
CLI extensions or project config behavior must be audited before actual spend.
No real CLI has been invoked to verify these flags or event formats.

Tool counts deduplicate by tool name and call id. For Codex we count
`item.started`/`item.completed` items of type `command_execution` as `shell`,
`file_change` as `apply_patch`, `mcp_tool_call` as `server.tool`, and `web_search`
as `web_search`. Counting either phase preserves completed-only calls without
double counting paired events; limitless's parser at `codex.ts:135–177` counts
MCP/web search starts and file-change completions specifically. Claude counts
`assistant.message.content` blocks of type `tool_use` by their `name` (including
StructuredOutput if present), following `claude.ts:106–119`; user tool results
are not calls. Bash calls also increment a key for their first two whitespace-separated
command words (for example, `Bash:git diff`), alongside the plain `Bash` count,
so manipulation checks show which git commands ran. Raw `stream_event` deltas are not counted. Model reporting reads
Claude's `system/init.model` (`claude.ts:96–100`); Codex top-level `model`, if
present, is recorded but is not demonstrated by the reference parser, so normally
it is null. Real CLI event types and model fields remain unverified. Runtime
failure events are errors even on exit 0. Status semantics follow the distinction
in `src/evals/runner.ts:254,705–724`; this runner has no skipped state.

### Trial CLI

```sh
node evals/quality-review/run-trials.mjs \
  --cases evals/quality-review/cases.json --limitless /path/to/limitless \
  --runtime codex --model <model> --effort high --prompt /path/to/prompt \
  --k 2 --out /path/to/output --case review-078 --dry-run
```

Repeat `--case` to select several cases; otherwise all exported dev cases are
planned. Dry-run prepares local snapshots and prints one JSON plan per sample:
case id, sample, argv, an elided stdin label, and **environment keys only**.
Without `--dry-run`, the CLI requires `--confirm-spend` before doing any work.
That flag authorizes real calls; it was **never used in round-2 verification**.
Samples run sequentially and records append to `<out>/trials.jsonl`. Existing
per-sample artifacts are overwritten for the same case/runtime/sample, so use a
fresh output directory for each experiment. No implicit fetch or install occurs.

Round-2 local verification: all 67 exported cases passed. The report was written
to `/Users/mflower/.hermes/profiles/research-integrator/workspace/exp-qr-eval/verify-all-round2.json`.
Exactly one case is affected: `review-224`, with `M AGENTS.md`. No case repo or
source clone was changed by verification.

## Round 3: judging

`judge.mjs` ports the two-judge semantic matcher from limitless `e42003a`
`src/evals/judge.ts:22–169,200–275`. Prompt bytes and prompt-version hashing,
G1/F1 ids, strict validation, stable confidence-ordered de-duplication, required
gold selection, and caught/contested/underRated/agreement rules follow that source.
A caught gold requires both judges to map it to a blocker or major finding
(`src/pipeline/review.ts:188–189`). Agreement means both mapped or both null,
even when they map to different findings. Missing judgments exclude that trial's
golds from the denominator and increment `unjudged`; inspect this count.
Wilson intervals are the verbatim JS port of `src/evals/stats.ts:24–34`.

```sh
node evals/quality-review/judge-trials.mjs \
  --trials /path/to/trials --judge codex:MODEL:high --judge claude:MODEL:high \
  --cache /path/to/judgment-cache --out /path/to/report.json --dry-run
```

Exactly two judge flags are required. Omitted effort is recorded as `default`.
The `default` effort stays in target/cache records but emits no effort flag for either runtime.
Repeatable `--pass-auth NAME` on both CLIs validates auth names and uses their values consistently for redacted judging, cache lookup, metrics, and sampling.
Dry-run prints uncached unique request count, maximum attempts (two per request),
argv and environment keys only, then writes the metrics report from existing
cache entries. Actual uncached launches require `--confirm-spend`. Cache-only
scoring needs no spend flag. Failed or malformed responses retry once; successful
judgments never retry. Cache corruption is an error, never permission to re-call.
Each attempt uses an empty scratch cwd, isolated config directories, stdin prompt,
no-tools/private-session flags, and a ten-minute timeout. No model calls were
made during development; tests use fake binaries only.

The report includes clean must-fix rate and error count, mean total and blocking
findings per successful trial, primary recall with all cases, and secondary
`withoutReview224` recall (pre-registered because review-224 edits AGENTS.md).
Errors never count as clean passes. These are aggregate trial metrics; compare
systems using separately selected trial directories.

```sh
node evals/quality-review/validation-sample.mjs \
  --trials /path/to/trials --judge codex:MODEL:high --judge claude:MODEL:high \
  --cache /path/to/judgment-cache --out /path/to/hand-check --n 50 --seed 1
```

This writes `.json` and `.csv` with a blank human column for Matt's hand check
(target >=90% agreement). Sampling is deterministic, without replacement: half
both-mapped, quarter contested, remainder both-null. For distinct mapped findings,
each pair is eligible. Both-null selects the closest finding by same file then
line distance; no findings leaves the finding columns empty. JSON records seed,
quotas and available counts; undersupplied strata produce fewer rows, without
silently filling from another stratum. Sampling never changes scoring.

Deliberate divergences from limitless:

- Target identity is `{runtime, model, effort}` instead of `parseTarget` and the
  router's provider/model identity. This also changes cache keys.
- `redact(text, secrets)` replaces all occurrences of strings at least eight
  characters long. Secrets are values of explicitly passed auth env vars,
  rather than limitless's credential registry. Direct `runJudge` callers may
  opt into `passAuth`; this CLI passes none, matching round 2.
- A file cache stores strict normalized matches, redacted reasons, judge target,
  and cost when reported, instead of the SQLite store. No provider cost estimate
  is invented; Claude's reported `total_cost_usd` is retained.
- Only first-review, non-panel blocking rules apply; there are no panel rules.
- Local CLI invocation and the existing transcript parser replace the harness
  router, structured-attempt routing, and model-origin eligibility checks.
  Codex uses the pinned noTools branch (not the tool-enabled read-only flags).
- There is no provider concurrency/rate tracking, quota accounting, budget cap,
  abort-signal router integration, or live telemetry. Calls run sequentially.
- Round-2 findings-only records replace StoredReview wrappers; strict finding
  validation remains in effect. The added clean/volume/exclusion metrics and
  hand-check sampling are secondary bookkeeping outside judge.ts.

Any change to JUDGE_RULE, TEMPLATE, matching, or the caught rule is a scoring
change that needs Matt's approval.

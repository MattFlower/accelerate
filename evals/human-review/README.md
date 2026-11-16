# Human-review page coverage: round 1

This suite supplies fixed branches plus private coverage keys for evaluating
human-review HTML pages. Round 1 builds inputs and checks their integrity; it
does not call a model, generate recap.json, render pages, or score prose.
Each point describes one fact a reader should learn, with full/partial coverage
criteria and source evidence. Traps describe plausible false claims separately.
The intended next step is independent judging of page coverage against these keys.

## Run

Requires Git and Node 18+; there are no dependencies to install.

```sh
node evals/human-review/build-case-repo.mjs dev-1 /tmp/parcel-review
node evals/human-review/validate-keys.mjs
node evals/human-review/validate-keys.mjs --quiet
node --test 'evals/human-review/test/*.test.mjs'
```

The destination must not exist. The builder also exports
`buildCaseRepo({ caseId, dest })`, returning `{ dest, base, head }`.
The created repository starts with the base commit on main, then the case's
ordered commits on its feature branch. It remains checked out on that branch.
Names, email addresses, dates, Git configuration, and hooks are fixed or isolated.
Only two refs exist. No Git operation writes the enclosing worktree's index.

On Node releases that do not expand quoted test globs, use
`node --test evals/human-review/test/*.test.mjs` instead.

The validator accepts `--keys-dir DIR` and `--cases-dir DIR` for separately
stored held-out material. Both the validator and builder use the same base.
Each case directory contains change.patch plus commits.json (1–3 ordered
`{ message, patch_file }` entries). The exported builder accepts the same optional
`keysDir` and `casesDir` overrides. Key filenames must match case_id.
Supported splits are dev and held-out. Evidence sides are head and base (main).
Ranges are inclusive. A commit reference uses `{"ref":"commit:<n>","side":"head"}`,
where n is the 1-based index of an ordered feature commit. It must resolve to a
commit with a nonempty message body. Every why point must cite at least one such
body or a resolvable head comment/docs line that states the intent. The validator
checks the evidence form and location; editorial review checks its meaning. The validator checks schema, counts, categories, unique IDs,
kind constraints, evidence paths/lines, patch application, and base tests. Feature patches must contain 80–250 combined patch-file lines
and touch at least three files; mechanical-heavy cases must touch at least eight.
It cannot establish atomicity, factual truth, or agreement between prose judges;
those require editorial review. The integration tests additionally run the
existing and added fixture tests on all four heads. Private reproductions belong
only in summary_for_maintainers, never in fixture tests.

## Development cases

| Case | Kind | Change |
| --- | --- | --- |
| dev-1 | planted-defect | Batch reads and resettable cache metrics; warm reads expose shared values. |
| dev-2 | planted-defect | Token validation and fixed expiry; new validation errors bypass the unchanged HTTP client-error mapping. |
| dev-3 | mostly-clean | Per-operation retry policies with a linear default trade recovery speed for outage traffic. |
| dev-4 | mechanical-heavy | Move lifecycle/storage packages; reduce only the HTTP default page size. |

Case 4 uses delete/add patch entries for moved files so its touched-path count
is independent of Git's rename similarity heuristics. The model/service/cache/
repository contents are identical across those moves. HTTP pagination is the
single semantic change. Direct repository pagination keeps its old default.

## Leakage rules

Give the page-producing model **only the built standalone repository**. Never
expose this directory, the key files, the validator output, or the witness tests.
Keys live outside fixture/. Case metadata and patches are not copied into the
built tree. Commit messages use ordinary development language.
The builder scans commit messages, the base and every committed case tree for case-insensitive
`keys/`, `evals/`, `planted`, `defect`, and `key point`. It rejects symlinks.
The scan excludes Git's internal directory; no evaluation metadata is written
there. The builder also enforces exactly main plus the selected feature branch.
Quiet validation prints only one status line per case plus totals, including on
errors. Error details are suppressed in quiet mode because Git/test errors can
contain private source text. For sealed checks use --quiet, not ordinary mode.

## Reserved for held-out

Four of the eight functional source areas remain untouched by all dev patches:

- `src/reporting/`: bounded CSV export and aggregate reporting.
- `src/security/`: signed capabilities, expiry, and scope checks.
- `src/config/`: environment parsing and retry-setting validation.
- `src/audit/`: ordered event journal, cursor retention, and hash-chain verification.

Dev logic edits stay in storage, orders, retry, and http. The package move also
updates the composition root, imports in tests, and the fixture README. Held-out
authors can add two independent cases in the reserved areas without reusing the
development mechanisms. Keep their keys outside fixture/ and their prose out of
built trees. Validate sealed cases using the directory overrides above.

## Round 2

Round 2 adds generation, two-vendor coverage scoring, omission calibration,
reporting and hand sampling. **No real model calls have been made.** Tests use
fake executables. Requires Node 18+, Git and system tar; no npm dependencies.

### Commands and run layout

Use one new directory per page underneath a run directory. Each contains
`trial.json`, `repo/`, raw `transcript.json`, `stderr.txt`, and available
`recap.json` / `review.html`. Use conventional names `page-text.json` and
`coverage.json` for the next stages. Reports scan nested directories, skip
repo/.cache, and stop at page directories. Coverage records hash page content;
readers reject stale page/coverage combinations. Keep full judgments private.

Commands below require fake binaries for no-spend experiments. Confirmed
commands can spend money if you substitute real executables.

```sh
node evals/human-review/generate-page.mjs dev-2 --out /tmp/hr-run/a --dry-run --claude-bin /path/to/fake-claude
node evals/human-review/generate-page.mjs dev-2 --out /tmp/hr-run/a --model sonnet --max-usd 2 --confirm-spend --claude-bin /path/to/fake-claude
node evals/human-review/page-text.mjs /tmp/hr-run/a/recap.json --out /tmp/hr-run/a/page-text.json
node evals/human-review/judge-coverage.mjs /tmp/hr-run/a/page-text.json evals/human-review/keys/dev-2.json --out /tmp/hr-run/a/coverage.json --cache-dir /tmp/hr-cache --runs 1 --max-calls 4 --confirm-spend --claude-bin /path/to/fake-claude --codex-bin /path/to/fake-codex
node evals/human-review/strip-point.mjs /tmp/hr-run/a/page-text.json evals/human-review/keys/dev-2.json --point dev-2.p1 --out /tmp/stripped.json --cache-dir /tmp/hr-cache --max-calls 2 --confirm-spend --claude-bin /path/to/fake-claude --codex-bin /path/to/fake-codex
node evals/human-review/calibrate.mjs /tmp/hr-run --out /tmp/calibration.json --cache-dir /tmp/hr-cache --pages-per-case 1 --max-calls 200 --confirm-spend --claude-bin /path/to/fake-claude --codex-bin /path/to/fake-codex
node evals/human-review/report.mjs /tmp/hr-run --out /tmp/report.json --quiet
node evals/human-review/hand-sample.mjs /tmp/hr-run --out /tmp/matt-sample --seed matt-1 --count 20
node --test 'evals/human-review/test/*.test.mjs'
```

Public flags:

| Command | Flags and purpose |
| --- | --- |
| generate-page | Positional caseId; required new `--out` directory; `--cases-dir`/`--keys-dir` override inputs; `--model` overrides generating CLI default; positive `--max-usd` caps budget; `--confirm-spend` authorizes launch; `--dry-run` prints argv/env keys only and creates no output; `--pass-auth` passes only CLAUDE_CODE_OAUTH_TOKEN; `--claude-bin` overrides executable, including help detection. |
| page-text | Positional recap; optional `--out` JSON file, otherwise stdout. |
| judge-coverage | Positional page-text/key; required `--out`; positive `--runs` repeats each vendor (default 1); `--claude-model` defaults sonnet; `--codex-model` unset uses CLI default; `--claude-bin`/`--codex-bin` override executables; cache/spend/cap flags below; `--quiet` suppresses private prose. |
| strip-point | Positional page-text/key; required `--point ID` and `--out`; `--claude-bin`/`--codex-bin`; cache/spend/cap flags. Both Claude and Codex run the same strip rule; both executable/model overrides are supported. |
| calibrate | Positional run directory; required `--out`; `--keys-dir`; both executable/model overrides; cache/spend/cap flags. All keys must be dev; positive `--pages-per-case N` defaults to 1 (first N ok pages per case, sorted by directory name). |
| report | Positional run directory; optional `--out`; `--quiet` prints counts only. |
| hand-sample | Positional run directory; required new `--out` directory; `--keys-dir`; `--seed` default matt; positive `--count` default 20. All keys must be dev. |

Cache/spend/cap flags: `--cache-dir DIR` is required for judging, stripping and calibration; there is no repository-local default. Use an external directory. `--pass-auth` opts into the authentication described below;
`--confirm-spend` is required for uncached calls; nonnegative `--max-calls`
hard-caps all launches including retries (default unlimited). Cache hits require
no confirmation and make zero calls. Exhausting the cap aborts the command;
already completed cache entries survive. Generation refuses before building
without confirmation (except dry-run). Dry-run only invokes the supplied
executable's `--help`, without a model prompt.

### Isolation, provenance and actual CLI argv

Adapted the sibling quality-review isolation, transcript, permission, ephemeral
judge and cache patterns into this directory; no cross-branch imports.
Scratch HOME, CLAUDE_CONFIG_DIR, XDG_CONFIG_HOME and TMPDIR are fresh
for every call and removed afterward. CODEX_HOME is also empty scratch unless
`--pass-auth` is supplied: then it is the parent's CODEX_HOME, or the parent
user's `~/.codex`. Codex's `--ignore-user-config` and `--strict-config` ignore
that home's user configuration while retaining persistent login state.
Claude generation, judging and stripping authenticate only through
CLAUDE_CODE_OAUTH_TOKEN with `--pass-auth`; API keys are not passed through.
Before an uncached Claude launch, missing opt-in token fails with
`CLAUDE_CODE_OAUTH_TOKEN not set (run claude setup-token)`.
Run `claude setup-token` to obtain the token. Never copy credential files into
scratch: persistent login/Keychain state and refreshed tokens must remain in
their real home. Only PATH, LANG, TERM and the opted-in token pass through.
Judges have an empty cwd. Known credential values are redacted from transcripts, stderr,
trial metadata and generated output files before returning.

The installed Claude 2.1.319 `--help` was inspected without a model call. It
advertises budget/session/permission flags and `/skill-name` invocation, but
**does not describe filesystem skill discovery**. The mechanism used here is
`$CLAUDE_CONFIG_DIR/skills/human-review/SKILL.md` as an isolated user skill,
with user setting sources enabled. Actual discovery remains a real-run check.
The entire skill directory comes from `git archive HEAD skills/human-review`,
never working-tree files, and is unpacked/copied outside the case repo.

Generation flags:

- `-p --output-format json`: headless single-result output.
- `--no-session-persistence`: no resumable session.
- `--setting-sources user`: isolated user skill; ignore project/local settings.
- `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`: no MCP servers.
- `--permission-mode dontAsk`: deny unapproved tools without prompting.
- `--tools Read,Grep,Glob,Bash,Write,Edit,Skill`: skill's required tool set.
- `--allowedTools`: read/search, Skill(human-review), read-only git
  diff/log/show/status, command detection, exact Node/Bun collect commands
  for main/current feature, exact build commands for known review directories
  (optionally `--check`), Write/Edit under `<repo>/.human-review/**` only.
  Quoted/unquoted script paths are supported. No arbitrary script `--out`.
- `--disallowedTools`: WebFetch/WebSearch and git output-file variants.
- Optional `--model`; `--max-budget-usd` when requested and advertised by help.
  Reported over-budget runs always error; missing cost with a budget errors.
  Unsupported budget flags are omitted and cost is checked afterward.

Prompt bytes are exactly `/human-review main..<feature-branch>` followed by
one newline and `Do not open a browser.` (no trailing newline). No key prose
enters the prompt/repo. The builder privately reads branch and split from the
key. Existing skill collect adds `.human-review` to `.git/info/exclude`; this
Git-metadata side effect is the exception to output-only writes. No source or
skill files are installed in the repo.

Trial fields: caseId, split, branch, base/head SHAs, modelRequested,
modelReported, total_cost_usd, durationMs, exitCode, status
(ok/error/cancelled), promptSha256, skillVersion, skillTreeSha, skillSha256,
toolCalls, buildCheck, random 12-hex pageId and any error. Current skill
`--version` prints help: the first line is its version string. Tree SHA is
`HEAD:skills/human-review`; skillSha256 hashes installed SKILL.md.
Generation times out after ten minutes; timeout/signals are cancelled.
Exactly one direct `.human-review/*/recap.json` must exist. The archived
script runs `build DIR --check`; recap/optional HTML are copied even if that
check fails so failures remain inspectable. Tool counts reflect events actually
present; single-result Claude JSON may omit intermediate tool events.

Judge flags preserve sibling spellings:

- Claude: `-p --output-format stream-json --verbose`, optional `--model`,
  `--setting-sources '' --no-session-persistence --tools ''`,
  `--json-schema JSON`.
- Codex: `exec --json --skip-git-repo-check -C EMPTY`, optional `-m MODEL`,
  `-c 'approval_policy="never"' --ephemeral --ignore-user-config --strict-config`,
  `--disable` for shell_tool, multi_agent, apps, plugins, code_mode, view_image,
  `-c orchestrator.mcp.enabled=false -c 'web_search="disabled"'`,
  `--output-schema FILE -` (stdin).
- Exported API effort overrides use Claude `--effort` or Codex
  `-c model_reasoning_effort=JSON`; unset/default omits effort entirely.
  There is no public effort CLI override.

Permission rules are Claude policy controls, not an OS filesystem sandbox.
Real skill discovery, shell matching and permission enforcement remain
unverified. The harness rejects symlink page artifacts and scrubs known auth
values from returned artifacts. Fakes do not test real policy enforcement.

### Scoring and calibration conventions

The judge sees sentence IDs/prose, point statement/covered_if/partial_if and
trap statement/why_false. Case-bearing point/trap IDs are mapped to P1/T1 etc.
inside prompts and mapped back afterward. No case ID, branch, maintainer
summary, evidence, generator provenance or pageId is sent. Constant prompt
plus strict schema hash versions cache entries. Identity also includes payload,
vendor, model, effort and run index. Records retain redacted raw stdout/stderr,
judgments, reported cost and target metadata.

Strict validation rejects extra properties, missing/duplicate IDs, invalid
types/labels and decisions serialized before rationales. Failed/malformed
judgments retry once; final errors are cached and counted, never absent labels.
Delete an error entry to explicitly retry it. For repeated runs each vendor
needs a strict majority of all configured runs; ties/insufficient votes are
unresolved. Both covered means covered; both absent means absent; other resolved
pairs mean disagree, except both partial means partial. Disagreement records retain both vendor labels and remain eligible; coverage is covered/eligible. Both vendors must assert a trap. Unresolved point decisions
are excluded from the eligible denominator and retained as errors. Raw labels,
rationales and notes stay in output JSON. Quiet output contains only
`caseId pages=N covered=K/P partial=N absent=N disagree=N false_claims=N errors=N`.

Stripping asks both Claude and Codex with the same STRIP_RULE, validates unique
existing IDs and removes the union without rewriting/renumbering. Records
include each vendor's list (`sentenceIds`), full vendor results, the `union`
(and `removed`) and the stripped `page`. Only an empty union is not-strippable;
either vendor's failed/malformed extraction is error. Calibration preflights every key for dev before spending; for each
originally both-covered point it judges the original/stripped page three times
per vendor. A pass requires >=2 original covered AND >=2 stripped absent.
Errors remain errors (two successful qualifying votes can still pass).
Reports include tested/passed, failed IDs, not-strippable IDs and errors.
Extraction failures are separate from successfully tested points. Matching
original judgment runs reuse cache across points and normal scoring runs 1–3
with identical payload, model, effort and run-index identities. Calibration uses
only the first `--pages-per-case` ok pages per case (default 1), sorted by
directory name. Before any call it prints a cache-aware maximum call plan for
stripping and judging, including judge retry slots, and refuses if the plan
exceeds the remaining `--max-calls`. Cached entries count as zero. Unknown
stripped payloads reserve all possible judge attempts; this can overestimate
when stripping finds nothing, produces a cached page, or fails.

Reports return separate dev/held-out objects with **no pooled totals**. Missing
coverage is unjudged, not zero. Coverage denominators exclude unresolved points;
total key points and affected points remain separately visible. Judge errors
count failed runs. Cost is generation plus newly incurred coverage judging cost;
unavailable generation cost is flagged. Codex dollar cost can be unavailable.
Per-page and per-case reports include separate partial, absent and disagree counts. Case counts sum eligible page-point pairs. A/A spread is absolute coverage-rate
difference for exactly two successful, fully judged pages sharing case,
requested/reported model and skill tree; mean is within split. Groups larger
than two are not paired arbitrarily. Sampling uses seeded hash ordering and
round-robin strata (covered, disagree for “judges disagree”, agreeing absent/partial),
filling available strata if others run out. matt.csv has prose/criteria and
blank matt_label; answers.json separately stores sample-to-page/point IDs and
both labels. Keep answers away from the hand labeler.

### Exact page-text field policy

Extraction follows explicit traversal order, sorting file-map keys and keeping
array order; unknown fields have no fallback. Long-field arrays are joined.
Sentence boundaries are `. ! ?` followed by whitespace outside backticks;
whitespace is normalized. Decimal/file-name dots do not split unless followed
by whitespace. Abbreviations can split: no locale/ICU heuristics. Fragments get
IDs too. Output is `{text, sentences:[{id,text}]}`; IDs start s1..sN. Stripped
copies keep gaps. Markdown emphasis/backticks/link destinations and fenced code
are removed. Inline paths inside prose remain.

Included fields, including prose held back in the UI:

- Top-level title, brief, background; terms[].term/means; risk.level/why;
  ask[], summary[], focus[].title/why; sections[].title/intro/blocks;
  keyChanges; questions[]; checks.verified string or text/cmd, checks.manual[];
  tests.covers/doesNotCover[]; notExamined[]; concerns[].title/why;
  files[path].review/note.
- All blocks: title, summary, label, caption, annotations[].title/text.
  markdown/callout: md.
- wireframe/diagram: url, visible html text and data-note/aria-label/title/alt
  attributes. screenshot: alt/caption, never pixels.
- mermaid: source lines containing participants, nodes, messages, conditions,
  relationships; omit blank/comment lines, diagram-kind headers, end,
  direction/style/classDef/linkStyle directives. Remaining syntax provides
  label context.
- compare: labels[], before/after blocks, columns[].label/blocks.
  tabs: tabs[].label and blocks[] (or legacy block).
- dataModel: entities[].name/change/note; fields[].name/type/change/was/
  pk/fk/unique/index/nullable/note; relations[].from/to/change.
- api: endpoints[].method/path/change/auth/summary/md/deprecated;
  params[].name/in/type/required/change/was/note; request.example;
  responses[].status/label/change/example. Authored examples are JSON-serialized.
- states: corner, columns[], rows[].label, cells (strings/booleans or value/was).
  Structured schema/permission labels are scoreable authored content.

Excluded fields: all ids; block type discriminators (except schema/parameter
field type); focus.ref; concerns.files; file-map path keys; block.file;
lines/hunks/mode; annotation.line/to/side/kind; callout.kind;
wireframe.surface/height/skeleton; screenshot.src/width; compare.stack;
diagram.css; HTML tags/styles/script/style contents and attributes other than
those listed; Mermaid layout/style directives; git-derived diffs, code hunks,
source excerpts, computed signals/blast radius/stats; unknown fields.
API examples are authored artifacts, unlike git code excerpts. Assets, CSS and
image bytes are never scored.

### Still unverified until a real run

Fakes check argv/stdin, isolation/auth redaction, external committed-skill
installation, archived build validation, extraction, retry/errors, consensus,
cache/caps, exact stripping, dev gates, threshold rules, quiet output and
split-separated reports. Actual CLAUDE_CONFIG_DIR discovery, permissions,
model availability, real CLI event/model/tool/cost formats, budget enforcement,
judge agreement, calibration reliability and Matt's comparison remain unverified.
No browser/server, real generation/judging, or commit was run.

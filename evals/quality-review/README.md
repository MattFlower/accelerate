# Quality-review eval — round 1

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
for AGENTS.md, CLAUDE.md, and .claude/.codex directories and their contents,
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

- Reviewer invocation (Claude Code + Codex headless)
- Two-judge matcher port
- Wilson CIs
- A/A drift
- Paired PR-clustered bootstrap
- Volume bookkeeping
- Stage-level scoring
- Manipulation checks

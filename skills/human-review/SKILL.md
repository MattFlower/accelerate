---
name: human-review
description: Turn a branch, pull request, commit range, or uncommitted work into one self-contained HTML review page (annotated diffs, before/after wireframes, data-model and API summaries, diagrams, a suggested reading order, and a comment-and-verdict loop) so a person can understand and review the change in minutes instead of half an hour. Use when the user asks to review, recap, walk through, explain, or summarize a change, PR, or branch for a human, or runs /human-review.
argument-hint: "[PR number | base..head | branch]"
---

# Human review

You turn a code change into a page a reviewer can read in a few minutes. The
page leads with the shape of the change (what users see, what contracts moved,
where the risk is) and only then drops into annotated diffs. Everything ships
as **one HTML file** with no server, account, or network access. The renderer,
syntax highlighter, diagram library, and fonts are bundled in this skill.

Your job has two halves:

1. **Mechanics.** The bundled CLI reads git and builds the page. Diffs are
   pulled from git by the build, never retyped by you, so the code on the page
   is true by construction.
2. **Editorial judgment.** You write `recap.json`: the title, the risk read, the
   reading order, the visuals, and a few sharp annotations. This is the part
   that turns a 30-minute review into a 3-minute one, and where you spend your
   effort.

The CLI is `scripts/human-review.mjs`, a single script with no dependencies. It
runs the same under **Bun or Node 18+**: use whichever is installed (check with
`command -v bun node`). The commands below show `node`; with Bun, write `bun` in
its place. There's no npm install step. If `${CLAUDE_SKILL_DIR}` isn't expanded in your environment, use
the directory that contains this `SKILL.md`.

## Workflow

### 1. Decide the scope

Map the user's argument to `collect` flags:

| User says | Flags |
| --- | --- |
| nothing | (none): current branch vs. the default branch's merge-base, **plus** uncommitted and untracked changes |
| a PR number, `#123`, or PR URL | `--pr 123` (uses the GitHub CLI `gh`) |
| `main..feature`, `abc123..def456` | `--base main --head feature` |
| a branch name | `--head that-branch` |
| "just my uncommitted changes" | `--base HEAD` |
| "the last commit" | `--base HEAD~1 --no-uncommitted` |

When you're invoked after doing work in this conversation, the scope is the
**whole work unit**: everything this thread changed (the original
implementation, later fixes, tests, docs), not just the last edit. Exclude
unrelated changes that were already in the tree before the thread started; if
you can't tell them apart, say what you assumed.

### 2. Collect

```bash
node "${CLAUDE_SKILL_DIR}/scripts/human-review.mjs" collect [flags]
```

It prints the file list and writes three files to `<repo>/.human-review/<branch>/`
(that folder is added to `.git/info/exclude` so it never gets committed):

- `review.txt`: the diff with **old and new line numbers on every line**. Read it.
- `diff.json`: the machine form the build uses. Don't edit it.
- `recap.json`: a skeleton with every changed file pre-listed. You fill it in.

If `recap.json` already exists from an earlier run, `collect` leaves it alone.
Update it rather than starting over.

### 3. Read the change

Read all of `review.txt` (in chunks if it's long). Generated and lock files are
summarized, not printed. Open surrounding source when a hunk doesn't make sense
on its own: callers, types, the rest of a component. Read the commit messages
and the PR description (`--pr` includes it in `diff.json`).

While reading, keep a short inventory. This is your raw material:

- **Surfaces:** routes, screens, components, popovers and dialogs, empty, error,
  and loading states, role- or permission-dependent UI.
- **Contracts:** schema and migrations, API routes and payloads, events,
  config, public functions and types, CLI flags.
- **Behavior:** what now happens differently at runtime, including the
  failure paths.
- **Risk:** anything that could break, leak, lose data, or surprise a user;
  anything irreversible; anything you aren't sure about.
- **Evidence:** tests added or changed, and what you actually ran.

Don't re-read the whole diff after this pass. Work from your notes.

### 4. Write `recap.json`

**Read `references/format.md` first.** It is the schema for every field and
block. For any UI change, also read `references/wireframes.md`. For
architecture or flow diagrams, read `references/diagrams.md`.
`references/example-recap.json` is a complete, strong recap of a mid-sized
feature (UI, schema, API, permissions). Skim it once to calibrate the tone and
density.

What to write, and how, is covered in "Writing for a reviewer" below.

### 5. Build and open

```bash
node "${CLAUDE_SKILL_DIR}/scripts/human-review.mjs" build <dir> --open
```

Use `build <dir> --check` to validate without writing the page while you
iterate. The build validates `recap.json` against the real diff. Errors name
the JSON path and the fix: an annotation on a line that isn't in the diff, a file that
isn't in the change, an unknown block type, a bad screenshot path. Fix every
error. Read the warnings and fix them unless you have a reason not to. The
output is `<dir>/review.html`.

If the build says the code moved since `collect`, run `collect` again, then
rebuild. Never hand over a stale review.

### 6. Look at it

If you have a browser tool, open `review.html` and check it once. Check that
wireframes aren't cramped or overlapping, that diagrams render, and that notes
sit on the lines they describe. If the browser can't open `file://` URLs, serve
the folder with any static server on localhost. Do one fix-and-rebuild pass,
not an open-ended polish loop. If you can't render pages (a headless or CI
run), the build's validation is your check; say in the handoff that you didn't
look at it.

### 7. Hand off

Reply with:

- the path to `review.html` (it's already open if you passed `--open`),
- two or three sentences: what changed, the risk level, and the one or two
  places the reviewer should look first,
- a note that they can comment on any line or block, pick a verdict, and press
  **Copy feedback for the agent** to send it back to you.

Don't paste the recap content into chat. The page is the deliverable.

## Writing for a reviewer

A reviewer opens the page with four questions. Answer them in this order, and
answer each one only once:

1. **What is this?** Covered by `title`, `brief`, and `summary`.
2. **Should I worry?** Covered by `risk` and `focus`.
3. **What does it look like, and what contracts moved?** Covered by `sections`:
   wireframes, screenshots, data model, API, diagrams.
4. **Show me the code that matters.** Covered by `keyChanges` (annotated diffs)
   and `files` (every file, triaged).

Then `questions` and `checks` close the loop: what you need from them, what you
already verified, and what they should try themselves.

### The fields that carry the most weight

- **`title`**: under 70 characters of plain text (backticks for code are
  fine), and it names the outcome, not the activity.
  "Read-only share links for project boards", not "Add share link feature".
- **`brief`**: one to three sentences in plain language that a product person
  could follow. What changed for whom, and the one mechanism that matters.
- **`risk`**: `low`, `medium`, or `high`, plus one line of why. Calibrate
  honestly. A refactor with full test coverage is `low`. A new unauthenticated
  route, a data migration, or auth or billing logic is at least `medium`. If
  you found a real bug, say so here.
- **`summary`**: two to five bullets of *what changed*, each one a fact a
  reviewer would otherwise have to dig out. No "this PR…" throat-clearing.
- **`focus`**: the suggested reading order, three to six stops. Each stop is a
  short title, a why ("check that…", "this is where…"), and a `ref` to
  `path:line` or `#block-id`. This is the most valuable thing on the page. Put
  the riskiest or most consequential thing first.
- **`files`**: give every changed file a `group` (Server, Web, Data, Tests,
  Docs, Config, Generated, or whatever fits this repo), a `review` level, and
  for anything non-obvious a short `note`:
  - `careful`: logic, security, data, or contracts. Read every line.
  - `skim`: straightforward or presentational. Glance at it.
  - `skip`: generated, lockfiles, snapshots, pure renames, formatting.

  Accurate triage is how a 40-file PR becomes a 6-file read.

### Annotations

Annotations are the margin notes on `keyChanges` diffs. They make the code
legible.

- Put **two to five per file**, on the load-bearing lines. Don't annotate every
  hunk.
- Say what the reader can't see at a glance: *why* a line exists, what it
  guards against, what breaks if it's wrong, or what it interacts with
  elsewhere. Never restate the code ("increments the counter").
- Pick the `kind` honestly. Each kind gets its own color:
  - `risk`: a bug, a sharp edge, or a missing check. Be specific about the
    failure and suggest the fix.
  - `question`: you aren't sure. Don't guess silently.
  - `decision`: a deliberate tradeoff the reviewer should agree with.
  - `note`: context.
  - `praise`: use sparingly, for something genuinely worth copying.
- Use `"to"` for multi-line spans, and `"side": "old"` for a removed line,
  numbered from the OLD column of `review.txt`.
- Line numbers come from `review.txt`. The build rejects any line that isn't in
  the diff and tells you which ranges are valid.

### Key changes

`keyChanges` holds **three to eight** files that carry the change, ordered the
way the reviewer should read them. Each one gets a one-sentence `summary` (what
the file's change does and why) and its annotations. Narrow a long file to the
relevant hunks with `"lines": [start, end]` (new-file numbers). The reviewer can
still expand the rest. Every file is also in **All files** at the bottom, so
you don't need a tab for each one.

### Visuals: match the change to the block

| The diff changes… | Show it with |
| --- | --- |
| Rendered UI: layout, controls, states, copy, navigation | **Required:** `wireframe` blocks in a `compare` (Before / After), or `screenshot` blocks if you can run the app. Show the entry point, the opened surface, and the resulting state. |
| Who can do what (roles, flags, plans) | `states` matrix, with changed cells marked by `was` |
| Database schema or migrations | `dataModel` with per-field `change` and `was` |
| HTTP, RPC, or GraphQL endpoints, or events | `api`, with real example payloads |
| Library or SDK surface: new options, exported functions, types, error classes | `markdown` table of options (name, type, default, effect); `code` blocks of the new signatures or types, annotated; `compare` of before/after usage as fenced code in `markdown` |
| Control flow, request lifecycle, or sequence | `mermaid` (`sequenceDiagram` or `flowchart`) |
| Architecture, or module boundaries moving | `diagram` with before/after panels (see `references/diagrams.md`) |
| A compatibility or migration concern, or a decision | `callout` (`breaking`, `risk`, `decision`, `security`, `perf`, `note`) |
| Unchanged code the reader needs for context | `code` block (any file at head, with annotations) |

Rules for visuals:

- **Before/after is the default comparison.** Use `compare` for anything that
  has a before. Use after-only when the before is just absence.
- **UI changes always get a picture.** Prose and diffs don't substitute for one.
  Screenshots from actually running the app are the best evidence; wireframes
  are the fallback. Say in the caption when a wireframe's layout is inferred.
- **Ground every visual in the diff.** Use the real labels, field names, routes,
  and status codes. Mark anything inferred as inferred. Don't invent screens,
  fields, or behavior.
- **Don't overdo it.** A two-file bug fix needs a title, brief, risk, focus, one
  or two key changes, and files. No sections. Add a visual only when it
  explains something faster than the diff does.

### Questions and checks

- **`questions`**: decisions you need from the reviewer, phrased so they can
  answer in a line. The page has an **Answer** box for each one.
- **`checks.verified`**: only what you **actually ran or confirmed in this
  session**. Add `cmd` only when the reviewer could rerun it from the repo root
  (`{"text": "...", "cmd": "npm test"}`); describe ad-hoc probes in `text`
  instead. If you ran nothing, leave it empty. Never imply verification you
  didn't do.
- **`checks.manual`**: two to five concrete things a human should try, written
  as steps. The reviewer can tick them off.

### Honesty

The page will be trusted. A confidently wrong recap is worse than none, because
the reviewer skips the line you summarized incorrectly.

- Everything structural (diffs, file list, stats) comes from git via the build.
  Everything you write (prose, wireframes, data models, API examples) must
  match the diff. If you didn't see it, leave it out.
- Say "inferred" when you infer.
- If you find a bug while recapping, flag it as a `risk` annotation, mention it
  in `risk.why` and `focus`, and tell the user in your handoff. Don't quietly
  fix code during a review unless they ask.

## When feedback comes back

The reviewer's **Copy feedback for the agent** button produces Markdown that
starts with `# Review feedback:`. It contains the verdict, an overall note,
answers to your questions, and comments anchored to `path:line` (with the code
line quoted) or to a named block. When the user pastes it:

1. Treat it as review comments from the user and address each one: fix the
   code, answer in chat, or explain why not.
2. Then refresh the review so it covers the **whole** work unit, not only the
   fixes: run `collect` again, update `recap.json` (line numbers shift, so
   re-check annotations), and run `build`. Saved comments belong to a version
   of the code: once the code changes, the new page starts clean. (A rebuild
   after a recap-only edit keeps them.)
3. Summarize what you changed per comment.

## Security and privacy

- The page contains source code. Treat `review.html` like the repo itself, and
  don't upload or publish it anywhere unless the user asks.
- `collect` and `build` redact secret-looking values (API keys, tokens, private
  keys, `.env` values, passwords in config files) and report how many. It's a
  heuristic, so never copy a secret into `recap.json`, a wireframe, or an API
  example; use obvious placeholders.
- The page's Content-Security-Policy blocks all network requests, so remote
  images or stylesheets in your HTML or Markdown won't load.
- Everything runs locally. The CLI only touches the network for `--pr`, which
  uses `gh` and `git fetch`.

## Troubleshooting

- **"not inside a git repository"**: `cd` into the repo first.
- **No changes found**: on the default branch with a clean tree, the CLI falls
  back to the last commit (for a repository's first commit, it compares
  against the empty tree). Otherwise pass `--base`.
- **"holds a review of …"**: each branch gets its own folder under
  `.human-review/`; pass `--slug <name>` or `--out <dir>` to choose another.
- **`--pr` fails**: `gh` must be installed and authenticated
  (`gh auth status`). As a fallback, fetch the PR branch and use
  `--base origin/main --head <branch>`.
- **JSON syntax error**: the build prints the line and column.
- **Huge diffs**: the page stays fast because files render only when opened.
  Lean on `files[...].review` to tell the reviewer what to skip, and keep
  `keyChanges` to eight or fewer.
- **File size**: about 350 KB for the renderer, plus the diff and the full
  text of changed files (so readers can expand context), typically a few
  hundred KB to a few MB. A `mermaid` block adds about 2.7 MB, since the
  library is inlined only when used. Screenshots add their own size.

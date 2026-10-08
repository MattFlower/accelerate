# /human-review

Turn a branch, pull request, commit range, or your uncommitted work into a
single HTML page that a person can review in a few minutes.

The page leads with the shape of the change, then drops into the code:

- **Title, brief, and risk read**: what changed, for whom, and whether to worry.
- **What I need from you**: the kind of feedback the author wants (a decision,
  a second opinion on one area, a check that couldn't be run), right under the
  brief, plus what the tests cover and what they don't.
- **From git**: a few checkable facts computed from history and file paths
  (an author new to the changed files, files mostly written by someone else,
  repeated recent fixes, changes spread across many directories, paths named
  for auth or migrations). Each is tagged *verified*, *author text*, or
  *inference* and shows the command that reproduces it. Never a score, and
  never read from the PR description.
- **Footprint bar**: where the weight of the change sits, concern by concern,
  and how much of it is mechanical or generated, so you know at a glance how
  much actually needs reading.
- **Where to look, in order**: a reading path of three to six stops, each
  linked to the exact line.
- **Visuals for what diffs are bad at**: before/after wireframes (sketch or
  clean), screenshots, permission matrices, data-model cards with per-field
  changes, API cards with example payloads, and Mermaid or hand-laid diagrams.
- **Key changes**: annotated diffs of the files that carry the change, with
  margin notes colored by kind (risk, question, decision, note), split or
  unified views, word-level highlights, and expandable context. Where a hunk
  touches access control, authentication, SQL built from strings,
  deserialization, crypto, or a shell call, the page asks one specific
  question at that line ("Is `canShare` applied on every path that reaches
  this code?"). These are computed from the diff, rare (five at most), and
  never a checklist.
- **Before you approve**: the agent's open questions (answer them inline),
  what it actually verified, and a checklist of things to try yourself.
- **All files, by concern**: every changed file grouped by what it does
  together (not by layer), in reading order, with each test right after the
  code it tests. Files are triaged *read closely* or *skim*; anything the diff
  proves needs no reading is tiered **mechanical** (renamed unchanged, or only
  moved or re-indented lines) or **generated**, with the proof shown. Moved
  lines are dimmed in diffs and labeled with where they came from.
- **Your read first**: the agent's conclusions (its risk read, the lines it
  flagged, risk callouts) are held back until you've viewed each file, so they
  don't steer where you look. One click shows them all. When you've viewed
  every file they open, together with what the agent did *not* examine and an
  "Anything else?" box for what the page didn't make you look at. The feedback
  export notes which comments you wrote before seeing them.

You can comment on any line or block, pick a verdict, and press **Copy
feedback for the agent**. You get Markdown with file:line anchors that you
paste back into your agent session, and the agent works through it.

## Self-contained by design

- **One HTML file.** The renderer, highlight.js, marked, rough.js, Mermaid
  (only when used), and the sketch font are bundled in this skill and inlined
  into the page. There's no server, account, CDN, or network request.
  Double-click to open; attach it to a PR or a message to share.
- **No install step.** The CLI is a single script with zero npm dependencies.
  It runs under Bun or Node 18+, whichever you have, and needs git (plus `gh`
  for `--pr`).
- **Code on the page comes from git, not from the model.** The agent
  references files and line numbers; the build pulls the real hunks, and
  rejects annotations that point at lines that don't exist.
- **Private by default.** Output goes to `<repo>/.human-review/`, which is
  added to `.git/info/exclude`. Secret-looking values (API keys, tokens,
  private keys, `.env` values) are redacted from the embedded diff. Review
  state (comments, viewed files, verdict) lives in the reviewer's browser.

## Usage

In Claude Code:

```
/human-review              # current branch vs. default branch, plus uncommitted work
/human-review 123          # a pull request (uses the GitHub CLI)
/human-review main..feature
```

Or just ask: "make a human review of this branch", or "recap what we changed
for review".

The agent runs (`bun` and `node` are interchangeable here):

```bash
node scripts/human-review.mjs collect [--base REF] [--head REF] [--pr N] [--no-uncommitted]
#   → .human-review/<branch>/review.txt   line-numbered diff the agent reads
#   → .human-review/<branch>/recap.json   skeleton the agent fills in
node scripts/human-review.mjs build .human-review/<branch> --open
#   → .human-review/<branch>/review.html
```

## Layout

```
human-review/
  SKILL.md                 instructions for the agent
  scripts/human-review.mjs collect / build / open CLI (zero dependencies)
  assets/
    template.html          page shell
    app.js, app.css        renderer
    vendor/                highlight.js, marked, rough.js, mermaid, font, licenses
  references/
    format.md              recap.json schema for every block
    wireframes.md          how to write wireframes that read well
    diagrams.md            Mermaid and HTML diagram primitives
    example-recap.json     a complete example
```

## Credits

Inspired by Builder.io's
[visual-recap](https://github.com/BuilderIO/skills/tree/main/skills/visual-recap),
whose structure and wireframe guidance this adapts. The difference here is
that everything is self-contained in the skill instead of depending on a
hosted plans app. Third-party licenses are in
`assets/vendor/THIRD_PARTY_LICENSES.txt`.

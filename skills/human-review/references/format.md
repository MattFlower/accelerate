# `recap.json` format

`recap.json` is the only file you write. The build validates it against the
real diff and reports errors by JSON path, so you can't silently reference a
line or file that isn't there.

Conventions:

- Every prose field is **Markdown** (GitHub-flavored, so tables, lists, and
  inline code work). Writing a changed path in backticks with an optional line,
  like `` `src/server/routes.ts:31` ``, makes it a link that jumps to that line.
- Any long text field (`brief`, `intro`, `md`, `html`, `css`, `source`,
  `summary`, `note`, `caption`, `text`, `why`) can be written as an **array of
  lines** instead of one string. The build joins them with newlines. Use this
  for wireframe HTML and Mermaid source so the JSON stays readable. (The
  top-level `summary` is a list of bullets, and API `example`s are JSON values,
  so neither is joined.)
- Any block can have an `id`: unique across the file, starting with a letter,
  using only letters, digits, `-` and `_`. Give one to blocks you reference
  from `focus` (`"ref": "#schema"`). The others get ids derived from their
  content. The page reserves `top`, `main`, `overview`, `key-changes`,
  `checks`, and `files`.
- The page loads nothing from the network: its Content-Security-Policy blocks
  remote images, fonts, and stylesheets. Show screenshots with `screenshot`
  blocks, which embed the image.
- In wireframe and diagram HTML, use **single quotes for attributes**
  (`<div class='wf-card'>`) to avoid escaping double quotes inside JSON.

## Top level

```jsonc
{
  "title": "Read-only share links for project boards",   // required, ≤ 70 chars
  "brief": "Owners can now create a public, read-only link…",  // 1–3 sentences
  "risk": { "level": "medium", "why": "Adds the first unauthenticated route…" },
  "summary": ["New `share_links` table…", "Three routes…"],   // 2–5 bullets
  "focus": [                                               // reading order, 3–6 stops
    { "title": "The public route", "why": "First endpoint with no session…", "ref": "src/server/routes.ts:49" },
    { "title": "Schema", "why": "…", "ref": "#schema" }
  ],
  "sections": [ { "title": "What users see", "intro": "optional markdown", "blocks": [ /* blocks */ ] } ],
  "keyChanges": [ /* diff or code blocks, 3–8 */ ],
  "questions": ["Should *Never expires* exist at all?"],
  "checks": {
    "verified": [{ "text": "Unit tests pass", "cmd": "npm test" }, "Migration applies on a seed DB"],
    "manual": ["Create a link with **Never** and check its expiry."]
  },
  "files": {
    "src/server/routes.ts": { "group": "Server", "review": "careful", "note": "Three new routes, one public." },
    "package-lock.json":   { "group": "Generated", "review": "skip" }
  }
}
```

| Field | Notes |
| --- | --- |
| `risk.level` | `"low"`, `"medium"`, or `"high"` |
| `focus[].ref` | `"path:line"`, `"path:start-end"`, `"path"`, or `"#block-or-section-id"`. Built-in section ids: `overview`, `key-changes`, `checks`, `files`. A custom section's id is its slugified title unless you set `id`. |
| `sections[]` | Rendered in order between the overview and key changes. Each needs a `title` and `blocks`; `id` and `intro` are optional. |
| `keyChanges[]` | `diff` blocks (the `type` can be omitted) or `code` blocks. Rendered as tabs, in order. |
| `files[path].review` | `"careful"`, `"skim"`, or `"skip"`. Drives sorting, the sidebar dots, and the progress bar (skipped files don't count). |
| `files[path].group` | Any label. Groups drive the footprint bar at the top and the All files section. The group named `Generated`, and any group whose files are all `skip`, is drawn hatched. |

## Blocks

### `markdown`

```json
{ "type": "markdown", "md": "Prose. Use sparingly; structured blocks usually say it better." }
```

### `callout`

```json
{ "type": "callout", "kind": "breaking", "title": "Clients must send `ttlDays`", "md": "Old clients get a 400 after deploy…" }
```

`kind` is one of `note`, `risk`, `breaking`, `decision`, `question`,
`security`, or `perf`.

### `diff`: annotated changes in one file

```jsonc
{
  "type": "diff",
  "file": "src/server/shareLinks.ts",        // must be a path in this diff
  "summary": "Owns token generation, hashing, lookup, and revocation.",
  "lines": [10, 60],          // optional: only hunks overlapping these NEW-file lines
  "hunks": [1, 3],            // optional: only these hunks (1-based, as numbered in review.txt)
  "mode": "unified",          // optional: force "split" or "unified" (default: reader's choice)
  "label": "shareLinks",      // optional: tab label in keyChanges
  "annotations": [
    { "line": 13, "kind": "praise", "text": "Tokens are hashed before storage…" },
    { "line": 45, "to": 47, "kind": "risk", "title": "Expiry ignored", "text": "Counts links with…" },
    { "line": 12, "side": "old", "kind": "note", "text": "This removed check moved to middleware." }
  ]
}
```

- `line` uses the NEW-file number by default. Set `"side": "old"` for removed
  lines and use the OLD number.
- `to` makes the note cover a span; it's drawn after the last line.
- `kind` is one of `note`, `risk`, `question`, `decision`, or `praise`.
- Added files render as a single annotated column, deleted files as removed
  lines. Readers can expand unchanged context between hunks.

### `code`: an excerpt of any file at head

Use this for context the reader needs that isn't in the diff, such as the
caller of a changed function or a config the change depends on.

```json
{ "type": "code", "file": "src/server/middleware.ts", "lines": [12, 40], "summary": "Why the public route skips auth.",
  "annotations": [{ "line": 18, "text": "`/s/` is on the allowlist, so no session is required." }] }
```

### `compare`: side by side

```jsonc
{
  "type": "compare",
  "labels": ["Before", "After"],     // optional, defaults to Before / After
  "before": { /* block */ },          // or an array of blocks
  "after":  { /* block */ },
  "caption": "optional markdown",
  "stack": false                      // optional: force vertical stacking
}
```

Wide content (browser or desktop wireframes, screenshots, diffs, APIs) stacks
vertically automatically. Narrow content (popovers, panels, mobile, data
models, markdown) sits side by side. For more than two columns, use
`"columns": [{ "label": "Owner", "blocks": [...] }, …]` instead of
`before`/`after`.

### `tabs`

```json
{ "type": "tabs", "tabs": [ { "label": "Owner", "blocks": [ ... ] }, { "label": "Viewer", "blocks": [ ... ] } ] }
```

Use for alternative states of the same thing (roles, breakpoints, steps in a
flow) when stacking them would be too long.

### `wireframe`

```json
{ "type": "wireframe", "surface": "browser", "url": "app.example.com/projects/42", "height": 260,
  "html": "<div style='display:flex;flex-direction:column;gap:12px;padding:16px'>…</div>",
  "caption": "Layout inferred from `ProjectHeader.tsx`." }
```

| Field | Notes |
| --- | --- |
| `surface` | `browser` (with URL bar), `desktop`, `mobile`, `popover`, `panel`, or `bare` |
| `url` / `title` | Text for the browser bar (browser) or window title (desktop) |
| `height` | Minimum height in px. Defaults depend on the surface. Set it so the frame fits the content without a big empty band. |
| `skeleton` | `true` greys out text for loading states |

**Read `references/wireframes.md` before writing one.** It covers the HTML
vocabulary, `data-change` highlights, numbered `data-note` callouts, and the
icon set.

### `screenshot`

```json
{ "type": "screenshot", "src": "shots/after.png", "alt": "Share popover", "caption": "Captured from the dev server.", "width": 420 }
```

`src` is relative to the folder containing `recap.json` (not a URL). The image is embedded
in the HTML. Keep each under about 1 MB (crop to the relevant area, or use
JPEG or WebP). Put screenshots inside `compare` for before/after.

### `mermaid`

```json
{ "type": "mermaid", "caption": "How a token is resolved.",
  "source": ["sequenceDiagram", "  participant V as Visitor", "  V->>API: GET /s/:token", "  API-->>V: 200"] }
```

This is the full Mermaid library: `flowchart`, `sequenceDiagram`,
`stateDiagram-v2`, `erDiagram`, `classDiagram`, and `gantt`. It's themed
automatically for light and dark. It adds about 2.7 MB to the file, so use it
when a real diagram helps.

### `diagram`: hand-laid HTML diagram

```json
{ "type": "diagram", "caption": "…", "html": "<div class='dg-flow'>…</div>", "css": "optional extra CSS" }
```

**Read `references/diagrams.md`** for the `dg-*` primitives (nodes, panels,
arrows, lanes, change states). Use this for before/after architecture and
module maps. Prefer Mermaid for sequences and graphs that need automatic
layout.

### `dataModel`

```jsonc
{
  "type": "dataModel",
  "id": "schema",
  "entities": [
    {
      "name": "share_links", "change": "added", "note": "One row per link.",
      "fields": [
        { "name": "id", "type": "INTEGER", "pk": true },
        { "name": "project_id", "type": "INTEGER", "fk": "projects.id", "note": "ON DELETE CASCADE" },
        { "name": "token_hash", "type": "TEXT", "unique": true },
        { "name": "expires_at", "type": "TEXT", "nullable": true },
        { "name": "plan", "type": "TEXT", "change": "modified", "was": "INTEGER" },
        { "name": "legacy_token", "type": "TEXT", "change": "removed" },
        { "name": "owner_id", "type": "INTEGER", "change": "renamed", "was": "user_id" }
      ]
    }
  ],
  "relations": [{ "from": "share_links.project_id", "to": "projects.id", "change": "added" }]
}
```

`change` is one of `added`, `removed`, `modified`, `renamed`, or `unchanged`
(the default). Flags are `pk`, `fk` (true or `"table.col"`), `unique`, `index`,
and `nullable`. Include the unchanged fields of a modified entity that help the
reader orient. Leave out the rest.

### `api`

```jsonc
{
  "type": "api",
  "endpoints": [
    {
      "method": "POST", "path": "/projects/{id}/share-links", "change": "added", "auth": "owner",
      "summary": "Create a link. Returns the raw token once.",
      "md": "Optional longer markdown.",
      "params": [
        { "name": "id", "in": "path", "type": "integer", "required": true },
        { "name": "ttlDays", "in": "body", "type": "integer | null", "change": "modified", "was": "integer", "note": "…" }
      ],
      "request":   { "example": "{\"ttlDays\": 30}" },
      "responses": [
        { "status": 201, "label": "Created", "example": "{\"id\": 12, \"url\": \"/s/…\"}" },
        { "status": 403, "label": "Not an owner", "example": "{\"error\": \"forbidden\"}", "change": "added" }
      ],
      "deprecated": false
    }
  ]
}
```

Each `example` must be a single valid JSON value, given as a JSON string or as
a JSON object. It renders as a collapsible explorer; invalid JSON falls back to
plain text. Use one example per distinct response shape. `path` parameters
written as `{id}` or `:id` are highlighted. For removed endpoints set
`"change": "removed"`. For deprecated ones set `"deprecated": true` and
explain why in `md`.

### `states`: capability matrix

```jsonc
{
  "type": "states", "title": "Who can do what", "corner": "Action",
  "columns": ["Owner", "Editor", "Viewer"],
  "rows": [
    { "label": "Create share links", "cells": [{ "value": true, "was": false }, false, false] },
    { "label": "Rename", "cells": [true, true, false] },
    { "label": "Export", "cells": ["CSV only", { "value": "CSV, PDF", "was": "CSV" }, false] }
  ],
  "caption": "Highlighted cells changed."
}
```

A cell is `true` (shown as Yes), `false` (No), a markdown string, or
`{ "value", "was" }` to mark a change. `value` and `was` can each be any of the
other cell forms, for example `{ "value": false, "was": "If retriable" }`. Give
each row exactly one cell per column. Use it for permissions, feature flags,
plan tiers, and platform support.

## Common mistakes the build catches

- A `diff.file` that isn't in the change. The error suggests near matches.
- An annotation `line` that isn't visible in that diff. The error lists the
  valid ranges and tells you if the number exists on the other side.
- `keyChanges` with no annotations or no summary (warnings).
- Wireframe or diagram HTML containing a tag the page strips along with its
  contents: `<script>`, `<style>`, `<form>`, `<iframe>`, `<object>`,
  `<foreignObject>`, and similar (error). Hex colors or `font-family` in
  wireframes (warning).
- `questions`, `checks.verified`, and `checks.manual` in the wrong shape
  (error).
- Duplicate ids, or ids the page reserves (error). A focus ref to a built-in
  section that won't appear, like `#checks` when there are no checks (error).
- A `focus.ref` that points nowhere: an unknown path or `#id`, or a line past
  the end of the file.
- A `title` over 70 characters (warning).
- Screenshots that are missing or too large.

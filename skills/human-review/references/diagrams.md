# Diagrams

Two options:

- **`mermaid`**: automatic layout. Best for sequences (`sequenceDiagram`),
  flows with branches (`flowchart`), state machines (`stateDiagram-v2`), and
  entity relationships (`erDiagram`). It's themed to match the page.
- **`diagram`**: hand-laid HTML. Best for before/after architecture, module
  maps, "this moved from here to there", and layered or swimlane views where
  you want precise control. It's rendered in an isolated shadow root.

Both answer one question: how does it fit together now, and what's different?
Don't draw a diagram that just restates the file list.

## Mermaid tips

- Write `source` as an array of lines.
- Keep node labels short. Put detail in the caption.
- Use real names (functions, routes, tables) from the diff.
- For a change in flow, either draw the new flow and mark new steps with a
  `Note` or `classDef`, or put two Mermaid blocks in a `compare`.
- Use `alt`, `else`, and `opt` in sequence diagrams for error paths. Reviewers
  care about failure paths.

```json
{ "type": "mermaid", "caption": "New retry path. Steps 3–4 are new.", "source": [
  "flowchart LR",
  "  A[Request] --> B{2xx?}",
  "  B -- yes --> C[Return]",
  "  B -- no --> D[Backoff]:::added --> E[Retry ≤ 3]:::added --> B",
  "  classDef added stroke:#1b7a36,stroke-width:2px"
]}
```

## HTML diagram primitives

| Class | What it draws |
| --- | --- |
| `dg-node` | A box. Put `<b>Title</b><small>subtitle</small>` inside. |
| `dg-node added`, `removed`, `changed`, `muted`, `accent`, `store` | Change states: green, red and dashed with a struck title, highlighter yellow, dashed grey, link-colored border, or a datastore shape |
| `dg-panel` (`solid`) | A titled grouping box (dashed by default). Put a `dg-title` first. |
| `dg-title` | Small heading for a panel or lane |
| `dg-row` (`top`, `stretch`, `center`) | Horizontal flex row with gaps; wraps on narrow screens |
| `dg-col` | Vertical stack |
| `dg-grid` | CSS grid; set `style='--cols:3'` |
| `dg-flow` | Horizontal chain with an **arrow drawn automatically between children** |
| `dg-flow v` | Vertical chain with arrows |
| `dg-arrow` (`down`, `added`, `removed`, `dashed`) | An explicit arrow, with optional label text inside: `<span class='dg-arrow'>calls</span>` |
| `dg-lanes` and `dg-lane` | Swimlanes side by side, each with a `dg-title` |
| `dg-pill` (`added`, `removed`, `risk`) | Small tag |
| `dg-note` | Muted small text |

Page color tokens are available for the rare custom style: `var(--ink)`,
`--ink-2`, `--muted`, `--rule`, `--rule-strong`, `--surface`, `--sunken`,
`--add-ink`, `--add-wash`, `--del-ink`, `--del-wash`, `--marker`,
`--marker-wash`, `--risk`, and `--link`. Don't use hex colors or fonts. Set
`"frame": "hide"` to drop the outer border when the diagram sits inside
something else.

## Example: before and after architecture

```json
{
  "type": "compare",
  "before": { "type": "diagram", "html": [
    "<div class='dg-flow v'>",
    "  <div class='dg-node'><b>Web client</b><small>polls every 5s</small></div>",
    "  <div class='dg-node'><b>GET /events</b></div>",
    "  <div class='dg-node store'><b>events</b><small>Postgres</small></div>",
    "</div>"
  ]},
  "after": { "type": "diagram", "html": [
    "<div class='dg-flow v'>",
    "  <div class='dg-node changed'><b>Web client</b><small>subscribes once</small></div>",
    "  <div class='dg-node added'><b>/events/stream</b><small>SSE</small></div>",
    "  <div class='dg-row center'>",
    "    <div class='dg-node added'><b>EventBus</b><small>in-process</small></div>",
    "    <span class='dg-arrow'>LISTEN</span>",
    "    <div class='dg-node store'><b>events</b><small>Postgres NOTIFY</small></div>",
    "  </div>",
    "</div>"
  ]},
  "caption": "Polling is replaced by a server-sent event stream fed by Postgres LISTEN/NOTIFY."
}
```

## Example: layers with what moved

```json
{ "type": "diagram", "html": [
  "<div class='dg-lanes'>",
  "  <div class='dg-lane'><div class='dg-title'>Routes</div><div class='dg-node'><b>routes.ts</b></div></div>",
  "  <div class='dg-lane'><div class='dg-title'>Domain</div>",
  "    <div class='dg-node added'><b>shareLinks.ts</b><small>token lifecycle</small></div>",
  "    <div class='dg-node changed'><b>permissions.ts</b><small>+ canShare</small></div></div>",
  "  <div class='dg-lane'><div class='dg-title'>Data</div><div class='dg-node store added'><b>share_links</b></div></div>",
  "</div>"
]}
```

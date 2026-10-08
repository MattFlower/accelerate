# Wireframes

A wireframe is a small HTML mockup. **You write the content and layout; the
renderer owns the look.** It supplies the device frame, light and dark colors,
fonts, and an optional hand-drawn "sketch" style (readers can toggle Sketch or
Clean). Each wireframe renders in an isolated shadow root, so page styles don't
leak in and yours don't leak out.

Use wireframes when the diff changes what a user sees and you can't take a real
screenshot. Real screenshots (the `screenshot` block) are better evidence when
you can run the app.

## The vocabulary

Plain semantic HTML is styled automatically. Don't add classes for these:

`h1`–`h4`, `p`, `small`, `a`, `button`, `input`, `select`, `textarea`,
`input[type=checkbox]`, `label`, `hr`, `table`/`th`/`td`, `ul`/`ol`.

Don't use `<form>` (use a `<div>`), `<iframe>`, `<script>`, or `<style>`: the
page strips them along with everything inside, and the build rejects them.

Helper classes:

| Class | Use |
| --- | --- |
| `wf-card`, `wf-box` | Bordered, padded container: a panel, row, list item, or card |
| `wf-pill`, `wf-chip` | Rounded tag or filter. Add `accent`, `ok`, or `warn` for variants. |
| `wf-muted` | Secondary text |
| `wf-avatar` | 28px circle. Put initials inside if useful. |
| `wf-img` | Image placeholder (crossed box). Give it a height. |
| `wf-bar` | Neutral placeholder bar (for skeletons or "lots of text here") |
| `wf-toast` | Dark notification bubble |
| `button.primary`, `[data-primary]` | Filled primary button |
| `button.ghost`, `button.danger` | Borderless, or destructive |
| `data-rough` (attribute) | Give any element a sketched border in sketch mode |

Color tokens, for the rare custom color: `var(--wf-ink)`, `--wf-muted`,
`--wf-line`, `--wf-paper`, `--wf-card`, `--wf-accent`, `--wf-accent-fg`,
`--wf-accent-soft`, `--wf-warn`, `--wf-ok`, `--wf-radius`. **Never hard-code
hex colors or set `font-family`.** The tokens are what make the mockup work in
both themes, and the build warns on both.

## Showing what changed

These two attributes make the delta jump out. Use them on the "after" frame.

- `data-change="added"` draws a highlighter outline around the element.
  `"changed"` draws a dashed highlighter outline, and `"removed"` a dashed red
  one (use that on the before frame).
- `data-note="Markdown text"` drops a numbered pin on the element's corner and
  lists the note under the frame. Use one or two per frame, on the elements
  that changed, saying what and why.

```html
<button data-change='added' data-note='**Share** only renders for owners.'>
  <span data-icon='link'></span>Share
</button>
```

## Icons

Write an empty element with `data-icon`, and the renderer inserts a matching
line icon sized to the text:

```html
<button aria-label='More'><span data-icon='more'></span></button>
<label>Email<input value='dana@acme.co'></label>
```

Names: `mail`, `lock`, `search`, `plus`, `minus`, `x`, `check`, `chevronDown`,
`chevronUp`, `chevronLeft`, `chevronRight`, `dots` (`more`), `user`, `users`,
`settings`, `calendar`, `bell`, `send`, `edit`, `trash`, `arrowLeft`,
`arrowRight`, `arrowUp`, `arrowDown`, `home`, `star`, `heart`, `filter`,
`link`, `share`, `upload`, `download`, `image`, `file`, `folder`, `grid`,
`menu`, `clock`, `info`, `alert`, `eye`, `refresh`, `logout`, `globe`,
`sparkles` (`ai`), `play`, `pause`, `externalLink`, `copy`, `comment`.

Don't write the word "search" or "more" where the real UI shows an icon.

## Surfaces

Pick the surface that matches what the user actually sees:

| `surface` | For | Default min-height |
| --- | --- | --- |
| `browser` | A web page; draws a URL bar (set `url`) | 360px |
| `desktop` | A desktop app window or app shell (set `title` for a title bar) | 420px |
| `mobile` | A phone screen. Only when the change is actually mobile. | 720px |
| `popover` | Menus, dropdowns, popovers, command palettes | none |
| `panel` | Side panels, inspectors, dialogs, sheets | 460px |
| `bare` | Just the content, with no frame | none |

Set `height` to fit the content. A frame with a big empty bottom half reads as
broken.

For a small sub-surface such as a popover, menu, or dialog: if placement on the
page matters, show the page once, then show the sub-surface in its own
`popover` or `panel` wireframe. Don't redraw the whole page around it, and
never stretch a popover to page width.

## Layout rules

These keep mockups from looking cramped or broken:

1. **Pad the root.** The outermost element gets `padding:16px` (at least 14px)
   and `display:flex;flex-direction:column;gap:12px`. Nothing should touch the
   frame edge.
2. **Lay out with inline flex and grid**, using `gap` and `min-width:0`, and
   literal px values. No absolute positioning, negative margins, Tailwind
   classes, or CSS variables for spacing.
3. **Full-width bars.** Headers, toolbars, and tab bars are one flex row at
   `width:100%`, with a `<div style='flex:1'></div>` spacer pushing trailing
   actions to the right edge. Keep the spacer in both before and after so
   controls don't shift.
4. **Pin bottom bars.** Make the root `height:100%` with the body at `flex:1`,
   and put the bar last.
5. **Single-line labels stay single-line.** Use `white-space:nowrap` on
   toolbars, tabs, chips, and filenames, and shorten the copy rather than let
   it wrap.
6. **Real content.** Use real labels, counts, names, and button text from the
   diff and the surrounding UI code. No lorem ipsum or grey bars standing in
   for real UI (except skeleton states).
7. **No labels inside the frame.** "Before" and "After" belong in the
   `compare` labels, never baked into the mockup.
8. **No shadows.** Flat bordered surfaces only.

## Before and after

- Put both frames in a `compare` block. Browser and desktop frames stack
  vertically; popover, panel, and mobile frames sit side by side.
- **Modify, don't redesign.** Reproduce the current screen faithfully first,
  then change only the delta. Use the same frame, height, padding, and density
  in both. Unchanged controls stay put so the eye finds the difference.
- Put the new element exactly where the code puts it (the same header slot,
  the same position in the row).
- For flows, show the entry point, the opened surface, and the resulting
  state, in order, using `tabs` or several `compare` blocks. One before/after
  of the entry point isn't enough when the change adds a flow.
- For role-dependent UI, pair the wireframes with a `states` matrix.

## Example: a header gains a Share button and a status pill

```json
{
  "type": "compare",
  "before": { "type": "wireframe", "surface": "browser", "url": "teamboard.app/projects/42", "height": 200, "html": [
    "<div style='display:flex;flex-direction:column;gap:16px;padding:18px 22px'>",
    "  <div style='display:flex;align-items:center;gap:12px;width:100%'>",
    "    <h1>Q3 Launch Plan</h1><div style='flex:1'></div>",
    "    <button>Rename</button><button aria-label='More'><span data-icon='more'></span></button>",
    "  </div><hr>",
    "  <div style='display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px'>",
    "    <div class='wf-card'><h3>To do</h3></div><div class='wf-card'><h3>Doing</h3></div><div class='wf-card'><h3>Done</h3></div>",
    "  </div>",
    "</div>"
  ]},
  "after": { "type": "wireframe", "surface": "browser", "url": "teamboard.app/projects/42", "height": 200, "html": [
    "<div style='display:flex;flex-direction:column;gap:16px;padding:18px 22px'>",
    "  <div style='display:flex;align-items:center;gap:12px;width:100%'>",
    "    <h1>Q3 Launch Plan</h1>",
    "    <span class='wf-pill' data-change='added' data-note='Shown while any link is live.'>Shared by link</span>",
    "    <div style='flex:1'></div>",
    "    <button>Rename</button>",
    "    <button data-change='added' data-note='Owners only.'><span data-icon='link'></span>Share</button>",
    "    <button aria-label='More'><span data-icon='more'></span></button>",
    "  </div><hr>",
    "  <div style='display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px'>",
    "    <div class='wf-card'><h3>To do</h3></div><div class='wf-card'><h3>Doing</h3></div><div class='wf-card'><h3>Done</h3></div>",
    "  </div>",
    "</div>"
  ]},
  "caption": "Header as an owner sees it. Layout inferred from `ProjectHeader.tsx`."
}
```

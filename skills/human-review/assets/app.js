/* human-review renderer. Reads the inlined #hr-data payload and builds the page. */
(() => {
  "use strict";

  const root = document.getElementById("app");
  let DATA;
  try {
    DATA = JSON.parse(document.getElementById("hr-data").textContent);
  } catch (e) {
    root.innerHTML = `<pre class="err">Could not read the embedded review data: ${String(e)}</pre>`;
    return;
  }
  const { recap, diff, contents = {}, assets = {}, meta = {} } = DATA;
  const files = diff.files || [];
  const byPath = new Map(files.map((f) => [f.path, f]));
  const SVGNS = "http://www.w3.org/2000/svg";

  // ───────────────────────────────────────────── tiny DOM helpers

  function h(tag, props, ...kids) {
    const svg = tag.startsWith("svg:");
    const el = svg ? document.createElementNS(SVGNS, tag.slice(4)) : document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === "class") svg ? el.setAttribute("class", v) : (el.className = v);
        else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
        else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === "html") el.innerHTML = v;
        else if (k === "text") el.textContent = v;
        else if (k === "dataset") Object.assign(el.dataset, v);
        else if (v === true) el.setAttribute(k, "");
        else el.setAttribute(k, v);
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : String(kid));
    }
    return el;
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const plural = (n, w, p) => `${n} ${n === 1 ? w : p || w + "s"}`;
  const hash = (s) => {
    let x = 2166136261;
    for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619);
    return (x >>> 0).toString(36);
  };
  const splitPath = (p) => {
    const i = p.lastIndexOf("/");
    return i < 0 ? ["", p] : [p.slice(0, i + 1), p.slice(i + 1)];
  };

  const ICONS = {
    check: "M5 12l5 5L20 7",
    x: "M18 6L6 18M6 6l12 12",
    plus: "M12 5v14M5 12h14",
    chevronRight: "M9 6l6 6-6 6",
    chevronLeft: "M15 6l-6 6 6 6",
    chevronDown: "M6 9l6 6 6-6",
    chevronUp: "M6 15l6-6 6 6",
    comment: "M8 9h8M8 13h5M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-5l-5 3v-3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3z",
    risk: "M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
    question: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4M12 17h.01",
    note: "M4 20h4L18.5 9.5a2.8 2.8 0 0 0-4-4L4 16v4zM13.5 6.5l4 4",
    decision: "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9",
    praise: "M12 17.8l-6.2 3.2 1.2-6.9-5-4.9 6.9-1L12 2l3.1 6.2 6.9 1-5 4.9 1.2 6.9z",
    security: "M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4z",
    perf: "M13 3L4 14h7l-1 7 9-11h-7l1-7z",
    breaking: "M8.7 3h6.6L21 8.7v6.6L15.3 21H8.7L3 15.3V8.7zM12 8v4M12 16h.01",
    sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
    moon: "M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z",
    auto: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 3v18M12 7l4.5-2.5M12 12l7-3M12 17l6-1",
    menu: "M4 6h16M4 12h16M4 18h16",
    copy: "M9 9h11v11H9zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1",
    download: "M12 4v12M7 11l5 5 5-5M5 20h14",
    unfold: "M12 3v7M9 6l3-3 3 3M12 21v-7M9 18l3 3 3-3",
    wrap: "M4 6h16M4 12h13a3 3 0 0 1 0 6h-4M15 16l-2 2 2 2M4 18h5",
    list: "M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2",
    approve: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12l3 3 5-6",
    changes: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 8v4M12 16h.01",
    mark: "M9 15l-5 5h5l2-2M14 4l6 6-8 8-6-6 8-8z",
    trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
    // wireframe icon set
    mail: "M3 6h18v12H3zM3 7l9 6 9-6",
    lock: "M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3",
    search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5",
    dots: "M4.5 12h1M11.5 12h1M18.5 12h1",
    user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM5 21a7 7 0 0 1 14 0",
    users: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M16 3.5a4 4 0 0 1 0 7.5M18 14a6 6 0 0 1 4 7",
    settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1",
    calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
    bell: "M6 16v-5a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0",
    send: "M21 3L10 14M21 3l-7 18-4-7-7-4z",
    edit: "M4 20h4L18.5 9.5a2.8 2.8 0 0 0-4-4L4 16v4zM13.5 6.5l4 4",
    arrowLeft: "M19 12H5M11 6l-6 6 6 6",
    arrowRight: "M5 12h14M13 6l6 6-6 6",
    arrowUp: "M12 19V5M6 11l6-6 6 6",
    arrowDown: "M12 5v14M6 13l6 6 6-6",
    home: "M3 11l9-7 9 7M5 10v10h14V10",
    star: "M12 17.8l-6.2 3.2 1.2-6.9-5-4.9 6.9-1L12 2l3.1 6.2 6.9 1-5 4.9 1.2 6.9z",
    heart: "M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z",
    filter: "M4 5h16l-6 8v6l-4-2v-4z",
    link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
    share: "M4 12v7h16v-7M12 3v12M8 7l4-4 4 4",
    image: "M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01",
    file: "M6 3h8l4 4v14H6zM14 3v4h4",
    folder: "M3 6h6l2 2h10v11H3z",
    grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
    clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
    info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01",
    alert: "M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
    eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    refresh: "M20 11a8 8 0 0 0-14.9-3M4 4v4h4M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4",
    logout: "M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10",
    globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18",
    sparkles: "M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z",
    upload: "M4 16v4h16v-4M12 4v12M7 9l5-5 5 5",
    play: "M7 4l13 8-13 8z",
    pause: "M8 5v14M16 5v14",
    minus: "M5 12h14",
    externalLink: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  };
  const ICON_ALIASES = {
    email: "mail", password: "lock", add: "plus", close: "x", more: "dots", chevron: "chevronDown", caret: "chevronDown",
    dropdown: "chevronDown", delete: "trash", gear: "settings", avatar: "user", person: "user", notification: "bell",
    pencil: "edit", back: "arrowLeft", next: "arrowRight", warning: "alert", ai: "sparkles", magic: "sparkles", photo: "image",
    team: "users", time: "clock", web: "globe", external: "externalLink",
  };
  function icon(name, cls = "i") {
    const d = ICONS[ICON_ALIASES[name] || name] || ICONS.info;
    const s = document.createElementNS(SVGNS, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("class", cls);
    s.setAttribute("aria-hidden", "true");
    const p = document.createElementNS(SVGNS, "path");
    p.setAttribute("d", d);
    s.append(p);
    return s;
  }

  // ───────────────────────────────────────────── sanitizing + markdown

  const DROP_TAGS = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "LINK", "META", "BASE", "FORM", "FRAME", "FRAMESET", "ANIMATE", "SET", "ANIMATETRANSFORM", "ANIMATEMOTION", "FOREIGNOBJECT"]);
  const URL_ATTRS = new Set(["href", "src", "xlink:href", "action", "formaction", "srcset", "poster", "background"]);
  // Browsers ignore whitespace and control characters inside a URL scheme ("java\tscript:").
  const unsafeUrl = (v) => /^(javascript|vbscript|data:(?!image\/(png|jpe?g|gif|webp);))/i.test(v.replace(/[\u0000-\u0020\u007f-\u009f]+/g, ""));
  function sanitizeInto(container) {
    const walk = (node) => {
      for (const el of [...node.children]) {
        if (DROP_TAGS.has(el.tagName.toUpperCase().replace(/^SVG:/, ""))) {
          el.remove();
          continue;
        }
        for (const a of [...el.attributes]) {
          const n = a.name.toLowerCase();
          if (n.startsWith("on")) el.removeAttribute(a.name);
          else if (URL_ATTRS.has(n) && unsafeUrl(a.value)) el.removeAttribute(a.name);
        }
        walk(el);
      }
    };
    walk(container);
    return container;
  }
  function htmlFragment(html) {
    const t = document.createElement("template");
    t.innerHTML = html;
    sanitizeInto(t.content);
    return t.content;
  }

  const REF_RE = /^(.+?)(?::(\d+)(?:-(\d+))?)?$/;
  function parseRef(ref) {
    if (!ref) return null;
    if (ref.startsWith("#")) return { id: ref.slice(1) };
    const m = REF_RE.exec(ref);
    if (!m || !byPath.has(m[1])) return null;
    return { file: m[1], line: m[2] ? Number(m[2]) : null };
  }

  function linkifyRefs(el) {
    for (const code of el.querySelectorAll("code")) {
      if (code.closest("pre") || code.closest("a")) continue;
      const t = code.textContent.trim();
      if (!parseRef(t)) continue;
      const a = h("a", { href: "#", class: "hr-ref", dataset: { ref: t }, title: `Jump to ${t}` });
      code.replaceWith(a);
      a.append(code);
    }
    for (const a of el.querySelectorAll('a[href^="#"]')) {
      let ref;
      try {
        ref = decodeURIComponent(a.getAttribute("href").slice(1));
      } catch {
        continue;
      }
      if (parseRef(ref) && !document.getElementById(ref)) a.dataset.ref = ref;
    }
    for (const a of el.querySelectorAll('a[href^="http"]')) {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
  }

  function md(text, { inline = false, cls = "prose" } = {}) {
    const src = String(text ?? "");
    let html;
    try {
      html = window.marked ? (inline ? marked.parseInline(src, { gfm: true }) : marked.parse(src, { gfm: true, breaks: false })) : esc(src);
    } catch {
      html = esc(src);
    }
    const el = h(inline ? "span" : "div", { class: inline ? null : cls });
    el.append(htmlFragment(html));
    linkifyRefs(el);
    return el;
  }

  // ───────────────────────────────────────────── persistence

  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem(k);
        return v == null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch {
        /* storage unavailable — state lives for this page view only */
      }
    },
  };
  // Tied to the code under review, not to the recap's wording: rebuilding after a recap-only
  // edit keeps the reviewer's comments.
  const KEY = `hr:${hash([diff.repo, diff.base.sha, diff.head.sha, diff.fingerprint].join("|"))}`;
  const state = Object.assign({ comments: [], viewed: {}, checks: {}, verdict: null, general: "" }, store.get(KEY, {}));
  // Which agent findings the reviewer has chosen to see (see "agent findings" below).
  state.revealed = Object.assign({ all: false, files: {}, blocks: {} }, state.revealed || {});
  const save = () => {
    store.set(KEY, state);
    updateCounts();
  };
  const prefs = Object.assign(
    { mode: window.innerWidth >= 1180 ? "split" : "unified", wrap: true, sketch: true, findings: "after" },
    store.get("hr:prefs", {}),
  );
  const savePrefs = () => store.set("hr:prefs", prefs);
  // Side-by-side needs room; phones always get the unified layout.
  const narrowQuery = matchMedia("(max-width: 900px)");
  const narrow = () => narrowQuery.matches;

  // ───────────────────────────────────────────── file metadata

  // Review tiers. The agent marks a file "careful" or "skim"; "mechanical" (no new code) and
  // "generated" are computed by the CLI from the diff and carry a proof. The agent can raise
  // attention on an auto-tiered file but can't lower it.
  const TIER_ORDER = { careful: 0, skim: 1, mechanical: 2, generated: 3 };
  const TIER_LABEL = { careful: "Read closely", skim: "Skim", mechanical: "Mechanical", generated: "Generated" };
  const fileMeta = (p) => {
    const f = byPath.get(p);
    const m = (recap.files && recap.files[p]) || {};
    const chosen = m.review === "careful" || m.review === "skim" ? m.review : null;
    const auto = f && f.generated ? "generated" : f && f.mechanical ? "mechanical" : null;
    return {
      review: chosen || auto || "skim",
      proof: f && f.generated ? `Generated: ${f.generatedBy || "matches a generated-file pattern"}.` : f && f.mechanical ? f.mechanical.proof : "",
      note: m.note || "",
    };
  };
  const isAuto = (p) => TIER_ORDER[fileMeta(p).review] >= 2;
  const byTier = (a, b) => TIER_ORDER[fileMeta(a.path).review] - TIER_ORDER[fileMeta(b.path).review] || a.path.localeCompare(b.path);
  // Sources in tier order, each followed by its tests.
  const withTestsAfter = (list) => {
    const inList = new Set(list.map((f) => f.path));
    const out = [];
    for (const f of [...list].sort(byTier)) {
      if (f.testFor && inList.has(f.testFor)) continue;
      out.push(f, ...list.filter((t) => t.testFor === f.path).sort(byTier));
    }
    return out;
  };

  // Groups in reading order: the recap's concerns, then files no concern claimed, then the
  // proven-mechanical and generated files.
  const groups = (() => {
    const list = [];
    const placed = new Set();
    const make = (name, fs, extra = {}) => {
      fs.forEach((f) => placed.add(f.path));
      return { name, files: fs, adds: fs.reduce((x, f) => x + f.additions, 0), dels: fs.reduce((x, f) => x + f.deletions, 0), ...extra };
    };
    for (const c of Array.isArray(recap.concerns) ? recap.concerns : []) {
      if (!c || !Array.isArray(c.files)) continue;
      const fs = c.files.filter((p) => byPath.has(p) && !placed.has(p)).map((p) => byPath.get(p));
      if (fs.length) list.push(make(c.title || "Untitled", fs, { id: c.id, why: c.why || "" }));
    }
    const rest = files.filter((f) => !placed.has(f.path));
    const other = rest.filter((f) => !isAuto(f.path));
    if (other.length) list.push(make(list.length ? "Other changes" : "Changes", withTestsAfter(other)));
    const mech = rest.filter((f) => fileMeta(f.path).review === "mechanical").sort(byTier);
    if (mech.length) list.push(make("Mechanical changes", mech, { auto: "mechanical", why: "No new code in these files — each one's proof is shown under its name. Open a row to check it." }));
    const gen = rest.filter((f) => fileMeta(f.path).review === "generated").sort(byTier);
    if (gen.length) list.push(make("Generated files", gen, { auto: "generated" }));
    let c = 0;
    for (const g of list) {
      g.hatch = !!g.auto || g.files.every((f) => isAuto(f.path));
      g.color = g.hatch ? null : `var(--g${(c++ % 6) + 1})`;
    }
    return list;
  })();
  const orderedFiles = groups.flatMap((g) => g.files);
  const reviewable = orderedFiles.filter((f) => !isAuto(f.path));

  // ───────────────────────────────────────────── agent findings, after the reviewer's own pass
  //
  // Showing an AI's conclusions before a reviewer has formed their own anchors them on what it
  // flagged (Tufano et al., ICSE 2025). So the agent's findings — its risk read, risk/question/
  // praise notes, and risk/security/question callouts — stay collapsed until the reviewer has
  // viewed that file, or chooses to see them all. Explanatory notes stay visible.
  const FINDING_NOTES = new Set(["risk", "question", "praise"]);
  const FINDING_CALLOUTS = new Set(["risk", "security", "question"]);
  const holdFindings = () => prefs.findings !== "always" && !state.revealed.all;
  const fileFindingsHidden = (p) => holdFindings() && !state.revealed.files[p];
  const blockFindingHidden = (id) => holdFindings() && !state.revealed.blocks[id];
  const findingWatchers = new Set(); // redraw functions for held-back placeholders
  const notifyFindings = () => {
    for (const fn of findingWatchers) fn();
  };
  function revealFile(p) {
    state.revealed.files[p] = true;
    save();
    rerenderFile(p);
    notifyFindings();
  }
  function revealBlock(id) {
    state.revealed.blocks[id] = true;
    save();
    notifyFindings();
  }
  function revealAll() {
    state.revealed.all = true;
    save();
    rerenderAllDiffs();
    notifyFindings();
  }
  const RISK_KEY = "__risk"; // block ids start with a letter, so this can't collide
  // All findings, or with `stillHeld` only those not yet revealed.
  const countFindings = (stillHeld = false) => {
    let n = recap.risk && recap.risk.level && (!stillHeld || blockFindingHidden(RISK_KEY)) ? 1 : 0;
    const walk = (x) => {
      if (Array.isArray(x)) return x.forEach(walk);
      if (!x || typeof x !== "object") return;
      if (x.type === "callout" && FINDING_CALLOUTS.has(x.kind) && (!stillHeld || blockFindingHidden(x.id))) n++;
      if (Array.isArray(x.annotations) && (x.type === "diff" || x.type === "code" || !x.type) && (!stillHeld || fileFindingsHidden(x.file)))
        n += x.annotations.filter((a) => FINDING_NOTES.has(a.kind)).length;
      for (const v of Object.values(x)) if (v && typeof v === "object") walk(v);
    };
    walk(recap.sections);
    walk(recap.keyChanges);
    return n;
  };

  // ───────────────────────────────────────────── syntax highlighting + word diff

  const hlCache = new Map();
  function highlight(text, lang) {
    if (!text) return "";
    if (!lang || !window.hljs || !hljs.getLanguage(lang)) return esc(text);
    const k = lang + "\u0000" + text;
    let v = hlCache.get(k);
    if (v === undefined) {
      try {
        v = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
      } catch {
        v = esc(text);
      }
      if (hlCache.size > 20000) hlCache.clear();
      hlCache.set(k, v);
    }
    return v;
  }

  function changedRange(a, b) {
    // Common prefix / suffix → the differing middle of two similar lines.
    if (a === b) return null;
    let s = 0;
    const max = Math.min(a.length, b.length);
    while (s < max && a[s] === b[s]) s++;
    let e = 0;
    while (e < max - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
    const ra = [s, a.length - e];
    const rb = [s, b.length - e];
    const longest = Math.max(a.trim().length, b.trim().length) || 1;
    const diffLen = Math.max(ra[1] - ra[0], rb[1] - rb[0]);
    if (diffLen / longest > 0.7) return null; // mostly rewritten — marking adds noise
    return [ra, rb];
  }

  function markRange(el, [start, end], cls) {
    if (end <= start) return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const segs = [];
    let pos = 0;
    let node;
    while ((node = walker.nextNode())) {
      const len = node.nodeValue.length;
      const a = Math.max(start, pos);
      const b = Math.min(end, pos + len);
      if (a < b) segs.push([node, a - pos, b - pos]);
      pos += len;
      if (pos >= end) break;
    }
    for (const [n, a, b] of segs) {
      const r = document.createRange();
      r.setStart(n, a);
      r.setEnd(n, b);
      const m = document.createElement("mark");
      m.className = cls;
      r.surroundContents(m);
    }
  }

  // ───────────────────────────────────────────── diff model

  function hunksFor(file, blk) {
    let hunks = file.hunks.map((hk, i) => ({ ...hk, index: i }));
    if (blk && Array.isArray(blk.hunks)) hunks = blk.hunks.map((i) => hunks[i - 1]).filter(Boolean);
    if (blk && Array.isArray(blk.lines) && blk.lines.length === 2) {
      const [s, e] = blk.lines;
      hunks = hunks.filter((hk) => hk.newStart <= e && hk.newStart + Math.max(hk.newLines, 1) - 1 >= s);
    }
    return hunks;
  }

  function newText(p) {
    const t = contents[p];
    if (t == null) return null;
    const lines = t.split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines;
  }

  // Produce the row model: hunks interleaved with gaps.
  function rowModel(file, hunks, allHunks) {
    const rows = [];
    const lines = file.status === "deleted" ? null : newText(file.path);
    const total = lines ? lines.length : null;
    let prevEndNew = 0;
    let prevEndOld = 0;
    let prevIndex = -1;
    hunks.forEach((hk, k) => {
      const hidden = hk.index - prevIndex - 1; // hunks between this and the previous shown one
      // For an empty side (pure insert or delete), git's start is the line before it.
      const ns = hk.newLines === 0 ? hk.newStart + 1 : hk.newStart;
      const os = hk.oldLines === 0 ? hk.oldStart + 1 : hk.oldStart;
      const from = prevEndNew + 1;
      const to = ns - 1;
      if (to >= from || hidden > 0) {
        rows.push({
          kind: "gap",
          from,
          to,
          offset: os - ns,
          header: hk.header,
          hidden,
          expandable: !!lines && hidden === 0 && file.status !== "added",
          first: k === 0,
        });
      } else if (hk.header && k > 0) {
        rows.push({ kind: "gap", from, to: from - 1, header: hk.header, hidden: 0, expandable: false });
      }
      for (const l of hk.lines) rows.push({ kind: "line", ...l });
      prevEndNew = ns + hk.newLines - 1;
      prevEndOld = os + hk.oldLines - 1;
      prevIndex = hk.index;
    });
    const trailingHidden = allHunks.length - 1 - prevIndex;
    if (hunks.length && (trailingHidden > 0 || (total && prevEndNew < total))) {
      rows.push({
        kind: "gap",
        from: prevEndNew + 1,
        to: total ?? prevEndNew,
        offset: prevEndOld - prevEndNew,
        header: "",
        hidden: trailingHidden,
        expandable: !!lines && trailingHidden === 0 && file.status !== "added",
        tail: true,
      });
    }
    return { rows, lines };
  }

  // Pair runs of -/+ lines for side-by-side display.
  function splitPairs(rows) {
    const out = [];
    let i = 0;
    while (i < rows.length) {
      const r = rows[i];
      if (r.kind !== "line" || r.t === " ") {
        out.push(r.kind === "line" ? { kind: "pair", l: r, r: r } : r);
        i++;
        continue;
      }
      const dels = [];
      const adds = [];
      while (i < rows.length && rows[i].kind === "line" && rows[i].t === "-") dels.push(rows[i++]);
      while (i < rows.length && rows[i].kind === "line" && rows[i].t === "+") adds.push(rows[i++]);
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) out.push({ kind: "pair", l: dels[k] || null, r: adds[k] || null });
    }
    return out;
  }

  // ───────────────────────────────────────────── comments

  let uid = 0;
  const nextId = () => `c${Date.now().toString(36)}${(uid++).toString(36)}`;
  const lineComments = (file, side, line) =>
    state.comments.filter((c) => c.anchor.type === "line" && c.anchor.file === file && c.anchor.side === side && c.anchor.line === line);

  function noteEl(kind, body, { label, lineLabel, you, acts, side } = {}) {
    const k = you ? "you" : kind || "note";
    const names = { note: "Note", risk: "Risk", question: "Question", decision: "Decision", praise: "Nice", you: "Your comment" };
    return h(
      "div",
      { class: `note ${you ? "you" : `k-${k}`}${side ? ` side-${side}` : ""}` },
      acts,
      h("div", { class: "nk" }, icon(you ? "comment" : k), label || names[k] || "Note", lineLabel ? h("span", { class: "ln" }, lineLabel) : null),
      you ? h("div", { class: "txt", style: { whiteSpace: "pre-wrap" } }, body) : md(body, { cls: "" }),
    );
  }

  // `onInput` lets the owner keep a draft across re-renders; `focus` is true only when the
  // editor opens from a user action (so a background re-render never steals focus or scroll).
  function editor({ initial = "", placeholder = "Leave a comment for the author…", onSave, onCancel, onInput, focus = true }) {
    const ta = h("textarea", { placeholder, "aria-label": "Comment" });
    ta.value = initial;
    if (onInput) ta.addEventListener("input", () => onInput(ta.value));
    const doSave = () => {
      const v = ta.value.trim();
      if (v) onSave(v);
      else onCancel();
    };
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        doSave();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    });
    const el = h(
      "div",
      { class: "editor" },
      ta,
      h(
        "div",
        { class: "row" },
        h("span", { class: "hint" }, "⌘/Ctrl + Enter to save"),
        h("button", { class: "btn ghost", type: "button", onclick: onCancel }, "Cancel"),
        h("button", { class: "btn primary", type: "button", onclick: doSave }, "Save comment"),
      ),
    );
    if (focus) {
      const go = () => ta.isConnected && document.activeElement !== ta && ta.focus({ preventScroll: true });
      requestAnimationFrame(go);
      setTimeout(go, 60);
    }
    return el;
  }

  function commentView(c, side, onChange) {
    if (typeof side === "function") {
      onChange = side;
      side = null;
    }
    const acts = h(
      "span",
      { class: "acts" },
      h("button", { type: "button", onclick: () => onChange("edit") }, "Edit"),
      h("button", { type: "button", onclick: () => onChange("delete") }, "Delete"),
    );
    return noteEl("you", c.body, { you: true, acts, side });
  }

  function addComment(anchor, body) {
    // `blind`: written before the reviewer saw the agent's findings (for this file, or at all).
    const blind = anchor.type === "line" ? fileFindingsHidden(anchor.file) : holdFindings();
    state.comments.push({ id: nextId(), anchor, body, blind, at: new Date().toISOString() });
    save();
  }
  function updateComment(id, body) {
    const c = state.comments.find((x) => x.id === id);
    if (c) c.body = body;
    save();
  }
  function deleteComment(id) {
    state.comments = state.comments.filter((x) => x.id !== id);
    save();
  }

  // ───────────────────────────────────────────── diff view

  const liveDiffs = new Set();
  let diffSeq = 0;
  const MAX_ROWS = 900;

  function renderDiff(file, blk = {}, { headless = false } = {}) {
    const inst = {
      id: `d${++diffSeq}`,
      file,
      blk,
      expanded: new Set(),
      showAll: false,
      full: false,
      editing: null,
      draft: "", // unsaved text of a new line comment
      editDraft: null, // unsaved text while editing an existing comment
      focusEditor: false,
      dirty: false, // re-render when its (cached, detached) tab is shown again
      el: h("div", { class: "diff" }),
    };
    inst.render = () => drawDiff(inst, headless);
    inst.render();
    liveDiffs.add(inst);
    inst.el._inst = inst;
    return inst.el;
  }

  function annotationIndex(blk, hideFindings = false) {
    const map = new Map();
    const marked = new Map();
    const all = blk.annotations || [];
    const shown = hideFindings ? all.filter((a) => !FINDING_NOTES.has(a.kind)) : all;
    const held = all.length - shown.length;
    for (const a of shown) {
      const side = a.side === "old" ? "o" : "n";
      const end = Number.isInteger(a.to) && a.to >= a.line ? Math.min(a.to, a.line + 5000) : a.line;
      const key = `${side}${end}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(a);
      for (let x = a.line; x <= end; x++) marked.set(`${side}${x}`, a.kind || "note");
    }
    return { notes: map, marked, held };
  }

  // Placeholder for findings held back in one file. It doesn't say where they are.
  function heldBanner(n, onShow) {
    return h(
      "div",
      { class: "held" },
      icon("eye"),
      h("span", null, `${plural(n, "agent finding")} for this file ${n === 1 ? "is" : "are"} held back until you've reviewed it. Mark the file Viewed to compare notes, or `),
      h("button", { type: "button", class: "linklike", onclick: onShow }, "show now"),
      ".",
    );
  }

  function drawDiff(inst, headless) {
    const { file, blk } = inst;
    const index = annotationIndex(blk, fileFindingsHidden(file.path));
    const el = inst.el;
    el.textContent = "";
    el.classList.toggle("nowrap", !prefs.wrap);

    // Header
    if (!headless) {
      const [dir, base] = splitPath(file.path);
      const viewed = !!state.viewed[file.path];
      el.append(
        h(
          "div",
          { class: "diff-head" },
          h(
            "div",
            { class: "diff-path" },
            file.status === "renamed" && file.oldPath ? h("span", { class: "from" }, file.oldPath) : null,
            h("span", { class: "dir" }, dir),
            h("span", { class: "base" }, base),
          ),
          file.status !== "modified" ? h("span", { class: `chip ${file.status}` }, file.status) : null,
          h("span", { class: "spacer" }),
          h("span", { class: "counts" }, h("span", { class: "num-add" }, `+${file.additions}`), h("span", { class: "num-del" }, `−${file.deletions}`)),
          viewedToggle(file.path, viewed),
        ),
      );
      if (blk.summary) el.append(h("div", { class: "diff-summary" }, md(blk.summary, { cls: "" })));
      if (index.held) el.append(heldBanner(index.held, () => revealFile(file.path)));
    }

    if (file.binary) {
      el.append(h("div", { class: "diff-empty" }, "Binary file — no text diff."));
      return;
    }
    if (!file.hunks.length) {
      el.append(h("div", { class: "diff-empty" }, file.status === "renamed" ? "Renamed without content changes." : "No content changes."));
      return;
    }

    const allHunks = file.hunks.map((hk, i) => ({ ...hk, index: i }));
    const hunks = inst.showAll ? allHunks : hunksFor(file, blk);
    const { rows, lines } = rowModel(file, hunks, allHunks);
    const { notes, marked } = index;
    const lang = file.language;

    const single = file.status === "added" ? "new" : file.status === "deleted" ? "old" : null;
    const mode = single ? "single" : narrow() ? "unified" : blk.mode || prefs.mode;

    const table = h("table", { class: `code ${mode}` });
    const cols =
      mode === "split"
        ? ["num", "sign", "", "num", "sign", ""]
        : mode === "single"
          ? ["num", "sign", ""]
          : ["num", "num", "sign", ""];
    table.append(h("colgroup", null, cols.map((c) => h("col", { class: c || null }))));
    const tbody = h("tbody");
    table.append(tbody);
    const ncols = cols.length;

    let rendered = 0;
    let truncated = 0;

    const numCell = (side, num, cls) => {
      const td = h("td", { class: `n ${cls || ""}` });
      if (num == null) return td;
      td.append(String(num));
      const k = marked.get(`${side}${num}`);
      if (k) td.classList.add("marked", `k-${k}`);
      td.append(
        h(
          "button",
          {
            class: "plus",
            type: "button",
            tabindex: "-1",
            title: "Comment on this line",
            "aria-label": `Comment on line ${num}`,
            onclick: (e) => {
              e.stopPropagation();
              const side2 = side === "o" ? "old" : "new";
              if (inst.editing && (inst.editing.line !== num || inst.editing.side !== side2)) inst.draft = "";
              inst.editing = { side: side === "o" ? "old" : "new", line: num };
              inst.focusEditor = true;
              inst.render();
            },
          },
          icon("plus"),
        ),
      );
      return td;
    };
    const codeCell = (l, cls) => {
      const td = h("td", { class: `c ${cls || ""}` });
      if (l) td.innerHTML = highlight(l.s, lang) || "&#8203;";
      if (l && l.noeol) td.append(h("span", { class: "noeol", title: "No newline at end of file" }, "no newline at end of file"));
      return td;
    };
    const signCell = (t, cls) => h("td", { class: `s ${cls || ""}` }, t === " " ? "" : t === "-" ? "−" : t || "");

    // Lines the CLI paired with an identical line elsewhere in the change are dimmed; the first
    // line of each run says where it moved from or to.
    const lastMv = { o: null, n: null };
    const markMoved = (td, l, sideKey) => {
      if (!l || !l.mv) {
        lastMv[sideKey] = null;
        return;
      }
      const [kind, p, ln] = l.mv;
      const dir = l.t === "+" ? "from" : "to";
      const here = p === file.path;
      td.classList.add("mv");
      td.title = kind === "indent" ? "Same content, re-indented" : `Same content, moved ${dir} ${here ? `line ${ln}` : `${p}:${ln}`}`;
      const run = `${kind}|${p}`;
      if (lastMv[sideKey] !== run) td.append(h("span", { class: "mvtag" }, kind === "indent" ? "re-indented" : here ? `moved ${dir} line ${ln}` : `moved ${dir} ${splitPath(p)[1]}`));
      lastMv[sideKey] = run;
    };

    // The first editor built after a user action gets focus; re-renders don't.
    const takeFocus = () => {
      const f = inst.focusEditor;
      inst.focusEditor = false;
      return f;
    };
    const notesAfter = (keys, linesInRow) => {
      const out = [];
      for (const key of keys) {
        for (const a of notes.get(key) || []) {
          const side = key[0] === "o" ? "old" : "new";
          const lineLabel = a.to && a.to !== a.line ? `L${a.line}–${a.to}` : `L${a.line}${side === "old" ? " (old)" : ""}`;
          out.push(h("tr", { class: "note-row" }, h("td", { colspan: ncols }, noteEl(a.kind, a.text, { label: a.title, lineLabel, side: key[0] }))));
        }
      }
      for (const { side, line } of linesInRow) {
        for (const c of lineComments(file.path, side, line)) {
          if (inst.editingId === c.id) {
            out.push(
              h(
                "tr",
                { class: "note-row" },
                h(
                  "td",
                  { colspan: ncols },
                  h(
                    "div",
                    { class: `note you side-${side[0]}` },
                    editor({
                      initial: inst.editDraft ?? c.body,
                      focus: takeFocus(),
                      onInput: (v) => (inst.editDraft = v),
                      onSave: (v) => {
                        inst.editingId = null;
                        inst.editDraft = null;
                        updateComment(c.id, v);
                        rerenderFile(file.path);
                      },
                      onCancel: () => {
                        inst.editingId = null;
                        inst.editDraft = null;
                        inst.render();
                      },
                    }),
                  ),
                ),
              ),
            );
            continue;
          }
          out.push(
            h(
              "tr",
              { class: "note-row" },
              h(
                "td",
                { colspan: ncols },
                commentView(c, side[0], (act) => {
                  if (act === "delete") {
                    deleteComment(c.id);
                    rerenderFile(file.path);
                  } else {
                    inst.editingId = c.id;
                    inst.editDraft = null;
                    inst.focusEditor = true;
                    inst.render();
                  }
                }),
              ),
            ),
          );
        }
        if (inst.editing && inst.editing.side === side && inst.editing.line === line) {
          const src = rowsSource(side, line);
          out.push(
            h(
              "tr",
              { class: "note-row" },
              h(
                "td",
                { colspan: ncols },
                h(
                  "div",
                  { class: `note you side-${side[0]}` },
                  editor({
                    initial: inst.draft,
                    focus: takeFocus(),
                    onInput: (v) => (inst.draft = v),
                    onSave: (v) => {
                      inst.editing = null;
                      inst.draft = "";
                      addComment({ type: "line", file: file.path, side, line, code: src }, v);
                      rerenderFile(file.path);
                    },
                    onCancel: () => {
                      inst.editing = null;
                      inst.draft = "";
                      inst.render();
                    },
                  }),
                ),
              ),
            ),
          );
        }
      }
      return out;
    };
    const rowsSource = (side, line) => {
      for (const r of rows) if (r.kind === "line" && (side === "old" ? r.o : r.n) === line && (side === "old" ? r.t !== "+" : r.t !== "-")) return r.s;
      if (lines && side === "new") return lines[line - 1] ?? "";
      return "";
    };

    const lineRow = (l) => {
      const cls = l.t === "+" ? "add" : l.t === "-" ? "del" : "ctx";
      const tr = h("tr", { class: cls });
      if (l.n != null) tr.dataset.n = l.n;
      if (l.o != null) tr.dataset.o = l.o;
      const cc = codeCell(l);
      if (l.t === " ") lastMv.o = lastMv.n = null;
      else markMoved(cc, l, l.t === "-" ? "o" : "n");
      if (mode === "single") {
        const side = single === "new" ? "n" : "o";
        tr.append(numCell(side, single === "new" ? l.n : l.o), signCell(l.t), cc);
      } else {
        tr.append(numCell("o", l.t === "+" ? null : l.o), numCell("n", l.t === "-" ? null : l.n), signCell(l.t), cc);
        // The comment button belongs to one side in unified mode.
        if (l.t === " ") tr.children[0].querySelector(".plus")?.remove();
      }
      tbody.append(tr);
      const keys = [];
      const lr = [];
      if (l.t !== "+" && l.o != null && mode !== "single") keys.push(`o${l.o}`);
      if (l.t !== "-" && l.n != null) keys.push(`n${l.n}`);
      if (mode === "single" && single === "old") keys.push(`o${l.o}`);
      if (l.t === "-") lr.push({ side: "old", line: l.o });
      else lr.push({ side: "new", line: l.n });
      for (const r of notesAfter([...new Set(keys)], lr)) tbody.append(r);
    };

    const pairRow = (p) => {
      const { l, r } = p;
      const tr = h("tr");
      if (r && r.n != null) tr.dataset.n = r.n;
      if (l && l.o != null) tr.dataset.o = l.o;
      const ctx = l && r && l === r;
      const lc = !l ? "empty" : ctx ? "" : "del";
      const rc = !r ? "empty" : ctx ? "" : "add";
      const tdl = l ? codeCell(l, `${lc} split-l`) : h("td", { class: "c empty split-l" });
      const tdr = r ? codeCell(r, rc) : h("td", { class: "c empty" });
      if (l && r && !ctx) {
        const rng = changedRange(l.s, r.s);
        if (rng) {
          markRange(tdl, rng[0], "wd-del");
          markRange(tdr, rng[1], "wd-add");
        }
      }
      if (ctx) lastMv.o = lastMv.n = null;
      else {
        markMoved(tdl, l, "o");
        markMoved(tdr, r, "n");
      }
      tr.append(
        l ? numCell("o", l.o, lc) : h("td", { class: "n empty" }),
        h("td", { class: `s ${lc}` }, l && !ctx ? "−" : ""),
        tdl,
        r ? numCell("n", r.n, rc) : h("td", { class: "n empty" }),
        h("td", { class: `s ${rc}` }, r && !ctx ? "+" : ""),
        tdr,
      );
      if (ctx) tr.children[0].querySelector(".plus")?.remove();
      tbody.append(tr);
      const keys = [];
      const lr = [];
      if (l && !ctx) {
        keys.push(`o${l.o}`);
        lr.push({ side: "old", line: l.o });
      }
      if (r) {
        keys.push(`n${r.n}`);
        lr.push({ side: "new", line: r.n });
      }
      if (ctx && l.o != null) keys.unshift(`o${l.o}`);
      for (const row of notesAfter([...new Set(keys)], lr)) tbody.append(row);
    };

    const gapRow = (g) => {
      const count = Math.max(0, g.to - g.from + 1);
      const key = `${g.from}:${g.to}`;
      if (g.expandable && inst.expanded.has(key)) {
        for (let n = g.from; n <= g.to; n++) {
          const ctxLine = { t: " ", n, o: n + g.offset, s: lines[n - 1] ?? "" };
          if (mode === "split") pairRow({ kind: "pair", l: ctxLine, r: ctxLine });
          else lineRow(ctxLine);
        }
        return;
      }
      if (g.first && count === 0 && !g.header) return;
      if (g.tail && count === 0 && !g.hidden) return;
      const td = h("td", { class: "c", colspan: ncols - (mode === "split" ? 0 : 0) });
      const parts = [];
      if (g.hidden > 0) {
        parts.push(
          h(
            "button",
            {
              type: "button",
              onclick: () => {
                inst.showAll = true;
                inst.render();
              },
            },
            icon("unfold"),
            `${plural(g.hidden, "more change")} in this file — show all`,
          ),
        );
      } else if (g.expandable && count > 0) {
        parts.push(
          h(
            "button",
            {
              type: "button",
              onclick: () => {
                inst.expanded.add(key);
                inst.render();
              },
            },
            icon("unfold"),
            `Show ${plural(count, "unchanged line")}`,
          ),
        );
      } else if (count > 0) {
        parts.push(h("span", null, `${plural(count, "unchanged line")}`));
      }
      if (g.header) parts.push(h("span", { style: { marginLeft: parts.length ? "8px" : 0 } }, g.header));
      if (!parts.length) return;
      td.append(...parts);
      tbody.append(h("tr", { class: "hunk" }, td));
    };

    const model = mode === "split" ? splitPairs(rows) : rows;
    for (const r of model) {
      if (!inst.full && rendered > MAX_ROWS) {
        if (r.kind !== "gap") truncated++;
        continue;
      }
      if (r.kind === "gap") gapRow(r);
      else if (r.kind === "pair") pairRow(r);
      else lineRow(r);
      rendered++;
    }

    // Keyboard: one tab stop per table (the first + button); arrow keys move between lines.
    const pluses = table.querySelectorAll(".plus");
    if (pluses.length) pluses[0].tabIndex = 0;
    table.addEventListener("keydown", (e) => {
      if (!e.target.classList || !e.target.classList.contains("plus") || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
      const all = [...table.querySelectorAll(".plus")];
      const next = all[all.indexOf(e.target) + (e.key === "ArrowDown" ? 1 : -1)];
      if (!next) return;
      e.preventDefault();
      e.target.tabIndex = -1;
      next.tabIndex = 0;
      next.focus();
    });

    el.classList.toggle("split", mode === "split");
    el.append(h("div", { class: "diff-scroll" }, table));
    if (truncated) {
      el.append(
        h(
          "div",
          { class: "diff-more" },
          `${plural(truncated, "more line")} not shown.`,
          h(
            "button",
            {
              type: "button",
              onclick: () => {
                inst.full = true;
                inst.render();
              },
            },
            "Show everything",
          ),
        ),
      );
    }
  }

  function viewedToggle(p, viewed) {
    const id = `v-${hash(p)}-${Math.random().toString(36).slice(2, 7)}`;
    return h(
      "label",
      { class: "chip", for: id, style: { cursor: "pointer", gap: "6px" }, title: "Mark this file as reviewed" },
      h("input", {
        id,
        type: "checkbox",
        checked: viewed,
        style: { margin: 0, accentColor: "var(--praise)" },
        onchange: (e) => setViewed(p, e.target.checked),
      }),
      "Viewed",
    );
  }

  // Diffs in cached tab panels are detached from the document; they re-render when shown.
  function refresh(inst) {
    if (inst.el.isConnected) {
      inst.dirty = false;
      inst.render();
    } else inst.dirty = true;
  }

  function setViewed(p, v) {
    if (v) {
      state.viewed[p] = true;
      state.revealed.files[p] = true; // reviewed it: now compare with what the agent found
      // Every file read: the reviewer's own pass is done, so the rest (risk read, callouts) opens too.
      if (reviewable.every((f) => state.viewed[f.path])) state.revealed.all = true;
    } else delete state.viewed[p];
    save();
    notifyFindings();
    if (state.revealed.all) rerenderAllDiffs();
    for (const inst of liveDiffs) if (inst.file.path === p) refresh(inst);
    for (const box of document.querySelectorAll(`[data-viewed="${CSS.escape(p)}"]`)) box.checked = v;
    for (const row of document.querySelectorAll(`.frow[data-path="${CSS.escape(p)}"]`)) row.classList.toggle("is-viewed", v);
    renderSideFiles();
  }

  function rerenderFile(p) {
    for (const inst of liveDiffs) if (inst.file.path === p) refresh(inst);
    renderSideFiles();
  }
  function rerenderAllDiffs() {
    for (const inst of liveDiffs) refresh(inst);
  }

  // `code` blocks: an excerpt of a file at head (changed or not).
  function renderCode(b) {
    const wrap = h("div", { class: "diff" });
    const draw = () => drawCode(b, wrap);
    if ((b.annotations || []).some((a) => FINDING_NOTES.has(a.kind))) findingWatchers.add(draw);
    draw();
    return wrap;
  }
  function drawCode(b, wrap) {
    wrap.textContent = "";
    const text = contents[b.file];
    const [dir, base] = splitPath(b.file);
    wrap.append(
      h(
        "div",
        { class: "diff-head" },
        h("div", { class: "diff-path" }, h("span", { class: "dir" }, dir), h("span", { class: "base" }, base)),
        b.lines ? h("span", { class: "chip" }, `lines ${b.lines[0]}–${b.lines[1]}`) : null,
        byPath.has(b.file) ? null : h("span", { class: "chip" }, "unchanged"),
      ),
    );
    if (b.summary) wrap.append(h("div", { class: "diff-summary" }, md(b.summary, { cls: "" })));
    const hide = fileFindingsHidden(b.file);
    const { notes, marked, held } = annotationIndex(b, hide);
    if (held) wrap.append(heldBanner(held, () => revealFile(b.file)));
    if (text == null) {
      wrap.append(h("div", { class: "diff-empty" }, "File contents were not embedded."));
      return wrap;
    }
    const all = text.split("\n");
    if (all[all.length - 1] === "") all.pop();
    const [s, e] = b.lines || [1, all.length];
    const lang = b.language || (byPath.get(b.file) || {}).language;
    const table = h("table", { class: "code single" }, h("colgroup", null, h("col", { class: "num" }), h("col", { class: "sign" }), h("col")));
    const tbody = h("tbody");
    table.append(tbody);
    for (let n = s; n <= e; n++) {
      const k = marked.get(`n${n}`);
      tbody.append(
        h(
          "tr",
          { class: "ctx", dataset: { n } },
          h("td", { class: `n ${k ? `marked k-${k}` : ""}` }, String(n)),
          h("td", { class: "s" }),
          h("td", { class: "c", html: highlight(all[n - 1], lang) || "&#8203;" }),
        ),
      );
      for (const a of notes.get(`n${n}`) || []) {
        tbody.append(h("tr", { class: "note-row" }, h("td", { colspan: 3 }, noteEl(a.kind, a.text, { label: a.title, lineLabel: a.to && a.to !== a.line ? `L${a.line}–${a.to}` : `L${a.line}` }))));
      }
    }
    wrap.append(h("div", { class: "diff-scroll" + (prefs.wrap ? "" : " nowrap") }, table));
  }


  // ───────────────────────────────────────────── wireframes

  const WF_CSS = `
:host { display:block; --wf-ink: var(--ink); --wf-muted: var(--muted); --wf-line: var(--rule-strong); --wf-paper: var(--surface);
  --wf-card: color-mix(in srgb, var(--sunken) 55%, var(--surface)); --wf-accent: var(--g1); --wf-accent-fg: #fff;
  --wf-accent-soft: color-mix(in srgb, var(--g1) 18%, var(--surface)); --wf-warn: var(--risk); --wf-ok: var(--praise);
  --wf-radius: 8px; --wf-hl: var(--marker); --wf-sketch: color-mix(in srgb, var(--ink) 62%, var(--surface)); }
*, *::before, *::after { box-sizing: border-box; }
.screen { position: relative; font: 14px/1.45 var(--sans); color: var(--wf-ink); background: var(--wf-paper); min-height: var(--min-h, 0); height: 100%; overflow: hidden; }
.screen > :first-child { min-height: inherit; }
h1, h2, h3, h4 { margin: 0; line-height: 1.25; font-weight: 650; }
h1 { font-size: 21px; } h2 { font-size: 17px; } h3 { font-size: 15px; } h4 { font-size: 14px; }
p { margin: 0; }
small, .wf-muted { color: var(--wf-muted); } small { font-size: 12px; }
a { color: var(--wf-accent); text-decoration: none; }
button { font: inherit; font-size: 13.5px; padding: 6px 12px; border: 1.5px solid var(--wf-line); border-radius: var(--wf-radius); background: var(--wf-paper); color: var(--wf-ink); white-space: nowrap; display: inline-flex; align-items: center; justify-content: center; gap: 6px; cursor: default; }
button.primary, [data-primary] { background: var(--wf-accent); color: var(--wf-accent-fg); border-color: var(--wf-accent); }
button.ghost { border-color: transparent; background: transparent; }
button.danger { color: var(--wf-warn); border-color: color-mix(in srgb, var(--wf-warn) 50%, var(--wf-line)); }
input, select, textarea { font: inherit; font-size: 13.5px; padding: 7px 10px; border: 1.5px solid var(--wf-line); border-radius: var(--wf-radius); background: var(--wf-paper); color: var(--wf-ink); width: 100%; min-width: 0; }
textarea { min-height: 70px; resize: none; }
input[type=checkbox], input[type=radio] { width: 16px; height: 16px; padding: 0; margin: 0; accent-color: var(--wf-accent); flex: none; }
label { display: flex; flex-direction: column; gap: 5px; font-size: 13px; color: var(--wf-muted); }
label:has(> input[type=checkbox]), label:has(> input[type=radio]) { flex-direction: row; align-items: center; gap: 8px; color: var(--wf-ink); }
hr { border: 0; border-top: 1.5px solid var(--wf-line); margin: 2px 0; width: 100%; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { border-bottom: 1.5px solid var(--wf-line); padding: 7px 8px; text-align: left; }
th { color: var(--wf-muted); font-weight: 600; font-size: 12px; }
ul, ol { margin: 0; padding-left: 18px; }
.wf-card, .wf-box { border: 1.5px solid var(--wf-line); border-radius: calc(var(--wf-radius) + 2px); padding: 12px; background: var(--wf-card); }
.wf-pill, .wf-chip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 10px; border: 1.5px solid var(--wf-line); border-radius: 999px; font-size: 12px; white-space: nowrap; line-height: 18px; }
.wf-pill.accent, .wf-chip.accent { background: var(--wf-accent); color: var(--wf-accent-fg); border-color: var(--wf-accent); }
.wf-pill.ok { color: var(--wf-ok); border-color: color-mix(in srgb, var(--wf-ok) 50%, var(--wf-line)); }
.wf-pill.warn { color: var(--wf-warn); border-color: color-mix(in srgb, var(--wf-warn) 50%, var(--wf-line)); }
.wf-avatar { width: 28px; height: 28px; border-radius: 50%; background: var(--wf-accent-soft); flex: none; display: inline-grid; place-items: center; font-size: 11px; font-weight: 700; color: var(--wf-accent); }
.wf-img { position: relative; min-height: 64px; border: 1.5px solid var(--wf-line); border-radius: var(--wf-radius); background:
  linear-gradient(to top right, transparent calc(50% - 0.75px), var(--wf-line) 50%, transparent calc(50% + 0.75px)),
  linear-gradient(to bottom right, transparent calc(50% - 0.75px), var(--wf-line) 50%, transparent calc(50% + 0.75px)), var(--wf-card); }
.wf-bar { height: 8px; border-radius: 4px; background: var(--wf-line); }
.wf-toast { border: 1.5px solid var(--wf-line); border-radius: var(--wf-radius); padding: 8px 12px; background: var(--wf-ink); color: var(--wf-paper); font-size: 13px; }
.wf-icon { width: 1.1em; height: 1.1em; stroke: currentColor; fill: none; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; vertical-align: -0.18em; flex: none; }
[data-icon] { display: inline-flex; }
[data-change] { position: relative; }
[data-change="added"] { outline: 2.5px solid var(--wf-hl); outline-offset: 3px; border-radius: var(--wf-radius); }
[data-change="changed"], [data-change="modified"] { outline: 2.5px dashed var(--wf-hl); outline-offset: 3px; border-radius: var(--wf-radius); }
[data-change="removed"] { outline: 2px dashed var(--wf-warn); outline-offset: 3px; border-radius: var(--wf-radius); opacity: 0.75; }
.skel * { color: transparent !important; }
.sk { position: absolute; inset: 0; pointer-events: none; overflow: visible; color: var(--wf-sketch); }
.pins { position: absolute; inset: 0; pointer-events: none; }
.pin { position: absolute; width: 19px; height: 19px; border-radius: 50%; background: var(--wf-hl); color: #3d3000; font: 700 11px/19px var(--sans); text-align: center; transform: translate(-50%, -50%); }
.sketch { font-family: "HR Sketch", var(--sans); }
.sketch button, .sketch input, .sketch select, .sketch textarea { font-family: "HR Sketch", var(--sans); }
.sketch .wf-card, .sketch .wf-box, .sketch button, .sketch input:not([type=checkbox]):not([type=radio]), .sketch select, .sketch textarea,
.sketch .wf-pill, .sketch .wf-chip, .sketch .wf-img, .sketch [data-rough] { border-color: transparent !important; }
.sketch hr { border-top-color: transparent; }
.sketch th, .sketch td { border-bottom-color: transparent; }
`;
  const SKETCH_TARGETS = ".wf-card, .wf-box, button, input:not([type=checkbox]):not([type=radio]), select, textarea, .wf-pill, .wf-chip, .wf-img, [data-rough]";
  const liveWireframes = new Set();

  function decorateIcons(rootEl) {
    for (const el of rootEl.querySelectorAll("[data-icon]")) {
      if (el.querySelector("svg.wf-icon")) continue;
      el.append(icon(el.dataset.icon, "wf-icon"));
      if (!el.getAttribute("aria-label") && !el.textContent.trim()) el.setAttribute("aria-hidden", "true");
    }
  }

  function renderWireframe(b) {
    const surface = b.surface || "browser";
    const fig = h("figure", { class: "wf" });
    const frame = h("div", { class: `wf-frame ${surface}` });
    if (surface === "browser") frame.append(h("div", { class: "wf-chrome" }, h("i"), h("i"), h("i"), h("div", { class: "url" }, b.url || b.title || "")));
    if (surface === "desktop" && (b.title || b.url)) frame.append(h("div", { class: "wf-chrome" }, h("i"), h("i"), h("i"), h("div", { class: "url" }, b.title || b.url)));
    const host = h("div", { class: "wf-host" });
    frame.append(host);
    fig.append(frame);

    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = WF_CSS;
    const minH = { browser: "360px", desktop: "420px", mobile: "720px", panel: "460px" }[surface] || "0";
    const screen = h("div", { class: `screen${b.skeleton ? " skel" : ""}`, style: { "--min-h": b.height ? `${b.height}px` : minH } });
    screen.style.setProperty("--min-h", b.height ? `${b.height}px` : minH);
    screen.append(htmlFragment(b.html || ""));
    decorateIcons(screen);
    const sk = document.createElementNS(SVGNS, "svg");
    sk.setAttribute("class", "sk");
    const pins = h("div", { class: "pins" });
    screen.append(sk, pins);
    shadow.append(style, screen);

    const notes = [...screen.querySelectorAll("[data-note]")];
    if (notes.length) {
      fig.append(
        h(
          "ol",
          { class: "wf-legend" },
          notes.map((n, i) => h("li", null, h("span", { class: "pin" }, String(i + 1)), md(n.dataset.note, { inline: true }))),
        ),
      );
    }
    if (b.caption) fig.append(h("figcaption", { class: "cap" }, md(b.caption, { cls: "" })));

    const inst = { screen, sk, pins, notes, frame, seed: (parseInt(hash(b.id || b.html || ""), 36) % 2 ** 31) + 1 };
    inst.draw = () => drawSketch(inst);
    liveWireframes.add(inst);
    const ro = new ResizeObserver(() => inst.draw());
    ro.observe(screen);
    return fig;
  }

  function roundedRectPath(x, y, w, h2, r) {
    r = Math.max(0, Math.min(r, w / 2, h2 / 2));
    return `M${x + r},${y} H${x + w - r} A${r},${r} 0 0 1 ${x + w},${y + r} V${y + h2 - r} A${r},${r} 0 0 1 ${x + w - r},${y + h2} H${x + r} A${r},${r} 0 0 1 ${x},${y + h2 - r} V${y + r} A${r},${r} 0 0 1 ${x + r},${y} Z`;
  }

  function drawSketch(inst) {
    const { screen, sk, pins, notes } = inst;
    sk.textContent = "";
    pins.textContent = "";
    const box = screen.getBoundingClientRect();
    if (!box.width) return;
    sk.setAttribute("width", box.width);
    sk.setAttribute("height", box.height);
    sk.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
    const sketch = prefs.sketch && !!window.rough;
    screen.classList.toggle("sketch", sketch);

    notes.forEach((n, i) => {
      const r = n.getBoundingClientRect();
      const x = Math.min(Math.max(r.right - box.left - 2, 12), box.width - 12);
      const y = Math.min(Math.max(r.top - box.top + 2, 12), box.height - 12);
      pins.append(h("span", { class: "pin", style: { left: `${x}px`, top: `${y}px` } }, String(i + 1)));
    });

    if (!sketch) return;
    const rc = rough.svg(sk);
    let seed = inst.seed;
    const opts = () => ({ roughness: 1.1, bowing: 0.7, stroke: "currentColor", strokeWidth: 1.25, seed: (seed = (seed * 48271) % 2147483647), disableMultiStroke: false });
    for (const el of screen.querySelectorAll(SKETCH_TARGETS)) {
      if (el.closest(".pins")) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const x = r.left - box.left + 0.5;
      const y = r.top - box.top + 0.5;
      const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
      const node = radius > 4 ? rc.path(roundedRectPath(x, y, r.width - 1, r.height - 1, radius), opts()) : rc.rectangle(x, y, r.width - 1, r.height - 1, opts());
      sk.append(node);
    }
    for (const el of screen.querySelectorAll("hr, th, td")) {
      const r = el.getBoundingClientRect();
      if (r.width < 2) continue;
      const y = (el.tagName === "HR" ? r.top : r.bottom) - box.top;
      sk.append(rc.line(r.left - box.left, y, r.right - box.left, y, { ...opts(), roughness: 0.9 }));
    }
  }
  const redrawWireframes = () => {
    for (const w of liveWireframes) if (w.screen.isConnected) w.draw();
  };

  // ───────────────────────────────────────────── diagrams + mermaid

  const DG_CSS = `
:host { display: block; }
*, *::before, *::after { box-sizing: border-box; }
.dg { font: 13.5px/1.45 var(--sans); color: var(--ink); }
.dg p { margin: 0; }
.dg-row { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; }
.dg-row.top { align-items: flex-start; } .dg-row.stretch { align-items: stretch; } .dg-row.center { justify-content: center; }
.dg-col { display: flex; flex-direction: column; gap: 12px; }
.dg-grid { display: grid; grid-template-columns: repeat(var(--cols, 2), minmax(0, 1fr)); gap: 16px; }
.dg-node { position: relative; border: 1.5px solid var(--rule-strong); border-radius: 8px; padding: 8px 12px; background: var(--surface); min-width: 0; }
.dg-node b, .dg-node strong { font-weight: 650; }
.dg-node small, .dg-node .sub { display: block; color: var(--muted); font-size: 12px; }
.dg-node code, .dg code { font-family: var(--mono); font-size: 12px; }
.dg-node.added { border-color: var(--add-ink); background: var(--add-wash); }
.dg-node.removed { border-color: var(--del-ink); border-style: dashed; background: var(--del-wash); color: var(--ink-2); }
.dg-node.removed > b, .dg-node.removed > strong { text-decoration: line-through; }
.dg-node.changed, .dg-node.modified { border-color: color-mix(in srgb, var(--marker) 85%, var(--ink)); background: var(--marker-wash); }
.dg-node.muted { border-style: dashed; color: var(--muted); background: transparent; }
.dg-node.accent { border-color: var(--link); }
.dg-node.store { border-radius: 8px 8px 14px 14px / 8px 8px 10px 10px; }
.dg-panel { border: 1.5px dashed var(--rule-strong); border-radius: 12px; padding: 14px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.dg-panel.solid { border-style: solid; background: var(--sunken); }
.dg-title { font-size: 12.5px; font-weight: 650; color: var(--muted); }
.dg-pill { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border-radius: 99px; border: 1px solid var(--rule-strong); font-size: 11.5px; color: var(--ink-2); white-space: nowrap; }
.dg-pill.added { color: var(--add-ink); border-color: var(--add-ink); } .dg-pill.removed { color: var(--del-ink); border-color: var(--del-ink); }
.dg-pill.risk { color: var(--risk); border-color: var(--risk); }
.dg-note { font-size: 12px; color: var(--muted); }
.wf-icon { width: 1.1em; height: 1.1em; stroke: currentColor; fill: none; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; vertical-align: -0.18em; flex: none; }
.dg-arrow { display: inline-flex; flex-direction: column; align-items: center; justify-content: center; min-width: 56px; gap: 2px; color: var(--ink-2); font-size: 11.5px; flex: none; }
.dg-arrow::after { content: ""; display: block; width: 100%; min-width: 48px; height: 10px;
  background: linear-gradient(currentColor, currentColor) left center / calc(100% - 7px) 1.5px no-repeat;
  -webkit-mask: none; position: relative; }
.dg-arrow::before { content: ""; order: 2; align-self: flex-end; width: 0; height: 0; margin-top: -10px;
  border-left: 8px solid currentColor; border-top: 5px solid transparent; border-bottom: 5px solid transparent; }
.dg-arrow.down { min-width: 0; min-height: 34px; flex-direction: row; align-items: stretch; }
.dg-arrow.down::after { width: 10px; min-width: 0; height: auto; min-height: 28px; order: 1;
  background: linear-gradient(currentColor, currentColor) center top / 1.5px calc(100% - 7px) no-repeat; }
.dg-arrow.down::before { order: 2; align-self: flex-end; margin: 0 0 0 -10px;
  border-top: 8px solid currentColor; border-left: 5px solid transparent; border-right: 5px solid transparent; border-bottom: 0; }
.dg-arrow.added { color: var(--add-ink); } .dg-arrow.removed { color: var(--del-ink); opacity: 0.8; } .dg-arrow.dashed::after { opacity: 0.6; }
.dg-flow { display: flex; align-items: center; gap: 44px; flex-wrap: nowrap; }
.dg-flow > * { position: relative; }
.dg-flow > * + *::before { content: ""; position: absolute; right: calc(100% + 14px); top: 50%; width: 22px; height: 0; border-top: 1.5px solid var(--ink-2); }
.dg-flow > * + *::after { content: ""; position: absolute; right: calc(100% + 6px); top: 50%; width: 0; height: 0; transform: translateY(-50%);
  border-left: 8px solid var(--ink-2); border-top: 5px solid transparent; border-bottom: 5px solid transparent; }
.dg-flow.v { flex-direction: column; align-items: stretch; gap: 36px; }
.dg-flow.v > * + *::before { right: auto; left: 50%; top: auto; bottom: calc(100% + 12px); width: 0; height: 18px; border-top: 0; border-left: 1.5px solid var(--ink-2); transform: translateX(-0.75px); }
.dg-flow.v > * + *::after { right: auto; left: 50%; top: auto; bottom: calc(100% + 5px); transform: translateX(-5px);
  border-top: 8px solid var(--ink-2); border-left: 5px solid transparent; border-right: 5px solid transparent; border-bottom: 0; }
.dg-lanes { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 0; border: 1.5px solid var(--rule); border-radius: 12px; overflow: hidden; }
.dg-lane { padding: 12px; display: flex; flex-direction: column; gap: 10px; border-left: 1.5px solid var(--rule); }
.dg-lane:first-child { border-left: 0; }
.dg-lane > .dg-title { padding-bottom: 6px; border-bottom: 1px solid var(--rule); }
`;
  function renderDiagram(b) {
    const wrap = h("div", { class: `diagram${b.frame === "hide" ? " bare" : ""}` });
    const host = h("div");
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = DG_CSS + (b.css || "").replace(/<\/?style>/gi, "");
    const dg = h("div", { class: "dg" });
    dg.append(htmlFragment(b.html || ""));
    decorateIcons(dg);
    shadow.append(style, dg);
    wrap.append(host);
    return b.caption ? h("figure", { class: "wf" }, wrap, h("figcaption", { class: "cap" }, md(b.caption, { cls: "" }))) : wrap;
  }

  const liveMermaid = new Set();
  let mermaidReady = false;
  let mseq = 0;
  function mermaidTheme() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    const dark = cs.colorScheme === "dark" || document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      fontFamily: v("--sans"),
      themeVariables: {
        darkMode: dark,
        background: v("--surface"),
        primaryColor: v("--surface"),
        primaryTextColor: v("--ink"),
        primaryBorderColor: v("--rule-strong"),
        secondaryColor: v("--sunken"),
        tertiaryColor: v("--sunken"),
        lineColor: v("--ink-2"),
        textColor: v("--ink"),
        mainBkg: v("--surface"),
        nodeBorder: v("--rule-strong"),
        clusterBkg: v("--sunken"),
        clusterBorder: v("--rule-strong"),
        edgeLabelBackground: v("--surface"),
        noteBkgColor: v("--marker-wash"),
        noteBorderColor: v("--marker"),
        noteTextColor: v("--ink"),
        actorBkg: v("--surface"),
        actorBorder: v("--rule-strong"),
        signalColor: v("--ink-2"),
        fontSize: "14px",
      },
    });
    mermaidReady = true;
  }
  function renderMermaid(b) {
    const host = h("div", { class: "mermaid-host" });
    const wrap = h("div", { class: `diagram${b.frame === "hide" ? " bare" : ""}` }, host);
    const inst = { b, host };
    inst.draw = async () => {
      if (!window.mermaid) {
        host.replaceChildren(h("pre", { class: "mermaid-error" }, b.source));
        return;
      }
      if (!mermaidReady) mermaidTheme();
      try {
        const { svg } = await mermaid.render(`mmd${++mseq}`, b.source);
        host.innerHTML = svg;
      } catch (e) {
        host.replaceChildren(h("pre", { class: "mermaid-error" }, `Mermaid could not render this diagram:\n${e.message || e}\n\n${b.source}`));
      }
    };
    liveMermaid.add(inst);
    queueMicrotask(() => inst.draw());
    return b.caption ? h("figure", { class: "wf" }, wrap, h("figcaption", { class: "cap" }, md(b.caption, { cls: "" }))) : wrap;
  }
  function redrawMermaid() {
    if (!liveMermaid.size || !window.mermaid) return;
    mermaidTheme();
    for (const m of liveMermaid) m.draw();
  }

  // ───────────────────────────────────────────── data model, API, JSON, states

  function changeChip(c) {
    if (!c || c === "unchanged") return null;
    return h("span", { class: `chip ${c}` }, c);
  }

  function renderDataModel(b) {
    const grid = h("div", { class: "dm" });
    for (const e of b.entities) {
      const card = h("div", { class: `entity ${e.change || ""}` });
      card.append(h("header", null, h("span", { class: "nm" }, e.name), e.was ? h("span", { class: "chip renamed" }, `was ${e.was}`) : null, h("span", { class: "spacer" }), changeChip(e.change)));
      if (e.note) card.append(h("div", { class: "en" }, md(e.note, { inline: true })));
      const t = h("table");
      for (const f of e.fields || []) {
        const flags = [];
        if (f.pk) flags.push("PK");
        if (f.fk) flags.push("FK");
        if (f.unique) flags.push("UQ");
        if (f.index) flags.push("IDX");
        if (f.nullable) flags.push("NULL");
        t.append(
          h(
            "tr",
            { class: `${f.change || ""}${f.note ? " has-note" : ""}` },
            h("td", { class: "f" }, f.name),
            h("td", { class: "t" }, f.was && f.change !== "renamed" ? h("span", { class: "was" }, f.was) : null, h("span", { class: f.was ? "now" : "" }, f.type || ""), f.was && f.change === "renamed" ? h("span", { class: "fn" }, `renamed from ${f.was}`) : null),
            h("td", { class: "flags" }, flags.map((x) => h("span", { class: "flag", title: { PK: "Primary key", FK: f.fk && typeof f.fk === "string" ? `References ${f.fk}` : "Foreign key", UQ: "Unique", IDX: "Indexed", NULL: "Nullable" }[x] }, x))),
          ),
        );
        if (f.note) t.append(h("tr", { class: `fnote ${f.change || ""}` }, h("td", { colspan: 3 }, md(f.note, { inline: true }))));
      }
      card.append(t);
      grid.append(card);
    }
    const out = h("div", null, grid);
    if (b.relations && b.relations.length) {
      out.append(
        h(
          "div",
          { class: "relations" },
          b.relations.map((r) => h("span", { class: r.change || "" }, `${r.from} → ${r.to}${r.label ? `  ${r.label}` : ""}`)),
        ),
      );
    }
    return out;
  }

  function jsonView(value) {
    let v = value;
    if (typeof v === "string") {
      try {
        v = JSON.parse(v);
      } catch {
        return h("pre", { class: "json", style: { margin: 0, whiteSpace: "pre-wrap" } }, value);
      }
    }
    const leaf = (x) => {
      if (x === null) return h("span", { class: "z" }, "null");
      if (typeof x === "string") return h("span", { class: "s" }, JSON.stringify(x));
      if (typeof x === "number") return h("span", { class: "n" }, String(x));
      if (typeof x === "boolean") return h("span", { class: "b" }, String(x));
      return h("span", null, String(x));
    };
    const node = (x, key, depth, last) => {
      const k = key != null ? [h("span", { class: "k" }, typeof key === "number" ? "" : JSON.stringify(key)), typeof key === "number" ? "" : ": "] : [];
      const comma = last ? "" : ",";
      if (x && typeof x === "object") {
        const arr = Array.isArray(x);
        const entries = arr ? x.map((v2, i) => [i, v2]) : Object.entries(x);
        if (!entries.length) return h("div", { class: "leaf" }, k, arr ? "[]" : "{}", comma);
        const d = h("details", { open: depth < 3 });
        d.append(h("summary", null, k, arr ? "[" : "{", h("span", { class: "sum" }, ` ${arr ? plural(entries.length, "item") : plural(entries.length, "key")} `)));
        d.append(h("div", { class: "kids" }, entries.map(([kk, vv], i) => node(vv, kk, depth + 1, i === entries.length - 1))));
        d.append(h("div", null, arr ? "]" : "}", comma));
        return d;
      }
      return h("div", { class: "leaf" }, k, leaf(x), comma);
    };
    return h("div", { class: "json" }, node(v, null, 0, true));
  }

  function renderApi(b) {
    const list = h("div", { class: "api" });
    for (const e of b.endpoints) {
      const method = String(e.method).toUpperCase();
      const pathEl = h("span", { class: "path" });
      String(e.path)
        .split(/(\{[^}]+\}|:[A-Za-z_]+)/)
        .forEach((part) => pathEl.append(/^(\{|:)/.test(part) ? h("span", { class: "p" }, part) : part));
      const card = h("div", { class: `endpoint ${e.change || ""} ${e.deprecated ? "deprecated" : ""}` });
      card.append(h("header", null, h("span", { class: `method ${method}` }, method), pathEl, changeChip(e.change), e.deprecated ? h("span", { class: "chip removed" }, "deprecated") : null, e.auth ? h("span", { class: "chip" }, e.auth) : null));
      if (e.summary || e.md) card.append(h("div", { class: "es" }, e.summary ? md(e.summary, { cls: "" }) : null, e.md ? md(e.md, { cls: "" }) : null));
      if (e.params && e.params.length) {
        card.append(
          h(
            "div",
            { class: "part" },
            h("h5", null, "Parameters"),
            h(
              "table",
              { class: "params" },
              e.params.map((p) =>
                h(
                  "tr",
                  { class: p.change || "" },
                  h("td", { class: "pn" }, p.name, p.required ? h("span", { class: "req", title: "Required" }, "required") : null),
                  h("td", { class: "pi" }, p.in || ""),
                  h("td", { class: "pt" }, p.was ? h("span", { class: "was" }, p.was) : null, p.type || ""),
                  h("td", null, p.change && p.change !== "unchanged" ? changeChip(p.change) : null, p.note ? md(p.note, { inline: true }) : null),
                ),
              ),
            ),
          ),
        );
      }
      const examples = [];
      if (e.request) examples.push({ label: e.request.label || "Request body", status: null, change: e.request.change, example: e.request.example, note: e.request.note });
      for (const r of e.responses || []) examples.push({ label: r.label || "", status: r.status, change: r.change, example: r.example, note: r.note });
      if (examples.length) {
        const stCls = (s) => (String(s).startsWith("2") ? "ok" : /^[45]/.test(String(s)) ? "bad" : "");
        const panel = h("div", { class: "ex-panel" });
        const show = (i) => {
          const x = examples[i];
          for (const [j, b2] of [...bar.children].entries()) b2.setAttribute("aria-selected", String(i === j));
          panel.replaceChildren(
            x.note || x.change ? h("div", { class: "ex-note" }, changeChip(x.change), x.note ? md(x.note, { inline: true }) : null) : "",
            x.example !== undefined ? jsonView(x.example) : h("div", { class: "ex-empty" }, "No body"),
          );
        };
        const bar = h(
          "div",
          { class: "ex-tabs", role: "tablist" },
          examples.map((x, i) =>
            h(
              "button",
              { type: "button", role: "tab", onclick: () => show(i) },
              x.status != null ? h("span", { class: `st ${stCls(x.status)}` }, String(x.status)) : null,
              x.label || (x.status == null ? "Request" : ""),
            ),
          ),
        );
        card.append(h("div", { class: "part" }, h("h5", null, e.request ? "Request and responses" : "Responses"), h("div", { class: "example" }, bar, panel)));
        show(0);
      }
      list.append(card);
    }
    return list;
  }

  function renderStates(b) {
    const t = h("table");
    t.append(h("thead", null, h("tr", null, h("th", null, b.corner || ""), b.columns.map((c) => h("th", null, c)))));
    const tb = h("tbody");
    for (const r of b.rows) {
      const cells = r.cells || [];
      tb.append(
        h(
          "tr",
          null,
          h("th", { scope: "row" }, md(r.label, { inline: true })),
          b.columns.map((_, i) => {
            let c = cells[i];
            let was;
            let changedCell = false;
            if (c && typeof c === "object") {
              was = c.was;
              changedCell = c.was !== undefined || !!c.changed;
              c = c.value;
            }
            const show = (x) => (x === true ? [icon("check"), "Yes"] : x === false ? [icon("minus"), "No"] : x == null ? "" : md(String(x), { inline: true }));
            return h(
              "td",
              { class: `${c === true ? "yes" : c === false ? "no" : ""} ${changedCell ? "changed" : ""}` },
              show(c),
              was !== undefined ? h("span", { class: "was" }, was === true ? "was: yes" : was === false ? "was: no" : `was: ${was}`) : null,
            );
          }),
        ),
      );
    }
    t.append(tb);
    return h("div", { class: "states" }, t);
  }

  function renderScreenshot(b) {
    const src = assets[b.src];
    if (!src) return h("div", { class: "diff-empty" }, `Missing screenshot ${b.src}`);
    const img = h("img", { src, alt: b.alt || b.caption || "Screenshot", loading: "lazy" });
    if (b.width) img.style.width = `${b.width}px`;
    return h(
      "figure",
      { class: "shot" },
      h(
        "button",
        {
          type: "button",
          title: "View full size",
          onclick: () => {
            const lb = h("div", { class: "lightbox", onclick: () => lb.remove(), role: "dialog", "aria-label": "Screenshot" }, h("img", { src, alt: b.alt || "" }));
            document.body.append(lb);
          },
        },
        img,
      ),
      b.caption ? h("figcaption", { class: "cap" }, md(b.caption, { cls: "" })) : null,
    );
  }

  // ───────────────────────────────────────────── block dispatcher

  const blockLabels = new Map();
  function labelFor(b, ctx) {
    const names = { markdown: "Notes", callout: b.title || "Callout", diff: b.file, code: b.file, compare: "Before / after", tabs: "Tabs", wireframe: b.caption || b.title || "Wireframe", screenshot: b.caption || b.src, mermaid: b.caption || "Diagram", diagram: b.caption || "Diagram", dataModel: "Data model", api: "API", states: b.title || "States" };
    let l = names[b.type] || b.type;
    if (typeof l === "string" && l.length > 80) l = l.slice(0, 77) + "…";
    return ctx ? `${ctx} › ${l}` : l;
  }

  function renderBlock(b, ctx) {
    let el;
    switch (b.type) {
      case "markdown":
        el = md(b.md);
        break;
      case "callout": {
        const k = b.kind || "note";
        const names = { risk: "Risk", breaking: "Breaking change", decision: "Decision", note: "Note", question: "Question", security: "Security", perf: "Performance" };
        const full = () => h("div", { class: `callout k-${k}` }, icon(k), h("div", null, h("div", { class: "ct" }, h("span", { class: "kind" }, names[k] || k), b.title || ""), b.md ? md(b.md) : null));
        if (!FINDING_CALLOUTS.has(k)) {
          el = full();
          break;
        }
        el = h("div");
        const draw = () =>
          el.replaceChildren(
            blockFindingHidden(b.id)
              ? h("div", { class: "held" }, icon("eye"), h("span", null, "An agent finding is held back here until you've formed your own view, or "), h("button", { type: "button", class: "linklike", onclick: () => revealBlock(b.id) }, "show it now"), ".")
              : full(),
          );
        findingWatchers.add(draw);
        draw();
        break;
      }
      case "diff": {
        const f = byPath.get(b.file);
        el = f ? renderDiff(f, b) : h("div", { class: "diff-empty" }, `Missing file ${b.file}`);
        break;
      }
      case "code":
        el = renderCode(b);
        break;
      case "compare": {
        const cols = b.columns
          ? b.columns.map((c) => ({ label: c.label, blocks: c.blocks, cls: "" }))
          : [
              { label: (b.labels && b.labels[0]) || "Before", blocks: [].concat(b.before ?? []), cls: "before" },
              { label: (b.labels && b.labels[1]) || "After", blocks: [].concat(b.after ?? []), cls: "after" },
            ];
        const wide = cols.some((c) => c.blocks.some((x) => (x.type === "wireframe" && ["browser", "desktop"].includes(x.surface || "browser")) || x.type === "diff" || x.type === "screenshot" || x.type === "api"));
        el = h("div", { class: `compare${wide || b.stack ? " stack" : ""}`, style: { "--cols": cols.length } });
        el.style.setProperty("--cols", cols.length);
        for (const c of cols) {
          el.append(h("div", { class: `col ${c.cls}` }, h("h4", null, c.label), h("div", { class: "blocks" }, c.blocks.map((x) => renderBlock(x, `${ctx ? ctx + " › " : ""}${c.label}`)))));
        }
        if (b.caption) el = h("div", null, el, h("div", { class: "cap" }, md(b.caption, { cls: "" })));
        break;
      }
      case "tabs":
        el = renderTabs(
          b.tabs.map((t) => ({ label: t.label, blocks: t.blocks || [t.block], render: () => h("div", { class: "blocks" }, (t.blocks || [t.block]).map((x) => renderBlock(x, `${ctx ? ctx + " › " : ""}${t.label}`))) })),
        );
        break;
      case "wireframe":
        el = renderWireframe(b);
        break;
      case "screenshot":
        el = renderScreenshot(b);
        break;
      case "mermaid":
        el = renderMermaid(b);
        break;
      case "diagram":
        el = renderDiagram(b);
        break;
      case "dataModel":
        el = renderDataModel(b);
        break;
      case "api":
        el = renderApi(b);
        break;
      case "states":
        el = renderStates(b);
        break;
      default:
        el = h("div", { class: "diff-empty" }, `Unknown block type ${b.type}`);
    }
    const label = labelFor(b, ctx);
    blockLabels.set(b.id, label);
    const wrap = h("div", { class: "blk", id: b.id, dataset: { type: b.type } });
    if (b.title && b.type !== "callout") wrap.append(h("h3", { class: "blk-title" }, b.title));
    wrap.append(el);
    if (b.type === "states" && b.caption) wrap.append(h("div", { class: "cap" }, md(b.caption, { cls: "" })));
    if (!["compare", "tabs", "diff"].includes(b.type)) attachBlockComments(wrap, b.id, label);
    return wrap;
  }

  function attachBlockComments(wrap, id, label) {
    const notes = h("div", { class: "blk-notes" });
    let editing = null;
    let draft = null; // unsaved editor text, kept across redraws (e.g. a delete from the drawer)
    let focusNext = false;
    const takeFocus = () => {
      const f = focusNext;
      focusNext = false;
      return f;
    };
    const draw = () => {
      notes.textContent = "";
      for (const c of state.comments.filter((x) => x.anchor.type === "block" && x.anchor.id === id)) {
        if (editing === c.id) {
          notes.append(
            h(
              "div",
              { class: "note you" },
              editor({
                initial: draft ?? c.body,
                focus: takeFocus(),
                onInput: (v) => (draft = v),
                onSave: (v) => {
                  editing = null;
                  draft = null;
                  updateComment(c.id, v);
                  draw();
                },
                onCancel: () => {
                  editing = null;
                  draft = null;
                  draw();
                },
              }),
            ),
          );
        } else
          notes.append(
            commentView(c, (act) => {
              if (act === "delete") deleteComment(c.id);
              else {
                editing = c.id;
                draft = null;
                focusNext = true;
              }
              draw();
            }),
          );
      }
      if (editing === "new") {
        notes.append(
          h(
            "div",
            { class: "note you" },
            editor({
              initial: draft ?? "",
              focus: takeFocus(),
              onInput: (v) => (draft = v),
              onSave: (v) => {
                editing = null;
                draft = null;
                addComment({ type: "block", id, label }, v);
                draw();
              },
              onCancel: () => {
                editing = null;
                draft = null;
                draw();
              },
            }),
          ),
        );
      }
    };
    wrap.prepend(
      h(
        "button",
        {
          class: "btn icon blk-comment",
          type: "button",
          title: "Comment on this",
          "aria-label": `Comment on ${label}`,
          onclick: () => {
            if (editing !== "new") draft = null;
            editing = "new";
            focusNext = true;
            draw();
          },
        },
        icon("comment"),
      ),
    );
    wrap.append(notes);
    wrap._drawNotes = draw;
    draw();
  }

  // block id → the tabs element and index that render it (for #id jumps into unopened tabs)
  const tabHome = new Map();
  const blockIds = (b, out = []) => {
    if (!b || typeof b !== "object") return out;
    if (b.id) out.push(b.id);
    for (const v of Object.values(b)) {
      if (Array.isArray(v)) v.forEach((x) => blockIds(x, out));
      else if (v && typeof v === "object") blockIds(v, out);
    }
    return out;
  };
  let tabSeq = 0;
  function renderTabs(tabs, { cls = "", onSelect } = {}) {
    const id = `t${++tabSeq}`;
    const el = h("div", { class: `tabs ${cls}` });
    const list = h("div", { class: "tablist", role: "tablist" });
    const panel = h("div", { class: "tabpanel", role: "tabpanel", id: `${id}-panel` });
    const cache = new Map();
    const buttons = tabs.map((t, i) =>
      h(
        "button",
        {
          type: "button",
          role: "tab",
          id: `${id}-tab-${i}`,
          "aria-controls": `${id}-panel`,
          "aria-selected": "false",
          title: t.title || null,
          onclick: () => select(i),
          onkeydown: (e) => {
            if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
              e.preventDefault();
              const j = (i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
              select(j);
              buttons[j].focus();
            }
          },
        },
        t.labelEl || t.label,
      ),
    );
    list.append(...buttons);
    function select(i) {
      buttons.forEach((b, j) => {
        b.setAttribute("aria-selected", String(i === j));
        b.tabIndex = i === j ? 0 : -1;
      });
      if (!cache.has(i)) cache.set(i, tabs[i].render());
      panel.replaceChildren(cache.get(i));
      for (const d of panel.querySelectorAll(".diff")) {
        if (d._inst && d._inst.dirty) {
          d._inst.dirty = false;
          d._inst.render();
        }
      }
      panel.setAttribute("aria-labelledby", `${id}-tab-${i}`);
      el.dataset.active = i;
      requestAnimationFrame(redrawWireframes);
      onSelect && onSelect(i);
    }
    el.append(list, panel);
    el._select = select;
    tabs.forEach((t, i) => {
      for (const id of blockIds(t.blocks || [])) if (!tabHome.has(id)) tabHome.set(id, { tabs: el, index: i });
    });
    el._panelFor = (i) => {
      if (!cache.has(i)) cache.set(i, tabs[i].render());
      return cache.get(i);
    };
    select(0);
    return el;
  }

  // ───────────────────────────────────────────── page sections

  const sectionsForToc = [];
  let keyTabs = null;
  let keyBlocks = [];

  const shortRef = (r) => (/^[0-9a-f]{12,40}$/.test(r) ? r.slice(0, 10) : r);
  function renderHero() {
    const totalAdd = files.reduce((a, f) => a + f.additions, 0);
    const totalDel = files.reduce((a, f) => a + f.deletions, 0);
    const commits = diff.commits || [];
    const hero = h("header", { class: "hero", id: "top" });

    if (meta.stale) hero.append(h("div", { class: "stale" }, "The code has changed since this review was built. Ask the agent to rebuild it before relying on it."));

    const commitList = h("ul", { class: "commits", hidden: true }, commits.map((c) => h("li", null, h("code", null, c.sha), h("span", null, c.subject), h("span", { class: "who" }, c.author))));
    const crumbs = h(
      "div",
      { class: "crumbs" },
      h("span", null, diff.repo),
      h(
        "span",
        { class: "refs" },
        h("span", { class: "ref", title: diff.base.sha }, shortRef(diff.base.ref), /^[0-9a-f]{7,40}$/.test(diff.base.ref) ? null : h("small", null, diff.base.sha.slice(0, 7))),
        icon("arrowRight"),
        h("span", { class: "ref", title: diff.head.sha }, diff.head.ref, h("small", null, diff.head.worktree ? "working tree" : diff.head.sha.slice(0, 7))),
      ),
      commits.length
        ? h(
            "button",
            {
              class: "linklike",
              type: "button",
              "aria-expanded": "false",
              onclick: (e) => {
                commitList.hidden = !commitList.hidden;
                e.currentTarget.setAttribute("aria-expanded", String(!commitList.hidden));
              },
            },
            plural(commits.length, "commit"),
          )
        : null,
      diff.pr ? h("a", { href: diff.pr.url, target: "_blank", rel: "noopener" }, `Pull request #${diff.pr.number}`) : null,
    );
    const h1 = h("h1", { id: "hr-title" });
    h1.append(md(recap.title || "Untitled review", { inline: true }));
    hero.append(crumbs, h1);
    if (recap.brief) hero.append(h("div", { class: "lede" }, md(recap.brief, { inline: true })));
    hero.append(commitList);

    // Footprint: where the weight of the change sits
    const total = groups.reduce((a, g) => a + g.adds + g.dels, 0) || 1;
    const bar = h(
      "div",
      { class: "footprint", role: "img", "aria-label": groups.map((g) => `${g.name}: ${g.adds + g.dels} lines`).join(", ") },
      groups.map((g) => h("span", { class: g.hatch ? "hatch" : "", style: { flexGrow: String(Math.max(g.adds + g.dels, total * 0.012)), background: g.color || "" }, title: `${g.name} · ${plural(g.files.length, "file")} · +${g.adds} −${g.dels}` })),
    );
    const legend = h(
      "div",
      { class: "legend" },
      groups.map((g) => h("span", null, h("i", { class: g.hatch ? "hatch" : "", style: { background: g.color || "" } }), g.name, h("small", null, `${g.files.length} · ${g.adds + g.dels}`))),
    );
    const left = h(
      "div",
      null,
      h(
        "div",
        { class: "footprint-label" },
        h("strong", null, plural(files.length, "file")),
        h("span", { class: "num-add" }, `+${totalAdd}`),
        h("span", { class: "num-del" }, `−${totalDel}`),
        reviewable.length !== files.length ? h("span", null, `${reviewable.length} to read, ${files.length - reviewable.length} mechanical or generated`) : null,
      ),
      bar,
      legend,
    );
    const facts = h("div", { class: "facts" }, left);
    if (recap.risk && ["low", "medium", "high"].includes(recap.risk.level)) {
      const lv = recap.risk.level;
      const slot = h("div");
      const draw = () =>
        slot.replaceChildren(
          blockFindingHidden(RISK_KEY)
            ? h("div", { class: "risk held-risk" }, h("span", { class: "level" }, "Agent's risk read"), h("span", null, "Held back until you've formed your own. ", h("button", { type: "button", class: "linklike", onclick: () => revealBlock(RISK_KEY) }, "Show it")))
            : h("div", { class: `risk ${lv}` }, h("span", { class: "level" }, `${lv[0].toUpperCase()}${lv.slice(1)} risk`), recap.risk.why ? md(recap.risk.why, { inline: true }) : null),
        );
      findingWatchers.add(draw);
      draw();
      facts.append(slot);
    }
    hero.append(facts);
    if (countFindings()) {
      const notice = h("div");
      const draw = () => {
        const held = countFindings(true);
        if (!holdFindings() || !held) return notice.replaceChildren();
        notice.replaceChildren(
          h(
            "div",
            { class: "held-notice" },
            icon("eye"),
            h(
              "div",
              null,
              h("strong", null, "Your read first. "),
              `The agent's ${plural(held, "finding")} (its risk read, the lines it flagged, and its risk callouts) ${held === 1 ? "is" : "are"} held back so ${held === 1 ? "it doesn't" : "they don't"} steer where you look. Each file's findings appear when you mark it Viewed.`,
              h(
                "div",
                { class: "held-actions" },
                h("button", { type: "button", class: "btn", onclick: revealAll }, "Show all findings now"),
                h(
                  "button",
                  {
                    type: "button",
                    class: "btn ghost",
                    onclick: () => {
                      prefs.findings = "always";
                      savePrefs();
                      rerenderAllDiffs();
                      notifyFindings();
                    },
                  },
                  "Always show them",
                ),
              ),
            ),
          ),
        );
      };
      findingWatchers.add(draw);
      draw();
      hero.append(notice);
    }
    return hero;
  }

  function renderOverview() {
    const summary = recap.summary || [];
    const focus = recap.focus || [];
    if (!summary.length && !focus.length) return null;
    sectionsForToc.push({ id: "overview", title: "Overview" });
    const el = h("section", { class: "overview", id: "overview" });
    if (summary.length) el.append(h("div", null, h("h3", null, "What changed"), h("ul", { class: "summary-list prose" }, summary.map((s) => h("li", null, md(s, { inline: true }))))));
    if (focus.length) {
      el.append(
        h(
          "div",
          null,
          h("h3", null, "Where to look, in order"),
          h(
            "ol",
            { class: "focus-list" },
            focus.map((f) => {
              const t = f.ref ? h("a", { href: "#", dataset: { ref: f.ref } }, f.title) : f.title;
              return h(
                "li",
                null,
                h("div", { class: "t" }, t),
                f.why ? h("div", { class: "w" }, md(f.why, { cls: "" })) : null,
                f.ref && !f.ref.startsWith("#") ? h("div", { class: "r" }, h("a", { href: "#", class: "hr-ref", dataset: { ref: f.ref } }, h("code", null, f.ref))) : null,
              );
            }),
          ),
        ),
      );
    }
    return el;
  }

  function sectionShell(id, title, aside) {
    sectionsForToc.push({ id, title });
    return h(
      "section",
      { class: "sec", id },
      h("header", null, h("h2", null, h("a", { class: "anchor", href: `#${id}` }, title)), aside ? h("span", { class: "aside" }, aside) : null),
    );
  }

  function renderSections() {
    const out = [];
    for (const s of recap.sections || []) {
      const sec = sectionShell(s.id, s.title);
      if (s.intro) sec.append(h("div", { style: { marginBottom: "22px" } }, md(s.intro)));
      sec.append(h("div", { class: "blocks" }, s.blocks.map((b) => renderBlock(b, s.title))));
      out.push(sec);
    }
    return out;
  }

  function renderKeyChanges() {
    keyBlocks = (recap.keyChanges || []).map((b) => ({ type: "diff", ...b }));
    if (!keyBlocks.length) return null;
    const sec = sectionShell("key-changes", "Key changes", `${plural(keyBlocks.length, "file")} that carry the change`);
    keyTabs = renderTabs(
      keyBlocks.map((b) => {
        const f = byPath.get(b.file);
        const [, base] = splitPath(b.file);
        const risky = (b.annotations || []).some((a) => a.kind === "risk");
        const dot = risky ? h("span", { class: "badge-risk", title: "Has a risk note" }) : null;
        if (dot) {
          const draw = () => (dot.hidden = fileFindingsHidden(b.file));
          findingWatchers.add(draw);
          draw();
        }
        const labelEl = [
          dot,
          h("span", { class: "mono" }, b.label || base),
          f ? h("span", { class: "n" }, h("span", { class: "num-add" }, `+${f.additions}`), " ", h("span", { class: "num-del" }, `−${f.deletions}`)) : null,
        ];
        return {
          label: b.label || base,
          labelEl,
          blocks: [b],
          title: b.file,
          render: () => {
            const w = h("div", { class: "blocks" }, renderBlock(b, "Key changes"));
            return w;
          },
        };
      }),
      { cls: "keychanges" },
    );
    sec.append(keyTabs);
    return sec;
  }

  function renderChecks() {
    const list = (v) => (Array.isArray(v) ? v : []);
    const q = list(recap.questions);
    const verified = list(recap.checks && recap.checks.verified);
    const manual = list(recap.checks && recap.checks.manual);
    if (!q.length && !verified.length && !manual.length) return null;
    const sec = sectionShell("checks", "Before you approve");
    const grid = h("div", { class: "checks-grid" });

    if (q.length) {
      const ul = h("ul");
      q.forEach((text, i) => {
        const li = h("li");
        const body = h("div");
        const draw = (editing) => {
          body.textContent = "";
          body.append(md(text, { cls: "" }));
          const qk = hash(String(text));
          const replies = state.comments.filter((c) => c.anchor.type === "question" && (c.anchor.key === qk || (c.anchor.key == null && c.anchor.text === text)));
          for (const c of replies) {
            if (editing === c.id) {
              body.append(h("div", { class: "note you", style: { margin: "8px 0 0" } }, editor({ initial: c.body, onSave: (v) => (updateComment(c.id, v), draw()), onCancel: () => draw() })));
            } else {
              const v = commentView(c, (act) => (act === "delete" ? (deleteComment(c.id), draw()) : draw(c.id)));
              v.style.margin = "8px 0 0";
              body.append(v);
            }
          }
          if (editing === "new") {
            body.append(
              h(
                "div",
                { class: "note you", style: { margin: "8px 0 0" } },
                editor({ placeholder: "Your answer…", onSave: (v) => (addComment({ type: "question", key: qk, text }, v), draw()), onCancel: () => draw() }),
              ),
            );
          } else if (!replies.length) {
            body.append(h("button", { type: "button", class: "btn ghost", style: { height: "26px", padding: "0 8px", marginTop: "4px", marginLeft: "-8px", fontSize: "12.5px", color: "var(--link)" }, onclick: () => draw("new") }, "Answer"));
          }
        };
        draw();
        li.append(icon("question"), body);
        ul.append(li);
      });
      grid.append(h("div", { class: "check-card questions" }, h("h3", null, icon("question"), "Questions for you"), ul));
    }
    if (verified.length) {
      grid.append(
        h(
          "div",
          { class: "check-card verified" },
          h("h3", null, icon("approve"), "Already verified"),
          h(
            "ul",
            null,
            verified.map((v) => {
              const text = typeof v === "string" ? v : v.text;
              const cmd = typeof v === "object" && v.cmd ? h("div", { style: { marginTop: "4px" } }, h("code", null, v.cmd)) : null;
              return h("li", null, icon("check"), h("div", null, md(text, { cls: "" }), cmd));
            }),
          ),
        ),
      );
    }
    if (manual.length) {
      grid.append(
        h(
          "div",
          { class: "check-card manual" },
          h("h3", null, icon("list"), "Check for yourself"),
          h(
            "ul",
            null,
            manual.map((m) => {
              const k = hash(String(m));
              const lab = h("label", { class: state.checks[k] ? "done" : "" });
              const box = h("input", {
                type: "checkbox",
                checked: !!state.checks[k],
                onchange: (e) => {
                  if (e.target.checked) state.checks[k] = true;
                  else delete state.checks[k];
                  lab.classList.toggle("done", e.target.checked);
                  save();
                },
              });
              lab.append(box, md(m, { cls: "" }));
              return h("li", { style: { display: "block" } }, lab);
            }),
          ),
        ),
      );
    }
    sec.append(grid);
    return sec;
  }

  function renderFiles() {
    const concerns = groups.filter((g) => !g.auto).length;
    const sec = sectionShell("files", "All files", `${plural(files.length, "file")}${concerns > 1 ? ` in ${concerns} concerns` : ""}, in reading order · open any row to see its diff`);
    for (const g of groups) {
      const wrap = h("div", { class: `fgroup${g.auto ? " auto" : ""}`, id: g.id || null });
      const rows = g.files.map(fileRow);
      const swatch = h("i", { class: g.hatch ? "hatch" : "", style: { background: g.hatch ? "repeating-linear-gradient(135deg, var(--rule-strong) 0 2px, transparent 2px 4px)" : g.color, boxShadow: g.hatch ? "inset 0 0 0 1px var(--rule-strong)" : "" } });
      wrap.append(
        h(
          "header",
          null,
          h("h3", null, swatch, g.name, h("small", null, `${plural(g.files.length, "file")}  +${g.adds} −${g.dels}`)),
          g.files.length > 1 ? h("button", { type: "button", class: "linklike", onclick: () => rows.forEach((r) => r._open()) }, "Open all") : null,
        ),
      );
      if (g.why) wrap.append(h("div", { class: "fwhy" }, md(g.why, { cls: "" })));
      const list = h("div", { class: "flist" });
      list.append(...rows);
      wrap.append(list);
      sec.append(wrap);
    }
    return sec;
  }
  function fileRow(f) {
    const m = fileMeta(f.path);
    const [dir, base] = splitPath(f.path);
    const viewed = !!state.viewed[f.path];
    const row = h("div", { class: `frow ${m.review}${viewed ? " is-viewed" : ""}`, id: `file-${hash(f.path)}`, dataset: { path: f.path } });
    const body = h("div", { class: "fbody", hidden: true });
    const box = h("input", {
      type: "checkbox",
      checked: viewed,
      dataset: { viewed: f.path },
      title: "Mark as viewed",
      "aria-label": `Mark ${f.path} as viewed`,
      onclick: (e) => e.stopPropagation(),
      onchange: (e) => setViewed(f.path, e.target.checked),
    });
    const line = h(
      "div",
      {
        class: "fline",
        role: "button",
        tabindex: "0",
        "aria-expanded": "false",
        onclick: () => toggle(),
        onkeydown: (e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        },
      },
      h("span", { class: "viewed-box" }, box),
      h("span", { class: `prio ${m.review}` }, TIER_LABEL[m.review] || m.review),
      h(
        "span",
        { class: "fp" },
        h("span", { class: "pth" }, f.status === "renamed" && f.oldPath ? h("span", { class: "dir" }, `${f.oldPath} → `) : null, h("span", { class: "dir" }, dir), base),
        " ",
        f.status !== "modified" ? h("span", { class: `chip ${f.status}`, style: { marginLeft: "4px" } }, f.status) : null,
        f.testFor ? h("span", { class: "chip test", style: { marginLeft: "4px" }, title: `Tests ${f.testFor}` }, `tests ${splitPath(f.testFor)[1]}`) : null,
        m.note ? h("span", { class: "fn" }, md(m.note, { inline: true })) : null,
        m.proof ? h("span", { class: "fproof" }, icon("check"), md(m.proof, { inline: true })) : null,
      ),
      h("span", { class: "fc" }, h("span", { class: "num-add" }, `+${f.additions}`), h("span", { class: "num-del" }, `−${f.deletions}`)),
      h("span", { class: "chev" }, icon("chevronRight")),
    );
    const toggle = (force) => {
      const open = force ?? body.hidden;
      body.hidden = !open;
      row.classList.toggle("open", open);
      line.setAttribute("aria-expanded", String(open));
      if (open && !body.firstChild) body.append(renderDiff(f, { file: f.path }, { headless: true }));
    };
    row._open = () => toggle(true);
    row.append(line, body);
    return row;
  }

  // ───────────────────────────────────────────── navigation

  // Starting the flash animation mid-scroll cancels a smooth scroll in Chromium,
  // so the flash waits for the scroll to finish.
  function flashRow(tr) {
    tr.classList.remove("flash");
    let done = false;
    const flash = () => {
      if (done) return;
      done = true;
      window.removeEventListener("scrollend", flash);
      void tr.offsetWidth;
      tr.classList.add("flash");
    };
    const r = tr.getBoundingClientRect();
    if (r.top > 60 && r.bottom < window.innerHeight - 20) return flash();
    const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (smooth) {
      window.addEventListener("scrollend", flash);
      setTimeout(flash, 1200);
    }
    tr.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
    if (!smooth) flash();
  }
  function findRow(container, line) {
    return container.querySelector(`tr[data-n="${line}"]`);
  }

  function goTo(ref) {
    const r = parseRef(ref);
    if (!r) return;
    closeSide();
    if (r.id) {
      // Tabs render lazily: open the tab (and any enclosing tabs) that holds the block.
      let el = document.getElementById(r.id);
      for (let i = 0; !el && i < 4; i++) {
        const loc = tabHome.get(r.id);
        if (!loc) break;
        loc.tabs._select(loc.index);
        el = document.getElementById(r.id);
      }
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    // Prefer the key-change tab that shows the line.
    // A file can have several key-change tabs (split by hunks): use the one showing the line.
    const tabsForFile = keyBlocks.map((b, i) => (b.file === r.file ? i : -1)).filter((i) => i >= 0);
    if (tabsForFile.length && keyTabs) {
      const panel = keyTabs.querySelector(".tabpanel");
      let idx = tabsForFile[0];
      if (r.line != null) idx = tabsForFile.find((i) => findRow(keyTabs._panelFor(i), r.line)) ?? idx;
      keyTabs._select(idx);
      if (r.line == null) return panel.scrollIntoView({ behavior: "smooth", block: "start" });
      let tr = findRow(panel, r.line);
      if (!tr) {
        const d = panel.querySelector(".diff");
        if (d && d._inst) {
          d._inst.showAll = true;
          d._inst.full = true;
          d._inst.render();
          tr = findRow(panel, r.line);
        }
      }
      if (tr) return flashRow(tr);
    }
    const row = document.getElementById(`file-${hash(r.file)}`);
    if (!row) return;
    row._open();
    if (r.line == null) return row.scrollIntoView({ behavior: "smooth", block: "start" });
    let tr = findRow(row, r.line);
    if (!tr) {
      // expand the gap containing it
      const d = row.querySelector(".diff");
      if (d && d._inst) {
        const f = d._inst.file;
        const { rows } = rowModel(f, f.hunks.map((x, i) => ({ ...x, index: i })), f.hunks.map((x, i) => ({ ...x, index: i })));
        for (const g of rows) if (g.kind === "gap" && g.expandable && r.line >= g.from && r.line <= g.to) d._inst.expanded.add(`${g.from}:${g.to}`);
        d._inst.full = true;
        d._inst.render();
        tr = findRow(row, r.line);
      }
    }
    if (tr) flashRow(tr);
    else row.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  document.addEventListener("click", (e) => {
    const a = e.target.closest("[data-ref]");
    if (a) {
      e.preventDefault();
      goTo(a.dataset.ref);
    }
  });

  // ───────────────────────────────────────────── top bar, sidebar, drawer

  let sideEl, sideFilesEl, progressEl, progressLabel, progressNote, feedbackCount;
  function renderTop() {
    const hasWire = Array.isArray(meta.types) ? meta.types.includes("wireframe") : JSON.stringify(recap).includes('"type":"wireframe"');
    const modeSeg = h(
      "div",
      { class: "seg hide-sm", role: "group", "aria-label": "Diff layout" },
      ["split", "unified"].map((m) =>
        h(
          "button",
          {
            type: "button",
            "aria-pressed": String(prefs.mode === m),
            onclick: (e) => {
              prefs.mode = m;
              savePrefs();
              for (const b of e.currentTarget.parentNode.children) b.setAttribute("aria-pressed", String(b === e.currentTarget));
              rerenderAllDiffs();
            },
          },
          m === "split" ? "Split" : "Unified",
        ),
      ),
    );
    const wrapBtn = h(
      "button",
      {
        class: "btn icon ghost hide-sm",
        type: "button",
        title: "Wrap long lines",
        "aria-pressed": String(prefs.wrap),
        style: { color: prefs.wrap ? "var(--ink)" : "var(--muted)" },
        onclick: (e) => {
          prefs.wrap = !prefs.wrap;
          savePrefs();
          e.currentTarget.setAttribute("aria-pressed", String(prefs.wrap));
          e.currentTarget.style.color = prefs.wrap ? "var(--ink)" : "var(--muted)";
          rerenderAllDiffs();
          for (const s of document.querySelectorAll(".diff-scroll")) if (!s.closest(".diff")?._inst) s.classList.toggle("nowrap", !prefs.wrap);
        },
      },
      icon("wrap"),
    );
    const sketchSeg = hasWire
      ? h(
          "div",
          { class: "seg hide-sm", role: "group", "aria-label": "Wireframe style" },
          [
            ["sketch", "Sketch"],
            ["clean", "Clean"],
          ].map(([k, l]) =>
            h(
              "button",
              {
                type: "button",
                "aria-pressed": String(prefs.sketch === (k === "sketch")),
                onclick: (e) => {
                  prefs.sketch = k === "sketch";
                  savePrefs();
                  for (const b of e.currentTarget.parentNode.children) b.setAttribute("aria-pressed", String(b === e.currentTarget));
                  redrawWireframes();
                },
              },
              l,
            ),
          ),
        )
      : null;
    const themes = ["auto", "light", "dark"];
    let theme = "auto";
    try {
      theme = localStorage.getItem("hr:theme") || "auto";
    } catch {}
    if (!themes.includes(theme)) theme = "auto";
    const themeBtn = h("button", { class: "btn icon ghost", type: "button" });
    const setTheme = (t) => {
      theme = t;
      if (t === "auto") delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = t;
      try {
        localStorage.setItem("hr:theme", t);
      } catch {}
      themeBtn.replaceChildren(icon(t === "auto" ? "auto" : t === "light" ? "sun" : "moon"));
      themeBtn.title = `Theme: ${t} (click to change)`;
      themeBtn.setAttribute("aria-label", themeBtn.title);
      requestAnimationFrame(() => {
        redrawWireframes();
        redrawMermaid();
      });
    };
    themeBtn.onclick = () => setTheme(themes[(themes.indexOf(theme) + 1) % 3]);
    setTheme(theme);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => theme === "auto" && setTheme("auto"));

    feedbackCount = h("span", { class: "count" }, "0");
    const top = h(
      "div",
      { class: "hr-top" },
      h("button", { class: "btn icon ghost hr-menu-btn", type: "button", "aria-label": "Open navigation", onclick: () => sideEl.classList.toggle("show") }, icon("menu")),
      h("a", { class: "hr-brand", href: "#top", title: "Back to top" }, h("span", { class: "hr-brand-mark" }, icon("mark")), h("span", { class: "word" }, "Review")),
      h("div", { class: "hr-top-title", id: "hr-top-title" }, String(recap.title || "").replace(/`/g, "")),
      h("div", { class: "hr-top-spacer" }),
      sketchSeg,
      modeSeg,
      wrapBtn,
      themeBtn,
      h("button", { class: "btn primary", type: "button", onclick: openDrawer }, icon("comment"), h("span", { class: "hide-sm" }, "Feedback"), feedbackCount),
    );
    return top;
  }

  function renderSide() {
    sideEl = h("aside", { class: "hr-side", "aria-label": "Review navigation" });
    const toc = h(
      "nav",
      { "aria-label": "On this page" },
      h("h4", null, "On this page"),
      h(
        "ul",
        { class: "toc" },
        sectionsForToc.map((s) => h("li", null, h("a", { href: `#${s.id}`, dataset: { toc: s.id }, onclick: closeSide }, s.title))),
      ),
    );
    progressEl = h("span");
    progressLabel = h("div", { class: "progress-label" });
    const prog = h("div", { class: "hr-side-block" }, h("h4", null, "Your progress"), h("div", { class: "progress" }, progressEl), progressLabel);
    progressNote = h("div", { class: "side-note" });
    prog.append(progressNote);
    const findingsLine = h("div", { class: "side-note findings-line" });
    if (countFindings()) {
      const draw = () =>
        findingsLine.replaceChildren(
          ...(holdFindings()
            ? [h("span", null, "Agent findings: after each file"), h("button", { type: "button", class: "linklike", onclick: revealAll }, "Show all")]
            : [
                h("span", null, "Agent findings: shown"),
                prefs.findings === "always"
                  ? h(
                      "button",
                      {
                        type: "button",
                        class: "linklike",
                        title: "Hold the agent's findings back on reviews you haven't opened yet",
                        onclick: () => {
                          prefs.findings = "after";
                          savePrefs();
                          notifyFindings();
                        },
                      },
                      "Hold back next time",
                    )
                  : null,
              ].filter(Boolean)),
        );
      findingWatchers.add(draw);
      draw();
      prog.append(findingsLine);
    }
    sideFilesEl = h("ul", { class: "side-files" });
    const filesBlock = h("div", { class: "hr-side-block" }, h("h4", null, "Files"), sideFilesEl);
    sideEl.append(toc, prog, filesBlock);
    renderSideFiles();
    return sideEl;
  }
  function closeSide() {
    sideEl && sideEl.classList.remove("show");
  }

  function renderSideFiles() {
    if (!sideFilesEl) return;
    sideFilesEl.textContent = "";
    const firstOf = new Map(groups.map((g) => [g.files[0], g]));
    for (const f of orderedFiles) {
      const g = firstOf.get(f);
      if (g && groups.length > 1) sideFilesEl.append(h("li", { class: "grp" }, g.name));
      const m = fileMeta(f.path);
      const viewed = !!state.viewed[f.path];
      const n = state.comments.filter((c) => c.anchor.type === "line" && c.anchor.file === f.path).length;
      sideFilesEl.append(
        h(
          "li",
          { class: viewed ? "is-viewed" : "" },
          h(
            "a",
            { href: "#", dataset: { ref: f.path }, title: `${f.path} — ${TIER_LABEL[m.review] || ""}` },
            viewed ? h("span", { class: "viewed" }, icon("check")) : h("span", { class: `dot ${m.review}` }),
            h("span", { class: "nm" }, h("bdi", null, f.path)),
            n ? h("span", { class: "cm" }, String(n)) : null,
          ),
        ),
      );
    }
    updateCounts();
  }

  function updateCounts() {
    if (feedbackCount) {
      const n = state.comments.length;
      feedbackCount.textContent = String(n);
      feedbackCount.style.display = n ? "" : "none";
    }
    if (progressEl) {
      const done = reviewable.filter((f) => state.viewed[f.path]).length;
      const pct = reviewable.length ? Math.round((done / reviewable.length) * 100) : 100;
      progressEl.style.width = `${pct}%`;
      const auto = files.length - reviewable.length;
      progressLabel.replaceChildren(h("span", null, `${done} of ${plural(reviewable.length, "file")} viewed`));
      progressNote.textContent = auto ? `Plus ${auto} mechanical or generated, each with a proof.` : "";
    }
  }

  // Feedback drawer
  let drawer, scrim, generalTa;
  function renderDrawer() {
    scrim = h("div", { class: "scrim", onclick: closeDrawer });
    generalTa = h("textarea", {
      placeholder: "Anything else the author should know?",
      oninput: (e) => {
        state.general = e.target.value;
        save();
      },
    });
    generalTa.value = state.general || "";
    const verdicts = [
      ["approve", "Approve", "approve"],
      ["changes", "Request changes", "changes"],
      ["comment", "Comment only", "comment"],
    ];
    const vbox = h(
      "div",
      { class: "verdict", role: "group", "aria-label": "Verdict" },
      verdicts.map(([k, l, ic]) =>
        h(
          "button",
          {
            type: "button",
            class: k,
            "aria-pressed": String(state.verdict === k),
            onclick: (e) => {
              state.verdict = state.verdict === k ? null : k;
              save();
              for (const b of vbox.children) b.setAttribute("aria-pressed", String(b.classList.contains(state.verdict)));
            },
          },
          icon(ic),
          l,
        ),
      ),
    );
    const list = h("ul", { class: "clist" });
    drawer = h(
      "aside",
      { class: "drawer", "aria-label": "Feedback", role: "dialog", "aria-modal": "true" },
      h("header", null, h("h2", null, "Your feedback"), h("button", { class: "btn icon ghost", type: "button", "aria-label": "Close", onclick: closeDrawer }, icon("x"))),
      h("div", { class: "body" }, h("div", null, h("h3", null, "Verdict"), vbox), h("div", null, h("h3", null, "Overall"), generalTa), h("div", null, h("h3", null, "Comments"), list)),
      h(
        "footer",
        null,
        h("button", { class: "btn primary", type: "button", onclick: copyFeedback }, icon("copy"), "Copy feedback for the agent"),
        h("button", { class: "btn icon", type: "button", title: "Download as Markdown", "aria-label": "Download as Markdown", onclick: downloadFeedback }, icon("download")),
        h("div", { class: "note-sm" }, "Paste it into your agent session. Comments are saved in this browser until the code changes."),
      ),
    );
    drawer._list = list;
    document.body.append(scrim, drawer);
  }
  function drawCommentList() {
    const list = drawer._list;
    list.textContent = "";
    if (!state.comments.length) {
      list.append(h("li", { class: "empty" }, "No comments yet. Hover any line number and press +, or use the speech bubble on any diagram, wireframe, or section block."));
      return;
    }
    for (const c of state.comments) {
      const a = c.anchor;
      const where =
        a.type === "line"
          ? h("a", { href: "#", dataset: { ref: `${a.file}:${a.side === "old" ? "" : a.line}`.replace(/:$/, "") }, onclick: closeDrawer }, `${a.file}:${a.line}${a.side === "old" ? " (old)" : ""}`)
          : a.type === "block"
            ? h("a", { href: "#", dataset: { ref: `#${a.id}` }, onclick: closeDrawer }, a.label || blockLabels.get(a.id))
            : h("a", { href: "#checks", onclick: closeDrawer }, "Answer to a question");
      list.append(
        h(
          "li",
          null,
          h(
            "div",
            { class: "where" },
            where,
            h(
              "button",
              {
                type: "button",
                onclick: () => {
                  deleteComment(c.id);
                  drawCommentList();
                  if (a.type === "line") rerenderFile(a.file);
                  else if (a.type === "block") document.getElementById(a.id)?._drawNotes?.();
                },
              },
              "Delete",
            ),
          ),
          h("div", { class: "txt" }, c.body),
        ),
      );
    }
  }
  let lastFocus = null;
  // While the drawer is open, Tab cycles inside it.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Tab" || !drawer || !drawer.classList.contains("show")) return;
    const f = [...drawer.querySelectorAll("button, textarea, a[href], input")].filter((x) => !x.disabled && x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || !drawer.contains(document.activeElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || !drawer.contains(document.activeElement))) {
      e.preventDefault();
      first.focus();
    }
  });
  function openDrawer() {
    lastFocus = document.activeElement;
    drawCommentList();
    scrim.classList.add("show");
    drawer.classList.add("show");
    requestAnimationFrame(() => drawer.querySelector("button")?.focus());
  }
  function closeDrawer() {
    scrim.classList.remove("show");
    drawer.classList.remove("show");
    lastFocus && lastFocus.focus && lastFocus.focus();
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (document.querySelector(".lightbox")) document.querySelector(".lightbox").remove();
      else if (drawer && drawer.classList.contains("show")) closeDrawer();
      else closeSide();
    }
  });

  function feedbackMarkdown() {
    const L = [];
    const v = { approve: "Approve", changes: "Request changes", comment: "Comment only" }[state.verdict] || "No verdict";
    L.push(`# Review feedback: ${recap.title || "Untitled"}`);
    L.push("");
    L.push(`- Repo: ${diff.repo}`);
    L.push(`- Range: ${diff.base.ref} @ ${diff.base.sha.slice(0, 10)} .. ${diff.head.ref} @ ${diff.head.worktree ? "working tree" : diff.head.sha.slice(0, 10)}`);
    L.push(`- Verdict: **${v}**`);
    const manual = Array.isArray(recap.checks && recap.checks.manual) ? recap.checks.manual : [];
    if (manual.length) L.push(`- Manual checks done: ${manual.filter((m) => state.checks[hash(String(m))]).length} of ${manual.length}`);
    const viewed = reviewable.filter((f) => state.viewed[f.path]).length;
    const auto = files.length - reviewable.length;
    L.push(`- Files viewed: ${viewed} of ${reviewable.length}${auto ? ` (plus ${auto} proven mechanical or generated)` : ""}`);
    if (state.comments.length) L.push(`- Comments written before seeing the agent's findings: ${state.comments.filter((c) => c.blind).length} of ${state.comments.length}`);
    if (state.general && state.general.trim()) {
      L.push("", "## Overall", "", state.general.trim());
    }
    const answers = state.comments.filter((c) => c.anchor.type === "question");
    if (answers.length) {
      L.push("", "## Answers to your questions", "");
      answers.forEach((c) => {
        L.push(`**Q:** ${c.anchor.text}`, "", `**A:** ${c.body}`, "");
      });
    }
    const rest = state.comments.filter((c) => c.anchor.type !== "question");
    if (rest.length) {
      L.push("", "## Comments", "");
      rest.forEach((c, i) => {
        const a = c.anchor;
        if (a.type === "line") {
          const f = byPath.get(a.file);
          L.push(`${i + 1}. \`${a.file}:${a.line}\`${a.side === "old" ? " (removed line, old numbering)" : ""}`);
          if (a.code != null && a.code.trim()) {
            const fence = a.code.includes("```") ? "~~~" : "```";
            L.push(`   ${fence}${(f && f.language) || ""}`, `   ${a.code}`, `   ${fence}`);
          }
        } else {
          L.push(`${i + 1}. On **${a.label || blockLabels.get(a.id)}** (block \`${a.id}\`)`);
        }
        for (const line of c.body.split("\n")) L.push(`   > ${line}`);
        L.push("");
      });
    }
    if (!rest.length && !answers.length && !(state.general || "").trim()) L.push("", "_No comments._");
    return L.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
  }
  function toast(msg) {
    const t = h("div", { class: "toast", role: "status" }, msg);
    document.body.append(t);
    requestAnimationFrame(() => t.classList.add("show"));
    setTimeout(() => {
      t.classList.remove("show");
      setTimeout(() => t.remove(), 300);
    }, 2200);
  }
  async function copyFeedback() {
    const text = feedbackMarkdown();
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied. Paste it into your agent session.");
    } catch {
      const ta = h("textarea", { style: { position: "fixed", opacity: "0" } });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      toast(ok ? "Copied. Paste it into your agent session." : "Copy failed. Use the download button instead.");
    }
  }
  function downloadFeedback() {
    const blob = new Blob([feedbackMarkdown()], { type: "text/markdown" });
    const a = h("a", { href: URL.createObjectURL(blob), download: "review-feedback.md" });
    document.body.append(a);
    a.click();
    setTimeout(() => (URL.revokeObjectURL(a.href), a.remove()), 1000);
  }

  // ───────────────────────────────────────────── assemble

  function build() {
    const main = h("main", { class: "hr-main", id: "main" });
    const inner = h("div", { class: "hr-inner" });
    main.append(inner);
    inner.append(renderHero());
    const ov = renderOverview();
    if (ov) inner.append(ov);
    for (const s of renderSections()) inner.append(s);
    const kc = renderKeyChanges();
    if (kc) inner.append(kc);
    const ch = renderChecks();
    if (ch) inner.append(ch);
    inner.append(renderFiles());
    inner.append(
      h(
        "footer",
        { class: "foot" },
        h("span", null, `Built ${new Date(meta.builtAt || Date.now()).toLocaleString()}`),
        h("span", null, h("code", null, diff.base.sha.slice(0, 10)), " → ", h("code", null, diff.head.worktree ? "working tree" : diff.head.sha.slice(0, 10))),
        diff.redactions ? h("span", null, `${plural(diff.redactions, "secret-looking value")} redacted`) : null,
        h("span", null, `human-review ${meta.version || ""}`),
      ),
    );

    const top = renderTop();
    const side = renderSide();
    root.replaceChildren(top, h("div", { class: "hr-shell" }, side, main));
    root.removeAttribute("aria-busy");
    renderDrawer();
    updateCounts();

    // Section highlighting in the TOC
    const links = new Map([...side.querySelectorAll("[data-toc]")].map((a) => [a.dataset.toc, a]));
    const visible = new Map();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) visible.set(e.target.id, e.isIntersecting ? e.boundingClientRect.top : null);
        let best = null;
        for (const s of sectionsForToc) {
          const el = document.getElementById(s.id);
          if (!el) continue;
          const r = el.getBoundingClientRect();
          if (r.top < window.innerHeight * 0.35) best = s.id;
        }
        for (const [id, a] of links) a.classList.toggle("active", id === best);
      },
      { rootMargin: "0px 0px -60% 0px", threshold: [0, 1] },
    );
    for (const s of sectionsForToc) {
      const el = document.getElementById(s.id);
      if (el) io.observe(el);
    }
    const titleEl = document.getElementById("hr-title");
    const topTitle = document.getElementById("hr-top-title");
    new IntersectionObserver(([e]) => topTitle.classList.toggle("show", !e.isIntersecting), { rootMargin: `-${52}px 0px 0px 0px` }).observe(titleEl);

    narrowQuery.addEventListener("change", rerenderAllDiffs);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(redrawWireframes);
    window.addEventListener("load", redrawWireframes);

    if (location.hash.length > 1) {
      let id = location.hash.slice(1);
      try {
        id = decodeURIComponent(id);
      } catch {}
      requestAnimationFrame(() => (document.getElementById(id) ? document.getElementById(id).scrollIntoView() : goTo(id)));
    }
  }

  try {
    build();
  } catch (e) {
    console.error(e);
    root.innerHTML = `<pre class="err">The review could not be rendered:\n${esc(e.stack || e)}</pre>`;
  }
})();

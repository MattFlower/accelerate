#!/usr/bin/env node
// human-review — turn a git diff into a self-contained, reviewable HTML page.
//
//   collect  read the change from git, write diff.json + review.txt + a recap.json skeleton
//   build    validate recap.json against the diff and write one self-contained review.html
//   open     open a built review in the default browser
//
// Zero npm dependencies. Runs under Node 18+ or Bun.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.2.0";
const RUNTIME = process.versions.bun ? "bun" : "node";
const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = path.join(SKILL_DIR, "assets");

const MAX_EMBED_FILE_BYTES = 400_000; // full-file context for "expand" rows
const MAX_EMBED_TOTAL_BYTES = 6_000_000;
const MAX_SCREENSHOT_BYTES = 4_000_000;

// ───────────────────────────────────────────────────────────── utilities

class CliError extends Error {
  constructor(msg, code = 1) {
    super(msg);
    this.code = code;
  }
}

// Throws (rather than exiting) so callers can recover; main() prints it once.
function die(msg, code = 1) {
  throw new CliError(msg, code);
}

function git(args, { cwd, allowFail = false, okCodes = [0], input } = {}) {
  const r = spawnSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd,
    input,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  if (r.error || !okCodes.includes(r.status)) {
    if (allowFail) return null;
    if (r.error) die(`could not run git in ${cwd}: ${r.error.message}`);
    die(`git ${args.join(" ")} failed:\n${r.stderr.trim()}`);
  }
  return r.stdout;
}

function sh(cmd, args, { cwd } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

const BOOLEAN_FLAGS = new Set(["open", "check", "help", "no-uncommitted", "no-merge-base", "uncommitted"]);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) out[k] = v;
      else if (!BOOLEAN_FLAGS.has(k) && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const slugify = (s) =>
  s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "review";

function readJSON(file, what) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    die(`${what} not found: ${file}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    // Point at the line/column of the syntax error — agents fix JSON faster with a location.
    const m = /position (\d+)/.exec(e.message);
    let where = "";
    if (m) {
      const pos = Number(m[1]);
      const before = text.slice(0, pos);
      const line = before.split("\n").length;
      const col = pos - before.lastIndexOf("\n");
      const src = text.split("\n")[line - 1] ?? "";
      where = `\n  at line ${line}, column ${col}:\n  ${src.slice(Math.max(0, col - 60), col + 40)}\n  ${" ".repeat(Math.min(col, 60) - 1)}^`;
    }
    die(`${what} is not valid JSON: ${e.message}${where}`);
  }
}

// ───────────────────────────────────────────────────────────── diff parsing

function unquote(p) {
  if (p.startsWith('"') && p.endsWith('"')) {
    try {
      return JSON.parse(p);
    } catch {
      return p.slice(1, -1);
    }
  }
  return p;
}

function stripPrefix(p) {
  p = unquote(p.replace(/\t.*$/, ""));
  if (p === "/dev/null") return null;
  return p.replace(/^[ab]\//, "");
}

export function parseUnifiedDiff(text) {
  const files = [];
  let f = null;
  let h = null;
  let o = 0;
  let n = 0;
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      f = {
        path: null,
        oldPath: null,
        status: "modified",
        binary: false,
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      files.push(f);
      h = null;
      // Fallback path guess: "a/P b/P" → P (works for paths containing spaces when unchanged)
      const rest = line.slice("diff --git ".length);
      if (rest.length % 2 === 1) {
        const half = (rest.length - 1) / 2;
        const a = rest.slice(0, half);
        const b = rest.slice(half + 1);
        if (a.slice(2) === b.slice(2)) f.path = f.oldPath = b.slice(2);
      }
      if (!f.path) {
        const m = /^"?a\/(.+?)"? "?b\/(.+?)"?$/.exec(rest);
        if (m) {
          f.oldPath = m[1];
          f.path = m[2];
        }
      }
      continue;
    }
    if (!f) continue;
    if (h) {
      const c = line[0];
      if (c === " " || c === "+" || c === "-" || line === "") {
        if (c === "+") {
          h.lines.push({ t: "+", n: n++, s: line.slice(1) });
          f.additions++;
        } else if (c === "-") {
          h.lines.push({ t: "-", o: o++, s: line.slice(1) });
          f.deletions++;
        } else {
          h.lines.push({ t: " ", o: o++, n: n++, s: line.slice(1) });
        }
        continue;
      }
      if (c === "\\") {
        const last = h.lines[h.lines.length - 1];
        if (last) last.noeol = true;
        continue;
      }
      h = null; // fall through to header parsing
    }
    let m;
    if ((m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line))) {
      h = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        header: m[5] || "",
        lines: [],
      };
      o = h.oldStart;
      n = h.newStart;
      f.hunks.push(h);
    } else if (line.startsWith("new file mode")) f.status = "added";
    else if (line.startsWith("deleted file mode")) f.status = "deleted";
    else if (line.startsWith("rename from ")) {
      f.oldPath = unquote(line.slice(12));
      f.status = "renamed";
    } else if (line.startsWith("rename to ")) f.path = unquote(line.slice(10));
    else if (line.startsWith("copy from ")) {
      f.oldPath = unquote(line.slice(10));
      f.status = "copied";
    } else if (line.startsWith("copy to ")) f.path = unquote(line.slice(8));
    else if (line.startsWith("similarity index ")) f.similarity = parseInt(line.slice(17), 10);
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") f.binary = true;
    else if (line.startsWith("--- ")) {
      const p = stripPrefix(line.slice(4));
      if (p) f.oldPath = p;
    } else if (line.startsWith("+++ ")) {
      const p = stripPrefix(line.slice(4));
      if (p) f.path = p;
      else if (f.oldPath) f.path = f.oldPath; // deleted file: keep the old path
    }
  }
  for (const file of files) {
    if (!file.path) file.path = file.oldPath;
    if (file.status === "added") file.oldPath = null;
    if (file.status === "modified" && file.oldPath && file.oldPath !== file.path) file.status = "renamed";
    if (file.status !== "renamed" && file.status !== "copied") delete file.similarity;
  }
  return files;
}

// ───────────────────────────────────────────────────────────── classification

// Each pattern carries the reason shown to the reviewer as the file's proof.
const GENERATED_PATTERNS = [
  [/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|composer\.lock|go\.sum|mix\.lock|pubspec\.lock|Podfile\.lock|flake\.lock|packages\.lock\.json)$/, "dependency lockfile"],
  [/\.min\.(js|css)$/, "minified bundle"],
  [/\.map$/, "source map"],
  [/\.snap$|(^|\/)__snapshots__\//, "test snapshot"],
  [/(^|\/)(dist|\.next|coverage)\//, "build output directory"],
  [/\.pb\.(go|cc|h)$|_pb2\.py$|\.g\.dart$/, "generated by a code generator (file name)"],
  [/\.generated\.|_generated\./, "file name marks it as generated"],
];

function generatedReason(p) {
  for (const [re, why] of GENERATED_PATTERNS) if (re.test(p)) return why;
  return null;
}

// ───────────────────────────────────────────────────────────── mechanical changes
//
// A file is "mechanical" only when the diff itself proves there's no new code in it:
// renamed with identical contents, or every changed line is an existing line moved or
// re-indented. The proof is stored with the file and shown to the reviewer.

// Indentation is meaningful in these, so only trailing whitespace may differ.
const INDENT_SENSITIVE = /\.(py|pyi|ya?ml|mk|pug|jade|haml|slim|sass|styl|coffee|nim|fs|fsx)$|(^|\/)(makefile|gnumakefile)$/i;
const lineKey = (file, s) => (INDENT_SENSITIVE.test(file) ? s.replace(/\s+$/, "") : s.trim());
// Does a line identify itself? `continue;`, `} else {`, and `return null;` appear everywhere, so
// matching them proves nothing; a line needs some non-keyword content to count as a move.
const TRIVIAL_WORDS = new Set(["return", "break", "continue", "else", "elif", "end", "fi", "done", "do", "then", "pass", "null", "nil", "none", "true", "false", "undefined", "default", "try", "finally", "begin", "esac", "endif", "this", "self", "super", "new", "await", "yield", "export", "const", "let", "var", "def", "fn", "func", "function", "public", "private", "static"]);
const hasIdentity = (s) =>
  s
    .split(/[^A-Za-z0-9_$]+/)
    .filter((w) => w && !TRIVIAL_WORDS.has(w.toLowerCase()))
    .join("").length >= 3;

// Pairs removed and added lines with the same content: first within a hunk (re-indents,
// in-place reorders), then anywhere in the change (moves). Paired lines get
// `mv: [kind, partnerPath, partnerLine]`. Must run before redaction.
function analyzeMechanical(files) {
  const entries = [];
  for (const f of files)
    f.hunks.forEach((h, hi) => {
      for (const l of h.lines) {
        if (l.t === " ") continue;
        const key = lineKey(f.path, l.s);
        if (key) entries.push({ f, hi, l, key });
      }
    });
  const lineNo = (e) => (e.l.t === "-" ? e.l.o : e.l.n);
  const pair = (a, b) => {
    const kind = a.f === b.f && a.hi === b.hi && a.l.s !== b.l.s ? "indent" : "moved";
    a.partner = b;
    b.partner = a;
    a.l.mv = [kind, b.f.path, lineNo(b)];
    b.l.mv = [kind, a.f.path, lineNo(a)];
  };
  // Pair unpaired entries that share a pool key, in order. `ok` can veto a candidate partner.
  const pairBy = (keyOf, ok = () => true) => {
    const pools = new Map();
    for (const e of entries) {
      if (e.partner) continue;
      const k = keyOf(e);
      if (k == null) continue;
      if (!pools.has(k)) pools.set(k, { del: [], add: [] });
      pools.get(k)[e.l.t === "-" ? "del" : "add"].push(e);
    }
    for (const { del, add } of pools.values()) {
      for (const a of del) {
        const b = add.find((x) => !x.partner && ok(a, x));
        if (b) pair(a, b);
      }
    }
  };
  // 1. Within a hunk: re-indents and in-place reorders.
  pairBy((e) => `${e.f.path}\0${e.hi}\0${e.key}`);
  // 2. Anywhere in the change, for lines with real content: moves.
  pairBy((e) => (hasIdentity(e.key) ? e.key : null));
  // 3. Punctuation-only lines (`}`, `);`) carry no identity, so they only pair within a file
  //    or with a file that real moved lines already tie this one to — never arbitrarily.
  const linked = new Map();
  for (const e of entries) {
    if (!e.partner || e.partner.f === e.f || !hasIdentity(e.key)) continue;
    if (!linked.has(e.f.path)) linked.set(e.f.path, new Set());
    linked.get(e.f.path).add(e.partner.f.path);
  }
  pairBy(
    (e) => e.key,
    (a, b) => a.f === b.f || (linked.get(a.f.path) || new Set()).has(b.f.path),
  );
  const tick = (s) => `\`${s}\``;
  for (const f of files) {
    if (f.binary) continue;
    if (!f.hunks.length) {
      if (f.status === "renamed" || f.status === "copied")
        f.mechanical = { kind: "rename", proof: `${f.status === "copied" ? "Copied" : "Renamed"} from ${tick(f.oldPath)} with identical contents.` };
      else if (f.status === "modified") f.mechanical = { kind: "mode", proof: "No content change (file mode only)." };
      continue;
    }
    const mine = entries.filter((e) => e.f === f);
    if (!mine.length) {
      f.mechanical = { kind: "whitespace", proof: "Only blank lines changed." };
      continue;
    }
    // Every non-blank changed line must have a partner, and a file whose only changes are
    // punctuation lines (braces, brackets) proves nothing.
    if (!mine.every((e) => e.partner) || !mine.some((e) => hasIdentity(e.key))) continue;
    const moved = mine.filter((e) => e.l.mv[0] === "moved");
    const indented = mine.filter((e) => e.l.mv[0] === "indent").length / 2;
    const others = [...new Set(moved.map((e) => e.l.mv[1]).filter((p) => p !== f.path))];
    const reordered = moved.some((e) => e.l.mv[1] === f.path);
    if (!moved.length) {
      f.mechanical = { kind: "whitespace", proof: `Only whitespace changed: ${indented} line${indented === 1 ? "" : "s"} re-indented or trimmed. Identical otherwise.` };
      continue;
    }
    const where = others.length ? `between this file and ${others.slice(0, 3).map(tick).join(", ")}${others.length > 3 ? ` and ${others.length - 3} more` : ""}` : "within this file";
    let proof = `No new code: every changed line is an existing line moved ${where}${indented ? ` (${indented} also re-indented)` : ""}.`;
    if (reordered) proof += " Lines were reordered within the file, and order can change behavior.";
    f.mechanical = { kind: "moved", proof, from: others };
  }
}

// ───────────────────────────────────────────────────────────── tests and concerns

const TEST_PATH = /(^|\/)(__tests__|tests?|test-d|tests?-[a-z]+|[a-z]+-tests?|spec|specs|e2e)\/|\.(test|spec)\.[A-Za-z0-9]+$|_(test|spec)\.[A-Za-z0-9]+$|(^|\/)test_[^/]+$|[a-z0-9]Tests?\.[A-Za-z]+$/;
const isTestPath = (p) => TEST_PATH.test(p);

// The name of the thing a test file tests: foo.test.ts, foo_test.go, test_foo.py,
// FooTest.java, FooTests.cs, foo_spec.rb → foo.
function testStem(p) {
  let b = path.basename(p).replace(/\.[^.]+$/, "");
  b = b.replace(/[._-](test|spec)s?$/i, "").replace(/^test[_-]/i, "");
  if (/[a-z0-9]Tests?$/.test(b)) b = b.replace(/Tests?$/, "");
  return b.toLowerCase();
}
const stem = (p) => path.basename(p).replace(/\.[^.]+$/, "").toLowerCase();

// For each test file in the change, the changed source file it most likely tests.
function pairTests(paths) {
  const sources = paths.filter((p) => !isTestPath(p));
  const out = new Map();
  for (const t of paths.filter(isTestPath)) {
    const want = testStem(t);
    const cands = sources.filter((s) => stem(s) === want);
    if (!cands.length) continue;
    // Prefer the same language, then the nearest directory.
    const dist = (s) => {
      const a = path.dirname(s).split("/");
      const b = path.dirname(t).split("/");
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      return a.length + b.length - 2 * i;
    };
    const ext = path.extname(t);
    cands.sort((x, y) => (path.extname(x) === ext ? 0 : 1) - (path.extname(y) === ext ? 0 : 1) || dist(x) - dist(y));
    out.set(t, cands[0]);
  }
  return out;
}

// A starting set of concerns for the skeleton: each source file followed by its tests,
// grouped by directory. The agent renames, merges, and reorders them.
function suggestConcerns(files) {
  const live = files.filter((f) => !f.generated && !f.mechanical).map((f) => f.path);
  const tests = pairTests(live);
  const testsOf = new Map();
  for (const [t, src] of tests) testsOf.set(src, [...(testsOf.get(src) || []), t]);
  const byDir = new Map();
  for (const p of live) {
    if (tests.has(p)) continue; // listed right after its source
    const dir = path.dirname(p);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(p, ...(testsOf.get(p) || []).sort());
  }
  return [...byDir.entries()].map(([dir, paths]) => ({ title: dir === "." ? "Top-level files" : dir, why: "", files: paths }));
}

function linguistGenerated(root, paths) {
  if (!paths.length) return new Set();
  const r = spawnSync("git", ["check-attr", "-z", "linguist-generated", "linguist-vendored", "--stdin"], {
    cwd: root,
    input: paths.join("\0"),
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  const out = new Set();
  if (r.error || r.status !== 0) {
    process.stderr.write(`  warn   could not read .gitattributes (linguist-generated): ${r.error ? r.error.message : r.stderr.trim()}\n`);
    return out;
  }
  // -z output: path NUL attribute NUL value NUL …
  const parts = r.stdout.split("\0");
  for (let i = 0; i + 2 < parts.length; i += 3) {
    if (parts[i + 2] === "set" || parts[i + 2] === "true") out.add(parts[i]);
  }
  return out;
}

const LANG_BY_EXT = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin",
  swift: "swift", m: "objectivec", mm: "objectivec", c: "c", h: "c", cc: "cpp", cpp: "cpp",
  hpp: "cpp", cxx: "cpp", cs: "csharp", php: "php", scala: "scala", dart: "dart", ex: "elixir",
  exs: "elixir", erl: "erlang", hs: "haskell", clj: "clojure", ml: "ocaml", lua: "lua",
  pl: "perl", r: "r", jl: "julia", groovy: "groovy", gradle: "groovy", nix: "nix",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash", ps1: "powershell",
  sql: "sql", graphql: "graphql", gql: "graphql", proto: "protobuf",
  json: "json", jsonc: "json", json5: "json", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini",
  xml: "xml", html: "xml", htm: "xml", svg: "xml", vue: "xml", svelte: "xml", astro: "xml",
  css: "css", scss: "scss", less: "less", md: "markdown", mdx: "markdown",
  dockerfile: "dockerfile", mk: "makefile", conf: "nginx", diff: "diff", patch: "diff",
};

function languageFor(p) {
  const base = path.basename(p).toLowerCase();
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
  if (base === "makefile" || base === "gnumakefile") return "makefile";
  if (base.startsWith(".env")) return "bash";
  const ext = base.includes(".") ? base.split(".").pop() : "";
  return LANG_BY_EXT[ext] || null;
}

// ───────────────────────────────────────────────────────────── secret redaction

const SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  // A whole key written on one line (JSON/env strings with escaped newlines).
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?:\\[rn]|[A-Za-z0-9+/=:\s-])+?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g,
  /\b(?:sk|pk|rk)_(?:live|test)_[0-9A-Za-z]{16,}/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g,
];
// A key name that ends in a secret-ish word: password, DB_PASSWORD, apiKey, aws_secret_access_key,
// _authToken… but not tokenizer, authorField, or passwordPolicy.
const SECRET_KEY = String.raw`(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?|auth[_-]?token)(?:[_-]?(?:value|key|id))?(?![A-Za-z0-9])`;
// Quoted values in any file: password: "…", "apiKey": "…".
const ASSIGNED_SECRET = new RegExp(String.raw`(${SECRET_KEY}["']?\s*[:=]\s*["'])([^"'\s]{8,})(["'])`, "gi");
// Unquoted values in config-style files (YAML, INI, .properties, .npmrc, credentials).
const CONFIG_SECRET = new RegExp(String.raw`^(\s*[\w.\/:@-]*?${SECRET_KEY}\s*[:=]\s*)(?![\s"'$<{%!&*\[|>])([^\r\n]*?)(\s+[#;][^\r\n]*)?(\r?)$`, "i");
const CONFIG_FILE = /(\.(ya?ml|ini|cfg|conf|properties|toml|tfvars|hcl|npmrc|pypirc|netrc)$|(^|\/)(\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials|config)$)/i;
const NOT_A_SECRET = /^(true|false|null|none|nil|yes|no|on|off|~|\d+)$/i;
const REDACTED = "‹redacted›";

// Private keys span lines, so they're found from a file's full text, never from a hunk alone.
const KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
const KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
const BASE64_LINE = /^\s*[A-Za-z0-9+/]{16,}={0,2}\s*$/;
const ARMOR_LINE = /^\s*((Proc-Type|DEK-Info|Version|Comment|Hash|Charset): .*|=[A-Za-z0-9+/]{4}|)\s*$/i;

// 1-based numbers of the lines holding key material: the base64 body after a BEGIN marker.
// A line that merely mentions the marker (code, docs) is followed by non-base64 and yields nothing.
function keyLines(lines) {
  const out = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (!KEY_BEGIN.test(lines[i]) || KEY_END.test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && !KEY_END.test(lines[j]) && (BASE64_LINE.test(lines[j]) || ARMOR_LINE.test(lines[j]))) out.add(++j);
    i = j - 1;
  }
  return out;
}

// Could this hunk touch a private key? (Cheap check before reading whole files.)
const mayHoldKey = (s) => KEY_BEGIN.test(s) || KEY_END.test(s) || (s.length >= 40 && BASE64_LINE.test(s));

function isEnvFile(p) {
  const b = path.basename(p).toLowerCase();
  return b.startsWith(".env") && !/(example|sample|template|dist|defaults)/.test(b);
}

// Line redactor. Stateless: the same line always redacts the same way, wherever it appears.
function makeRedactor() {
  let count = 0;
  const fn = (s, file) => {
    if (typeof s !== "string" || !s) return s;
    let out = s;
    if (file && isEnvFile(file)) {
      out = out.replace(/^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*)([^\r\n]+?)(\r?)$/, (m, k, v, cr) => {
        count++;
        return k + REDACTED + cr;
      });
    } else if (file && CONFIG_FILE.test(file)) {
      out = out.replace(CONFIG_SECRET, (m, k, v, comment = "", cr) => {
        if (v.length < 6 || NOT_A_SECRET.test(v) || v === REDACTED) return m;
        count++;
        return k + REDACTED + comment + cr;
      });
    }
    for (const re of SECRET_PATTERNS) {
      out = out.replace(re, () => {
        count++;
        return REDACTED;
      });
    }
    out = out.replace(ASSIGNED_SECRET, (m, pre, val, post) => {
      if (val === REDACTED || /^(\$\{|process\.env|os\.environ|env\(|<|\{\{)/.test(val)) return m;
      count++;
      return pre + REDACTED + post;
    });
    return out;
  };
  fn.count = () => count;
  fn.bump = () => count++;
  return fn;
}

// Redact a file's lines given its full text (for key blocks) plus the line redactor.
function redactText(text, file, redact) {
  const lines = text.split("\n");
  const keys = keyLines(lines);
  return lines.map((l, i) => (keys.has(i + 1) ? (redact.bump(), REDACTED) : redact(l, file))).join("\n");
}

// Read a file as of a commit, or from the working tree. Symlinks yield their target path
// (what git stores), never the target's contents, and nothing outside the repo is read.
function readFileAt(root, { sha, worktree }, p, maxBytes = MAX_EMBED_FILE_BYTES) {
  if (!p || path.isAbsolute(p) || p.split(/[\\/]/).includes("..")) return null;
  if (worktree) {
    const abs = path.join(root, p);
    try {
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) return fs.readlinkSync(abs);
      if (!st.isFile() || st.size > maxBytes) return null;
      const real = fs.realpathSync(abs);
      if (!real.startsWith(fs.realpathSync(root) + path.sep)) return null;
      return fs.readFileSync(abs, "utf8");
    } catch {
      return null;
    }
  }
  const size = git(["cat-file", "-s", `${sha}:${p}`], { cwd: root, allowFail: true });
  if (!size || Number(size) > maxBytes) return null;
  return git(["show", `${sha}:${p}`], { cwd: root, allowFail: true });
}

// Redact a parsed file's hunks in place. Key blocks are located in the full old and new text,
// so a hunk that starts mid-key (or a key line used as git's hunk header) is still covered.
function redactHunks(f, redact, readOld, readNew) {
  const all = f.hunks.flatMap((h) => [h.header, ...h.lines.map((l) => l.s)]);
  let oldKeys = new Set();
  let newKeys = new Set();
  let blind = false; // couldn't read a side we needed: redact anything that looks like key material
  if (all.some(mayHoldKey)) {
    const oldText = f.status === "added" ? null : readOld(f.oldPath || f.path);
    const newText = f.status === "deleted" ? null : readNew(f.path);
    if (oldText) oldKeys = keyLines(oldText.split("\n"));
    if (newText) newKeys = keyLines(newText.split("\n"));
    blind = (f.status !== "added" && oldText == null) || (f.status !== "deleted" && newText == null);
  }
  const anyKeys = blind || oldKeys.size + newKeys.size > 0;
  const looksLikeKey = (s) => s.length >= 40 && BASE64_LINE.test(s);
  for (const h of f.hunks) {
    h.header = anyKeys && looksLikeKey(h.header) ? (redact.bump(), REDACTED) : redact(h.header, f.path);
    for (const l of h.lines) {
      const isKey = (l.t !== "+" && oldKeys.has(l.o)) || (l.t !== "-" && newKeys.has(l.n)) || (blind && looksLikeKey(l.s));
      l.s = isKey ? (redact.bump(), REDACTED) : redact(l.s, f.path);
    }
  }
}

// ───────────────────────────────────────────────────────────── collect

function repoRoot(cwd) {
  const r = git(["rev-parse", "--show-toplevel"], { cwd, allowFail: true });
  if (!r) die("not inside a git repository");
  return r.trim();
}

function revParse(root, ref) {
  const r = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: root, allowFail: true });
  return r ? r.trim() : null;
}

// The empty tree: the "before" of a repository's first commit.
function emptyTree(root) {
  return git(["hash-object", "-t", "tree", "--stdin"], { cwd: root, input: "" }).trim();
}

// A folder name per ref that never collides: lossy slugs get a short hash of the real name.
function refSlug(ref) {
  const s = slugify(ref);
  return s === ref ? s : `${s.slice(0, 50)}-${sha256(ref).slice(0, 6)}`;
}

function defaultBaseRef(root) {
  const sym = git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], { cwd: root, allowFail: true });
  if (sym) return sym.trim().replace("refs/remotes/", "");
  for (const c of ["origin/main", "origin/master", "main", "master", "origin/develop", "develop"]) {
    if (revParse(root, c)) return c;
  }
  return null;
}

function excludeFromGit(root, rel) {
  const common = git(["rev-parse", "--git-common-dir"], { cwd: root, allowFail: true });
  if (!common) return;
  const dir = path.resolve(root, common.trim(), "info");
  const file = path.join(dir, "exclude");
  try {
    fs.mkdirSync(dir, { recursive: true });
    const cur = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const entry = `/${rel.replace(/^\/+/, "")}/`;
    if (!cur.split("\n").includes(entry)) {
      fs.appendFileSync(file, `${cur && !cur.endsWith("\n") ? "\n" : ""}# human-review output\n${entry}\n`);
    }
  } catch {
    /* best effort */
  }
}

// Pin prefixes and disable textconv so output is independent of the user's git config
// (diff.noprefix, diff.mnemonicPrefix, textconv drivers).
const DIFF_FLAGS = ["-M", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/"];

function computePatch(root, { baseSha, headSha, worktree, context, outRel }) {
  const diffArgs = ["diff", ...DIFF_FLAGS, `-U${context}`, baseSha];
  if (!worktree) diffArgs.push(headSha);
  let patch = git(diffArgs, { cwd: root });
  let untracked = [];
  if (worktree) {
    untracked = git(["ls-files", "-z", "--others", "--exclude-standard"], { cwd: root })
      .split("\0")
      .filter((p) => p && !p.endsWith("/") && !p.startsWith(".human-review/") && !(outRel && p.startsWith(outRel + "/")));
    for (const p of untracked) {
      const d = git(["diff", ...DIFF_FLAGS, "--no-index", `-U${context}`, "--", "/dev/null", p], { cwd: root, okCodes: [0, 1], allowFail: true });
      if (d) patch += (patch.endsWith("\n") || !patch ? "" : "\n") + d;
    }
  }
  return { patch, untracked };
}

function collect(opts) {
  const root = repoRoot(process.cwd());
  const context = Number(opts.context ?? 3);
  let baseRef, baseSha, headRef, headSha;
  let worktree = false;
  let pr = null;
  let slug = opts.slug;

  if (opts.pr) {
    const num = String(opts.pr).replace(/^#/, "");
    const view = sh("gh", ["pr", "view", num, "--json", "number,title,body,url,baseRefName,headRefName,author"], { cwd: root });
    if (!view) die(`could not read PR ${num} with the GitHub CLI (is \`gh\` installed and authenticated?)`);
    const info = JSON.parse(view);
    pr = { number: info.number, title: info.title, url: info.url, author: info.author?.login, body: (info.body || "").slice(0, 4000) };
    git(["fetch", "--quiet", "origin", `pull/${info.number}/head`, info.baseRefName], { cwd: root });
    headSha = git(["rev-parse", "FETCH_HEAD"], { cwd: root }).trim();
    const fetched = git(["rev-parse", `origin/${info.baseRefName}`], { cwd: root, allowFail: true });
    const baseTip = fetched ? fetched.trim() : revParse(root, info.baseRefName);
    if (!baseTip) die(`base branch ${info.baseRefName} not found`);
    headRef = info.headRefName;
    baseRef = `origin/${info.baseRefName}`;
    baseSha = git(["merge-base", baseTip, headSha], { cwd: root }).trim();
    slug ||= `pr-${info.number}`;
  } else {
    const explicitHead = typeof opts.head === "string";
    headRef = explicitHead ? opts.head : (git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, allowFail: true }) || "HEAD").trim();
    headSha = revParse(root, explicitHead ? opts.head : "HEAD");
    if (!headSha) die(`cannot resolve head ${headRef}`);

    baseRef = typeof opts.base === "string" ? opts.base : defaultBaseRef(root);
    if (baseRef) {
      const tip = revParse(root, baseRef);
      if (!tip) die(`cannot resolve base ${baseRef}${/[~^]\d*$/.test(baseRef) && !revParse(root, `${headSha}~1`) ? " — HEAD is the repository's first commit; run collect without --base to review it" : ""}`);
      baseSha = typeof opts.base === "string" && opts["no-merge-base"] ? tip : git(["merge-base", tip, headSha], { cwd: root }).trim();
    } else {
      baseRef = "HEAD";
      baseSha = headSha;
    }

    const dirty = git(["status", "--porcelain", "--untracked-files=normal"], { cwd: root }).trim().length > 0;
    if (!explicitHead && opts.uncommitted !== "false" && !opts["no-uncommitted"] && dirty) worktree = true;
    if (opts.uncommitted === true) worktree = true;
    if (baseSha === headSha && !worktree && opts.base === undefined) {
      // On the default branch with nothing ahead: fall back to the last commit.
      // The first commit has no parent: compare it with the empty tree.
      const parent = revParse(root, `${headSha}~1`);
      baseSha = parent || emptyTree(root);
      baseRef = parent ? `${headRef}~1` : "(empty tree)";
    }
    const shaLike = headRef === "HEAD" || headSha.startsWith(headRef.toLowerCase());
    slug ||= refSlug(shaLike ? headSha.slice(0, 12) : headRef) + (worktree && baseSha === headSha ? "-uncommitted" : "");
  }

  const outRel = opts.out ? path.relative(root, path.resolve(opts.out)) : ".human-review";
  const patchSpec = { baseSha, headSha, worktree, context, outRel };
  const { patch, untracked } = computePatch(root, patchSpec);
  const fingerprint = sha256(patch);

  const files = parseUnifiedDiff(patch);
  const generated = linguistGenerated(root, files.map((f) => f.path));
  analyzeMechanical(files); // on the raw text, before redaction can make lines look alike
  for (const [t, src] of pairTests(files.map((f) => f.path))) files.find((f) => f.path === t).testFor = src;
  const redact = makeRedactor();
  const baseIsTree = !revParse(root, baseSha);
  for (const f of files) {
    f.language = languageFor(f.path);
    const why = generatedReason(f.path) || (generated.has(f.path) ? "marked linguist-generated in .gitattributes" : null);
    if (why) {
      f.generated = true;
      f.generatedBy = why;
    }
    redactHunks(
      f,
      redact,
      (p) => (baseIsTree ? null : readFileAt(root, { sha: baseSha }, p, Infinity)),
      (p) => readFileAt(root, { sha: headSha, worktree }, p, Infinity),
    );
  }
  if (pr) {
    pr.title = redact(pr.title, null);
    pr.body = redact(pr.body, null);
  }

  const range = worktree ? `${baseSha}..(working tree)` : `${baseSha}..${headSha}`;
  const logRange = baseSha === headSha ? null : baseIsTree ? headSha : `${baseSha}..${headSha}`;
  // --no-show-signature: log.showSignature would print verification lines into this output.
  const commits = logRange
    ? git(["log", "--no-show-signature", "--format=%h%x1f%an%x1f%aI%x1f%s", logRange], { cwd: root })
        .split("\n")
        .map((l) => l.split("\x1f"))
        .filter((parts) => parts.length === 4)
        .map(([sha, author, date, subject]) => ({ sha, author, date, subject: redact(subject, null) }))
    : [];

  const remote = (git(["remote", "get-url", "origin"], { cwd: root, allowFail: true }) || "").trim();
  const repoName = (remote.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/) || [])[1] || path.basename(root);

  const outDir = path.resolve(opts.out || path.join(root, ".human-review", slug));
  // Never overwrite another change's review (and silently inherit its recap.json).
  const prior = path.join(outDir, "diff.json");
  if (fs.existsSync(prior)) {
    let was = null;
    try {
      was = JSON.parse(fs.readFileSync(prior, "utf8"));
    } catch {
      /* unreadable — treat as ours */
    }
    if (was && (was.head?.ref !== headRef || (was.pr?.number ?? null) !== (pr?.number ?? null)))
      die(`${outDir} holds a review of ${was.pr ? `PR #${was.pr.number}` : was.head?.ref}, not ${pr ? `PR #${pr.number}` : headRef}. ${opts.out ? "Pass a different --out <dir>." : "Pass --slug <name> or --out <dir> to keep them apart."}`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  if (!opts.out) excludeFromGit(root, ".human-review");

  const diff = {
    tool: { name: "human-review", version: VERSION },
    collectedAt: new Date().toISOString(),
    root,
    repo: repoName,
    remote: remote.replace(/\/\/[^@/]+@/, "//"),
    base: { ref: baseRef, sha: baseSha },
    head: { ref: headRef, sha: headSha, worktree },
    pr,
    range,
    context,
    patchSpec,
    untracked,
    fingerprint,
    redactions: redact.count(),
    commits,
    files,
  };
  fs.writeFileSync(path.join(outDir, "diff.json"), JSON.stringify(diff));
  fs.writeFileSync(path.join(outDir, "review.txt"), renderReviewText(diff));

  const recapPath = path.join(outDir, "recap.json");
  let wroteSkeleton = false;
  if (!fs.existsSync(recapPath)) {
    fs.writeFileSync(recapPath, JSON.stringify(skeleton(diff), null, 2) + "\n");
    wroteSkeleton = true;
  }

  // Report
  const adds = files.reduce((a, f) => a + f.additions, 0);
  const dels = files.reduce((a, f) => a + f.deletions, 0);
  const out = [];
  out.push(`human-review: collected ${files.length} file${files.length === 1 ? "" : "s"} (+${adds} −${dels}) from ${repoName}`);
  out.push(`  base  ${baseRef} @ ${baseSha.slice(0, 10)}`);
  out.push(`  head  ${headRef} @ ${headSha.slice(0, 10)}${worktree ? " + uncommitted changes" : ""}${pr ? `  (PR #${pr.number})` : ""}`);
  out.push(`  ${commits.length} commit${commits.length === 1 ? "" : "s"}${untracked.length ? `, ${untracked.length} untracked file(s) included` : ""}`);
  if (diff.redactions) out.push(`  ${diff.redactions} secret-looking value(s) redacted from the diff`);
  out.push("");
  const w = Math.min(70, Math.max(...files.map((f) => f.path.length), 10));
  for (const f of files) {
    const flag = f.generated ? " generated" : f.mechanical ? " mechanical" : f.binary ? " binary" : "";
    out.push(`  ${f.status.padEnd(8)} ${f.path.padEnd(w)}  +${String(f.additions).padEnd(5)} −${String(f.deletions).padEnd(5)}${flag}`);
  }
  out.push("");
  out.push(`  dir       ${outDir}`);
  out.push(`  read      ${path.join(outDir, "review.txt")}   (line-numbered diff — annotate with these numbers)`);
  out.push(`  write     ${recapPath}${wroteSkeleton ? "   (skeleton created)" : "   (exists — left untouched)"}`);
  out.push(`  then run  ${RUNTIME} ${path.join(SKILL_DIR, "scripts", "human-review.mjs")} build "${outDir}" --open`);
  if (files.length === 0) out.push("\n  No changes found. Pass --base <ref>, --head <ref>, or --pr <number>.");
  process.stdout.write(out.join("\n") + "\n");
}

function renderReviewText(diff) {
  const out = [];
  out.push(`# human-review diff view — ${diff.repo}`);
  out.push(`# base ${diff.base.ref} @ ${diff.base.sha.slice(0, 10)}   head ${diff.head.ref} @ ${diff.head.sha.slice(0, 10)}${diff.head.worktree ? " + uncommitted" : ""}`);
  out.push("# Columns: OLD line │ NEW line │ marker + code.  Annotate with the NEW number;");
  out.push('# for a removed line use the OLD number with "side": "old".');
  if (diff.commits.length) {
    out.push("#");
    out.push("# Commits:");
    for (const c of diff.commits) out.push(`#   ${c.sha} ${c.subject}  (${c.author})`);
  }
  out.push("");
  for (const f of diff.files) {
    const label = f.status === "renamed" ? `${f.oldPath} → ${f.path}` : f.path;
    out.push(`${"═".repeat(100)}`);
    out.push(`FILE ${label}   [${f.status} +${f.additions} −${f.deletions}]${f.language ? `  ${f.language}` : ""}`);
    if (f.binary) {
      out.push("  (binary file)");
      continue;
    }
    const changed = f.additions + f.deletions;
    if (f.generated) {
      out.push(`  (generated: ${f.generatedBy} — hunks omitted here; they are still in diff.json)`);
      continue;
    }
    if (f.mechanical) {
      out.push(`  (mechanical: ${f.mechanical.proof.replace(/\`/g, "")} — hunks omitted here)`);
      continue;
    }
    if (changed > 4000) {
      out.push(`  (very large: ${changed} changed lines — only the first 400 diff lines are shown here)`);
    }
    let shown = 0;
    f.hunks.forEach((h, i) => {
      if (changed > 4000 && shown > 400) return;
      const span = (start, count) => (count === 0 ? "none" : `${start}–${start + count - 1}`);
      const oldRange = `old lines ${span(h.oldStart, h.oldLines)}`;
      const newRange = `new lines ${span(h.newStart, h.newLines)}`;
      const ranges = f.status === "added" ? newRange : f.status === "deleted" ? oldRange : `${newRange} · ${oldRange}`;
      out.push(`@@ hunk ${i + 1} · ${ranges}${h.header ? ` · ${h.header}` : ""}`);
      for (const l of h.lines) {
        const o = l.o !== undefined ? String(l.o).padStart(5) : "     ";
        const n = l.n !== undefined ? String(l.n).padStart(5) : "     ";
        out.push(`${o} ${n} │${l.t}${l.s}${l.mv && l.mv[1] !== f.path ? `   ⟵ moved ${l.t === "+" ? "from" : "to"} ${l.mv[1]}:${l.mv[2]}` : ""}`);
        shown++;
      }
    });
  }
  return out.join("\n") + "\n";
}

function skeleton(diff) {
  const files = {};
  for (const f of diff.files) {
    if (f.generated || f.mechanical) continue; // tiered automatically, with proof
    files[f.path] = { review: "skim", note: "" };
  }
  return {
    title: diff.pr?.title || "",
    brief: "",
    risk: { level: "", why: "" },
    summary: [],
    focus: [],
    sections: [],
    keyChanges: [],
    questions: [],
    checks: { verified: [], manual: [] },
    concerns: suggestConcerns(diff.files),
    files,
  };
}

// ───────────────────────────────────────────────────────────── validation

const BLOCK_TYPES = new Set([
  "markdown", "callout", "diff", "code", "compare", "tabs", "wireframe", "screenshot",
  "mermaid", "diagram", "dataModel", "api", "states",
]);
const CHANGE = new Set(["added", "removed", "modified", "renamed", "unchanged"]);
const ANNOTATION_KINDS = new Set(["note", "risk", "question", "decision", "praise"]);
const CALLOUT_KINDS = new Set(["note", "risk", "breaking", "decision", "question", "security", "perf"]);
const SURFACES = new Set(["browser", "desktop", "mobile", "popover", "panel", "bare"]);
const TEXT_KEYS = new Set(["md", "html", "css", "source", "brief", "intro", "why", "summary", "note", "caption", "text"]);
// Ids the page itself uses; recap ids must not shadow them.
const RESERVED_IDS = new Set(["top", "main", "app", "overview", "key-changes", "checks", "files", "hr-data", "hr-title", "hr-top-title"]);
const isReservedId = (id) => RESERVED_IDS.has(id) || /^(file-|t\d+-|v-|mmd\d)/.test(id);
const VALID_ID = /^[A-Za-z][\w-]*$/;
// Tags the renderer strips together with everything inside them.
const STRIPPED_TAGS = /<(script|style|link|meta|base|html|body|head|form|iframe|object|embed|frame|frameset|foreignobject|animate|set|animatetransform|animatemotion)\b/i;

// Long text fields may be written as an array of lines — join them.
// The top-level `summary` is a bullet list and API `example`s are JSON values, so neither is joined.
function normalizeText(node, depth = 0) {
  if (Array.isArray(node)) return node.map((x) => normalizeText(x, depth + 1));
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "example") continue;
      if ((depth > 0 || k === "brief") && TEXT_KEYS.has(k) && Array.isArray(v) && v.every((x) => typeof x === "string")) node[k] = v.join("\n");
      else node[k] = normalizeText(v, depth + 1);
    }
  }
  return node;
}

// Every explicit block id in the recap, so generated ids never take one.
function explicitIds(node, out = new Set()) {
  if (Array.isArray(node)) node.forEach((x) => explicitIds(x, out));
  else if (node && typeof node === "object") {
    if (typeof node.type === "string" && typeof node.id === "string") out.add(node.id);
    for (const v of Object.values(node)) if (v && typeof v === "object") explicitIds(v, out);
  }
  return out;
}

const isStringList = (v) => Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim());

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

function nearPaths(p, paths) {
  const want = String(p || "");
  const base = path.basename(want);
  return paths
    .map((k) => ({ k, score: Math.min(editDistance(want, k), editDistance(base, path.basename(k)) + (k.endsWith(want) ? 0 : 1)) }))
    .filter((x) => x.score <= Math.max(3, Math.floor(base.length / 3)))
    .sort((a, b) => a.score - b.score)
    .slice(0, 3)
    .map((x) => x.k);
}

function validate(recap, diff, recapDir) {
  const errors = [];
  const warnings = [];
  const err = (p, m) => errors.push(`${p}: ${m}`);
  const warn = (p, m) => warnings.push(`${p}: ${m}`);
  const byPath = new Map(diff.files.map((f) => [f.path, f]));
  const ids = new Set();
  const declared = explicitIds(recap);
  const referencedFiles = new Set();
  const codeFiles = new Set();
  const screenshots = new Set();
  const typesUsed = new Set();
  const codeBlocks = [];
  const lineRefs = [];

  // Generated ids come from the block's content, so inserting or reordering other blocks
  // doesn't move a reviewer's saved comments onto a different block.
  const autoId = (b) => {
    const base = `b-${sha256(JSON.stringify(b, (k, v) => (k === "id" ? undefined : v))).slice(0, 7)}`;
    let id = base;
    for (let n = 2; ids.has(id) || declared.has(id); n++) id = `${base}-${n}`;
    return id;
  };

  const visible = (f, blk) => {
    // Lines shown by a diff block, honoring its `lines` / `hunks` selection.
    const hunks = selectHunks(f, blk);
    const n = new Set();
    const o = new Set();
    for (const h of hunks) for (const l of h.lines) {
      if (l.n !== undefined) n.add(l.n);
      if (l.o !== undefined) o.add(l.o);
    }
    return { n, o, hunks };
  };

  const ranges = (set) => {
    const a = [...set].sort((x, y) => x - y);
    const out = [];
    for (const v of a) {
      const last = out[out.length - 1];
      if (last && v === last[1] + 1) last[1] = v;
      else out.push([v, v]);
    }
    return out.map(([s, e]) => (s === e ? `${s}` : `${s}-${e}`)).join(", ");
  };

  const checkAnnotations = (p, list, check) => {
    if (list === undefined) return;
    if (!Array.isArray(list)) return err(p, "annotations must be an array");
    list.forEach((a, i) => {
      const ap = `${p}[${i}]`;
      if (typeof a.text !== "string" || !a.text.trim()) err(ap, "annotation needs `text`");
      if (a.kind && !ANNOTATION_KINDS.has(a.kind)) err(ap, `unknown kind "${a.kind}" (use ${[...ANNOTATION_KINDS].join(", ")})`);
      if (!Number.isInteger(a.line)) return err(ap, "annotation needs an integer `line`");
      if (a.to !== undefined && (!Number.isInteger(a.to) || a.to < a.line)) err(ap, "`to` must be an integer ≥ line");
      check(a, ap);
    });
  };

  const block = (b, p) => {
    if (!b || typeof b !== "object") return err(p, "block must be an object");
    if (!BLOCK_TYPES.has(b.type)) return err(p, `unknown block type "${b.type}" (valid: ${[...BLOCK_TYPES].join(", ")})`);
    typesUsed.add(b.type);
    if (b.id !== undefined) {
      if (typeof b.id !== "string" || !VALID_ID.test(b.id)) err(p, `id "${b.id}" must start with a letter and use only letters, digits, - and _`);
      else if (isReservedId(b.id)) err(p, `id "${b.id}" is used by the page itself — pick another`);
      if (ids.has(b.id)) err(p, `duplicate id "${b.id}"`);
      ids.add(b.id);
    } else {
      b.id = autoId(b);
      ids.add(b.id);
    }
    switch (b.type) {
      case "markdown":
        if (typeof b.md !== "string") err(p, "markdown block needs `md`");
        break;
      case "callout":
        if (b.kind && !CALLOUT_KINDS.has(b.kind)) err(p, `unknown callout kind "${b.kind}" (use ${[...CALLOUT_KINDS].join(", ")})`);
        if (typeof b.md !== "string" && typeof b.title !== "string") err(p, "callout needs `title` or `md`");
        break;
      case "diff": {
        const f = byPath.get(b.file);
        if (!f) {
          const near = nearPaths(b.file, [...byPath.keys()]);
          return err(p, `file "${b.file}" is not in this diff${near.length ? ` (did you mean ${near.join(", ")}?)` : ""}`);
        }
        referencedFiles.add(f.path);
        if (b.mode && !["split", "unified"].includes(b.mode)) err(p, 'mode must be "split" or "unified"');
        if (!b.summary) warn(p, `diff of ${b.file} has no \`summary\` — say what the hunk does and why`);
        if (b.hunks !== undefined) {
          if (!Array.isArray(b.hunks) || b.hunks.some((i) => !Number.isInteger(i) || i < 1 || i > f.hunks.length))
            return err(`${p}.hunks`, `must be hunk numbers between 1 and ${f.hunks.length} (as numbered in review.txt)`);
          b.hunks = [...new Set(b.hunks)].sort((x, y) => x - y);
        }
        const vis = visible(f, b);
        if (b.lines && vis.hunks.length === 0)
          return err(`${p}.lines`, `no hunk of ${b.file} overlaps lines ${b.lines.join("-")} (hunks cover new lines ${f.hunks.map((h) => `${h.newStart}-${h.newStart + h.newLines - 1}`).join(", ")})`);
        if ((b.annotations || []).length > 6) warn(`${p}.annotations`, `${b.annotations.length} notes on ${b.file} — more than ~5 dilutes the ones that matter`);
        checkAnnotations(`${p}.annotations`, b.annotations, (a, ap) => {
          const set = a.side === "old" ? vis.o : vis.n;
          const sideName = a.side === "old" ? "old" : "new";
          if (!set.has(a.line)) {
            const other = a.side === "old" ? vis.n : vis.o;
            const hint = other.has(a.line) ? ` (that number exists on the ${a.side === "old" ? "new" : "old"} side — set "side" accordingly)` : "";
            err(ap, `line ${a.line} is not a visible ${sideName}-side line in ${b.file}; visible: ${ranges(set) || "none"}${hint}`);
          } else if (Number.isInteger(a.to) && a.to !== a.line && !set.has(a.to)) {
            err(ap, `"to": ${a.to} is not a visible ${sideName}-side line in ${b.file}; visible: ${ranges(set)}`);
          }
        });
        break;
      }
      case "code": {
        if (typeof b.file !== "string") return err(p, "code block needs `file`");
        if (path.isAbsolute(b.file) || b.file.split(/[\\/]/).includes("..")) return err(p, "`file` must be a path inside the repo, relative to its root");
        if (b.lines && (!Array.isArray(b.lines) || b.lines.length !== 2)) err(p, "`lines` must be [start, end]");
        codeFiles.add(b.file);
        codeBlocks.push({ b, p });
        b.language ||= languageFor(b.file);
        break;
      }
      case "compare": {
        const sides = b.before !== undefined || b.after !== undefined ? ["before", "after"] : null;
        if (!sides && !Array.isArray(b.columns)) return err(p, "compare needs `before` and `after` (or `columns`)");
        if (sides) {
          for (const s of sides) {
            if (b[s] === undefined) continue;
            const list = Array.isArray(b[s]) ? b[s] : [b[s]];
            list.forEach((c, i) => block(c, `${p}.${s}${Array.isArray(b[s]) ? `[${i}]` : ""}`));
          }
        } else {
          b.columns.forEach((c, i) => {
            if (!Array.isArray(c.blocks)) return err(`${p}.columns[${i}]`, "column needs `blocks`");
            c.blocks.forEach((x, j) => block(x, `${p}.columns[${i}].blocks[${j}]`));
          });
        }
        break;
      }
      case "tabs":
        if (!Array.isArray(b.tabs) || !b.tabs.length) return err(p, "tabs needs a non-empty `tabs` array");
        b.tabs.forEach((t, i) => {
          if (!t.label) err(`${p}.tabs[${i}]`, "tab needs `label`");
          const list = t.blocks || (t.block ? [t.block] : []);
          if (!list.length) err(`${p}.tabs[${i}]`, "tab needs `blocks`");
          list.forEach((x, j) => block(x, `${p}.tabs[${i}].blocks[${j}]`));
        });
        break;
      case "wireframe":
        if (typeof b.html !== "string") err(p, "wireframe needs `html`");
        if (b.surface && !SURFACES.has(b.surface)) err(p, `unknown surface "${b.surface}" (use ${[...SURFACES].join(", ")})`);
        if (typeof b.html === "string") {
          const tag = STRIPPED_TAGS.exec(b.html);
          if (tag) err(p, `wireframe html can't use <${tag[1].toLowerCase()}>: the page removes it and everything inside it (use a <div>)`);
          if (/(?:color|background|border)[^;"']*#[0-9a-f]{3,8}\b/i.test(b.html)) warn(p, "wireframe uses hex colors — use var(--wf-*) tokens so it works in light and dark");
          if (/font-family/i.test(b.html)) warn(p, "wireframe sets font-family — the renderer owns fonts");
        }
        break;
      case "screenshot": {
        if (typeof b.src !== "string") return err(p, "screenshot needs `src` (path relative to recap.json)");
        const abs = path.resolve(recapDir, b.src);
        if (!fs.existsSync(abs)) err(p, `screenshot not found: ${abs}`);
        else {
          const size = fs.statSync(abs).size;
          if (size > MAX_SCREENSHOT_BYTES) err(p, `screenshot is ${(size / 1e6).toFixed(1)} MB — keep under ${MAX_SCREENSHOT_BYTES / 1e6} MB (crop or use JPEG)`);
          screenshots.add(b.src);
        }
        break;
      }
      case "mermaid":
        if (typeof b.source !== "string") err(p, "mermaid needs `source`");
        break;
      case "diagram":
        if (typeof b.html !== "string") err(p, "diagram needs `html`");
        else if (STRIPPED_TAGS.test(b.html)) err(p, `diagram html can't use <${STRIPPED_TAGS.exec(b.html)[1].toLowerCase()}>: the page removes it and everything inside it (put CSS in \`css\`)`);
        break;
      case "dataModel":
        if (!Array.isArray(b.entities) || !b.entities.length) return err(p, "dataModel needs `entities`");
        b.entities.forEach((e, i) => {
          const ep = `${p}.entities[${i}]`;
          if (!e.name) err(ep, "entity needs `name`");
          if (e.change && !CHANGE.has(e.change)) err(ep, `unknown change "${e.change}"`);
          (e.fields || []).forEach((fl, j) => {
            if (!fl.name) err(`${ep}.fields[${j}]`, "field needs `name`");
            if (fl.change && !CHANGE.has(fl.change)) err(`${ep}.fields[${j}]`, `unknown change "${fl.change}"`);
          });
        });
        break;
      case "api":
        if (!Array.isArray(b.endpoints) || !b.endpoints.length) return err(p, "api needs `endpoints`");
        b.endpoints.forEach((e, i) => {
          const ep = `${p}.endpoints[${i}]`;
          if (!e.method || !e.path) err(ep, "endpoint needs `method` and `path`");
          if (e.change && !CHANGE.has(e.change)) err(ep, `unknown change "${e.change}"`);
          const ex = [e.request?.example, ...(e.responses || []).map((r) => r.example)].filter((x) => x !== undefined);
          for (const x of ex) {
            if (typeof x === "string") {
              try {
                JSON.parse(x);
              } catch {
                warn(ep, "an example is a string that is not valid JSON — it will render as plain text");
              }
            }
          }
        });
        break;
      case "states":
        if (!Array.isArray(b.columns) || !Array.isArray(b.rows)) return err(p, "states needs `columns` and `rows`");
        b.rows.forEach((r, i) => {
          if (!r || typeof r.label !== "string") err(`${p}.rows[${i}]`, "row needs `label`");
          else if ((r.cells || []).length !== b.columns.length) warn(`${p}.rows[${i}]`, `${(r.cells || []).length} cells for ${b.columns.length} columns`);
        });
        break;
    }
  };

  // Top level
  const known = new Set(["title", "brief", "risk", "summary", "focus", "sections", "keyChanges", "questions", "checks", "concerns", "files", "$schema"]);
  for (const k of Object.keys(recap)) if (!known.has(k)) warn(k, "unknown top-level key (ignored)");
  if (!recap.title || !String(recap.title).trim()) err("title", "required");
  else if (recap.title.length > 70) warn("title", `${recap.title.length} chars — keep it to 70 or fewer`);
  if (!recap.brief) warn("brief", "add 1–3 sentences: what changed and why");
  if (!recap.risk || !recap.risk.level) warn("risk", 'set risk.level to "low", "medium", or "high" and say why');
  else {
    if (!["low", "medium", "high"].includes(recap.risk.level)) err("risk.level", 'must be "low", "medium", or "high"');
    if (!recap.risk.why) warn("risk.why", "say why in one line");
  }
  if (recap.summary !== undefined && !(Array.isArray(recap.summary) && recap.summary.every((x) => typeof x === "string"))) err("summary", "must be an array of strings");
  if (Array.isArray(recap.summary) && recap.summary.length === 0) warn("summary", "empty — add 2–5 bullets");
  if (Array.isArray(recap.focus) && recap.focus.length === 0 && diff.files.length > 2) warn("focus", "empty — add 3–6 stops, riskiest first");
  if (recap.questions !== undefined && !isStringList(recap.questions)) err("questions", "must be an array of non-empty strings");
  if (recap.checks !== undefined) {
    const c = recap.checks;
    if (!c || typeof c !== "object" || Array.isArray(c)) err("checks", "must be an object with `verified` and/or `manual` arrays");
    else {
      if (c.verified !== undefined && !(Array.isArray(c.verified) && c.verified.every((v) => (typeof v === "string" && v.trim()) || (v && typeof v.text === "string" && v.text.trim()))))
        err("checks.verified", 'must be an array of strings or { "text": "…", "cmd": "…" } objects');
      if (c.manual !== undefined && !isStringList(c.manual)) err("checks.manual", "must be an array of non-empty strings");
    }
  }
  const sectionIds = new Set();
  (recap.sections || []).forEach((s, i) => {
    const sp = `sections[${i}]`;
    if (!s.title) err(sp, "section needs `title`");
    if (!Array.isArray(s.blocks)) return err(sp, "section needs `blocks`");
    if (s.id !== undefined) {
      if (typeof s.id !== "string" || !VALID_ID.test(s.id)) err(`${sp}.id`, `"${s.id}" must start with a letter and use only letters, digits, - and _`);
      else if (isReservedId(s.id) || sectionIds.has(s.id) || declared.has(s.id)) err(`${sp}.id`, `"${s.id}" is already used on the page`);
    } else {
      // Slug of the title, made unique against built-in sections, other sections, and block ids.
      const base = String(s.title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || `section-${i + 1}`;
      const start = /^[a-z]/.test(base) ? base : `s-${base}`;
      s.id = start;
      for (let n = 2; isReservedId(s.id) || sectionIds.has(s.id) || declared.has(s.id); n++) s.id = `${start}-${n}`;
    }
    sectionIds.add(s.id);
    s.blocks.forEach((b, j) => block(b, `${sp}.blocks[${j}]`));
  });
  if (!Array.isArray(recap.keyChanges)) {
    if (recap.keyChanges !== undefined) err("keyChanges", "must be an array of diff/code blocks");
  } else {
    if (recap.keyChanges.length === 0 && diff.files.length > 2) warn("keyChanges", "empty — add 3–8 annotated diffs of the load-bearing files");
    if (recap.keyChanges.length > 10) warn("keyChanges", `${recap.keyChanges.length} tabs — more than ~8 stops being a summary`);
    recap.keyChanges.forEach((b, i) => {
      if (!b.type) b.type = "diff";
      if (b.type !== "diff" && b.type !== "code") err(`keyChanges[${i}]`, 'key changes must be "diff" or "code" blocks');
      block(b, `keyChanges[${i}]`);
      if (b.type === "diff" && !(b.annotations || []).length) warn(`keyChanges[${i}]`, `no annotations on ${b.file} — add a few on the load-bearing lines`);
    });
  }
  if (recap.files && typeof recap.files === "object") {
    for (const [p, v] of Object.entries(recap.files)) {
      if (!byPath.has(p)) {
        warn(`files["${p}"]`, `not in this diff (ignored)${nearPaths(p, [...byPath.keys()]).length ? ` — did you mean ${nearPaths(p, [...byPath.keys()]).join(", ")}?` : ""}`);
        continue;
      }
      if (!v || !v.review) continue;
      if (v.review === "skip") {
        warn(`files["${p}"].review`, '"skip" is gone — generated and mechanical files are detected automatically, with proof; using the automatic tier (or "skim")');
        delete v.review;
      } else if (v.review === "mechanical" || v.review === "generated") err(`files["${p}"].review`, `"${v.review}" is computed from the diff, not set by hand — use "careful" or "skim"`);
      else if (!["careful", "skim"].includes(v.review)) err(`files["${p}"].review`, 'must be "careful" or "skim"');
    }
  }

  // Concerns: named groups of related files, in reading order. Older recaps grouped files by
  // `files[path].group`; those become concerns so they still render.
  if (recap.concerns === undefined && recap.files && Object.values(recap.files).some((v) => v && v.group)) {
    const legacy = new Map();
    for (const [p, v] of Object.entries(recap.files)) if (v && v.group && byPath.has(p)) legacy.set(v.group, [...(legacy.get(v.group) || []), p]);
    recap.concerns = [...legacy].filter(([g]) => g !== "Generated").map(([title, paths]) => ({ title, files: paths }));
    warn("files[…].group", "is replaced by `concerns` (named groups of related files, tests next to their code) — converted for now");
  }
  const autoTier = (f) => f.generated || f.mechanical;
  if (recap.concerns !== undefined) {
    if (!Array.isArray(recap.concerns)) err("concerns", "must be an array of { title, why, files }");
    else {
      const owner = new Map();
      const concernIds = new Set();
      recap.concerns.forEach((c, i) => {
        const cp = `concerns[${i}]`;
        if (!c || typeof c !== "object") return err(cp, "must be an object");
        if (typeof c.title !== "string" || !c.title.trim()) err(cp, "needs a `title` naming what these files do together");
        else if (c.files && c.files.length > 1 && !(typeof c.why === "string" && c.why.trim())) warn(`${cp}.why`, `"${c.title}" has no one-line \`why\``);
        if (!Array.isArray(c.files) || !c.files.length) return err(cp, "needs a non-empty `files` list, in reading order");
        c.files.forEach((p, j) => {
          if (!byPath.has(p)) {
            const near = nearPaths(p, [...byPath.keys()]);
            return err(`${cp}.files[${j}]`, `"${p}" is not in this diff${near.length ? ` (did you mean ${near.join(", ")}?)` : ""}`);
          }
          if (owner.has(p)) err(`${cp}.files[${j}]`, `"${p}" is already in concerns[${owner.get(p)}] — each file belongs to one concern`);
          else owner.set(p, i);
        });
        const base = `c-${String(c.title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || i + 1}`;
        c.id = base;
        for (let n = 2; concernIds.has(c.id) || ids.has(c.id) || sectionIds.has(c.id) || isReservedId(c.id); n++) c.id = `${base}-${n}`;
        concernIds.add(c.id);
        sectionIds.add(c.id); // concerns are page sections too, reachable from focus refs
      });
      const loose = diff.files.filter((f) => !owner.has(f.path) && !autoTier(f)).map((f) => f.path);
      if (loose.length) warn("concerns", `${loose.length} file(s) aren't in any concern and will be listed under "Other changes": ${loose.slice(0, 5).join(", ")}${loose.length > 5 ? ", …" : ""}`);
      for (const [t, src] of pairTests(diff.files.map((f) => f.path))) {
        if (owner.has(t) && owner.has(src) && owner.get(t) !== owner.get(src))
          warn("concerns", `${t} tests ${src} but sits in a different concern — keep tests next to the code they test`);
      }
    }
  }
  for (const id of sectionIds) if (ids.has(id)) err("sections", `section id "${id}" is also a block id`);

  // Built-in sections exist only when they have content.
  const builtIn = new Set(["files"]);
  if ((recap.summary || []).length || (recap.focus || []).length) builtIn.add("overview");
  if ((recap.keyChanges || []).length) builtIn.add("key-changes");
  if ((recap.questions || []).length || (recap.checks?.verified || []).length || (recap.checks?.manual || []).length) builtIn.add("checks");
  if (recap.focus !== undefined) {
    if (!Array.isArray(recap.focus)) err("focus", "must be an array");
    else
      recap.focus.forEach((f, i) => {
        if (!f || !f.title) err(`focus[${i}]`, "needs `title`");
        if (f && f.ref) checkRef(f.ref, `focus[${i}].ref`);
      });
  }

  function checkRef(ref, p) {
    if (typeof ref !== "string") return err(p, "ref must be a string");
    if (ref.startsWith("#")) {
      const id = ref.slice(1);
      if (RESERVED_IDS.has(id) && !builtIn.has(id)) err(p, `"${ref}" isn't on this page (that section only appears when it has content)`);
      else if (!ids.has(id) && !sectionIds.has(id) && !builtIn.has(id)) err(p, `no block or section with id "${id}"`);
      return;
    }
    const m = /^(.+?)(?::(\d+)(?:-(\d+))?)?$/.exec(ref);
    if (!m || !byPath.has(m[1])) {
      const near = m ? nearPaths(m[1], [...byPath.keys()]) : [];
      return err(p, `"${ref}" — expected "#block-id" or "path/in/diff.ts:42" with a path from this diff${near.length ? ` (did you mean ${near.join(", ")}?)` : ""}`);
    }
    if (m[2]) lineRefs.push({ p, file: m[1], line: Number(m[3] || m[2]) });
  }

  // Checks that need file contents; build calls this once they are loaded.
  const finish = (contents) => {
    const lineCount = (t) => (t.endsWith("\n") ? t.split("\n").length - 1 : t.split("\n").length);
    for (const r of lineRefs) {
      const f = byPath.get(r.file);
      const t = contents[r.file];
      if (f && f.status !== "deleted" && t != null && r.line > lineCount(t)) err(r.p, `line ${r.line} is past the end of ${r.file} (${lineCount(t)} lines)`);
    }
    for (const { b, p } of codeBlocks) {
      const t = contents[b.file];
      if (t == null) {
        err(p, `cannot read ${b.file} at head`);
        continue;
      }
      const len = lineCount(t);
      const [s, e] = b.lines || [1, len];
      if (s < 1 || e > len || s > e) err(`${p}.lines`, `range ${s}-${e} is outside ${b.file} (${len} lines)`);
      checkAnnotations(`${p}.annotations`, b.annotations, (a, ap) => {
        if (a.side === "old") err(ap, 'code blocks show the file at head — remove `"side": "old"`');
        else if (a.line < s || a.line > e) err(ap, `line ${a.line} is outside the shown range ${s}-${e}`);
        else if (Number.isInteger(a.to) && a.to > e) err(ap, `"to": ${a.to} is outside the shown range ${s}-${e}`);
      });
    }
  };

  return { errors, warnings, referencedFiles, codeFiles, screenshots, typesUsed, finish };
}

function selectHunks(f, blk) {
  let hunks = f.hunks;
  if (Array.isArray(blk.hunks)) hunks = blk.hunks.map((i) => f.hunks[i - 1]).filter(Boolean);
  if (Array.isArray(blk.lines) && blk.lines.length === 2) {
    const [s, e] = blk.lines;
    hunks = hunks.filter((h) => h.newStart <= e && h.newStart + Math.max(h.newLines, 1) - 1 >= s);
  }
  return hunks;
}

// ───────────────────────────────────────────────────────────── build

const looksBinary = (s) => s.includes("\u0000");

function build(opts) {
  const dir = path.resolve(opts._[1] || ".");
  const diff = readJSON(path.join(dir, "diff.json"), "diff.json (run `collect` first)");
  const recap = normalizeText(readJSON(path.join(dir, "recap.json"), "recap.json"));

  const { errors, warnings, referencedFiles, codeFiles, screenshots, typesUsed, finish } = validate(recap, diff, dir);

  // Has the code moved since collect? (Same patch recipe as collect, untracked files included.)
  let stale = false;
  const repoHere = fs.existsSync(diff.root);
  if (!repoHere) warnings.push(`repo: ${diff.root} no longer exists — file contents for context expansion are not embedded`);
  else {
    try {
      if (diff.patchSpec) stale = sha256(computePatch(diff.root, diff.patchSpec).patch) !== diff.fingerprint;
      if (!diff.head.worktree && !diff.pr && diff.head.ref !== "HEAD") {
        const headNow = revParse(diff.root, diff.head.ref);
        if (headNow && headNow !== diff.head.sha) warnings.push(`head: ${diff.head.ref} has moved since collect (${diff.head.sha.slice(0, 8)} → ${headNow.slice(0, 8)}) — rerun collect to include new commits`);
      }
    } catch (e) {
      warnings.push(`repo: could not compare with git (${e.message.split("\n")[0]}) — skipped the staleness check`);
    }
  }
  if (stale) warnings.push("diff: the working tree changed since collect — rerun collect so the review matches the code");

  // Embed file contents for context expansion and `code` blocks.
  const redact = makeRedactor();
  const contents = {};
  let total = 0;
  const head = { sha: diff.head.sha, worktree: diff.head.worktree };
  const wanted = [...referencedFiles, ...codeFiles];
  for (const f of diff.files) if (!f.generated && !f.binary && f.status !== "deleted") wanted.push(f.path);
  for (const p of repoHere ? [...new Set(wanted)] : []) {
    if (total > MAX_EMBED_TOTAL_BYTES && !codeFiles.has(p)) continue;
    const text = readFileAt(diff.root, head, p);
    if (text == null || looksBinary(text)) continue;
    contents[p] = redactText(text, p, redact);
    total += text.length;
  }
  finish(contents);

  for (const w of warnings) process.stderr.write(`  warn   ${w}\n`);
  for (const e of errors) process.stderr.write(`  error  ${e}\n`);
  if (errors.length) die(`${errors.length} error(s) in recap.json — fix them and build again`, 2);
  if (opts.check) {
    process.stdout.write(`human-review: recap.json is valid${warnings.length ? ` (${warnings.length} warning(s))` : ""}\n`);
    return;
  }

  // Screenshots → data URIs
  const assets = {};
  for (const src of screenshots) {
    const abs = path.resolve(dir, src);
    const ext = path.extname(abs).slice(1).toLowerCase();
    const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" }[ext] || "application/octet-stream";
    assets[src] = `data:${mime};base64,${fs.readFileSync(abs).toString("base64")}`;
  }

  const needs = { mermaid: typesUsed.has("mermaid"), rough: typesUsed.has("wireframe") };

  const data = {
    recap,
    diff: { ...diff, root: undefined, patchSpec: undefined },
    contents,
    assets,
    meta: { builtAt: new Date().toISOString(), version: VERSION, stale, types: [...typesUsed], contentRedactions: redact.count() },
  };

  const read = (p) => fs.readFileSync(path.join(ASSETS, p), "utf8");
  // Keep the HTML parser from ending or re-entering an inline script early. The replacements
  // must mean the same thing inside JS strings AND regexes — including `u`-flag regexes, where
  // an escape like `\!` is a syntax error — so `!` becomes the hex escape `\x21`.
  const scriptSafe = (s) => s.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\x21--");
  const font = fs.readFileSync(path.join(ASSETS, "vendor", "architects-daughter.woff2")).toString("base64");

  const vendor = [read("vendor/highlight.min.js"), read("vendor/marked.min.js")];
  if (needs.rough) vendor.push(read("vendor/rough.min.js"));
  if (needs.mermaid) vendor.push(read("vendor/mermaid.min.js"));

  const title = String(recap.title || "Review").replace(/`/g, "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]);
  // Single pass: substituted content (which may itself mention a placeholder,
  // e.g. when reviewing this skill) is never scanned again.
  const fills = {
    "%TITLE%": () => title,
    "/*%FONT_FACE%*/": () => (needs.rough ? `@font-face{font-family:"HR Sketch";src:url(data:font/woff2;base64,${font}) format("woff2");font-display:block}` : ""),
    "/*%CSS%*/": () => read("app.css"),
    "%DATA%": () => JSON.stringify(data).replace(/</g, "\\u003c"),
    "/*%VENDOR%*/": () => vendor.map(scriptSafe).join("\n;\n"),
    "/*%APP%*/": () => scriptSafe(read("app.js")),
  };
  const html = read("template.html").replace(/%TITLE%|%DATA%|\/\*%(?:FONT_FACE|CSS|VENDOR|APP)%\*\//g, (m) => fills[m]());

  const outFile = path.resolve(opts.out || path.join(dir, "review.html"));
  fs.writeFileSync(outFile, html);
  const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
  process.stdout.write(`human-review: wrote ${outFile} (${kb} KB${warnings.length ? `, ${warnings.length} warning(s)` : ""})\n`);
  if (redact.count()) process.stdout.write(`  ${redact.count()} secret-looking value(s) redacted from embedded file contents\n`);
  if (opts.open) openFile(outFile);
}

function openFile(file) {
  const cmd = process.platform === "darwin" ? ["open", [file]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", file]] : ["xdg-open", [file]];
  const r = spawnSync(cmd[0], cmd[1], { stdio: "ignore", detached: true });
  if (r.error || r.status !== 0) process.stdout.write(`  open it manually: ${file}\n`);
}

// ───────────────────────────────────────────────────────────── main

const HELP = `human-review ${VERSION}

Usage:
  human-review.mjs collect [--base <ref>] [--head <ref>] [--pr <number>]
                           [--no-uncommitted] [--context <n>] [--slug <name>] [--out <dir>]
  human-review.mjs build <dir> [--open] [--check] [--out <file.html>]
  human-review.mjs open <dir|file.html>

collect  Reads the change from git. Defaults: base = merge-base with the default
         branch; head = HEAD plus uncommitted and untracked changes.
         Writes <dir>/diff.json, <dir>/review.txt, and <dir>/recap.json (skeleton,
         only if missing). <dir> defaults to <repo>/.human-review/<branch>/.
build    Validates <dir>/recap.json against the diff and writes <dir>/review.html,
         a single self-contained file. --check validates without writing.
open     Opens a built review in the default browser.
`;

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cmd = opts._[0];
  if (!cmd || opts.help || cmd === "help") process.stdout.write(HELP);
  else if (cmd === "collect") collect(opts);
  else if (cmd === "build") build(opts);
  else if (cmd === "check") build({ ...opts, check: true });
  else if (cmd === "open") {
    const t = path.resolve(opts._[1] || ".");
    if (!fs.existsSync(t)) die(`not found: ${t}`);
    openFile(fs.statSync(t).isDirectory() ? path.join(t, "review.html") : t);
  } else die(`unknown command "${cmd}"\n\n${HELP}`);
}

try {
  main();
} catch (e) {
  if (!(e instanceof CliError)) throw e;
  process.stderr.write(`human-review: ${e.message}\n`);
  process.exit(e.code);
}

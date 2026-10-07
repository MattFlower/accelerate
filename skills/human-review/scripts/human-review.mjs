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

const VERSION = "0.1.0";
const RUNTIME = process.versions.bun ? "bun" : "node";
const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = path.join(SKILL_DIR, "assets");

const MAX_EMBED_FILE_BYTES = 400_000; // full-file context for "expand" rows
const MAX_EMBED_TOTAL_BYTES = 6_000_000;
const MAX_SCREENSHOT_BYTES = 4_000_000;

// ───────────────────────────────────────────────────────────── utilities

function die(msg, code = 1) {
  process.stderr.write(`human-review: ${msg}\n`);
  process.exit(code);
}

function git(args, { cwd, allowFail = false, okCodes = [0] } = {}) {
  const r = spawnSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  if (r.error) die(`could not run git: ${r.error.message}`);
  if (!okCodes.includes(r.status)) {
    if (allowFail) return null;
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

const GENERATED_PATTERNS = [
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|composer\.lock|go\.sum|mix\.lock|pubspec\.lock|Podfile\.lock|flake\.lock|packages\.lock\.json)$/,
  /\.min\.(js|css)$/,
  /\.(map|snap)$/,
  /(^|\/)__snapshots__\//,
  /(^|\/)(dist|\.next|coverage)\//,
  /\.pb\.(go|cc|h)$|_pb2\.py$|\.g\.dart$|\.generated\.|_generated\./,
];

function isGenerated(p) {
  return GENERATED_PATTERNS.some((re) => re.test(p));
}

function linguistGenerated(root, paths) {
  if (!paths.length) return new Set();
  const r = spawnSync("git", ["check-attr", "-z", "linguist-generated", "linguist-vendored", "--stdin"], {
    cwd: root,
    input: paths.join("\0"),
    encoding: "utf8",
  });
  const out = new Set();
  if (r.status !== 0) return out;
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
  /\b(?:sk|pk|rk)_(?:live|test)_[0-9A-Za-z]{16,}/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g,
];
const ASSIGNED_SECRET =
  /((?:secret|token|passw(?:or)?d|api[_-]?key|private[_-]?key|client[_-]?secret|auth)[A-Za-z0-9_]*["']?\s*[:=]\s*["'])([^"'\s]{8,})(["'])/gi;
const REDACTED = "‹redacted›";

function isEnvFile(p) {
  const b = path.basename(p).toLowerCase();
  return b.startsWith(".env") && !/(example|sample|template|dist|defaults)/.test(b);
}

function makeRedactor() {
  let count = 0;
  let inKey = false;
  const fn = (s, file) => {
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(s)) inKey = true;
    if (inKey) {
      if (/-----END [A-Z ]*PRIVATE KEY-----/.test(s)) inKey = false;
      count++;
      return REDACTED;
    }
    let out = s;
    if (file && isEnvFile(file)) {
      out = out.replace(/^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*)(.+)$/, (m, k, v) => {
        count++;
        return k + REDACTED;
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
  fn.reset = () => (inKey = false);
  return fn;
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
      if (!tip) die(`cannot resolve base ${baseRef}`);
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
      const parent = revParse(root, `${headSha}~1`);
      if (parent) {
        baseSha = parent;
        baseRef = `${headRef}~1`;
      }
    }
    slug ||= slugify(headRef === "HEAD" ? headSha.slice(0, 8) : headRef) + (worktree && baseSha === headSha ? "-uncommitted" : "");
  }

  const outRel = opts.out ? path.relative(root, path.resolve(opts.out)) : ".human-review";
  const patchSpec = { baseSha, headSha, worktree, context, outRel };
  const { patch, untracked } = computePatch(root, patchSpec);
  const fingerprint = sha256(patch);

  const files = parseUnifiedDiff(patch);
  const generated = linguistGenerated(root, files.map((f) => f.path));
  const redact = makeRedactor();
  for (const f of files) {
    f.language = languageFor(f.path);
    if (isGenerated(f.path) || generated.has(f.path)) f.generated = true;
    redact.reset();
    for (const h of f.hunks) {
      h.header = redact(h.header, null);
      for (const l of h.lines) l.s = redact(l.s, f.path);
    }
  }
  if (pr) {
    pr.title = redact(pr.title, null);
    pr.body = redact(pr.body, null);
  }

  const range = worktree ? `${baseSha}..(working tree)` : `${baseSha}..${headSha}`;
  const logRange = baseSha === headSha ? null : `${baseSha}..${headSha}`;
  const commits = logRange
    ? git(["log", "--format=%h%x1f%an%x1f%aI%x1f%s", logRange], { cwd: root })
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [sha, author, date, subject] = l.split("\x1f");
          return { sha, author, date, subject: redact(subject, null) };
        })
    : [];

  const remote = (git(["remote", "get-url", "origin"], { cwd: root, allowFail: true }) || "").trim();
  const repoName = (remote.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/) || [])[1] || path.basename(root);

  const outDir = path.resolve(opts.out || path.join(root, ".human-review", slug));
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
    const flag = f.generated ? " generated" : f.binary ? " binary" : "";
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
      out.push("  (generated or lock file — hunks omitted here; they are still in diff.json)");
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
        out.push(`${o} ${n} │${l.t}${l.s}`);
        shown++;
      }
    });
  }
  return out.join("\n") + "\n";
}

function guessGroup(p) {
  const lower = p.toLowerCase();
  if (isGenerated(p)) return "Generated";
  if (/(^|\/)(__tests__|tests?|spec|e2e|fixtures?)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py|rb)$|(^|\/)test_[^/]+\.py$/.test(lower)) return "Tests";
  if (/(^|\/)(migrations?|db\/migrate|schema)\b|\.sql$|schema\.prisma$/.test(lower)) return "Data";
  if (/\.(md|mdx|rst|txt)$|(^|\/)docs?\//.test(lower)) return "Docs";
  if (/(^|\/)\.github\/|(^|\/)(dockerfile|docker-compose[^/]*|makefile)$|\.(ya?ml|toml|ini|json|lock)$|(^|\/)\.[^/]+$|config/.test(lower)) return "Config";
  return "Source";
}

function skeleton(diff) {
  const files = {};
  for (const f of diff.files) {
    files[f.path] = { group: guessGroup(f.path), review: f.generated ? "skip" : "skim", note: "" };
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
const TEXT_KEYS = new Set(["md", "html", "css", "source", "brief", "why", "summary", "note", "caption", "text"]);

// Long text fields may be written as an array of lines — join them.
// (The top-level `summary` is a bullet list, so the root object is not joined.)
function normalizeText(node, depth = 0) {
  if (Array.isArray(node)) return node.map((x) => normalizeText(x, depth + 1));
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "example") continue; // payloads are data, not prose
      if (depth > 0 && TEXT_KEYS.has(k) && Array.isArray(v) && v.every((x) => typeof x === "string")) node[k] = v.join("\n");
      else node[k] = normalizeText(v, depth + 1);
    }
  }
  return node;
}

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
  const referencedFiles = new Set();
  const codeFiles = new Set();
  const screenshots = new Set();
  const deferred = [];
  const lineRefs = [];
  let counter = 0;

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
    if (b.id !== undefined) {
      if (ids.has(b.id)) err(p, `duplicate id "${b.id}"`);
      ids.add(b.id);
    } else {
      b.id = `b${++counter}`;
      while (ids.has(b.id)) b.id = `b${++counter}`;
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
        b._check = (len) => {
          const [s, e] = b.lines || [1, len];
          if (s < 1 || e > len || s > e) err(`${p}.lines`, `range ${s}-${e} is outside ${b.file} (${len} lines)`);
          checkAnnotations(`${p}.annotations`, b.annotations, (a, ap) => {
            if (a.line < s || a.line > e) err(ap, `line ${a.line} is outside the shown range ${s}-${e}`);
            else if (Number.isInteger(a.to) && a.to > e) err(ap, `"to": ${a.to} is outside the shown range ${s}-${e}`);
          });
        };
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
          if (/<(script|style|html|body|head|link)\b/i.test(b.html)) err(p, "wireframe html must not contain <script>, <style>, <html>, <body>, <head>, or <link>");
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
        else if (/<script\b/i.test(b.html)) err(p, "diagram html must not contain <script>");
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
  const known = new Set(["title", "brief", "risk", "summary", "focus", "sections", "keyChanges", "questions", "checks", "files", "$schema"]);
  for (const k of Object.keys(recap)) if (!known.has(k)) warn(k, "unknown top-level key (ignored)");
  if (!recap.title || !String(recap.title).trim()) err("title", "required");
  else if (recap.title.length > 70) warn("title", `${recap.title.length} chars — keep it to 70 or fewer`);
  if (!recap.brief) warn("brief", "add 1–3 sentences: what changed and why");
  if (!recap.risk || !recap.risk.level) warn("risk", 'set risk.level to "low", "medium", or "high" and say why');
  else {
    if (!["low", "medium", "high"].includes(recap.risk.level)) err("risk.level", 'must be "low", "medium", or "high"');
    if (!recap.risk.why) warn("risk.why", "say why in one line");
  }
  if (recap.summary !== undefined && !Array.isArray(recap.summary)) err("summary", "must be an array of strings");
  if (Array.isArray(recap.summary) && recap.summary.length === 0) warn("summary", "empty — add 2–5 bullets");
  if (recap.focus !== undefined) {
    if (!Array.isArray(recap.focus)) err("focus", "must be an array");
    else
      recap.focus.forEach((f, i) => {
        if (!f.title) err(`focus[${i}]`, "needs `title`");
        if (f.ref) checkRef(f.ref, `focus[${i}].ref`);
      });
  }
  (recap.sections || []).forEach((s, i) => {
    const sp = `sections[${i}]`;
    if (!s.title) err(sp, "section needs `title`");
    if (!Array.isArray(s.blocks)) return err(sp, "section needs `blocks`");
    s.id ||= slugify(s.title || `section-${i}`);
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
      if (v && v.review && !["careful", "skim", "skip"].includes(v.review)) err(`files["${p}"].review`, 'must be "careful", "skim", or "skip"');
    }
  }

  function checkRef(ref, p) {
    if (typeof ref !== "string") return err(p, "ref must be a string");
    if (ref.startsWith("#")) {
      // checked after all ids are known
      deferred.push(() => {
        const id = ref.slice(1);
        const sectionIds = new Set((recap.sections || []).map((s) => s.id));
        if (!ids.has(id) && !sectionIds.has(id) && !["key-changes", "files", "checks", "overview"].includes(id)) err(p, `no block or section with id "${id}"`);
      });
      return;
    }
    const m = /^(.+?)(?::(\d+)(?:-(\d+))?)?$/.exec(ref);
    if (!m || !byPath.has(m[1])) {
      const near = m ? nearPaths(m[1], [...byPath.keys()]) : [];
      return err(p, `"${ref}" — expected "#block-id" or "path/in/diff.ts:42" with a path from this diff${near.length ? ` (did you mean ${near.join(", ")}?)` : ""}`);
    }
    if (m[2]) lineRefs.push({ p, file: m[1], line: Number(m[3] || m[2]) });
  }
  deferred.forEach((fn) => fn());

  return { errors, warnings, referencedFiles, codeFiles, screenshots, lineRefs };
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

function readHeadFile(diff, p) {
  if (path.isAbsolute(p) || p.split(/[\\/]/).includes("..")) return null;
  if (diff.head.worktree) {
    const abs = path.join(diff.root, p);
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) return null;
      if (st.size > MAX_EMBED_FILE_BYTES) return null;
      return fs.readFileSync(abs, "utf8");
    } catch {
      return null;
    }
  }
  const size = git(["cat-file", "-s", `${diff.head.sha}:${p}`], { cwd: diff.root, allowFail: true });
  if (!size || Number(size) > MAX_EMBED_FILE_BYTES) return null;
  return git(["show", `${diff.head.sha}:${p}`], { cwd: diff.root, allowFail: true });
}

const looksBinary = (s) => s.includes("\u0000");

function build(opts) {
  const dir = path.resolve(opts._[1] || ".");
  const diff = readJSON(path.join(dir, "diff.json"), "diff.json (run `collect` first)");
  const recap = normalizeText(readJSON(path.join(dir, "recap.json"), "recap.json"));

  const { errors, warnings, referencedFiles, codeFiles, screenshots, lineRefs } = validate(recap, diff, dir);

  // Staleness check: has the code moved since collect? (Same patch recipe as collect,
  // untracked files included.)
  let stale = false;
  if (diff.patchSpec) {
    try {
      stale = sha256(computePatch(diff.root, diff.patchSpec).patch) !== diff.fingerprint;
    } catch {
      /* repo moved or unavailable — skip the check */
    }
  }
  if (!diff.head.worktree && !diff.pr) {
    const headNow = revParse(diff.root, diff.head.ref);
    if (headNow && headNow !== diff.head.sha && diff.head.ref !== "HEAD") warnings.push(`head: ${diff.head.ref} has moved since collect (${diff.head.sha.slice(0, 8)} → ${headNow.slice(0, 8)}) — rerun collect to include new commits`);
  }
  if (stale) warnings.push("diff: the working tree changed since collect — rerun collect so the review matches the code");

  // Embed file contents for context expansion and `code` blocks.
  const redact = makeRedactor();
  const contents = {};
  let total = 0;
  const wanted = [...referencedFiles, ...codeFiles];
  for (const f of diff.files) if (!f.generated && !f.binary && f.status !== "deleted") wanted.push(f.path);
  for (const p of [...new Set(wanted)]) {
    if (total > MAX_EMBED_TOTAL_BYTES && !codeFiles.has(p)) continue;
    const text = readHeadFile(diff, p);
    if (text == null || looksBinary(text)) {
      if (codeFiles.has(p)) errors.push(`code block: cannot read ${p} at head`);
      continue;
    }
    redact.reset();
    contents[p] = text.split("\n").map((l) => redact(l, p)).join("\n");
    total += text.length;
  }
  const lineCount = (t) => {
    const n = t.split("\n").length;
    return t.endsWith("\n") ? n - 1 : n;
  };
  for (const r of lineRefs) {
    const f = diff.files.find((x) => x.path === r.file);
    const t = contents[r.file];
    if (f && f.status !== "deleted" && t != null && r.line > lineCount(t)) errors.push(`${r.p}: line ${r.line} is past the end of ${r.file} (${lineCount(t)} lines)`);
  }
  // Validate `code` block ranges now that contents are known.
  const walk = (b) => {
    if (!b || typeof b !== "object") return;
    if (b.type === "code" && b._check && contents[b.file] != null) b._check(lineCount(contents[b.file]));
    delete b._check;
    for (const v of Object.values(b)) {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") walk(v);
    }
  };
  walk(recap);

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

  const json = JSON.stringify(recap);
  const needs = {
    mermaid: json.includes('"type":"mermaid"'),
    rough: json.includes('"type":"wireframe"'),
  };

  const data = {
    recap,
    diff: { ...diff, root: undefined, patchSpec: undefined },
    contents,
    assets,
    meta: { builtAt: new Date().toISOString(), version: VERSION, stale },
  };

  const read = (p) => fs.readFileSync(path.join(ASSETS, p), "utf8");
  const scriptSafe = (s) => s.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
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

const opts = parseArgs(process.argv.slice(2));
const cmd = opts._[0];
if (!cmd || opts.help || cmd === "help") process.stdout.write(HELP);
else if (cmd === "collect") collect(opts);
else if (cmd === "build") build(opts);
else if (cmd === "check") build({ ...opts, check: true });
else if (cmd === "open") {
  const t = path.resolve(opts._[1] || ".");
  openFile(fs.statSync(t).isDirectory() ? path.join(t, "review.html") : t);
} else die(`unknown command "${cmd}"\n\n${HELP}`);

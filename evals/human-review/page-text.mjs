import { isMain, readJSON, writeJSON, options } from './runtime.mjs';

const lines = v => Array.isArray(v) ? v.join('\n') : v;
const decode = s => s.replace(/&(?:amp|lt|gt|quot|apos|#39|#x[0-9a-f]+|#\d+);/gi, e => {
  const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'" };
  if (named[e]) return named[e];
  const n = e.startsWith('&#x') ? parseInt(e.slice(3), 16) : parseInt(e.slice(2), 10);
  return Number.isFinite(n) && n <= 0x10ffff ? String.fromCodePoint(n) : e;
});
export function plainText(s) {
  return decode(String(s).replace(/```[\s\S]*?```/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ').replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_~]/g, '').replace(/\s+/g, ' ').trim());
}
// Deliberately conservative: sentence boundary = punctuation + whitespace. Never split inside backticks, decimals, or file names.
export function splitSentences(input) {
  const s = String(input).replace(/\s+/g, ' ').trim();
  const out = []; let start = 0, ticks = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '`') ticks = !ticks;
    if (!ticks && /[.!?]/.test(s[i]) && /\s/.test(s[i + 1] ?? '')) {
      out.push(s.slice(start, i + 1)); start = i + 2;
    }
  }
  if (start < s.length) out.push(s.slice(start));
  return out.filter(Boolean);
}
export function pageText(recap) {
  const fragments = [];
  const add = v => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) { v.forEach(add); return; }
    if (typeof v === 'object') return;
    // Split before removing inline code delimiters.
    for (const sentence of splitSentences(String(v).replace(/```[\s\S]*?```/g, ''))) {
      const text = plainText(sentence); if (text) fragments.push(text);
    }
  };
  const prose = (v, fields) => { for (const k of fields) add(lines(v?.[k])); };
  function block(b) {
    if (!b) return;
    prose(b, ['title', 'summary', 'label', 'caption']);
    for (const a of b.annotations ?? []) prose(a, ['title', 'text']);
    switch (b.type) {
      case 'markdown': case 'callout': add(lines(b.md)); break;
      case 'wireframe': case 'diagram': {
        add(b.url);
        const html = lines(b.html) ?? '';
        // data-note and accessibility labels carry authored explanations too.
        for (const m of html.matchAll(/(?:data-note|aria-label|title|alt)=(['"])(.*?)\1/g)) add(decode(m[2]));
        add(plainText(html)); break;
      }
      case 'screenshot': add(b.alt); break;
      case 'mermaid': {
        // Keep authored labels and messages; drop layout/style directives.
        for (const line of String(lines(b.source) ?? '').split('\n')) {
          const s = line.trim();
          if (!s || /^(?:%%|flowchart\b|sequenceDiagram\b|stateDiagram|erDiagram|classDiagram|gantt\b|style\b|classDef\b|direction\b|linkStyle\b|end$)/.test(s)) continue;
          add(s);
        }
        break;
      }
      case 'compare':
        add(b.labels);
        for (const v of [b.before, b.after]) (Array.isArray(v) ? v : v ? [v] : []).forEach(block);
        for (const c of b.columns ?? []) { add(c.label); (c.blocks ?? []).forEach(block); }
        break;
      case 'tabs':
        for (const t of b.tabs ?? []) { add(t.label); (t.blocks ?? (t.block ? [t.block] : [])).forEach(block); }
        break;
      case 'dataModel':
        for (const e of b.entities ?? []) {
          prose(e, ['name', 'change', 'note']);
          for (const f of e.fields ?? []) prose(f, ['name', 'type', 'change', 'was', 'pk', 'fk', 'unique', 'index', 'nullable', 'note']);
        }
        for (const r of b.relations ?? []) prose(r, ['from', 'to', 'change']);
        break;
      case 'api':
        for (const e of b.endpoints ?? []) {
          prose(e, ['method', 'path', 'change', 'auth', 'summary', 'md', 'deprecated']);
          for (const p of e.params ?? []) prose(p, ['name', 'in', 'type', 'required', 'change', 'was', 'note']);
          if (e.request?.example !== undefined) add(JSON.stringify(e.request.example));
          for (const r of e.responses ?? []) { prose(r, ['status', 'label', 'change']); if (r.example !== undefined) add(JSON.stringify(r.example)); }
        }
        break;
      case 'states':
        add(b.corner); add(b.columns);
        for (const r of b.rows ?? []) {
          add(r.label);
          for (const c of r.cells ?? []) {
            if (c && typeof c === 'object') { add(c.value); add(c.was); } else add(c);
          }
        }
        break;
    }
  }
  prose(recap, ['title', 'brief', 'background']);
  for (const t of recap.terms ?? []) prose(t, ['term', 'means']);
  prose(recap.risk, ['level', 'why']);
  add(recap.ask); add(recap.summary);
  for (const f of recap.focus ?? []) prose(f, ['title', 'why']);
  for (const s of recap.sections ?? []) { prose(s, ['title', 'intro']); (s.blocks ?? []).forEach(block); }
  (recap.keyChanges ?? []).forEach(block);
  add(recap.questions);
  for (const v of recap.checks?.verified ?? []) typeof v === 'string' ? add(v) : prose(v, ['text', 'cmd']);
  add(recap.checks?.manual); add(recap.tests?.covers); add(recap.tests?.doesNotCover); add(recap.notExamined);
  for (const c of recap.concerns ?? []) prose(c, ['title', 'why']);
  for (const path of Object.keys(recap.files ?? {}).sort()) prose(recap.files[path], ['review', 'note']);
  const sentences = fragments.map((text, i) => ({ id: 's' + (i + 1), text }));
  return { text: sentences.map(s => s.text).join('\n'), sentences };
}
export function validatePage(page) {
  if (!page || !Array.isArray(page.sentences) || typeof page.text !== 'string') throw new Error('expected page text with sentence ids');
  const ids = new Set();
  for (const s of page.sentences) {
    if (!/^s[1-9]\d*$/.test(s.id) || ids.has(s.id) || typeof s.text !== 'string' || /[\r\n]/.test(s.text)) throw new Error('invalid sentence');
    ids.add(s.id);
  }
  if (page.text !== page.sentences.map(s => s.text).join('\n')) throw new Error('page text does not match sentences');
  return page;
}
if (isMain(import.meta.url)) {
  try { const o = options(process.argv.slice(2)); const p = pageText(readJSON(o._[0]));
    if (o.out) writeJSON(o.out, p); else console.log(JSON.stringify(p, null, 2));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}

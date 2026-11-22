// main.ts is mend, the CLI SPEC.md specifies: one patch tool for every AI edit format.
// It reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A,
// JSON edits), finds the lines each edit names at the first of three matching tiers,
// and writes every change or none. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts (the last lines below): keep that hand-over and
// runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines plus its own line break and whether it ends with one (SPEC.md section 3). */
interface FileDoc {
  lines: string[];
  br: '\n' | '\r\n';
  final: boolean;
}

function parseDoc(text: string): FileDoc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    final = true;
    parts.pop();
  }
  return { lines: parts, br, final };
}

function serializeDoc(d: FileDoc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

/** The leading spaces and tabs of a line. */
function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function wsOnly(s: string): boolean {
  return /^[ \t]*$/.test(s);
}

/** One line of N: `oIdx` names the O line it is a context line of, or null for an added line. */
interface NLine {
  text: string;
  oIdx: number | null;
}

/** The old and new lines of one hunk / block / chunk, with context lines marked. */
interface MatchChunk {
  o: string[];
  n: NLine[];
}

/** A line compared at a matching tier (SPEC.md section 5). */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position at or after `from` where O occurs in `lines` at `tier`. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const res: number[] = [];
  if (o.length === 0) return res;
  const no = o.map((l) => normLine(l, tier));
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j]!, tier) !== no[j]) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

/** The first tier (0, then 1, then 2) at which O occurs at or after `from`, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The tier at which O matches exactly at position `pos`, or null when it matches at none. */
function tierAt(lines: string[], o: string[], pos: number, strict: boolean): number | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[pos + j]!, t) !== normLine(o[j]!, t)) {
        ok = false;
        break;
      }
    }
    if (ok) return t;
  }
  return null;
}

/** The lines that replace a match at `pos`: context lines come from the file itself, and at
 * tier 2 every other line of N is re-indented from O's first line to the file's (section 5). */
function buildReplacement(lines: string[], pos: number, chunk: MatchChunk, tier: number): string[] {
  const out: string[] = [];
  const f = leadingWs(lines[pos] ?? '');
  const p = chunk.o.length > 0 ? leadingWs(chunk.o[0]!) : '';
  for (const nl of chunk.n) {
    if (nl.oIdx !== null) {
      out.push(lines[pos + nl.oIdx]!);
    } else if (tier === 2) {
      const t = nl.text;
      if (t !== '' && !wsOnly(t) && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    } else {
      out.push(nl.text);
    }
  }
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk.
 * `moves` remembers, for each path a move edit wrote, the path the file came from, so the
 * output can print one `R old -> new` line for it instead of a `D` and an `A` line. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves = new Map<string, string>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  recordMove(oldP: string, newP: string): void {
    const orig = this.moves.get(oldP) ?? oldP;
    this.moves.delete(oldP);
    this.moves.set(newP, orig);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                  */
/* ------------------------------------------------------------------ */

interface UniHunk extends MatchChunk {
  a: number;
  backslashAfterLastPlus: boolean;
  backslashAfterLastOut: boolean;
}

interface UniSection {
  pairOld: string | null;
  pairNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  diffOld: string | null;
  diffNew: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: UniHunk[];
}

function newUniSection(diffOld: string | null, diffNew: string | null): UniSection {
  return {
    pairOld: null, pairNew: null, renameOld: null, renameNew: null,
    diffOld, diffNew, isCreate: false, isDelete: false, hunks: [],
  };
}

/** The path of a `--- ` or `+++ ` line, or null for `/dev/null`. */
function dashPath(line: string): string | null {
  const cut = line.slice(4).split('\t')[0]!;
  let p = cut.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** The old-side start line A of a hunk header, or a parse error. */
function hunkStart(line: string, idx: number): number {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (m === null) throw new Exit2(`error: parse ${idx + 1}`);
  return Number(m[1]);
}

/** A hunk's body: the lines after its header, up to the first other line, a `diff --git `
 * line, or a `--- ` line followed by a `+++ ` line. Empty lines at the end are not part of it. */
function collectBody(lines: string[], start: number): { body: string[]; next: number } {
  const body: string[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
      body.push(l);
      j++;
      continue;
    }
    break;
  }
  while (body.length > 0 && blank(body[body.length - 1]!)) body.pop();
  return { body, next: j };
}

/** A hunk's body read as old and new lines, with context lines marked. */
function parseHunkBody(body: string[]): { o: string[]; n: NLine[]; backslashAfterLastPlus: boolean; backslashAfterLastOut: boolean } {
  const o: string[] = [];
  const n: NLine[] = [];
  let lastPlus = -1;
  let lastOut = -1;
  for (let i = 0; i < body.length; i++) {
    const l = body[i]!;
    if (l.startsWith('\\')) continue;
    if (l === '' || l.startsWith(' ')) {
      const text = l === '' ? '' : l.slice(1);
      const oi = o.length;
      o.push(text);
      n.push({ text, oIdx: oi });
      lastOut = i;
    } else if (l.startsWith('-')) {
      o.push(l.slice(1));
    } else if (l.startsWith('+')) {
      n.push({ text: l.slice(1), oIdx: null });
      lastPlus = i;
      lastOut = i;
    }
  }
  const afterPlus = lastPlus >= 0 && body[lastPlus + 1] !== undefined && body[lastPlus + 1]!.startsWith('\\');
  const afterOut = lastOut >= 0 && body[lastOut + 1] !== undefined && body[lastOut + 1]!.startsWith('\\');
  return { o, n, backslashAfterLastPlus: afterPlus, backslashAfterLastOut: afterOut };
}

/** A section's hunks applied in order to a file's lines. */
function applyHunks(doc: FileDoc, hunks: UniHunk[], strict: boolean, path: string): FileDoc {
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, doc.lines.length));
      const atEnd = at === doc.lines.length;
      doc.lines.splice(at, 0, ...h.n.map((nl) => nl.text));
      if (atEnd) doc.final = !h.backslashAfterLastOut;
      d += h.n.length;
      continue;
    }
    const found = findTier(doc.lines, h.o, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const pos of found.occ) {
      const dist = Math.abs(pos - target);
      if (dist < bestDist) {
        best = pos;
        bestDist = dist;
      }
    }
    const touchesEnd = best + h.o.length === doc.lines.length;
    const rep = buildReplacement(doc.lines, best, h, found.tier);
    doc.lines.splice(best, h.o.length, ...rep);
    if (touchesEnd) doc.final = !h.backslashAfterLastOut;
    d += h.n.length - h.o.length;
  }
  return doc;
}

/** One unified section as one edit. */
function unifiedEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.pairOld ?? sec.renameOld ?? sec.diffOld;
    const newP = sec.pairNew ?? sec.renameNew ?? sec.diffNew;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && newP !== oldP && !safe(newP)) throw new Fail('unsafe', newP);
    if (sec.isCreate || oldP === null) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let lastPlusHunk: UniHunk | null = null;
      for (const h of sec.hunks) {
        let hasPlus = false;
        for (const nl of h.n) {
          if (nl.oIdx === null) {
            plus.push(nl.text);
            hasPlus = true;
          }
        }
        if (hasPlus) lastPlusHunk = h;
      }
      const finalBr = lastPlusHunk === null ? true : !lastPlusHunk.backslashAfterLastPlus;
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (finalBr ? '\n' : ''));
      return;
    }
    if (sec.isDelete || newP === null) {
      if (oldP === null) return;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const oldPath = oldP!;
    const newPath = newP!;
    if (oldPath !== newPath) {
      const cur = tree.get(oldPath);
      if (cur === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const doc = applyHunks(parseDoc(cur), sec.hunks, strict, oldPath);
      tree.now.set(newPath, serializeDoc(doc));
      tree.now.set(oldPath, null);
      tree.recordMove(oldPath, newPath);
      return;
    }
    const cur = tree.get(oldPath);
    if (cur === null) throw new Fail('missing', oldPath);
    const doc = applyHunks(parseDoc(cur), sec.hunks, strict, oldPath);
    tree.now.set(oldPath, serializeDoc(doc));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  const startSection = (diffOld: string | null, diffNew: string | null): UniSection => {
    const s = newUniSection(diffOld, diffNew);
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (cur === null) {
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        const s = startSection(null, null);
        s.pairOld = dashPath(line);
        s.pairNew = dashPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const a = hunkStart(line, i);
      const { body, next } = collectBody(lines, i + 1);
      const parsed = parseHunkBody(body);
      cur.hunks.push({ a, ...parsed });
      inHeader = false;
      i = next;
      continue;
    }
    if (inHeader) {
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (cur.pairOld === null) {
            cur.pairOld = dashPath(line);
            cur.pairNew = dashPath(lines[i + 1]!);
            i += 2;
            continue;
          }
          const s = startSection(null, null);
          s.pairOld = dashPath(line);
          s.pairNew = dashPath(lines[i + 1]!);
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('+++ ')) {
        cur.pairNew = dashPath(line);
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameOld = line.slice(12).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameNew = line.slice(10).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.isCreate = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.isDelete = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const s = startSection(null, null);
      s.pairOld = dashPath(line);
      s.pairNew = dashPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    i++;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                          */
/* ------------------------------------------------------------------ */

/** One SEARCH/REPLACE block as one edit. */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const doc = parseDoc(cur);
    const found = findTier(doc.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length !== 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const chunk: MatchChunk = { o: oldLines, n: newLines.map((text) => ({ text, oIdx: null })) };
    const rep = buildReplacement(doc.lines, pos, chunk, found.tier);
    doc.lines.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, serializeDoc(doc));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let lastEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchIdx = i;
      let path: string | null = null;
      for (let j = searchIdx - 1; j >= lastEnd; j--) {
        const t = lines[j]!.trim();
        if (t === '' || t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
        path = prevPath;
      }
      let k = searchIdx + 1;
      let eq = -1;
      while (k < lines.length) {
        if (lines[k]!.trimEnd() === '=======') {
          eq = k;
          break;
        }
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') break;
        k++;
      }
      if (eq === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
      let m = eq + 1;
      let rep = -1;
      while (m < lines.length) {
        if (lines[m]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = m;
          break;
        }
        m++;
      }
      if (rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
      edits.push(srEdit(path, lines.slice(searchIdx + 1, eq), lines.slice(eq + 1, rep), strict));
      prevPath = path;
      lastEnd = rep + 1;
      i = rep + 1;
      continue;
    }
    i++;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                    */
/* ------------------------------------------------------------------ */

interface V4aChunkRaw {
  anchor: string | null;
  body: { text: string; num: number }[];
  eof: boolean;
}

interface V4aChunk extends MatchChunk {
  anchor: string | null;
  eof: boolean;
}

/** The first line at or after `from` equal to the anchor at the first tier where one is. */
function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const a = normLine(anchor, t);
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i]!, t) === a) return i;
    }
  }
  return null;
}

/** One V4A section header, or null when the line starts no section. */
function v4aHead(line: string): { kind: 'add' | 'delete' | 'update'; path: string } | null {
  if (line.startsWith('*** Add File: ')) return { kind: 'add', path: line.slice(14).trim() };
  if (line.startsWith('*** Delete File: ')) return { kind: 'delete', path: line.slice(17).trim() };
  if (line.startsWith('*** Update File: ')) return { kind: 'update', path: line.slice(17).trim() };
  return null;
}

/** One V4A section as one edit. `headNum` is the 1-based line of its header. */
function v4aEdit(
  head: { kind: 'add' | 'delete' | 'update'; path: string },
  raw: { text: string; num: number }[],
  headNum: number,
  strict: boolean,
): Edit {
  if (head.kind === 'add') {
    const fileLines: string[] = [];
    for (const r of raw) {
      if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
      else if (blank(r.text)) fileLines.push('');
      else throw new Exit2(`error: parse ${r.num}`);
    }
    const path = head.path;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (head.kind === 'delete') {
    for (const r of raw) {
      if (!blank(r.text)) throw new Exit2(`error: parse ${r.num}`);
    }
    const path = head.path;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  let moveTo: string | null = null;
  let idx = 0;
  if (idx < raw.length && raw[idx]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[idx]!.text.slice(13).trim();
    idx++;
  }
  const raws: V4aChunkRaw[] = [];
  let cur: V4aChunkRaw | null = null;
  let seen = false;
  for (; idx < raw.length; idx++) {
    const r = raw[idx]!;
    const text = r.text;
    if (text === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${r.num}`);
      cur.eof = true;
      raws.push(cur);
      cur = null;
      continue;
    }
    if (text.startsWith('@@')) {
      if (cur !== null) {
        raws.push(cur);
        cur = null;
      }
      const anchor = text.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
      seen = true;
      continue;
    }
    if (text.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${r.num}`);
    if (text === '' || text.startsWith(' ') || text.startsWith('-') || text.startsWith('+')) {
      if (cur === null) {
        if (seen) throw new Exit2(`error: parse ${r.num}`);
        cur = { anchor: null, body: [], eof: false };
        seen = true;
      }
      cur.body.push(r);
      continue;
    }
    throw new Exit2(`error: parse ${r.num}`);
  }
  if (cur !== null) raws.push(cur);
  if (raws.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headNum}`);
  const chunks: V4aChunk[] = raws.map((c) => {
    const o: string[] = [];
    const n: NLine[] = [];
    for (const r of c.body) {
      const t = r.text;
      if (t === '' || t.startsWith(' ')) {
        const text = t === '' ? '' : t.slice(1);
        const oi = o.length;
        o.push(text);
        n.push({ text, oIdx: oi });
      } else if (t.startsWith('-')) {
        o.push(t.slice(1));
      } else if (t.startsWith('+')) {
        n.push({ text: t.slice(1), oIdx: null });
      }
    }
    return { anchor: c.anchor, eof: c.eof, o, n };
  });
  const path = head.path;
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const curText = tree.get(path);
    if (curText === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const doc = parseDoc(curText);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(doc.lines, ch.anchor, strict, cursor);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      if (ch.o.length === 0) {
        const at = ch.eof ? doc.lines.length : cursor;
        doc.lines.splice(at, 0, ...ch.n.map((nl) => nl.text));
        cursor = at + ch.n.length;
        continue;
      }
      if (ch.eof) {
        const endPos = doc.lines.length - ch.o.length;
        if (endPos < cursor) throw new Fail('no-match', path);
        const tier = tierAt(doc.lines, ch.o, endPos, strict);
        if (tier === null) throw new Fail('no-match', path);
        const rep = buildReplacement(doc.lines, endPos, ch, tier);
        doc.lines.splice(endPos, ch.o.length, ...rep);
        cursor = endPos + rep.length;
        continue;
      }
      const found = findTier(doc.lines, ch.o, strict, cursor);
      if (found === null) throw new Fail('no-match', path);
      const pos = found.occ[0]!;
      const rep = buildReplacement(doc.lines, pos, ch, found.tier);
      doc.lines.splice(pos, ch.o.length, ...rep);
      cursor = pos + rep.length;
    }
    const out = serializeDoc(doc);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.recordMove(path, moveTo);
    } else {
      tree.now.set(path, out);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const head = v4aHead(line);
    if (head === null) throw new Exit2(`error: parse ${i + 1}`);
    const headNum = i + 1;
    const raw: { text: string; num: number }[] = [];
    i++;
    while (i < last) {
      const l = lines[i]!;
      if (v4aHead(l) !== null) break;
      raw.push({ text: l, num: i + 1 });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    edits.push(v4aEdit(head, raw, headNum, strict));
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Invocation, output and exit codes (SPEC.md sections 1, 2 and 10)   */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = new Map(tree.moves);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.clear();
      for (const [k, v] of beforeMoves) tree.moves.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const covered = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const [newP, oldP] of tree.moves) {
    if (oldP === newP) continue;
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  const changed = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const p of changed) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of changed) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

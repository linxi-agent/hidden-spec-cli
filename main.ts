// mend: one patch tool for the four edit formats AI models write (SPEC.md).
// Node 22, standard library only, run as `node main.ts [options] [PATCH]`.
// The last lines hand a make.fun trial over to runner.ts when MAKEFUN_ENV_URL
// is set; everything above them is the CLI itself.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/* ---------- small shared helpers ---------- */

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

const isBlank = (s: string): boolean => s.trim() === '';
const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

/** A patch text split the way SPEC section 3 prescribes. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** SPEC section 3: what a safe relative path is. */
function safePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/* ---------- a text file as lines + break style + final break ---------- */

interface FileModel {
  lines: string[];
  br: string;
  eol: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', eol: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const eol = text.endsWith(br);
  const parts = text.split(br);
  if (eol) parts.pop();
  return { lines: parts, br, eol };
}

function writeModel(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.eol ? m.br : '');
}

/* ---------- the tree: original bytes remembered, edits staged ---------- */

interface Move {
  from: string;
  to: string;
}

class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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
  set(p: string, v: string | null): void {
    this.now.set(p, v);
  }
}

type Edit = (tree: Tree, moves: Move[]) => void;

function needSafe(p: string): void {
  if (!safePath(p)) throw new Fail('unsafe', p);
}

function needFile(tree: Tree, p: string): string {
  const t = tree.get(p);
  if (t === null) throw new Fail('missing', p);
  return t;
}

/* ---------- SPEC section 5: the three matching tiers ---------- */

function tierText(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return trimTrail(s);
  return trimTrail(s.replace(/^[ \t]+/, ''));
}

interface Found {
  tier: number;
  at: number[];
}

/** Occurrences of O in lines at the first tier that has any, from index `from`. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0, eofOnly = false): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const want = o.map((x) => tierText(x, tier));
    const at: number[] = [];
    for (let i = from; i + o.length <= lines.length; i += 1) {
      if (eofOnly && i + o.length !== lines.length) continue;
      let ok = true;
      for (let j = 0; j < o.length; j += 1) {
        if (tierText(lines[i + j]!, tier) !== want[j]) {
          ok = false;
          break;
        }
      }
      if (ok) at.push(i);
    }
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** One replacement line: its text, and the O index it is a context line of (-1: new text). */
interface SegLine {
  text: string;
  ctx: number;
}

/** The lines that replace the matched ones: context from the file, tier-2 re-indent. */
function buildSeg(fileLines: string[], pos: number, o: string[], seg: SegLine[], tier: number): string[] {
  const f = leadWs(fileLines[pos] ?? '');
  const p = o.length > 0 ? leadWs(o[0]!) : '';
  return seg.map((n) => {
    if (n.ctx >= 0) return fileLines[pos + n.ctx]!;
    if (tier === 2 && n.text.trim() !== '' && n.text.startsWith(p)) return f + n.text.slice(p.length);
    return n.text;
  });
}

/* ---------- SPEC section 6: unified diffs ---------- */

interface BodyItem {
  k: 'c' | 'o' | 'n' | 'm'; // context, old, new, backslash marker
  t: string;
}

interface Hunk {
  a: number;
  body: BodyItem[];
}

interface USection {
  startedByDiff: boolean;
  hasPair: boolean;
  diffOld: string | null;
  diffNew: string | null;
  minus: string | null;
  plus: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

function headerPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** Does a `\` marker follow the last context-or-new line of this body? */
function markAfterLastWritten(body: BodyItem[]): boolean {
  for (let i = body.length - 1; i >= 0; i -= 1) {
    if (body[i]!.k === 'c' || body[i]!.k === 'n') {
      return i + 1 < body.length && body[i + 1]!.k === 'm';
    }
  }
  return false;
}

function splitHunk(body: BodyItem[]): { o: string[]; seg: SegLine[] } {
  const o: string[] = [];
  const seg: SegLine[] = [];
  for (const it of body) {
    if (it.k === 'c') {
      o.push(it.t);
      seg.push({ text: it.t, ctx: o.length - 1 });
    } else if (it.k === 'o') {
      o.push(it.t);
    } else if (it.k === 'n') {
      seg.push({ text: it.t, ctx: -1 });
    }
  }
  return { o, seg };
}

function applyHunks(model: FileModel, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const { o, seg } = splitHunk(h.body);
    if (o.length === 0) {
      const pos = Math.min(Math.max(h.a + d, 0), model.lines.length);
      const texts = seg.map((s) => s.text);
      const atEnd = pos === model.lines.length;
      model.lines.splice(pos, 0, ...texts);
      if (atEnd && texts.length > 0) model.eol = !markAfterLastWritten(h.body);
      d += texts.length;
      continue;
    }
    const found = findTier(model.lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.at[0]!;
    for (const at of found.at) {
      if (Math.abs(at - target) < Math.abs(pos - target)) pos = at;
    }
    const written = buildSeg(model.lines, pos, o, seg, found.tier);
    const reachesEnd = pos + o.length === model.lines.length;
    model.lines.splice(pos, o.length, ...written);
    if (reachesEnd) model.eol = !markAfterLastWritten(h.body);
    d += seg.length - o.length;
  }
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  return (tree, moves) => {
    const oldP = sec.minus ?? sec.renameFrom ?? sec.diffOld;
    const newP = sec.plus ?? sec.renameTo ?? sec.diffNew;
    const isCreate = sec.newFile || oldP === '/dev/null';
    const isDelete = sec.delFile || newP === '/dev/null';
    if (isCreate) {
      const p = newP ?? '';
      needSafe(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const flat: BodyItem[] = [];
      for (const h of sec.hunks) flat.push(...h.body);
      const texts = flat.filter((it) => it.k === 'n').map((it) => it.t);
      let lastNew = -1;
      flat.forEach((it, idx) => {
        if (it.k === 'n') lastNew = idx;
      });
      const eol = !(lastNew >= 0 && flat[lastNew + 1]?.k === 'm');
      tree.set(p, writeModel({ lines: texts, br: '\n', eol }));
      return;
    }
    if (isDelete) {
      const p = oldP ?? '';
      needSafe(p);
      needFile(tree, p);
      tree.set(p, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      needSafe(oldP);
      needSafe(newP);
      const before = needFile(tree, oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const model = parseFile(before);
      applyHunks(model, sec.hunks, strict, oldP);
      tree.set(newP, writeModel(model));
      tree.set(oldP, null);
      moves.push({ from: oldP, to: newP });
      return;
    }
    const p = oldP ?? newP ?? '';
    needSafe(p);
    const before = needFile(tree, p);
    const model = parseFile(before);
    applyHunks(model, sec.hunks, strict, p);
    tree.set(p, writeModel(model));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  const fresh = (byDiff: boolean): USection => ({
    startedByDiff: byDiff,
    hasPair: false,
    diffOld: null,
    diffNew: null,
    minus: null,
    plus: null,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    delFile: false,
    hunks: [],
  });
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const ln = i + 1;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*?) b\/(.*)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${ln}`);
      cur = fresh(true);
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${ln}`);
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hm === null) throw new Exit2(`error: parse ${ln}`);
      const after = line.slice(hm[0].length);
      if (after !== '' && !after.startsWith(' ') && !after.startsWith('\t')) {
        throw new Exit2(`error: parse ${ln}`);
      }
      const raw: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        const c0 = b.charAt(0);
        if (b === '' || c0 === ' ' || c0 === '-' || c0 === '+' || c0 === '\\') {
          raw.push(b);
          j += 1;
        } else break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      const body: BodyItem[] = raw.map((b) => {
        if (b === '') return { k: 'c' as const, t: '' };
        const c0 = b.charAt(0);
        if (c0 === ' ') return { k: 'c' as const, t: b.slice(1) };
        if (c0 === '-') return { k: 'o' as const, t: b.slice(1) };
        if (c0 === '+') return { k: 'n' as const, t: b.slice(1) };
        return { k: 'm' as const, t: '' };
      });
      cur.hunks.push({ a: Number(hm[1]), body });
      i = j;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        if (cur !== null && cur.startedByDiff && !cur.hasPair && cur.hunks.length === 0) {
          cur.minus = headerPath(line);
          cur.plus = headerPath(next);
          cur.hasPair = true;
        } else {
          cur = fresh(false);
          cur.minus = headerPath(line);
          cur.plus = headerPath(next);
          cur.hasPair = true;
          sections.push(cur);
        }
        i += 2;
        continue;
      }
      if (cur !== null && cur.hunks.length === 0 && !cur.hasPair) {
        throw new Exit2(`error: parse ${ln + 1}`);
      }
      i += 1;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

/* ---------- SPEC section 7: SEARCH/REPLACE blocks ---------- */

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (trimTrail(lines[i]!) !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLn = i + 1;
    let path: string | null = null;
    for (let k = i - 1; k >= prevEnd; k -= 1) {
      const t = lines[k]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLn}`);
      path = prevPath;
    }
    let div = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const t = trimTrail(lines[j]!);
      if (t === '=======') {
        div = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (div < 0) throw new Exit2(`error: parse ${searchLn}`);
    let end = -1;
    for (let j = div + 1; j < lines.length; j += 1) {
      if (trimTrail(lines[j]!) === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLn}`);
    blocks.push({ path, oldLines: lines.slice(i + 1, div), newLines: lines.slice(div + 1, end) });
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  return blocks;
}

function searchReplaceEdit(block: SRBlock, strict: boolean): Edit {
  return (tree) => {
    needSafe(block.path);
    if (block.oldLines.length === 0) {
      if (tree.get(block.path) !== null) throw new Fail('exists', block.path);
      tree.set(block.path, writeModel({ lines: block.newLines, br: '\n', eol: true }));
      return;
    }
    const model = parseFile(needFile(tree, block.path));
    const found = findTier(model.lines, block.oldLines, strict);
    if (found === null) throw new Fail('no-match', block.path);
    if (found.at.length > 1) throw new Fail('ambiguous', block.path);
    const pos = found.at[0]!;
    const seg = buildSeg(
      model.lines,
      pos,
      block.oldLines,
      block.newLines.map((t) => ({ text: t, ctx: -1 })),
      found.tier,
    );
    model.lines.splice(pos, block.oldLines.length, ...seg);
    tree.set(block.path, writeModel(model));
  };
}

/* ---------- SPEC section 8: V4A patches ---------- */

interface VChunk {
  anchor: string | null;
  body: BodyItem[];
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  ln: number;
  addLines: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

interface RawLine {
  t: string;
  ln: number;
}

function parseV4a(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!isBlank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  const starterOf = (l: string): 'add' | 'del' | 'upd' | null => {
    if (l.startsWith('*** Add File: ')) return 'add';
    if (l.startsWith('*** Delete File: ')) return 'del';
    if (l.startsWith('*** Update File: ')) return 'upd';
    return null;
  };
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    const kind = starterOf(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const secLn = i + 1;
    const path = line.slice(line.indexOf(': ') + 2).trim();
    const content: RawLine[] = [];
    let j = i + 1;
    while (j < last && starterOf(lines[j]!) === null) {
      content.push({ t: lines[j]!, ln: j + 1 });
      j += 1;
    }
    while (content.length > 0 && isBlank(content[content.length - 1]!.t)) content.pop();
    const sec: VSection = { kind, path, ln: secLn, addLines: [], moveTo: null, chunks: [] };
    if (kind === 'add') {
      for (const c of content) {
        if (c.t.startsWith('+')) sec.addLines.push(c.t.slice(1));
        else if (c.t === '') sec.addLines.push('');
        else throw new Exit2(`error: parse ${c.ln}`);
      }
    } else if (kind === 'del') {
      if (content.length > 0) throw new Exit2(`error: parse ${content[0]!.ln}`);
    } else {
      let rest = content;
      if (rest.length > 0 && rest[0]!.t.startsWith('*** Move to: ')) {
        sec.moveTo = rest[0]!.t.slice('*** Move to: '.length).trim();
        rest = rest.slice(1);
      }
      let chunk: VChunk | null = null;
      let implicitOk = true;
      for (const c of rest) {
        if (c.t.startsWith('@@')) {
          chunk = { anchor: c.t.slice(2).trim() === '' ? null : c.t.slice(2).trim(), body: [], eof: false };
          sec.chunks.push(chunk);
          implicitOk = false;
        } else if (c.t.trim() === '*** End of File') {
          if (chunk === null) {
            if (!implicitOk) throw new Exit2(`error: parse ${c.ln}`);
            chunk = { anchor: null, body: [], eof: false };
            sec.chunks.push(chunk);
          }
          chunk.eof = true;
          chunk = null;
          implicitOk = false;
        } else if (c.t === '' || c.t.startsWith(' ') || c.t.startsWith('-') || c.t.startsWith('+')) {
          if (chunk === null) {
            if (!implicitOk) throw new Exit2(`error: parse ${c.ln}`);
            chunk = { anchor: null, body: [], eof: false };
            sec.chunks.push(chunk);
            implicitOk = false;
          }
          if (c.t === '') chunk.body.push({ k: 'c', t: '' });
          else if (c.t.startsWith(' ')) chunk.body.push({ k: 'c', t: c.t.slice(1) });
          else if (c.t.startsWith('-')) chunk.body.push({ k: 'o', t: c.t.slice(1) });
          else chunk.body.push({ k: 'n', t: c.t.slice(1) });
        } else {
          throw new Exit2(`error: parse ${c.ln}`);
        }
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${secLn}`);
    }
    sections.push(sec);
    i = j;
  }
  return sections;
}

function v4aEdit(sec: VSection, strict: boolean): Edit {
  return (tree, moves) => {
    needSafe(sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.set(sec.path, writeModel({ lines: sec.addLines, br: '\n', eol: true }));
      return;
    }
    if (sec.kind === 'del') {
      needFile(tree, sec.path);
      tree.set(sec.path, null);
      return;
    }
    if (sec.moveTo !== null) needSafe(sec.moveTo);
    const model = parseFile(needFile(tree, sec.path));
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        const hit = findTier(model.lines, [chunk.anchor], strict, cursor);
        if (hit === null) throw new Fail('no-match', sec.path);
        cursor = hit.at[0]! + 1;
      }
      const { o, seg } = splitHunk(chunk.body);
      if (o.length === 0) {
        const pos = chunk.eof ? model.lines.length : Math.min(cursor, model.lines.length);
        const texts = seg.map((s) => s.text);
        model.lines.splice(pos, 0, ...texts);
        cursor = pos + texts.length;
        continue;
      }
      const found = findTier(model.lines, o, strict, cursor, chunk.eof);
      if (found === null) throw new Fail('no-match', sec.path);
      const pos = found.at[0]!;
      const written = buildSeg(model.lines, pos, o, seg, found.tier);
      model.lines.splice(pos, o.length, ...written);
      cursor = pos + written.length;
    }
    if (sec.moveTo !== null) {
      tree.set(sec.moveTo, writeModel(model));
      tree.set(sec.path, null);
      moves.push({ from: sec.path, to: sec.moveTo });
    } else {
      tree.set(sec.path, writeModel(model));
    }
  };
}

/* ---------- SPEC section 9: JSON edits ---------- */

function jsonEditOf(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      needSafe(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      needSafe(p);
      const before = needFile(tree, p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.split('\r\n').join('\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.split('\n').join('\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const at = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      needSafe(p);
      const model = parseFile(needFile(tree, p));
      if (at < 0 || at > model.lines.length) throw new Fail('no-match', p);
      model.lines.splice(at, 0, ...add);
      tree.set(p, writeModel(model));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
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
      const e = jsonEditOf(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEditOf(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${idx + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---------- SPEC sections 1, 2, 4 and 10: the CLI itself ---------- */

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart().charAt(0);
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => trimTrail(l) === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

function runCli(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMAT_NAMES.includes(a.slice('--format='.length))) {
        format = a.slice('--format='.length);
      } else if (a === '--check' && !checkOnly) {
        checkOnly = true;
      } else if (a === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const patchArg = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(patchArg ?? 0, 'utf8');
  } catch {
    if (patchArg !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines).map((b) => searchReplaceEdit(b, strict));
    else edits = parseV4a(lines).map((s) => v4aEdit(s, strict));
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const moves: Move[] = [];
  const fails: Fail[] = [];
  for (const edit of edits) {
    const savedNow = new Map(tree.now);
    const savedMoves = moves.length;
    try {
      edit(tree, moves);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of savedNow) tree.now.set(k, v);
      moves.length = savedMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  const used = new Set<string>();
  const changed = (p: string): boolean => tree.original(p) !== tree.now.get(p)!;
  for (const mv of moves) {
    if (used.has(mv.from) || used.has(mv.to)) continue;
    const fromGone = tree.original(mv.from) !== null && tree.now.get(mv.from) === null;
    const toNew = tree.original(mv.to) === null && tree.now.get(mv.to) !== null;
    if (fromGone && toNew) {
      rows.push({ key: mv.to, text: `R ${mv.from} -> ${mv.to}` });
      used.add(mv.from);
      used.add(mv.to);
    }
  }
  for (const p of tree.now.keys()) {
    if (used.has(p) || !changed(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  if (!checkOnly) {
    for (const p of tree.now.keys()) {
      if (!changed(p)) continue;
      const now = tree.now.get(p)!;
      if (now === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = runCli(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

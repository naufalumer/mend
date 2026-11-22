// mend: one patch tool for every AI edit format.
//
// Applies an AI-written edit in one of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A patches, JSON tool calls) to the tree of text
// files rooted at the working directory, following SPEC.md version 1 in
// full: three-tier fuzzy line matching, nearest-hunk selection, atomic
// all-or-nothing writes, and exact stdout plus exit codes.
//
// Node 22, standard library only. Run as: node main.ts [options] [PATCH]
// With MAKEFUN_ENV_URL set, hands the trial over to runner.ts instead.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 failure: the single line to print. */
class ParseProblem {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One failed edit: its code and the path it concerns. */
class EditProblem {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

type ApplyEdit = (tree: Tree) => void;

interface MoveRecord {
  old: string;
  next: string;
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** SPEC.md section 3: a path is safe when it is not empty, does not start with /, holds no \, and none of its segments is empty, . or ... */
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function checkSafe(p: string): void {
  if (!isSafePath(p)) throw new EditProblem('unsafe', p);
}

/** A file's lines, its line break, and whether it ends with one (SPEC.md section 3). */
interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitText(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinText(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null means deleted), the rest read from disk. */
class Tree {
  private readonly seen = new Map<string, string | null>();
  private readonly presentSeen = new Map<string, boolean>();
  readonly now = new Map<string, string | null>();

  /** The file's text before the patch, or null when there is no such file. */
  original(p: string): string | null {
    if (!this.seen.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.seen.set(p, v);
    }
    return this.seen.get(p)!;
  }

  /** Whether the path exists right now: on disk (file or directory) or created by an earlier edit. */
  present(p: string): boolean {
    if (this.now.has(p)) return this.now.get(p) !== null;
    if (!this.presentSeen.has(p)) {
      let ok = false;
      try {
        statSync(p);
        ok = true;
      } catch {
        ok = false;
      }
      this.presentSeen.set(p, ok);
    }
    return this.presentSeen.get(p)!;
  }

  /** The file's text as earlier edits left it, or null when there is none. */
  text(p: string): string | null {
    if (this.now.has(p)) return this.now.get(p)!;
    return this.original(p);
  }
}

// ---------------------------------------------------------------------------
// Matching (SPEC.md section 5)
// ---------------------------------------------------------------------------

function stripTrailing(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailing(a) === stripTrailing(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every 0-based position at or after `from` where `needle` matches `lines` at `tier`. Occurrences may overlap. */
function occurrences(needle: string[], lines: string[], from: number, tier: number): number[] {
  const out: number[] = [];
  if (needle.length === 0) return out;
  for (let i = Math.max(0, from); i + needle.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (!lineEq(needle[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which `needle` occurs at or after `from`, with its positions. */
function firstTierWith(
  needle: string[],
  lines: string[],
  from: number,
  strict: boolean,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = occurrences(needle, lines, from, tier);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

interface NewLine {
  /** The patch's text for the line. */
  text: string;
  /** True for a context line: written as the file's own matched line, never the patch's. */
  context: boolean;
  /** For a context line: its index inside the old lines. */
  oldIndex: number;
}

/**
 * Resolve a replacement's lines: context lines come from the file, other
 * lines are re-indented at tier 2 (SPEC.md section 5) and written as they are otherwise.
 */
function resolveNew(repl: NewLine[], fileLines: string[], at: number, oldLines: string[], tier: number): string[] {
  if (tier !== 2) {
    return repl.map((n) => (n.context ? fileLines[at + n.oldIndex]! : n.text));
  }
  const fileLead = leadingWs(fileLines[at]!);
  const oldLead = leadingWs(oldLines[0]!);
  return repl.map((n) => {
    if (n.context) return fileLines[at + n.oldIndex]!;
    const t = n.text;
    if (t === '' || t.trim() === '' || !t.startsWith(oldLead)) return t;
    return fileLead + t.slice(oldLead.length);
  });
}

// ---------------------------------------------------------------------------
// Format detection (SPEC.md section 4)
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

function jsonEdit(value: unknown): ApplyEdit | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const path = obj.path;
  if (typeof path !== 'string') return null;

  const needFile = (tree: Tree): string => {
    checkSafe(path);
    const t = tree.text(path);
    if (t === null) throw new EditProblem('missing', path);
    return t;
  };

  if (obj.command === 'create' && typeof obj.file_text === 'string') {
    const text = obj.file_text;
    return (tree) => {
      checkSafe(path);
      if (tree.present(path)) throw new EditProblem('exists', path);
      tree.now.set(path, text);
    };
  }

  if (
    obj.command === 'str_replace' &&
    typeof obj.old_str === 'string' &&
    obj.old_str !== '' &&
    (obj.new_str === undefined || typeof obj.new_str === 'string')
  ) {
    const oldStr = obj.old_str;
    const newStr = (obj.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = needFile(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const body = norm(before);
      const old = norm(oldStr);
      let count = 0;
      for (let k = body.indexOf(old); k >= 0; k = body.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditProblem('no-match', path);
      if (count > 1) throw new EditProblem('ambiguous', path);
      const at = body.indexOf(old);
      const out = body.slice(0, at) + norm(newStr) + body.slice(at + old.length);
      tree.now.set(path, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }

  if (
    obj.command === 'insert' &&
    typeof obj.insert_line === 'number' &&
    Number.isInteger(obj.insert_line) &&
    typeof obj.new_str === 'string'
  ) {
    const atLine = obj.insert_line;
    const add = patchLines(obj.new_str);
    return (tree) => {
      const before = needFile(tree);
      const parts = splitText(before);
      if (atLine < 0 || atLine > parts.lines.length) throw new EditProblem('no-match', path);
      const lines = [...parts.lines];
      lines.splice(atLine, 0, ...add);
      tree.now.set(path, joinText(lines, parts.br, parts.final));
    };
  }

  return null;
}

function parseJson(text: string, lines: string[]): ApplyEdit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseProblem('error: parse 1');
  const edits: ApplyEdit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ParseProblem(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(parsed)) throw new ParseProblem(`error: parse ${first + 1}`);
    for (const item of parsed) {
      const edit = jsonEdit(item);
      if (edit === null) throw new ParseProblem(`error: parse ${first + 1}`);
      edits.push(edit);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let edit: ApplyEdit | null = null;
    try {
      edit = jsonEdit(JSON.parse(l));
    } catch {
      edit = null;
    }
    if (edit === null) throw new ParseProblem(`error: parse ${i + 1}`);
    edits.push(edit);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  /** 1-based start line of the old side. */
  start: number;
  /** Body lines after the header, trailing empty lines removed. */
  body: string[];
}

/** The old and new lines of a hunk body, in body order. */
function hunkSides(hunk: Hunk): { oldLines: string[]; newLines: NewLine[] } {
  const oldLines: string[] = [];
  const newLines: NewLine[] = [];
  for (const line of hunk.body) {
    if (line === '' || line.startsWith(' ')) {
      const text = line === '' ? '' : line.slice(1);
      oldLines.push(text);
      newLines.push({ text, context: true, oldIndex: oldLines.length - 1 });
    } else if (line.startsWith('-')) {
      oldLines.push(line.slice(1));
    } else if (line.startsWith('+')) {
      newLines.push({ text: line.slice(1), context: false, oldIndex: -1 });
    }
    // A '\' line names the line before it; it carries no line of its own.
  }
  return { oldLines, newLines };
}

/** Whether a '\' line follows the hunk's last context or '+' line. */
function endsWithoutBreak(hunk: Hunk): boolean {
  const isLast = (l: string): boolean => l === '' || l.startsWith(' ') || l.startsWith('+');
  for (let i = hunk.body.length - 1; i >= 0; i -= 1) {
    if (!isLast(hunk.body[i]!)) continue;
    const next = hunk.body[i + 1];
    return next !== undefined && next.startsWith('\\');
  }
  return false;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@( .*)?$/;

function parseHunkHead(line: string): number | null {
  const m = HUNK_HEAD.exec(line);
  if (m === null) return null;
  return Number(m[1]);
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

function headerPath(line: string): string {
  const cut = line.indexOf('\t');
  const raw = cut >= 0 ? line.slice(4, cut) : line.slice(4);
  return raw.trim();
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseUnified(lines: string[], strict: boolean, moves: MoveRecord[]): ApplyEdit[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  let diffOld: string | null = null;
  let diffNew: string | null = null;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let hasPair = false;
  let seenHunk = false;

  const finishSection = (): void => {
    if (current === null) return;
    if (current.oldPath === null) current.oldPath = renameFrom ?? diffOld;
    if (current.newPath === null) current.newPath = renameTo ?? diffNew;
    sections.push(current);
    current = null;
    diffOld = null;
    diffNew = null;
    renameFrom = null;
    renameTo = null;
    hasPair = false;
    seenHunk = false;
  };

  const openSection = (oldPath: string | null, newPath: string | null): void => {
    finishSection();
    current = { oldPath, newPath, create: false, remove: false, hunks: [] };
  };

  const readDiffGit = (line: string, at: number): [string, string] => {
    const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
    if (m === null) throw new ParseProblem(`error: parse ${at + 1}`);
    return [m[1]!, m[2]!];
  };

  /** Collect a hunk body starting at `at`; returns the body and the index after it. */
  const readBody = (at: number): { body: string[]; next: number } => {
    const body: string[] = [];
    let i = at;
    while (i < lines.length) {
      const l = lines[i]!;
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
      if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
        body.push(l);
        i += 1;
      } else {
        break;
      }
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    return { body, next: i };
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (current === null) {
      if (line.startsWith('diff --git ')) {
        const [o, n] = readDiffGit(line, i);
        openSection(null, null);
        diffOld = o;
        diffNew = n;
        i += 1;
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        const oldP = headerPath(line);
        const newP = headerPath(lines[i + 1]!);
        openSection(oldP === '/dev/null' ? null : stripAB(oldP), newP === '/dev/null' ? null : stripAB(newP));
        hasPair = true;
        i += 2;
        continue;
      }
      if (line.startsWith('@@')) throw new ParseProblem(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (!seenHunk) {
      if (line.startsWith('diff --git ')) {
        const [o, n] = readDiffGit(line, i);
        openSection(null, null);
        diffOld = o;
        diffNew = n;
        i += 1;
        continue;
      }
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (!hasPair) {
            const oldP = headerPath(line);
            const newP = headerPath(lines[i + 1]!);
            current.oldPath = oldP === '/dev/null' ? null : stripAB(oldP);
            current.newPath = newP === '/dev/null' ? null : stripAB(newP);
            hasPair = true;
            i += 2;
            continue;
          }
          const oldP = headerPath(line);
          const newP = headerPath(lines[i + 1]!);
          openSection(oldP === '/dev/null' ? null : stripAB(oldP), newP === '/dev/null' ? null : stripAB(newP));
          hasPair = true;
          i += 2;
          continue;
        }
        throw new ParseProblem(`error: parse ${i + 2}`);
      }
      if (line.startsWith('rename from ')) {
        renameFrom = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        renameTo = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line === 'new file mode' || line.startsWith('new file mode ')) {
        current.create = true;
        i += 1;
        continue;
      }
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        current.remove = true;
        i += 1;
        continue;
      }
      if (line.startsWith('@@')) {
        const start = parseHunkHead(line);
        if (start === null) throw new ParseProblem(`error: parse ${i + 1}`);
        const { body, next } = readBody(i + 1);
        current.hunks.push({ start, body });
        seenHunk = true;
        i = next;
        continue;
      }
      i += 1;
      continue;
    }
    // Between hunks of the current section.
    if (line.startsWith('diff --git ')) {
      const [o, n] = readDiffGit(line, i);
      openSection(null, null);
      diffOld = o;
      diffNew = n;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = headerPath(line);
      const newP = headerPath(lines[i + 1]!);
      openSection(oldP === '/dev/null' ? null : stripAB(oldP), newP === '/dev/null' ? null : stripAB(newP));
      hasPair = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const start = parseHunkHead(line);
      if (start === null) throw new ParseProblem(`error: parse ${i + 1}`);
      const { body, next } = readBody(i + 1);
      current.hunks.push({ start, body });
      i = next;
      continue;
    }
    i += 1;
  }
  finishSection();

  return sections.map((section) => unifiedEdit(section, strict, moves));
}

/** Apply a section's hunks, in order, to a file's text. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, failPath: string): string {
  const parts = splitText(text);
  let fileLines = parts.lines;
  let final = parts.final;
  let delta = 0;
  for (const hunk of hunks) {
    const { oldLines, newLines } = hunkSides(hunk);
    if (oldLines.length > 0) {
      let found: { tier: number; positions: number[] } | null = null;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const tier of tiers) {
        const positions = occurrences(oldLines, fileLines, 0, tier);
        if (positions.length > 0) {
          found = { tier, positions };
          break;
        }
      }
      if (found === null) throw new EditProblem('no-match', failPath);
      const target = hunk.start - 1 + delta;
      let best = found.positions[0]!;
      for (const pos of found.positions) {
        if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
      }
      const repl = resolveNew(newLines, fileLines, best, oldLines, found.tier);
      const reachesEnd = best + oldLines.length === fileLines.length;
      fileLines = [...fileLines.slice(0, best), ...repl, ...fileLines.slice(best + oldLines.length)];
      if (reachesEnd) final = !endsWithoutBreak(hunk);
    } else {
      const at = Math.max(0, Math.min(hunk.start + delta, fileLines.length));
      const repl = newLines.map((n) => n.text);
      const atEnd = at === fileLines.length;
      fileLines = [...fileLines.slice(0, at), ...repl, ...fileLines.slice(at)];
      if (atEnd) final = !endsWithoutBreak(hunk);
    }
    delta += newLines.length - oldLines.length;
  }
  return joinText(fileLines, parts.br, final);
}

function unifiedEdit(section: Section, strict: boolean, moves: MoveRecord[]): ApplyEdit {
  const isCreate = section.create || section.oldPath === null;
  const isDelete = !isCreate && (section.remove || section.newPath === null);
  if (isCreate) {
    const newPath = section.newPath;
    return (tree) => {
      if (newPath === null) return;
      checkSafe(newPath);
      if (tree.present(newPath)) throw new EditProblem('exists', newPath);
      const added: string[] = [];
      let noBreak = false;
      for (const hunk of section.hunks) {
        const { newLines } = hunkSides(hunk);
        for (const n of newLines) {
          if (!n.context) added.push(n.text);
        }
        if (hunk.body.some((l) => l.startsWith('+'))) {
          // Whether the section's last '+' line is followed by a '\' line.
          for (let k = hunk.body.length - 1; k >= 0; k -= 1) {
            if (!hunk.body[k]!.startsWith('+')) continue;
            const next = hunk.body[k + 1];
            noBreak = next !== undefined && next.startsWith('\\');
            break;
          }
        }
      }
      tree.now.set(newPath, added.length === 0 ? '' : added.join('\n') + (noBreak ? '' : '\n'));
    };
  }
  if (isDelete) {
    const oldPath = section.oldPath;
    return (tree) => {
      if (oldPath === null) return;
      checkSafe(oldPath);
      if (tree.text(oldPath) === null) throw new EditProblem('missing', oldPath);
      tree.now.set(oldPath, null);
    };
  }
  const oldPath = section.oldPath!;
  const newPath = section.newPath!;
  if (oldPath !== newPath) {
    return (tree) => {
      checkSafe(oldPath);
      checkSafe(newPath);
      const before = tree.text(oldPath);
      if (before === null) throw new EditProblem('missing', oldPath);
      if (tree.present(newPath)) throw new EditProblem('exists', newPath);
      const out = applyHunks(before, section.hunks, strict, oldPath);
      tree.now.set(newPath, out);
      tree.now.set(oldPath, null);
      moves.push({ old: oldPath, next: newPath });
    };
  }
  return (tree) => {
    checkSafe(oldPath);
    const before = tree.text(oldPath);
    if (before === null) throw new EditProblem('missing', oldPath);
    tree.now.set(oldPath, applyHunks(before, section.hunks, strict, oldPath));
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[], strict: boolean): ApplyEdit[] {
  const edits: ApplyEdit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  for (let s = 0; s < lines.length; s += 1) {
    if (lines[s]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    let path: string | null = null;
    for (let j = s - 1; j >= prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseProblem(`error: parse ${s + 1}`);
    let eq = -1;
    let rep = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '<<<<<<< SEARCH') break;
      if (eq === -1) {
        if (t === '=======') eq = j;
        else if (t === '>>>>>>> REPLACE') break;
      } else if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (eq === -1 || rep === -1) throw new ParseProblem(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevEnd = rep + 1;
    prevPath = path;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): ApplyEdit {
  if (oldLines.length === 0) {
    return (tree) => {
      checkSafe(path);
      if (tree.present(path)) throw new EditProblem('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
    };
  }
  return (tree) => {
    checkSafe(path);
    const before = tree.text(path);
    if (before === null) throw new EditProblem('missing', path);
    const parts = splitText(before);
    const hit = firstTierWith(oldLines, parts.lines, 0, strict);
    if (hit === null) throw new EditProblem('no-match', path);
    if (hit.positions.length > 1) throw new EditProblem('ambiguous', path);
    const at = hit.positions[0]!;
    const repl = resolveNew(
      newLines.map((text) => ({ text, context: false, oldIndex: -1 })),
      parts.lines,
      at,
      oldLines,
      hit.tier,
    );
    const out = [...parts.lines.slice(0, at), ...repl, ...parts.lines.slice(at + oldLines.length)];
    tree.now.set(path, joinText(out, parts.br, parts.final));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  /** Null or '' means no anchor. */
  anchor: string | null;
  body: string[];
  eof: boolean;
}

const V4A_HEAD = /^\*\*\* (Add File|Delete File|Update File):(.*)$/;

function isV4aHead(line: string): boolean {
  return V4A_HEAD.test(line);
}

function parseV4a(lines: string[], strict: boolean, moves: MoveRecord[]): ApplyEdit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseProblem('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseProblem(`error: parse ${first + 1}`);
  const last = lines.reduce((acc, l, idx) => (!isBlank(l) ? idx : acc), -1);
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseProblem(`error: parse ${lines.length + 1}`);

  const edits: ApplyEdit[] = [];
  let i = first + 1;
  while (i < last) {
    if (isBlank(lines[i]!)) {
      i += 1;
      continue;
    }
    const head = V4A_HEAD.exec(lines[i]!);
    if (head === null) throw new ParseProblem(`error: parse ${i + 1}`);
    const kind = head[1]!;
    const path = head[2]!.trim();
    const headLine = i + 1;
    i += 1;
    // The section's raw lines run to the next header or the End Patch line; trailing blanks are not part of it.
    let end = i;
    while (end < last && !isV4aHead(lines[end]!)) end += 1;
    let trimmedEnd = end;
    while (trimmedEnd > i && isBlank(lines[trimmedEnd - 1]!)) trimmedEnd -= 1;
    const sectionLines = lines.slice(i, trimmedEnd);
    const sectionStart = i;
    i = end;

    if (kind === 'Add File') {
      const fileLines: string[] = [];
      for (let k = 0; k < sectionLines.length; k += 1) {
        const l = sectionLines[k]!;
        if (l === '') fileLines.push('');
        else if (l.startsWith('+')) fileLines.push(l.slice(1));
        else throw new ParseProblem(`error: parse ${sectionStart + k + 1}`);
      }
      edits.push((tree) => {
        checkSafe(path);
        if (tree.present(path)) throw new EditProblem('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      continue;
    }
    if (kind === 'Delete File') {
      for (let k = 0; k < sectionLines.length; k += 1) {
        if (sectionLines[k] !== '') throw new ParseProblem(`error: parse ${sectionStart + k + 1}`);
      }
      edits.push((tree) => {
        checkSafe(path);
        if (tree.text(path) === null) throw new EditProblem('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }
    // Update File.
    let moveTo: string | null = null;
    let k = 0;
    if (k < sectionLines.length && sectionLines[k]!.startsWith('*** Move to:')) {
      moveTo = sectionLines[k]!.slice('*** Move to:'.length).trim();
      k += 1;
    }
    const chunks: V4aChunk[] = [];
    let current: V4aChunk | null = null;
    const closeChunk = (): void => {
      if (current !== null) {
        chunks.push(current);
        current = null;
      }
    };
    for (; k < sectionLines.length; k += 1) {
      const l = sectionLines[k]!;
      const no = sectionStart + k + 1;
      if (l === '*** End of File') {
        if (current === null) throw new ParseProblem(`error: parse ${no}`);
        current.eof = true;
        closeChunk();
        continue;
      }
      if (l.startsWith('@@')) {
        closeChunk();
        current = { anchor: l.slice(2).trim(), body: [], eof: false };
        continue;
      }
      if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
        if (current === null) {
          if (chunks.length > 0) throw new ParseProblem(`error: parse ${no}`);
          current = { anchor: null, body: [], eof: false };
        }
        current.body.push(l);
        continue;
      }
      throw new ParseProblem(`error: parse ${no}`);
    }
    closeChunk();
    if (chunks.length === 0 && moveTo === null) throw new ParseProblem(`error: parse ${headLine}`);
    edits.push(v4aUpdateEdit(path, moveTo, chunks, strict, moves));
  }
  return edits;
}

function v4aUpdateEdit(
  path: string,
  moveTo: string | null,
  chunks: V4aChunk[],
  strict: boolean,
  moves: MoveRecord[],
): ApplyEdit {
  return (tree) => {
    checkSafe(path);
    if (moveTo !== null) checkSafe(moveTo);
    const before = tree.text(path);
    if (before === null) throw new EditProblem('missing', path);
    const parts = splitText(before);
    let fileLines = parts.lines;
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null && chunk.anchor !== '') {
        let found = -1;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const tier of tiers) {
          for (let idx = cursor; idx < fileLines.length; idx += 1) {
            if (lineEq(chunk.anchor, fileLines[idx]!, tier)) {
              found = idx;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new EditProblem('no-match', path);
        cursor = found + 1;
      }
      const { oldLines, newLines } = hunkSides({ start: 0, body: chunk.body });
      if (oldLines.length === 0) {
        const at = chunk.eof ? fileLines.length : cursor;
        const repl = newLines.map((n) => n.text);
        fileLines = [...fileLines.slice(0, at), ...repl, ...fileLines.slice(at)];
        cursor = at + repl.length;
        continue;
      }
      let hit: { tier: number; positions: number[] } | null = null;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const tier of tiers) {
        let positions = occurrences(oldLines, fileLines, cursor, tier);
        if (chunk.eof) positions = positions.filter((p) => p + oldLines.length === fileLines.length);
        if (positions.length > 0) {
          hit = { tier, positions };
          break;
        }
      }
      if (hit === null) throw new EditProblem('no-match', path);
      const at = hit.positions[0]!;
      const repl = resolveNew(newLines, fileLines, at, oldLines, hit.tier);
      fileLines = [...fileLines.slice(0, at), ...repl, ...fileLines.slice(at + oldLines.length)];
      cursor = at + repl.length;
    }
    const out = joinText(fileLines, parts.br, parts.final);
    if (moveTo !== null) {
      if (tree.present(moveTo)) throw new EditProblem('exists', moveTo);
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      moves.push({ old: path, next: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

// ---------------------------------------------------------------------------
// Driver (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function run(argv: string[]): { code: number; out: string[] } {
  const usage = { code: 2, out: ['error: usage'] };
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of argv) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (format !== null) return usage;
        const value = a.slice('--format='.length);
        if (!FORMAT_NAMES.includes(value)) return usage;
        format = value;
      } else if (a === '--check') {
        if (check) return usage;
        check = true;
      } else if (a === '--strict') {
        if (strict) return usage;
        strict = true;
      } else {
        return usage;
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return usage;
  const patchFile = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(patchFile ?? 0, 'utf8');
  } catch {
    if (patchFile !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: MoveRecord[] = [];
  let edits: ApplyEdit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict, moves);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict, moves);
    if (edits.length === 0) throw new ParseProblem('error: parse 1');
  } catch (e) {
    if (e instanceof ParseProblem) return { code: 2, out: [e.line] };
    throw e;
  }

  const tree = new Tree();
  const fails: EditProblem[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditProblem)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
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
    line: string;
  }
  const rows: Row[] = [];
  for (const p of [...tree.now.keys()].sort(byteOrder)) {
    const was = tree.original(p);
    const cur = tree.now.get(p)!;
    if (was === cur) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : cur === null ? 'D' : 'M'} ${p}` });
  }
  for (const mv of moves) {
    if (tree.original(mv.old) === null) continue;
    if (tree.text(mv.old) !== null) continue;
    if (tree.original(mv.next) !== null) continue;
    if (tree.text(mv.next) === null) continue;
    const dIdx = rows.findIndex((r) => r.line === `D ${mv.old}`);
    const aIdx = rows.findIndex((r) => r.line === `A ${mv.next}`);
    if (dIdx < 0 || aIdx < 0) continue;
    rows.splice(Math.max(dIdx, aIdx), 1);
    rows.splice(Math.min(dIdx, aIdx), 1);
    rows.push({ key: mv.next, line: `R ${mv.old} -> ${mv.next}` });
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));

  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteOrder)) {
      const was = tree.original(p);
      const cur = tree.now.get(p)!;
      if (was === cur) continue;
      if (cur === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, cur);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const result = run(process.argv.slice(2));
  writeSync(1, result.out.map((l) => `${l}\n`).join(''));
  process.exitCode = result.code;
}

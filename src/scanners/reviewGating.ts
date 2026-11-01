import type { Check, CheckResult } from "../checks.js";
import { dedupeFindings, finding, type Confidence, type Finding, type Severity } from "../finding.js";
import { lineAtFile, lineOf, searchFile, type ScanContext, type SourceFile } from "../project.js";
import { blankStrings, enclosingBraces, enclosingConditions, isDebugOnly } from "../scope.js";
import { MANAGED_PAYWALL, NON_SHIPPING_PATH, PURCHASE_CALL } from "../rules/store.js";
import {
  CONTENT_SINKS,
  GATE_DETECTORS,
  LEGAL_MARKERS,
  PROMO_WORD,
  RECEIPT_CONTEXT,
  SENSITIVE_SINKS,
  SERVER_PATH,
  classifySinks,
  describeSinks,
  hasAny,
  wordsOf,
  type GateDetector,
  type GateKind,
  type SinkProfile,
} from "../rules/gating.js";

// ───────────────────────── gate-site analysis (shared with remote_config) ─────────────────────────

const CODE_EXTS = new Set(["swift", "m", "mm", "h", "ts", "tsx", "js", "jsx", "mjs", "cjs", "kt", "java"]);
const MAX_BODY = 4000;

export function isCodeFile(f: SourceFile): boolean {
  return CODE_EXTS.has(f.ext);
}

const maskCache = new WeakMap<SourceFile, string>();
function maskOf(file: SourceFile): string {
  let m = maskCache.get(file);
  if (m === undefined) {
    m = blankStrings(file.code, file.ext);
    maskCache.set(file, m);
  }
  return m;
}

export type SiteKind = "if" | "guard" | "while" | "switch" | "ternary" | "and";

export interface GateSite {
  kind: SiteKind;
  /** the condition text */
  header: string;
  /** what runs differently depending on the condition (all branches, plus the rest of the scope for early exits) */
  body: string;
  /** offset of the header start in file.code */
  start: number;
  line: number;
}

export interface Analysis {
  site?: GateSite;
  /** a name whose value carries the gate (`let isReview = …`, `var isTF: Bool { … }`) */
  derived?: string;
  /** how `derived` got the value: a declaration, an assignment to an existing name, or a computed container */
  derivedBy?: "decl" | "assign" | "container";
  /** the full statement around the hit */
  statement: string;
  stmtStart: number;
  stmtEnd: number;
  /** the hit is an argument of a call, so the statement *uses* the value */
  inCall: boolean;
  /** the hit is the name a declaration introduces (`var isReviewBuild: Bool { get }`), not a read of it */
  declares?: string;
}

const OPENERS = "([{";
const CLOSERS = ")]}";
const CONTINUE_PREV = /[&|?:=(,.+\-*/<>!]$/;
const CONTINUE_NEXT = /^(&&|\|\||\?(?![?.])|:|\.(?!\.)|==|!=|\+|-(?!-)|\*|\/(?![/*]))/;

function prevNonSpace(m: string, k: number): string {
  let j = k - 1;
  while (j >= 0 && /\s/.test(m[j]!)) j--;
  return j >= 0 ? m[j]! : "";
}

/**
 * Longest statement walked from a hit. Each hit walks its statement, so without a cap one
 * long minified line or chained expression costs hits × length and stalls the gate.
 */
const MAX_STATEMENT = 4096;

function statementStart(m: string, i: number): { start: number; stop: string } {
  let depth = 0;
  const floor = Math.max(0, i - MAX_STATEMENT);
  for (let k = i - 1; k >= floor; k--) {
    const ch = m[k]!;
    if (ch === ")" || ch === "]") depth++;
    else if (ch === "}") {
      if (depth > 0) depth++;
      else return { start: k + 1, stop: "}" };
    } else if (ch === "(" || ch === "[") {
      if (depth > 0) depth--;
    } else if (ch === "{") {
      if (depth > 0) depth--;
      else return { start: k + 1, stop: "{" };
    } else if (ch === ";" && depth === 0) return { start: k + 1, stop: ";" };
    else if (ch === "\n" && depth === 0) {
      const prev = prevNonSpace(m, k);
      let j = k + 1;
      while (j < i && /\s/.test(m[j]!)) j++;
      const next = m.slice(j, Math.min(i, j + 8));
      if (!(CONTINUE_PREV.test(prev) || CONTINUE_NEXT.test(next))) return { start: k + 1, stop: "\n" };
    }
  }
  return { start: floor, stop: "" };
}

function statementEnd(m: string, i: number): number {
  let depth = 0;
  const limit = Math.min(m.length, i + MAX_STATEMENT);
  for (let k = i; k < limit; k++) {
    const c = m.charCodeAt(k);
    // ( [ {   and   ) ] }
    if (c === 40 || c === 91 || c === 123) depth++;
    else if (c === 41 || c === 93 || c === 125) {
      if (depth === 0) return k;
      depth--;
    } else if (c === 59 && depth === 0) return k;
    else if (c === 10 && depth === 0) {
      const prev = prevNonSpace(m, k);
      const rest = m.slice(k + 1, k + 40).trimStart();
      if (!(CONTINUE_PREV.test(prev) || CONTINUE_NEXT.test(rest))) return k;
    }
  }
  return limit;
}

function matchClose(m: string, open: number): number {
  const o = m[open]!;
  const c = o === "(" ? ")" : o === "[" ? "]" : "}";
  let depth = 0;
  for (let k = open; k < m.length; k++) {
    if (m[k] === o) depth++;
    else if (m[k] === c) {
      depth--;
      if (depth === 0) return k;
    }
  }
  return m.length - 1;
}

function skipSpace(m: string, k: number): number {
  while (k < m.length && /\s/.test(m[k]!)) k++;
  return k;
}

/** First `{` at bracket depth 0 from `from`, or -1 if a statement ends first. */
function firstBlockOpen(m: string, from: number, limit = 600): number {
  let depth = 0;
  for (let k = from; k < m.length && k < from + limit; k++) {
    const ch = m[k]!;
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") {
      if (depth === 0) return -1;
      depth--;
    } else if (ch === "{" && depth === 0) return k;
    else if ((ch === ";" || ch === "}") && depth === 0) return -1;
  }
  return -1;
}

function enclosingBlock(file: SourceFile, index: number): { open: number; close: number } | undefined {
  return enclosingBraces(file.code, file.ext, index);
}

/** A branch body plus (for JS `if (x) return;`) the rest of the enclosing scope. */
function branchAt(code: string, m: string, k: number): { text: string; end: number } {
  k = skipSpace(m, k);
  if (m[k] === "{") {
    const close = matchClose(m, k);
    return { text: code.slice(k + 1, close), end: close + 1 };
  }
  const end = statementEnd(m, k);
  return { text: code.slice(k, end), end: end + (m[end] === ";" ? 1 : 0) };
}

function remainderOfScope(file: SourceFile, from: number): string {
  const code = file.code;
  const b = enclosingBlock(file, from);
  const close = b ? b.close : code.length;
  return code.slice(from, Math.min(close, from + MAX_BODY));
}

const EARLY_EXIT = /^\s*\{?\s*(return|throw|break|continue)\b[^{};]*;?\s*\}?\s*$/;

function ifSite(file: SourceFile, start: number, kw: "if" | "while"): GateSite | undefined {
  const code = file.code;
  const m = maskOf(file);
  const kwAt = m.indexOf(kw, start);
  if (kwAt < 0) return undefined;
  let p = skipSpace(m, kwAt + kw.length);
  let bodyAt: number;
  if (m[p] === "(") {
    const close = matchClose(m, p);
    bodyAt = skipSpace(m, close + 1);
    // Swift `if (a) && b {` keeps going after the parenthesis.
    if (m[bodyAt] !== "{" && /^(&&|\|\||,)/.test(m.slice(bodyAt, bodyAt + 2))) {
      const open = firstBlockOpen(m, bodyAt);
      if (open < 0) return undefined;
      bodyAt = open;
    }
  } else {
    const open = firstBlockOpen(m, p);
    if (open < 0) return undefined;
    bodyAt = open;
  }
  const header = code.slice(start, bodyAt).replace(/\s+/g, " ").trim();
  const first = branchAt(code, m, bodyAt);
  let body = first.text;
  let end = first.end;
  for (let n = 0; n < 6; n++) {
    p = skipSpace(m, end);
    if (!m.startsWith("else", p)) break;
    p = skipSpace(m, p + 4);
    if (m.startsWith("if", p)) {
      const open = firstBlockOpen(m, p + 2);
      if (open < 0) break;
      body += `\n${code.slice(p, open)}`;
      const br = branchAt(code, m, open);
      body += `\n${br.text}`;
      end = br.end;
    } else {
      const br = branchAt(code, m, p);
      body += `\n${br.text}`;
      end = br.end;
      break;
    }
  }
  if (EARLY_EXIT.test(first.text)) body += `\n${remainderOfScope(file, end)}`;
  return { kind: kw, header, body: body.slice(0, MAX_BODY), start, line: lineOf(code, start) };
}

function guardSite(file: SourceFile, start: number): GateSite | undefined {
  const code = file.code;
  const m = maskOf(file);
  const elseAt = m.slice(start, start + 600).search(/\belse\s*\{/);
  if (elseAt < 0) return undefined;
  const open = m.indexOf("{", start + elseAt);
  const close = matchClose(m, open);
  const header = code.slice(start, start + elseAt).replace(/\s+/g, " ").trim();
  const body = `${code.slice(open + 1, close)}\n${remainderOfScope(file, close + 1)}`;
  return { kind: "guard", header, body: body.slice(0, MAX_BODY), start, line: lineOf(code, start) };
}

/** Offset of a top-level ternary `?` or `&&` in m[from, to). */
function topLevelOp(m: string, from: number, to: number, op: "?" | "&&"): number {
  let depth = 0;
  for (let k = from; k < to; k++) {
    const ch = m[k]!;
    if (OPENERS.includes(ch)) depth++;
    else if (CLOSERS.includes(ch)) depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      if (op === "&&" && ch === "&" && m[k + 1] === "&") return k;
      if (op === "?" && ch === "?") {
        const nx = m[k + 1] ?? "";
        const pv = m[k - 1] ?? "";
        if (nx === "?" || nx === "." || pv === "?" || nx === ":" || nx === ")" || nx === "," || nx === ";" || nx === "]") continue;
        if (/\s/.test(pv) || pv === ")") return k;
      }
    }
  }
  return -1;
}

const DECL =
  /^(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|internal|fileprivate|static|class|lazy|final|override|export|nonisolated|readonly|async)\s+)*(?:let|var|const)\s+([A-Za-z_$][\w$]*)/;
const MEMBER_DECL = /^(?:(?:public|private|protected|static|readonly)\s+)+([A-Za-z_$][\w$]*)\s*[:=]/;
const FUNC_DECL = /^(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|internal|fileprivate|static|class|final|override|export|nonisolated|async|mutating)\s+)*(?:func|function|get)\s+([A-Za-z_$][\w$]*)/;
const ASSIGN = /^(?:self\.|this\.)?([A-Za-z_$][\w$]*)\s*=(?!=)/;
const CONTAINER = [
  /(?:var|let)\s+([A-Za-z_]\w*)\s*:\s*Bool\??\s*$/,
  /func\s+([A-Za-z_]\w*)\s*\([^)]*\)[^{]*$/,
  /function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)[^{]*$/,
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>\s*$/,
  /\bget\s+([A-Za-z_$][\w$]*)\s*\(\s*\)[^{]*$/,
  /^\s*(?:(?:public|private|protected|static|async)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[\w<>[\]| ]+)?\s*$/,
];
const NOT_NAMES = new Set(["if", "for", "while", "switch", "catch", "return", "guard", "else", "function", "init"]);

function containerName(code: string, m: string, braceAt: number): string | undefined {
  const { start } = statementStart(m, braceAt);
  const header = code.slice(start, braceAt).replace(/\s+/g, " ").trim();
  for (const rx of CONTAINER) {
    const mm = rx.exec(header);
    if (mm?.[1] && !NOT_NAMES.has(mm[1])) return mm[1];
  }
  return undefined;
}

/** Conversions that pass a value through unchanged in meaning (`Boolean(x)`, `Bool(x)`). */
const TRANSPARENT_CALLS = /(?:^|[^\w$.])(?:Boolean|Bool|String|Number|Int|Double|parseInt|parseFloat|Optional)\s*$/;

function insideCallArgs(m: string, from: number, index: number): boolean {
  let depth = 0;
  for (let k = index - 1; k >= from; k--) {
    const ch = m[k]!;
    if (ch === ")" || ch === "]") depth++;
    else if (ch === "(" || ch === "[") {
      if (depth > 0) {
        depth--;
        continue;
      }
      if (ch === "(" && /[\w$?!>]/.test(prevNonSpace(m, k))) {
        if (TRANSPARENT_CALLS.test(m.slice(Math.max(from, k - 40), k))) continue;
        return true;
      }
    }
  }
  return false;
}

// Detector scanning and tracing both analyze the same hits; each analysis walks its statement.
const analysisCache = new WeakMap<SourceFile, Map<number, Analysis>>();

/** Classifies the hit at `index`: a condition site, a derived name, or neither. */
export function analyzeAt(file: SourceFile, index: number): Analysis {
  let byIndex = analysisCache.get(file);
  if (!byIndex) analysisCache.set(file, (byIndex = new Map()));
  let a = byIndex.get(index);
  if (!a) byIndex.set(index, (a = analyzeUncached(file, index)));
  return a;
}

function analyzeUncached(file: SourceFile, index: number): Analysis {
  const code = file.code;
  const m = maskOf(file);
  const { start: rawStart, stop } = statementStart(m, index);
  const start = skipSpace(m, rawStart);
  const end = Math.max(statementEnd(m, start), index);
  const statement = code.slice(start, Math.min(Math.max(end, index), Math.max(index + 200, start + 400))).replace(/\s+/g, " ").trim();
  const rawLead = code.slice(start, start + 200);
  const lead = rawLead.replace(/^\}\s*/, "");
  const out: Analysis = { statement, stmtStart: start, stmtEnd: end, inCall: insideCallArgs(m, start, index) };

  // The declared name itself is neither a branch nor a read; its uses are analyzed on their own.
  const named = DECL.exec(lead) ?? MEMBER_DECL.exec(lead) ?? FUNC_DECL.exec(lead);
  if (named?.[1]) {
    const nameAt = start + (rawLead.length - lead.length) + named[0].lastIndexOf(named[1]);
    if (index >= nameAt && index < nameAt + named[1].length) {
      out.declares = named[1];
      return out;
    }
  }

  if (/^(?:else\s+)?if\b/.test(lead)) {
    out.site = ifSite(file, start, "if");
    return out;
  }
  if (/^while\b/.test(lead)) {
    out.site = ifSite(file, start, "while");
    return out;
  }
  if (/^guard\b/.test(lead)) {
    out.site = guardSite(file, start);
    return out;
  }
  if (/^switch\b/.test(lead)) {
    const open = firstBlockOpen(m, start);
    if (open > 0) {
      const close = matchClose(m, open);
      out.site = {
        kind: "switch",
        header: code.slice(start, open).replace(/\s+/g, " ").trim(),
        body: code.slice(open + 1, close).slice(0, MAX_BODY),
        start,
        line: lineOf(code, start),
      };
    }
    return out;
  }

  const q = topLevelOp(m, index, end, "?");
  if (q >= 0) {
    out.site = { kind: "ternary", header: code.slice(start, q).replace(/\s+/g, " ").trim(), body: code.slice(q + 1, end), start, line: lineOf(code, start) };
    return out;
  }
  const and = topLevelOp(m, index, end, "&&");
  const declared = DECL.exec(lead) ?? MEMBER_DECL.exec(lead) ?? ASSIGN.exec(lead);
  if (and >= 0 && !declared && !/^return\b/.test(lead)) {
    out.site = { kind: "and", header: code.slice(start, and).replace(/\s+/g, " ").trim(), body: code.slice(and + 2, end), start, line: lineOf(code, start) };
    return out;
  }

  if (declared?.[1]) {
    const nameEnd = start + lead.indexOf(declared[1]) + declared[1].length;
    // A hit on the declared name itself is a use of the detector, not a derivation from it.
    if (index >= nameEnd) {
      out.derived = declared[1];
      out.derivedBy = DECL.exec(lead) ? "decl" : "assign";
    }
    return out;
  }
  if (/^return\b/.test(lead) || stop === "{") {
    const block = enclosingBlock(file, index);
    if (block) {
      const inner = code.slice(block.open + 1, block.close).trim();
      const single = inner.replace(/^return\s+/, "").replace(/;$/, "").trim() === statement.replace(/^return\s+/, "").replace(/;$/, "").trim();
      if ((/^return\b/.test(lead) && !out.inCall) || single) {
        out.derived = containerName(code, m, block.open);
        if (out.derived) out.derivedBy = "container";
      }
    }
  }
  return out;
}

export interface TraceResult {
  sites: { file: SourceFile; site: GateSite; via?: string }[];
  /** non-condition statements that use the value (e.g. passed as a prompt) */
  uses: { file: SourceFile; line: number; text: string }[];
  names: string[];
}

function escapeRx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Names that are likely global (a computed property or exported helper), worth following across files. */
function isDistinctive(name: string): boolean {
  if (name.length < 6) return false;
  return /^(is|in|has|should|show|enable|can|use|allow)[A-Z_]/.test(name) || /review|testflight|sandbox|demo|launch|unlock/i.test(name) || (name.length >= 8 && /[a-z][A-Z]|_/.test(name));
}

/**
 * Names too generic to follow by text across files: `.isEnabled` or `wideEvent` in another
 * file is almost never the same value.
 */
const GENERIC_NAMES = new Set([
  "isEnabled", "enabled", "isOn", "isOff", "isActive", "active", "isVisible", "visible", "isHidden", "hidden", "show", "shouldShow",
  "configuration", "config", "settings", "options", "environment", "env", "build", "buildType", "current", "shared", "instance",
  "result", "results", "data", "flow", "existingFlow", "observer", "value", "state", "status", "mode", "type", "flag", "flags",
  "event", "wideEvent", "response", "res", "item", "model", "key", "cacheKey", "name", "displayName", "title", "text", "client",
  "manager", "service", "provider", "store", "context", "ctx", "session", "user", "account", "isAvailable", "available",
]);

interface DeclInfo {
  count: number;
  files: string[];
}
const declCountIndex = new WeakMap<ScanContext, Map<string, DeclInfo>>();

/** How many times each name is declared across the project, and where. */
function declCounts(ctx: ScanContext): Map<string, DeclInfo> {
  let idx = declCountIndex.get(ctx);
  if (idx) return idx;
  idx = new Map();
  const rx = /\b(?:var|let|const|func|function|get|case)\s+([A-Za-z_$][\w$]*)|\b(?:public|private|protected|readonly|static)\s+(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*[:=?]/g;
  for (const f of ctx.files.filter(isCodeFile)) {
    for (const m of f.code.matchAll(rx)) {
      const name = m[1] ?? m[2];
      if (!name) continue;
      const cur = idx.get(name) ?? { count: 0, files: [] };
      cur.count++;
      if (!cur.files.includes(f.path)) cur.files.push(f.path);
      idx.set(name, cur);
    }
  }
  declCountIndex.set(ctx, idx);
  return idx;
}

export interface TraceOptions {
  /**
   * Follow a value through call arguments (`const res = await fetch(URL)`). Remote config
   * needs this; review gating does not: `WideEvent(useMockRequests: isReviewBuild)` does not
   * make the new object a review flag.
   */
  throughCalls?: boolean;
}

/** Follows a hit through derived names (up to `maxDepth` hops) to the conditions that use it. */
export function trace(ctx: ScanContext, file: SourceFile, index: number, maxDepth = 2, opts: TraceOptions = {}): TraceResult {
  const throughCalls = opts.throughCalls ?? true;
  const res: TraceResult = { sites: [], uses: [], names: [] };
  const seenSites = new Set<string>();
  const seenNames = new Set<string>();
  const visit = (f: SourceFile, i: number, depth: number, via?: string) => {
    const a = analyzeAt(f, i);
    if (a.site) {
      const key = `${f.path}:${a.site.start}`;
      if (!seenSites.has(key)) {
        seenSites.add(key);
        res.sites.push({ file: f, site: a.site, via });
      }
      return;
    }
    if (!a.derived || a.inCall) res.uses.push({ file: f, line: lineAtFile(f, a.stmtStart), text: a.statement });
    if (a.inCall && !throughCalls) return;
    if (a.derived && depth < maxDepth && !seenNames.has(a.derived)) {
      const name = a.derived;
      seenNames.add(name);
      res.names.push(name);
      // Cross-file only from the first hop, for a declared (not merely assigned) name that
      // is declared once in the whole project; anything else is followed within its file.
      const decl = declCounts(ctx).get(name);
      const wide =
        depth === 0 &&
        isDistinctive(name) &&
        !GENERIC_NAMES.has(name) &&
        a.derivedBy !== "assign" &&
        (decl?.count ?? 0) <= 1;
      const files = wide ? ctx.files.filter(isCodeFile) : [f];
      // A `let`/`const` inside a block is only visible in that block.
      const block = !wide && a.derivedBy === "decl" ? enclosingBlock(f, a.stmtStart) : undefined;
      const lo = block ? block.open : 0;
      const hi = block ? block.close : Number.MAX_SAFE_INTEGER;
      // Distinctive names are usually properties (`Bundle.main.isReviewBuild`), so member access counts too.
      const rx = wide
        ? new RegExp(`(?<![\\w$])${escapeRx(name)}(?![\\w$])`)
        : new RegExp(`(?<![\\w$.])${escapeRx(name)}(?![\\w$])|(?<=\\b(?:self|this)\\.)${escapeRx(name)}(?![\\w$])`);
      let count = 0;
      for (const g of files) {
        for (const index of refsIn(g, rx, g === f && block ? { from: lo, to: hi } : undefined)) {
          if (g === f && index >= a.stmtStart && index <= a.stmtEnd) continue;
          // The declaration of the derived name is not a use of it.
          if (/\b(?:var|let|const|func|function|get|static)\s+$/.test(g.code.slice(Math.max(0, index - 40), index))) continue;
          if (++count > 60) return;
          visit(g, index, depth + 1, name);
        }
      }
    }
  };
  visit(file, index, 0);
  return res;
}

const refCache = new WeakMap<SourceFile, Map<string, number[]>>();

/** Match starts of rx in a file, cached because every hit in one long statement traces the same derived names. */
function refsIn(file: SourceFile, rx: RegExp, range?: { from: number; to: number }): number[] {
  let byKey = refCache.get(file);
  if (!byKey) refCache.set(file, (byKey = new Map()));
  const key = `${rx.source}\0${range ? `${range.from}:${range.to}` : ""}`;
  let out = byKey.get(key);
  if (!out) {
    out = (range ? searchRange(file, rx, range.from, range.to) : searchFile(file, rx)).map((h) => h.index);
    byKey.set(key, out);
  }
  return out;
}

/** searchFile limited to [from, to) of the comment-stripped code. */
function searchRange(file: SourceFile, rx: RegExp, from: number, to: number): { index: number }[] {
  const g = new RegExp(rx.source, rx.flags.includes("g") ? rx.flags : `${rx.flags}g`);
  g.lastIndex = from;
  const out: { index: number }[] = [];
  for (let m = g.exec(file.code); m && m.index < to; m = g.exec(file.code)) {
    out.push({ index: m.index });
    if (m[0].length === 0) g.lastIndex++;
  }
  return out;
}

// ───────────────────────── build-time configuration ─────────────────────────

/**
 * Values fixed when the binary is built. App Review tests the same binary App Store users
 * get, so a flag derived only from these cannot tell a reviewer from a customer.
 */
const BUILD_TIME =
  /\bbundleIdentifier\b|\bBundle\.main\.(?:object\s*\(\s*forInfoDictionaryKey|infoDictionary)|\binfoDictionary\b|^[ \t]*#if\b|\bprocess\.env\b|\bEXPO_PUBLIC_\w+|__DEV__|\bConstants\.(?:expoConfig|manifest2?|easConfig)\b|\bConfig\.[A-Z_]{2,}\b|\bBuildConfig\.\w+|\bgetBundleId\b|\bDeviceInfo\.getBundleId\b|\bProcessInfo\.processInfo\.environment\b/m;
/** Values that genuinely differ for an App Review install. */
const RUNTIME_ENV =
  /appStoreReceiptURL|sandboxReceipt|\bAppTransaction\b|\.environment\s*[!=]=|embedded\.mobileprovision|getIosApplicationReleaseTypeAsync|ApplicationReleaseType|\bTransaction\b|isTestFlight\w*\s*\(|reviewer|appReview|in_review|IN_REVIEW|\bfetch\(|URLSession|axios|remoteConfig|RemoteConfig|featureFlag|useFeatureFlag/;
const BUILD_CONFIG_FILE = /(^|\/)(app|babel|metro|react-native|webpack|eas)\.config\.[cm]?[jt]s$/;

interface BuildConfigOrigin {
  file: string;
  line: number;
  evidence: string;
}

interface Definition {
  file: SourceFile;
  index: number;
  text: string;
}
const definitionCache = new WeakMap<ScanContext, Map<string, Definition[]>>();

function definitionsOf(ctx: ScanContext, name: string): Definition[] {
  let cache = definitionCache.get(ctx);
  if (!cache) definitionCache.set(ctx, (cache = new Map()));
  const hit = cache.get(name);
  if (hit) return hit;
  const out = findDefinitions(ctx, name);
  cache.set(name, out);
  return out;
}

/** Mocks and fakes stand in for the real value in tests and previews; they never decide what ships. */
const MOCK_PATH = /(?:^|\/)(?:Mocks?|Fakes?|Stubs?|Preview Content)\/|(?:^|\/)(?:Mock|Fake|Stub)[A-Z]\w*\.\w+$|[a-z0-9](?:Mock|Fake|Stub)s?\.\w+$/;

function insideProtocol(f: SourceFile, index: number): boolean {
  const block = enclosingBlock(f, index);
  if (!block) return false;
  const { start } = statementStart(maskOf(f), block.open);
  return /(?:^|\s)protocol\s+[A-Za-z_]/.test(f.code.slice(start, block.open));
}

function findDefinitions(ctx: ScanContext, name: string): Definition[] {
  const n = escapeRx(name);
  const rx = new RegExp(`\\b(?:var|let|const|func|function|get)\\s+${n}(?![\\w$])`);
  // A stored property typed but not initialized here (`private let isAppStoreBuild: Bool`) gets its value in an initializer.
  const typedOnly = /^\s*:\s*[^={}\n;]+?\s*(?:\n|;|$)/;
  const out: Definition[] = [];
  for (const f of ctx.files.filter((x) => isCodeFile(x) && !MOCK_PATH.test(x.path))) {
    const m = maskOf(f);
    for (const h of searchFile(f, rx)) {
      const after = h.index + h.match.length;
      // A protocol requirement declares a name without giving it a value.
      if (insideProtocol(f, h.index)) continue;
      if (typedOnly.test(f.code.slice(after, after + 200))) {
        for (const a of searchFile(f, new RegExp(`(?<![\\w$.])(?:(?:self|this)\\.)?${n}\\s*=(?!=)`))) {
          const at = a.index + a.match.indexOf(name);
          out.push({ file: f, index: at, text: f.code.slice(at, Math.min(statementEnd(m, at), at + 800)) });
        }
        continue;
      }
      const open = firstBlockOpen(m, after, 300);
      const end = open >= 0 ? matchClose(m, open) + 1 : statementEnd(m, after);
      out.push({ file: f, index: h.index, text: f.code.slice(h.index, Math.min(end, h.index + 800)) });
      if (out.length >= 6) return out;
    }
  }
  return out;
}

function underCompileFlag(f: SourceFile, index: number): boolean {
  return enclosingConditions(f.code, index, f.ext).conditions.some((c) => c.kind === "#if");
}

const buildConfigCache = new WeakMap<ScanContext, Map<string, BuildConfigOrigin | null>>();

/** Where `name` is fixed at build time, if every definition of it is; undefined when it is runtime or unknown. */
export function buildConfigOrigin(ctx: ScanContext, name: string): BuildConfigOrigin | undefined {
  let cache = buildConfigCache.get(ctx);
  if (!cache) buildConfigCache.set(ctx, (cache = new Map()));
  if (cache.has(name)) return cache.get(name) ?? undefined;
  const defs = definitionsOf(ctx, name);
  let origin: BuildConfigOrigin | undefined;
  if (defs.length) {
    const verdicts = defs.map((d) => {
      const body = d.text.split(name).join(" ");
      // `let isReviewBuild = buildType.isReviewBuild` (or an initializer storing its own
      // `isReviewBuild` parameter) only forwards another definition.
      if (d.text.slice(name.length).includes(`.${name}`)) return "alias";
      const rhs = /^[\w$]+\s*=(?!=)\s*([\s\S]*)$/.exec(d.text)?.[1]?.trim().replace(/;$/, "");
      if (rhs === name) return "alias";
      if (RUNTIME_ENV.test(body)) return "runtime";
      if (BUILD_TIME.test(body) || underCompileFlag(d.file, d.index)) return "build";
      // One level of indirection: `IS_TESTFLIGHT = ENV === "testflight"` with `ENV = process.env…`.
      const refs = [...new Set([...d.text.slice(name.length + 8).matchAll(/(?<![\w$.])([A-Za-z_$][\w$]{1,})\b/g)].map((x) => x[1]!))]
        .filter((r) => r !== name && !/^(let|var|const|func|function|return|true|false|nil|null|undefined|Bool|String|static|get|some|self|this)$/.test(r))
        .slice(0, 8);
      let build = false;
      for (const r of refs) {
        for (const rd of definitionsOf(ctx, r).filter((x) => x.file === d.file || x.file.path.split("/").slice(0, -1).join("/") === d.file.path.split("/").slice(0, -1).join("/"))) {
          if (RUNTIME_ENV.test(rd.text)) return "runtime";
          if (BUILD_TIME.test(rd.text) || underCompileFlag(rd.file, rd.index)) build = true;
        }
      }
      return build ? "build" : "unknown";
    });
    if (verdicts.includes("build") && verdicts.every((v) => v === "build" || v === "alias")) {
      const d = defs[verdicts.indexOf("build")]!;
      origin = { file: d.file.path, line: lineAtFile(d.file, d.index), evidence: d.text.split("\n")[0]!.trim() };
    }
  }
  cache.set(name, origin ?? null);
  return origin;
}

/** Detectors that match a symbol name, whose meaning depends on how that symbol is defined. */
const SYMBOL_DETECTORS = new Set(["App Review identity check", "review-mode flag", "TestFlight / sandbox detection", "demo-account check"]);

// ───────────────────────── scope expansion ─────────────────────────

interface Decl {
  file: SourceFile;
  kind: "value" | "function";
  /** declaration text (values) or the returned expressions (functions) */
  text: string;
}

const declIndex = new WeakMap<ScanContext, Map<string, Decl[]>>();
const KEYWORDS = new Set(["return", "const", "let", "var", "func", "function", "true", "false", "nil", "null", "undefined", "self", "this", "await", "async", "try", "new", "some", "View", "String", "Bool", "Int", "Text", "Array", "Object", "Promise"]);

function indexDecls(ctx: ScanContext): Map<string, Decl[]> {
  let idx = declIndex.get(ctx);
  if (idx) return idx;
  idx = new Map();
  for (const f of ctx.files.filter(isCodeFile)) {
    const m = maskOf(f);
    for (const h of searchFile(f, /\b(function\s+|func\s+|(?:const|let|var)\s+)([A-Za-z_$][\w$]*)/)) {
      const name = h.groups[1] ?? "";
      if (!name || KEYWORDS.has(name)) continue;
      const isFn = /^func|^function/.test(h.groups[0] ?? "") || /^\s*[:=]\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/.test(f.code.slice(h.index + h.match.length, h.index + h.match.length + 200));
      let text: string;
      if (isFn) {
        const open = m.indexOf("{", h.index + h.match.length);
        if (open < 0 || open - h.index > 400) continue;
        const body = f.code.slice(open + 1, matchClose(m, open));
        // What a function hands back is what the gated scope gets; its side effects are not followed.
        text = [...body.matchAll(/\breturn\b([^;\n]*)/g)].map((x) => x[1] ?? "").join("\n");
        if (!text.trim()) continue;
      } else {
        // Only stored values count as data; computed properties (`var body: some View { … }`) are code.
        if (!/^\s*(?::[^={\n]+)?=(?!=)/.test(f.code.slice(h.index + h.match.length, h.index + h.match.length + 200))) continue;
        text = f.code.slice(h.index, Math.min(statementEnd(m, h.index), h.index + 1500));
      }
      const list = idx.get(name) ?? [];
      list.push({ file: f, kind: isFn ? "function" : "value", text });
      idx.set(name, list);
    }
  }
  declIndex.set(ctx, idx);
  return idx;
}

/**
 * Appends what a gated scope refers to: same-file constants (`BODY_PRESETS`) and the
 * return values of called functions defined anywhere in the project (`availablePresets()`).
 * Side effects of called functions are deliberately not followed: a settings screen that
 * happens to contain "Restore Purchases" says nothing about what this branch does.
 */
export function expandScope(ctx: ScanContext, file: SourceFile, text: string, depth = 2, budget = { left: 8000 }): string {
  if (depth <= 0 || budget.left <= 0) return text;
  const idx = indexDecls(ctx);
  const parts = [text];
  const seen = new Set<string>();
  // `...BODY_PRESETS` is the spread value itself, not member access.
  for (const mm of text.matchAll(/(?<![\w$])(?:(?<=\.\.\.)|(?<!\.))([A-Za-z_$][\w$]{2,})\b(\s*\()?/g)) {
    const name = mm[1]!;
    if (seen.has(name) || KEYWORDS.has(name)) continue;
    seen.add(name);
    const decls = idx.get(name) ?? [];
    const called = Boolean(mm[2]);
    const local = decls.filter((d) => d.file === file && d.kind === "value" && !text.startsWith(d.text));
    const fns = called ? decls.filter((d) => d.kind === "function") : [];
    for (const d of [...local, ...(fns.length === 1 ? fns : fns.filter((d) => d.file === file))]) {
      if (budget.left <= 0) break;
      const add = d.text.slice(0, Math.min(1500, budget.left));
      budget.left -= add.length;
      parts.push(expandScope(ctx, d.file, add, depth - 1, budget));
    }
  }
  return parts.join("\n");
}

export function debugOnlyAt(file: SourceFile, index: number): boolean {
  return isDebugOnly(enclosingConditions(file.code, index, file.ext));
}

// ───────────────────────── the check ─────────────────────────

interface GateHit {
  file: SourceFile;
  kinds: Set<GateKind>;
  labels: string[];
  site?: GateSite;
  index: number;
  line: number;
  evidence: string;
  via?: string;
  /** the flag every site of this hit reads, so many sites of one flag become one finding */
  symbol?: string;
}

/** Up to `lines` lines either side of `index`, bounded in characters so one-line minified files stay cheap. */
function windowAround(file: SourceFile, index: number, lines = 12): string {
  const code = file.code;
  const floor = Math.max(0, index - lines * 250);
  const ceil = Math.min(code.length, index + lines * 250);
  let s = index;
  for (let n = 0; n <= lines && s > floor; n++) {
    const p = code.lastIndexOf("\n", s - 1);
    s = p < floor ? floor : p;
  }
  let e = index;
  for (let n = 0; n < lines && e < ceil; n++) {
    const nx = code.indexOf("\n", e + 1);
    e = nx < 0 || nx > ceil ? ceil : nx;
  }
  return code.slice(Math.max(0, s), e);
}

const PRECEDENCE: [GateKind, GateKind][] = [
  ["reviewer", "review-state"],
  ["storefront", "region"],
  ["timezone-pacific", "timezone"],
  ["date", "install-age"],
];

interface BuildConfigHit {
  name: string;
  kind: GateKind;
  origin: BuildConfigOrigin;
  uses: { file: string; line: number }[];
}

export const MAX_HITS_PER_FILE = 8000;
export const MAX_HITS_PER_DETECTOR = 1000;

function collect(ctx: ScanContext): { standalone: GateHit[]; sited: Map<string, GateHit>; buildConfig: Map<string, BuildConfigHit> } {
  const standalone: GateHit[] = [];
  const sited = new Map<string, GateHit>();
  const buildConfig = new Map<string, BuildConfigHit>();
  const addSite = (file: SourceFile, site: GateSite, det: GateDetector, via?: string, symbol?: string) => {
    const key = `${file.path}:${site.start}`;
    const cur = sited.get(key) ?? { file, kinds: new Set<GateKind>(), labels: [], site, index: site.start, line: site.line, evidence: site.header, via, symbol };
    cur.kinds.add(det.kind);
    if (!cur.labels.includes(det.label)) cur.labels.push(det.label);
    sited.set(key, cur);
  };

  // Build configuration files run on the developer's machine, never in the app; debug menus, scripts and stories never reach App Review.
  for (const file of ctx.files.filter((f) => isCodeFile(f) && !BUILD_CONFIG_FILE.test(f.path) && !NON_SHIPPING_PATH.test(f.path))) {
    // Each hit walks its statement (up to MAX_STATEMENT either way), so a malformed or
    // generated file with one detector term repeated through a single statement costs
    // hits × statement length. Real files stay far below both caps; the per-detector cap
    // keeps one repeated term from starving the other detectors of the file's budget.
    let analyzed = 0;
    for (const det of GATE_DETECTORS) {
      if (analyzed >= MAX_HITS_PER_FILE) break;
      let own = 0;
      for (const h of searchFile(file, det.rx)) {
        if (++own > MAX_HITS_PER_DETECTOR || ++analyzed > MAX_HITS_PER_FILE) break;
        if (debugOnlyAt(file, h.index)) continue;
        const a = analyzeAt(file, h.index);
        if (a.declares) continue;
        const stmt = a.site ? `${a.site.header} ${a.statement}` : a.statement;
        const near = file.code.slice(Math.max(0, h.index - 400), h.index);
        const before = near.slice(near.lastIndexOf("\n") + 1);
        if (det.validate && !det.validate(stmt, windowAround(file, h.index), before, file.code)) continue;
        const symbolic = SYMBOL_DETECTORS.has(det.label) && /^[A-Za-z_$][\w$]*$/.test(h.match);
        const alone: GateHit = { file, kinds: new Set([det.kind]), labels: [det.label], index: h.index, line: h.line, evidence: h.text, symbol: symbolic ? h.match : undefined };
        if (det.standalone) {
          standalone.push(alone);
          continue;
        }
        if (symbolic) {
          const origin = buildConfigOrigin(ctx, h.match);
          if (origin) {
            const cur = buildConfig.get(h.match) ?? { name: h.match, kind: det.kind, origin, uses: [] };
            if (cur.uses.length < 20) cur.uses.push({ file: file.path, line: h.line });
            buildConfig.set(h.match, cur);
            continue;
          }
        }
        const t = trace(ctx, file, h.index, 2, { throughCalls: false });
        const live = t.sites.filter((s) => !debugOnlyAt(s.file, s.site.start) && !BUILD_CONFIG_FILE.test(s.file.path));
        for (const s of live) addSite(s.file, s.site, det, s.via, s.via ?? alone.symbol);
        // Reviewer detection is the finding even when its result is consumed somewhere we cannot follow.
        if (det.kind === "reviewer" && live.length === 0) standalone.push(alone);
      }
    }
  }
  for (const hit of sited.values()) for (const [hi, lo] of PRECEDENCE) if (hit.kinds.has(hi)) hit.kinds.delete(lo);
  return { standalone, sited, buildConfig };
}

/** Adult or nudification content cannot be fixed by disclosure: the content itself is the problem. */
const ADULT_REMOVE =
  "Remove the switch and the adult or nudification content it gates. Content App Review rejects under 1.1 must not ship behind any gate, so disclosing the switch does not fix it.";

/** Runtime install-environment detectors; the rest match symbols whose origin is unknown. */
const RECEIPT_LABELS = new Set(["sandbox receipt check", "StoreKit environment check", "StoreKit environment switch", "install-source detection", "provisioning-profile detection"]);

/** A branch that only switches things off or adds moderation restricts users; it never shows reviewers less than users get. */
function restrictsOnly(gate: string, scope: string): boolean {
  // `if (!adultContentDisabled)` enables content; only an un-negated restriction counts.
  const negated = /!\s*[\w$.?]*(?:Disabled|Blocked|Restricted|Prohibited|Banned)\b|(?:Disabled|Blocked|Restricted|Prohibited|Banned)\s*[!=]==?\s*(?:false|nil|null)|!==?\s*true/.test(gate);
  if (!negated && /\b\w*(?:Disabled|Blocked|Restricted|Prohibited|Banned)\b|\b(?:age ?assurance|ageAssurance|age ?verification|ageVerification)\b/.test(gate)) return true;
  const offs = [...scope.matchAll(/\b(\w*?)(?:Enabled|Allowed|Visible|Available)\s*[:=]\s*false\b|\b(\w*?)(?:Disabled|Blocked|Hidden|Restricted)\s*[:=]\s*true\b/g)];
  const weakensSafety = offs.some((m) => /moderat|filter|safe|report|block|age/i.test(m[1] ?? m[2] ?? ""));
  const adds = /\b(?:labelers?|moderation\w*|moderators?)\b/i.test(scope) && /\b(?:push|add|append|concat|insert|\.\.\.)/.test(scope);
  return !weakensSafety && (offs.length > 0 || adds);
}

const receiptFiles = new WeakMap<SourceFile, boolean>();
function isReceiptFile(f: SourceFile): boolean {
  let r = receiptFiles.get(f);
  if (r === undefined) receiptFiles.set(f, (r = RECEIPT_CONTEXT.test(f.code)));
  return r;
}

const REMOVE_OR_DISCLOSE =
  "Remove the branch so every user, App Review included, gets the same behavior. If the gated feature must ship, make it reachable during review and describe it specifically in Notes for Review (2.3.1(a)).";

/** Detecting App Review itself has no disclosable form: the check is the violation. */
const REMOVE_REVIEWER_CHECK =
  "Remove the check entirely so nothing branches on whether the user is App Review (Apple's network, Cupertino, Pacific time, reviewer accounts or review status). Disclosure in Notes for Review does not cure this (2.5.19, DPLA 3.2(e)).";

interface Verdict {
  rule: string;
  severity: Severity;
  guideline: string;
  why: string;
  fix: string;
  confidence: Confidence;
  suppressible: boolean;
}

function verdictFor(kind: GateKind, sinks: SinkProfile, gate: string, where: string, scope: string, ctxText = "", runtimeEnv = true, ungatedPurchase = false): Verdict | undefined {
  const v = baseVerdict(kind, sinks, gate, where, scope, ctxText, runtimeEnv, ungatedPurchase);
  if (v && sinks.kinds.includes("adult") && (v.severity === "block" || v.severity === "high")) return { ...v, fix: ADULT_REMOVE, suppressible: false };
  return v;
}

function baseVerdict(kind: GateKind, sinks: SinkProfile, gate: string, where: string, scope: string, ctxText: string, runtimeEnv: boolean, ungatedPurchase: boolean): Verdict | undefined {
  const sensitive = hasAny(sinks, SENSITIVE_SINKS);
  const content = hasAny(sinks, CONTENT_SINKS);
  const what = describeSinks(sinks);
  const does = what ? `The gated code touches ${what}.` : "";
  switch (kind) {
    case "apple-ip":
      return {
        rule: "review_gating.apple_ip",
        severity: "block",
        guideline: "2.5.19",
        why: `${where} checks for Apple's 17.0.0.0/8 network, which is where App Review traffic comes from. Code that behaves differently for Apple is hiding behavior from review (2.5.19, DPLA 3.2(e)) and is the kind of conduct cited in 3.2(f) terminations. ${does}`.trim(),
        fix: REMOVE_REVIEWER_CHECK,
        confidence: "high",
        suppressible: false,
      };
    case "geofence":
      return {
        rule: "review_gating.geofence",
        severity: "block",
        guideline: "2.5.19",
        why: `${where} tests whether the user is at Apple's Cupertino campus. Location checks aimed at Apple change what App Review sees (2.5.19, DPLA 3.2(e)). ${does}`.trim(),
        fix: REMOVE_REVIEWER_CHECK,
        confidence: "high",
        suppressible: false,
      };
    case "reviewer":
      return {
        rule: "review_gating.reviewer_branch",
        severity: "block",
        guideline: "2.5.19",
        why: `${where} branches on whether the user is App Review (${gate}). Showing reviewers a different app is concealment under 2.5.19 and DPLA 3.2(e). ${does}`.trim(),
        fix: REMOVE_REVIEWER_CHECK,
        confidence: "high",
        suppressible: false,
      };
    case "review-state": {
      const web = sinks.kinds.includes("websurface");
      if (!sensitive && !web) return undefined;
      const swapped = describeSinks(sinks, [...SENSITIVE_SINKS, "websurface"]);
      return {
        rule: "review_gating.review_state",
        severity: "high",
        guideline: "2.5.19",
        why: `${where} branches on a review-mode flag (${gate}) around ${sensitive ? "sensitive behavior" : "an embedded web surface, whose content the server can change after approval"}. The gated code touches ${swapped}. If this flag tracks App Store review status, reviewers see a different app (2.5.19, DPLA 3.2(e)).`,
        fix: "Remove the branch on review status so App Review gets exactly what users get; disclosure does not cure branching on review status (2.5.19). If the flag means something unrelated to App Review, confirm that and record why in the baseline.",
        confidence: "medium",
        suppressible: true,
      };
    }
    case "demo-account":
      if (sensitive)
        return {
          rule: "review_gating.demo_account",
          severity: "block",
          guideline: "2.5.19",
          why: `${where} changes sensitive behavior for the demo/test account App Review signs in with (${gate}). ${does} The reviewer then evaluates a different app from the one users get (2.5.19, 2.1(a)).`,
          fix: "Remove the demo-account branch so the reviewer's account behaves like any user's. A built-in demo mode needs Apple's prior approval (2.1(a)); describe any demo-account differences specifically in Notes for Review.",
          confidence: "high",
          suppressible: false,
        };
      return {
        rule: "review_gating.demo_account",
        severity: "medium",
        guideline: "2.1(a)",
        why: `${where} branches on a demo/test account (${gate}). A built-in demo mode needs Apple's prior approval (2.1(a)); verify the reviewer's account sees the same app users do.`,
        fix: "Remove the demo-account branch, or disclose exactly what differs for the demo account in Notes for Review.",
        confidence: "medium",
        suppressible: true,
      };
    case "environment": {
      const base = runtimeEnv
        ? `${where} checks the install environment (${gate}). App Review installs carry a sandbox receipt, like TestFlight, so this branch runs during review.`
        : `${where} branches on an install-environment flag (${gate}). If the flag is detected at runtime from the receipt or install source, App Review installs (which carry a sandbox receipt, like TestFlight) take this branch.`;
      if (sensitive)
        return {
          rule: "review_gating.environment",
          severity: "block",
          guideline: "2.5.19",
          why: `${base} ${does} Reviewers therefore see different content, generation or pricing than App Store users (2.5.19, DPLA 3.2(e)).`,
          // Disclosure can justify a tester price difference, never showing reviewers other content.
          fix: content
            ? "Remove the environment check so App Review and App Store users get the same app; disclosure in Notes for Review does not cure showing reviewers different content (2.5.19, DPLA 3.2(e))."
            : "Remove the environment check from this code path so review and production builds behave the same. If a difference is intentional, disclose it specifically in Notes for Review (2.3.1(a)).",
          confidence: content ? "high" : "medium",
          // Showing reviewers different content has no legitimate justification; price-only
          // differences (e.g. TestFlight testers unlocked) can be justified in the baseline.
          suppressible: !content,
        };
      if (sinks.kinds.includes("debug"))
        return {
          rule: "review_gating.environment_debug",
          severity: "medium",
          guideline: "2.5.19",
          why: `${base} The gated code looks like debug UI ("${sinks.words.debug}"), which the reviewer will also see.`,
          fix: "Verify nothing user-facing differs during review. Remove the debug UI from release builds (#if DEBUG / __DEV__) or disclose it in Notes for Review.",
          confidence: "medium",
          suppressible: true,
        };
      if (sinks.kinds.includes("websurface"))
        return {
          rule: "review_gating.environment",
          severity: "medium",
          guideline: "2.5.19",
          why: `${base} The gated code shows an embedded web surface ("${sinks.words.websurface}"), whose content the server can change after approval, so reviewers and App Store users may see different screens.`,
          fix: "Remove the environment check so review and App Store installs show the same screens, or disclose specifically in Notes for Review what the web surface shows and to whom (2.3.1(a)).",
          confidence: "medium",
          suppressible: true,
        };
      if (sinks.kinds.includes("backend"))
        return {
          rule: "review_gating.environment_backend",
          severity: "medium",
          guideline: "2.1(a)",
          why: `${base} It selects a backend ("${sinks.words.backend}"), so the reviewer may hit a non-production server (2.1(a) requires a live backend).`,
          fix: "Remove the environment-based backend switch so review builds use the production backend, or disclose the difference in Notes for Review.",
          confidence: "medium",
          suppressible: true,
        };
      const benign = sinks.kinds.some((k) => k === "receipt" || k === "logging");
      if (benign || !sinks.hasCode) return undefined;
      return {
        rule: "review_gating.environment",
        severity: "info",
        guideline: "2.5.19",
        why: `${base} The gated code shows no content, pricing or debug behavior, but it does run during review.`,
        fix: "Confirm the review build behaves like production; disclose any user-visible difference in Notes for Review.",
        confidence: "low",
        suppressible: true,
      };
    }
    case "date":
      if (!sensitive) return undefined;
      return {
        rule: "review_gating.date",
        severity: "block",
        guideline: "2.5.19",
        why: `${where} switches behavior at a fixed date (${gate}). ${does} A time switch lets the app change after review without a new submission (2.5.19 dormant features, DPLA 3.2(e) post-review modifications).`,
        fix: "Remove the time switch, or ship the behavior active from the reviewed build and describe it specifically in Notes for Review (2.3.1(a)).",
        confidence: "medium",
        suppressible: !content,
      };
    case "install-age":
      if (content)
        return {
          rule: "review_gating.install_age",
          severity: "block",
          guideline: "2.5.19",
          why: `${where} enables sensitive behavior only after install age or launch count (${gate}). ${does} A fresh review install never reaches it, so it is a dormant feature under 2.5.19.`,
          fix: "Remove the install-age gate from this behavior, or make it reachable in the review build and describe it specifically in Notes for Review.",
          confidence: "medium",
          suppressible: false,
        };
      // A promotional cadence ("show the promo to returning users") changes no price.
      if (!sensitive || (sinks.kinds.filter((k) => SENSITIVE_SINKS.includes(k)).join() === "price" && PROMO_WORD.test(sinks.words.price ?? ""))) return undefined;
      if (ungatedPurchase)
        return {
          rule: "review_gating.install_age",
          severity: "info",
          guideline: "2.1(b)",
          why: `${where} changes paywall or pricing presentation after install age or launch count (${gate}). ${does} The project also has a purchase path outside this gate, so a fresh review install can still buy.`,
          fix: "Verify App Review can reach a purchase path in a fresh install, and describe the timing in Notes for Review.",
          confidence: "low",
          suppressible: true,
        };
      if (sensitive)
        return {
          rule: "review_gating.install_age",
          severity: "medium",
          guideline: "3.1.2",
          why: `${where} changes paywall or pricing behavior after install age or launch count (${gate}). ${does} The reviewer's fresh install may never see it (2.1(b): purchases must be visible to review).`,
          fix: "Verify App Review can reach this paywall, and describe the timing in Notes for Review.",
          confidence: "medium",
          suppressible: true,
        };
      return undefined;
    case "timezone-pacific":
      if (sensitive)
        return {
          rule: "review_gating.timezone",
          severity: "block",
          guideline: "2.5.19",
          why: `${where} checks for the US Pacific timezone (${gate}), where App Review works, around sensitive behavior. ${does}`,
          fix: REMOVE_REVIEWER_CHECK,
          confidence: "medium",
          suppressible: false,
        };
      return {
        rule: "review_gating.timezone",
        severity: "medium",
        guideline: "2.5.19",
        why: `${where} checks for the US Pacific timezone (${gate}), where App Review works. Verify nothing differs for reviewers.`,
        fix: "Remove the timezone branch, or disclose what differs and why in Notes for Review.",
        confidence: "low",
        suppressible: true,
      };
    case "storefront":
    case "region":
    case "timezone": {
      const label = kind === "storefront" ? "App Store storefront" : kind === "timezone" ? "timezone" : "region";
      const legal = LEGAL_MARKERS.test(wordsOf(gate)) || LEGAL_MARKERS.test(wordsOf(scope)) || LEGAL_MARKERS.test(wordsOf(ctxText));
      // Legal and payment rules follow the storefront or country, never the device clock: a
      // timezone branch that hides a label is display formatting unless the code says why.
      const restricts = kind !== "timezone" && restrictsOnly(gate, scope);
      if ((legal || restricts) && (sinks.hasCode || sensitive))
        return {
          rule: "review_gating.region_legal",
          severity: "info",
          guideline: "2.3.1(a)",
          why: `${where} changes behavior by ${label} (${gate}) for what looks like a legal or payment-rule reason. App Review's guidance asks you to describe regional differences.`,
          fix: "Disclose the regional difference in Notes for Review: which storefronts or regions, what changes, and why.",
          confidence: "medium",
          suppressible: true,
        };
      if (content)
        return {
          rule: "review_gating.region",
          severity: "high",
          guideline: "2.5.19",
          why: `${where} changes sensitive behavior by ${label} (${gate}). ${does} Reviewers may be in a region that never sees it, which makes it an undisclosed feature (2.5.19).`,
          fix: "Remove the regional switch, or disclose specifically in Notes for Review which regions get this behavior and why.",
          confidence: "medium",
          suppressible: true,
        };
      if (sensitive)
        return {
          rule: "review_gating.region_legal",
          severity: "info",
          guideline: "2.3.1(a)",
          why: `${where} changes pricing or paywall behavior by ${label} (${gate}). ${does}`,
          fix: "Disclose the regional pricing or payment difference in Notes for Review.",
          confidence: "medium",
          suppressible: true,
        };
      return undefined;
    }
  }
}

/** True when the project can start a purchase from code other than `gated`. */
const PURCHASE_ANY = [new RegExp(PURCHASE_CALL.source, "g"), new RegExp(MANAGED_PAYWALL.source, "g")];
const purchaseTotals = new WeakMap<ScanContext, number>();
function purchaseCount(t: string): number {
  return PURCHASE_ANY.reduce((n, rx) => n + [...t.matchAll(rx)].length, 0);
}
function purchaseOutside(ctx: ScanContext, gated: string): boolean {
  let total = purchaseTotals.get(ctx);
  if (total === undefined) {
    total = 0;
    for (const f of ctx.files) if (isCodeFile(f)) total += purchaseCount(f.code);
    purchaseTotals.set(ctx, total);
  }
  return total > purchaseCount(gated);
}

export const check: Check = {
  id: "review_gating",
  title: "Behavior that differs during App Review",
  guidelines: ["2.5.19", "DPLA 3.2(e)", "2.1(a)"],
  async run(ctx: ScanContext): Promise<CheckResult> {
    const findings: Finding[] = [];
    const { standalone, sited, buildConfig } = collect(ctx);
    const gates: Record<string, unknown>[] = [];

    // One finding per (rule, severity, symbol): a flag read in many places is one decision.
    const bySymbol = new Map<string, { f: Finding; more: string[] }>();
    const grouped = (v: Verdict, symbol: string | undefined, f: Finding, at: string): boolean => {
      if (!symbol) return false;
      const key = `${v.rule}|${v.severity}|${v.fix}|${symbol}`;
      const cur = bySymbol.get(key);
      if (cur) {
        if (!cur.more.includes(at)) cur.more.push(at);
        return true;
      }
      bySymbol.set(key, { f, more: [] });
      return false;
    };

    for (const hit of standalone) {
      const kind = [...hit.kinds][0]!;
      const where = SERVER_PATH.test(hit.file.path) ? "Server code" : "App code";
      const near = windowAround(hit.file, hit.index, 8);
      const v = verdictFor(kind, classifySinks(near), hit.labels.join(", "), where, near, hit.file.path);
      if (!v) continue;
      gates.push({ kind, file: hit.file.path, line: hit.line, label: hit.labels.join(", ") });
      const f = finding({ ...v, file: hit.file.path, line: hit.line, evidence: hit.evidence });
      if (grouped(v, hit.symbol, f, `${hit.file.path}:${hit.line}`)) continue;
      findings.push(f);
    }

    for (const hit of sited.values()) {
      const site = hit.site!;
      const sinks = classifySinks(expandScope(ctx, hit.file, site.body));
      const where = SERVER_PATH.test(hit.file.path) ? "Server code" : "App code";
      const gate = hit.via ? `${site.header} — via ${hit.via}` : site.header;
      const receiptHandling = isReceiptFile(hit.file);
      const viaFiles = hit.via ? (declCounts(ctx).get(hit.via)?.files ?? []) : [];
      const ctxText = [hit.file.path, ...viaFiles].join(" ");
      const runtimeEnv = hit.labels.some((l) => RECEIPT_LABELS.has(l));
      for (const kind of hit.kinds) {
        if (kind === "environment" && receiptHandling) continue;
        const v = verdictFor(kind, sinks, gate, where, site.body, ctxText, runtimeEnv, kind === "install-age" && purchaseOutside(ctx, site.body));
        gates.push({ kind, file: hit.file.path, line: site.line, header: site.header, via: hit.via, sinks: sinks.kinds, severity: v?.severity ?? null });
        if (!v) continue;
        const f = finding({ ...v, file: hit.file.path, line: site.line, evidence: site.header });
        if (grouped(v, hit.symbol, f, `${hit.file.path}:${site.line}`)) continue;
        findings.push(f);
      }
    }
    for (const { f, more } of bySymbol.values()) {
      if (!more.length) continue;
      f.why += ` The same value also gates ${more.length} other site(s): ${more.slice(0, 6).join(", ")}${more.length > 6 ? ", …" : ""}.`;
    }

    for (const b of buildConfig.values()) {
      findings.push(
        finding({
          rule: "review_gating.build_config",
          severity: "info",
          guideline: "2.5.19",
          file: b.origin.file,
          line: b.origin.line,
          evidence: b.origin.evidence,
          why: `${b.name} is fixed when the app is built (${b.origin.file}:${b.origin.line}), not detected at runtime, so App Review and App Store users run the same value from the same binary. It is read at ${b.uses.length} site(s), e.g. ${b.uses.slice(0, 3).map((u) => `${u.file}:${u.line}`).join(", ")}. It only matters if the configuration you submit enables it.`,
          fix: "Verify the App Store (Release) configuration never sets this flag, and disclose any user-visible behavior it enables in Notes for Review.",
          confidence: "medium",
        }),
      );
      gates.push({ kind: b.kind, file: b.origin.file, line: b.origin.line, label: `build configuration: ${b.name}`, severity: "info" });
    }
    return { findings: dedupeFindings(findings), data: { gates } };
  },
};

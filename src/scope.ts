/**
 * Lexical scope analysis for C-family / Swift / JS / TSX source.
 *
 * Answers "what conditions guard this offset?" well enough to tell a remote-flag- or
 * environment-gated feature from an unconditional one. It is not a parser: it walks
 * braces and parentheses backwards over comment-stripped, string-blanked text. Every
 * result therefore carries `confidence`, and callers must treat it as a lead, not proof.
 */

import { isJsExt, jsQuoteOpens, jsRegexEnd, lineCappedRegexEnd, UnclosedQuotes } from "./project.js";

export type ConditionKind = "if" | "guard" | "ternary" | "and" | "#if" | "switch" | "block";

export type ConditionSignal = "flag" | "environment" | "date" | "region" | "debug" | "identity";

export interface Condition {
  kind: ConditionKind;
  /** header text, e.g. `if remoteConfig["nsfw"].boolValue` */
  text: string;
  /** 1-based line of the header */
  line: number;
  signals: ConditionSignal[];
  /**
   * For ternaries: which arm holds the offset. `else` means the offset runs when the
   * condition is false, which inverts what the condition says about the offset.
   */
  branch?: "then" | "else";
}

export interface ScopeInfo {
  conditions: Condition[];
  /** union of all signals on the path */
  signals: ConditionSignal[];
  confidence: "medium" | "low";
}

const SIGNAL_PATTERNS: Record<ConditionSignal, RegExp> = {
  flag: /\b(remoteConfig|RemoteConfig|configValue|getBoolean|getValue|getString|isFeatureEnabled|featureFlag|feature_flag|featureFlags|flags?\s*[.[]|useFlag|useFeatureFlag|useFeatureFlagEnabled|useGate|checkGate|getFeatureGate|variation|boolVariation|isEnabled|isOn|getFeatureValue|Statsig|LaunchDarkly|ldClient|posthog\.(isFeatureEnabled|getFeatureFlag)|unleash|growthbook|configcat|optimizely|RemoteSettings|serverConfig|remoteFlag|killSwitch|killswitch)\b/,
  environment: /\b(sandboxReceipt|appStoreReceiptURL|isTestFlight|isTestflight|testFlight|TestFlight|AppTransaction|\.environment\s*==|environment\s*==|\.sandbox\b|\.xcode\b|isSandbox|isReviewer|inReview|isInReview|reviewMode|review_mode|isAppReview|underReview|Bundle\.main\.appStoreReceiptURL|embedded\.mobileprovision)\b/,
  date: /\b(Date\(\)|Date\.now|new Date\(|launchDate|releaseDate|installDate|daysSince|daysSinceInstall|firstLaunch|timeIntervalSince(Now|1970|ReferenceDate)?|unlockDate|goLiveDate|approvalDate)\b/,
  region: /\b(Locale\.(current|preferred)|regionCode|countryCode|Storefront|storefront|countryCode|TimeZone\.current|timeZone|ipAddress|geoip|geoIP|clientIP|cf-ipcountry|CF-IPCountry|request\.cf|cupertino|Cupertino)\b/,
  debug: /(#if\s+DEBUG|__DEV__|\bisDebug\b|\bDEBUG\b|process\.env\.NODE_ENV)/,
  identity: /\b(reviewer|demoAccount|demo_account|testAccount|test_account|appleReview|APPLE_REVIEW|isDemoUser|userEmail\s*==|email\s*===?\s*["'])/,
};

export function signalsOf(text: string): ConditionSignal[] {
  return (Object.keys(SIGNAL_PATTERNS) as ConditionSignal[]).filter((s) => SIGNAL_PATTERNS[s].test(text));
}

/** Replaces string-literal contents with spaces (quotes kept) so braces inside strings don't count. */
export function blankStrings(code: string, ext: string): string {
  const js = isJsExt(ext);
  const swift = ext === "swift";
  const out = code.split("");
  let i = 0;
  const n = code.length;
  const unclosed = new UnclosedQuotes();
  const regexEnd = lineCappedRegexEnd();
  let re = -1;
  while (i < n) {
    const c = code[i];
    if (swift && code.startsWith('"""', i)) {
      const end = code.indexOf('"""', i + 3);
      const stop = end === -1 ? n : end;
      for (let k = i + 3; k < stop; k++) if (out[k] !== "\n") out[k] = " ";
      i = stop + 3;
    } else if (js && c === "/" && (re = regexEnd(code, i)) > 0) {
      for (let k = i + 1; k < re; k++) out[k] = " ";
      i = re + 1;
    } else if (((c === '"' && (!js || jsQuoteOpens(code, i))) || (js && ((c === "'" && jsQuoteOpens(code, i)) || c === "`"))) && !unclosed.covers(c, i)) {
      let j = i + 1;
      while (j < n && code[j] !== c) {
        if (code[j] === "\\") { out[j] = " "; j++; if (j < n && out[j] !== "\n") out[j] = " "; j++; continue; }
        if (code[j] === "\n" && c !== "`") break;
        if (out[j] !== "\n") out[j] = " ";
        j++;
      }
      if (j < n && code[j] === c) i = j + 1;
      else if (c === "`") i = n;
      else {
        // A quote that never closes on its line was not a delimiter (an apostrophe in JSX
        // text); blanking to the line end would hide the `}` that closes a `{__DEV__ && …}`.
        for (let k = i + 1; k < Math.min(j, n); k++) out[k] = code[k]!;
        unclosed.record(c, j);
        i++;
      }
    } else {
      i++;
    }
  }
  return out.join("");
}

interface FileIndex {
  code: string;
  ext: string;
  masked: string;
  lineStarts: number[];
  /** preprocessor lines (#if / #else / #elseif / #endif) in order */
  directives: { offset: number; line: number; text: string }[];
  /** innermost unclosed `{` or `(` before each offset (-1 at top level); an opener's own entry is its parent */
  innerAt: Int32Array;
  /** for each `{` or `(`, the offset of its matching closer (-1 if unclosed) */
  closeOf: Int32Array;
  /** newline offsets inside multi-line string literals, which never end a statement */
  stringNewlines: Set<number>;
  /** per-opener conditions, filled lazily by openerCondition */
  openers: Map<number, OpenerCondition | undefined>;
  /** Swift `guard … else {` statements, filled lazily */
  guards?: { offset: number; end: number; cond: Condition }[];
}

/** Newlines inside JS template literals or Swift `"""` strings; `masked` keeps only string delimiters. */
function stringNewlines(masked: string, ext: string): Set<number> {
  const out = new Set<number>();
  const js = ["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext);
  const delim = js ? "`" : ext === "swift" ? '"""' : "";
  if (!delim) return out;
  let inside = false;
  for (let k = 0; k < masked.length; k++) {
    if (masked.startsWith(delim, k)) {
      inside = !inside;
      k += delim.length - 1;
    } else if (inside && masked.charCodeAt(k) === 10) out.add(k);
  }
  return out;
}

function bracketTables(masked: string): { innerAt: Int32Array; closeOf: Int32Array } {
  const n = masked.length;
  const innerAt = new Int32Array(n + 1);
  const closeOf = new Int32Array(n).fill(-1);
  const stack: number[] = [];
  for (let k = 0; k < n; k++) {
    innerAt[k] = stack.length ? stack[stack.length - 1]! : -1;
    const ch = masked.charCodeAt(k);
    if (ch === 123 || ch === 40) stack.push(k);
    else if (ch === 125 || ch === 41) {
      // Pop to the matching kind; a stray closer (e.g. inside a regex literal) is ignored.
      const want = ch === 125 ? 123 : 40;
      let j = stack.length - 1;
      while (j >= 0 && masked.charCodeAt(stack[j]!) !== want) j--;
      if (j >= 0) {
        closeOf[stack[j]!] = k;
        stack.length = j;
      }
    }
  }
  innerAt[n] = stack.length ? stack[stack.length - 1]! : -1;
  return { innerAt, closeOf };
}

// Scanners ask about many offsets in the same file; masking and line indexing once per
// file keeps that linear instead of O(hits × file size).
const INDEX_CACHE: FileIndex[] = [];
const INDEX_CACHE_SIZE = 4;

function fileIndex(code: string, ext: string): FileIndex {
  for (let i = 0; i < INDEX_CACHE.length; i++) {
    const e = INDEX_CACHE[i]!;
    if (e.ext === ext && e.code.length === code.length && e.code === code) {
      if (i > 0) {
        INDEX_CACHE.splice(i, 1);
        INDEX_CACHE.unshift(e);
      }
      return e;
    }
  }
  const lineStarts = [0];
  for (let k = 0; k < code.length; k++) if (code.charCodeAt(k) === 10) lineStarts.push(k + 1);
  const masked = blankStrings(code, ext);
  const directives: FileIndex["directives"] = [];
  // Matched on the masked text: a `#if DEBUG` line inside a Swift `"""` string or a JS template
  // is string content, and pushing it would mark the rest of the file debug-only.
  for (const m of masked.matchAll(/^[ \t]*(#(?:if|else|elseif|endif)\b[^\n]*)/gm)) {
    const offset = m.index ?? 0;
    const start = offset + m[0].length - m[1]!.length;
    directives.push({ offset, line: lineFromStarts(lineStarts, offset), text: code.slice(start, offset + m[0].length).trim() });
  }
  const e: FileIndex = { code, ext, masked, lineStarts, directives, ...bracketTables(masked), stringNewlines: stringNewlines(masked, ext), openers: new Map() };
  INDEX_CACHE.unshift(e);
  if (INDEX_CACHE.length > INDEX_CACHE_SIZE) INDEX_CACHE.pop();
  return e;
}

function lineFromStarts(starts: number[], index: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Index of the first top-level ternary `?` in `t` (not `?.`, `??` or an optional type), or -1. */
function ternaryAt(t: string): number {
  let depth = 0;
  for (let k = 0; k < t.length; k++) {
    const ch = t[k]!;
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    else if (ch === "?" && depth === 0) {
      const nx = t[k + 1] ?? "";
      const pv = t[k - 1] ?? "";
      if (nx === "?" || nx === "." || pv === "?") { k++; continue; }
      if (/\s/.test(pv) || pv === ")" || /\s/.test(nx)) return k;
    }
  }
  return -1;
}

/** Which ternary arm the end of `t` (text from the condition up to the offset) lies in. */
function branchOf(t: string): "then" | "else" | undefined {
  const q = ternaryAt(t);
  if (q < 0) return undefined;
  let depth = 0;
  let nested = 0;
  for (let k = q + 1; k < t.length; k++) {
    const ch = t[k]!;
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0 && ch === "?" && t[k + 1] !== "?" && t[k + 1] !== "." && t[k - 1] !== "?") nested++;
    else if (depth === 0 && ch === ":" && t[k + 1] !== ":" && t[k - 1] !== ":") {
      if (nested > 0) nested--;
      else return "else";
    }
  }
  return "then";
}

/**
 * A line ending in a binary operator continues on the next line. Tokens that can also end a
 * finished statement do not count: postfix `x++` / `x--`, a TypeScript non-null `x!`, a closing
 * `>` (`/>`, `Array<T>`) other than an arrow head, an optional type (`String?`) and the closing
 * `/` of a regex literal.
 * Joining after those would put `if (__DEV__) n++` in charge of the statement below it.
 */
const CONTINUE_PREV = /(?:[&|:=(,.*<\[]|(?<![\w$)\]>])\?|(?<!\+)\+|(?<!-)-|=>|(?:^|[\s(\[,=&|?:!])!|\/)$/;

function continuesPrev(prev: string, ext: string): boolean {
  if (!CONTINUE_PREV.test(prev)) return false;
  if (!prev.endsWith("/") || !isJsExt(ext)) return true;
  // String and regex contents are blanked, so the opening `/` is the previous slash on the line.
  const ls = prev.lastIndexOf("\n") + 1;
  const open = prev.lastIndexOf("/", prev.length - 2);
  return !(open >= ls && jsRegexEnd(prev, open) === prev.length - 1);
}
const CONTINUE_NEXT = /^(&&|\|\||\?(?![?.])|:|\.(?!\.)|==|!=|\+|-(?!-)|\*|\/(?![/*])|else\b|where\b|catch\b|finally\b)/;

/**
 * True when the line ending at newline `nl` is an unfinished `if (…)`, `while (…)`,
 * `for (…)` or `else` whose body starts on the next line.
 */
function bareHeaderLine(fi: FileIndex, nl: number): boolean {
  const masked = fi.masked;
  const ls = masked.lastIndexOf("\n", nl - 1) + 1;
  const line = masked.slice(ls, nl);
  const t = line.trim();
  if (/(^|[\s}])else$/.test(t)) return true;
  const m = /^(\}\s*)?(else\s+)?(if|while|for)\s*\(/.exec(t);
  if (!m) return false;
  const open = ls + (line.length - line.trimStart().length) + m[0].length - 1;
  const last = ls + line.trimEnd().length - 1;
  return fi.closeOf[open] === last;
}

/**
 * Text of the statement header that precedes `open` (an index of `{` or `(`, or any offset),
 * back to the previous statement boundary. A newline ends the walk when the previous line
 * is a complete statement, so in semicolon-less JS a one-line `if (__DEV__) log(…)` is not
 * read as the header of the statement after it.
 */
function headerBefore(fi: FileIndex, open: number): { text: string; start: number } {
  const { code, masked } = fi;
  let k = open - 1;
  let depth = 0;
  const floor = Math.max(0, open - 400);
  // A `{` alone at the start of a line belongs to the header on the line above (Allman style).
  const braceOpener = masked[open] === "{";
  while (k >= floor) {
    const ch = masked[k];
    if (ch === ")" || ch === "]") depth++;
    else if (ch === "(" || ch === "[") {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && (ch === ";" || ch === "{" || ch === "}")) break;
    else if (depth === 0 && ch === "\n" && !fi.stringNewlines.has(k)) {
      const next = masked.slice(k + 1, open).trimStart();
      const prev = masked.slice(Math.max(floor, k - 200), k).trimEnd();
      const joined = continuesPrev(prev, fi.ext) || CONTINUE_NEXT.test(next) || (braceOpener && next === "") || bareHeaderLine(fi, k);
      // A preprocessor line is never part of a statement.
      if (!joined || /^[ \t]*#/.test(masked.slice(masked.lastIndexOf("\n", k - 1) + 1, k))) break;
    }
    k--;
  }
  let start = k + 1;
  // In `if (c) a()⏎else b()` the offset sits in the else arm, which the `if` condition does not guard.
  // A Swift `guard c else {` body is still governed by c, so it keeps its header.
  const span = masked.slice(start, open);
  const elses = /\bguard\b/.test(span) ? [] : [...span.matchAll(/\belse\b/g)];
  const last = elses[elses.length - 1];
  if (last) start += (last.index ?? 0) + 4;
  return { text: code.slice(start, open).replace(/\s+/g, " ").trim(), start };
}

function kindOf(header: string, opener: "{" | "("): ConditionKind | null {
  if (/^(}\s*)?else\s+if\b|^if\b|^\}?\s*if\b/.test(header) || /\bif\b[^{]*$/.test(header)) return "if";
  if (/^guard\b/.test(header)) return "guard";
  if (/\bswitch\b|\bcase\b/.test(header)) return "switch";
  if (/\?\s*$/.test(header) || /:\s*$/.test(header)) return "ternary";
  if (/&&\s*$/.test(header)) return "and";
  return opener === "{" ? "block" : null;
}

/**
 * Conditions enclosing `index` in comment-stripped `code`. Condition objects are shared
 * between lookups in the same file and must not be mutated. Pass the file extension so
 * string literals are masked correctly.
 */
export function enclosingConditions(code: string, index: number, ext: string): ScopeInfo {
  const fi = fileIndex(code, ext);
  const masked = fi.masked;
  const lineAt = (_t: string, i: number) => lineFromStarts(fi.lineStarts, i);
  const conditions: Condition[] = [];

  // Inline guard on the same statement: `flag && <View/>`, `cond ? a : b`, `if cond { x }` on one line.
  const stmt = headerBefore(fi, index);
  if (stmt.text && /(&&|\|\||\?|\bif\b|\bguard\b)/.test(stmt.text)) {
    const s = signalsOf(stmt.text);
    if (s.length) {
      const kind: ConditionKind = /\bif\b/.test(stmt.text) ? "if" : /\?/.test(stmt.text) ? "ternary" : "and";
      conditions.push({ kind, text: stmt.text, line: lineAt(code, stmt.start), signals: s, branch: branchOf(stmt.text) });
    }
  }

  // Walk the chain of enclosing openers, innermost first. Each opener's header is computed
  // once per file, and the walk stops after MAX_OPENERS levels: in malformed code with
  // unclosed brackets every later offset sits inside every earlier opener, and walking the
  // whole chain for each lookup is quadratic in file size.
  let levels = 0;
  for (let k = fi.innerAt[Math.min(index, code.length)]!; k >= 0 && levels < MAX_OPENERS; k = fi.innerAt[k]!, levels++) {
    const o = openerCondition(fi, k);
    if (!o) continue;
    if (o.jsx && o.jsx.from <= index) {
      const branch = o.jsx.cond.kind === "ternary" ? branchOf(masked.slice(k + 1, index)) : undefined;
      conditions.push({ ...o.jsx.cond, branch });
    } else if (o.cond) conditions.push(o.cond);
  }

  // Swift guard statements earlier in the same scope.
  if (ext === "swift") {
    const scopeStart = enclosingBlockStart(fi, index);
    // Guards are found once per file; slicing the scope for each lookup is quadratic when an
    // unclosed brace makes the whole file one scope.
    fi.guards ??= [...code.matchAll(/\bguard\b([^{]{0,400}?)\belse\s*\{/g)].map((m) => {
      const text = `guard${m[1]}`.replace(/\s+/g, " ").trim();
      return { offset: m.index ?? 0, end: (m.index ?? 0) + m[0].length, cond: { kind: "guard" as const, text, line: lineAt(code, m.index ?? 0), signals: signalsOf(text) } };
    });
    let lo = 0;
    let hi = fi.guards.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (fi.guards[mid]!.offset < scopeStart) lo = mid + 1;
      else hi = mid;
    }
    for (let g = lo, n = 0; g < fi.guards.length && fi.guards[g]!.end <= index && n < MAX_OPENERS; g++, n++) conditions.push(fi.guards[g]!.cond);
  }

  // Compile-time conditions (#if … #endif).
  const stack: { text: string; line: number }[] = [];
  for (const d of fi.directives) {
    if (d.offset >= index) break;
    const t = d.text;
    if (/^#if\b/.test(t)) stack.push({ text: t, line: d.line });
    else if (/^#endif\b/.test(t)) stack.pop();
    else if (/^#else\b|^#elseif\b/.test(t) && stack.length) stack[stack.length - 1] = { text: `${t} (of ${stack[stack.length - 1]!.text})`, line: d.line };
  }
  for (const s of stack) conditions.push({ kind: "#if", text: s.text, line: s.line, signals: signalsOf(s.text) });

  const signals = [...new Set(conditions.flatMap((c) => c.signals))];
  return { conditions, signals, confidence: conditions.length ? "medium" : "low" };
}

const MAX_OPENERS = 128;

interface OpenerCondition {
  /** the condition the opener's header puts on everything inside it */
  cond?: Condition;
  /** a JSX container `{flag && …}`: its condition applies from offset `from` on */
  jsx?: { from: number; cond: Condition };
}

/** The index-independent condition an opener (`(` or `{` at `k`) contributes, cached per file. */
function openerCondition(fi: FileIndex, k: number): OpenerCondition | undefined {
  if (fi.openers.has(k)) return fi.openers.get(k);
  const { code, masked, ext } = fi;
  const lineAt = (i: number) => lineFromStarts(fi.lineStarts, i);
  let out: OpenerCondition | undefined;
  const ch = masked[k];
  if (ch === "(") {
    const h = headerBefore(fi, k);
    const kind = kindOf(h.text, "(");
    if (kind && kind !== "block") {
      out = { cond: { kind, text: h.text, line: lineAt(h.start), signals: signalsOf(h.text), branch: kind === "ternary" ? branchOf(`${h.text} (`) : undefined } };
    }
  } else if (ch === "{") {
    const h = headerBefore(fi, k);
    const kind = kindOf(h.text, "{") ?? "block";
    out = {};
    // A JSX expression container `{flag && (` puts its condition *after* the brace.
    const after = code.slice(k + 1, Math.min(code.length, k + 200));
    const jsx = kind === "block" && isJsxContainer(fi, k, h.text, ext) ? /^\s*([^{};]*?)(&&|(?<!\?)\?(?![?.]))/.exec(after) : null;
    if (jsx && jsx[1]) {
      const text = jsx[1].trim() + ` ${jsx[2]}`;
      out.jsx = { from: k + 1 + jsx[0].length, cond: { kind: jsx[2] === "&&" ? "and" : "ternary", text, line: lineAt(k), signals: signalsOf(text) } };
    }
    if (kind !== "block" || signalsOf(h.text).length) {
      const branch = kind === "ternary" || ternaryAt(h.text) >= 0 ? branchOf(`${h.text} {`) : undefined;
      out.cond = { kind, text: h.text, line: lineAt(h.start), signals: signalsOf(h.text), branch };
    }
    if (!out.jsx && !out.cond) out = undefined;
  }
  fi.openers.set(k, out);
  return out;
}

/**
 * True if the `{` at `k` opens a JSX expression container rather than a function, class or
 * statement block. Only then can a leading `x &&` / `x ?` inside it be a condition on the rest:
 * in a function body it is just the first statement (`const v = __DEV__ && x`).
 */
function isJsxContainer(fi: FileIndex, k: number, header: string, ext: string): boolean {
  if (!/^[cm]?[jt]sx?$/.test(ext)) return false;
  const { masked } = fi;
  let j = k - 1;
  while (j >= 0 && /\s/.test(masked[j]!)) j--;
  const prev = masked[j];
  if (prev === "}") return true;
  if (prev === ">") {
    // `=> {` is an arrow body; `): Promise<T> {`, `class A extends B<T> {` are declarations.
    if (masked[j - 1] === "=") return false;
    return !/\)\s*:|\b(function|class|interface|extends|implements|type)\b/.test(header);
  }
  if (prev === "=") {
    // `attr={…}`: an attribute name glued to `=`, inside an open tag.
    const before = masked.slice(Math.max(0, j - 400), j);
    if (!/(?:^|\s)[A-Za-z_$][\w$.:-]*$/.test(before)) return false;
    const lt = before.search(/<[A-Za-z][^<]*$/);
    if (lt < 0) return false;
    return !/[^=]>/.test(before.slice(lt));
  }
  return false;
}

function enclosingBlockStart(fi: FileIndex, index: number): number {
  let levels = 0;
  for (let k = fi.innerAt[Math.min(index, fi.code.length)]!; k >= 0; k = fi.innerAt[k]!) {
    // Past MAX_OPENERS unclosed brackets the code is malformed; the narrower scope is the safe guess.
    if (fi.masked[k] === "{" || ++levels >= MAX_OPENERS) return k + 1;
  }
  return 0;
}

/** The innermost `{ … }` around `index` (offsets of both braces), using the per-file bracket index. */
export function enclosingBraces(code: string, ext: string, index: number): { open: number; close: number } | undefined {
  const fi = fileIndex(code, ext);
  for (let k = fi.innerAt[Math.min(index, code.length)]!; k >= 0; k = fi.innerAt[k]!) {
    if (fi.masked[k] === "{") return { open: k, close: fi.closeOf[k]! >= 0 ? fi.closeOf[k]! : code.length - 1 };
  }
  return undefined;
}

/** True if any enclosing condition reads a runtime signal (flag, environment, date, region, identity). */
export function isRuntimeGated(scope: ScopeInfo): boolean {
  return scope.signals.some((s) => s !== "debug");
}

/** True if the offset only ships in debug builds. */
export function isDebugOnly(scope: ScopeInfo): boolean {
  return scope.conditions.some((c) => c.kind === "#if" && debugOnlyDirective(c.text)) || scope.conditions.some(requiresDev);
}

/**
 * `#if DEBUG` and `#if DEBUG && X` compile only into debug builds, and
 * `#if targetEnvironment(simulator)` only into simulator builds, which App Store builds
 * never are. `#if DEBUG || X`, `#if !DEBUG` and the `#else` arm also compile into release
 * builds when X is set. Project-defined flags (TESTING, UITESTING) are not trusted: any
 * configuration, release included, can set them.
 */
function debugOnlyDirective(text: string): boolean {
  const m = /^#if\s+(.+)$/.exec(text.trim());
  if (!m || /#else/.test(text)) return false;
  const cond = m[1]!.replace(/\/\/.*$/, "").trim();
  // A negated group can turn a non-shipping term inside it into a shipping one.
  if (/!\s*\(/.test(cond)) return false;
  const nonShipping = (term: string) => {
    const t = term.replace(/[()\s]/g, "");
    return t === "DEBUG" || t === "targetEnvironmentsimulator";
  };
  return cond.split("||").every((alt) => alt.split("&&").some(nonShipping));
}

/**
 * True when the offset runs only while `__DEV__` is true. The condition is evaluated as
 * a boolean expression with `__DEV__` = false (a release build) and every other operand
 * unknown, so any spelling of a negation (`!__DEV__`, `!(__DEV__)`, `false === __DEV__`,
 * `__DEV__ || x`, the false arm of `__DEV__ ? a : b`) reads as shipping. Anything the
 * evaluator cannot decide also reads as shipping, because a wrong debug-only verdict
 * downgrades a block finding.
 */
function requiresDev(c: Condition): boolean {
  if (c.kind === "#if" || !/__DEV__/.test(c.text)) return false;
  // Opener conditions are shared across lookups in a file, so the verdict is too.
  let v = DEV_VERDICTS.get(c);
  if (v === undefined) DEV_VERDICTS.set(c, (v = devOnlyGuard(c.text, c.branch, 0)));
  return v;
}

const DEV_VERDICTS = new WeakMap<Condition, boolean>();

/** True when the code at the end of `text` (a header up to the offset) cannot run with `__DEV__` false. */
function devOnlyGuard(text: string, branch: "then" | "else" | undefined, depth: number): boolean {
  if (depth > 8 || !/__DEV__/.test(text)) return false;
  const lead = /^\s*(?:\}\s*)?(?:else\s+)?(?:if|while)\s*\(/.exec(text);
  if (lead) {
    const open = lead[0].length - 1;
    const close = matchingClose(text, open);
    if (close < 0) return releaseValue(text.slice(open + 1)) === false;
    if (releaseValue(text.slice(open + 1, close)) === false) return true;
    return devOnlyGuard(text.slice(close + 1), undefined, depth + 1);
  }
  const q = ternaryAt(text);
  if (q >= 0) {
    const arm = branch ?? branchOf(text);
    const cond = releaseValue(stripPrefix(text.slice(0, q)));
    if (cond === (arm === "else")) return true;
    const colon = arm === "else" ? elseColon(text, q) : -1;
    const rest = arm === "else" ? (colon >= 0 ? text.slice(colon + 1) : "") : text.slice(q + 1);
    return devOnlyGuard(rest, undefined, depth + 1);
  }
  // `a && <offset>` runs only when a is truthy; `a || <offset>` only when a is falsy.
  const expr = stripPrefix(text);
  const op = lastLogicalOp(expr);
  if (!op || op.op === "??") return false;
  const left = releaseValue(expr.slice(0, op.at));
  return op.op === "&&" ? left === false : left === true;
}

/** Index of the `:` that ends the then-arm of the ternary whose `?` is at `q`, or -1. */
function elseColon(t: string, q: number): number {
  let depth = 0;
  let nested = 0;
  for (let k = q + 1; k < t.length; k++) {
    const ch = t[k]!;
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0 && ch === "?" && t[k + 1] !== "?" && t[k + 1] !== "." && t[k - 1] !== "?") nested++;
    else if (depth === 0 && ch === ":" && t[k + 1] !== ":" && t[k - 1] !== ":") {
      if (nested > 0) nested--;
      else return k;
    }
  }
  return -1;
}

/** Index past a string literal starting at `k`, or the text end when it is unterminated. */
function skipString(t: string, k: number): number {
  const quote = t[k];
  for (let j = k + 1; j < t.length; j++) {
    if (t[j] === "\\") j++;
    else if (t[j] === quote) return j + 1;
  }
  return t.length;
}

function matchingClose(t: string, open: number): number {
  let depth = 0;
  for (let k = open; k < t.length; k++) {
    const ch = t[k]!;
    if (ch === "'" || ch === '"' || ch === "`") { k = skipString(t, k) - 1; continue; }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") if (--depth === 0) return k;
  }
  return -1;
}

/**
 * The expression that ends `t`: everything after the last top-level assignment, arrow,
 * comma, colon, statement end or unclosed bracket, minus a leading `return`-style keyword.
 */
function stripPrefix(t: string): string {
  let cut = 0;
  const opens: number[] = [];
  for (let k = 0; k < t.length; k++) {
    const ch = t[k]!;
    if (ch === "'" || ch === '"' || ch === "`") { k = skipString(t, k) - 1; continue; }
    if (ch === "(" || ch === "[" || ch === "{") { opens.push(k); continue; }
    if (ch === ")" || ch === "]" || ch === "}") { if (opens.pop() === undefined) cut = k + 1; continue; }
    if (opens.length) continue;
    if (ch === "," || ch === ";") cut = k + 1;
    else if (ch === ":" && t[k + 1] !== ":" && t[k - 1] !== ":") cut = k + 1;
    else if (ch === "=") {
      const pv = t[k - 1] ?? "";
      const nx = t[k + 1] ?? "";
      if (nx === ">") { cut = k + 2; k++; }
      else if (nx === "=") { while (t[k + 1] === "=") k++; }
      else if (!"=!<>".includes(pv)) cut = k + 1;
    }
  }
  const last = opens[opens.length - 1];
  if (last !== undefined && last + 1 > cut) cut = last + 1;
  return t.slice(cut).replace(/^\s*(?:return|yield\*?|throw|case|else|do|export\s+default)\b/, "").trim();
}

/** The last top-level `&&`, `||` or `??` in `t`. */
function lastLogicalOp(t: string): { op: "&&" | "||" | "??"; at: number } | undefined {
  let found: { op: "&&" | "||" | "??"; at: number } | undefined;
  let depth = 0;
  for (let k = 0; k < t.length; k++) {
    const ch = t[k]!;
    if (ch === "'" || ch === '"' || ch === "`") { k = skipString(t, k) - 1; continue; }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      const two = t.slice(k, k + 2);
      if (two === "&&" || two === "||" || two === "??") {
        if (t[k + 2] === "=") { k += 2; continue; }
        found = { op: two, at: k };
        k++;
      }
    }
  }
  return found;
}

type Tri = boolean | undefined;
type Tok = { t: "atom"; v: string } | { t: "op"; v: string };

/**
 * Truthiness of a JS condition in a release build (`__DEV__` = false), or undefined when
 * it depends on anything else or cannot be parsed.
 */
export function releaseValue(expr: string): Tri {
  const toks = tokenize(expr);
  if (!toks) return undefined;
  let i = 0;
  const peek = (): Tok | undefined => toks[i];
  const isOp = (v: string) => peek()?.t === "op" && peek()!.v === v;
  const fail = Symbol("fail");
  const parseTernary = (): Tri => {
    const c = parseOr();
    if (!isOp("?")) return c;
    i++;
    const a = parseTernary();
    if (!isOp(":")) throw fail;
    i++;
    const b = parseTernary();
    if (c === true) return a;
    if (c === false) return b;
    return a === b ? a : undefined;
  };
  const parseOr = (): Tri => {
    let a = parseAnd();
    while (isOp("||") || isOp("??")) {
      const op = toks[i++]!.v;
      const b = parseAnd();
      if (op === "??") a = typeof a === "boolean" ? a : undefined;
      else a = a === true || b === true ? true : a === false ? b : undefined;
    }
    return a;
  };
  const parseAnd = (): Tri => {
    let a = parseEq();
    while (isOp("&&")) {
      i++;
      const b = parseEq();
      a = a === false || b === false ? false : a === true ? b : undefined;
    }
    return a;
  };
  const parseEq = (): Tri => {
    let a = parseUnary();
    while (isOp("==") || isOp("===") || isOp("!=") || isOp("!==")) {
      const op = toks[i++]!.v;
      const b = parseUnary();
      if (typeof a !== "boolean" || typeof b !== "boolean") a = undefined;
      else a = op.startsWith("!") ? a !== b : a === b;
    }
    return a;
  };
  const parseUnary = (): Tri => {
    if (isOp("!")) {
      i++;
      const v = parseUnary();
      return v === undefined ? undefined : !v;
    }
    const tok = toks[i++];
    if (!tok) throw fail;
    if (tok.t === "op") {
      if (tok.v !== "(") throw fail;
      const v = parseTernary();
      if (!isOp(")")) throw fail;
      i++;
      return v;
    }
    if (tok.v === "__DEV__" || tok.v === "false") return false;
    if (tok.v === "true") return true;
    return undefined;
  };
  try {
    const v = parseTernary();
    return i === toks.length ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Splits a condition into logical operators and atoms. Anything that binds tighter than
 * `==` (calls, members, arithmetic, relational operators, literals) is one opaque atom.
 */
function tokenize(s: string): Tok[] | undefined {
  const toks: Tok[] = [];
  let atom = "";
  const flush = () => {
    const v = atom.trim();
    if (v) toks.push({ t: "atom", v });
    atom = "";
  };
  for (let k = 0; k < s.length; k++) {
    const ch = s[k]!;
    const three = s.slice(k, k + 3);
    const two = s.slice(k, k + 2);
    if (/\s/.test(ch)) { atom += ch; continue; }
    if (ch === "'" || ch === '"' || ch === "`") { const e = skipString(s, k); atom += s.slice(k, e); k = e - 1; continue; }
    if (ch === "(" || ch === "[" || ch === "{") {
      // A bracket glued to an atom is a call, index or literal and belongs to it.
      if (atom.trim() || ch !== "(") {
        const close = matchingClose(s, k);
        if (close < 0) return undefined;
        atom += s.slice(k, close + 1);
        k = close;
        continue;
      }
      toks.push({ t: "op", v: "(" });
      continue;
    }
    if (ch === ")") { flush(); toks.push({ t: "op", v: ")" }); continue; }
    if (three === "===" || three === "!==") { flush(); toks.push({ t: "op", v: three }); k += 2; continue; }
    if (two === "=>") return undefined;
    if (two === "==" || two === "!=" || two === "&&" || two === "||" || two === "??") { flush(); toks.push({ t: "op", v: two }); k++; continue; }
    if (ch === "!") {
      // A `!` after an operand is TypeScript's non-null assertion, not a negation.
      if (atom.trim()) { atom += ch; continue; }
      toks.push({ t: "op", v: "!" });
      continue;
    }
    if (ch === "?") {
      if (s[k + 1] === "." && !/\d/.test(s[k + 2] ?? "")) { atom += "?."; k++; continue; }
      flush();
      toks.push({ t: "op", v: "?" });
      continue;
    }
    if (ch === ":") { flush(); toks.push({ t: "op", v: ":" }); continue; }
    atom += ch;
  }
  flush();
  // Two operands in a row (`(a) b`) is not an expression this evaluator understands.
  for (let k = 1; k < toks.length; k++) {
    const a = toks[k - 1]!;
    const b = toks[k]!;
    if ((a.t === "atom" || a.v === ")") && (b.t === "atom" || b.v === "(")) return undefined;
  }
  return toks;
}

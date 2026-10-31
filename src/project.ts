import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export type Platform = "swift" | "react-native" | "expo";

export interface SourceFile {
  /** repo-relative POSIX path */
  path: string;
  abs: string;
  /** lowercase, without dot: "swift", "tsx", "plist", "xcprivacy" … */
  ext: string;
  text: string;
  /** text with comments blanked out (same length, newlines kept) for code files; equals text otherwise */
  code: string;
}

export interface ProjectInfo {
  root: string;
  platforms: Platform[];
  xcodeProjects: string[];
  infoPlists: string[];
  privacyManifests: string[];
  packageJson?: string;
  expoConfig?: string;
  /**
   * Repo-relative directory of a React Native / Expo app below the root (monorepo `apps/expo`);
   * absent when the app is at the root. packageJson and expoConfig already point inside it.
   */
  appRoot?: string;
  /** canonical store metadata dirs found: "metadata", "fastlane/metadata" */
  metadataDirs: string[];
  /**
   * Every app found in the repo, scanned or not: a folder holding an Xcode project, or a React
   * Native / Expo package with app config or a native ios/ folder. A monorepo can hold a
   * shipping app beside a stale one; listing them lets the developer pick with `appPaths`.
   */
  appRoots: AppRootInfo[];
  /** the `appPaths` from .appstore-shield/config.json that limited this scan, when set and valid */
  appPaths?: string[];
  /** problems with .appstore-shield/config.json `appPaths`; invalid entries are ignored, never guessed at */
  configProblems?: string[];
}

export interface AppRootInfo {
  /** repo-relative POSIX folder, "." for the repo root */
  path: string;
  platform: Platform;
}

export interface SkippedFile {
  path: string;
  /** "budget": the walk or load hit MAX_WALK_ENTRIES / MAX_LOADED_FILES / MAX_LOADED_BYTES; path is the first file not read */
  reason: "too-large" | "binary" | "budget" | "unreadable";
  bytes: number;
  /** for "budget": how many more text files were left unread */
  remaining?: number;
  /** the file compiles into the app, is copied into it, or is store metadata; an unread one can hide a finding */
  shipping?: boolean;
}

export interface ScanContext {
  root: string;
  project: ProjectInfo;
  files: SourceFile[];
  /** text files that were not loaded; a scan that never saw a file must say so rather than imply it is clean */
  skipped?: SkippedFile[];
  /** nested git worktrees (other checkouts of this or another repo) that were not walked */
  excludedWorktrees?: string[];
}

export interface LoadOptions {
  /** restrict to these repo-relative paths or directories; when given, config `appPaths` is not applied */
  paths?: string[];
  /** include test sources (excluded by default: they never ship) */
  includeTests?: boolean;
}

export interface Hit {
  file: string;
  line: number;
  /** the full source line, trimmed */
  text: string;
  match: string;
  /** regex capture groups */
  groups: string[];
  index: number;
}

const CODE_EXTS = new Set(["swift", "m", "mm", "h", "ts", "tsx", "js", "jsx", "mjs", "cjs", "kt", "java"]);
const TEXT_EXTS = new Set([
  ...CODE_EXTS,
  "json", "plist", "xcprivacy", "entitlements", "strings", "stringsdict", "xcstrings",
  "yaml", "yml", "toml", "txt", "xml", "html", "md", "pbxproj", "xcconfig", "gradle", "env", "prompt",
]);
const IGNORED_DIRS = new Set([
  "node_modules", "Pods", ".git", "build", "DerivedData", "dist", ".build", ".expo", "Carthage",
  "android", ".gradle", "vendor", ".next", "coverage", "xcuserdata", ".swiftpm", ".appstore-shield",
  ".turbo", ".cache", "SourcePackages", "web-build", ".venv", "venv", "__pycache__", ".yarn", ".pnpm-store",
  ".vercel", ".output", ".idea",
  // Agent and editor worktree folders hold whole extra copies of the repo; scanning them repeats
  // every finding once per copy and can exhaust the file budget before the real app is read.
  ".claude", ".worktrees",
  // Generated server bundles: findings there point at build output nobody edits.
  ".wrangler", ".netlify", ".svelte-kit", ".nuxt", ".parcel-cache", ".angular", ".serverless", ".docusaurus",
]);
/**
 * Sources that never ship. Case-sensitive on purpose: Xcode test targets end in `Tests/`
 * (`AppTests/`, `AppUITests/`), mock and support targets in `TestMocks/` or `TestSupport/`,
 * and scratch targets in `_Test/`, while `contests/`, `Protests/` or an `ABTests/`
 * experiments folder are product code and must be scanned.
 */
const TEST_DIR =
  /(^|\/)(tests?|Tests?|__tests__|__mocks__|__fixtures__|__automation__|e2e|e2e-tests|jest|detox|maestro|test-utils|testing|(?!(?:AB|A_B|Ab|Split|Experiments?)[_-]?Tests?\/)[\w-]*(?:Tests|[_-]Tests?|TestMocks?|TestSupport|TestHelpers?|TestUtils?))\//;
/**
 * Prebuilt binary bundles. Their headers declare a vendor's API, never the app's own calls,
 * so a deprecation string in `llama.xcframework/.../llama.h` is not evidence of app behavior.
 */
const BINARY_BUNDLE_DIR = /\.(xcframework|framework)$/;
/**
 * Build products: archives, debug symbols, test bundles and Xcode's `.noindex` caches, plus a
 * custom `-derivedDataPath`'s `Build/Products`. They hold compiled copies of the app and of its
 * SDKs, so an SDK's privacy manifest inside an archived `.app` would pass for the app's own,
 * and their binary plists count as unread shipping files.
 */
const BUILD_PRODUCT_DIR = /\.(xcarchive|dSYM|xctest|ipa|noindex)$/;
const DERIVED_PRODUCTS = /(^|\/)Build\/Products$/;

/**
 * A built `.app` / `.appex` carries its Info.plist at the top (iOS) or in Contents/ (macOS), or
 * a code signature. A source folder that merely ends in `.app` (a domain name) has neither.
 */
function isBuiltBundle(abs: string, name: string): boolean {
  if (!/\.(app|appex)$/.test(name)) return false;
  return ["Info.plist", "Contents/Info.plist", "_CodeSignature"].some((p) => existsSync(path.join(abs, p)));
}
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(jest|vitest|detox)\.(config|setup)\.[cm]?[jt]s$|(^|\/)\.detoxrc(\.[cm]?[jt]s|\.json)?$/;
const MAX_FILE_BYTES = 1_500_000;
/** String catalogs hold every locale of every string; disclosures live there, so they get a higher cap. */
const MAX_LOCALIZATION_BYTES = 16_000_000;
const LOCALIZATION_EXTS = new Set(["xcstrings", "strings", "stringsdict"]);

export function extOf(p: string): string {
  const base = path.basename(p);
  if (base === "Podfile" || base === "Package.resolved") return "txt";
  if (base === ".env" || base.startsWith(".env.")) return "env";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

export function isTestPath(rel: string): boolean {
  return TEST_DIR.test(rel) || TEST_FILE.test(rel);
}

/**
 * Decodes a text file. Xcode's legacy `.strings` files are often UTF-16; reading them as
 * UTF-8 yields NUL bytes and the file would be dropped as binary. Returns undefined for
 * genuinely binary content.
 */
export function decodeText(buf: Buffer): string | undefined {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf);
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder("utf-16be").decode(buf);
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  let even = 0;
  let odd = 0;
  for (let k = 0; k < sample.length; k++) if (sample[k] === 0) (k % 2 === 0 ? even++ : odd++);
  if (even + odd === 0) return new TextDecoder("utf-8").decode(buf);
  // BOM-less UTF-16: ASCII text puts a NUL in every other byte.
  const half = sample.length / 2;
  if (odd > half * 0.6 && even < half * 0.05) return new TextDecoder("utf-16le").decode(buf);
  if (even > half * 0.6 && odd < half * 0.05) return new TextDecoder("utf-16be").decode(buf);
  return undefined;
}

/**
 * Files that compile or are copied into the app. Xcode builds every file its project
 * references and Metro bundles every file that is imported, whether or not git tracks it,
 * so .gitignore never hides these from the scan.
 */
const SHIPPING_EXTS = new Set([...CODE_EXTS, "plist", "xcprivacy", "entitlements", "strings", "stringsdict", "xcstrings", "pbxproj", "prompt"]);

export interface GitignoreMatcher {
  (rel: string, isDir: boolean): boolean;
}

/**
 * .gitignore subset: globs, `?`, `[...]` classes, leading "/", trailing "/", "**" and "!"
 * negation, where the last matching rule wins, as in git. Whitelist-style files (`/*` then
 * `!/src/`) depend on it.
 *
 * Matching walks segments and characters with the linear-backtrack wildcard algorithm
 * instead of compiling to a RegExp: `.gitignore` is untrusted repo input, and a line of
 * repeated `**` compiles to a regex that backtracks exponentially on every path.
 */
export function compileGitignore(src: string, stepBudget = GITIGNORE_STEP_BUDGET): GitignoreMatcher {
  const lines = src
    .split(/\r?\n/)
    .slice(0, MAX_GITIGNORE_LINES)
    // Capped before trimming: a long whitespace run is quadratic for a backtracking trim.
    .map((l) => (l.length > MAX_GITIGNORE_PATTERN ? "" : trimGitignoreLine(l).trimStart()))
    .filter((l) => l && !l.startsWith("#") && l.length <= MAX_GITIGNORE_PATTERN);
  // The last matching rule wins, so only the last copy of a repeated line can decide anything.
  const last = new Map(lines.map((l, i) => [l, i]));
  const unique = lines.filter((l, i) => last.get(l) === i).slice(0, MAX_GITIGNORE_RULES);
  const rules = unique
    .map((line) => {
      const negate = line.startsWith("!");
      const raw = (negate ? line.slice(1) : line).replace(/^\\([#!])/, "$1");
      const dirOnly = raw.endsWith("/");
      const pat = raw.replace(/\/+$/, "");
      // A pattern with no inner slash matches the name at any depth.
      const anchored = pat.includes("/");
      // Without a slash, `**` is just two ordinary stars.
      const segs: GlobSegment[] = anchored ? [] : ["**", globTokens(pat)];
      if (anchored) for (const part of pat.replace(/^\//, "").split("/")) {
        if (!part) continue;
        if (part === "**") {
          if (segs[segs.length - 1] !== "**") segs.push("**");
        } else segs.push(globTokens(part));
      }
      // `dir/**` matches everything inside dir, not dir itself.
      if (segs[segs.length - 1] === "**") segs.push(globTokens("*"));
      return { negate, dirOnly, segs };
    })
    .filter((r) => r.segs.some((s) => s !== "**" && s.length > 0));
  // Directory names repeat on every path below them, so segment results are worth keeping.
  const memo = new Map<GlobToken[], Map<string, boolean>>();
  let memoSize = 0;
  const budget = { left: stepBudget };
  const seg = (toks: GlobToken[], part: string): boolean => {
    let m = memo.get(toks);
    if (!m) memo.set(toks, (m = new Map()));
    let r = m.get(part);
    if (r === undefined) {
      r = segmentMatch(toks, part, budget);
      if (memoSize++ < 250_000) m.set(part, r);
    }
    return r;
  };
  let exhausted = false;
  return (rel, isDir) => {
    // An adversarial .gitignore must not stall the scan; once its budget is spent it is
    // treated as empty, which scans more files rather than fewer.
    if (exhausted) return false;
    const parts = rel.split("/").filter(Boolean);
    let ignored = false;
    try {
      for (const r of rules) if ((!r.dirOnly || isDir) && wildcardMatch(r.segs, parts, (sg, part) => sg !== "**" && seg(sg, part), (sg) => sg === "**", budget)) ignored = !r.negate;
    } catch (e) {
      if (e !== BUDGET_SPENT) throw e;
      exhausted = true;
      return false;
    }
    return ignored;
  };
}

const MAX_GITIGNORE_LINES = 5000;
const MAX_GITIGNORE_RULES = 1000;
const MAX_GITIGNORE_PATTERN = 255;
/** Wildcard steps one .gitignore may spend across a whole walk; real files use a small fraction. */
const GITIGNORE_STEP_BUDGET = 100_000_000;
const BUDGET_SPENT = Symbol("gitignore budget spent");
const MAX_GITIGNORE_BYTES = 1024 * 1024;

async function readGitignore(file: string): Promise<GitignoreMatcher> {
  try {
    const st = await stat(file);
    if (!st.isFile() || st.size > MAX_GITIGNORE_BYTES) return () => false;
    return compileGitignore(await readFile(file, "utf8"));
  } catch {
    return () => false;
  }
}

/** Git drops trailing spaces unless the last one is escaped with a backslash. */
function trimGitignoreLine(l: string): string {
  const t = l.trimEnd();
  return t.endsWith("\\") && t.length < l.length ? t + l.charAt(t.length) : t;
}

type GlobToken = { t: "star" } | { t: "any" } | { t: "lit"; c: string } | { t: "class"; neg: boolean; ranges: [string, string][] };
type GlobSegment = "**" | GlobToken[];

function globTokens(seg: string): GlobToken[] {
  const out: GlobToken[] = [];
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!;
    if (c === "\\" && i + 1 < seg.length) out.push({ t: "lit", c: seg[++i]! });
    else if (c === "*") {
      if (out[out.length - 1]?.t !== "star") out.push({ t: "star" });
    } else if (c === "?") out.push({ t: "any" });
    else if (c === "[") {
      let j = i + 1;
      const neg = seg[j] === "!" || seg[j] === "^";
      if (neg) j++;
      const ranges: [string, string][] = [];
      let first = true;
      for (; j < seg.length && (first || seg[j] !== "]"); j++, first = false) {
        let lo = seg[j]!;
        if (lo === "\\" && j + 1 < seg.length) lo = seg[++j]!;
        if (seg[j + 1] === "-" && j + 2 < seg.length && seg[j + 2] !== "]") {
          let hi = seg[j + 2]!;
          j += 2;
          if (hi === "\\" && j + 1 < seg.length) hi = seg[++j]!;
          ranges.push([lo, hi]);
        } else ranges.push([lo, lo]);
      }
      if (j >= seg.length) out.push({ t: "lit", c: "[" });
      else {
        out.push({ t: "class", neg, ranges });
        i = j;
      }
    } else out.push({ t: "lit", c });
  }
  return out;
}

function tokenMatches(tok: GlobToken, ch: string): boolean {
  return tok.t === "any" || (tok.t === "lit" && tok.c === ch) || (tok.t === "class" && tok.ranges.some(([lo, hi]) => ch >= lo && ch <= hi) !== tok.neg);
}

/** wildcardMatch specialised to one path segment; it runs once per rule per path segment, so it avoids per-call allocation. */
function segmentMatch(toks: GlobToken[], seg: string, budget?: { left: number }): boolean {
  // Code points, so `?` matches one emoji; plain names skip the copy.
  const s: ArrayLike<string> = /[\uD800-\uDFFF]/.test(seg) ? [...seg] : seg;
  let pi = 0;
  let si = 0;
  let starP = -1;
  let starS = 0;
  while (si < s.length) {
    if (budget && --budget.left < 0) throw BUDGET_SPENT;
    const tok = toks[pi];
    if (tok?.t === "star") {
      starP = pi++;
      starS = si;
    } else if (tok && tokenMatches(tok, s[si]!)) {
      pi++;
      si++;
    } else if (starP >= 0) {
      pi = starP + 1;
      si = ++starS;
    } else return false;
  }
  while (toks[pi]?.t === "star") pi++;
  return pi === toks.length;
}

/**
 * Greedy wildcard match that only ever retries the most recent star, so it runs in
 * O(pattern × input) however many stars the pattern has.
 */
function wildcardMatch<P, S>(pat: P[], input: S[], one: (p: P, s: S) => boolean, isStar: (p: P) => boolean, budget?: { left: number }): boolean {
  let pi = 0;
  let si = 0;
  let starP = -1;
  let starS = 0;
  while (si < input.length) {
    if (budget && --budget.left < 0) throw BUDGET_SPENT;
    if (pi < pat.length && isStar(pat[pi]!)) {
      starP = pi++;
      starS = si;
    } else if (pi < pat.length && one(pat[pi]!, input[si]!)) {
      pi++;
      si++;
    } else if (starP >= 0) {
      pi = starP + 1;
      si = ++starS;
    } else return false;
  }
  while (pi < pat.length && isStar(pat[pi]!)) pi++;
  return pi === pat.length;
}

const JS_EXTS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs"]);

export function isJsExt(ext: string): boolean {
  return JS_EXTS.has(ext);
}

// Keywords after which a quote or `/` starts an operand even though a word precedes it.
const EXPR_KEYWORD = /(?:^|[^\w$])(?:return|case|typeof|void|delete|throw|yield|await|in|of|instanceof|else|do|from|new)$/;

/**
 * True when the `'` or `"` at `i` in JS source can open a string literal. A quote glued to
 * an identifier (`Don't`, `You're`) is JSX text: code never puts a string straight after a
 * name, and reading it as one would swallow the rest of the line, closing braces included.
 */
export function jsQuoteOpens(text: string, i: number): boolean {
  const p = text.charCodeAt(i - 1);
  const word = (p >= 48 && p <= 57) || (p >= 65 && p <= 90) || (p >= 97 && p <= 122) || p === 95 || p === 36;
  return !word || EXPR_KEYWORD.test(text.slice(Math.max(0, i - 12), i));
}

/**
 * Index of the closing `/` of a JS regex literal starting at `i`, or -1 when that `/` is
 * division or the literal does not close on its line. Quotes and brackets inside a regex
 * (`/'/g`, `/[({]/`) are pattern characters, not string or block delimiters.
 */
export function jsRegexEnd(text: string, i: number): number {
  const nx = text[i + 1];
  if (nx === "/" || nx === "*") return -1;
  let k = i - 1;
  while (k >= 0 && (text[k] === " " || text[k] === "\t")) k--;
  const prev = k >= 0 ? text[k]! : "";
  // `<` and `>` are left out: `</Text>` closes a JSX tag and `=>` an arrow head.
  if (prev && !"(,=:[!&|?{;".includes(prev) && !EXPR_KEYWORD.test(text.slice(Math.max(0, k - 11), k + 1))) return -1;
  let inClass = false;
  for (let j = i + 1; j < text.length; j++) {
    const ch = text[j];
    if (ch === "\n") return -1;
    if (ch === "\\") j++;
    else if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) return j > i + 1 ? j : -1;
  }
  return -1;
}

/**
 * Remembers where a failed scan for a closing quote stopped. Every same-kind quote it passed was
 * escaped, so a scan from one of them would stop at the same line end and fail too; skipping
 * those keeps a long line of unclosed openers (`"\\"\\"\\…`) linear instead of quadratic.
 */
export class UnclosedQuotes {
  private until = new Map<string, number>();
  covers(quote: string, i: number): boolean {
    return i < (this.until.get(quote) ?? -1);
  }
  record(quote: string, stop: number): void {
    this.until.set(quote, stop);
  }
}

const MAX_REGEX_MISSES_PER_LINE = 64;

/**
 * jsRegexEnd with a per-line budget: each failed candidate scans to the line end, so a long
 * line of `[/[/[/…` would be quadratic. Past the budget a `/` on that line is division, which
 * real code (even minified) never reaches.
 */
export function lineCappedRegexEnd(): (text: string, i: number) => number {
  let lineEnd = -1;
  let misses = 0;
  return (text, i) => {
    if (i > lineEnd) {
      const nl = text.indexOf("\n", i);
      lineEnd = nl === -1 ? text.length : nl;
      misses = 0;
    }
    if (misses >= MAX_REGEX_MISSES_PER_LINE) return -1;
    const end = jsRegexEnd(text, i);
    if (end < 0 && text[i + 1] !== "/" && text[i + 1] !== "*") misses++;
    return end;
  };
}

/**
 * Blanks comments in C-family / Swift / JS source while keeping string literals,
 * offsets and newlines intact, so regex hits map back to the original line numbers.
 */
export function stripComments(text: string, ext: string): string {
  if (!CODE_EXTS.has(ext) && ext !== "strings") return text;
  const swift = ext === "swift";
  const js = JS_EXTS.has(ext);
  const out = text.split("");
  let changed = false;
  const blank = (from: number, to: number) => {
    changed = true;
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  const n = text.length;
  const unclosed = new UnclosedQuotes();
  const regexEnd = lineCappedRegexEnd();
  let re = -1;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    // `https://` in JSX text is not a comment; code almost never glues one straight onto `word:`.
    if (c === "/" && d === "/" && !(js && /[A-Za-z][\w+.-]*:$/.test(text.slice(Math.max(0, i - 24), i)))) {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && d === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (swift && text[j] === "/" && text[j + 1] === "*") { depth++; j += 2; continue; }
        if (text[j] === "*" && text[j + 1] === "/") { depth--; j += 2; continue; }
        j++;
      }
      blank(i, j);
      i = j;
    } else if (swift && text.startsWith('"""', i)) {
      const end = text.indexOf('"""', i + 3);
      i = end === -1 ? n : end + 3;
    } else if (js && c === "/" && (re = regexEnd(text, i)) > 0) {
      i = re + 1;
    } else if (((c === '"' && (!js || jsQuoteOpens(text, i))) || (js && ((c === "'" && jsQuoteOpens(text, i)) || c === "`"))) && !unclosed.covers(c, i)) {
      let j = i + 1;
      while (j < n && text[j] !== c) {
        if (text[j] === "\\") j++;
        else if (text[j] === "\n" && c !== "`") break;
        j++;
      }
      // A quote that never closes on its line was not a delimiter (an apostrophe in JSX text).
      if (j < n && text[j] === c) i = j + 1;
      else if (c === "`") i = n;
      else {
        unclosed.record(c, j);
        i++;
      }
    } else {
      i++;
    }
  }
  // Returning the same string when nothing changed lets caches keyed by text match by identity.
  return changed ? out.join("") : text;
}

// Line lookups happen once per hit; indexing a file once keeps that O(log n) per hit
// instead of rescanning from offset 0.
const LINE_CACHE: { text: string; starts: number[] }[] = [];
const LINE_CACHE_SIZE = 8;

function lineStartsOf(text: string): number[] {
  for (let i = 0; i < LINE_CACHE.length; i++) {
    const e = LINE_CACHE[i]!;
    if (e.text.length === text.length && e.text === text) {
      if (i > 0) {
        LINE_CACHE.splice(i, 1);
        LINE_CACHE.unshift(e);
      }
      return e.starts;
    }
  }
  const starts = [0];
  for (let k = 0; k < text.length; k++) if (text.charCodeAt(k) === 10) starts.push(k + 1);
  LINE_CACHE.unshift({ text, starts });
  if (LINE_CACHE.length > LINE_CACHE_SIZE) LINE_CACHE.pop();
  return starts;
}

export function lineOf(text: string, index: number): number {
  if (text.length < 4096) {
    let line = 1;
    for (let k = 0; k < index && k < text.length; k++) if (text.charCodeAt(k) === 10) line++;
    return line;
  }
  const starts = lineStartsOf(text);
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

// stripComments keeps every newline in place, so `text` and `code` share line starts.
const FILE_LINES = new WeakMap<SourceFile, number[]>();

function fileLineStarts(file: SourceFile): number[] {
  let starts = FILE_LINES.get(file);
  if (!starts) {
    starts = [0];
    const t = file.text;
    for (let k = 0; k < t.length; k++) if (t.charCodeAt(k) === 10) starts.push(k + 1);
    FILE_LINES.set(file, starts);
  }
  return starts;
}

/** 1-based line of an offset in `file.text` / `file.code`. */
export function lineAtFile(file: SourceFile, index: number): number {
  const starts = fileLineStarts(file);
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Longest evidence line kept whole; minified bundles put a whole file on one line. */
const MAX_LINE_TEXT = 2000;

function lineTextFrom(file: SourceFile, line: number, index: number): string {
  const starts = fileLineStarts(file);
  let start = starts[line - 1] ?? 0;
  let end = (starts[line] ?? file.text.length + 1) - 1;
  if (end - start > MAX_LINE_TEXT) {
    start = Math.max(start, index - MAX_LINE_TEXT / 2);
    end = Math.min(end, index + MAX_LINE_TEXT / 2);
  }
  return file.text.slice(start, end).trim();
}

/** Regex search over one file. Matches against comment-stripped code unless `raw` is set. */
export function searchFile(file: SourceFile, rx: RegExp, opts: { raw?: boolean } = {}): Hit[] {
  const src = opts.raw ? file.text : file.code;
  const g = new RegExp(rx.source, rx.flags.includes("g") ? rx.flags : `${rx.flags}g`);
  const hits: Hit[] = [];
  for (const m of src.matchAll(g)) {
    const index = m.index ?? 0;
    const line = lineAtFile(file, index);
    hits.push({
      file: file.path,
      line,
      text: lineTextFrom(file, line, index),
      match: m[0],
      groups: m.slice(1).map((s) => s ?? ""),
      index,
    });
    if (m[0].length === 0) break;
  }
  return hits;
}

/** Regex search across the context, optionally limited to some extensions. */
export function search(
  ctx: ScanContext,
  rx: RegExp,
  opts: { exts?: string[]; raw?: boolean; filter?: (f: SourceFile) => boolean } = {},
): Hit[] {
  const exts = opts.exts ? new Set(opts.exts) : undefined;
  return ctx.files
    .filter((f) => (!exts || exts.has(f.ext)) && (!opts.filter || opts.filter(f)))
    .flatMap((f) => searchFile(f, rx, { raw: opts.raw }));
}

export function fileByPath(ctx: ScanContext, rel: string): SourceFile | undefined {
  return ctx.files.find((f) => f.path === rel);
}

export const CODE_EXTENSIONS = [...CODE_EXTS];

// A misdetected or forced root such as $HOME must not walk and buffer the whole disk.
const MAX_WALK_ENTRIES = 200_000;
const MAX_LOADED_FILES = 20_000;
const MAX_LOADED_BYTES = 200_000_000;

/**
 * A linked worktree's `.git` is a file pointing into another repo's `.git/worktrees/`. It is a
 * second checkout of some branch, not part of this tree. Submodules also use a `.git` file, but
 * point into `.git/modules/`, and they do ship, so they are still walked.
 */
function isLinkedWorktree(dir: string, entries: { name: string; isFile(): boolean }[]): boolean {
  if (!entries.some((e) => e.name === ".git" && e.isFile())) return false;
  try {
    const head = readFileSync(path.join(dir, ".git"), "utf8").slice(0, 4096);
    return /^gitdir:.*[\\/]worktrees[\\/]/m.test(head);
  } catch {
    return false;
  }
}

async function walk(
  root: string,
  dir: string,
  ignored: GitignoreMatcher,
  prune: (rel: string) => boolean,
  includeTests: boolean,
  out: string[],
  dirs: string[],
  worktrees: string[],
  /** an ancestor directory is gitignored; git cannot re-include files below it */
  underIgnored = false,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  if (dir !== root && isLinkedWorktree(dir, entries)) {
    worktrees.push(path.relative(root, dir).split(path.sep).join("/"));
    return;
  }
  for (const e of entries) {
    if (out.length + dirs.length >= MAX_WALK_ENTRIES) return;
    const abs = path.join(dir, e.name);
    const rel = path.relative(root, abs).split(path.sep).join("/");
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name) || BINARY_BUNDLE_DIR.test(e.name) || BUILD_PRODUCT_DIR.test(e.name) || DERIVED_PRODUCTS.test(rel) || prune(rel)) continue;
      if (isBuiltBundle(abs, e.name)) continue;
      if (!includeTests && isTestPath(`${rel}/`)) continue;
      // Gitignored directories are still walked: shipping sources inside them still ship.
      dirs.push(rel);
      await walk(root, abs, ignored, prune, includeTests, out, dirs, worktrees, underIgnored || ignored(rel, true));
    } else if (e.isFile()) {
      if ((underIgnored || ignored(rel, false)) && !SHIPPING_EXTS.has(extOf(rel))) continue;
      if (!includeTests && isTestPath(rel)) continue;
      out.push(rel);
    }
  }
}

export async function loadContext(rootIn: string, opts: LoadOptions = {}): Promise<ScanContext> {
  const root = path.resolve(rootIn);
  const gi = path.join(root, ".gitignore");
  const ignored: GitignoreMatcher = await readGitignore(gi);
  // EAS builds from the git tree and regenerates the native project from app config, so a
  // gitignored ios/ folder there is a stale local prebuild, not what ships.
  const easPrebuild = existsSync(path.join(root, "eas.json")) && ignored("ios", true);
  const prune = (rel: string) => easPrebuild && rel === "ios";
  const all: string[] = [];
  const dirs: string[] = [];
  const excludedWorktrees: string[] = [];
  await walk(root, root, ignored, prune, opts.includeTests ?? false, all, dirs, excludedWorktrees);
  const walkTruncated = all.length + dirs.length >= MAX_WALK_ENTRIES;

  const dirSet = new Set(dirs);
  const appRoots = await detectAppRoots(root, all, dirs);
  const config = await readAppPaths(root, dirSet);
  // An explicit `paths` request is the caller choosing; config narrows only a whole-repo scan.
  const appPaths = opts.paths ? [] : config.paths;
  const scopeDirs = appPaths.length ? appScopeDirs(appPaths, await linkedLocalPackages(root, appPaths, all, dirSet), dirSet) : undefined;
  const inAppScope = (rel: string) => !scopeDirs || scopeDirs.some((d) => rel.startsWith(`${d}/`));
  const scopedAll = scopeDirs ? all.filter(inAppScope) : all;
  const scopedDirs = scopeDirs ? dirs.filter((d) => scopeDirs.some((s) => d === s || d.startsWith(`${s}/`))) : dirs;

  const wanted = opts.paths?.map((p) => p.replace(/^\.\//, "").replace(/\/$/, ""));
  const inScope = (rel: string) => inAppScope(rel) && (!wanted || wanted.some((w) => rel === w || rel.startsWith(`${w}/`)));

  const files: SourceFile[] = [];
  const skipped: SkippedFile[] = [];
  if (walkTruncated) skipped.push({ path: all.at(-1) ?? ".", reason: "budget", bytes: 0 });
  let loadedBytes = 0;
  const candidates = all.filter((rel) => inScope(rel) && TEXT_EXTS.has(extOf(rel)));
  for (const [i, rel] of candidates.entries()) {
    const ext = extOf(rel);
    const abs = path.join(root, rel);
    // One unreadable file (root-owned build output, a file deleted mid-walk) must not abort the scan; it is reported instead.
    const st = await stat(abs).catch(() => undefined);
    if (!st) {
      skipped.push({ path: rel, reason: "unreadable", bytes: 0, shipping: isShippingPath(rel) });
      continue;
    }
    if (files.length >= MAX_LOADED_FILES || loadedBytes + st.size > MAX_LOADED_BYTES) {
      skipped.push({ path: rel, reason: "budget", bytes: st.size, remaining: candidates.length - i });
      break;
    }
    if (st.size > (LOCALIZATION_EXTS.has(ext) ? MAX_LOCALIZATION_BYTES : MAX_FILE_BYTES)) {
      skipped.push({ path: rel, reason: "too-large", bytes: st.size, shipping: isShippingPath(rel) });
      continue;
    }
    const buf = await readFile(abs).catch(() => undefined);
    if (!buf) {
      skipped.push({ path: rel, reason: "unreadable", bytes: st.size, shipping: isShippingPath(rel) });
      continue;
    }
    const text = decodeText(buf);
    if (text === undefined || text.includes("\u0000")) {
      skipped.push({ path: rel, reason: "binary", bytes: st.size, shipping: isShippingPath(rel) });
      continue;
    }
    loadedBytes += st.size;
    files.push({ path: rel, abs, ext, text, code: stripComments(text, ext) });
  }

  const project = detectProject(root, scopedAll, scopedDirs, files, appPaths);
  project.appRoots = appRoots;
  if (appPaths.length) project.appPaths = appPaths;
  if (config.problems.length) project.configProblems = config.problems;
  return { root, project, files, skipped, excludedWorktrees };
}

/** Files the scan could not read although they ship; a verdict over them vouches for code nobody saw. */
export function unreadShippingFiles(ctx: ScanContext): SkippedFile[] {
  return (ctx.skipped ?? []).filter((s) => s.shipping);
}

function isShippingPath(rel: string): boolean {
  // Docs, examples and tests never ship, so an unreadable build script there is no coverage gap.
  if (NON_APP_DIR.test(rel) || TEST_DIR.test(rel)) return false;
  return SHIPPING_EXTS.has(extOf(rel)) || /(^|\/)(fastlane\/)?metadata\//.test(rel);
}

export const APP_PATHS_CONFIG = ".appstore-shield/config.json";
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_APP_PATHS = 50;
/**
 * Read alongside the chosen app folders: store metadata at the repo root, and server code in
 * the repo that apps call (a review-gating switch often lives in the backend, not the app).
 */
const REPO_METADATA_DIRS = ["fastlane", "metadata"];
const SERVER_DIRS = ["workers", "functions", "supabase", "api", "server", "backend", "apps/api", "apps/server", "apps/backend", "apps/workers"];

/**
 * Validates `appPaths`: repo-relative folders, no absolute paths and no `..`, so the config can
 * only narrow the scan inside this repo. "." means the whole repo and turns narrowing off.
 */
export function parseAppPaths(raw: unknown): { paths: string[]; problems: string[] } {
  const problems: string[] = [];
  if (raw === undefined) return { paths: [], problems };
  if (!Array.isArray(raw)) return { paths: [], problems: [`"appPaths" in ${APP_PATHS_CONFIG} must be an array of repo-relative folders, for example ["apps/ios"]; it was ignored and the whole repo was scanned.`] };
  const out: string[] = [];
  let whole = false;
  for (const [i, v] of raw.slice(0, MAX_APP_PATHS).entries()) {
    const bad = (why: string) => problems.push(`appPaths[${i}] ${JSON.stringify(v)} ${why}; ignored.`);
    if (typeof v !== "string" || !v.trim()) { bad("is not a folder path"); continue; }
    const t = v.trim();
    if (t.includes("\0") || t.includes("\\")) { bad("must be a plain path with forward slashes"); continue; }
    if (t.startsWith("/") || t.startsWith("~") || /^[A-Za-z]:/.test(t)) { bad("must be relative to the repo root"); continue; }
    const segs = t.split("/").filter((p) => p && p !== ".");
    if (segs.includes("..")) { bad("must not contain \"..\""); continue; }
    if (!segs.length) { whole = true; continue; }
    const norm = segs.join("/");
    if (!out.includes(norm)) out.push(norm);
  }
  if (raw.length > MAX_APP_PATHS) problems.push(`appPaths lists more than ${MAX_APP_PATHS} folders; the rest were ignored.`);
  return { paths: whole ? [] : out, problems };
}

async function readAppPaths(root: string, dirSet: Set<string>): Promise<{ paths: string[]; problems: string[] }> {
  const file = path.join(root, APP_PATHS_CONFIG);
  let text: string;
  try {
    const st = await stat(file);
    if (!st.isFile() || st.size > MAX_CONFIG_BYTES) return { paths: [], problems: [] };
    text = (await readFile(file, "utf8")).replace(/^\uFEFF/, "");
  } catch {
    return { paths: [], problems: [] };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { paths: [], problems: /"appPaths"/.test(text) ? [`${APP_PATHS_CONFIG} is not valid JSON, so "appPaths" was ignored and the whole repo was scanned.`] : [] };
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return { paths: [], problems: [] };
  const parsed = parseAppPaths((json as Record<string, unknown>).appPaths);
  const paths = parsed.paths.filter((p) => {
    if (dirSet.has(p)) return true;
    parsed.problems.push(`appPaths entry "${p}" is not a scannable folder in this repo; ignored.`);
    return false;
  });
  if (!paths.length && parsed.paths.length) parsed.problems.push("No appPaths entry was usable, so the whole repo was scanned.");
  return { paths, problems: parsed.problems };
}

function appScopeDirs(appPaths: string[], linked: string[], dirSet: Set<string>): string[] {
  const out = new Set<string>([...appPaths, ...linked]);
  for (const d of [...REPO_METADATA_DIRS, ...SERVER_DIRS]) if (dirSet.has(d)) out.add(d);
  // A folder inside another one adds nothing.
  return [...out].filter((d, _i, all) => !all.some((o) => o !== d && d.startsWith(`${o}/`)));
}

async function readSmall(abs: string, cap: number): Promise<string | undefined> {
  try {
    const st = await stat(abs);
    if (!st.isFile() || st.size > cap) return undefined;
    return await readFile(abs, "utf8");
  } catch {
    return undefined;
  }
}

/** `path` joined to `rel`, or undefined when it leaves the repo. */
function repoJoin(dir: string, rel: string): string | undefined {
  if (rel.startsWith("/") || rel.includes("\0")) return undefined;
  const j = path.posix.normalize(path.posix.join(dir === "." ? "" : dir, rel));
  if (j === ".." || j.startsWith("../") || j.startsWith("/")) return undefined;
  return j.replace(/\/$/, "") || ".";
}

const MAX_LINK_FILES = 500;

/**
 * Code outside the chosen app folders that is built into those apps: local Swift packages the
 * Xcode project or Package.swift references by path, and workspace JS packages the app depends
 * on. Narrowing the scan must not drop code that ships.
 */
async function linkedLocalPackages(root: string, appPaths: string[], all: string[], dirSet: Set<string>): Promise<string[]> {
  const out = new Set<string>();
  const under = (rel: string) => appPaths.some((p) => rel.startsWith(`${p}/`));
  // macOS and Windows checkouts are case-insensitive, and Xcode keeps whatever case was typed.
  const byLower = new Map([...dirSet].map((d) => [d.toLowerCase(), d]));
  const add = (raw: string | undefined) => {
    const d = raw === undefined ? undefined : dirSet.has(raw) ? raw : byLower.get(raw.toLowerCase());
    if (d && d !== "." && !appPaths.some((p) => d === p || d.startsWith(`${p}/`))) out.add(d);
  };
  let budget = MAX_LINK_FILES;
  for (const rel of all) {
    if (!under(rel) || budget <= 0) continue;
    const base = path.posix.basename(rel);
    if (base === "project.pbxproj") {
      budget--;
      const text = await readSmall(path.join(root, rel), 8_000_000);
      // XCLocalSwiftPackageReference paths are relative to the folder holding the .xcodeproj.
      const projDir = path.posix.dirname(path.posix.dirname(rel));
      for (const m of text?.matchAll(/\brelativePath\s*=\s*"?([^";\n]+)"?\s*;/g) ?? []) add(repoJoin(projDir, m[1]!.trim()));
    } else if (base === "Package.swift") {
      budget--;
      const text = await readSmall(path.join(root, rel), 1_000_000);
      for (const m of text?.matchAll(/\.package\s*\(\s*(?:name\s*:\s*"[^"]*"\s*,\s*)?path\s*:\s*"([^"]+)"/g) ?? []) add(repoJoin(path.posix.dirname(rel), m[1]!));
    }
  }
  const wantedDeps = new Set<string>();
  for (const p of appPaths) {
    const text = await readSmall(path.join(root, p, "package.json"), 1_000_000);
    if (!text) continue;
    try {
      const pkg = JSON.parse(text) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
      // Dev dependencies are build tooling; only runtime dependencies are bundled.
      for (const name of Object.keys(pkg.dependencies ?? {})) wantedDeps.add(name);
    } catch {
      // An unparsable package.json links nothing.
    }
  }
  if (wantedDeps.size) {
    for (const rel of all) {
      if (budget <= 0) break;
      if (path.posix.basename(rel) !== "package.json" || rel === "package.json" || under(rel) || rel.split("/").length > 4) continue;
      budget--;
      const text = await readSmall(path.join(root, rel), 1_000_000);
      try {
        const name = (JSON.parse(text ?? "") as { name?: unknown }).name;
        if (typeof name === "string" && wantedDeps.has(name)) add(path.posix.dirname(rel));
      } catch {
        // Not a package.
      }
    }
  }
  return [...out];
}

/**
 * Every app in the repo. React Native and Expo apps are found first, because the Xcode project
 * in their ios/ folder belongs to them, not to a separate Swift app.
 */
async function detectAppRoots(root: string, all: string[], dirs: string[]): Promise<AppRootInfo[]> {
  const found = new Map<string, Platform>();
  const parent = (p: string) => {
    const d = path.posix.dirname(p);
    return d === "" ? "." : d;
  };
  const dirSet = new Set(dirs);
  const appConfigDirs = new Set(all.filter((p) => /^app\.(json|config\.(ts|js|mjs|cjs))$/.test(path.posix.basename(p))).map(parent));
  const pkgs = all
    .filter((p) => path.posix.basename(p) === "package.json" && p.split("/").length <= 4 && !NON_APP_DIR.test(p))
    .slice(0, MAX_LINK_FILES);
  for (const rel of pkgs) {
    const text = await readSmall(path.join(root, rel), 1_000_000);
    let deps: Record<string, unknown> = {};
    try {
      const pkg = JSON.parse(text ?? "") as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
      deps = { ...pkg.devDependencies, ...pkg.dependencies };
    } catch {
      continue;
    }
    if (!("expo" in deps) && !("react-native" in deps)) continue;
    const dir = parent(rel);
    // A library under packages/ or a workspace root can list react-native too; an app has app config or a native project.
    if (!appConfigDirs.has(dir) && !dirSet.has(dir === "." ? "ios" : `${dir}/ios`)) continue;
    found.set(dir, "expo" in deps ? "expo" : "react-native");
  }
  const jsRoots = [...found.keys()];
  const swiftDirs = [
    ...dirs.filter((d) => d.endsWith(".xcodeproj")).map(parent),
    ...all.filter((p) => path.posix.basename(p) === "Project.swift").map(parent),
  ];
  for (const dir of swiftDirs) {
    if (NON_APP_DIR.test(`${dir}/`)) continue;
    if (jsRoots.some((r) => { const ios = r === "." ? "ios" : `${r}/ios`; return dir === ios || dir.startsWith(`${ios}/`); })) continue;
    if (!found.has(dir)) found.set(dir, "swift");
  }
  // An Xcode project nested in another app's folder (a vendored library, an extension) is part
  // of that app. A repo-root app does not swallow separate apps in subfolders, except a Swift
  // app's own vendored Xcode projects.
  const within = (d: string, o: string) => (o === "." ? d !== "." : d.startsWith(`${o}/`));
  const swallows = (d: string, pf: Platform, o: string, opf: Platform) =>
    o !== d && within(d, o) && (o === "." ? pf === "swift" && opf === "swift" : pf === "swift" || opf !== "swift");
  const entries = [...found.entries()];
  const roots = entries.filter(([d, pf]) => !entries.some(([o, opf]) => swallows(d, pf, o, opf)));
  return roots.map(([p, platform]) => ({ path: p, platform })).sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Plain-language lines about which apps were scanned, so a finding on a stale app in a
 * monorepo comes with the way to stop seeing it.
 */
export function appRootNotes(project: ProjectInfo): string[] {
  const out = [...(project.configProblems ?? []).map((p) => `${APP_PATHS_CONFIG}: ${p}`)];
  const label = (r: AppRootInfo) => `${r.path} (${r.platform})`;
  if (project.appPaths?.length) {
    const scanned = (r: AppRootInfo) => project.appPaths!.some((p) => r.path === p || r.path.startsWith(`${p}/`) || p.startsWith(`${r.path === "." ? "" : `${r.path}/`}`));
    const skippedRoots = project.appRoots.filter((r) => !scanned(r));
    out.push(`Scanning only appPaths from ${APP_PATHS_CONFIG}: ${project.appPaths.join(", ")}, plus repo-level store metadata and in-repo server code.${skippedRoots.length ? ` Not scanned: ${skippedRoots.map(label).join(", ")}.` : ""}`);
  } else if (project.appRoots.length > 1) {
    const n = project.appRoots.length;
    out.push(
      `Found ${n} app roots: ${project.appRoots.map(label).join(", ")}; scanning ${n === 2 ? "both" : `all ${n}`}. If only some ship, set "appPaths" in ${APP_PATHS_CONFIG} (for example {"appPaths": ["${project.appRoots[0]!.path}"]}) to scan just those.`,
    );
  }
  return out;
}

/**
 * Directory of a React Native or Expo app that lives below the repo root (a monorepo's
 * `apps/expo/`, a repo whose app is in `app/`). Libraries under `packages/` may also list
 * react-native, so a candidate with its own app config or native `ios/` folder wins, then
 * the shallowest.
 */
// Sample, template and throwaway spike apps sit beside the product in many repos and never ship as it.
const NON_APP_DIR = /(^|\/)(examples?|samples?|demos?|docs?|templates?|fixtures?|playground|storybook|probes?|spikes?)\//i;

function nestedAppRoot(all: string[], dirs: string[], files: SourceFile[], appPaths: string[] = []): string | undefined {
  const declares = (text: string) => {
    try {
      const pkg = JSON.parse(text) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      return "react-native" in deps || "expo" in deps;
    } catch {
      return false;
    }
  };
  const candidates = files
    .filter((f) => (/^(?:[^/]+\/){1,2}package\.json$/.test(f.path) || appPaths.some((p) => f.path === `${p}/package.json`)) && !NON_APP_DIR.test(f.path) && declares(f.text))
    .map((f) => {
      const dir = f.path.slice(0, -"/package.json".length);
      const app = all.some((p) => p.startsWith(`${dir}/`) && /^app\.(json|config\.(ts|js|mjs|cjs))$/.test(p.slice(dir.length + 1))) || dirs.includes(`${dir}/ios`);
      return { dir, app, depth: dir.split("/").length };
    })
    .sort((a, b) => Number(b.app) - Number(a.app) || a.depth - b.depth || a.dir.localeCompare(b.dir));
  return candidates[0]?.dir;
}

function detectProject(root: string, all: string[], dirs: string[], files: SourceFile[], appPaths: string[] = []): ProjectInfo {
  const base = (p: string) => p.split("/").pop() ?? p;
  const xcodeProjects = dirs.filter((d) => d.endsWith(".xcodeproj"));
  const rootPkg = files.find((f) => f.path === "package.json")?.text ?? "";
  const rootIsApp = /"(react-native|expo)"\s*:/.test(rootPkg);
  const appRoot = rootIsApp ? undefined : nestedAppRoot(all, dirs, files, appPaths);
  const prefix = appRoot ? `${appRoot}/` : "";
  const packageJson = all.find((p) => p === `${prefix}package.json`);
  const pkgText = files.find((f) => f.path === packageJson)?.text ?? "";
  const expoConfig = all.find((p) => p.startsWith(prefix) && /^app\.(json|config\.(ts|js|mjs|cjs))$/.test(p.slice(prefix.length)));
  const platforms: Platform[] = [];
  if (xcodeProjects.length || all.some((p) => p.endsWith(".swift") || base(p) === "Package.swift")) platforms.push("swift");
  if (/"react-native"\s*:/.test(pkgText)) platforms.push("react-native");
  if (/"expo"\s*:/.test(pkgText) || (expoConfig && /"expo"\s*:/.test(files.find((f) => f.path === expoConfig)?.text ?? ""))) {
    platforms.push("expo");
  }
  return {
    root,
    platforms,
    xcodeProjects,
    infoPlists: all.filter((p) => base(p) === "Info.plist"),
    privacyManifests: all.filter((p) => base(p) === "PrivacyInfo.xcprivacy"),
    packageJson,
    expoConfig,
    ...(appRoot ? { appRoot } : {}),
    metadataDirs: ["metadata", "fastlane/metadata", ...appPaths.flatMap((p) => [`${p}/metadata`, `${p}/fastlane/metadata`])].filter((d) => dirs.includes(d)),
    appRoots: [],
  };
}

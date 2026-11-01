#!/usr/bin/env node
import { createRequire as __shieldCreateRequire } from "node:module";
const require = __shieldCreateRequire(import.meta.url);
import {
  CHECK_IDS
} from "./chunk-NJWBMBWQ.js";
import {
  clip,
  countBySeverity,
  dedupeFindings,
  finding,
  sortFindings
} from "./chunk-JMGZ43QQ.js";
import {
  buildSnapshots,
  diffSinceApproved,
  gateCoverageWarnings,
  gateDecision,
  refreshHighFindingsWarning,
  rejectionAppliesTo,
  rejectionsToResweep,
  resweepFromVerification,
  stableHash,
  toolRef,
  triggerChecklist
} from "./chunk-L5NUVNOO.js";
import {
  MetadataSnapshot,
  RemoteControl,
  ResidueSpec,
  appendEvent,
  foldEvents,
  loadState,
  locateLedger,
  probeConfirmation,
  readLedger
} from "./chunk-XY3GP4WK.js";

// src/preflight.ts
import { execFile as execFile3 } from "node:child_process";
import { readdirSync, readFileSync as readFileSync2, statSync } from "node:fs";
import path7 from "node:path";

// src/baseline.ts
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
var BASELINE_REL = ".appstore-shield/baseline.json";
var MIN_JUSTIFICATION = 20;
var MAX_BASELINE_BYTES = 1024 * 1024;
async function loadBaseline(root) {
  const file2 = path.join(root, BASELINE_REL);
  let text;
  try {
    const fh = await open(file2, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const st = await fh.stat();
      if (!st.isFile()) return { path: file2, exists: true, suppressions: [], problems: [`${BASELINE_REL} is not a regular file; no suppressions applied.`] };
      if (st.size > MAX_BASELINE_BYTES) {
        return { path: file2, exists: true, suppressions: [], problems: [`${BASELINE_REL} is ${st.size} bytes (limit ${MAX_BASELINE_BYTES}); no suppressions applied.`] };
      }
      text = await fh.readFile("utf8");
    } finally {
      await fh.close();
    }
  } catch (e) {
    if (e.code === "ENOENT") return { path: file2, exists: false, suppressions: [], problems: [] };
    return { path: file2, exists: true, suppressions: [], problems: [`Cannot read ${BASELINE_REL}: ${e.message}`] };
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { path: file2, exists: true, suppressions: [], problems: [`${BASELINE_REL} is not valid JSON (${e.message}); no suppressions applied.`] };
  }
  const list = Array.isArray(json) ? json : json?.suppressions;
  if (!Array.isArray(list)) {
    return { path: file2, exists: true, suppressions: [], problems: [`${BASELINE_REL} must be {"suppressions": [{"id" or "rule", "justification"}]}; no suppressions applied.`] };
  }
  const suppressions = [];
  const problems = [];
  list.forEach((raw, i) => {
    const s = raw ?? {};
    const id = typeof s.id === "string" && s.id.trim() ? s.id.trim() : void 0;
    const rule = typeof s.rule === "string" && s.rule.trim() ? s.rule.trim() : void 0;
    const fileSel = typeof s.file === "string" && s.file.trim() ? s.file.trim().replace(/^\.\//, "") : void 0;
    const justification = typeof s.justification === "string" ? s.justification.trim() : "";
    if (!id && !rule) {
      problems.push(`suppressions[${i}] has neither "id" nor "rule"; skipped.`);
      return;
    }
    if (justification.length < MIN_JUSTIFICATION) {
      problems.push(
        `suppressions[${i}] (${id ?? rule}) skipped: "justification" must explain why in at least ${MIN_JUSTIFICATION} characters.`
      );
      return;
    }
    suppressions.push({
      id,
      rule,
      file: fileSel,
      justification,
      addedBy: typeof s.addedBy === "string" ? s.addedBy : void 0,
      addedAt: typeof s.addedAt === "string" ? s.addedAt : void 0
    });
  });
  return { path: file2, exists: true, suppressions, problems };
}
function matches(s, f) {
  if (s.id) return s.id === f.id;
  if (s.rule !== f.rule) return false;
  return !s.file || s.file === f.file;
}
function applyBaseline(findings, suppressions) {
  const out = { active: [], suppressed: [], refused: [] };
  for (const f of findings) {
    const s = suppressions.find((x) => matches(x, f));
    if (!s) out.active.push(f);
    else if (!f.suppressible) {
      out.active.push(f);
      out.refused.push({ finding: f, justification: s.justification });
    } else out.suppressed.push({ finding: f, justification: s.justification });
  }
  return out;
}

// src/project.ts
import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path2 from "node:path";
var CODE_EXTS = /* @__PURE__ */ new Set(["swift", "m", "mm", "h", "ts", "tsx", "js", "jsx", "mjs", "cjs", "kt", "java"]);
var TEXT_EXTS = /* @__PURE__ */ new Set([
  ...CODE_EXTS,
  "json",
  "plist",
  "xcprivacy",
  "entitlements",
  "strings",
  "stringsdict",
  "xcstrings",
  "yaml",
  "yml",
  "toml",
  "txt",
  "xml",
  "html",
  "md",
  "pbxproj",
  "xcconfig",
  "gradle",
  "env",
  "prompt"
]);
var IGNORED_DIRS = /* @__PURE__ */ new Set([
  "node_modules",
  "Pods",
  ".git",
  "build",
  "DerivedData",
  "dist",
  ".build",
  ".expo",
  "Carthage",
  "android",
  ".gradle",
  "vendor",
  ".next",
  "coverage",
  "xcuserdata",
  ".swiftpm",
  ".appstore-shield",
  ".turbo",
  ".cache",
  "SourcePackages",
  "web-build",
  ".venv",
  "venv",
  "__pycache__",
  ".yarn",
  ".pnpm-store",
  ".vercel",
  ".output",
  ".idea",
  // Agent and editor worktree folders hold whole extra copies of the repo; scanning them repeats
  // every finding once per copy and can exhaust the file budget before the real app is read.
  ".claude",
  ".worktrees",
  // Generated server bundles: findings there point at build output nobody edits.
  ".wrangler",
  ".netlify",
  ".svelte-kit",
  ".nuxt",
  ".parcel-cache",
  ".angular",
  ".serverless",
  ".docusaurus"
]);
var TEST_DIR = /(^|\/)(tests?|Tests?|__tests__|__mocks__|__fixtures__|__automation__|e2e|e2e-tests|jest|detox|maestro|test-utils|testing|(?!(?:AB|A_B|Ab|Split|Experiments?)[_-]?Tests?\/)[\w-]*(?:Tests|[_-]Tests?|TestMocks?|TestSupport|TestHelpers?|TestUtils?))\//;
var BINARY_BUNDLE_DIR = /\.(xcframework|framework)$/;
var BUILD_PRODUCT_DIR = /\.(xcarchive|dSYM|xctest|ipa|noindex)$/;
var DERIVED_PRODUCTS = /(^|\/)Build\/Products$/;
function isBuiltBundle(abs, name) {
  if (!/\.(app|appex)$/.test(name)) return false;
  return ["Info.plist", "Contents/Info.plist", "_CodeSignature"].some((p) => existsSync(path2.join(abs, p)));
}
var TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(jest|vitest|detox)\.(config|setup)\.[cm]?[jt]s$|(^|\/)\.detoxrc(\.[cm]?[jt]s|\.json)?$/;
var MAX_FILE_BYTES = 15e5;
var MAX_LOCALIZATION_BYTES = 16e6;
var LOCALIZATION_EXTS = /* @__PURE__ */ new Set(["xcstrings", "strings", "stringsdict"]);
function extOf(p) {
  const base = path2.basename(p);
  if (base === "Podfile" || base === "Package.resolved") return "txt";
  if (base === ".env" || base.startsWith(".env.")) return "env";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}
function isTestPath(rel) {
  return TEST_DIR.test(rel) || TEST_FILE.test(rel);
}
function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 255 && buf[1] === 254) return new TextDecoder("utf-16le").decode(buf);
  if (buf.length >= 2 && buf[0] === 254 && buf[1] === 255) return new TextDecoder("utf-16be").decode(buf);
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  let even = 0;
  let odd = 0;
  for (let k = 0; k < sample.length; k++) if (sample[k] === 0) k % 2 === 0 ? even++ : odd++;
  if (even + odd === 0) return new TextDecoder("utf-8").decode(buf);
  const half = sample.length / 2;
  if (odd > half * 0.6 && even < half * 0.05) return new TextDecoder("utf-16le").decode(buf);
  if (even > half * 0.6 && odd < half * 0.05) return new TextDecoder("utf-16be").decode(buf);
  return void 0;
}
var SHIPPING_EXTS = /* @__PURE__ */ new Set([...CODE_EXTS, "plist", "xcprivacy", "entitlements", "strings", "stringsdict", "xcstrings", "pbxproj", "prompt"]);
function compileGitignore(src, stepBudget = GITIGNORE_STEP_BUDGET) {
  const lines = src.split(/\r?\n/).slice(0, MAX_GITIGNORE_LINES).map((l) => l.length > MAX_GITIGNORE_PATTERN ? "" : trimGitignoreLine(l).trimStart()).filter((l) => l && !l.startsWith("#") && l.length <= MAX_GITIGNORE_PATTERN);
  const last = new Map(lines.map((l, i) => [l, i]));
  const unique = lines.filter((l, i) => last.get(l) === i).slice(0, MAX_GITIGNORE_RULES);
  const rules = unique.map((line) => {
    const negate = line.startsWith("!");
    const raw = (negate ? line.slice(1) : line).replace(/^\\([#!])/, "$1");
    const dirOnly = raw.endsWith("/");
    const pat = raw.replace(/\/+$/, "");
    const anchored = pat.includes("/");
    const segs = anchored ? [] : ["**", globTokens(pat)];
    if (anchored) for (const part of pat.replace(/^\//, "").split("/")) {
      if (!part) continue;
      if (part === "**") {
        if (segs[segs.length - 1] !== "**") segs.push("**");
      } else segs.push(globTokens(part));
    }
    if (segs[segs.length - 1] === "**") segs.push(globTokens("*"));
    return { negate, dirOnly, segs };
  }).filter((r) => r.segs.some((s) => s !== "**" && s.length > 0));
  const memo = /* @__PURE__ */ new Map();
  let memoSize = 0;
  const budget = { left: stepBudget };
  const seg = (toks, part) => {
    let m = memo.get(toks);
    if (!m) memo.set(toks, m = /* @__PURE__ */ new Map());
    let r = m.get(part);
    if (r === void 0) {
      r = segmentMatch(toks, part, budget);
      if (memoSize++ < 25e4) m.set(part, r);
    }
    return r;
  };
  let exhausted = false;
  return (rel, isDir) => {
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
var MAX_GITIGNORE_LINES = 5e3;
var MAX_GITIGNORE_RULES = 1e3;
var MAX_GITIGNORE_PATTERN = 255;
var GITIGNORE_STEP_BUDGET = 1e8;
var BUDGET_SPENT = /* @__PURE__ */ Symbol("gitignore budget spent");
var MAX_GITIGNORE_BYTES = 1024 * 1024;
async function readGitignore(file2) {
  try {
    const st = await stat(file2);
    if (!st.isFile() || st.size > MAX_GITIGNORE_BYTES) return () => false;
    return compileGitignore(await readFile(file2, "utf8"));
  } catch {
    return () => false;
  }
}
function trimGitignoreLine(l) {
  const t = l.trimEnd();
  return t.endsWith("\\") && t.length < l.length ? t + l.charAt(t.length) : t;
}
function globTokens(seg) {
  const out = [];
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === "\\" && i + 1 < seg.length) out.push({ t: "lit", c: seg[++i] });
    else if (c === "*") {
      if (out[out.length - 1]?.t !== "star") out.push({ t: "star" });
    } else if (c === "?") out.push({ t: "any" });
    else if (c === "[") {
      let j = i + 1;
      const neg = seg[j] === "!" || seg[j] === "^";
      if (neg) j++;
      const ranges = [];
      let first = true;
      for (; j < seg.length && (first || seg[j] !== "]"); j++, first = false) {
        let lo = seg[j];
        if (lo === "\\" && j + 1 < seg.length) lo = seg[++j];
        if (seg[j + 1] === "-" && j + 2 < seg.length && seg[j + 2] !== "]") {
          let hi = seg[j + 2];
          j += 2;
          if (hi === "\\" && j + 1 < seg.length) hi = seg[++j];
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
function tokenMatches(tok, ch) {
  return tok.t === "any" || tok.t === "lit" && tok.c === ch || tok.t === "class" && tok.ranges.some(([lo, hi]) => ch >= lo && ch <= hi) !== tok.neg;
}
function segmentMatch(toks, seg, budget) {
  const s = /[\uD800-\uDFFF]/.test(seg) ? [...seg] : seg;
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
    } else if (tok && tokenMatches(tok, s[si])) {
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
function wildcardMatch(pat, input, one, isStar, budget) {
  let pi = 0;
  let si = 0;
  let starP = -1;
  let starS = 0;
  while (si < input.length) {
    if (budget && --budget.left < 0) throw BUDGET_SPENT;
    if (pi < pat.length && isStar(pat[pi])) {
      starP = pi++;
      starS = si;
    } else if (pi < pat.length && one(pat[pi], input[si])) {
      pi++;
      si++;
    } else if (starP >= 0) {
      pi = starP + 1;
      si = ++starS;
    } else return false;
  }
  while (pi < pat.length && isStar(pat[pi])) pi++;
  return pi === pat.length;
}
var JS_EXTS = /* @__PURE__ */ new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs"]);
function isJsExt(ext) {
  return JS_EXTS.has(ext);
}
var EXPR_KEYWORD = /(?:^|[^\w$])(?:return|case|typeof|void|delete|throw|yield|await|in|of|instanceof|else|do|from|new)$/;
function jsQuoteOpens(text, i) {
  const p = text.charCodeAt(i - 1);
  const word = p >= 48 && p <= 57 || p >= 65 && p <= 90 || p >= 97 && p <= 122 || p === 95 || p === 36;
  return !word || EXPR_KEYWORD.test(text.slice(Math.max(0, i - 12), i));
}
function jsRegexEnd(text, i) {
  const nx = text[i + 1];
  if (nx === "/" || nx === "*") return -1;
  let k = i - 1;
  while (k >= 0 && (text[k] === " " || text[k] === "	")) k--;
  const prev = k >= 0 ? text[k] : "";
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
var UnclosedQuotes = class {
  until = /* @__PURE__ */ new Map();
  covers(quote, i) {
    return i < (this.until.get(quote) ?? -1);
  }
  record(quote, stop) {
    this.until.set(quote, stop);
  }
};
var MAX_REGEX_MISSES_PER_LINE = 64;
function lineCappedRegexEnd() {
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
function stripComments(text, ext) {
  if (!CODE_EXTS.has(ext) && ext !== "strings") return text;
  const swift = ext === "swift";
  const js = JS_EXTS.has(ext);
  const out = text.split("");
  let changed = false;
  const blank = (from, to) => {
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
    if (c === "/" && d === "/" && !(js && /[A-Za-z][\w+.-]*:$/.test(text.slice(Math.max(0, i - 24), i)))) {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && d === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (swift && text[j] === "/" && text[j + 1] === "*") {
          depth++;
          j += 2;
          continue;
        }
        if (text[j] === "*" && text[j + 1] === "/") {
          depth--;
          j += 2;
          continue;
        }
        j++;
      }
      blank(i, j);
      i = j;
    } else if (swift && text.startsWith('"""', i)) {
      const end = text.indexOf('"""', i + 3);
      i = end === -1 ? n : end + 3;
    } else if (js && c === "/" && (re = regexEnd(text, i)) > 0) {
      i = re + 1;
    } else if ((c === '"' && (!js || jsQuoteOpens(text, i)) || js && (c === "'" && jsQuoteOpens(text, i) || c === "`")) && !unclosed.covers(c, i)) {
      let j = i + 1;
      while (j < n && text[j] !== c) {
        if (text[j] === "\\") j++;
        else if (text[j] === "\n" && c !== "`") break;
        j++;
      }
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
  return changed ? out.join("") : text;
}
var LINE_CACHE = [];
var LINE_CACHE_SIZE = 8;
function lineStartsOf(text) {
  for (let i = 0; i < LINE_CACHE.length; i++) {
    const e = LINE_CACHE[i];
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
function lineOf(text, index) {
  if (text.length < 4096) {
    let line = 1;
    for (let k = 0; k < index && k < text.length; k++) if (text.charCodeAt(k) === 10) line++;
    return line;
  }
  const starts = lineStartsOf(text);
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = lo + hi + 1 >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}
var FILE_LINES = /* @__PURE__ */ new WeakMap();
function fileLineStarts(file2) {
  let starts = FILE_LINES.get(file2);
  if (!starts) {
    starts = [0];
    const t = file2.text;
    for (let k = 0; k < t.length; k++) if (t.charCodeAt(k) === 10) starts.push(k + 1);
    FILE_LINES.set(file2, starts);
  }
  return starts;
}
function lineAtFile(file2, index) {
  const starts = fileLineStarts(file2);
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = lo + hi + 1 >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}
var MAX_LINE_TEXT = 2e3;
function lineTextFrom(file2, line, index) {
  const starts = fileLineStarts(file2);
  let start = starts[line - 1] ?? 0;
  let end = (starts[line] ?? file2.text.length + 1) - 1;
  if (end - start > MAX_LINE_TEXT) {
    start = Math.max(start, index - MAX_LINE_TEXT / 2);
    end = Math.min(end, index + MAX_LINE_TEXT / 2);
  }
  return file2.text.slice(start, end).trim();
}
function searchFile(file2, rx, opts = {}) {
  const src = opts.raw ? file2.text : file2.code;
  const g = new RegExp(rx.source, rx.flags.includes("g") ? rx.flags : `${rx.flags}g`);
  const hits = [];
  for (const m of src.matchAll(g)) {
    const index = m.index ?? 0;
    const line = lineAtFile(file2, index);
    hits.push({
      file: file2.path,
      line,
      text: lineTextFrom(file2, line, index),
      match: m[0],
      groups: m.slice(1).map((s) => s ?? ""),
      index
    });
    if (m[0].length === 0) break;
  }
  return hits;
}
var CODE_EXTENSIONS = [...CODE_EXTS];
var MAX_WALK_ENTRIES = 2e5;
var MAX_LOADED_FILES = 2e4;
var MAX_LOADED_BYTES = 2e8;
function isLinkedWorktree(dir, entries) {
  if (!entries.some((e) => e.name === ".git" && e.isFile())) return false;
  try {
    const head = readFileSync(path2.join(dir, ".git"), "utf8").slice(0, 4096);
    return /^gitdir:.*[\\/]worktrees[\\/]/m.test(head);
  } catch {
    return false;
  }
}
async function walk(root, dir, ignored, prune, includeTests, out, dirs, worktrees, underIgnored = false) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  if (dir !== root && isLinkedWorktree(dir, entries)) {
    worktrees.push(path2.relative(root, dir).split(path2.sep).join("/"));
    return;
  }
  for (const e of entries) {
    if (out.length + dirs.length >= MAX_WALK_ENTRIES) return;
    const abs = path2.join(dir, e.name);
    const rel = path2.relative(root, abs).split(path2.sep).join("/");
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name) || BINARY_BUNDLE_DIR.test(e.name) || BUILD_PRODUCT_DIR.test(e.name) || DERIVED_PRODUCTS.test(rel) || prune(rel)) continue;
      if (isBuiltBundle(abs, e.name)) continue;
      if (!includeTests && isTestPath(`${rel}/`)) continue;
      dirs.push(rel);
      await walk(root, abs, ignored, prune, includeTests, out, dirs, worktrees, underIgnored || ignored(rel, true));
    } else if (e.isFile()) {
      if ((underIgnored || ignored(rel, false)) && !SHIPPING_EXTS.has(extOf(rel))) continue;
      if (!includeTests && isTestPath(rel)) continue;
      out.push(rel);
    }
  }
}
async function loadContext(rootIn, opts = {}) {
  const root = path2.resolve(rootIn);
  const gi = path2.join(root, ".gitignore");
  const ignored = await readGitignore(gi);
  const easPrebuild = existsSync(path2.join(root, "eas.json")) && ignored("ios", true);
  const prune = (rel) => easPrebuild && rel === "ios";
  const all = [];
  const dirs = [];
  const excludedWorktrees = [];
  await walk(root, root, ignored, prune, opts.includeTests ?? false, all, dirs, excludedWorktrees);
  const walkTruncated = all.length + dirs.length >= MAX_WALK_ENTRIES;
  const dirSet = new Set(dirs);
  const appRoots = await detectAppRoots(root, all, dirs);
  const config = await readAppPaths(root, dirSet);
  const appPaths = opts.paths ? [] : config.paths;
  const scopeDirs = appPaths.length ? appScopeDirs(appPaths, await linkedLocalPackages(root, appPaths, all, dirSet), dirSet) : void 0;
  const inAppScope = (rel) => !scopeDirs || scopeDirs.some((d) => rel.startsWith(`${d}/`));
  const scopedAll = scopeDirs ? all.filter(inAppScope) : all;
  const scopedDirs = scopeDirs ? dirs.filter((d) => scopeDirs.some((s) => d === s || d.startsWith(`${s}/`))) : dirs;
  const wanted = opts.paths?.map((p) => p.replace(/^\.\//, "").replace(/\/$/, ""));
  const inScope = (rel) => inAppScope(rel) && (!wanted || wanted.some((w) => rel === w || rel.startsWith(`${w}/`)));
  const files = [];
  const skipped = [];
  if (walkTruncated) skipped.push({ path: all.at(-1) ?? ".", reason: "budget", bytes: 0 });
  let loadedBytes = 0;
  const candidates = all.filter((rel) => inScope(rel) && TEXT_EXTS.has(extOf(rel)));
  for (const [i, rel] of candidates.entries()) {
    const ext = extOf(rel);
    const abs = path2.join(root, rel);
    const st = await stat(abs).catch(() => void 0);
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
    const buf = await readFile(abs).catch(() => void 0);
    if (!buf) {
      skipped.push({ path: rel, reason: "unreadable", bytes: st.size, shipping: isShippingPath(rel) });
      continue;
    }
    const text = decodeText(buf);
    if (text === void 0 || text.includes("\0")) {
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
function unreadShippingFiles(ctx) {
  return (ctx.skipped ?? []).filter((s) => s.shipping);
}
function isShippingPath(rel) {
  if (NON_APP_DIR.test(rel) || TEST_DIR.test(rel)) return false;
  return SHIPPING_EXTS.has(extOf(rel)) || /(^|\/)(fastlane\/)?metadata\//.test(rel);
}
var APP_PATHS_CONFIG = ".appstore-shield/config.json";
var MAX_CONFIG_BYTES = 64 * 1024;
var MAX_APP_PATHS = 50;
var REPO_METADATA_DIRS = ["fastlane", "metadata"];
var SERVER_DIRS = ["workers", "functions", "supabase", "api", "server", "backend", "apps/api", "apps/server", "apps/backend", "apps/workers"];
function parseAppPaths(raw) {
  const problems = [];
  if (raw === void 0) return { paths: [], problems };
  if (!Array.isArray(raw)) return { paths: [], problems: [`"appPaths" in ${APP_PATHS_CONFIG} must be an array of repo-relative folders, for example ["apps/ios"]; it was ignored and the whole repo was scanned.`] };
  const out = [];
  let whole = false;
  for (const [i, v] of raw.slice(0, MAX_APP_PATHS).entries()) {
    const bad = (why) => problems.push(`appPaths[${i}] ${JSON.stringify(v)} ${why}; ignored.`);
    if (typeof v !== "string" || !v.trim()) {
      bad("is not a folder path");
      continue;
    }
    const t = v.trim();
    if (t.includes("\0") || t.includes("\\")) {
      bad("must be a plain path with forward slashes");
      continue;
    }
    if (t.startsWith("/") || t.startsWith("~") || /^[A-Za-z]:/.test(t)) {
      bad("must be relative to the repo root");
      continue;
    }
    const segs = t.split("/").filter((p) => p && p !== ".");
    if (segs.includes("..")) {
      bad('must not contain ".."');
      continue;
    }
    if (!segs.length) {
      whole = true;
      continue;
    }
    const norm = segs.join("/");
    if (!out.includes(norm)) out.push(norm);
  }
  if (raw.length > MAX_APP_PATHS) problems.push(`appPaths lists more than ${MAX_APP_PATHS} folders; the rest were ignored.`);
  return { paths: whole ? [] : out, problems };
}
async function readAppPaths(root, dirSet) {
  const file2 = path2.join(root, APP_PATHS_CONFIG);
  let text;
  try {
    const st = await stat(file2);
    if (!st.isFile() || st.size > MAX_CONFIG_BYTES) return { paths: [], problems: [] };
    text = (await readFile(file2, "utf8")).replace(/^\uFEFF/, "");
  } catch {
    return { paths: [], problems: [] };
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { paths: [], problems: /"appPaths"/.test(text) ? [`${APP_PATHS_CONFIG} is not valid JSON, so "appPaths" was ignored and the whole repo was scanned.`] : [] };
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return { paths: [], problems: [] };
  const parsed = parseAppPaths(json.appPaths);
  const paths = parsed.paths.filter((p) => {
    if (dirSet.has(p)) return true;
    parsed.problems.push(`appPaths entry "${p}" is not a scannable folder in this repo; ignored.`);
    return false;
  });
  if (!paths.length && parsed.paths.length) parsed.problems.push("No appPaths entry was usable, so the whole repo was scanned.");
  return { paths, problems: parsed.problems };
}
function appScopeDirs(appPaths, linked, dirSet) {
  const out = /* @__PURE__ */ new Set([...appPaths, ...linked]);
  for (const d of [...REPO_METADATA_DIRS, ...SERVER_DIRS]) if (dirSet.has(d)) out.add(d);
  return [...out].filter((d, _i, all) => !all.some((o) => o !== d && d.startsWith(`${o}/`)));
}
async function readSmall(abs, cap2) {
  try {
    const st = await stat(abs);
    if (!st.isFile() || st.size > cap2) return void 0;
    return await readFile(abs, "utf8");
  } catch {
    return void 0;
  }
}
function repoJoin(dir, rel) {
  if (rel.startsWith("/") || rel.includes("\0")) return void 0;
  const j = path2.posix.normalize(path2.posix.join(dir === "." ? "" : dir, rel));
  if (j === ".." || j.startsWith("../") || j.startsWith("/")) return void 0;
  return j.replace(/\/$/, "") || ".";
}
var MAX_LINK_FILES = 500;
async function linkedLocalPackages(root, appPaths, all, dirSet) {
  const out = /* @__PURE__ */ new Set();
  const under = (rel) => appPaths.some((p) => rel.startsWith(`${p}/`));
  const byLower = new Map([...dirSet].map((d) => [d.toLowerCase(), d]));
  const add = (raw) => {
    const d = raw === void 0 ? void 0 : dirSet.has(raw) ? raw : byLower.get(raw.toLowerCase());
    if (d && d !== "." && !appPaths.some((p) => d === p || d.startsWith(`${p}/`))) out.add(d);
  };
  let budget = MAX_LINK_FILES;
  for (const rel of all) {
    if (!under(rel) || budget <= 0) continue;
    const base = path2.posix.basename(rel);
    if (base === "project.pbxproj") {
      budget--;
      const text = await readSmall(path2.join(root, rel), 8e6);
      const projDir = path2.posix.dirname(path2.posix.dirname(rel));
      for (const m of text?.matchAll(/\brelativePath\s*=\s*"?([^";\n]+)"?\s*;/g) ?? []) add(repoJoin(projDir, m[1].trim()));
    } else if (base === "Package.swift") {
      budget--;
      const text = await readSmall(path2.join(root, rel), 1e6);
      for (const m of text?.matchAll(/\.package\s*\(\s*(?:name\s*:\s*"[^"]*"\s*,\s*)?path\s*:\s*"([^"]+)"/g) ?? []) add(repoJoin(path2.posix.dirname(rel), m[1]));
    }
  }
  const wantedDeps = /* @__PURE__ */ new Set();
  for (const p of appPaths) {
    const text = await readSmall(path2.join(root, p, "package.json"), 1e6);
    if (!text) continue;
    try {
      const pkg = JSON.parse(text);
      for (const name of Object.keys(pkg.dependencies ?? {})) wantedDeps.add(name);
    } catch {
    }
  }
  if (wantedDeps.size) {
    for (const rel of all) {
      if (budget <= 0) break;
      if (path2.posix.basename(rel) !== "package.json" || rel === "package.json" || under(rel) || rel.split("/").length > 4) continue;
      budget--;
      const text = await readSmall(path2.join(root, rel), 1e6);
      try {
        const name = JSON.parse(text ?? "").name;
        if (typeof name === "string" && wantedDeps.has(name)) add(path2.posix.dirname(rel));
      } catch {
      }
    }
  }
  return [...out];
}
async function detectAppRoots(root, all, dirs) {
  const found = /* @__PURE__ */ new Map();
  const parent = (p) => {
    const d = path2.posix.dirname(p);
    return d === "" ? "." : d;
  };
  const dirSet = new Set(dirs);
  const appConfigDirs = new Set(all.filter((p) => /^app\.(json|config\.(ts|js|mjs|cjs))$/.test(path2.posix.basename(p))).map(parent));
  const pkgs = all.filter((p) => path2.posix.basename(p) === "package.json" && p.split("/").length <= 4 && !NON_APP_DIR.test(p)).slice(0, MAX_LINK_FILES);
  for (const rel of pkgs) {
    const text = await readSmall(path2.join(root, rel), 1e6);
    let deps = {};
    try {
      const pkg = JSON.parse(text ?? "");
      deps = { ...pkg.devDependencies, ...pkg.dependencies };
    } catch {
      continue;
    }
    if (!("expo" in deps) && !("react-native" in deps)) continue;
    const dir = parent(rel);
    if (!appConfigDirs.has(dir) && !dirSet.has(dir === "." ? "ios" : `${dir}/ios`)) continue;
    found.set(dir, "expo" in deps ? "expo" : "react-native");
  }
  const jsRoots = [...found.keys()];
  const swiftDirs = [
    ...dirs.filter((d) => d.endsWith(".xcodeproj")).map(parent),
    ...all.filter((p) => path2.posix.basename(p) === "Project.swift").map(parent)
  ];
  for (const dir of swiftDirs) {
    if (NON_APP_DIR.test(`${dir}/`)) continue;
    if (jsRoots.some((r) => {
      const ios = r === "." ? "ios" : `${r}/ios`;
      return dir === ios || dir.startsWith(`${ios}/`);
    })) continue;
    if (!found.has(dir)) found.set(dir, "swift");
  }
  const within = (d, o) => o === "." ? d !== "." : d.startsWith(`${o}/`);
  const swallows = (d, pf, o, opf) => o !== d && within(d, o) && (o === "." ? pf === "swift" && opf === "swift" : pf === "swift" || opf !== "swift");
  const entries = [...found.entries()];
  const roots = entries.filter(([d, pf]) => !entries.some(([o, opf]) => swallows(d, pf, o, opf)));
  return roots.map(([p, platform]) => ({ path: p, platform })).sort((a, b) => a.path.localeCompare(b.path));
}
function appRootNotes(project) {
  const out = [...(project.configProblems ?? []).map((p) => `${APP_PATHS_CONFIG}: ${p}`)];
  const label = (r) => `${r.path} (${r.platform})`;
  if (project.appPaths?.length) {
    const scanned = (r) => project.appPaths.some((p) => r.path === p || r.path.startsWith(`${p}/`) || p.startsWith(`${r.path === "." ? "" : `${r.path}/`}`));
    const skippedRoots = project.appRoots.filter((r) => !scanned(r));
    out.push(`Scanning only appPaths from ${APP_PATHS_CONFIG}: ${project.appPaths.join(", ")}, plus repo-level store metadata and in-repo server code.${skippedRoots.length ? ` Not scanned: ${skippedRoots.map(label).join(", ")}.` : ""}`);
  } else if (project.appRoots.length > 1) {
    const n = project.appRoots.length;
    out.push(
      `Found ${n} app roots: ${project.appRoots.map(label).join(", ")}; scanning ${n === 2 ? "both" : `all ${n}`}. If only some ship, set "appPaths" in ${APP_PATHS_CONFIG} (for example {"appPaths": ["${project.appRoots[0].path}"]}) to scan just those.`
    );
  }
  return out;
}
var NON_APP_DIR = /(^|\/)(examples?|samples?|demos?|docs?|templates?|fixtures?|playground|storybook|probes?|spikes?)\//i;
function nestedAppRoot(all, dirs, files, appPaths = []) {
  const declares = (text) => {
    try {
      const pkg = JSON.parse(text);
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      return "react-native" in deps || "expo" in deps;
    } catch {
      return false;
    }
  };
  const candidates = files.filter((f) => (/^(?:[^/]+\/){1,2}package\.json$/.test(f.path) || appPaths.some((p) => f.path === `${p}/package.json`)) && !NON_APP_DIR.test(f.path) && declares(f.text)).map((f) => {
    const dir = f.path.slice(0, -"/package.json".length);
    const app = all.some((p) => p.startsWith(`${dir}/`) && /^app\.(json|config\.(ts|js|mjs|cjs))$/.test(p.slice(dir.length + 1))) || dirs.includes(`${dir}/ios`);
    return { dir, app, depth: dir.split("/").length };
  }).sort((a, b) => Number(b.app) - Number(a.app) || a.depth - b.depth || a.dir.localeCompare(b.dir));
  return candidates[0]?.dir;
}
function detectProject(root, all, dirs, files, appPaths = []) {
  const base = (p) => p.split("/").pop() ?? p;
  const xcodeProjects = dirs.filter((d) => d.endsWith(".xcodeproj"));
  const rootPkg = files.find((f) => f.path === "package.json")?.text ?? "";
  const rootIsApp = /"(react-native|expo)"\s*:/.test(rootPkg);
  const appRoot = rootIsApp ? void 0 : nestedAppRoot(all, dirs, files, appPaths);
  const prefix = appRoot ? `${appRoot}/` : "";
  const packageJson = all.find((p) => p === `${prefix}package.json`);
  const pkgText = files.find((f) => f.path === packageJson)?.text ?? "";
  const expoConfig = all.find((p) => p.startsWith(prefix) && /^app\.(json|config\.(ts|js|mjs|cjs))$/.test(p.slice(prefix.length)));
  const platforms = [];
  if (xcodeProjects.length || all.some((p) => p.endsWith(".swift") || base(p) === "Package.swift")) platforms.push("swift");
  if (/"react-native"\s*:/.test(pkgText)) platforms.push("react-native");
  if (/"expo"\s*:/.test(pkgText) || expoConfig && /"expo"\s*:/.test(files.find((f) => f.path === expoConfig)?.text ?? "")) {
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
    ...appRoot ? { appRoot } : {},
    metadataDirs: ["metadata", "fastlane/metadata", ...appPaths.flatMap((p) => [`${p}/metadata`, `${p}/fastlane/metadata`])].filter((d) => dirs.includes(d)),
    appRoots: []
  };
}

// src/remediation/built.ts
import { execFile as execFile2 } from "node:child_process";
import { constants as fsc2, createReadStream, createWriteStream, open as openCb } from "node:fs";
import { lstat as lstat2, mkdir, mkdtemp, open as open3, readdir as readdir3, rm, stat as stat2 } from "node:fs/promises";
import { tmpdir } from "node:os";
import path5 from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify as promisify2 } from "node:util";
import { createInflateRaw } from "node:zlib";

// src/remediation/fsread.ts
import { constants as fsc } from "node:fs";
import { lstat, open as open2, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path3 from "node:path";
var RESULTS_MAX_BYTES = 5 * 1024 * 1024;
var EVIDENCE_MAX_BYTES = 10 * 1024 * 1024;
async function readRegularFile(file2, max, what, within) {
  const st = await lstat(file2);
  if (st.isSymbolicLink()) throw new Error(`${what} ${file2} is a symbolic link; pass the file it points to`);
  if (!st.isFile()) throw new Error(`${what} ${file2} is not a regular file`);
  if (st.size > max) throw new Error(`${what} ${file2} is ${st.size} bytes (limit ${max})`);
  if (within) {
    const [real, base] = await Promise.all([realpath(file2), realpath(within)]);
    if (!real.startsWith(base + path3.sep)) throw new Error(`${what} ${file2} resolves outside ${within}`);
  }
  const fh = await open2(file2, fsc.O_RDONLY | fsc.O_NOFOLLOW | (fsc.O_NONBLOCK ?? 0));
  try {
    const fst = await fh.stat();
    if (!fst.isFile() || fst.ino !== st.ino || fst.dev !== st.dev) throw new Error(`${what} ${file2} changed while it was being opened`);
    if (fst.size > max) throw new Error(`${what} ${file2} is ${fst.size} bytes (limit ${max})`);
    const buf = Buffer.alloc(fst.size + 1);
    let n = 0;
    for (; ; ) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
      if (!bytesRead) break;
      n += bytesRead;
      if (n > fst.size) throw new Error(`${what} ${file2} grew while it was being read`);
    }
    return buf.subarray(0, n);
  } finally {
    await fh.close();
  }
}
function insideHiddenDir(file2, home) {
  const rel = path3.relative(home, file2);
  return !rel.startsWith("..") && !path3.isAbsolute(rel) && rel.split(path3.sep).some((part) => part.startsWith("."));
}
async function vetClientPath(file2, what) {
  const abs = path3.resolve(file2);
  const st = await lstat(abs);
  if (st.isSymbolicLink()) throw new Error(`${what} ${abs} is a symbolic link; pass the path it points to`);
  const real = await realpath(abs);
  const home = homedir();
  const realHome = await realpath(home).catch(() => home);
  if ([abs, real].some((p) => insideHiddenDir(p, home) || insideHiddenDir(p, realHome))) {
    throw new Error(`${what} ${abs} is inside a hidden directory in your home folder; it is not read from there`);
  }
  return real;
}

// src/remediation/surface.ts
import { execFile } from "node:child_process";
import { existsSync as existsSync2 } from "node:fs";
import { readdir as readdir2 } from "node:fs/promises";
import path4 from "node:path";
import { promisify } from "node:util";

// src/rules/genai.ts
var PROVIDERS = [
  {
    id: "openai",
    name: "OpenAI",
    kind: "cloud",
    media: ["text", "image", "audio", "video"],
    sdk: /(from\s+["']openai["']|require\(\s*["']openai["']\s*\)|(?<=^[ \t]{0,64})import\s+(OpenAI|OpenAIKit|SwiftOpenAI|OpenAISwift)\b|["']@ai-sdk\/openai["']|MacPaw\/OpenAI|"openai"\s*:\s*"[~^]?\d|@langchain\/openai)/m,
    hosts: /\bapi\.openai\.com\b/
  },
  {
    id: "anthropic",
    name: "Anthropic",
    kind: "cloud",
    media: ["text"],
    sdk: /(["']@anthropic-ai\/sdk["']|["']@ai-sdk\/anthropic["']|(?<=^[ \t]{0,64})import\s+(SwiftAnthropic|Anthropic)\b|SwiftAnthropic\.git|"@anthropic-ai\/sdk"\s*:)/m,
    hosts: /\bapi\.anthropic\.com\b/
  },
  {
    id: "gemini",
    name: "Google Gemini / Vertex AI (incl. Firebase AI Logic)",
    kind: "cloud",
    media: ["text", "image", "video"],
    sdk: /(["']@google\/(generative-ai|genai)["']|["']@google-cloud\/vertexai["']|["']firebase\/(vertexai|ai)["']|["']@react-native-firebase\/(vertexai|ai)["']|["']@ai-sdk\/google(-vertex)?["']|(?<=^[ \t]{0,64})import\s+(GoogleGenerativeAI|FirebaseVertexAI|FirebaseAI|FirebaseAILogic)\b|generative-ai-swift|FirebaseAI\.firebaseAI|VertexAI\.vertexAI|\bgetGenerativeModel\s*\(|\bgetImagenModel\s*\()/m,
    hosts: /\b(generativelanguage|aiplatform|firebasevertexai|firebaseml)\.googleapis\.com\b/
  },
  {
    id: "replicate",
    name: "Replicate",
    kind: "cloud",
    media: ["text", "image", "video", "audio"],
    sdk: /(from\s+["']replicate["']|require\(\s*["']replicate["']\s*\)|(?<=^[ \t]{0,64})import\s+Replicate\b|replicate\/replicate-swift|"replicate"\s*:\s*"[~^]?\d)/m,
    hosts: /\b(api\.replicate\.com|replicate\.delivery)\b/
  },
  {
    id: "fal",
    name: "fal.ai",
    kind: "cloud",
    media: ["image", "video", "audio", "text"],
    sdk: /(["']@fal-ai\/(client|serverless-client|react-native|serverless-proxy)["']|(?<=^[ \t]{0,64})import\s+FalClient\b|fal-ai\/fal-swift)/m,
    hosts: /\b((queue\.|rest\.|ws\.)?fal\.run|fal\.media|(api\.|rest\.)?fal\.ai)\b/
  },
  {
    id: "stability",
    name: "Stability AI",
    kind: "cloud",
    media: ["image", "video"],
    sdk: /(["']@stability-ai\/[\w-]+["']|stability_sdk|\bStabilityAIClient\b)/,
    hosts: /\bapi\.stability\.ai\b/
  },
  {
    id: "together",
    name: "Together AI",
    kind: "cloud",
    media: ["text", "image"],
    sdk: /(["']together-ai["']|["']@ai-sdk\/togetherai["'])/,
    hosts: /\bapi\.together\.(xyz|ai)\b/
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "cloud",
    media: ["text", "image"],
    sdk: /["']@openrouter\/[\w-]+["']/,
    hosts: /\bopenrouter\.ai\b/
  },
  {
    id: "groq",
    name: "Groq",
    kind: "cloud",
    media: ["text", "audio"],
    sdk: /(["']groq-sdk["']|["']@ai-sdk\/groq["'])/,
    hosts: /\bapi\.groq\.com\b/
  },
  {
    id: "xai",
    name: "xAI",
    kind: "cloud",
    media: ["text", "image"],
    sdk: /(["']@ai-sdk\/xai["']|["']xai-sdk["'])/,
    hosts: /\bapi\.x\.ai\b/
  },
  {
    id: "bfl",
    name: "Black Forest Labs",
    kind: "cloud",
    media: ["image"],
    sdk: /["']@bfl[\w-]*\/[\w-]+["']/,
    hosts: /\b((api|api\.us1|api\.eu1)\.)?bfl\.(ai|ml)\b/
  },
  {
    id: "huggingface",
    name: "Hugging Face Inference",
    kind: "cloud",
    media: ["text", "image", "audio"],
    sdk: /["']@huggingface\/inference["']/,
    hosts: /\b(api-inference\.huggingface\.co|router\.huggingface\.co)\b|(?<![\w-])[\w-]{1,100}\.(endpoints\.huggingface\.cloud|hf\.space)\b/
  },
  {
    id: "runway",
    name: "Runway",
    kind: "cloud",
    media: ["video", "image"],
    sdk: /["']@runwayml\/sdk["']/,
    hosts: /\bapi\.(dev\.)?runwayml\.com\b/
  },
  {
    id: "leonardo",
    name: "Leonardo.Ai",
    kind: "cloud",
    media: ["image", "video"],
    sdk: /["']@leonardo-ai\/sdk["']/,
    hosts: /\bcloud\.leonardo\.ai\b/
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    kind: "cloud",
    media: ["audio"],
    sdk: /(["']@elevenlabs\/[\w-]+["']|from\s+["']elevenlabs["']|(?<=^[ \t]{0,64})import\s+ElevenLabs\w*\b)/m,
    hosts: /\bapi\.elevenlabs\.io\b/
  },
  {
    id: "bedrock",
    name: "Amazon Bedrock",
    kind: "cloud",
    media: ["text", "image"],
    sdk: /["']@aws-sdk\/client-bedrock(-runtime|-agent-runtime)?["']|\bBedrockRuntimeClient\b|\bAWSBedrockRuntime\b/,
    hosts: /\bbedrock-runtime\.[\w-]+\.amazonaws\.com\b/
  },
  {
    id: "mistral",
    name: "Mistral AI",
    kind: "cloud",
    media: ["text"],
    sdk: /["']@mistralai\/mistralai["']|["']@ai-sdk\/mistral["']/,
    hosts: /\bapi\.mistral\.ai\b/
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    kind: "cloud",
    media: ["text"],
    sdk: /["']@ai-sdk\/deepseek["']/,
    hosts: /\bapi\.deepseek\.com\b/
  },
  {
    id: "cloudflare-ai",
    name: "Cloudflare Workers AI",
    kind: "cloud",
    media: ["text", "image", "audio"],
    sdk: /\benv\.AI\.run\s*\(|["']@cf\/[\w.-]+\/[\w.-]+["']|["']workers-ai-provider["']/,
    hosts: /\bapi\.cloudflare\.com\/client\/v4\/accounts\/[^"'`\s]*\/ai\/run\b/
  },
  {
    id: "coreml",
    name: "Core ML (on-device)",
    kind: "on-device",
    media: [],
    sdk: /((?<=^[ \t]{0,64})import\s+CoreML\b|(?<![\w-])[\w-]{1,200}\.ml(model|modelc|package)\b|\bMLModel\s*\(\s*contentsOf|\bMLModelConfiguration\s*\()/m
  },
  {
    id: "mlx",
    name: "MLX (on-device)",
    kind: "on-device",
    media: ["text", "image"],
    sdk: /((?<=^[ \t]{0,64})import\s+MLX(LLM|LMCommon|VLM|Swift)?\b|ml-explore\/mlx-swift)/m
  },
  {
    id: "llamacpp",
    name: "llama.cpp (on-device)",
    kind: "on-device",
    media: ["text"],
    sdk: /((?<=^[ \t]{0,64})import\s+(?:llama|llmfarm_core|SwiftLlama)\b|\bllama_(init_from_file|load_model_from_file|model_load_from_file|new_context_with_model|init_from_model)\b|\bLlamaContext\b|["']llama\.rn["']|(ggerganov|ggml-org)\/llama\.cpp|(?<![\w.-])[\w.-]{1,200}\.gguf\b)/m
  },
  {
    id: "foundationmodels",
    name: "Apple Foundation Models (on-device)",
    kind: "on-device",
    media: ["text"],
    sdk: /((?<=^[ \t]{0,64})import\s+FoundationModels\b|\bLanguageModelSession\b|\bSystemLanguageModel\b)/m,
    builtInModeration: "text"
  },
  {
    id: "imageplayground",
    name: "Apple Image Playground (on-device)",
    kind: "on-device",
    media: ["image"],
    sdk: /((?<=^[ \t]{0,64})import\s+ImagePlayground\b|\bImagePlaygroundSheet\b|\.imagePlaygroundSheet\s*\(|\bImageCreator\s*\()/m,
    builtInModeration: "both"
  },
  {
    id: "stablediffusion-ondevice",
    name: "Stable Diffusion (on-device, Core ML)",
    kind: "on-device",
    media: ["image"],
    sdk: /((?<=^[ \t]{0,64})import\s+StableDiffusion\b|\bStableDiffusionPipeline\b|apple\/ml-stable-diffusion)/m,
    // apple/ml-stable-diffusion runs its SafetyChecker model and drops flagged images unless `disableSafety` is true.
    defaultSafety: { kind: "image", label: "Apple ml-stable-diffusion safety checker (on unless disableSafety is set)", offRule: "stability_safety_off" }
  },
  {
    // The same package's SDXL and SD3 pipelines load no SafetyChecker model, so the default
    // checker above never runs on their output.
    id: "stablediffusion-xl-ondevice",
    name: "Stable Diffusion XL / 3 (on-device, Core ML; no built-in safety checker)",
    kind: "on-device",
    media: ["image"],
    sdk: /\bStableDiffusion(?:XL|3)Pipeline\b|coreml-stable-diffusion-(?:xl|3)[\w.-]*/
  }
];
var NO_SAFETY_CHECKER_PROVIDERS = /* @__PURE__ */ new Set(["stablediffusion-xl-ondevice"]);
var AMBIGUOUS_IMAGE_NAMES = "textToImage|text_to_image|txt2img|sd3|ImageCreator";
var AMBIGUOUS_TEXT_NAMES = "generateContent(?:Stream)?|ChatQuery|chatCompletion(?:Stream)?|textGeneration";
var SMS_SDK = /["'](?:twilio|telnyx|@vonage\/[\w-]+|plivo|messagebird|@sinch\/[\w-]+)["']|\b(?:twilio|telnyx|plivo)\s*\(|\bTwilio\b/;
var SINKS = [
  { kind: "text", rx: /\b(chat\.completions\.create|completions\.create)\b/ },
  // `generateContent` is also a SwiftUI layout-helper name (WrappingHStack), `ChatQuery` an Apollo
  // codegen class: they count only with a generator in the project, and never as the app's own declaration.
  {
    kind: "text",
    rx: new RegExp(`\\b(${AMBIGUOUS_TEXT_NAMES})\\b(?!\\s*\\(\\s*in\\s*:)`),
    requires: "generativeProviderInProject",
    declared: new RegExp(`\\b(?:func|function|def|class|struct|enum|protocol|interface|type|typealias)\\s+(${AMBIGUOUS_TEXT_NAMES})\\b|\\b(?:const|let|var)\\s+(${AMBIGUOUS_TEXT_NAMES})\\s*=\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>)`),
    declaredSkip: "unqualified"
  },
  // `messages.create` / `responses.create` are also Twilio, Telnyx, Vonage and Plivo SMS calls.
  { kind: "text", rx: /\b\w*(?:anthropic|Anthropic|claude|Claude|openai|openAI|OpenAI)\w*\.(?:messages\.(?:create|stream)|responses\.create)\b/ },
  { kind: "text", rx: /\b(messages\.(create|stream)|responses\.create)\b/, requires: "providerInFile", skipInFile: SMS_SDK },
  { kind: "text", rx: /\.(chats|chatsStream)\s*\(\s*query|\bstartChat\s*\(|\bsendMessage(Stream)?\s*\(|\b(generateText|streamText|generateObject|streamObject)\s*\(|\.respond\s*\(\s*to\s*:|\.streamResponse\s*\(\s*to\s*:|\bllama_decode\s*\(/, requires: "providerInFile" },
  // llama.rn's `context.completion(params, onToken)`; not a Swift `self.completion(.success(…))` handler.
  { kind: "text", rx: /\.completion\s*\((?!\s*[.)])/, requires: "providerInFile", skipInFile: /^[ \t]*import\s+(?:Foundation|SwiftUI|UIKit)\b/m },
  // MLX Swift's token loop (`MLXLMCommon.generate(input:parameters:context:)`) and its ChatSession.
  { kind: "text", rx: /\bMLXLMCommon\.generate\s*\(|(?<![\w.])generate\s*\(\s*input\s*:|\bChatSession\s*\(/, requires: "providerInFile" },
  { kind: "image", rx: /\bStableDiffusion(?:XL|3)Pipeline\b/, provider: "stablediffusion-xl-ondevice" },
  { kind: "image", rx: /\b(images\.generate|images\.create|ImagesQuery|generateImages|stable-image\/generate)\b|\.images\s*\(\s*query|\bImagePlaygroundSheet\b|\.imagePlaygroundSheet\s*\(|\bStableDiffusionPipeline\b/ },
  {
    kind: "image",
    rx: new RegExp(`\\b(${AMBIGUOUS_IMAGE_NAMES})\\b`),
    requires: "providerInProject",
    mention: true,
    declared: new RegExp(
      `\\b(?:func|function|def|class|struct|enum|protocol|interface|type|typealias)\\s+(${AMBIGUOUS_IMAGE_NAMES})\\b|\\b(?:const|let|var)\\s+(${AMBIGUOUS_IMAGE_NAMES})\\s*=\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>)`
    )
  },
  { kind: "image", rx: /["'`][^"'`\n]*\b(dall-e-\d|gpt-image-[\w.]+|imagen-[\w.-]+|gemini-[\d.]+-flash-image[\w-]*|flux[\w.-]*|sdxl[\w-]*|stable-diffusion[\w.-]*|ideogram[\w.-]*|recraft[\w.-]*|seedream[\w.-]*|hidream[\w.-]*|playground-v[\w.-]*|leonardo-[\w.-]+|grok-2-image[\w-]*)\b[^"'`\n]*["'`]/i, requires: "providerInProject", mention: true },
  { kind: "image-edit", rx: /\b(images\.edit|images\/edits|ImageEditsQuery|imageEdits|image-to-image|image_to_image|imageToImage|img2img|inpaint\w*|outpaint\w*|stable-image\/edit|init_image|input_image|image_prompt|kontext[\w-]*|face[-_]?swap\w*|faceSwap\w*|FaceSwap\w*)\b/, requires: "providerInProject" },
  { kind: "video", rx: /\b(image_to_video|imageToVideo|image-to-video|text_to_video|textToVideo|text-to-video|videos\.create|veo-[\w.-]+|sora-[\w.-]+|gen4[\w_-]*|kling[\w.-]*|hunyuan-video|ltx-video|wan-?2[\w.-]*)\b/, requires: "providerInProject" },
  // Speech-to-text is listed separately by the scanner: it reads content but generates none.
  { kind: "audio", rx: /\b(textToSpeech|text_to_speech|text-to-speech|speech\.create|audio\.speech)\b/, requires: "providerInProject" },
  { kind: "generation", rx: /\b(replicate\.run|replicate\.predictions\.create|predictions\.create|fal\.subscribe|fal\.run|fal\.queue\.submit|fal\.stream)\s*\(/ }
];
var ENDPOINT_MEDIA = [
  { kind: "image-edit", rx: /\/images\/(?:edits|variations)\b/ },
  { kind: "image", rx: /\/images\/generations\b|:predict\b[^"'`\n]*imagen|\/imagen[\w.-]*:predict\b/ },
  { kind: "audio", rx: /\/audio\/speech\b|\/text-to-speech\b/ },
  { kind: "video", rx: /\/videos\b|:predictLongRunning\b/ },
  // Not Gemini's `:generateContent`: the same path serves its image models.
  { kind: "text", rx: /\/(?:chat\/completions|completions|responses|messages)\b/ }
];
var VIDEO_OUTPUT = /\b(?:VideoPlayer|AVPlayer|AVPlayerItem)\s*\(|["']?\b(?:num_frames|frames_per_second|motion_bucket_id|video_length)\b["']?\s*[:=]/;
var IMAGE_OUTPUT = /\b(?:UIImage|NSImage)\s*\(\s*data\s*:|\bCGImage\w*Create\w*\s*\(|["']?\b(?:num_inference_steps|guidance_scale|negative_prompt|image_size|num_outputs)\b["']?\s*[:=]/;
var LOOKUP_LINE = /[!=]==?\s*["'`]|["'`]\s*[!=]==?|^\s*case\s+["'`.]/;
var SOURCES = [
  { kind: "text", rx: /\b(TextField|TextEditor)\s*\(|\bUITextView\b|\bUITextField\b|<TextInput\b/ },
  { kind: "photo", rx: /\bPhotosPicker\b|\.photosPicker\s*\(|\bPHPickerViewController\b|\bUIImagePickerController\b|["']expo-image-picker["']|\blaunchImageLibrary(Async)?\s*\(|["']react-native-image-picker["']|["']react-native-image-crop-picker["']|\bImagePicker\.openPicker\b|\bPhotosPickerItem\b/ },
  { kind: "camera", rx: /\bAVCapturePhotoOutput\b|\bAVCaptureSession\b|\blaunchCamera(Async)?\s*\(|["']expo-camera["']|["']react-native-vision-camera["']|\btakePictureAsync\b|\bImagePicker\.openCamera\b|sourceType\s*=\s*\.camera/ },
  { kind: "health", rx: /\bHKHealthStore\s*\(|\bHK(?:Sample|Statistics|StatisticsCollection|Anchored|Observer|Correlation)Query\b|["'](?:react-native-health|@kingstinct\/react-native-healthkit|react-native-health-connect)["']/ },
  { kind: "calendar", rx: /\bEKEventStore\s*\(|["'](?:expo-calendar|react-native-calendar-events)["']/ },
  { kind: "mic", rx: /\bAVAudioRecorder\b|\bSFSpeechRecognizer\b|\.inputNode\b|\bAudio\.Recording\b|\buseAudioRecorder\b|["']expo-audio["']|["']@react-native-voice\/voice["']|["']react-native-audio-recorder-player["']|\bSpeechAnalyzer\b|\bSpeechTranscriber\b/ }
];
var PROMPTS = [
  { kind: "system", rx: /\brole\s*:\s*["']system["']|"role"\s*:\s*"system"|\bsystemInstruction\b|\bsystem_instruction\b|\bsystemPrompt\b|\bsystem_prompt\b|\bSYSTEM_PROMPT\b|\bsystem\s*:\s*["'`]|\.system\s*\(/ },
  { kind: "system", rx: /\bLanguageModelSession\s*\([^)]*instructions\s*:|\binstructions\s*:\s*["'`]/, requires: "providerInProject" },
  // The value must be prompt text, a list or a definition: `companionOk = false` or
  // `companionSent = 0` counts a notification job ("companion nudges"), not a persona.
  { kind: "persona", rx: /\b\w*(persona|Persona|companion|Companion|girlfriend|Girlfriend|boyfriend|Boyfriend|waifu|Waifu|roleplay|Roleplay|characterPresets|CharacterPresets)\w*\s*(?::\s*[\w.<>[\]?]+\s*=|[:=](?!=))\s*(?:["'`[{]|\w*(?:Persona|Character|Companion)\w*\s*\()/, requires: "providerInProject" },
  { kind: "template", rx: /\b\w*(promptTemplates?|PromptTemplates?|stylePresets?|StylePresets?|promptPresets?|PromptPresets?|PROMPT_TEMPLATES?|prompt_templates?)\b\s*[:=]/, requires: "providerInProject" }
];
var MODERATION_IMAGE_INPUT = /["']?\b(?:image_url|imageUrl|imageURL)\b["']?\s*[:=]|["']type["']\s*[:=]\s*["']image_url["']|\.imageUrl\s*\(|data:image\/|\bModerationsQuery\.Input\.image\b/;
var MODERATION_REQUEST_WINDOW = 800;
var MODERATION_HELPER_IMAGE = new RegExp(`[Mm]oderat\\w*\\s*\\([^;)]{0,200}?(?:${MODERATION_IMAGE_INPUT.source})`);
var MODERATION = [
  // Before the endpoint rule: on a line with both, the item keeps the model's label.
  { kind: "both", label: "OpenAI omni-moderation (text + image)", rx: /\bomni-moderation[\w.-]*/, imageInput: MODERATION_IMAGE_INPUT },
  { kind: "text", label: "OpenAI text moderation model", rx: /\btext-moderation-[\w.-]+/ },
  // The endpoint classifies images too (omni-moderation is its default model) when the request carries one.
  { kind: "both", label: "OpenAI moderation endpoint (text + image)", rx: /\b(moderations\.create|ModerationsQuery)\b|\/v1\/moderations\b|\.moderations\s*\(\s*query/, imageInput: MODERATION_IMAGE_INPUT },
  { kind: "image", label: "image classifier", rx: /\b(SCSensitivityAnalyzer|SensitiveContentAnalysis|DetectModerationLabels(Command)?|detectModerationLabels|safeSearchDetection|SafeSearchAnnotation|NSFWDetector|NsfwDetector|NSFWClassifier|NsfwClassifier|ContentSafetyClient|analyzeImage)\b|["']nsfwjs["']|\bnsfwjs\b|\bsightengine\b|\bthehive\.ai\b|\bcontentsafety\b|image:analyze|shieldgemma-2[\w-]*|llama-?guard-?[\w.-]*vision[\w.-]*|nsfw[_-]?(image[_-])?(detection|detector|classifier)/i },
  { kind: "text", label: "safety classifier model", rx: /\b(llama-?guard[\w.-]*|shieldgemma[\w.-]*|LlamaGuard\w*|ShieldGemma\w*)\b|\bcommentanalyzer\.googleapis\.com\b|\bwebpurify\b/i },
  { kind: "text", label: "Gemini safetySettings at a blocking threshold", rx: /\b(BLOCK_LOW_AND_ABOVE|BLOCK_MEDIUM_AND_ABOVE|BLOCK_ONLY_HIGH|blockLowAndAbove|blockMediumAndAbove|blockOnlyHigh)\b/ },
  { kind: "image", label: "Imagen safety filter level", rx: /\b(block_most|block_some|block_low_and_above|block_medium_and_above|ImagenSafetyFilterLevel\.(blockLowAndAbove|blockMediumAndAbove|blockOnlyHigh))\b/ },
  { kind: "image", label: "provider output safety checker explicitly on", rx: /["']?enable_safety_checker["']?\s*[:=]\s*(true|True)\b|["']?disable_safety_checker["']?\s*[:=]\s*(false|False)\b|["']?safety_tolerance["']?\s*[:=]\s*["']?[0-2]\b|\bdisableSafety\s*[:=]\s*false\b/ },
  { kind: "text", label: "profanity / blocklist package", rx: /["'](bad-words|leo-profanity|obscenity|@2toad\/profanity|profanity-util|naughty-words|glin-profanity)["']/ },
  {
    kind: "text",
    label: "in-repo filter / blocklist",
    identifiersOnly: true,
    rx: /\b(moderat\w*|Moderat\w*|contentFilter\w*|ContentFilter\w*|content_filter\w*|profanity\w*|Profanity\w*|isProfane|blocklist|blockList|BlockList|BLOCKLIST|block_list|denylist|denyList|DenyList|deny_list|bannedWords|banned_words|bannedTerms|BannedTerms|BANNED_\w+|forbiddenWords|forbiddenTerms|FORBIDDEN_\w+|nsfwFilter|NSFWFilter|safetyFilter|SafetyFilter|filterPrompt|sanitizePrompt|validatePrompt|checkPromptSafety|isPromptSafe|isSafePrompt)\b/
  }
];
var IMAGE_OUTPUT_KINDS = ["image", "both"];
var SAFETY_DISABLED = [
  {
    id: "gemini_block_none",
    provider: "Gemini / Vertex / Firebase AI Logic",
    label: "safetySettings threshold BLOCK_NONE / OFF",
    rx: /\bBLOCK_NONE\b|\bHarmBlockThreshold\.(OFF|BLOCK_NONE|blockNone|off)\b|\bthreshold["']?\s*[:=]\s*["'](OFF|BLOCK_NONE|off|block_none)["']|\bthreshold\s*:\s*\.(blockNone|off)\b|\bImagenSafetyFilterLevel\.blockNone\b|\bsafety_?[Ff]ilter_?[Ll]evel["']?\s*[:=]\s*["'](block_none|BLOCK_NONE|blockNone|OFF)["']/,
    restore: "Remove the BLOCK_NONE / OFF thresholds so Gemini's default safety applies (or set BLOCK_MEDIUM_AND_ABOVE or stricter)"
  },
  {
    id: "replicate_safety_off",
    provider: "Replicate",
    label: "disable_safety_checker: true",
    rx: /["']?\bdisable_safety_checker["']?\s*[:=]\s*(true|True|1)\b/,
    restore: "Remove disable_safety_checker from the request so Replicate's safety checker runs"
  },
  {
    id: "fal_safety_off",
    provider: "fal.ai",
    label: "enable_safety_checker: false",
    rx: /["']?\b(enable_safety_checker|enableSafetyChecker)["']?\s*[:=]\s*(false|False|0)\b/,
    restore: "Remove enable_safety_checker: false (or set it to true) so fal.ai's safety checker runs"
  },
  {
    id: "bfl_tolerance_max",
    provider: "Black Forest Labs",
    label: "safety_tolerance >= 5",
    rx: /["']?\b(?:safety_tolerance|safetyTolerance)["']?\s*[:=]\s*["']?(\d+)\b/,
    minValue: 5,
    restore: "Remove the safety_tolerance override (or set it to 2 or lower) so Black Forest Labs' default moderation applies"
  },
  {
    id: "stability_safety_off",
    provider: "Stability / Stable Diffusion",
    label: "safety checker / filter disabled",
    rx: /\bdisableSafety\s*[:=]\s*true\b|["']?\bsafety_checker["']?\s*[:=]\s*(None|null|nil|false|False)\b|\brequires_safety_checker["']?\s*[:=]\s*(False|false)\b|["']?\b(safety_filter|safetyFilter|nsfw_filter|nsfwFilter)["']?\s*[:=]\s*(false|False|["']off["'])/,
    restore: "Remove the override so the safety checker runs (disableSafety false, safety_checker loaded)"
  }
];
var USER_SAFETY_TOGGLE = /\b(?:Toggle|Switch)\b[^\n]{0,160}?\b\w*(?:[Dd]isableSafety|[Ss]afetyChecker|safety_checker|[Ss]afetyFilter|safety_filter|[Nn]sfwFilter|nsfw_filter|[Ee]nableSafety)\w*/;
var UNSAFE_MODEL_TERM = /(uncensored|nsfw|abliterat\w*|porn\w*|hentai|(?<![a-z])nud(e|es|ity|ify)(?![a-z])|(?<![a-z])erotic\w*|(?<![a-z])lewd(?![a-z]))/i;
var MODEL_CLASSIFIER_EXCLUDE = /(detect|classif|filter|moderat|safety|checker|guard|scanner|censor(?!ed)|blocker)/i;
var MODEL_KEY_CONTEXT = /\b(model|modelId|model_id|modelName|model_name|models|lora|loras|lora_url|loraUrl|checkpoint|ckpt|base_model|baseModel|adapter|adapters|weights|version|repo|repoId|repo_id|endpoint|endpointId|modelPath|model_path|engine)\b\s*["']?\s*[:=(]/;
var MODEL_FILE_EXT = /\.(gguf|safetensors|ckpt|mlmodelc?|mlpackage|bin|pt|onnx)$/i;
var NUDIFY_STRONG = /\b(undress\w*|nudif\w*|deep-?nude\w*|(clothes|clothing)[ _-]?(off|remov\w*)|(naked|nude)[ -]?(ai|filter|mode|app|camera|maker|generator)|x-?ray[ -]+(cloth\w*|vision|camera|body|filter|effect|mode)|see[ -]?through[ -]+(cloth\w*|filter|mode|camera|vision|dress|shirt|effect))\b/i;
var NUDIFY_STRONG_IDENT = /\b\w*(undress|Undress|UNDRESS|nudif|Nudif|NUDIF|deepNude|DeepNude|deepnude|(xray|xRay|XRay|Xray)(Mode|Filter|Vision|Camera|Clothes)|clothesOff|ClothesOff|removeClothes|RemoveClothes|remove_clothes|clothingRemoval|ClothingRemoval|clothing_removal)\w*\b/;
var NUDIFY_CONTEXTUAL = [
  /\bremov\w*\s+(the\s+|her\s+|his\s+|their\s+|all\s+|any\s+|my\s+|your\s+)?(cloth(es|ing)|outfit|dress|shirt|top|bra|underwear|bikini|swimsuit)\b(?!\s+(item|items|from|piece|pieces|tag|tags|category|categories|listing))/i,
  /\btake\s+off\s+(her|his|their|the person'?s|the woman'?s|the man'?s)\s+(cloth(es|ing)|outfit|dress|shirt|top|bra|underwear|bikini|swimsuit)\b/i,
  /\bwithout\s+(any\s+)?(cloth(es|ing)|outfit)\b/i,
  // "nude" is also a cosmetics colour ("make lips a nude shade").
  /\b(make|turn|render|show|generate|create|edit)\b[^.!?\n]{0,40}\b(nude|naked|topless|unclothed)\b(?!\s*(lip\w*|shade\w*|tone\w*|colou?r\w*|palette|make-?up|polish|nail\w*|heel\w*|beige|pink|blush|gloss|eyeshadow|look))/i,
  /\b(nude|naked|topless|unclothed)\s+(photo|image|version|body|woman|women|man|men|girl|girls|boy|person|people|pic|picture|selfie)s?\b/i,
  /\b(change|replace|swap|transform|put|dress|turn)\b[^.!?\n]{0,40}\b(lingerie|underwear|nipples?|breasts?|genitals?)\b/i
];
var FACE_SWAP_SDK = /\b(inswapper[\w.-]*|insightface|facefusion|simswap|deepfacelab|ghost-?faceswap)\b/i;
var FACE_SWAP_TERM = /\b(face[ _-]?swap\w*|faceswap\w*|deep-?fakes?)\b/i;
var CELEBRITY_TERM = /\b(celebrit(y|ies)|famous\s+(people|person|actors?|actress(es)?|singers?|stars?|athletes?)|movie\s+stars?|pop\s+stars?)\b/i;
var LIKENESS_ACTION = /\b(photo|image|picture|pic|selfie|portrait|generate|create|render|swap|face|pose|with|as)\b/i;
var NEGATION_BEFORE = /\b(no|not|never|don'?t|do not|avoid|refuse\w*|disallow\w*|prohibit\w*|forbid\w*|block\w*|reject\w*|must not|cannot|can'?t|won'?t|ban\w*|against)\b[^.!?\n]{0,80}$/i;
var FILTER_CONTEXT = /\b\w*(block|Block|BLOCK|ban|Ban|BAN|forbid|Forbid|FORBID|deny|Deny|DENY|disallow|Disallow|DISALLOW|prohibit|Prohibit|PROHIBIT|reject|Reject|REJECT|unsafe|Unsafe|UNSAFE|moderat|Moderat|MODERAT|blacklist|Blacklist|BLACKLIST|stopword|StopWord|STOPWORD|badword|BadWord|BAD_WORD|profan|Profan|PROFAN|flagged|Flagged|FLAGGED|sensitive|Sensitive|SENSITIVE)\w*\b/;
var FILTER_CALL = /\b(contains|includes|matches|match|test|range\s*\(\s*of|hasPrefix|hasSuffix|indexOf|localizedCaseInsensitiveContains|localizedStandardContains|some|filter|reject|firstMatch|wholeMatch)\b/;
var UGC_DISPLAY = [
  // Vendor chat SDKs by import, package or their own class names. A prefix wildcard
  // (`StreamChat\w*`) also matched app types such as an LLM's `StreamChatParams`.
  /^[ \t]*(?:@testable\s+)?import\s+(StreamChat|StreamChatUI|StreamChatSwiftUI|SendbirdChatSDK|SendBirdSDK|SendbirdUIKit|SendBirdUIKit|CometChatSDK|CometChatPro|CometChatUIKitSwift|MessageKit|ExyteChat|PubNub|PubNubSDK|TwilioConversationsClient|TalkJS)\b/m,
  /\bChatClient\s*\(\s*config\s*:|\b(StreamChatClient|SendbirdChat\.(?:initialize|connect)|SendBird\.(?:initWithApplicationId|init|connect)|CometChat\.(?:init|login)|CometChatUIKit|GiftedChat|ConversationsClient|TalkSession|PubNub)\b|["'](stream-chat(?:-[\w-]+)?|@sendbird\/[\w-]+|@cometchat[\w/-]*|react-native-gifted-chat|@twilio\/conversations|talkjs|pubnub)["']/,
  /\b(collection|collectionGroup)\s*\(\s*["'](posts|comments|feed|feeds|stories|reels|replies|community|publicPosts|publicImages|sharedImages|publicCreations)["']/,
  /\.from\s*\(\s*["'](posts|comments|feed|feeds|stories|reels|replies|community|public_posts|public_images|shared_images|public_creations)["']\s*\)/,
  // `createComment` is also the DOM's `document.createComment()`: a call on a document is markup, not a post.
  /\b(createPost|submitPost|publishPost|uploadPost|addComment|postComment|submitComment|createComment(?<!\b(?:document|ownerDocument|doc|[\w$]*Document)\s*\??\.\s*createComment)|publishCreation|shareToFeed|publishToFeed|shareToCommunity|postToCommunity|publishToCommunity|CommentsView|CommentList|CommentSection|CommunityFeed|PublicFeed|DiscoverFeed|ExploreFeed|CommunityView|DirectMessages?View|followUser|unfollowUser)\b/
];
var DOM_IMPLEMENTATION = /\bcreate(?:TextNode|CDATASection|ElementNS|DocumentFragment|ProcessingInstruction)\b/;
var PUBLIC_UGC = /\b(followUser|unfollowUser|Followers(?:View|List|Model|Screen)|[Cc]ommunity(?:Feed|View|Id|ID)|DiscoverFeed|ExploreFeed|PublicFeed|publicTimeline|PublicTimeline|shareToFeed|publishToFeed|shareToCommunity|postToCommunity|publishToCommunity|publishCreation|publicPosts|public_posts|publicCreations|public_creations)\b/;
var FOLLOWER_AUDIENCE = /\b([Ff]ollowers(?:Count)?|followers(?:View|List|Model|Screen)|[Ff]ollowerCount)\b/;
var COMMUNITY_AUDIENCE = /\b[Cc]ommunit(?:y|ies)\b/;
var COMMUNITY_NOT_AUDIENCE = /[Gg]uideline|[Hh]elp|[Ss]upport|[Pp]olic(?:y|ies)|[Rr]ules|[Ss]tandards/;
var UGC_MODERATION_STATE = [
  /\b(?:isDeletedOrFlagged|isFlagged|isRemovedByModerator|removedByModerator|removed_by_moderator|removedByAdmin|isModerated|moderation_?[Ss]tatus|moderationState|isHiddenByModerator|hiddenByModerator)\b/,
  /["'`][^"'`\n]{0,60}\b(?:(?:comment|post|message|reply|content|review|photo|video|image)s?\b[^"'`\n]{0,30}\b(?:has been|have been|was|were) (?:removed|hidden|flagged)\b|removed by (?:a |the )?(?:moderators?|admins?|administrators?|staff)\b|removed for violating\b|hidden by (?:the )?moderators?\b|violat(?:es|ed|ing) (?:our |the )?(?:community guidelines|content polic(?:y|ies)))[^"'`\n]{0,80}["'`]/i
];
var CONTENT_LABEL = /\b(?:\w*(?:[Nn]sfw|NSFW)\w*|\w*(?:[Cc]ontentWarning|content_warning|[Ss]ensitiveMedia|sensitive_media|[Ss]ensitiveContent|sensitive_content|[Mm]atureContent|mature_content|[Ee]xplicitContent)\w*|isSensitive|isMature|isExplicit|markAsSensitive)\b/;
var AI_CHAT_DISPLAY = /\b(?:Text|Markdown|MarkdownView|MarkdownText)\s*\(\s*(?:message|msg|reply|response|answer|turn|bubble|item|entry)\??\.(?:text|content|body|message)\b|\b[A-Z]\w*(?:Message|Reply|Response|Chat)\w*(?:Text|View|Bubble|Row|Cell)\s*\(\s*(?:message|msg|reply|response|turn)\s*:\s*(?:message|msg|reply|response|turn)\b|<(?:Text|Markdown)\b[^<>{}]{0,200}>\s*\{\s*(?:message|msg|reply|response|answer|item)\??\.(?:text|content|body)\s*\}/;
var AI_IMAGE_DISPLAY = /\bImage\s*\(\s*uiImage\s*:|\bAsyncImage\s*\(|<(?:Image|ExpoImage|FastImage)\b[^<>]{0,200}\bsource=/;
var REPORT_TEXT_WORD = /\b(?:message|response|reply|replies|chat|conversation|answer)s?\b|(?:Message|Response|Reply|Chat|Conversation|Answer)/;
var REPORT_VISUAL_WORD = /\b(?:image|photo|picture|video|avatar|artwork|generation|creation)s?\b|(?:Image|Photo|Picture|Video|Avatar|Artwork|Generation|Creation)/;
var REPORT_OBJECT = "(?:(?:[Tt]his|[Tt]hat|[Tt]he|[Aa]s|[Tt]o|[Aa]nd|[Pp]osts?|[Uu]sers?|[Mm]essages?|[Cc]omments?|[Cc]ontent|[Aa]buse|[Ii]mages?|[Pp]hotos?|[Vv]ideos?|[Rr]esponses?|[Rr]epl(?:y|ies)|[Aa]nswers?|[Gg]enerations?|[Cc]reations?|[Ii]tems?|[Cc]hats?|[Pp]rofiles?|[Aa]ccounts?|[Cc]onversations?|[Ii]nappropriate|[Oo]ffensive|[Hh]armful|[Ss]pam|[Hh]arassment|[Ss]tor(?:y|ies)|[Cc]reators?|[Cc]hannels?|[Gg]roups?|[Oo]utputs?|[Rr]esults?|[Cc]haracters?|[Mm]embers?|[Aa]uthors?|AI|POST|USER|CONTENT|MESSAGE)\\b|@|%@|%\\d+\\$@|\\\\\\(|\\$\\{|\\{)";
var REPORT = [
  /\b(report|flag)(Content|Post|User|Message|Comment|Abuse|Image|Photo|Video|Response|Reply|Generation|Creation|Item|Chat|Profile|Account|Conversation)\w*\b/,
  /\b(report|flag)_(content|post|user|message|comment|abuse|image|photo|response|generation)\b/,
  // Case-sensitive: lowercase "flag" / "report" literals are asset names, SF Symbols and emoji tags, not labels.
  /["'](Report|Flag)( this| as inappropriate| content| post| user| message| comment| abuse| image| photo| response| generation| conversation| reply)?(…|\.\.\.)?["']/,
  new RegExp(`>\\s*(?:Report|Flag)(?:\\s+${REPORT_OBJECT}[\\w ]{0,30})?\\s*<`),
  // A "Report …" label whose next word is what gets reported. Noun uses ("Report period",
  // "Report scope: …", "Report when nearby", Italian "Report ed esportazione") name an
  // analytics export or a crowd report, and "Report a bug" is feedback about the app.
  // Backticks too: Lingui labels are tagged templates (msg`Report post`).
  new RegExp(`["'\`](?:Report|Flag|REPORT|FLAG)(?:\\s+${REPORT_OBJECT}[^"'\`\\n]{0,40})?(?:\u2026|\\.\\.\\.)?["'\`]`),
  /\bReport(?!(?:s|Bug|Crash|Error|Issue|Problem|Feedback|Export|Period|Scope|Pdf|PDF|Csv|CSV|Chart|Summary|Card))\w*(?:Service|Sheet|View|Manager|Controller|Screen|Modal|Dialog|Button|Menu|Action)\b/,
  /\.report\(\s*(?:content|post|user|message|comment|image|photo|video|generation|creation|item|response|reply|chat|profile|reason)\s*:/
];
var BLOCK_USER = [
  /\b(block|mute|ban)(User|Account|Profile|Sender|Author|Member|Contact|Person)\w*\b/,
  /\bblocked_?(users?|user_?ids|userIds|accounts|profiles)\b/i,
  /["']Block( user| this user| account| @?%@| @?\{[^}]*\}| @?\$\{[^}]*\})?(…|\.\.\.)?["']/,
  />\s*Block(\s+[\w ]{0,30})?\s*</
];
var CONTACT = [
  /mailto:/,
  // The last label must be an alphabetic TLD that is not a file extension: "image@2x.png" is an asset name.
  /["'][\w.+-]+@(?!example\.|test\.|email\.|domain\.|yourdomain\.)[\w-]+(?:\.[\w-]+)*\.(?!(?:png|jpe?g|gif|pdf|svg|heic|webp|json|mp4|mov|caf|wav|mp3)["'])[a-zA-Z]{2,}["']/,
  /\b(support|help|contact)(Email|URL|Url|Link|Page|View|Screen)\b/,
  /\b(contactSupport|ContactUs\w*|ContactSupport\w*|MFMailComposeViewController)\b|["'](expo-mail-composer|react-native-mail)["']/,
  /["'](Contact (us|support|the developer)|Support|Help (&|and) Support|Get help|Send feedback|Email us)["']/i,
  /https?:\/\/[^"'\s]*\/(support|contact|help)\b|https?:\/\/(support|help)\./
];
var CONTACT_SAMPLE_LINE = /\b(mock|Mock|MOCK|preview|Preview|sample|Sample|fake|Fake|dummy|Dummy|placeholder|Placeholder)\w*|["']acct["']\s*:/;
var WEBSITE_LINK = /\bLink\s*\([^)]{0,120}destination\s*:\s*URL\s*\(\s*string\s*:\s*"https:\/\/|\bopenURL\s*\(\s*(?:URL\s*\(\s*string\s*:\s*)?["'`]https:\/\/|\bLinking\.openURL\s*\(\s*["'`]https:\/\/|\bSafariView\w*\s*\(\s*url\s*:\s*URL\s*\(\s*string\s*:\s*"https:\/\//;
var THIRD_PARTY_HOST = /https:\/\/(?:[\w-]+\.)*(?:apple\.com|huggingface\.co|google\.com|openai\.com|anthropic\.com|ollama\.(?:com|ai)|twitter\.com|x\.com|wikipedia\.org|creativecommons\.org|opensource\.org)\b/;
var ABOUT_SCREEN_PATH = /(about|settings?|credits|acknowledg\w*|info|support|help)[^/]*$/i;
var BUILD_TOOL_CONFIG = /(^|\/)(metro|webpack|babel|jest|vite|vitest|rollup|esbuild|eslint|prettier|tailwind|postcss|tsup|next|craco|react-native)\.config\.[cm]?[jt]s$|(^|\/)(webpack\.[\w.-]+\.[cm]?js|\.eslintrc(\.[cm]?js)?|\.babelrc(\.js)?)$/;
var AGE = [
  /\b(DeclaredAgeRange|AgeRangeService|requestAgeRange|ageRange\w*|AgeRange\w*|ageGate\w*|AgeGate\w*|isAdult|isOver(13|16|17|18)|over18|isMinor|isUnderage|minimumAge|verifyAge|ageVerification\w*|AgeVerification\w*|dateOfBirth|birthDate|date_of_birth)\b/,
  /["'][^"'\n]*\b(1[3678]\+|18 or older|over 18|at least 1[3678]|years old or older|confirm (your age|you are))[^"'\n]*["']/i
];
var AI_ACRONYM = /\bAI\b/;
var AI_PARTY = /artificial intelligence|\b(OpenAI|ChatGPT|GPT-?\d|Anthropic|Claude|Gemini|Vertex AI|Replicate|fal\.ai|Stability AI|Together AI|OpenRouter|Groq|xAI|Grok|Black Forest Labs|Hugging ?Face|Runway|Leonardo|ElevenLabs)\b|\bthird[- ]part(y|ies)\b|\bservice providers?\b/i;
var SHARE_VERB = /\b(shar\w*|sen[dt]|sending|process\w*|upload\w*|transmit\w*|disclos\w*|consent\w*|agree\w*|allow\w*|permission)\b/i;
var ANALYZE_VERB = /\banaly[sz]\w*/i;
var MARKETING_PATH = /paywall|subscri|premium|upgrade|pricing|\biap\b|(^|\/)(pro|plus|plans?)(view|screen|sheet|page)?\.\w+$/i;
var CONSENT_WORD = /(consent|agree|accept|disclos|acknowledg|optin|opt_in|permission)/i;
var AI_TOKENS = /* @__PURE__ */ new Set(["ai", "llm", "openai", "gemini", "gpt", "chatgpt", "claude", "anthropic", "genai", "thirdparty"]);

// src/scope.ts
var SIGNAL_PATTERNS = {
  flag: /\b(remoteConfig|RemoteConfig|configValue|getBoolean|getValue|getString|isFeatureEnabled|featureFlag|feature_flag|featureFlags|flags?\s*[.[]|useFlag|useFeatureFlag|useFeatureFlagEnabled|useGate|checkGate|getFeatureGate|variation|boolVariation|isEnabled|isOn|getFeatureValue|Statsig|LaunchDarkly|ldClient|posthog\.(isFeatureEnabled|getFeatureFlag)|unleash|growthbook|configcat|optimizely|RemoteSettings|serverConfig|remoteFlag|killSwitch|killswitch)\b/,
  environment: /\b(sandboxReceipt|appStoreReceiptURL|isTestFlight|isTestflight|testFlight|TestFlight|AppTransaction|\.environment\s*==|environment\s*==|\.sandbox\b|\.xcode\b|isSandbox|isReviewer|inReview|isInReview|reviewMode|review_mode|isAppReview|underReview|Bundle\.main\.appStoreReceiptURL|embedded\.mobileprovision)\b/,
  date: /\b(Date\(\)|Date\.now|new Date\(|launchDate|releaseDate|installDate|daysSince|daysSinceInstall|firstLaunch|timeIntervalSince(Now|1970|ReferenceDate)?|unlockDate|goLiveDate|approvalDate)\b/,
  region: /\b(Locale\.(current|preferred)|regionCode|countryCode|Storefront|storefront|countryCode|TimeZone\.current|timeZone|ipAddress|geoip|geoIP|clientIP|cf-ipcountry|CF-IPCountry|request\.cf|cupertino|Cupertino)\b/,
  debug: /(#if\s+DEBUG|__DEV__|\bisDebug\b|\bDEBUG\b|process\.env\.NODE_ENV)/,
  identity: /\b(reviewer|demoAccount|demo_account|testAccount|test_account|appleReview|APPLE_REVIEW|isDemoUser|userEmail\s*==|email\s*===?\s*["'])/
};
function signalsOf(text) {
  return Object.keys(SIGNAL_PATTERNS).filter((s) => SIGNAL_PATTERNS[s].test(text));
}
function blankStrings(code, ext) {
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
    } else if ((c === '"' && (!js || jsQuoteOpens(code, i)) || js && (c === "'" && jsQuoteOpens(code, i) || c === "`")) && !unclosed.covers(c, i)) {
      let j = i + 1;
      while (j < n && code[j] !== c) {
        if (code[j] === "\\") {
          out[j] = " ";
          j++;
          if (j < n && out[j] !== "\n") out[j] = " ";
          j++;
          continue;
        }
        if (code[j] === "\n" && c !== "`") break;
        if (out[j] !== "\n") out[j] = " ";
        j++;
      }
      if (j < n && code[j] === c) i = j + 1;
      else if (c === "`") i = n;
      else {
        for (let k = i + 1; k < Math.min(j, n); k++) out[k] = code[k];
        unclosed.record(c, j);
        i++;
      }
    } else {
      i++;
    }
  }
  return out.join("");
}
function stringNewlines(masked, ext) {
  const out = /* @__PURE__ */ new Set();
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
function bracketTables(masked) {
  const n = masked.length;
  const innerAt = new Int32Array(n + 1);
  const closeOf = new Int32Array(n).fill(-1);
  const stack = [];
  for (let k = 0; k < n; k++) {
    innerAt[k] = stack.length ? stack[stack.length - 1] : -1;
    const ch = masked.charCodeAt(k);
    if (ch === 123 || ch === 40) stack.push(k);
    else if (ch === 125 || ch === 41) {
      const want = ch === 125 ? 123 : 40;
      let j = stack.length - 1;
      while (j >= 0 && masked.charCodeAt(stack[j]) !== want) j--;
      if (j >= 0) {
        closeOf[stack[j]] = k;
        stack.length = j;
      }
    }
  }
  innerAt[n] = stack.length ? stack[stack.length - 1] : -1;
  return { innerAt, closeOf };
}
var INDEX_CACHE = [];
var INDEX_CACHE_SIZE = 4;
function fileIndex(code, ext) {
  for (let i = 0; i < INDEX_CACHE.length; i++) {
    const e2 = INDEX_CACHE[i];
    if (e2.ext === ext && e2.code.length === code.length && e2.code === code) {
      if (i > 0) {
        INDEX_CACHE.splice(i, 1);
        INDEX_CACHE.unshift(e2);
      }
      return e2;
    }
  }
  const lineStarts3 = [0];
  for (let k = 0; k < code.length; k++) if (code.charCodeAt(k) === 10) lineStarts3.push(k + 1);
  const masked = blankStrings(code, ext);
  const directives = [];
  for (const m of masked.matchAll(/^[ \t]*(#(?:if|else|elseif|endif)\b[^\n]*)/gm)) {
    const offset = m.index ?? 0;
    const start = offset + m[0].length - m[1].length;
    directives.push({ offset, line: lineFromStarts(lineStarts3, offset), text: code.slice(start, offset + m[0].length).trim() });
  }
  const e = { code, ext, masked, lineStarts: lineStarts3, directives, ...bracketTables(masked), stringNewlines: stringNewlines(masked, ext), openers: /* @__PURE__ */ new Map() };
  INDEX_CACHE.unshift(e);
  if (INDEX_CACHE.length > INDEX_CACHE_SIZE) INDEX_CACHE.pop();
  return e;
}
function lineFromStarts(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = lo + hi + 1 >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}
function ternaryAt(t) {
  let depth = 0;
  for (let k = 0; k < t.length; k++) {
    const ch = t[k];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    else if (ch === "?" && depth === 0) {
      const nx = t[k + 1] ?? "";
      const pv = t[k - 1] ?? "";
      if (nx === "?" || nx === "." || pv === "?") {
        k++;
        continue;
      }
      if (/\s/.test(pv) || pv === ")" || /\s/.test(nx)) return k;
    }
  }
  return -1;
}
function branchOf(t) {
  const q = ternaryAt(t);
  if (q < 0) return void 0;
  let depth = 0;
  let nested = 0;
  for (let k = q + 1; k < t.length; k++) {
    const ch = t[k];
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
var CONTINUE_PREV = /(?:[&|:=(,.*<\[]|(?<![\w$)\]>])\?|(?<!\+)\+|(?<!-)-|=>|(?:^|[\s(\[,=&|?:!])!|\/)$/;
function continuesPrev(prev, ext) {
  if (!CONTINUE_PREV.test(prev)) return false;
  if (!prev.endsWith("/") || !isJsExt(ext)) return true;
  const ls = prev.lastIndexOf("\n") + 1;
  const open4 = prev.lastIndexOf("/", prev.length - 2);
  return !(open4 >= ls && jsRegexEnd(prev, open4) === prev.length - 1);
}
var CONTINUE_NEXT = /^(&&|\|\||\?(?![?.])|:|\.(?!\.)|==|!=|\+|-(?!-)|\*|\/(?![/*])|else\b|where\b|catch\b|finally\b)/;
function bareHeaderLine(fi, nl) {
  const masked = fi.masked;
  const ls = masked.lastIndexOf("\n", nl - 1) + 1;
  const line = masked.slice(ls, nl);
  const t = line.trim();
  if (/(^|[\s}])else$/.test(t)) return true;
  const m = /^(\}\s*)?(else\s+)?(if|while|for)\s*\(/.exec(t);
  if (!m) return false;
  const open4 = ls + (line.length - line.trimStart().length) + m[0].length - 1;
  const last = ls + line.trimEnd().length - 1;
  return fi.closeOf[open4] === last;
}
function headerBefore(fi, open4) {
  const { code, masked } = fi;
  let k = open4 - 1;
  let depth = 0;
  const floor = Math.max(0, open4 - 400);
  const braceOpener = masked[open4] === "{";
  while (k >= floor) {
    const ch = masked[k];
    if (ch === ")" || ch === "]") depth++;
    else if (ch === "(" || ch === "[") {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && (ch === ";" || ch === "{" || ch === "}")) break;
    else if (depth === 0 && ch === "\n" && !fi.stringNewlines.has(k)) {
      const next = masked.slice(k + 1, open4).trimStart();
      const prev = masked.slice(Math.max(floor, k - 200), k).trimEnd();
      const joined = continuesPrev(prev, fi.ext) || CONTINUE_NEXT.test(next) || braceOpener && next === "" || bareHeaderLine(fi, k);
      if (!joined || /^[ \t]*#/.test(masked.slice(masked.lastIndexOf("\n", k - 1) + 1, k))) break;
    }
    k--;
  }
  let start = k + 1;
  const span = masked.slice(start, open4);
  const elses = /\bguard\b/.test(span) ? [] : [...span.matchAll(/\belse\b/g)];
  const last = elses[elses.length - 1];
  if (last) start += (last.index ?? 0) + 4;
  return { text: code.slice(start, open4).replace(/\s+/g, " ").trim(), start };
}
function kindOf(header, opener) {
  if (/^(}\s*)?else\s+if\b|^if\b|^\}?\s*if\b/.test(header) || /\bif\b[^{]*$/.test(header)) return "if";
  if (/^guard\b/.test(header)) return "guard";
  if (/\bswitch\b|\bcase\b/.test(header)) return "switch";
  if (/\?\s*$/.test(header) || /:\s*$/.test(header)) return "ternary";
  if (/&&\s*$/.test(header)) return "and";
  return opener === "{" ? "block" : null;
}
function enclosingConditions(code, index, ext) {
  const fi = fileIndex(code, ext);
  const masked = fi.masked;
  const lineAt2 = (_t, i) => lineFromStarts(fi.lineStarts, i);
  const conditions = [];
  const stmt = headerBefore(fi, index);
  if (stmt.text && /(&&|\|\||\?|\bif\b|\bguard\b)/.test(stmt.text)) {
    const s = signalsOf(stmt.text);
    if (s.length) {
      const kind = /\bif\b/.test(stmt.text) ? "if" : /\?/.test(stmt.text) ? "ternary" : "and";
      conditions.push({ kind, text: stmt.text, line: lineAt2(code, stmt.start), signals: s, branch: branchOf(stmt.text) });
    }
  }
  let levels = 0;
  for (let k = fi.innerAt[Math.min(index, code.length)]; k >= 0 && levels < MAX_OPENERS; k = fi.innerAt[k], levels++) {
    const o = openerCondition(fi, k);
    if (!o) continue;
    if (o.jsx && o.jsx.from <= index) {
      const branch = o.jsx.cond.kind === "ternary" ? branchOf(masked.slice(k + 1, index)) : void 0;
      conditions.push({ ...o.jsx.cond, branch });
    } else if (o.cond) conditions.push(o.cond);
  }
  if (ext === "swift") {
    const scopeStart = enclosingBlockStart(fi, index);
    fi.guards ??= [...code.matchAll(/\bguard\b([^{]{0,400}?)\belse\s*\{/g)].map((m) => {
      const text = `guard${m[1]}`.replace(/\s+/g, " ").trim();
      return { offset: m.index ?? 0, end: (m.index ?? 0) + m[0].length, cond: { kind: "guard", text, line: lineAt2(code, m.index ?? 0), signals: signalsOf(text) } };
    });
    let lo = 0;
    let hi = fi.guards.length;
    while (lo < hi) {
      const mid = lo + hi >> 1;
      if (fi.guards[mid].offset < scopeStart) lo = mid + 1;
      else hi = mid;
    }
    for (let g = lo, n = 0; g < fi.guards.length && fi.guards[g].end <= index && n < MAX_OPENERS; g++, n++) conditions.push(fi.guards[g].cond);
  }
  const stack = [];
  for (const d of fi.directives) {
    if (d.offset >= index) break;
    const t = d.text;
    if (/^#if\b/.test(t)) stack.push({ text: t, line: d.line });
    else if (/^#endif\b/.test(t)) stack.pop();
    else if (/^#else\b|^#elseif\b/.test(t) && stack.length) stack[stack.length - 1] = { text: `${t} (of ${stack[stack.length - 1].text})`, line: d.line };
  }
  for (const s of stack) conditions.push({ kind: "#if", text: s.text, line: s.line, signals: signalsOf(s.text) });
  const signals = [...new Set(conditions.flatMap((c) => c.signals))];
  return { conditions, signals, confidence: conditions.length ? "medium" : "low" };
}
var MAX_OPENERS = 128;
function openerCondition(fi, k) {
  if (fi.openers.has(k)) return fi.openers.get(k);
  const { code, masked, ext } = fi;
  const lineAt2 = (i) => lineFromStarts(fi.lineStarts, i);
  let out;
  const ch = masked[k];
  if (ch === "(") {
    const h = headerBefore(fi, k);
    const kind = kindOf(h.text, "(");
    if (kind && kind !== "block") {
      out = { cond: { kind, text: h.text, line: lineAt2(h.start), signals: signalsOf(h.text), branch: kind === "ternary" ? branchOf(`${h.text} (`) : void 0 } };
    }
  } else if (ch === "{") {
    const h = headerBefore(fi, k);
    const kind = kindOf(h.text, "{") ?? "block";
    out = {};
    const after = code.slice(k + 1, Math.min(code.length, k + 200));
    const jsx = kind === "block" && isJsxContainer(fi, k, h.text, ext) ? /^\s*([^{};]*?)(&&|(?<!\?)\?(?![?.]))/.exec(after) : null;
    if (jsx && jsx[1]) {
      const text = jsx[1].trim() + ` ${jsx[2]}`;
      out.jsx = { from: k + 1 + jsx[0].length, cond: { kind: jsx[2] === "&&" ? "and" : "ternary", text, line: lineAt2(k), signals: signalsOf(text) } };
    }
    if (kind !== "block" || signalsOf(h.text).length) {
      const branch = kind === "ternary" || ternaryAt(h.text) >= 0 ? branchOf(`${h.text} {`) : void 0;
      out.cond = { kind, text: h.text, line: lineAt2(h.start), signals: signalsOf(h.text), branch };
    }
    if (!out.jsx && !out.cond) out = void 0;
  }
  fi.openers.set(k, out);
  return out;
}
function isJsxContainer(fi, k, header, ext) {
  if (!/^[cm]?[jt]sx?$/.test(ext)) return false;
  const { masked } = fi;
  let j = k - 1;
  while (j >= 0 && /\s/.test(masked[j])) j--;
  const prev = masked[j];
  if (prev === "}") return true;
  if (prev === ">") {
    if (masked[j - 1] === "=") return false;
    return !/\)\s*:|\b(function|class|interface|extends|implements|type)\b/.test(header);
  }
  if (prev === "=") {
    const before = masked.slice(Math.max(0, j - 400), j);
    if (!/(?:^|\s)[A-Za-z_$][\w$.:-]*$/.test(before)) return false;
    const lt = before.search(/<[A-Za-z][^<]*$/);
    if (lt < 0) return false;
    return !/[^=]>/.test(before.slice(lt));
  }
  return false;
}
function enclosingBlockStart(fi, index) {
  let levels = 0;
  for (let k = fi.innerAt[Math.min(index, fi.code.length)]; k >= 0; k = fi.innerAt[k]) {
    if (fi.masked[k] === "{" || ++levels >= MAX_OPENERS) return k + 1;
  }
  return 0;
}
function enclosingBraces(code, ext, index) {
  const fi = fileIndex(code, ext);
  for (let k = fi.innerAt[Math.min(index, code.length)]; k >= 0; k = fi.innerAt[k]) {
    if (fi.masked[k] === "{") return { open: k, close: fi.closeOf[k] >= 0 ? fi.closeOf[k] : code.length - 1 };
  }
  return void 0;
}
function isRuntimeGated(scope) {
  return scope.signals.some((s) => s !== "debug");
}
function isDebugOnly(scope) {
  return scope.conditions.some((c) => c.kind === "#if" && debugOnlyDirective(c.text)) || scope.conditions.some(requiresDev);
}
function debugOnlyDirective(text) {
  const m = /^#if\s+(.+)$/.exec(text.trim());
  if (!m || /#else/.test(text)) return false;
  const cond = m[1].replace(/\/\/.*$/, "").trim();
  if (/!\s*\(/.test(cond)) return false;
  const nonShipping = (term) => {
    const t = term.replace(/[()\s]/g, "");
    return t === "DEBUG" || t === "targetEnvironmentsimulator";
  };
  return cond.split("||").every((alt) => alt.split("&&").some(nonShipping));
}
function requiresDev(c) {
  if (c.kind === "#if" || !/__DEV__/.test(c.text)) return false;
  let v = DEV_VERDICTS.get(c);
  if (v === void 0) DEV_VERDICTS.set(c, v = devOnlyGuard(c.text, c.branch, 0));
  return v;
}
var DEV_VERDICTS = /* @__PURE__ */ new WeakMap();
function devOnlyGuard(text, branch, depth) {
  if (depth > 8 || !/__DEV__/.test(text)) return false;
  const lead = /^\s*(?:\}\s*)?(?:else\s+)?(?:if|while)\s*\(/.exec(text);
  if (lead) {
    const open4 = lead[0].length - 1;
    const close = matchingClose(text, open4);
    if (close < 0) return releaseValue(text.slice(open4 + 1)) === false;
    if (releaseValue(text.slice(open4 + 1, close)) === false) return true;
    return devOnlyGuard(text.slice(close + 1), void 0, depth + 1);
  }
  const q = ternaryAt(text);
  if (q >= 0) {
    const arm = branch ?? branchOf(text);
    const cond = releaseValue(stripPrefix(text.slice(0, q)));
    if (cond === (arm === "else")) return true;
    const colon = arm === "else" ? elseColon(text, q) : -1;
    const rest = arm === "else" ? colon >= 0 ? text.slice(colon + 1) : "" : text.slice(q + 1);
    return devOnlyGuard(rest, void 0, depth + 1);
  }
  const expr = stripPrefix(text);
  const op = lastLogicalOp(expr);
  if (!op || op.op === "??") return false;
  const left = releaseValue(expr.slice(0, op.at));
  return op.op === "&&" ? left === false : left === true;
}
function elseColon(t, q) {
  let depth = 0;
  let nested = 0;
  for (let k = q + 1; k < t.length; k++) {
    const ch = t[k];
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
function skipString(t, k) {
  const quote = t[k];
  for (let j = k + 1; j < t.length; j++) {
    if (t[j] === "\\") j++;
    else if (t[j] === quote) return j + 1;
  }
  return t.length;
}
function matchingClose(t, open4) {
  let depth = 0;
  for (let k = open4; k < t.length; k++) {
    const ch = t[k];
    if (ch === "'" || ch === '"' || ch === "`") {
      k = skipString(t, k) - 1;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (--depth === 0) return k;
    }
  }
  return -1;
}
function stripPrefix(t) {
  let cut = 0;
  const opens = [];
  for (let k = 0; k < t.length; k++) {
    const ch = t[k];
    if (ch === "'" || ch === '"' || ch === "`") {
      k = skipString(t, k) - 1;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      opens.push(k);
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      if (opens.pop() === void 0) cut = k + 1;
      continue;
    }
    if (opens.length) continue;
    if (ch === "," || ch === ";") cut = k + 1;
    else if (ch === ":" && t[k + 1] !== ":" && t[k - 1] !== ":") cut = k + 1;
    else if (ch === "=") {
      const pv = t[k - 1] ?? "";
      const nx = t[k + 1] ?? "";
      if (nx === ">") {
        cut = k + 2;
        k++;
      } else if (nx === "=") {
        while (t[k + 1] === "=") k++;
      } else if (!"=!<>".includes(pv)) cut = k + 1;
    }
  }
  const last = opens[opens.length - 1];
  if (last !== void 0 && last + 1 > cut) cut = last + 1;
  return t.slice(cut).replace(/^\s*(?:return|yield\*?|throw|case|else|do|export\s+default)\b/, "").trim();
}
function lastLogicalOp(t) {
  let found;
  let depth = 0;
  for (let k = 0; k < t.length; k++) {
    const ch = t[k];
    if (ch === "'" || ch === '"' || ch === "`") {
      k = skipString(t, k) - 1;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      const two = t.slice(k, k + 2);
      if (two === "&&" || two === "||" || two === "??") {
        if (t[k + 2] === "=") {
          k += 2;
          continue;
        }
        found = { op: two, at: k };
        k++;
      }
    }
  }
  return found;
}
function releaseValue(expr) {
  const toks = tokenize(expr);
  if (!toks) return void 0;
  let i = 0;
  const peek = () => toks[i];
  const isOp = (v) => peek()?.t === "op" && peek().v === v;
  const fail = /* @__PURE__ */ Symbol("fail");
  const parseTernary = () => {
    const c = parseOr();
    if (!isOp("?")) return c;
    i++;
    const a = parseTernary();
    if (!isOp(":")) throw fail;
    i++;
    const b = parseTernary();
    if (c === true) return a;
    if (c === false) return b;
    return a === b ? a : void 0;
  };
  const parseOr = () => {
    let a = parseAnd();
    while (isOp("||") || isOp("??")) {
      const op = toks[i++].v;
      const b = parseAnd();
      if (op === "??") a = typeof a === "boolean" ? a : void 0;
      else a = a === true || b === true ? true : a === false ? b : void 0;
    }
    return a;
  };
  const parseAnd = () => {
    let a = parseEq();
    while (isOp("&&")) {
      i++;
      const b = parseEq();
      a = a === false || b === false ? false : a === true ? b : void 0;
    }
    return a;
  };
  const parseEq = () => {
    let a = parseUnary();
    while (isOp("==") || isOp("===") || isOp("!=") || isOp("!==")) {
      const op = toks[i++].v;
      const b = parseUnary();
      if (typeof a !== "boolean" || typeof b !== "boolean") a = void 0;
      else a = op.startsWith("!") ? a !== b : a === b;
    }
    return a;
  };
  const parseUnary = () => {
    if (isOp("!")) {
      i++;
      const v = parseUnary();
      return v === void 0 ? void 0 : !v;
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
    return void 0;
  };
  try {
    const v = parseTernary();
    return i === toks.length ? v : void 0;
  } catch {
    return void 0;
  }
}
function tokenize(s) {
  const toks = [];
  let atom = "";
  const flush = () => {
    const v = atom.trim();
    if (v) toks.push({ t: "atom", v });
    atom = "";
  };
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    const three = s.slice(k, k + 3);
    const two = s.slice(k, k + 2);
    if (/\s/.test(ch)) {
      atom += ch;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const e = skipString(s, k);
      atom += s.slice(k, e);
      k = e - 1;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      if (atom.trim() || ch !== "(") {
        const close = matchingClose(s, k);
        if (close < 0) return void 0;
        atom += s.slice(k, close + 1);
        k = close;
        continue;
      }
      toks.push({ t: "op", v: "(" });
      continue;
    }
    if (ch === ")") {
      flush();
      toks.push({ t: "op", v: ")" });
      continue;
    }
    if (three === "===" || three === "!==") {
      flush();
      toks.push({ t: "op", v: three });
      k += 2;
      continue;
    }
    if (two === "=>") return void 0;
    if (two === "==" || two === "!=" || two === "&&" || two === "||" || two === "??") {
      flush();
      toks.push({ t: "op", v: two });
      k++;
      continue;
    }
    if (ch === "!") {
      if (atom.trim()) {
        atom += ch;
        continue;
      }
      toks.push({ t: "op", v: "!" });
      continue;
    }
    if (ch === "?") {
      if (s[k + 1] === "." && !/\d/.test(s[k + 2] ?? "")) {
        atom += "?.";
        k++;
        continue;
      }
      flush();
      toks.push({ t: "op", v: "?" });
      continue;
    }
    if (ch === ":") {
      flush();
      toks.push({ t: "op", v: ":" });
      continue;
    }
    atom += ch;
  }
  flush();
  for (let k = 1; k < toks.length; k++) {
    const a = toks[k - 1];
    const b = toks[k];
    if ((a.t === "atom" || a.v === ")") && (b.t === "atom" || b.v === "(")) return void 0;
  }
  return toks;
}

// src/rules/store.ts
var CODE_EXT_SET = new Set(CODE_EXTENSIONS);
var UI_TEXT_EXTS = /* @__PURE__ */ new Set([...CODE_EXTENSIONS, "strings", "xcstrings", "stringsdict"]);
var JS_EXTS2 = /* @__PURE__ */ new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs"]);
function isCode(f) {
  return CODE_EXT_SET.has(f.ext);
}
function isLocaleJson(f) {
  return f.ext === "json" && /(^|\/)(i18n|locales?|translations?|lang|strings)(\/|$)|(^|\/)[a-z]{2}(-[A-Za-z]{2})?\.json$/.test(f.path);
}
function isUiText(f) {
  return UI_TEXT_EXTS.has(f.ext) || isLocaleJson(f);
}
var NON_SHIPPING_PATH = /(^|\/)(mocks?|fixtures?|samples?|previews?|preview content|stubs?|storybook|stories|design|designs|prototypes?|mockups?|docs?|marketing)(\/|$)|(^|\/)(scripts?|debug|debug ?menu|\.claude|\.worktrees|worktrees)(\/|$)|^tools?\/|\.(stories|mock|fixture)\.[jt]sx?$|Preview(s)?\.swift$|Mock\w*\.swift$|(DebugMenu|Debug\w*ViewController)\w*\.\w+$/i;
function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}
function lineIndex(text) {
  const starts = lineStarts(text);
  return (index) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = lo + hi + 1 >> 1;
      if (starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}
var literalCache = /* @__PURE__ */ new WeakMap();
function literalsOf(f) {
  const cached = literalCache.get(f);
  if (cached) return cached;
  const src = f.code;
  const at = lineIndex(src);
  const out = [];
  if (f.ext === "plist" || f.ext === "xcprivacy" || f.ext === "xml") {
    for (const m of src.matchAll(/<string>([\s\S]*?)<\/string>/g)) {
      const index = m.index ?? 0;
      out.push({ value: decodeXml(m[1] ?? ""), index, line: at(index) });
    }
    literalCache.set(f, out);
    return out;
  }
  const js = JS_EXTS2.has(f.ext);
  const swift = f.ext === "swift";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (swift && src.startsWith('"""', i)) {
      const end = src.indexOf('"""', i + 3);
      const stop = end === -1 ? n : end;
      out.push({ value: src.slice(i + 3, stop), index: i, line: at(i) });
      i = stop + 3;
    } else if (c === '"' || js && (c === "'" || c === "`")) {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === "\\") j++;
        else if (src[j] === "\n" && c !== "`") break;
        j++;
      }
      out.push({ value: src.slice(i + 1, Math.min(j, n)), index: i, line: at(i) });
      i = j + 1;
    } else {
      i++;
    }
  }
  if (f.ext === "tsx" || f.ext === "jsx") {
    for (const m of src.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)) {
      const value = (m[1] ?? "").trim();
      if (!value || /[;=]|=>/.test(value)) continue;
      const index = (m.index ?? 0) + 1;
      out.push({ value, index, line: at(index) });
    }
  }
  literalCache.set(f, out);
  return out;
}
function decodeXml(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, "&");
}
function inPreview(code, index) {
  const rx = /#Preview\b[^{]*\{|:\s*PreviewProvider\b[^{]*\{/g;
  for (const m of code.matchAll(rx)) {
    const open4 = (m.index ?? 0) + m[0].length - 1;
    if (open4 > index) break;
    if (matchingBrace(code, open4) > index) return true;
  }
  return false;
}
function matchingBrace(code, open4) {
  let depth = 0;
  let quote = "";
  for (let k = open4; k < code.length; k++) {
    const ch = code[k];
    if (quote) {
      if (ch === "\\") k++;
      else if (ch === quote || ch === "\n") quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return k;
    }
  }
  return code.length;
}
function ships(f, index) {
  if (!isCode(f)) return true;
  if (inPreview(f.code, index)) return false;
  return !isDebugOnly(enclosingConditions(f.code, index, f.ext));
}
function firstMatch(ctx, rx, filter = isCode) {
  for (const f of ctx.files) {
    if (!filter(f)) continue;
    const m = rx.exec(f.code);
    rx.lastIndex = 0;
    if (m) {
      const index = m.index;
      const start = f.code.lastIndexOf("\n", index - 1) + 1;
      const end = f.text.indexOf("\n", index);
      return { file: f, index, line: lineIndex(f.code)(index), text: f.text.slice(start, end === -1 ? void 0 : end).trim() };
    }
  }
  return void 0;
}
var PAYWALL_SDKS = [
  { name: "StoreKit 2", rx: /\b(Product\.products\s*\(|SubscriptionStoreView\b|StoreView\s*\(\s*(ids|products):|ProductView\s*\(\s*(id|product):|Transaction\.(updates|currentEntitlements)\b|AppStore\.sync\s*\()/ },
  { name: "StoreKit 1", rx: /\b(SKProductsRequest|SKPaymentQueue|SKPayment\s*\()/ },
  { name: "RevenueCat", rx: /\b(Purchases\.(shared|configure|purchase\w*|getOfferings|restorePurchases)|import\s+RevenueCat(UI)?\b|presentPaywallIfNeeded|RevenueCatUI)|from\s+["']react-native-purchases(-ui)?["']/ },
  { name: "react-native-iap", rx: /from\s+["'](react-native-iap|expo-iap)["']|\b(requestPurchase|requestSubscription|useIAP|initConnection)\s*\(/ }
];
var MANAGED_PAYWALL = /\bSubscriptionStoreView\s*\(|\bpresentPaywallIfNeeded\b|\bRevenueCatUI\.(Paywall|presentPaywall\w*)\b|\.paywallFooter\s*\(|\bPaywallFooterView\s*\(|\bPaywallView\s*\((?<=import\s+RevenueCatUI\b[\s\S]*)/;
var PURCHASE_CALL = /((?:\b\w+|\))\??\.purchase\s*\(|\bPurchases\.shared\.purchase\s*\(|\bpurchasePackage\s*\(|\bpurchaseStoreProduct\s*\(|\bpurchaseProduct\s*\(|\brequestPurchase\s*\(|\brequestSubscription\s*\(|\bSKPaymentQueue\.default\(\)\.add\s*\(|\bbuyProduct\s*\(|\bStoreView\s*\(\s*(ids|products):|\bProductView\s*\(\s*(id|product):)/;
var PAYWALL_PATH = /paywall|subscri|premium|upgrade|purchase|pricing|\biap\b|storekit|unlock|(^|\/)(pro|plus|plans?)(view|screen|sheet|page)?\.\w+$|(^|\/)store\w*\.\w+$/i;
var RESTORE = /\b(?:AppStore\.sync\s*\(|(?:restorePurchases|restoreCompletedTransactions|restoreTransactions|getAvailablePurchases|getPurchaseHistory|syncPurchases)\b)|storeButton\s*\(\s*\.visible\s*,\s*for:[^)]*restorePurchases|["'`]Restore\b(?!\s+(?:defaults?|settings|backups?|from|data|photos?|files?|notes?|drafts?|sessions?|tabs?|windows?)\b)[^"'`\n]{0,30}["'`]/i;
var ACCOUNT_BOUND_PURCHASE = /\.appAccountToken\s*\(|\bappAccountToken\s*:|\bapplicationUsername\s*=|\bPurchases(?:\.shared)?\.logIn\s*\(|\b\w*(?:[Tt]ransactions?|[Pp]urchases?|[Pp]ayments?)(?:Observer|Manager|Service|Handler|Controller)\b[^\n]{0,80}\b\w*(?:[Ss]ession|[Aa]ccount(?:Id|ID)?|[Uu]serI[dD])\s*[:)]/;
var STORE_IMPLEMENTATION = new RegExp(
  [
    ...PAYWALL_SDKS.map((s) => s.rx.source),
    // StoreKit 2 `Product.purchase()` / `purchase(options:)` / `purchase(confirmIn:)`.
    /\.purchase\s*\(\s*(?:\)|options\s*:|confirmIn\s*:)/.source,
    /\b(?:SwiftyStoreKit|Qonversion|Adapty|Apphud|Glassfy|InAppPurchase\.(?:purchase|restore))\b|["'](?:expo-in-app-purchases|react-native-purchases|react-native-adapty|react-native-qonversion)["']/.source
  ].join("|")
);
var LOCAL_PACKAGE_PATH = /\.package\s*\(\s*(?:name\s*:\s*"[^"]*"\s*,\s*)?path\s*:\s*"([^"]+)"|XCLocalSwiftPackageReference[^\n]*\n(?:[^\n]*\n){0,3}?\s*relativePath\s*=\s*"?([^";\n]+)"?\s*;/g;
var SUBSCRIPTION_PRODUCT = /\b(autoRenewable|subscriptionPeriod|requestSubscription|subscriptionGroup\w*|SubscriptionInfo|SubscriptionStoreView|packageType|getSubscriptions|activeSubscriptions|subscriptionOfferDetails|subscriptionPeriodUnitIOS|subscriptionPeriodAndroid|SubscriptionOffer)\b|\b\w+\??\.subscription\??\.(subscriptionPeriod|introductoryOffer|status|subscriptionGroupID)\b|\btype\s*:\s*["'`]subs["'`]|\bProductType\.(SUBS|subs|autoRenewable)\b/;
var SUBSCRIPTION_LITERAL = /["'`][^"'`\n]*\b(subscription|subscribe|per (week|month|year)|\/\s?(week|month|year|mo|yr)|monthly|yearly|annually|weekly)\b[^"'`\n]*["'`]/i;
var NON_CONSUMABLE_SIGNAL = /\b(nonConsumable|non_consumable|lifetime|unlockPro|isPro|isPremium|hasPremium|premiumUnlocked|removeAds)\b/i;
var CONSUMABLE_SIGNAL = /\b(consumable|coins?|credits?|gems|tokens?Pack)\b/i;
var PRICE_LITERAL = /(?:US\$|A\$|C\$|[$€£¥₹₩])\s?\d{1,5}[.,]\d{2}\b|(?:US\$|A\$|C\$|[$€£¥₹₩])\s?\d{1,5}\s*(?:\/|per|a|each)\s*(?:week|wk|month|mo|year|yr)\b|\b\d{1,5}[.,]\d{2}\s?(?:USD|EUR|GBP|JPY|AUD|CAD|[€£$])/i;
var DYNAMIC_PRICE = /\b(displayPrice|localizedPriceString|priceString|localizedPrice|formattedPrice|priceFormatStyle|localizedPriceStringAndroid|oneTimePurchaseOfferDetails|pricePerMonthString|pricePerYearString|localizedIntroductoryPriceString|priceFormatter)\b|price\.formatted\s*\(/;
var RENEWAL_TERMS = /auto[- ]?renew|renews? automatically|automatically renews?|recurring (billing|charge|payment)|cancel (any ?time|at least)|until (you )?cancel|unless (auto[- ]?renew(al)? is )?(turned off|cancel)|\b(will|it|plan|subscription) renews?\b|\brenews? (monthly|yearly|annually|weekly|every|each)\b/i;
var PERIOD_DISCLOSURE = /\b(subscriptionPeriod|subscriptionPeriodUnitIOS|subscriptionPeriodNumberIOS|subscriptionPeriodAndroid|packageType|periodUnit|billingPeriod|SubscriptionPeriod)\b|\b(per|a|each|every)\s+(week|month|year)\b|\/\s?(week|wk|month|mo|year|yr)\b|\b(weekly|monthly|yearly|annual(ly)?)\b/i;
var TRIAL_LITERAL = /\bfree[- ]trial\b|\b\d+[- ](day|week|month)s?[- ](free[- ])?trial\b|\btry (it )?(for )?free\b/i;
var TRIAL_DATA = /\b(introductoryOffer|introOffer|introPrice|introductoryPrice|isEligibleForIntroOffer|introductoryDiscount|freeTrialPeriod\w*|introductoryPricePaymentModeIOS|introductoryPriceSubscriptionPeriodIOS|IntroEligibility|checkTrialOrIntroDiscountEligibility|isEligibleForIntroOffer)\b/;
var TRIAL_AFTER_TERMS = /\bafter (the |your )?(free )?trial\b|\btrial (ends|period ends)\b|\bthen\s+(\S*\d|\$|€|£|\\\(|\$\{)|once the trial|when the trial ends/i;
var TERMS_LINK = /\bterms\s*(of\s*(use|service)|&\s*conditions|and conditions)?\b|\btermsOfUse\b|\btermsOfService\b|\btos\b|\beula\b|stdeula|subscriptionStorePolicyDestination/i;
var PRIVACY_LINK = /\bprivacy\s*policy\b|privacyPolicy|privacy_policy|privacy-policy|\/privacy\b|subscriptionStorePolicyDestination/i;
var DELAY_CALL = /\b(asyncAfter\s*\(|Timer\.scheduledTimer\s*\(|Task\.sleep\s*\(|setTimeout\s*\(|withDelay\s*\(|Animated\.delay\s*\()|\.delay\(\s*\d/g;
var CLOSE_REVEAL = /\b(set)?_?(show|is|can|enable|display|reveal)_?(close|dismiss|skip|exit|xmark|x)(Button)?\w*\s*(=\s*true\b|\(\s*true\s*\))|\b(close|dismiss|skip|xmark|exit)(Button)?_?(Visible|Shown|Enabled|Available|Opacity|Alpha)\s*=\s*(true|1(\.0)?)\b|\bset(Close|Dismiss|Skip|Xmark|Exit)(Button)?(Visible|Shown|Enabled|Available|Opacity)\(\s*(true|1)\b/i;
var CLOSE_CONTROL = /systemName:\s*"xmark[\w.]*"|"xmark[\w.]*"|\bname=["'](close|x|xmark)["']|\bicon=["'](close|x)["']|accessibilityLabel(\(|=)\s*\{?\s*["']Close|\bonClose\b|closeButton/gi;
var NEAR_INVISIBLE = /\.opacity\(\s*(0|0?\.0\d*|0?\.1\d*|0?\.2)\s*\)|\bopacity:\s*(0|0?\.0\d*|0?\.1\d*|0?\.2)\b/;
var DISCOUNT_LITERAL = /\bsave\s+(up to\s+)?\d{1,3}\s?%|\b\d{1,3}\s?%\s*(off|discount|savings?)\b|\b(discount|off)\s+\d{1,3}\s?%/i;
var DISCOUNT_COMPUTED = /\b(savings?Percent\w*|discountPercent\w*|percentOff|percentSaved|savePercent\w*|computeSavings|calculateSavings)\b|\bprice\b[^;\n]{0,60}\/[^;\n]{0,60}\bprice\b|\b(saving|savings|discount|percent|pct)\w*\s*=\s*[\s\S]{0,200}?price/i;
var FALLBACK_CONTEXT = /fallback|placeholder|default|offline|loading|unavailable|\?\?/i;
var SYSTEM_REVIEW = /\b(SKStoreReviewController|requestReview\b|\\\.requestReview|AppStore\.requestReview|StoreReview\.requestReview|InAppReview\.RequestInAppReview|InAppReview\.requestReview|preferInApp:\s*true)|from\s+["'](expo-store-review|react-native-in-app-review)["']/;
var WRITE_REVIEW_LINK = /action=write-review|itms-apps:\/\/[^"'`\s]*\breview|apps\.apple\.com\/[^"'`\s]*\breview|\bRate\.rate\s*\(|from\s+["']react-native-rate["']/;
var ALERT_UI = /\b(Alert\s*\(|\.alert\s*\(|Alert\.alert\s*\(|UIAlertController|\.confirmationDialog\s*\(|<Modal\b|\.sheet\s*\(|\.popover\s*\(|showDialog\s*\(|BottomSheet)/;
var RATE_ASK_LITERAL = /\brate (us|this app|our app|the app|\w+ on the app store)\b|\bleave (us )?a (5[- ]star |nice |quick )?(review|rating)\b|\bgive us (5|five) stars\b|\bwrite (us )?a review\b|\b(5|five)[- ]star (review|rating)\b/i;
var STAR_PICKER = /ForEach\s*\(\s*(0\s*\.\.<\s*5|1\s*\.\.\.\s*5)[\s\S]{0,300}?"star(\.fill)?"|Array\.from\(\{\s*length:\s*5\s*\}[\s\S]{0,300}?(star|Star)|\[1,\s*2,\s*3,\s*4,\s*5\]\.map[\s\S]{0,300}?(star|Star)|\b(StarRating|RatingStars|StarRatingView|AirbnbRating|react-native-ratings)\b/;
var SENTIMENT_LITERAL = /\b(are you )?enjoying\b|\bdo you (like|love|enjoy)\b|\bhow do you like\b|\blove (the|this|our) app\b|\bhappy with (the|this|our) app\b|\bhow (are we doing|was your experience|would you rate your experience)\b/i;
var NEGATIVE_PATH = /\bmailto:|\bsend feedback\b|\bfeedback\b|\bcontact (us|support)\b|\bnot really\b|\btell us (more|how|what)\b|MFMailComposeViewController|Linking\.openURL\([^)]*mailto/i;
var INCENTIVE_LITERAL = /\b(rate|review)\b[^"'`\n]{0,40}\b(to|and|for)\s+(unlock|get|earn|receive|claim|win)\b|\b(unlock|earn|get|receive|claim|win)\b[^"'`\n]{0,40}\b(for|by|when you|after)\s+(rating|reviewing|leaving (us )?a (review|rating)|writing a review)\b|\b(free|bonus|extra)\s+(coins?|credits?|gems|days?|premium|generations?)\b[^"'`\n]{0,30}\b(for|by)\s+(a\s+)?(rating|review)/i;
var REWARD_CODE = /\b(coins?|credits?|gems|tokens|points|balance)\s*(\+=|=\s*[\w.]+\s*\+)|\b(addCoins|addCredits|grantPremium|grantReward|unlockPremium|giveReward|rewardUser|addGems|setPremium|setIsPremium)\s*\(|\b(isPremium|hasPremium|premiumUnlocked|isPro|isUnlocked)\s*=\s*true/;
var SOCIAL_PROOF = /\b[3-5][.,]\d\s?(★|⭐|stars?|rating)|(?:★|⭐){4,}\s?(?:\d|rat|review|by\b)|(?:\d|rated|rating)\s?(?:★|⭐){4,}|\b\d[\d,.]*\s?[kKmM]?\+?\s+(happy |satisfied |active |trusted |loyal )?(users|customers|downloads|people|members|subscribers)\b|#\s?1\s+(app|ai|rated|choice|in|for|best)\b|\bnumber one\b|\btop[- ]rated\b|\brated\s+[3-5][.,]\d\b|\btrusted by\s+[\d,.]+/i;
var SOCIAL_PROOF_JSON_KEY = /"(rating|average_?rating|averageRating|app_?store_?rating|appStoreRating|review_?count|reviewCount|reviews_?count|reviewsCount|ratings?_?count|ratingCount|ratingsCount|user_?count|userCount|users_?count|usersCount|download_?count|downloadCount|downloads)"\s*:\s*"?\d{1,9}(?:[.,]\d{1,3})?\s?[kKmM]?"?\s*(?=[,}\]\r\n])/;
var ONBOARDING_PATH = /onboard|welcome|intro|walkthrough|landing|get_?started|tutorial|splash/i;
var ACCOUNT_CREATION = [
  { label: "Firebase Auth createUser", rx: /\b(Auth\.auth\(\)\.createUser|createUser\s*\(\s*withEmail|createUserWithEmailAndPassword|createUserWithEmail)\b/ },
  { label: "Supabase signUp", rx: /\bauth\.signUp\s*\(/ },
  { label: "Sign in with Apple", rx: /\b(ASAuthorizationAppleIDProvider|SignInWithAppleButton|AppleAuthentication\.signInAsync|appleAuth\.performRequest|expo-apple-authentication)\b/ },
  { label: "Clerk sign-up", rx: /\b(useSignUp\s*\(|signUp\.create\s*\(|<SignUp\b|SignUpView\b)/ },
  { label: "Auth0 sign-up", rx: /\b(auth0\.auth\.createUser|\.signup\s*\(\s*\{|screen_hint:\s*["']signup["']|"screen_hint"\s*:\s*"signup")/ },
  { label: "Amplify signUp", rx: /\b(Auth\.signUp|Amplify\.Auth\.signUp|signUp\s*\(\s*\{\s*username)\b/ },
  // A bare `api.register()` is often device or push registration with the user's own
  // server; it only counts as sign-up with account fields in the call.
  { label: "generic signUp/register", rx: /\b(func|function|const|let|var)\s+(signUp|signup|registerUser|registerAccount|createAccount)\b|\b(api|client|auth|service|backend|authService|authManager)\.(signUp|signup|createAccount|createUser)\s*\(|\b(api|client|auth|service|backend|authService|authManager)\.register\s*\(\s*(\{\s*)?(email|username|password|with(Email|Username))\b/ }
];
var ACCOUNT_DELETION = /\b(deleteAccount|delete_account|deleteUser|deleteMyAccount|removeAccount|closeAccount|accountDeletion|requestAccountDeletion|deleteProfile|vanishAccount|accountVanish\w*|deactivateAndDelete\w*|deleteMyData|eraseMyData|eraseUserData|gdprErase\w*|gdpr_erase\w*)\b|\bvanish\w*\s+(my |your |the |this )?account\b|\baccount vanish\w*|\baccount deletion\b|\b(delete|erase) (all )?(of )?my (personal )?data\b|\buser\??\.delete\s*\(|\bcurrentUser\??\.delete\s*\(|\bauth\.admin\.deleteUser\b|\bdelete-account\b|\bdelete (my |your |the )?account\b|\b(close|remove) (my |your )?account\b/i;
var SIWA = /\b(ASAuthorizationAppleIDProvider|SignInWithAppleButton|AppleAuthentication\.signInAsync|appleAuth\.performRequest)\b/;
var SIWA_REVOKE = /\b(revokeToken|revokeAccessToken|revokeAppleToken|auth\/revoke|appleid\.apple\.com\/auth\/revoke|revokeTokenWithAuthorizationCode|revoke\w*Apple\w*)\b|\/auth\/revoke/;
var REQUIRED_REASON_APIS = [
  {
    category: "NSPrivacyAccessedAPICategoryUserDefaults",
    label: "UserDefaults",
    reasons: ["CA92.1", "1C8F.1", "C56D.1", "AC6B.1"],
    rx: /\b(UserDefaults|NSUserDefaults)\b|@AppStorage\b/,
    exts: ["swift", "m", "mm", "h"]
  },
  {
    category: "NSPrivacyAccessedAPICategoryUserDefaults",
    label: "UserDefaults (react-native Settings)",
    reasons: ["CA92.1", "1C8F.1", "C56D.1", "AC6B.1"],
    rx: /\bimport\s*\{[^}]*\bSettings\b[^}]*\}\s*from\s*["']react-native["']/,
    exts: ["ts", "tsx", "js", "jsx"]
  },
  {
    category: "NSPrivacyAccessedAPICategoryFileTimestamp",
    label: "file timestamp APIs",
    reasons: ["DDA9.1", "C617.1", "3B52.1", "0A2A.1"],
    rx: /\battributesOfItem\s*\(|\.(creationDateKey|contentModificationDateKey|contentAccessDateKey|attributeModificationDateKey)\b|FileAttributeKey\.(creationDate|modificationDate)\b|\[\s*\.(creationDate|modificationDate)\s*\]|\bNSFile(Creation|Modification)Date\b|\bNSURL(Creation|ContentModification|ContentAccess|AttributeModification)DateKey\b|\b[fl]?stat\s*\([^)]*&|\bgetattrlist\s*\(/,
    exts: ["swift", "m", "mm", "h"]
  },
  {
    category: "NSPrivacyAccessedAPICategorySystemBootTime",
    label: "system boot time APIs",
    reasons: ["35F9.1", "8FFB.1", "3D61.1"],
    rx: /\bsystemUptime\b|\bmach_absolute_time\s*\(|\bkern\.boottime\b|KERN_BOOTTIME/,
    exts: ["swift", "m", "mm", "h"]
  },
  {
    category: "NSPrivacyAccessedAPICategoryDiskSpace",
    label: "disk space APIs",
    reasons: ["85F4.1", "E174.1", "7D9E.1", "B728.1"],
    rx: /\bvolume(Available|Total)Capacity\w*Key\b|\bNSURLVolume(Available|Total)Capacity\w*Key\b|\b(f)?statv?fs\s*\(|FileAttributeKey\.system(Free)?Size\b|\[\s*\.system(Free)?Size\s*\]|\bNSFileSystem(Free)?Size\b/,
    exts: ["swift", "m", "mm", "h"]
  },
  {
    category: "NSPrivacyAccessedAPICategoryActiveKeyboards",
    label: "active keyboard APIs",
    reasons: ["3EC4.1", "54BD.1"],
    rx: /\bactiveInputModes\b/,
    exts: ["swift", "m", "mm", "h"]
  }
];
var TRACKING_SDKS = [
  { name: "App Tracking Transparency prompt", rx: /\bATTrackingManager\.requestTrackingAuthorization\b|\brequestTrackingPermissionsAsync\b|["']expo-tracking-transparency["']|["']react-native-tracking-transparency["']/ },
  { name: "Meta (Facebook) SDK", rx: /\bimport\s+(FBSDKCoreKit|FacebookCore|FBAudienceNetwork)\b|["']react-native-fbsdk-next["']|pod\s+["']FBSDKCoreKit["']/ },
  { name: "AppsFlyer", rx: /\bimport\s+AppsFlyerLib\b|["']react-native-appsflyer["']|pod\s+["']AppsFlyerFramework["']/ },
  { name: "Adjust", rx: /\bimport\s+(AdjustSdk|Adjust)\b|["']react-native-adjust["']|pod\s+["']Adjust["']/ },
  { name: "Branch", rx: /\bimport\s+BranchSDK\b|["']react-native-branch["']/ },
  { name: "Google Mobile Ads", rx: /\bimport\s+GoogleMobileAds\b|["']react-native-google-mobile-ads["']|pod\s+["']Google-Mobile-Ads-SDK["']/ },
  { name: "AppLovin", rx: /\bimport\s+AppLovinSDK\b|["']react-native-applovin-max["']|pod\s+["']AppLovinSDK["']/ },
  { name: "Unity Ads", rx: /\bimport\s+UnityAds\b|pod\s+["']UnityAds["']/ },
  { name: "ironSource", rx: /\bimport\s+IronSource\b|pod\s+["']IronSourceSDK["']/ },
  { name: "Singular", rx: /\bimport\s+Singular\b|["']singular-react-native["']/ },
  { name: "Kochava", rx: /\bimport\s+KochavaTracker\b|["']react-native-kochava-tracker["']/ },
  { name: "TikTok Business SDK", rx: /\bimport\s+TikTokBusinessSDK\b/ }
];
var METADATA_LIMITS = {
  nameMin: 2,
  name: 30,
  subtitle: 30,
  // App Store Connect counts keyword characters in every language; 100 bytes would reject valid CJK sets.
  keywords: 100,
  promotionalText: 170,
  description: 4e3,
  whatsNew: 4e3
};
var BRANDS = [
  "ChatGPT",
  "OpenAI",
  "GPT",
  "Instagram",
  "TikTok",
  "Snapchat",
  "WhatsApp",
  "Midjourney",
  "Disney",
  "Pixar",
  "Netflix",
  "YouTube",
  "Facebook",
  "Spotify",
  "Pokemon",
  "Pok\xE9mon",
  "Nintendo",
  "Fortnite",
  "Minecraft",
  "Roblox",
  "WeChat",
  "Perplexity",
  "DALL-E",
  "DALL\xB7E",
  "Stable Diffusion",
  "Anthropic",
  "Character.AI",
  "Character AI",
  "Replika",
  "CapCut",
  "Canva",
  "Lensa",
  "Pinterest",
  "Tinder"
];
var AMBIGUOUS_BRANDS = ["Gemini", "Claude", "Llama", "Bard", "Mistral", "Sora", "Copilot", "Grok"];
var AI_CONTEXT = /\b(ai|a\.i\.|chat\s?bot|chat|bot|assistant|gpt|llm|model|prompt|genai)\b/i;
var PRICE_IN_TEXT = /(?:US\$|A\$|C\$|[$€£¥₹₩])\s?\d|\b\d+(?:[.,]\d{2})?\s?(?:USD|EUR|GBP)\b|\b\d{1,3}\s?%\s*off\b/i;
var FREE_WORD = /\bfree\b/i;
var STRONG_CLAIMS = /#\s?1\b|\bnumber one\b|\buncensored\b|\bno[- ]filters?\b|\bunfiltered\b|\bnsfw\b|\bno restrictions\b/i;
var CONTENT_SIGNAL_CLAIMS = /\buncensored\b|\bno[- ]filters?\b|\bunfiltered\b|\bnsfw\b|\bno restrictions\b/i;
var SHORT_FIELD_CLAIMS = /\bbest\b|\bunlimited\b|\bno limits\b|\bworld'?s (first|best|most)\b|\bguaranteed?\b|\btop[- ]rated\b|\b#?1 rated\b/i;
var PLACEHOLDER_PURPOSE = /^\s*$|\b(todo|fixme|tbd|lorem|ipsum|placeholder|xxx+|description here|usage description)\b|^\s*\$\([A-Z_]+\)\s*$/i;
var GENERIC_LEAD = /^\s*(this app|the app|our app|app|we|\w+)\s+(needs?|requires?|would like|wants?)\s+(to\s+)?(use|access|permission)\b|^\s*allow\s+(\$\(PRODUCT_NAME\)|[\w$().-]+)\s+to\s+(access|use)\b/i;
var RESOURCE_PREPOSITION = /^\s*(?:to|for)\s+(?:(?:use|access)\b|(?=(?:your|the|my|our|this|these|its|their|all|any|an?|device|camera|microphone|photos?|location|contacts|calendars?|reminders|bluetooth|motion)\b))/i;
var PURPOSE_WORD = /\b(to|so|for|when|which|that|while|because|lets?|allows?|enables?|in order)\b/i;
function isGenericPurpose(s) {
  const m = GENERIC_LEAD.exec(s);
  if (!m) return false;
  const rest = s.slice(m[0].length).replace(RESOURCE_PREPOSITION, " ");
  return !PURPOSE_WORD.test(rest);
}
function parsePlist(xml) {
  const tokens2 = [...xml.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<(\/?)([A-Za-z]+)(?:\s[^>]*?)?\s*(\/?)>|([^<]+)/g)];
  let i = 0;
  const textUntil = (tag) => {
    let s = "";
    while (i < tokens2.length) {
      const t = tokens2[i];
      if (t[2] === tag && t[1] === "/") {
        i++;
        break;
      }
      s += t[4] ?? "";
      i++;
    }
    return decodeXml(s);
  };
  const value = () => {
    while (i < tokens2.length) {
      const t = tokens2[i];
      i++;
      if (t[4] !== void 0) continue;
      const tag = t[2];
      if (t[1] === "/") return void 0;
      const selfClosing = t[3] === "/";
      switch (tag) {
        case "plist":
          continue;
        case "true":
          return true;
        case "false":
          return false;
        case "string":
        case "date":
        case "data":
          return selfClosing ? "" : textUntil(tag);
        case "integer":
        case "real":
          return selfClosing ? 0 : Number(textUntil(tag).trim());
        case "array": {
          const arr = [];
          if (selfClosing) return arr;
          for (; ; ) {
            const v = value();
            if (v === void 0) break;
            arr.push(v);
          }
          return arr;
        }
        case "dict": {
          const obj2 = {};
          if (selfClosing) return obj2;
          for (; ; ) {
            const k = tokens2[i];
            if (!k) break;
            if (k[4] !== void 0) {
              i++;
              continue;
            }
            if (k[1] === "/") {
              i++;
              break;
            }
            if (k[2] !== "key") {
              value();
              continue;
            }
            i++;
            const key = textUntil("key").trim();
            const v = value();
            if (v === void 0) break;
            obj2[key] = v;
          }
          return obj2;
        }
        default:
          continue;
      }
    }
    return void 0;
  };
  if (!/<plist\b|<dict\b/.test(xml)) return void 0;
  return value();
}
function asDict(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : void 0;
}
function plistKeyLine(text, key) {
  const i = text.indexOf(`<key>${key}</key>`);
  return i === -1 ? void 0 : lineIndex(text)(i);
}
function utf8Bytes(s) {
  return Buffer.byteLength(s, "utf8");
}
function charLength(s) {
  return [...s].length;
}
function escapeRx(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// src/scanners/metadata.ts
import { createHash } from "node:crypto";

// src/scanners/genaiSafety.ts
var LIST_CAP = 60;
var EVIDENCE_POOL = 40;
var HOST_COMPARISON = /(?:\b(?:endsWith|startsWith|includes|contains|hasSuffix|hasPrefix|indexOf|match|matches|test)\s*\(\s*|[!=]==?\s*|\bcase\s+)["'`](?:https?:\/\/)?[\w.-]*$/;
var ENTRY_FILE = /(^|\/)(AppDelegate|SceneDelegate|\w*App)\.swift$|(^|\/)(main|index|App)\.[jt]sx?$/;
var SERVER_PATH = /^(?:packages\/|apps\/)?(server|backend|functions|cloud-?functions|lambda|api|supabase\/functions)\//i;
function comparedHost(f, index) {
  const before = f.code.slice(Math.max(0, index - 120), index);
  return HOST_COMPARISON.test(before.slice(before.lastIndexOf("\n") + 1));
}
function evidenceRank(e, inString = false) {
  const code = CODE.has(e.file.slice(e.file.lastIndexOf(".") + 1));
  const call = code && !inString && !/^\s*(import|from|require|#include|@import)\b/.test(e.text) && /[\w)\]?!]\s*\(/.test(e.text);
  const base = !code ? 6 : call ? 0 : e.kind === "sdk" && !inString ? ENTRY_FILE.test(e.file) ? 2 : 1 : 3;
  return base + (SERVER_PATH.test(e.file) ? 1 : 0) + (NON_SHIPPING_TARGET.test(e.file) ? 7 : 0);
}
function hitInString(f, index) {
  return CODE.has(f.ext) && maskedOf(f).charCodeAt(index) !== f.code.charCodeAt(index);
}
var TYPE_UNION_LINE = /^(?:\|\s*["'`][^"'`]*["'`]\s*;?|(?:export\s+)?type\s+\w+(?:<[^>]*>)?\s*=\s*\|?\s*["'`][^"'`]*["'`]\s*(?:\|.*)?;?)$/;
var EVIDENCE_PER_PROVIDER = 8;
var FINDINGS_PER_RULE = 12;
var SURFACE_NOTE = "Sources and sinks are listed, not linked. This tool does not claim any source reaches any sink; trace each path (and any server code outside this repo) before concluding. Dev-only paths (scripts/, prototypes/, experiments/, evals/, examples/, docs/, worktree copies, virtualenvs) are not scanned.";
var NON_PRODUCT_PATH = /(^|\/)(\.claude|\.worktrees|worktrees|\.venv|venv|site-packages|scripts?|prototypes?|experiments?|evals?|benchmarks?|examples?|samples?|docs?|fixtures?|mocks?|\.storybook|storybook|probes?|spikes?)\//i;
var NON_SHIPPING_TARGET = /(^|\/)(?:[^/]*(?:Tests?|Demo|Examples?|Samples?)(?![a-z])[^/]*|__tests__|tests?|demos?)\//;
var SIBLING_WEB_PATH = /^apps\/(web|nextjs|next|site|website|docs|landing|marketing)\//i;
var SERVER_SIBLING = /^(?:api|server|backend|workers?|functions|cloud-?functions|lambda|supabase)$/i;
function siblingApps(ctx) {
  const roots = ctx.project.appRoots ?? [];
  const root = roots.length === 1 ? roots[0].path : void 0;
  if (!root || root === "." || !root.includes("/")) return [];
  const parent = root.slice(0, root.lastIndexOf("/"));
  const pkgOf = (dir) => {
    const f = ctx.files.find((x) => x.path === `${dir}/package.json`);
    try {
      const json = f ? JSON.parse(f.text) : void 0;
      return json && typeof json === "object" && !Array.isArray(json) ? json : void 0;
    } catch {
      return void 0;
    }
  };
  const app = pkgOf(root);
  const deps = /* @__PURE__ */ new Set();
  for (const k of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const d = app?.[k];
    if (d && typeof d === "object") for (const n of Object.keys(d)) deps.add(n);
  }
  const out = [];
  const pkgPath = new RegExp(`^${parent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([^/]+)/package\\.json$`);
  for (const f of ctx.files) {
    const name = pkgPath.exec(f.path)?.[1];
    if (!name || `${parent}/${name}` === root || SERVER_SIBLING.test(name)) continue;
    const pkgName = pkgOf(`${parent}/${name}`)?.name;
    if (typeof pkgName === "string" && deps.has(pkgName)) continue;
    out.push(`${parent}/${name}/`);
  }
  return out;
}
var productCache = /* @__PURE__ */ new WeakMap();
function productFiles(ctx) {
  const cached = productCache.get(ctx);
  if (cached) return cached;
  const siblingWeb = ctx.project.appRoot || ctx.project.xcodeProjects.length > 0;
  const inApp = (p) => Boolean(ctx.project.appRoot) && p.startsWith(`${ctx.project.appRoot}/`);
  const others = siblingApps(ctx);
  const out = ctx.files.filter(
    (f) => !NON_PRODUCT_PATH.test(f.path) && !f.path.endsWith(".d.ts") && !(siblingWeb && SIBLING_WEB_PATH.test(f.path) && !inApp(f.path)) && !others.some((o) => f.path.startsWith(o))
  );
  productCache.set(ctx, out);
  return out;
}
var ROLLUP_IDENT = /\b[A-Za-z_]\w*\$\d+\b/g;
var bundleCache = /* @__PURE__ */ new WeakMap();
function isGeneratedBundle(f) {
  let v = bundleCache.get(f);
  if (v === void 0) {
    const js = f.ext === "js" || f.ext === "mjs" || f.ext === "cjs";
    v = js && (/\/\/# sourceMappingURL=\S+\s*$/.test(f.text.slice(-400)) || f.text.split("\n", 2e3).some((l) => l.length > 2e3) || bundleIdentDensity(f.text));
    bundleCache.set(f, v);
  }
  return v;
}
function bundleIdentDensity(text) {
  const n = text.match(ROLLUP_IDENT)?.length ?? 0;
  if (n < 100) return false;
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  return lines <= 100 * n;
}
var CODE = new Set(CODE_EXTENSIONS);
var CONFIG_EXTS = /* @__PURE__ */ new Set(["json", "txt", "pbxproj", "plist", "xcconfig", "yaml", "yml", "toml", "gradle"]);
var STRING_EXTS = /* @__PURE__ */ new Set(["strings", "stringsdict", "xcstrings", "plist", "json"]);
var isCode2 = (f) => CODE.has(f.ext);
var isCodeOrConfig = (f) => CODE.has(f.ext) || CONFIG_EXTS.has(f.ext) && !/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(f.path);
function isShippedText(ctx) {
  const meta = ctx.project.metadataDirs;
  return (f) => CODE.has(f.ext) || STRING_EXTS.has(f.ext) && !/(^|\/)(package(-lock)?\.json|tsconfig[\w.]*\.json|Package\.resolved)$/.test(f.path) || f.ext === "txt" && meta.some((d) => f.path.startsWith(`${d}/`));
}
var maskedCache = /* @__PURE__ */ new WeakMap();
function maskedOf(f) {
  let m = maskedCache.get(f);
  if (m === void 0) {
    m = CODE.has(f.ext) ? blankStrings(f.code, f.ext) : f.code;
    maskedCache.set(f, m);
  }
  return m;
}
var lineCache = /* @__PURE__ */ new WeakMap();
function lineStarts2(f) {
  let s = lineCache.get(f);
  if (!s) {
    s = [0];
    for (let i = 0; i < f.text.length; i++) if (f.text.charCodeAt(i) === 10) s.push(i + 1);
    lineCache.set(f, s);
  }
  return s;
}
function lineAt(f, index) {
  const s = lineStarts2(f);
  let lo = 0;
  let hi = s.length - 1;
  while (lo < hi) {
    const mid = lo + hi + 1 >> 1;
    if ((s[mid] ?? 0) <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}
var LINE_WINDOW = 300;
function lineTextAt(f, index, src = f.text) {
  const floor = Math.max(0, index - LINE_WINDOW);
  const ceil = Math.min(src.length, index + LINE_WINDOW);
  let start = index;
  while (start > floor && src.charCodeAt(start - 1) !== 10) start--;
  let end = index;
  while (end < ceil && src.charCodeAt(end) !== 10) end++;
  return src.slice(start, end).trim();
}
function redact(s) {
  return s.replace(/\b(sk|pk|rk)-(proj-|ant-)?[A-Za-z0-9_-]{12,}/g, "[redacted]").replace(/\br8_[A-Za-z0-9]{12,}/g, "[redacted]").replace(/\bAIza[0-9A-Za-z_-]{20,}/g, "[redacted]").replace(/\bhf_[A-Za-z0-9]{20,}/g, "[redacted]").replace(/\b(gsk|xai)-?_?[A-Za-z0-9]{20,}/g, "[redacted]").replace(/(Bearer\s+)[A-Za-z0-9._-]{16,}/g, "$1[redacted]").replace(/\b(?=[A-Za-z0-9+=]*\d)(?=[A-Za-z0-9+=]*[A-Z])(?=[A-Za-z0-9+=]*[a-z])[A-Za-z0-9+=]{40,}/g, "[redacted]");
}
var literalCache2 = /* @__PURE__ */ new WeakMap();
function literalsOf2(f) {
  const cached = literalCache2.get(f);
  if (cached) return cached;
  const out = [];
  const src = f.code;
  if (f.ext === "plist") {
    for (const m of src.matchAll(/<string>([^<]*)<\/string>/g)) out.push({ value: m[1] ?? "", index: (m.index ?? 0) + 8, prose: true });
  } else if (f.ext === "txt") {
    let idx = 0;
    for (const l of src.split("\n")) {
      if (l.trim()) out.push({ value: l, index: idx, prose: true });
      idx += l.length + 1;
    }
  } else {
    const js = ["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(f.ext);
    const quotes = js ? "\"'`" : '"';
    const unclosed = new UnclosedQuotes();
    const n = src.length;
    let i = 0;
    while (i < n) {
      const q = src[i] ?? "";
      if (!quotes.includes(q) || unclosed.covers(q, i)) {
        i++;
        continue;
      }
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const c = src[j];
        if (c === q) {
          closed = true;
          break;
        }
        if (c === "\n") break;
        if (c === "\\") {
          const next = src[j + 1];
          if (next === void 0 || next === "\n" || next === "\r" || next === "\u2028" || next === "\u2029") break;
          j += 2;
        } else j++;
      }
      if (closed) {
        out.push({ value: src.slice(i + 1, j), index: i + 1 });
        i = j + 1;
      } else {
        unclosed.record(q, j);
        i++;
      }
    }
    if (f.ext === "tsx" || f.ext === "jsx") {
      for (const m of src.matchAll(/>([^<>{}=;]*[A-Za-z][^<>{}=;]*)</g)) {
        const v = m[1] ?? "";
        if (v.trim().length >= 4) out.push({ value: v.trim(), index: (m.index ?? 0) + 1 + v.indexOf(v.trim()), prose: true });
      }
    }
  }
  literalCache2.set(f, out);
  return out;
}
function inFilterContext(f, index) {
  const masked = maskedOf(f);
  if (FILTER_CALL.test(lineTextAt(f, index, masked)) && FILTER_CONTEXT.test(lineTextAt(f, index, masked))) return true;
  if (FILTER_CALL.test(lineTextAt(f, index, masked)) && /\(\s*["'`]?\s*$/.test(masked.slice(Math.max(0, index - 40), index))) return true;
  let depth = 0;
  let levels = 0;
  const floor = Math.max(0, index - 4e3);
  for (let k = index - 1; k >= floor && levels < 2; k--) {
    const ch = masked[k];
    if (ch === "]" || ch === ")" || ch === "}") depth++;
    else if (ch === "[" || ch === "(" || ch === "{") {
      if (depth > 0) {
        depth--;
        continue;
      }
      levels++;
      const header = lineTextAt(f, k, masked);
      if (FILTER_CONTEXT.test(header)) return true;
    }
  }
  return FILTER_CONTEXT.test(lineTextAt(f, index, masked).split(/[=:]/)[0] ?? "");
}
function item(f, index, kind, provider) {
  return { file: f.path, line: lineAt(f, index), text: redact(lineTextAt(f, index)).slice(0, 200), kind, ...provider ? { provider } : {} };
}
function itemFromHit(f, h, kind, provider) {
  return item(f, h.index, kind, provider);
}
function cap(xs, n = LIST_CAP) {
  return xs.length > n ? xs.slice(0, n) : xs;
}
var surfaceCache = /* @__PURE__ */ new WeakMap();
var providerById = new Map(PROVIDERS.map((p) => [p.id, p]));
function analyzeAiSurface(ctx) {
  const cached = surfaceCache.get(ctx);
  if (cached) return cached;
  const codeFiles = productFiles(ctx).filter(isCode2);
  const cfgFiles = productFiles(ctx).filter(isCodeOrConfig);
  const providers = [];
  const providerFiles = /* @__PURE__ */ new Map();
  for (const rule of PROVIDERS) {
    const evidence = [];
    const quoted = [];
    for (const f of cfgFiles) {
      const hits = [
        ...searchFile(f, rule.sdk).map((h) => ({ h, kind: "sdk" })),
        ...(rule.hosts ? searchFile(f, rule.hosts).filter((h) => !comparedHost(f, h.index)) : []).map((h) => ({ h, kind: "endpoint" }))
      ];
      for (const { h, kind } of hits) {
        if (!providerFiles.has(f.path)) providerFiles.set(f.path, /* @__PURE__ */ new Set());
        providerFiles.get(f.path).add(rule.id);
        if (evidence.length < EVIDENCE_POOL && !evidence.some((e) => e.file === f.path && e.line === h.line)) {
          evidence.push(itemFromHit(f, h, kind, rule.id));
          quoted.push(hitInString(f, h.index));
        }
      }
    }
    if (evidence.length) {
      const ranked = evidence.map((e, i) => ({ e, i, r: evidenceRank(e, quoted[i]) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.e);
      providers.push({ id: rule.id, name: rule.name, kind: rule.kind, media: rule.media, evidence: ranked.slice(0, EVIDENCE_PER_PROVIDER) });
    }
  }
  const anyProvider = providers.length > 0;
  const anyGenerativeProvider = providers.some((p) => p.media.length > 0);
  const sinks = [];
  const seenSink = /* @__PURE__ */ new Map();
  const pushSink = (s) => {
    const k = `${s.file}:${s.line}`;
    const prev = seenSink.get(k);
    if (prev) {
      if (prev.mention && !s.mention) delete prev.mention;
      return;
    }
    seenSink.set(k, s);
    sinks.push(s);
  };
  const declared = /* @__PURE__ */ new Map();
  const declaredBy = (rule) => {
    if (!rule.declared) return void 0;
    let names = declared.get(rule);
    if (!names) {
      names = /* @__PURE__ */ new Set();
      for (const f of codeFiles) for (const h of scan(f, maskedOf(f), rule.declared)) for (const g of h.groups) if (g) names.add(g);
      declared.set(rule, names);
    }
    return names;
  };
  for (const f of codeFiles) {
    const inFile = providerFiles.get(f.path);
    const fileProvider = inFile ? [...inFile][0] : void 0;
    const providerFor = (kind) => {
      if (!inFile) return void 0;
      const media = kind === "image-edit" ? "image" : kind === "generation" ? void 0 : kind;
      const ids = [...inFile];
      return ids.find((id) => media ? providerById.get(id)?.media.includes(media) : false) ?? ids.find((id) => (providerById.get(id)?.media.length ?? 0) > 0) ?? fileProvider;
    };
    for (const rule of SINKS) {
      if (rule.requires === "providerInFile" && !inFile) continue;
      if (rule.requires === "providerInProject" && !anyProvider) continue;
      if (rule.requires === "generativeProviderInProject" && !anyGenerativeProvider) continue;
      if (rule.skipInFile?.test(f.code)) continue;
      for (const h of searchFile(f, rule.rx)) {
        const name = h.groups[0] ?? h.match;
        if (declaredBy(rule)?.has(name) && (rule.declaredSkip !== "unqualified" || ownCall(f, h, rule))) continue;
        if (TYPE_UNION_LINE.test(h.text)) continue;
        const sink = itemFromHit(f, h, rule.kind, rule.provider ?? providerFor(rule.kind));
        if (rule.kind === "text" && OUTPUT_CHECK.test(f.code.slice(h.index, h.index + STRUCTURED_WINDOW))) sink.structured = true;
        pushSink(rule.mention || LOOKUP_LINE.test(h.text) || CONSTANT_LINE.test(h.text) ? { ...sink, mention: true } : sink);
      }
    }
    const requests = REQUEST_CALL.test(f.code);
    for (const rule of PROVIDERS) {
      if (!rule.hosts) continue;
      for (const h of searchFile(f, rule.hosts)) {
        if (comparedHost(f, h.index) || inErrorMessage(f, h) || NON_GENERATING_ENDPOINT.test(h.text)) continue;
        const only = rule.media.length === 1 ? rule.media[0] : void 0;
        let byPath2 = ENDPOINT_MEDIA.find((e) => e.rx.test(h.text))?.kind;
        if (byPath2 === "text" && (IMAGE_OUTPUT.test(f.code) || VIDEO_OUTPUT.test(f.code))) byPath2 = void 0;
        const sink = itemFromHit(f, h, only ?? byPath2 ?? "generation", rule.id);
        pushSink(requests && !CONSTANT_LINE.test(h.text) ? sink : { ...sink, mention: true });
      }
    }
    for (const h of searchFile(f, /\b(embeddings\.create|EmbeddingsQuery|embedContent|batchEmbedContents)\b|\.embeddings\s*\(\s*query/)) {
      pushSink(itemFromHit(f, h, "embedding", fileProvider));
    }
    for (const h of searchFile(f, /\b(transcriptions\.create|audio\.transcriptions|AudioTranscriptionQuery|speechToText|speech_to_text|translations\.create)\b|\.audioTranscriptions\s*\(/)) {
      pushSink(itemFromHit(f, h, "transcription", fileProvider));
    }
  }
  const byPath = new Map(codeFiles.map((f) => [f.path, f]));
  for (const x of sinks) {
    if (x.kind !== "generation") continue;
    const f = byPath.get(x.file);
    if (!f) continue;
    const media = x.provider ? providerById.get(x.provider)?.media : void 0;
    if ((media?.includes("video") ?? true) && VIDEO_OUTPUT.test(f.code)) x.kind = "video";
    else if ((media?.includes("image") ?? true) && IMAGE_OUTPUT.test(f.code)) x.kind = "image";
  }
  const generating = sinks.filter((s) => s.kind !== "embedding" && s.kind !== "transcription");
  for (const p of providers) {
    const own = generating.filter((x) => x.provider === p.id);
    if (own.length === 0 || own.some((x) => x.kind === "generation")) continue;
    const seen = new Set(own.map((x) => x.kind === "image-edit" ? "image" : x.kind));
    const narrowed = p.media.filter((m) => seen.has(m));
    if (narrowed.length) p.media = narrowed;
  }
  const generativeProviders = providers.filter((p) => p.media.length > 0);
  const hasGenerator = generating.length > 0 || sinks.length === 0 && generativeProviders.length > 0;
  const visual = ["image", "image-edit", "video"];
  const visualOnlyProvider = generativeProviders.some((p) => p.media.every((m) => m === "image" || m === "video"));
  const hasImageGenerator = generating.some((s) => visual.includes(s.kind)) || visualOnlyProvider;
  const hasImageEdit = generating.some((s) => s.kind === "image-edit");
  const imageCapable = hasImageGenerator || generativeProviders.some((p) => p.media.includes("image"));
  const platformGuardedOnly = generativeProviders.length > 0 && generativeProviders.every((p) => providerById.get(p.id)?.builtInModeration !== void 0) && generating.every((x) => x.provider === void 0 || providerById.get(x.provider)?.builtInModeration !== void 0);
  const moderation = [];
  const useCount = /* @__PURE__ */ new Map();
  const usedElsewhere = (name) => {
    let n = useCount.get(name);
    if (n === void 0) {
      n = 0;
      const rx = new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`, "g");
      for (const f of codeFiles) {
        for (const _ of maskedOf(f).matchAll(rx)) if (++n >= 2) break;
        if (n >= 2) break;
      }
      useCount.set(name, n);
    }
    return n >= 2;
  };
  const appliedFilter = (f, h, src) => {
    const before = src.slice(Math.max(0, h.index - 40), h.index);
    if (FILTER_DECLARATION.test(before)) return usedElsewhere(h.match);
    return /^\s*[?!]?\s*[.(]/.test(src.slice(h.index + h.match.length, h.index + h.match.length + 8)) || usedElsewhere(h.match);
  };
  for (const f of cfgFiles) {
    if (BUILD_TOOL_CONFIG.test(f.path)) continue;
    for (const rule of MODERATION) {
      const src = rule.identifiersOnly && isCode2(f) ? maskedOf(f) : void 0;
      const hits = src !== void 0 ? scan(f, src, rule.rx) : searchFile(f, rule.rx);
      for (const h of hits) {
        if (SAFETY_DISABLED.some((s) => s.rx.test(h.text))) continue;
        if (rule.identifiersOnly && src !== void 0 && !appliedFilter(f, h, src)) continue;
        if (rule.imageInput && !rule.imageInput.test(f.code.slice(Math.max(0, h.index - MODERATION_REQUEST_WINDOW), h.index + MODERATION_REQUEST_WINDOW)) && !MODERATION_HELPER_IMAGE.test(f.code)) {
          moderation.push({ ...itemFromHit(f, h, "text"), label: `${rule.label.replace(/\s*\(.*\)$/, "")} (text only: no image is sent to it)` });
          continue;
        }
        moderation.push({ ...itemFromHit(f, h, rule.kind), label: rule.label });
      }
    }
  }
  for (const p of providers) {
    const rule = providerById.get(p.id);
    const ev = p.evidence[0];
    if (!rule || !ev) continue;
    if (rule.builtInModeration) moderation.push({ ...ev, kind: rule.builtInModeration, label: `${p.name}${BUILT_IN_SUFFIX}`, provider: p.id });
    const def = rule.defaultSafety;
    const off = def && SAFETY_DISABLED.find((x) => x.id === def.offRule);
    if (def && off && !cfgFiles.some((f) => off.rx.test(f.code))) moderation.push({ ...ev, kind: def.kind, label: def.label, provider: p.id });
  }
  const sources = [];
  for (const f of codeFiles) for (const rule of SOURCES) for (const h of searchFile(f, rule.rx)) sources.push(itemFromHit(f, h, rule.kind));
  const prompts = [];
  if (hasGenerator || anyProvider) {
    for (const f of codeFiles) {
      for (const rule of PROMPTS) {
        if (rule.requires === "providerInProject" && !anyProvider) continue;
        for (const h of searchFile(f, rule.rx)) prompts.push(itemFromHit(f, h, rule.kind));
      }
    }
  }
  const surface = {
    providers,
    sources: dedupeItems(sources),
    sinks,
    prompts: dedupeItems(prompts),
    moderation: dedupeItems(moderation),
    hasGenerator,
    hasImageGenerator,
    hasImageEdit,
    imageCapable,
    platformGuardedOnly,
    note: SURFACE_NOTE
  };
  surfaceCache.set(ctx, surface);
  return surface;
}
function dedupeItems(xs) {
  const seen = /* @__PURE__ */ new Set();
  return xs.filter((x) => {
    const k = `${x.file}:${x.line}:${x.kind}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
var STRUCTURED_WINDOW = 600;
var CONSTANT_LINE = /^(?:(?:export\s+)?(?:(?:public|private|internal|fileprivate|static)\s+)*(?:const|let|var)\s+\w+(?:\s*:\s*[\w.<>?]+)?\s*=|["']?[\w-]+["']?\s*:|return)\s*["'`][^"'`]*["'`]\s*[,;]?$/;
var NON_GENERATING_ENDPOINT = /\/(?:moderations|embeddings|audio\/transcriptions|audio\/translations)["'`/?]|\/models["'`?]/;
var ERROR_MESSAGE_LINE = /\bthrow\b|\b\w*Error\s*\(|\bconsole\.(?:error|warn|log|info)\s*\(|\b(?:logger|log|Log)\.\w+\s*\(|\bos_log\s*\(/;
function inErrorMessage(f, h) {
  return ERROR_MESSAGE_LINE.test(h.text) && hitInString(f, h.index) && !/:\/\/[\w.-]*$/.test(f.code.slice(Math.max(0, h.index - 80), h.index));
}
var FILTER_DECLARATION = /\b(?:func|function|def|class|struct|enum|protocol|interface|type|typealias|let|var|const|val|case)\s+$/;
var REQUEST_CALL = /\b(?:fetch|axios|URLRequest|URLSession|AF\.request|ky|got|superagent|HttpClient|httpClient|http\.(?:post|request)|https\.request|request)\s*[.(]/;
function ownCall(f, h, rule) {
  if (rule.declared?.test(h.text)) return true;
  const before = maskedOf(f).slice(Math.max(0, h.index - 40), h.index);
  return /\b(?:self|this)\s*[?!]?\.\s*$/.test(before) || !/[.?]\s*$/.test(before);
}
function scan(f, src, rx) {
  return searchFile({ ...f, code: src }, rx);
}
function surfaceData(s) {
  const counts = { sources: s.sources.length, sinks: s.sinks.length, prompts: s.prompts.length, moderation: s.moderation.length };
  return {
    providers: s.providers,
    sources: cap(s.sources),
    sinks: cap(s.sinks),
    prompts: cap(s.prompts),
    moderation: cap(s.moderation),
    counts,
    truncated: Object.values(counts).some((n) => n > LIST_CAP),
    hasGenerator: s.hasGenerator,
    hasImageGenerator: s.hasImageGenerator,
    hasImageEdit: s.hasImageEdit,
    note: s.note
  };
}
function safetyDisabled(ctx) {
  const out = [];
  for (const f of productFiles(ctx).filter(isCodeOrConfig)) {
    for (const rule of SAFETY_DISABLED) {
      for (const h of searchFile(f, rule.rx)) {
        if (rule.minValue !== void 0 && !(Number(h.groups[0]) >= rule.minValue)) continue;
        const debugOnly = isCode2(f) && isDebugOnly(enclosingConditions(f.code, h.index, f.ext));
        out.push(
          finding({
            rule: debugOnly ? "genai.safety_disabled_debug" : "genai.safety_disabled",
            severity: debugOnly ? "medium" : "block",
            guideline: "1.1",
            file: f.path,
            line: h.line,
            evidence: redact(h.text),
            why: debugOnly ? `${rule.provider} safety is explicitly turned off (${rule.label}) inside a debug-only block. It should not ship, but any path that compiles it into a release build would generate unfiltered content (1.1, 1.2).` : `${rule.provider} safety is explicitly turned off (${rule.label}). Apps that generate content are responsible for it under 1.1 and 1.2 (which names AI content creation apps); switching provider safety off is direct evidence the app can produce objectionable content.`,
            fix: debugOnly ? "Remove the override entirely so no build can carry it." : `${rule.restore}, and keep your own server-side filter as well.`,
            confidence: "high",
            suppressible: debugOnly
          })
        );
      }
    }
  }
  return out;
}
function userSafetyToggle(ctx, s) {
  if (!s.hasGenerator) return [];
  const out = [];
  for (const f of productFiles(ctx).filter(isCode2)) {
    for (const h of searchFile(f, USER_SAFETY_TOGGLE)) {
      if (isDebugOnly(enclosingConditions(f.code, h.index, f.ext))) continue;
      out.push(
        finding({
          rule: "genai.user_safety_toggle",
          severity: "medium",
          guideline: "1.2",
          file: f.path,
          line: h.line,
          evidence: redact(h.text),
          why: "Users can switch the content safety checker or filter off from the app's UI. With it off, generated content is not filtered, while 1.2 (which names AI content creation apps) requires a method for filtering objectionable material.",
          fix: "Remove the user-facing switch so the safety checker always runs on generated output, and disclose the filtering in Review Notes.",
          confidence: "medium"
        })
      );
      if (out.length >= FINDINGS_PER_RULE) return out;
    }
  }
  return out;
}
function unsafeModels(ctx, s) {
  if (s.providers.length === 0) return [];
  const hostRx = new RegExp(PROVIDERS.filter((p) => p.hosts).map((p) => p.hosts.source).join("|"));
  const out = [];
  for (const f of productFiles(ctx).filter(isCodeOrConfig)) {
    for (const lit of literalsOf2(f)) {
      const v = lit.value.trim();
      if (!v || /\s/.test(v) || v.length > 300) continue;
      if (!UNSAFE_MODEL_TERM.test(v) || MODEL_CLASSIFIER_EXCLUDE.test(v)) continue;
      const isUrl = /^[a-z]+:\/\//i.test(v);
      const lineText3 = lineTextAt(f, lit.index);
      const modelish = MODEL_FILE_EXT.test(v) || (isUrl ? hostRx.test(v) : /^[\w.-]{2,}\/[\w.:@-]+$/.test(v) || MODEL_KEY_CONTEXT.test(lineText3));
      if (!modelish) continue;
      out.push(
        finding({
          rule: "genai.unsafe_model",
          severity: "block",
          guideline: "1.1",
          file: f.path,
          line: lineAt(f, lit.index),
          evidence: redact(lineText3),
          why: `The model or LoRA id "${v.slice(0, 80)}" is named for uncensored / sexual output. Shipping a generator built on it is direct evidence the app produces objectionable content (1.1, 1.2), whatever prompts the UI offers.`,
          fix: "Remove this model / LoRA from the app and its backend, and use a model whose safety training is intact with a moderation layer on inputs and outputs.",
          confidence: "high",
          suppressible: false
        })
      );
    }
  }
  return out;
}
function literalTermHits(ctx, rx, filesFilter) {
  const out = [];
  for (const f of productFiles(ctx).filter(filesFilter)) {
    for (const lit of literalsOf2(f)) {
      const m = rx.exec(lit.value);
      if (!m) continue;
      const before = lit.value.slice(0, m.index);
      if (NEGATION_BEFORE.test(before)) continue;
      const at = lit.index + m.index;
      if (isCode2(f) && inFilterContext(f, at)) continue;
      out.push({ f, index: at, text: lit.value, term: m[0] });
    }
  }
  return out;
}
function identTermHits(ctx, rx) {
  const out = [];
  for (const f of productFiles(ctx).filter(isCode2)) {
    for (const h of scan(f, maskedOf(f), rx)) {
      if (inFilterContext(f, h.index)) continue;
      out.push({ f, index: h.index, text: h.text, term: h.match });
    }
  }
  return out;
}
function nudification(ctx, s) {
  const shipped2 = isShippedText(ctx);
  const out = [];
  const userPhotos = s.sources.some((x) => x.kind === "photo" || x.kind === "camera");
  const emit = (h, why) => out.push(
    finding({
      rule: "genai.nudification",
      severity: "block",
      guideline: "1.2",
      file: h.f.path,
      line: lineAt(h.f, h.index),
      evidence: redact(lineTextAt(h.f, h.index)),
      why,
      fix: "Remove the clothing-removal / nudity transformation entirely: the prompts, presets, UI entry points, model routes and any server endpoints behind them. A disclaimer or age gate does not cure this.",
      confidence: "high",
      suppressible: false
    })
  );
  if (s.imageCapable || s.hasImageEdit) {
    const strong = [...literalTermHits(ctx, NUDIFY_STRONG, shipped2), ...identTermHits(ctx, NUDIFY_STRONG_IDENT)];
    for (const h of strong.slice(0, FINDINGS_PER_RULE)) {
      emit(h, `"${h.term}" next to an image generator describes nudification. Apple's Oct 16, 2026 update names nudification as an example of the bait-and-switch apps covered by 2.5.19, and covers AI-generated nonconsensual intimate imagery under 1.2; these lead to removal and Program termination.`);
    }
  }
  if (userPhotos && s.hasImageEdit) {
    const ctxHits = [];
    for (const rx of NUDIFY_CONTEXTUAL) ctxHits.push(...literalTermHits(ctx, rx, shipped2));
    for (const h of ctxHits.slice(0, FINDINGS_PER_RULE)) {
      emit(h, `"${h.term}" appears in an app that edits user-supplied photos with an image model. Clothing removal or nudity applied to photos of real people is nonconsensual intimate imagery (1.2, Oct 16, 2026).`);
    }
  }
  return out;
}
function likeness(ctx, s) {
  const shipped2 = isShippedText(ctx);
  const out = [];
  const faceSwap = [
    ...literalTermHits(ctx, FACE_SWAP_SDK, isCodeOrConfig).filter((h) => !/\s/.test(h.text.trim())),
    ...identTermHits(ctx, FACE_SWAP_SDK),
    ...s.providers.length > 0 || s.hasImageEdit ? [...literalTermHits(ctx, FACE_SWAP_TERM, shipped2), ...identTermHits(ctx, /\b\w*(faceSwap|FaceSwap|face_swap|FACE_SWAP)\w*\b/)] : []
  ];
  for (const h of faceSwap.slice(0, FINDINGS_PER_RULE)) {
    out.push(
      finding({
        rule: "genai.face_swap",
        severity: "block",
        guideline: "1.2",
        file: h.f.path,
        line: lineAt(h.f, h.index),
        evidence: redact(lineTextAt(h.f, h.index)),
        why: `Face-swap ("${h.term}") puts a real person's likeness onto other bodies or scenes. Apple's Oct 16, 2026 update targets AI-generated nonconsensual imagery under 1.2; with arbitrary user photos this cannot be limited to consenting people.`,
        fix: "Remove the face-swap capability (SDK, model route, UI and server endpoint).",
        confidence: "medium",
        suppressible: false
      })
    );
  }
  if (s.imageCapable) {
    const celeb = literalTermHits(ctx, CELEBRITY_TERM, shipped2).filter((h) => LIKENESS_ACTION.test(h.text));
    for (const h of celeb.slice(0, FINDINGS_PER_RULE)) {
      out.push(
        finding({
          rule: "genai.celebrity_likeness",
          severity: "block",
          guideline: "1.2",
          file: h.f.path,
          line: lineAt(h.f, h.index),
          evidence: redact(lineTextAt(h.f, h.index)),
          why: `"${h.term}" in an image-generation app offers real people's likeness. 1.2 names nonconsensual imagery and IP infringement as AI-content risks, and 4.1(c)/5.2 cover using others' identity without permission.`,
          fix: "Remove prompts, presets and UI that generate images of real or famous people, and add a filter that refuses such requests.",
          confidence: "medium",
          suppressible: false
        })
      );
    }
  }
  return out;
}
var PROVIDER_SCOPED_MODERATION = /* @__PURE__ */ new Set([
  "Gemini safetySettings at a blocking threshold",
  "Imagen safety filter level",
  "provider output safety checker explicitly on"
]);
var BUILT_IN_SUFFIX = " built-in guardrails";
var DEV_ONLY_PATH = /(^|\/)[^/]*(devtools?|debug)[^/]*(\/|$)/i;
function primarySink(sinks) {
  let best;
  let bestScore = Infinity;
  for (const x of sinks) {
    if (x.kind === "embedding" || x.kind === "transcription") continue;
    const score = sinkScore(x);
    if (score < bestScore) {
      best = x;
      bestScore = score;
      if (score === 0) break;
    }
  }
  return best;
}
function sinkScore(x) {
  return (DEV_ONLY_PATH.test(x.file) || NON_SHIPPING_TARGET.test(x.file) ? 4 : 0) + (SERVER_PATH.test(x.file) ? 2 : 0) + (x.mention ? 3 : 0) + (/[\w)\]?!]\s*\(/.test(x.text) ? 0 : 1) + (x.structured ? 0.5 : 0);
}
function aiAnchor(s) {
  const sink = primarySink(s.sinks);
  if (sink && !sink.mention && sinkScore(sink) < 4) return sink;
  const shippingCode = (e) => CODE.has(e.file.slice(e.file.lastIndexOf(".") + 1)) && !DEV_ONLY_PATH.test(e.file) && !NON_SHIPPING_TARGET.test(e.file);
  const generators = s.providers.filter((p) => p.media.length > 0);
  const promptFiles = new Set(s.prompts.map((p) => p.file));
  const sdk = (e) => e.kind === "sdk" || /[\w)\]?!]\s*\(/.test(e.text);
  const tiers = [
    (e) => sdk(e) && promptFiles.has(e.file),
    (e) => promptFiles.has(e.file),
    sdk,
    () => true
  ];
  let fromProvider;
  for (const tier of tiers) {
    fromProvider = generators.map((p) => p.evidence.find((e) => shippingCode(e) && tier(e))).find(Boolean);
    if (fromProvider) break;
  }
  return fromProvider ?? sink ?? generators.map((p) => p.evidence.find((e) => CODE.has(e.file.slice(e.file.lastIndexOf(".") + 1)))).find(Boolean) ?? s.providers.map((p) => p.evidence.find(shippingCode)).find(Boolean) ?? s.providers[0]?.evidence[0];
}
var POLICY_ENFORCING_TEXT = /* @__PURE__ */ new Map([
  ["anthropic", "Anthropic"],
  ["openai", "OpenAI"],
  ["gemini", "Gemini"],
  ["foundationmodels", "Apple Foundation Models"]
]);
var OUTPUT_CHECK = /\b(?:response_format|responseFormat|json_schema|jsonSchema|responseSchema|response_schema|responseMimeType|response_mime_type|generateObject|streamObject|zodResponseFormat|zodOutputFormat|output_format|output_config|outputFormat|tool_choice|toolChoice|safeParse|JSONSchema)\b|@Generable\b/;
function hostedTextOnly(ctx, s, safetyOff) {
  if (safetyOff || s.hasImageGenerator || s.hasImageEdit) return void 0;
  if (s.prompts.some((p) => p.kind === "persona")) return void 0;
  const generators = s.providers.filter((p) => p.media.length > 0);
  const generating = s.sinks.filter((x) => x.kind !== "embedding" && x.kind !== "transcription");
  if (generators.length === 0 || generating.length === 0) return void 0;
  if (!generators.every((p) => POLICY_ENFORCING_TEXT.has(p.id) && p.media.every((m) => m === "text"))) return void 0;
  if (!generating.every((x) => x.kind === "text" && (x.provider === void 0 || POLICY_ENFORCING_TEXT.has(x.provider)))) return void 0;
  const files = new Map(productFiles(ctx).map((f) => [f.path, f]));
  let check12;
  for (const path8 of new Set(generating.map((x) => x.file))) {
    const f = files.get(path8);
    const h = f && searchFile(f, OUTPUT_CHECK)[0];
    if (!f || !h) return void 0;
    check12 ??= itemFromHit(f, h, "output check");
  }
  return check12 ? { names: generators.map((p) => POLICY_ENFORCING_TEXT.get(p.id) ?? p.name), check: check12 } : void 0;
}
function noModeration(n, hosted) {
  if (hosted) {
    return finding({
      rule: "genai.no_moderation",
      severity: "medium",
      guideline: "1.2",
      ...n.loc,
      why: `${n.why} Every generator here is text-only through ${hosted.names.join(", ")}, which enforces its own usage policies on each request, and app code constrains the output (${hosted.check.file}:${hosted.check.line}), so the risk is lower than for image or open-weight generation.`,
      fix: `Disclose in Review Notes that generation is text-only through ${hosted.names.join(", ")} with the provider's usage-policy enforcement, and how app code validates the output. If users can read free-form replies, add a filter on prompts and output as well.`,
      confidence: "medium"
    });
  }
  return finding({ rule: "genai.no_moderation", severity: "high", guideline: "1.2", ...n.loc, why: n.why, fix: n.fix, confidence: "medium" });
}
var NO_CHECKER_WHY = "The Stable Diffusion XL / 3 pipelines of apple/ml-stable-diffusion run without the package's safety checker, so their output images are never classified.";
function moderationCoverage(ctx, s, safetyOff) {
  if (!s.hasGenerator) return [];
  const anchor = aiAnchor(s);
  const loc = anchor ? { file: anchor.file, line: anchor.line, evidence: anchor.text } : {};
  const hosted = hostedTextOnly(ctx, s, safetyOff);
  if (s.moderation.length === 0) {
    return [
      noModeration(
        {
          loc,
          why: "The app generates content but no moderation was found in this repo: no moderation endpoint, classifier, blocking safety settings, server-side filter or blocklist. 1.2 (which names AI content creation apps) and 4.7.1 require a method for filtering objectionable material.",
          fix: "Add a filter on prompts and on generated output (moderation endpoint or classifier) before content is shown. If filtering already runs on a server outside this repo, disclose and describe it in Review Notes."
        },
        hosted
      )
    ];
  }
  const guardedProviders = new Set(s.moderation.filter((m) => m.provider !== void 0).map((m) => m.provider));
  const scoped = (m) => PROVIDER_SCOPED_MODERATION.has(m.label ?? "") || m.provider !== void 0;
  const general = s.moderation.filter((m) => !scoped(m));
  if (general.length === 0) {
    const scopedFiles = new Set(s.moderation.filter((m) => m.provider === void 0).map((m) => m.file));
    const uncovered = primarySink(
      s.sinks.filter(
        (x) => (
          // A pipeline with no safety checker is not covered by a checker flag set on its neighbour.
          x.provider !== void 0 && NO_SAFETY_CHECKER_PROVIDERS.has(x.provider) || !scopedFiles.has(x.file) && !(x.provider !== void 0 && guardedProviders.has(x.provider))
        )
      )
    );
    const inCode = (e) => CODE.has(e.file.slice(e.file.lastIndexOf(".") + 1));
    const candidates = s.providers.filter(
      (p) => p.media.length > 0 && !guardedProviders.has(p.id) && !s.sinks.some((x) => x.provider === p.id) && !p.evidence.some((e) => scopedFiles.has(e.file))
    );
    const unguarded = candidates.find((p) => p.evidence.some(inCode)) ?? candidates[0];
    const unguardedAt = unguarded?.evidence.find(inCode) ?? unguarded?.evidence[0];
    if (unguarded && unguardedAt) {
      const covered = [...new Set(s.moderation.map((m) => m.label))].join(", ");
      const noChecker = NO_SAFETY_CHECKER_PROVIDERS.has(unguarded.id);
      return [
        noModeration(
          {
            loc: { file: unguardedAt.file, line: unguardedAt.line, evidence: unguardedAt.text },
            why: noChecker ? `${NO_CHECKER_WHY} The safeguard found (${covered}) covers only the standard StableDiffusionPipeline. 1.2 (which names AI content creation apps) requires a method for filtering objectionable material.` : `${unguarded.name} generates content with no moderation. The only safeguard found (${covered}) belongs to a different model and filters only that model's output. 1.2 (which names AI content creation apps) and 4.7.1 require a method for filtering objectionable material.`,
            fix: noChecker ? "Add an output image classifier (e.g. SensitiveContentAnalysis or an NSFW Core ML model) on every SDXL / SD3 image and discard flagged output, plus a prompt filter." : "Add a filter on prompts and on generated output (moderation endpoint or classifier) for this generator before content is shown. If filtering already runs on a server outside this repo, disclose and describe it in Review Notes."
          },
          noChecker ? void 0 : hosted
        )
      ];
    }
    if (uncovered) {
      const covered = [...new Set(s.moderation.map((m) => m.label))].join(", ");
      const noChecker = uncovered.provider !== void 0 && NO_SAFETY_CHECKER_PROVIDERS.has(uncovered.provider);
      return [
        noModeration(
          {
            loc: { file: uncovered.file, line: uncovered.line, evidence: uncovered.text },
            why: noChecker ? `${NO_CHECKER_WHY} The safeguard found (${covered}) covers only the standard StableDiffusionPipeline. 1.2 (which names AI content creation apps) requires a method for filtering objectionable material.` : `This generator has no moderation. The only safeguard found (${covered}) is a setting of a different provider and filters only that provider's calls. 1.2 (which names AI content creation apps) and 4.7.1 require a method for filtering objectionable material.`,
            fix: noChecker ? "Add an output image classifier (e.g. SensitiveContentAnalysis or an NSFW Core ML model) on every SDXL / SD3 image and discard flagged output, plus a prompt filter." : "Add a filter on prompts and on generated output (moderation endpoint or classifier) for this generator before content is shown. If filtering already runs on a server outside this repo, disclose and describe it in Review Notes."
          },
          noChecker ? void 0 : hosted
        )
      ];
    }
  }
  const kinds = new Set(s.moderation.map((m) => m.kind));
  if (s.hasImageGenerator && !IMAGE_OUTPUT_KINDS.some((k) => kinds.has(k))) {
    const image = primarySink(s.sinks.filter((x) => x.kind === "image" || x.kind === "image-edit" || x.kind === "video"));
    const imageLoc = image && !DEV_ONLY_PATH.test(image.file) && !NON_SHIPPING_TARGET.test(image.file) ? { file: image.file, line: image.line, evidence: image.text } : loc;
    return [
      finding({
        rule: "genai.input_only_moderation",
        severity: "high",
        guideline: "1.2",
        ...imageLoc,
        why: "The app generates images but only text/prompt moderation was found. Benign-looking prompts and edited user photos can still yield explicit images; without classifying the output image, objectionable images reach users (1.2, Oct 16, 2026 NCII).",
        fix: "Add classification of every generated image (e.g. an image moderation API or on-device classifier) and discard flagged output. If output classification runs on a server outside this repo, disclose and describe it in Review Notes.",
        confidence: "medium"
      })
    ];
  }
  return [];
}
var check = {
  id: "genai_safety",
  title: "Generative AI safety",
  guidelines: ["1.1", "1.2", "4.7", "4.7.1"],
  async run(ctx) {
    const s = analyzeAiSurface(ctx);
    const disabled = safetyDisabled(ctx);
    const toggles = userSafetyToggle(ctx, s);
    const unsafe = unsafeModels(ctx, s);
    const findings = [
      ...disabled,
      ...toggles,
      ...unsafe,
      ...nudification(ctx, s),
      ...likeness(ctx, s),
      ...moderationCoverage(ctx, s, disabled.length + toggles.length + unsafe.length > 0)
    ];
    return { findings: dedupeFindings(findings), data: { surface: surfaceData(s) } };
  }
};

// src/scanners/metadata.ts
var FASTLANE_FILES = {
  "name.txt": "name",
  "subtitle.txt": "subtitle",
  "keywords.txt": "keywords",
  "promotional_text.txt": "promotionalText",
  "description.txt": "description",
  "release_notes.txt": "whatsNew"
};
var ASC_APP_INFO = /^metadata\/app-info\/([^/]+)\.json$/;
var ASC_VERSION = /^metadata\/version\/([^/]+)\/([^/]+)\.json$/;
var FASTLANE = /^fastlane\/metadata\/([^/]+)\/([a-z_]+\.txt)$/;
var USAGE_KEY = /^NS\w+UsageDescription$/;
function compareVersions(a, b) {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
function jsonLine(f, key) {
  const i = f.text.indexOf(`"${key}"`);
  return i === -1 ? void 0 : lineIndex(f.text)(i);
}
function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return void 0;
  }
}
function strOf(v) {
  return typeof v === "string" ? v : void 0;
}
function isBuildVariable(s) {
  return /^\s*\$[({][A-Z_]+[)}]\s*$/.test(s);
}
function metadataTexts(ctx) {
  const out = [];
  const push = (t) => {
    if (t.text.trim() === "" && t.field !== "usageDescription") return;
    out.push(t);
  };
  const versions = [...new Set(ctx.files.map((f) => ASC_VERSION.exec(f.path)?.[1]).filter((v) => !!v))];
  const latest = versions.sort(compareVersions).at(-1);
  for (const f of ctx.files) {
    const info = ASC_APP_INFO.exec(f.path);
    const ver = ASC_VERSION.exec(f.path);
    if (!info && !(ver && ver[1] === latest)) continue;
    const locale = (info ? info[1] : ver?.[2]) ?? "default";
    const obj2 = safeJson(f.text);
    if (!obj2 || typeof obj2 !== "object") continue;
    const rec = obj2;
    const fields = info ? ["name", "subtitle"] : ["description", "keywords", "promotionalText", "whatsNew"];
    for (const field of fields) {
      const text = strOf(rec[field]);
      if (text !== void 0) push({ file: f.path, field, locale, text, line: jsonLine(f, field), surface: "store" });
    }
  }
  for (const f of ctx.files) {
    const m = FASTLANE.exec(f.path);
    if (!m) continue;
    const field = FASTLANE_FILES[m[2] ?? ""];
    if (!field || m[1] === "review_information" || m[1] === "trade_representative_contact_information") continue;
    push({ file: f.path, field, locale: m[1] ?? "default", text: f.text.trimEnd(), line: 1, surface: "store" });
  }
  for (const f of ctx.files) {
    const base = f.path.split("/").pop() ?? "";
    if (base === "Info.plist") {
      const dict = asDict(parsePlist(f.text));
      if (!dict) continue;
      for (const [key, v] of Object.entries(dict)) {
        if (typeof v !== "string") continue;
        const line = plistKeyLine(f.text, key);
        if (key === "CFBundleDisplayName" || key === "CFBundleName") {
          if (isBuildVariable(v)) continue;
          push({ file: f.path, field: key === "CFBundleDisplayName" ? "displayName" : "bundleName", locale: "default", text: v, line, surface: "bundle" });
        } else if (USAGE_KEY.test(key)) {
          push({ file: f.path, field: "usageDescription", key, locale: "default", text: v, line, surface: "bundle" });
        }
      }
    } else if (base === "InfoPlist.strings") {
      const locale = /([^/]+)\.lproj\/InfoPlist\.strings$/.exec(f.path)?.[1] ?? "default";
      const at = lineIndex(f.code);
      for (const m of f.code.matchAll(/"?([A-Za-z]+)"?\s*=\s*"((?:[^"\\]|\\.)*)"\s*;/g)) {
        const key = m[1] ?? "";
        const text = (m[2] ?? "").replace(/\\"/g, '"');
        const line = at(m.index ?? 0);
        if (key === "CFBundleDisplayName" || key === "CFBundleName") {
          push({ file: f.path, field: key === "CFBundleDisplayName" ? "displayName" : "bundleName", locale, text, line, surface: "bundle" });
        } else if (USAGE_KEY.test(key)) {
          push({ file: f.path, field: "usageDescription", key, locale, text, line, surface: "bundle" });
        }
      }
    } else if (f.ext === "pbxproj") {
      const at = lineIndex(f.text);
      const seen = /* @__PURE__ */ new Set();
      for (const m of f.text.matchAll(/INFOPLIST_KEY_(CFBundleDisplayName|NS\w+UsageDescription)\s*=\s*("((?:[^"\\]|\\.)*)"|[^;\n]*);/g)) {
        const key = m[1] ?? "";
        const text = (m[3] ?? m[2] ?? "").replace(/\\"/g, '"').trim();
        if (seen.has(`${key}=${text}`) || isBuildVariable(text)) continue;
        seen.add(`${key}=${text}`);
        const line = at(m.index ?? 0);
        if (key === "CFBundleDisplayName") push({ file: f.path, field: "displayName", locale: "default", text, line, surface: "bundle" });
        else push({ file: f.path, field: "usageDescription", key, locale: "default", text, line, surface: "bundle" });
      }
    }
  }
  const expoPath = ctx.project.expoConfig;
  const expo = expoPath ? ctx.files.find((f) => f.path === expoPath) : void 0;
  if (expo) {
    const at = lineIndex(expo.text);
    const lineOfText = (needle) => {
      const i = expo.text.indexOf(needle);
      return i === -1 ? void 0 : at(i);
    };
    if (expo.ext === "json") {
      const root = safeJson(expo.text);
      const cfg = root && typeof root.expo === "object" ? root.expo : root;
      const name = strOf(cfg?.name);
      if (name) push({ file: expo.path, field: "displayName", locale: "default", text: name, line: lineOfText(`"name"`), surface: "bundle" });
      const ios = cfg?.ios;
      const plist = ios?.infoPlist;
      for (const [key, v] of Object.entries(plist ?? {})) {
        const text = strOf(v);
        if (text === void 0) continue;
        if (USAGE_KEY.test(key)) push({ file: expo.path, field: "usageDescription", key, locale: "default", text, line: lineOfText(`"${key}"`), surface: "bundle" });
        else if (key === "CFBundleDisplayName") push({ file: expo.path, field: "displayName", locale: "default", text, line: lineOfText(`"${key}"`), surface: "bundle" });
      }
      for (const p of Array.isArray(cfg?.plugins) ? cfg.plugins : []) {
        if (!Array.isArray(p) || typeof p[0] !== "string" || !p[1] || typeof p[1] !== "object") continue;
        for (const [opt, v] of Object.entries(p[1])) {
          const text = strOf(v);
          if (text === void 0 || !/Permission$|UsageDescription$/.test(opt)) continue;
          push({ file: expo.path, field: "usageDescription", key: `${p[0]}.${opt}`, locale: "default", text, line: lineOfText(`"${opt}"`), surface: "bundle" });
        }
      }
    } else {
      const name = /\bname\s*:\s*(["'`])([^"'`\n]+)\1/.exec(expo.code);
      if (name?.[2]) push({ file: expo.path, field: "displayName", locale: "default", text: name[2], line: at(name.index), surface: "bundle" });
      for (const m of expo.code.matchAll(/\b(NS\w+UsageDescription|\w+Permission)["']?\s*:\s*(["'`])([^"'`\n]*)\2/g)) {
        push({ file: expo.path, field: "usageDescription", key: m[1] ?? "", locale: "default", text: m[3] ?? "", line: at(m.index ?? 0), surface: "bundle" });
      }
    }
  }
  return out;
}
function brandHits(text) {
  const hits = [];
  for (const b of BRANDS) if (new RegExp(`(?<![\\w])${escapeRx(b)}(?![\\w])`, "i").test(text)) hits.push(b);
  if (AI_CONTEXT.test(text)) {
    for (const b of AMBIGUOUS_BRANDS) if (new RegExp(`(?<![\\w])${escapeRx(b)}(?![\\w])`, "i").test(text)) hits.push(b);
  }
  return hits;
}
var FIELD_LABEL = {
  name: "app name",
  subtitle: "subtitle",
  keywords: "keywords",
  promotionalText: "promotional text",
  description: "description",
  whatsNew: "What's New",
  displayName: "home-screen display name",
  bundleName: "bundle name",
  usageDescription: "permission purpose string"
};
function limitFindings(t) {
  const out = [];
  const at = { file: t.file, line: t.line, evidence: `${t.field} [${t.locale}]: ${t.text}` };
  const over = (what, n, max, unit) => finding({
    rule: "metadata.field_limit",
    severity: "high",
    guideline: "2.3.7",
    ...at,
    why: `The ${what} for ${t.locale} is ${n} ${unit}; App Store Connect allows ${max}. The listing cannot be saved or will be truncated.`,
    fix: `Remove words until the ${what} is at most ${max} ${unit}.`,
    confidence: "high"
  });
  const chars = charLength(t.text);
  if (t.field === "name") {
    if (chars > METADATA_LIMITS.name) out.push(over("app name", chars, METADATA_LIMITS.name, "characters"));
    if (chars < METADATA_LIMITS.nameMin)
      out.push(
        finding({
          rule: "metadata.field_limit",
          severity: "high",
          guideline: "2.3.7",
          ...at,
          why: `The app name for ${t.locale} is ${chars} character(s); App Store Connect requires at least ${METADATA_LIMITS.nameMin}.`,
          fix: "Use the app's full name (2\u201330 characters).",
          confidence: "high"
        })
      );
  }
  if (t.field === "subtitle" && chars > METADATA_LIMITS.subtitle) out.push(over("subtitle", chars, METADATA_LIMITS.subtitle, "characters"));
  if (t.field === "keywords") {
    if (chars > METADATA_LIMITS.keywords) out.push(over("keywords field", chars, METADATA_LIMITS.keywords, "characters"));
    else if (utf8Bytes(t.text) > METADATA_LIMITS.keywords)
      out.push(
        finding({
          rule: "metadata.keywords_bytes_note",
          severity: "info",
          guideline: "2.3.7",
          ...at,
          why: `The keywords field for ${t.locale} is ${chars} characters but ${utf8Bytes(t.text)} bytes in UTF-8. Apple's Help page says 100 bytes, while App Store Connect accepts 100 characters in every language.`,
          fix: "No change needed unless App Store Connect refuses to save the keywords; if it does, remove keywords until it saves.",
          confidence: "low"
        })
      );
  }
  if (t.field === "promotionalText" && chars > METADATA_LIMITS.promotionalText)
    out.push(over("promotional text", chars, METADATA_LIMITS.promotionalText, "characters"));
  if (t.field === "description" && chars > METADATA_LIMITS.description) out.push(over("description", chars, METADATA_LIMITS.description, "characters"));
  if (t.field === "whatsNew" && chars > METADATA_LIMITS.whatsNew) out.push(over("What's New text", chars, METADATA_LIMITS.whatsNew, "characters"));
  return out;
}
function contentFindings(t, contentApp) {
  const out = [];
  const label = FIELD_LABEL[t.field];
  const at = { file: t.file, line: t.line, evidence: `${t.key ?? t.field} [${t.locale}]: ${t.text}` };
  const identity = t.field === "name" || t.field === "subtitle" || t.field === "keywords" || t.field === "displayName";
  if (identity) {
    const brands = brandHits(t.text);
    if (brands.length) {
      out.push(
        finding({
          rule: "metadata.third_party_brand",
          severity: "high",
          guideline: "4.1(c)",
          ...at,
          why: `The ${label} uses another company's brand or app name (${brands.join(", ")}). 2.3.7 bans other app names and trademarks in the name, subtitle and keywords, 4.1(c) bans using another developer's brand without permission, and DPLA 3.2(f) lists confusingly similar names.`,
          fix: `Remove ${brands.join(", ")} from the ${label} unless you hold written permission from the brand owner; describe what the app does in your own words instead.`,
          confidence: "medium"
        })
      );
    }
  }
  if (t.field === "name" || t.field === "subtitle" || t.field === "keywords") {
    const price = PRICE_IN_TEXT.exec(t.text);
    if (price) {
      out.push(
        finding({
          rule: "metadata.price_in_metadata",
          severity: "high",
          guideline: "2.3.7",
          ...at,
          why: `The ${label} contains a price or discount ("${price[0]}"). 2.3.7 bans prices in the name, subtitle and keywords.`,
          fix: `Remove the price from the ${label}.`,
          confidence: "high"
        })
      );
    } else if (t.field !== "keywords" && FREE_WORD.test(t.text)) {
      out.push(
        finding({
          rule: "metadata.price_in_metadata",
          severity: "medium",
          guideline: "2.3.7",
          ...at,
          why: `The ${label} says "free". App Review treats pricing words in the name or subtitle as price references under 2.3.7, and "free" misleads when content needs a purchase.`,
          fix: `Remove "free" from the ${label}.`,
          confidence: "medium"
        })
      );
    }
  }
  if (t.surface === "store" || t.field === "displayName") {
    const signal = CONTENT_SIGNAL_CLAIMS.exec(t.text);
    const strong = signal ? null : STRONG_CLAIMS.exec(t.text);
    const short = t.field === "name" || t.field === "subtitle" || t.field === "promotionalText" || t.field === "displayName" ? SHORT_FIELD_CLAIMS.exec(t.text) : null;
    const claim = strong ?? short;
    if (signal) {
      const showsContent = contentApp();
      out.push(
        finding({
          rule: "metadata.content_signal_claim",
          severity: showsContent ? "high" : "medium",
          guideline: `${t.field === "subtitle" || t.field === "name" ? "2.3.7" : "2.3.14"}, 1.1, 1.2`,
          ...at,
          why: `The ${label} advertises "${signal[0]}" content${showsContent ? " in an app that shows AI-generated or user-generated content" : ""}. Store text must describe what the app actually does (2.3 accurate metadata; 2.3.7 and 2.3.14 bar unverifiable claims), so this word is either a promise of objectionable material, which 1.1 and 1.2 bar, or an inaccurate claim.`,
          fix: `Remove "${signal[0]}" from the ${label} in every locale and store surface (name, subtitle, keywords, promotional text, description, screenshots) so the store text describes what the app actually does. If the app can produce or show that content, first remove or filter the capability itself (see the genai_safety and ugc_safeguards findings, and any backend outside this repo): changing the listing alone while the output stays unfiltered is a cosmetic change.`,
          confidence: "high"
        })
      );
    } else if (claim) {
      out.push(
        finding({
          rule: "metadata.unverifiable_claim",
          severity: "medium",
          guideline: t.field === "subtitle" || t.field === "name" ? "2.3.7" : "2.3.14",
          ...at,
          why: `The ${label} makes an unverifiable or content-signalling claim ("${claim[0]}"). 2.3.7 bars unverifiable claims in the subtitle and name, 2.3.14 bars them in creative assets, and words like "uncensored" or "no filter" invite a 1.1/1.2 content review of the whole app.`,
          fix: `Remove "${claim[0]}" from the ${label}, or replace it with a factual description you can substantiate.`,
          confidence: strong ? "high" : "medium"
        })
      );
    }
  }
  if (t.field === "usageDescription") {
    const placeholder = PLACEHOLDER_PURPOSE.test(t.text);
    if (placeholder || isGenericPurpose(t.text)) {
      out.push(
        finding({
          rule: "metadata.placeholder_purpose_string",
          severity: "medium",
          guideline: "5.1.1",
          ...at,
          why: placeholder ? `The ${t.key ?? "permission"} purpose string is empty or a placeholder. Apple rejects permission prompts that do not explain why the data is needed (5.1.1).` : `The ${t.key ?? "permission"} purpose string names the resource but not why the app needs it. 5.1.1 requires purpose strings that clearly and completely describe the use of the data.`,
          fix: 'Disclose the specific use in the purpose string, e.g. "Used to scan receipts you choose to add"; remove the key if the app no longer uses the permission.',
          confidence: placeholder ? "high" : "medium"
        })
      );
    }
  }
  return out;
}
function showsGeneratedOrUserContent(ctx) {
  const s = analyzeAiSurface(ctx);
  if (s.hasGenerator && !s.platformGuardedOnly) return true;
  return productFiles(ctx).some((f) => isCode2(f) && UGC_DISPLAY.some((rx) => rx.test(f.code)));
}
function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}
function metadataSnapshots(texts) {
  const groups = /* @__PURE__ */ new Map();
  for (const t of texts) {
    if (t.field === "usageDescription" || t.field === "bundleName") continue;
    const storeRoot = t.surface === "store" ? t.file.startsWith("fastlane/") ? "fastlane" : "asc" : t.file;
    const key = `${storeRoot}|${t.locale}`;
    let g = groups.get(key);
    if (!g) {
      g = { snap: { locale: t.locale, source: "" }, sources: /* @__PURE__ */ new Set() };
      groups.set(key, g);
    }
    g.sources.add(t.file);
    if (t.field === "description") g.snap.descriptionHash = sha256(t.text);
    else if (t.field === "whatsNew") continue;
    else g.snap[t.field] = t.text;
  }
  return [...groups.values()].map((g) => ({ ...g.snap, source: [...g.sources].sort().join(" + ") }));
}
var check2 = {
  id: "metadata",
  title: "Store metadata and bundle text",
  guidelines: ["1.1", "1.2", "2.3.7", "2.3.8", "2.3.14", "4.1(c)", "5.1.1", "DPLA 3.2(f)"],
  async run(ctx) {
    const texts = metadataTexts(ctx);
    const findings = [];
    let shows;
    const contentApp = () => shows ??= showsGeneratedOrUserContent(ctx);
    for (const t of texts) {
      if (t.surface === "store") findings.push(...limitFindings(t));
      findings.push(...contentFindings(t, contentApp));
    }
    return {
      findings,
      data: {
        snapshots: metadataSnapshots(texts),
        sources: [...new Set(texts.map((t) => t.file))].sort()
      }
    };
  }
};

// src/remediation/surface.ts
var execFileP = promisify(execFile);
var SAFE_GIT = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.sshCommand=false",
  "-c",
  "core.pager=cat",
  "-c",
  "core.askPass=",
  "-c",
  "diff.external=",
  "-c",
  "protocol.allow=never",
  "-c",
  "log.showSignature=false",
  "-c",
  "gpg.program=false",
  "-c",
  "gpg.openpgp.program=false",
  "-c",
  "gpg.ssh.program=false",
  "-c",
  "gpg.x509.program=false"
];
var GIT_ENV = { GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", GIT_EXTERNAL_DIFF: "" };
async function repoDriverOverrides(root) {
  try {
    const { stdout } = await execFileP(
      "git",
      ["-C", root, ...SAFE_GIT, "config", "--name-only", "--get-regexp", String.raw`^(filter|diff)\..+\.(clean|smudge|process|textconv|command)$`],
      { timeout: 1e4, env: { ...process.env, ...GIT_ENV } }
    );
    return stdout.split("\n").map((k) => k.trim()).filter((k) => /^(filter|diff)\..+\.(clean|smudge|process|textconv|command)$/.test(k)).flatMap((k) => ["-c", `${k}=${/\.(clean|smudge)$/.test(k) ? "cat" : ""}`]);
  } catch {
    return [];
  }
}
async function git(root, args, timeout = 2e4) {
  try {
    const drivers = await repoDriverOverrides(root);
    const { stdout } = await execFileP("git", ["-C", root, ...SAFE_GIT, ...drivers, ...args], { timeout, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...GIT_ENV } });
    return stdout;
  } catch {
    return void 0;
  }
}
function safeRef(ref) {
  return /^[\w./@{}^~:-]+$/.test(ref) && !ref.startsWith("-");
}
async function isGitRepo(root) {
  return (await git(root, ["rev-parse", "--is-inside-work-tree"]))?.trim() === "true";
}
async function inGitPathHistory(root, needle) {
  const out = await git(root, ["log", "--no-show-signature", "--all", "--no-textconv", "--name-only", "--relative", "--format=", "-n", "5000", "--", "."], 3e4);
  return (out ?? "").split("\n").some((rel) => rel.split("/").some((seg) => matchNeedle(needle, seg, 1).length > 0));
}
async function inGitHistory(root, needle) {
  const out = await git(root, ["log", "--no-show-signature", "--all", "--no-textconv", "-i", `-S${needle}`, "--format=%h", "-n", "1", "--", "."], 3e4);
  return !!out?.trim();
}
var IGNORED_DIRS2 = /* @__PURE__ */ new Set([
  "node_modules",
  "Pods",
  ".git",
  "build",
  "DerivedData",
  "dist",
  ".build",
  ".expo",
  "Carthage",
  "android",
  ".gradle",
  "vendor",
  ".next",
  "coverage",
  "xcuserdata",
  ".swiftpm",
  ".appstore-shield",
  ".turbo",
  ".cache",
  "SourcePackages"
]);
async function listRepoPaths(root, includeTests = false) {
  let files;
  if (await isGitRepo(root)) {
    const out = await git(root, ["ls-files", "-co", "--exclude-standard", "-z"]);
    if (out !== void 0) {
      files = out.split("\0").filter(Boolean).filter((rel) => existsSync2(path4.join(root, rel)));
    }
  }
  if (!files) {
    files = [];
    await walkPaths(root, root, files);
  }
  files = files.filter((rel) => !rel.split("/").some((seg) => IGNORED_DIRS2.has(seg)));
  if (!includeTests) files = files.filter((rel) => !isTestPath(rel));
  const all = /* @__PURE__ */ new Set();
  for (const f of files) {
    all.add(f);
    const segs = f.split("/");
    for (let i = 1; i < segs.length; i++) all.add(segs.slice(0, i).join("/"));
  }
  return [...all].sort();
}
async function walkPaths(root, dir, out) {
  let entries;
  try {
    entries = await readdir2(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (IGNORED_DIRS2.has(e.name)) continue;
    const abs = path4.join(dir, e.name);
    const rel = path4.relative(root, abs).split(path4.sep).join("/");
    if (e.isDirectory()) await walkPaths(root, abs, out);
    else if (e.isFile()) out.push(rel);
  }
}
var LEET = {
  a: "a4@",
  b: "b8",
  e: "e3",
  g: "g9",
  i: "i1!|",
  l: "l1|",
  o: "o0",
  s: "s5$",
  t: "t7+",
  z: "z2"
};
var isLetter = (c) => !!c && new RegExp("\\p{L}", "u").test(c);
var isUpper = (c) => !!c && c !== c.toLowerCase() && c === c.toUpperCase();
var isLowerOrDigit = (c) => !!c && (/\d/.test(c) || c === c.toLowerCase() && c !== c.toUpperCase());
var escapeRx2 = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function termSource(term) {
  const t = term.toLowerCase().trim();
  const letters = [...t].filter((c) => isLetter(c)).length;
  const leet = letters >= 4;
  const seps = letters >= 5;
  const parts = [];
  const chars = [...t];
  chars.forEach((c, i) => {
    if (/[\s_-]/.test(c)) {
      parts.push("[\\s_-]*");
      return;
    }
    const cls = leet && LEET[c] ? `[${escapeRx2(LEET[c]).replace(/\\\|/g, "|")}]` : escapeRx2(c);
    parts.push(cls);
    const next = chars[i + 1];
    if (seps && next && isLetter(c) && isLetter(next)) parts.push("[-_.* ]?");
  });
  return parts.join("");
}
function termBoundaryOk(src, start, end) {
  const prev = src[start - 1];
  const first = src[start];
  const last = src[end - 1];
  const leftOk = !isLetter(prev) || isLowerOrDigit(prev) && isUpper(first);
  if (!leftOk) return false;
  const rightAt = (k) => {
    const nx = src[k];
    return !isLetter(nx) || isUpper(nx) && isLowerOrDigit(src[k - 1]);
  };
  if (rightAt(end)) return true;
  const lower = src.slice(end, end + 2).toLowerCase();
  if (lower.startsWith("s") && rightAt(end + 1)) return true;
  if (lower === "es" && rightAt(end + 2)) return true;
  return false;
}
function globSource(glob) {
  return glob.split("").map((c) => c === "*" ? "[A-Za-z0-9_.-]*" : c === "?" ? "[A-Za-z0-9_.-]" : escapeRx2(c)).join("");
}
function keyBoundary(chars) {
  return (src, start, end) => {
    const rx = new RegExp(`[${chars}]`);
    const p = src[start - 1];
    const n = src[end];
    return !(p && rx.test(p)) && !(n && rx.test(n));
  };
}
function makeNeedle(kind, value) {
  const v = value.trim();
  if (!v) return void 0;
  switch (kind) {
    case "term":
      return { kind, value: v, rx: new RegExp(termSource(v), "giu"), accept: termBoundaryOk };
    case "symbol":
      return { kind, value: v, rx: new RegExp(escapeRx2(v), "gi"), accept: keyBoundary("A-Za-z0-9_") };
    case "asset":
      return { kind, value: v, rx: new RegExp(globSource(v), "gi"), accept: keyBoundary("A-Za-z0-9_") };
    case "string":
    case "flag":
      return { kind, value: v, rx: new RegExp(escapeRx2(v), "gi"), accept: keyBoundary("A-Za-z0-9_.\\-") };
    case "endpoint":
      return { kind, value: v, rx: new RegExp(escapeRx2(v), "gi") };
    case "promptFragment": {
      const words = v.split(/\s+/).map(escapeRx2);
      return { kind, value: v, rx: new RegExp(words.join("\\s+"), "gi") };
    }
  }
}
function needlesOf(spec) {
  const out = [];
  const add = (kind, values) => {
    const seen = /* @__PURE__ */ new Set();
    for (const v of values) {
      const key = v.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const n = makeNeedle(kind, v);
      if (n) out.push(n);
    }
  };
  add("term", spec.terms);
  add("symbol", spec.symbols);
  add("asset", spec.assets);
  add("string", spec.strings);
  add("endpoint", spec.endpoints);
  add("flag", spec.flags);
  add("promptFragment", spec.promptFragments);
  return out;
}
function matchNeedle(needle, src, limit = 200) {
  const rx = new RegExp(needle.rx.source, needle.rx.flags.includes("g") ? needle.rx.flags : `${needle.rx.flags}g`);
  const out = [];
  for (const m of src.matchAll(rx)) {
    const index = m.index ?? 0;
    if (m[0].length === 0) break;
    const end = index + m[0].length;
    if (needle.accept && !needle.accept(src, index, end)) continue;
    out.push({ index, end, text: m[0] });
    if (out.length >= limit) break;
  }
  return out;
}
function matchesAny(needles, text) {
  return needles.find((n) => matchNeedle(n, text, 1).length > 0);
}
function lineText(text, index) {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? text.length : end).trim();
}
var AI_HOSTS = /(api\.openai\.com|generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com|api\.anthropic\.com|api\.replicate\.com|replicate\.com|fal\.run|fal\.ai|fal\.media|api\.stability\.ai|api\.bfl\.(ai|ml)|api\.together\.xyz|api\.deepinfra\.com|api\.runpod\.ai|openrouter\.ai|api\.x\.ai|api\.mistral\.ai|api\.groq\.com|api\.fireworks\.ai|api\.leonardo\.ai|api\.ideogram\.ai|api\.midjourney|api\.novita\.ai|modelslab\.com|stablediffusionapi\.com|api-inference\.huggingface\.co)/i;
var AI_SINK = new RegExp(
  [
    AI_HOSTS.source,
    String.raw`\bopenai\.(images|chat|responses|completions)\b`,
    String.raw`\.images\.(generate|edit|createVariation)\s*\(`,
    String.raw`images/(generations|edits|variations)`,
    String.raw`chat/completions`,
    String.raw`\bgenerateContent(Stream)?\s*\(`,
    String.raw`\bmessages\.create\s*\(`,
    String.raw`\breplicate\.(run|predictions)\b`,
    String.raw`\bfal\.(run|subscribe|queue)\b`,
    String.raw`\b(txt2img|img2img)\b`,
    String.raw`\bImageCreator\b`,
    String.raw`\bImagePlayground\w*\b`,
    String.raw`\bLanguageModelSession\b`,
    String.raw`\bStableDiffusionPipeline\b`
  ].join("|"),
  "i"
);
var AI_SOURCES = [
  { label: "free-text prompt", rx: /\b(TextField|TextEditor)\s*\(|<TextInput\b|\bonChangeText\b|\bUITextView\b|\bUITextField\b/ },
  { label: "image upload", rx: /\b(PhotosPicker|UIImagePickerController|PHPickerViewController|launchImageLibraryAsync|launchCameraAsync|ImagePicker\.\w+|DocumentPicker\w*|getDocumentAsync)\b/ },
  { label: "deep link", rx: /\b(onOpenURL|getInitialURL|useURL|useLocalSearchParams|continueUserActivity)\b|Linking\.addEventListener|application\([^)]*\bopen\s+url\b/ },
  { label: "voice input", rx: /\b(SFSpeechRecognizer|AVAudioRecorder|useSpeechRecognition|Voice\.start)\b/ },
  { label: "shared content", rx: /\b(NSExtensionContext|ShareExtension|onDrop|UIPasteboard)\b/ }
];
function omniKind(code, hit, idx) {
  if (!/^omni-moderation/i.test(hit)) return "text";
  return MODERATION_IMAGE_INPUT.test(code.slice(Math.max(0, idx - MODERATION_REQUEST_WINDOW), idx + hit.length + MODERATION_REQUEST_WINDOW)) ? "image" : "text";
}
var MODERATION_TEXT = /(\/v1\/moderations|\bmoderations\.create\b|text-moderation|omni-moderation|commentanalyzer\.googleapis|perspectiveapi|\bmoderate(Text|Prompt|Content)\s*\(|\bModerationService\b|contentmoderator)/i;
var MODERATION_IMAGE = /(DetectModerationLabels|detectModerationLabels|\bSCSensitivityAnalyzer\b|SensitiveContentAnalysis|\bmoderateImage\s*\(|\bnsfwjs\b|\bNSFWDetector\b|api\.sightengine\.com|thehive\.ai|api\.hive\.ai|vision\.googleapis\.com[^"'`]*safeSearch|SafeSearchDetection|safeSearchDetection)/i;
var SAFETY_DISABLED2 = /(\bBLOCK_NONE\b|HarmBlockThreshold\.(OFF|BLOCK_NONE)|\bthreshold\b["']?\s*[:=]\s*["']?OFF\b|disable_safety_checker["']?\s*[:=]\s*(true|True)|enable_safety_checker["']?\s*[:=]\s*(false|False)|safety_tolerance["']?\s*[:=]\s*["']?[5-6]\b|\bsafety_checker["']?\s*[:=]\s*(false|False|None|null)\b|\bmoderation["']?\s*[:=]\s*["']low["'])/;
var SAFETY_STRICT = /(\bBLOCK_LOW_AND_ABOVE\b|\bBLOCK_MEDIUM_AND_ABOVE\b|safety_tolerance["']?\s*[:=]\s*["']?[0-2]\b|enable_safety_checker["']?\s*[:=]\s*(true|True)|disable_safety_checker["']?\s*[:=]\s*(false|False))/;
var SERVER_DIRS2 = ["workers/", "functions/", "supabase/functions/", "api/", "server/"];
var isServerPath = (rel) => SERVER_DIRS2.some((d) => rel.startsWith(d) || rel.includes(`/${d}`));
var CODE2 = new Set(CODE_EXTENSIONS);
var isCodeFile = (f) => CODE2.has(f.ext);
var BLOCKLIST_NAME = /(block|deny|ban(ned|list|_?words|_?terms)|forbid|disallow|reject|refus|profan|moderat|prohibit|stop_?words|bad_?words|(nsfw|unsafe|sensitive|restricted|filter(ed)?)[_-]?(words|terms|keywords|phrases|list))/i;
var maskedCache2 = /* @__PURE__ */ new WeakMap();
function maskedOf2(f) {
  let m = maskedCache2.get(f);
  if (m === void 0) {
    m = blankStrings(f.code, f.ext);
    maskedCache2.set(f, m);
  }
  return m;
}
var DECL_RX = /(?:^|[\s;{(])(?:(?:export\s+)?(?:default\s+)?(?:public\s+|private\s+|fileprivate\s+|internal\s+|static\s+|final\s+|lazy\s+|async\s+)*)(?:func|function|class|struct|enum|protocol|interface|type|typealias|let|var|const|val)\s+([A-Za-z_$][\w$]*)/;
function enclosingDeclarations(file2, index, maxLevels = 8) {
  const masked = maskedOf2(file2);
  const out = [];
  let depth = 0;
  let levels = 0;
  const opens = [];
  for (let k = index - 1; k >= 0 && levels < maxLevels; k--) {
    const ch = masked[k];
    if (ch === "}" || ch === "]" || ch === ")") depth++;
    else if (ch === "{" || ch === "[" || ch === "(") {
      if (depth > 0) {
        depth--;
        continue;
      }
      opens.push(k);
      levels++;
    }
  }
  for (let i = 0; i < opens.length; i++) {
    const open4 = opens[i];
    const lineStart = masked.lastIndexOf("\n", open4 - 1) + 1;
    const prevLineStart = masked.lastIndexOf("\n", Math.max(0, lineStart - 2)) + 1;
    const header = file2.code.slice(prevLineStart, open4).replace(/\s+/g, " ").trim();
    const thisLine = file2.code.slice(lineStart, open4);
    const m = DECL_RX.exec(` ${thisLine}`) ?? DECL_RX.exec(` ${header}`);
    if (!m || !m[1]) continue;
    const declKind = /\b(func|function|class|struct|enum|protocol|interface|type|typealias|let|var|const|val)\s+[A-Za-z_$]/.exec(m[0])?.[1] ?? "";
    out.push({
      ident: m[1],
      header,
      depth: opens.length - 1 - i,
      exported: /\bexport\b|@main|@objc|@IBAction|@IBOutlet|override\b|@UIApplicationMain/.test(header),
      declKind
    });
  }
  return out;
}
var identCountCache = /* @__PURE__ */ new WeakMap();
function identifierCount(ctx, ident) {
  let cache = identCountCache.get(ctx);
  if (!cache) {
    cache = /* @__PURE__ */ new Map();
    identCountCache.set(ctx, cache);
  }
  const hit = cache.get(ident);
  if (hit !== void 0) return hit;
  const rx = new RegExp(`(?<![\\w$])${escapeRx2(ident)}(?![\\w$])`, "g");
  let n = 0;
  for (const f of ctx.files) {
    if (!isCodeFile(f)) continue;
    n += (maskedOf2(f).match(rx) ?? []).length;
  }
  cache.set(ident, n);
  return n;
}
var VALUE_DECL = /^(let|var|const|val)$/;
var LIST_CALL = /\b(setOf|listOf|arrayOf|mutableListOf|mutableSetOf|hashSetOf|Set|NSSet|NSArray)\s*(<[^>]*>)?\s*$/;
var QUALIFIER = /(?:[\w$]+[?!]?\.)+$/;
var MEMBERSHIP_AFTER = /^\s*[?!]?\.\s*(contains|includes|has|some|any|anyMatch|allSatisfy|first\s*\(\s*where|firstIndex|findIndex|find|index\s*\(\s*of|test|matches|isDisjoint|intersection|intersects|isSuperset|isSubset|filter|contains_any)\b/;
var MEMBERSHIP_BEFORE = /(\b\w*(contain|include|match|intersect|disjoint|subset|superset|overlap)\w*\s*\(\s*(\w+\s*:\s*)?|\b(in|of)\s+)$/i;
var DECIDES = /\b(throws?|raise|reject\w*|return|guard|abort|fatalError|precondition|cancel|deny|refus\w*|block\w*|disallow\w*|forbid\w*|unsafe|violat\w*|error|nil|false|allow\w*|safe)\b|=>/i;
var CONTAINS_OP = /\b(contains|includes|range\s*\(\s*of|hasPrefix|hasSuffix|test|match(es)?|indexOf|in)\b|===?/;
var UI_ELEMENT = /\b(Button|Text|Image|Label|Toggle|NavigationLink|Tab|Option|Chip|Card|Cell)\s*[({]|<[A-Z]\w*/;
var CONTENT_BEFORE = /(\b(ForEach|List|Picker|Menu|FlatList|SectionList|LazyVGrid|LazyHGrid|LazyVStack|LazyHStack|TabView|Carousel|Select|Segmented\w*)\s*\(\s*(\w+\s*:\s*)?|\b(data|items|options|presets|styles|choices|sections|outfits|looks|templates|categories|effects)\s*[:=]\s*\{?\s*|\.\.\.|\bconcat\s*\(\s*|contentsOf\s*:\s*|\+=\s*|(?<!\+)\+\s*)$/;
var CONTENT_AFTER = /^\s*([?!]?\.\s*(map|compactMap|flatMap|enumerated|randomElement|shuffled|joined|join|sorted|reversed|first|last|prefix|suffix|slice|at|indices|values|keys)\b|\[|\+(?![+=]))/;
var BARE_BEFORE = /(\breturn\s+|\{\s*|^\s*|=>\s*)$/;
var BARE_AFTER = /^\s*[}\]);,]*\s*$/;
var ASSIGN_AFTER = /^\s*(:\s*[^=\n]+)?=(?![=>])/;
var SAME_LINE_DECL = /\b(?:let|var|const|val)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=(?![=>])/;
var usesCache = /* @__PURE__ */ new WeakMap();
function listUses(files, ident, depth = 0) {
  let cache = usesCache.get(files);
  if (!cache) {
    cache = /* @__PURE__ */ new Map();
    usesCache.set(files, cache);
  }
  const hit = cache.get(ident);
  if (hit) return hit;
  const out = { filter: 0, content: 0, other: 0 };
  cache.set(ident, out);
  const rx = new RegExp(`(?<![\\w$])${escapeRx2(ident)}(?![\\w$])`, "g");
  const interp = new RegExp(`(\\\\\\(|\\$\\{)[^)}\\n]*(?<![\\w$])${escapeRx2(ident)}(?![\\w$])`);
  for (const f of files) {
    if (!isCodeFile(f)) continue;
    if (interp.test(f.code)) out.content++;
    const masked = maskedOf2(f);
    for (const m of masked.matchAll(rx)) {
      const idx = m.index ?? 0;
      const lineStart = masked.lastIndexOf("\n", idx - 1) + 1;
      const lineEnd = masked.indexOf("\n", idx);
      const before = masked.slice(lineStart, idx);
      const pre = before.replace(QUALIFIER, "");
      const lineRest = masked.slice(idx + ident.length, lineEnd === -1 ? masked.length : lineEnd);
      if (pre === before && ASSIGN_AFTER.test(lineRest)) continue;
      const chained = lineRest.trim() === "" && lineEnd !== -1 ? /^\s*([?!]?\.[^\n]*)/.exec(masked.slice(lineEnd + 1, lineEnd + 400))?.[1] : void 0;
      const rest = chained ?? lineRest;
      const window = masked.slice(lineStart, nthLineEnd(masked, idx, 3)).replace(rx, " ");
      const loop = /\b(in|of)\s+$/.test(pre);
      const copied = /\.\.\.$/.test(pre) ? afterLiteral(masked, idx) : void 0;
      if (copied !== void 0 && MEMBERSHIP_AFTER.test(copied)) {
        if (DECIDES.test(window)) out.filter++;
        else out.other++;
        continue;
      }
      if (loop && UI_ELEMENT.test(window)) {
        out.content++;
        continue;
      }
      if (MEMBERSHIP_AFTER.test(rest) || MEMBERSHIP_BEFORE.test(pre)) {
        if (CONTENT_BEFORE.test(pre) && !MEMBERSHIP_BEFORE.test(pre)) out.content++;
        else if (DECIDES.test(window) && (!loop || CONTAINS_OP.test(window.slice(window.indexOf("\n") + 1)) || CONTAINS_OP.test(pre.replace(/\bfor\b(?![^]*\bfor\b)[^]*$/, "")))) out.filter++;
        else out.other++;
        continue;
      }
      const combines = CONTENT_BEFORE.test(pre) || CONTENT_AFTER.test(rest) || BARE_BEFORE.test(pre) && BARE_AFTER.test(rest);
      if (!combines) {
        out.other++;
        continue;
      }
      const outer = SAME_LINE_DECL.exec(before)?.[1] ?? (innermostOpen(masked, idx, Math.max(0, idx - 4e3))?.ch === "[" ? enclosingDeclarations(f, idx, 2).find((d) => VALUE_DECL.test(d.declKind) && d.ident !== ident)?.ident : void 0);
      if (outer && outer !== ident && depth < 3) {
        const o = listUses(files, outer, depth + 1);
        if (o.content) out.content++;
        else if (o.filter) out.filter++;
        else out.other++;
      } else {
        out.content++;
      }
    }
  }
  return out;
}
function afterLiteral(masked, index) {
  const open4 = innermostOpen(masked, index, Math.max(0, index - 400));
  if (open4?.ch !== "[" || /[\w$)\]]\s*$|=\s*$/.test(masked.slice(Math.max(0, open4.at - 40), open4.at))) return void 0;
  let depth = 0;
  for (let k = open4.at; k < masked.length && k < open4.at + 2e3; k++) {
    const ch = masked[k];
    if (ch === "[" || ch === "(" || ch === "{") depth++;
    else if (ch === "]" || ch === ")" || ch === "}") {
      depth--;
      if (depth === 0) return masked.slice(k + 1, k + 200);
    }
  }
  return void 0;
}
function nthLineEnd(text, from, n) {
  let at = from;
  for (let i = 0; i <= n; i++) {
    const nl = text.indexOf("\n", at);
    if (nl === -1) return text.length;
    at = nl + 1;
  }
  return at - 1;
}
function innermostOpen(masked, index, floor = 0) {
  let depth = 0;
  for (let k = index - 1; k >= floor; k--) {
    const ch = masked[k];
    if (ch === "}" || ch === "]" || ch === ")") depth++;
    else if (ch === "{" || ch === "[" || ch === "(") {
      if (depth > 0) depth--;
      else return { ch, at: k };
    }
  }
  return void 0;
}
function blocklistAt(ctx, file2, index) {
  return blocklistIn(ctx.files, file2, index);
}
function blocklistIn(files, file2, index) {
  const line = lineOf(file2.text, index);
  const base = path4.basename(file2.path).replace(/\.[^.]+$/, "");
  if (BLOCKLIST_NAME.test(base) && !isCodeFile(file2)) {
    return { name: base, file: file2.path, line, used: referencedByName(files, base, file2.path) };
  }
  if (isCodeFile(file2)) {
    const masked = maskedOf2(file2);
    const open4 = innermostOpen(masked, index, Math.max(0, index - 2e4));
    if (!open4) return void 0;
    const listOpen = open4.ch === "[" || open4.ch === "(" && LIST_CALL.test(masked.slice(Math.max(0, open4.at - 24), open4.at));
    if (!listOpen) return void 0;
    const d = enclosingDeclarations(file2, open4.at + 1, 2).find((x) => VALUE_DECL.test(x.declKind))?.ident;
    if (!d) return void 0;
    const u = listUses(files, d);
    if (u.content) return void 0;
    if (u.filter) return { name: d, file: file2.path, line, used: true };
    if (!BLOCKLIST_NAME.test(d)) return void 0;
    return { name: d, file: file2.path, line, used: false };
  }
  const lines = file2.text.split("\n");
  for (let i = line - 1; i >= 0 && i >= line - 200; i--) {
    const l = lines[i] ?? "";
    const key = /^\s*(?:<key>([\w.-]+)<\/key>|["']?([\w.-]+)["']?\s*[:=])/.exec(l);
    if (key) {
      const name = key[1] ?? key[2] ?? "";
      if (!BLOCKLIST_NAME.test(name)) return void 0;
      return { name, file: file2.path, line, used: referencedByName(files, name, file2.path) };
    }
  }
  return void 0;
}
function referencedByName(files, name, self) {
  const rx = new RegExp(`["'/]${escapeRx2(name)}(\\.\\w+)?["']|\\b${escapeRx2(name)}\\b`);
  return files.some((f) => f.path !== self && isCodeFile(f) && rx.test(f.code));
}
var REFUSAL = /\b(never|do not|don't|must not|mustn't|refuse to|decline to|avoid|not allowed|prohibited|forbidden|disallowed)\b/i;
var REFUSAL_LOOPHOLE = /\b(unless|except|only if|but if|if the user|premium|subscriber|when asked)\b|\b(never|don't|do not)\s+(refuse|decline|reject)/i;
function isRefusalInstruction(text, index) {
  const start = Math.max(text.lastIndexOf(".", index - 1), text.lastIndexOf("\n", index - 1)) + 1;
  const endDot = text.indexOf(".", index);
  const endNl = text.indexOf("\n", index);
  const ends = [endDot, endNl].filter((n) => n >= 0);
  const end = ends.length ? Math.min(...ends) : text.length;
  const sentence = text.slice(start, end);
  const before = text.slice(start, index);
  return REFUSAL.test(before) && !REFUSAL_LOOPHOLE.test(sentence);
}
var MODERATION_RESULT = /\b(category_scores|categoryScores|category_applied_input_types|flagged|safetyRatings|safety_ratings|HarmCategory|HARM_CATEGORY_\w+|ModerationLabels|moderationLabels)\b/;
var isModerationSite = (g) => isCodeFile(g) && (MODERATION_TEXT.test(g.code) || MODERATION_IMAGE.test(g.code) || SAFETY_STRICT.test(g.code) || SAFETY_DISABLED2.test(g.code));
var moderationCtxCache = /* @__PURE__ */ new WeakMap();
function moderationContext(files, f) {
  let cache = moderationCtxCache.get(files);
  if (!cache) moderationCtxCache.set(files, cache = /* @__PURE__ */ new Map());
  const hit = cache.get(f);
  if (hit !== void 0) return hit;
  let ok = isModerationSite(f);
  if (!ok && isCodeFile(f) && MODERATION_RESULT.test(f.code)) {
    const mine = new Set(declaredNames(f));
    const used = identifiersOf([f]);
    ok = files.some((g) => g !== f && g.path !== f.path && isModerationSite(g) && (declaredNames(g).some((n) => used.has(n)) || [...identifiersOf([g])].some((n) => mine.has(n))));
  }
  cache.set(f, ok);
  return ok;
}
function literalAround(code, index) {
  const start = code.lastIndexOf("\n", index - 1) + 1;
  const endNl = code.indexOf("\n", index);
  const line = code.slice(start, endNl === -1 ? code.length : endNl);
  for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`([^`]*)`/g)) {
    const a = start + (m.index ?? 0);
    if (a < index && index < a + m[0].length) return { open: a, close: a + m[0].length, value: m[1] ?? m[2] ?? m[3] ?? "" };
  }
  return void 0;
}
var RESULT_WORD = String.raw`(?:categories|category_?scores|categoryScores|category_applied_input_types|[\w$]*[sS]cores?|safety_?[rR]atings|ratings|[\w$]*[mM]oderation[\w$]*|[\w$]*[tT]hresholds?|harm[\w$]*)[?!]?`;
var RESULT_SUBSCRIPT = new RegExp(String.raw`\b${RESULT_WORD}\s*(\[\s*|\.\s*(get|getValue|value|optDouble|getDouble|getFloat|getBoolean|valueForKey|objectForKey)\s*\(\s*)$`, "i");
var RESULT_CHAIN = new RegExp(String.raw`\b${RESULT_WORD}\s*\.\s*$`, "i");
var RESULT_TYPE = /categor|score|rating|moderat|safety|harm|threshold/i;
function moderationKeyIn(files, f, index, end) {
  if (!isCodeFile(f) || !moderationContext(files, f)) return false;
  const src = f.code;
  let a = index;
  let b = end;
  while (a > 0 && /[\w$]/.test(src[a - 1])) a--;
  while (b < src.length && /[\w$]/.test(src[b])) b++;
  const ident = src.slice(a, b);
  const before = src.slice(Math.max(0, a - 120), a);
  if (/^HARM_CATEGORY_/.test(ident) || /\bHarmCategory\w*\s*\.\s*$/.test(before)) return true;
  const masked = maskedOf2(f);
  const inResultDecl = () => enclosingDeclarations(f, index).some((d) => RESULT_TYPE.test(d.ident));
  if (masked.slice(index, end) !== src.slice(index, end)) {
    const lit = literalAround(src, index);
    if (!lit || !/^[A-Za-z][\w/ .-]{0,39}$/.test(lit.value)) return false;
    if (RESULT_SUBSCRIPT.test(src.slice(Math.max(0, lit.open - 120), lit.open))) return true;
    const keyed = /^\s*:/.test(src.slice(lit.close, lit.close + 4)) || /\bcase\s+[\w$]+\s*=\s*$/.test(src.slice(Math.max(0, lit.open - 80), lit.open));
    return keyed && inResultDecl();
  }
  if (RESULT_CHAIN.test(before)) return true;
  const line = lineText(src, index);
  if (!new RegExp(`^(?:(?:public|private|internal|readonly|export|@\\w+)\\s+)*(?:(?:let|var|val)\\s+)?["']?${escapeRx2(ident)}["']?\\??\\s*:`).test(line)) return false;
  return inResultDecl();
}
var CATEGORIES = [
  {
    id: "lingerie",
    describe: "images of a person in lingerie, underwear or similarly revealing clothing",
    triggers: /\b(lingerie|underwear|bikini|swimsuit|revealing (clothing|outfits?)|undergarments?|bra|panties|thong|negligee|boudoir)\b/i,
    terms: ["lingerie", "underwear", "bra", "panties", "thong", "negligee", "bikini", "swimsuit", "corset", "see-through", "boudoir", "nightie"]
  },
  {
    id: "nudity",
    describe: "nude or sexually explicit images, including undressing a real person's photo",
    triggers: /\b(nud(e|ity)|naked|pornograph\w*|sexually explicit|nsfw|topless|undress\w*|1\.1\.4|ncii|nudif\w*)\b/i,
    terms: ["nude", "naked", "nudity", "nsfw", "topless", "undress", "porn", "x-ray", "nudify"]
  },
  {
    id: "sexual",
    describe: "sexualized or overtly sexual content",
    triggers: /\b(sexual\w*|sexy|erotic\w*|seductive|lewd|overtly sexual|adult content|fetish\w*|1\.1\.4)\b/i,
    terms: ["sexual", "sexy", "erotic", "seductive", "lewd", "spicy", "fetish", "adult content", "nsfw"]
  },
  {
    id: "violence",
    describe: "graphic violence or gore",
    triggers: /\b(violen\w*|gore|gory|graphic|blood\w*|torture|dismember\w*|1\.1\.2)\b/i,
    terms: ["violence", "violent", "gore", "gory", "bloody", "dismember", "torture", "behead", "mutilate"]
  },
  {
    id: "drugs",
    describe: "content that encourages illegal drug use",
    triggers: /\b(drugs?|narcotic\w*|cocaine|heroin|marijuana|cannabis|1\.4\.3)\b/i,
    terms: ["drugs", "cocaine", "heroin", "meth", "marijuana", "cannabis", "mdma", "weed"]
  },
  {
    id: "self-harm",
    describe: "content that depicts or encourages self-harm or suicide",
    triggers: /\b(self[- ]?harm|suicid\w*|eating disorder)\b/i,
    terms: ["self-harm", "suicide", "suicidal", "self harm", "pro-ana"]
  },
  {
    id: "hate",
    describe: "hateful, discriminatory or defamatory content",
    triggers: /\b(hate|hateful|discriminat\w*|racis\w*|slurs?|defamatory|1\.1\.1)\b/i,
    terms: ["hate", "hateful", "slur", "racist", "nazi", "supremacist", "bigot"]
  },
  {
    id: "weapons",
    describe: "content that facilitates weapons or explosives",
    triggers: /\b(weapons?|firearms?|explosives?|1\.4\.3)\b/i,
    terms: ["weapon", "firearm", "explosive", "ammo", "bomb"]
  },
  {
    id: "gambling",
    describe: "real-money gambling",
    triggers: /\b(gambl\w*|casino|betting|5\.3)\b/i,
    terms: ["gambling", "casino", "betting", "wager"]
  }
];
var LEXICON = new Set(CATEGORIES.flatMap((c) => c.terms));
var STOPWORDS = new Set(
  `about above after again against also apple apps application because been before being below between both cannot could
  does doing down during each few from further guideline guidelines have having here hers herself himself however into
  itself just more most must myself need only other ours ourselves over please same section should some such than that
  their theirs them themselves then there these they this those through under until very what when where which while
  will with within would your yours yourself yourselves review reviewed reviewer submission submitted content contents
  feature features user users safety objectionable include includes including issue issues found specifically hello
  thank thanks regards team information resolution center next steps update updated version build binary store
  inappropriate appropriate generated generate generates generating create created allow allows allowed allowing
  people person persons image images photo photos picture pictures option options make makes made like using used
  provide provided able potentially example examples following note notes`.split(/\s+/)
);
var SEXUAL_FAMILY = /* @__PURE__ */ new Set(["lingerie", "nudity", "sexual"]);
var CONTENT_NOUNS = ["outfit", "costume", "wardrobe", "clothing", "clothes", "attire", "lingerie"];
var isContextTerm = (t) => t.category === "content";
function termsFromRejection(text) {
  const categories = CATEGORIES.filter((c) => c.triggers.test(text));
  const out = /* @__PURE__ */ new Map();
  const add = (t) => {
    const key = t.term.toLowerCase();
    if (!out.has(key)) out.set(key, { ...t, term: key });
  };
  for (const m of text.matchAll(/[“"']([^“”"'\n]{3,40})[”"']/g)) {
    const q = m[1].trim();
    if (q.split(/\s+/).length <= 4 && !/^\d/.test(q)) add({ term: q, origin: "quoted" });
  }
  const words = (text.toLowerCase().match(/[\p{L}][\p{L}'-]{3,}/gu) ?? []).map((w) => w.replace(/'s$/, ""));
  for (const w of words) {
    for (const c of categories) {
      const hit = c.terms.includes(w) ? w : c.terms.includes(w.replace(/s$/, "")) ? w.replace(/s$/, "") : void 0;
      if (hit) add({ term: hit, origin: "rejection", category: c.id });
    }
  }
  for (const c of categories) for (const t of c.terms) add({ term: t, origin: "lexicon", category: c.id });
  if (categories.some((c) => SEXUAL_FAMILY.has(c.id))) {
    for (const c of CATEGORIES.filter((x) => SEXUAL_FAMILY.has(x.id) && !categories.includes(x))) {
      for (const t of c.terms) add({ term: t, origin: "lexicon", category: c.id });
    }
    for (const w of words) {
      const noun = CONTENT_NOUNS.find((n) => w === n || w === `${n}s`);
      if (noun) add({ term: noun, origin: "rejection", category: "content" });
    }
  }
  const known = new Set(out.keys());
  const otherWords = [...new Set(words)].filter((w) => !STOPWORDS.has(w) && !known.has(w) && !known.has(w.replace(/s$/, ""))).slice(0, 25);
  return { terms: [...out.values()], categories, otherWords };
}
var IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|pdf|svg|mp4|mov|m4v|webm|gltf|glb|usdz)$/i;
var ASSET_SET = /\.(imageset|colorset|dataset|symbolset|appiconset|textureset|spriteatlas)$/i;
var FLAG_READ = /\b(remoteConfig|RemoteConfig|configValue|getBoolean|getValue|getString|isFeatureEnabled|featureFlag|useFlag|useFeatureFlag|useFeatureFlagEnabled|useGate|checkGate|getFeatureGate|boolVariation|variation|getFeatureValue|isOn|isEnabled)\s*(?:\(\s*\)\s*)?(?:\(\s*(?:forKey:\s*)?|\[\s*)["'`]([\w.:-]+)["'`]/g;
var REMOTE_CONFIG_FILE = /\b(remoteConfig|RemoteConfig|setDefaults|featureFlag|useFlag|useFeatureFlag|LaunchDarkly|Statsig|GrowthBook|ConfigCat|Unleash)\b/;
var STRINGS_PAIR = /^\s*"((?:[^"\\]|\\.)+)"\s*=\s*"((?:[^"\\]|\\.)*)"\s*;/gm;
var URL_LIT = /["'`]((?:https?:\/\/|\/)[^\s"'`]{2,200})["'`]/g;
var CREDENTIAL_FIELD = /\b(?:TextField|TextInput|UITextField)\b[^\n]{0,80}?["'`$(](?:e-?mail(?:\s*address)?|password|passcode|user\s*name|username|(?:first|last|full|display|nick)?\s*name|name\s*draft|search(?:\s+\w+)?|phone|code)["'`)\s,]|\bSecureField\b|\bsecureTextEntry\b|\bkeyboardType\s*[:=]\s*["'`.](?:email|emailAddress|email-address|phonePad|numberPad)|\btextContentType\s*[:=]\s*["'`.]?(?:emailAddress|username|password|newPassword|name|oneTimeCode)/i;
function isCredentialField(src, index) {
  const line = lineText(src, index);
  return CREDENTIAL_FIELD.test(line) || /\$(?:email|password|username|userName|name|nameDraft|search\w*|query)\b/.test(line);
}
var DECLARED_TYPE = /\b(?:class|struct|enum|protocol|actor|interface|object|extension)\s+([A-Z][\w]*)|\bfunction\s+([A-Za-z_$][\w$]*)|\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
var LINK_SKIP = /* @__PURE__ */ new Set(["App", "View", "Body", "Content", "ContentView", "Model", "State", "Error", "Failure", "Result", "Config"]);
function declaredNames(f) {
  const out = /* @__PURE__ */ new Set();
  for (const m of f.code.matchAll(DECLARED_TYPE)) {
    const n = m[1] ?? m[2] ?? m[3];
    if (n && n.length >= 3 && !LINK_SKIP.has(n)) out.add(n);
  }
  return [...out];
}
function identifiersOf(files) {
  return new Set(files.flatMap((f) => f.code.match(/[A-Za-z_$][\w$]*/g) ?? []));
}
function linkedSinks(ctx, sourceFile, sinks) {
  const f = ctx.files.find((x) => x.path === sourceFile);
  if (!f) return [];
  const used = identifiersOf([f]);
  const reach = /* @__PURE__ */ new Set([sourceFile]);
  for (const g of ctx.files) if (g.path !== sourceFile && isCodeFile(g) && declaredNames(g).some((n) => used.has(n))) reach.add(g.path);
  return sinks.filter((s) => reach.has(s.file));
}
function offsetOfLine(text, line) {
  let at = 0;
  for (let i = 1; i < line; i++) {
    const nl = text.indexOf("\n", at);
    if (nl === -1) return at;
    at = nl + 1;
  }
  return at;
}
function boundVariable(code, window) {
  const binding = /\$([A-Za-z_]\w*)/.exec(window)?.[1];
  if (binding) return binding;
  const setter = /\bonChangeText\s*=\s*\{\s*(?:\(?\s*\w+\s*\)?\s*=>\s*)?(set[A-Z]\w*)/.exec(window)?.[1];
  if (setter) {
    const state = new RegExp(String.raw`\[\s*([A-Za-z_$][\w$]*)\s*,\s*${setter}\s*\]`).exec(code)?.[1];
    if (state) return state;
  }
  const value = /\bvalue\s*=\s*\{\s*([A-Za-z_$][\w$]*)\s*\}/.exec(window)?.[1];
  if (value) return value;
  return /(?:const|let|var)\s+(?:\{\s*)?([A-Za-z_$][\w$]*)[^=\n]*=\s*(?:await\s+)?[\w.]*(?:launchImageLibraryAsync|launchCameraAsync|getDocumentAsync|ImagePicker\.\w+)/.exec(window)?.[1];
}
function blockEnd(masked, open4) {
  let depth = 0;
  for (let k = open4; k < masked.length; k++) {
    const c = masked[k];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return k;
  }
  return masked.length;
}
var FUNC_HEADER = /(?:\bfunc\s+([A-Za-z_]\w*)|\bfunction\s+([A-Za-z_$][\w$]*)|\b([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>|^\s*(?:async\s+)?([a-z_$][\w$]*)\s*\([^()]*\)\s*(?::\s*[^{]+)?)[^{};]*$/;
function enclosingFunction(f, index) {
  const masked = maskedOf2(f);
  let depth = 0;
  for (let k = index - 1; k >= 0; k--) {
    const c = masked[k];
    if (c === "}") depth++;
    else if (c === "{") {
      if (depth > 0) {
        depth--;
        continue;
      }
      const lineStart = masked.lastIndexOf("\n", k - 1) + 1;
      const m = FUNC_HEADER.exec(masked.slice(lineStart, k));
      const name = m?.[1] ?? m?.[2] ?? m?.[3] ?? m?.[4];
      if (name && !/^(body|render|if|for|while|switch|catch|guard|else|do)$/.test(name) && !/^[A-Z]/.test(name)) return [k, blockEnd(masked, k)];
    }
  }
  return void 0;
}
function statementRegion(f, index) {
  const masked = maskedOf2(f);
  const start = masked.lastIndexOf("\n", index - 1) + 1;
  let end = masked.indexOf("\n", index);
  if (end === -1) end = masked.length;
  let depth = 0;
  for (let k = start; k < masked.length && k - start < 4e3; k++) {
    const c = masked[k];
    if (c === "{" || c === "(") depth++;
    else if ((c === "}" || c === ")") && depth > 0) depth--;
    if (k >= end && depth === 0) return [start, k];
  }
  return [start, end];
}
function linkSource(ctx, source, sinks) {
  const inferred = linkedSinks(ctx, source.file, sinks);
  const f = ctx.files.find((x) => x.path === source.file);
  if (!f || !isCodeFile(f) || !sinks.length) return { traced: [], inferred };
  const srcAt = offsetOfLine(f.code, source.line);
  const srcEnd = offsetOfLine(f.code, source.line + 3);
  const window = f.code.slice(srcAt, srcEnd > srcAt ? srcEnd : f.code.length);
  const variable = boundVariable(f.code, window);
  if (!variable) return { traced: [], inferred };
  const masked = maskedOf2(f);
  const regions = [];
  for (const m of f.code.matchAll(new RegExp(`(?<![\\w$])${escapeRx2(variable)}(?![\\w$])`, "g"))) {
    const at = m.index ?? 0;
    if (at >= srcAt && at < srcAt + window.length) continue;
    if (/(?:var|let|const|val)\s+$|\[\s*$/.test(f.code.slice(Math.max(0, at - 40), at))) continue;
    regions.push(enclosingFunction(f, at) ?? statementRegion(f, at));
  }
  if (!regions.length) return { traced: [], inferred, variable };
  const helpers = /* @__PURE__ */ new Map();
  for (const m of masked.matchAll(/\b(?:func|function)\s+([A-Za-z_$][\w$]*)\s*[(<]/g)) {
    const open4 = masked.indexOf("{", m.index ?? 0);
    if (open4 !== -1) helpers.set(m[1], [open4, blockEnd(masked, open4)]);
  }
  for (const [a, b] of [...regions]) {
    for (const call of f.code.slice(a, b).matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
      const h = helpers.get(call[1]);
      if (h && !regions.some(([x, y]) => x === h[0] && y === h[1])) regions.push(h);
    }
  }
  const propType = /* @__PURE__ */ new Map();
  for (const m of f.code.matchAll(/\b(?:let|var|const)\s+([A-Za-z_$][\w$]*)\s*(?::\s*([A-Z]\w*))?\s*(?:=\s*(?:new\s+)?([A-Z]\w*)\b)?/g)) {
    const t = m[3] ?? m[2];
    if (t) propType.set(m[1], t);
  }
  const names = /* @__PURE__ */ new Set();
  for (const [a, b] of regions) {
    for (const id of f.code.slice(a, b).match(/[A-Za-z_$][\w$]*/g) ?? []) {
      names.add(id);
      const t = propType.get(id);
      if (t) names.add(t);
    }
  }
  const declaresUsed = (g) => declaredNames(g).some((n) => names.has(n));
  const viaTypes = ctx.files.filter((g) => g.path !== f.path && isCodeFile(g) && declaresUsed(g));
  const traced = sinks.filter((s) => {
    if (s.file === f.path) {
      const at = offsetOfLine(f.code, s.line);
      return regions.some(([a, b]) => at >= masked.lastIndexOf("\n", a) + 1 && at <= b);
    }
    if (viaTypes.some((g) => g.path === s.file)) return true;
    const sinkFile = ctx.files.find((x) => x.path === s.file);
    const sinkNames = sinkFile ? declaredNames(sinkFile) : [];
    return viaTypes.some((g) => {
      const ids = identifiersOf([g]);
      return sinkNames.some((n) => ids.has(n));
    });
  });
  return { traced, inferred: inferred.filter((s) => !traced.includes(s)), variable };
}
function siteScan(ctx) {
  const sources = [];
  const sinks = [];
  const moderation = [];
  const push = (arr, role, label, f, idx) => arr.push({ role, label, file: f.path, line: lineOf(f.code, idx), evidence: lineText(f.text, idx).slice(0, 160) });
  for (const f of ctx.files) {
    if (!isCodeFile(f) && !["json", "yaml", "yml", "toml"].includes(f.ext)) continue;
    const src = f.code;
    for (const m of src.matchAll(new RegExp(AI_SINK.source, "gi"))) push(sinks, "sink", m[0], f, m.index ?? 0);
    for (const s of AI_SOURCES) {
      for (const m of src.matchAll(new RegExp(s.rx.source, "g"))) {
        if (s.label === "free-text prompt" && isCredentialField(src, m.index ?? 0)) continue;
        push(sources, "source", s.label, f, m.index ?? 0);
      }
    }
    for (const m of src.matchAll(new RegExp(MODERATION_TEXT.source, "gi"))) push(moderation, "moderation", `${omniKind(src, m[0], m.index ?? 0)} moderation (${m[0]})`, f, m.index ?? 0);
    for (const m of src.matchAll(new RegExp(MODERATION_IMAGE.source, "gi"))) push(moderation, "moderation", `image moderation (${m[0]})`, f, m.index ?? 0);
    for (const m of src.matchAll(new RegExp(SAFETY_DISABLED2.source, "g"))) push(moderation, "safety-disabled", m[0], f, m.index ?? 0);
    for (const m of src.matchAll(new RegExp(SAFETY_STRICT.source, "g"))) push(moderation, "safety-strict", m[0], f, m.index ?? 0);
  }
  const dedupe = (a) => {
    const seen = /* @__PURE__ */ new Set();
    return a.filter((s) => {
      const k = `${s.role}|${s.label}|${s.file}|${s.line}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  const screening = new Set(moderation.filter((m) => m.role === "moderation").map((m) => `${m.file}:${m.line}`));
  return { sources: dedupe(sources), sinks: dedupe(sinks.filter((s) => !screening.has(`${s.file}:${s.line}`))), moderation: dedupe(moderation) };
}
function aiSites(ctx) {
  return siteScan(ctx);
}
function identAround(src, start, end) {
  let a = start;
  let b = end;
  while (a > 0 && /[\w$]/.test(src[a - 1])) a--;
  while (b < src.length && /[\w$]/.test(src[b])) b++;
  return src.slice(a, b);
}
async function findSurface(ctx, rejectionText) {
  const { terms, categories, otherWords } = termsFromRejection(rejectionText);
  const notes = [];
  const candidates = [];
  const evidence = [];
  const counts = /* @__PURE__ */ new Map();
  const seen = /* @__PURE__ */ new Set();
  const contextTerms = new Set(terms.filter(isContextTerm).map((t) => t.term));
  const addCand = (c) => {
    const key = `${c.kind}|${c.value.toLowerCase()}`;
    counts.set(c.term, (counts.get(c.term) ?? 0) + 1);
    const isContext = contextTerms.has(c.term.toLowerCase());
    if (seen.has(key)) {
      if (!isContext) {
        for (const x of candidates) if (`${x.kind}|${x.value.toLowerCase()}` === key) delete x.context;
      }
      return;
    }
    seen.add(key);
    candidates.push(isContext ? { ...c, context: true } : c);
    if (c.line) evidence.push(`${c.file}:${c.line}: ${c.evidence ?? c.value}`);
    else evidence.push(`${c.file}: ${c.value}`);
  };
  const termNeedles = terms.map((t) => makeNeedle("term", t.term)).filter(Boolean);
  for (const f of ctx.files) {
    for (const n of termNeedles) {
      for (const m of matchNeedle(n, f.code, 50)) {
        const line = lineOf(f.code, m.index);
        const ev = lineText(f.text, m.index).slice(0, 160);
        if (isCodeFile(f)) {
          const masked = maskedOf2(f);
          const inString = masked.slice(m.index, m.end) !== f.code.slice(m.index, m.end);
          if (!inString) {
            const ident = identAround(f.code, m.index, m.end);
            const declared = new RegExp(
              `\\b(func|function|class|struct|enum|protocol|interface|type|let|var|const|case)\\s+${escapeRx2(ident)}\\b`
            ).test(f.code);
            if (declared) addCand({ kind: "symbol", value: ident, term: n.value, file: f.path, line, evidence: ev });
          } else {
            const lit = stringLiteralAt(f.code, m.index);
            if (lit && /^[A-Za-z][\w.:-]{2,63}$/.test(lit) && /[_.:-]|[a-z][A-Z]/.test(lit) && REMOTE_CONFIG_FILE.test(f.code)) {
              addCand({ kind: "flag", value: lit, term: n.value, file: f.path, line, evidence: ev });
            }
            if (lit && /^(https?:\/\/|\/)\S+$/.test(lit)) addCand({ kind: "endpoint", value: lit, term: n.value, file: f.path, line, evidence: ev });
            else if (lit && lit.trim().split(/\s+/).length >= 4)
              addCand({ kind: "promptFragment", value: lit.trim().slice(0, 120), term: n.value, file: f.path, line, evidence: ev });
          }
          const scopeFlag = flagKeyNear(f.code, m.index);
          if (scopeFlag) addCand({ kind: "flag", value: scopeFlag, term: n.value, file: f.path, line, evidence: ev });
        } else if (["prompt", "txt", "md"].includes(f.ext) && !isDocPath(f.path)) {
          addCand({ kind: "promptFragment", value: ev.slice(0, 120), term: n.value, file: f.path, line, evidence: ev });
        }
      }
    }
    if (f.ext === "strings") {
      for (const m of f.text.matchAll(STRINGS_PAIR)) {
        const [key, value] = [m[1], m[2]];
        const n = termNeedles.find((t) => matchNeedle(t, key, 1).length || matchNeedle(t, value, 1).length);
        if (n) addCand({ kind: "string", value: key, term: n.value, file: f.path, line: lineOf(f.text, m.index ?? 0), evidence: `${key} = ${value}`.slice(0, 160) });
      }
    } else if (f.ext === "xcstrings") {
      for (const { key, values } of xcstringsEntries(f.text)) {
        const n = termNeedles.find((t) => [key, ...values].some((v) => matchNeedle(t, v, 1).length));
        if (n) addCand({ kind: "string", value: key, term: n.value, file: f.path, evidence: key });
      }
    }
    if (isCodeFile(f)) {
      for (const m of f.code.matchAll(FLAG_READ)) {
        const key = m[2];
        const n = termNeedles.find((t) => matchNeedle(t, key, 1).length);
        if (n) addCand({ kind: "flag", value: key, term: n.value, file: f.path, line: lineOf(f.code, m.index ?? 0), evidence: lineText(f.text, m.index ?? 0) });
      }
      for (const m of f.code.matchAll(URL_LIT)) {
        const url = m[1];
        const n = termNeedles.find((t) => matchNeedle(t, url, 1).length);
        if (n) addCand({ kind: "endpoint", value: url, term: n.value, file: f.path, line: lineOf(f.code, m.index ?? 0), evidence: lineText(f.text, m.index ?? 0) });
      }
    }
  }
  const paths = await listRepoPaths(ctx.root);
  for (const rel of paths) {
    const base = rel.split("/").pop() ?? rel;
    const n = termNeedles.find((t) => matchNeedle(t, base, 1).length);
    if (!n) continue;
    if (ASSET_SET.test(base)) addCand({ kind: "asset", value: base.replace(ASSET_SET, ""), term: n.value, file: rel });
    else if (IMAGE_EXT.test(base) && !rel.split("/").some((s) => ASSET_SET.test(s)))
      addCand({ kind: "asset", value: base.replace(/\.[^.]+$/, ""), term: n.value, file: rel });
    else if (!rel.split("/").some((s) => ASSET_SET.test(s))) addCand({ kind: "file", value: rel, term: n.value, file: rel });
  }
  const { sources, sinks, moderation } = siteScan(ctx);
  const inputPaths = [];
  if (sinks.length) {
    let untraced2 = 0;
    let inferredOnly = 0;
    for (const s of sources) {
      if (inputPaths.some((p) => p.startsWith(`${s.label} (${s.file}:`))) continue;
      const link = linkSource(ctx, s, sinks);
      const at = (xs) => [...new Set(xs.map((x) => `${x.file}:${x.line}`))].slice(0, 3).join(", ");
      if (link.traced.length) inputPaths.push(`${s.label} (${s.file}:${s.line}) \u2192 AI generation (${at(link.traced)})`);
      else if (link.inferred.length) {
        inferredOnly++;
        inputPaths.push(`${s.label} (${s.file}:${s.line}) \u2192 AI generation (linkage inferred, not traced: ${at(link.inferred)}; confirm or remove)`);
      } else {
        untraced2++;
        inputPaths.push(`${s.label} (${s.file}:${s.line}) \u2192 AI generation (call not traced; confirm or remove)`);
      }
    }
    if (untraced2) notes.push(`${untraced2} input source(s) could not be linked to an AI call by name; trace each one by hand and drop it from inputPaths if it never reaches a generator.`);
    if (inferredOnly) notes.push(`${inferredOnly} input source(s) only share a view or type with an AI call; no data flow from the input to the call was found. Trace each one and keep only the calls it really feeds.`);
    if (!sources.length) notes.push("AI sinks found but no user input sources were recognized; trace how prompts are built by hand.");
    const presetFiles = /* @__PURE__ */ new Set();
    const presets = candidates.filter((c) => c.kind === "symbol" && /^[A-Z]/.test(c.value) && /picker|outfit|preset|style|template|option|menu|catalog/i.test(c.value)).sort((a, b) => Number(/picker|catalog|preset/i.test(b.value)) - Number(/picker|catalog|preset/i.test(a.value)));
    for (const p of presets) {
      if (presetFiles.has(p.file)) continue;
      presetFiles.add(p.file);
      const linked = linkedSinks(ctx, p.file, sinks);
      const at = [...new Set(linked.map((x) => `${x.file}:${x.line}`))].slice(0, 3).join(", ");
      inputPaths.push(`preset/picker ${p.value} (${p.file}:${p.line ?? "?"})${at ? ` \u2192 AI generation (${at})` : ""}`);
    }
  } else {
    notes.push("No AI generation call was recognized in the repo; if generation happens on a server outside this repo, its prompt and filters must be attested by the developer.");
  }
  if (!terms.length) notes.push("No category from the expansion lexicon matched the rejection text; add terms by hand from the reviewer's wording and screenshots.");
  notes.push("Every entry is a candidate. Confirm each against the code, remove anything unrelated, and add input paths the scan could not see (remix, share extension, server-side presets).");
  const pick = (k, cap2 = 40) => [...new Set(candidates.filter((c) => c.kind === k && !c.context).map((c) => c.value))].slice(0, cap2);
  const pickContext = (kinds) => [...new Set(candidates.filter((c) => kinds.includes(c.kind) && c.context).map((c) => c.value))].slice(0, 40);
  const context = {
    terms: [...contextTerms],
    symbols: pickContext(["symbol"]),
    promptFragments: pickContext(["promptFragment"]),
    other: pickContext(["asset", "string", "endpoint", "flag", "file"])
  };
  if (context.terms.length) {
    notes.push(
      `Context terms (${context.terms.join(", ")}) and the ${context.symbols.length + context.promptFragments.length + context.other.length} entries found only through them are not residue and are left out of the draft: they show where the feature lived. List only what must disappear.`
    );
  }
  const metadataSurfaces = [
    ...candidates.filter((c) => !c.context && /(^|\/)(fastlane\/)?metadata\//.test(c.file)).map((c) => c.file),
    // "uncensored" or "no filters" in the listing invites the same 1.1/1.2 review whatever the rejection named.
    ...metadataTexts(ctx).filter((t) => t.surface === "store" && CONTENT_SIGNAL_CLAIMS.test(t.text)).map((t) => `${t.file} (${t.field}${t.locale === "default" ? "" : `, ${t.locale}`})`)
  ];
  const found = terms.filter((t) => !isContextTerm(t) && (counts.get(t.term) ?? 0) > 0).sort((a, b) => (counts.get(b.term) ?? 0) - (counts.get(a.term) ?? 0));
  const where = [...contextTerms].find((t) => (counts.get(t) ?? 0) > 0);
  const named = found.slice(0, 2).map((t) => t.term).join(" / ");
  const featureText = named ? `${named}${where ? ` ${where}` : ""}${categories.length ? ` (${categories.slice(0, 2).map((c) => c.describe.split(",")[0]).join("; ")})` : ""}` : categories[0]?.describe.split(",")[0] ?? terms[0]?.term ?? otherWords[0] ?? "rejected feature";
  const feature = featureText.charAt(0).toUpperCase() + featureText.slice(1);
  const regressionTerms = terms.filter((t) => t.origin === "lexicon" && !isContextTerm(t) && !(counts.get(t.term) ?? 0)).map((t) => t.term);
  if (regressionTerms.length) {
    notes.push(
      `${regressionTerms.length} lexicon terms were not found in the repo (${regressionTerms.slice(0, 6).join(", ")}${regressionTerms.length > 6 ? ", \u2026" : ""}). They stay in the draft as regression guards so verify catches them if they appear later; they do not show what this app had.`
    );
  }
  const capability = categories.length ? `A user can no longer obtain ${categories.map((c) => c.describe).join("; ")} through any input path (pickers, presets, free-text prompts, image uploads, remixes, deep links).` : "Describe what a user must no longer be able to do or produce, at capability level, not which screen was removed.";
  const draft = ResidueSpec.parse({
    feature,
    capability,
    terms: terms.filter((t) => !isContextTerm(t)).map((t) => t.term),
    symbols: pick("symbol"),
    assets: pick("asset"),
    strings: pick("string"),
    endpoints: pick("endpoint"),
    flags: pick("flag"),
    promptFragments: pick("promptFragment", 20),
    inputPaths,
    confirmedPaths: [],
    metadataSurfaces: [...new Set(metadataSurfaces)]
  });
  return {
    draft,
    context,
    terms: terms.map((t) => ({ ...t, inRepo: counts.get(t.term) ?? 0 })),
    regressionTerms,
    otherWords,
    candidates,
    sources,
    sinks,
    moderation,
    evidence: evidence.slice(0, 300),
    notes
  };
}
function isDocPath(rel) {
  const base = rel.split("/").pop() ?? rel;
  if (!rel.includes("/") && /\.(md|txt)$/i.test(base)) return true;
  if (/^(docs?|documentation|\.github)\//i.test(rel)) return true;
  return /^(README|CHANGELOG|LICENSE|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY|NOTICE)(\.|$)/i.test(base);
}
function stringLiteralAt(code, index) {
  const start = code.lastIndexOf("\n", index - 1) + 1;
  const end = code.indexOf("\n", index);
  const line = code.slice(start, end === -1 ? code.length : end);
  for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`([^`]*)`/g)) {
    const a = start + (m.index ?? 0);
    if (a < index && index < a + m[0].length) return m[1] ?? m[2] ?? m[3];
  }
  return void 0;
}
function flagKeyNear(code, index) {
  const from = Math.max(0, index - 400);
  const window = code.slice(from, index + 120);
  let last;
  for (const m of window.matchAll(FLAG_READ)) if (from + (m.index ?? 0) < index) last = m[2];
  return last;
}
function xcstringsEntries(text) {
  try {
    const json = JSON.parse(text);
    return Object.entries(json.strings ?? {}).map(([key, v]) => ({
      key,
      values: JSON.stringify(v?.localizations ?? {}).match(/"value"\s*:\s*"((?:[^"\\]|\\.)*)"/g)?.map((s) => s.replace(/^"value"\s*:\s*"|"$/g, "")) ?? []
    }));
  } catch {
    return [];
  }
}
function parseEvidenceRef(ev) {
  const m = /^\s*([^\s:]+(?:\/[^\s:]+)*\.[A-Za-z0-9]+):(\d+)(?::\d+)?(?:[:\s]\s*(.*))?$/.exec(ev);
  if (!m) return void 0;
  return { file: m[1], line: Number(m[2]), snippet: m[3]?.trim() || void 0 };
}
var SOURCE_WORDS = {
  "free-text prompt": /text|prompt|chat|message|describ|type|field|input/i,
  "image upload": /image|photo|upload|picker|selfie|camera|gallery|picture/i,
  "deep link": /link|url|scheme/i,
  "voice input": /voice|speech|audio|record|dictat/i,
  "shared content": /share|paste|drop|extension/i
};
function specCovers(spec, src) {
  const base = path4.posix.basename(src.file);
  const stem = new RegExp(`(?<![\\w$])${escapeRx2(base.replace(/\.[^.]+$/, ""))}(?![\\w$])`);
  const words = SOURCE_WORDS[src.label];
  const texts = [...spec.inputPaths, ...spec.confirmedPaths.flatMap((c) => [`${c.source} \u2192 ${c.sink}`, ...c.evidence])];
  return texts.some((t) => {
    if (t.includes(`${base}:${src.line}`)) return true;
    const sourceSide = t.split(/→|->/)[0] ?? t;
    return stem.test(sourceSide) && !!words?.test(sourceSide);
  });
}
async function validateSpec(ctx, specIn, opts = {}) {
  const problems = [];
  const warnings = [];
  const parsed = ResidueSpec.safeParse(specIn);
  if (!parsed.success) return { ok: false, problems: [`spec does not match the ResidueSpec schema: ${parsed.error.message}`], warnings };
  const spec = parsed.data;
  if (!spec.feature.trim()) problems.push("feature is empty.");
  if (!spec.capability.trim()) problems.push("capability is empty: describe what a user must no longer be able to do or produce.");
  else if (/\b(screen|button|picker|tab|menu|view|toggle)\b/i.test(spec.capability) && !/\b(generat\w*|creat\w*|produc\w*|obtain|request|view|see|make|edit|upload|access)\b/i.test(spec.capability)) {
    warnings.push("capability names UI elements but not what the user can produce; describe the capability, not the screen.");
  }
  const gitRepo = await isGitRepo(ctx.root);
  const paths = await listRepoPaths(ctx.root, true);
  const lowerTexts = ctx.files.map((f) => f.text.toLowerCase());
  const existsInTree = (value, kind) => {
    const n = makeNeedle(kind, value);
    if (!n) return false;
    if (kind === "asset") return paths.some((p) => matchNeedle(n, p, 1).length > 0) || ctx.files.some((f) => matchNeedle(n, f.text, 1).length > 0);
    const low = value.toLowerCase();
    return lowerTexts.some((t) => t.includes(low)) || paths.some((p) => p.toLowerCase().includes(low));
  };
  const checkExisting = async (kind, label, values) => {
    for (const v of values) {
      if (!v.trim()) {
        problems.push(`${label}: empty entry.`);
        continue;
      }
      if (v.trim().length < 3) warnings.push(`${label} "${v}" is very short and will match unrelated code.`);
      if (existsInTree(v, kind)) continue;
      const probe = kind === "asset" ? v.replace(/[*?].*$/, "") : v;
      const asset = kind === "asset" ? makeNeedle("asset", v) : void 0;
      if (gitRepo && (asset && await inGitPathHistory(ctx.root, asset) || probe.length >= 3 && await inGitHistory(ctx.root, probe))) {
        warnings.push(`${label} "${v}" is no longer in the working tree but exists in git history (already removed).`);
        continue;
      }
      problems.push(`${label} "${v}" does not exist anywhere in the repo${gitRepo ? " or its git history" : ""}; remove it or correct the spelling.`);
    }
  };
  await checkExisting("symbol", "symbol", spec.symbols);
  await checkExisting("asset", "asset", spec.assets);
  await checkExisting("string", "string key", spec.strings);
  await checkExisting("endpoint", "endpoint", spec.endpoints);
  await checkExisting("flag", "flag", spec.flags);
  await checkExisting("promptFragment", "prompt fragment", spec.promptFragments);
  const guards = [];
  for (const t of spec.terms) {
    if (!t.trim()) {
      problems.push("term: empty entry.");
      continue;
    }
    if (existsInTree(t, "term")) continue;
    if (!gitRepo) continue;
    if (!await inGitHistory(ctx.root, t)) {
      if (LEXICON.has(t.trim().toLowerCase())) guards.push(t.trim());
      else warnings.push(`term "${t}" is absent now and never appeared in git history; check that it describes this app's feature.`);
    }
  }
  for (const cp of spec.confirmedPaths) {
    if (!cp.evidence.length) problems.push(`confirmed path ${cp.source} \u2192 ${cp.sink} has no file:line evidence.`);
    for (const ev of cp.evidence) {
      const ref = parseEvidenceRef(ev);
      if (!ref) {
        problems.push(`confirmed path evidence "${ev}" is not in file:line form.`);
        continue;
      }
      const abs = path4.join(ctx.root, ref.file);
      if (!abs.startsWith(path4.resolve(ctx.root) + path4.sep) || !existsSync2(abs)) {
        problems.push(`confirmed path evidence "${ev}": file does not exist.`);
        continue;
      }
      let body;
      try {
        body = await readRegularFile(abs, EVIDENCE_MAX_BYTES, "evidence file", ctx.root);
      } catch (e) {
        problems.push(`confirmed path evidence "${ev}": ${e.message}.`);
        continue;
      }
      const lines = body.toString("utf8").split("\n");
      if (ref.line < 1 || ref.line > lines.length) problems.push(`confirmed path evidence "${ev}": line ${ref.line} is past the end of the file.`);
      else if (!ref.snippet) {
        warnings.push(`confirmed path evidence "${ev}" has no snippet, so verify can only check that line ${ref.line} still exists; write it as "${ref.file}:${ref.line}: ${clipLine(lines[ref.line - 1] ?? "")}".`);
      }
    }
  }
  const { sources, sinks } = siteScan(ctx);
  if (!spec.inputPaths.length && !spec.confirmedPaths.length) {
    if (sources.length && sinks.length) {
      warnings.push("No input paths listed, but the repo has user input sources and AI generation calls; list every way a user could still reach the capability.");
    }
  } else if (sinks.length) {
    const seen = /* @__PURE__ */ new Set();
    for (const src of sources) {
      const key = `${src.label}|${src.file}`;
      if (seen.has(key) || specCovers(spec, src)) continue;
      seen.add(key);
      const link = linkSource(ctx, src, sinks);
      if (!link.traced.length && !link.inferred.length) continue;
      warnings.push(
        `Input source ${src.label} (${src.file}:${src.line}) reaches ${link.traced.length ? "" : "(by inference) "}the AI call in ${[...new Set((link.traced.length ? link.traced : link.inferred).map((x) => x.file))].join(", ")} but is not in the spec. Verify judges it anyway; list it in inputPaths, or trace it and record why it does not reach the generator.`
      );
    }
  }
  const sinkFiles = [...new Set(sinks.filter((x) => !/\.(json|ya?ml|toml)$/i.test(x.file)).map((x) => x.file))];
  if (sinkFiles.length > 1) {
    for (const p of spec.inputPaths) {
      const refs = [...p.matchAll(/([\w./-]+\.(?:swift|tsx?|jsx?|mjs|cjs|kt|py|dart|go|rb|m|mm))(?::\d+)?/g)].map((m) => m[1].replace(/^\.\//, ""));
      if (refs.some((r) => sinkFiles.some((f) => f === r || f.endsWith(`/${r}`)))) continue;
      warnings.push(
        `input path "${clipLine(p)}" names no generation call by file:line, so verify requires a filter on all ${sinkFiles.length} of them (${sinkFiles.slice(0, 4).join(", ")}${sinkFiles.length > 4 ? ", \u2026" : ""}) and lists each one's filters separately. Add the file:line of the call it reaches on the sink side of the arrow, for example "\u2192 AI generation (${sinkFiles[0]}:<line>)".`
      );
    }
  }
  if (!spec.terms.length) warnings.push("No terms listed; the residue sweep will only look for the named symbols, assets and keys.");
  if (guards.length) {
    warnings.push(
      `${guards.length} lexicon term${guards.length === 1 ? " is" : "s are"} not in the repo or its git history and ${guards.length === 1 ? "is" : "are"} kept as regression guards (${guards.slice(0, 8).join(", ")}${guards.length > 8 ? ", \u2026" : ""}); they do not show the spec describes this app.`
    );
  }
  if (opts.rejectionText) {
    const ref = gitRepo ? opts.baseRef ?? "HEAD" : void 0;
    const g = await specGrounding(ctx, spec, opts.rejectionText, ref);
    if (g.checked && !g.grounded) {
      warnings.unshift(
        `The spec is not grounded in the rejection: none of its entries appear in the pre-fix code next to the terms find_surface derives from App Review's message (${g.terms.slice(0, 6).join(", ")}). Removing entries that are not tied to App Review's message proves nothing about it, so verify caps an ungrounded spec at UNVERIFIABLE: it cannot clear the open rejection, which stays on HOLD in preflight. Add entries find_surface found in the pre-fix code, or the developer acknowledges the rejection with \`appstore-shield ack\`.`
      );
    }
  }
  return { ok: problems.length === 0, problems, warnings };
}
var STORE_METADATA = /^(fastlane\/)?(metadata|screenshots)\//;
function isProseDoc(rel) {
  if (STORE_METADATA.test(rel)) return false;
  return isDocPath(rel) || /\.(md|markdown|mdx|txt|rst|adoc)$/i.test(rel);
}
function isFilterMatch(files, f, src, index, end) {
  if (blocklistIn(files, f, index)) return true;
  if ((["prompt", "txt", "md"].includes(f.ext) || isCodeFile(f)) && isRefusalInstruction(src, index)) return true;
  return moderationKeyIn(files, f, index, end);
}
var clipLine = (s) => s.trim().length > 80 ? `${s.trim().slice(0, 80)}\u2026` : s.trim();
var FILE_TOKEN = /[\w./-]+\.[A-Za-z][A-Za-z0-9]{0,9}\b/g;
async function specGrounding(ctx, specIn, rejectionText, ref) {
  const spec = ResidueSpec.parse(specIn);
  const derived = termsFromRejection(rejectionText);
  const base = derived.terms.length ? derived.terms.map((t) => t.term) : derived.otherWords;
  const termNeedles = base.map((t) => makeNeedle("term", t)).filter((n) => !!n);
  const terms = termNeedles.map((n) => n.value);
  if (!termNeedles.length) return { checked: false, grounded: false, terms };
  const whence = (t) => {
    const c = derived.terms.find((x) => x.term === t.value.toLowerCase());
    if (!c || c.origin !== "lexicon") return `"${t.value}", a word from App Review's message`;
    const cat = derived.categories.find((x) => x.id === c.category) ?? derived.categories[0];
    const hit = cat ? new RegExp(cat.triggers.source, cat.triggers.flags.replace("g", "")).exec(rejectionText) : void 0;
    const phrase = hit ? /^[\p{L}'-]+(?:\s+[\p{L}'-]+)?/u.exec(rejectionText.slice(hit.index))?.[0] ?? hit[0] : void 0;
    return `"${t.value}", one of the terms find_surface derives from App Review's message${phrase ? ` ("${phrase}")` : ""}`;
  };
  const entry = (n) => `spec ${n.kind === "promptFragment" ? "prompt fragment" : n.kind} "${n.value}"`;
  const specNeedles = needlesOf(spec);
  const pathFiles = [
    ...spec.inputPaths,
    ...spec.confirmedPaths.flatMap((c) => [c.source, c.sink, ...c.evidence])
  ].flatMap((t) => [...t.matchAll(FILE_TOKEN)].map((m) => m[0].replace(/^\.\//, "")));
  const namesFile = (file2) => pathFiles.some((p) => p === file2 || file2.endsWith(`/${p}`));
  const lines = [];
  const paths = [];
  let usedRef;
  const capabilityLines = (f, files, only) => {
    if (isProseDoc(f.path)) return;
    const code = isCodeFile(f);
    const src = code ? f.code : f.text;
    const rows = src.split("\n");
    const shown = f.text.split("\n");
    let start = 0;
    rows.forEach((row, i) => {
      const at = start;
      start += row.length + 1;
      if (only && !only.has(i + 1)) return;
      const hits = termNeedles.flatMap((n) => matchNeedle(n, row, 1));
      if (!hits.length || hits.every((m) => isFilterMatch(files, f, src, at + m.index, at + m.end))) return;
      lines.push({ file: f.path, line: i + 1, text: code ? row : shown[i] ?? row, code });
    });
  };
  if (ref && safeRef(ref) && await isGitRepo(ctx.root)) {
    const commit = (await git(ctx.root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]))?.trim();
    if (commit) {
      usedRef = commit;
      const out = await git(ctx.root, ["grep", "-I", "-n", "-i", "--null", "--no-color", "--no-textconv", "-F", ...terms.flatMap((t) => ["-e", t]), commit, "--"], 3e4) ?? "";
      const hits = /* @__PURE__ */ new Map();
      for (const row of out.split("\n")) {
        const [head, line] = row.split("\0");
        if (!head || !line) continue;
        const rel = head.slice(commit.length + 1);
        if (isProseDoc(rel)) continue;
        hits.set(rel, (hits.get(rel) ?? /* @__PURE__ */ new Set()).add(Number(line)));
      }
      for (const [rel, want] of [...hits].slice(0, 60)) {
        const text = await git(ctx.root, ["show", "--no-textconv", `${commit}:${rel}`]);
        if (text === void 0) continue;
        const ext = extOf(rel);
        const old = { path: rel, abs: path4.join(ctx.root, rel), ext, text, code: stripComments(text, ext) };
        capabilityLines(old, [old, ...ctx.files.filter((f) => f.path !== rel)], want);
      }
      paths.push(...(await git(ctx.root, ["ls-tree", "-r", "--name-only", "-z", commit]) ?? "").split("\0").filter(Boolean));
    }
  }
  if (!usedRef) {
    for (const f of ctx.files) capabilityLines(f, ctx.files);
    paths.push(...await listRepoPaths(ctx.root, true));
  }
  const fix = usedRef ? " before the fix" : "";
  const where = (code) => `${code ? "in the code" : "in the repo"}${fix}`;
  for (const l of lines) {
    const t0 = termNeedles.find((n) => matchNeedle(n, l.text, 1).length);
    if (!t0) continue;
    const s = specNeedles.find((n) => matchNeedle(n, l.text, 1).length);
    if (!s) continue;
    const t = termNeedles.find((n) => n.value.toLowerCase() === s.value.toLowerCase()) ?? t0;
    const via = s.kind === "term" && s.value.toLowerCase() === t.value.toLowerCase() ? `${entry(s)} was ${where(l.code)} at ${l.file}:${l.line}, and it is ${whence(t).replace(/^"[^"]*", /, "")}` : `${entry(s)} was ${where(l.code)} at ${l.file}:${l.line}, on the same line as ${whence(t)}`;
    return { checked: true, grounded: true, via, ref: usedRef, terms };
  }
  for (const p of paths) {
    if (isProseDoc(p)) continue;
    const name = p.split("/").pop() ?? p;
    const t = termNeedles.find((n) => matchNeedle(n, name, 1).length);
    if (!t) continue;
    const s = specNeedles.find((n) => (n.kind === "term" || n.kind === "asset" || n.kind === "symbol") && matchNeedle(n, name, 1).length);
    if (s) return { checked: true, grounded: true, via: `${entry(s)} names ${p}, a file ${where(false)} whose name carries ${whence(t)}`, ref: usedRef, terms };
    if (namesFile(p)) return { checked: true, grounded: true, via: `input path file ${p} was ${where(false)}, and its name carries ${whence(t)}`, ref: usedRef, terms };
  }
  for (const l of lines) {
    if (!namesFile(l.file)) continue;
    const t = termNeedles.find((n) => matchNeedle(n, l.text, 1).length);
    if (t) return { checked: true, grounded: true, via: `input path file ${l.file} had ${whence(t)} at line ${l.line} ${where(l.code)}`, ref: usedRef, terms };
  }
  if (!usedRef) {
    const written = new Set(derived.terms.filter((t) => t.origin !== "lexicon").map((t) => t.term));
    const named = spec.terms.map((t) => t.trim().toLowerCase()).find((t) => written.has(t));
    if (named) return { checked: true, grounded: true, via: `spec term "${named}" is App Review's own wording`, terms };
  }
  return { checked: true, grounded: false, ref: usedRef, terms };
}

// src/remediation/built.ts
var execFileP2 = promisify2(execFile2);
var openFd = promisify2(openCb);
var MAX_SCAN_BYTES = 200 * 1024 * 1024;
var MAX_UNCOMPRESSED = 2 * 1024 * 1024 * 1024;
var MAX_MATCHES = 500;
var HERMES_MAGIC = Buffer.from([198, 31, 188, 3, 193, 3, 25, 31]);
var CDN = /https?:\/\/[^\s"'<>]*?(cloudfront\.net|cloudinary\.com|imgix\.net|firebasestorage\.googleapis\.com|storage\.googleapis\.com|amazonaws\.com|r2\.dev|r2\.cloudflarestorage\.com|supabase\.co\/storage|cdn\.[\w.-]+|bunnycdn|b-cdn\.net)/gi;
function unsafeZipEntries(entries, symlinks = []) {
  const bad = [];
  const links = symlinks.map((s) => s.replace(/\/+$/, ""));
  for (const e of entries) {
    const segs = e.split(/[\\/]+/);
    if (e.includes("\0") || e.startsWith("/") || e.startsWith("\\") || /^[A-Za-z]:/.test(e) || segs.includes("..") || links.some((l) => e.startsWith(`${l}/`))) {
      bad.push(e);
    }
  }
  return bad;
}
var MAX_ENTRIES = 2e5;
var MAX_CENTRAL_DIR = 256 * 1024 * 1024;
async function readAt(fh, offset, length) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, offset);
  if (bytesRead !== length) throw new Error("refusing to extract: the archive is truncated");
  return buf;
}
async function readCentralDirectory(fh, fileSize) {
  const tailLen = Math.min(fileSize, 22 + 65535);
  const tail = await readAt(fh, fileSize - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 101010256) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("refusing to extract: not a zip archive (no end of central directory)");
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === 65535 || cdSize === 4294967295 || cdOffset === 4294967295) {
    const locAt = fileSize - tailLen + eocd - 20;
    if (locAt < 0) throw new Error("refusing to extract: zip64 locator missing");
    const loc = await readAt(fh, locAt, 20);
    if (loc.readUInt32LE(0) !== 117853008) throw new Error("refusing to extract: zip64 locator missing");
    const z = await readAt(fh, Number(loc.readBigUInt64LE(8)), 56);
    if (z.readUInt32LE(0) !== 101075792) throw new Error("refusing to extract: zip64 end of central directory missing");
    count = Number(z.readBigUInt64LE(32));
    cdSize = Number(z.readBigUInt64LE(40));
    cdOffset = Number(z.readBigUInt64LE(48));
  }
  if (count > MAX_ENTRIES) throw new Error(`refusing to extract: ${count} entries exceeds the ${MAX_ENTRIES} limit`);
  if (cdSize > MAX_CENTRAL_DIR || cdOffset + cdSize > fileSize) throw new Error("refusing to extract: the central directory is out of bounds");
  const cd = await readAt(fh, cdOffset, cdSize);
  const out = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 33639248) throw new Error("refusing to extract: malformed central directory");
    const madeBy = cd.readUInt16LE(p + 4) >> 8;
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    if (p + 46 + nameLen + extraLen + commentLen > cd.length) throw new Error("refusing to extract: malformed central directory");
    const e = {
      name: cd.toString("utf8", p + 46, p + 46 + nameLen),
      flags: cd.readUInt16LE(p + 8),
      method: cd.readUInt16LE(p + 10),
      compressedSize: cd.readUInt32LE(p + 20),
      size: cd.readUInt32LE(p + 24),
      localOffset: cd.readUInt32LE(p + 42),
      mode: madeBy === 3 ? cd.readUInt32LE(p + 38) >>> 16 : 0
    };
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = cd.readUInt16LE(x);
      const len = cd.readUInt16LE(x + 2);
      if (id === 1) {
        let q = x + 4;
        const next = () => {
          if (q + 8 > x + 4 + len) throw new Error("refusing to extract: malformed zip64 field");
          const v = Number(cd.readBigUInt64LE(q));
          q += 8;
          return v;
        };
        if (e.size === 4294967295) e.size = next();
        if (e.compressedSize === 4294967295) e.compressedSize = next();
        if (e.localOffset === 4294967295) e.localOffset = next();
      }
      x += 4 + len;
    }
    out.push(e);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
async function extractIpa(ipa, maxTotal = MAX_UNCOMPRESSED) {
  const fh = await open3(ipa, "r");
  let dest;
  try {
    const fileSize = (await fh.stat()).size;
    const entries = await readCentralDirectory(fh, fileSize);
    const isLink = (e) => (e.mode & 61440) === 40960;
    const bad = unsafeZipEntries(
      entries.map((e) => e.name),
      entries.filter(isLink).map((e) => e.name)
    );
    if (bad.length) throw new Error(`refusing to extract: unsafe zip entries (${bad.slice(0, 3).join(", ")})`);
    const claimed = entries.reduce((n, e) => n + e.size, 0);
    if (claimed > maxTotal) throw new Error(`refusing to extract: ${claimed} bytes uncompressed exceeds the ${maxTotal} byte limit`);
    for (const e of entries) {
      if (e.flags & 1) throw new Error(`refusing to extract: ${e.name} is encrypted`);
      if (e.method !== 0 && e.method !== 8) throw new Error(`refusing to extract: ${e.name} uses unsupported compression method ${e.method}`);
    }
    dest = await mkdtemp(path5.join(tmpdir(), "appstore-shield-ipa-"));
    const root = dest;
    let total = 0;
    for (const e of entries) {
      if (isLink(e)) continue;
      const target = path5.resolve(root, e.name);
      if (target !== root && !target.startsWith(root + path5.sep)) throw new Error(`refusing to extract: unsafe zip entry (${e.name})`);
      if (e.name.endsWith("/")) {
        await mkdir(target, { recursive: true });
        continue;
      }
      await mkdir(path5.dirname(target), { recursive: true });
      const lh = await readAt(fh, e.localOffset, 30);
      if (lh.readUInt32LE(0) !== 67324752) throw new Error(`refusing to extract: bad local header for ${e.name}`);
      const dataStart = e.localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      if (dataStart + e.compressedSize > fileSize) throw new Error(`refusing to extract: ${e.name} runs past the end of the archive`);
      let written = 0;
      const counter = new Transform({
        transform(chunk, _enc, cb) {
          written += chunk.length;
          total += chunk.length;
          if (written > e.size) return cb(new Error(`refusing to extract: ${e.name} inflates past the ${e.size} bytes its header states (zip bomb)`));
          if (total > maxTotal) return cb(new Error(`refusing to extract: more than ${maxTotal} bytes uncompressed`));
          cb(null, chunk);
        }
      });
      const fd = await openFd(target, fsc2.O_WRONLY | fsc2.O_CREAT | fsc2.O_EXCL | fsc2.O_NOFOLLOW, 420);
      const sink = createWriteStream("", { fd });
      if (!e.compressedSize) await pipeline(Readable.from([]), counter, sink);
      else {
        const input = createReadStream(ipa, { start: dataStart, end: dataStart + e.compressedSize - 1 });
        if (e.method === 8) await pipeline(input, createInflateRaw(), counter, sink);
        else await pipeline(input, counter, sink);
      }
    }
    return root;
  } catch (err) {
    if (dest) await rm(dest, { recursive: true, force: true });
    const msg = err.message;
    throw new Error(msg.startsWith("refusing to extract") ? msg : `extraction failed: ${msg}`);
  } finally {
    await fh.close();
  }
}
async function findApp(dir) {
  const entries = await readdir3(dir, { withFileTypes: true }).catch(() => []);
  const app = entries.find((e) => e.isDirectory() && e.name.endsWith(".app"));
  return app ? path5.join(dir, app.name) : void 0;
}
var LC_ENCRYPTION_INFO = 33;
var LC_ENCRYPTION_INFO_64 = 44;
function machoCryptId(buf) {
  if (buf.length < 32) return void 0;
  const be = buf.readUInt32BE(0);
  if (be === 3405691582 || be === 3405691583) {
    const nfat = buf.readUInt32BE(4);
    const wide = be === 3405691583;
    for (let i = 0; i < Math.min(nfat, 8); i++) {
      const base = 8 + i * (wide ? 32 : 20);
      if (base + 16 > buf.length) return void 0;
      const off2 = wide ? Number(buf.readBigUInt64BE(base + 8)) : buf.readUInt32BE(base + 8);
      if (off2 >= buf.length) continue;
      const id = machoCryptId(buf.subarray(off2));
      if (id !== void 0) return id;
    }
    return void 0;
  }
  const le = buf.readUInt32LE(0);
  if (le !== 4277009103 && le !== 4277009102) return void 0;
  const ncmds = buf.readUInt32LE(16);
  let off = le === 4277009103 ? 32 : 28;
  for (let i = 0; i < ncmds && off + 8 <= buf.length; i++) {
    const cmd = buf.readUInt32LE(off);
    const size = buf.readUInt32LE(off + 4);
    if (cmd === LC_ENCRYPTION_INFO || cmd === LC_ENCRYPTION_INFO_64) {
      return off + 20 <= buf.length ? buf.readUInt32LE(off + 16) : void 0;
    }
    if (size < 8) break;
    off += size;
  }
  return 0;
}
function isMachO(buf) {
  if (buf.length < 4) return false;
  const le = buf.readUInt32LE(0);
  const be = buf.readUInt32BE(0);
  return le === 4277009103 || le === 4277009102 || be === 3405691582 || be === 3405691583;
}
function printableRuns(buf, min = 4) {
  const out = [];
  let start = -1;
  for (let i = 0; i <= buf.length; i++) {
    const b = i < buf.length ? buf[i] : 0;
    const printable = b >= 32 && b < 127 || b === 9;
    if (printable) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if (i - start >= min) out.push(buf.toString("latin1", start, i));
      start = -1;
    }
  }
  return out.join("\n");
}
function looksText(buf) {
  const head = buf.subarray(0, 4096);
  if (head.length >= 2 && head[0] === 255 && head[1] === 254) return true;
  return !head.includes(0);
}
function decodeText2(buf) {
  if (buf.length >= 2 && buf[0] === 255 && buf[1] === 254) return buf.subarray(2).toString("utf16le");
  return buf.toString("utf8");
}
async function assetCatalogNames(file2) {
  try {
    const { stdout } = await execFileP2("xcrun", ["assetutil", "--info", file2], { maxBuffer: 128 * 1024 * 1024, timeout: 6e4 });
    const json = JSON.parse(stdout);
    return json.flatMap((e) => [e["Name"], e["RenditionName"], e["AssetType"] === "Image" ? e["Name"] : void 0]).filter((v) => typeof v === "string").join("\n");
  } catch {
    return void 0;
  }
}
async function walkFiles(dir, base, out) {
  const entries = await readdir3(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const abs = path5.join(dir, e.name);
    const st = await lstat2(abs).catch(() => void 0);
    if (!st || st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      out.push(`${path5.relative(base, abs).split(path5.sep).join("/")}/`);
      await walkFiles(abs, base, out);
    } else if (st.isFile()) out.push(path5.relative(base, abs).split(path5.sep).join("/"));
  }
}
async function readCapped(abs, max) {
  const fh = await open3(abs, "r");
  try {
    const size = (await fh.stat()).size;
    const len = Math.min(size, max);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    return buf;
  } finally {
    await fh.close();
  }
}
async function sweepBuiltProduct(productPath, specIn, opts = {}) {
  const spec = ResidueSpec.parse(specIn);
  if (!await lstat2(path5.resolve(productPath)).catch(() => void 0)) throw new Error(`built product not found: ${productPath}`);
  const abs = await vetClientPath(productPath, "build_path");
  const st = await stat2(abs);
  const notes = [];
  let kind;
  let appDir;
  let cleanup;
  if (st.isFile() && /\.ipa$/i.test(abs)) {
    kind = "ipa";
    cleanup = await extractIpa(abs);
    appDir = await findApp(path5.join(cleanup, "Payload"));
  } else if (st.isDirectory() && /\.xcarchive$/i.test(abs)) {
    kind = "xcarchive";
    appDir = await findApp(path5.join(abs, "Products", "Applications"));
  } else if (st.isDirectory() && /\.app$/i.test(abs)) {
    kind = "app";
    appDir = abs;
  } else {
    throw new Error("unsupported built product: pass a .app directory, an .xcarchive directory or an .ipa file");
  }
  try {
    if (!appDir) {
      notes.push("No .app bundle was found inside the product.");
      return { path: productPath, kind, hermes: false, hits: 0, matches: [], notes, encrypted: false, complete: false, scannedBytes: 0 };
    }
    const needles = needlesOf(spec).map((n) => n.kind === "symbol" ? { ...n, accept: void 0 } : n);
    const result = await sweepApp(appDir, needles, opts.maxBytes ?? MAX_SCAN_BYTES, notes);
    return { path: productPath, kind, ...result, notes };
  } finally {
    if (cleanup) await rm(cleanup, { recursive: true, force: true });
  }
}
async function sweepApp(appDir, needles, maxBytes, notes) {
  const rels = [];
  await walkFiles(appDir, appDir, rels);
  const matches2 = [];
  const seen = /* @__PURE__ */ new Set();
  let hermes = false;
  let encrypted = false;
  let sawMachO = false;
  let scanned = 0;
  let complete = true;
  let assetutilMissing = false;
  const cdnHosts = /* @__PURE__ */ new Set();
  let odr = rels.some((r) => /(^|\/)(OnDemandResources|AssetPackManifest[^/]*\.plist)/.test(r));
  const record = (n, file2, text) => {
    const key = `${n.kind}|${n.value}|${file2}`;
    if (seen.has(key) || matches2.length >= MAX_MATCHES) return;
    const m = matchNeedle(n, text, 1)[0];
    if (!m) return;
    seen.add(key);
    const s = text.lastIndexOf("\n", m.index - 1) + 1;
    const e = text.indexOf("\n", m.index);
    matches2.push({ kind: n.kind, needle: n.value, file: file2, evidence: text.slice(s, e === -1 ? void 0 : e).slice(0, 160) });
  };
  for (const rel of rels) {
    const name = rel.replace(/\/$/, "").split("/").pop() ?? rel;
    for (const n of needles) if (n.kind === "term" || n.kind === "asset" || n.kind === "symbol") record(n, rel, name);
    if (rel.endsWith("/")) continue;
    if (scanned >= maxBytes) {
      complete = false;
      continue;
    }
    const absFile = path5.join(appDir, rel);
    const buf = await readCapped(absFile, maxBytes - scanned).catch(() => void 0);
    if (!buf) continue;
    scanned += buf.length;
    const size = (await stat2(absFile).catch(() => void 0))?.size ?? buf.length;
    if (size > buf.length) complete = false;
    let text;
    if (buf.subarray(0, 8).equals(HERMES_MAGIC)) {
      hermes = true;
      text = printableRuns(buf);
    } else if (isMachO(buf)) {
      sawMachO = true;
      if (machoCryptId(buf) === 1) encrypted = true;
      text = printableRuns(buf);
    } else if (looksText(buf)) {
      text = decodeText2(buf);
    } else {
      text = printableRuns(buf);
    }
    if (name === "Assets.car") {
      const names = await assetCatalogNames(absFile);
      if (names !== void 0) text += `
${names}`;
      else assetutilMissing = true;
    }
    if (/NSBundleResourceRequest/.test(text)) odr = true;
    for (const m of text.matchAll(CDN)) {
      const host = /https?:\/\/([^/\s"'<>]+)/.exec(m[0])?.[1];
      if (host && cdnHosts.size < 10) cdnHosts.add(host);
    }
    for (const n of needles) record(n, rel, text);
  }
  if (hermes) notes.push("The JS bundle is Hermes bytecode: string literals were scanned, but identifiers and code structure were not.");
  if (encrypted) {
    notes.push("The executable is FairPlay-encrypted (LC_ENCRYPTION_INFO cryptid=1, an App Store download), so its strings cannot be read. Sweep the .xcarchive or the exported .ipa instead.");
  } else if (!sawMachO) {
    notes.push("No Mach-O executable was found in the bundle, so compiled code was not checked.");
  }
  if (assetutilMissing) notes.push("xcrun assetutil was unavailable, so Assets.car names were scanned only as raw strings.");
  if (odr) notes.push("The app uses on-demand resources; asset packs hosted by Apple are not in this bundle and could not be checked.");
  if (cdnHosts.size) notes.push(`Remote assets are loaded from ${[...cdnHosts].join(", ")}; their contents cannot be checked from the bundle and need a developer attestation.`);
  if (!complete) notes.push(`The sweep stopped at the ${Math.round(maxBytes / 1024 / 1024)} MB scan limit; files after that were not checked.`);
  if (!rels.length) complete = false;
  return { hermes, hits: matches2.length, matches: matches2, encrypted, complete, scannedBytes: scanned };
}

// src/remediation/verify.ts
import { existsSync as existsSync3 } from "node:fs";
import path6 from "node:path";

// src/rules/gating.ts
var COMPARE = /===?|!==?|\.includes\(|\.contains\(|\.has\(|\.equals\(|\bin\s*\[|\bcase\b|\.indexOf\(|\.hasPrefix\(|\.hasSuffix\(|\.startsWith\(|\.endsWith\(|\bisEqual/;
var IP_CONTEXT = /\b(ip|ips|ipAddress|ip_address|ipAddr|remoteAddr\w*|remoteAddress|remote_addr|clientIp\w*|clientIP|client_ip|x-forwarded-for|x-real-ip|cf-connecting-ip|true-client-ip|forwardedFor|forwarded|req\.ip|request\.ip|addr|address)\b/i;
var APPLE_WEBHOOK_CONTEXT = /signed_?payload|signedPayload|server_?notification|serverNotification|notification_?type|notificationType|webhook|apns|push_?notification/i;
var NOW_REF = /\bDate\(\)|\bDate\.now\b|\bnew Date\(\s*\)|\bDate\.init\(\)|\bNSDate\(\)|\.now\b|\bnow\b|\bcurrentDate\b|\btoday\b|CFAbsoluteTimeGetCurrent|timeIntervalSinceNow|\bisPast\b|\bhasPassed\b|\bisInThePast\b|\bisBeforeNow\b|\bisAfterNow\b/;
var ORDER_COMPARE = /[<>]=?|\.compare\(|isAfter|isBefore|timeIntervalSince|differenceInDays|daysBetween/;
var TIMEZONE_REF = /time_?zone|timeZone|TimeZone|secondsFromGMT|getTimezoneOffset/;
var STOREKIT_CONTEXT = /\bAppTransaction\b|\bTransaction\b|\bStoreKit\b|AppStore\.Environment|\bVerificationResult\b|\bjwsRepresentation\b|\btransaction\w*\??\.environment\b/;
var storeKitEnv = (_s, w, _b, file2) => STOREKIT_CONTEXT.test(w) || /^\s*import\s+StoreKit\b/m.test(file2);
var NOT_REGION = /phone|calling ?code|callingCode|dialCode|dialingCode|e164|E164|libphonenumber|PhoneNumber|languageCode|language_code|cacheKey|cache_key|Cache\b|\bcache\b/i;
var REGION_COMPARE = /(?:===?|!==?)\s*["'`][A-Z]{2,3}["'`]|["'`][A-Z]{2,3}["'`]\s*(?:===?|!==?)|\[[^\]]*["'`][A-Z]{2}["'`][^\]]*\]\s*\.(?:includes|contains|has)\(|\.(?:includes|contains|has)\(\s*[\w.?!]*(?:region|country)|\bcase\s+["'`][A-Z]{2,3}["'`]|\[\s*[\w.?!]*(?:region|country)\w*\s*\]/i;
var GATE_DETECTORS = [
  // Apple's corporate network: App Review traffic originates from 17.0.0.0/8.
  {
    kind: "apple-ip",
    label: "Apple IP range 17.0.0.0/8",
    rx: /["'`]17\.0\.0\.0\/8["'`]/,
    standalone: true,
    validate: (_s, w) => !APPLE_WEBHOOK_CONTEXT.test(w)
  },
  {
    kind: "apple-ip",
    label: "IP address prefix 17.",
    rx: /\b(?:startsWith|hasPrefix|startswith|indexOf)\(\s*["'`]17\.["'`]\s*\)/,
    standalone: true,
    validate: (s, w) => IP_CONTEXT.test(s) && !APPLE_WEBHOOK_CONTEXT.test(w)
  },
  {
    kind: "apple-ip",
    label: "IP address pattern ^17.",
    rx: /\^17\\\./,
    standalone: true,
    validate: (s, w) => IP_CONTEXT.test(w) && !APPLE_WEBHOOK_CONTEXT.test(w) && !/version|os_?version|systemVersion|ios/i.test(s)
  },
  {
    kind: "apple-ip",
    label: "first IP octet == 17",
    rx: /\[0\]\s*={2,3}\s*["'`]?17\b|\b17["'`]?\s*={2,3}\s*[\w.]+\[0\]/,
    standalone: true,
    validate: (s, w) => IP_CONTEXT.test(s) && /split\(\s*["'`]\.["'`]\s*\)|octet/i.test(w) && !APPLE_WEBHOOK_CONTEXT.test(w)
  },
  // Apple Park / Infinite Loop. A map centred there is common; only a distance or region test counts.
  {
    kind: "geofence",
    label: "Cupertino coordinates in a distance check",
    rx: /\b37\.3[2-4]\d*[\s\S]{0,120}?-122\.0[0-4]\d*/,
    standalone: true,
    validate: (_s, w) => /distance|geofence|CLCircularRegion|haversine|isNear\w*|withinRadius|radius/i.test(w) && /[<>]=?\s*[\d(]/.test(w)
  },
  {
    kind: "geofence",
    label: "Cupertino location comparison",
    rx: /["'`](?:Cupertino|Apple Park|Infinite Loop|One Apple Park Way|95014)["'`]/i,
    standalone: true,
    validate: (s) => COMPARE.test(s)
  },
  // Explicit reviewer detection.
  {
    kind: "reviewer",
    label: "App Review identity check",
    rx: /\b(?:isAppleReview(?:er)?|isAppReview(?:er|Build|Mode)?|appleReviewer\w*|appleReviewMode|reviewerAccount\w*|reviewerEmail\w*|reviewerUser\w*|REVIEWER_[A-Z_]+|APPLE_REVIEW\w*|APP_REVIEW_(?:MODE|ACCOUNT|EMAIL|USER)\w*|isUnderAppReview|isAppStoreReview\w*|isInAppStoreReview)\b/
  },
  {
    kind: "reviewer",
    label: "review-version comparison",
    rx: /\b(?:reviewVersion|review_version|reviewingVersion|auditVersion|audit_version|inReviewVersion|reviewBuildNumber|review_build)\b/
  },
  {
    kind: "reviewer",
    label: "App Store review-state check",
    rx: /["'`](?:IN_REVIEW|WAITING_FOR_REVIEW|in_review|inReview|under_review|is_reviewing)["'`]/,
    validate: (s, w) => /version|build|apple|app_?store|testflight|CFBundle/i.test(s) || /appStoreVersion|app_store_version|appStoreState|app_store_state|CFBundleShortVersionString/i.test(w)
  },
  {
    kind: "reviewer",
    label: "reviewer email comparison",
    rx: /["'`][^"'`\s@]*(?:apple|appreview|app_review|review|reviewer)[^"'`\s@]*@[^"'`\s]+["'`]|["'`]@apple\.com["'`]/i,
    validate: (s) => COMPARE.test(s)
  },
  {
    kind: "review-state",
    label: "review-mode flag",
    // "Review build" also names internal QA or code-review build configurations, so it is not proof of reviewer detection.
    rx: /\b(?:isReviewBuild|isReviewer|isInReview|inReview|isUnderReview|underReview|reviewMode|review_mode|isReviewMode|isReviewing|isAudit(?:ing|Mode)?|auditMode|audit_mode|shenhe\w*)\b/
  },
  {
    kind: "review-state",
    label: "review-state literal",
    rx: /["'`](?:IN_REVIEW|WAITING_FOR_REVIEW|in_review|inReview|under_review)["'`]/
  },
  // Demo / test accounts (2.1(a) asks for one; branching on it changes what the reviewer sees).
  {
    kind: "demo-account",
    label: "demo-account check",
    // Bare `isDemo` / `isDemoMode` also names playable demos (App Clips, trial levels), not reviewer accounts.
    rx: /\b(?:isDemoUser|isDemoAccount|demoAccount\w*|demo_account\w*|DEMO_ACCOUNT\w*|DEMO_EMAIL\w*|DEMO_USER\w*|demoEmail|demoUser\w*|isTestAccount|testAccount\w*|test_account\w*|TEST_ACCOUNT\w*|isTestUser)\b/
  },
  {
    kind: "demo-account",
    label: "demo email comparison",
    rx: /["'`][^"'`\s@]*(?:demo|tester|test)[^"'`\s@]*@[^"'`\s]+["'`]/i,
    validate: (s) => COMPARE.test(s)
  },
  // Build environment: App Review installs carry a sandbox receipt, like TestFlight.
  { kind: "environment", label: "sandbox receipt check", rx: /["'`]sandboxReceipt["'`]/ },
  { kind: "environment", label: "sandbox receipt check", rx: /\bappStoreReceiptURL\b[^;\n]*\b(?:lastPathComponent|sandbox)/ },
  {
    kind: "environment",
    label: "StoreKit environment check",
    rx: /\.environment\s*(?:==|!=|===|!==)\s*(?:\.|(?:AppStore\.)?Environment\.|["'`])(?:sandbox|xcode|production|Sandbox|Production|Xcode|SANDBOX|PRODUCTION)\b/,
    validate: storeKitEnv
  },
  {
    kind: "environment",
    label: "StoreKit environment check",
    rx: /(?:\.|(?:AppStore\.)?Environment\.)(?:sandbox|xcode)\s*(?:==|===)\s*[\w.?]*environment\b/,
    validate: storeKitEnv
  },
  { kind: "environment", label: "StoreKit environment switch", rx: /\bswitch\s+[\w.?!()]*\benvironment\s*\{/, validate: storeKitEnv },
  {
    kind: "environment",
    label: "TestFlight / sandbox detection",
    rx: /\b(?:isTestFlight\w*|isTestflight\w*|IS_TESTFLIGHT|isRunningInTestFlight\w*|isSandbox(?:Environment|Receipt|Build)?|isSandboxedReceipt|inTestFlight|isAppStoreBuild|isAppStoreEnvironment)\b/
  },
  {
    kind: "environment",
    label: "install-source detection",
    rx: /\bgetIosApplicationReleaseTypeAsync\b|\bApplicationReleaseType\.(?:AD_HOC|APP_STORE|DEVELOPMENT|ENTERPRISE|SIMULATOR)\b/
  },
  {
    kind: "environment",
    label: "provisioning-profile detection",
    rx: /embedded\.mobileprovision|forResource:\s*"embedded"\s*,\s*ofType:\s*"mobileprovision"/
  },
  // Absolute date switches.
  {
    kind: "date",
    label: "launch/unlock date",
    rx: /\b(?:launchDate|goLiveDate|unlockDate|approvalDate|reviewEndDate|activationDate|switchDate|enableDate|enableAfter|liveDate|cutoverDate|LAUNCH_DATE|GO_LIVE\w*|UNLOCK_DATE|UNLOCK_AT|APPROVAL_DATE|go_live_at|unlock_at|launch_at|releaseDate|RELEASE_DATE)\b/,
    // `movie.releaseDate` is data about something else; `Config.launchDate` / `self.unlockDate` is a switch.
    validate: (s, _w, before) => NOW_REF.test(s) && ORDER_COMPARE.test(s) && !/(?:^|[^\w.])(?!self\b|this\b|config\b|remoteConfig\b|settings\b|appConfig\b)[a-z]\w*\??\.$/.test(before)
  },
  {
    kind: "date",
    label: "hardcoded date comparison",
    rx: /["'`]20\d\d-\d\d-\d\d[T"'`\s]|\b1[6-9]\d{8}(?:\d{3})?\b|DateComponents\(\s*(?:calendar:[^,]*,\s*)?year:\s*20\d\d|new Date\(\s*20\d\d\s*,/,
    validate: (s) => NOW_REF.test(s) && ORDER_COMPARE.test(s)
  },
  {
    kind: "install-age",
    label: "install-age / launch-count gate",
    rx: /\b(?:daysSinceInstall\w*|daysSinceFirstLaunch|daysSinceFirstOpen|installDate|installedAt|firstLaunchDate|firstOpenDate|firstInstallTime|getFirstInstallTime|launchCount|appLaunchCount|sessionCount|appOpenCount|openCount|install_date|days_since_install|first_launch_date)\b/,
    validate: (s) => /[<>]=?|===?|\.compare\(|timeIntervalSince/.test(s)
  },
  // Region, storefront and timezone.
  {
    kind: "storefront",
    label: "App Store storefront check",
    rx: /\b(?:Storefront\.current|SKPaymentQueue\.default\(\)\.storefront|storefront\w*|Storefront\w*|getStorefront\w*)\b/
  },
  {
    kind: "region",
    label: "device/IP region check",
    rx: /\b(?:Locale\.(?:current|autoupdatingCurrent)\.(?:regionCode|region)|RNLocalize\.getCountry|Localization\.region|cf-ipcountry|CF-IPCountry|cf\??\.country|x-vercel-ip-country|x-country-code|cloudfront-viewer-country|geoip\w*|geoIP\w*|ipCountry|ip_country|geoCountry|countryFromIp\w*|getCountryFromIp\w*)\b/i,
    validate: (s) => !NOT_REGION.test(s)
  },
  {
    kind: "region",
    label: "device/IP region check",
    // A bare `countryCode` is often a phone prefix or a lookup key; it is a gate only when compared to a country.
    rx: /\b(?:regionCode|countryCode|getCountry)\b/,
    validate: (s) => !NOT_REGION.test(s) && REGION_COMPARE.test(s)
  },
  {
    kind: "region",
    label: "country comparison",
    rx: /\bcountry\w*\b/i,
    // `station.country` describes data; the user's or request's country is a gate.
    validate: (s, _w, before) => !NOT_REGION.test(s) && (!/\.$/.test(before) || /\b(?:user|req|request|geo|locale|device|client|viewer|account|profile|session|ctx|context|cf|headers?|me|currentUser|location|ipInfo|geoInfo)\??\.$/i.test(before)) && /country\w*\s*(?:===?|!==?)\s*["'`][A-Z]{2,3}["'`]|["'`][A-Z]{2,3}["'`]\s*(?:===?|!==?)\s*[\w.?]*country|\[[^\]]*["'`][A-Z]{2}["'`][^\]]*\]\s*\.(?:includes|contains)\(\s*[\w.?]*country/i.test(s)
  },
  {
    kind: "timezone-pacific",
    label: "Pacific timezone check",
    rx: /["'`](?:America\/Los_Angeles|US\/Pacific|PST|PDT|America\/Vancouver|Pacific Time)["'`]|secondsFromGMT\(\)\s*(?:==|<=|>=|<|>)\s*-\s*(?:25200|28800)|getTimezoneOffset\(\)\s*(?:===?|>=|<=)\s*(?:420|480)/,
    validate: (s) => TIMEZONE_REF.test(s) && COMPARE.test(s) || /secondsFromGMT|getTimezoneOffset/.test(s)
  },
  {
    kind: "timezone",
    label: "timezone check",
    rx: /\b(?:TimeZone\.current|TimeZone\.autoupdatingCurrent|NSTimeZone\.local|resolvedOptions\(\)\.timeZone|getTimezoneOffset|secondsFromGMT|RNLocalize\.getTimeZone|Localization\.timezone|getTimeZone)\b/
  }
];
var RECEIPT_CONTEXT = /signed_?payload|signedPayload|serverNotification|server_notification|notificationType|notification_type|verifyReceipt|AppStoreServerAPIClient|SignedDataVerifier|verifyAndDecode\w*|decodeTransaction|JWSTransaction|SignedTransaction|app-store-server-library|appstoreserverlibrary/;
var LEGAL_MARKERS = /\b(gdpr|ccpa|legal|laws?|regulat\w*|complian\w*|consent|tax|vat|gst|age verification|age assurance|age check|osa|dsa|dma|external purchase\w*|alternative payment\w*|alt payment|link out|external link|loot ?box\w*|gambling|betting|sportsbooks?|casinos?|wager\w*|real money|sweepstakes|china|mainland|icp|korea|netherlands|sanction\w*|embargo\w*|ofac|restricted (countries|regions)|not available in your (country|region)|unavailable in your (country|region))\b/;
var SINKS2 = {
  adult: /\b(nsfw|adult|explicit|nude|nudes|nudity|naked|lingerie|bikini|underwear|undress\w*|sexy|spicy|uncensored|unfiltered|erotic\w*|porn\w*|hentai|xxx|lewd|seductive|topless|boudoir|onlyfans|r18|mature content|unclothed|nudif\w*|deep ?nude|(clothes|clothing) (off|remov\w*)|remov\w* (the |her |his |their |all )?(clothes|clothing)|see through (cloth\w*|dress|shirt|filter|mode|effect)|x ray (cloth\w*|vision|filter|mode|camera|effect))\b/,
  generator: /\b(generat(e|es|ing|ion)\b(?!\s+(uuid|id|ids|key|keys|hash|token|haptic|report|pdf|qr|barcode|random|nonce|salt|password|thumbnail|preview|feedback|code|csv|invoice|receipt))|generate (image|images|photo|avatar|video|art|content|response|reply|completion|text|message|story|character|picture|outfit|portrait)|txt2img|img2img|text to image|image to image|inpaint\w*|outpaint\w*|diffusion|sdxl|dall e|dalle|midjourney|replicate|fal (run|subscribe)|stability|openai|anthropic|gemini|gpt|llm|chat completions?|completions create|messages create|face swap|swap face|faceswap|create image|images generate)\b/,
  persona: (
    // "character(s)" alone is mostly text length ("N characters", textThatFits); it needs a persona context.
    /\b(persona|personas|(ai|chat|virtual|fictional|custom|anime|roleplay|companion|your|create a|my) characters?|characters? (chat|creator|card|cards|persona|profile|builder|preset|presets|prompt)|companion|companions|girlfriend|boyfriend|waifu|husbando|roleplay|role play|outfit|outfits|costume|costumes|wardrobe|dress up|clothing|clothes|virtual (friend|partner|lover)|lover)\b(?!\s+(count|limit|limits|set|encoding|length|spacing|index|width))/
  ),
  safety: /\b(moderat\w*|safety|safe mode|safe search|safesearch|content filter|nsfw filter|profanity filter|filter content|block none|age gate|age verification)\b/,
  price: /\b(paywall|paywalls|price|prices|pricing|display price|discount\w*|(?:promo|promotion\w*)(?! (?:bridge|factory|decider|delegate|builder|coordinator|protocol|type|kind|id|key|cache)\b)|free trial|trial|offering|offerings|product ids?|sku|in app purchase|iap|checkout|premium (view|screen|sheet|upsell|offer)|subscription (screen|view|sheet|price|offer|plan)|upgrade (screen|sheet|view|modal|prompt))\b|\b(purchase|buy|subscribe)\s*\(/,
  unlock: /\b(unlock\w*|grant (access|premium|pro|entitlement)|is (premium|pro|subscribed|vip|unlocked)\s*[:=]\s*true|has (premium|pro)\s*[:=]\s*true|bypass paywall|skip paywall|free access|all access|entitlement override)\b/,
  gambling: /\b(gambling|gamble|betting|sportsbooks?|sports book|bookmaker|casinos?|wagers?|wagering|real money (bets?|games?|gaming|play)|slot machines?|slots (game|games|machine|spin)|roulette|blackjack|poker|loot ?box\w*)\b/,
  // An embedded web surface shows whatever the server sends, so a review-mode swap to one changes the app after approval.
  websurface: /\b(wk ?web ?view|web ?view|sf ?safari ?view ?controller|safari ?view|in ?app ?browser|web ?page)\b/,
  debug: /\b(debug (menu|view|panel|screen|overlay|settings|tools|console|info|button|options|sheet)|dev (menu|tools|settings|panel)|developer (menu|options|settings|tools)|flex|flex manager|internal (settings|menu|tools)|diagnostics|log viewer|logs view|qa (menu|panel|tools)|test menu|environment switcher|feature flags (view|screen|menu)|inspector|shake to)\b/,
  logging: /\b(print|debug print|log|logs|logger|os log|nslog|console|analytics|track|crashlytics|sentry|breadcrumb|telemetry)\b/,
  receipt: /\b(verify receipt|receipt|receipts|sandbox itunes|buy itunes|app store server|environment|verification|validate receipt|sandbox|production|xcode)\b/,
  backend: /\b(base url|api url|api base|endpoint|endpoints|server url|api host|backend url|backend|staging|host)\b/
};
var SENSITIVE_SINKS = ["adult", "generator", "persona", "safety", "price", "unlock", "gambling"];
var CONTENT_SINKS = ["adult", "generator", "persona", "safety", "unlock", "gambling"];
var LOG_CALL = /\b(?:print|debugPrint|NSLog|os_log|logger\.\w+|Logger\(\)\.\w+|log\.\w+|Log\.\w+|logEvent|console\.\w+|Analytics\.\w+|analytics\.\w+|Sentry\.\w+|Crashlytics\.\w+|crashlytics\(\)\.\w+|track|trackEvent)\s*\(/g;
function wordsOf(text) {
  return text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/[_\-./\\]+/g, " ").toLowerCase();
}
function stripLogCalls(text) {
  let logged = false;
  let out = text;
  for (let guard = 0; guard < 50; guard++) {
    LOG_CALL.lastIndex = 0;
    const m = LOG_CALL.exec(out);
    if (!m) break;
    logged = true;
    let depth = 1;
    let k = m.index + m[0].length;
    while (k < out.length && depth > 0) {
      if (out[k] === "(") depth++;
      else if (out[k] === ")") depth--;
      k++;
    }
    out = out.slice(0, m.index) + " " + out.slice(k);
  }
  return { rest: out, logged };
}
var PROMO_WORD = /^(?:promo|promotion)\w*$/;
var BACKEND_SELECT = /\b\w*(?:base_?url|api_?(?:url|base|host|endpoint)|server_?(?:url|host)|backend_?url|endpoints?|host(?:name)?|environment|backend|server)\w*\s*(?:=(?![=>])|:(?!:))|\breturn\s+[\w.]*(?:url|host|api|endpoint|backend|server|staging)\w*\b|https?:\/\/[^"'`\s]*\b(?:staging|stage|dev|sandbox|test|qa|localhost)\b|\.(?:staging|production|prod|dev|sandbox|localhost)\b(?!\s*\()/i;
function classifySinks(text) {
  const { rest, logged } = stripLogCalls(text);
  const w = wordsOf(rest);
  const kinds = [];
  const words = {};
  for (const k of Object.keys(SINKS2)) {
    if (k === "logging") continue;
    let m = SINKS2[k].exec(w);
    if (m && k === "price" && PROMO_WORD.test(m[0])) m = SINKS2.price.exec(w.replace(/\b(?:promo|promotion)\w*/g, " ")) ?? m;
    if (m && k === "backend" && !BACKEND_SELECT.test(rest)) m = null;
    if (m) {
      kinds.push(k);
      words[k] = m[0].trim();
    }
  }
  if (logged || SINKS2.logging.test(w)) {
    kinds.push("logging");
    words.logging = "logging";
  }
  const hasCode = /[A-Za-z_$][\w$]*\s*[({=]|<[A-Z]\w*/.test(rest.replace(/\b(return|else|break|continue)\b/g, ""));
  return { kinds, words, hasCode };
}
function hasAny(p, kinds) {
  return p.kinds.some((k) => kinds.includes(k));
}
function describeSinks(p, kinds = SENSITIVE_SINKS) {
  const parts = p.kinds.filter((k) => kinds.includes(k)).map((k) => `${k} ("${p.words[k] ?? k}")`);
  return parts.join(", ");
}
var SERVER_PATH2 = /(^|\/)(workers?|functions|supabase\/functions|api|server|backend|edge|cloudflare|lambda|netlify\/functions)\//;
var PROVIDER_IMPORTS = {
  "Firebase Remote Config": /FirebaseRemoteConfig|RemoteConfig\b|remote-config|remoteConfig|firebase\/remote-config/,
  LaunchDarkly: /launchdarkly|LaunchDarkly|LDClient/,
  Statsig: /statsig|Statsig/,
  PostHog: /posthog|PostHog/,
  ConfigCat: /configcat|ConfigCat/,
  Optimizely: /optimizely|Optimizely/,
  Unleash: /unleash|Unleash/,
  GrowthBook: /growthbook|GrowthBook/,
  RevenueCat: /RevenueCat|react-native-purchases|Purchases\b|purchases-js/,
  Superwall: /Superwall|superwall/,
  Adapty: /Adapty|adapty/
};
var Q = `['"\`]`;
var KEY = `${Q}([^'"\`]+)${Q}`;
var QUOTED_KEY = KEY;
var FLAG_READS = [
  // Firebase Remote Config
  { provider: "Firebase Remote Config", rx: new RegExp(`\\[\\s*"([^"]+)"\\s*\\]\\s*\\.(?:boolValue|stringValue|numberValue|jsonValue|dataValue)\\b`), keyGroup: 1 },
  { provider: "Firebase Remote Config", rx: /\.configValue\(\s*forKey:\s*"([^"]+)"/, keyGroup: 1 },
  { provider: "Firebase Remote Config", rx: /@RemoteConfigProperty\(\s*key:\s*"([^"]+)"\s*,\s*fallback:\s*([^)]+)\)/, keyGroup: 1, defaultGroup: 2 },
  {
    provider: "Firebase Remote Config",
    rx: new RegExp(`\\.get(?:Value|Boolean|String|Number)\\(\\s*${KEY}\\s*\\)`),
    keyGroup: 1,
    requires: /remote-config|remoteConfig\(\)|RemoteConfig/
  },
  {
    provider: "Firebase Remote Config",
    rx: new RegExp(`\\bget(?:Value|Boolean|String|Number)\\(\\s*\\w+\\s*,\\s*${KEY}\\s*\\)`),
    keyGroup: 1,
    requires: /firebase\/remote-config|getRemoteConfig/
  },
  // LaunchDarkly
  {
    provider: "LaunchDarkly",
    rx: new RegExp(`\\b(?:use)?(?:[Bb]ool|[Ss]tring|[Ii]nt|[Dd]ouble|[Jj]son|[Nn]umber)Variation(?:Detail)?\\(\\s*(?:forKey:\\s*)?${KEY}\\s*,\\s*(?:defaultValue:\\s*)?([^)]+?)\\s*\\)`),
    keyGroup: 1,
    defaultGroup: 2
  },
  {
    provider: "LaunchDarkly",
    rx: new RegExp(`\\.variation\\(\\s*${KEY}\\s*,\\s*([^)]+?)\\s*\\)`),
    keyGroup: 1,
    defaultGroup: 2,
    requires: PROVIDER_IMPORTS.LaunchDarkly
  },
  // Statsig
  {
    provider: "Statsig",
    rx: new RegExp(`\\b(?:checkGate|useGate|useFeatureGate|getFeatureGate|checkGateWithExposureLoggingDisabled)\\(\\s*(?:\\w+\\s*,\\s*)?${KEY}`),
    keyGroup: 1,
    requires: PROVIDER_IMPORTS.Statsig
  },
  {
    provider: "Statsig",
    rx: new RegExp(`\\b(?:getConfig|getDynamicConfig|useConfig|useDynamicConfig|getExperiment|useExperiment|getLayer|useLayer)\\(\\s*(?:\\w+\\s*,\\s*)?${KEY}`),
    keyGroup: 1,
    requires: PROVIDER_IMPORTS.Statsig
  },
  // PostHog / ConfigCat / Optimizely / Unleash share method names; the import decides.
  {
    provider: ["PostHog", "Optimizely", "ConfigCat", "Unleash"],
    rx: new RegExp(`\\b(?:isFeatureEnabled|getFeatureFlag|getFeatureFlagPayload|useFeatureFlagEnabled|useFeatureFlagPayload|useFeatureFlagVariantKey|useFeatureFlag)\\(\\s*${KEY}(?:\\s*,\\s*([^)]+?))?\\s*\\)`),
    keyGroup: 1,
    defaultGroup: 2
  },
  {
    provider: "ConfigCat",
    rx: new RegExp(`\\bgetValue(?:Async)?\\(\\s*(?:for:\\s*)?${KEY}\\s*,\\s*(?:defaultValue:\\s*)?([^,)]+)`),
    keyGroup: 1,
    defaultGroup: 2,
    requires: PROVIDER_IMPORTS.ConfigCat
  },
  {
    provider: "Optimizely",
    rx: new RegExp(`\\b(?:decide|useDecision|getFeatureVariable\\w*)\\(\\s*(?:key:\\s*)?${KEY}`),
    keyGroup: 1,
    requires: PROVIDER_IMPORTS.Optimizely
  },
  {
    provider: "Unleash",
    rx: new RegExp(`\\b(?:isEnabled|useFlag|useVariant|getVariant)\\(\\s*(?:name:\\s*)?${KEY}`),
    keyGroup: 1,
    requires: PROVIDER_IMPORTS.Unleash
  },
  {
    provider: "GrowthBook",
    rx: new RegExp(`\\b(?:isOn|isOff|getFeatureValue|useFeatureIsOn|useFeatureValue|evalFeature|feature)\\(\\s*(?:feature:\\s*|id:\\s*)?${KEY}(?:\\s*,\\s*(?:default:\\s*)?([^)]+?))?\\s*\\)`),
    keyGroup: 1,
    defaultGroup: 2,
    requires: PROVIDER_IMPORTS.GrowthBook
  },
  // RevenueCat offering metadata, and remote paywalls
  {
    provider: "RevenueCat offering metadata",
    rx: new RegExp(`\\bmetadata\\??\\s*\\[\\s*${KEY}\\s*\\]`),
    keyGroup: 1,
    requires: PROVIDER_IMPORTS.RevenueCat
  },
  {
    provider: "RevenueCat offering metadata",
    rx: new RegExp(`\\.getMetadataValue\\(\\s*(?:for:\\s*)?${KEY}\\s*,\\s*(?:default:\\s*)?([^)]+?)\\s*\\)`),
    keyGroup: 1,
    defaultGroup: 2
  },
  { provider: "RevenueCat offering metadata", rx: /\boffering\w*\??\.metadata\??\.(\w+)/, keyGroup: 1, requires: PROVIDER_IMPORTS.RevenueCat },
  {
    provider: "RevenueCat Paywalls",
    rx: /\b(?:PaywallView|presentPaywallIfNeeded|presentPaywall|RevenueCatUI\.\w+)\b/,
    keyGroup: 0,
    requires: /RevenueCatUI|react-native-purchases-ui/,
    paywall: true
  },
  {
    provider: "Superwall",
    rx: new RegExp(`\\b(?:register|registerPlacement|usePlacement)\\(\\s*(?:\\{\\s*)?(?:event|placement)?:?\\s*${KEY}`),
    keyGroup: 1,
    requires: PROVIDER_IMPORTS.Superwall,
    paywall: true
  },
  {
    provider: "Adapty",
    rx: new RegExp(`\\bget(?:Paywall|Placement)\\(\\s*(?:placementId:\\s*|id:\\s*)?${KEY}`),
    keyGroup: 1,
    requires: PROVIDER_IMPORTS.Adapty,
    paywall: true
  },
  { provider: "Adapty", rx: /\.remoteConfig(?:String|Dictionary)?\??\s*\[?\s*["']?(\w*)/, keyGroup: 1, requires: /Adapty|adapty/ }
];
var CUSTOM_CONFIG_URL = /["'`](https?:\/\/[^"'`\s]*?(\.workers\.dev|\.pages\.dev|\.supabase\.co|\.supabase\.in|\.s3[.-][^"'`\s/]*amazonaws\.com|s3\.amazonaws\.com|gist\.githubusercontent\.com|raw\.githubusercontent\.com|gist\.github\.com|jsonbin\.io|npoint\.io|firebasestorage\.googleapis\.com|\.r2\.dev|\.cloudfront\.net)[^"'`\s]*)["'`]/;
var ALWAYS_CONFIG_HOSTS = /gist\.githubusercontent\.com|raw\.githubusercontent\.com|gist\.github\.com|jsonbin\.io|npoint\.io/;
var CONFIG_PATH = /config|flag|feature|setting|remote|toggle|switch|kill|\.json(\?|$|#)/i;
var STATIC_ASSET_PATH = /\.(?:png|jpe?g|gif|webp|heic|svg|ico|pdf|ttf|otf|woff2?|mp3|mp4|m4a|mov|wav|aac|caf|zip|gz|tgz|tar|bz2|xz|7z|bin|onnx|mlmodel|mlpackage|gguf|safetensors|pt|pth|tflite|csv|tsv|parquet|(?:idx\d?-)?ubyte(?:\.gz)?)(?:[?#]|$)/i;
var CONFIG_TABLE = /\.from\(\s*['"`](app_?config|config|configs|feature_?flags|flags|settings|app_?settings|remote_?config|toggles|kill_?switch(?:es)?)['"`]\s*\)/i;
var CONFIG_COLLECTION = /\.collection\(\s*['"`](config|configs|settings|flags|featureFlags|feature_flags|remoteConfig|remote_config|appConfig|app_config)['"`]\s*\)/;
var KILL_WORDS = /\b(kill|killswitch|disable|disabled|maintenance|emergency|outage|pause|paused|force update|forced update|min version|minimum version|min app version|shutdown|read only)\b/;
var PRICE_KEY_WORDS = /\b(price|prices|pricing|paywall|trial|discount|offer|offering|promo|sale|plan|sku|iap|subscription|hard paywall|soft paywall|free)\b/;
var OTA_PACKAGES = {
  "expo-updates": "expo-updates (EAS Update)",
  "react-native-code-push": "CodePush",
  "@code-push-next/react-native-code-push": "CodePush",
  "@revopush/react-native-code-push": "CodePush (Revopush)",
  "@bravemobile/react-native-code-push": "CodePush",
  "@appzung/react-native-code-push": "CodePush (AppZung)",
  "react-native-update": "Pushy (react-native-update)",
  "react-native-ota-hot-update": "react-native-ota-hot-update",
  "@hot-updater/react-native": "hot-updater",
  "hot-updater": "hot-updater",
  "react-native-stallion": "Stallion",
  "react-native-dynamic-bundle": "react-native-dynamic-bundle"
};
var NATIVE_HOTPATCH = /\bpod\s+['"](JSPatch|JSPatchPlatform|MangoFix|OCRunner|DynamicCocoa|WaxPatch|Wax|Rollout\.io|Rollout)['"]|#import\s+[<"](?:JSPatch|JSPatchPlatform|MangoFix|OCRunner)\/|\bimport\s+(?:MangoFix|OCRunner|JSPatch)\b|\bJPEngine\s+(?:startEngine|evaluateScript)|\[JPEngine\s+(?:startEngine|evaluateScript)|\bMFInterpreter\b|\bJSPatch\.(?:startWithAppKey|sync)|\bRollout\.setupWithKey/;
var JS_NETWORK = /\bfetch\(|axios|XMLHttpRequest|\.text\(\)|downloadFile|downloadAsync|readAsStringAsync|RNFS\.readFile|\bgot\(|ky\.get|superagent/;
var NATIVE_NETWORK = /URLSession|dataTask|downloadTask|AF\.request|Alamofire|Data\(contentsOf:\s*(?!Bundle)|String\(contentsOf:\s*(?!Bundle)|NSURLConnection|NSURLSession|dataWithContentsOfURL/;
var DOWNLOADED_PATH = /documentDirectory|NSDocumentDirectory|cachesDirectory|NSCachesDirectory|NSTemporaryDirectory|temporaryDirectory|applicationSupportDirectory|Documents|Caches|download/i;

// src/scanners/reviewGating.ts
var CODE_EXTS2 = /* @__PURE__ */ new Set(["swift", "m", "mm", "h", "ts", "tsx", "js", "jsx", "mjs", "cjs", "kt", "java"]);
var MAX_BODY = 4e3;
function isCodeFile2(f) {
  return CODE_EXTS2.has(f.ext);
}
var maskCache = /* @__PURE__ */ new WeakMap();
function maskOf(file2) {
  let m = maskCache.get(file2);
  if (m === void 0) {
    m = blankStrings(file2.code, file2.ext);
    maskCache.set(file2, m);
  }
  return m;
}
var OPENERS = "([{";
var CLOSERS = ")]}";
var CONTINUE_PREV2 = /[&|?:=(,.+\-*/<>!]$/;
var CONTINUE_NEXT2 = /^(&&|\|\||\?(?![?.])|:|\.(?!\.)|==|!=|\+|-(?!-)|\*|\/(?![/*]))/;
function prevNonSpace(m, k) {
  let j = k - 1;
  while (j >= 0 && /\s/.test(m[j])) j--;
  return j >= 0 ? m[j] : "";
}
var MAX_STATEMENT = 4096;
function statementStart(m, i) {
  let depth = 0;
  const floor = Math.max(0, i - MAX_STATEMENT);
  for (let k = i - 1; k >= floor; k--) {
    const ch = m[k];
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
      while (j < i && /\s/.test(m[j])) j++;
      const next = m.slice(j, Math.min(i, j + 8));
      if (!(CONTINUE_PREV2.test(prev) || CONTINUE_NEXT2.test(next))) return { start: k + 1, stop: "\n" };
    }
  }
  return { start: floor, stop: "" };
}
function statementEnd(m, i) {
  let depth = 0;
  const limit = Math.min(m.length, i + MAX_STATEMENT);
  for (let k = i; k < limit; k++) {
    const c = m.charCodeAt(k);
    if (c === 40 || c === 91 || c === 123) depth++;
    else if (c === 41 || c === 93 || c === 125) {
      if (depth === 0) return k;
      depth--;
    } else if (c === 59 && depth === 0) return k;
    else if (c === 10 && depth === 0) {
      const prev = prevNonSpace(m, k);
      const rest = m.slice(k + 1, k + 40).trimStart();
      if (!(CONTINUE_PREV2.test(prev) || CONTINUE_NEXT2.test(rest))) return k;
    }
  }
  return limit;
}
function matchClose(m, open4) {
  const o = m[open4];
  const c = o === "(" ? ")" : o === "[" ? "]" : "}";
  let depth = 0;
  for (let k = open4; k < m.length; k++) {
    if (m[k] === o) depth++;
    else if (m[k] === c) {
      depth--;
      if (depth === 0) return k;
    }
  }
  return m.length - 1;
}
function skipSpace(m, k) {
  while (k < m.length && /\s/.test(m[k])) k++;
  return k;
}
function firstBlockOpen(m, from, limit = 600) {
  let depth = 0;
  for (let k = from; k < m.length && k < from + limit; k++) {
    const ch = m[k];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") {
      if (depth === 0) return -1;
      depth--;
    } else if (ch === "{" && depth === 0) return k;
    else if ((ch === ";" || ch === "}") && depth === 0) return -1;
  }
  return -1;
}
function enclosingBlock(file2, index) {
  return enclosingBraces(file2.code, file2.ext, index);
}
function branchAt(code, m, k) {
  k = skipSpace(m, k);
  if (m[k] === "{") {
    const close = matchClose(m, k);
    return { text: code.slice(k + 1, close), end: close + 1 };
  }
  const end = statementEnd(m, k);
  return { text: code.slice(k, end), end: end + (m[end] === ";" ? 1 : 0) };
}
function remainderOfScope(file2, from) {
  const code = file2.code;
  const b = enclosingBlock(file2, from);
  const close = b ? b.close : code.length;
  return code.slice(from, Math.min(close, from + MAX_BODY));
}
var EARLY_EXIT = /^\s*\{?\s*(return|throw|break|continue)\b[^{};]*;?\s*\}?\s*$/;
function ifSite(file2, start, kw) {
  const code = file2.code;
  const m = maskOf(file2);
  const kwAt = m.indexOf(kw, start);
  if (kwAt < 0) return void 0;
  let p = skipSpace(m, kwAt + kw.length);
  let bodyAt;
  if (m[p] === "(") {
    const close = matchClose(m, p);
    bodyAt = skipSpace(m, close + 1);
    if (m[bodyAt] !== "{" && /^(&&|\|\||,)/.test(m.slice(bodyAt, bodyAt + 2))) {
      const open4 = firstBlockOpen(m, bodyAt);
      if (open4 < 0) return void 0;
      bodyAt = open4;
    }
  } else {
    const open4 = firstBlockOpen(m, p);
    if (open4 < 0) return void 0;
    bodyAt = open4;
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
      const open4 = firstBlockOpen(m, p + 2);
      if (open4 < 0) break;
      body += `
${code.slice(p, open4)}`;
      const br = branchAt(code, m, open4);
      body += `
${br.text}`;
      end = br.end;
    } else {
      const br = branchAt(code, m, p);
      body += `
${br.text}`;
      end = br.end;
      break;
    }
  }
  if (EARLY_EXIT.test(first.text)) body += `
${remainderOfScope(file2, end)}`;
  return { kind: kw, header, body: body.slice(0, MAX_BODY), start, line: lineOf(code, start) };
}
function guardSite(file2, start) {
  const code = file2.code;
  const m = maskOf(file2);
  const elseAt = m.slice(start, start + 600).search(/\belse\s*\{/);
  if (elseAt < 0) return void 0;
  const open4 = m.indexOf("{", start + elseAt);
  const close = matchClose(m, open4);
  const header = code.slice(start, start + elseAt).replace(/\s+/g, " ").trim();
  const body = `${code.slice(open4 + 1, close)}
${remainderOfScope(file2, close + 1)}`;
  return { kind: "guard", header, body: body.slice(0, MAX_BODY), start, line: lineOf(code, start) };
}
function topLevelOp(m, from, to, op) {
  let depth = 0;
  for (let k = from; k < to; k++) {
    const ch = m[k];
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
var DECL = /^(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|internal|fileprivate|static|class|lazy|final|override|export|nonisolated|readonly|async)\s+)*(?:let|var|const)\s+([A-Za-z_$][\w$]*)/;
var MEMBER_DECL = /^(?:(?:public|private|protected|static|readonly)\s+)+([A-Za-z_$][\w$]*)\s*[:=]/;
var FUNC_DECL = /^(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|internal|fileprivate|static|class|final|override|export|nonisolated|async|mutating)\s+)*(?:func|function|get)\s+([A-Za-z_$][\w$]*)/;
var ASSIGN = /^(?:self\.|this\.)?([A-Za-z_$][\w$]*)\s*=(?!=)/;
var CONTAINER = [
  /(?:var|let)\s+([A-Za-z_]\w*)\s*:\s*Bool\??\s*$/,
  /func\s+([A-Za-z_]\w*)\s*\([^)]*\)[^{]*$/,
  /function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)[^{]*$/,
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>\s*$/,
  /\bget\s+([A-Za-z_$][\w$]*)\s*\(\s*\)[^{]*$/,
  /^\s*(?:(?:public|private|protected|static|async)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[\w<>[\]| ]+)?\s*$/
];
var NOT_NAMES = /* @__PURE__ */ new Set(["if", "for", "while", "switch", "catch", "return", "guard", "else", "function", "init"]);
function containerName(code, m, braceAt) {
  const { start } = statementStart(m, braceAt);
  const header = code.slice(start, braceAt).replace(/\s+/g, " ").trim();
  for (const rx of CONTAINER) {
    const mm = rx.exec(header);
    if (mm?.[1] && !NOT_NAMES.has(mm[1])) return mm[1];
  }
  return void 0;
}
var TRANSPARENT_CALLS = /(?:^|[^\w$.])(?:Boolean|Bool|String|Number|Int|Double|parseInt|parseFloat|Optional)\s*$/;
function insideCallArgs(m, from, index) {
  let depth = 0;
  for (let k = index - 1; k >= from; k--) {
    const ch = m[k];
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
var analysisCache = /* @__PURE__ */ new WeakMap();
function analyzeAt(file2, index) {
  let byIndex = analysisCache.get(file2);
  if (!byIndex) analysisCache.set(file2, byIndex = /* @__PURE__ */ new Map());
  let a = byIndex.get(index);
  if (!a) byIndex.set(index, a = analyzeUncached(file2, index));
  return a;
}
function analyzeUncached(file2, index) {
  const code = file2.code;
  const m = maskOf(file2);
  const { start: rawStart, stop } = statementStart(m, index);
  const start = skipSpace(m, rawStart);
  const end = Math.max(statementEnd(m, start), index);
  const statement = code.slice(start, Math.min(Math.max(end, index), Math.max(index + 200, start + 400))).replace(/\s+/g, " ").trim();
  const rawLead = code.slice(start, start + 200);
  const lead = rawLead.replace(/^\}\s*/, "");
  const out = { statement, stmtStart: start, stmtEnd: end, inCall: insideCallArgs(m, start, index) };
  const named = DECL.exec(lead) ?? MEMBER_DECL.exec(lead) ?? FUNC_DECL.exec(lead);
  if (named?.[1]) {
    const nameAt = start + (rawLead.length - lead.length) + named[0].lastIndexOf(named[1]);
    if (index >= nameAt && index < nameAt + named[1].length) {
      out.declares = named[1];
      return out;
    }
  }
  if (/^(?:else\s+)?if\b/.test(lead)) {
    out.site = ifSite(file2, start, "if");
    return out;
  }
  if (/^while\b/.test(lead)) {
    out.site = ifSite(file2, start, "while");
    return out;
  }
  if (/^guard\b/.test(lead)) {
    out.site = guardSite(file2, start);
    return out;
  }
  if (/^switch\b/.test(lead)) {
    const open4 = firstBlockOpen(m, start);
    if (open4 > 0) {
      const close = matchClose(m, open4);
      out.site = {
        kind: "switch",
        header: code.slice(start, open4).replace(/\s+/g, " ").trim(),
        body: code.slice(open4 + 1, close).slice(0, MAX_BODY),
        start,
        line: lineOf(code, start)
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
    if (index >= nameEnd) {
      out.derived = declared[1];
      out.derivedBy = DECL.exec(lead) ? "decl" : "assign";
    }
    return out;
  }
  if (/^return\b/.test(lead) || stop === "{") {
    const block = enclosingBlock(file2, index);
    if (block) {
      const inner = code.slice(block.open + 1, block.close).trim();
      const single = inner.replace(/^return\s+/, "").replace(/;$/, "").trim() === statement.replace(/^return\s+/, "").replace(/;$/, "").trim();
      if (/^return\b/.test(lead) && !out.inCall || single) {
        out.derived = containerName(code, m, block.open);
        if (out.derived) out.derivedBy = "container";
      }
    }
  }
  return out;
}
function escapeRx3(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function isDistinctive(name) {
  if (name.length < 6) return false;
  return /^(is|in|has|should|show|enable|can|use|allow)[A-Z_]/.test(name) || /review|testflight|sandbox|demo|launch|unlock/i.test(name) || name.length >= 8 && /[a-z][A-Z]|_/.test(name);
}
var GENERIC_NAMES = /* @__PURE__ */ new Set([
  "isEnabled",
  "enabled",
  "isOn",
  "isOff",
  "isActive",
  "active",
  "isVisible",
  "visible",
  "isHidden",
  "hidden",
  "show",
  "shouldShow",
  "configuration",
  "config",
  "settings",
  "options",
  "environment",
  "env",
  "build",
  "buildType",
  "current",
  "shared",
  "instance",
  "result",
  "results",
  "data",
  "flow",
  "existingFlow",
  "observer",
  "value",
  "state",
  "status",
  "mode",
  "type",
  "flag",
  "flags",
  "event",
  "wideEvent",
  "response",
  "res",
  "item",
  "model",
  "key",
  "cacheKey",
  "name",
  "displayName",
  "title",
  "text",
  "client",
  "manager",
  "service",
  "provider",
  "store",
  "context",
  "ctx",
  "session",
  "user",
  "account",
  "isAvailable",
  "available"
]);
var declCountIndex = /* @__PURE__ */ new WeakMap();
function declCounts(ctx) {
  let idx = declCountIndex.get(ctx);
  if (idx) return idx;
  idx = /* @__PURE__ */ new Map();
  const rx = /\b(?:var|let|const|func|function|get|case)\s+([A-Za-z_$][\w$]*)|\b(?:public|private|protected|readonly|static)\s+(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*[:=?]/g;
  for (const f of ctx.files.filter(isCodeFile2)) {
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
function trace(ctx, file2, index, maxDepth = 2, opts = {}) {
  const throughCalls = opts.throughCalls ?? true;
  const res = { sites: [], uses: [], names: [] };
  const seenSites = /* @__PURE__ */ new Set();
  const seenNames = /* @__PURE__ */ new Set();
  const visit = (f, i, depth, via) => {
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
      const decl = declCounts(ctx).get(name);
      const wide = depth === 0 && isDistinctive(name) && !GENERIC_NAMES.has(name) && a.derivedBy !== "assign" && (decl?.count ?? 0) <= 1;
      const files = wide ? ctx.files.filter(isCodeFile2) : [f];
      const block = !wide && a.derivedBy === "decl" ? enclosingBlock(f, a.stmtStart) : void 0;
      const lo = block ? block.open : 0;
      const hi = block ? block.close : Number.MAX_SAFE_INTEGER;
      const rx = wide ? new RegExp(`(?<![\\w$])${escapeRx3(name)}(?![\\w$])`) : new RegExp(`(?<![\\w$.])${escapeRx3(name)}(?![\\w$])|(?<=\\b(?:self|this)\\.)${escapeRx3(name)}(?![\\w$])`);
      let count = 0;
      for (const g of files) {
        for (const index2 of refsIn(g, rx, g === f && block ? { from: lo, to: hi } : void 0)) {
          if (g === f && index2 >= a.stmtStart && index2 <= a.stmtEnd) continue;
          if (/\b(?:var|let|const|func|function|get|static)\s+$/.test(g.code.slice(Math.max(0, index2 - 40), index2))) continue;
          if (++count > 60) return;
          visit(g, index2, depth + 1, name);
        }
      }
    }
  };
  visit(file2, index, 0);
  return res;
}
var refCache = /* @__PURE__ */ new WeakMap();
function refsIn(file2, rx, range) {
  let byKey = refCache.get(file2);
  if (!byKey) refCache.set(file2, byKey = /* @__PURE__ */ new Map());
  const key = `${rx.source}\0${range ? `${range.from}:${range.to}` : ""}`;
  let out = byKey.get(key);
  if (!out) {
    out = (range ? searchRange(file2, rx, range.from, range.to) : searchFile(file2, rx)).map((h) => h.index);
    byKey.set(key, out);
  }
  return out;
}
function searchRange(file2, rx, from, to) {
  const g = new RegExp(rx.source, rx.flags.includes("g") ? rx.flags : `${rx.flags}g`);
  g.lastIndex = from;
  const out = [];
  for (let m = g.exec(file2.code); m && m.index < to; m = g.exec(file2.code)) {
    out.push({ index: m.index });
    if (m[0].length === 0) g.lastIndex++;
  }
  return out;
}
var BUILD_TIME = /\bbundleIdentifier\b|\bBundle\.main\.(?:object\s*\(\s*forInfoDictionaryKey|infoDictionary)|\binfoDictionary\b|^[ \t]*#if\b|\bprocess\.env\b|\bEXPO_PUBLIC_\w+|__DEV__|\bConstants\.(?:expoConfig|manifest2?|easConfig)\b|\bConfig\.[A-Z_]{2,}\b|\bBuildConfig\.\w+|\bgetBundleId\b|\bDeviceInfo\.getBundleId\b|\bProcessInfo\.processInfo\.environment\b/m;
var RUNTIME_ENV = /appStoreReceiptURL|sandboxReceipt|\bAppTransaction\b|\.environment\s*[!=]=|embedded\.mobileprovision|getIosApplicationReleaseTypeAsync|ApplicationReleaseType|\bTransaction\b|isTestFlight\w*\s*\(|reviewer|appReview|in_review|IN_REVIEW|\bfetch\(|URLSession|axios|remoteConfig|RemoteConfig|featureFlag|useFeatureFlag/;
var BUILD_CONFIG_FILE = /(^|\/)(app|babel|metro|react-native|webpack|eas)\.config\.[cm]?[jt]s$/;
var definitionCache = /* @__PURE__ */ new WeakMap();
function definitionsOf(ctx, name) {
  let cache = definitionCache.get(ctx);
  if (!cache) definitionCache.set(ctx, cache = /* @__PURE__ */ new Map());
  const hit = cache.get(name);
  if (hit) return hit;
  const out = findDefinitions(ctx, name);
  cache.set(name, out);
  return out;
}
var MOCK_PATH = /(?:^|\/)(?:Mocks?|Fakes?|Stubs?|Preview Content)\/|(?:^|\/)(?:Mock|Fake|Stub)[A-Z]\w*\.\w+$|[a-z0-9](?:Mock|Fake|Stub)s?\.\w+$/;
function insideProtocol(f, index) {
  const block = enclosingBlock(f, index);
  if (!block) return false;
  const { start } = statementStart(maskOf(f), block.open);
  return /(?:^|\s)protocol\s+[A-Za-z_]/.test(f.code.slice(start, block.open));
}
function findDefinitions(ctx, name) {
  const n = escapeRx3(name);
  const rx = new RegExp(`\\b(?:var|let|const|func|function|get)\\s+${n}(?![\\w$])`);
  const typedOnly = /^\s*:\s*[^={}\n;]+?\s*(?:\n|;|$)/;
  const out = [];
  for (const f of ctx.files.filter((x) => isCodeFile2(x) && !MOCK_PATH.test(x.path))) {
    const m = maskOf(f);
    for (const h of searchFile(f, rx)) {
      const after = h.index + h.match.length;
      if (insideProtocol(f, h.index)) continue;
      if (typedOnly.test(f.code.slice(after, after + 200))) {
        for (const a of searchFile(f, new RegExp(`(?<![\\w$.])(?:(?:self|this)\\.)?${n}\\s*=(?!=)`))) {
          const at = a.index + a.match.indexOf(name);
          out.push({ file: f, index: at, text: f.code.slice(at, Math.min(statementEnd(m, at), at + 800)) });
        }
        continue;
      }
      const open4 = firstBlockOpen(m, after, 300);
      const end = open4 >= 0 ? matchClose(m, open4) + 1 : statementEnd(m, after);
      out.push({ file: f, index: h.index, text: f.code.slice(h.index, Math.min(end, h.index + 800)) });
      if (out.length >= 6) return out;
    }
  }
  return out;
}
function underCompileFlag(f, index) {
  return enclosingConditions(f.code, index, f.ext).conditions.some((c) => c.kind === "#if");
}
var buildConfigCache = /* @__PURE__ */ new WeakMap();
function buildConfigOrigin(ctx, name) {
  let cache = buildConfigCache.get(ctx);
  if (!cache) buildConfigCache.set(ctx, cache = /* @__PURE__ */ new Map());
  if (cache.has(name)) return cache.get(name) ?? void 0;
  const defs = definitionsOf(ctx, name);
  let origin;
  if (defs.length) {
    const verdicts = defs.map((d) => {
      const body = d.text.split(name).join(" ");
      if (d.text.slice(name.length).includes(`.${name}`)) return "alias";
      const rhs = /^[\w$]+\s*=(?!=)\s*([\s\S]*)$/.exec(d.text)?.[1]?.trim().replace(/;$/, "");
      if (rhs === name) return "alias";
      if (RUNTIME_ENV.test(body)) return "runtime";
      if (BUILD_TIME.test(body) || underCompileFlag(d.file, d.index)) return "build";
      const refs = [...new Set([...d.text.slice(name.length + 8).matchAll(/(?<![\w$.])([A-Za-z_$][\w$]{1,})\b/g)].map((x) => x[1]))].filter((r) => r !== name && !/^(let|var|const|func|function|return|true|false|nil|null|undefined|Bool|String|static|get|some|self|this)$/.test(r)).slice(0, 8);
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
      const d = defs[verdicts.indexOf("build")];
      origin = { file: d.file.path, line: lineAtFile(d.file, d.index), evidence: d.text.split("\n")[0].trim() };
    }
  }
  cache.set(name, origin ?? null);
  return origin;
}
var SYMBOL_DETECTORS = /* @__PURE__ */ new Set(["App Review identity check", "review-mode flag", "TestFlight / sandbox detection", "demo-account check"]);
var declIndex = /* @__PURE__ */ new WeakMap();
var KEYWORDS = /* @__PURE__ */ new Set(["return", "const", "let", "var", "func", "function", "true", "false", "nil", "null", "undefined", "self", "this", "await", "async", "try", "new", "some", "View", "String", "Bool", "Int", "Text", "Array", "Object", "Promise"]);
function indexDecls(ctx) {
  let idx = declIndex.get(ctx);
  if (idx) return idx;
  idx = /* @__PURE__ */ new Map();
  for (const f of ctx.files.filter(isCodeFile2)) {
    const m = maskOf(f);
    for (const h of searchFile(f, /\b(function\s+|func\s+|(?:const|let|var)\s+)([A-Za-z_$][\w$]*)/)) {
      const name = h.groups[1] ?? "";
      if (!name || KEYWORDS.has(name)) continue;
      const isFn = /^func|^function/.test(h.groups[0] ?? "") || /^\s*[:=]\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/.test(f.code.slice(h.index + h.match.length, h.index + h.match.length + 200));
      let text;
      if (isFn) {
        const open4 = m.indexOf("{", h.index + h.match.length);
        if (open4 < 0 || open4 - h.index > 400) continue;
        const body = f.code.slice(open4 + 1, matchClose(m, open4));
        text = [...body.matchAll(/\breturn\b([^;\n]*)/g)].map((x) => x[1] ?? "").join("\n");
        if (!text.trim()) continue;
      } else {
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
function expandScope(ctx, file2, text, depth = 2, budget = { left: 8e3 }) {
  if (depth <= 0 || budget.left <= 0) return text;
  const idx = indexDecls(ctx);
  const parts = [text];
  const seen = /* @__PURE__ */ new Set();
  for (const mm of text.matchAll(/(?<![\w$])(?:(?<=\.\.\.)|(?<!\.))([A-Za-z_$][\w$]{2,})\b(\s*\()?/g)) {
    const name = mm[1];
    if (seen.has(name) || KEYWORDS.has(name)) continue;
    seen.add(name);
    const decls = idx.get(name) ?? [];
    const called = Boolean(mm[2]);
    const local = decls.filter((d) => d.file === file2 && d.kind === "value" && !text.startsWith(d.text));
    const fns = called ? decls.filter((d) => d.kind === "function") : [];
    for (const d of [...local, ...fns.length === 1 ? fns : fns.filter((d2) => d2.file === file2)]) {
      if (budget.left <= 0) break;
      const add = d.text.slice(0, Math.min(1500, budget.left));
      budget.left -= add.length;
      parts.push(expandScope(ctx, d.file, add, depth - 1, budget));
    }
  }
  return parts.join("\n");
}
function debugOnlyAt(file2, index) {
  return isDebugOnly(enclosingConditions(file2.code, index, file2.ext));
}
function windowAround(file2, index, lines = 12) {
  const code = file2.code;
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
var PRECEDENCE = [
  ["reviewer", "review-state"],
  ["storefront", "region"],
  ["timezone-pacific", "timezone"],
  ["date", "install-age"]
];
var MAX_HITS_PER_FILE = 8e3;
var MAX_HITS_PER_DETECTOR = 1e3;
function collect(ctx) {
  const standalone = [];
  const sited = /* @__PURE__ */ new Map();
  const buildConfig = /* @__PURE__ */ new Map();
  const addSite = (file2, site, det, via, symbol) => {
    const key = `${file2.path}:${site.start}`;
    const cur = sited.get(key) ?? { file: file2, kinds: /* @__PURE__ */ new Set(), labels: [], site, index: site.start, line: site.line, evidence: site.header, via, symbol };
    cur.kinds.add(det.kind);
    if (!cur.labels.includes(det.label)) cur.labels.push(det.label);
    sited.set(key, cur);
  };
  for (const file2 of ctx.files.filter((f) => isCodeFile2(f) && !BUILD_CONFIG_FILE.test(f.path) && !NON_SHIPPING_PATH.test(f.path))) {
    let analyzed = 0;
    for (const det of GATE_DETECTORS) {
      if (analyzed >= MAX_HITS_PER_FILE) break;
      let own = 0;
      for (const h of searchFile(file2, det.rx)) {
        if (++own > MAX_HITS_PER_DETECTOR || ++analyzed > MAX_HITS_PER_FILE) break;
        if (debugOnlyAt(file2, h.index)) continue;
        const a = analyzeAt(file2, h.index);
        if (a.declares) continue;
        const stmt = a.site ? `${a.site.header} ${a.statement}` : a.statement;
        const near = file2.code.slice(Math.max(0, h.index - 400), h.index);
        const before = near.slice(near.lastIndexOf("\n") + 1);
        if (det.validate && !det.validate(stmt, windowAround(file2, h.index), before, file2.code)) continue;
        const symbolic = SYMBOL_DETECTORS.has(det.label) && /^[A-Za-z_$][\w$]*$/.test(h.match);
        const alone = { file: file2, kinds: /* @__PURE__ */ new Set([det.kind]), labels: [det.label], index: h.index, line: h.line, evidence: h.text, symbol: symbolic ? h.match : void 0 };
        if (det.standalone) {
          standalone.push(alone);
          continue;
        }
        if (symbolic) {
          const origin = buildConfigOrigin(ctx, h.match);
          if (origin) {
            const cur = buildConfig.get(h.match) ?? { name: h.match, kind: det.kind, origin, uses: [] };
            if (cur.uses.length < 20) cur.uses.push({ file: file2.path, line: h.line });
            buildConfig.set(h.match, cur);
            continue;
          }
        }
        const t = trace(ctx, file2, h.index, 2, { throughCalls: false });
        const live = t.sites.filter((s) => !debugOnlyAt(s.file, s.site.start) && !BUILD_CONFIG_FILE.test(s.file.path));
        for (const s of live) addSite(s.file, s.site, det, s.via, s.via ?? alone.symbol);
        if (det.kind === "reviewer" && live.length === 0) standalone.push(alone);
      }
    }
  }
  for (const hit of sited.values()) for (const [hi, lo] of PRECEDENCE) if (hit.kinds.has(hi)) hit.kinds.delete(lo);
  return { standalone, sited, buildConfig };
}
var ADULT_REMOVE = "Remove the switch and the adult or nudification content it gates. Content App Review rejects under 1.1 must not ship behind any gate, so disclosing the switch does not fix it.";
var RECEIPT_LABELS = /* @__PURE__ */ new Set(["sandbox receipt check", "StoreKit environment check", "StoreKit environment switch", "install-source detection", "provisioning-profile detection"]);
function restrictsOnly(gate, scope) {
  const negated = /!\s*[\w$.?]*(?:Disabled|Blocked|Restricted|Prohibited|Banned)\b|(?:Disabled|Blocked|Restricted|Prohibited|Banned)\s*[!=]==?\s*(?:false|nil|null)|!==?\s*true/.test(gate);
  if (!negated && /\b\w*(?:Disabled|Blocked|Restricted|Prohibited|Banned)\b|\b(?:age ?assurance|ageAssurance|age ?verification|ageVerification)\b/.test(gate)) return true;
  const offs = [...scope.matchAll(/\b(\w*?)(?:Enabled|Allowed|Visible|Available)\s*[:=]\s*false\b|\b(\w*?)(?:Disabled|Blocked|Hidden|Restricted)\s*[:=]\s*true\b/g)];
  const weakensSafety = offs.some((m) => /moderat|filter|safe|report|block|age/i.test(m[1] ?? m[2] ?? ""));
  const adds = /\b(?:labelers?|moderation\w*|moderators?)\b/i.test(scope) && /\b(?:push|add|append|concat|insert|\.\.\.)/.test(scope);
  return !weakensSafety && (offs.length > 0 || adds);
}
var receiptFiles = /* @__PURE__ */ new WeakMap();
function isReceiptFile(f) {
  let r = receiptFiles.get(f);
  if (r === void 0) receiptFiles.set(f, r = RECEIPT_CONTEXT.test(f.code));
  return r;
}
var REMOVE_REVIEWER_CHECK = "Remove the check entirely so nothing branches on whether the user is App Review (Apple's network, Cupertino, Pacific time, reviewer accounts or review status). Disclosure in Notes for Review does not cure this (2.5.19, DPLA 3.2(e)).";
function verdictFor(kind, sinks, gate, where, scope, ctxText = "", runtimeEnv = true, ungatedPurchase = false) {
  const v = baseVerdict(kind, sinks, gate, where, scope, ctxText, runtimeEnv, ungatedPurchase);
  if (v && sinks.kinds.includes("adult") && (v.severity === "block" || v.severity === "high")) return { ...v, fix: ADULT_REMOVE, suppressible: false };
  return v;
}
function baseVerdict(kind, sinks, gate, where, scope, ctxText, runtimeEnv, ungatedPurchase) {
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
        suppressible: false
      };
    case "geofence":
      return {
        rule: "review_gating.geofence",
        severity: "block",
        guideline: "2.5.19",
        why: `${where} tests whether the user is at Apple's Cupertino campus. Location checks aimed at Apple change what App Review sees (2.5.19, DPLA 3.2(e)). ${does}`.trim(),
        fix: REMOVE_REVIEWER_CHECK,
        confidence: "high",
        suppressible: false
      };
    case "reviewer":
      return {
        rule: "review_gating.reviewer_branch",
        severity: "block",
        guideline: "2.5.19",
        why: `${where} branches on whether the user is App Review (${gate}). Showing reviewers a different app is concealment under 2.5.19 and DPLA 3.2(e). ${does}`.trim(),
        fix: REMOVE_REVIEWER_CHECK,
        confidence: "high",
        suppressible: false
      };
    case "review-state": {
      const web = sinks.kinds.includes("websurface");
      if (!sensitive && !web) return void 0;
      const swapped = describeSinks(sinks, [...SENSITIVE_SINKS, "websurface"]);
      return {
        rule: "review_gating.review_state",
        severity: "high",
        guideline: "2.5.19",
        why: `${where} branches on a review-mode flag (${gate}) around ${sensitive ? "sensitive behavior" : "an embedded web surface, whose content the server can change after approval"}. The gated code touches ${swapped}. If this flag tracks App Store review status, reviewers see a different app (2.5.19, DPLA 3.2(e)).`,
        fix: "Remove the branch on review status so App Review gets exactly what users get; disclosure does not cure branching on review status (2.5.19). If the flag means something unrelated to App Review, confirm that and record why in the baseline.",
        confidence: "medium",
        suppressible: true
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
          suppressible: false
        };
      return {
        rule: "review_gating.demo_account",
        severity: "medium",
        guideline: "2.1(a)",
        why: `${where} branches on a demo/test account (${gate}). A built-in demo mode needs Apple's prior approval (2.1(a)); verify the reviewer's account sees the same app users do.`,
        fix: "Remove the demo-account branch, or disclose exactly what differs for the demo account in Notes for Review.",
        confidence: "medium",
        suppressible: true
      };
    case "environment": {
      const base = runtimeEnv ? `${where} checks the install environment (${gate}). App Review installs carry a sandbox receipt, like TestFlight, so this branch runs during review.` : `${where} branches on an install-environment flag (${gate}). If the flag is detected at runtime from the receipt or install source, App Review installs (which carry a sandbox receipt, like TestFlight) take this branch.`;
      if (sensitive)
        return {
          rule: "review_gating.environment",
          severity: "block",
          guideline: "2.5.19",
          why: `${base} ${does} Reviewers therefore see different content, generation or pricing than App Store users (2.5.19, DPLA 3.2(e)).`,
          // Disclosure can justify a tester price difference, never showing reviewers other content.
          fix: content ? "Remove the environment check so App Review and App Store users get the same app; disclosure in Notes for Review does not cure showing reviewers different content (2.5.19, DPLA 3.2(e))." : "Remove the environment check from this code path so review and production builds behave the same. If a difference is intentional, disclose it specifically in Notes for Review (2.3.1(a)).",
          confidence: content ? "high" : "medium",
          // Showing reviewers different content has no legitimate justification; price-only
          // differences (e.g. TestFlight testers unlocked) can be justified in the baseline.
          suppressible: !content
        };
      if (sinks.kinds.includes("debug"))
        return {
          rule: "review_gating.environment_debug",
          severity: "medium",
          guideline: "2.5.19",
          why: `${base} The gated code looks like debug UI ("${sinks.words.debug}"), which the reviewer will also see.`,
          fix: "Verify nothing user-facing differs during review. Remove the debug UI from release builds (#if DEBUG / __DEV__) or disclose it in Notes for Review.",
          confidence: "medium",
          suppressible: true
        };
      if (sinks.kinds.includes("websurface"))
        return {
          rule: "review_gating.environment",
          severity: "medium",
          guideline: "2.5.19",
          why: `${base} The gated code shows an embedded web surface ("${sinks.words.websurface}"), whose content the server can change after approval, so reviewers and App Store users may see different screens.`,
          fix: "Remove the environment check so review and App Store installs show the same screens, or disclose specifically in Notes for Review what the web surface shows and to whom (2.3.1(a)).",
          confidence: "medium",
          suppressible: true
        };
      if (sinks.kinds.includes("backend"))
        return {
          rule: "review_gating.environment_backend",
          severity: "medium",
          guideline: "2.1(a)",
          why: `${base} It selects a backend ("${sinks.words.backend}"), so the reviewer may hit a non-production server (2.1(a) requires a live backend).`,
          fix: "Remove the environment-based backend switch so review builds use the production backend, or disclose the difference in Notes for Review.",
          confidence: "medium",
          suppressible: true
        };
      const benign = sinks.kinds.some((k) => k === "receipt" || k === "logging");
      if (benign || !sinks.hasCode) return void 0;
      return {
        rule: "review_gating.environment",
        severity: "info",
        guideline: "2.5.19",
        why: `${base} The gated code shows no content, pricing or debug behavior, but it does run during review.`,
        fix: "Confirm the review build behaves like production; disclose any user-visible difference in Notes for Review.",
        confidence: "low",
        suppressible: true
      };
    }
    case "date":
      if (!sensitive) return void 0;
      return {
        rule: "review_gating.date",
        severity: "block",
        guideline: "2.5.19",
        why: `${where} switches behavior at a fixed date (${gate}). ${does} A time switch lets the app change after review without a new submission (2.5.19 dormant features, DPLA 3.2(e) post-review modifications).`,
        fix: "Remove the time switch, or ship the behavior active from the reviewed build and describe it specifically in Notes for Review (2.3.1(a)).",
        confidence: "medium",
        suppressible: !content
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
          suppressible: false
        };
      if (!sensitive || sinks.kinds.filter((k) => SENSITIVE_SINKS.includes(k)).join() === "price" && PROMO_WORD.test(sinks.words.price ?? "")) return void 0;
      if (ungatedPurchase)
        return {
          rule: "review_gating.install_age",
          severity: "info",
          guideline: "2.1(b)",
          why: `${where} changes paywall or pricing presentation after install age or launch count (${gate}). ${does} The project also has a purchase path outside this gate, so a fresh review install can still buy.`,
          fix: "Verify App Review can reach a purchase path in a fresh install, and describe the timing in Notes for Review.",
          confidence: "low",
          suppressible: true
        };
      if (sensitive)
        return {
          rule: "review_gating.install_age",
          severity: "medium",
          guideline: "3.1.2",
          why: `${where} changes paywall or pricing behavior after install age or launch count (${gate}). ${does} The reviewer's fresh install may never see it (2.1(b): purchases must be visible to review).`,
          fix: "Verify App Review can reach this paywall, and describe the timing in Notes for Review.",
          confidence: "medium",
          suppressible: true
        };
      return void 0;
    case "timezone-pacific":
      if (sensitive)
        return {
          rule: "review_gating.timezone",
          severity: "block",
          guideline: "2.5.19",
          why: `${where} checks for the US Pacific timezone (${gate}), where App Review works, around sensitive behavior. ${does}`,
          fix: REMOVE_REVIEWER_CHECK,
          confidence: "medium",
          suppressible: false
        };
      return {
        rule: "review_gating.timezone",
        severity: "medium",
        guideline: "2.5.19",
        why: `${where} checks for the US Pacific timezone (${gate}), where App Review works. Verify nothing differs for reviewers.`,
        fix: "Remove the timezone branch, or disclose what differs and why in Notes for Review.",
        confidence: "low",
        suppressible: true
      };
    case "storefront":
    case "region":
    case "timezone": {
      const label = kind === "storefront" ? "App Store storefront" : kind === "timezone" ? "timezone" : "region";
      const legal = LEGAL_MARKERS.test(wordsOf(gate)) || LEGAL_MARKERS.test(wordsOf(scope)) || LEGAL_MARKERS.test(wordsOf(ctxText));
      const restricts = kind !== "timezone" && restrictsOnly(gate, scope);
      if ((legal || restricts) && (sinks.hasCode || sensitive))
        return {
          rule: "review_gating.region_legal",
          severity: "info",
          guideline: "2.3.1(a)",
          why: `${where} changes behavior by ${label} (${gate}) for what looks like a legal or payment-rule reason. App Review's guidance asks you to describe regional differences.`,
          fix: "Disclose the regional difference in Notes for Review: which storefronts or regions, what changes, and why.",
          confidence: "medium",
          suppressible: true
        };
      if (content)
        return {
          rule: "review_gating.region",
          severity: "high",
          guideline: "2.5.19",
          why: `${where} changes sensitive behavior by ${label} (${gate}). ${does} Reviewers may be in a region that never sees it, which makes it an undisclosed feature (2.5.19).`,
          fix: "Remove the regional switch, or disclose specifically in Notes for Review which regions get this behavior and why.",
          confidence: "medium",
          suppressible: true
        };
      if (sensitive)
        return {
          rule: "review_gating.region_legal",
          severity: "info",
          guideline: "2.3.1(a)",
          why: `${where} changes pricing or paywall behavior by ${label} (${gate}). ${does}`,
          fix: "Disclose the regional pricing or payment difference in Notes for Review.",
          confidence: "medium",
          suppressible: true
        };
      return void 0;
    }
  }
}
var PURCHASE_ANY = [new RegExp(PURCHASE_CALL.source, "g"), new RegExp(MANAGED_PAYWALL.source, "g")];
var purchaseTotals = /* @__PURE__ */ new WeakMap();
function purchaseCount(t) {
  return PURCHASE_ANY.reduce((n, rx) => n + [...t.matchAll(rx)].length, 0);
}
function purchaseOutside(ctx, gated) {
  let total = purchaseTotals.get(ctx);
  if (total === void 0) {
    total = 0;
    for (const f of ctx.files) if (isCodeFile2(f)) total += purchaseCount(f.code);
    purchaseTotals.set(ctx, total);
  }
  return total > purchaseCount(gated);
}
var check3 = {
  id: "review_gating",
  title: "Behavior that differs during App Review",
  guidelines: ["2.5.19", "DPLA 3.2(e)", "2.1(a)"],
  async run(ctx) {
    const findings = [];
    const { standalone, sited, buildConfig } = collect(ctx);
    const gates = [];
    const bySymbol = /* @__PURE__ */ new Map();
    const grouped = (v, symbol, f, at) => {
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
      const kind = [...hit.kinds][0];
      const where = SERVER_PATH2.test(hit.file.path) ? "Server code" : "App code";
      const near = windowAround(hit.file, hit.index, 8);
      const v = verdictFor(kind, classifySinks(near), hit.labels.join(", "), where, near, hit.file.path);
      if (!v) continue;
      gates.push({ kind, file: hit.file.path, line: hit.line, label: hit.labels.join(", ") });
      const f = finding({ ...v, file: hit.file.path, line: hit.line, evidence: hit.evidence });
      if (grouped(v, hit.symbol, f, `${hit.file.path}:${hit.line}`)) continue;
      findings.push(f);
    }
    for (const hit of sited.values()) {
      const site = hit.site;
      const sinks = classifySinks(expandScope(ctx, hit.file, site.body));
      const where = SERVER_PATH2.test(hit.file.path) ? "Server code" : "App code";
      const gate = hit.via ? `${site.header} \u2014 via ${hit.via}` : site.header;
      const receiptHandling = isReceiptFile(hit.file);
      const viaFiles = hit.via ? declCounts(ctx).get(hit.via)?.files ?? [] : [];
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
      f.why += ` The same value also gates ${more.length} other site(s): ${more.slice(0, 6).join(", ")}${more.length > 6 ? ", \u2026" : ""}.`;
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
          confidence: "medium"
        })
      );
      gates.push({ kind: b.kind, file: b.origin.file, line: b.origin.line, label: `build configuration: ${b.name}`, severity: "info" });
    }
    return { findings: dedupeFindings(findings), data: { gates } };
  }
};

// src/scanners/remoteConfig.ts
var RANK = {
  "content-gating": 0,
  "price-gating": 1,
  "safety-killswitch": 2,
  product: 3,
  unknown: 4
};
function resolveProvider(p, file2) {
  if (typeof p === "string") return p;
  for (const name of p) if (PROVIDER_IMPORTS[name]?.test(file2.code)) return name;
  return void 0;
}
function cleanDefault(v) {
  if (!v) return void 0;
  const t = v.trim().replace(/\s+as\s+NSObject$/, "").replace(/^["'`]|["'`]$/g, "");
  return t ? clip(t, 80) : void 0;
}
var PARAM_READ = (param) => new RegExp(
  `(?:getValue|getBoolean|getString|getNumber|configValue\\(\\s*forKey:|Variation\\(\\s*(?:forKey:\\s*)?|\\.variation|isFeatureEnabled|getFeatureFlag|checkGate|useGate|isOn|getFeatureValue|isEnabled|getValueAsync)\\(?\\s*${param}\\b|\\[\\s*${param}\\s*\\]\\s*\\.(?:bool|string|number|json|data)Value`
);
var FUNC_WITH_PARAM = [
  /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)/g,
  /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(\s*([A-Za-z_$][\w$]*)/g,
  /\bfunc\s+([A-Za-z_]\w*)\s*\(\s*(?:_\s+)?([A-Za-z_]\w*)\s*:/g
];
function findWrappers(ctx) {
  const out = /* @__PURE__ */ new Map();
  for (const file2 of ctx.files.filter(isCodeFile2)) {
    const provider = Object.entries(PROVIDER_IMPORTS).find(([, rx]) => rx.test(file2.code))?.[0];
    if (!provider) continue;
    for (const rx of FUNC_WITH_PARAM) {
      for (const m of file2.code.matchAll(rx)) {
        const [, name, param] = m;
        if (!name || !param) continue;
        const body = file2.code.slice(m.index ?? 0, (m.index ?? 0) + 1200);
        if (PARAM_READ(param.replace(/\$/g, "\\$")).test(body)) out.set(name, provider);
      }
    }
  }
  return out;
}
function collectReads(ctx) {
  const reads = [];
  const seen = /* @__PURE__ */ new Set();
  const push = (r) => {
    const k = `${r.file.path}:${r.index}`;
    if (seen.has(k)) return;
    seen.add(k);
    reads.push(r);
  };
  const wrappers = findWrappers(ctx);
  const shipping = ctx.files.filter((f) => isCodeFile2(f) && !NON_SHIPPING_PATH.test(f.path));
  for (const file2 of shipping) {
    for (const [name, provider] of wrappers) {
      for (const h of searchFile(file2, new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}\\(\\s*${QUOTED_KEY}`))) {
        push({ provider, key: h.groups[0] ?? "", file: file2, index: h.index, line: h.line, text: h.text, depth: 2 });
      }
    }
  }
  for (const file2 of shipping) {
    for (const pat of FLAG_READS) {
      if (pat.requires && !pat.requires.test(file2.code)) continue;
      const hits = searchFile(file2, pat.rx);
      if (!hits.length) continue;
      const provider = resolveProvider(pat.provider, file2) ?? "Feature flag (provider not identified)";
      for (const h of hits) {
        const key = pat.keyGroup > 0 ? h.groups[pat.keyGroup - 1] ?? "" : "paywall";
        if (!key) continue;
        push({
          provider,
          key,
          file: file2,
          index: h.index,
          line: h.line,
          text: h.text,
          defaultValue: pat.defaultGroup ? cleanDefault(h.groups[pat.defaultGroup - 1]) : void 0,
          paywall: pat.paywall,
          depth: 2
        });
      }
    }
    for (const h of searchFile(file2, CUSTOM_CONFIG_URL)) {
      const url = h.groups[0] ?? "";
      if (!isConfigUrl(url)) continue;
      const host = /^https?:\/\/([^/]+)/.exec(url)?.[1] ?? "custom";
      push({ provider: `Custom JSON (${host})`, key: url, file: file2, index: h.index, line: h.line, text: h.text, depth: 4 });
    }
    for (const h of searchFile(file2, CONFIG_TABLE))
      push({ provider: "Custom config (Supabase table)", key: h.groups[0] ?? "config", file: file2, index: h.index, line: h.line, text: h.text, depth: 4 });
    for (const h of searchFile(file2, CONFIG_COLLECTION))
      push({ provider: "Custom config (Firestore collection)", key: h.groups[0] ?? "config", file: file2, index: h.index, line: h.line, text: h.text, depth: 4 });
  }
  return reads;
}
function isConfigUrl(url) {
  const pathPart = url.replace(/^https?:\/\/[^/]+/, "");
  if (STATIC_ASSET_PATH.test(pathPart)) return false;
  if (CONFIG_PATH.test(pathPart)) return true;
  if (!ALWAYS_CONFIG_HOSTS.test(url)) return false;
  const last = pathPart.replace(/[?#].*$/, "").split("/").pop() ?? "";
  if (/\/raw\/?$/.test(pathPart.replace(/[?#].*$/, ""))) return true;
  return last !== "" && !/\\\(|\$\{|\{\{/.test(last);
}
function firebaseDefaults(ctx) {
  const out = /* @__PURE__ */ new Map();
  const plists = /* @__PURE__ */ new Set();
  for (const file2 of ctx.files.filter(isCodeFile2)) {
    for (const h of searchFile(file2, /setDefaults\(\s*fromPlist:\s*"([^"]+)"/)) plists.add(h.groups[0] ?? "");
    const literals = [];
    for (const h of searchFile(file2, /(?:setDefaults\(\s*|defaultConfig\s*=\s*)([[{])/)) {
      const open4 = h.index + h.match.length - 1;
      const close = file2.code.indexOf(h.groups[0] === "[" ? "]" : "}", open4);
      if (close >= 0) literals.push(file2.code.slice(open4 + 1, close));
    }
    for (const h of searchFile(file2, /(?:setDefaults\(\s*|defaultConfig\s*=\s*)([A-Za-z_$][\w$]*)\s*\)?/)) {
      const decl = new RegExp(`(?:const|let|var)\\s+${(h.groups[0] ?? "").replace(/\$/g, "\\$")}\\b[^=]*=\\s*([[{])`).exec(file2.code);
      if (!decl) continue;
      const open4 = decl.index + decl[0].length - 1;
      const close = file2.code.indexOf(decl[1] === "[" ? "]" : "}", open4);
      if (close >= 0) literals.push(file2.code.slice(open4 + 1, close));
    }
    for (const body of literals) {
      for (const m of body.matchAll(/["'`]?([A-Za-z_][\w.-]*)["'`]?\s*:\s*([^,\n]+)/g)) {
        const v = cleanDefault(m[2]);
        if (m[1] && v !== void 0) out.set(m[1], v);
      }
    }
  }
  for (const name of plists) {
    const f = ctx.files.find((x) => x.ext === "plist" && x.path.split("/").pop() === `${name.replace(/\.plist$/, "")}.plist`);
    if (!f) continue;
    for (const m of f.text.matchAll(/<key>([^<]+)<\/key>\s*(?:<(true|false)\s*\/>|<(?:string|integer|real)>([^<]*)<\/(?:string|integer|real)>)/g)) {
      if (m[1]) out.set(m[1], m[2] ?? m[3] ?? "");
    }
  }
  return out;
}
var CONTENT = ["adult", "persona", "generator"];
function classify(ctx, read, t) {
  const scopeText = t.sites.map((s) => expandScope(ctx, s.file, s.site.body)).join("\n");
  const headerText = t.sites.map((s) => s.site.header).join("\n");
  const useText = t.uses.map((u) => u.text.split(read.key).join(" ")).join("\n");
  const scope = classifySinks(scopeText);
  const use = classifySinks(useText);
  const kill = KILL_WORDS.test(wordsOf(`${read.key} ${headerText}`));
  const firstSite = t.sites[0];
  const at = firstSite ? { file: firstSite.file.path, line: firstSite.site.line, evidence: firstSite.site.header } : t.uses[0] ? { file: t.uses[0].file.path, line: t.uses[0].line, evidence: t.uses[0].text } : void 0;
  const where = at ? ` at ${at.file}:${at.line}` : "";
  for (const [profile, basis] of [
    [scope, "scope"],
    [use, "use"]
  ]) {
    const has = (k) => profile.kinds.includes(k);
    const verb = basis === "scope" ? "gates" : "value flows into";
    if (has("safety"))
      return { classification: "content-gating", gates: `${verb} safety/moderation controls (${describeSinks(profile, ["safety"])})${where}`, basis, confidence: "high", at };
    if (has("adult") || has("persona"))
      return { classification: "content-gating", gates: `${verb} ${describeSinks(profile, ["adult", "persona"])}${where}`, basis, confidence: "high", at, adult: has("adult") };
    if (has("generator")) {
      if (kill)
        return { classification: "safety-killswitch", gates: `switches off ${describeSinks(profile, ["generator"])}${where}`, basis, confidence: "medium", at };
      return { classification: "content-gating", gates: `${verb} ${describeSinks(profile, CONTENT)}${where}`, basis, confidence: "medium", at };
    }
    if (has("price") || has("unlock"))
      return { classification: read.paywall ? "product" : "price-gating", gates: `${verb} ${describeSinks(profile, ["price", "unlock"])}${where}`, basis, confidence: "medium", at };
  }
  if (read.paywall) return { classification: "product", gates: "remote paywall presentation (layout and offer selection are configured on the provider's dashboard)", basis: "none", confidence: "medium", at };
  if (kill) return { classification: "safety-killswitch", gates: `kill switch / maintenance control${where}`, basis: t.sites.length ? "scope" : "name", confidence: "medium", at };
  if (scope.hasCode || use.hasCode) {
    const p = scope.hasCode ? scope : use;
    const extra = p.kinds.includes("debug") ? " (debug UI)" : "";
    return { classification: "product", gates: `${t.sites.length ? "gates" : "value used by"} product code${extra}${where}`, basis: t.sites.length ? "scope" : "use", confidence: "medium", at };
  }
  const kw = wordsOf(read.key);
  if (SINKS2.adult.test(kw) || SINKS2.persona.test(kw))
    return { classification: "content-gating", gates: "key name refers to adult or persona content; read site not traced to its use", basis: "name", confidence: "low" };
  if (/\b(price|pricing|paywall|trial|discount|promo|sku|iap|subscription)\b/.test(kw) && PRICE_KEY_WORDS.test(kw))
    return { classification: "price-gating", gates: "key name refers to pricing or the paywall; read site not traced to its use", basis: "name", confidence: "low" };
  return { classification: "unknown", gates: "read site not traced to its use", basis: "none", confidence: "low" };
}
var TRACE_BUDGET_PER_FILE = 1024 * 1024;
function untraced(c) {
  return { ...c, gates: c.gates.replace(/read site not traced to its use$/, "read site not traced: the file exceeds the per-file trace budget") };
}
function subKeys(t) {
  const out = /* @__PURE__ */ new Map();
  if (!t.names.length) return out;
  const names = t.names.map((n) => n.replace(/[$]/g, "\\$")).join("|");
  const rx = new RegExp(`\\b(?:${names})\\??\\.(?!then\\b|json\\b|text\\b|ok\\b|status\\b|data\\b)([A-Za-z_]\\w*)|\\b(?:${names})\\s*\\[\\s*["'\`]([^"'\`]+)["'\`]\\s*\\]`, "g");
  const add = (key, part) => {
    const cur = out.get(key) ?? { sites: [], uses: [], names: t.names };
    cur.sites.push(...part.sites ?? []);
    cur.uses.push(...part.uses ?? []);
    out.set(key, cur);
  };
  for (const s of t.sites) for (const m of s.site.header.matchAll(rx)) add(m[1] ?? m[2] ?? "", { sites: [s] });
  for (const u of t.uses) for (const m of u.text.matchAll(rx)) add(m[1] ?? m[2] ?? "", { uses: [u] });
  out.delete("");
  return out;
}
var check4 = {
  id: "remote_config",
  title: "Remote config and feature flags",
  guidelines: ["2.5.19", "2.3.1(a)", "DPLA 3.2(e)", "3.1.2"],
  async run(ctx) {
    const defaults = firebaseDefaults(ctx);
    const entries = /* @__PURE__ */ new Map();
    const findings = [];
    const flagged = /* @__PURE__ */ new Map();
    const record = (read, key, c) => {
      const id = `${read.provider}\0${key}`;
      const defaultValue = read.defaultValue ?? (read.provider === "Firebase Remote Config" ? defaults.get(key) : void 0);
      const cur = entries.get(id);
      const site = { file: read.file.path, line: read.line };
      if (!cur) {
        entries.set(id, {
          key,
          provider: read.provider,
          file: read.file.path,
          line: read.line,
          defaultValue,
          gates: c.gates,
          classification: c.classification,
          readSites: [site],
          basis: c.basis
        });
      } else {
        if (!cur.readSites.some((s) => s.file === site.file && s.line === site.line)) cur.readSites.push(site);
        cur.defaultValue ??= defaultValue;
        if (RANK[c.classification] < RANK[cur.classification] || c.adult === true && c.classification === cur.classification) {
          cur.classification = c.classification;
          cur.gates = c.gates;
          cur.basis = c.basis;
        }
      }
      const flagKey = `${id}\0${c.classification}`;
      const prior = flagged.get(flagKey);
      const content = c.classification === "content-gating";
      const adult = content && c.adult === true;
      const upgrade = prior !== void 0 && adult && findings[prior].severity !== "block";
      if ((c.classification === "content-gating" || c.classification === "price-gating") && (prior === void 0 || upgrade)) {
        const slot = prior ?? findings.length;
        flagged.set(flagKey, slot);
        findings[slot] = finding({
          rule: content ? "remote_config.content_gating" : "remote_config.price_gating",
          severity: adult ? "block" : "high",
          guideline: content ? "2.5.19" : "3.1.2",
          file: c.at?.file ?? read.file.path,
          line: c.at?.line ?? read.line,
          evidence: c.at?.evidence ?? read.text,
          why: `${read.provider} key "${key}" (read at ${read.file.path}:${read.line}) ${c.gates}. A server-side switch can change ${content ? "content" : "pricing or paywall behavior"} after approval without a new review (2.5.19, DPLA 3.2(e)${content ? "" : ", 3.1.2"}), and Apple distrusts fixes that live on a server.`,
          fix: adult ? "Delete the flag and the adult or nudification content it gates. Content App Review rejects under 1.1 must not ship behind a server switch, so disclosing the flag does not fix it (2.5.19, DPLA 3.2(e))." : "Remove the remote switch, or disclose it specifically in Notes for Review (2.3.1(a), 2.5.19).",
          confidence: c.confidence,
          suppressible: !adult
        });
      }
    };
    const spent = /* @__PURE__ */ new Map();
    for (const read of collectReads(ctx)) {
      if (debugOnlyAt(read.file, read.index)) continue;
      const used = spent.get(read.file.path) ?? 0;
      if (used >= TRACE_BUDGET_PER_FILE) {
        record(read, read.key, untraced(classify(ctx, read, { sites: [], uses: [], names: [] })));
        continue;
      }
      const t = trace(ctx, read.file, read.index, read.depth);
      spent.set(read.file.path, used + 1 + t.sites.reduce((n, s) => n + s.site.body.length + s.site.header.length, 0) + t.uses.reduce((n, u) => n + u.text.length, 0));
      if (read.provider.startsWith("Custom")) {
        const subs = subKeys(t);
        if (subs.size) {
          for (const [k, sub] of subs) record(read, k, classify(ctx, read, sub));
          continue;
        }
      }
      record(read, read.key, classify(ctx, read, t));
    }
    const inventory = [...entries.values()].sort((a, b) => RANK[a.classification] - RANK[b.classification] || a.provider.localeCompare(b.provider) || a.key.localeCompare(b.key));
    const byProvider = /* @__PURE__ */ new Map();
    for (const e of inventory) {
      if (e.classification === "content-gating" || e.classification === "price-gating") continue;
      byProvider.set(e.provider, [...byProvider.get(e.provider) ?? [], e]);
    }
    for (const [provider, list] of byProvider) {
      const first = list[0];
      const keys = list.map((e) => `${e.key} (${e.classification})`);
      findings.push(
        finding({
          rule: "remote_config.inventory",
          severity: "info",
          guideline: "2.3.1(a)",
          file: first.file,
          line: first.line,
          evidence: `${provider}: ${keys.slice(0, 8).join(", ")}${keys.length > 8 ? ` +${keys.length - 8} more` : ""}`,
          why: `${list.length} remote key(s) read via ${provider}. Remote values can change app behavior after review; App Review's guidance asks for changes to be described with specificity.`,
          fix: "Disclose remote configuration that changes user-visible behavior in Notes for Review, and keep a snapshot of this inventory so drift against the approved build can be checked.",
          confidence: "medium"
        })
      );
    }
    return { findings, data: { inventory } };
  }
};

// src/remediation/verify.ts
var MAX_RESIDUE = 500;
var MIN_PROBES = 50;
var PROMPTISH = /\bprompt|instruction|persona|system_?message|systemMessage/i;
var CONFIG_EXTS2 = /* @__PURE__ */ new Set(["json", "yaml", "yml", "plist", "prompt", "txt", "md", "strings", "stringsdict", "xcstrings", "xcconfig", "env", "toml", "xml"]);
var DECODE_CALL = /(Data\(\s*base64Encoded:|\batob\s*\(|Buffer\.from\([^)]*["']base64["']|\bbase64Decode\w*\s*\(|\bdecodeBase64\w*\s*\(|\bBase64\.decode\w*\s*\(|base64DecodedString|\bfromBase64\w*\s*\()/;
var XOR_DECRYPT = /(\b(xor|deobfuscate|unscramble|decrypt\w*|decipher\w*|unmask)\s*\(|\^\s*0x[0-9a-fA-F]{2}\b|CryptoJS\.\w+\.decrypt|AES\.GCM\.open|ChaChaPoly\.open)/i;
var RUNTIME_PROMPT = [
  /(remoteConfig|RemoteConfig|configValue|getString|getValue|getFeatureValue|getJSON|getConfig)\s*(?:\(\s*(?:forKey:\s*)?|\[\s*)["'`][\w.:-]*(prompt|instruction|persona|system_?message)[\w.:-]*["'`]/i,
  /["'`]https?:\/\/[^"'`\s]*\/[^"'`\s]*(prompt|instruction|persona)s?\b[^"'`\s]*["'`]/i,
  /\b(let|var|const)\s+\w*(prompt|instructions?|persona)\w*\s*(:\s*[\w<>?[\]]+\s*)?=\s*(try\s+)?(await\s+)?(fetch|axios|URLSession|loadRemote\w*|download\w*)\b/i
];
var NET_CALL = /\b(fetch\s*\(|axios(\.(post|get|request))?\s*\(|URLRequest\s*\(\s*url|URLSession\.shared\.(data|upload)|AF\.request|httpsCallable\s*\(|functions\.invoke\s*\()/;
var NON_AI_HOSTS = /(apple\.com|googleapis\.com\/(identitytoolkit|firestore)|sentry\.io|posthog|mixpanel|amplitude|segment\.io|revenuecat|facebook\.com|branch\.io|appsflyer|onesignal|expo\.dev|exp\.host)/i;
var FRAMEWORK_NAMES = /* @__PURE__ */ new Set([
  "body",
  "main",
  "init",
  "render",
  "App",
  "default",
  "makeBody",
  "viewDidLoad",
  "viewWillAppear",
  "application",
  "scene",
  "previews",
  "Previews",
  "loader",
  "action",
  "generateMetadata",
  "layout"
]);
var newSweep = () => ({ residue: [], seen: /* @__PURE__ */ new Set(), truncated: false, excluded: 0, blocklists: /* @__PURE__ */ new Map(), moderationKeys: /* @__PURE__ */ new Map() });
function pushHit(st, h) {
  const key = `${h.kind}|${h.needle.toLowerCase()}|${h.file}|${h.line ?? ""}`;
  if (st.seen.has(key)) return;
  st.seen.add(key);
  if (st.residue.length >= MAX_RESIDUE) {
    st.truncated = true;
    return;
  }
  st.residue.push({ ...h, evidence: h.evidence ? clip(h.evidence) : void 0 });
}
var isMetadataPath = (rel) => /^(fastlane\/)?(metadata|screenshots)\//.test(rel);
var REVIEWER_ONLY = /(^|\/)review[_-]?(information|notes?)(\/|\.|$)/i;
var LOCKFILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|Package\.resolved|Podfile\.lock|yarn\.lock)$/;
var REMOVAL_NOTICE = /\b(removed|no longer|deleted|discontinued|dropped|taken out)\b/i;
function inSweep(f) {
  if (LOCKFILE.test(f.path)) return false;
  if (isMetadataPath(f.path)) return !REVIEWER_ONLY.test(f.path);
  if (["md", "txt"].includes(f.ext) && isDocPath(f.path)) return false;
  return true;
}
function declaredIdentAt(f, start, end) {
  let a = start;
  let b = end;
  while (a > 0 && /[\w$]/.test(f.code[a - 1])) a--;
  while (b < f.code.length && /[\w$]/.test(f.code[b])) b++;
  const ident = f.code.slice(a, b);
  if (!/^[A-Za-z_$][\w$]*$/.test(ident)) return void 0;
  const line = lineText(f.code, start);
  const rx = new RegExp(`\\b(func|function|class|struct|enum|protocol|interface|type|typealias|let|var|const)\\s+${escapeRx2(ident)}(?![\\w$])`);
  return rx.test(line) ? ident : void 0;
}
function classify2(ctx, f, start, end) {
  if (!isCodeFile(f)) {
    if (isMetadataPath(f.path)) return { status: "PRESENT", confidence: "high", reason: "Store metadata in the repo still mentions it; reviewers and users see this text." };
    return { status: "PRESENT", confidence: "high", reason: `Still present in a bundled ${f.ext} file.` };
  }
  const scope = enclosingConditions(f.code, start, f.ext);
  if (isDebugOnly(scope)) {
    return {
      status: "DEBUG_ONLY",
      confidence: "medium",
      reason: "Only compiled into debug builds (#if DEBUG / __DEV__). It does not fail verification by itself; delete it anyway so a build-setting change cannot ship it."
    };
  }
  if (isRuntimeGated(scope)) {
    const c = scope.conditions.find((x) => x.signals.some((s) => s !== "debug"));
    return {
      status: "GATED",
      confidence: "medium",
      reason: `Behind a runtime condition (${scope.signals.filter((s) => s !== "debug").join(", ")})${c ? ` at line ${c.line}: ${clip(c.text, 80)}` : ""}. A switch that can turn the feature back on after review is a hidden feature under 2.5.19; remove the gated code, not just the switch.`
    };
  }
  const own = declaredIdentAt(f, start, end);
  const decls = enclosingDeclarations(f, start);
  const candidates = [
    ...own ? [{ ident: own, depth: decls.length, exported: /\bexport\b|@main|@objc|override\b/.test(lineText(f.code, start)), declKind: /\b(func|function|class|struct|enum|protocol|interface|type|typealias|let|var|const)\s+/.exec(lineText(f.code, start))?.[1] ?? "" }] : [],
    ...decls
  ];
  const dead = candidates.find((d) => {
    if (d.exported || FRAMEWORK_NAMES.has(d.ident)) return false;
    const typeLike = /^(class|struct|enum|protocol|interface|type|typealias)$/.test(d.declKind);
    const topLevelValue = /^(let|var|const|val|func|function)$/.test(d.declKind) && d.depth === 0;
    if (!typeLike && !topLevelValue) return false;
    return identifierCount(ctx, d.ident) <= 1;
  });
  if (dead) {
    return {
      status: "UNREFERENCED",
      confidence: "low",
      reason: `Inside ${dead.ident}, which is declared but never referenced by name. Unreferenced code still ships in the binary and can be reached by reflection, a string-based lookup or an update; 2.5.19 treats it as a dormant feature. Delete it.`
    };
  }
  return { status: "PRESENT", confidence: "high", reason: "Unconditional code that ships in release builds." };
}
function tryDecodeBase64(s) {
  try {
    const buf = Buffer.from(s, "base64");
    if (buf.length < 40) return void 0;
    let printable = 0;
    for (const b of buf) if (b === 9 || b === 10 || b === 13 || b >= 32 && b < 127 || b >= 194) printable++;
    return printable / buf.length >= 0.95 ? buf.toString("utf8") : void 0;
  } catch {
    return void 0;
  }
}
function sweepFile(ctx, f, needles, st) {
  const src = isCodeFile(f) ? f.code : f.text;
  const promptFile = ["prompt", "txt", "md"].includes(f.ext);
  for (const n of needles) {
    for (const m of matchNeedle(n, src)) {
      const line = lineOf(src, m.index);
      if (n.kind === "term") {
        const bl = blocklistAt(ctx, f, m.index);
        if (bl) {
          const key = `${bl.file}#${bl.name}`;
          const entry = st.blocklists.get(key) ?? { file: bl.file, line: bl.line, used: bl.used, terms: /* @__PURE__ */ new Set(), server: isServerPath(bl.file) };
          entry.terms.add(n.value.toLowerCase());
          st.blocklists.set(key, entry);
          st.excluded++;
          continue;
        }
        if ((promptFile || isCodeFile(f)) && isRefusalInstruction(src, m.index)) {
          st.excluded++;
          continue;
        }
        if (moderationKeyIn(ctx.files, f, m.index, m.end)) {
          const at = `${f.path}:${line}`;
          st.moderationKeys.set(at, (st.moderationKeys.get(at) ?? /* @__PURE__ */ new Set()).add(n.value.toLowerCase()));
          st.excluded++;
          continue;
        }
        if (isMetadataPath(f.path) && REMOVAL_NOTICE.test(lineText(src, m.index))) {
          st.excluded++;
          continue;
        }
      }
      const c = classify2(ctx, f, m.index, m.end);
      const variant = n.kind === "term" && m.text.toLowerCase() !== n.value.toLowerCase();
      pushHit(st, {
        kind: isMetadataPath(f.path) ? "metadata" : n.kind,
        needle: n.value,
        file: f.path,
        line,
        evidence: lineText(f.text, m.index),
        ...c,
        confidence: variant && c.confidence === "high" ? "medium" : c.confidence,
        reason: variant ? `${c.reason} Matched the spelling variant "${m.text}".` : c.reason
      });
    }
  }
}
function obfuscationSweep(f, needles, st) {
  const code = isCodeFile(f);
  if (!code && !CONFIG_EXTS2.has(f.ext)) return;
  const src = code ? f.code : f.text;
  const nearAi = code && (AI_SINK.test(src) || PROMPTISH.test(src));
  const obf = (idx, needle, reason) => pushHit(st, {
    kind: "obfuscation",
    needle,
    file: f.path,
    line: lineOf(src, idx),
    evidence: lineText(f.text, idx),
    status: "PRESENT",
    confidence: "medium",
    reason: `${reason} Static checks cannot see what this produces at runtime, and hiding features through obfuscation is itself grounds for removal under 2.5.19. Replace it with plain, reviewable text or disclose it in the review notes.`
  });
  for (const m of src.matchAll(/[A-Za-z0-9+/]{200,}={0,2}/g)) {
    const idx = m.index ?? 0;
    const before = src.slice(Math.max(0, idx - 64), idx);
    if (/data:(image|font|audio|video|application\/(pdf|x-font[\w-]*|font[\w-]*|octet-stream))[^,]*,\s*$/i.test(before)) continue;
    if (m[0].startsWith("eyJ")) continue;
    const decoded = tryDecodeBase64(m[0]);
    if (!decoded && !nearAi) continue;
    obf(idx, "base64 blob", `A ${m[0].length}-character base64 blob${decoded ? " that decodes to text" : ""}${nearAi ? " sits in a file that builds prompts or calls an AI service" : ""}.`);
    if (decoded) {
      const hit = matchesAny(needles, decoded);
      if (hit) {
        pushHit(st, {
          kind: hit.kind,
          needle: hit.value,
          file: f.path,
          line: lineOf(src, idx),
          evidence: `base64 blob decodes to text containing "${hit.value}"`,
          status: "PRESENT",
          confidence: "high",
          reason: "The decoded blob still contains a residue item. Encoding it does not remove it; it hides it, which 2.5.19 treats as concealment."
        });
      }
    }
  }
  if (!code) return;
  if (nearAi) {
    for (const m of src.matchAll(new RegExp(DECODE_CALL.source, "g"))) {
      obf(m.index ?? 0, "runtime decoding", "Base64 decoding in a file that builds prompts or calls an AI service.");
    }
    for (const m of src.matchAll(new RegExp(XOR_DECRYPT.source, "gi"))) {
      obf(m.index ?? 0, "decrypt/xor helper", "A decrypt or XOR helper in a file that builds prompts or calls an AI service.");
    }
  }
  for (const rx of RUNTIME_PROMPT) {
    for (const m of src.matchAll(new RegExp(rx.source, "gi"))) {
      obf(m.index ?? 0, "runtime-fetched prompt", "The prompt or instructions are fetched at runtime (remote config or URL), so the shipped binary does not show what the model is told.");
    }
  }
}
var NOT_GENERATION = new Set(
  "report reporter reporting feedback support contact abuse flag flagging bug analytics telemetry log logs logging event events track tracking metric metrics auth login signin signup account profile subscription purchase receipt push notification token health ping".split(" ")
);
var wordsOf2 = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
var GENERATION_HINT = /generat|imag(e|ine)|render|chat|complet|prompt|avatar|predict|infer|llm|diffus|styli[sz]e|portrait|caption/i;
function unverifiableCalls(ctx, files) {
  const out = [];
  const serverFiles = ctx.files.filter((f) => isServerPath(f.path) && isCodeFile(f));
  const hasServer = serverFiles.length > 0;
  for (const f of files) {
    if (!isCodeFile(f) || isServerPath(f.path)) continue;
    if (!/\bprompt\b|generat/i.test(f.code)) continue;
    if (AI_HOSTS.test(f.code)) continue;
    let last = { line: -Infinity, fn: "" };
    for (const m of f.code.matchAll(new RegExp(NET_CALL.source, "g"))) {
      const idx = m.index ?? 0;
      const line = lineOf(f.code, idx);
      const stmt = f.code.slice(idx, idx + 300);
      const urlM = /["'`]((?:https?:\/\/)?[^"'`\s]+)["'`]/.exec(stmt);
      const target = urlM?.[1] ?? "";
      const fnName = /functions\.invoke\s*\(\s*["'`]([\w-]+)/.exec(stmt)?.[1] ?? /httpsCallable\s*\([^"'`]*["'`]([\w-]+)/.exec(stmt)?.[1];
      const decls = enclosingDeclarations(f, idx);
      const fn = decls[0]?.ident ?? "";
      if (target || fnName) last = { line, fn };
      else if (line - last.line <= 15 && fn === last.fn) continue;
      if (AI_HOSTS.test(stmt) || AI_HOSTS.test(target) || NON_AI_HOSTS.test(target)) continue;
      if (fnName && serverFiles.some((s) => s.path.includes(`/${fnName}/`) || s.path.includes(`${fnName}.`))) continue;
      if (hasServer && /^\/|localhost|127\.0\.0\.1/.test(target)) continue;
      const what = [target, fnName ?? "", ...decls.map((d) => d.ident)].join(" ");
      if (wordsOf2(what).some((w) => NOT_GENERATION.has(w) || NOT_GENERATION.has(w.replace(/s$/, ""))) && !GENERATION_HINT.test(what)) continue;
      out.push(
        `${f.path}:${line} sends a prompt-building request to ${target || fnName || "a backend"}; the prompt template and any filters on that server are not in this repo, so they need a developer attestation.`
      );
    }
  }
  return [...new Set(out)].slice(0, 30);
}
function blockingEvidence(spec, st, sites, sinks) {
  const wanted = spec.terms.length ? spec.terms.map((t) => t.toLowerCase()) : spec.capability.toLowerCase().match(new RegExp("\\p{L}{5,}", "gu")) ?? [];
  const filters = [];
  for (const [key, bl] of st.blocklists) {
    if (!bl.used) continue;
    const covered = wanted.filter((w) => bl.terms.has(w)).length;
    if (wanted.length && covered / wanted.length >= 0.5) {
      filters.push({
        kind: "text",
        file: bl.file,
        line: bl.line,
        name: key.slice(key.indexOf("#") + 1),
        label: `${bl.server ? "server-side " : ""}blocklist at ${bl.file}:${bl.line} covers ${covered}/${wanted.length} spec terms and is used in code`
      });
    }
  }
  const disabled = [];
  for (const s of sites) {
    const where = `${s.file}:${s.line}`;
    const server = isServerPath(s.file) ? "server-side " : "";
    if (s.role === "safety-disabled") disabled.push(`provider safety is turned off at ${where} (${s.label})`);
    else if (s.role === "safety-strict") filters.push({ kind: "both", file: s.file, line: s.line, provider: settingProvider(s.label), label: `${server}strict ${providerName(settingProvider(s.label))} safety setting at ${where} (${s.label})` });
    else if (s.role === "moderation") filters.push({ kind: s.label.startsWith("image") ? "both" : "text", file: s.file, line: s.line, label: `${server}${s.label} at ${where}` });
  }
  const code = sinks.filter((x) => !/\.(json|ya?ml|toml)$/i.test(x.file));
  const sinkLines = /* @__PURE__ */ new Map();
  for (const x of code) sinkLines.set(x.file, [...sinkLines.get(x.file) ?? [], x.line]);
  return { filters, disabled, sinkFiles: [...sinkLines.keys()], sinkLines };
}
function settingProvider(label) {
  if (/BLOCK_/.test(label)) return "gemini";
  if (/safety_tolerance/.test(label)) return "bfl";
  if (/enable_safety_checker/.test(label)) return "fal";
  if (/disable_safety_checker/.test(label)) return "replicate";
  return void 0;
}
function providerName(id) {
  return id && PROVIDERS.find((p) => p.id === id)?.name || "provider";
}
var PROVIDER_HINTS = {
  gemini: /\bgemini\b|GenerativeModel|generativelanguage|aiplatform\.googleapis/i,
  replicate: /\breplicate\b/i,
  fal: /\bfal\.(?:run|ai|media|subscribe|queue)\b|["'`]fal-ai\//i,
  openai: /\bopenai\b|api\.openai\.com/i,
  bfl: /api\.bfl\.|black-forest-labs/i,
  stability: /stability\.ai|stability-ai\//i,
  anthropic: /\banthropic\b/i
};
function providersOf(f) {
  const out = /* @__PURE__ */ new Set();
  if (!f) return out;
  for (const p of PROVIDERS) if (p.sdk.test(f.code) || p.hosts?.test(f.text)) out.add(p.id);
  for (const [id, rx] of Object.entries(PROVIDER_HINTS)) if (rx.test(f.code)) out.add(id);
  return out;
}
var FILE_REF = /([\w./-]+\.(?:swift|tsx?|jsx?|mjs|cjs|kt|py|dart|go|rb|m|mm))(?::\d+)?/g;
function refsIn2(ctx, text) {
  const out = [];
  for (const m of text.matchAll(FILE_REF)) {
    const ref = m[1].replace(/^\.\//, "");
    const f = ctx.files.find((x) => x.path === ref || x.path.endsWith(`/${ref}`));
    if (f && !out.includes(f.path)) out.push(f.path);
  }
  return out;
}
function citedLines(ctx, text) {
  const out = /* @__PURE__ */ new Map();
  for (const m of text.matchAll(/([\w./-]+\.(?:swift|tsx?|jsx?|mjs|cjs|kt|py|dart|go|rb|m|mm)):(\d+)/g)) {
    const [p] = refsIn2(ctx, m[1]);
    if (p && !out.has(p)) out.set(p, Number(m[2]));
  }
  return out;
}
function guardFiles(ctx, direct, used) {
  const out = new Set(direct);
  for (const f of ctx.files) {
    if (out.has(f.path) || !isCodeFile(f)) continue;
    if (declaredNames(f).some((n) => used.has(n))) out.add(f.path);
  }
  return out;
}
var FN_KIND = /^(func|function)$/;
var TYPE_KIND = /^(class|struct|enum|protocol|interface|type)$/;
var FN_DECL = /\b(?:func|function)\s+([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g;
var fnLike = (d) => FN_KIND.test(d.declKind) || /^(const|let|var)$/.test(d.declKind) && /=>|=\s*(async\s+)?function\b/.test(d.header);
function reachedFunctions(g, used) {
  const fns = [...new Set([...g.code.matchAll(FN_DECL)].map((m) => m[1] ?? m[2]).filter((n) => !!n))];
  const reached = new Set(fns.filter((n) => used.has(n)));
  const masked = maskedOf2(g);
  for (let changed = true, rounds = 0; changed && rounds < 8; rounds++) {
    changed = false;
    for (const n of fns) {
      if (reached.has(n)) continue;
      for (const m of masked.matchAll(new RegExp(`(?<![\\w$])${escapeRx2(n)}(?![\\w$])`, "g"))) {
        const caller = enclosingDeclarations(g, m.index ?? 0).find(fnLike);
        if (caller && caller.ident !== n && reached.has(caller.ident)) {
          reached.add(n);
          changed = true;
          break;
        }
      }
    }
  }
  return reached;
}
function onCallChain(g, line, used) {
  const decls = enclosingDeclarations(g, lineStartOffset(g, line));
  if (!decls.length) return false;
  const types = decls.filter((d) => TYPE_KIND.test(d.declKind));
  const outer = types[types.length - 1];
  if (outer && !used.has(outer.ident)) return false;
  const fn = decls.find(fnLike);
  if (!fn) return !!outer || decls.some((d) => used.has(d.ident));
  return reachedFunctions(g, used).has(fn.ident);
}
function lineStartOffset(g, line) {
  const lines = g.code.split("\n");
  const l = lines[line - 1] ?? "";
  return lines.slice(0, line - 1).reduce((n, x) => n + x.length + 1, 0) + (l.length - l.trimStart().length);
}
function declRanges(g, names) {
  const masked = maskedOf2(g);
  const out = [];
  for (const m of masked.matchAll(/\b(?:func|function|var|let|const|val)\s+([A-Za-z_$][\w$]*)/g)) {
    if (!names.has(m[1])) continue;
    const start = m.index ?? 0;
    let i = start + m[0].length;
    let paren = 0;
    let open4 = -1;
    for (; i < masked.length; i++) {
      const ch = masked[i];
      if (ch === "(" || ch === "[") paren++;
      else if (ch === ")" || ch === "]") paren--;
      else if (paren > 0) continue;
      else if (ch === "{") {
        open4 = i;
        break;
      } else if (ch === ";" || ch === "}") break;
      else if (ch === "\n" && !/^\s*\{/.test(masked.slice(i + 1, i + 200)) && !/(=>|=|->)\s*$/.test(masked.slice(start, i))) break;
    }
    if (open4 < 0) {
      out.push([start, i]);
      continue;
    }
    let depth = 0;
    let j = open4;
    for (; j < masked.length; j++) {
      if (masked[j] === "{") depth++;
      else if (masked[j] === "}" && --depth === 0) break;
    }
    out.push([start, j + 1]);
  }
  return out;
}
var DECL_ON_LINE = /\b(?:let|var|const|val)\s+([A-Za-z_$][\w$]*)/;
function chainRegions(p, sink, citedLine) {
  const masked = maskedOf2(p);
  const fns = /* @__PURE__ */ new Set();
  const holders = /* @__PURE__ */ new Set();
  const seen = /* @__PURE__ */ new Set();
  let unplaced = false;
  const place = (at) => {
    const decls = enclosingDeclarations(p, at);
    const fn = decls.find(fnLike);
    if (fn) {
      fns.add(fn.ident);
      return;
    }
    const lineStart = masked.lastIndexOf("\n", at - 1) + 1;
    const lineEnd = masked.indexOf("\n", at);
    const decl = DECL_ON_LINE.exec(masked.slice(lineStart, lineEnd < 0 ? void 0 : lineEnd));
    const holder = decls.find((d) => !TYPE_KIND.test(d.declKind))?.ident ?? (decl && lineStart + decl.index <= at ? decl[1] : void 0);
    if (!holder) {
      unplaced = true;
      return;
    }
    holders.add(holder);
    follow([holder]);
  };
  const follow = (names2) => {
    for (const n of names2) {
      if (seen.has(n)) continue;
      seen.add(n);
      for (const m of masked.matchAll(new RegExp(`(?<![\\w$])${escapeRx2(n)}(?![\\w$])`, "g"))) place(m.index ?? 0);
    }
  };
  follow(declaredNames(sink));
  if (!fns.size && !holders.size && citedLine) place(lineStartOffset(p, citedLine));
  if (unplaced || !fns.size && !holders.size) return void 0;
  const names = /* @__PURE__ */ new Set([...holders, ...fns, ...reachedFunctions(p, fns)]);
  return declRanges(p, names);
}
function sinkChain(g, lines) {
  const entry = /* @__PURE__ */ new Set();
  for (const line of lines) {
    const fn = enclosingDeclarations(g, lineStartOffset(g, line)).find(fnLike);
    if (!fn) return void 0;
    entry.add(fn.ident);
  }
  const masked = maskedOf2(g);
  const fns = [...new Set([...g.code.matchAll(FN_DECL)].map((m) => m[1] ?? m[2]).filter((n) => !!n))];
  const callers = /* @__PURE__ */ new Map();
  for (const n of fns) {
    for (const m of masked.matchAll(new RegExp(`(?<![\\w$])${escapeRx2(n)}(?![\\w$])`, "g"))) {
      const caller = enclosingDeclarations(g, m.index ?? 0).find(fnLike);
      if (caller && caller.ident !== n) callers.set(n, (callers.get(n) ?? /* @__PURE__ */ new Set()).add(caller.ident));
    }
  }
  const upward = new Set(entry);
  for (const todo = [...entry]; todo.length; ) {
    for (const c of callers.get(todo.pop()) ?? []) if (!upward.has(c)) upward.add(c), todo.push(c);
  }
  return reachedFunctions(g, upward);
}
function filtersForSink(ctx, b, sinkFile, pathFiles, image, cited = /* @__PURE__ */ new Map()) {
  const fileOf = (p) => ctx.files.find((f) => f.path === p);
  const sink = fileOf(sinkFile);
  const sinkProviders = providersOf(sink);
  const direct = /* @__PURE__ */ new Set([sinkFile, ...pathFiles]);
  const regions = /* @__PURE__ */ new Map();
  const chainUsed = identifiersOf(sink ? [sink] : []);
  for (const pf of pathFiles) {
    const f = fileOf(pf);
    if (!f || pf === sinkFile) continue;
    const r = sink ? chainRegions(f, sink, cited.get(pf)) : void 0;
    if (r) regions.set(pf, r);
    const text = r ? r.map(([s, e]) => f.code.slice(s, e)).join("\n") : f.code;
    for (const id of text.match(/[A-Za-z_$][\w$]*/g) ?? []) chainUsed.add(id);
  }
  const guards = guardFiles(ctx, direct, chainUsed);
  const used = new Set(chainUsed);
  for (const p of guards) if (!direct.has(p)) for (const id of identifiersOf([fileOf(p)].filter((f) => !!f))) used.add(id);
  const chain = sink ? sinkChain(sink, b.sinkLines.get(sinkFile) ?? []) : void 0;
  const guarding = (x) => {
    if (!guards.has(x.file)) return false;
    const g = fileOf(x.file);
    if (x.file === sinkFile && chain && g && !x.provider) {
      const fn = enclosingDeclarations(g, lineStartOffset(g, x.line)).find(fnLike);
      if (fn && !chain.has(fn.ident)) return false;
    }
    const r = regions.get(x.file);
    if (r && g) {
      const at = lineStartOffset(g, x.line);
      return r.some(([s, e]) => at >= s && at < e);
    }
    if (direct.has(x.file)) return true;
    return !!g && onCallChain(g, x.line, chainUsed);
  };
  return b.filters.filter((x) => {
    if (image && x.kind === "text") return false;
    if (x.provider) return guarding(x) && (sinkProviders.size === 0 || sinkProviders.has(x.provider));
    if (guarding(x)) return true;
    return !!x.name && used.has(x.name);
  });
}
var IMAGE_PATH = /\b(image|photo|upload|camera|picture|img2img|remix|selfie|face|gallery)\b/i;
function distinctFilters(ctx, found) {
  const where = (x) => x.label.replace(` at ${x.file}:${x.line}`, "");
  const token = (x) => /\(([^)]+)\)/.exec(where(x))?.[1]?.toLowerCase();
  const isModeration = (x) => !x.provider && !x.name;
  const declared = /* @__PURE__ */ new Map();
  const declaresOf = (file2) => {
    let d = declared.get(file2);
    if (!d) {
      const f = ctx.files.find((g) => g.path === file2);
      d = new Set((f ? declaredNames(f) : []).map((n) => n.toLowerCase()));
      declared.set(file2, d);
    }
    return d;
  };
  const calledInto = (y) => found.some((x) => {
    if (x === y || x.file === y.file || !isModeration(x)) return false;
    const t = token(x);
    return !!t && declaresOf(y.file).has(t);
  });
  const seen = /* @__PURE__ */ new Set();
  return found.filter((x) => {
    if (isModeration(x) && calledInto(x)) return false;
    const key = isModeration(x) ? `m|${x.file}|${x.kind}` : `${x.provider ?? x.name}|${x.file}|${where(x)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function judgePath(ctx, name, text, b, generationLeft, extraRefs = []) {
  if (b.disabled.length) return { inputPath: name, blocked: false, evidence: [...b.disabled, "Provider safety is explicitly disabled, so other filters cannot be relied on."] };
  if (!generationLeft) return { inputPath: name, blocked: true, evidence: ["No AI generation call or prompt-building backend call remains in the repo."] };
  const image = IMAGE_PATH.test(text);
  const arrow = text.split(/→|->/);
  const sinkSide = arrow.length > 1 ? arrow.slice(1).join(" ") : text;
  const pathFiles = [.../* @__PURE__ */ new Set([...refsIn2(ctx, text), ...extraRefs])];
  const cited = citedLines(ctx, text);
  const named = [.../* @__PURE__ */ new Set([...refsIn2(ctx, sinkSide), ...pathFiles])].filter((f) => b.sinkFiles.includes(f));
  const sinks = named.length ? named : b.sinkFiles;
  if (!sinks.length) {
    const any = b.filters.filter((x) => !image || x.kind === "both");
    if (any.length) return { inputPath: name, blocked: true, evidence: any.slice(0, 6).map((x) => `${x.label} (no generation call in the repo to tie it to)`) };
    return { inputPath: name, blocked: false, evidence: ["No prompt blocklist covering the spec terms, moderation call or strict provider safety setting was found in the repo."] };
  }
  const evidence = [];
  const open4 = [];
  const grouped = !named.length && sinks.length > 1;
  const sinkNames = (sink) => {
    const f = ctx.files.find((x) => x.path === sink);
    return f ? declaredNames(f) : [];
  };
  const reaching = (sink) => {
    const names = sinkNames(sink);
    return pathFiles.filter((pf) => {
      const f = ctx.files.find((x) => x.path === pf);
      return !!f && (pf === sink || names.some((n) => new RegExp(`(?<![\\w$])${escapeRx2(n)}(?![\\w$])`).test(f.code)));
    });
  };
  for (const sink of sinks) {
    const found = distinctFilters(ctx, filtersForSink(ctx, b, sink, grouped ? reaching(sink) : pathFiles, image, cited));
    if (!found.length) open4.push(sink);
    else if (grouped) evidence.push(`${found.slice(0, 3).map((x) => x.label).join("; ")} (guards ${sink})`);
    else evidence.push(...found.slice(0, 3).map((x) => `${x.label} (guards ${sink})`));
  }
  if (!open4.length) {
    const note = grouped ? [`The path names no generation call, so all ${sinks.length} generation calls in the repo had to be guarded; each filter below guards only the call named after it, not this path as a whole.`] : [];
    return { inputPath: name, blocked: true, evidence: [...note, ...[...new Set(evidence)].slice(0, 6)] };
  }
  const elsewhere = b.filters.filter((x) => !open4.some((o) => filtersForSink(ctx, b, o, pathFiles, image, cited).includes(x))).sort((x, y) => Number(!!x.provider) - Number(!!y.provider));
  const out = open4.map((sink) => {
    const prov = [...providersOf(ctx.files.find((f) => f.path === sink))].map((id) => providerName(id)).join("/");
    return image ? `The generation call in ${sink}${prov ? ` (${prov})` : ""} has no image moderation or strict safety setting of its own; a text blocklist does not filter uploaded images.` : `The generation call in ${sink}${prov ? ` (${prov})` : ""} has no filter of its own: no moderation call or prompt blocklist on its call path and no strict safety setting for its provider.`;
  });
  if (elsewhere.length) out.push(`Filters elsewhere are not on its call path, so they do not cover it: ${elsewhere.slice(0, 3).map((x) => x.label).join("; ")}. A setting for a different provider filters only that provider's calls.`);
  if (!b.filters.length) out.push("Provider default safety settings are not counted: defaults commonly allow the content App Review rejected (for example lingerie).");
  return { inputPath: name, blocked: false, evidence: out };
}
async function refState(root, ev, baseRef, gitRepo) {
  const ref = parseEvidenceRef(ev);
  if (!ref) return "present";
  const abs = path6.join(root, ref.file);
  if (!abs.startsWith(path6.resolve(root) + path6.sep) || !existsSync3(abs)) return "gone";
  const body = await readRegularFile(abs, EVIDENCE_MAX_BYTES, "evidence file", root).catch(() => void 0);
  if (!body) return "present";
  const text = body.toString("utf8");
  const lines = text.split("\n");
  let snippet = ref.snippet;
  if (!snippet && baseRef && gitRepo && safeRef(baseRef) && !/[\0:]/.test(ref.file)) {
    const before = (await git(root, ["show", "--no-textconv", `${baseRef}:${ref.file}`]))?.split("\n")[ref.line - 1]?.trim();
    if (before && /[\p{L}\p{N}]/u.test(before)) snippet = before;
  }
  if (snippet) {
    const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
    return norm(text).includes(norm(snippet)) ? "present" : "gone";
  }
  return ref.line >= 1 && ref.line <= lines.length ? "line-only" : "gone";
}
var tokensOf = (s) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
function inPlaceSwap(before, after, needles) {
  const b = before.trim();
  const a = after.trim();
  if (!a || matchesAny(needles, a)) return void 0;
  for (const n of needles) {
    const ms = matchNeedle(n, b, 20);
    if (!ms.length) continue;
    if (ms.length <= 6) {
      const parts = [];
      let at = 0;
      for (const m of ms) {
        parts.push(escapeRx2(b.slice(at, m.index)));
        at = m.end;
      }
      parts.push(escapeRx2(b.slice(at)));
      const rx = new RegExp(`^${parts.join("(.{1,80}?)")}$`, "s");
      const hit = rx.exec(a);
      if (hit) {
        const replacement = hit.slice(1).join(", ").trim();
        if (replacement && /[\p{L}\p{N}]/u.test(replacement)) return { needle: n, replacement };
      }
    }
    const rest = tokensOf(b.replace(new RegExp(n.rx.source, n.rx.flags.includes("g") ? n.rx.flags : `${n.rx.flags}g`), " "));
    const now = tokensOf(a);
    const fresh = now.filter((t) => !tokensOf(b).includes(t));
    if (rest.length >= 4 && fresh.length && fresh.length <= ms.length * 3 && rest.filter((t) => now.includes(t)).length / rest.length >= 0.85) {
      return { needle: n, replacement: fresh.join(" ") };
    }
  }
  return void 0;
}
var needleSet = (needles, text) => needles.filter((n) => matchNeedle(n, text, 1).length).map((n) => `${n.kind}:${n.value.toLowerCase()}`).join("|");
function filterOnlyLine(old, files, lineNo, needles) {
  const src = isCodeFile(old) ? old.code : old.text;
  const lines = src.split("\n");
  const text = lines[lineNo - 1];
  if (text === void 0) return false;
  const start = lines.slice(0, lineNo - 1).reduce((n, l) => n + l.length + 1, 0);
  let any = false;
  for (const n of needles) {
    for (const m of matchNeedle(n, text)) {
      if (n.kind !== "term") return false;
      if (!isFilterMatch(files, old, src, start + m.index, start + m.end)) return false;
      any = true;
    }
  }
  return any;
}
async function diffEvidence(ctx, baseRef, needles) {
  const root = ctx.root;
  const none = { removed: [], replaced: [], renamedFiles: [], filterLines: 0 };
  if (!safeRef(baseRef)) return { ...none, error: `baseRef "${baseRef}" is not a plain git ref` };
  const ok = await git(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${baseRef}^{commit}`]);
  if (!ok?.trim()) return { ...none, error: `baseRef ${baseRef} was not found in this repository` };
  const stat3 = (await git(root, ["diff", "--shortstat", "--no-ext-diff", "--no-textconv", baseRef, "--"]))?.trim();
  const diff = await git(root, ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", baseRef, "--"]);
  if (diff === void 0) return { ...none, stat: stat3, error: "git diff failed" };
  const removed = [];
  const removedLines = [];
  const replaced = [];
  let file2 = "";
  let oldLine = 0;
  let newLine = 0;
  let minus = [];
  let plus = [];
  const flush = () => {
    for (const [i, r] of minus.entries()) {
      if (!matchesAny(needles, r.text)) continue;
      const kept2 = needleSet(needles, r.text);
      if (plus.some((p) => needleSet(needles, stripComments(p.text, extOf(file2))) === kept2)) continue;
      const order = plus[i] ? [plus[i], ...plus.filter((_, j) => j !== i)] : plus;
      const swap = order.map((p) => ({ p, s: inPlaceSwap(r.text, p.text, needles) })).find((x) => x.s);
      if (swap?.s) replaced.push({ file: file2, line: swap.p.line, needle: swap.s.needle, before: r.text, after: swap.p.text, replacement: swap.s.replacement });
      else removedLines.push({ file: file2, line: r.line, text: r.text });
    }
    minus = [];
    plus = [];
  };
  for (const l of diff.split("\n")) {
    if (l.startsWith("diff --git ")) {
      flush();
      file2 = /^diff --git a\/(.+?) b\//.exec(l)?.[1] ?? "";
      continue;
    }
    if (l.startsWith("--- ") || l.startsWith("+++ ")) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l);
    if (hunk) {
      flush();
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (l.startsWith("Binary files ") && /\/dev\/null differ$/.test(l) || l.startsWith("deleted file mode")) {
      if (matchesAny(needles, file2)) removed.push(`${file2} (deleted)`);
      continue;
    }
    if (l.startsWith("-")) minus.push({ line: oldLine++, text: l.slice(1) });
    else if (l.startsWith("+")) plus.push({ line: newLine++, text: l.slice(1) });
    if (removed.length + removedLines.length >= 200) break;
  }
  flush();
  let filterLines = 0;
  for (const rel of [...new Set(removedLines.map((r) => r.file))]) {
    const lines = removedLines.filter((r) => r.file === rel);
    const text = await git(root, ["show", "--no-textconv", `${baseRef}:${rel}`]);
    const ext = extOf(rel);
    const old = text === void 0 ? void 0 : { path: rel, abs: path6.join(root, rel), ext, text, code: stripComments(text, ext) };
    const files = old ? [old, ...ctx.files.filter((f) => f.path !== rel)] : [];
    for (const r of lines) {
      if (old && filterOnlyLine(old, files, r.line, needles)) {
        filterLines++;
        continue;
      }
      removed.push(`${rel}:${r.line}: ${clip(r.text, 120)}`);
    }
  }
  const renamedFiles = [];
  const status = await git(root, ["diff", "--name-status", "-M50%", "--no-ext-diff", "--no-textconv", baseRef, "--"]);
  for (const l of status?.split("\n") ?? []) {
    const [code, from, to] = l.split("	");
    if (!code?.startsWith("R") || !from || !to) continue;
    const n = matchesAny(needles, from);
    if (!n || matchesAny(needles, to)) continue;
    renamedFiles.push({ from, to, needle: n });
  }
  const movedFrom = renamedFiles.map((r) => r.from);
  const kept = [...new Set(removed)].filter((r) => !movedFrom.some((m) => r === `${m} (deleted)` || r.startsWith(`${m}:`)));
  return { removed: kept, replaced, renamedFiles, filterLines, stat: stat3 };
}
var isConditionRule = (rule) => rule.startsWith("review_gating.") || rule === "remote_config.content_gating";
var CONDITION_EXTS = /* @__PURE__ */ new Set([...CODE_EXTENSIONS, "json", "plist", "xcconfig", "pbxproj", "yaml", "yml", "env"]);
var MAX_BASE_FILE = 1024 * 1024;
var NOT_NAMES2 = /* @__PURE__ */ new Set(["true", "false", "self", "this", "return", "else", "guard", "while", "let", "var", "const", "null", "undefined", "nil"]);
async function conditionFindings(ctx) {
  const out = [];
  for (const c of [check3, check4]) {
    const r = await c.run(ctx).catch(() => ({ findings: [] }));
    out.push(...r.findings.filter((f) => isConditionRule(f.rule) && f.severity !== "info" && !!f.file));
  }
  return out;
}
function conditionOf(evidence) {
  const e = evidence.trim().replace(/^\}?\s*(else\s+)?(if|guard|while|switch|unless)\b\s*/, "").replace(/\s*(else\s*)?\{\s*$/, "").trim();
  const inner = /^\((.*)\)$/.exec(e)?.[1];
  return clip(inner ?? e, 120);
}
var namesIn = (s) => [...new Set((s.match(/[A-Za-z_$][\w$]{3,}/g) ?? []).filter((n) => !NOT_NAMES2.has(n)))];
function gatesOf(f) {
  const what = /The gated code touches ([^.]+?)\.(?:\s|$)/.exec(f.why)?.[1] ?? /\bgates (.+?) at [\w./-]+:\d+/.exec(f.why)?.[1];
  return what ? `gated code that touches ${clip(what, 100)}` : void 0;
}
async function removedConditionsSince(ctx, baseRef, includeTests) {
  if (!safeRef(baseRef)) return [];
  const status = await git(ctx.root, ["diff", "--name-status", "--no-renames", "--no-ext-diff", "--no-textconv", baseRef, "--"]);
  if (!status) return [];
  const changed = /* @__PURE__ */ new Map();
  for (const l of status.split("\n")) {
    const [code, file2] = l.split("	");
    if (!code || !file2) continue;
    if (!includeTests && isTestPath(file2)) continue;
    if (CONDITION_EXTS.has(extOf(file2))) changed.set(file2, code);
  }
  if (!changed.size) return [];
  const files = ctx.files.filter((f) => !changed.has(f.path));
  for (const [rel, code] of changed) {
    if (code.startsWith("A") || /[\0:]/.test(rel)) continue;
    const text = await git(ctx.root, ["show", "--no-textconv", `${baseRef}:${rel}`]);
    if (text === void 0 || text.length > MAX_BASE_FILE || text.includes("\0")) continue;
    const ext = extOf(rel);
    files.push({ path: rel, abs: path6.join(ctx.root, rel), ext, text, code: stripComments(text, ext) });
  }
  const [before, now] = await Promise.all([conditionFindings({ ...ctx, files }), conditionFindings(ctx)]);
  const out = [];
  for (const f of before) {
    if (!changed.has(f.file) || !f.evidence) continue;
    const condition = conditionOf(f.evidence);
    const names = namesIn(condition);
    if (!names.length) continue;
    const has = (text) => names.every((n) => new RegExp(`(?<![\\w$])${escapeRx2(n)}(?![\\w$])`).test(text));
    if (now.some((g) => g.rule === f.rule && has(g.evidence ?? ""))) continue;
    const cur = ctx.files.find((x) => x.path === f.file);
    if (cur && cur.code.split("\n").some(has)) continue;
    if (out.some((o) => o.file === f.file && o.condition === condition)) continue;
    const gates = gatesOf(f);
    out.push({ rule: f.rule, file: f.file, ...f.line ? { line: f.line } : {}, condition, ...gates ? { gates } : {} });
    if (out.length >= 20) break;
  }
  return out;
}
function rejectionsFor(events, spec, rejectionId) {
  const rejections = foldEvents("", events).rejections;
  if (rejectionId) return { single: rejections.find((r) => r.id === rejectionId), open: [] };
  const key = JSON.stringify(spec);
  const saved = rejections.filter((r) => {
    if (!r.spec) return false;
    const parsed = ResidueSpec.safeParse(r.spec);
    return parsed.success && JSON.stringify(parsed.data) === key;
  });
  if (saved.length) return { single: saved[saved.length - 1], open: [] };
  return { open: rejections.filter((r) => !r.approvedBy && r.outcome === "rejected" && r.reviewerMessage?.trim()) };
}
async function commitBefore(root, at) {
  if (!Number.isFinite(Date.parse(at))) return void 0;
  return (await git(root, ["rev-list", "-1", `--before=${new Date(at).toISOString()}`, "HEAD", "--"]))?.trim() || void 0;
}
async function repoLedgerEvents(root) {
  try {
    return (await readLedger(await locateLedger(root, { remember: false }))).events;
  } catch {
    return [];
  }
}
var FAILING_STATUS = /* @__PURE__ */ new Set(["PRESENT", "GATED", "UNREFERENCED"]);
function tierLabel(v) {
  if (v.tier !== "RESIDUE_FOUND") return v.tier;
  const residue = v.residue.some((r) => r.kind !== "obfuscation" && FAILING_STATUS.has(r.status));
  const open4 = v.inputPaths.some((p) => !p.blocked);
  const why = [residue ? "residue present" : "", open4 ? "input path not blocked" : ""].filter(Boolean).join("; ");
  return why ? `RESIDUE_FOUND (${why})` : v.tier;
}
async function verifyRemediation(root, specIn, opts) {
  const spec = ResidueSpec.parse(specIn);
  const ctx = await loadContext(root, { includeTests: opts.includeTests });
  const needles = needlesOf(spec);
  const st = newSweep();
  const notes = [];
  const files = ctx.files.filter(inSweep);
  for (const f of files) sweepFile(ctx, f, needles, st);
  const pathNeedles = needles.filter((n) => n.kind === "term" || n.kind === "asset" || n.kind === "symbol");
  const matchedDirs = [];
  for (const rel of await listRepoPaths(ctx.root, opts.includeTests)) {
    if (isDocPath(rel) && !isMetadataPath(rel)) continue;
    if (REVIEWER_ONLY.test(rel) || LOCKFILE.test(rel)) continue;
    if (matchedDirs.some((d) => rel.startsWith(`${d}/`))) continue;
    const base = rel.split("/").pop() ?? rel;
    const n = pathNeedles.find((x) => matchNeedle(x, base, 1).length > 0);
    if (!n) continue;
    matchedDirs.push(rel);
    pushHit(st, {
      kind: isMetadataPath(rel) ? "metadata" : n.kind === "symbol" ? "symbol" : n.kind,
      needle: n.value,
      file: rel,
      status: "PRESENT",
      confidence: "high",
      reason: isMetadataPath(rel) ? "A store metadata file or screenshot name still refers to it; check the image and replace it." : /\.xcassets\//.test(rel) ? "An asset catalog entry with this name still ships in the app." : "A file or folder with this name still exists in the project."
    });
  }
  for (const f of files) obfuscationSweep(f, needles, st);
  const unverifiable = unverifiableCalls(ctx, files);
  const sitesAll = aiSites(ctx);
  const sites = sitesAll.moderation;
  const blocking = blockingEvidence(spec, st, sites, sitesAll.sinks);
  const generationLeft = sitesAll.sinks.length > 0 || unverifiable.length > 0 || st.residue.some((r) => r.kind === "obfuscation");
  const gitRepo = await isGitRepo(ctx.root);
  const inputPaths = spec.inputPaths.map((p) => judgePath(ctx, p, p, blocking, generationLeft));
  for (const cp of spec.confirmedPaths) {
    const name = `${cp.source} \u2192 ${cp.sink}`;
    const byState = { present: [], gone: [], "line-only": [] };
    for (const ev of cp.evidence) byState[await refState(ctx.root, ev, opts.baseRef, gitRepo)].push(ev);
    const present = [...byState.present, ...byState["line-only"]];
    if (cp.evidence.length && !present.length) {
      inputPaths.push({ inputPath: name, blocked: true, evidence: [`Traced evidence is no longer in the tree: ${byState.gone.join("; ")}`] });
      continue;
    }
    const judged = judgePath(ctx, name, `${cp.source} \u2192 ${cp.sink}`, blocking, generationLeft, refsIn2(ctx, present.join(" ")));
    if (byState["line-only"].length) {
      judged.evidence.unshift(
        `Traced evidence line still exists, content not checked: ${byState["line-only"].join("; ")}. Record it as "file:line: code on that line" (or pass base_ref) so verify can tell whether the code was removed.`
      );
    }
    if (byState.present.length || !cp.evidence.length) judged.evidence.unshift(`Traced evidence still present: ${byState.present.join("; ") || "(none recorded)"}`);
    inputPaths.push(judged);
  }
  const detectedMissing = [];
  if (generationLeft && sitesAll.sinks.length) {
    const seenSrc = /* @__PURE__ */ new Set();
    for (const src of sitesAll.sources) {
      const key = `${src.label}|${src.file}`;
      if (seenSrc.has(key) || specCovers(spec, src)) continue;
      seenSrc.add(key);
      const link = linkSource(ctx, src, sitesAll.sinks);
      const where = `${src.label} (${src.file}:${src.line})`;
      if (link.traced.length) {
        const at = [...new Set(link.traced.map((x) => `${x.file}:${x.line}`))].join(", ");
        inputPaths.push(judgePath(ctx, `${where} \u2192 AI generation (${at}) [detected; not in the spec]`, `${where} \u2192 AI generation (${at})`, blocking, generationLeft));
        detectedMissing.push(where);
      } else if (link.inferred.length) {
        const files2 = [...new Set(link.inferred.map((x) => x.file))];
        const j = judgePath(ctx, `${where} [detected; not in the spec; sink linkage inferred]`, `${where} \u2192 AI generation (${files2.join(", ")})`, blocking, generationLeft);
        if (j.blocked) {
          inputPaths.push(j);
          detectedMissing.push(where);
        } else {
          unverifiable.push(
            `${where} is not in the spec. It shares a view or type with the generation call in ${files2.join(", ")}, but no data flow from it to that call was found (sink linkage inferred). Trace it, and list it in inputPaths if it reaches a generator.`
          );
        }
      }
    }
  }
  let sha;
  let removedInDiff = [];
  let removedFilterLines = 0;
  let replacedInDiff = 0;
  let diffStat;
  let removedConditions = [];
  if (gitRepo) {
    sha = (await git(ctx.root, ["rev-parse", "HEAD"]))?.trim() || void 0;
    if (opts.baseRef) {
      const d = await diffEvidence(ctx, opts.baseRef, needles);
      removedInDiff = d.removed;
      removedFilterLines = d.filterLines;
      diffStat = d.stat;
      if (d.error) notes.push(`Diff evidence unavailable: ${d.error}.`);
      else removedConditions = await removedConditionsSince(ctx, opts.baseRef, opts.includeTests ?? false);
      for (const r of d.replaced) {
        replacedInDiff++;
        pushHit(st, {
          kind: r.needle.kind,
          needle: r.needle.value,
          file: r.file,
          line: r.line,
          evidence: r.after.trim(),
          status: "PRESENT",
          confidence: "medium",
          reason: `The line was changed, not removed: "${clip(r.before.trim(), 80)}" now reads "${clip(r.after.trim(), 80)}" ("${r.needle.value}" replaced by "${clip(r.replacement, 40)}"). Renaming does not remove a capability (2.5.19); remove what this line provides.`
        });
      }
      for (const r of d.renamedFiles) {
        replacedInDiff++;
        pushHit(st, {
          kind: r.needle.kind,
          needle: r.needle.value,
          file: r.to,
          status: "PRESENT",
          confidence: "medium",
          reason: `${r.from} was renamed to ${r.to}, not deleted (git matched at least half of its content). Renaming does not remove a capability (2.5.19); remove what the file provides.`
        });
      }
    }
  } else if (opts.baseRef) {
    notes.push("Diff evidence unavailable: the project is not a git repository.");
  }
  let built;
  if (opts.builtProductPath) {
    try {
      built = await sweepBuiltProduct(opts.builtProductPath, spec);
      const filterTerms = /* @__PURE__ */ new Set([...[...st.blocklists.values()].filter((b) => b.used).flatMap((b) => [...b.terms]), ...[...st.moderationKeys.values()].flatMap((t) => [...t])]);
      let skipped = 0;
      for (const h of built.matches) {
        if (h.kind === "term" && filterTerms.has(h.needle.toLowerCase())) {
          skipped++;
          continue;
        }
        pushHit(st, {
          kind: "binary",
          needle: h.needle,
          file: `${path6.basename(opts.builtProductPath)}/${h.file}`,
          evidence: h.evidence,
          status: "PRESENT",
          confidence: "medium",
          reason: "Found in the built product; anything in the bundle can be reached or inspected after review."
        });
      }
      if (skipped) built.notes.push(`${skipped} built-product matches were terms that also appear in a used blocklist or a moderation category check in the source, so they were not counted.`);
      built.hits = built.matches.length - skipped;
    } catch (e) {
      notes.push(`Built product sweep failed: ${e.message}`);
    }
  }
  const validation = await validateSpec(ctx, spec);
  let neverExisted = false;
  if (gitRepo && needles.length && !st.residue.length && !st.excluded && !removedInDiff.length && !replacedInDiff) {
    let seen = false;
    for (const n of needles.slice(0, 8)) {
      const probe2 = n.kind === "asset" ? n.value.replace(/[*?].*$/, "") : n.value;
      if (probe2.length >= 3 && await inGitHistory(ctx.root, probe2)) {
        seen = true;
        break;
      }
    }
    neverExisted = !seen;
  }
  const events = opts.ledgerEvents ?? await repoLedgerEvents(root);
  const target = opts.rejectionText ? { open: [] } : rejectionsFor(events, spec, opts.rejectionId);
  const rejectionText = opts.rejectionText ?? target.single?.reviewerMessage;
  let grounding;
  const groundAgainst = rejectionText ? [{ text: rejectionText, at: target.single?.at }] : target.open.map((r) => ({ text: r.reviewerMessage, at: r.at }));
  for (const g of groundAgainst) {
    const ref = gitRepo ? opts.baseRef ?? (g.at ? await commitBefore(ctx.root, g.at) : void 0) ?? "HEAD" : void 0;
    const r = await specGrounding(ctx, spec, g.text, ref);
    if (!r.checked) continue;
    grounding = r;
    if (r.grounded) break;
  }
  const forRejection = opts.rejectionText !== void 0 || opts.rejectionId !== void 0 || !!target.single || target.open.length > 0;
  const unchecked = !grounding && forRejection;
  const ungrounded = !!grounding && !grounding.grounded || unchecked;
  const omitted = /* @__PURE__ */ new Map();
  if (rejectionText) {
    const have = new Set(spec.terms.map((t) => t.toLowerCase().trim()));
    const extra = termsFromRejection(rejectionText).terms.filter((t) => !isContextTerm(t) && t.origin !== "quoted" && !have.has(t.term)).map((t) => makeNeedle("term", t.term)).filter((n) => !!n);
    const side = newSweep();
    for (const f of files) sweepFile(ctx, f, extra, side);
    for (const h of side.residue) {
      if (h.status === "DEBUG_ONLY") continue;
      const at = omitted.get(h.needle) ?? [];
      if (at.length < 3) at.push(`${h.file}${h.line ? `:${h.line}` : ""}`);
      omitted.set(h.needle, at);
    }
  }
  const residue = st.residue;
  const failing = residue.filter((r) => r.kind !== "obfuscation" && (r.status === "PRESENT" || r.status === "GATED" || r.status === "UNREFERENCED"));
  const openPaths = inputPaths.filter((p) => !p.blocked);
  const obfuscation = residue.filter((r) => r.kind === "obfuscation");
  let tier = failing.length || openPaths.length ? "RESIDUE_FOUND" : obfuscation.length || unverifiable.length ? "UNVERIFIABLE" : "STATIC_CLEAN";
  const nothingToSweep = !needles.length;
  const pathsMissing = !spec.inputPaths.length && !spec.confirmedPaths.length && sitesAll.sinks.length > 0 && sitesAll.sources.length > 0;
  const specProblems = gitRepo ? validation.problems : validation.problems.filter((x) => !/does not exist|past the end/.test(x));
  const specInvalid = specProblems.length > 0;
  const incomplete = nothingToSweep || pathsMissing || specInvalid || neverExisted || omitted.size > 0 || ungrounded;
  if (incomplete && tier === "STATIC_CLEAN") tier = "UNVERIFIABLE";
  const buildClean = !!built && built.hits === 0 && !built.encrypted && built.complete;
  if (tier === "STATIC_CLEAN" && buildClean) tier = "BUILD_CLEAN";
  const probe = opts.probe;
  const probePasses = !!probe && probe.total >= MIN_PROBES && probe.blocked === probe.total;
  const confirmedBy = probe ? probeConfirmation(events, probe.resultsHash) : void 0;
  if (probePasses && confirmedBy && (tier === "STATIC_CLEAN" || tier === "BUILD_CLEAN")) tier = "PROBED";
  const count = (s2) => residue.filter((r) => r.kind !== "obfuscation" && r.status === s2).length;
  const s = [];
  const fileCount = new Set(residue.filter((r) => r.kind !== "obfuscation").map((r) => r.file)).size;
  if (tier === "RESIDUE_FOUND" && !failing.length && openPaths.length) {
    s.push(
      `Evidence tier: RESIDUE_FOUND (input path not blocked). No residue was found, but ${openPaths.length} input path${openPaths.length === 1 ? "" : "s"} can still reach the capability with no filter, first: ${openPaths[0].inputPath}.`
    );
  } else {
    s.push(`Evidence tier: ${tierLabel({ tier, residue, inputPaths })}.`);
  }
  if (residue.length - obfuscation.length) {
    s.push(
      `The sweep found ${residue.length - obfuscation.length} residue matches in ${fileCount} files: ${count("PRESENT")} present, ${count("GATED")} behind a runtime switch, ${count("DEBUG_ONLY")} debug-only, ${count("UNREFERENCED")} in unreferenced code.`
    );
  } else {
    s.push(`The sweep found no residue matches in code, strings, assets, configuration, bundled prompts, in-repo server code${files.some((f) => isMetadataPath(f.path)) ? " or the store metadata in the repo" : ""}.`);
  }
  if (count("GATED")) s.push("Gated residue fails verification: a runtime switch can turn the feature back on after review.");
  if (count("UNREFERENCED")) s.push("Unreferenced matches still ship and count as dormant code under 2.5.19; delete them.");
  if (count("DEBUG_ONLY")) s.push("Debug-only matches: delete them too, so a build-setting change cannot ship them.");
  if (replacedInDiff) s.push(`${replacedInDiff} line(s) or file(s) matching the spec were changed or renamed in place rather than removed; renaming does not remove a capability (2.5.19).`);
  if (st.excluded) s.push(`${st.excluded} matches were inside blocklists, refusal instructions or moderation category checks and were not counted as residue.`);
  if (st.blocklists.size) {
    const lists = [...st.blocklists].map(([key, b]) => `${key.slice(key.indexOf("#") + 1)} (${b.file}:${b.line}; ${[...b.terms].slice(0, 6).join(", ")}${b.used ? "" : "; no membership test reads it"})`);
    s.push(`Lists treated as filters and not counted as residue: ${lists.slice(0, 6).join("; ")}${lists.length > 6 ? `; and ${lists.length - 6} more` : ""}.`);
  }
  if (st.moderationKeys.size) {
    const keys = [...st.moderationKeys].map(([at, t]) => `${at} (${[...t].slice(0, 4).join(", ")})`);
    s.push(`Moderation category keys treated as filters and not counted as residue: ${keys.slice(0, 6).join("; ")}${keys.length > 6 ? `; and ${keys.length - 6} more` : ""}.`);
  }
  if (st.truncated) s.push(`Only the first ${MAX_RESIDUE} matches were recorded.`);
  if (inputPaths.length) {
    s.push(`${inputPaths.length - openPaths.length} of ${inputPaths.length} input paths have blocking evidence in the repo.`);
    for (const p of openPaths.slice(0, 3)) s.push(`Not blocked: ${p.inputPath}.`);
  } else {
    s.push("The spec lists no input paths, so no path to the capability was checked for a filter.");
  }
  if (detectedMissing.length) s.push(`${detectedMissing.length} input source(s) the scan detected are not in the spec and were checked anyway: ${detectedMissing.slice(0, 4).join("; ")}.`);
  if (obfuscation.length) s.push(`${obfuscation.length} obfuscation signals (encoded blobs, decoding helpers or runtime-fetched prompts) limit the tier to UNVERIFIABLE at best; obfuscation is itself grounds for removal under 2.5.19.`);
  if (unverifiable.length) s.push(`${unverifiable.length} items depend on servers or prompts outside this repo and need a developer attestation.`);
  if (removedInDiff.length) s.push(`The diff from ${opts.baseRef} removed ${removedInDiff.length} lines or files matching the spec${diffStat ? ` (${diffStat})` : ""}.`);
  else if (opts.baseRef && gitRepo && !notes.length) s.push(`The diff from ${opts.baseRef} removed nothing that matches the spec.`);
  if (removedConditions.length) {
    s.push(
      `The diff from ${opts.baseRef} removed ${removedConditions.length} review-time condition${removedConditions.length === 1 ? "" : "s"} that changed what App Review saw: ${removedConditions.slice(0, 4).map((c) => `${c.condition} at ${c.file}${c.line ? `:${c.line}` : ""} (${c.rule})`).join("; ")}. Disclose each removal factually in the review notes (2.5.19).`
    );
  }
  if (removedFilterLines) s.push(`${removedFilterLines} removed line(s) matching the spec were filter lists or refusal instructions, not the capability, and are not counted as removed.`);
  if (built) {
    s.push(`Built product (${built.kind}) sweep: ${built.hits} matches${built.hermes ? "; the JS bundle is Hermes bytecode, so only its string table was checked" : ""}${built.encrypted ? "; the binary is FairPlay-encrypted, so its strings could not be read" : ""}${built.complete ? "" : "; the sweep was incomplete"}.`);
  }
  if (nothingToSweep) {
    s.push("The spec lists no terms, symbols, assets, strings, endpoints, flags or prompt fragments, so nothing about the rejected capability was swept; the tier is capped at UNVERIFIABLE until the spec names what to look for.");
  } else if (pathsMissing) {
    s.push("The spec lists no input paths although the repo has user input and AI generation calls, so no path to the capability was checked for a filter; the tier is capped at UNVERIFIABLE until every input path is listed.");
  }
  if (specInvalid) s.push(`The spec does not match the repo (${specProblems.slice(0, 3).join(" ")}); the tier is capped at UNVERIFIABLE until it is corrected.`);
  if (ungrounded && grounding) {
    s.push(
      `The spec is not grounded in the rejection: none of its terms, symbols, assets or input-path files appear in the pre-fix code${grounding.ref ? ` (${grounding.ref.slice(0, 12)})` : ""} next to the terms find_surface derives from App Review's message (${grounding.terms.slice(0, 6).join(", ")}${grounding.terms.length > 6 ? ", \u2026" : ""}). Removing entries that are not tied to the rejection proves nothing about it, so the tier is capped at UNVERIFIABLE and the open rejection stays on HOLD. Save a spec with entries find_surface found${opts.baseRef ? "" : " (pass base_ref: the commit before the fix)"}, or the developer can acknowledge the rejection with \`appstore-shield ack\` in a terminal.`
    );
  } else if (unchecked) {
    const missing = !groundAgainst.some((g) => g.text?.trim());
    s.push(
      `The spec is not grounded in the rejection: App Review's message for it ${missing ? "is not recorded in the ledger" : "names nothing find_surface can search the pre-fix code for"}, so none of the spec's entries can be shown to be what was rejected. Removing entries that are not tied to the rejection proves nothing about it, so the tier is capped at UNVERIFIABLE and the open rejection stays on HOLD. Import App Review's full message (shield_ledger_import) and verify again, or the developer can acknowledge the rejection with \`appstore-shield ack\` in a terminal.`
    );
  } else if (grounding?.grounded && grounding.via) {
    s.push(`The spec is tied to the rejection: ${grounding.via}.`);
  }
  if (neverExisted) s.push("Nothing the spec names appears in the repo now, in the diff, or anywhere in its git history, so the spec does not describe this app's feature; the tier is capped at UNVERIFIABLE.");
  if (omitted.size) {
    s.push(
      `The spec leaves out terms from App Review's message that still appear in shipping code: ${[...omitted].slice(0, 6).map(([t, at]) => `${t} (${at.join(", ")})`).join("; ")}. The tier is capped at UNVERIFIABLE until the spec includes them.`
    );
  }
  if (probe) {
    const verdict = probePasses ? "" : probe.total < MIN_PROBES ? `; at least ${MIN_PROBES} prompts, all blocked, are needed for PROBED` : "; every prompt must be blocked for PROBED";
    s.push(
      confirmedBy ? `The developer states (confirmed in ${confirmedBy}) that their probe run blocked ${probe.blocked} of ${probe.total} prompts${verdict}. Probe results cover only the prompts tried.` : `Probe results supplied to the tool mark ${probe.blocked} of ${probe.total} prompts blocked${verdict}. They are not counted until the developer confirms them in a terminal: \`appstore-shield attest --statement "my own probe run produced results ${probe.resultsHash.slice(0, 12)}"\`. Probe results cover only the prompts tried.`
    );
  }
  if (spec.metadataSurfaces.length) {
    const swept = new Set(files.map((f) => f.path));
    const inRepo = (surface) => {
      const p = /^[\w@+.-][\w@+./-]*/.exec(surface.trim())?.[0]?.replace(/^\.\//, "").replace(/\/$/, "");
      return !!p && p.includes("/") && (swept.has(p) || files.some((f) => f.path.startsWith(`${p}/`)));
    };
    const checked = spec.metadataSurfaces.filter(inRepo);
    const outside = spec.metadataSurfaces.filter((x) => !inRepo(x));
    if (checked.length) s.push(`Store metadata files in the repo were swept with the code: ${checked.slice(0, 6).join(", ")}${checked.length > 6 ? `, and ${checked.length - 6} more` : ""}.`);
    s.push(
      `Confirm the live App Store Connect copy, screenshots and previews match the repo metadata${outside.length ? `; these surfaces are not in the repo and were not checked: ${outside.slice(0, 6).join(", ")}${outside.length > 6 ? `, and ${outside.length - 6} more` : ""}` : ""}.`
    );
  }
  s.push(...notes);
  s.push("This is evidence about the code and bundle only; it does not show what the model behind the app will produce.");
  return {
    at: opts.now,
    sha,
    baseRef: opts.baseRef,
    tier,
    removedInDiff,
    ...removedConditions.length ? { removedConditions } : {},
    residue,
    inputPaths,
    unverifiable,
    builtProduct: built ? { path: built.path, kind: built.kind, hermes: built.hermes, hits: built.hits, notes: built.notes } : void 0,
    probe,
    summary: s.join(" ")
  };
}

// src/scanners/accountDeletion.ts
var shipped = (f) => isCode(f) && !NON_SHIPPING_PATH.test(f.path);
var deletionSurface = (f) => (isUiText(f) || f.ext === "json") && !NON_SHIPPING_PATH.test(f.path);
var check5 = {
  id: "account_deletion",
  title: "In-app account deletion",
  guidelines: ["5.1.1(v)"],
  async run(ctx) {
    const findings = [];
    const creation = ACCOUNT_CREATION.map((c) => ({ label: c.label, hit: firstMatch(ctx, c.rx, shipped) })).filter((c) => c.hit);
    const deletion = firstMatch(ctx, ACCOUNT_DELETION, deletionSurface);
    const first = creation[0]?.hit;
    if (first && !deletion) {
      findings.push(
        finding({
          rule: "account_deletion.missing",
          severity: "high",
          guideline: "5.1.1(v)",
          file: first.file.path,
          line: first.line,
          evidence: first.text,
          why: `The app lets users create an account (${creation.map((c) => c.label).join(", ")}) but no in-app account deletion path was found (deleteAccount, user.delete(), auth.admin.deleteUser, a "Delete Account" control). 5.1.1(v) requires apps that support account creation to let users initiate deletion of the account and its data from within the app.`,
          fix: 'Add an in-app "Delete Account" flow that deletes the account and its associated data (not just deactivation), reachable from account settings.',
          confidence: "medium"
        })
      );
    }
    const siwa = firstMatch(ctx, SIWA, shipped);
    if (siwa && deletion && !firstMatch(ctx, SIWA_REVOKE, (f) => isCode(f) || f.ext === "json")) {
      findings.push(
        finding({
          rule: "account_deletion.siwa_revoke",
          severity: "info",
          guideline: "5.1.1(v)",
          file: siwa.file.path,
          line: siwa.line,
          evidence: siwa.text,
          why: "The app uses Sign in with Apple and has account deletion, but no call to Apple's token revocation endpoint was found in this repo. Apple expects deletion to revoke the user's Sign in with Apple tokens; this may happen on a server outside the repo.",
          fix: "Disclose or confirm: on account deletion, revoke the Sign in with Apple token via the REST API (appleid.apple.com/auth/revoke) on your server.",
          confidence: "low"
        })
      );
    }
    return {
      findings,
      data: {
        accountCreation: creation.map((c) => ({ via: c.label, file: c.hit.file.path, line: c.hit.line })),
        deletionPath: deletion ? { file: deletion.file.path, line: deletion.line } : null
      }
    };
  }
};

// src/scanners/aiDataDisclosure.ts
var PER_KIND = 10;
function tokens(ident) {
  return ident.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(/[\s_.\-]+/).map((t) => t.toLowerCase()).filter(Boolean);
}
function isAiConsentIdent(ident) {
  if (!CONSENT_WORD.test(ident)) return false;
  if (/third_?party/i.test(ident)) return true;
  return tokens(ident).some((t) => AI_TOKENS.has(t));
}
function isDisclosureProse(s) {
  if (!/\s/.test(s.trim())) return false;
  return (AI_ACRONYM.test(s) || AI_PARTY.test(s)) && SHARE_VERB.test(s) || AI_PARTY.test(s) && ANALYZE_VERB.test(s);
}
function consentEvidence(ctx) {
  const out = [];
  const shipped2 = isShippedText(ctx);
  const push = (f, index, kind) => {
    if (out.length < PER_KIND) out.push({ file: f.path, line: lineAt(f, index), text: redact(lineTextAt(f, index)).slice(0, 200), kind });
  };
  for (const f of productFiles(ctx).filter(shipped2)) {
    if (MARKETING_PATH.test(f.path)) continue;
    for (const lit of literalsOf2(f)) {
      const v = lit.value.trim();
      if (isDisclosureProse(v)) push(f, lit.index, "disclosure-text");
      else if (/^[A-Za-z_][\w.-]*$/.test(v) && isAiConsentIdent(v)) push(f, lit.index, "consent-key");
    }
    if (isCode2(f)) {
      for (const m of maskedOf(f).matchAll(/\b[A-Za-z_][A-Za-z0-9_]{3,}\b/g)) {
        if (isAiConsentIdent(m[0])) push(f, m.index ?? 0, "consent-state");
      }
    }
    if (out.length >= PER_KIND) break;
  }
  return out;
}
var check6 = {
  id: "ai_data_disclosure",
  title: "Disclosure of user data sent to third-party AI",
  guidelines: ["5.1.2(i)", "4.7.3"],
  async run(ctx) {
    const s = analyzeAiSurface(ctx);
    const cloud = s.providers.filter((p) => p.kind === "cloud");
    if (cloud.length === 0) return { findings: [], data: { applies: false } };
    const cloudIds = new Set(cloud.map((p) => p.id));
    const cloudSinks = s.sinks.filter((x) => x.provider === void 0 || cloudIds.has(x.provider));
    const textToModel = cloudSinks.some((x) => x.kind === "text" || x.kind === "generation");
    const kinds = /* @__PURE__ */ new Set();
    for (const src of s.sources) {
      if (src.kind === "photo" || src.kind === "camera") kinds.add("photos");
      else if (src.kind === "mic") kinds.add("voice");
      else if (src.kind === "text" && textToModel) kinds.add("text");
      else if (src.kind === "health" && textToModel) kinds.add("health data");
      else if (src.kind === "calendar" && textToModel) kinds.add("calendar events");
    }
    const consent = consentEvidence(ctx);
    const data = {
      applies: kinds.size > 0,
      providers: cloud.map((p) => p.name),
      dataKinds: [...kinds],
      sources: s.sources.slice(0, 30),
      sinks: cloudSinks.slice(0, 30),
      consent,
      note: `${s.note} Consent evidence is not checked for ordering: confirm it appears before the first upload.`
    };
    if (kinds.size === 0 || consent.length > 0) return { findings: [], data };
    const anchor = primarySink(cloudSinks) ?? cloudSinks[0] ?? cloud[0]?.evidence[0];
    const names = cloud.map((p) => p.name).join(", ");
    return {
      findings: [
        finding({
          rule: "ai.undisclosed_sharing",
          severity: "high",
          guideline: "5.1.2(i)",
          ...anchor ? { file: anchor.file, line: anchor.line, evidence: anchor.text } : {},
          why: `The app collects user ${[...kinds].join(", ")} and calls a third-party AI service (${names}), but no consent screen, alert, persisted AI consent or string naming AI / the provider / third-party sharing was found. 5.1.2(i) requires clearly disclosing that personal data is shared with third-party AI and obtaining explicit permission first (4.7.3 for chatbot data sharing).` + (kinds.has("health data") ? " The app also reads HealthKit or health data; 5.1.3 limits sharing health data with third parties and requires the user's consent first." : ""),
          fix: `Disclose in the app, before the first upload, that ${[...kinds].join(", ")} are sent to ${names} (a third-party AI service) and for what purpose, ask for explicit permission, and disclose the same in the privacy policy and App Privacy details.`,
          // Photos, voice, health and calendar records are personal data on their face; typed text may or may not reach the model.
          confidence: kinds.has("photos") || kinds.has("voice") || kinds.has("health data") || kinds.has("calendar events") ? "medium" : "low"
        })
      ],
      data
    };
  }
};

// src/scanners/otaUpdates.ts
var JS_EXTS3 = /* @__PURE__ */ new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs"]);
var NATIVE_EXTS = /* @__PURE__ */ new Set(["swift", "m", "mm", "h"]);
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return void 0;
  }
}
function obj(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : void 0;
}
function str(v) {
  if (typeof v === "string") return v;
  const o = obj(v);
  if (o && typeof o.policy === "string") return `policy:${o.policy}`;
  return void 0;
}
function upsert(map, provider, source) {
  const cur = map.get(provider) ?? { provider, sources: [], enabled: true, usage: [] };
  if (!cur.sources.includes(source)) cur.sources.push(source);
  map.set(provider, cur);
  return cur;
}
function file(ctx, rel) {
  return rel ? ctx.files.find((f) => f.path === rel) : void 0;
}
function detectProviders(ctx) {
  const out = /* @__PURE__ */ new Map();
  const pkgPath = ctx.project.packageJson ?? "package.json";
  const pkg = obj(parseJson(file(ctx, pkgPath)?.text ?? ""));
  if (pkg) {
    const deps = { ...obj(pkg.dependencies), ...obj(pkg.devDependencies) };
    for (const name of Object.keys(deps)) {
      const p = OTA_PACKAGES[name];
      if (p) upsert(out, p, pkgPath);
    }
  }
  const expo = "expo-updates (EAS Update)";
  const cfgFile = file(ctx, ctx.project.expoConfig) ?? ctx.files.find((f) => /^app\.json$/.test(f.path));
  if (cfgFile) {
    if (cfgFile.ext === "json") {
      const root = obj(parseJson(cfgFile.text));
      const cfg = obj(root?.expo) ?? root;
      const updates = obj(cfg?.updates);
      const runtime = str(cfg?.runtimeVersion) ?? str(obj(cfg?.ios)?.runtimeVersion);
      if (updates?.url || out.has(expo)) {
        const p = upsert(out, expo, cfgFile.path);
        if (typeof updates?.url === "string") p.updatesUrl = updates.url;
        if (updates?.enabled === false) p.enabled = false;
        if (typeof updates?.checkAutomatically === "string") p.checkAutomatically = updates.checkAutomatically;
        if (runtime) p.runtimeVersion = runtime;
      }
    } else {
      const t = cfgFile.code;
      const url = /updates\s*:\s*\{[^}]*?\burl\s*:\s*["'`]([^"'`]+)["'`]/.exec(t)?.[1];
      if (url || out.has(expo)) {
        const p = upsert(out, expo, cfgFile.path);
        if (url) p.updatesUrl = url;
        if (/updates\s*:\s*\{[^}]*?\benabled\s*:\s*false/.test(t)) p.enabled = false;
        const rv = /runtimeVersion\s*:\s*(?:["'`]([^"'`]+)["'`]|\{\s*policy\s*:\s*["'`](\w+)["'`])/.exec(t);
        if (rv) p.runtimeVersion = rv[1] ?? `policy:${rv[2]}`;
        const ca = /checkAutomatically\s*:\s*["'`](\w+)["'`]/.exec(t)?.[1];
        if (ca) p.checkAutomatically = ca;
      }
    }
  }
  for (const f of ctx.files.filter((x) => x.path.endsWith("Expo.plist"))) {
    const url = /<key>EXUpdatesURL<\/key>\s*<string>([^<]+)<\/string>/.exec(f.text)?.[1];
    if (!url && !out.has(expo)) continue;
    const p = upsert(out, expo, f.path);
    if (url) p.updatesUrl ??= url;
    if (/<key>EXUpdatesEnabled<\/key>\s*<false\s*\/>/.test(f.text)) p.enabled = false;
    const rv = /<key>EXUpdatesRuntimeVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(f.text)?.[1];
    if (rv) p.runtimeVersion ??= rv;
  }
  const easPath = ctx.files.some((f) => f.path === `${ctx.project.appRoot}/eas.json`) ? `${ctx.project.appRoot}/eas.json` : "eas.json";
  const eas = obj(parseJson(ctx.files.find((f) => f.path === easPath)?.text ?? ""));
  if (eas && out.has(expo)) {
    const channels = /* @__PURE__ */ new Set();
    for (const profile of Object.values(obj(eas.build) ?? {})) {
      const ch = obj(profile)?.channel;
      if (typeof ch === "string") channels.add(ch);
    }
    const p = out.get(expo);
    if (channels.size) p.channels = [...channels];
    if (!p.sources.includes(easPath)) p.sources.push(easPath);
  }
  for (const f of ctx.files.filter((x) => x.path.split("/").pop() === "Info.plist")) {
    if (/<key>CodePushDeploymentKey<\/key>/.test(f.text)) upsert(out, "CodePush", f.path);
  }
  for (const f of ctx.files.filter((x) => x.path.split("/").pop() === "shorebird.yaml")) upsert(out, "Shorebird", f.path);
  const USAGE = [
    [expo, /\bUpdates\.(?:checkForUpdateAsync|fetchUpdateAsync|reloadAsync)\b|\buseUpdates\(\)/],
    ["CodePush", /\bcodePush\s*\(|\b[Cc]odePush\.sync\(/],
    ["Pushy (react-native-update)", /\b(?:checkUpdate|downloadUpdate|switchVersion(?:Later)?)\(|\bPushyProvider\b/],
    ["hot-updater", /\bHotUpdater\.(?:wrap|checkForUpdate|runUpdateProcess)\b/]
  ];
  for (const f of ctx.files.filter((x) => JS_EXTS3.has(x.ext))) {
    for (const [provider, rx] of USAGE) {
      const p = out.get(provider);
      if (!p) continue;
      for (const h of searchFile(f, rx)) p.usage.push({ file: f.path, line: h.line });
    }
  }
  return out;
}
function callArgs(code, open4) {
  const out = [];
  let depth = 0;
  let from = open4 + 1;
  for (let k = open4; k < code.length && k < open4 + 2e3; k++) {
    const ch = code[k];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        out.push(code.slice(from, k).trim());
        return out.filter(Boolean);
      }
    } else if (ch === "," && depth === 1) {
      out.push(code.slice(from, k).trim());
      from = k + 1;
    }
  }
  return out.filter(Boolean);
}
function firstArg(code, open4) {
  return callArgs(code, open4)[0] ?? "";
}
var MAX_SCOPE = 2e4;
var CONTROL_HEADER = /^(?:\}\s*)?(?:else|if|for|while|switch|catch|do|try|guard|repeat|defer|finally|with)\b/;
var CONTINUES_LINE = /(?:[(,=.&|?:+\-*/<[]|=>)$/;
var CONTINUED_LINE = /^(?:\.|\?\.|&&|\|\||\?|:|\))/;
function statementStart2(masked, open4) {
  let depth = 0;
  const floor = Math.max(0, open4 - 2e3);
  for (let k = open4 - 1; k >= floor; k--) {
    const ch = masked[k];
    if (ch === ")" || ch === "]") depth++;
    else if (ch === "(" || ch === "[") depth = Math.max(0, depth - 1);
    else if (ch === "}") {
      if (depth === 0) return k + 1;
      depth++;
    } else if (ch === "{") {
      if (depth === 0) return k + 1;
      depth--;
    } else if (ch === ";" && depth === 0) return k + 1;
    else if (ch === "\n" && depth === 0) {
      const prev = masked.slice(Math.max(floor, k - 200), k).trimEnd();
      const next = masked.slice(k + 1, open4).trimStart();
      if (!CONTINUES_LINE.test(prev) && !CONTINUED_LINE.test(next)) return k + 1;
    }
  }
  return floor;
}
function scopeBefore(f, masked, index) {
  let b = enclosingBraces(f.code, f.ext, index);
  for (let levels = 0; b && levels < 64; levels++) {
    const start = statementStart2(masked, b.open);
    if (!CONTROL_HEADER.test(masked.slice(start, b.open).trim())) return f.code.slice(Math.max(start, index - MAX_SCOPE), index);
    b = enclosingBraces(f.code, f.ext, b.open);
  }
  const lineStart = (n) => {
    let at = index;
    for (let i = 0; i < n && at > 0; i++) at = f.code.lastIndexOf("\n", at - 1);
    return Math.max(0, at);
  };
  const from = Math.max(lineStart(30), index - 4e3);
  let kept = "";
  let depth = 0;
  for (let k = from; k < index; k++) {
    const ch = masked[k];
    if (ch === "{") depth++;
    else if (ch === "}") {
      if (depth === 0) kept = "";
      else depth--;
    } else if (depth === 0) kept += f.code[k];
  }
  return kept;
}
function isVendoredBundle(f) {
  if (/\.min\.[cm]?js$|(^|\/)(vendor|vendors|third[-_]?party)\//i.test(f.path)) return true;
  if (/\/\/[#@] sourceMappingURL=/.test(f.text.slice(-4096))) return true;
  let start = 0;
  for (let nl = f.text.indexOf("\n"); ; nl = f.text.indexOf("\n", start)) {
    const end = nl === -1 ? f.text.length : nl;
    if (end - start > 2e3) return true;
    if (nl === -1) return false;
    start = nl + 1;
  }
}
var LITERAL_ONLY = /^(["'`])[^"'`]*\1$|^@?"[^"]*"$|^(?:NULL|nil|null|RTLD_\w+)$/;
function fromNetwork(arg, window, network, js) {
  if (!arg || LITERAL_ONLY.test(arg)) return false;
  if (/Bundle\.main|mainBundle|pathForResource|url\(forResource|require\(/.test(arg)) return false;
  if (network.test(arg)) return true;
  if (!network.test(window)) return false;
  const id = /^[\s(]*(?:await\s+)?(?:try\s+)?([A-Za-z_$][\w$]*)/.exec(arg)?.[1];
  if (!id) return false;
  const e = id.replace(/\$/g, "\\$");
  const assigned = js ? new RegExp(`\\b${e}\\s*=\\s*[^;\\n]*(?:fetch|axios|\\.text\\(\\)|\\.data\\b|response|res\\.|await|readAsStringAsync|readFile|download)|then\\(\\s*\\(?\\s*${e}\\s*\\)?\\s*=>`) : new RegExp(`\\b${e}\\s*=\\s*[^\\n]*(?:String\\(data:|String\\(contentsOf:|NSString\\(data:|initWithData:|data|response|download)|\\(\\s*${e}\\s*,`);
  return assigned.test(window);
}
function remoteCode(ctx) {
  const out = [];
  for (const f of productFiles(ctx).filter(isCodeFile2)) {
    if (SERVER_PATH2.test(f.path)) continue;
    let masked;
    const scope = (index) => scopeBefore(f, masked ??= blankStrings(f.code, f.ext), index);
    let vendored;
    const push = (r) => out.push({ file: f.path, ...r, ...(vendored ??= isVendoredBundle(f)) ? { vendored: true } : {} });
    if (JS_EXTS3.has(f.ext)) {
      for (const h of searchFile(f, /\b(?:eval|new\s+Function|Function)\s*\(/)) {
        if (debugOnlyAt(f, h.index)) continue;
        const args = callArgs(f.code, h.index + h.match.length - 1);
        const arg = (h.match.includes("Function") ? args[args.length - 1] : args[0]) ?? "";
        if (fromNetwork(arg, scope(h.index), JS_NETWORK, true))
          push({ line: h.line, kind: h.match.includes("Function") ? "new Function on fetched text" : "eval of fetched text", evidence: h.text });
      }
    }
    if (NATIVE_EXTS.has(f.ext)) {
      const jsc = /JSContext|JavaScriptCore/.test(f.code);
      if (jsc) {
        for (const h of searchFile(f, /\.evaluateScript\s*\(|\bevaluateScript:\s*/)) {
          const arg = h.match.endsWith("(") ? firstArg(f.code, h.index + h.match.length - 1) : /^([^\]\s]+)/.exec(f.code.slice(h.index + h.match.length))?.[1] ?? "";
          if (fromNetwork(arg, scope(h.index), NATIVE_NETWORK, false))
            push({ line: h.line, kind: "JavaScriptCore evaluateScript on downloaded code", evidence: h.text });
        }
      }
      for (const h of searchFile(f, /\bdlopen\s*\(|Bundle\(\s*(?:path|url):[^)]*\)\??\.load\(\)|bundleWithPath:[^\]]*\]\s*load\]/)) {
        const arg = h.match.startsWith("dlopen") ? firstArg(f.code, h.index + h.match.length - 1) : h.match;
        if (LITERAL_ONLY.test(arg)) continue;
        if (DOWNLOADED_PATH.test(scope(h.index)))
          push({ line: h.line, kind: "loading a downloaded binary (dlopen / Bundle.load)", evidence: h.text });
      }
    }
  }
  return out;
}
var check7 = {
  id: "ota_updates",
  title: "Over-the-air updates and downloaded code",
  guidelines: ["2.5.2", "2.5.19", "DPLA 3.2(e)"],
  async run(ctx) {
    const findings = [];
    const providers = [...detectProviders(ctx).values()];
    const rc = remoteCode(ctx);
    const hotpatch = [];
    for (const f of ctx.files.filter((x) => isCodeFile2(x) || x.path.split("/").pop() === "Podfile" || x.path.endsWith("Package.resolved") || x.path.endsWith("Package.swift"))) {
      for (const h of searchFile(f, NATIVE_HOTPATCH)) hotpatch.push({ file: f.path, line: h.line, evidence: h.text });
    }
    for (const p of providers.filter((x) => x.enabled)) {
      const details = [p.updatesUrl && `update URL ${p.updatesUrl}`, p.runtimeVersion && `runtimeVersion ${p.runtimeVersion}`, p.channels?.length && `channels ${p.channels.join(", ")}`].filter(Boolean).join("; ");
      findings.push(
        finding({
          rule: "ota_updates.present",
          severity: "info",
          guideline: "2.5.2",
          file: p.sources[0],
          evidence: `${p.provider}${details ? ` (${details})` : ""}`,
          why: `The app can receive over-the-air JavaScript/asset updates via ${p.provider}. Apple allows downloaded code only when it does not add or change features or the app's purpose (2.5.2), and 2.5.19 / DPLA 3.2(e) treat post-review changes as concealment when they are not disclosed. Each OTA publish is drift from the approved build.`,
          fix: `Disclose the OTA mechanism (${p.provider}) in Notes for Review; describe its scope only as the developer's statement. Record each publish in the ledger so drift against the last approved snapshot can be checked. An OTA update may only fix bugs (2.5.2); ship any feature or content change in a build that goes through App Review.`,
          confidence: "high"
        })
      );
    }
    for (const r of rc) {
      if (r.vendored) {
        findings.push(
          finding({
            rule: "ota_updates.remote_code",
            severity: "high",
            guideline: "2.5.2",
            file: r.file,
            line: r.line,
            evidence: r.evidence,
            why: `${r.kind} in a minified or vendored library. Libraries such as PDF renderers build functions from text they generate themselves, which is allowed; running code downloaded after review is not (2.5.2, 2.5.19, DPLA 3.2(e)). The scan cannot tell which this is.`,
            fix: "Confirm the library only evaluates text it generates from bundled data. If it can run code fetched from a server, remove that path and ship the logic in the binary for review; otherwise suppress this finding with that reason.",
            confidence: "low"
          })
        );
        continue;
      }
      findings.push(
        finding({
          rule: "ota_updates.remote_code",
          severity: "block",
          guideline: "2.5.2",
          file: r.file,
          line: r.line,
          evidence: r.evidence,
          why: `${r.kind}: the app runs code it downloads, so its behavior can change after review without a new submission (2.5.2, 2.5.19, DPLA 3.2(e)).`,
          fix: "Remove the downloaded-code path and ship the logic in the binary for review.",
          confidence: "medium",
          suppressible: false
        })
      );
    }
    for (const h of hotpatch) {
      findings.push(
        finding({
          rule: "ota_updates.native_hotpatch",
          severity: "block",
          guideline: "2.5.2",
          file: h.file,
          line: h.line,
          evidence: h.evidence,
          why: "A native hot-patching framework can rewrite compiled app behavior after review. Apple rejects these under 2.5.2.",
          fix: "Remove the hot-patching framework and ship fixes as reviewed app updates.",
          confidence: "high",
          suppressible: false
        })
      );
    }
    const data = { present: providers.some((p) => p.enabled) || rc.length > 0 || hotpatch.length > 0, providers, remoteCode: rc, nativeHotpatch: hotpatch };
    return { findings, data: { ota: data } };
  }
};

// src/scanners/paywall.ts
var GUIDE_PRICE = "DPLA Schedule 2 \xA73.8(b)";
function resolveRepoPath(dir, rel) {
  const parts = dir ? dir.split("/") : [];
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return void 0;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}
function missingLocalPackages(ctx) {
  const out = /* @__PURE__ */ new Set();
  for (const f of ctx.files) {
    const pkg = /(^|\/)Package\.swift$/.test(f.path);
    const pbx = f.path.endsWith(".xcodeproj/project.pbxproj");
    if (!pkg && !pbx) continue;
    const base = pbx ? f.path.replace(/\/?[^/]*\.xcodeproj\/project\.pbxproj$/, "") : f.path.replace(/\/?Package\.swift$/, "");
    for (const m of f.code.matchAll(LOCAL_PACKAGE_PATH)) {
      const rel = (m[1] ?? m[2] ?? "").trim();
      if (!rel) continue;
      const dir = resolveRepoPath(base, rel);
      if (dir === void 0 || !ctx.files.some((x) => x.path.startsWith(`${dir}/`))) out.add(rel);
    }
  }
  return [...out];
}
function isPaywallFile(f) {
  if (!isCode(f) || NON_SHIPPING_PATH.test(f.path)) return false;
  return PURCHASE_CALL.test(f.code) || MANAGED_PAYWALL.test(f.code) || PAYWALL_PATH.test(f.path);
}
function delaySeconds(window) {
  const num = (s) => s === void 0 ? void 0 : Number(s.replace(/_/g, ""));
  let m = /\.now\(\)\s*\+\s*(?:\.seconds\(\s*)?(\d+(?:\.\d+)?)/.exec(window);
  if (m) return num(m[1]);
  m = /\.now\(\)\s*\+\s*\.milliseconds\(\s*(\d+)/.exec(window);
  if (m) return (num(m[1]) ?? 0) / 1e3;
  m = /withTimeInterval:\s*(\d+(?:\.\d+)?)/.exec(window);
  if (m) return num(m[1]);
  m = /nanoseconds:\s*([\d_]+)/.exec(window);
  if (m) return (num(m[1]) ?? 0) / 1e9;
  m = /(?:for:\s*)?\.seconds\(\s*(\d+(?:\.\d+)?)/.exec(window);
  if (m) return num(m[1]);
  m = /^\.delay\(\s*(\d+(?:\.\d+)?)/.exec(window);
  if (m) return num(m[1]);
  m = /^(?:withDelay|Animated\.delay)\s*\(\s*(\d+)/.exec(window);
  if (m) return (num(m[1]) ?? 0) / 1e3;
  m = /\}\s*,\s*(\d+)\s*\)/.exec(window);
  if (m && window.startsWith("setTimeout")) return (num(m[1]) ?? 0) / 1e3;
  return void 0;
}
var check8 = {
  id: "paywall",
  title: "Paywall and subscription disclosures",
  guidelines: ["3.1.1", "3.1.2", GUIDE_PRICE, "5.6"],
  async run(ctx) {
    const findings = [];
    const sdks = PAYWALL_SDKS.filter((s) => ctx.files.some((f) => isCode(f) && s.rx.test(f.code))).map((s) => s.name);
    const purchase = firstMatch(ctx, PURCHASE_CALL, (f) => isCode(f) && !NON_SHIPPING_PATH.test(f.path));
    const managed = firstMatch(ctx, MANAGED_PAYWALL, (f) => isCode(f) && !NON_SHIPPING_PATH.test(f.path));
    if (!sdks.length && !purchase && !managed) {
      return { findings, data: { paywall: false } };
    }
    const paywallFiles = ctx.files.filter(isPaywallFile);
    const uiText = ctx.files.filter((f) => isUiText(f) && !NON_SHIPPING_PATH.test(f.path));
    const inUi = (rx) => uiText.some((f) => rx.test(isCode(f) ? f.code : f.text));
    const subscription = ctx.files.some((f) => isCode(f) && !NON_SHIPPING_PATH.test(f.path) && SUBSCRIPTION_PRODUCT.test(f.code)) || paywallFiles.some((f) => SUBSCRIPTION_LITERAL.test(f.code)) || inUi(RENEWAL_TERMS);
    const nonConsumable = inUi(NON_CONSUMABLE_SIGNAL);
    const consumableOnly = !subscription && !nonConsumable && inUi(CONSUMABLE_SIGNAL);
    const custom = Boolean(purchase);
    const hasRestore = inUi(RESTORE);
    const hasTerms = inUi(TERMS_LINK);
    const hasPrivacy = inUi(PRIVACY_LINK);
    const anchor = purchase ?? managed;
    const subscriptionCode = (f) => isCode(f) && !NON_SHIPPING_PATH.test(f.path) && (SUBSCRIPTION_PRODUCT.test(f.code) || isPaywallFile(f) && SUBSCRIPTION_LITERAL.test(f.code));
    const subAnchor = firstMatch(ctx, PURCHASE_CALL, (f) => subscriptionCode(f)) ?? firstMatch(ctx, MANAGED_PAYWALL, (f) => subscriptionCode(f)) ?? firstMatch(ctx, SUBSCRIPTION_PRODUCT, (f) => subscriptionCode(f) && isPaywallFile(f)) ?? firstMatch(ctx, SUBSCRIPTION_PRODUCT, (f) => subscriptionCode(f)) ?? firstMatch(ctx, SUBSCRIPTION_LITERAL, (f) => subscriptionCode(f)) ?? firstMatch(ctx, RENEWAL_TERMS, (f) => isUiText(f) && !NON_SHIPPING_PATH.test(f.path));
    for (const f of paywallFiles) {
      const readsPrices = DYNAMIC_PRICE.test(f.code);
      const byLine = /* @__PURE__ */ new Map();
      for (const lit of literalsOf(f)) {
        const m = PRICE_LITERAL.exec(lit.value);
        if (!m || !ships(f, lit.index)) continue;
        const dynamic = readsPrices || FALLBACK_CONTEXT.test(f.code.slice(Math.max(0, lit.index - 160), lit.index));
        const prev = byLine.get(lit.line);
        if (prev) {
          prev.prices.push(m[0]);
          prev.dynamic &&= dynamic;
        } else byLine.set(lit.line, { lit, prices: [m[0]], dynamic });
      }
      for (const { lit, prices, dynamic } of byLine.values()) {
        const shown = prices.map((p) => `"${p}"`).join(", ");
        const one = prices.length === 1;
        findings.push(
          finding({
            rule: "paywall.hardcoded_price",
            severity: dynamic ? "medium" : "high",
            guideline: "3.1.2",
            file: f.path,
            line: lit.line,
            evidence: one ? lit.value : prices.join(", "),
            why: dynamic ? `${one ? "A price literal" : "Price literals"} (${shown}) ${one ? "sits" : "sit"} in purchase UI as a fallback or next to product prices; whenever it is shown (for example while products load or offline) it can disagree with the price the user is charged in their storefront. Schedule 2 \xA73.8(b) requires the actual price to be clearly shown.` : `Purchase UI shows ${one ? "a hardcoded price" : "hardcoded prices"} (${shown}) instead of the localized price from the product (displayPrice / localizedPriceString / priceString). Prices differ by storefront and change over time, so the screen can misstate what the user pays (3.1.2, Schedule 2 \xA73.8(b); bait-and-switch pricing is named in DPLA 3.2(f)).`,
            fix: `Remove the ${one ? "literal" : "literals"} and display the price from the product object (StoreKit \`product.displayPrice\`, RevenueCat \`storeProduct.localizedPriceString\`, react-native-iap \`localizedPrice\`).`,
            confidence: dynamic ? "medium" : "high"
          })
        );
      }
    }
    for (const f of paywallFiles) {
      if (DISCOUNT_COMPUTED.test(f.code)) continue;
      for (const lit of literalsOf(f)) {
        const m = DISCOUNT_LITERAL.exec(lit.value);
        if (!m || !ships(f, lit.index)) continue;
        findings.push(
          finding({
            rule: "paywall.hardcoded_discount",
            severity: "medium",
            guideline: "3.1.2",
            file: f.path,
            line: lit.line,
            evidence: lit.value,
            why: `A fixed discount claim ("${m[0]}") is not computed from product prices. When storefront prices or the plan lineup change, the claim becomes false; misleading pricing claims fall under 3.1.2 and DPLA 3.2(f) ("bait-and-switch pricing").`,
            fix: "Remove the fixed percentage, or compute it from the products' actual prices at runtime and show it only when it is true for the user's storefront.",
            confidence: "medium"
          })
        );
      }
    }
    for (const f of paywallFiles) {
      for (const m of f.code.matchAll(DELAY_CALL)) {
        const index = m.index ?? 0;
        const window = f.code.slice(index, index + 450);
        const reveal = CLOSE_REVEAL.exec(window);
        if (!reveal || !ships(f, index)) continue;
        const secs = delaySeconds(window);
        if (secs !== void 0 && secs < 1) continue;
        const line = lineIndex(f.code)(index);
        findings.push(
          finding({
            rule: "paywall.delayed_dismiss",
            severity: "high",
            guideline: "3.1.2",
            file: f.path,
            line,
            evidence: `${f.text.split("\n")[line - 1]?.trim() ?? ""} \u2026 ${reveal[0]}`,
            why: `The paywall's close control appears only after a delay${secs !== void 0 ? ` of ${secs}s` : ""}. Withholding the way out pressures users into a purchase; App Review rejects paywalls that cannot be dismissed immediately (3.1.2, 5.6 manipulative behavior).`,
            fix: "Remove the delay: show the close control as soon as the paywall appears.",
            confidence: secs !== void 0 ? "high" : "medium"
          })
        );
      }
      for (const m of f.code.matchAll(CLOSE_CONTROL)) {
        const index = m.index ?? 0;
        const window = f.code.slice(Math.max(0, index - 160), index + 260);
        const faint = NEAR_INVISIBLE.exec(window);
        if (!faint || !ships(f, index)) continue;
        const line = lineIndex(f.code)(index);
        findings.push(
          finding({
            rule: "paywall.hidden_dismiss",
            severity: "high",
            guideline: "3.1.2",
            file: f.path,
            line,
            evidence: `${f.text.split("\n")[line - 1]?.trim() ?? ""} \u2026 ${faint[0]}`,
            why: "The paywall's close control is drawn fully or nearly transparent, so users cannot find the way out (3.1.2, 5.6 manipulative behavior).",
            fix: "Remove the transparency: give the close control normal contrast from the moment the paywall appears.",
            confidence: "medium"
          })
        );
      }
    }
    if (custom && !managed && anchor) {
      const at = { file: anchor.file.path, line: anchor.line, evidence: anchor.text };
      if (!hasRestore && !consumableOnly) {
        const shippedCode = (f) => isCode(f) && !NON_SHIPPING_PATH.test(f.path);
        const accountBound = ctx.files.some((f) => shippedCode(f) && ACCOUNT_BOUND_PURCHASE.test(f.code));
        const external = !ctx.files.some((f) => shippedCode(f) && STORE_IMPLEMENTATION.test(f.code));
        const missingPkgs = external ? missingLocalPackages(ctx) : [];
        const pkgNote = missingPkgs.length ? ` It depends on local package(s) not in this repo: ${missingPkgs.slice(0, 3).join(", ")}.` : "";
        findings.push(
          finding({
            rule: "paywall.missing_restore",
            severity: accountBound || external ? "medium" : "high",
            guideline: "3.1.1",
            ...at,
            why: external ? `The purchase call (${anchor.file.path}:${anchor.line}) goes through code that is not in this repo: no StoreKit, RevenueCat or react-native-iap purchase API was found here.${pkgNote} Whether purchases can be restored could not be checked from this repo; 3.1.1 requires restorable purchases to be restorable.${accountBound ? " Purchases also appear tied to the user's session or account, so signing in may restore them." : ""}` : accountBound ? "Purchases appear tied to your account (appAccountToken, applicationUsername, a RevenueCat logIn, or a transaction observer configured with the user's session), so signing in may restore them, but no Restore Purchases control was found. A Restore Purchases button is still recommended (3.1.1), and Review Notes should say how a reinstalling user gets their purchase back." : 'The app sells in-app purchases with its own UI, but no restore mechanism was found (AppStore.sync, Purchases.restorePurchases, getAvailablePurchases, a "Restore Purchases" control). 3.1.1 requires restorable purchases to be restorable.',
            fix: external ? 'Check the purchase and restore code where it lives (outside this repo): if no visible "Restore Purchases" control calls `AppStore.sync()` or the SDK\'s restore, add one, and disclose in Review Notes how users restore purchases.' : accountBound ? 'Add a visible "Restore Purchases" control that calls `AppStore.sync()` (StoreKit 2) or `Purchases.shared.restorePurchases()` (RevenueCat), and disclose in Review Notes how signing in restores purchases.' : 'Add a visible "Restore Purchases" control that calls `AppStore.sync()` (StoreKit 2), `Purchases.shared.restorePurchases()` (RevenueCat) or `getAvailablePurchases()` (react-native-iap).',
            confidence: accountBound || external ? "low" : "medium"
          })
        );
      }
      if (subscription && subAnchor) {
        const subAt = { file: subAnchor.file.path, line: subAnchor.line, evidence: subAnchor.text };
        const missing = [!hasTerms && "Terms of Use (EULA) link", !hasPrivacy && "Privacy Policy link"].filter(Boolean);
        if (missing.length) {
          findings.push(
            finding({
              rule: "paywall.missing_legal_links",
              severity: "high",
              guideline: GUIDE_PRICE,
              ...subAt,
              why: `The subscription purchase UI has no ${missing.join(" and no ")}. DPLA Schedule 2 \xA73.8(b) requires functional in-app links to the Terms of Use and the Privacy Policy wherever a subscription is sold.`,
              fix: "Add tappable Terms of Use (EULA) and Privacy Policy links on the paywall itself, next to the purchase button.",
              confidence: "medium"
            })
          );
        }
        const priceShown = inUi(DYNAMIC_PRICE) || inUi(PRICE_LITERAL) || paywallFiles.some((f) => /price/i.test(f.code));
        const terms = [!inUi(PERIOD_DISCLOSURE) && "subscription length (period)", !priceShown && "price"].filter(Boolean);
        if (terms.length) {
          findings.push(
            finding({
              rule: "paywall.missing_subscription_terms",
              severity: "high",
              guideline: GUIDE_PRICE,
              ...subAt,
              why: `The subscription purchase UI does not disclose the ${terms.join(" or the ")}. Schedule 2 \xA73.8(b) requires the title, length and price of the subscription, and 3.1.2(c) requires describing what the user gets before purchase.`,
              fix: "Disclose on the paywall: the subscription length from the product (`product.subscription?.subscriptionPeriod`) and the localized price per period (`product.displayPrice`).",
              confidence: "medium"
            })
          );
        }
        if (!inUi(RENEWAL_TERMS)) {
          findings.push(
            finding({
              rule: "paywall.renewal_wording",
              severity: "medium",
              guideline: "3.1.2",
              ...subAt,
              why: "No wording was found saying the subscription renews automatically until cancelled. App Review commonly asks for the auto-renewal and cancellation terms near the purchase button so users know they will be charged again (3.1.2).",
              fix: "Disclose on the paywall that the subscription renews automatically each period until cancelled in Settings.",
              confidence: "low"
            })
          );
        }
      }
      if (!inUi(TRIAL_DATA) && !inUi(TRIAL_AFTER_TERMS)) {
        for (const f of paywallFiles) {
          const lit = literalsOf(f).find((l) => TRIAL_LITERAL.test(l.value) && ships(f, l.index));
          if (!lit) continue;
          findings.push(
            finding({
              rule: "paywall.trial_terms",
              severity: "high",
              guideline: "3.1.2",
              file: f.path,
              line: lit.line,
              evidence: lit.value,
              why: "The paywall advertises a free trial with hardcoded wording, never reads the product's introductory offer (or the user's eligibility), and never states what is charged when the trial ends. Users who are not eligible, or who do not know the post-trial price, are misled (3.1.2, Schedule 2 \xA73.8(b)).",
              fix: "Disclose the trial from the product's introductory offer (`product.subscription?.introductoryOffer`, `isEligibleForIntroOffer`) and state the price and period that apply after the trial ends; remove trial wording for ineligible users.",
              confidence: "medium"
            })
          );
          break;
        }
      }
    }
    if (managed && !hasTerms && !hasPrivacy) {
      findings.push(
        finding({
          rule: "paywall.managed_policy_links",
          severity: "info",
          guideline: GUIDE_PRICE,
          file: managed.file.path,
          line: managed.line,
          evidence: managed.text,
          why: "A system or RevenueCat paywall shows Terms and Privacy links only from configured URLs (App Store Connect EULA/privacy policy, `.subscriptionStorePolicyDestination`, or the RevenueCat paywall settings). No Terms or Privacy URL was found in the repo.",
          fix: "Disclose: confirm the Terms of Use and Privacy Policy URLs are configured where this paywall reads them, so the links render on the paywall.",
          confidence: "low"
        })
      );
    }
    return {
      findings,
      data: {
        paywall: true,
        sdks,
        managedPaywall: Boolean(managed),
        customPurchaseUI: custom,
        subscription,
        restore: hasRestore,
        termsLink: hasTerms,
        privacyLink: hasPrivacy,
        paywallFiles: paywallFiles.map((f) => f.path)
      }
    };
  }
};

// src/scanners/privacyManifest.ts
function readArray(v) {
  return Array.isArray(v) ? v : [];
}
function addDeclarations(decl, root) {
  if (!root) return;
  if (root.NSPrivacyTracking === true) decl.tracking = true;
  for (const d of readArray(root.NSPrivacyTrackingDomains)) if (typeof d === "string" && d.trim()) decl.trackingDomains.push(d);
  for (const entry of readArray(root.NSPrivacyAccessedAPITypes)) {
    const e = asDict(entry);
    const type = e?.NSPrivacyAccessedAPIType;
    if (typeof type !== "string") continue;
    const reasons = readArray(e?.NSPrivacyAccessedAPITypeReasons).filter((r) => typeof r === "string");
    decl.accessed.set(type, [...decl.accessed.get(type) ?? [], ...reasons]);
  }
}
var VENDOR_BUNDLE = /(^|\/)[^/]+\.(bundle|framework|xcframework)\//;
function readDeclarations(ctx) {
  const decl = { files: [], tracking: false, trackingDomains: [], accessed: /* @__PURE__ */ new Map() };
  for (const f of ctx.files) {
    if (!f.path.endsWith("PrivacyInfo.xcprivacy") || VENDOR_BUNDLE.test(f.path)) continue;
    decl.files.push(f.path);
    addDeclarations(decl, asDict(parsePlist(f.text)));
  }
  let expoConfigured = false;
  const expo = ctx.project.expoConfig ? ctx.files.find((f) => f.path === ctx.project.expoConfig) : void 0;
  if (expo && /\bprivacyManifests\b/.test(expo.code)) {
    expoConfigured = true;
    decl.files.push(expo.path);
    let parsed = false;
    if (expo.ext === "json") {
      try {
        const root = JSON.parse(expo.text);
        const cfg = root.expo ?? root;
        const pm = cfg.ios?.privacyManifests;
        addDeclarations(decl, pm);
        parsed = true;
      } catch {
        parsed = false;
      }
    }
    if (!parsed) {
      if (/NSPrivacyTracking["']?\s*:\s*true/.test(expo.code)) decl.tracking = true;
      for (const m of expo.code.matchAll(/(NSPrivacyAccessedAPICategory\w+)[\s\S]{0,200}?NSPrivacyAccessedAPITypeReasons["']?\s*:\s*\[([^\]]*)\]/g)) {
        const reasons = [...(m[2] ?? "").matchAll(/["']([0-9A-F]{4}\.\d)["']/g)].map((r) => r[1] ?? "");
        decl.accessed.set(m[1] ?? "", [...decl.accessed.get(m[1] ?? "") ?? [], ...reasons]);
      }
      const domains = /NSPrivacyTrackingDomains["']?\s*:\s*\[([^\]]*)\]/.exec(expo.code);
      for (const d of (domains?.[1] ?? "").matchAll(/["']([^"']+)["']/g)) decl.trackingDomains.push(d[1] ?? "");
    }
  }
  return { ...decl, expoConfigured };
}
var NON_APP_PROJECT = /(^|\/)(examples?|samples?|demos?|tests?|playgrounds?)(\/|$)|(Tests?|Example|Demo|Sample)s?\.xcodeproj\//i;
function appProject(ctx) {
  let best;
  let bestScore = -Infinity;
  for (const f of ctx.files) {
    if (!f.path.endsWith(".xcodeproj/project.pbxproj")) continue;
    const score = (/com\.apple\.product-type\.application["';]/.test(f.code) ? 100 : 0) - (NON_APP_PROJECT.test(f.path) ? 200 : 0) - f.path.split("/").length;
    if (score > bestScore) {
      best = f;
      bestScore = score;
    }
  }
  return best;
}
function anchorFile(ctx) {
  const pbx = appProject(ctx);
  if (pbx) return { file: pbx.path };
  if (ctx.project.expoConfig) return { file: ctx.project.expoConfig };
  if (ctx.project.packageJson) return { file: ctx.project.packageJson };
  const swift = ctx.files.find((f) => f.ext === "swift");
  return swift ? { file: swift.path } : {};
}
var MAC_TREE = /^((?:[^/]*\/)*?[^/]*(?:macOS|MacOS|macos|OSX)[^/]*)\//;
var IOS_WORD = /iOS|ios|iPhone|iPad|Shared|Common|Multiplatform/;
var APPKIT_IMPORT = /^[ \t]*import\s+(?:AppKit|Cocoa)\b/m;
var UIKIT_IMPORT = /^[ \t]*import\s+(?:UIKit|WatchKit|TVUIKit)\b/m;
function macOnly(f, manifests) {
  const tree = MAC_TREE.exec(f.path)?.[1];
  const treeName = tree?.slice(tree.lastIndexOf("/") + 1) ?? "";
  if (tree && !IOS_WORD.test(treeName) && !manifests.some((m2) => m2.startsWith(`${tree}/`))) return true;
  if (f.ext !== "swift" || UIKIT_IMPORT.test(f.code)) return false;
  const m = APPKIT_IMPORT.exec(f.code);
  return m !== null && !enclosingConditions(f.code, m.index + m[0].length - 1, f.ext).conditions.some((c) => c.kind === "#if");
}
var dependencyFile = (ctx, f) => f.path === "package.json" || f.path === ctx.project.packageJson || /(^|\/)(Podfile|Package\.resolved|Package\.swift)$/.test(f.path);
var check9 = {
  id: "privacy_manifest",
  title: "Privacy manifest",
  guidelines: ["5.1.1", "5.1.2"],
  async run(ctx) {
    const findings = [];
    const platforms = ctx.project.platforms;
    if (!platforms.some((p) => p === "swift" || p === "react-native" || p === "expo")) {
      return { findings, data: { applicable: false } };
    }
    const decl = readDeclarations(ctx);
    const hasManifest = decl.files.length > 0;
    const missing = (needed) => {
      const prefix = ctx.project.appRoot ? `${ctx.project.appRoot}/` : "";
      const managedExpo = platforms.includes("expo") && !ctx.files.some((f) => f.path.startsWith(`${prefix}ios/`));
      return finding({
        rule: "privacy_manifest.missing",
        severity: needed ? "medium" : "info",
        guideline: "5.1.1",
        ...anchorFile(ctx),
        why: (managedExpo ? "No privacy manifest is configured: there is no PrivacyInfo.xcprivacy and no `ios.privacyManifests` in the Expo config. Apps must declare collected data and required-reason API use in a privacy manifest; App Store Connect may flag or reject uploads (ITMS-91053) that use required-reason APIs without one." : "No PrivacyInfo.xcprivacy was found for the app target. Apps must declare collected data, tracking and required-reason API use in a privacy manifest; App Store Connect may flag or reject uploads (ITMS-91053) that use required-reason APIs without one.") + (needed ? "" : " No required-reason API use or tracking SDK was found in the app's code, so the manifest is advisory until the app or an SDK adds one."),
        fix: managedExpo ? "Add `ios.privacyManifests` to the Expo config disclosing the app's tracking status, collected data types and required-reason API categories with reason codes." : "Add a PrivacyInfo.xcprivacy to the app target that discloses NSPrivacyTracking, NSPrivacyCollectedDataTypes and NSPrivacyAccessedAPITypes with reason codes.",
        confidence: managedExpo ? "low" : "medium"
      });
    };
    const used = [];
    const reported = /* @__PURE__ */ new Set();
    for (const api of REQUIRED_REASON_APIS) {
      if (reported.has(api.category)) continue;
      const exts = new Set(api.exts);
      let hit;
      for (const f of ctx.files) {
        if (!exts.has(f.ext) || NON_SHIPPING_PATH.test(f.path) || macOnly(f, decl.files)) continue;
        for (const m of f.code.matchAll(new RegExp(api.rx.source, "g"))) {
          if (ships(f, m.index ?? 0)) {
            hit = { f, index: m.index ?? 0 };
            break;
          }
        }
        if (hit) break;
      }
      if (!hit) continue;
      reported.add(api.category);
      const line = lineIndex(hit.f.code)(hit.index);
      const evidence = hit.f.text.split("\n")[line - 1]?.trim() ?? "";
      used.push({ category: api.category, label: api.label, file: hit.f.path, line });
      const declared = decl.accessed.get(api.category);
      const codes = api.reasons.join(", ");
      if (!declared) {
        findings.push(
          finding({
            rule: "privacy_manifest.undeclared_required_reason_api",
            severity: "medium",
            guideline: "5.1.1",
            file: hit.f.path,
            line,
            evidence,
            why: `The app calls ${api.label}, a required-reason API, but the privacy manifest does not declare ${api.category}. App Store Connect may flag or reject uploads (ITMS-91053) with undeclared required-reason API use.`,
            fix: `Disclose it: add an NSPrivacyAccessedAPITypes entry with NSPrivacyAccessedAPIType ${api.category} and the reason code(s) that match your use (valid: ${codes}); or remove the API call if it is not needed.`,
            confidence: "medium"
          })
        );
        continue;
      }
      const invalid = declared.filter((r) => !api.reasons.includes(r));
      if (declared.length === 0 || invalid.length) {
        findings.push(
          finding({
            rule: "privacy_manifest.invalid_reason",
            severity: "medium",
            guideline: "5.1.1",
            file: hit.f.path,
            line,
            evidence,
            why: declared.length === 0 ? `${api.category} is declared without any reason code.` : `${api.category} lists reason code(s) that are not valid for it: ${invalid.join(", ")}.`,
            fix: `Disclose the accurate reason: use only the approved codes for ${api.category} (${codes}) that match how the app uses it.`,
            confidence: "high"
          })
        );
      }
    }
    const tracking = [];
    for (const sdk of TRACKING_SDKS) {
      for (const f of ctx.files) {
        if (NON_SHIPPING_PATH.test(f.path)) continue;
        if (!(dependencyFile(ctx, f) || ["swift", "m", "mm", "ts", "tsx", "js", "jsx"].includes(f.ext))) continue;
        const m = sdk.rx.exec(f.code);
        if (m) {
          tracking.push({ name: sdk.name, file: f.path, line: lineIndex(f.code)(m.index) });
          break;
        }
      }
    }
    const firstTracker = tracking[0];
    if (firstTracker && hasManifest && !decl.tracking) {
      findings.push(
        finding({
          rule: "privacy_manifest.tracking_undeclared",
          severity: "medium",
          guideline: "5.1.2",
          file: firstTracker.file,
          line: firstTracker.line,
          evidence: tracking.map((t) => t.name).join(", "),
          why: `The app includes tracking or attribution components (${tracking.map((t) => t.name).join(", ")}) but its privacy manifest does not set NSPrivacyTracking to true. If the app or these SDKs track users as Apple defines it, the manifest and App Privacy details must say so.`,
          fix: "Disclose: if the app tracks, set NSPrivacyTracking to true and list NSPrivacyTrackingDomains; if it does not, remove the tracking SDKs or configure them not to track, and keep App Privacy details consistent.",
          confidence: "low"
        })
      );
    }
    if (!hasManifest) {
      const jsFramework = platforms.some((p) => p === "react-native" || p === "expo") || ctx.files.some((f) => /(^|\/)package\.json$/.test(f.path) && /"(?:@capacitor\/(?:ios|core)|cordova-ios)"\s*:/.test(f.text));
      findings.unshift(missing(jsFramework || used.length > 0 || tracking.length > 0));
    }
    if (decl.tracking && decl.trackingDomains.length === 0) {
      findings.push(
        finding({
          rule: "privacy_manifest.tracking_domains_missing",
          severity: "medium",
          guideline: "5.1.2",
          file: decl.files[0],
          why: "NSPrivacyTracking is true but NSPrivacyTrackingDomains is empty or missing; Apple requires the tracking domains to be listed when tracking is declared.",
          fix: "Disclose the domains the app contacts for tracking in NSPrivacyTrackingDomains.",
          confidence: "high"
        })
      );
    }
    return {
      findings,
      data: {
        applicable: true,
        manifests: decl.files,
        declaredCategories: Object.fromEntries(decl.accessed),
        tracking: decl.tracking,
        requiredReasonUse: used,
        trackingSdks: tracking
      }
    };
  }
};

// src/scanners/ratingsIntegrity.ts
function lineText2(f, line) {
  return f.text.split("\n")[line - 1]?.trim() ?? "";
}
function firstIn(f, rx) {
  const m = new RegExp(rx.source, rx.flags.replace("g", "")).exec(f.code);
  if (!m) return void 0;
  return { index: m.index, line: lineIndex(f.code)(m.index) };
}
var check10 = {
  id: "ratings_integrity",
  title: "Ratings and reviews integrity",
  guidelines: ["5.6.1", "5.6.3", "DPLA 3.2(f)"],
  async run(ctx) {
    const findings = [];
    const code = ctx.files.filter((f) => isCode(f) && !NON_SHIPPING_PATH.test(f.path));
    const reviewSites = [];
    for (const f of code) {
      const system = firstIn(f, SYSTEM_REVIEW);
      const link = firstIn(f, WRITE_REVIEW_LINK);
      if (system) reviewSites.push({ file: f.path, line: system.line, kind: "system" });
      if (link) reviewSites.push({ file: f.path, line: link.line, kind: "link" });
      const ask = system ?? link;
      for (const lit of literalsOf(f)) {
        const m = INCENTIVE_LITERAL.exec(lit.value);
        if (!m || !ships(f, lit.index)) continue;
        findings.push(
          finding({
            rule: "ratings.incentivized_review",
            severity: "block",
            guideline: "5.6.3",
            file: f.path,
            line: lit.line,
            evidence: lit.value,
            why: `The app offers something in return for a rating or review ("${m[0]}"). Incentivized reviews manipulate ratings (5.6.3); the guidelines' introduction and DPLA \xA711.2 treat review manipulation as grounds for removal from the Developer Program.`,
            fix: "Remove the reward entirely: ratings must never unlock content, currency or features.",
            confidence: "high",
            suppressible: false
          })
        );
      }
      if (ask) {
        const rx = new RegExp(`${SYSTEM_REVIEW.source}|${WRITE_REVIEW_LINK.source}`, "g");
        for (const m of f.code.matchAll(rx)) {
          const index = m.index ?? 0;
          const after = f.code.slice(index, index + 300);
          const reward = REWARD_CODE.exec(after);
          if (!reward || !ships(f, index)) continue;
          const line = lineIndex(f.code)(index);
          findings.push(
            finding({
              rule: "ratings.incentivized_review",
              severity: "block",
              guideline: "5.6.3",
              file: f.path,
              line,
              evidence: `${lineText2(f, line)} \u2026 ${reward[0]}`,
              why: "Code grants a reward (currency, credits or premium) right after asking for a rating or review. Incentivized reviews manipulate ratings (5.6.3) and are grounds for Program removal (DPLA \xA711.2).",
              fix: "Remove the reward from the review flow: nothing may be granted for rating or reviewing.",
              confidence: "medium"
            })
          );
          break;
        }
      }
      const sentiment = literalsOf(f).find(
        (l) => SENTIMENT_LITERAL.test(l.value) && (l.value.includes("?") || /^\s*(are you|do you|how)\b/i.test(l.value)) && ships(f, l.index)
      );
      if (sentiment && ask && literalsOf(f).some((l) => NEGATIVE_PATH.test(l.value))) {
        findings.push(
          finding({
            rule: "ratings.sentiment_gate",
            severity: "high",
            guideline: "5.6.3",
            file: f.path,
            line: sentiment.line,
            evidence: sentiment.value,
            why: 'A sentiment question ("Enjoying the app?") decides who is asked for a review: happy users go to the review prompt, unhappy users to feedback. Filtering who may rate skews ratings, which 5.6.3 prohibits as review manipulation, and 5.6.1 requires the system prompt to be the only rating prompt.',
            fix: "Remove the pre-question: call the system review API (`requestReview`) at a natural moment for every user, and offer feedback through a separate, always-available control.",
            confidence: "medium"
          })
        );
      } else if (sentiment && ask && /\b(if|guard|\?|switch|case)\b[^\n]{0,80}\b(yes|positive|liked|enjoy|happy|love)\w*/i.test(f.code)) {
        findings.push(
          finding({
            rule: "ratings.sentiment_gate",
            severity: "high",
            guideline: "5.6.3",
            file: f.path,
            line: sentiment.line,
            evidence: sentiment.value,
            why: "A sentiment question decides whether the review prompt is shown, so only users who answer positively are asked to rate. That skews ratings (5.6.3).",
            fix: "Remove the pre-question: call the system review API (`requestReview`) for every user at a natural moment.",
            confidence: "low"
          })
        );
      }
      if (!system && link) {
        const stars = STAR_PICKER.exec(f.code);
        const rateAsk = literalsOf(f).find(
          (l) => RATE_ASK_LITERAL.test(l.value) && ALERT_UI.test(f.code.slice(Math.max(0, l.index - 250), l.index)) && ships(f, l.index)
        );
        if (stars && ships(f, stars.index)) {
          const line = lineIndex(f.code)(stars.index);
          findings.push(
            finding({
              rule: "ratings.custom_prompt",
              severity: "block",
              guideline: "5.6.1",
              file: f.path,
              line,
              evidence: lineText2(f, line),
              why: "The app draws its own star-rating prompt and then sends users to the App Store review page. 5.6.1 requires the system API to prompt for ratings; a custom star picker is a prompt that bypasses it and lets the app filter who reaches the store.",
              fix: "Remove the custom star prompt and call the system API instead (`@Environment(\\.requestReview)`, `AppStore.requestReview(in:)`, or `StoreReview.requestReview()` in Expo).",
              confidence: "medium"
            })
          );
        } else if (rateAsk) {
          findings.push(
            finding({
              rule: "ratings.custom_prompt",
              severity: "high",
              guideline: "5.6.1",
              file: f.path,
              line: rateAsk.line,
              evidence: rateAsk.value,
              why: 'The app shows its own "rate us" alert or modal and links to the App Store review page instead of using the system rating prompt. 5.6.1 says to use the provided API to prompt users to review. A plain "Write a Review" link in settings is fine; an interruptive custom prompt is not.',
              fix: "Remove the custom prompt and call the system API instead (`@Environment(\\.requestReview)`, `AppStore.requestReview(in:)`, `StoreReview.requestReview()` in Expo).",
              confidence: "medium"
            })
          );
        }
      }
    }
    const proofFiles = ctx.files.filter(
      (f) => isUiText(f) && !NON_SHIPPING_PATH.test(f.path) && (ONBOARDING_PATH.test(f.path) || PAYWALL_PATH.test(f.path) || isCode(f) && (PURCHASE_CALL.test(f.code) || MANAGED_PAYWALL.test(f.code)))
    );
    for (const f of proofFiles) {
      for (const lit of literalsOf(f)) {
        const m = SOCIAL_PROOF.exec(lit.value);
        if (!m || !ships(f, lit.index)) continue;
        findings.push(
          finding({
            rule: "ratings.hardcoded_social_proof",
            severity: "medium",
            guideline: "5.6.3",
            file: f.path,
            line: lit.line,
            evidence: lit.value,
            why: `Paywall or onboarding copy states a fixed rating, user count or ranking ("${m[0]}"). Hardcoded figures go stale or were never true; unverifiable claims are consumer misrepresentation under DPLA 3.2(f) and misleading under 5.6.3/2.3.`,
            fix: "Remove the figure unless it is current and verifiable; if you keep a claim, source it from live data and be ready to substantiate it to App Review.",
            confidence: "medium"
          })
        );
      }
    }
    const dirOf = (p) => p.slice(0, p.lastIndexOf("/") + 1);
    const proofDirs = new Set(proofFiles.filter(isCode).map((f) => dirOf(f.path)));
    for (const f of ctx.files) {
      if (f.ext !== "json" || NON_SHIPPING_PATH.test(f.path) || /(^|\/)(package(-lock)?|tsconfig[\w.]*|app|eas|Contents)\.json$/.test(f.path)) continue;
      if (!ONBOARDING_PATH.test(f.path) && !PAYWALL_PATH.test(f.path) && !proofDirs.has(dirOf(f.path))) continue;
      const m = SOCIAL_PROOF_JSON_KEY.exec(f.text);
      if (!m) continue;
      const line = lineIndex(f.text)(m.index);
      findings.push(
        finding({
          rule: "ratings.hardcoded_social_proof",
          severity: "medium",
          guideline: "5.6.3",
          file: f.path,
          line,
          evidence: lineText2(f, line),
          why: `A data file bundled with the paywall or onboarding holds a fixed rating or audience figure (${m[0].replace(/\s+/g, " ")}). Hardcoded figures go stale or were never true; unverifiable claims are consumer misrepresentation under DPLA 3.2(f) and misleading under 5.6.3/2.3.`,
          fix: "Remove the figure unless it is current and verifiable; if you keep a claim, source it from live data and be ready to substantiate it to App Review.",
          confidence: "medium"
        })
      );
    }
    return { findings, data: { reviewRequestSites: reviewSites } };
  }
};

// src/scanners/ugcSafeguards.ts
var PER_KIND2 = 10;
var DIRECT_DB_UGC = UGC_DISPLAY.filter((rx) => rx.source.includes("collection") || rx.source.includes("\\.from"));
var REPORT_COVERAGE_CAP = 500;
var ugcFile = (f) => isCode2(f) && !isGeneratedBundle(f);
var domMarkup = (f, h) => /^createComment$/.test(h.groups[0] ?? h.match) && DOM_IMPLEMENTATION.test(f.code);
var ugcHits = (f, rx) => ugcFile(f) ? searchFile(f, rx).filter((h) => !domMarkup(f, h)) : [];
function collect2(ctx, rxs, filter, kind, limit = PER_KIND2, skipLine, skipHit) {
  const out = [];
  for (const f of productFiles(ctx).filter(filter)) {
    for (const rx of rxs) {
      for (const h of searchFile(f, rx)) {
        if (skipLine?.(h.text) || skipHit?.(f, h)) continue;
        out.push({ file: f.path, line: h.line, text: redact(h.text).slice(0, 200), kind });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}
var LOTTIE = /^\s*\{[^]{0,400}"(?:fr|ip|op)"\s*:[^]{0,400}"layers"\s*:|^\s*\{\s*"v"\s*:\s*"\d+\.\d+\.\d+"/;
var DATA_BLOB_BYTES = 256 * 1024;
function isDataBlob(f) {
  if (/\.xcassets\//.test(f.path)) return true;
  if (f.ext !== "json") return false;
  if (/emoji/i.test(f.path) || f.text.length > DATA_BLOB_BYTES) return true;
  const firstBreak = f.text.indexOf("\n");
  return LOTTIE.test(f.text) || f.text.length > 2e4 && (firstBreak === -1 || firstBreak > 2e4);
}
var SELF_NAMED_CONSTANT = /^\s*(\w+)\s*=\s*(["'])\1\2\s*,?\s*$/;
var reportNoise = (text) => /emoji/i.test(text) || SELF_NAMED_CONSTANT.test(text);
function websiteLinks(ctx, shipped2) {
  const out = [];
  for (const f of productFiles(ctx)) {
    if (!isCode2(f) || !shipped2(f) || !ABOUT_SCREEN_PATH.test(f.path)) continue;
    for (const h of searchFile(f, WEBSITE_LINK)) {
      if (THIRD_PARTY_HOST.test(h.text)) continue;
      out.push({ file: f.path, line: h.line, text: redact(h.text).slice(0, 200), kind: "website" });
      if (out.length >= PER_KIND2) return out;
    }
  }
  return out;
}
var STAGED_VIEW = /(?:Screenshot|Preview|Fixture|Mock|Sample|Demo|Snapshot)[^/]*$/;
var IMAGE_GENERATION_NAME = /image_?gen|imagegenerat|generat\w{0,20}image|txt2img|text_?to_?image/i;
var providerMedia = new Map(PROVIDERS.map((p) => [p.id, p.media]));
function aiDisplays(ctx, s) {
  const generating = s.sinks.filter((x) => x.kind !== "embedding" && x.kind !== "transcription");
  const textOut = generating.some((x) => x.kind === "text" || x.kind === "generation" && (x.provider === void 0 || providerMedia.get(x.provider)?.includes("text")));
  const out = [];
  const add = (what, rx, also) => {
    let surface;
    for (const f of productFiles(ctx).filter(isCode2)) {
      if (also && !also(f)) continue;
      const h = searchFile(f, rx)[0];
      if (!h) continue;
      const at = { file: f.path, line: h.line, text: redact(h.text).slice(0, 200), kind: "display" };
      surface ??= { what, at, files: /* @__PURE__ */ new Set() };
      if (STAGED_VIEW.test(surface.at.file) && !STAGED_VIEW.test(f.path)) surface.at = at;
      surface.files.add(f.path);
    }
    if (surface) out.push(surface);
  };
  if (textOut) add("chat replies", AI_CHAT_DISPLAY);
  const visualSinkFiles = new Set(generating.filter((x) => x.kind === "image" || x.kind === "image-edit" || x.kind === "video").map((x) => x.file));
  if (s.imageCapable) add("generated images", AI_IMAGE_DISPLAY, (f) => visualSinkFiles.has(f.path) || IMAGE_GENERATION_NAME.test(maskedOf(f)));
  return out;
}
var REPORT_ANY_CONTENT = /\b(?:content|abuse|inappropriate|offensive|harmful)\b|(?:Content|Abuse|Inappropriate|Offensive)/;
function reportCovers(r, displays) {
  const words = /* @__PURE__ */ new Set();
  if (REPORT_TEXT_WORD.test(r.text)) words.add("chat replies");
  if (REPORT_VISUAL_WORD.test(r.text)) words.add("generated images");
  if (words.size) return words;
  const inView = new Set(displays.filter((d) => d.files.has(r.file)).map((d) => d.what));
  if (inView.size) return inView;
  return REPORT_ANY_CONTENT.test(r.text) ? "any" : words;
}
function metadataSupportUrl(ctx) {
  return ctx.files.filter((f) => ctx.project.metadataDirs.some((d) => f.path.startsWith(`${d}/`)) && /(^|\/)support_url\.txt$/.test(f.path) && /https?:\/\/\S+/.test(f.text)).slice(0, 1).map((f) => ({ file: f.path, line: lineAt(f, 0), text: f.text.trim().slice(0, 200), kind: "contact" }));
}
var check11 = {
  id: "ugc_safeguards",
  title: "UGC and AI-content safeguards",
  guidelines: ["1.2", "1.2.1(a)", "4.7.1"],
  async run(ctx) {
    const surface = analyzeAiSurface(ctx);
    const ugc = collect2(ctx, UGC_DISPLAY, ugcFile, "ugc", PER_KIND2, void 0, domMarkup);
    const ai = surface.hasGenerator && !surface.platformGuardedOnly;
    if (ugc.length === 0 && !ai) return { findings: [], data: { applies: false } };
    const shippedText = isShippedText(ctx);
    const shipped2 = (f) => shippedText(f) && !isDataBlob(f);
    const moderationState = ugc.length ? collect2(ctx, UGC_MODERATION_STATE, (f) => isCode2(f) && shipped2(f), "moderation state") : [];
    const filter = [...surface.moderation, ...moderationState.map((m) => ({ ...m, label: "server-set moderation state on posted content" }))];
    const report = collect2(ctx, REPORT, shipped2, "report", PER_KIND2, reportNoise);
    const block = collect2(ctx, BLOCK_USER, shipped2, "block");
    const contact = [...metadataSupportUrl(ctx), ...collect2(ctx, CONTACT, shipped2, "contact", PER_KIND2, (t) => CONTACT_SAMPLE_LINE.test(t))];
    const website = contact.length ? [] : websiteLinks(ctx, shipped2);
    const age = collect2(ctx, AGE, shipped2, "age");
    const showsUgc = (f) => UGC_DISPLAY.some((rx) => ugcHits(f, rx).length > 0);
    const communityAudience = (f) => scan(f, maskedOf(f), COMMUNITY_AUDIENCE).some((h) => !COMMUNITY_NOT_AUDIENCE.test(h.text));
    const publicUgc = ugc.length > 0 && productFiles(ctx).some(
      (f) => isCode2(f) && (scan(f, maskedOf(f), PUBLIC_UGC).length > 0 || (scan(f, maskedOf(f), FOLLOWER_AUDIENCE).length > 0 || communityAudience(f)) && showsUgc(f))
    );
    const labels = publicUgc && age.length === 0 ? productFiles(ctx).filter((f) => isCode2(f) && shipped2(f)).flatMap((f) => scan(f, maskedOf(f), CONTENT_LABEL).slice(0, 1).map((h) => ({ f, h }))).slice(0, 1) : [];
    const anchorItem = ugc[0] ?? (ai ? aiDisplays(ctx, surface)[0]?.at : void 0) ?? aiAnchor(surface);
    const loc = anchorItem ? { file: anchorItem.file, line: anchorItem.line, evidence: anchorItem.text } : {};
    const what = ugc.length && ai ? "user-generated and AI-generated content" : ugc.length ? "user-generated content" : "AI-generated content";
    const findings = [];
    if (ugc.length && filter.length === 0) {
      const directDb = productFiles(ctx).some((f) => DIRECT_DB_UGC.some((rx) => ugcHits(f, rx).length > 0));
      const serverSide = !directDb && report.length > 0 && block.length > 0;
      findings.push(
        finding({
          rule: "ugc.no_filter",
          severity: serverSide ? "medium" : "high",
          guideline: "1.2",
          ...loc,
          why: serverSide ? `The app shows ${what} posted through its own API, and has report (${report[0].file}:${report[0].line}) and block (${block[0].file}:${block[0].line}) actions, but the filter for objectionable material is not visible in client code (safeguard 1 of 1.2); it may run on the server.` : `The app shows ${what} but no filter for objectionable material was found (safeguard 1 of 1.2).${directDb ? " Posts are written straight from the app to a shared database, so no server of yours filters them first." : ""}`,
          fix: serverSide ? "Disclose in Review Notes how posted content (text and images) is filtered on the server before other users see it; if it is not filtered, add filtering." : "Add filtering of posted content (text and images) before other users see it. If filtering runs on a server outside this repo, disclose and describe it in Review Notes.",
          confidence: serverSide ? "low" : "medium"
        })
      );
    }
    if (report.length === 0) {
      findings.push(
        finding({
          rule: "ugc.no_report",
          severity: "high",
          guideline: "1.2",
          ...loc,
          why: `The app shows ${what} but no way to report offensive content was found (safeguard 2 of 1.2${ai ? "; 4.7.1 for chatbots" : ""}). Apple discovers problems through user reports, and 1.2 expects timely responses to them.`,
          fix: `Add a visible "Report" action on each piece of ${ugc.length ? "user" : "generated"} content that reaches a monitored queue, and act on reports promptly.`,
          confidence: "medium"
        })
      );
    }
    if (report.length > 0 && ai) {
      const displays = aiDisplays(ctx, surface);
      const covered = /* @__PURE__ */ new Set();
      let coversAll = false;
      for (const r of collect2(ctx, REPORT, shipped2, "report", REPORT_COVERAGE_CAP, reportNoise)) {
        const c = reportCovers(r, displays);
        if (c === "any") coversAll = true;
        else for (const w of c) covered.add(w);
      }
      for (const d of coversAll ? [] : displays.filter((x) => !covered.has(x.what))) {
        findings.push(
          finding({
            rule: "ugc.no_report",
            severity: "high",
            guideline: "1.2",
            file: d.at.file,
            line: d.at.line,
            evidence: d.at.text,
            why: `Report path missing for: ${d.what} (${d.at.file}:${d.at.line}). A report action was found for other content (${report[0].file}:${report[0].line}), but none on this view, so users cannot report these (safeguard 2 of 1.2; 4.7.1 for chatbots).`,
            fix: `Add a visible "Report" action on each of the ${d.what} that reaches a monitored queue, and act on reports promptly.`,
            confidence: "medium"
          })
        );
      }
    }
    if (ugc.length && block.length === 0) {
      findings.push(
        finding({
          rule: "ugc.no_block",
          severity: "high",
          guideline: "1.2",
          ...loc,
          why: "The app shows content from other users but no way to block abusive users was found (safeguard 3 of 1.2).",
          fix: `Add a "Block user" action that removes the blocked user's content from the blocker's feed and stops their contact.`,
          confidence: "medium"
        })
      );
    }
    if (contact.length === 0) {
      const site = website[0];
      findings.push(
        finding({
          rule: "ugc.no_contact",
          severity: site ? "medium" : "high",
          guideline: "1.2",
          ...loc,
          why: `The app shows ${what} but no published contact information was found in the app (support email, mailto: link, contact screen or support URL) (safeguard 4 of 1.2).` + (site ? ` The app links to a website (${site.file}:${site.line}); it counts only if that site lets users reach the developer.` : "") + " The App Store Connect Support URL also counts as published contact if it really reaches the developer.",
          fix: "Add in-app contact information (support email or contact/support screen) that users can reach easily.",
          confidence: "low"
        })
      );
    }
    if (publicUgc && age.length === 0) {
      const label = labels[0];
      findings.push(
        finding({
          rule: "ugc.no_age_gate",
          severity: "medium",
          guideline: "1.2.1(a)",
          ...loc,
          why: label ? `The app publishes ${what} to followers, communities or public feeds. Content identification was found (${label.f.path}:${label.h.line}), but no age restriction was found. 1.2.1(a) asks creator-content apps to identify content above the app's age rating and restrict it by verified or declared age.` : `The app publishes ${what} to followers, communities or public feeds, which can exceed the app's age rating, but no age identification or age restriction was found. 1.2.1(a) asks creator-content apps for a way to identify such content and restrict it by verified or declared age.`,
          fix: "Add a way to identify content above the app's age rating and restrict it by declared or verified age (an age gate, or Apple's Declared Age Range API); disclose how it works in Review Notes.",
          confidence: "low"
        })
      );
    }
    return {
      findings,
      data: {
        applies: true,
        ugc,
        aiContent: ai,
        // Lets outgoing text be checked against what an AI-only app can honestly say about blocking.
        aiOnly: ugc.length === 0 && ai,
        userBlockFound: block.length > 0,
        safeguards: {
          filter: ugc.length || filter.length ? filter.slice(0, PER_KIND2) : "covered by genai_safety",
          report,
          block: ugc.length ? block : "not applicable (no multi-user content found)",
          contact,
          ...website.length ? { website } : {},
          age: publicUgc ? age : "not applicable (no public or creator content found)",
          ...labels.length ? { contentLabels: labels.map(({ f, h }) => ({ file: f.path, line: h.line, text: redact(h.text).slice(0, 200), kind: "content label" })) } : {}
        }
      }
    };
  }
};

// src/scanners/index.ts
var ALL = [
  check3,
  check4,
  check7,
  check,
  check11,
  check6,
  check10,
  check8,
  check2,
  check5,
  check9
];
var CHECKS = new Map(
  CHECK_IDS.map((id) => {
    const c = ALL.find((x) => x.id === id);
    if (!c) throw new Error(`No scanner registered for check "${id}"`);
    return [id, c];
  })
);
function getChecks(ids) {
  const want = ids?.length ? new Set(ids) : void 0;
  return [...CHECKS.values()].filter((c) => !want || want.has(c.id));
}

// src/preflight.ts
var SKIP_DIRS = /* @__PURE__ */ new Set(["node_modules", "Pods", "build", "DerivedData", "dist", "vendor", "Carthage"]);
function looksLikeApp(root) {
  const queue = [{ dir: root, depth: 0 }];
  let budget = 5e3;
  while (queue.length && budget > 0) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (--budget <= 0) break;
      const n = e.name;
      if (n.endsWith(".xcodeproj") || n.endsWith(".xcworkspace") || n === "Package.swift" || n.endsWith(".swift")) return true;
      if (depth <= 2 && (n === "package.json" || /^app\.(json|config\.(ts|js|mjs|cjs))$/.test(n))) {
        try {
          const file2 = path7.join(dir, n);
          const st = statSync(file2);
          if (st.isFile() && st.size <= 1024 * 1024 && /"(react-native|expo)"\s*:/.test(readFileSync2(file2, "utf8"))) return true;
        } catch {
        }
      }
      if (e.isDirectory() && depth < 3 && !n.startsWith(".") && !SKIP_DIRS.has(n)) queue.push({ dir: path7.join(dir, n), depth: depth + 1 });
    }
  }
  return false;
}
function noAppMessage(root, override) {
  return `no iOS, SwiftUI or React Native/Expo project found in ${root} (no .xcodeproj, .xcworkspace, Package.swift, .swift files, or react-native/expo in package.json or app.json). Pass the app repo root, or ${override} to use this directory anyway.`;
}
var NoAppProjectError = class extends Error {
  constructor(root, override = "pass force: true") {
    super(noAppMessage(root, override));
    this.name = "NoAppProjectError";
  }
};
function coverageOf(ctx) {
  const skipped = ctx.skipped ?? [];
  const budget = skipped.filter((s) => s.reason === "budget");
  return {
    truncated: budget.length > 0,
    notRead: budget.reduce((n, s) => n + (s.remaining ?? 0), 0),
    tooLarge: skipped.filter((s) => s.reason === "too-large").map((s) => s.path),
    excludedWorktrees: ctx.excludedWorktrees ?? [],
    unreadShipping: unreadShippingFiles(ctx).map((s) => s.path),
    appRoots: ctx.project?.appRoots ?? [],
    appNotes: ctx.project?.appRoots ? appRootNotes(ctx.project) : []
  };
}
async function runScan(root, opts = {}) {
  const ctx = await loadContext(root, { paths: opts.paths, includeTests: opts.includeTests });
  const runs = [];
  const all = [];
  for (const c of getChecks(opts.checks)) {
    try {
      const r = await c.run(ctx);
      all.push(...r.findings);
      runs.push({ id: c.id, title: c.title, guidelines: c.guidelines, findings: r.findings.length, data: r.data });
    } catch (e) {
      runs.push({ id: c.id, title: c.title, guidelines: c.guidelines, findings: 0, error: e.message });
    }
  }
  const baseline = await loadBaseline(ctx.root);
  const applied = applyBaseline(dedupeFindings(all), baseline.suppressions);
  const findings = sortFindings(applied.active);
  return {
    ctx,
    root: ctx.root,
    platforms: ctx.project.platforms,
    filesScanned: ctx.files.length,
    checks: runs,
    findings,
    counts: countBySeverity(findings),
    suppressed: applied.suppressed,
    refusedSuppressions: applied.refused,
    baselineProblems: baseline.problems,
    coverage: coverageOf(ctx)
  };
}
function checkData(scan2, id) {
  return scan2.checks.find((c) => c.id === id)?.data;
}
function remoteControlsOf(scan2) {
  const inv = checkData(scan2, "remote_config")?.inventory;
  if (!Array.isArray(inv)) return void 0;
  return inv.flatMap((x) => {
    const p = RemoteControl.safeParse(x);
    return p.success ? [p.data] : [];
  });
}
function disclosureInventory(scan2) {
  const ota = checkData(scan2, "ota_updates")?.ota;
  const surface = checkData(scan2, "genai_safety")?.surface;
  const remote = (surface?.providers ?? []).filter((p) => p.kind !== "on-device" && p.name);
  const aiServices = [...new Set(remote.map((p) => String(p.name)))];
  const aiSinks = remote.flatMap((p) => (p.evidence ?? []).slice(0, 3).map((e) => ({ provider: String(p.name), file: e.file, line: e.line })));
  return {
    remoteControls: remoteControlsOf(scan2),
    ota: (ota?.providers ?? []).map((p) => ({
      provider: String(p.provider ?? "OTA"),
      detail: [p.updatesUrl && `updates ${p.updatesUrl}`, p.runtimeVersion && `runtime ${p.runtimeVersion}`, p.channels?.length && `channels ${p.channels.join(", ")}`].filter(Boolean).join("; ") || void 0
    })),
    aiServices,
    aiSinks
  };
}
function detectBundleId(ctx) {
  const literal = (s) => s && /^[A-Za-z0-9.-]+\.[A-Za-z0-9-]+$/.test(s) ? s : void 0;
  const ids = [];
  for (const f of ctx.files.filter((x) => x.ext === "pbxproj")) {
    for (const m of f.text.matchAll(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*"?([^";\s]+)"?;/g)) {
      const id = literal(m[1]);
      if (!id || /tests?$/i.test(id.split(".").at(-1))) continue;
      if (/\.(widget|extension|share|notification|intents?|watchkit\w*)$/i.test(id)) continue;
      ids.push(id);
    }
  }
  if (ids.length) return ids.reduce((a, b) => b.length < a.length ? b : a);
  const expo = ctx.project.expoConfig ? ctx.files.find((f) => f.path === ctx.project.expoConfig) : void 0;
  if (expo?.ext === "json") {
    try {
      const j = JSON.parse(expo.text);
      return literal(j.expo?.ios?.bundleIdentifier ?? j.ios?.bundleIdentifier);
    } catch {
      return void 0;
    }
  }
  return literal(/bundleIdentifier\s*:\s*["']([^"']+)["']/.exec(expo?.text ?? "")?.[1]);
}
function gitHead(root) {
  return new Promise((resolve) => {
    execFile3("git", ["-C", root, "rev-parse", "HEAD"], { timeout: 5e3 }, (err, stdout) => {
      resolve(err ? void 0 : stdout.trim() || void 0);
    });
  });
}
function openRejections(state) {
  return state.rejections.filter((r) => !r.approvedBy).map((r) => ({
    id: r.id,
    at: r.at,
    bundleId: r.bundleId,
    outcome: r.outcome,
    guidelines: r.guidelines,
    tier: r.verification?.tier,
    acked: r.acked,
    hasInterpretation: Boolean(r.interpretation),
    hasSpec: Boolean(r.spec)
  }));
}
function blockedRemoteKey(c, findings) {
  return findings.some(
    (f) => f.rule === "remote_config.content_gating" && f.severity === "block" && (f.why.includes(`key "${c.key}"`) || f.file !== void 0 && f.file === c.file && f.line === c.line)
  );
}
function manualChecklist(inv, scan2, state) {
  const items = [
    {
      id: "demo_account",
      item: "If the app has a login, give App Review a working demo account that will not expire during review, with any content it needs already loaded.",
      guideline: "2.1(a)"
    },
    {
      id: "expired_subscription_account",
      item: "If features depend on a subscription, say in the notes how a reviewer can see both subscribed and expired or not-subscribed states (e.g. a second demo account).",
      guideline: "2.1(a), 3.1.2"
    },
    {
      id: "two_factor",
      item: "If sign-in needs 2FA, an OTP or a hardware device, explain in the notes exactly how a reviewer gets past it.",
      guideline: "2.1(a)"
    },
    {
      id: "notes_specificity",
      item: `Notes for Review describe what changed in this build with specificity, not 'bug fixes and improvements', and stay under 4000 bytes. Lint them with ${toolRef("shield_lint_text")}.`,
      guideline: "2.3.1(a)"
    }
  ];
  const mustDelete = new Set((inv.remoteControls ?? []).filter((c) => blockedRemoteKey(c, scan2.findings)).map((c) => c.key));
  const disclose = (inv.remoteControls ?? []).filter((c) => !mustDelete.has(c.key));
  const sensitive = disclose.filter((c) => c.classification === "content-gating" || c.classification === "price-gating");
  if (mustDelete.size) {
    items.push({
      id: "delete_remote_switch",
      item: `Delete ${[...mustDelete].slice(0, 5).join(", ")} and the content it gates (block finding remote_config.content_gating); disclosing it does not fix it.`,
      guideline: "2.5.19, DPLA 3.2(e)"
    });
  }
  if (disclose.length) {
    items.push({
      id: "disclose_remote_config",
      item: `Disclose ${mustDelete.size ? "the remaining " : ""}remote configuration in the notes: ${disclose.length} key(s)${sensitive.length ? `, including ${sensitive.map((c) => c.key).slice(0, 5).join(", ")} that change content or price` : ""}.`,
      guideline: "2.5.19, 2.3.1(a)"
    });
  }
  if (inv.ota?.length) {
    items.push({
      id: "disclose_ota",
      item: `Disclose over-the-air updates (${inv.ota.map((o) => o.provider).join(", ")}) and what they are used for; any promise about their future scope is the developer's own statement (2.5.2 limits what they may change).`,
      guideline: "2.5.2, 2.5.19"
    });
  }
  if (inv.aiServices?.length) {
    items.push({
      id: "disclose_ai",
      item: `Disclose the third-party AI services the app sends user data to (${inv.aiServices.join(", ")}) and the moderation that runs on input and output.`,
      guideline: "5.1.2(i), 1.2"
    });
  }
  if (state.rejections.some((r) => !r.approvedBy)) {
    items.push({
      id: "address_open_rejection",
      item: "The notes name the open rejection and describe, at capability level, what was removed on every input path, without claiming more than the verification tier supports.",
      guideline: "2.3.1(a), 1.2"
    });
  }
  if (scan2.findings.some((f) => f.rule.startsWith("review_gating.region_legal"))) {
    items.push({ id: "disclose_storefront_gates", item: "Disclose storefront or region-specific behavior and the legal reason for it.", guideline: "2.5.19" });
  }
  return items;
}
var GUIDELINE_ALIASES = { "4.7": ["1.2"], "4.7.1": ["1.2"] };
function guidelineWithin(findingGuideline, cited) {
  const c = cited.trim();
  if (!c) return false;
  const targets = [c, ...GUIDELINE_ALIASES[c] ?? []];
  return findingGuideline.split(/[,;]\s*/).map((g) => g.trim()).some((g) => targets.some((t) => g === t || g.startsWith(`${t}.`) || g.startsWith(`${t}(`)));
}
function openRejectionHolds(state, findings, bundleId) {
  const out = [];
  for (const r of state.rejections) {
    if (r.approvedBy || r.acked || r.outcome !== "rejected") continue;
    if (!rejectionAppliesTo(r, bundleId)) continue;
    const seen = /* @__PURE__ */ new Set();
    const objectionable = r.guidelines.some((g) => /^1\.[12](\D|$)/.test(g));
    for (const f of findings) {
      if (seen.has(f.rule)) continue;
      if (f.severity !== "high" && !(objectionable && f.rule === "metadata.content_signal_claim")) continue;
      const cited = r.guidelines.find((g) => guidelineWithin(f.guideline, g));
      if (!cited) continue;
      seen.add(f.rule);
      out.push(
        `Open rejection ${r.id} cites Guideline ${cited}, and ${f.rule} (Guideline ${f.guideline}) is still reported${f.file ? ` at ${f.file}${f.line ? `:${f.line}` : ""}` : ""}: ${f.fix} Check every precaution the rejection message lists before resubmitting.`
      );
    }
  }
  return out;
}
function checkErrorHolds(scan2) {
  return scan2.checks.filter((c) => c.error).map(
    (c) => `Check ${c.id} failed: ${c.error}. The gate cannot vouch for this area (${c.guidelines.join(", ")}). Run \`appstore-shield scan --checks ${c.id}\` to see the error; the hold lifts once the check runs.`
  );
}
var SAFEGUARD_CLAIMS = [
  {
    rules: ["ugc.no_report"],
    what: "a way to report content",
    rx: /\breport(?:ing)?\s+(?:button|action|option|flow|feature|menu|link|icon|screen)s?\b|\b(?:users?|you|people|anyone|reviewers?)\s+can\s+(?:also\s+|now\s+)?(?:tap\s+)?report\b|["“]report\b[^"”\n]{0,40}["”]|\breporting:|\btap(?:s|ping)?\s+["“]?report\b|\breport\s+(?:this|offensive|abusive|inappropriate|objectionable)\b/i,
    serverSide: false
  },
  {
    rules: ["ugc.no_block"],
    what: "a way to block users",
    rx: /\bblock(?:ing)?\s+(?:button|action|option|feature|menu)s?\b|\b(?:users?|you|people)\s+can\s+(?:also\s+|now\s+)?block\b|["“]block\b[^"”\n]{0,40}["”]|\bblocking:|\bblock\s+(?:a\s+|abusive\s+|other\s+|any\s+)?users?\b/i,
    serverSide: false
  },
  {
    rules: ["ugc.no_filter", "genai.no_moderation"],
    what: "content filtering or moderation",
    rx: /\bmoderat(?:ion|ed|es|ing)\b|\bcontent\s+filter(?:s|ing)?\b|\bfilter(?:s|ed|ing)?\s+(?:objectionable|offensive|inappropriate|posted|user|generated|explicit)\b|\bfiltering:|\bclassifier\b/i,
    serverSide: true
  },
  {
    rules: ["genai.input_only_moderation"],
    what: "moderation of generated output",
    rx: /\boutput\s+(?:image\s+|text\s+)?(?:moderation|filter(?:ing)?|classifier)\b|\bmoderat\w*\s+(?:the\s+|of\s+(?:the\s+)?)?(?:generated|outputs?|results?)\b|\bgenerated\s+(?:images?|content|text|outputs?|results?)\s+(?:are|is)\s+(?:now\s+)?(?:moderated|filtered|checked|classified|scanned)\b/i,
    serverSide: true
  },
  {
    rules: ["ugc.no_age_gate"],
    what: "an age gate or age identification",
    rx: /\bage[- ](?:gate|gated|gating|verification|check|restriction|identification)\b|\bdeclared\s+age\s+range\b|\bverif(?:y|ies|ied)\s+(?:the\s+)?(?:user'?s?\s+)?age\b/i,
    serverSide: false
  },
  {
    // "Asks for camera permission" is an OS prompt, not AI consent, so permission counts only when tied to sending or sharing.
    rules: ["ai.undisclosed_sharing"],
    what: "a consent prompt before data is sent to a third-party AI service",
    rx: /\bconsent\s+(?:screen|prompt|dialog|alert|sheet|step|page|modal)s?\b|\bask(?:s|ed|ing)?\s+(?:the\s+user\s+|users?\s+|them\s+)?(?:for\s+)?(?:their\s+|explicit\s+)?consent\b|\b(?:permission|consent)\s+(?:before|to)\s+(?:send|shar|upload)\w*|\btaps?\s+["“']?allow\b|\b(?:users?|you)\s+(?:must\s+|can\s+)?(?:agree|consent|opt[- ]in)\b[^.\n]{0,60}\b(?:shar|send|AI|third)/i,
    serverSide: false
  },
  {
    rules: ["account_deletion.missing"],
    what: "in-app account deletion",
    rx: /\bdelet(?:e|es|ing)\s+(?:their|your|the|an?|my|his|her)\s+(?:own\s+)?account\b|\baccount\s+deletion\b|["“]delete\s+(?:my\s+)?account["”]|\bdelete\s+account\s+(?:button|option|flow|screen|link)\b/i,
    serverSide: false
  },
  {
    rules: ["paywall.missing_restore"],
    what: "a way to restore purchases",
    rx: /\brestore\s+purchases?\b/i,
    serverSide: false
  }
];
var NEGATED = /\b(?:no|not|without|never|lacks?|isn'?t|aren'?t|doesn'?t|don'?t|cannot|can'?t|will add|plan(?:s|ned)? to)\b/i;
var DEVELOPER_STATES = /^\s*(?:[-*•]\s*)?the developer (?:states|confirms|attests)\b/i;
function safeguardGaps(findings) {
  const open4 = /* @__PURE__ */ new Map();
  for (const f of findings) if (!open4.has(f.rule)) open4.set(f.rule, f);
  return SAFEGUARD_CLAIMS.flatMap((claim) => {
    const f = claim.rules.map((r) => open4.get(r)).find((x) => x !== void 0 && x.severity !== "info");
    return f ? [{ what: claim.what, finding: f, serverSide: claim.serverSide, rx: claim.rx }] : [];
  });
}
function aiOnlyWithoutBlock(scan2) {
  const d = scan2.checks.find((c) => c.id === "ugc_safeguards")?.data;
  return d?.aiOnly === true && d.userBlockFound === false;
}
var BLOCK_USERS_CLAIM = /\b(?:block|mute)\w*\s+(?:abusive\s+|other\s+)?users?\b|\busers?\s+can\s+(?:block|mute)\b/i;
function safeguardClaimIssues(text, findings, opts = {}) {
  const sentences = text.split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9"'(“])/).map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const { what, finding: f, serverSide, rx } of safeguardGaps(findings)) {
    const claim = { what, serverSide, rx };
    const hit = sentences.find((s) => claim.rx.test(s) && !NEGATED.test(s) && !(claim.serverSide && DEVELOPER_STATES.test(s)));
    if (!hit) continue;
    const where = f.file ? ` (at ${f.file}${f.line ? `:${f.line}` : ""})` : "";
    out.push({
      rule: "safeguard_claim_unbacked",
      severity: f.severity === "medium" ? "warning" : "error",
      excerpt: hit.length > 140 ? `${hit.slice(0, 139)}\u2026` : hit,
      message: `The text describes ${claim.what}, but the scan still reports ${f.rule}${where}. Describing a feature the app does not have is a misleading statement to App Review.`,
      fix: claim.serverSide ? `Add ${claim.what} and scan again before describing it. If it runs on a server outside this repo, write it as "The developer states that \u2026" and have the developer record it with \`appstore-shield attest\`.` : `Add ${claim.what} and scan again before describing it, or remove the sentence.`
    });
  }
  if (opts.aiOnlyNoBlock) {
    const hit = sentences.find((s) => BLOCK_USERS_CLAIM.test(s) && !NEGATED.test(s));
    if (hit && !out.some((i) => i.excerpt === (hit.length > 140 ? `${hit.slice(0, 139)}\u2026` : hit))) {
      out.push({
        rule: "safeguard_claim_unbacked",
        severity: "error",
        excerpt: hit.length > 140 ? `${hit.slice(0, 139)}\u2026` : hit,
        message: "The text says users can block other users, but this app has no user-to-user interaction and no block or mute feature was found.",
        fix: "Remove the sentence. For an AI-only app, say plainly that there are no other users to block, and describe the report flow for AI output and the content filter (SKILL.md step 7); if you add a way to stop or mute the AI character, scan again before describing it."
      });
    }
  }
  return out;
}
function latestConfigSnapshot(state, s) {
  const same = state.configSnapshots.filter((e) => e.kind === s.kind && e.label === s.label && (e.bundleId ?? "") === (s.bundleId ?? ""));
  return same[same.length - 1]?.hash;
}
async function resweepRejections(root, state, now, bundleId) {
  const out = [];
  for (const r of rejectionsToResweep(state, bundleId)) {
    try {
      const v = await verifyRemediation(root, r.spec, { now, rejectionId: r.id, ledgerEvents: state.events });
      out.push(resweepFromVerification(r.id, v));
    } catch {
    }
  }
  return out;
}
async function runPreflight(rootIn, opts) {
  const now = opts.now ?? (/* @__PURE__ */ new Date()).toISOString();
  const record = opts.record ?? true;
  const scan2 = await runScan(rootIn);
  const ctx = scan2.ctx;
  if (opts.requirePlatform && !scan2.platforms.length) throw new NoAppProjectError(ctx.root);
  const bundleId = opts.recordSubmission?.bundleId ?? detectBundleId(ctx);
  const location = await locateLedger(ctx.root, { remember: record });
  const { state, invalid } = await loadState(location);
  const remoteControls = remoteControlsOf(scan2);
  const snapshots = buildSnapshots(ctx, { remoteControls, bundleId });
  const drift = diffSinceApproved(state, snapshots, { bundleId });
  const gate = gateDecision(state, scan2.findings, now, drift, await resweepRejections(ctx.root, state, now, bundleId), { bundleId });
  const tied = [...openRejectionHolds(state, scan2.findings, bundleId), ...checkErrorHolds(scan2)];
  if (tied.length) {
    gate.holdReasons.push(...tied);
    gate.verdict = "HOLD";
    refreshHighFindingsWarning(gate, scan2.findings);
  }
  const unread = gateCoverageWarnings(scan2.coverage);
  if (unread.length) {
    gate.warnings.push(...unread);
    if (gate.verdict === "CLEAR") gate.verdict = "WARN";
  }
  const inventory = disclosureInventory(scan2);
  let builtProduct;
  if (opts.buildPath) {
    builtProduct = [];
    const withSpec = state.rejections.filter((r) => !r.approvedBy && r.spec && rejectionAppliesTo(r, bundleId));
    if (!withSpec.length) {
      builtProduct.push({
        rejectionId: "",
        notes: [`No open rejection has a saved residue spec, so there is nothing to sweep the build for. Save one with ${toolRef("shield_remediation", "save_spec")}.`],
        matches: []
      });
    }
    for (const r of withSpec) {
      try {
        const sweep = await sweepBuiltProduct(opts.buildPath, r.spec);
        builtProduct.push({
          rejectionId: r.id,
          hits: sweep.hits,
          encrypted: sweep.encrypted,
          complete: sweep.complete,
          notes: sweep.notes,
          matches: sweep.matches.slice(0, 20).map((m) => ({ needle: m.needle, file: m.file, evidence: m.evidence }))
        });
        if (sweep.hits > 0) {
          gate.warnings.push(`Built product ${opts.buildPath} still contains ${sweep.hits} residue match(es) for rejection ${r.id}.`);
          if (gate.verdict === "CLEAR") gate.verdict = "WARN";
        }
        if (!sweep.complete || sweep.encrypted) {
          gate.warnings.push(`Built product ${opts.buildPath} could not be fully swept for rejection ${r.id}${sweep.notes.length ? `: ${sweep.notes.join(" ")}` : "."}`);
          if (gate.verdict === "CLEAR") gate.verdict = "WARN";
        }
      } catch (e) {
        const err = e.message;
        builtProduct.push({ rejectionId: r.id, notes: [], matches: [], error: err });
        gate.warnings.push(`Built product ${opts.buildPath} could not be swept for rejection ${r.id}: ${err}`);
        if (gate.verdict === "CLEAR") gate.verdict = "WARN";
      }
    }
  }
  const recorded = { snapshotEvents: [] };
  try {
    if (record) {
      for (const s of snapshots) {
        if (latestConfigSnapshot(state, s) === s.hash) continue;
        const ev = await appendEvent(location, s, { source: opts.source });
        recorded.snapshotEvents.push(ev.id);
      }
      const metaRaw = checkData(scan2, "metadata")?.snapshots;
      const meta = Array.isArray(metaRaw) ? metaRaw.flatMap((m) => {
        const p = MetadataSnapshot.safeParse(m);
        return p.success ? [p.data] : [];
      }) : [];
      if (meta.length) {
        const last = state.metadataSnapshots.filter((e) => (e.bundleId ?? "") === (bundleId ?? "")).at(-1);
        if (!last || stableHash(last.snapshots) !== stableHash(meta)) {
          const ev = await appendEvent(location, { type: "metadata_snapshot", snapshots: meta, bundleId, repo: ctx.root }, { source: opts.source });
          recorded.metadataEventId = ev.id;
        }
      }
    }
    if (opts.recordSubmission) {
      const ev = await appendEvent(
        location,
        {
          type: "submission",
          version: opts.recordSubmission.version,
          build: opts.recordSubmission.build,
          bundleId,
          repo: ctx.root,
          sha: await gitHead(ctx.root)
        },
        { source: opts.source }
      );
      recorded.submissionEventId = ev.id;
    }
  } catch (e) {
    if (e.name !== "NotALedgerError" && e.name !== "SymlinkLedgerError") throw e;
    const err = e.message;
    if (!gate.holdReasons.some((r) => r.includes(err) || err.includes(r))) gate.holdReasons.push(`Nothing was recorded in the ledger: ${err}`);
    gate.verdict = "HOLD";
  }
  return {
    root: ctx.root,
    platforms: scan2.platforms,
    bundleId,
    ledger: { teamId: location.teamId, teamIdSource: location.teamIdSource, path: location.path, warnings: location.warnings, invalidLines: invalid },
    gate,
    triggers: triggerChecklist(state, now),
    drift,
    openRejections: openRejections(state),
    manualChecklist: manualChecklist(inventory, scan2, state),
    inventory,
    builtProduct,
    coverage: scan2.coverage,
    recorded,
    scan: scan2,
    state,
    location
  };
}

export {
  loadContext,
  RESULTS_MAX_BYTES,
  readRegularFile,
  vetClientPath,
  findSurface,
  validateSpec,
  tierLabel,
  verifyRemediation,
  CHECKS,
  looksLikeApp,
  noAppMessage,
  NoAppProjectError,
  coverageOf,
  runScan,
  checkData,
  remoteControlsOf,
  disclosureInventory,
  detectBundleId,
  openRejections,
  manualChecklist,
  guidelineWithin,
  openRejectionHolds,
  checkErrorHolds,
  safeguardGaps,
  aiOnlyWithoutBlock,
  safeguardClaimIssues,
  runPreflight
};

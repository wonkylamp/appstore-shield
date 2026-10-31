import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ResidueSpec } from "../ledger/schema.js";
import { CODE_EXTENSIONS, extOf, isTestPath, lineOf, stripComments, type ScanContext, type SourceFile } from "../project.js";
import { MODERATION_IMAGE_INPUT, MODERATION_REQUEST_WINDOW } from "../rules/genai.js";
import { CONTENT_SIGNAL_CLAIMS } from "../rules/store.js";
import { metadataTexts } from "../scanners/metadata.js";
import { blankStrings } from "../scope.js";
import { EVIDENCE_MAX_BYTES, readRegularFile } from "./fsread.js";

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// git (execFile only, never a shell)
// ---------------------------------------------------------------------------

// A checkout can arrive with its own .git/config (tarball, zip, shared folder). These settings
// would run commands from it on read-only calls, so every call overrides them. log.showSignature
// makes log and show verify each signed commit with the configured gpg/ssh/x509 program.
const SAFE_GIT = [
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.sshCommand=false",
  "-c", "core.pager=cat",
  "-c", "core.askPass=",
  "-c", "diff.external=",
  "-c", "protocol.allow=never",
  "-c", "log.showSignature=false",
  "-c", "gpg.program=false",
  "-c", "gpg.openpgp.program=false",
  "-c", "gpg.ssh.program=false",
  "-c", "gpg.x509.program=false",
];
const GIT_ENV = { GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", GIT_EXTERNAL_DIFF: "" };

// Clean/smudge/textconv drivers are named by the repo, so they are read from its config and
// neutralized on each call (not cached: a long-running server sees config edits).
async function repoDriverOverrides(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileP(
      "git",
      ["-C", root, ...SAFE_GIT, "config", "--name-only", "--get-regexp", String.raw`^(filter|diff)\..+\.(clean|smudge|process|textconv|command)$`],
      { timeout: 10_000, env: { ...process.env, ...GIT_ENV } },
    );
    return stdout
      .split("\n")
      .map((k) => k.trim())
      .filter((k) => /^(filter|diff)\..+\.(clean|smudge|process|textconv|command)$/.test(k))
      .flatMap((k) => ["-c", `${k}=${/\.(clean|smudge)$/.test(k) ? "cat" : ""}`]);
  } catch {
    return [];
  }
}

export async function git(root: string, args: string[], timeout = 20_000): Promise<string | undefined> {
  try {
    const drivers = await repoDriverOverrides(root);
    const { stdout } = await execFileP("git", ["-C", root, ...SAFE_GIT, ...drivers, ...args], { timeout, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...GIT_ENV } });
    return stdout;
  } catch {
    return undefined;
  }
}

/** A ref the caller supplied; anything git could read as an option is refused. */
export function safeRef(ref: string): boolean {
  return /^[\w./@{}^~:-]+$/.test(ref) && !ref.startsWith("-");
}

export async function isGitRepo(root: string): Promise<boolean> {
  return (await git(root, ["rev-parse", "--is-inside-work-tree"]))?.trim() === "true";
}

/** True when a file or folder whose name matches `needle` (an asset glob) was ever committed. */
export async function inGitPathHistory(root: string, needle: Needle): Promise<boolean> {
  // Limited to the project folder: in a monorepo, or an app vendored inside another repo, a match
  // elsewhere in the history says nothing about this app.
  const out = await git(root, ["log", "--no-show-signature", "--all", "--no-textconv", "--name-only", "--relative", "--format=", "-n", "5000", "--", "."], 30_000);
  return (out ?? "").split("\n").some((rel) => rel.split("/").some((seg) => matchNeedle(needle, seg, 1).length > 0));
}

/** True when `needle` was ever added or removed in any commit (case-insensitive pickaxe). */
export async function inGitHistory(root: string, needle: string): Promise<boolean> {
  const out = await git(root, ["log", "--no-show-signature", "--all", "--no-textconv", "-i", `-S${needle}`, "--format=%h", "-n", "1", "--", "."], 30_000);
  return !!out?.trim();
}

// ---------------------------------------------------------------------------
// Paths (files and directories, including binary assets that loadContext skips)
// ---------------------------------------------------------------------------

const IGNORED_DIRS = new Set([
  "node_modules", "Pods", ".git", "build", "DerivedData", "dist", ".build", ".expo", "Carthage",
  "android", ".gradle", "vendor", ".next", "coverage", "xcuserdata", ".swiftpm", ".appstore-shield",
  ".turbo", ".cache", "SourcePackages",
]);

/**
 * Repo-relative paths of files and the directories that contain them. Uses git when
 * available so .gitignore is honored exactly; otherwise walks the tree.
 */
export async function listRepoPaths(root: string, includeTests = false): Promise<string[]> {
  let files: string[] | undefined;
  if (await isGitRepo(root)) {
    const out = await git(root, ["ls-files", "-co", "--exclude-standard", "-z"]);
    if (out !== undefined) {
      files = out.split("\0").filter(Boolean).filter((rel) => existsSync(path.join(root, rel)));
    }
  }
  if (!files) {
    files = [];
    await walkPaths(root, root, files);
  }
  files = files.filter((rel) => !rel.split("/").some((seg) => IGNORED_DIRS.has(seg)));
  if (!includeTests) files = files.filter((rel) => !isTestPath(rel));
  const all = new Set<string>();
  for (const f of files) {
    all.add(f);
    const segs = f.split("/");
    for (let i = 1; i < segs.length; i++) all.add(segs.slice(0, i).join("/"));
  }
  return [...all].sort();
}

async function walkPaths(root: string, dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (IGNORED_DIRS.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    const rel = path.relative(root, abs).split(path.sep).join("/");
    if (e.isDirectory()) await walkPaths(root, abs, out);
    else if (e.isFile()) out.push(rel);
  }
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

const LEET: Record<string, string> = {
  a: "a4@", b: "b8", e: "e3", g: "g9", i: "i1!|", l: "l1|", o: "o0", s: "s5$", t: "t7+", z: "z2",
};

const isLetter = (c: string | undefined) => !!c && /\p{L}/u.test(c);
const isUpper = (c: string | undefined) => !!c && c !== c.toLowerCase() && c === c.toUpperCase();
const isLowerOrDigit = (c: string | undefined) => !!c && (/\d/.test(c) || (c === c.toLowerCase() && c !== c.toUpperCase()));

export const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Source for a term regex. Variants (leetspeak, separators inside the word) are only
 * generated for longer terms, where they rarely collide with ordinary words.
 */
function termSource(term: string): string {
  const t = term.toLowerCase().trim();
  const letters = [...t].filter((c) => isLetter(c)).length;
  const leet = letters >= 4;
  const seps = letters >= 5;
  const parts: string[] = [];
  const chars = [...t];
  chars.forEach((c, i) => {
    if (/[\s_-]/.test(c)) {
      parts.push("[\\s_-]*");
      return;
    }
    const cls = leet && LEET[c] ? `[${escapeRx(LEET[c]!).replace(/\\\|/g, "|")}]` : escapeRx(c);
    parts.push(cls);
    const next = chars[i + 1];
    if (seps && next && isLetter(c) && isLetter(next)) parts.push("[-_.* ]?");
  });
  return parts.join("");
}

/** Identifier-aware boundary: start/end of word, camelCase transition, or a plural suffix. */
function termBoundaryOk(src: string, start: number, end: number): boolean {
  const prev = src[start - 1];
  const first = src[start];
  const last = src[end - 1];
  const leftOk = !isLetter(prev) || (isLowerOrDigit(prev) && isUpper(first));
  if (!leftOk) return false;
  const rightAt = (k: number) => {
    const nx = src[k];
    return !isLetter(nx) || (isUpper(nx) && isLowerOrDigit(src[k - 1]));
  };
  if (rightAt(end)) return true;
  const lower = src.slice(end, end + 2).toLowerCase();
  if (lower.startsWith("s") && rightAt(end + 1)) return true;
  if (lower === "es" && rightAt(end + 2)) return true;
  return false;
}

export type NeedleKind = "term" | "symbol" | "asset" | "string" | "endpoint" | "flag" | "promptFragment";

export interface Needle {
  kind: NeedleKind;
  value: string;
  rx: RegExp;
  accept?: (src: string, start: number, end: number) => boolean;
}

function globSource(glob: string): string {
  return glob
    .split("")
    .map((c) => (c === "*" ? "[A-Za-z0-9_.-]*" : c === "?" ? "[A-Za-z0-9_.-]" : escapeRx(c)))
    .join("");
}

/** Boundary for keys/identifiers: not glued to other key characters. */
function keyBoundary(chars: string) {
  return (src: string, start: number, end: number) => {
    const rx = new RegExp(`[${chars}]`);
    const p = src[start - 1];
    const n = src[end];
    return !(p && rx.test(p)) && !(n && rx.test(n));
  };
}

export function makeNeedle(kind: NeedleKind, value: string): Needle | undefined {
  const v = value.trim();
  if (!v) return undefined;
  switch (kind) {
    case "term":
      return { kind, value: v, rx: new RegExp(termSource(v), "giu"), accept: termBoundaryOk };
    case "symbol":
      return { kind, value: v, rx: new RegExp(escapeRx(v), "gi"), accept: keyBoundary("A-Za-z0-9_") };
    case "asset":
      return { kind, value: v, rx: new RegExp(globSource(v), "gi"), accept: keyBoundary("A-Za-z0-9_") };
    case "string":
    case "flag":
      return { kind, value: v, rx: new RegExp(escapeRx(v), "gi"), accept: keyBoundary("A-Za-z0-9_.\\-") };
    case "endpoint":
      return { kind, value: v, rx: new RegExp(escapeRx(v), "gi") };
    case "promptFragment": {
      const words = v.split(/\s+/).map(escapeRx);
      return { kind, value: v, rx: new RegExp(words.join("\\s+"), "gi") };
    }
  }
}

export function needlesOf(spec: ResidueSpec): Needle[] {
  const out: Needle[] = [];
  const add = (kind: NeedleKind, values: string[]) => {
    const seen = new Set<string>();
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

export interface NeedleMatch {
  index: number;
  end: number;
  text: string;
}

export function matchNeedle(needle: Needle, src: string, limit = 200): NeedleMatch[] {
  const rx = new RegExp(needle.rx.source, needle.rx.flags.includes("g") ? needle.rx.flags : `${needle.rx.flags}g`);
  const out: NeedleMatch[] = [];
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

export function matchesAny(needles: Needle[], text: string): Needle | undefined {
  return needles.find((n) => matchNeedle(n, text, 1).length > 0);
}

export function lineText(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? text.length : end).trim();
}

// ---------------------------------------------------------------------------
// AI surface lexicon (deliberately local; the genai scanner owns the full version)
// ---------------------------------------------------------------------------

export const AI_HOSTS =
  /(api\.openai\.com|generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com|api\.anthropic\.com|api\.replicate\.com|replicate\.com|fal\.run|fal\.ai|fal\.media|api\.stability\.ai|api\.bfl\.(ai|ml)|api\.together\.xyz|api\.deepinfra\.com|api\.runpod\.ai|openrouter\.ai|api\.x\.ai|api\.mistral\.ai|api\.groq\.com|api\.fireworks\.ai|api\.leonardo\.ai|api\.ideogram\.ai|api\.midjourney|api\.novita\.ai|modelslab\.com|stablediffusionapi\.com|api-inference\.huggingface\.co)/i;

export const AI_SINK = new RegExp(
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
    String.raw`\bStableDiffusionPipeline\b`,
  ].join("|"),
  "i",
);

export const AI_SOURCES: { label: string; rx: RegExp }[] = [
  { label: "free-text prompt", rx: /\b(TextField|TextEditor)\s*\(|<TextInput\b|\bonChangeText\b|\bUITextView\b|\bUITextField\b/ },
  { label: "image upload", rx: /\b(PhotosPicker|UIImagePickerController|PHPickerViewController|launchImageLibraryAsync|launchCameraAsync|ImagePicker\.\w+|DocumentPicker\w*|getDocumentAsync)\b/ },
  { label: "deep link", rx: /\b(onOpenURL|getInitialURL|useURL|useLocalSearchParams|continueUserActivity)\b|Linking\.addEventListener|application\([^)]*\bopen\s+url\b/ },
  { label: "voice input", rx: /\b(SFSpeechRecognizer|AVAudioRecorder|useSpeechRecognition|Voice\.start)\b/ },
  { label: "shared content", rx: /\b(NSExtensionContext|ShareExtension|onDrop|UIPasteboard)\b/ },
];

/** A text-only omni-moderation call must not be credited as guarding image generation. */
function omniKind(code: string, hit: string, idx: number): "text" | "image" {
  if (!/^omni-moderation/i.test(hit)) return "text";
  return MODERATION_IMAGE_INPUT.test(code.slice(Math.max(0, idx - MODERATION_REQUEST_WINDOW), idx + hit.length + MODERATION_REQUEST_WINDOW)) ? "image" : "text";
}

/** Calls or settings that actually filter content: the evidence an input path is blocked. */
export const MODERATION_TEXT =
  /(\/v1\/moderations|\bmoderations\.create\b|text-moderation|omni-moderation|commentanalyzer\.googleapis|perspectiveapi|\bmoderate(Text|Prompt|Content)\s*\(|\bModerationService\b|contentmoderator)/i;
// omni-moderation is matched as text: it classifies an image only when the request sends one (see omniKind).
export const MODERATION_IMAGE =
  /(DetectModerationLabels|detectModerationLabels|\bSCSensitivityAnalyzer\b|SensitiveContentAnalysis|\bmoderateImage\s*\(|\bnsfwjs\b|\bNSFWDetector\b|api\.sightengine\.com|thehive\.ai|api\.hive\.ai|vision\.googleapis\.com[^"'`]*safeSearch|SafeSearchDetection|safeSearchDetection)/i;
export const SAFETY_DISABLED =
  /(\bBLOCK_NONE\b|HarmBlockThreshold\.(OFF|BLOCK_NONE)|\bthreshold\b["']?\s*[:=]\s*["']?OFF\b|disable_safety_checker["']?\s*[:=]\s*(true|True)|enable_safety_checker["']?\s*[:=]\s*(false|False)|safety_tolerance["']?\s*[:=]\s*["']?[5-6]\b|\bsafety_checker["']?\s*[:=]\s*(false|False|None|null)\b|\bmoderation["']?\s*[:=]\s*["']low["'])/;
export const SAFETY_STRICT =
  /(\bBLOCK_LOW_AND_ABOVE\b|\bBLOCK_MEDIUM_AND_ABOVE\b|safety_tolerance["']?\s*[:=]\s*["']?[0-2]\b|enable_safety_checker["']?\s*[:=]\s*(true|True)|disable_safety_checker["']?\s*[:=]\s*(false|False))/;

export const SERVER_DIRS = ["workers/", "functions/", "supabase/functions/", "api/", "server/"];
export const isServerPath = (rel: string) => SERVER_DIRS.some((d) => rel.startsWith(d) || rel.includes(`/${d}`));

const CODE = new Set(CODE_EXTENSIONS);
export const isCodeFile = (f: SourceFile) => CODE.has(f.ext);

/**
 * Names that mark a data file or key as a list of things to refuse, and an unused code list as one.
 * Broad words like "filter", "restrict" or "sensitive" alone also name photo effects and style
 * presets, so they count only next to words/terms/list.
 */
export const BLOCKLIST_NAME =
  /(block|deny|ban(ned|list|_?words|_?terms)|forbid|disallow|reject|refus|profan|moderat|prohibit|stop_?words|bad_?words|(nsfw|unsafe|sensitive|restricted|filter(ed)?)[_-]?(words|terms|keywords|phrases|list))/i;

// ---------------------------------------------------------------------------
// Declarations and blocklists (lexical; good enough to steer, never proof)
// ---------------------------------------------------------------------------

const maskedCache = new WeakMap<SourceFile, string>();

/** Comment-stripped code with string contents blanked, cached per file (scans call this per hit). */
export function maskedOf(f: SourceFile): string {
  let m = maskedCache.get(f);
  if (m === undefined) {
    m = blankStrings(f.code, f.ext);
    maskedCache.set(f, m);
  }
  return m;
}

const DECL_RX =
  /(?:^|[\s;{(])(?:(?:export\s+)?(?:default\s+)?(?:public\s+|private\s+|fileprivate\s+|internal\s+|static\s+|final\s+|lazy\s+|async\s+)*)(?:func|function|class|struct|enum|protocol|interface|type|typealias|let|var|const|val)\s+([A-Za-z_$][\w$]*)/;

export interface Enclosing {
  /** declared identifier the offset belongs to (variable initializer or type/function body) */
  ident: string;
  header: string;
  /** brace/bracket depth of the declaration itself (0 = file level) */
  depth: number;
  exported: boolean;
  declKind: string;
}

/**
 * Walks outward from `index` and returns each declaration whose initializer or body
 * contains it, innermost first.
 */
export function enclosingDeclarations(file: SourceFile, index: number, maxLevels = 8): Enclosing[] {
  const masked = maskedOf(file);
  const out: Enclosing[] = [];
  let depth = 0;
  let levels = 0;
  const opens: number[] = [];
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
    const open = opens[i]!;
    const lineStart = masked.lastIndexOf("\n", open - 1) + 1;
    const prevLineStart = masked.lastIndexOf("\n", Math.max(0, lineStart - 2)) + 1;
    const header = file.code.slice(prevLineStart, open).replace(/\s+/g, " ").trim();
    const thisLine = file.code.slice(lineStart, open);
    const m = DECL_RX.exec(` ${thisLine}`) ?? DECL_RX.exec(` ${header}`);
    if (!m || !m[1]) continue;
    const declKind = /\b(func|function|class|struct|enum|protocol|interface|type|typealias|let|var|const|val)\s+[A-Za-z_$]/.exec(m[0])?.[1] ?? "";
    out.push({
      ident: m[1],
      header,
      depth: opens.length - 1 - i,
      exported: /\bexport\b|@main|@objc|@IBAction|@IBOutlet|override\b|@UIApplicationMain/.test(header),
      declKind,
    });
  }
  return out;
}

const identCountCache = new WeakMap<ScanContext, Map<string, number>>();

/** Occurrences of `ident` as an identifier in code (string contents excluded). */
export function identifierCount(ctx: ScanContext, ident: string): number {
  let cache = identCountCache.get(ctx);
  if (!cache) {
    cache = new Map();
    identCountCache.set(ctx, cache);
  }
  const hit = cache.get(ident);
  if (hit !== undefined) return hit;
  const rx = new RegExp(`(?<![\\w$])${escapeRx(ident)}(?![\\w$])`, "g");
  let n = 0;
  for (const f of ctx.files) {
    if (!isCodeFile(f)) continue;
    n += (maskedOf(f).match(rx) ?? []).length;
  }
  cache.set(ident, n);
  return n;
}

export interface BlocklistContext {
  name: string;
  file: string;
  line: number;
  /** consumed by a membership test whose result decides something (refuse, throw, return) */
  used: boolean;
}

/** How code consumes a declared list: membership tests that decide, or as data shown or sent on. */
export interface ListUses {
  filter: number;
  content: number;
  other: number;
}

const VALUE_DECL = /^(let|var|const|val)$/;
const LIST_CALL = /\b(setOf|listOf|arrayOf|mutableListOf|mutableSetOf|hashSetOf|Set|NSSet|NSArray)\s*(<[^>]*>)?\s*$/;
const QUALIFIER = /(?:[\w$]+[?!]?\.)+$/;
const MEMBERSHIP_AFTER =
  /^\s*[?!]?\.\s*(contains|includes|has|some|any|anyMatch|allSatisfy|first\s*\(\s*where|firstIndex|findIndex|find|index\s*\(\s*of|test|matches|isDisjoint|intersection|intersects|isSuperset|isSubset|filter|contains_any)\b/;
const MEMBERSHIP_BEFORE = /(\b\w*(contain|include|match|intersect|disjoint|subset|superset|overlap)\w*\s*\(\s*(\w+\s*:\s*)?|\b(in|of)\s+)$/i;
/** The test refuses, throws, returns early or names its verdict. */
const DECIDES = /\b(throws?|raise|reject\w*|return|guard|abort|fatalError|precondition|cancel|deny|refus\w*|block\w*|disallow\w*|forbid\w*|unsafe|violat\w*|error|nil|false|allow\w*|safe)\b|=>/i;
const CONTAINS_OP = /\b(contains|includes|range\s*\(\s*of|hasPrefix|hasSuffix|test|match(es)?|indexOf|in)\b|===?/;
const UI_ELEMENT = /\b(Button|Text|Image|Label|Toggle|NavigationLink|Tab|Option|Chip|Card|Cell)\s*[({]|<[A-Z]\w*/;
/** UI containers and data props that render a list's elements as choices. */
const CONTENT_BEFORE =
  /(\b(ForEach|List|Picker|Menu|FlatList|SectionList|LazyVGrid|LazyHGrid|LazyVStack|LazyHStack|TabView|Carousel|Select|Segmented\w*)\s*\(\s*(\w+\s*:\s*)?|\b(data|items|options|presets|styles|choices|sections|outfits|looks|templates|categories|effects)\s*[:=]\s*\{?\s*|\.\.\.|\bconcat\s*\(\s*|contentsOf\s*:\s*|\+=\s*|(?<!\+)\+\s*)$/;
const CONTENT_AFTER =
  /^\s*([?!]?\.\s*(map|compactMap|flatMap|enumerated|randomElement|shuffled|joined|join|sorted|reversed|first|last|prefix|suffix|slice|at|indices|values|keys)\b|\[|\+(?![+=]))/;
const BARE_BEFORE = /(\breturn\s+|\{\s*|^\s*|=>\s*)$/;
const BARE_AFTER = /^\s*[}\]);,]*\s*$/;
const ASSIGN_AFTER = /^\s*(:\s*[^=\n]+)?=(?![=>])/;
const SAME_LINE_DECL = /\b(?:let|var|const|val)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=(?![=>])/;

const usesCache = new WeakMap<readonly SourceFile[], Map<string, ListUses>>();

/**
 * Classifies every reference to `ident` in `files`. A reference inside another list's initializer
 * (`let all = base + extra`) takes that list's verdict, so merging two blocklists stays a filter
 * and merging presets stays content.
 */
export function listUses(files: readonly SourceFile[], ident: string, depth = 0): ListUses {
  let cache = usesCache.get(files);
  if (!cache) {
    cache = new Map();
    usesCache.set(files, cache);
  }
  const hit = cache.get(ident);
  if (hit) return hit;
  const out: ListUses = { filter: 0, content: 0, other: 0 };
  cache.set(ident, out); // guards against a list that refers to itself
  const rx = new RegExp(`(?<![\\w$])${escapeRx(ident)}(?![\\w$])`, "g");
  const interp = new RegExp(`(\\\\\\(|\\$\\{)[^)}\\n]*(?<![\\w$])${escapeRx(ident)}(?![\\w$])`);
  for (const f of files) {
    if (!isCodeFile(f)) continue;
    // strings are blanked in the masked text, so interpolation into a prompt is checked on the raw code
    if (interp.test(f.code)) out.content++;
    const masked = maskedOf(f);
    for (const m of masked.matchAll(rx)) {
      const idx = m.index ?? 0;
      const lineStart = masked.lastIndexOf("\n", idx - 1) + 1;
      const lineEnd = masked.indexOf("\n", idx);
      const before = masked.slice(lineStart, idx);
      const pre = before.replace(QUALIFIER, "");
      const lineRest = masked.slice(idx + ident.length, lineEnd === -1 ? masked.length : lineEnd);
      if (pre === before && ASSIGN_AFTER.test(lineRest)) continue; // its own declaration or a reassignment
      // a chain continued on the next line (`terms\n  .contains { … }`) reads as one expression
      const chained = lineRest.trim() === "" && lineEnd !== -1 ? /^\s*([?!]?\.[^\n]*)/.exec(masked.slice(lineEnd + 1, lineEnd + 400))?.[1] : undefined;
      const rest = chained ?? lineRest;
      const window = masked.slice(lineStart, nthLineEnd(masked, idx, 3)).replace(rx, " ");
      const loop = /\b(in|of)\s+$/.test(pre);
      // `[...list].some(…)`: the spread only copies the list for the test that follows it
      const copied = /\.\.\.$/.test(pre) ? afterLiteral(masked, idx) : undefined;
      if (copied !== undefined && MEMBERSHIP_AFTER.test(copied)) {
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
      const combines = CONTENT_BEFORE.test(pre) || CONTENT_AFTER.test(rest) || (BARE_BEFORE.test(pre) && BARE_AFTER.test(rest));
      if (!combines) {
        out.other++;
        continue;
      }
      // Combined into another list, that list's own use decides. Only a list literal counts as an
      // initializer; a `{` is a computed property or closure body.
      const outer =
        SAME_LINE_DECL.exec(before)?.[1] ??
        (innermostOpen(masked, idx, Math.max(0, idx - 4000))?.ch === "["
          ? enclosingDeclarations(f, idx, 2).find((d) => VALUE_DECL.test(d.declKind) && d.ident !== ident)?.ident
          : undefined);
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

/** Text after the array literal enclosing `index`, when the literal is not assigned to anything. */
function afterLiteral(masked: string, index: number): string | undefined {
  const open = innermostOpen(masked, index, Math.max(0, index - 400));
  if (open?.ch !== "[" || /[\w$)\]]\s*$|=\s*$/.test(masked.slice(Math.max(0, open.at - 40), open.at))) return undefined;
  let depth = 0;
  for (let k = open.at; k < masked.length && k < open.at + 2000; k++) {
    const ch = masked[k];
    if (ch === "[" || ch === "(" || ch === "{") depth++;
    else if (ch === "]" || ch === ")" || ch === "}") {
      depth--;
      if (depth === 0) return masked.slice(k + 1, k + 200);
    }
  }
  return undefined;
}

function nthLineEnd(text: string, from: number, n: number): number {
  let at = from;
  for (let i = 0; i <= n; i++) {
    const nl = text.indexOf("\n", at);
    if (nl === -1) return text.length;
    at = nl + 1;
  }
  return at - 1;
}

/** Innermost unclosed bracket before `index` in masked code, with its offset. */
function innermostOpen(masked: string, index: number, floor = 0): { ch: string; at: number } | undefined {
  let depth = 0;
  for (let k = index - 1; k >= floor; k--) {
    const ch = masked[k]!;
    if (ch === "}" || ch === "]" || ch === ")") depth++;
    else if (ch === "{" || ch === "[" || ch === "(") {
      if (depth > 0) depth--;
      else return { ch, at: k };
    }
  }
  return undefined;
}

/**
 * Whether an offset sits inside a list of refused terms. Code lists are judged by how they are
 * used, never by their name: a list counts as a filter when a membership test on it decides
 * something, and as content (residue) when it is shown, merged, returned or sent to a model,
 * whatever it is called. Data files and keys have no use site to read, so a narrow name check
 * stands in there.
 */
export function blocklistAt(ctx: ScanContext, file: SourceFile, index: number): BlocklistContext | undefined {
  return blocklistIn(ctx.files, file, index);
}

export function blocklistIn(files: readonly SourceFile[], file: SourceFile, index: number): BlocklistContext | undefined {
  const line = lineOf(file.text, index);
  const base = path.basename(file.path).replace(/\.[^.]+$/, "");
  if (BLOCKLIST_NAME.test(base) && !isCodeFile(file)) {
    return { name: base, file: file.path, line, used: referencedByName(files, base, file.path) };
  }
  if (isCodeFile(file)) {
    const masked = maskedOf(file);
    // Only a term written directly in a list literal can be a refused term. One inside a call, an
    // object or a view body (Outfit(title:…, prompt:…), { id, prompt }, Text(…)) is content.
    const open = innermostOpen(masked, index, Math.max(0, index - 20_000));
    if (!open) return undefined;
    const listOpen = open.ch === "[" || (open.ch === "(" && LIST_CALL.test(masked.slice(Math.max(0, open.at - 24), open.at)));
    if (!listOpen) return undefined;
    const d = enclosingDeclarations(file, open.at + 1, 2).find((x) => VALUE_DECL.test(x.declKind))?.ident;
    if (!d) return undefined;
    const u = listUses(files, d);
    if (u.content) return undefined;
    if (u.filter) return { name: d, file: file.path, line, used: true };
    // Declared but never tested: only an explicit refusal name keeps it out of the residue.
    if (!BLOCKLIST_NAME.test(d)) return undefined;
    return { name: d, file: file.path, line, used: false };
  }
  // JSON / YAML / plist: nearest enclosing key above the match.
  const lines = file.text.split("\n");
  for (let i = line - 1; i >= 0 && i >= line - 200; i--) {
    const l = lines[i] ?? "";
    const key = /^\s*(?:<key>([\w.-]+)<\/key>|["']?([\w.-]+)["']?\s*[:=])/.exec(l);
    if (key) {
      const name = key[1] ?? key[2] ?? "";
      if (!BLOCKLIST_NAME.test(name)) return undefined;
      return { name, file: file.path, line, used: referencedByName(files, name, file.path) };
    }
  }
  return undefined;
}

function referencedByName(files: readonly SourceFile[], name: string, self: string): boolean {
  const rx = new RegExp(`["'/]${escapeRx(name)}(\\.\\w+)?["']|\\b${escapeRx(name)}\\b`);
  return files.some((f) => f.path !== self && isCodeFile(f) && rx.test(f.code));
}

const REFUSAL = /\b(never|do not|don't|must not|mustn't|refuse to|decline to|avoid|not allowed|prohibited|forbidden|disallowed)\b/i;
const REFUSAL_LOOPHOLE = /\b(unless|except|only if|but if|if the user|premium|subscriber|when asked)\b|\b(never|don't|do not)\s+(refuse|decline|reject)/i;

/** A prompt sentence that tells the model to refuse the term (not residue, not a filter either). */
export function isRefusalInstruction(text: string, index: number): boolean {
  const start = Math.max(text.lastIndexOf(".", index - 1), text.lastIndexOf("\n", index - 1)) + 1;
  const endDot = text.indexOf(".", index);
  const endNl = text.indexOf("\n", index);
  const ends = [endDot, endNl].filter((n) => n >= 0);
  const end = ends.length ? Math.min(...ends) : text.length;
  const sentence = text.slice(start, end);
  const before = text.slice(start, index);
  return REFUSAL.test(before) && !REFUSAL_LOOPHOLE.test(sentence);
}

/** Fields a moderation or safety API returns per category; a file reading them handles a filter's verdict. */
const MODERATION_RESULT = /\b(category_scores|categoryScores|category_applied_input_types|flagged|safetyRatings|safety_ratings|HarmCategory|HARM_CATEGORY_\w+|ModerationLabels|moderationLabels)\b/;
const isModerationSite = (g: SourceFile) =>
  isCodeFile(g) && (MODERATION_TEXT.test(g.code) || MODERATION_IMAGE.test(g.code) || SAFETY_STRICT.test(g.code) || SAFETY_DISABLED.test(g.code));
const moderationCtxCache = new WeakMap<readonly SourceFile[], Map<SourceFile, boolean>>();

/**
 * A file that calls a moderation or safety API, or reads such a result for a file that does (they
 * name each other's declarations). Only there is a category key read as a filter's own vocabulary.
 */
function moderationContext(files: readonly SourceFile[], f: SourceFile): boolean {
  let cache = moderationCtxCache.get(files);
  if (!cache) moderationCtxCache.set(files, (cache = new Map()));
  const hit = cache.get(f);
  if (hit !== undefined) return hit;
  let ok = isModerationSite(f);
  if (!ok && isCodeFile(f) && MODERATION_RESULT.test(f.code)) {
    const mine = new Set(declaredNames(f));
    const used = identifiersOf([f]);
    ok = files.some((g) => g !== f && g.path !== f.path && isModerationSite(g) && (declaredNames(g).some((n) => used.has(n)) || [...identifiersOf([g])].some((n) => mine.has(n))));
  }
  cache.set(f, ok);
  return ok;
}

function literalAround(code: string, index: number): { open: number; close: number; value: string } | undefined {
  const start = code.lastIndexOf("\n", index - 1) + 1;
  const endNl = code.indexOf("\n", index);
  const line = code.slice(start, endNl === -1 ? code.length : endNl);
  for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`([^`]*)`/g)) {
    const a = start + (m.index ?? 0);
    if (a < index && index < a + m[0].length) return { open: a, close: a + m[0].length, value: m[1] ?? m[2] ?? m[3] ?? "" };
  }
  return undefined;
}

const RESULT_WORD = String.raw`(?:categories|category_?scores|categoryScores|category_applied_input_types|[\w$]*[sS]cores?|safety_?[rR]atings|ratings|[\w$]*[mM]oderation[\w$]*|[\w$]*[tT]hresholds?|harm[\w$]*)[?!]?`;
/** `scores["sexual"]`, `category_scores?["hate"]`, `scores.get("sexual")`, `categories.sexual`: read off a result. */
const RESULT_SUBSCRIPT = new RegExp(String.raw`\b${RESULT_WORD}\s*(\[\s*|\.\s*(get|getValue|value|optDouble|getDouble|getFloat|getBoolean|valueForKey|objectForKey)\s*\(\s*)$`, "i");
const RESULT_CHAIN = new RegExp(String.raw`\b${RESULT_WORD}\s*\.\s*$`, "i");
const RESULT_TYPE = /categor|score|rating|moderat|safety|harm|threshold/i;

/**
 * Whether a term match is a moderation category key: `scores["sexual"]`, `categories.sexual`,
 * `HARM_CATEGORY_HATE_SPEECH`, a property of a decoded CategoryScores type. Reading the category a
 * filter scored is the filter at work, not the rejected capability, so it is not residue.
 */
export function moderationKeyIn(files: readonly SourceFile[], f: SourceFile, index: number, end: number): boolean {
  if (!isCodeFile(f) || !moderationContext(files, f)) return false;
  const src = f.code;
  let a = index;
  let b = end;
  while (a > 0 && /[\w$]/.test(src[a - 1]!)) a--;
  while (b < src.length && /[\w$]/.test(src[b]!)) b++;
  const ident = src.slice(a, b);
  const before = src.slice(Math.max(0, a - 120), a);
  if (/^HARM_CATEGORY_/.test(ident) || /\bHarmCategory\w*\s*\.\s*$/.test(before)) return true;
  const masked = maskedOf(f);
  // A key written into a declaration named for results or thresholds (`let thresholds = ["sexual": 0.2]`,
  // `enum CategoryScores.CodingKeys { case sexualMinors = "sexual/minors" }`); a styles map is content.
  const inResultDecl = () => enclosingDeclarations(f, index).some((d) => RESULT_TYPE.test(d.ident));
  if (masked.slice(index, end) !== src.slice(index, end)) {
    const lit = literalAround(src, index);
    if (!lit || !/^[A-Za-z][\w/ .-]{0,39}$/.test(lit.value)) return false;
    if (RESULT_SUBSCRIPT.test(src.slice(Math.max(0, lit.open - 120), lit.open))) return true;
    const keyed = /^\s*:/.test(src.slice(lit.close, lit.close + 4)) || /\bcase\s+[\w$]+\s*=\s*$/.test(src.slice(Math.max(0, lit.open - 80), lit.open));
    return keyed && inResultDecl();
  }
  if (RESULT_CHAIN.test(before)) return true;
  // a stored property of a decoded result type: `let sexual: Double` inside struct CategoryScores
  const line = lineText(src, index);
  if (!new RegExp(`^(?:(?:public|private|internal|readonly|export|@\\w+)\\s+)*(?:(?:let|var|val)\\s+)?["']?${escapeRx(ident)}["']?\\??\\s*:`).test(line)) return false;
  return inResultDecl();
}

// ---------------------------------------------------------------------------
// Rejection-text → terms
// ---------------------------------------------------------------------------

interface Category {
  id: string;
  describe: string;
  triggers: RegExp;
  terms: string[];
}

export const CATEGORIES: Category[] = [
  {
    id: "lingerie",
    describe: "images of a person in lingerie, underwear or similarly revealing clothing",
    triggers: /\b(lingerie|underwear|bikini|swimsuit|revealing (clothing|outfits?)|undergarments?|bra|panties|thong|negligee|boudoir)\b/i,
    terms: ["lingerie", "underwear", "bra", "panties", "thong", "negligee", "bikini", "swimsuit", "corset", "see-through", "boudoir", "nightie"],
  },
  {
    id: "nudity",
    describe: "nude or sexually explicit images, including undressing a real person's photo",
    triggers: /\b(nud(e|ity)|naked|pornograph\w*|sexually explicit|nsfw|topless|undress\w*|1\.1\.4|ncii|nudif\w*)\b/i,
    terms: ["nude", "naked", "nudity", "nsfw", "topless", "undress", "porn", "x-ray", "nudify"],
  },
  {
    id: "sexual",
    describe: "sexualized or overtly sexual content",
    triggers: /\b(sexual\w*|sexy|erotic\w*|seductive|lewd|overtly sexual|adult content|fetish\w*|1\.1\.4)\b/i,
    terms: ["sexual", "sexy", "erotic", "seductive", "lewd", "spicy", "fetish", "adult content", "nsfw"],
  },
  {
    id: "violence",
    describe: "graphic violence or gore",
    triggers: /\b(violen\w*|gore|gory|graphic|blood\w*|torture|dismember\w*|1\.1\.2)\b/i,
    terms: ["violence", "violent", "gore", "gory", "bloody", "dismember", "torture", "behead", "mutilate"],
  },
  {
    id: "drugs",
    describe: "content that encourages illegal drug use",
    triggers: /\b(drugs?|narcotic\w*|cocaine|heroin|marijuana|cannabis|1\.4\.3)\b/i,
    terms: ["drugs", "cocaine", "heroin", "meth", "marijuana", "cannabis", "mdma", "weed"],
  },
  {
    id: "self-harm",
    describe: "content that depicts or encourages self-harm or suicide",
    triggers: /\b(self[- ]?harm|suicid\w*|eating disorder)\b/i,
    terms: ["self-harm", "suicide", "suicidal", "self harm", "pro-ana"],
  },
  {
    id: "hate",
    describe: "hateful, discriminatory or defamatory content",
    triggers: /\b(hate|hateful|discriminat\w*|racis\w*|slurs?|defamatory|1\.1\.1)\b/i,
    terms: ["hate", "hateful", "slur", "racist", "nazi", "supremacist", "bigot"],
  },
  {
    id: "weapons",
    describe: "content that facilitates weapons or explosives",
    triggers: /\b(weapons?|firearms?|explosives?|1\.4\.3)\b/i,
    terms: ["weapon", "firearm", "explosive", "ammo", "bomb"],
  },
  {
    id: "gambling",
    describe: "real-money gambling",
    triggers: /\b(gambl\w*|casino|betting|5\.3)\b/i,
    terms: ["gambling", "casino", "betting", "wager"],
  },
];

const LEXICON = new Set(CATEGORIES.flatMap((c) => c.terms));

const STOPWORDS = new Set(
  `about above after again against also apple apps application because been before being below between both cannot could
  does doing down during each few from further guideline guidelines have having here hers herself himself however into
  itself just more most must myself need only other ours ourselves over please same section should some such than that
  their theirs them themselves then there these they this those through under until very what when where which while
  will with within would your yours yourself yourselves review reviewed reviewer submission submitted content contents
  feature features user users safety objectionable include includes including issue issues found specifically hello
  thank thanks regards team information resolution center next steps update updated version build binary store
  inappropriate appropriate generated generate generates generating create created allow allows allowed allowing
  people person persons image images photo photos picture pictures option options make makes made like using used
  provide provided able potentially example examples following note notes`.split(/\s+/),
);

const SEXUAL_FAMILY = new Set(["lingerie", "nudity", "sexual"]);
/** Nouns for what a user dresses or styles; searched only when the rejection is about sexual content. */
const CONTENT_NOUNS = ["outfit", "costume", "wardrobe", "clothing", "clothes", "attire", "lingerie"];

export interface TermCandidate {
  term: string;
  origin: "rejection" | "quoted" | "lexicon";
  category?: string;
}

/**
 * Nouns from Apple's wording ("outfit") name where the feature lived, not what must disappear:
 * a compliant outfit picker can stay. They steer the search but are kept out of the residue draft.
 */
export const isContextTerm = (t: Pick<TermCandidate, "category">) => t.category === "content";

export function termsFromRejection(text: string): { terms: TermCandidate[]; categories: Category[]; otherWords: string[] } {
  const categories = CATEGORIES.filter((c) => c.triggers.test(text));
  const out = new Map<string, TermCandidate>();
  const add = (t: TermCandidate) => {
    const key = t.term.toLowerCase();
    if (!out.has(key)) out.set(key, { ...t, term: key });
  };
  for (const m of text.matchAll(/[“"']([^“”"'\n]{3,40})[”"']/g)) {
    const q = m[1]!.trim();
    if (q.split(/\s+/).length <= 4 && !/^\d/.test(q)) add({ term: q, origin: "quoted" });
  }
  const words = (text.toLowerCase().match(/[\p{L}][\p{L}'-]{3,}/gu) ?? []).map((w) => w.replace(/'s$/, ""));
  for (const w of words) {
    for (const c of categories) {
      const hit = c.terms.includes(w) ? w : c.terms.includes(w.replace(/s$/, "")) ? w.replace(/s$/, "") : undefined;
      if (hit) add({ term: hit, origin: "rejection", category: c.id });
    }
  }
  for (const c of categories) for (const t of c.terms) add({ term: t, origin: "lexicon", category: c.id });
  // "Sexually suggestive outfits" names no garment; the features that produce it usually do.
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

// ---------------------------------------------------------------------------
// findSurface
// ---------------------------------------------------------------------------

export interface SurfaceCandidate {
  kind: "symbol" | "asset" | "string" | "endpoint" | "flag" | "promptFragment" | "file";
  value: string;
  term: string;
  file: string;
  line?: number;
  evidence?: string;
  /** found only through context terms; listed for orientation, not residue */
  context?: boolean;
}

export interface AiSite {
  role: "source" | "sink" | "moderation" | "safety-disabled" | "safety-strict";
  label: string;
  file: string;
  line: number;
  evidence: string;
}

export interface SurfaceResult {
  /** Draft for the agent to confirm and edit; nothing here is final. */
  draft: ResidueSpec;
  /**
   * Terms and entries found only through context nouns from Apple's message (e.g. "outfit",
   * OutfitCatalog). They show where the feature lived; they are not residue and are not in the draft.
   */
  context: { terms: string[]; symbols: string[]; promptFragments: string[]; other: string[] };
  terms: (TermCandidate & { inRepo: number })[];
  /** Lexicon terms in the draft that the repo never had: kept so a later reintroduction is caught. */
  regressionTerms: string[];
  /** Salient words from the rejection text that are not in the lexicon; candidates only. */
  otherWords: string[];
  candidates: SurfaceCandidate[];
  sources: AiSite[];
  sinks: AiSite[];
  moderation: AiSite[];
  /** "file:line: snippet" lines backing the candidates */
  evidence: string[];
  notes: string[];
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|pdf|svg|mp4|mov|m4v|webm|gltf|glb|usdz)$/i;
const ASSET_SET = /\.(imageset|colorset|dataset|symbolset|appiconset|textureset|spriteatlas)$/i;
// `remoteConfig()["key"]` (Firebase's subscript on the singleton) is as common as `remoteConfig["key"]`.
const FLAG_READ =
  /\b(remoteConfig|RemoteConfig|configValue|getBoolean|getValue|getString|isFeatureEnabled|featureFlag|useFlag|useFeatureFlag|useFeatureFlagEnabled|useGate|checkGate|getFeatureGate|boolVariation|variation|getFeatureValue|isOn|isEnabled)\s*(?:\(\s*\)\s*)?(?:\(\s*(?:forKey:\s*)?|\[\s*)["'`]([\w.:-]+)["'`]/g;
const REMOTE_CONFIG_FILE = /\b(remoteConfig|RemoteConfig|setDefaults|featureFlag|useFlag|useFeatureFlag|LaunchDarkly|Statsig|GrowthBook|ConfigCat|Unleash)\b/;
const STRINGS_PAIR = /^\s*"((?:[^"\\]|\\.)+)"\s*=\s*"((?:[^"\\]|\\.)*)"\s*;/gm;
const URL_LIT = /["'`]((?:https?:\/\/|\/)[^\s"'`]{2,200})["'`]/g;
const STRING_LIT = /"((?:[^"\\\n]|\\.){12,400})"|'((?:[^'\\\n]|\\.){12,400})'|`([^`]{12,600})`/g;

// Sign-in, profile-name and search fields take text but do not feed a generator.
const CREDENTIAL_FIELD =
  /\b(?:TextField|TextInput|UITextField)\b[^\n]{0,80}?["'`$(](?:e-?mail(?:\s*address)?|password|passcode|user\s*name|username|(?:first|last|full|display|nick)?\s*name|name\s*draft|search(?:\s+\w+)?|phone|code)["'`)\s,]|\bSecureField\b|\bsecureTextEntry\b|\bkeyboardType\s*[:=]\s*["'`.](?:email|emailAddress|email-address|phonePad|numberPad)|\btextContentType\s*[:=]\s*["'`.]?(?:emailAddress|username|password|newPassword|name|oneTimeCode)/i;

function isCredentialField(src: string, index: number): boolean {
  const line = lineText(src, index);
  return CREDENTIAL_FIELD.test(line) || /\$(?:email|password|username|userName|name|nameDraft|search\w*|query)\b/.test(line);
}

const DECLARED_TYPE = /\b(?:class|struct|enum|protocol|actor|interface|object|extension)\s+([A-Z][\w]*)|\bfunction\s+([A-Za-z_$][\w$]*)|\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
const LINK_SKIP = new Set(["App", "View", "Body", "Content", "ContentView", "Model", "State", "Error", "Failure", "Result", "Config"]);

/** Types, JS functions and exported values a file declares; what another file has to name to call into it. */
export function declaredNames(f: SourceFile): string[] {
  const out = new Set<string>();
  for (const m of f.code.matchAll(DECLARED_TYPE)) {
    const n = m[1] ?? m[2] ?? m[3];
    if (n && n.length >= 3 && !LINK_SKIP.has(n)) out.add(n);
  }
  return [...out];
}

export function identifiersOf(files: SourceFile[]): Set<string> {
  return new Set(files.flatMap((f) => f.code.match(/[A-Za-z_$][\w$]*/g) ?? []));
}

/** Sinks in the source file, or in a file declaring something the source file names (co-location only). */
function linkedSinks(ctx: ScanContext, sourceFile: string, sinks: AiSite[]): AiSite[] {
  const f = ctx.files.find((x) => x.path === sourceFile);
  if (!f) return [];
  const used = identifiersOf([f]);
  const reach = new Set([sourceFile]);
  for (const g of ctx.files) if (g.path !== sourceFile && isCodeFile(g) && declaredNames(g).some((n) => used.has(n))) reach.add(g.path);
  return sinks.filter((s) => reach.has(s.file));
}

export interface SourceLink {
  /** sinks the input's own variable reaches (read in a function or statement that calls into the sink's file) */
  traced: AiSite[];
  /** sinks that only share a file or a named type with the input; no data flow was found */
  inferred: AiSite[];
  variable?: string;
}

function offsetOfLine(text: string, line: number): number {
  let at = 0;
  for (let i = 1; i < line; i++) {
    const nl = text.indexOf("\n", at);
    if (nl === -1) return at;
    at = nl + 1;
  }
  return at;
}

/** The state an input writes to: `$draft` (SwiftUI binding), `setPrompt` → `prompt` (React), `result = await launch…`. */
function boundVariable(code: string, window: string): string | undefined {
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

/** Offset of the `}` closing the block opened at `open` (masked code, so braces in strings do not count). */
function blockEnd(masked: string, open: number): number {
  let depth = 0;
  for (let k = open; k < masked.length; k++) {
    const c = masked[k];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return k;
  }
  return masked.length;
}

const FUNC_HEADER =
  /(?:\bfunc\s+([A-Za-z_]\w*)|\bfunction\s+([A-Za-z_$][\w$]*)|\b([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>|^\s*(?:async\s+)?([a-z_$][\w$]*)\s*\([^()]*\)\s*(?::\s*[^{]+)?)[^{};]*$/;

/** Innermost named function around `index`; view bodies and React components are skipped because they hold every input. */
function enclosingFunction(f: SourceFile, index: number): [number, number] | undefined {
  const masked = maskedOf(f);
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
  return undefined;
}

/** The statement at `index` plus any blocks or argument lists it opens (a closure such as `.onChange { … }`). */
function statementRegion(f: SourceFile, index: number): [number, number] {
  const masked = maskedOf(f);
  const start = masked.lastIndexOf("\n", index - 1) + 1;
  let end = masked.indexOf("\n", index);
  if (end === -1) end = masked.length;
  let depth = 0;
  for (let k = start; k < masked.length && k - start < 4000; k++) {
    const c = masked[k];
    if (c === "{" || c === "(") depth++;
    else if ((c === "}" || c === ")") && depth > 0) depth--;
    if (k >= end && depth === 0) return [start, k];
  }
  return [start, end];
}

/**
 * Which generation calls an input actually feeds: its variable must be read in a function or
 * statement that calls into the sink's file (directly, through a property holding that type, one
 * helper hop away, or through a type such as a view model whose file calls the sink). Merely
 * sharing a view or a named type with a sink is reported as `inferred`, not traced.
 */
export function linkSource(ctx: ScanContext, source: AiSite, sinks: AiSite[]): SourceLink {
  const inferred = linkedSinks(ctx, source.file, sinks);
  const f = ctx.files.find((x) => x.path === source.file);
  if (!f || !isCodeFile(f) || !sinks.length) return { traced: [], inferred };
  const srcAt = offsetOfLine(f.code, source.line);
  const srcEnd = offsetOfLine(f.code, source.line + 3);
  const window = f.code.slice(srcAt, srcEnd > srcAt ? srcEnd : f.code.length);
  const variable = boundVariable(f.code, window);
  if (!variable) return { traced: [], inferred };

  const masked = maskedOf(f);
  const regions: [number, number][] = [];
  for (const m of f.code.matchAll(new RegExp(`(?<![\\w$])${escapeRx(variable)}(?![\\w$])`, "g"))) {
    const at = m.index ?? 0;
    if (at >= srcAt && at < srcAt + window.length) continue;
    if (/(?:var|let|const|val)\s+$|\[\s*$/.test(f.code.slice(Math.max(0, at - 40), at))) continue;
    regions.push(enclosingFunction(f, at) ?? statementRegion(f, at));
  }
  if (!regions.length) return { traced: [], inferred, variable };
  // one hop: helpers in the same file that those regions call
  const helpers = new Map<string, [number, number]>();
  for (const m of masked.matchAll(/\b(?:func|function)\s+([A-Za-z_$][\w$]*)\s*[(<]/g)) {
    const open = masked.indexOf("{", m.index ?? 0);
    if (open !== -1) helpers.set(m[1]!, [open, blockEnd(masked, open)]);
  }
  for (const [a, b] of [...regions]) {
    for (const call of f.code.slice(a, b).matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
      const h = helpers.get(call[1]!);
      if (h && !regions.some(([x, y]) => x === h[0] && y === h[1])) regions.push(h);
    }
  }

  // properties and the types they hold: `private let chat = CompanionChat()`, `vm: ChatViewModel`
  const propType = new Map<string, string>();
  for (const m of f.code.matchAll(/\b(?:let|var|const)\s+([A-Za-z_$][\w$]*)\s*(?::\s*([A-Z]\w*))?\s*(?:=\s*(?:new\s+)?([A-Z]\w*)\b)?/g)) {
    const t = m[3] ?? m[2];
    if (t) propType.set(m[1]!, t);
  }
  const names = new Set<string>();
  for (const [a, b] of regions) {
    for (const id of f.code.slice(a, b).match(/[A-Za-z_$][\w$]*/g) ?? []) {
      names.add(id);
      const t = propType.get(id);
      if (t) names.add(t);
    }
  }
  const declaresUsed = (g: SourceFile) => declaredNames(g).some((n) => names.has(n));
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

function siteScan(ctx: ScanContext): { sources: AiSite[]; sinks: AiSite[]; moderation: AiSite[] } {
  const sources: AiSite[] = [];
  const sinks: AiSite[] = [];
  const moderation: AiSite[] = [];
  const push = (arr: AiSite[], role: AiSite["role"], label: string, f: SourceFile, idx: number) =>
    arr.push({ role, label, file: f.path, line: lineOf(f.code, idx), evidence: lineText(f.text, idx).slice(0, 160) });
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
    for (const m of src.matchAll(new RegExp(SAFETY_DISABLED.source, "g"))) push(moderation, "safety-disabled", m[0], f, m.index ?? 0);
    for (const m of src.matchAll(new RegExp(SAFETY_STRICT.source, "g"))) push(moderation, "safety-strict", m[0], f, m.index ?? 0);
  }
  const dedupe = (a: AiSite[]) => {
    const seen = new Set<string>();
    return a.filter((s) => {
      const k = `${s.role}|${s.label}|${s.file}|${s.line}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  // A request to a moderation endpoint screens content; it generates nothing, so it is not a sink.
  const screening = new Set(moderation.filter((m) => m.role === "moderation").map((m) => `${m.file}:${m.line}`));
  return { sources: dedupe(sources), sinks: dedupe(sinks.filter((s) => !screening.has(`${s.file}:${s.line}`))), moderation: dedupe(moderation) };
}

export function aiSites(ctx: ScanContext) {
  return siteScan(ctx);
}

function identAround(src: string, start: number, end: number): string {
  let a = start;
  let b = end;
  while (a > 0 && /[\w$]/.test(src[a - 1]!)) a--;
  while (b < src.length && /[\w$]/.test(src[b]!)) b++;
  return src.slice(a, b);
}

export async function findSurface(ctx: ScanContext, rejectionText: string): Promise<SurfaceResult> {
  const { terms, categories, otherWords } = termsFromRejection(rejectionText);
  const notes: string[] = [];
  const candidates: SurfaceCandidate[] = [];
  const evidence: string[] = [];
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  const contextTerms = new Set(terms.filter(isContextTerm).map((t) => t.term));
  const addCand = (c: SurfaceCandidate) => {
    const key = `${c.kind}|${c.value.toLowerCase()}`;
    counts.set(c.term, (counts.get(c.term) ?? 0) + 1);
    const isContext = contextTerms.has(c.term.toLowerCase());
    if (seen.has(key)) {
      // the same entry reached through a real residue term is residue after all
      if (!isContext) for (const x of candidates) if (`${x.kind}|${x.value.toLowerCase()}` === key) delete x.context;
      return;
    }
    seen.add(key);
    candidates.push(isContext ? { ...c, context: true } : c);
    if (c.line) evidence.push(`${c.file}:${c.line}: ${c.evidence ?? c.value}`);
    else evidence.push(`${c.file}: ${c.value}`);
  };

  const termNeedles = terms.map((t) => makeNeedle("term", t.term)!).filter(Boolean);

  for (const f of ctx.files) {
    for (const n of termNeedles) {
      for (const m of matchNeedle(n, f.code, 50)) {
        const line = lineOf(f.code, m.index);
        const ev = lineText(f.text, m.index).slice(0, 160);
        if (isCodeFile(f)) {
          const masked = maskedOf(f);
          const inString = masked.slice(m.index, m.end) !== f.code.slice(m.index, m.end);
          if (!inString) {
            const ident = identAround(f.code, m.index, m.end);
            const declared = new RegExp(
              `\\b(func|function|class|struct|enum|protocol|interface|type|let|var|const|case)\\s+${escapeRx(ident)}\\b`,
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
        const [key, value] = [m[1]!, m[2]!];
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
        const key = m[2]!;
        const n = termNeedles.find((t) => matchNeedle(t, key, 1).length);
        if (n) addCand({ kind: "flag", value: key, term: n.value, file: f.path, line: lineOf(f.code, m.index ?? 0), evidence: lineText(f.text, m.index ?? 0) });
      }
      for (const m of f.code.matchAll(URL_LIT)) {
        const url = m[1]!;
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
  const inputPaths: string[] = [];
  if (sinks.length) {
    let untraced = 0;
    let inferredOnly = 0;
    for (const s of sources) {
      if (inputPaths.some((p) => p.startsWith(`${s.label} (${s.file}:`))) continue;
      const link = linkSource(ctx, s, sinks);
      const at = (xs: AiSite[]) => [...new Set(xs.map((x) => `${x.file}:${x.line}`))].slice(0, 3).join(", ");
      if (link.traced.length) inputPaths.push(`${s.label} (${s.file}:${s.line}) → AI generation (${at(link.traced)})`);
      else if (link.inferred.length) {
        inferredOnly++;
        inputPaths.push(`${s.label} (${s.file}:${s.line}) → AI generation (linkage inferred, not traced: ${at(link.inferred)}; confirm or remove)`);
      } else {
        untraced++;
        inputPaths.push(`${s.label} (${s.file}:${s.line}) → AI generation (call not traced; confirm or remove)`);
      }
    }
    if (untraced) notes.push(`${untraced} input source(s) could not be linked to an AI call by name; trace each one by hand and drop it from inputPaths if it never reaches a generator.`);
    if (inferredOnly) notes.push(`${inferredOnly} input source(s) only share a view or type with an AI call; no data flow from the input to the call was found. Trace each one and keep only the calls it really feeds.`);
    if (!sources.length) notes.push("AI sinks found but no user input sources were recognized; trace how prompts are built by hand.");
    // One entry per file for the preset type, tied to the AI calls that file names, so it is judged against those.
    const presetFiles = new Set<string>();
    const presets = candidates
      .filter((c) => c.kind === "symbol" && /^[A-Z]/.test(c.value) && /picker|outfit|preset|style|template|option|menu|catalog/i.test(c.value))
      .sort((a, b) => Number(/picker|catalog|preset/i.test(b.value)) - Number(/picker|catalog|preset/i.test(a.value)));
    for (const p of presets) {
      if (presetFiles.has(p.file)) continue;
      presetFiles.add(p.file);
      const linked = linkedSinks(ctx, p.file, sinks);
      const at = [...new Set(linked.map((x) => `${x.file}:${x.line}`))].slice(0, 3).join(", ");
      inputPaths.push(`preset/picker ${p.value} (${p.file}:${p.line ?? "?"})${at ? ` → AI generation (${at})` : ""}`);
    }
  } else {
    notes.push("No AI generation call was recognized in the repo; if generation happens on a server outside this repo, its prompt and filters must be attested by the developer.");
  }
  if (!terms.length) notes.push("No category from the expansion lexicon matched the rejection text; add terms by hand from the reviewer's wording and screenshots.");
  notes.push("Every entry is a candidate. Confirm each against the code, remove anything unrelated, and add input paths the scan could not see (remix, share extension, server-side presets).");

  const pick = (k: SurfaceCandidate["kind"], cap = 40) => [...new Set(candidates.filter((c) => c.kind === k && !c.context).map((c) => c.value))].slice(0, cap);
  const pickContext = (kinds: SurfaceCandidate["kind"][]) => [...new Set(candidates.filter((c) => kinds.includes(c.kind) && c.context).map((c) => c.value))].slice(0, 40);
  const context = {
    terms: [...contextTerms],
    symbols: pickContext(["symbol"]),
    promptFragments: pickContext(["promptFragment"]),
    other: pickContext(["asset", "string", "endpoint", "flag", "file"]),
  };
  if (context.terms.length) {
    notes.push(
      `Context terms (${context.terms.join(", ")}) and the ${context.symbols.length + context.promptFragments.length + context.other.length} entries found only through them are not residue and are left out of the draft: they show where the feature lived. List only what must disappear.`,
    );
  }
  const metadataSurfaces = [
    ...candidates.filter((c) => !c.context && /(^|\/)(fastlane\/)?metadata\//.test(c.file)).map((c) => c.file),
    // "uncensored" or "no filters" in the listing invites the same 1.1/1.2 review whatever the rejection named.
    ...metadataTexts(ctx).filter((t) => t.surface === "store" && CONTENT_SIGNAL_CLAIMS.test(t.text)).map((t) => `${t.file} (${t.field}${t.locale === "default" ? "" : `, ${t.locale}`})`),
  ];
  // Named after what the scan matched in this repo ("Lingerie outfit"), not the lexicon category.
  const found = terms.filter((t) => !isContextTerm(t) && (counts.get(t.term) ?? 0) > 0).sort((a, b) => (counts.get(b.term) ?? 0) - (counts.get(a.term) ?? 0));
  const where = [...contextTerms].find((t) => (counts.get(t) ?? 0) > 0);
  const named = found.slice(0, 2).map((t) => t.term).join(" / ");
  const featureText = named ? `${named}${where ? ` ${where}` : ""}${categories.length ? ` (${categories.slice(0, 2).map((c) => c.describe.split(",")[0]).join("; ")})` : ""}` : (categories[0]?.describe.split(",")[0] ?? terms[0]?.term ?? otherWords[0] ?? "rejected feature");
  const feature = featureText.charAt(0).toUpperCase() + featureText.slice(1);
  const regressionTerms = terms.filter((t) => t.origin === "lexicon" && !isContextTerm(t) && !(counts.get(t.term) ?? 0)).map((t) => t.term);
  if (regressionTerms.length) {
    notes.push(
      `${regressionTerms.length} lexicon terms were not found in the repo (${regressionTerms.slice(0, 6).join(", ")}${regressionTerms.length > 6 ? ", …" : ""}). They stay in the draft as regression guards so verify catches them if they appear later; they do not show what this app had.`,
    );
  }
  const capability = categories.length
    ? `A user can no longer obtain ${categories.map((c) => c.describe).join("; ")} through any input path (pickers, presets, free-text prompts, image uploads, remixes, deep links).`
    : "Describe what a user must no longer be able to do or produce, at capability level, not which screen was removed.";

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
    metadataSurfaces: [...new Set(metadataSurfaces)],
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
    notes,
  };
}

/** Docs that never ship in the app bundle. */
export function isDocPath(rel: string): boolean {
  const base = rel.split("/").pop() ?? rel;
  if (!rel.includes("/") && /\.(md|txt)$/i.test(base)) return true;
  if (/^(docs?|documentation|\.github)\//i.test(rel)) return true;
  return /^(README|CHANGELOG|LICENSE|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY|NOTICE)(\.|$)/i.test(base);
}

function stringLiteralAt(code: string, index: number): string | undefined {
  const start = code.lastIndexOf("\n", index - 1) + 1;
  const end = code.indexOf("\n", index);
  const line = code.slice(start, end === -1 ? code.length : end);
  for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`([^`]*)`/g)) {
    const a = start + (m.index ?? 0);
    if (a < index && index < a + m[0].length) return m[1] ?? m[2] ?? m[3];
  }
  return undefined;
}

function flagKeyNear(code: string, index: number): string | undefined {
  const from = Math.max(0, index - 400);
  // Reach past the match so a key that itself contains the term (read of "spicy_mode") is found too.
  const window = code.slice(from, index + 120);
  let last: string | undefined;
  for (const m of window.matchAll(FLAG_READ)) if (from + (m.index ?? 0) < index) last = m[2];
  return last;
}

export function xcstringsEntries(text: string): { key: string; values: string[] }[] {
  try {
    const json = JSON.parse(text) as { strings?: Record<string, { localizations?: Record<string, unknown> }> };
    return Object.entries(json.strings ?? {}).map(([key, v]) => ({
      key,
      values: JSON.stringify(v?.localizations ?? {}).match(/"value"\s*:\s*"((?:[^"\\]|\\.)*)"/g)?.map((s) => s.replace(/^"value"\s*:\s*"|"$/g, "")) ?? [],
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// validateSpec
// ---------------------------------------------------------------------------

export interface SpecValidation {
  ok: boolean;
  /** hard failures: entries that exist nowhere (likely hallucinated) or malformed evidence */
  problems: string[];
  warnings: string[];
}

/** Parses "path:line" / "path:line: snippet" / "path:line snippet" evidence references. */
export function parseEvidenceRef(ev: string): { file: string; line: number; snippet?: string } | undefined {
  const m = /^\s*([^\s:]+(?:\/[^\s:]+)*\.[A-Za-z0-9]+):(\d+)(?::\d+)?(?:[:\s]\s*(.*))?$/.exec(ev);
  if (!m) return undefined;
  return { file: m[1]!, line: Number(m[2]), snippet: m[3]?.trim() || undefined };
}

/** Words a spec entry uses for each kind of detected input, to tell whether the spec already lists it. */
const SOURCE_WORDS: Record<string, RegExp> = {
  "free-text prompt": /text|prompt|chat|message|describ|type|field|input/i,
  "image upload": /image|photo|upload|picker|selfie|camera|gallery|picture/i,
  "deep link": /link|url|scheme/i,
  "voice input": /voice|speech|audio|record|dictat/i,
  "shared content": /share|paste|drop|extension/i,
};

export function specCovers(spec: ResidueSpec, src: AiSite): boolean {
  const base = path.posix.basename(src.file);
  const stem = new RegExp(`(?<![\\w$])${escapeRx(base.replace(/\.[^.]+$/, ""))}(?![\\w$])`);
  const words = SOURCE_WORDS[src.label];
  const texts = [...spec.inputPaths, ...spec.confirmedPaths.flatMap((c) => [`${c.source} → ${c.sink}`, ...c.evidence])];
  return texts.some((t) => {
    if (t.includes(`${base}:${src.line}`)) return true;
    const sourceSide = t.split(/→|->/)[0] ?? t;
    return stem.test(sourceSide) && !!words?.test(sourceSide);
  });
}

export async function validateSpec(
  ctx: ScanContext,
  specIn: ResidueSpec,
  opts: { rejectionText?: string; baseRef?: string } = {},
): Promise<SpecValidation> {
  const problems: string[] = [];
  const warnings: string[] = [];
  const parsed = ResidueSpec.safeParse(specIn);
  if (!parsed.success) return { ok: false, problems: [`spec does not match the ResidueSpec schema: ${parsed.error.message}`], warnings };
  const spec = parsed.data;
  if (!spec.feature.trim()) problems.push("feature is empty.");
  if (!spec.capability.trim()) problems.push("capability is empty: describe what a user must no longer be able to do or produce.");
  else if (
    /\b(screen|button|picker|tab|menu|view|toggle)\b/i.test(spec.capability) &&
    !/\b(generat\w*|creat\w*|produc\w*|obtain|request|view|see|make|edit|upload|access)\b/i.test(spec.capability)
  ) {
    warnings.push("capability names UI elements but not what the user can produce; describe the capability, not the screen.");
  }

  const gitRepo = await isGitRepo(ctx.root);
  const paths = await listRepoPaths(ctx.root, true);
  const lowerTexts = ctx.files.map((f) => f.text.toLowerCase());
  const existsInTree = (value: string, kind: NeedleKind) => {
    const n = makeNeedle(kind, value);
    if (!n) return false;
    if (kind === "asset") return paths.some((p) => matchNeedle(n, p, 1).length > 0) || ctx.files.some((f) => matchNeedle(n, f.text, 1).length > 0);
    const low = value.toLowerCase();
    return lowerTexts.some((t) => t.includes(low)) || paths.some((p) => p.toLowerCase().includes(low));
  };

  const checkExisting = async (kind: NeedleKind, label: string, values: string[]) => {
    for (const v of values) {
      if (!v.trim()) {
        problems.push(`${label}: empty entry.`);
        continue;
      }
      if (v.trim().length < 3) warnings.push(`${label} "${v}" is very short and will match unrelated code.`);
      if (existsInTree(v, kind)) continue;
      const probe = kind === "asset" ? v.replace(/[*?].*$/, "") : v;
      const asset = kind === "asset" ? makeNeedle("asset", v) : undefined;
      if (gitRepo && ((asset && (await inGitPathHistory(ctx.root, asset))) || (probe.length >= 3 && (await inGitHistory(ctx.root, probe))))) {
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

  // find_surface drafts the whole lexicon category; its unseen terms guard against a regression
  // and are summarized once, so the warnings that need action are not buried under them.
  const guards: string[] = [];
  for (const t of spec.terms) {
    if (!t.trim()) {
      problems.push("term: empty entry.");
      continue;
    }
    if (existsInTree(t, "term")) continue;
    if (!gitRepo) continue;
    if (!(await inGitHistory(ctx.root, t))) {
      if (LEXICON.has(t.trim().toLowerCase())) guards.push(t.trim());
      else warnings.push(`term "${t}" is absent now and never appeared in git history; check that it describes this app's feature.`);
    }
  }

  for (const cp of spec.confirmedPaths) {
    if (!cp.evidence.length) problems.push(`confirmed path ${cp.source} → ${cp.sink} has no file:line evidence.`);
    for (const ev of cp.evidence) {
      const ref = parseEvidenceRef(ev);
      if (!ref) {
        problems.push(`confirmed path evidence "${ev}" is not in file:line form.`);
        continue;
      }
      const abs = path.join(ctx.root, ref.file);
      if (!abs.startsWith(path.resolve(ctx.root) + path.sep) || !existsSync(abs)) {
        problems.push(`confirmed path evidence "${ev}": file does not exist.`);
        continue;
      }
      let body: Buffer;
      try {
        body = await readRegularFile(abs, EVIDENCE_MAX_BYTES, "evidence file", ctx.root);
      } catch (e) {
        problems.push(`confirmed path evidence "${ev}": ${(e as Error).message}.`);
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
    const seen = new Set<string>();
    for (const src of sources) {
      const key = `${src.label}|${src.file}`;
      if (seen.has(key) || specCovers(spec, src)) continue;
      seen.add(key);
      const link = linkSource(ctx, src, sinks);
      if (!link.traced.length && !link.inferred.length) continue;
      warnings.push(
        `Input source ${src.label} (${src.file}:${src.line}) reaches ${link.traced.length ? "" : "(by inference) "}the AI call in ${[...new Set((link.traced.length ? link.traced : link.inferred).map((x) => x.file))].join(", ")} but is not in the spec. Verify judges it anyway; list it in inputPaths, or trace it and record why it does not reach the generator.`,
      );
    }
  }
  // Verify must then find a filter on every generation call and lists each call's filters, which
  // reads as noise at best and invites crediting one call's filter to another path at worst.
  const sinkFiles = [...new Set(sinks.filter((x) => !/\.(json|ya?ml|toml)$/i.test(x.file)).map((x) => x.file))];
  if (sinkFiles.length > 1) {
    for (const p of spec.inputPaths) {
      const refs = [...p.matchAll(/([\w./-]+\.(?:swift|tsx?|jsx?|mjs|cjs|kt|py|dart|go|rb|m|mm))(?::\d+)?/g)].map((m) => m[1]!.replace(/^\.\//, ""));
      if (refs.some((r) => sinkFiles.some((f) => f === r || f.endsWith(`/${r}`)))) continue;
      warnings.push(
        `input path "${clipLine(p)}" names no generation call by file:line, so verify requires a filter on all ${sinkFiles.length} of them (${sinkFiles.slice(0, 4).join(", ")}${sinkFiles.length > 4 ? ", …" : ""}) and lists each one's filters separately. Add the file:line of the call it reaches on the sink side of the arrow, for example "→ AI generation (${sinkFiles[0]}:<line>)".`,
      );
    }
  }
  if (!spec.terms.length) warnings.push("No terms listed; the residue sweep will only look for the named symbols, assets and keys.");
  if (guards.length) {
    warnings.push(
      `${guards.length} lexicon term${guards.length === 1 ? " is" : "s are"} not in the repo or its git history and ${guards.length === 1 ? "is" : "are"} kept as regression guards (${guards.slice(0, 8).join(", ")}${guards.length > 8 ? ", …" : ""}); they do not show the spec describes this app.`,
    );
  }
  if (opts.rejectionText) {
    const ref = gitRepo ? (opts.baseRef ?? "HEAD") : undefined;
    const g = await specGrounding(ctx, spec, opts.rejectionText, ref);
    if (g.checked && !g.grounded) {
      // first, so a save_spec reply that lists only the first few warnings still shows it
      warnings.unshift(
        `The spec is not grounded in the rejection: none of its entries appear in the pre-fix code next to the terms find_surface derives from App Review's message (${g.terms.slice(0, 6).join(", ")}). Removing entries that are not tied to App Review's message proves nothing about it, so verify caps an ungrounded spec at UNVERIFIABLE: it cannot clear the open rejection, which stays on HOLD in preflight. Add entries find_surface found in the pre-fix code, or the developer acknowledges the rejection with \`appstore-shield ack\`.`,
      );
    }
  }

  return { ok: problems.length === 0, problems, warnings };
}

// ---------------------------------------------------------------------------
// specGrounding
// ---------------------------------------------------------------------------

export interface SpecGrounding {
  /** false when App Review's message gives nothing to compare against */
  checked: boolean;
  grounded: boolean;
  /**
   * what tied the spec to the rejection, in words a developer can check, e.g. `spec symbol
   * "LingerieOutfit" was in the code before the fix at Sources/A.swift:12, on the same line as "lingerie", …`
   */
  via?: string;
  /** the tree searched as the pre-fix code; undefined when only the working tree was available */
  ref?: string;
  /** search terms find_surface derives from the message */
  terms: string[];
}

const STORE_METADATA = /^(fastlane\/)?(metadata|screenshots)\//;

/** Prose that describes the app (docs, notes, a README) rather than shipping in it; store metadata ships. */
function isProseDoc(rel: string): boolean {
  if (STORE_METADATA.test(rel)) return false;
  return isDocPath(rel) || /\.(md|markdown|mdx|txt|rst|adoc)$/i.test(rel);
}

/** Whether a term match is filter wording (a refusing blocklist, a refusal instruction, a moderation key), not capability. */
export function isFilterMatch(files: readonly SourceFile[], f: SourceFile, src: string, index: number, end: number): boolean {
  if (blocklistIn(files, f, index)) return true;
  if ((["prompt", "txt", "md"].includes(f.ext) || isCodeFile(f)) && isRefusalInstruction(src, index)) return true;
  return moderationKeyIn(files, f, index, end);
}

const clipLine = (s: string) => (s.trim().length > 80 ? `${s.trim().slice(0, 80)}…` : s.trim());

const FILE_TOKEN = /[\w./-]+\.[A-Za-z][A-Za-z0-9]{0,9}\b/g;

/**
 * The agent writes the spec it is verified against, so a spec only counts toward clearing a
 * rejection when it names something the find_surface sweep finds in the code as it was before the
 * fix: a spec entry on a line (or a file name) that carries one of the terms derived from App
 * Review's message, or an input-path file that held one. Without git, the working tree and the
 * words App Review itself wrote are all there is to go on.
 */
export async function specGrounding(ctx: ScanContext, specIn: ResidueSpec, rejectionText: string, ref?: string): Promise<SpecGrounding> {
  const spec = ResidueSpec.parse(specIn);
  const derived = termsFromRejection(rejectionText);
  const base = derived.terms.length ? derived.terms.map((t) => t.term) : derived.otherWords;
  const termNeedles = base.map((t) => makeNeedle("term", t)).filter((n): n is Needle => !!n);
  const terms = termNeedles.map((n) => n.value);
  if (!termNeedles.length) return { checked: false, grounded: false, terms };
  // Said in the developer's terms: where the word came from, not how the search ran.
  const whence = (t: Needle): string => {
    const c = derived.terms.find((x) => x.term === t.value.toLowerCase());
    if (!c || c.origin !== "lexicon") return `"${t.value}", a word from App Review's message`;
    const cat = derived.categories.find((x) => x.id === c.category) ?? derived.categories[0];
    const hit = cat ? new RegExp(cat.triggers.source, cat.triggers.flags.replace("g", "")).exec(rejectionText) : undefined;
    // the trigger and the word after it ("sexually suggestive"), as App Review wrote them
    const phrase = hit ? (/^[\p{L}'-]+(?:\s+[\p{L}'-]+)?/u.exec(rejectionText.slice(hit.index))?.[0] ?? hit[0]) : undefined;
    return `"${t.value}", one of the terms find_surface derives from App Review's message${phrase ? ` ("${phrase}")` : ""}`;
  };
  const entry = (n: Needle) => `spec ${n.kind === "promptFragment" ? "prompt fragment" : n.kind} "${n.value}"`;
  const specNeedles = needlesOf(spec);
  const pathFiles = [
    ...spec.inputPaths,
    ...spec.confirmedPaths.flatMap((c) => [c.source, c.sink, ...c.evidence]),
  ].flatMap((t) => [...t.matchAll(FILE_TOKEN)].map((m) => m[0].replace(/^\.\//, "")));
  const namesFile = (file: string) => pathFiles.some((p) => p === file || file.endsWith(`/${p}`));

  const lines: { file: string; line: number; text: string; code: boolean }[] = [];
  const paths: string[] = [];
  let usedRef: string | undefined;
  // Lines where App Review's term is capability, not docs, comments or filter wording: a blocklist
  // that refuses "nsfw" or a README describing the rejection says nothing about what the app did.
  const capabilityLines = (f: SourceFile, files: readonly SourceFile[], only?: Set<number>) => {
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
      lines.push({ file: f.path, line: i + 1, text: code ? row : (shown[i] ?? row), code });
    });
  };
  if (ref && safeRef(ref) && (await isGitRepo(ctx.root))) {
    const commit = (await git(ctx.root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]))?.trim();
    if (commit) {
      usedRef = commit;
      // Exit status 1 (no match) comes back as undefined: nothing found is the answer then.
      const out = (await git(ctx.root, ["grep", "-I", "-n", "-i", "--null", "--no-color", "--no-textconv", "-F", ...terms.flatMap((t) => ["-e", t]), commit, "--"], 30_000)) ?? "";
      const hits = new Map<string, Set<number>>();
      for (const row of out.split("\n")) {
        const [head, line] = row.split("\0");
        if (!head || !line) continue;
        const rel = head.slice(commit.length + 1);
        if (isProseDoc(rel)) continue;
        hits.set(rel, (hits.get(rel) ?? new Set()).add(Number(line)));
      }
      // The pre-fix file, not the grep line, says whether a hit sits in a comment or a filter list.
      for (const [rel, want] of [...hits].slice(0, 60)) {
        const text = await git(ctx.root, ["show", "--no-textconv", `${commit}:${rel}`]);
        if (text === undefined) continue;
        const ext = extOf(rel);
        const old: SourceFile = { path: rel, abs: path.join(ctx.root, rel), ext, text, code: stripComments(text, ext) };
        capabilityLines(old, [old, ...ctx.files.filter((f) => f.path !== rel)], want);
      }
      paths.push(...((await git(ctx.root, ["ls-tree", "-r", "--name-only", "-z", commit])) ?? "").split("\0").filter(Boolean));
    }
  }
  if (!usedRef) {
    for (const f of ctx.files) capabilityLines(f, ctx.files);
    paths.push(...(await listRepoPaths(ctx.root, true)));
  }
  const fix = usedRef ? " before the fix" : "";
  const where = (code: boolean) => `${code ? "in the code" : "in the repo"}${fix}`;

  for (const l of lines) {
    const t0 = termNeedles.find((n) => matchNeedle(n, l.text, 1).length);
    if (!t0) continue;
    const s = specNeedles.find((n) => matchNeedle(n, l.text, 1).length);
    if (!s) continue;
    const t = termNeedles.find((n) => n.value.toLowerCase() === s.value.toLowerCase()) ?? t0;
    const via =
      s.kind === "term" && s.value.toLowerCase() === t.value.toLowerCase()
        ? `${entry(s)} was ${where(l.code)} at ${l.file}:${l.line}, and it is ${whence(t).replace(/^"[^"]*", /, "")}`
        : `${entry(s)} was ${where(l.code)} at ${l.file}:${l.line}, on the same line as ${whence(t)}`;
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
    // Without history the removed code is gone; App Review's own words still tie the spec to the rejection.
    const written = new Set(derived.terms.filter((t) => t.origin !== "lexicon").map((t) => t.term));
    const named = spec.terms.map((t) => t.trim().toLowerCase()).find((t) => written.has(t));
    if (named) return { checked: true, grounded: true, via: `spec term "${named}" is App Review's own wording`, terms };
  }
  return { checked: true, grounded: false, ref: usedRef, terms };
}

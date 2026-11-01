import type { Check, CheckResult } from "../checks.js";
import { dedupeFindings, finding, type Finding } from "../finding.js";
import { CODE_EXTENSIONS, searchFile, UnclosedQuotes, type Hit, type ScanContext, type SourceFile } from "../project.js";
import { blankStrings, enclosingConditions, isDebugOnly } from "../scope.js";
import {
  BUILD_TOOL_CONFIG,
  CELEBRITY_TERM,
  ENDPOINT_MEDIA,
  FACE_SWAP_SDK,
  FACE_SWAP_TERM,
  FILTER_CALL,
  FILTER_CONTEXT,
  IMAGE_OUTPUT,
  IMAGE_OUTPUT_KINDS,
  LIKENESS_ACTION,
  LOOKUP_LINE,
  MODEL_CLASSIFIER_EXCLUDE,
  MODEL_FILE_EXT,
  MODEL_KEY_CONTEXT,
  MODERATION,
  MODERATION_HELPER_IMAGE,
  MODERATION_REQUEST_WINDOW,
  NEGATION_BEFORE,
  NO_SAFETY_CHECKER_PROVIDERS,
  NUDIFY_CONTEXTUAL,
  NUDIFY_STRONG,
  NUDIFY_STRONG_IDENT,
  PROMPTS,
  PROVIDERS,
  SAFETY_DISABLED,
  SINKS,
  SOURCES,
  UNSAFE_MODEL_TERM,
  USER_SAFETY_TOGGLE,
  VIDEO_OUTPUT,
  type Media,
  type ModerationKind,
  type SinkKind,
  type SinkRule,
} from "../rules/genai.js";

// ------------------------------------------------------------------ surface types

export interface SurfaceItem {
  file: string;
  line: number;
  /** trimmed, secret-redacted source line */
  text: string;
  kind: string;
  provider?: string;
  /** what kind of safeguard a moderation item is, e.g. "OpenAI moderation endpoint" */
  label?: string;
  /** a sink that names a model or helper (a model table, a lookup) rather than calling a provider */
  mention?: true;
  /** a text call whose output is schema-bound or tool-routed (a router or classifier), not free text shown to users */
  structured?: true;
}

export interface ProviderSurface {
  id: string;
  name: string;
  kind: "cloud" | "on-device";
  media: Media[];
  evidence: SurfaceItem[];
}

export interface AiSurface {
  providers: ProviderSurface[];
  sources: SurfaceItem[];
  sinks: SurfaceItem[];
  prompts: SurfaceItem[];
  moderation: SurfaceItem[];
  /** true when something in the repo generates content (text, image, video or speech) */
  hasGenerator: boolean;
  hasImageGenerator: boolean;
  hasImageEdit: boolean;
  /** an image-capable provider or image sink exists */
  imageCapable: boolean;
  /** every generator is an Apple on-device model with built-in guardrails (Foundation Models, Image Playground) */
  platformGuardedOnly: boolean;
  note: string;
}

const LIST_CAP = 60;
const EVIDENCE_POOL = 40;
/** The text right before a host literal compares a URL against it: `hostname.endsWith('api.openai.com')`, `url === "…"`. */
const HOST_COMPARISON = /(?:\b(?:endsWith|startsWith|includes|contains|hasSuffix|hasPrefix|indexOf|match|matches|test)\s*\(\s*|[!=]==?\s*|\bcase\s+)["'`](?:https?:\/\/)?[\w.-]*$/;
const ENTRY_FILE = /(^|\/)(AppDelegate|SceneDelegate|\w*App)\.swift$|(^|\/)(main|index|App)\.[jt]sx?$/;
/** A server package at the repo root (or under packages/, apps/); an app's own Backend/ group is still app code. */
const SERVER_PATH = /^(?:packages\/|apps\/)?(server|backend|functions|cloud-?functions|lambda|api|supabase\/functions)\//i;

function comparedHost(f: SourceFile, index: number): boolean {
  const before = f.code.slice(Math.max(0, index - 120), index);
  return HOST_COMPARISON.test(before.slice(before.lastIndexOf("\n") + 1));
}

/**
 * Anchor order: a call in app code, then an SDK import, then an endpoint string; config, server
 * and test/demo code last. A name inside a string literal (a credits `Link("MLX Swift", …)`, a
 * package URL) only mentions the SDK, so it ranks with endpoint strings even on a line with a call.
 */
function evidenceRank(e: SurfaceItem, inString = false): number {
  const code = CODE.has(e.file.slice(e.file.lastIndexOf(".") + 1));
  const call = code && !inString && !/^\s*(import|from|require|#include|@import)\b/.test(e.text) && /[\w)\]?!]\s*\(/.test(e.text);
  const base = !code ? 6 : call ? 0 : e.kind === "sdk" && !inString ? (ENTRY_FILE.test(e.file) ? 2 : 1) : 3;
  return base + (SERVER_PATH.test(e.file) ? 1 : 0) + (NON_SHIPPING_TARGET.test(e.file) ? 7 : 0);
}

/** True when the hit starts inside a string literal of a code file. */
function hitInString(f: SourceFile, index: number): boolean {
  return CODE.has(f.ext) && maskedOf(f).charCodeAt(index) !== f.code.charCodeAt(index);
}
/** `| 'chatCompletion'` or `type Op = 'chatCompletion' | ...`: a TS type made of string literals. */
const TYPE_UNION_LINE = /^(?:\|\s*["'`][^"'`]*["'`]\s*;?|(?:export\s+)?type\s+\w+(?:<[^>]*>)?\s*=\s*\|?\s*["'`][^"'`]*["'`]\s*(?:\|.*)?;?)$/;
const EVIDENCE_PER_PROVIDER = 8;
const FINDINGS_PER_RULE = 12;

export const SURFACE_NOTE =
  "Sources and sinks are listed, not linked. This tool does not claim any source reaches any sink; trace each path (and any server code outside this repo) before concluding. Dev-only paths (scripts/, prototypes/, experiments/, evals/, examples/, docs/, worktree copies, virtualenvs) are not scanned.";

/**
 * Paths that never ship to users: eval scripts, prototypes, agent worktree copies, vendored
 * virtualenvs. Counting them would report a bakeoff script as the product's AI surface.
 */
export const NON_PRODUCT_PATH =
  /(^|\/)(\.claude|\.worktrees|worktrees|\.venv|venv|site-packages|scripts?|prototypes?|experiments?|evals?|benchmarks?|examples?|samples?|docs?|fixtures?|mocks?|\.storybook|storybook|probes?|spikes?)\//i;

/**
 * A separate test, demo or example target inside a product folder (LLMFarm's `RagTestIOS/`,
 * `ChatDemo/`, `FooUITests/`). It is built from the repo but never installed by users, so a
 * finding anchored there sends the developer to the wrong file. Capitalised `Test` / `Demo`
 * inside a folder name, so "Latest" or "Contest" never count.
 */
export const NON_SHIPPING_TARGET = /(^|\/)(?:[^/]*(?:Tests?|Demo|Examples?|Samples?)(?![a-z])[^/]*|__tests__|tests?|demos?)\//;

const SIBLING_WEB_PATH = /^apps\/(web|nextjs|next|site|website|docs|landing|marketing)\//i;
/** Sibling folders that are the app's backend, which the app calls; their safeguards serve it. */
const SERVER_SIBLING = /^(?:api|server|backend|workers?|functions|cloud-?functions|lambda|supabase)$/i;

/**
 * Other JS apps next to the only detected app (`apps/monograph` beside `apps/mobile`): a separate
 * product, so its report dialog or AI calls say nothing about the app App Review installs. A
 * sibling the app depends on by package name, or a backend folder, still counts.
 */
function siblingApps(ctx: ScanContext): string[] {
  const roots = ctx.project.appRoots ?? [];
  const root = roots.length === 1 ? roots[0]!.path : undefined;
  if (!root || root === "." || !root.includes("/")) return [];
  const parent = root.slice(0, root.lastIndexOf("/"));
  const pkgOf = (dir: string): Record<string, unknown> | undefined => {
    const f = ctx.files.find((x) => x.path === `${dir}/package.json`);
    try {
      const json: unknown = f ? JSON.parse(f.text) : undefined;
      return json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };
  const app = pkgOf(root);
  const deps = new Set<string>();
  for (const k of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const d = app?.[k];
    if (d && typeof d === "object") for (const n of Object.keys(d)) deps.add(n);
  }
  const out: string[] = [];
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

const productCache = new WeakMap<ScanContext, SourceFile[]>();

/** Files this module reasons about: everything loaded except dev-only paths. */
export function productFiles(ctx: ScanContext): SourceFile[] {
  const cached = productCache.get(ctx);
  if (cached) return cached;
  // A sibling web site in a monorepo (apps/web next to apps/mobile, or beside an Xcode project) is
  // not what App Review installs; its AI calls would otherwise be reported as the iOS app's.
  const siblingWeb = ctx.project.appRoot || ctx.project.xcodeProjects.length > 0;
  const inApp = (p: string) => Boolean(ctx.project.appRoot) && p.startsWith(`${ctx.project.appRoot}/`);
  const others = siblingApps(ctx);
  // .d.ts files are generated type declarations (e.g. a Workers AI model catalog), never behavior.
  const out = ctx.files.filter(
    (f) =>
      !NON_PRODUCT_PATH.test(f.path) &&
      !f.path.endsWith(".d.ts") &&
      !(siblingWeb && SIBLING_WEB_PATH.test(f.path) && !inApp(f.path)) &&
      !others.some((o) => f.path.startsWith(o)),
  );
  productCache.set(ctx, out);
  return out;
}

const ROLLUP_IDENT = /\b[A-Za-z_]\w*\$\d+\b/g;
const bundleCache = new WeakMap<SourceFile, boolean>();

/**
 * Bundler output (rollup, esbuild, webpack): a source-map trailer, minified lines, or the
 * `name$2` identifiers rollup gives deduplicated bindings. It inlines library code such as DOM
 * shims, whose method names say nothing about what the app shows.
 */
export function isGeneratedBundle(f: SourceFile): boolean {
  let v = bundleCache.get(f);
  if (v === undefined) {
    const js = f.ext === "js" || f.ext === "mjs" || f.ext === "cjs";
    v = js && (/\/\/# sourceMappingURL=\S+\s*$/.test(f.text.slice(-400)) || f.text.split("\n", 2000).some((l) => l.length > 2000) || bundleIdentDensity(f.text));
    bundleCache.set(f, v);
  }
  return v;
}

/** Hand-written code almost never holds a hundred `name$N` bindings; rollup output holds them throughout. */
function bundleIdentDensity(text: string): boolean {
  const n = text.match(ROLLUP_IDENT)?.length ?? 0;
  if (n < 100) return false;
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  return lines <= 100 * n;
}

// ------------------------------------------------------------------ file helpers

const CODE = new Set(CODE_EXTENSIONS);
const CONFIG_EXTS = new Set(["json", "txt", "pbxproj", "plist", "xcconfig", "yaml", "yml", "toml", "gradle"]);
const STRING_EXTS = new Set(["strings", "stringsdict", "xcstrings", "plist", "json"]);

export const isCode = (f: SourceFile): boolean => CODE.has(f.ext);
/** Code plus dependency manifests and build config; never .env (it holds secrets) or prose docs. */
export const isCodeOrConfig = (f: SourceFile): boolean =>
  CODE.has(f.ext) || (CONFIG_EXTS.has(f.ext) && !/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(f.path));

/** Files whose string content ships to users: code, localization, plists, and store metadata text. */
export function isShippedText(ctx: ScanContext): (f: SourceFile) => boolean {
  const meta = ctx.project.metadataDirs;
  return (f) =>
    CODE.has(f.ext) ||
    (STRING_EXTS.has(f.ext) && !/(^|\/)(package(-lock)?\.json|tsconfig[\w.]*\.json|Package\.resolved)$/.test(f.path)) ||
    (f.ext === "txt" && meta.some((d) => f.path.startsWith(`${d}/`)));
}

const maskedCache = new WeakMap<SourceFile, string>();
/** Comment-stripped code with string contents blanked, for identifier-only matching. */
export function maskedOf(f: SourceFile): string {
  let m = maskedCache.get(f);
  if (m === undefined) {
    m = CODE.has(f.ext) ? blankStrings(f.code, f.ext) : f.code;
    maskedCache.set(f, m);
  }
  return m;
}

const lineCache = new WeakMap<SourceFile, number[]>();
function lineStarts(f: SourceFile): number[] {
  let s = lineCache.get(f);
  if (!s) {
    s = [0];
    for (let i = 0; i < f.text.length; i++) if (f.text.charCodeAt(i) === 10) s.push(i + 1);
    lineCache.set(f, s);
  }
  return s;
}

export function lineAt(f: SourceFile, index: number): number {
  const s = lineStarts(f);
  let lo = 0;
  let hi = s.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((s[mid] ?? 0) <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * Chars kept on each side of the index. Evidence is clipped to 200 chars anyway, and every hit
 * redacts and regex-tests this text: on a one-line minified bundle the whole line per hit made
 * the AI checks quadratic.
 */
const LINE_WINDOW = 300;

export function lineTextAt(f: SourceFile, index: number, src: string = f.text): string {
  const floor = Math.max(0, index - LINE_WINDOW);
  const ceil = Math.min(src.length, index + LINE_WINDOW);
  let start = index;
  while (start > floor && src.charCodeAt(start - 1) !== 10) start--;
  let end = index;
  while (end < ceil && src.charCodeAt(end) !== 10) end++;
  return src.slice(start, end).trim();
}

/** Evidence ends up in tool output and possibly in review notes; keys must never travel with it. */
export function redact(s: string): string {
  return s
    .replace(/\b(sk|pk|rk)-(proj-|ant-)?[A-Za-z0-9_-]{12,}/g, "[redacted]")
    .replace(/\br8_[A-Za-z0-9]{12,}/g, "[redacted]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
    .replace(/\bhf_[A-Za-z0-9]{20,}/g, "[redacted]")
    .replace(/\b(gsk|xai)-?_?[A-Za-z0-9]{20,}/g, "[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{16,}/g, "$1[redacted]")
    // Opaque mixed-case tokens only: model ids and paths contain "/" "-" "_" and must stay readable.
    .replace(/\b(?=[A-Za-z0-9+=]*\d)(?=[A-Za-z0-9+=]*[A-Z])(?=[A-Za-z0-9+=]*[a-z])[A-Za-z0-9+=]{40,}/g, "[redacted]");
}

export interface Literal {
  value: string;
  /** index of the literal's content in file.code */
  index: number;
  /** true for prose-like text (JSX text, plist <string>, metadata lines) */
  prose?: boolean;
}

const literalCache = new WeakMap<SourceFile, Literal[]>();
/** String literals (and JSX text / plist strings / metadata lines) with their offsets. */
export function literalsOf(f: SourceFile): Literal[] {
  const cached = literalCache.get(f);
  if (cached) return cached;
  const out: Literal[] = [];
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
    const quotes = js ? "\"'`" : "\"";
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
          if (next === undefined || next === "\n" || next === "\r" || next === "\u2028" || next === "\u2029") break;
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
  literalCache.set(f, out);
  return out;
}

/**
 * True when `index` sits in a filter list or a matching call: `bannedWords = ["undress", …]`,
 * `if prompt.contains("nude")`. Those are safeguards, not features.
 */
export function inFilterContext(f: SourceFile, index: number): boolean {
  const masked = maskedOf(f);
  if (FILTER_CALL.test(lineTextAt(f, index, masked)) && FILTER_CONTEXT.test(lineTextAt(f, index, masked))) return true;
  if (FILTER_CALL.test(lineTextAt(f, index, masked)) && /\(\s*["'`]?\s*$/.test(masked.slice(Math.max(0, index - 40), index))) return true;
  let depth = 0;
  let levels = 0;
  const floor = Math.max(0, index - 4000);
  for (let k = index - 1; k >= floor && levels < 2; k--) {
    const ch = masked[k];
    if (ch === "]" || ch === ")" || ch === "}") depth++;
    else if (ch === "[" || ch === "(" || ch === "{") {
      if (depth > 0) { depth--; continue; }
      levels++;
      const header = lineTextAt(f, k, masked);
      if (FILTER_CONTEXT.test(header)) return true;
    }
  }
  return FILTER_CONTEXT.test(lineTextAt(f, index, masked).split(/[=:]/)[0] ?? "");
}

function item(f: SourceFile, index: number, kind: string, provider?: string): SurfaceItem {
  return { file: f.path, line: lineAt(f, index), text: redact(lineTextAt(f, index)).slice(0, 200), kind, ...(provider ? { provider } : {}) };
}

function itemFromHit(f: SourceFile, h: Hit, kind: string, provider?: string): SurfaceItem {
  return item(f, h.index, kind, provider);
}

function cap<T>(xs: T[], n = LIST_CAP): T[] {
  return xs.length > n ? xs.slice(0, n) : xs;
}

// ------------------------------------------------------------------ surface analysis

const surfaceCache = new WeakMap<ScanContext, AiSurface>();
const providerById = new Map(PROVIDERS.map((p) => [p.id, p]));

/** Inventory of the AI surface. Memoized per context; shared by genai_safety, ugc_safeguards and ai_data_disclosure. */
export function analyzeAiSurface(ctx: ScanContext): AiSurface {
  const cached = surfaceCache.get(ctx);
  if (cached) return cached;

  const codeFiles = productFiles(ctx).filter(isCode);
  const cfgFiles = productFiles(ctx).filter(isCodeOrConfig);

  const providers: ProviderSurface[] = [];
  const providerFiles = new Map<string, Set<string>>();
  for (const rule of PROVIDERS) {
    const evidence: SurfaceItem[] = [];
    const quoted: boolean[] = [];
    for (const f of cfgFiles) {
      const hits = [
        ...searchFile(f, rule.sdk).map((h) => ({ h, kind: "sdk" })),
        ...(rule.hosts ? searchFile(f, rule.hosts).filter((h) => !comparedHost(f, h.index)) : []).map((h) => ({ h, kind: "endpoint" })),
      ];
      for (const { h, kind } of hits) {
        if (!providerFiles.has(f.path)) providerFiles.set(f.path, new Set());
        providerFiles.get(f.path)!.add(rule.id);
        // Two matches on one line (`x.gguf-00001-of-00004.gguf`) are one piece of evidence.
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

  const sinks: SurfaceItem[] = [];
  const seenSink = new Map<string, SurfaceItem>();
  const pushSink = (s: SurfaceItem) => {
    const k = `${s.file}:${s.line}`;
    const prev = seenSink.get(k);
    if (prev) {
      // `fal.subscribe("fal-ai/flux/dev", …)` names a model and calls the provider: it is a call.
      if (prev.mention && !s.mention) delete prev.mention;
      return;
    }
    seenSink.set(k, s);
    sinks.push(s);
  };
  const declared = new Map<SinkRule, Set<string>>();
  // Only when a hit needs it: the declaration scan reads every file.
  const declaredBy = (rule: SinkRule): Set<string> | undefined => {
    if (!rule.declared) return undefined;
    let names = declared.get(rule);
    if (!names) {
      names = new Set<string>();
      for (const f of codeFiles) for (const h of scan(f, maskedOf(f), rule.declared)) for (const g of h.groups) if (g) names.add(g);
      declared.set(rule, names);
    }
    return names;
  };
  for (const f of codeFiles) {
    const inFile = providerFiles.get(f.path);
    const fileProvider = inFile ? [...inFile][0] : undefined;
    // A Core ML import next to a Stable Diffusion pipeline generates nothing itself; a call is
    // attributed to a provider in the file that can produce its kind of output.
    const providerFor = (kind: SinkKind): string | undefined => {
      if (!inFile) return undefined;
      const media: Media | undefined = kind === "image-edit" ? "image" : kind === "generation" ? undefined : kind;
      const ids = [...inFile];
      return (
        ids.find((id) => (media ? providerById.get(id)?.media.includes(media) : false)) ??
        ids.find((id) => (providerById.get(id)?.media.length ?? 0) > 0) ??
        fileProvider
      );
    };
    for (const rule of SINKS) {
      if (rule.requires === "providerInFile" && !inFile) continue;
      if (rule.requires === "providerInProject" && !anyProvider) continue;
      // A Core ML classifier or upscaler generates nothing, so it cannot vouch for an ambiguous name.
      if (rule.requires === "generativeProviderInProject" && !anyGenerativeProvider) continue;
      if (rule.skipInFile?.test(f.code)) continue;
      for (const h of searchFile(f, rule.rx)) {
        const name = h.groups[0] ?? h.match;
        if (declaredBy(rule)?.has(name) && (rule.declaredSkip !== "unqualified" || ownCall(f, h, rule))) continue;
        // A string-literal member of a TS type union names an operation; it does not perform one.
        if (TYPE_UNION_LINE.test(h.text)) continue;
        const sink = itemFromHit(f, h, rule.kind, rule.provider ?? providerFor(rule.kind));
        if (rule.kind === "text" && OUTPUT_CHECK.test(f.code.slice(h.index, h.index + STRUCTURED_WINDOW))) sink.structured = true;
        pushSink(rule.mention || LOOKUP_LINE.test(h.text) || CONSTANT_LINE.test(h.text) ? { ...sink, mention: true } : sink);
      }
    }
    // A host constant in a config file only names the service; the call that uses it is elsewhere.
    const requests = REQUEST_CALL.test(f.code);
    for (const rule of PROVIDERS) {
      if (!rule.hosts) continue;
      for (const h of searchFile(f, rule.hosts)) {
        // A moderation, embeddings, transcription or model-list URL on the provider's host generates nothing.
        if (comparedHost(f, h.index) || inErrorMessage(f, h) || NON_GENERATING_ENDPOINT.test(h.text)) continue;
        const only = rule.media.length === 1 ? rule.media[0] : undefined;
        let byPath = ENDPOINT_MEDIA.find((e) => e.rx.test(h.text))?.kind;
        // A text path in a file that decodes bitmaps may still return images; the generic check below decides.
        if (byPath === "text" && (IMAGE_OUTPUT.test(f.code) || VIDEO_OUTPUT.test(f.code))) byPath = undefined;
        const sink = itemFromHit(f, h, only ?? byPath ?? "generation", rule.id);
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
  // A generic generation call (Replicate predictions, fal.run, a multi-media REST host) produces
  // whatever the model does; a decoded bitmap or diffusion parameters in its file say it is visual.
  const byPath = new Map(codeFiles.map((f) => [f.path, f]));
  for (const x of sinks) {
    if (x.kind !== "generation") continue;
    const f = byPath.get(x.file);
    if (!f) continue;
    const media = x.provider ? providerById.get(x.provider)?.media : undefined;
    if ((media?.includes("video") ?? true) && VIDEO_OUTPUT.test(f.code)) x.kind = "video";
    else if ((media?.includes("image") ?? true) && IMAGE_OUTPUT.test(f.code)) x.kind = "image";
  }
  // Transcription and embeddings read content but do not produce any for users to see.
  const generating = sinks.filter((s) => s.kind !== "embedding" && s.kind !== "transcription");
  // A provider's catalogue (OpenAI: text, image, audio, video) overstates what an app does with it;
  // when every call attributed to it names its media, report those.
  for (const p of providers) {
    const own = generating.filter((x) => x.provider === p.id);
    if (own.length === 0 || own.some((x) => x.kind === "generation")) continue;
    const seen = new Set(own.map((x) => (x.kind === "image-edit" ? "image" : x.kind) as Media));
    const narrowed = p.media.filter((m) => seen.has(m));
    if (narrowed.length) p.media = narrowed;
  }
  const generativeProviders = providers.filter((p) => p.media.length > 0);
  const hasGenerator = generating.length > 0 || (sinks.length === 0 && generativeProviders.length > 0);
  const visual: SinkKind[] = ["image", "image-edit", "video"];
  const visualOnlyProvider = generativeProviders.some((p) => p.media.every((m) => m === "image" || m === "video"));
  const hasImageGenerator = generating.some((s) => (visual as string[]).includes(s.kind)) || visualOnlyProvider;
  const hasImageEdit = generating.some((s) => s.kind === "image-edit");
  const imageCapable = hasImageGenerator || generativeProviders.some((p) => p.media.includes("image"));
  const platformGuardedOnly =
    generativeProviders.length > 0 && generativeProviders.every((p) => providerById.get(p.id)?.builtInModeration !== undefined) &&
    generating.every((x) => x.provider === undefined || providerById.get(x.provider)?.builtInModeration !== undefined);

  const moderation: SurfaceItem[] = [];
  // A filter list or function only filters when something applies it. A word list read only by
  // tests (excluded from the scan) is a constant, not moderation on the generation path.
  const useCount = new Map<string, number>();
  const usedElsewhere = (name: string): boolean => {
    let n = useCount.get(name);
    if (n === undefined) {
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
  const appliedFilter = (f: SourceFile, h: Hit, src: string): boolean => {
    const before = src.slice(Math.max(0, h.index - 40), h.index);
    if (FILTER_DECLARATION.test(before)) return usedElsewhere(h.match);
    // A call or member use (`moderate(text)`, `ContentFilter.check(`) applies it right here.
    return /^\s*[?!]?\s*[.(]/.test(src.slice(h.index + h.match.length, h.index + h.match.length + 8)) || usedElsewhere(h.match);
  };
  for (const f of cfgFiles) {
    if (BUILD_TOOL_CONFIG.test(f.path)) continue;
    for (const rule of MODERATION) {
      const src = rule.identifiersOnly && isCode(f) ? maskedOf(f) : undefined;
      const hits = src !== undefined ? scan(f, src, rule.rx) : searchFile(f, rule.rx);
      for (const h of hits) {
        // `safetyFilter: false` names a filter but switches it off.
        if (SAFETY_DISABLED.some((s) => s.rx.test(h.text))) continue;
        if (rule.identifiersOnly && src !== undefined && !appliedFilter(f, h, src)) continue;
        // omni-moderation sent only the prompt text classifies no image, whatever the model can do.
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

  const sources: SurfaceItem[] = [];
  for (const f of codeFiles) for (const rule of SOURCES) for (const h of searchFile(f, rule.rx)) sources.push(itemFromHit(f, h, rule.kind));

  const prompts: SurfaceItem[] = [];
  if (hasGenerator || anyProvider) {
    for (const f of codeFiles) {
      for (const rule of PROMPTS) {
        if (rule.requires === "providerInProject" && !anyProvider) continue;
        for (const h of searchFile(f, rule.rx)) prompts.push(itemFromHit(f, h, rule.kind));
      }
    }
  }

  const surface: AiSurface = {
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
    note: SURFACE_NOTE,
  };
  surfaceCache.set(ctx, surface);
  return surface;
}

function dedupeItems(xs: SurfaceItem[]): SurfaceItem[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = `${x.file}:${x.line}:${x.kind}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Chars after a text call searched for a schema or tool routing: a classifier, not the reply users read. */
const STRUCTURED_WINDOW = 600;
/** A line that only binds or returns a literal (`const ANTHROPIC_URL = "…"`, `endpoint: "…",`): the call is elsewhere. */
const CONSTANT_LINE =
  /^(?:(?:export\s+)?(?:(?:public|private|internal|fileprivate|static)\s+)*(?:const|let|var)\s+\w+(?:\s*:\s*[\w.<>?]+)?\s*=|["']?[\w-]+["']?\s*:|return)\s*["'`][^"'`]*["'`]\s*[,;]?$/;
// `/models` alone lists models; `/models/gemini-…:generateContent` generates.
const NON_GENERATING_ENDPOINT = /\/(?:moderations|embeddings|audio\/transcriptions|audio\/translations)["'`/?]|\/models["'`?]/;
const ERROR_MESSAGE_LINE = /\bthrow\b|\b\w*Error\s*\(|\bconsole\.(?:error|warn|log|info)\s*\(|\b(?:logger|log|Log)\.\w+\s*\(|\bos_log\s*\(/;

/** A bare host name in an error or log message ("fal.ai error 502") names the provider; no request goes to it there. */
function inErrorMessage(f: SourceFile, h: Hit): boolean {
  return ERROR_MESSAGE_LINE.test(h.text) && hitInString(f, h.index) && !/:\/\/[\w.-]*$/.test(f.code.slice(Math.max(0, h.index - 80), h.index));
}

/** The text before an identifier that declares it (`static let forbiddenWords =`, `func moderate`). */
const FILTER_DECLARATION = /\b(?:func|function|def|class|struct|enum|protocol|interface|type|typealias|let|var|const|val|case)\s+$/;

/** Request APIs: a host literal in a file that makes requests is the call site itself. */
const REQUEST_CALL = /\b(?:fetch|axios|URLRequest|URLSession|AF\.request|ky|got|superagent|HttpClient|httpClient|http\.(?:post|request)|https\.request|request)\s*[.(]/;

/**
 * The hit is the app's own declaration of the name, or a call to it with no receiver (`self.`,
 * `this.` or none). `model.generateContent(` inside the app's own wrapper stays a provider call.
 */
function ownCall(f: SourceFile, h: Hit, rule: SinkRule): boolean {
  if (rule.declared?.test(h.text)) return true;
  const before = maskedOf(f).slice(Math.max(0, h.index - 40), h.index);
  return /\b(?:self|this)\s*[?!]?\.\s*$/.test(before) || !/[.?]\s*$/.test(before);
}

/** searchFile over an alternate rendering of the file (same offsets), e.g. the string-masked code. */
export function scan(f: SourceFile, src: string, rx: RegExp): Hit[] {
  return searchFile({ ...f, code: src }, rx);
}

/** Surface trimmed for output. */
export function surfaceData(s: AiSurface): Record<string, unknown> {
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
    note: s.note,
  };
}

// ------------------------------------------------------------------ rules

function safetyDisabled(ctx: ScanContext): Finding[] {
  const out: Finding[] = [];
  for (const f of productFiles(ctx).filter(isCodeOrConfig)) {
    for (const rule of SAFETY_DISABLED) {
      for (const h of searchFile(f, rule.rx)) {
        if (rule.minValue !== undefined && !(Number(h.groups[0]) >= rule.minValue)) continue;
        const debugOnly = isCode(f) && isDebugOnly(enclosingConditions(f.code, h.index, f.ext));
        out.push(
          finding({
            rule: debugOnly ? "genai.safety_disabled_debug" : "genai.safety_disabled",
            severity: debugOnly ? "medium" : "block",
            guideline: "1.1",
            file: f.path,
            line: h.line,
            evidence: redact(h.text),
            why: debugOnly
              ? `${rule.provider} safety is explicitly turned off (${rule.label}) inside a debug-only block. It should not ship, but any path that compiles it into a release build would generate unfiltered content (1.1, 1.2).`
              : `${rule.provider} safety is explicitly turned off (${rule.label}). Apps that generate content are responsible for it under 1.1 and 1.2 (which names AI content creation apps); switching provider safety off is direct evidence the app can produce objectionable content.`,
            fix: debugOnly
              ? "Remove the override entirely so no build can carry it."
              : `${rule.restore}, and keep your own server-side filter as well.`,
            confidence: "high",
            suppressible: debugOnly,
          }),
        );
      }
    }
  }
  return out;
}

/** A switch that lets users turn a safety checker or filter off in a shipping build. */
function userSafetyToggle(ctx: ScanContext, s: AiSurface): Finding[] {
  if (!s.hasGenerator) return [];
  const out: Finding[] = [];
  for (const f of productFiles(ctx).filter(isCode)) {
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
          confidence: "medium",
        }),
      );
      if (out.length >= FINDINGS_PER_RULE) return out;
    }
  }
  return out;
}

function unsafeModels(ctx: ScanContext, s: AiSurface): Finding[] {
  if (s.providers.length === 0) return [];
  const hostRx = new RegExp(PROVIDERS.filter((p) => p.hosts).map((p) => p.hosts!.source).join("|"));
  const out: Finding[] = [];
  for (const f of productFiles(ctx).filter(isCodeOrConfig)) {
    for (const lit of literalsOf(f)) {
      const v = lit.value.trim();
      if (!v || /\s/.test(v) || v.length > 300) continue;
      if (!UNSAFE_MODEL_TERM.test(v) || MODEL_CLASSIFIER_EXCLUDE.test(v)) continue;
      const isUrl = /^[a-z]+:\/\//i.test(v);
      const lineText = lineTextAt(f, lit.index);
      const modelish =
        MODEL_FILE_EXT.test(v) ||
        (isUrl ? hostRx.test(v) : /^[\w.-]{2,}\/[\w.:@-]+$/.test(v) || MODEL_KEY_CONTEXT.test(lineText));
      if (!modelish) continue;
      out.push(
        finding({
          rule: "genai.unsafe_model",
          severity: "block",
          guideline: "1.1",
          file: f.path,
          line: lineAt(f, lit.index),
          evidence: redact(lineText),
          why: `The model or LoRA id "${v.slice(0, 80)}" is named for uncensored / sexual output. Shipping a generator built on it is direct evidence the app produces objectionable content (1.1, 1.2), whatever prompts the UI offers.`,
          fix: "Remove this model / LoRA from the app and its backend, and use a model whose safety training is intact with a moderation layer on inputs and outputs.",
          confidence: "high",
          suppressible: false,
        }),
      );
    }
  }
  return out;
}

interface TermHit { f: SourceFile; index: number; text: string; term: string }

function literalTermHits(ctx: ScanContext, rx: RegExp, filesFilter: (f: SourceFile) => boolean): TermHit[] {
  const out: TermHit[] = [];
  for (const f of productFiles(ctx).filter(filesFilter)) {
    for (const lit of literalsOf(f)) {
      const m = rx.exec(lit.value);
      if (!m) continue;
      const before = lit.value.slice(0, m.index);
      if (NEGATION_BEFORE.test(before)) continue;
      const at = lit.index + m.index;
      if (isCode(f) && inFilterContext(f, at)) continue;
      out.push({ f, index: at, text: lit.value, term: m[0] });
    }
  }
  return out;
}

function identTermHits(ctx: ScanContext, rx: RegExp): TermHit[] {
  const out: TermHit[] = [];
  for (const f of productFiles(ctx).filter(isCode)) {
    for (const h of scan(f, maskedOf(f), rx)) {
      if (inFilterContext(f, h.index)) continue;
      out.push({ f, index: h.index, text: h.text, term: h.match });
    }
  }
  return out;
}

function nudification(ctx: ScanContext, s: AiSurface): Finding[] {
  const shipped = isShippedText(ctx);
  const out: Finding[] = [];
  const userPhotos = s.sources.some((x) => x.kind === "photo" || x.kind === "camera");
  const emit = (h: TermHit, why: string) =>
    out.push(
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
        suppressible: false,
      }),
    );

  if (s.imageCapable || s.hasImageEdit) {
    const strong = [...literalTermHits(ctx, NUDIFY_STRONG, shipped), ...identTermHits(ctx, NUDIFY_STRONG_IDENT)];
    for (const h of strong.slice(0, FINDINGS_PER_RULE)) {
      emit(h, `"${h.term}" next to an image generator describes nudification. Apple's Oct 16, 2026 update names nudification as an example of the bait-and-switch apps covered by 2.5.19, and covers AI-generated nonconsensual intimate imagery under 1.2; these lead to removal and Program termination.`);
    }
  }
  if (userPhotos && s.hasImageEdit) {
    const ctxHits: TermHit[] = [];
    for (const rx of NUDIFY_CONTEXTUAL) ctxHits.push(...literalTermHits(ctx, rx, shipped));
    for (const h of ctxHits.slice(0, FINDINGS_PER_RULE)) {
      emit(h, `"${h.term}" appears in an app that edits user-supplied photos with an image model. Clothing removal or nudity applied to photos of real people is nonconsensual intimate imagery (1.2, Oct 16, 2026).`);
    }
  }
  return out;
}

function likeness(ctx: ScanContext, s: AiSurface): Finding[] {
  const shipped = isShippedText(ctx);
  const out: Finding[] = [];
  const faceSwap = [
    ...literalTermHits(ctx, FACE_SWAP_SDK, isCodeOrConfig).filter((h) => !/\s/.test(h.text.trim())),
    ...identTermHits(ctx, FACE_SWAP_SDK),
    ...(s.providers.length > 0 || s.hasImageEdit
      ? [...literalTermHits(ctx, FACE_SWAP_TERM, shipped), ...identTermHits(ctx, /\b\w*(faceSwap|FaceSwap|face_swap|FACE_SWAP)\w*\b/)]
      : []),
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
        suppressible: false,
      }),
    );
  }
  if (s.imageCapable) {
    const celeb = literalTermHits(ctx, CELEBRITY_TERM, shipped).filter((h) => LIKENESS_ACTION.test(h.text));
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
          suppressible: false,
        }),
      );
    }
  }
  return out;
}

const PROVIDER_SCOPED_MODERATION = new Set([
  "Gemini safetySettings at a blocking threshold",
  "Imagen safety filter level",
  "provider output safety checker explicitly on",
]);

const BUILT_IN_SUFFIX = " built-in guardrails";
const DEV_ONLY_PATH = /(^|\/)[^/]*(devtools?|debug)[^/]*(\/|$)/i;

/**
 * The generating sink a finding should point at. Developers open the anchor first, so a
 * call in shipping code beats a name mentioned in a debug-only screen.
 */
export function primarySink(sinks: SurfaceItem[]): SurfaceItem | undefined {
  let best: SurfaceItem | undefined;
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

function sinkScore(x: SurfaceItem): number {
  // Server code is not what App Review runs; when the app itself calls the model, point there.
  // A model table or lookup line ranks after the server handler that really calls the provider.
  // A schema-bound router call ranks just below a free-text call: users read the latter's output.
  return (DEV_ONLY_PATH.test(x.file) || NON_SHIPPING_TARGET.test(x.file) ? 4 : 0) + (SERVER_PATH.test(x.file) ? 2 : 0) + (x.mention ? 3 : 0) + (/[\w)\]?!]\s*\(/.test(x.text) ? 0 : 1) + (x.structured ? 0.5 : 0);
}

/**
 * Where an AI finding should point when no single call is at fault: a generating call in
 * shipping code, else the SDK import or call of a provider that generates something, in code
 * (never a privacy statement or README that names it), else whatever evidence exists.
 */
export function aiAnchor(s: AiSurface): SurfaceItem | undefined {
  const sink = primarySink(s.sinks);
  if (sink && !sink.mention && sinkScore(sink) < 4) return sink;
  const shippingCode = (e: SurfaceItem) => CODE.has(e.file.slice(e.file.lastIndexOf(".") + 1)) && !DEV_ONLY_PATH.test(e.file) && !NON_SHIPPING_TARGET.test(e.file);
  const generators = s.providers.filter((p) => p.media.length > 0);
  // Of several files importing the SDK, the one that builds prompts is where generation happens,
  // not a device-stats model that imports it for a type.
  // An endpoint constant in a provider table (`endpoint: "https://api.openai.com/…"`) is a
  // setting; an SDK import or a request call is where the generator is used.
  const promptFiles = new Set(s.prompts.map((p) => p.file));
  const sdk = (e: SurfaceItem) => e.kind === "sdk" || /[\w)\]?!]\s*\(/.test(e.text);
  const tiers: ((e: SurfaceItem) => boolean)[] = [
    (e) => sdk(e) && promptFiles.has(e.file),
    (e) => promptFiles.has(e.file),
    sdk,
    () => true,
  ];
  let fromProvider: SurfaceItem | undefined;
  for (const tier of tiers) {
    fromProvider = generators.map((p) => p.evidence.find((e) => shippingCode(e) && tier(e))).find(Boolean);
    if (fromProvider) break;
  }
  // A model-id table or lookup is never where a developer fixes moderation; the SDK use is closer.
  return (
    fromProvider ??
    sink ??
    generators.map((p) => p.evidence.find((e) => CODE.has(e.file.slice(e.file.lastIndexOf(".") + 1)))).find(Boolean) ??
    s.providers.map((p) => p.evidence.find(shippingCode)).find(Boolean) ??
    s.providers[0]?.evidence[0]
  );
}

/** Hosted text APIs that apply the provider's usage-policy enforcement to every request. */
const POLICY_ENFORCING_TEXT = new Map([
  ["anthropic", "Anthropic"],
  ["openai", "OpenAI"],
  ["gemini", "Gemini"],
  ["foundationmodels", "Apple Foundation Models"],
]);
/** App code that constrains or checks model output: a JSON schema, structured output, a validating parse. */
const OUTPUT_CHECK = /\b(?:response_format|responseFormat|json_schema|jsonSchema|responseSchema|response_schema|responseMimeType|response_mime_type|generateObject|streamObject|zodResponseFormat|zodOutputFormat|output_format|output_config|outputFormat|tool_choice|toolChoice|safeParse|JSONSchema)\b|@Generable\b/;

/**
 * Text-only generation through a hosted provider that enforces its own usage policies, with app
 * code constraining the output, is a lower risk than images or an open-weight model: the missing
 * filter is then something to disclose. Returns the evidence when that holds for every generator.
 * Explicitly disabled safety, unsafe models, persona chat and any visual output keep it high.
 */
function hostedTextOnly(ctx: ScanContext, s: AiSurface, safetyOff: boolean): { names: string[]; check: SurfaceItem } | undefined {
  if (safetyOff || s.hasImageGenerator || s.hasImageEdit) return undefined;
  if (s.prompts.some((p) => p.kind === "persona")) return undefined;
  const generators = s.providers.filter((p) => p.media.length > 0);
  const generating = s.sinks.filter((x) => x.kind !== "embedding" && x.kind !== "transcription");
  if (generators.length === 0 || generating.length === 0) return undefined;
  if (!generators.every((p) => POLICY_ENFORCING_TEXT.has(p.id) && p.media.every((m) => m === "text"))) return undefined;
  if (!generating.every((x) => x.kind === "text" && (x.provider === undefined || POLICY_ENFORCING_TEXT.has(x.provider)))) return undefined;
  const files = new Map(productFiles(ctx).map((f) => [f.path, f]));
  let check: SurfaceItem | undefined;
  for (const path of new Set(generating.map((x) => x.file))) {
    const f = files.get(path);
    const h = f && searchFile(f, OUTPUT_CHECK)[0];
    if (!f || !h) return undefined;
    check ??= itemFromHit(f, h, "output check");
  }
  return check ? { names: generators.map((p) => POLICY_ENFORCING_TEXT.get(p.id) ?? p.name), check } : undefined;
}

type NoModeration = { loc: { file?: string; line?: number; evidence?: string }; why: string; fix: string };

function noModeration(n: NoModeration, hosted: ReturnType<typeof hostedTextOnly>): Finding {
  if (hosted) {
    return finding({
      rule: "genai.no_moderation",
      severity: "medium",
      guideline: "1.2",
      ...n.loc,
      why: `${n.why} Every generator here is text-only through ${hosted.names.join(", ")}, which enforces its own usage policies on each request, and app code constrains the output (${hosted.check.file}:${hosted.check.line}), so the risk is lower than for image or open-weight generation.`,
      fix: `Disclose in Review Notes that generation is text-only through ${hosted.names.join(", ")} with the provider's usage-policy enforcement, and how app code validates the output. If users can read free-form replies, add a filter on prompts and output as well.`,
      confidence: "medium",
    });
  }
  return finding({ rule: "genai.no_moderation", severity: "high", guideline: "1.2", ...n.loc, why: n.why, fix: n.fix, confidence: "medium" });
}

const NO_CHECKER_WHY =
  "The Stable Diffusion XL / 3 pipelines of apple/ml-stable-diffusion run without the package's safety checker, so their output images are never classified.";

function moderationCoverage(ctx: ScanContext, s: AiSurface, safetyOff: boolean): Finding[] {
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
          fix: "Add a filter on prompts and on generated output (moderation endpoint or classifier) before content is shown. If filtering already runs on a server outside this repo, disclose and describe it in Review Notes.",
        },
        hosted,
      ),
    ];
  }
  // A provider's own safety setting (Gemini safetySettings, Imagen filter level, a fal/BFL
  // checker flag) filters only that provider's calls, so it cannot vouch for a second
  // generator elsewhere in the app.
  // Platform guardrails (Foundation Models, Image Playground) likewise cover only that
  // platform's own sessions, not a cloud or MLX model elsewhere in the same app.
  // A safeguard that names its provider (platform guardrails, an SDK's default checker) covers that provider only.
  const guardedProviders = new Set(s.moderation.filter((m) => m.provider !== undefined).map((m) => m.provider));
  const scoped = (m: SurfaceItem) => PROVIDER_SCOPED_MODERATION.has(m.label ?? "") || m.provider !== undefined;
  const general = s.moderation.filter((m) => !scoped(m));
  if (general.length === 0) {
    const scopedFiles = new Set(s.moderation.filter((m) => m.provider === undefined).map((m) => m.file));
    // The best-ranked uncovered call, not the first file visited: a model table is not the fix site.
    const uncovered = primarySink(
      s.sinks.filter(
        (x) =>
          // A pipeline with no safety checker is not covered by a checker flag set on its neighbour.
          (x.provider !== undefined && NO_SAFETY_CHECKER_PROVIDERS.has(x.provider)) ||
          (!scopedFiles.has(x.file) && !(x.provider !== undefined && guardedProviders.has(x.provider))),
      ),
    );
    // A generator whose call sites were not recognized is known only from its SDK.
    const inCode = (e: SurfaceItem) => CODE.has(e.file.slice(e.file.lastIndexOf(".") + 1));
    const candidates = s.providers.filter(
      (p) =>
        p.media.length > 0 &&
        !guardedProviders.has(p.id) &&
        !s.sinks.some((x) => x.provider === p.id) &&
        !p.evidence.some((e) => scopedFiles.has(e.file)),
    );
    // Point at code that uses the SDK, not a privacy statement or lockfile that names it.
    const unguarded = candidates.find((p) => p.evidence.some(inCode)) ?? candidates[0];
    const unguardedAt = unguarded?.evidence.find(inCode) ?? unguarded?.evidence[0];
    if (unguarded && unguardedAt) {
      const covered = [...new Set(s.moderation.map((m) => m.label))].join(", ");
      const noChecker = NO_SAFETY_CHECKER_PROVIDERS.has(unguarded.id);
      return [
        noModeration(
          {
            loc: { file: unguardedAt.file, line: unguardedAt.line, evidence: unguardedAt.text },
            why: noChecker
              ? `${NO_CHECKER_WHY} The safeguard found (${covered}) covers only the standard StableDiffusionPipeline. 1.2 (which names AI content creation apps) requires a method for filtering objectionable material.`
              : `${unguarded.name} generates content with no moderation. The only safeguard found (${covered}) belongs to a different model and filters only that model's output. 1.2 (which names AI content creation apps) and 4.7.1 require a method for filtering objectionable material.`,
            fix: noChecker
              ? "Add an output image classifier (e.g. SensitiveContentAnalysis or an NSFW Core ML model) on every SDXL / SD3 image and discard flagged output, plus a prompt filter."
              : "Add a filter on prompts and on generated output (moderation endpoint or classifier) for this generator before content is shown. If filtering already runs on a server outside this repo, disclose and describe it in Review Notes.",
          },
          noChecker ? undefined : hosted,
        ),
      ];
    }
    if (uncovered) {
      const covered = [...new Set(s.moderation.map((m) => m.label))].join(", ");
      const noChecker = uncovered.provider !== undefined && NO_SAFETY_CHECKER_PROVIDERS.has(uncovered.provider);
      return [
        noModeration(
          {
            loc: { file: uncovered.file, line: uncovered.line, evidence: uncovered.text },
            why: noChecker
              ? `${NO_CHECKER_WHY} The safeguard found (${covered}) covers only the standard StableDiffusionPipeline. 1.2 (which names AI content creation apps) requires a method for filtering objectionable material.`
              : `This generator has no moderation. The only safeguard found (${covered}) is a setting of a different provider and filters only that provider's calls. 1.2 (which names AI content creation apps) and 4.7.1 require a method for filtering objectionable material.`,
            fix: noChecker
              ? "Add an output image classifier (e.g. SensitiveContentAnalysis or an NSFW Core ML model) on every SDXL / SD3 image and discard flagged output, plus a prompt filter."
              : "Add a filter on prompts and on generated output (moderation endpoint or classifier) for this generator before content is shown. If filtering already runs on a server outside this repo, disclose and describe it in Review Notes.",
          },
          noChecker ? undefined : hosted,
        ),
      ];
    }
  }
  const kinds = new Set<ModerationKind>(s.moderation.map((m) => m.kind as ModerationKind));
  if (s.hasImageGenerator && !IMAGE_OUTPUT_KINDS.some((k) => kinds.has(k))) {
    // The missing output classifier belongs on the image call, not on a text provider's call.
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
        confidence: "medium",
      }),
    ];
  }
  return [];
}

export const check: Check = {
  id: "genai_safety",
  title: "Generative AI safety",
  guidelines: ["1.1", "1.2", "4.7", "4.7.1"],
  async run(ctx: ScanContext): Promise<CheckResult> {
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
      ...moderationCoverage(ctx, s, disabled.length + toggles.length + unsafe.length > 0),
    ];
    // Several lexicon terms can hit the same preset line; one finding per line is enough.
    return { findings: dedupeFindings(findings), data: { surface: surfaceData(s) } };
  },
};

import { existsSync } from "node:fs";
import path from "node:path";
import { clip } from "../finding.js";
import { foldEvents, locateLedger, probeConfirmation, readLedger } from "../ledger/store.js";
import { ResidueSpec as ResidueSpecSchema, type EvidenceTier, type LedgerEvent, type RejectionState, type ResidueHit, type ResidueSpec, type Verification } from "../ledger/schema.js";
import type { Finding } from "../finding.js";
import { CODE_EXTENSIONS, extOf, isTestPath, loadContext, lineOf, stripComments, type ScanContext, type SourceFile } from "../project.js";
import { check as remoteConfigCheck } from "../scanners/remoteConfig.js";
import { check as reviewGatingCheck } from "../scanners/reviewGating.js";
import { enclosingConditions, isDebugOnly, isRuntimeGated } from "../scope.js";
import { PROVIDERS } from "../rules/genai.js";
import { sweepBuiltProduct, type BuiltSweep } from "./built.js";
import { EVIDENCE_MAX_BYTES, readRegularFile } from "./fsread.js";
import {
  AI_HOSTS,
  AI_SINK,
  aiSites,
  blocklistAt,
  blocklistIn,
  declaredNames,
  enclosingDeclarations,
  escapeRx,
  git,
  inGitHistory,
  isContextTerm,
  identifierCount,
  identifiersOf,
  isCodeFile,
  isDocPath,
  isFilterMatch,
  isGitRepo,
  isRefusalInstruction,
  isServerPath,
  lineText,
  linkSource,
  makeNeedle,
  maskedOf,
  listRepoPaths,
  matchesAny,
  matchNeedle,
  moderationKeyIn,
  needlesOf,
  parseEvidenceRef,
  safeRef,
  specCovers,
  specGrounding,
  termsFromRejection,
  validateSpec,
  type AiSite,
  type Enclosing,
  type Needle,
} from "./surface.js";

export interface VerifyOptions {
  /** git ref the rejection was recorded at; diff evidence is computed from here to the working tree */
  baseRef?: string;
  /** optional local .app / .xcarchive / .ipa to sweep for residue */
  builtProductPath?: string;
  /** previously ingested probe results for this rejection, if any */
  probe?: Verification["probe"];
  /**
   * Ledger events used to look for the developer's confirmation of the probe results (a human
   * attestation naming the results hash). When absent, the repo's ledger is read.
   */
  ledgerEvents?: LedgerEvent[];
  includeTests?: boolean;
  /**
   * App Review's message for this rejection. Its lexicon terms are swept even when the spec leaves
   * them out, so a spec cannot pass by naming something else.
   */
  rejectionText?: string;
  /**
   * The recorded rejection this verification is for. Its reviewer message is read from the ledger
   * when rejectionText is not given; without either, the rejection whose saved spec this is is used.
   */
  rejectionId?: string;
  now: string;
}

const MAX_RESIDUE = 500;
const MIN_PROBES = 50;

const PROMPTISH = /\bprompt|instruction|persona|system_?message|systemMessage/i;
const CONFIG_EXTS = new Set(["json", "yaml", "yml", "plist", "prompt", "txt", "md", "strings", "stringsdict", "xcstrings", "xcconfig", "env", "toml", "xml"]);
const DECODE_CALL = /(Data\(\s*base64Encoded:|\batob\s*\(|Buffer\.from\([^)]*["']base64["']|\bbase64Decode\w*\s*\(|\bdecodeBase64\w*\s*\(|\bBase64\.decode\w*\s*\(|base64DecodedString|\bfromBase64\w*\s*\()/;
const XOR_DECRYPT = /(\b(xor|deobfuscate|unscramble|decrypt\w*|decipher\w*|unmask)\s*\(|\^\s*0x[0-9a-fA-F]{2}\b|CryptoJS\.\w+\.decrypt|AES\.GCM\.open|ChaChaPoly\.open)/i;
const RUNTIME_PROMPT: RegExp[] = [
  /(remoteConfig|RemoteConfig|configValue|getString|getValue|getFeatureValue|getJSON|getConfig)\s*(?:\(\s*(?:forKey:\s*)?|\[\s*)["'`][\w.:-]*(prompt|instruction|persona|system_?message)[\w.:-]*["'`]/i,
  /["'`]https?:\/\/[^"'`\s]*\/[^"'`\s]*(prompt|instruction|persona)s?\b[^"'`\s]*["'`]/i,
  /\b(let|var|const)\s+\w*(prompt|instructions?|persona)\w*\s*(:\s*[\w<>?[\]]+\s*)?=\s*(try\s+)?(await\s+)?(fetch|axios|URLSession|loadRemote\w*|download\w*)\b/i,
];
const NET_CALL =
  /\b(fetch\s*\(|axios(\.(post|get|request))?\s*\(|URLRequest\s*\(\s*url|URLSession\.shared\.(data|upload)|AF\.request|httpsCallable\s*\(|functions\.invoke\s*\()/;
const NON_AI_HOSTS = /(apple\.com|googleapis\.com\/(identitytoolkit|firestore)|sentry\.io|posthog|mixpanel|amplitude|segment\.io|revenuecat|facebook\.com|branch\.io|appsflyer|onesignal|expo\.dev|exp\.host)/i;

const FRAMEWORK_NAMES = new Set([
  "body", "main", "init", "render", "App", "default", "makeBody", "viewDidLoad", "viewWillAppear", "application", "scene",
  "previews", "Previews", "loader", "action", "generateMetadata", "layout",
]);

interface SweepState {
  residue: ResidueHit[];
  seen: Set<string>;
  truncated: boolean;
  excluded: number;
  blocklists: Map<string, { file: string; line: number; used: boolean; terms: Set<string>; server: boolean }>;
  /** moderation category keys read off a filter's result, by file:line */
  moderationKeys: Map<string, Set<string>>;
}

const newSweep = (): SweepState => ({ residue: [], seen: new Set(), truncated: false, excluded: 0, blocklists: new Map(), moderationKeys: new Map() });

function pushHit(st: SweepState, h: ResidueHit) {
  const key = `${h.kind}|${h.needle.toLowerCase()}|${h.file}|${h.line ?? ""}`;
  if (st.seen.has(key)) return;
  st.seen.add(key);
  if (st.residue.length >= MAX_RESIDUE) {
    st.truncated = true;
    return;
  }
  st.residue.push({ ...h, evidence: h.evidence ? clip(h.evidence) : undefined });
}

const isMetadataPath = (rel: string) => /^(fastlane\/)?(metadata|screenshots)\//.test(rel);

const REVIEWER_ONLY = /(^|\/)review[_-]?(information|notes?)(\/|\.|$)/i;
const LOCKFILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|Package\.resolved|Podfile\.lock|yarn\.lock)$/;
/** Store copy that announces the removal ("Removed lingerie outfits") is not residue. */
const REMOVAL_NOTICE = /\b(removed|no longer|deleted|discontinued|dropped|taken out)\b/i;

/** Files that ship in the app or configure it; docs, lockfiles and reviewer-only notes are skipped. */
function inSweep(f: SourceFile): boolean {
  if (LOCKFILE.test(f.path)) return false;
  if (isMetadataPath(f.path)) return !REVIEWER_ONLY.test(f.path);
  if (["md", "txt"].includes(f.ext) && isDocPath(f.path)) return false;
  return true;
}

function declaredIdentAt(f: SourceFile, start: number, end: number): string | undefined {
  let a = start;
  let b = end;
  while (a > 0 && /[\w$]/.test(f.code[a - 1]!)) a--;
  while (b < f.code.length && /[\w$]/.test(f.code[b]!)) b++;
  const ident = f.code.slice(a, b);
  // prompt fragments and strings span punctuation; only a single identifier can be a declaration
  if (!/^[A-Za-z_$][\w$]*$/.test(ident)) return undefined;
  const line = lineText(f.code, start);
  const rx = new RegExp(`\\b(func|function|class|struct|enum|protocol|interface|type|typealias|let|var|const)\\s+${escapeRx(ident)}(?![\\w$])`);
  return rx.test(line) ? ident : undefined;
}

function classify(ctx: ScanContext, f: SourceFile, start: number, end: number): Pick<ResidueHit, "status" | "confidence" | "reason"> {
  if (!isCodeFile(f)) {
    if (isMetadataPath(f.path)) return { status: "PRESENT", confidence: "high", reason: "Store metadata in the repo still mentions it; reviewers and users see this text." };
    return { status: "PRESENT", confidence: "high", reason: `Still present in a bundled ${f.ext} file.` };
  }
  const scope = enclosingConditions(f.code, start, f.ext);
  if (isDebugOnly(scope)) {
    return {
      status: "DEBUG_ONLY",
      confidence: "medium",
      reason: "Only compiled into debug builds (#if DEBUG / __DEV__). It does not fail verification by itself; delete it anyway so a build-setting change cannot ship it.",
    };
  }
  if (isRuntimeGated(scope)) {
    const c = scope.conditions.find((x) => x.signals.some((s) => s !== "debug"));
    return {
      status: "GATED",
      confidence: "medium",
      reason: `Behind a runtime condition (${scope.signals.filter((s) => s !== "debug").join(", ")})${c ? ` at line ${c.line}: ${clip(c.text, 80)}` : ""}. A switch that can turn the feature back on after review is a hidden feature under 2.5.19; remove the gated code, not just the switch.`,
    };
  }
  const own = declaredIdentAt(f, start, end);
  const decls = enclosingDeclarations(f, start);
  const candidates = [
    ...(own ? [{ ident: own, depth: decls.length, exported: /\bexport\b|@main|@objc|override\b/.test(lineText(f.code, start)), declKind: /\b(func|function|class|struct|enum|protocol|interface|type|typealias|let|var|const)\s+/.exec(lineText(f.code, start))?.[1] ?? "" }] : []),
    ...decls,
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
      reason: `Inside ${dead.ident}, which is declared but never referenced by name. Unreferenced code still ships in the binary and can be reached by reflection, a string-based lookup or an update; 2.5.19 treats it as a dormant feature. Delete it.`,
    };
  }
  return { status: "PRESENT", confidence: "high", reason: "Unconditional code that ships in release builds." };
}

function tryDecodeBase64(s: string): string | undefined {
  try {
    const buf = Buffer.from(s, "base64");
    if (buf.length < 40) return undefined;
    let printable = 0;
    for (const b of buf) if (b === 9 || b === 10 || b === 13 || (b >= 0x20 && b < 0x7f) || b >= 0xc2) printable++;
    return printable / buf.length >= 0.95 ? buf.toString("utf8") : undefined;
  } catch {
    return undefined;
  }
}

function sweepFile(ctx: ScanContext, f: SourceFile, needles: Needle[], st: SweepState) {
  const src = isCodeFile(f) ? f.code : f.text;
  const promptFile = ["prompt", "txt", "md"].includes(f.ext);
  for (const n of needles) {
    for (const m of matchNeedle(n, src)) {
      const line = lineOf(src, m.index);
      if (n.kind === "term") {
        const bl = blocklistAt(ctx, f, m.index);
        if (bl) {
          const key = `${bl.file}#${bl.name}`;
          const entry = st.blocklists.get(key) ?? { file: bl.file, line: bl.line, used: bl.used, terms: new Set<string>(), server: isServerPath(bl.file) };
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
          st.moderationKeys.set(at, (st.moderationKeys.get(at) ?? new Set()).add(n.value.toLowerCase()));
          st.excluded++;
          continue;
        }
        if (isMetadataPath(f.path) && REMOVAL_NOTICE.test(lineText(src, m.index))) {
          st.excluded++;
          continue;
        }
      }
      const c = classify(ctx, f, m.index, m.end);
      const variant = n.kind === "term" && m.text.toLowerCase() !== n.value.toLowerCase();
      pushHit(st, {
        kind: isMetadataPath(f.path) ? "metadata" : n.kind,
        needle: n.value,
        file: f.path,
        line,
        evidence: lineText(f.text, m.index),
        ...c,
        confidence: variant && c.confidence === "high" ? "medium" : c.confidence,
        reason: variant ? `${c.reason} Matched the spelling variant "${m.text}".` : c.reason,
      });
    }
  }
}

function obfuscationSweep(f: SourceFile, needles: Needle[], st: SweepState) {
  const code = isCodeFile(f);
  if (!code && !CONFIG_EXTS.has(f.ext)) return;
  const src = code ? f.code : f.text;
  const nearAi = code && (AI_SINK.test(src) || PROMPTISH.test(src));
  const obf = (idx: number, needle: string, reason: string) =>
    pushHit(st, {
      kind: "obfuscation",
      needle,
      file: f.path,
      line: lineOf(src, idx),
      evidence: lineText(f.text, idx),
      status: "PRESENT",
      confidence: "medium",
      reason: `${reason} Static checks cannot see what this produces at runtime, and hiding features through obfuscation is itself grounds for removal under 2.5.19. Replace it with plain, reviewable text or disclose it in the review notes.`,
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
          reason: "The decoded blob still contains a residue item. Encoding it does not remove it; it hides it, which 2.5.19 treats as concealment.",
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

/** Requests that carry a report, account or telemetry payload, judged by where they go and what sends them. */
const NOT_GENERATION = new Set(
  "report reporter reporting feedback support contact abuse flag flagging bug analytics telemetry log logs logging event events track tracking metric metrics auth login signin signup account profile subscription purchase receipt push notification token health ping".split(" "),
);
const wordsOf = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const GENERATION_HINT = /generat|imag(e|ine)|render|chat|complet|prompt|avatar|predict|infer|llm|diffus|styli[sz]e|portrait|caption/i;

/** Calls to the developer's own backend from prompt-building code, where the server is not in this repo. */
function unverifiableCalls(ctx: ScanContext, files: SourceFile[]): string[] {
  const out: string[] = [];
  const serverFiles = ctx.files.filter((f) => isServerPath(f.path) && isCodeFile(f));
  const hasServer = serverFiles.length > 0;
  for (const f of files) {
    if (!isCodeFile(f) || isServerPath(f.path)) continue;
    if (!/\bprompt\b|generat/i.test(f.code)) continue;
    // Requests in a file that names an AI provider are taken to go to that provider.
    if (AI_HOSTS.test(f.code)) continue;
    // The last request built with a target: a send without one shortly after, in the same function, is that request.
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
      // A field named "prompt" on a report or account request does not make it a generation call.
      const what = [target, fnName ?? "", ...decls.map((d) => d.ident)].join(" ");
      if (wordsOf(what).some((w) => NOT_GENERATION.has(w) || NOT_GENERATION.has(w.replace(/s$/, ""))) && !GENERATION_HINT.test(what)) continue;
      out.push(
        `${f.path}:${line} sends a prompt-building request to ${target || fnName || "a backend"}; the prompt template and any filters on that server are not in this repo, so they need a developer attestation.`,
      );
    }
  }
  return [...new Set(out)].slice(0, 30);
}

/** A filter found in the repo, and where it sits, so it can be tied to the generation call it guards. */
interface Filter {
  /** text filters do not screen uploaded images; "both" covers prompts and images */
  kind: "text" | "both";
  file: string;
  line: number;
  label: string;
  /** provider a safety setting applies to; it filters only that provider's calls */
  provider?: string;
  /** a declared list that code must reference to count */
  name?: string;
}

interface Blocking {
  filters: Filter[];
  disabled: string[];
  /** generation calls in the repo, by file */
  sinkFiles: string[];
  /** lines of the generation calls in each sink file */
  sinkLines: Map<string, number[]>;
}

function blockingEvidence(spec: ResidueSpec, st: SweepState, sites: AiSite[], sinks: AiSite[]): Blocking {
  const wanted = spec.terms.length
    ? spec.terms.map((t) => t.toLowerCase())
    : (spec.capability.toLowerCase().match(/\p{L}{5,}/gu) ?? []);
  const filters: Filter[] = [];
  for (const [key, bl] of st.blocklists) {
    if (!bl.used) continue;
    const covered = wanted.filter((w) => bl.terms.has(w)).length;
    if (wanted.length && covered / wanted.length >= 0.5) {
      filters.push({
        kind: "text",
        file: bl.file,
        line: bl.line,
        name: key.slice(key.indexOf("#") + 1),
        label: `${bl.server ? "server-side " : ""}blocklist at ${bl.file}:${bl.line} covers ${covered}/${wanted.length} spec terms and is used in code`,
      });
    }
  }
  const disabled: string[] = [];
  for (const s of sites) {
    const where = `${s.file}:${s.line}`;
    const server = isServerPath(s.file) ? "server-side " : "";
    if (s.role === "safety-disabled") disabled.push(`provider safety is turned off at ${where} (${s.label})`);
    else if (s.role === "safety-strict") filters.push({ kind: "both", file: s.file, line: s.line, provider: settingProvider(s.label), label: `${server}strict ${providerName(settingProvider(s.label))} safety setting at ${where} (${s.label})` });
    else if (s.role === "moderation") filters.push({ kind: s.label.startsWith("image") ? "both" : "text", file: s.file, line: s.line, label: `${server}${s.label} at ${where}` });
  }
  // A host named in a JSON/YAML config is not a call site; it cannot carry a filter of its own.
  const code = sinks.filter((x) => !/\.(json|ya?ml|toml)$/i.test(x.file));
  const sinkLines = new Map<string, number[]>();
  for (const x of code) sinkLines.set(x.file, [...(sinkLines.get(x.file) ?? []), x.line]);
  return { filters, disabled, sinkFiles: [...sinkLines.keys()], sinkLines };
}

/** Which provider a strict safety setting belongs to (BLOCK_* thresholds are Gemini's, and so on). */
function settingProvider(label: string): string | undefined {
  if (/BLOCK_/.test(label)) return "gemini";
  if (/safety_tolerance/.test(label)) return "bfl";
  if (/enable_safety_checker/.test(label)) return "fal";
  if (/disable_safety_checker/.test(label)) return "replicate";
  return undefined;
}

function providerName(id: string | undefined): string {
  return (id && PROVIDERS.find((p) => p.id === id)?.name) || "provider";
}

// Loose names for when a file builds the request by hand (URLRequest to a host) or uses an unlisted SDK.
const PROVIDER_HINTS: Record<string, RegExp> = {
  gemini: /\bgemini\b|GenerativeModel|generativelanguage|aiplatform\.googleapis/i,
  replicate: /\breplicate\b/i,
  fal: /\bfal\.(?:run|ai|media|subscribe|queue)\b|["'`]fal-ai\//i,
  openai: /\bopenai\b|api\.openai\.com/i,
  bfl: /api\.bfl\.|black-forest-labs/i,
  stability: /stability\.ai|stability-ai\//i,
  anthropic: /\banthropic\b/i,
};

function providersOf(f: SourceFile | undefined): Set<string> {
  const out = new Set<string>();
  if (!f) return out;
  for (const p of PROVIDERS) if (p.sdk.test(f.code) || p.hosts?.test(f.text)) out.add(p.id);
  for (const [id, rx] of Object.entries(PROVIDER_HINTS)) if (rx.test(f.code)) out.add(id);
  return out;
}

const FILE_REF = /([\w./-]+\.(?:swift|tsx?|jsx?|mjs|cjs|kt|py|dart|go|rb|m|mm))(?::\d+)?/g;

function refsIn(ctx: ScanContext, text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(FILE_REF)) {
    const ref = m[1]!.replace(/^\.\//, "");
    const f = ctx.files.find((x) => x.path === ref || x.path.endsWith(`/${ref}`));
    if (f && !out.includes(f.path)) out.push(f.path);
  }
  return out;
}

/** The line each path file is cited at ("ChatView.swift:30"), first citation wins. */
function citedLines(ctx: ScanContext, text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of text.matchAll(/([\w./-]+\.(?:swift|tsx?|jsx?|mjs|cjs|kt|py|dart|go|rb|m|mm)):(\d+)/g)) {
    const [p] = refsIn(ctx, m[1]!);
    if (p && !out.has(p)) out.set(p, Number(m[2]));
  }
  return out;
}

/**
 * Files whose filters can guard a generation call in `sinkFile`: the file itself, files the
 * traced path names, and files declaring something the chain calls (one hop). `used` is what the
 * chain itself names, not everything in the path files: a view that moderates its chat text in
 * one function and uploads a selfie in another must not lend the moderator to the upload.
 */
function guardFiles(ctx: ScanContext, direct: Set<string>, used: Set<string>): Set<string> {
  const out = new Set(direct);
  for (const f of ctx.files) {
    if (out.has(f.path) || !isCodeFile(f)) continue;
    if (declaredNames(f).some((n) => used.has(n))) out.add(f.path);
  }
  return out;
}

const FN_KIND = /^(func|function)$/;
const TYPE_KIND = /^(class|struct|enum|protocol|interface|type)$/;
const FN_DECL = /\b(?:func|function)\s+([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g;

const fnLike = (d: Enclosing) => FN_KIND.test(d.declKind) || (/^(const|let|var)$/.test(d.declKind) && /=>|=\s*(async\s+)?function\b/.test(d.header));

/**
 * Functions in `g` that the guarded chain calls: named in the sink or path files, or called from
 * one that is (a public isAllowed that calls a private check), followed to a fixed point.
 */
function reachedFunctions(g: SourceFile, used: Set<string>): Set<string> {
  const fns = [...new Set([...g.code.matchAll(FN_DECL)].map((m) => m[1] ?? m[2]).filter((n): n is string => !!n))];
  const reached = new Set(fns.filter((n) => used.has(n)));
  const masked = maskedOf(g);
  for (let changed = true, rounds = 0; changed && rounds < 8; rounds++) {
    changed = false;
    for (const n of fns) {
      if (reached.has(n)) continue;
      for (const m of masked.matchAll(new RegExp(`(?<![\\w$])${escapeRx(n)}(?![\\w$])`, "g"))) {
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

/**
 * Whether a filter in a file the sink reaches only by naming something it declares is on the
 * guarded call chain. Sharing a file with a type the chain uses (a ContentReporter next to an
 * unused ContentModerator) does not put the moderator on the chain.
 */
function onCallChain(g: SourceFile, line: number, used: Set<string>): boolean {
  const decls = enclosingDeclarations(g, lineStartOffset(g, line));
  if (!decls.length) return false;
  const types = decls.filter((d) => TYPE_KIND.test(d.declKind));
  // A method name the chain uses on some other type (PromptFilter.isAllowed) is not this type's.
  const outer = types[types.length - 1];
  if (outer && !used.has(outer.ident)) return false;
  const fn = decls.find(fnLike);
  if (!fn) return !!outer || decls.some((d) => used.has(d.ident));
  return reachedFunctions(g, used).has(fn.ident);
}

/** Offset of the first code character on a 1-based line. */
function lineStartOffset(g: SourceFile, line: number): number {
  const lines = g.code.split("\n");
  const l = lines[line - 1] ?? "";
  return lines.slice(0, line - 1).reduce((n, x) => n + x.length + 1, 0) + (l.length - l.trimStart().length);
}

/** Body spans of every declaration (function or property) named in `names`, found lexically. */
function declRanges(g: SourceFile, names: Set<string>): Array<[number, number]> {
  const masked = maskedOf(g);
  const out: Array<[number, number]> = [];
  for (const m of masked.matchAll(/\b(?:func|function|var|let|const|val)\s+([A-Za-z_$][\w$]*)/g)) {
    if (!names.has(m[1]!)) continue;
    const start = m.index ?? 0;
    let i = start + m[0].length;
    let paren = 0;
    let open = -1;
    for (; i < masked.length; i++) {
      const ch = masked[i];
      if (ch === "(" || ch === "[") paren++;
      else if (ch === ")" || ch === "]") paren--;
      else if (paren > 0) continue;
      else if (ch === "{") {
        open = i;
        break;
      } else if (ch === ";" || ch === "}") break;
      else if (ch === "\n" && !/^\s*\{/.test(masked.slice(i + 1, i + 200)) && !/(=>|=|->)\s*$/.test(masked.slice(start, i))) break;
    }
    if (open < 0) {
      out.push([start, i]);
      continue;
    }
    let depth = 0;
    let j = open;
    for (; j < masked.length; j++) {
      if (masked[j] === "{") depth++;
      else if (masked[j] === "}" && --depth === 0) break;
    }
    out.push([start, j + 1]);
  }
  return out;
}

const DECL_ON_LINE = /\b(?:let|var|const|val)\s+([A-Za-z_$][\w$]*)/;

/**
 * The parts of a path file that are on the call into the sink: functions that name something the
 * sink file declares (directly or through a stored property holding it) and what they call.
 * A filter used in a sibling function of the same file (moderated chat next to an unmoderated
 * selfie upload) is not on that call. Undefined when the call cannot be placed in a function.
 */
function chainRegions(p: SourceFile, sink: SourceFile, citedLine: number | undefined): Array<[number, number]> | undefined {
  const masked = maskedOf(p);
  const fns = new Set<string>();
  const holders = new Set<string>();
  const seen = new Set<string>();
  let unplaced = false;
  const place = (at: number) => {
    const decls = enclosingDeclarations(p, at);
    const fn = decls.find(fnLike);
    if (fn) {
      fns.add(fn.ident);
      return;
    }
    const lineStart = masked.lastIndexOf("\n", at - 1) + 1;
    const lineEnd = masked.indexOf("\n", at);
    const decl = DECL_ON_LINE.exec(masked.slice(lineStart, lineEnd < 0 ? undefined : lineEnd));
    const holder = decls.find((d) => !TYPE_KIND.test(d.declKind))?.ident ?? (decl && lineStart + decl.index <= at ? decl[1] : undefined);
    if (!holder) {
      unplaced = true;
      return;
    }
    holders.add(holder);
    follow([holder]);
  };
  const follow = (names: string[]) => {
    for (const n of names) {
      if (seen.has(n)) continue;
      seen.add(n);
      for (const m of masked.matchAll(new RegExp(`(?<![\\w$])${escapeRx(n)}(?![\\w$])`, "g"))) place(m.index ?? 0);
    }
  };
  follow(declaredNames(sink));
  if (!fns.size && !holders.size && citedLine) place(lineStartOffset(p, citedLine));
  if (unplaced || (!fns.size && !holders.size)) return undefined;
  const names = new Set([...holders, ...fns, ...reachedFunctions(p, fns)]);
  return declRanges(p, names);
}

/**
 * Functions of the sink file on the way to its generation call: those that call it (transitively)
 * and whatever they call. A moderation helper nothing on that way calls does not screen the
 * request. Undefined when a generation call sits outside any function.
 */
function sinkChain(g: SourceFile, lines: number[]): Set<string> | undefined {
  const entry = new Set<string>();
  for (const line of lines) {
    const fn = enclosingDeclarations(g, lineStartOffset(g, line)).find(fnLike);
    if (!fn) return undefined;
    entry.add(fn.ident);
  }
  const masked = maskedOf(g);
  const fns = [...new Set([...g.code.matchAll(FN_DECL)].map((m) => m[1] ?? m[2]).filter((n): n is string => !!n))];
  const callers = new Map<string, Set<string>>();
  for (const n of fns) {
    for (const m of masked.matchAll(new RegExp(`(?<![\\w$])${escapeRx(n)}(?![\\w$])`, "g"))) {
      const caller = enclosingDeclarations(g, m.index ?? 0).find(fnLike);
      if (caller && caller.ident !== n) callers.set(n, (callers.get(n) ?? new Set()).add(caller.ident));
    }
  }
  const upward = new Set(entry);
  for (const todo = [...entry]; todo.length; ) {
    for (const c of callers.get(todo.pop()!) ?? []) if (!upward.has(c)) upward.add(c), todo.push(c);
  }
  return reachedFunctions(g, upward);
}

function filtersForSink(ctx: ScanContext, b: Blocking, sinkFile: string, pathFiles: string[], image: boolean, cited: Map<string, number> = new Map()): Filter[] {
  const fileOf = (p: string) => ctx.files.find((f) => f.path === p);
  const sink = fileOf(sinkFile);
  const sinkProviders = providersOf(sink);
  const direct = new Set([sinkFile, ...pathFiles]);
  const regions = new Map<string, Array<[number, number]>>();
  const chainUsed = identifiersOf(sink ? [sink] : []);
  for (const pf of pathFiles) {
    const f = fileOf(pf);
    if (!f || pf === sinkFile) continue;
    const r = sink ? chainRegions(f, sink, cited.get(pf)) : undefined;
    if (r) regions.set(pf, r);
    const text = r ? r.map(([s, e]) => f.code.slice(s, e)).join("\n") : f.code;
    for (const id of text.match(/[A-Za-z_$][\w$]*/g) ?? []) chainUsed.add(id);
  }
  const guards = guardFiles(ctx, direct, chainUsed);
  const used = new Set(chainUsed);
  for (const p of guards) if (!direct.has(p)) for (const id of identifiersOf([fileOf(p)].filter((f): f is SourceFile => !!f))) used.add(id);
  const chain = sink ? sinkChain(sink, b.sinkLines.get(sinkFile) ?? []) : undefined;
  const guarding = (x: Filter) => {
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
    // A provider setting filters only that provider's calls, wherever it is written.
    if (x.provider) return guarding(x) && (sinkProviders.size === 0 || sinkProviders.has(x.provider));
    if (guarding(x)) return true;
    return !!x.name && used.has(x.name);
  });
}

const IMAGE_PATH = /\b(image|photo|upload|camera|picture|img2img|remix|selfie|face|gallery)\b/i;

/**
 * One entry per filter a reviewer would recognize. A call site (ContentModerator.shared.isAllowed)
 * and the moderator file it calls into are one moderation call, and a provider setting written
 * once per harm category is one setting.
 */
function distinctFilters(ctx: ScanContext, found: Filter[]): Filter[] {
  const where = (x: Filter) => x.label.replace(` at ${x.file}:${x.line}`, "");
  const token = (x: Filter) => /\(([^)]+)\)/.exec(where(x))?.[1]?.toLowerCase();
  const isModeration = (x: Filter) => !x.provider && !x.name;
  const declared = new Map<string, Set<string>>();
  const declaresOf = (file: string) => {
    let d = declared.get(file);
    if (!d) {
      const f = ctx.files.find((g) => g.path === file);
      d = new Set((f ? declaredNames(f) : []).map((n) => n.toLowerCase()));
      declared.set(file, d);
    }
    return d;
  };
  const calledInto = (y: Filter) =>
    found.some((x) => {
      if (x === y || x.file === y.file || !isModeration(x)) return false;
      const t = token(x);
      return !!t && declaresOf(y.file).has(t);
    });
  const seen = new Set<string>();
  return found.filter((x) => {
    if (isModeration(x) && calledInto(x)) return false;
    const key = isModeration(x) ? `m|${x.file}|${x.kind}` : `${x.provider ?? x.name}|${x.file}|${where(x)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}


function judgePath(ctx: ScanContext, name: string, text: string, b: Blocking, generationLeft: boolean, extraRefs: string[] = []): { inputPath: string; blocked: boolean; evidence: string[] } {
  if (b.disabled.length) return { inputPath: name, blocked: false, evidence: [...b.disabled, "Provider safety is explicitly disabled, so other filters cannot be relied on."] };
  if (!generationLeft) return { inputPath: name, blocked: true, evidence: ["No AI generation call or prompt-building backend call remains in the repo."] };
  const image = IMAGE_PATH.test(text);
  const arrow = text.split(/→|->/);
  const sinkSide = arrow.length > 1 ? arrow.slice(1).join(" ") : text;
  const pathFiles = [...new Set([...refsIn(ctx, text), ...extraRefs])];
  const cited = citedLines(ctx, text);
  const named = [...new Set([...refsIn(ctx, sinkSide), ...pathFiles])].filter((f) => b.sinkFiles.includes(f));
  // A path that names no generation call must be safe at every one of them.
  const sinks = named.length ? named : b.sinkFiles;
  if (!sinks.length) {
    const any = b.filters.filter((x) => !image || x.kind === "both");
    if (any.length) return { inputPath: name, blocked: true, evidence: any.slice(0, 6).map((x) => `${x.label} (no generation call in the repo to tie it to)`) };
    return { inputPath: name, blocked: false, evidence: ["No prompt blocklist covering the spec terms, moderation call or strict provider safety setting was found in the repo."] };
  }
  const evidence: string[] = [];
  const open: string[] = [];
  // Unnamed: each call's filters stay in one entry tagged with that call, so a setting that guards
  // the chat call is never read as a filter on the image picker.
  const grouped = !named.length && sinks.length > 1;
  const sinkNames = (sink: string) => {
    const f = ctx.files.find((x) => x.path === sink);
    return f ? declaredNames(f) : [];
  };
  // A path file that names nothing a generation call declares does not call it, so its filters are not lent to it.
  const reaching = (sink: string) => {
    const names = sinkNames(sink);
    return pathFiles.filter((pf) => {
      const f = ctx.files.find((x) => x.path === pf);
      return !!f && (pf === sink || names.some((n) => new RegExp(`(?<![\\w$])${escapeRx(n)}(?![\\w$])`).test(f.code)));
    });
  };
  for (const sink of sinks) {
    const found = distinctFilters(ctx, filtersForSink(ctx, b, sink, grouped ? reaching(sink) : pathFiles, image, cited));
    if (!found.length) open.push(sink);
    else if (grouped) evidence.push(`${found.slice(0, 3).map((x) => x.label).join("; ")} (guards ${sink})`);
    else evidence.push(...found.slice(0, 3).map((x) => `${x.label} (guards ${sink})`));
  }
  if (!open.length) {
    const note = grouped
      ? [`The path names no generation call, so all ${sinks.length} generation calls in the repo had to be guarded; each filter below guards only the call named after it, not this path as a whole.`]
      : [];
    return { inputPath: name, blocked: true, evidence: [...note, ...[...new Set(evidence)].slice(0, 6)] };
  }
  // A moderation call or blocklist off the call path is the likelier near miss than another provider's setting.
  const elsewhere = b.filters
    .filter((x) => !open.some((o) => filtersForSink(ctx, b, o, pathFiles, image, cited).includes(x)))
    .sort((x, y) => Number(!!x.provider) - Number(!!y.provider));
  const out = open.map((sink) => {
    const prov = [...providersOf(ctx.files.find((f) => f.path === sink))].map((id) => providerName(id)).join("/");
    return image
      ? `The generation call in ${sink}${prov ? ` (${prov})` : ""} has no image moderation or strict safety setting of its own; a text blocklist does not filter uploaded images.`
      : `The generation call in ${sink}${prov ? ` (${prov})` : ""} has no filter of its own: no moderation call or prompt blocklist on its call path and no strict safety setting for its provider.`;
  });
  if (elsewhere.length) out.push(`Filters elsewhere are not on its call path, so they do not cover it: ${elsewhere.slice(0, 3).map((x) => x.label).join("; ")}. A setting for a different provider filters only that provider's calls.`);
  if (!b.filters.length) out.push("Provider default safety settings are not counted: defaults commonly allow the content App Review rejected (for example lingerie).");
  return { inputPath: name, blocked: false, evidence: out };
}

type RefState = "present" | "gone" | "line-only";

/**
 * A bare file:line ref only says the line number exists; the line at the pre-fix commit stands in
 * for the missing snippet when there is one, so a deleted line is not read as still present.
 */
async function refState(root: string, ev: string, baseRef: string | undefined, gitRepo: boolean): Promise<RefState> {
  const ref = parseEvidenceRef(ev);
  if (!ref) return "present"; // unparseable evidence cannot prove removal
  const abs = path.join(root, ref.file);
  if (!abs.startsWith(path.resolve(root) + path.sep) || !existsSync(abs)) return "gone";
  // a FIFO or device named as evidence must not hang verify; an unreadable file proves nothing removed
  const body = await readRegularFile(abs, EVIDENCE_MAX_BYTES, "evidence file", root).catch(() => undefined);
  if (!body) return "present";
  const text = body.toString("utf8");
  const lines = text.split("\n");
  let snippet = ref.snippet;
  if (!snippet && baseRef && gitRepo && safeRef(baseRef) && !/[\0:]/.test(ref.file)) {
    const before = (await git(root, ["show", "--no-textconv", `${baseRef}:${ref.file}`]))?.split("\n")[ref.line - 1]?.trim();
    if (before && /[\p{L}\p{N}]/u.test(before)) snippet = before;
  }
  if (snippet) {
    const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
    return norm(text).includes(norm(snippet)) ? "present" : "gone";
  }
  return ref.line >= 1 && ref.line <= lines.length ? "line-only" : "gone";
}

interface Replaced {
  file: string;
  line: number;
  needle: Needle;
  before: string;
  after: string;
  replacement: string;
}

const tokensOf = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/**
 * Whether `after` is `before` with the matched spec text swapped for something else in place,
 * e.g. "Lingerie" → "Style 7". A plain deletion ("Casual", "Lingerie" → "Casual") is not a swap.
 */
function inPlaceSwap(before: string, after: string, needles: Needle[]): { needle: Needle; replacement: string } | undefined {
  const b = before.trim();
  const a = after.trim();
  if (!a || matchesAny(needles, a)) return undefined; // still matching: the sweep reports it already
  for (const n of needles) {
    const ms = matchNeedle(n, b, 20);
    if (!ms.length) continue;
    // lazy groups backtrack per match; a line with many matches goes to the token check alone
    if (ms.length <= 6) {
      const parts: string[] = [];
      let at = 0;
      for (const m of ms) {
        parts.push(escapeRx(b.slice(at, m.index)));
        at = m.end;
      }
      parts.push(escapeRx(b.slice(at)));
      const rx = new RegExp(`^${parts.join("(.{1,80}?)")}$`, "s");
      const hit = rx.exec(a);
      if (hit) {
        const replacement = hit.slice(1).join(", ").trim();
        if (replacement && /[\p{L}\p{N}]/u.test(replacement)) return { needle: n, replacement };
      }
    }
    // Looser: everything else on the line survived and new words took the needle's place.
    const rest = tokensOf(b.replace(new RegExp(n.rx.source, n.rx.flags.includes("g") ? n.rx.flags : `${n.rx.flags}g`), " "));
    const now = tokensOf(a);
    const fresh = now.filter((t) => !tokensOf(b).includes(t));
    if (rest.length >= 4 && fresh.length && fresh.length <= ms.length * 3 && rest.filter((t) => now.includes(t)).length / rest.length >= 0.85) {
      return { needle: n, replacement: fresh.join(" ") };
    }
  }
  return undefined;
}

const needleSet = (needles: Needle[], text: string): string =>
  needles
    .filter((n) => matchNeedle(n, text, 1).length)
    .map((n) => `${n.kind}:${n.value.toLowerCase()}`)
    .join("|");

/**
 * Whether every spec match on a removed line sat in a filter list or a refusal instruction at the
 * base commit. Deleting or rewriting a filter removes no capability, so it is not offered as such.
 */
function filterOnlyLine(old: SourceFile, files: readonly SourceFile[], lineNo: number, needles: Needle[]): boolean {
  const src = isCodeFile(old) ? old.code : old.text;
  const lines = src.split("\n");
  const text = lines[lineNo - 1];
  if (text === undefined) return false;
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

async function diffEvidence(
  ctx: ScanContext,
  baseRef: string,
  needles: Needle[],
): Promise<{ removed: string[]; replaced: Replaced[]; renamedFiles: { from: string; to: string; needle: Needle }[]; filterLines: number; stat?: string; error?: string }> {
  const root = ctx.root;
  const none = { removed: [] as string[], replaced: [] as Replaced[], renamedFiles: [] as { from: string; to: string; needle: Needle }[], filterLines: 0 };
  if (!safeRef(baseRef)) return { ...none, error: `baseRef "${baseRef}" is not a plain git ref` };
  const ok = await git(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${baseRef}^{commit}`]);
  if (!ok?.trim()) return { ...none, error: `baseRef ${baseRef} was not found in this repository` };
  const stat = (await git(root, ["diff", "--shortstat", "--no-ext-diff", "--no-textconv", baseRef, "--"]))?.trim();
  const diff = await git(root, ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", baseRef, "--"]);
  if (diff === undefined) return { ...none, stat, error: "git diff failed" };
  const removed: string[] = [];
  const removedLines: { file: string; line: number; text: string }[] = [];
  const replaced: Replaced[] = [];
  let file = "";
  let oldLine = 0;
  let newLine = 0;
  let minus: { line: number; text: string }[] = [];
  let plus: { line: number; text: string }[] = [];
  const flush = () => {
    for (const [i, r] of minus.entries()) {
      if (!matchesAny(needles, r.text)) continue;
      // The hunk still adds a line with the same spec matches (a renamed list, a reflowed line):
      // nothing was removed, and the sweep judges the new line where it now stands.
      const kept = needleSet(needles, r.text);
      // A line commented out in place does not keep anything, so comments are stripped first.
      if (plus.some((p) => needleSet(needles, stripComments(p.text, extOf(file))) === kept)) continue;
      // the line at the same position first, then any other line the hunk added
      const order = plus[i] ? [plus[i]!, ...plus.filter((_, j) => j !== i)] : plus;
      const swap = order.map((p) => ({ p, s: inPlaceSwap(r.text, p.text, needles) })).find((x) => x.s);
      if (swap?.s) replaced.push({ file, line: swap.p.line, needle: swap.s.needle, before: r.text, after: swap.p.text, replacement: swap.s.replacement });
      else removedLines.push({ file, line: r.line, text: r.text });
    }
    minus = [];
    plus = [];
  };
  for (const l of diff.split("\n")) {
    if (l.startsWith("diff --git ")) {
      flush();
      file = /^diff --git a\/(.+?) b\//.exec(l)?.[1] ?? "";
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
    if ((l.startsWith("Binary files ") && /\/dev\/null differ$/.test(l)) || l.startsWith("deleted file mode")) {
      if (matchesAny(needles, file)) removed.push(`${file} (deleted)`);
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
    const old: SourceFile | undefined = text === undefined ? undefined : { path: rel, abs: path.join(root, rel), ext, text, code: stripComments(text, ext) };
    const files = old ? [old, ...ctx.files.filter((f) => f.path !== rel)] : [];
    for (const r of lines) {
      if (old && filterOnlyLine(old, files, r.line, needles)) {
        filterLines++;
        continue;
      }
      removed.push(`${rel}:${r.line}: ${clip(r.text, 120)}`);
    }
  }

  // A file "deleted" under a matching name may only have moved; renames do not remove anything.
  const renamedFiles: { from: string; to: string; needle: Needle }[] = [];
  const status = await git(root, ["diff", "--name-status", "-M50%", "--no-ext-diff", "--no-textconv", baseRef, "--"]);
  for (const l of status?.split("\n") ?? []) {
    const [code, from, to] = l.split("\t");
    if (!code?.startsWith("R") || !from || !to) continue;
    const n = matchesAny(needles, from);
    if (!n || matchesAny(needles, to)) continue;
    renamedFiles.push({ from, to, needle: n });
  }
  const movedFrom = renamedFiles.map((r) => r.from);
  const kept = [...new Set(removed)].filter((r) => !movedFrom.some((m) => r === `${m} (deleted)` || r.startsWith(`${m}:`)));
  return { removed: kept, replaced, renamedFiles, filterLines, stat };
}

type RemovedCondition = NonNullable<Verification["removedConditions"]>[number];

/** Review-time conditions: what reviewers saw depended on them, so their removal is disclosed (2.5.19). */
const isConditionRule = (rule: string) => rule.startsWith("review_gating.") || rule === "remote_config.content_gating";
const CONDITION_EXTS = new Set([...CODE_EXTENSIONS, "json", "plist", "xcconfig", "pbxproj", "yaml", "yml", "env"]);
const MAX_BASE_FILE = 1024 * 1024;
const NOT_NAMES = new Set(["true", "false", "self", "this", "return", "else", "guard", "while", "let", "var", "const", "null", "undefined", "nil"]);

async function conditionFindings(ctx: ScanContext): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const c of [reviewGatingCheck, remoteConfigCheck]) {
    const r = await c.run(ctx).catch(() => ({ findings: [] as Finding[] }));
    out.push(...r.findings.filter((f) => isConditionRule(f.rule) && f.severity !== "info" && !!f.file));
  }
  return out;
}

/** The tested expression of a gate line: `if !AppEnvironment.isTestFlight {` → `!AppEnvironment.isTestFlight`. */
function conditionOf(evidence: string): string {
  const e = evidence
    .trim()
    .replace(/^\}?\s*(else\s+)?(if|guard|while|switch|unless)\b\s*/, "")
    .replace(/\s*(else\s*)?\{\s*$/, "")
    .trim();
  const inner = /^\((.*)\)$/.exec(e)?.[1];
  return clip(inner ?? e, 120);
}

const namesIn = (s: string) => [...new Set((s.match(/[A-Za-z_$][\w$]{3,}/g) ?? []).filter((n) => !NOT_NAMES.has(n)))];

function gatesOf(f: Finding): string | undefined {
  const what = /The gated code touches ([^.]+?)\.(?:\s|$)/.exec(f.why)?.[1] ?? /\bgates (.+?) at [\w./-]+:\d+/.exec(f.why)?.[1];
  return what ? `gated code that touches ${clip(what, 100)}` : undefined;
}

/**
 * Review-time conditions the scanners flag in the pre-fix tree (`baseRef`) that are gone from the
 * working tree. Removing one changes what App Review saw, so it is disclosed even when it is not
 * residue of the spec. A condition still written in the file, or still flagged anywhere, is kept.
 */
async function removedConditionsSince(ctx: ScanContext, baseRef: string, includeTests: boolean): Promise<RemovedCondition[]> {
  if (!safeRef(baseRef)) return [];
  const status = await git(ctx.root, ["diff", "--name-status", "--no-renames", "--no-ext-diff", "--no-textconv", baseRef, "--"]);
  if (!status) return [];
  const changed = new Map<string, string>();
  for (const l of status.split("\n")) {
    const [code, file] = l.split("\t");
    if (!code || !file) continue;
    if (!includeTests && isTestPath(file)) continue;
    if (CONDITION_EXTS.has(extOf(file))) changed.set(file, code);
  }
  if (!changed.size) return [];
  const files = ctx.files.filter((f) => !changed.has(f.path));
  for (const [rel, code] of changed) {
    if (code.startsWith("A") || /[\0:]/.test(rel)) continue;
    const text = await git(ctx.root, ["show", "--no-textconv", `${baseRef}:${rel}`]);
    if (text === undefined || text.length > MAX_BASE_FILE || text.includes("\u0000")) continue;
    const ext = extOf(rel);
    files.push({ path: rel, abs: path.join(ctx.root, rel), ext, text, code: stripComments(text, ext) });
  }
  const [before, now] = await Promise.all([conditionFindings({ ...ctx, files }), conditionFindings(ctx)]);
  const out: RemovedCondition[] = [];
  for (const f of before) {
    if (!changed.has(f.file!) || !f.evidence) continue;
    const condition = conditionOf(f.evidence);
    const names = namesIn(condition);
    if (!names.length) continue;
    const has = (text: string) => names.every((n) => new RegExp(`(?<![\\w$])${escapeRx(n)}(?![\\w$])`).test(text));
    if (now.some((g) => g.rule === f.rule && has(g.evidence ?? ""))) continue;
    // still in the file but no longer flagged (it now gates nothing sensitive): not removed
    const cur = ctx.files.find((x) => x.path === f.file);
    if (cur && cur.code.split("\n").some(has)) continue;
    if (out.some((o) => o.file === f.file && o.condition === condition)) continue;
    const gates = gatesOf(f);
    out.push({ rule: f.rule, file: f.file!, ...(f.line ? { line: f.line } : {}), condition, ...(gates ? { gates } : {}) });
    if (out.length >= 20) break;
  }
  return out;
}

/** Rejections this verification may be for, most specific first; `single` when it is known which one. */
function rejectionsFor(events: LedgerEvent[], spec: ResidueSpec, rejectionId: string | undefined): { single?: RejectionState; open: RejectionState[] } {
  const rejections = foldEvents("", events).rejections;
  if (rejectionId) return { single: rejections.find((r) => r.id === rejectionId), open: [] };
  const key = JSON.stringify(spec);
  const saved = rejections.filter((r) => {
    if (!r.spec) return false;
    const parsed = ResidueSpecSchema.safeParse(r.spec);
    return parsed.success && JSON.stringify(parsed.data) === key;
  });
  if (saved.length) return { single: saved[saved.length - 1], open: [] };
  return { open: rejections.filter((r) => !r.approvedBy && r.outcome === "rejected" && r.reviewerMessage?.trim()) };
}

async function commitBefore(root: string, at: string): Promise<string | undefined> {
  if (!Number.isFinite(Date.parse(at))) return undefined;
  return (await git(root, ["rev-list", "-1", `--before=${new Date(at).toISOString()}`, "HEAD", "--"]))?.trim() || undefined;
}

async function repoLedgerEvents(root: string): Promise<LedgerEvent[]> {
  try {
    return (await readLedger(await locateLedger(root, { remember: false }))).events;
  } catch {
    return [];
  }
}

const FAILING_STATUS = new Set<ResidueHit["status"]>(["PRESENT", "GATED", "UNREFERENCED"]);

/**
 * The tier with the reason it is RESIDUE_FOUND: that tier also covers an input path with no filter,
 * which is not leftover code and is fixed differently (add a filter), so the label says which.
 */
export function tierLabel(v: Pick<Verification, "tier" | "residue" | "inputPaths">): string {
  if (v.tier !== "RESIDUE_FOUND") return v.tier;
  const residue = v.residue.some((r) => r.kind !== "obfuscation" && FAILING_STATUS.has(r.status));
  const open = v.inputPaths.some((p) => !p.blocked);
  const why = [residue ? "residue present" : "", open ? "input path not blocked" : ""].filter(Boolean).join("; ");
  return why ? `RESIDUE_FOUND (${why})` : v.tier;
}

export async function verifyRemediation(root: string, specIn: ResidueSpec, opts: VerifyOptions): Promise<Verification> {
  const spec = ResidueSpecSchema.parse(specIn);
  const ctx = await loadContext(root, { includeTests: opts.includeTests });
  const needles = needlesOf(spec);
  const st = newSweep();
  const notes: string[] = [];

  // (2)+(3) residue sweep with scope classification
  const files = ctx.files.filter(inSweep);
  for (const f of files) sweepFile(ctx, f, needles, st);

  // file, asset-catalog and screenshot names
  const pathNeedles = needles.filter((n) => n.kind === "term" || n.kind === "asset" || n.kind === "symbol");
  const matchedDirs: string[] = [];
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
      reason: isMetadataPath(rel)
        ? "A store metadata file or screenshot name still refers to it; check the image and replace it."
        : /\.xcassets\//.test(rel)
          ? "An asset catalog entry with this name still ships in the app."
          : "A file or folder with this name still exists in the project.",
    });
  }

  // (5) obfuscation
  for (const f of files) obfuscationSweep(f, needles, st);

  // (6) servers outside the repo
  const unverifiable = unverifiableCalls(ctx, files);

  // (4) input paths
  const sitesAll = aiSites(ctx);
  const sites = sitesAll.moderation;
  const blocking = blockingEvidence(spec, st, sites, sitesAll.sinks);
  const generationLeft = sitesAll.sinks.length > 0 || unverifiable.length > 0 || st.residue.some((r) => r.kind === "obfuscation");
  const gitRepo = await isGitRepo(ctx.root);
  const inputPaths: Verification["inputPaths"] = spec.inputPaths.map((p) => judgePath(ctx, p, p, blocking, generationLeft));
  for (const cp of spec.confirmedPaths) {
    const name = `${cp.source} → ${cp.sink}`;
    const byState: Record<RefState, string[]> = { present: [], gone: [], "line-only": [] };
    for (const ev of cp.evidence) byState[await refState(ctx.root, ev, opts.baseRef, gitRepo)].push(ev);
    const present = [...byState.present, ...byState["line-only"]];
    if (cp.evidence.length && !present.length) {
      inputPaths.push({ inputPath: name, blocked: true, evidence: [`Traced evidence is no longer in the tree: ${byState.gone.join("; ")}`] });
      continue;
    }
    const judged = judgePath(ctx, name, `${cp.source} → ${cp.sink}`, blocking, generationLeft, refsIn(ctx, present.join(" ")));
    if (byState["line-only"].length) {
      judged.evidence.unshift(
        `Traced evidence line still exists, content not checked: ${byState["line-only"].join("; ")}. Record it as "file:line: code on that line" (or pass base_ref) so verify can tell whether the code was removed.`,
      );
    }
    if (byState.present.length || !cp.evidence.length) judged.evidence.unshift(`Traced evidence still present: ${byState.present.join("; ") || "(none recorded)"}`);
    inputPaths.push(judged);
  }

  // The agent writes the spec; every input the scan detects is judged too, listed or not.
  const detectedMissing: string[] = [];
  if (generationLeft && sitesAll.sinks.length) {
    const seenSrc = new Set<string>();
    for (const src of sitesAll.sources) {
      const key = `${src.label}|${src.file}`;
      if (seenSrc.has(key) || specCovers(spec, src)) continue;
      seenSrc.add(key);
      const link = linkSource(ctx, src, sitesAll.sinks);
      const where = `${src.label} (${src.file}:${src.line})`;
      if (link.traced.length) {
        const at = [...new Set(link.traced.map((x) => `${x.file}:${x.line}`))].join(", ");
        inputPaths.push(judgePath(ctx, `${where} → AI generation (${at}) [detected; not in the spec]`, `${where} → AI generation (${at})`, blocking, generationLeft));
        detectedMissing.push(where);
      } else if (link.inferred.length) {
        const files = [...new Set(link.inferred.map((x) => x.file))];
        const j = judgePath(ctx, `${where} [detected; not in the spec; sink linkage inferred]`, `${where} → AI generation (${files.join(", ")})`, blocking, generationLeft);
        if (j.blocked) {
          inputPaths.push(j);
          detectedMissing.push(where);
        } else {
          unverifiable.push(
            `${where} is not in the spec. It shares a view or type with the generation call in ${files.join(", ")}, but no data flow from it to that call was found (sink linkage inferred). Trace it, and list it in inputPaths if it reaches a generator.`,
          );
        }
      }
    }
  }

  // (1) diff evidence
  let sha: string | undefined;
  let removedInDiff: string[] = [];
  let removedFilterLines = 0;
  let replacedInDiff = 0;
  let diffStat: string | undefined;
  let removedConditions: RemovedCondition[] = [];
  if (gitRepo) {
    sha = (await git(ctx.root, ["rev-parse", "HEAD"]))?.trim() || undefined;
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
          reason: `The line was changed, not removed: "${clip(r.before.trim(), 80)}" now reads "${clip(r.after.trim(), 80)}" ("${r.needle.value}" replaced by "${clip(r.replacement, 40)}"). Renaming does not remove a capability (2.5.19); remove what this line provides.`,
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
          reason: `${r.from} was renamed to ${r.to}, not deleted (git matched at least half of its content). Renaming does not remove a capability (2.5.19); remove what the file provides.`,
        });
      }
    }
  } else if (opts.baseRef) {
    notes.push("Diff evidence unavailable: the project is not a git repository.");
  }

  // built product
  let built: BuiltSweep | undefined;
  if (opts.builtProductPath) {
    try {
      built = await sweepBuiltProduct(opts.builtProductPath, spec);
      const filterTerms = new Set([...[...st.blocklists.values()].filter((b) => b.used).flatMap((b) => [...b.terms]), ...[...st.moderationKeys.values()].flatMap((t) => [...t])]);
      let skipped = 0;
      for (const h of built.matches) {
        if (h.kind === "term" && filterTerms.has(h.needle.toLowerCase())) {
          skipped++;
          continue;
        }
        pushHit(st, {
          kind: "binary",
          needle: h.needle,
          file: `${path.basename(opts.builtProductPath)}/${h.file}`,
          evidence: h.evidence,
          status: "PRESENT",
          confidence: "medium",
          reason: "Found in the built product; anything in the bundle can be reached or inspected after review.",
        });
      }
      if (skipped) built.notes.push(`${skipped} built-product matches were terms that also appear in a used blocklist or a moderation category check in the source, so they were not counted.`);
      built.hits = built.matches.length - skipped;
    } catch (e) {
      notes.push(`Built product sweep failed: ${(e as Error).message}`);
    }
  }

  // The spec is the agent's own; check it is valid and describes something this repo had.
  const validation = await validateSpec(ctx, spec);
  let neverExisted = false;
  if (gitRepo && needles.length && !st.residue.length && !st.excluded && !removedInDiff.length && !replacedInDiff) {
    let seen = false;
    for (const n of needles.slice(0, 8)) {
      const probe = n.kind === "asset" ? n.value.replace(/[*?].*$/, "") : n.value;
      if (probe.length >= 3 && (await inGitHistory(ctx.root, probe))) {
        seen = true;
        break;
      }
    }
    neverExisted = !seen;
  }
  // Which rejection this is for decides what the spec must answer to.
  const events = opts.ledgerEvents ?? (await repoLedgerEvents(root));
  const target = opts.rejectionText ? { open: [] as RejectionState[] } : rejectionsFor(events, spec, opts.rejectionId);
  const rejectionText = opts.rejectionText ?? target.single?.reviewerMessage;
  // A spec only counts toward clearing a rejection when it names something find_surface finds in
  // the pre-fix code; otherwise any made-up entry, once deleted, would read as a clean sweep.
  let grounding: Awaited<ReturnType<typeof specGrounding>> | undefined;
  const groundAgainst = rejectionText ? [{ text: rejectionText, at: target.single?.at }] : target.open.map((r) => ({ text: r.reviewerMessage!, at: r.at }));
  for (const g of groundAgainst) {
    const ref = gitRepo ? (opts.baseRef ?? (g.at ? await commitBefore(ctx.root, g.at) : undefined) ?? "HEAD") : undefined;
    const r = await specGrounding(ctx, spec, g.text, ref);
    if (!r.checked) continue;
    grounding = r;
    if (r.grounded) break;
  }
  // A rejection this run answers to whose message gives nothing to compare against cannot be
  // cleared by the spec either: without the tie, any deleted entry would read as the fix.
  const forRejection = opts.rejectionText !== undefined || opts.rejectionId !== undefined || !!target.single || target.open.length > 0;
  const unchecked = !grounding && forRejection;
  const ungrounded = (!!grounding && !grounding.grounded) || unchecked;

  // Lexicon terms from App Review's own message are swept even if the spec dropped them.
  const omitted = new Map<string, string[]>();
  if (rejectionText) {
    const have = new Set(spec.terms.map((t) => t.toLowerCase().trim()));
    const extra = termsFromRejection(rejectionText)
      .terms.filter((t) => !isContextTerm(t) && t.origin !== "quoted" && !have.has(t.term))
      .map((t) => makeNeedle("term", t.term))
      .filter((n): n is Needle => !!n);
    const side = newSweep();
    for (const f of files) sweepFile(ctx, f, extra, side);
    for (const h of side.residue) {
      if (h.status === "DEBUG_ONLY") continue;
      const at = omitted.get(h.needle) ?? [];
      if (at.length < 3) at.push(`${h.file}${h.line ? `:${h.line}` : ""}`);
      omitted.set(h.needle, at);
    }
  }

  // tier
  const residue = st.residue;
  const failing = residue.filter((r) => r.kind !== "obfuscation" && (r.status === "PRESENT" || r.status === "GATED" || r.status === "UNREFERENCED"));
  const openPaths = inputPaths.filter((p) => !p.blocked);
  const obfuscation = residue.filter((r) => r.kind === "obfuscation");
  let tier: EvidenceTier = failing.length || openPaths.length ? "RESIDUE_FOUND" : obfuscation.length || unverifiable.length ? "UNVERIFIABLE" : "STATIC_CLEAN";
  // The agent writes the spec it is checked against: an empty one must not read as a clean sweep.
  const nothingToSweep = !needles.length;
  const pathsMissing = !spec.inputPaths.length && !spec.confirmedPaths.length && sitesAll.sinks.length > 0 && sitesAll.sources.length > 0;
  // Without git history a removed entry looks the same as an invented one, so only the shape is checked there.
  const specProblems = gitRepo ? validation.problems : validation.problems.filter((x) => !/does not exist|past the end/.test(x));
  const specInvalid = specProblems.length > 0;
  const incomplete = nothingToSweep || pathsMissing || specInvalid || neverExisted || omitted.size > 0 || ungrounded;
  if (incomplete && tier === "STATIC_CLEAN") tier = "UNVERIFIABLE";
  const buildClean = !!built && built.hits === 0 && !built.encrypted && built.complete;
  if (tier === "STATIC_CLEAN" && buildClean) tier = "BUILD_CLEAN";
  const probe = opts.probe;
  const probePasses = !!probe && probe.total >= MIN_PROBES && probe.blocked === probe.total;
  // A results file is easy to write by hand, so it counts only once the developer confirms it in a terminal.
  const confirmedBy = probe ? probeConfirmation(events, probe.resultsHash) : undefined;
  if (probePasses && confirmedBy && (tier === "STATIC_CLEAN" || tier === "BUILD_CLEAN")) tier = "PROBED";

  // summary
  const count = (s: ResidueHit["status"]) => residue.filter((r) => r.kind !== "obfuscation" && r.status === s).length;
  const s: string[] = [];
  const fileCount = new Set(residue.filter((r) => r.kind !== "obfuscation").map((r) => r.file)).size;
  // RESIDUE_FOUND also covers an input path with no filter; say which, so it does not read as leftover code.
  if (tier === "RESIDUE_FOUND" && !failing.length && openPaths.length) {
    s.push(
      `Evidence tier: RESIDUE_FOUND (input path not blocked). No residue was found, but ${openPaths.length} input path${openPaths.length === 1 ? "" : "s"} can still reach the capability with no filter, first: ${openPaths[0]!.inputPath}.`,
    );
  } else {
    s.push(`Evidence tier: ${tierLabel({ tier, residue, inputPaths })}.`);
  }
  if (residue.length - obfuscation.length) {
    s.push(
      `The sweep found ${residue.length - obfuscation.length} residue matches in ${fileCount} files: ${count("PRESENT")} present, ${count("GATED")} behind a runtime switch, ${count("DEBUG_ONLY")} debug-only, ${count("UNREFERENCED")} in unreferenced code.`,
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
    // Named so the developer can check that each skipped list really refuses input.
    const lists = [...st.blocklists].map(([key, b]) => `${key.slice(key.indexOf("#") + 1)} (${b.file}:${b.line}; ${[...b.terms].slice(0, 6).join(", ")}${b.used ? "" : "; no membership test reads it"})`);
    s.push(`Lists treated as filters and not counted as residue: ${lists.slice(0, 6).join("; ")}${lists.length > 6 ? `; and ${lists.length - 6} more` : ""}.`);
  }
  if (st.moderationKeys.size) {
    // Named so the developer can check each one reads a moderation result rather than offering the content.
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
      `The diff from ${opts.baseRef} removed ${removedConditions.length} review-time condition${removedConditions.length === 1 ? "" : "s"} that changed what App Review saw: ${removedConditions
        .slice(0, 4)
        .map((c) => `${c.condition} at ${c.file}${c.line ? `:${c.line}` : ""} (${c.rule})`)
        .join("; ")}. Disclose each removal factually in the review notes (2.5.19).`,
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
      `The spec is not grounded in the rejection: none of its terms, symbols, assets or input-path files appear in the pre-fix code${grounding.ref ? ` (${grounding.ref.slice(0, 12)})` : ""} next to the terms find_surface derives from App Review's message (${grounding.terms.slice(0, 6).join(", ")}${grounding.terms.length > 6 ? ", …" : ""}). Removing entries that are not tied to the rejection proves nothing about it, so the tier is capped at UNVERIFIABLE and the open rejection stays on HOLD. Save a spec with entries find_surface found${opts.baseRef ? "" : " (pass base_ref: the commit before the fix)"}, or the developer can acknowledge the rejection with \`appstore-shield ack\` in a terminal.`,
    );
  } else if (unchecked) {
    const missing = !groundAgainst.some((g) => g.text?.trim());
    s.push(
      `The spec is not grounded in the rejection: App Review's message for it ${missing ? "is not recorded in the ledger" : "names nothing find_surface can search the pre-fix code for"}, so none of the spec's entries can be shown to be what was rejected. Removing entries that are not tied to the rejection proves nothing about it, so the tier is capped at UNVERIFIABLE and the open rejection stays on HOLD. Import App Review's full message (shield_ledger_import) and verify again, or the developer can acknowledge the rejection with \`appstore-shield ack\` in a terminal.`,
    );
  } else if (grounding?.grounded && grounding.via) {
    s.push(`The spec is tied to the rejection: ${grounding.via}.`);
  }
  if (neverExisted) s.push("Nothing the spec names appears in the repo now, in the diff, or anywhere in its git history, so the spec does not describe this app's feature; the tier is capped at UNVERIFIABLE.");
  if (omitted.size) {
    s.push(
      `The spec leaves out terms from App Review's message that still appear in shipping code: ${[...omitted].slice(0, 6).map(([t, at]) => `${t} (${at.join(", ")})`).join("; ")}. The tier is capped at UNVERIFIABLE until the spec includes them.`,
    );
  }
  if (probe) {
    const verdict = probePasses ? "" : probe.total < MIN_PROBES ? `; at least ${MIN_PROBES} prompts, all blocked, are needed for PROBED` : "; every prompt must be blocked for PROBED";
    s.push(
      confirmedBy
        ? `The developer states (confirmed in ${confirmedBy}) that their probe run blocked ${probe.blocked} of ${probe.total} prompts${verdict}. Probe results cover only the prompts tried.`
        : `Probe results supplied to the tool mark ${probe.blocked} of ${probe.total} prompts blocked${verdict}. They are not counted until the developer confirms them in a terminal: \`appstore-shield attest --statement "my own probe run produced results ${probe.resultsHash.slice(0, 12)}"\`. Probe results cover only the prompts tried.`,
    );
  }
  if (spec.metadataSurfaces.length) {
    // Repo files the sweep read are reported as checked; only what lives in App Store Connect needs a look.
    const swept = new Set(files.map((f) => f.path));
    const inRepo = (surface: string) => {
      const p = /^[\w@+.-][\w@+./-]*/.exec(surface.trim())?.[0]?.replace(/^\.\//, "").replace(/\/$/, "");
      return !!p && p.includes("/") && (swept.has(p) || files.some((f) => f.path.startsWith(`${p}/`)));
    };
    const checked = spec.metadataSurfaces.filter(inRepo);
    const outside = spec.metadataSurfaces.filter((x) => !inRepo(x));
    if (checked.length) s.push(`Store metadata files in the repo were swept with the code: ${checked.slice(0, 6).join(", ")}${checked.length > 6 ? `, and ${checked.length - 6} more` : ""}.`);
    s.push(
      `Confirm the live App Store Connect copy, screenshots and previews match the repo metadata${outside.length ? `; these surfaces are not in the repo and were not checked: ${outside.slice(0, 6).join(", ")}${outside.length > 6 ? `, and ${outside.length - 6} more` : ""}` : ""}.`,
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
    ...(removedConditions.length ? { removedConditions } : {}),
    residue,
    inputPaths,
    unverifiable,
    builtProduct: built ? { path: built.path, kind: built.kind, hermes: built.hermes, hits: built.hits, notes: built.notes } : undefined,
    probe,
    summary: s.join(" "),
  };
}


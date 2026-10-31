import type { Check, CheckResult } from "../checks.js";
import { finding, type Finding } from "../finding.js";
import { searchFile, type ScanContext, type SourceFile } from "../project.js";
import { DOWNLOADED_PATH, JS_NETWORK, NATIVE_HOTPATCH, NATIVE_NETWORK, OTA_PACKAGES, SERVER_PATH } from "../rules/gating.js";
import { blankStrings, enclosingBraces } from "../scope.js";
import { productFiles } from "./genaiSafety.js";
import { debugOnlyAt, isCodeFile } from "./reviewGating.js";

export interface OtaProvider {
  provider: string;
  /** files that declare or configure it */
  sources: string[];
  enabled: boolean;
  updatesUrl?: string;
  runtimeVersion?: string;
  channels?: string[];
  checkAutomatically?: string;
  /** call sites that fetch or apply updates */
  usage: { file: string; line: number }[];
}

export interface OtaData {
  present: boolean;
  providers: OtaProvider[];
  /** `vendored`: found in a minified or vendored bundle, where the evaluated text is most likely generated locally */
  remoteCode: { file: string; line: number; kind: string; evidence: string; vendored?: true }[];
  nativeHotpatch: { file: string; line: number; evidence: string }[];
}

const JS_EXTS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs"]);
const NATIVE_EXTS = new Set(["swift", "m", "mm", "h"]);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function str(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  const o = obj(v);
  if (o && typeof o.policy === "string") return `policy:${o.policy}`;
  return undefined;
}

function upsert(map: Map<string, OtaProvider>, provider: string, source: string): OtaProvider {
  const cur = map.get(provider) ?? { provider, sources: [], enabled: true, usage: [] };
  if (!cur.sources.includes(source)) cur.sources.push(source);
  map.set(provider, cur);
  return cur;
}

function file(ctx: ScanContext, rel: string | undefined): SourceFile | undefined {
  return rel ? ctx.files.find((f) => f.path === rel) : undefined;
}

function detectProviders(ctx: ScanContext): Map<string, OtaProvider> {
  const out = new Map<string, OtaProvider>();

  const pkgPath = ctx.project.packageJson ?? "package.json";
  const pkg = obj(parseJson(file(ctx, pkgPath)?.text ?? ""));
  if (pkg) {
    const deps = { ...obj(pkg.dependencies), ...obj(pkg.devDependencies) };
    for (const name of Object.keys(deps)) {
      const p = OTA_PACKAGES[name];
      if (p) upsert(out, p, pkgPath);
    }
  }

  // Expo config: app.json (static) or app.config.* (regex, it is code).
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

  // Bare React Native with expo-updates configures it in Expo.plist.
  for (const f of ctx.files.filter((x) => x.path.endsWith("Expo.plist"))) {
    const url = /<key>EXUpdatesURL<\/key>\s*<string>([^<]+)<\/string>/.exec(f.text)?.[1];
    if (!url && !out.has(expo)) continue;
    const p = upsert(out, expo, f.path);
    if (url) p.updatesUrl ??= url;
    if (/<key>EXUpdatesEnabled<\/key>\s*<false\s*\/>/.test(f.text)) p.enabled = false;
    const rv = /<key>EXUpdatesRuntimeVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(f.text)?.[1];
    if (rv) p.runtimeVersion ??= rv;
  }

  // In a monorepo EAS is configured beside the app, not at the repo root.
  const easPath = ctx.files.some((f) => f.path === `${ctx.project.appRoot}/eas.json`) ? `${ctx.project.appRoot}/eas.json` : "eas.json";
  const eas = obj(parseJson(ctx.files.find((f) => f.path === easPath)?.text ?? ""));
  if (eas && out.has(expo)) {
    const channels = new Set<string>();
    for (const profile of Object.values(obj(eas.build) ?? {})) {
      const ch = obj(profile)?.channel;
      if (typeof ch === "string") channels.add(ch);
    }
    const p = out.get(expo)!;
    if (channels.size) p.channels = [...channels];
    if (!p.sources.includes(easPath)) p.sources.push(easPath);
  }

  for (const f of ctx.files.filter((x) => x.path.split("/").pop() === "Info.plist")) {
    if (/<key>CodePushDeploymentKey<\/key>/.test(f.text)) upsert(out, "CodePush", f.path);
  }
  for (const f of ctx.files.filter((x) => x.path.split("/").pop() === "shorebird.yaml")) upsert(out, "Shorebird", f.path);

  const USAGE: [string, RegExp][] = [
    [expo, /\bUpdates\.(?:checkForUpdateAsync|fetchUpdateAsync|reloadAsync)\b|\buseUpdates\(\)/],
    ["CodePush", /\bcodePush\s*\(|\b[Cc]odePush\.sync\(/],
    ["Pushy (react-native-update)", /\b(?:checkUpdate|downloadUpdate|switchVersion(?:Later)?)\(|\bPushyProvider\b/],
    ["hot-updater", /\bHotUpdater\.(?:wrap|checkForUpdate|runUpdateProcess)\b/],
  ];
  for (const f of ctx.files.filter((x) => JS_EXTS.has(x.ext))) {
    for (const [provider, rx] of USAGE) {
      const p = out.get(provider);
      if (!p) continue;
      for (const h of searchFile(f, rx)) p.usage.push({ file: f.path, line: h.line });
    }
  }
  return out;
}

/** Arguments of the call whose `(` is at `open`. */
function callArgs(code: string, open: number): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = open + 1;
  for (let k = open; k < code.length && k < open + 2000; k++) {
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

function firstArg(code: string, open: number): string {
  return callArgs(code, open)[0] ?? "";
}

const MAX_SCOPE = 20_000;
const CONTROL_HEADER = /^(?:\}\s*)?(?:else|if|for|while|switch|catch|do|try|guard|repeat|defer|finally|with)\b/;
const CONTINUES_LINE = /(?:[(,=.&|?:+\-*/<[]|=>)$/;
const CONTINUED_LINE = /^(?:\.|\?\.|&&|\|\||\?|:|\))/;

/**
 * Start of the statement that ends at `open` (a `{`): back past balanced brackets to the
 * previous `;`, unmatched `{`, `}` or a line break that ends a finished statement.
 */
function statementStart(masked: string, open: number): number {
  let depth = 0;
  const floor = Math.max(0, open - 2000);
  for (let k = open - 1; k >= floor; k--) {
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
      const next = masked.slice(k + 1, open).trimStart();
      if (!CONTINUES_LINE.test(prev) && !CONTINUED_LINE.test(next)) return k + 1;
    }
  }
  return floor;
}

/**
 * The code a call at `index` can see being assigned: the enclosing function from its header up
 * to the call, or, at top level, the preceding top-level statements with every block cut out.
 * A text window of nearby lines is not enough: in a minified bundle it is the whole file, and a
 * `const e = await fetch(u)` in one function would vouch for an unrelated `e` in another.
 */
function scopeBefore(f: SourceFile, masked: string, index: number): string {
  let b = enclosingBraces(f.code, f.ext, index);
  for (let levels = 0; b && levels < 64; levels++) {
    const start = statementStart(masked, b.open);
    // A bundle wraps everything in one function; past MAX_SCOPE chars the text is another module's.
    if (!CONTROL_HEADER.test(masked.slice(start, b.open).trim())) return f.code.slice(Math.max(start, index - MAX_SCOPE), index);
    b = enclosingBraces(f.code, f.ext, b.open);
  }
  const lineStart = (n: number) => {
    let at = index;
    for (let i = 0; i < n && at > 0; i++) at = f.code.lastIndexOf("\n", at - 1);
    return Math.max(0, at);
  };
  const from = Math.max(lineStart(30), index - 4000);
  let kept = "";
  let depth = 0;
  for (let k = from; k < index; k++) {
    const ch = masked[k];
    if (ch === "{") depth++;
    else if (ch === "}") {
      // An unmatched `}` closes a block the window started inside; nothing before it is top level.
      if (depth === 0) kept = "";
      else depth--;
    } else if (depth === 0) kept += f.code[k];
  }
  return kept;
}

/**
 * Minified or vendored bundles (`pdf.worker.min.js`) build functions from text they generate
 * themselves; the scan cannot tell that from downloaded code with any confidence.
 */
function isVendoredBundle(f: SourceFile): boolean {
  if (/\.min\.[cm]?js$|(^|\/)(vendor|vendors|third[-_]?party)\//i.test(f.path)) return true;
  if (/\/\/[#@] sourceMappingURL=/.test(f.text.slice(-4096))) return true;
  let start = 0;
  for (let nl = f.text.indexOf("\n"); ; nl = f.text.indexOf("\n", start)) {
    const end = nl === -1 ? f.text.length : nl;
    if (end - start > 2000) return true;
    if (nl === -1) return false;
    start = nl + 1;
  }
}

const LITERAL_ONLY = /^(["'`])[^"'`]*\1$|^@?"[^"]*"$|^(?:NULL|nil|null|RTLD_\w+)$/;

/** True when the evaluated text plausibly arrived over the network rather than from the bundle. */
function fromNetwork(arg: string, window: string, network: RegExp, js: boolean): boolean {
  if (!arg || LITERAL_ONLY.test(arg)) return false;
  if (/Bundle\.main|mainBundle|pathForResource|url\(forResource|require\(/.test(arg)) return false;
  if (network.test(arg)) return true;
  if (!network.test(window)) return false;
  const id = /^[\s(]*(?:await\s+)?(?:try\s+)?([A-Za-z_$][\w$]*)/.exec(arg)?.[1];
  if (!id) return false;
  const e = id.replace(/\$/g, "\\$");
  const assigned = js
    ? new RegExp(`\\b${e}\\s*=\\s*[^;\\n]*(?:fetch|axios|\\.text\\(\\)|\\.data\\b|response|res\\.|await|readAsStringAsync|readFile|download)|then\\(\\s*\\(?\\s*${e}\\s*\\)?\\s*=>`)
    : new RegExp(`\\b${e}\\s*=\\s*[^\\n]*(?:String\\(data:|String\\(contentsOf:|NSString\\(data:|initWithData:|data|response|download)|\\(\\s*${e}\\s*,`);
  return assigned.test(window);
}

function remoteCode(ctx: ScanContext): OtaData["remoteCode"] {
  const out: OtaData["remoteCode"] = [];
  // productFiles leaves out a sibling web app (apps/web beside apps/mobile) and dev-only paths:
  // neither is the binary App Review installs.
  for (const f of productFiles(ctx).filter(isCodeFile)) {
    // Server code is not shipped in the app; 2.5.2 is about the binary.
    if (SERVER_PATH.test(f.path)) continue;
    let masked: string | undefined;
    const scope = (index: number) => scopeBefore(f, (masked ??= blankStrings(f.code, f.ext)), index);
    let vendored: boolean | undefined;
    const push = (r: Omit<OtaData["remoteCode"][number], "file" | "vendored">) => out.push({ file: f.path, ...r, ...((vendored ??= isVendoredBundle(f)) ? { vendored: true } : {}) });
    if (JS_EXTS.has(f.ext)) {
      for (const h of searchFile(f, /\b(?:eval|new\s+Function|Function)\s*\(/)) {
        if (debugOnlyAt(f, h.index)) continue;
        // `new Function(a, b, body)` takes the code last; eval takes it first.
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
          const arg = h.match.endsWith("(") ? firstArg(f.code, h.index + h.match.length - 1) : (/^([^\]\s]+)/.exec(f.code.slice(h.index + h.match.length))?.[1] ?? "");
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

export const check: Check = {
  id: "ota_updates",
  title: "Over-the-air updates and downloaded code",
  guidelines: ["2.5.2", "2.5.19", "DPLA 3.2(e)"],
  async run(ctx: ScanContext): Promise<CheckResult> {
    const findings: Finding[] = [];
    const providers = [...detectProviders(ctx).values()];
    const rc = remoteCode(ctx);
    const hotpatch: OtaData["nativeHotpatch"] = [];
    for (const f of ctx.files.filter((x) => isCodeFile(x) || x.path.split("/").pop() === "Podfile" || x.path.endsWith("Package.resolved") || x.path.endsWith("Package.swift"))) {
      for (const h of searchFile(f, NATIVE_HOTPATCH)) hotpatch.push({ file: f.path, line: h.line, evidence: h.text });
    }

    for (const p of providers.filter((x) => x.enabled)) {
      const details = [p.updatesUrl && `update URL ${p.updatesUrl}`, p.runtimeVersion && `runtimeVersion ${p.runtimeVersion}`, p.channels?.length && `channels ${p.channels.join(", ")}`]
        .filter(Boolean)
        .join("; ");
      findings.push(
        finding({
          rule: "ota_updates.present",
          severity: "info",
          guideline: "2.5.2",
          file: p.sources[0],
          evidence: `${p.provider}${details ? ` (${details})` : ""}`,
          why: `The app can receive over-the-air JavaScript/asset updates via ${p.provider}. Apple allows downloaded code only when it does not add or change features or the app's purpose (2.5.2), and 2.5.19 / DPLA 3.2(e) treat post-review changes as concealment when they are not disclosed. Each OTA publish is drift from the approved build.`,
          fix: `Disclose the OTA mechanism (${p.provider}) in Notes for Review; describe its scope only as the developer's statement. Record each publish in the ledger so drift against the last approved snapshot can be checked. An OTA update may only fix bugs (2.5.2); ship any feature or content change in a build that goes through App Review.`,
          confidence: "high",
        }),
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
            confidence: "low",
          }),
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
          suppressible: false,
        }),
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
          suppressible: false,
        }),
      );
    }

    const data: OtaData = { present: providers.some((p) => p.enabled) || rc.length > 0 || hotpatch.length > 0, providers, remoteCode: rc, nativeHotpatch: hotpatch };
    return { findings, data: { ota: data } };
  },
};

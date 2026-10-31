import type { Check, CheckResult } from "../checks.js";
import { clip, finding, type Confidence, type Finding } from "../finding.js";
import type { RemoteControl } from "../ledger/schema.js";
import { searchFile, type ScanContext, type SourceFile } from "../project.js";
import { NON_SHIPPING_PATH } from "../rules/store.js";
import {
  ALWAYS_CONFIG_HOSTS,
  CONFIG_COLLECTION,
  CONFIG_PATH,
  CONFIG_TABLE,
  CUSTOM_CONFIG_URL,
  FLAG_READS,
  QUOTED_KEY,
  KILL_WORDS,
  STATIC_ASSET_PATH,
  PRICE_KEY_WORDS,
  PROVIDER_IMPORTS,
  SINKS,
  classifySinks,
  describeSinks,
  wordsOf,
  type SinkKind,
} from "../rules/gating.js";
import { debugOnlyAt, expandScope, isCodeFile, trace, type TraceResult } from "./reviewGating.js";

type Classification = RemoteControl["classification"];

export interface RemoteControlEntry extends RemoteControl {
  readSites: { file: string; line: number }[];
  /** how the classification was reached: traced scope, value use, or key name only */
  basis: "scope" | "use" | "name" | "none";
}

interface Read {
  provider: string;
  key: string;
  file: SourceFile;
  index: number;
  line: number;
  text: string;
  defaultValue?: string;
  paywall?: boolean;
  /** custom sources: follow further, the value usually passes through a fetch helper */
  depth: number;
}

const RANK: Record<Classification, number> = {
  "content-gating": 0,
  "price-gating": 1,
  "safety-killswitch": 2,
  product: 3,
  unknown: 4,
};

function resolveProvider(p: string | string[], file: SourceFile): string | undefined {
  if (typeof p === "string") return p;
  for (const name of p) if (PROVIDER_IMPORTS[name]?.test(file.code)) return name;
  return undefined;
}

function cleanDefault(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const t = v.trim().replace(/\s+as\s+NSObject$/, "").replace(/^["'`]|["'`]$/g, "");
  return t ? clip(t, 80) : undefined;
}

/** A provider read whose key is a parameter: `function useFlag(key) { … getValue(key) … }`. */
const PARAM_READ = (param: string) =>
  new RegExp(
    `(?:getValue|getBoolean|getString|getNumber|configValue\\(\\s*forKey:|Variation\\(\\s*(?:forKey:\\s*)?|\\.variation|isFeatureEnabled|getFeatureFlag|checkGate|useGate|isOn|getFeatureValue|isEnabled|getValueAsync)\\(?\\s*${param}\\b|\\[\\s*${param}\\s*\\]\\s*\\.(?:bool|string|number|json|data)Value`,
  );
const FUNC_WITH_PARAM = [
  /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)/g,
  /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(\s*([A-Za-z_$][\w$]*)/g,
  /\bfunc\s+([A-Za-z_]\w*)\s*\(\s*(?:_\s+)?([A-Za-z_]\w*)\s*:/g,
];

/** Project-local helpers that wrap a provider, so `useFeatureFlag("x")` is attributed to Firebase. */
function findWrappers(ctx: ScanContext): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of ctx.files.filter(isCodeFile)) {
    const provider = Object.entries(PROVIDER_IMPORTS).find(([, rx]) => rx.test(file.code))?.[0];
    if (!provider) continue;
    for (const rx of FUNC_WITH_PARAM) {
      for (const m of file.code.matchAll(rx)) {
        const [, name, param] = m;
        if (!name || !param) continue;
        const body = file.code.slice(m.index ?? 0, (m.index ?? 0) + 1200);
        if (PARAM_READ(param.replace(/\$/g, "\\$")).test(body)) out.set(name, provider);
      }
    }
  }
  return out;
}

function collectReads(ctx: ScanContext): Read[] {
  const reads: Read[] = [];
  const seen = new Set<string>();
  const push = (r: Read) => {
    const k = `${r.file.path}:${r.index}`;
    if (seen.has(k)) return;
    seen.add(k);
    reads.push(r);
  };

  const wrappers = findWrappers(ctx);
  // Debug menus, scripts, stories and mocks never reach App Review, so a flag read there gates nothing in the build.
  const shipping = ctx.files.filter((f) => isCodeFile(f) && !NON_SHIPPING_PATH.test(f.path));
  for (const file of shipping) {
    for (const [name, provider] of wrappers) {
      for (const h of searchFile(file, new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}\\(\\s*${QUOTED_KEY}`))) {
        push({ provider, key: h.groups[0] ?? "", file, index: h.index, line: h.line, text: h.text, depth: 2 });
      }
    }
  }
  for (const file of shipping) {
    for (const pat of FLAG_READS) {
      if (pat.requires && !pat.requires.test(file.code)) continue;
      const hits = searchFile(file, pat.rx);
      if (!hits.length) continue;
      const provider = resolveProvider(pat.provider, file) ?? "Feature flag (provider not identified)";
      for (const h of hits) {
        const key = pat.keyGroup > 0 ? h.groups[pat.keyGroup - 1] ?? "" : "paywall";
        if (!key) continue;
        push({
          provider,
          key,
          file,
          index: h.index,
          line: h.line,
          text: h.text,
          defaultValue: pat.defaultGroup ? cleanDefault(h.groups[pat.defaultGroup - 1]) : undefined,
          paywall: pat.paywall,
          depth: 2,
        });
      }
    }

    for (const h of searchFile(file, CUSTOM_CONFIG_URL)) {
      const url = h.groups[0] ?? "";
      if (!isConfigUrl(url)) continue;
      const host = /^https?:\/\/([^/]+)/.exec(url)?.[1] ?? "custom";
      push({ provider: `Custom JSON (${host})`, key: url, file, index: h.index, line: h.line, text: h.text, depth: 4 });
    }
    for (const h of searchFile(file, CONFIG_TABLE))
      push({ provider: "Custom config (Supabase table)", key: h.groups[0] ?? "config", file, index: h.index, line: h.line, text: h.text, depth: 4 });
    for (const h of searchFile(file, CONFIG_COLLECTION))
      push({ provider: "Custom config (Firestore collection)", key: h.groups[0] ?? "config", file, index: h.index, line: h.line, text: h.text, depth: 4 });
  }
  return reads;
}

/**
 * True when a fetched URL can carry configuration. Static assets never can. On hosts that
 * mostly serve config (raw GitHub, gists), a directory base URL or a path made only of
 * interpolated parts is a generic file downloader (acknowledgements, a dataset mirror), so
 * it counts only when the path itself names config.
 */
export function isConfigUrl(url: string): boolean {
  const pathPart = url.replace(/^https?:\/\/[^/]+/, "");
  if (STATIC_ASSET_PATH.test(pathPart)) return false;
  if (CONFIG_PATH.test(pathPart)) return true;
  if (!ALWAYS_CONFIG_HOSTS.test(url)) return false;
  const last = pathPart.replace(/[?#].*$/, "").split("/").pop() ?? "";
  // Gist "latest revision" URLs end in `/raw` or `/raw/`.
  if (/\/raw\/?$/.test(pathPart.replace(/[?#].*$/, ""))) return true;
  return last !== "" && !/\\\(|\$\{|\{\{/.test(last);
}

/** Firebase defaults from setDefaults(fromPlist:), setDefaults([...]) / setDefaults({...}) and defaultConfig = {...}. */
function firebaseDefaults(ctx: ScanContext): Map<string, string> {
  const out = new Map<string, string>();
  const plists = new Set<string>();
  for (const file of ctx.files.filter(isCodeFile)) {
    for (const h of searchFile(file, /setDefaults\(\s*fromPlist:\s*"([^"]+)"/)) plists.add(h.groups[0] ?? "");
    const literals: string[] = [];
    for (const h of searchFile(file, /(?:setDefaults\(\s*|defaultConfig\s*=\s*)([[{])/)) {
      const open = h.index + h.match.length - 1;
      const close = file.code.indexOf(h.groups[0] === "[" ? "]" : "}", open);
      if (close >= 0) literals.push(file.code.slice(open + 1, close));
    }
    // setDefaults(DEFAULTS) with `const DEFAULTS = { … }` in the same file.
    for (const h of searchFile(file, /(?:setDefaults\(\s*|defaultConfig\s*=\s*)([A-Za-z_$][\w$]*)\s*\)?/)) {
      const decl = new RegExp(`(?:const|let|var)\\s+${(h.groups[0] ?? "").replace(/\$/g, "\\$")}\\b[^=]*=\\s*([[{])`).exec(file.code);
      if (!decl) continue;
      const open = decl.index + decl[0].length - 1;
      const close = file.code.indexOf(decl[1] === "[" ? "]" : "}", open);
      if (close >= 0) literals.push(file.code.slice(open + 1, close));
    }
    for (const body of literals) {
      for (const m of body.matchAll(/["'`]?([A-Za-z_][\w.-]*)["'`]?\s*:\s*([^,\n]+)/g)) {
        const v = cleanDefault(m[2]);
        if (m[1] && v !== undefined) out.set(m[1], v);
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

const CONTENT: SinkKind[] = ["adult", "persona", "generator"];

interface Classified {
  classification: Classification;
  gates: string;
  basis: RemoteControlEntry["basis"];
  confidence: Confidence;
  at?: { file: string; line: number; evidence: string };
  /** the traced scope or value use shows adult or nudification content */
  adult?: boolean;
}

function classify(ctx: ScanContext, read: Read, t: TraceResult): Classified {
  const scopeText = t.sites.map((s) => expandScope(ctx, s.file, s.site.body)).join("\n");
  const headerText = t.sites.map((s) => s.site.header).join("\n");
  // The key's own name is not behavior; only what the code does with the value is.
  const useText = t.uses.map((u) => u.text.split(read.key).join(" ")).join("\n");
  const scope = classifySinks(scopeText);
  const use = classifySinks(useText);
  const kill = KILL_WORDS.test(wordsOf(`${read.key} ${headerText}`));
  const firstSite = t.sites[0];
  const at = firstSite
    ? { file: firstSite.file.path, line: firstSite.site.line, evidence: firstSite.site.header }
    : t.uses[0]
      ? { file: t.uses[0].file.path, line: t.uses[0].line, evidence: t.uses[0].text }
      : undefined;
  const where = at ? ` at ${at.file}:${at.line}` : "";

  for (const [profile, basis] of [
    [scope, "scope"],
    [use, "use"],
  ] as const) {
    const has = (k: SinkKind) => profile.kinds.includes(k);
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

  // Nothing traced: fall back to what the key itself says, at low confidence.
  const kw = wordsOf(read.key);
  if (SINKS.adult.test(kw) || SINKS.persona.test(kw))
    return { classification: "content-gating", gates: "key name refers to adult or persona content; read site not traced to its use", basis: "name", confidence: "low" };
  if (/\b(price|pricing|paywall|trial|discount|promo|sku|iap|subscription)\b/.test(kw) && PRICE_KEY_WORDS.test(kw))
    return { classification: "price-gating", gates: "key name refers to pricing or the paywall; read site not traced to its use", basis: "name", confidence: "low" };
  return { classification: "unknown", gates: "read site not traced to its use", basis: "none", confidence: "low" };
}

export const TRACE_BUDGET_PER_FILE = 1024 * 1024;

function untraced(c: Classified): Classified {
  return { ...c, gates: c.gates.replace(/read site not traced to its use$/, "read site not traced: the file exceeds the per-file trace budget") };
}

/** For custom JSON, the interesting keys are the fields read off the fetched object. */
function subKeys(t: TraceResult): Map<string, TraceResult> {
  const out = new Map<string, TraceResult>();
  if (!t.names.length) return out;
  const names = t.names.map((n) => n.replace(/[$]/g, "\\$")).join("|");
  const rx = new RegExp(`\\b(?:${names})\\??\\.(?!then\\b|json\\b|text\\b|ok\\b|status\\b|data\\b)([A-Za-z_]\\w*)|\\b(?:${names})\\s*\\[\\s*["'\`]([^"'\`]+)["'\`]\\s*\\]`, "g");
  const add = (key: string, part: Partial<TraceResult>) => {
    const cur = out.get(key) ?? { sites: [], uses: [], names: t.names };
    cur.sites.push(...(part.sites ?? []));
    cur.uses.push(...(part.uses ?? []));
    out.set(key, cur);
  };
  for (const s of t.sites) for (const m of s.site.header.matchAll(rx)) add(m[1] ?? m[2] ?? "", { sites: [s] });
  for (const u of t.uses) for (const m of u.text.matchAll(rx)) add(m[1] ?? m[2] ?? "", { uses: [u] });
  out.delete("");
  return out;
}

export const check: Check = {
  id: "remote_config",
  title: "Remote config and feature flags",
  guidelines: ["2.5.19", "2.3.1(a)", "DPLA 3.2(e)", "3.1.2"],
  async run(ctx: ScanContext): Promise<CheckResult> {
    const defaults = firebaseDefaults(ctx);
    const entries = new Map<string, RemoteControlEntry>();
    const findings: Finding[] = [];
    // The strongest finding per key and classification; read order must not decide severity.
    const flagged = new Map<string, number>();

    const record = (read: Read, key: string, c: Classified) => {
      const id = `${read.provider}\u0000${key}`;
      const defaultValue = read.defaultValue ?? (read.provider === "Firebase Remote Config" ? defaults.get(key) : undefined);
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
          basis: c.basis,
        });
      } else {
        if (!cur.readSites.some((s) => s.file === site.file && s.line === site.line)) cur.readSites.push(site);
        cur.defaultValue ??= defaultValue;
        if (RANK[c.classification] < RANK[cur.classification] || (c.adult === true && c.classification === cur.classification)) {
          cur.classification = c.classification;
          cur.gates = c.gates;
          cur.basis = c.basis;
        }
      }
      const flagKey = `${id}\u0000${c.classification}`;
      const prior = flagged.get(flagKey);
      const content = c.classification === "content-gating";
      // A server switch that turns adult content on is the pattern behind 3.2(f)
      // terminations; it can only be fixed by deleting the switch and the content.
      const adult = content && c.adult === true;
      const upgrade = prior !== undefined && adult && findings[prior]!.severity !== "block";
      if ((c.classification === "content-gating" || c.classification === "price-gating") && (prior === undefined || upgrade)) {
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
          fix: adult
            ? "Delete the flag and the adult or nudification content it gates. Content App Review rejects under 1.1 must not ship behind a server switch, so disclosing the flag does not fix it (2.5.19, DPLA 3.2(e))."
            : "Remove the remote switch, or disclose it specifically in Notes for Review (2.3.1(a), 2.5.19).",
          confidence: c.confidence,
          suppressible: !adult,
        });
      }
    };

    // Characters of traced scope per file. In malformed code with unclosed brackets every
    // read's scope runs to the end of the file, so tracing each one costs the file's size;
    // past the budget a read is classified by its key name alone, at low confidence.
    const spent = new Map<string, number>();
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

    const byProvider = new Map<string, RemoteControlEntry[]>();
    for (const e of inventory) {
      if (e.classification === "content-gating" || e.classification === "price-gating") continue;
      byProvider.set(e.provider, [...(byProvider.get(e.provider) ?? []), e]);
    }
    for (const [provider, list] of byProvider) {
      const first = list[0]!;
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
          confidence: "medium",
        }),
      );
    }

    return { findings, data: { inventory } };
  },
};

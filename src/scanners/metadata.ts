import { createHash } from "node:crypto";
import type { Check } from "../checks.js";
import { finding, type Finding } from "../finding.js";
import type { MetadataSnapshot } from "../ledger/schema.js";
import type { ScanContext, SourceFile } from "../project.js";
import { UGC_DISPLAY } from "../rules/genai.js";
import {
  AI_CONTEXT,
  AMBIGUOUS_BRANDS,
  BRANDS,
  CONTENT_SIGNAL_CLAIMS,
  FREE_WORD,
  METADATA_LIMITS,
  PLACEHOLDER_PURPOSE,
  PRICE_IN_TEXT,
  SHORT_FIELD_CLAIMS,
  STRONG_CLAIMS,
  asDict,
  charLength,
  escapeRx,
  isGenericPurpose,
  lineIndex,
  parsePlist,
  plistKeyLine,
  utf8Bytes,
} from "../rules/store.js";
import { analyzeAiSurface, isCode, productFiles } from "./genaiSafety.js";

export type MetadataField =
  | "name"
  | "subtitle"
  | "keywords"
  | "promotionalText"
  | "description"
  | "whatsNew"
  | "displayName"
  | "bundleName"
  | "usageDescription";

export interface MetadataText {
  /** repo-relative path */
  file: string;
  field: MetadataField;
  locale: string;
  text: string;
  line?: number;
  /** Info.plist key or expo plugin option for usage descriptions, e.g. NSCameraUsageDescription */
  key?: string;
  /** "store" = App Store Connect listing text; "bundle" = text shipped inside the app */
  surface: "store" | "bundle";
}

const FASTLANE_FILES: Record<string, MetadataField> = {
  "name.txt": "name",
  "subtitle.txt": "subtitle",
  "keywords.txt": "keywords",
  "promotional_text.txt": "promotionalText",
  "description.txt": "description",
  "release_notes.txt": "whatsNew",
};
const ASC_APP_INFO = /^metadata\/app-info\/([^/]+)\.json$/;
const ASC_VERSION = /^metadata\/version\/([^/]+)\/([^/]+)\.json$/;
const FASTLANE = /^fastlane\/metadata\/([^/]+)\/([a-z_]+\.txt)$/;
const USAGE_KEY = /^NS\w+UsageDescription$/;

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

function jsonLine(f: SourceFile, key: string): number | undefined {
  const i = f.text.indexOf(`"${key}"`);
  return i === -1 ? undefined : lineIndex(f.text)(i);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function strOf(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function isBuildVariable(s: string): boolean {
  return /^\s*\$[({][A-Z_]+[)}]\s*$/.test(s);
}

/**
 * Every piece of store-listing and bundle-identity text the repo controls: asc canonical
 * metadata (latest version only), fastlane metadata, Info.plist / InfoPlist.strings,
 * generated INFOPLIST_KEY_* build settings, and the Expo config. Remediation sweeps use
 * this to find residue of a removed feature in store text.
 */
export function metadataTexts(ctx: ScanContext): MetadataText[] {
  const out: MetadataText[] = [];
  const push = (t: MetadataText) => {
    if (t.text.trim() === "" && t.field !== "usageDescription") return;
    out.push(t);
  };

  // asc canonical layout: metadata/app-info/<locale>.json + metadata/version/<version>/<locale>.json
  const versions = [...new Set(ctx.files.map((f) => ASC_VERSION.exec(f.path)?.[1]).filter((v): v is string => !!v))];
  const latest = versions.sort(compareVersions).at(-1);
  for (const f of ctx.files) {
    const info = ASC_APP_INFO.exec(f.path);
    const ver = ASC_VERSION.exec(f.path);
    if (!info && !(ver && ver[1] === latest)) continue;
    const locale = (info ? info[1] : ver?.[2]) ?? "default";
    const obj = safeJson(f.text);
    if (!obj || typeof obj !== "object") continue;
    const rec = obj as Record<string, unknown>;
    const fields: MetadataField[] = info ? ["name", "subtitle"] : ["description", "keywords", "promotionalText", "whatsNew"];
    for (const field of fields) {
      const text = strOf(rec[field]);
      if (text !== undefined) push({ file: f.path, field, locale, text, line: jsonLine(f, field), surface: "store" });
    }
  }

  // fastlane/metadata/<locale>/<field>.txt
  for (const f of ctx.files) {
    const m = FASTLANE.exec(f.path);
    if (!m) continue;
    const field = FASTLANE_FILES[m[2] ?? ""];
    if (!field || m[1] === "review_information" || m[1] === "trade_representative_contact_information") continue;
    push({ file: f.path, field, locale: m[1] ?? "default", text: f.text.trimEnd(), line: 1, surface: "store" });
  }

  // Info.plist and InfoPlist.strings
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
      const seen = new Set<string>();
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

  // Expo config
  const expoPath = ctx.project.expoConfig;
  const expo = expoPath ? ctx.files.find((f) => f.path === expoPath) : undefined;
  if (expo) {
    const at = lineIndex(expo.text);
    const lineOfText = (needle: string) => {
      const i = expo.text.indexOf(needle);
      return i === -1 ? undefined : at(i);
    };
    if (expo.ext === "json") {
      const root = safeJson(expo.text) as Record<string, unknown> | undefined;
      const cfg = (root && typeof root.expo === "object" ? root.expo : root) as Record<string, unknown> | undefined;
      const name = strOf(cfg?.name);
      if (name) push({ file: expo.path, field: "displayName", locale: "default", text: name, line: lineOfText(`"name"`), surface: "bundle" });
      const ios = cfg?.ios as Record<string, unknown> | undefined;
      const plist = ios?.infoPlist as Record<string, unknown> | undefined;
      for (const [key, v] of Object.entries(plist ?? {})) {
        const text = strOf(v);
        if (text === undefined) continue;
        if (USAGE_KEY.test(key)) push({ file: expo.path, field: "usageDescription", key, locale: "default", text, line: lineOfText(`"${key}"`), surface: "bundle" });
        else if (key === "CFBundleDisplayName") push({ file: expo.path, field: "displayName", locale: "default", text, line: lineOfText(`"${key}"`), surface: "bundle" });
      }
      for (const p of Array.isArray(cfg?.plugins) ? (cfg.plugins as unknown[]) : []) {
        if (!Array.isArray(p) || typeof p[0] !== "string" || !p[1] || typeof p[1] !== "object") continue;
        for (const [opt, v] of Object.entries(p[1] as Record<string, unknown>)) {
          const text = strOf(v);
          if (text === undefined || !/Permission$|UsageDescription$/.test(opt)) continue;
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

function brandHits(text: string): string[] {
  const hits: string[] = [];
  for (const b of BRANDS) if (new RegExp(`(?<![\\w])${escapeRx(b)}(?![\\w])`, "i").test(text)) hits.push(b);
  if (AI_CONTEXT.test(text)) {
    for (const b of AMBIGUOUS_BRANDS) if (new RegExp(`(?<![\\w])${escapeRx(b)}(?![\\w])`, "i").test(text)) hits.push(b);
  }
  return hits;
}

const FIELD_LABEL: Record<MetadataField, string> = {
  name: "app name",
  subtitle: "subtitle",
  keywords: "keywords",
  promotionalText: "promotional text",
  description: "description",
  whatsNew: "What's New",
  displayName: "home-screen display name",
  bundleName: "bundle name",
  usageDescription: "permission purpose string",
};

function limitFindings(t: MetadataText): Finding[] {
  const out: Finding[] = [];
  const at = { file: t.file, line: t.line, evidence: `${t.field} [${t.locale}]: ${t.text}` };
  const over = (what: string, n: number, max: number, unit: string) =>
    finding({
      rule: "metadata.field_limit",
      severity: "high",
      guideline: "2.3.7",
      ...at,
      why: `The ${what} for ${t.locale} is ${n} ${unit}; App Store Connect allows ${max}. The listing cannot be saved or will be truncated.`,
      fix: `Remove words until the ${what} is at most ${max} ${unit}.`,
      confidence: "high",
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
          fix: "Use the app's full name (2–30 characters).",
          confidence: "high",
        }),
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
          confidence: "low",
        }),
      );
  }
  if (t.field === "promotionalText" && chars > METADATA_LIMITS.promotionalText)
    out.push(over("promotional text", chars, METADATA_LIMITS.promotionalText, "characters"));
  if (t.field === "description" && chars > METADATA_LIMITS.description) out.push(over("description", chars, METADATA_LIMITS.description, "characters"));
  if (t.field === "whatsNew" && chars > METADATA_LIMITS.whatsNew) out.push(over("What's New text", chars, METADATA_LIMITS.whatsNew, "characters"));
  return out;
}

function contentFindings(t: MetadataText, contentApp: () => boolean): Finding[] {
  const out: Finding[] = [];
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
          confidence: "medium",
        }),
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
          confidence: "high",
        }),
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
          confidence: "medium",
        }),
      );
    }
  }
  if (t.surface === "store" || t.field === "displayName") {
    const signal = CONTENT_SIGNAL_CLAIMS.exec(t.text);
    const strong = signal ? null : STRONG_CLAIMS.exec(t.text);
    const short = t.field === "name" || t.field === "subtitle" || t.field === "promotionalText" || t.field === "displayName" ? SHORT_FIELD_CLAIMS.exec(t.text) : null;
    const claim = strong ?? short;
    if (signal) {
      // An app that generates or hosts content is exactly what such words advertise; 1.1/1.2 review follows.
      const showsContent = contentApp();
      out.push(
        finding({
          rule: "metadata.content_signal_claim",
          severity: showsContent ? "high" : "medium",
          guideline: `${t.field === "subtitle" || t.field === "name" ? "2.3.7" : "2.3.14"}, 1.1, 1.2`,
          ...at,
          why: `The ${label} advertises "${signal[0]}" content${showsContent ? " in an app that shows AI-generated or user-generated content" : ""}. Store text must describe what the app actually does (2.3 accurate metadata; 2.3.7 and 2.3.14 bar unverifiable claims), so this word is either a promise of objectionable material, which 1.1 and 1.2 bar, or an inaccurate claim.`,
          fix: `Remove "${signal[0]}" from the ${label} in every locale and store surface (name, subtitle, keywords, promotional text, description, screenshots) so the store text describes what the app actually does. If the app can produce or show that content, first remove or filter the capability itself (see the genai_safety and ugc_safeguards findings, and any backend outside this repo): changing the listing alone while the output stays unfiltered is a cosmetic change.`,
          confidence: "high",
        }),
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
          confidence: strong ? "high" : "medium",
        }),
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
          why: placeholder
            ? `The ${t.key ?? "permission"} purpose string is empty or a placeholder. Apple rejects permission prompts that do not explain why the data is needed (5.1.1).`
            : `The ${t.key ?? "permission"} purpose string names the resource but not why the app needs it. 5.1.1 requires purpose strings that clearly and completely describe the use of the data.`,
          fix: "Disclose the specific use in the purpose string, e.g. \"Used to scan receipts you choose to add\"; remove the key if the app no longer uses the permission.",
          confidence: placeholder ? "high" : "medium",
        }),
      );
    }
  }
  return out;
}

/** Same test ugc_safeguards uses for "applies": AI generation outside platform guardrails, or multi-user content. */
function showsGeneratedOrUserContent(ctx: ScanContext): boolean {
  const s = analyzeAiSurface(ctx);
  if (s.hasGenerator && !s.platformGuardedOnly) return true;
  return productFiles(ctx).some((f) => isCode(f) && UGC_DISPLAY.some((rx) => rx.test(f.code)));
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function metadataSnapshots(texts: MetadataText[]): MetadataSnapshot[] {
  const groups = new Map<string, { snap: MetadataSnapshot; sources: Set<string> }>();
  for (const t of texts) {
    if (t.field === "usageDescription" || t.field === "bundleName") continue;
    const storeRoot = t.surface === "store" ? (t.file.startsWith("fastlane/") ? "fastlane" : "asc") : t.file;
    const key = `${storeRoot}|${t.locale}`;
    let g = groups.get(key);
    if (!g) {
      g = { snap: { locale: t.locale, source: "" }, sources: new Set() };
      groups.set(key, g);
    }
    g.sources.add(t.file);
    if (t.field === "description") g.snap.descriptionHash = sha256(t.text);
    else if (t.field === "whatsNew") continue;
    else g.snap[t.field] = t.text;
  }
  return [...groups.values()].map((g) => ({ ...g.snap, source: [...g.sources].sort().join(" + ") }));
}

export const check: Check = {
  id: "metadata",
  title: "Store metadata and bundle text",
  guidelines: ["1.1", "1.2", "2.3.7", "2.3.8", "2.3.14", "4.1(c)", "5.1.1", "DPLA 3.2(f)"],
  async run(ctx: ScanContext) {
    const texts = metadataTexts(ctx);
    const findings: Finding[] = [];
    let shows: boolean | undefined;
    const contentApp = () => (shows ??= showsGeneratedOrUserContent(ctx));
    for (const t of texts) {
      if (t.surface === "store") findings.push(...limitFindings(t));
      findings.push(...contentFindings(t, contentApp));
    }
    return {
      findings,
      data: {
        snapshots: metadataSnapshots(texts),
        sources: [...new Set(texts.map((t) => t.file))].sort(),
      },
    };
  },
};

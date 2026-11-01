import type { Check } from "../checks.js";
import { finding, type Finding } from "../finding.js";
import type { ScanContext, SourceFile } from "../project.js";
import { enclosingConditions } from "../scope.js";
import {
  REQUIRED_REASON_APIS,
  TRACKING_SDKS,
  NON_SHIPPING_PATH,
  asDict,
  lineIndex,
  parsePlist,
  ships,
  type PlistValue,
} from "../rules/store.js";

export interface ManifestDeclarations {
  files: string[];
  tracking: boolean;
  trackingDomains: string[];
  /** category → declared reason codes */
  accessed: Map<string, string[]>;
}

function readArray(v: PlistValue | undefined): PlistValue[] {
  return Array.isArray(v) ? v : [];
}

function addDeclarations(decl: ManifestDeclarations, root: Record<string, PlistValue | unknown> | undefined): void {
  if (!root) return;
  if (root.NSPrivacyTracking === true) decl.tracking = true;
  for (const d of readArray(root.NSPrivacyTrackingDomains as PlistValue)) if (typeof d === "string" && d.trim()) decl.trackingDomains.push(d);
  for (const entry of readArray(root.NSPrivacyAccessedAPITypes as PlistValue)) {
    const e = asDict(entry);
    const type = e?.NSPrivacyAccessedAPIType;
    if (typeof type !== "string") continue;
    const reasons = readArray(e?.NSPrivacyAccessedAPITypeReasons).filter((r): r is string => typeof r === "string");
    decl.accessed.set(type, [...(decl.accessed.get(type) ?? []), ...reasons]);
  }
}

/** A committed SDK bundle's manifest covers that SDK, not the app target. */
const VENDOR_BUNDLE = /(^|\/)[^/]+\.(bundle|framework|xcframework)\//;

/** Declarations from every PrivacyInfo.xcprivacy in the repo plus Expo's `ios.privacyManifests`. */
export function readDeclarations(ctx: ScanContext): ManifestDeclarations & { expoConfigured: boolean } {
  const decl: ManifestDeclarations = { files: [], tracking: false, trackingDomains: [], accessed: new Map() };
  for (const f of ctx.files) {
    if (!f.path.endsWith("PrivacyInfo.xcprivacy") || VENDOR_BUNDLE.test(f.path)) continue;
    decl.files.push(f.path);
    addDeclarations(decl, asDict(parsePlist(f.text)));
  }
  let expoConfigured = false;
  const expo = ctx.project.expoConfig ? ctx.files.find((f) => f.path === ctx.project.expoConfig) : undefined;
  if (expo && /\bprivacyManifests\b/.test(expo.code)) {
    expoConfigured = true;
    decl.files.push(expo.path);
    let parsed = false;
    if (expo.ext === "json") {
      try {
        const root = JSON.parse(expo.text) as Record<string, unknown>;
        const cfg = (root.expo ?? root) as Record<string, unknown>;
        const pm = (cfg.ios as Record<string, unknown> | undefined)?.privacyManifests as Record<string, unknown> | undefined;
        addDeclarations(decl, pm);
        parsed = true;
      } catch {
        parsed = false;
      }
    }
    if (!parsed) {
      // app.config.ts: read the declarations textually; good enough to know what is declared.
      if (/NSPrivacyTracking["']?\s*:\s*true/.test(expo.code)) decl.tracking = true;
      for (const m of expo.code.matchAll(/(NSPrivacyAccessedAPICategory\w+)[\s\S]{0,200}?NSPrivacyAccessedAPITypeReasons["']?\s*:\s*\[([^\]]*)\]/g)) {
        const reasons = [...(m[2] ?? "").matchAll(/["']([0-9A-F]{4}\.\d)["']/g)].map((r) => r[1] ?? "");
        decl.accessed.set(m[1] ?? "", [...(decl.accessed.get(m[1] ?? "") ?? []), ...reasons]);
      }
      const domains = /NSPrivacyTrackingDomains["']?\s*:\s*\[([^\]]*)\]/.exec(expo.code);
      for (const d of (domains?.[1] ?? "").matchAll(/["']([^"']+)["']/g)) decl.trackingDomains.push(d[1] ?? "");
    }
  }
  return { ...decl, expoConfigured };
}

const NON_APP_PROJECT = /(^|\/)(examples?|samples?|demos?|tests?|playgrounds?)(\/|$)|(Tests?|Example|Demo|Sample)s?\.xcodeproj\//i;

/** The app target's project: an application product type outside example/test folders, shallowest first. */
function appProject(ctx: ScanContext): SourceFile | undefined {
  let best: SourceFile | undefined;
  let bestScore = -Infinity;
  for (const f of ctx.files) {
    if (!f.path.endsWith(".xcodeproj/project.pbxproj")) continue;
    const score =
      (/com\.apple\.product-type\.application["';]/.test(f.code) ? 100 : 0) -
      (NON_APP_PROJECT.test(f.path) ? 200 : 0) -
      f.path.split("/").length;
    if (score > bestScore) {
      best = f;
      bestScore = score;
    }
  }
  return best;
}

function anchorFile(ctx: ScanContext): { file?: string; line?: number } {
  const pbx = appProject(ctx);
  if (pbx) return { file: pbx.path };
  if (ctx.project.expoConfig) return { file: ctx.project.expoConfig };
  if (ctx.project.packageJson) return { file: ctx.project.packageJson };
  const swift = ctx.files.find((f) => f.ext === "swift");
  return swift ? { file: swift.path } : {};
}

/** The folder of a Mac-only target in a multi-platform repo: `macOS/`, `DuckDuckGo-macOS/`, `App OSX/`. */
const MAC_TREE = /^((?:[^/]*\/)*?[^/]*(?:macOS|MacOS|macos|OSX)[^/]*)\//;
const IOS_WORD = /iOS|ios|iPhone|iPad|Shared|Common|Multiplatform/;
const APPKIT_IMPORT = /^[ \t]*import\s+(?:AppKit|Cocoa)\b/m;
const UIKIT_IMPORT = /^[ \t]*import\s+(?:UIKit|WatchKit|TVUIKit)\b/m;

/**
 * Code that cannot be part of the iOS binary: a file in a Mac-only folder that has no privacy
 * manifest of its own, or a Swift file that imports AppKit unconditionally (it would not compile
 * for iOS). Its required-reason API use belongs to the Mac app, not to the iOS app's manifest.
 */
export function macOnly(f: SourceFile, manifests: string[]): boolean {
  const tree = MAC_TREE.exec(f.path)?.[1];
  const treeName = tree?.slice(tree.lastIndexOf("/") + 1) ?? "";
  if (tree && !IOS_WORD.test(treeName) && !manifests.some((m) => m.startsWith(`${tree}/`))) return true;
  if (f.ext !== "swift" || UIKIT_IMPORT.test(f.code)) return false;
  const m = APPKIT_IMPORT.exec(f.code);
  return m !== null && !enclosingConditions(f.code, m.index + m[0].length - 1, f.ext).conditions.some((c) => c.kind === "#if");
}

const dependencyFile = (ctx: ScanContext, f: SourceFile) =>
  f.path === "package.json" ||
  f.path === ctx.project.packageJson ||
  /(^|\/)(Podfile|Package\.resolved|Package\.swift)$/.test(f.path);

export const check: Check = {
  id: "privacy_manifest",
  title: "Privacy manifest",
  guidelines: ["5.1.1", "5.1.2"],
  async run(ctx: ScanContext) {
    const findings: Finding[] = [];
    const platforms = ctx.project.platforms;
    if (!platforms.some((p) => p === "swift" || p === "react-native" || p === "expo")) {
      return { findings, data: { applicable: false } };
    }
    const decl = readDeclarations(ctx);
    const hasManifest = decl.files.length > 0;

    const missing = (needed: boolean): Finding => {
      // In a monorepo the native project, when one exists, sits under the app root, not the repo root.
      const prefix = ctx.project.appRoot ? `${ctx.project.appRoot}/` : "";
      const managedExpo = platforms.includes("expo") && !ctx.files.some((f) => f.path.startsWith(`${prefix}ios/`));
      return finding({
        rule: "privacy_manifest.missing",
        severity: needed ? "medium" : "info",
        guideline: "5.1.1",
        ...anchorFile(ctx),
        why: (managedExpo
          ? "No privacy manifest is configured: there is no PrivacyInfo.xcprivacy and no `ios.privacyManifests` in the Expo config. Apps must declare collected data and required-reason API use in a privacy manifest; App Store Connect may flag or reject uploads (ITMS-91053) that use required-reason APIs without one."
          : "No PrivacyInfo.xcprivacy was found for the app target. Apps must declare collected data, tracking and required-reason API use in a privacy manifest; App Store Connect may flag or reject uploads (ITMS-91053) that use required-reason APIs without one.") +
          (needed ? "" : " No required-reason API use or tracking SDK was found in the app's code, so the manifest is advisory until the app or an SDK adds one."),
        fix: managedExpo
          ? "Add `ios.privacyManifests` to the Expo config disclosing the app's tracking status, collected data types and required-reason API categories with reason codes."
          : "Add a PrivacyInfo.xcprivacy to the app target that discloses NSPrivacyTracking, NSPrivacyCollectedDataTypes and NSPrivacyAccessedAPITypes with reason codes.",
        confidence: managedExpo ? "low" : "medium",
      });
    };

    // Required-reason APIs used by the app's own code.
    const used: { category: string; label: string; file: string; line: number }[] = [];
    const reported = new Set<string>();
    for (const api of REQUIRED_REASON_APIS) {
      if (reported.has(api.category)) continue;
      const exts = new Set(api.exts);
      let hit: { f: SourceFile; index: number } | undefined;
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
            confidence: "medium",
          }),
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
            why:
              declared.length === 0
                ? `${api.category} is declared without any reason code.`
                : `${api.category} lists reason code(s) that are not valid for it: ${invalid.join(", ")}.`,
            fix: `Disclose the accurate reason: use only the approved codes for ${api.category} (${codes}) that match how the app uses it.`,
            confidence: "high",
          }),
        );
      }
    }

    // Tracking SDKs vs NSPrivacyTracking.
    const tracking: { name: string; file: string; line: number }[] = [];
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
          confidence: "low",
        }),
      );
    }
    if (!hasManifest) {
      // ITMS-91053 is about required-reason APIs and listed SDKs. React Native, Expo, Capacitor
      // and Cordova use required-reason APIs themselves; a Swift app with neither does not need a manifest yet.
      const jsFramework =
        platforms.some((p) => p === "react-native" || p === "expo") ||
        ctx.files.some((f) => /(^|\/)package\.json$/.test(f.path) && /"(?:@capacitor\/(?:ios|core)|cordova-ios)"\s*:/.test(f.text));
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
          confidence: "high",
        }),
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
        trackingSdks: tracking,
      },
    };
  },
};

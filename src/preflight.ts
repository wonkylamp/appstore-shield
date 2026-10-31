import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import path from "node:path";
import { applyBaseline, loadBaseline } from "./baseline.js";
import type { CheckId } from "./checks.js";
import { countBySeverity, dedupeFindings, sortFindings, type Finding, type Severity } from "./finding.js";
import { gateCoverageWarnings, toolRef } from "./format.js";
import { diffSinceApproved, buildSnapshots, stableHash, type DriftReport, type SnapshotInput } from "./ledger/drift.js";
import type { DisclosureInventory } from "./ledger/evidence.js";
import { MetadataSnapshot, RemoteControl, type EventSource, type LedgerEvent, type LedgerState } from "./ledger/schema.js";
import { appendEvent, loadState, locateLedger, type InvalidLine, type LedgerLocation } from "./ledger/store.js";
import { gateDecision, refreshHighFindingsWarning, rejectionAppliesTo, rejectionsToResweep, resweepFromVerification, triggerChecklist, type GateDecision, type ResweepResult, type TriggerItem } from "./ledger/triggers.js";
import { appRootNotes, loadContext, unreadShippingFiles, type AppRootInfo, type Platform, type ScanContext } from "./project.js";
import { sweepBuiltProduct } from "./remediation/built.js";
import { verifyRemediation } from "./remediation/verify.js";
import { getChecks } from "./scanners/index.js";

// ------------------------------------------------------------------ app detection

const SKIP_DIRS = new Set(["node_modules", "Pods", "build", "DerivedData", "dist", "vendor", "Carthage"]);

/**
 * Whether `root` holds an iOS, SwiftUI or React Native/Expo project, looking a few levels deep
 * and at a bounded number of entries, so pointing a tool at a home directory or $TMPDIR is
 * refused at once instead of walking the whole tree.
 */
export function looksLikeApp(root: string): boolean {
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  let budget = 5000;
  while (queue.length && budget > 0) {
    const { dir, depth } = queue.shift()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (--budget <= 0) break;
      const n = e.name;
      if (n.endsWith(".xcodeproj") || n.endsWith(".xcworkspace") || n === "Package.swift" || n.endsWith(".swift")) return true;
      // A monorepo keeps its React Native / Expo app one or two folders down (apps/mobile), and
      // the scan finds it there, so a manifest that deep counts too.
      if (depth <= 2 && (n === "package.json" || /^app\.(json|config\.(ts|js|mjs|cjs))$/.test(n))) {
        try {
          // Regular files only, capped: a FIFO named package.json would hang the gate.
          const file = path.join(dir, n);
          const st = statSync(file);
          if (st.isFile() && st.size <= 1024 * 1024 && /"(react-native|expo)"\s*:/.test(readFileSync(file, "utf8"))) return true;
        } catch {
          // unreadable manifest: keep looking
        }
      }
      if (e.isDirectory() && depth < 3 && !n.startsWith(".") && !SKIP_DIRS.has(n)) queue.push({ dir: path.join(dir, n), depth: depth + 1 });
    }
  }
  return false;
}

export function noAppMessage(root: string, override: string): string {
  return `no iOS, SwiftUI or React Native/Expo project found in ${root} (no .xcodeproj, .xcworkspace, Package.swift, .swift files, or react-native/expo in package.json or app.json). Pass the app repo root, or ${override} to use this directory anyway.`;
}

/** A gate verdict on a directory that is not an app would vouch for code it never saw. */
export class NoAppProjectError extends Error {
  constructor(root: string, override = "pass force: true") {
    super(noAppMessage(root, override));
    this.name = "NoAppProjectError";
  }
}

// ------------------------------------------------------------------ scan

export interface CheckRun {
  id: CheckId;
  title: string;
  guidelines: string[];
  findings: number;
  data?: Record<string, unknown>;
  /** set when the scanner threw; the rest of the scan still ran */
  error?: string;
}

export interface ScanRun {
  ctx: ScanContext;
  root: string;
  platforms: Platform[];
  filesScanned: number;
  checks: CheckRun[];
  /** after baseline suppressions, deduped, most severe first */
  findings: Finding[];
  counts: Record<Severity, number>;
  suppressed: { finding: Finding; justification: string }[];
  refusedSuppressions: { finding: Finding; justification: string }[];
  baselineProblems: string[];
  /** what the scan did not read; shown so a partial scan never reads as a clean one */
  coverage: ScanCoverage;
}

export interface ScanCoverage {
  /** a file-count or byte budget stopped the scan before every file was read */
  truncated: boolean;
  /** text files left unread because of the budget (lower bound when the walk itself stopped) */
  notRead: number;
  /** files over the per-file size cap */
  tooLarge: string[];
  /** linked git worktrees inside the project that were not scanned */
  excludedWorktrees: string[];
  /** files that ship in the app (code, plists, assets config, store metadata) but were not read */
  unreadShipping: string[];
  /** every app found in the repo, scanned or not */
  appRoots: AppRootInfo[];
  /** which apps were scanned, `appPaths` problems, and how to narrow a monorepo scan */
  appNotes: string[];
}

export function coverageOf(ctx: ScanContext): ScanCoverage {
  const skipped = ctx.skipped ?? [];
  const budget = skipped.filter((s) => s.reason === "budget");
  return {
    truncated: budget.length > 0,
    notRead: budget.reduce((n, s) => n + (s.remaining ?? 0), 0),
    tooLarge: skipped.filter((s) => s.reason === "too-large").map((s) => s.path),
    excludedWorktrees: ctx.excludedWorktrees ?? [],
    unreadShipping: unreadShippingFiles(ctx).map((s) => s.path),
    appRoots: ctx.project?.appRoots ?? [],
    appNotes: ctx.project?.appRoots ? appRootNotes(ctx.project) : [],
  };
}

export interface ScanOptions {
  checks?: CheckId[];
  paths?: string[];
  includeTests?: boolean;
}

export async function runScan(root: string, opts: ScanOptions = {}): Promise<ScanRun> {
  const ctx = await loadContext(root, { paths: opts.paths, includeTests: opts.includeTests });
  const runs: CheckRun[] = [];
  const all: Finding[] = [];
  for (const c of getChecks(opts.checks)) {
    try {
      const r = await c.run(ctx);
      all.push(...r.findings);
      runs.push({ id: c.id, title: c.title, guidelines: c.guidelines, findings: r.findings.length, data: r.data });
    } catch (e) {
      runs.push({ id: c.id, title: c.title, guidelines: c.guidelines, findings: 0, error: (e as Error).message });
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
    coverage: coverageOf(ctx),
  };
}

export function checkData(scan: ScanRun, id: CheckId): Record<string, unknown> | undefined {
  return scan.checks.find((c) => c.id === id)?.data;
}

/** remote_config inventory, validated against the shared RemoteControl contract (extra fields stripped). */
export function remoteControlsOf(scan: ScanRun): RemoteControl[] | undefined {
  const inv = checkData(scan, "remote_config")?.inventory;
  if (!Array.isArray(inv)) return undefined;
  return inv.flatMap((x) => {
    const p = RemoteControl.safeParse(x);
    return p.success ? [p.data] : [];
  });
}

interface OtaProviderLike {
  provider?: string;
  updatesUrl?: string;
  runtimeVersion?: string;
  channels?: string[];
}

/** What the review notes must disclose, as found in the repo. */
export function disclosureInventory(scan: ScanRun): DisclosureInventory {
  const ota = checkData(scan, "ota_updates")?.ota as { providers?: OtaProviderLike[] } | undefined;
  const surface = checkData(scan, "genai_safety")?.surface as
    | { providers?: { name?: string; kind?: string; evidence?: { file: string; line: number }[] }[] }
    | undefined;
  const remote = (surface?.providers ?? []).filter((p) => p.kind !== "on-device" && p.name);
  const aiServices = [...new Set(remote.map((p) => String(p.name)))];
  // Call sites let a false "nothing leaves the device" claim be checked against the code.
  const aiSinks = remote.flatMap((p) => (p.evidence ?? []).slice(0, 3).map((e) => ({ provider: String(p.name), file: e.file, line: e.line })));
  return {
    remoteControls: remoteControlsOf(scan),
    ota: (ota?.providers ?? []).map((p) => ({
      provider: String(p.provider ?? "OTA"),
      detail: [p.updatesUrl && `updates ${p.updatesUrl}`, p.runtimeVersion && `runtime ${p.runtimeVersion}`, p.channels?.length && `channels ${p.channels.join(", ")}`]
        .filter(Boolean)
        .join("; ") || undefined,
    })),
    aiServices,
    aiSinks,
  };
}

/** Bundle id from the Xcode project or Expo config, when it is a literal. */
export function detectBundleId(ctx: ScanContext): string | undefined {
  const literal = (s: string | undefined) => (s && /^[A-Za-z0-9.-]+\.[A-Za-z0-9-]+$/.test(s) ? s : undefined);
  const ids: string[] = [];
  for (const f of ctx.files.filter((x) => x.ext === "pbxproj")) {
    for (const m of f.text.matchAll(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*"?([^";\s]+)"?;/g)) {
      const id = literal(m[1]);
      // Test targets are named "<App>Tests", "<app>UITests" or "integration-tests" in the last segment.
      if (!id || /tests?$/i.test(id.split(".").at(-1)!)) continue;
      if (/\.(widget|extension|share|notification|intents?|watchkit\w*)$/i.test(id)) continue;
      ids.push(id);
    }
  }
  // Extension targets reuse the app id as a prefix; the shortest literal is the app.
  if (ids.length) return ids.reduce((a, b) => (b.length < a.length ? b : a));
  const expo = ctx.project.expoConfig ? ctx.files.find((f) => f.path === ctx.project.expoConfig) : undefined;
  if (expo?.ext === "json") {
    try {
      const j = JSON.parse(expo.text) as { expo?: { ios?: { bundleIdentifier?: string } }; ios?: { bundleIdentifier?: string } };
      return literal(j.expo?.ios?.bundleIdentifier ?? j.ios?.bundleIdentifier);
    } catch {
      return undefined;
    }
  }
  return literal(/bundleIdentifier\s*:\s*["']([^"']+)["']/.exec(expo?.text ?? "")?.[1]);
}

// ------------------------------------------------------------------ preflight

export interface ManualItem {
  id: string;
  item: string;
  guideline: string;
}

export interface OpenRejection {
  id: string;
  at: string;
  bundleId?: string;
  outcome: string;
  guidelines: string[];
  tier?: string;
  acked: boolean;
  hasInterpretation: boolean;
  hasSpec: boolean;
}

export interface BuiltProductReport {
  rejectionId: string;
  hits?: number;
  encrypted?: boolean;
  complete?: boolean;
  notes: string[];
  matches: { needle: string; file: string; evidence: string }[];
  error?: string;
}

export interface PreflightOptions {
  buildPath?: string;
  recordSubmission?: { version: string; build: string; bundleId?: string };
  /** append snapshot events (default true); the gate and hook pass false */
  record?: boolean;
  /** who is recording; MCP = "agent", hook = "hook", CLI = "human", CI = "ci" */
  source: EventSource;
  /** throw NoAppProjectError, before the ledger is located or written, when no platform is detected */
  requirePlatform?: boolean;
  now?: string;
}

export interface PreflightResult {
  root: string;
  platforms: Platform[];
  bundleId?: string;
  ledger: { teamId: string; teamIdSource: string; path: string; warnings: string[]; invalidLines: InvalidLine[] };
  gate: GateDecision;
  triggers: TriggerItem[];
  drift: DriftReport;
  openRejections: OpenRejection[];
  manualChecklist: ManualItem[];
  inventory: DisclosureInventory;
  builtProduct?: BuiltProductReport[];
  /** the scan's coverage at top level, so JSON output (which drops the scan) still says what was not read */
  coverage: ScanCoverage;
  recorded: { snapshotEvents: string[]; metadataEventId?: string; submissionEventId?: string };
  scan: ScanRun;
  state: LedgerState;
  location: LedgerLocation;
}

function gitHead(root: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", ["-C", root, "rev-parse", "HEAD"], { timeout: 5_000 }, (err, stdout) => {
      resolve(err ? undefined : stdout.trim() || undefined);
    });
  });
}

export function openRejections(state: LedgerState): OpenRejection[] {
  return state.rejections
    .filter((r) => !r.approvedBy)
    .map((r) => ({
      id: r.id,
      at: r.at,
      bundleId: r.bundleId,
      outcome: r.outcome,
      guidelines: r.guidelines,
      tier: r.verification?.tier,
      acked: r.acked,
      hasInterpretation: Boolean(r.interpretation),
      hasSpec: Boolean(r.spec),
    }));
}

function blockedRemoteKey(c: RemoteControl, findings: Finding[]): boolean {
  return findings.some(
    (f) =>
      f.rule === "remote_config.content_gating" &&
      f.severity === "block" &&
      (f.why.includes(`key "${c.key}"`) || (f.file !== undefined && f.file === c.file && f.line === c.line)),
  );
}

export function manualChecklist(inv: DisclosureInventory, scan: ScanRun, state: LedgerState): ManualItem[] {
  const items: ManualItem[] = [
    {
      id: "demo_account",
      item: "If the app has a login, give App Review a working demo account that will not expire during review, with any content it needs already loaded.",
      guideline: "2.1(a)",
    },
    {
      id: "expired_subscription_account",
      item: "If features depend on a subscription, say in the notes how a reviewer can see both subscribed and expired or not-subscribed states (e.g. a second demo account).",
      guideline: "2.1(a), 3.1.2",
    },
    {
      id: "two_factor",
      item: "If sign-in needs 2FA, an OTP or a hardware device, explain in the notes exactly how a reviewer gets past it.",
      guideline: "2.1(a)",
    },
    {
      id: "notes_specificity",
      item: `Notes for Review describe what changed in this build with specificity, not 'bug fixes and improvements', and stay under 4000 bytes. Lint them with ${toolRef("shield_lint_text")}.`,
      guideline: "2.3.1(a)",
    },
  ];
  // A key a block finding says must be deleted cannot be cured by disclosure, so it is never listed as "disclose".
  const mustDelete = new Set((inv.remoteControls ?? []).filter((c) => blockedRemoteKey(c, scan.findings)).map((c) => c.key));
  const disclose = (inv.remoteControls ?? []).filter((c) => !mustDelete.has(c.key));
  const sensitive = disclose.filter((c) => c.classification === "content-gating" || c.classification === "price-gating");
  if (mustDelete.size) {
    items.push({
      id: "delete_remote_switch",
      item: `Delete ${[...mustDelete].slice(0, 5).join(", ")} and the content it gates (block finding remote_config.content_gating); disclosing it does not fix it.`,
      guideline: "2.5.19, DPLA 3.2(e)",
    });
  }
  if (disclose.length) {
    items.push({
      id: "disclose_remote_config",
      item: `Disclose ${mustDelete.size ? "the remaining " : ""}remote configuration in the notes: ${disclose.length} key(s)${sensitive.length ? `, including ${sensitive.map((c) => c.key).slice(0, 5).join(", ")} that change content or price` : ""}.`,
      guideline: "2.5.19, 2.3.1(a)",
    });
  }
  if (inv.ota?.length) {
    items.push({
      id: "disclose_ota",
      item: `Disclose over-the-air updates (${inv.ota.map((o) => o.provider).join(", ")}) and what they are used for; any promise about their future scope is the developer's own statement (2.5.2 limits what they may change).`,
      guideline: "2.5.2, 2.5.19",
    });
  }
  if (inv.aiServices?.length) {
    items.push({
      id: "disclose_ai",
      item: `Disclose the third-party AI services the app sends user data to (${inv.aiServices.join(", ")}) and the moderation that runs on input and output.`,
      guideline: "5.1.2(i), 1.2",
    });
  }
  if (state.rejections.some((r) => !r.approvedBy)) {
    items.push({
      id: "address_open_rejection",
      item: "The notes name the open rejection and describe, at capability level, what was removed on every input path, without claiming more than the verification tier supports.",
      guideline: "2.3.1(a), 1.2",
    });
  }
  if (scan.findings.some((f) => f.rule.startsWith("review_gating.region_legal"))) {
    items.push({ id: "disclose_storefront_gates", item: "Disclose storefront or region-specific behavior and the legal reason for it.", guideline: "2.5.19" });
  }
  return items;
}

// 4.7.1 asks chatbots and plug-ins for the same filter/report/block safeguards as 1.2 UGC.
const GUIDELINE_ALIASES: Record<string, string[]> = { "4.7": ["1.2"], "4.7.1": ["1.2"] };

/** True when a finding's guideline is the cited one or a subsection of it ("1.2" covers "1.2.1(a)"). */
export function guidelineWithin(findingGuideline: string, cited: string): boolean {
  const c = cited.trim();
  if (!c) return false;
  const targets = [c, ...(GUIDELINE_ALIASES[c] ?? [])];
  return findingGuideline
    .split(/[,;]\s*/)
    .map((g) => g.trim())
    .some((g) => targets.some((t) => g === t || g.startsWith(`${t}.`) || g.startsWith(`${t}(`)));
}

/**
 * An open rejection names the guideline Apple will check again. A high finding under that same
 * guideline (e.g. no report mechanism after a 1.2 rejection that asked for one) means the
 * resubmission is likely to be rejected again, whatever the residue verification says, so it
 * holds like a block finding until it is fixed or the developer acknowledges the rejection.
 */
export function openRejectionHolds(state: LedgerState, findings: Finding[], bundleId?: string): string[] {
  const out: string[] = [];
  for (const r of state.rejections) {
    if (r.approvedBy || r.acked || r.outcome !== "rejected") continue;
    if (!rejectionAppliesTo(r, bundleId)) continue;
    const seen = new Set<string>();
    // "Uncensored" in the listing restates what a 1.1/1.2 rejection objected to, even in an app the scan cannot tie to content.
    const objectionable = r.guidelines.some((g) => /^1\.[12](\D|$)/.test(g));
    for (const f of findings) {
      if (seen.has(f.rule)) continue;
      if (f.severity !== "high" && !(objectionable && f.rule === "metadata.content_signal_claim")) continue;
      const cited = r.guidelines.find((g) => guidelineWithin(f.guideline, g));
      if (!cited) continue;
      seen.add(f.rule);
      out.push(
        `Open rejection ${r.id} cites Guideline ${cited}, and ${f.rule} (Guideline ${f.guideline}) is still reported${f.file ? ` at ${f.file}${f.line ? `:${f.line}` : ""}` : ""}: ${f.fix} Check every precaution the rejection message lists before resubmitting.`,
      );
    }
  }
  return out;
}

/**
 * A check that threw reported nothing, and most checks can report block findings, so the gate
 * would otherwise say CLEAR or WARN for an area it never looked at.
 */
export function checkErrorHolds(scan: Pick<ScanRun, "checks">): string[] {
  return scan.checks
    .filter((c) => c.error)
    .map(
      (c) =>
        `Check ${c.id} failed: ${c.error}. The gate cannot vouch for this area (${c.guidelines.join(", ")}). Run \`appstore-shield scan --checks ${c.id}\` to see the error; the hold lifts once the check runs.`,
    );
}

/** Safeguards a text may describe only when the scan does not report them missing. */
const SAFEGUARD_CLAIMS: { rules: string[]; what: string; rx: RegExp; serverSide: boolean }[] = [
  {
    rules: ["ugc.no_report"],
    what: "a way to report content",
    rx: /\breport(?:ing)?\s+(?:button|action|option|flow|feature|menu|link|icon|screen)s?\b|\b(?:users?|you|people|anyone|reviewers?)\s+can\s+(?:also\s+|now\s+)?(?:tap\s+)?report\b|["“]report\b[^"”\n]{0,40}["”]|\breporting:|\btap(?:s|ping)?\s+["“]?report\b|\breport\s+(?:this|offensive|abusive|inappropriate|objectionable)\b/i,
    serverSide: false,
  },
  {
    rules: ["ugc.no_block"],
    what: "a way to block users",
    rx: /\bblock(?:ing)?\s+(?:button|action|option|feature|menu)s?\b|\b(?:users?|you|people)\s+can\s+(?:also\s+|now\s+)?block\b|["“]block\b[^"”\n]{0,40}["”]|\bblocking:|\bblock\s+(?:a\s+|abusive\s+|other\s+|any\s+)?users?\b/i,
    serverSide: false,
  },
  {
    rules: ["ugc.no_filter", "genai.no_moderation"],
    what: "content filtering or moderation",
    rx: /\bmoderat(?:ion|ed|es|ing)\b|\bcontent\s+filter(?:s|ing)?\b|\bfilter(?:s|ed|ing)?\s+(?:objectionable|offensive|inappropriate|posted|user|generated|explicit)\b|\bfiltering:|\bclassifier\b/i,
    serverSide: true,
  },
  {
    rules: ["genai.input_only_moderation"],
    what: "moderation of generated output",
    rx: /\boutput\s+(?:image\s+|text\s+)?(?:moderation|filter(?:ing)?|classifier)\b|\bmoderat\w*\s+(?:the\s+|of\s+(?:the\s+)?)?(?:generated|outputs?|results?)\b|\bgenerated\s+(?:images?|content|text|outputs?|results?)\s+(?:are|is)\s+(?:now\s+)?(?:moderated|filtered|checked|classified|scanned)\b/i,
    serverSide: true,
  },
  {
    rules: ["ugc.no_age_gate"],
    what: "an age gate or age identification",
    rx: /\bage[- ](?:gate|gated|gating|verification|check|restriction|identification)\b|\bdeclared\s+age\s+range\b|\bverif(?:y|ies|ied)\s+(?:the\s+)?(?:user'?s?\s+)?age\b/i,
    serverSide: false,
  },
  {
    // "Asks for camera permission" is an OS prompt, not AI consent, so permission counts only when tied to sending or sharing.
    rules: ["ai.undisclosed_sharing"],
    what: "a consent prompt before data is sent to a third-party AI service",
    rx: /\bconsent\s+(?:screen|prompt|dialog|alert|sheet|step|page|modal)s?\b|\bask(?:s|ed|ing)?\s+(?:the\s+user\s+|users?\s+|them\s+)?(?:for\s+)?(?:their\s+|explicit\s+)?consent\b|\b(?:permission|consent)\s+(?:before|to)\s+(?:send|shar|upload)\w*|\btaps?\s+["“']?allow\b|\b(?:users?|you)\s+(?:must\s+|can\s+)?(?:agree|consent|opt[- ]in)\b[^.\n]{0,60}\b(?:shar|send|AI|third)/i,
    serverSide: false,
  },
  {
    rules: ["account_deletion.missing"],
    what: "in-app account deletion",
    rx: /\bdelet(?:e|es|ing)\s+(?:their|your|the|an?|my|his|her)\s+(?:own\s+)?account\b|\baccount\s+deletion\b|["“]delete\s+(?:my\s+)?account["”]|\bdelete\s+account\s+(?:button|option|flow|screen|link)\b/i,
    serverSide: false,
  },
  {
    rules: ["paywall.missing_restore"],
    what: "a way to restore purchases",
    rx: /\brestore\s+purchases?\b/i,
    serverSide: false,
  },
];

// Negated or future sentences are honest statements about what is missing, not claims.
const NEGATED = /\b(?:no|not|without|never|lacks?|isn'?t|aren'?t|doesn'?t|don'?t|cannot|can'?t|will add|plan(?:s|ned)? to)\b/i;
const DEVELOPER_STATES = /^\s*(?:[-*•]\s*)?the developer (?:states|confirms|attests)\b/i;

export interface SafeguardClaimIssue {
  rule: "safeguard_claim_unbacked";
  severity: "error" | "warning";
  excerpt: string;
  message: string;
  fix: string;
}

/**
 * Text that describes a safeguard the scan reports missing tells App Review the app has a feature
 * it does not have. Filtering that runs on a server outside the repo cannot be seen by the scan,
 * so it may still be described as the developer's own statement; a report or block control is UI
 * and would be in the repo.
 */
type FindingRef = Pick<Finding, "rule" | "severity" | "file" | "line">;

/** Safeguards the scan reports missing, each with the first finding that says so. */
export function safeguardGaps(findings: FindingRef[]): { what: string; finding: FindingRef; serverSide: boolean; rx: RegExp }[] {
  const open = new Map<string, FindingRef>();
  for (const f of findings) if (!open.has(f.rule)) open.set(f.rule, f);
  return SAFEGUARD_CLAIMS.flatMap((claim) => {
    const f = claim.rules.map((r) => open.get(r)).find((x) => x !== undefined && x.severity !== "info");
    return f ? [{ what: claim.what, finding: f, serverSide: claim.serverSide, rx: claim.rx }] : [];
  });
}

/** An AI-only app (no other users) with no block or mute control: "users can block" describes nothing it has. */
export function aiOnlyWithoutBlock(scan: Pick<ScanRun, "checks">): boolean {
  const d = scan.checks.find((c) => c.id === "ugc_safeguards")?.data;
  return d?.aiOnly === true && d.userBlockFound === false;
}

const BLOCK_USERS_CLAIM = /\b(?:block|mute)\w*\s+(?:abusive\s+|other\s+)?users?\b|\busers?\s+can\s+(?:block|mute)\b/i;

export function safeguardClaimIssues(text: string, findings: FindingRef[], opts: { aiOnlyNoBlock?: boolean } = {}): SafeguardClaimIssue[] {
  const sentences = text
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9"'(“])/)
    .map((x) => x.trim())
    .filter(Boolean);
  const out: SafeguardClaimIssue[] = [];
  for (const { what, finding: f, serverSide, rx } of safeguardGaps(findings)) {
    const claim = { what, serverSide, rx };
    const hit = sentences.find((s) => claim.rx.test(s) && !NEGATED.test(s) && !(claim.serverSide && DEVELOPER_STATES.test(s)));
    if (!hit) continue;
    const where = f.file ? ` (at ${f.file}${f.line ? `:${f.line}` : ""})` : "";
    out.push({
      rule: "safeguard_claim_unbacked",
      severity: f.severity === "medium" ? "warning" : "error",
      excerpt: hit.length > 140 ? `${hit.slice(0, 139)}…` : hit,
      message: `The text describes ${claim.what}, but the scan still reports ${f.rule}${where}. Describing a feature the app does not have is a misleading statement to App Review.`,
      fix: claim.serverSide
        ? `Add ${claim.what} and scan again before describing it. If it runs on a server outside this repo, write it as "The developer states that …" and have the developer record it with \`appstore-shield attest\`.`
        : `Add ${claim.what} and scan again before describing it, or remove the sentence.`,
    });
  }
  if (opts.aiOnlyNoBlock) {
    const hit = sentences.find((s) => BLOCK_USERS_CLAIM.test(s) && !NEGATED.test(s));
    if (hit && !out.some((i) => i.excerpt === (hit.length > 140 ? `${hit.slice(0, 139)}…` : hit))) {
      out.push({
        rule: "safeguard_claim_unbacked",
        severity: "error",
        excerpt: hit.length > 140 ? `${hit.slice(0, 139)}…` : hit,
        message: "The text says users can block other users, but this app has no user-to-user interaction and no block or mute feature was found.",
        fix: "Remove the sentence. For an AI-only app, say plainly that there are no other users to block, and describe the report flow for AI output and the content filter (SKILL.md step 7); if you add a way to stop or mute the AI character, scan again before describing it.",
      });
    }
  }
  return out;
}

function latestConfigSnapshot(state: LedgerState, s: SnapshotInput): string | undefined {
  const same = state.configSnapshots.filter((e) => e.kind === s.kind && e.label === s.label && (e.bundleId ?? "") === (s.bundleId ?? ""));
  return same[same.length - 1]?.hash;
}

/**
 * A rejection verified clean (or later approved) stays closed only while the tree still is: sweep
 * the current source against each saved spec, static only (no build, no probe), so a capability
 * that came back holds the gate instead of riding on an old verification.
 */
async function resweepRejections(root: string, state: LedgerState, now: string, bundleId?: string): Promise<ResweepResult[]> {
  const out: ResweepResult[] = [];
  for (const r of rejectionsToResweep(state, bundleId)) {
    try {
      const v = await verifyRemediation(root, r.spec!, { now, rejectionId: r.id, ledgerEvents: state.events });
      out.push(resweepFromVerification(r.id, v));
    } catch {
      // A sweep that cannot run adds nothing; the recorded verification still stands for this rejection.
    }
  }
  return out;
}

export async function runPreflight(rootIn: string, opts: PreflightOptions): Promise<PreflightResult> {
  const now = opts.now ?? new Date().toISOString();
  const record = opts.record ?? true;
  const scan = await runScan(rootIn);
  const ctx = scan.ctx;
  if (opts.requirePlatform && !scan.platforms.length) throw new NoAppProjectError(ctx.root);
  const bundleId = opts.recordSubmission?.bundleId ?? detectBundleId(ctx);

  // A read-only gate (CI, the hook) leaves the shield home untouched as well as the ledger.
  const location = await locateLedger(ctx.root, { remember: record });
  const { state, invalid } = await loadState(location);

  const remoteControls = remoteControlsOf(scan);
  const snapshots = buildSnapshots(ctx, { remoteControls, bundleId });
  const drift = diffSinceApproved(state, snapshots, { bundleId });
  const gate = gateDecision(state, scan.findings, now, drift, await resweepRejections(ctx.root, state, now, bundleId), { bundleId });
  const tied = [...openRejectionHolds(state, scan.findings, bundleId), ...checkErrorHolds(scan)];
  if (tied.length) {
    gate.holdReasons.push(...tied);
    gate.verdict = "HOLD";
    // A rule promoted to HOLD here should not also be listed as a mere high-finding warning.
    refreshHighFindingsWarning(gate, scan.findings);
  }
  // A CLEAR over files the scan never read would vouch for code it did not see.
  const unread = gateCoverageWarnings(scan.coverage);
  if (unread.length) {
    gate.warnings.push(...unread);
    if (gate.verdict === "CLEAR") gate.verdict = "WARN";
  }
  const inventory = disclosureInventory(scan);

  let builtProduct: BuiltProductReport[] | undefined;
  if (opts.buildPath) {
    builtProduct = [];
    const withSpec = state.rejections.filter((r) => !r.approvedBy && r.spec && rejectionAppliesTo(r, bundleId));
    if (!withSpec.length) {
      builtProduct.push({
        rejectionId: "",
        notes: [`No open rejection has a saved residue spec, so there is nothing to sweep the build for. Save one with ${toolRef("shield_remediation", "save_spec")}.`],
        matches: [],
      });
    }
    for (const r of withSpec) {
      try {
        const sweep = await sweepBuiltProduct(opts.buildPath, r.spec!);
        builtProduct.push({
          rejectionId: r.id,
          hits: sweep.hits,
          encrypted: sweep.encrypted,
          complete: sweep.complete,
          notes: sweep.notes,
          matches: sweep.matches.slice(0, 20).map((m) => ({ needle: m.needle, file: m.file, evidence: m.evidence })),
        });
        if (sweep.hits > 0) {
          gate.warnings.push(`Built product ${opts.buildPath} still contains ${sweep.hits} residue match(es) for rejection ${r.id}.`);
          if (gate.verdict === "CLEAR") gate.verdict = "WARN";
        }
        // A sweep that read only part of the product, or could not read the executable, is not a
        // clean build: the gate must say so rather than pass silently.
        if (!sweep.complete || sweep.encrypted) {
          gate.warnings.push(`Built product ${opts.buildPath} could not be fully swept for rejection ${r.id}${sweep.notes.length ? `: ${sweep.notes.join(" ")}` : "."}`);
          if (gate.verdict === "CLEAR") gate.verdict = "WARN";
        }
      } catch (e) {
        const err = (e as Error).message;
        builtProduct.push({ rejectionId: r.id, notes: [], matches: [], error: err });
        gate.warnings.push(`Built product ${opts.buildPath} could not be swept for rejection ${r.id}: ${err}`);
        if (gate.verdict === "CLEAR") gate.verdict = "WARN";
      }
    }
  }

  const recorded: PreflightResult["recorded"] = { snapshotEvents: [] };
  try {
    if (record) {
      // Unchanged snapshots are not re-appended, so the ledger grows only when something changed.
      for (const s of snapshots) {
        if (latestConfigSnapshot(state, s) === s.hash) continue;
        const ev = await appendEvent(location, s, { source: opts.source });
        recorded.snapshotEvents.push(ev.id);
      }
      const metaRaw = checkData(scan, "metadata")?.snapshots;
      const meta = Array.isArray(metaRaw) ? metaRaw.flatMap((m) => { const p = MetadataSnapshot.safeParse(m); return p.success ? [p.data] : []; }) : [];
      if (meta.length) {
        const last = state.metadataSnapshots.filter((e) => (e.bundleId ?? "") === (bundleId ?? "")).at(-1);
        if (!last || stableHash(last.snapshots) !== stableHash(meta)) {
          const ev = await appendEvent(location, { type: "metadata_snapshot", snapshots: meta, bundleId, repo: ctx.root }, { source: opts.source });
          recorded.metadataEventId = ev.id;
        }
      }
    }
    if (opts.recordSubmission) {
      const ev: LedgerEvent = await appendEvent(
        location,
        {
          type: "submission",
          version: opts.recordSubmission.version,
          build: opts.recordSubmission.build,
          bundleId,
          repo: ctx.root,
          sha: await gitHead(ctx.root),
        },
        { source: opts.source },
      );
      recorded.submissionEventId = ev.id;
    }
  } catch (e) {
    // A foreign file or symlink at ledgerPath is already a location issue on the gate; refusing to
    // write there must give that HOLD, not end the run with no verdict.
    if ((e as Error).name !== "NotALedgerError" && (e as Error).name !== "SymlinkLedgerError") throw e;
    const err = (e as Error).message;
    if (!gate.holdReasons.some((r) => r.includes(err) || err.includes(r))) gate.holdReasons.push(`Nothing was recorded in the ledger: ${err}`);
    gate.verdict = "HOLD";
  }

  return {
    root: ctx.root,
    platforms: scan.platforms,
    bundleId,
    ledger: { teamId: location.teamId, teamIdSource: location.teamIdSource, path: location.path, warnings: location.warnings, invalidLines: invalid },
    gate,
    triggers: triggerChecklist(state, now),
    drift,
    openRejections: openRejections(state),
    manualChecklist: manualChecklist(inventory, scan, state),
    inventory,
    builtProduct,
    coverage: scan.coverage,
    recorded,
    scan,
    state,
    location,
  };
}

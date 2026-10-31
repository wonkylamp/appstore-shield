import { execFile } from "node:child_process";
import { constants, existsSync, realpathSync, statSync } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import { CHECK_IDS, type CheckId } from "./checks.js";
import type { Finding } from "./finding.js";
import { coverageNotes, groupByRule, labelText, preflightSummary, scanSummary } from "./format.js";
import { redactSecrets } from "./ledger/drift.js";
import { evidencePack, type EvidencePurpose } from "./ledger/evidence.js";
import { commitImport, importAppleData, isFutureDated, type ProposedEvent } from "./ledger/import.js";
import { lintText, type TierEvidence } from "./ledger/lint.js";
import { HUMAN_ONLY_EVENTS, ResidueSpec, type LedgerState, type RejectionState } from "./ledger/schema.js";
import { appendEvent, HumanOnlyEventError, loadState, locateLedger } from "./ledger/store.js";
import { triggerChecklist } from "./ledger/triggers.js";
import { aiOnlyWithoutBlock, detectBundleId, disclosureInventory, looksLikeApp, NoAppProjectError, noAppMessage, openRejections, runPreflight, runScan, safeguardClaimIssues, safeguardGaps, type ScanRun } from "./preflight.js";
import { loadContext } from "./project.js";
import { ingestProbeResults, writeProbeSuite } from "./remediation/probe.js";
import { findSurface, validateSpec } from "./remediation/surface.js";
import { tierLabel, verifyRemediation } from "./remediation/verify.js";
import { CHECKS } from "./scanners/index.js";

import { VERSION } from "./version.js";

export { VERSION };
const TOP = 30;

export const INSTRUCTIONS = `App Store rejection, App Review, Guideline 1.1 / 1.2 / 2.5.19, DPLA 3.2(f) "pattern of manipulative or misleading behavior", developer account terminated, resubmit, review notes, Resolution Center reply, App Review Board appeal.

appstore-shield is a local, offline helper for iOS, SwiftUI and React Native/Expo developers. It never contacts Apple or any network and needs no App Store Connect keys. It cannot guarantee approval or prevent a termination; Apple's heuristics are not public.

Use it when a developer: got an App Store rejection or a 3.2(f) termination notice; is about to submit for review; must write Notes for Review, a Resolution Center reply, a clarification question or an appeal.

Tools (all take project_path, the absolute path of the app repo; a directory with no app is refused, and force:true is only for a path the user confirmed):
- shield_scan: static checks (review-time gating, remote config, OTA, generative-AI safety, UGC safeguards, AI data disclosure, ratings, paywall, metadata, account deletion, privacy manifest). Concise by default; detail:"full" for everything.
- shield_preflight: gate verdict CLEAR/WARN/HOLD, trigger checklist (raw counts, no thresholds), drift since the last approved snapshot, open rejections, manual checklist. Records config snapshots; pass record_submission only after the developer actually submitted.
- shield_remediation: find_surface → save_spec → verify (loop until STATIC_CLEAN or better) → probe_suite → ingest_probe_results, for a recorded rejection.
- shield_ledger_import / shield_ledger_record / shield_ledger_query: the account-scoped review history (keyed by Apple Team ID).
- shield_evidence_pack: typed facts with ledger event ids plus a section scaffold for review_notes, reply, clarification, appeal_review_board, appeal_termination.
- shield_lint_text: lint every text before it goes to Apple.

Rules:
1. Compliance and disclosure, never evasion. Never suggest renaming, moving or hiding code, gating content on remote flags, dates, regions, environments or reviewer detection. Fixes are "remove" or "disclose".
2. Fix the capability, not the screen: every input path (picker, free text, remix, upload, deep link, server prompt).
3. Never submit for review while preflight says HOLD. On WARN, name high findings as likely next rejections and recommend fixing them in the same build. Uploading a build is not submitting it.
4. attestation and ack events are human-only: the developer runs \`appstore-shield attest\` or \`appstore-shield ack\` in a terminal. Never run them for the user.
5. Never claim the capability is gone from the model; only a probe result says anything about behavior, and only for the prompts tried.
6. Lint every outgoing text with shield_lint_text and fix every error before showing it as final. Private hypotheses in appeal packs are never pasted into anything sent to Apple.
7. Findings are leads for a human, not proof. The tool does not give legal advice; for terminations suggest counsel.`;

// ------------------------------------------------------------------ helpers

function text(t: string): CallToolResult["content"] {
  return [{ type: "text", text: t }];
}

function fail(message: string): CallToolResult {
  return { isError: true, content: text(message) };
}

function ok(summary: string, structured: Record<string, unknown>): CallToolResult {
  // JSON round-trip drops undefined fields so structuredContent matches the output schema exactly.
  return { content: text(summary), structuredContent: JSON.parse(JSON.stringify(structured)) as Record<string, unknown> };
}

/**
 * Returns the resolved directory, or an actionable error message. A directory with no app in it
 * is refused (unless forced): a scan or gate there would report CLEAR for code it never saw and
 * start a ledger for a repo that is not the developer's app.
 */
export function checkProjectPath(p: string, force = false): { root: string } | { error: string } {
  if (!p || !path.isAbsolute(p)) {
    return { error: `project_path must be an absolute path to the app repo; got "${p}". Pass the repo root, e.g. /Users/me/MyApp.` };
  }
  const root = path.resolve(p);
  if (!existsSync(root)) return { error: `project_path ${root} does not exist. Check the path, or ask the user where the app repo is.` };
  if (!statSync(root).isDirectory()) {
    return { error: `project_path ${root} is a file, not a directory. Pass the repo root that contains the .xcodeproj or package.json.` };
  }
  if (!force && !looksLikeApp(root)) return { error: `project_path: ${noAppMessage(root, "pass force: true")}` };
  return { root };
}

/** Proposed events dated after now; they cannot be Apple's past messages. Same rule as the CLI and commitImport. */
function futureDated<T extends ProposedEvent>(proposed: T[], now = Date.now()): T[] {
  return proposed.filter((p) => !p.duplicateOf && isFutureDated(p, now));
}

function clip(s: string | undefined, max = 300): string | undefined {
  if (s === undefined) return undefined;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function packageRoot(): string {
  // The bundle runs from dist/chunks/, and npx or a global install starts it through a bin
  // symlink, so walk up from both the real module path and the real script path.
  const starts = [fileURLToPath(import.meta.url), process.argv[1]].flatMap((p) => {
    if (!p) return [];
    try {
      return [path.dirname(realpathSync(p))];
    } catch {
      return [path.dirname(p)];
    }
  });
  const has = (dir: string) => existsSync(path.join(dir, "skills", "appstore-shield", "references"));
  for (const start of starts) {
    for (let dir = start, i = 0; i < 6; i++, dir = path.dirname(dir)) if (has(dir)) return dir;
  }
  const plugin = process.env.CLAUDE_PLUGIN_ROOT;
  return plugin && has(plugin) ? plugin : path.resolve(starts[0] ?? ".", "..");
}

async function reference(name: string): Promise<string> {
  const file = path.join(packageRoot(), "skills", "appstore-shield", "references", name);
  try {
    return await readFile(file, "utf8");
  } catch {
    return `Reference ${name} was not found at ${file}. Reinstall the appstore-shield plugin.`;
  }
}

export function checksCatalog(): string {
  const rows = [...CHECKS.values()].map((c) => `| \`${c.id}\` | ${c.title} | ${c.guidelines.join(", ")} |`);
  return ["# appstore-shield checks", "", "| Check | Title | Guidelines |", "|---|---|---|", ...rows, "", "Severity: block (gate HOLD), high, medium, info. Findings marked not suppressible can only be cleared by fixing the code."].join("\n");
}

async function ledgerFor(root: string) {
  const location = await locateLedger(root);
  const { state, invalid } = await loadState(location);
  return { location, state, invalid };
}

function findRejection(state: LedgerState, id: string | undefined): RejectionState | undefined {
  if (!id) return undefined;
  return state.rejections.find((r) => r.id === id);
}

function gitOut(root: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", ["-C", root, ...args], { timeout: 10_000, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? undefined : stdout.trim() || undefined));
  });
}

async function isGitWorkTree(root: string): Promise<boolean> {
  return (await gitOut(root, ["rev-parse", "--is-inside-work-tree"])) === "true";
}

/**
 * The pre-fix commit for a rejection when verify is called without base_ref. Without one, a fix
 * that removed a TestFlight check or a remote flag is never seen, and that removal is the
 * disclosure that matters most (2.5.19, DPLA 3.2(f)); so the commit recorded with the rejected
 * submission is used, else the last commit before the rejection.
 */
async function inferBaseRef(root: string, state: LedgerState, rej: RejectionState): Promise<{ ref: string; why: string } | undefined> {
  if (!(await isGitWorkTree(root))) return undefined;
  const sub = rej.submissionId ? state.submissions.find((x) => x.id === rej.submissionId) : undefined;
  if (sub?.sha && /^[0-9a-f]{7,64}$/i.test(sub.sha) && (await gitOut(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${sub.sha}^{commit}`]))) {
    return { ref: sub.sha, why: "the commit recorded with the rejected submission" };
  }
  if (!Number.isFinite(Date.parse(rej.at))) return undefined;
  const before = await gitOut(root, ["rev-list", "-1", `--before=${new Date(rej.at).toISOString()}`, "HEAD", "--"]);
  return before && /^[0-9a-f]{40,64}$/.test(before) ? { ref: before, why: `the last commit before the rejection on ${rej.at.slice(0, 10)}` } : undefined;
}

const NO_BASE_REF = "review-time conditions the fix removed (a TestFlight, reviewer, region or remote-flag check) were not looked for, so their disclosure cannot be checked";

function unknownRejection(state: LedgerState, id: string | undefined): string {
  const known = state.rejections.map((r) => r.id).slice(-5);
  return `No rejection with id "${id ?? ""}" in the ledger. ${known.length ? `Known rejection ids: ${known.join(", ")}.` : "The ledger has no rejections yet."} Import the App Review message with shield_ledger_import (commit: true) first, or check shield_ledger_query view "status".`;
}

const FindingOut = z.object({
  id: z.string(),
  rule: z.string(),
  severity: z.enum(["block", "high", "medium", "info"]),
  guideline: z.string(),
  file: z.string().optional(),
  line: z.number().optional(),
  evidence: z.string().optional(),
  why: z.string(),
  fix: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  suppressible: z.boolean(),
});

const Counts = z.object({ block: z.number(), high: z.number(), medium: z.number(), info: z.number() });

const RuleGroupOut = z.object({
  rule: z.string(),
  severity: z.string(),
  guideline: z.string(),
  count: z.number(),
  suppressible: z.boolean(),
  locations: z.array(z.string()),
});

const projectPath = z.string().describe("Absolute path of the app repo root (the directory with the .xcodeproj, Package.swift or package.json)");
const force = z.boolean().default(false).describe("Use project_path even though no iOS, SwiftUI or React Native/Expo project was detected there (shield_remediation: or record a spec/verification for a rejection whose bundle id differs from the project's). Only when the user confirms the path");
const detail = z.enum(["concise", "full"]).default("concise").describe('"concise" (default): top 30 findings, grouped by rule. "full": every finding and all per-check data.');
const PURPOSES = ["review_notes", "reply", "clarification", "appeal_review_board", "appeal_termination"] as const;

/** Compact per-check data for concise output; the full inventories are behind detail:"full". */
function conciseData(scan: ScanRun): Record<string, unknown> {
  const inv = disclosureInventory(scan);
  const out: Record<string, unknown> = {};
  if (inv.remoteControls?.length) {
    out.remoteControls = inv.remoteControls.slice(0, TOP).map((c) => ({ key: c.key, provider: c.provider, classification: c.classification, file: c.file, line: c.line, defaultValue: c.defaultValue }));
  }
  if (inv.ota?.length) out.ota = inv.ota;
  if (inv.aiServices?.length) out.aiServices = inv.aiServices;
  const snaps = scan.checks.find((c) => c.id === "metadata")?.data?.snapshots;
  if (Array.isArray(snaps) && snaps.length) out.metadataSnapshots = snaps.slice(0, 5);
  return out;
}

function findingsOut(findings: Finding[], full: boolean): { findings: Finding[]; truncated: boolean } {
  return full ? { findings, truncated: false } : { findings: findings.slice(0, TOP), truncated: findings.length > TOP };
}

/**
 * The rejection a text's facts belong to. A pack's F-numbers are positional and change with
 * purpose and rejection_id, so only ledger event ids (a fact's eventId) identify a rejection:
 * the rejection itself, a message sent for it, or any event recorded against it.
 */
export function rejectionForFacts(state: LedgerState, factIds: string[] | undefined): { rejection?: RejectionState; unresolved: string[] } {
  const unresolved: string[] = [];
  for (const id of factIds ?? []) {
    const ev = state.events.find((e) => e.id === id);
    const owner = ev && "rejectionId" in ev && typeof ev.rejectionId === "string" ? ev.rejectionId : undefined;
    const r = state.rejections.find((x) => x.id === id || x.id === owner || x.messages.some((m) => m.eventId === id));
    if (r) return { rejection: r, unresolved };
    unresolved.push(id);
  }
  return { unresolved };
}

/** Strongest verification evidence relevant to a lint call, so absolute claims are only allowed when backed. */
export function tierFor(state: LedgerState, rejectionId: string | undefined, factIds: string[] | undefined): TierEvidence | undefined {
  const r = findRejection(state, rejectionId) ?? rejectionForFacts(state, factIds).rejection ?? state.rejections.filter((x) => !x.approvedBy).at(-1);
  const v = r?.verification;
  if (!v) return undefined;
  return { tier: v.tier, probe: v.probe, builtProduct: v.builtProduct, buildClean: v.builtProduct ? v.builtProduct.hits === 0 : undefined };
}

/** The checks whose results decide what a text must disclose and which safeguards it may describe. */
async function textScan(root: string) {
  const scan = await runScan(root, { checks: ["remote_config", "ota_updates", "genai_safety", "ugc_safeguards"] });
  return { inventory: disclosureInventory(scan), findings: scan.findings, aiOnlyNoBlock: aiOnlyWithoutBlock(scan) };
}

/**
 * Safety-off sites are listed by role and first: lumped in with real moderation calls, "3
 * moderation sites" reads as "already moderated" when all three turn provider safety off.
 */
export function moderationLines(sites: { role: string; file: string; line?: number; label: string }[]): string[] {
  const at = (x: { file: string; line?: number }) => `${x.file}${x.line ? `:${x.line}` : ""}`;
  const off = sites.filter((x) => x.role === "safety-disabled");
  const calls = sites.filter((x) => x.role === "moderation").length;
  const strict = sites.filter((x) => x.role === "safety-strict").length;
  const lines = [
    `${off.length} place(s) where provider safety is OFF${off.length ? " (fix first)" : ""}; ${calls} moderation call(s); ${strict} strict provider safety setting(s).`,
    ...off.slice(0, 6).map((x) => `- safety OFF: ${x.label} @ ${at(x)}`),
  ];
  if (off.length > 6) lines.push(`- … ${off.length - 6} more safety-off site(s) in result.moderation`);
  return lines;
}

const IMPORT_EXTENSIONS = new Set([".eml", ".emlx", ".txt", ".json"]);
const IMPORT_MAX_BYTES = 2 * 1024 * 1024;

function insideHiddenHomeDir(file: string, home: string): boolean {
  const rel = path.relative(home, file);
  return !rel.startsWith("..") && !path.isAbsolute(rel) && rel.split(path.sep).some((part) => part.startsWith("."));
}

async function realHome(): Promise<string> {
  try {
    return await realpath(homedir());
  } catch {
    return homedir();
  }
}

/**
 * file_path is read by this server, not through the client's own file permissions, so it is held
 * to what an App Review message or asc export looks like: a small regular file with a mail, text
 * or JSON extension, outside the dot-directories in $HOME where credentials live.
 */
export async function checkImportPath(file: string): Promise<string | undefined> {
  const r = await vetImportPath(file);
  return "error" in r ? r.error : undefined;
}

/**
 * The rules are applied to the path as written and to its real path: a symlinked directory
 * (/tmp/l -> ~/.config/gcloud) would otherwise reach a hidden directory in $HOME.
 */
async function vetImportPath(file: string): Promise<{ error: string } | { real: string; dev: number; ino: number }> {
  if (!path.isAbsolute(file)) return { error: `file_path must be absolute; got "${file}".` };
  const resolved = path.resolve(file);
  const extError = (p: string) =>
    IMPORT_EXTENSIONS.has(path.extname(p).toLowerCase())
      ? undefined
      : `file_path must be a saved email or export (.eml, .emlx, .txt or .json); got "${path.basename(p)}". Paste the message as text instead.`;
  const hiddenError = (p: string) =>
    `file_path ${p} is inside a hidden directory in your home folder; App Review messages are not read from there. Save the message elsewhere or paste it as text.`;
  const bad = extError(resolved);
  if (bad) return { error: bad };
  const home = homedir();
  const rhome = await realHome();
  if (insideHiddenHomeDir(resolved, home) || insideHiddenHomeDir(resolved, rhome)) return { error: hiddenError(resolved) };
  let st;
  try {
    st = await lstat(resolved);
  } catch (e) {
    return { error: `Cannot read ${resolved}: ${(e as Error).message}.` };
  }
  if (st.isSymbolicLink()) return { error: `file_path ${resolved} is a symbolic link; pass the file it points to.` };
  if (!st.isFile()) return { error: `file_path ${resolved} is not a regular file.` };
  if (st.size > IMPORT_MAX_BYTES) return { error: `file_path ${resolved} is ${st.size} bytes; App Review messages and exports are far smaller (limit ${IMPORT_MAX_BYTES}). Paste the relevant message as text.` };
  let real: string;
  try {
    real = await realpath(resolved);
  } catch (e) {
    return { error: `Cannot read ${resolved}: ${(e as Error).message}.` };
  }
  const realBad = extError(real);
  if (realBad) return { error: realBad };
  if (insideHiddenHomeDir(real, home) || insideHiddenHomeDir(real, rhome)) return { error: hiddenError(resolved) };
  return { real, dev: st.dev, ino: st.ino };
}

/**
 * Reads the vetted file through its real path with O_NOFOLLOW and checks the opened descriptor is
 * the file that was vetted, so a path swapped after the checks is refused rather than read.
 */
export async function readImportFile(file: string): Promise<{ error: string } | { text: string }> {
  const v = await vetImportPath(file);
  if ("error" in v) return v;
  let fh;
  try {
    fh = await open(v.real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    return { error: `Cannot read ${file}: ${(e as Error).message}.` };
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.dev !== v.dev || st.ino !== v.ino || st.size > IMPORT_MAX_BYTES) return { error: `file_path ${file} changed while it was being read; save the message again or paste it as text.` };
    return { text: await fh.readFile("utf8") };
  } finally {
    await fh.close();
  }
}

function wrap<A>(fn: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      if (e instanceof HumanOnlyEventError || e instanceof NoAppProjectError) return fail(e.message);
      return fail(`${(e as Error).message}\nIf this persists, run the same step with the CLI (appstore-shield --help) to see more detail.`);
    }
  };
}

// ------------------------------------------------------------------ server

export function createServer(): McpServer {
  const server = new McpServer({ name: "appstore-shield", version: VERSION }, { instructions: INSTRUCTIONS });

  // ---- shield_scan
  server.registerTool(
    "shield_scan",
    {
      title: "Scan an iOS / Expo app for App Review risks",
      description:
        "Scan an iOS, SwiftUI or React Native/Expo repo for App Review rejection and 3.2(f) risks: review-time gating (2.5.19), remote config and OTA inventory, generative-AI safety and nudification (1.1, 1.2), UGC safeguards, AI data disclosure (5.1.2(i)), ratings integrity, paywall terms, store metadata, account deletion, privacy manifest. Read-only and offline. Concise output groups findings by rule and returns the top 30; narrow with checks/paths/rule, or pass detail:\"full\".",
      inputSchema: z.object({
        project_path: projectPath,
        force,
        checks: z.array(z.enum(CHECK_IDS)).optional().describe("Only run these checks (default: all)"),
        paths: z.array(z.string()).optional().describe("Only scan these repo-relative files or directories"),
        rule: z.string().optional().describe("Only return findings whose rule starts with this, e.g. \"paywall.\" or \"genai.nudification\""),
        include_tests: z.boolean().default(false).describe("Also scan test sources (they never ship, so off by default)"),
        detail,
      }),
      outputSchema: z.object({
        project_path: z.string(),
        platforms: z.array(z.string()),
        files_scanned: z.number(),
        coverage_notes: z.array(z.string()),
        app_roots: z.array(z.object({ path: z.string(), platform: z.string() })).describe("Every app found in the repo, scanned or not; set appPaths in .appstore-shield/config.json to scan only the ones that ship"),
        counts: Counts,
        suppressed_count: z.number(),
        by_rule: z.array(RuleGroupOut),
        findings: z.array(FindingOut),
        truncated: z.boolean(),
        narrow_hint: z.string().optional(),
        check_errors: z.array(z.object({ check: z.string(), error: z.string() })),
        baseline_problems: z.array(z.string()),
        data: z.record(z.string(), z.unknown()).describe("Concise: remote controls, OTA, AI services, metadata snapshots. Full: every check's data"),
      }),
      annotations: { title: "Scan app repo", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    wrap(async ({ project_path, force: forced, checks, paths, rule, include_tests, detail: d }) => {
      const p = checkProjectPath(project_path, forced);
      if ("error" in p) return fail(p.error);
      let scoped: string[] | undefined;
      if (paths?.length) {
        // A path outside the repo, missing, or matching no read file would report "No findings"
        // for code the scan never read.
        const outside: string[] = [];
        const missing: string[] = [];
        const rels: string[] = [];
        for (const raw of paths) {
          const rel = path.relative(p.root, path.resolve(p.root, raw));
          if (rel.startsWith("..") || path.isAbsolute(rel)) outside.push(raw);
          else if (!existsSync(path.join(p.root, rel))) missing.push(raw);
          else rels.push(rel === "" ? "." : rel.split(path.sep).join("/"));
        }
        if (outside.length) return fail(`paths: ${outside.join(", ")} ${outside.length === 1 ? "is" : "are"} outside the project ${p.root}. Pass paths inside the repo, relative to its root.`);
        if (missing.length) return fail(`paths: ${missing.join(", ")} ${missing.length === 1 ? "does" : "do"} not exist in ${p.root}. Paths are relative to the repo root.`);
        scoped = rels.includes(".") ? undefined : rels;
      }
      const scan = await runScan(p.root, { checks: checks as CheckId[] | undefined, paths: scoped, includeTests: include_tests });
      if (scoped) {
        const seen = [...scan.ctx.files.map((f) => f.path), ...(scan.ctx.skipped ?? []).map((f) => f.path)];
        const empty = scoped.filter((x) => !seen.some((f) => f === x || f.startsWith(`${x}/`)));
        if (empty.length) return fail(`paths: ${empty.join(", ")} matched no source file the scan reads${include_tests ? "" : " (test sources need include_tests: true)"}. Check the path; it is relative to ${p.root}.`);
      }
      // A narrowed scan may legitimately miss the manifests; a whole-repo scan with no platform is the wrong directory.
      if (!scoped && !forced && !scan.platforms.length) return fail(`project_path: ${noAppMessage(scan.root, "pass force: true")}`);
      const filtered = rule ? scan.findings.filter((f) => f.rule.startsWith(rule)) : scan.findings;
      const full = d === "full";
      const out = findingsOut(filtered, full);
      return ok(scanSummary({ ...scan, findings: filtered }), {
        project_path: scan.root,
        platforms: scan.platforms,
        files_scanned: scan.filesScanned,
        coverage_notes: coverageNotes(scan.coverage),
        app_roots: scan.coverage.appRoots,
        counts: scan.counts,
        suppressed_count: scan.suppressed.length,
        by_rule: groupByRule(filtered),
        findings: out.findings,
        truncated: out.truncated,
        narrow_hint: out.truncated
          ? `Showing ${TOP} of ${filtered.length}. Narrow with checks (e.g. ["genai_safety"]), paths (e.g. ["Sources/AI"]) or rule (e.g. "paywall."), or pass detail:"full".`
          : undefined,
        check_errors: scan.checks.filter((c) => c.error).map((c) => ({ check: c.id, error: c.error! })),
        baseline_problems: scan.baselineProblems,
        data: full ? Object.fromEntries(scan.checks.filter((c) => c.data).map((c) => [c.id, c.data])) : conciseData(scan),
      });
    }),
  );

  // ---- shield_preflight
  server.registerTool(
    "shield_preflight",
    {
      title: "Pre-submission gate (CLEAR / WARN / HOLD)",
      description:
        "Run before submitting for App Review. Returns the gate verdict (HOLD only on deterministic conditions: a block finding, an open rejection not verified to STATIC_CLEAN and not acknowledged, or verified earlier but swept below STATIC_CLEAN now, a high finding under a guideline an open rejection cites, a check that failed, undisclosed post-approval drift touching content or price), the trigger checklist with raw counts, drift since the last approved snapshot, open rejections, findings and a manual checklist (demo account, expired-subscription account, 2FA, notes specificity). Records config and metadata snapshots in the ledger. Pass record_submission only after the developer has actually submitted.",
      inputSchema: z.object({
        project_path: projectPath,
        force,
        build_path: z.string().optional().describe("Absolute path to a local .ipa, .xcarchive or .app to sweep for residue of open rejections"),
        record_submission: z
          .object({ version: z.string(), build: z.string(), bundle_id: z.string().optional() })
          .optional()
          .describe("Record a submission event. Only after the developer confirms they submitted this version/build."),
        detail,
      }),
      outputSchema: z.object({
        verdict: z.enum(["CLEAR", "WARN", "HOLD"]),
        hold_reasons: z.array(z.string()),
        warnings: z.array(z.string()),
        project_path: z.string(),
        bundle_id: z.string().optional(),
        ledger: z.object({ team_id: z.string(), team_id_source: z.string(), path: z.string(), warnings: z.array(z.string()), invalid_lines: z.number() }),
        coverage_notes: z.array(z.string()).describe("What the scan did not read, and which apps it covered"),
        app_roots: z.array(z.object({ path: z.string(), platform: z.string() })).describe("Every app found in the repo, scanned or not; set appPaths in .appstore-shield/config.json to scan only the ones that ship"),
        counts: Counts,
        top_findings: z.array(FindingOut),
        truncated: z.boolean(),
        triggers: z.array(z.unknown()),
        drift: z.unknown(),
        open_rejections: z.array(z.unknown()),
        manual_checklist: z.array(z.object({ id: z.string(), item: z.string(), guideline: z.string() })),
        disclosure_inventory: z.unknown(),
        built_product: z.array(z.unknown()).optional(),
        recorded: z.object({ snapshot_events: z.array(z.string()), metadata_event_id: z.string().optional(), submission_event_id: z.string().optional() }),
      }),
      annotations: { title: "Preflight gate", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    wrap(async ({ project_path, force: forced, build_path, record_submission, detail: d }) => {
      const p = checkProjectPath(project_path, forced);
      if ("error" in p) return fail(p.error);
      if (build_path && (!path.isAbsolute(build_path) || !existsSync(build_path))) {
        return fail(`build_path must be an absolute path to an existing .ipa, .xcarchive or .app; got "${build_path}".`);
      }
      const r = await runPreflight(p.root, {
        buildPath: build_path,
        recordSubmission: record_submission ? { version: record_submission.version, build: record_submission.build, bundleId: record_submission.bundle_id } : undefined,
        source: "agent",
        requirePlatform: !forced,
      });
      const full = d === "full";
      const out = full ? { findings: r.scan.findings, truncated: false } : { findings: r.scan.findings.slice(0, 15), truncated: r.scan.findings.length > 15 };
      return ok(preflightSummary(r), {
        verdict: r.gate.verdict,
        hold_reasons: r.gate.holdReasons,
        warnings: r.gate.warnings,
        project_path: r.root,
        bundle_id: r.bundleId,
        ledger: { team_id: r.ledger.teamId, team_id_source: r.ledger.teamIdSource, path: r.ledger.path, warnings: r.ledger.warnings, invalid_lines: r.ledger.invalidLines.length },
        coverage_notes: coverageNotes(r.scan.coverage),
        app_roots: r.scan.coverage.appRoots,
        counts: r.scan.counts,
        top_findings: out.findings,
        truncated: out.truncated,
        triggers: full ? r.triggers : r.triggers.map((t) => ({ id: t.id, title: t.title, count: t.count, window: t.window, windowNote: t.windowNote, label: t.label, contextOnly: t.contextOnly, basis: t.basis, detail: t.detail.slice(0, 5) })),
        drift: r.drift,
        open_rejections: r.openRejections,
        manual_checklist: r.manualChecklist,
        disclosure_inventory: r.inventory,
        built_product: r.builtProduct,
        recorded: { snapshot_events: r.recorded.snapshotEvents, metadata_event_id: r.recorded.metadataEventId, submission_event_id: r.recorded.submissionEventId },
      });
    }),
  );

  // ---- shield_remediation
  server.registerTool(
    "shield_remediation",
    {
      title: "Remediate a rejection: surface, spec, verify, probe",
      description:
        "Work a recorded rejection to a verified fix. action=find_surface: candidate terms, symbols, assets, strings, endpoints, flags, prompt fragments, AI sources/sinks for the rejection text. save_spec: validate a ResidueSpec (entries must exist in the repo or its git history) and store it. verify: residue sweep across all input paths (and build_path if given) giving an evidence tier RESIDUE_FOUND < UNVERIFIABLE < STATIC_CLEAN < BUILD_CLEAN < PROBED, recorded in the ledger. probe_suite: write .appstore-shield/probes/<rejection_id>.jsonl plus a runner template (no network). ingest_probe_results: count blocked probes. Never describes the capability as gone from the model.",
      inputSchema: z.object({
        project_path: projectPath,
        force,
        action: z.enum(["find_surface", "save_spec", "verify", "probe_suite", "ingest_probe_results"]),
        rejection_id: z.string().optional().describe("Ledger id of the rejection (from shield_ledger_query). Required except for find_surface with rejection_text"),
        rejection_text: z.string().optional().describe("find_surface: the App Review message text, when the rejection is not in the ledger yet"),
        spec: ResidueSpec.optional().describe("save_spec: the residue spec. verify/probe_suite: overrides the saved spec"),
        base_ref: z.string().optional().describe("verify: git ref from before the fix, for diff evidence"),
        build_path: z.string().optional().describe("verify: absolute path to a local .ipa, .xcarchive or .app"),
        results_path: z.string().optional().describe("ingest_probe_results / verify: absolute path to the probe results JSONL"),
        count: z.number().int().min(10).max(500).optional().describe("probe_suite: number of probes (default 60)"),
      }),
      outputSchema: z.object({
        action: z.string(),
        rejection_id: z.string().optional(),
        result: z.record(z.string(), z.unknown()),
        next: z.string(),
      }),
      annotations: { title: "Remediation workflow", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    wrap(async (a) => {
      const p = checkProjectPath(a.project_path, a.force);
      if ("error" in p) return fail(p.error);
      const { location, state } = await ledgerFor(p.root);
      const rej = findRejection(state, a.rejection_id);
      const needRejection = a.action !== "find_surface" || !a.rejection_text;
      if (needRejection && !rej) return fail(unknownRejection(state, a.rejection_id));
      const specOf = () => a.spec ?? rej?.spec;
      // The ledger is per team: a spec or verification recorded from another app's tree would close this rejection on evidence about the wrong app.
      if (rej?.bundleId && (a.action === "save_spec" || a.action === "verify") && !a.force) {
        const own = detectBundleId(await loadContext(p.root));
        if (own && own !== rej.bundleId) {
          return fail(`Rejection ${rej.id} is for ${rej.bundleId}, but ${p.root} builds ${own}. Run ${a.action} from that app's project, or pass force:true only when the user confirms this tree is the app that was rejected.`);
        }
      }

      if (a.action === "find_surface") {
        const ctx = await loadContext(p.root);
        const msg = a.rejection_text ?? rej?.reviewerMessage ?? "";
        if (!msg.trim()) return fail(`Rejection ${a.rejection_id} has no reviewer message stored. Pass rejection_text with the App Review message.`);
        const s = await findSurface(ctx, msg);
        const result = {
          draft: s.draft,
          terms: s.terms,
          other_words: s.otherWords,
          candidates: s.candidates.slice(0, 60),
          candidates_total: s.candidates.length,
          sources: s.sources.slice(0, 30),
          sinks: s.sinks.slice(0, 30),
          moderation: s.moderation.slice(0, 30),
          notes: s.notes,
        };
        const summary = [
          `Surface for ${a.rejection_id ?? "the pasted rejection"}: ${s.terms.length} term(s) (${s.terms.slice(0, 8).map((t) => t.term).join(", ")}), ${s.candidates.length} candidate(s), ${s.sources.length} AI source(s), ${s.sinks.length} sink(s).`,
          ...moderationLines(s.moderation),
          ...s.candidates.slice(0, 12).map((c) => `- ${c.kind} ${c.value} @ ${c.file}${c.line ? `:${c.line}` : ""}`),
          ...s.notes.slice(0, 4),
          "Next: read the candidate files, trace every source to every sink, then save_spec with only entries you have seen.",
        ];
        return ok(summary.slice(0, 25).join("\n"), { action: a.action, rejection_id: a.rejection_id, result, next: "Trace sources to sinks, then call save_spec with the confirmed spec." });
      }

      if (a.action === "save_spec") {
        if (!a.spec) return fail("save_spec needs spec: {feature, capability, terms, symbols, assets, strings, endpoints, flags, promptFragments, inputPaths, confirmedPaths, metadataSurfaces}. Start from the find_surface draft.");
        const ctx = await loadContext(p.root);
        const v = await validateSpec(ctx, a.spec, { rejectionText: rej!.reviewerMessage, baseRef: a.base_ref });
        if (!v.ok) {
          return fail(`Spec not saved. Fix these entries from what is actually in the code (never add entries you have not seen):\n${v.problems.map((x) => `- ${x}`).join("\n")}${v.warnings.length ? `\nWarnings:\n${v.warnings.map((x) => `- ${x}`).join("\n")}` : ""}`);
        }
        const ev = await appendEvent(location, { type: "residue_spec", rejectionId: rej!.id, spec: a.spec, repo: p.root }, { source: "agent" });
        return ok(`Spec saved as ${ev.id} for ${rej!.id}.${v.warnings.length ? `\nWarnings:\n${v.warnings.slice(0, 10).map((x) => `- ${x}`).join("\n")}` : ""}\nNext: remove the capability on every input path, then verify.`, {
          action: a.action,
          rejection_id: rej!.id,
          result: { event_id: ev.id, warnings: v.warnings },
          next: "Remove the capability across all input paths and store surfaces, then call verify.",
        });
      }

      const spec = specOf();
      if (!spec) return fail(`Rejection ${rej!.id} has no saved spec. Run find_surface, trace, then save_spec first.`);

      if (a.action === "probe_suite") {
        const w = await writeProbeSuite(p.root, rej!.id, spec, { count: a.count });
        return ok(`Wrote ${w.count} probes to ${w.suitePath}.${w.runnerWritten ? ` Runner template: ${w.runnerPath}.` : ` Existing runner kept: ${w.runnerPath}.`}\nThe developer runs it against their own dev backend (this tool makes no network calls), then call ingest_probe_results with results_path.`, {
          action: a.action,
          rejection_id: rej!.id,
          result: w,
          next: "Have the developer run the suite against their dev backend, then call ingest_probe_results.",
        });
      }

      const resultsPath = a.results_path;
      if (resultsPath && !path.isAbsolute(resultsPath)) return fail(`results_path must be absolute; got "${resultsPath}".`);
      if (a.action === "ingest_probe_results") {
        if (!resultsPath) return fail("ingest_probe_results needs results_path: the absolute path of the results JSONL the runner wrote.");
        const ing = await ingestProbeResults(p.root, rej!.id, resultsPath);
        return ok(`${ing.blocked} of ${ing.total} probes blocked (results ${ing.resultsHash.slice(0, 12)}).${ing.failures.length ? `\nNot blocked:\n${ing.failures.slice(0, 10).map((f) => `- ${f.id}: ${f.prompt}`).join("\n")}` : ""}\nThis says nothing about prompts that were not tried. Next: verify with the same results_path to record the tier.`, {
          action: a.action,
          rejection_id: rej!.id,
          result: { total: ing.total, blocked: ing.blocked, results_hash: ing.resultsHash, failures: ing.failures.slice(0, 50) },
          next: "Call verify with results_path to record the probe result with the verification.",
        });
      }

      // verify
      if (a.build_path && (!path.isAbsolute(a.build_path) || !existsSync(a.build_path))) {
        return fail(`build_path must be an absolute path to an existing .ipa, .xcarchive or .app; got "${a.build_path}".`);
      }
      const probe = resultsPath ? await ingestProbeResults(p.root, rej!.id, resultsPath) : undefined;
      const inferred = a.base_ref ? undefined : await inferBaseRef(p.root, state, rej!);
      const baseRef = a.base_ref ?? inferred?.ref;
      const baseNote = inferred
        ? `No base_ref given: diffed against ${inferred.ref.slice(0, 12)} (${inferred.why}). Pass base_ref (the commit of the rejected build) if that is not the pre-fix code.`
        : !baseRef && (await isGitWorkTree(p.root))
          ? `No base_ref given and none could be inferred: ${NO_BASE_REF}. Verify again with base_ref = the commit or tag of the rejected build (ask the developer).`
          : undefined;
      const v = await verifyRemediation(p.root, spec, {
        baseRef,
        builtProductPath: a.build_path,
        probe: probe ? { total: probe.total, blocked: probe.blocked, resultsHash: probe.resultsHash } : rej!.verification?.probe,
        rejectionId: rej!.id,
        rejectionText: rej!.reviewerMessage,
        now: new Date().toISOString(),
      });
      const ev = await appendEvent(location, { type: "verification", rejectionId: rej!.id, verification: v, repo: p.root }, { source: "agent" });
      const summary = [
        `Tier: ${tierLabel(v)} for ${rej!.id} (recorded as ${ev.id}).`,
        v.summary,
        ...v.residue.slice(0, 12).map((h) => `- ${h.status} ${h.kind} "${h.needle}" @ ${h.file}${h.line ? `:${h.line}` : ""}: ${h.reason}`),
        ...v.inputPaths.filter((x) => !x.blocked).slice(0, 5).map((x) => `- input path not blocked: ${x.inputPath}`),
        ...v.unverifiable.slice(0, 4).map((x) => `- unverifiable: ${x}`),
        ...(v.removedConditions ?? []).slice(0, 4).map((c) => `- review-time condition removed: ${c.condition} at ${c.file}${c.line ? `:${c.line}` : ""} (${c.rule})`),
      ];
      if (baseNote) summary.splice(2, 0, baseNote);
      return ok(summary.slice(0, 25).join("\n"), {
        action: a.action,
        rejection_id: rej!.id,
        result: { event_id: ev.id, tier: v.tier, summary: v.summary, residue: v.residue.slice(0, 100), residue_total: v.residue.length, input_paths: v.inputPaths, unverifiable: v.unverifiable, removed_in_diff: v.removedInDiff.slice(0, 50), removed_conditions: v.removedConditions ?? [], base_ref: baseRef ? { ref: baseRef, inferred: Boolean(inferred), why: inferred?.why } : null, built_product: v.builtProduct, probe: v.probe },
        next: `${baseNote && !inferred ? `${baseNote} ` : ""}${v.tier === "RESIDUE_FOUND" || v.tier === "UNVERIFIABLE" ? "Remove the remaining residue and add a filter on every input path that is not blocked (or have the developer fix it server-side and attest), then verify again." : "For generative capabilities, write a probe_suite; then prepare review notes with shield_evidence_pack."}`,
      });
    }),
  );

  // ---- shield_ledger_record
  server.registerTool(
    "shield_ledger_record",
    {
      title: "Record an event in the review ledger",
      description:
        "Append one event to the account-scoped review ledger (keyed by Apple Team ID). Typical types: interpretation {rejectionId, text}, message_sent {purpose, text, rejectionId?} after the developer confirms it was sent, apple_reply {text, rejectionId?, submissionId?}, outcome {outcome: rejected|metadata_rejected|withdrawn|developer_rejected, guidelines, reviewerMessage} (approvals only via shield_ledger_import), note {text}, app {bundleId, name}, ota_publish {channel, message}. id, time, source and textHash are filled in. attestation and ack are human-only and refused here: the developer runs `appstore-shield attest` / `appstore-shield ack` in a terminal.",
      inputSchema: z.object({
        project_path: projectPath,
        force,
        event: z
          .object({ type: z.string().describe("Event type, e.g. interpretation, message_sent, apple_reply, outcome, note") })
          .catchall(z.unknown())
          .describe("The event fields; see the description for each type"),
      }),
      outputSchema: z.object({ event: z.record(z.string(), z.unknown()), team_id: z.string(), ledger_path: z.string() }),
      annotations: { title: "Record ledger event", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    wrap(async ({ project_path, force: forced, event }) => {
      const p = checkProjectPath(project_path, forced);
      if ("error" in p) return fail(p.error);
      if ((HUMAN_ONLY_EVENTS as string[]).includes(event.type)) throw new HumanOnlyEventError(event.type);
      if (["verification", "residue_spec", "config_snapshot", "metadata_snapshot"].includes(event.type)) {
        return fail(`"${event.type}" events are computed by the tools: use shield_remediation (save_spec / verify) or shield_preflight instead of recording them by hand.`);
      }
      // An approval closes open rejections and resets the drift baseline, so it must come from
      // Apple's own message or export, never from an agent's say-so.
      if (event.type === "outcome" && event.outcome === "approved") {
        return fail(
          "Approvals cannot be recorded with shield_ledger_record: they close open rejections and reset the drift baseline. Import Apple's approval message or an `asc review history --output json` export with shield_ledger_import. If the developer has decided to submit despite an open rejection, they run `appstore-shield ack` themselves in a terminal.",
        );
      }
      if (typeof event.at === "string" && Date.parse(event.at) > Date.now() + 10 * 60_000) {
        return fail(`"at" (${event.at}) is in the future. Omit it to use the current time, or pass when the event actually happened.`);
      }
      const location = await locateLedger(p.root);
      const ev = await appendEvent(location, { repo: p.root, ...event }, { source: "agent" });
      return ok(`Recorded ${ev.type} ${ev.id} in ${location.path} (team ${location.teamId}).`, { event: ev as unknown as Record<string, unknown>, team_id: location.teamId, ledger_path: location.path });
    }),
  );

  // ---- shield_ledger_import
  server.registerTool(
    "shield_ledger_import",
    {
      title: "Import App Review messages into the ledger",
      description:
        "Parse App Review rejection, approval, metadata-rejection and termination messages (pasted Resolution Center text, saved emails) or `asc review history|submissions list --output json` exports into proposed ledger events. Preview by default; nothing is stored until commit:true. Duplicates of existing events are flagged and skipped. Approvals are previewed but never stored from here, because they close open rejections: the developer imports Apple's approval with `appstore-shield import <file>` in their own terminal.",
      inputSchema: z.object({
        project_path: projectPath,
        force,
        text: z.string().optional().describe("Pasted message text or JSON export"),
        file_path: z.string().optional().describe("Absolute path to a saved email (.eml/.txt) or asc JSON export"),
        bundle_id: z.string().optional().describe("Bundle id to attach when the message does not name one"),
        commit: z.boolean().default(false).describe("Store the proposed events. Only after the user confirmed the preview."),
      }),
      outputSchema: z.object({
        format: z.string(),
        proposed: z.array(z.object({ type: z.string(), summary: z.string(), duplicate_of: z.string().optional(), event: z.record(z.string(), z.unknown()) })),
        ignored: z.array(z.string()),
        warnings: z.array(z.string()),
        committed: z.array(z.object({ id: z.string(), type: z.string() })),
        team_id: z.string(),
      }),
      annotations: { title: "Import review history", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    wrap(async ({ project_path, force: forced, text: t, file_path, bundle_id, commit }) => {
      const p = checkProjectPath(project_path, forced);
      if ("error" in p) return fail(p.error);
      if (!t && !file_path) return fail("Pass text (the pasted App Review message) or file_path (absolute path to a saved email or asc JSON export).");
      let body = t;
      if (!t && file_path) {
        const read = await readImportFile(file_path);
        if ("error" in read) return fail(read.error);
        body = read.text;
      }
      const { location, state } = await ledgerFor(p.root);
      // A message that names no bundle id belongs to this project's app when the account has no
      // other app on record; the preview says so, so the developer can correct it before commit.
      let bundleId = bundle_id;
      let detected: string | undefined;
      if (!bundleId) {
        const own = detectBundleId(await loadContext(p.root));
        if (own && state.apps.every((a) => a.bundleId === own)) bundleId = detected = own;
      }
      const res = await importAppleData({ text: body }, { bundleId, existing: state.events });
      const future = futureDated(res.proposed);
      if (commit && future.length) {
        return fail(`${future.length} proposed event(s) are dated in the future (${future.map((x) => x.event.at).join(", ")}). App Review messages describe what already happened; check the date in the message. Nothing was stored.`);
      }
      // An MCP caller is the agent, whatever text it passes in: its approvals must not close
      // rejections. Only the developer's own terminal import records source "import".
      const committed = commit ? await commitImport(location, res, { source: "agent" }) : [];
      const lines = [
        `${res.proposed.length} proposed event(s) from ${res.format}${commit ? `; committed ${committed.length}` : " (preview only; call again with commit:true after the user confirms)"}.`,
        ...res.proposed.slice(0, 15).map((x) => `- ${x.event.type}: ${x.summary}${x.duplicateOf ? ` (duplicate of ${x.duplicateOf}, skipped)` : ""}`),
        ...(detected ? [`Events without a bundle id are attached to ${detected}, detected from the project; pass bundle_id to attach them elsewhere.`] : []),
        ...res.warnings.slice(0, 4).map((w) => `Warning: ${w}`),
        ...(res.ignored.length ? [`${res.ignored.length} piece(s) not understood; check the ignored list.`] : []),
      ];
      return ok(lines.slice(0, 25).join("\n"), {
        format: res.format,
        proposed: res.proposed.map((x) => ({ type: x.event.type, summary: x.summary, duplicate_of: x.duplicateOf, event: x.event })),
        // Unrecognized text is echoed back to the agent; keys that happen to be in the input stay out of it.
        ignored: res.ignored.map((s) => clip(redactSecrets(s), 300)!),
        warnings: res.warnings,
        committed: committed.map((e) => ({ id: e.id, type: e.type })),
        team_id: location.teamId,
      });
    }),
  );

  // ---- shield_ledger_query
  server.registerTool(
    "shield_ledger_query",
    {
      title: "Query the review ledger",
      description:
        "Read the account-scoped review ledger. view=status: detected Team ID and how it was found, ledger path and warnings, apps, open rejections, terminations, counts. timeline: recent events. triggers: the 3.2(f) trigger checklist with raw counts and the basis for each (no thresholds). rejection: one rejection with its interpretation, spec, verification, messages and attestations.",
      inputSchema: z.object({
        project_path: projectPath,
        force,
        view: z.enum(["status", "timeline", "triggers", "rejection"]),
        rejection_id: z.string().optional().describe("Required for view=rejection"),
        limit: z.number().int().min(1).max(500).default(50).describe("timeline: number of most recent events"),
      }),
      outputSchema: z.object({ view: z.string(), team_id: z.string(), team_id_source: z.string(), ledger_path: z.string(), warnings: z.array(z.string()), result: z.record(z.string(), z.unknown()) }),
      annotations: { title: "Query ledger", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    wrap(async ({ project_path, force: forced, view, rejection_id, limit }) => {
      const p = checkProjectPath(project_path, forced);
      if ("error" in p) return fail(p.error);
      const { location, state, invalid } = await ledgerFor(p.root);
      const base = { view, team_id: location.teamId, team_id_source: location.teamIdSource, ledger_path: location.path, warnings: [...location.warnings, ...invalid.map((i) => `Ledger line ${i.line} skipped${i.torn ? " (torn final line)" : ""}: ${i.error}`)] };
      const head = `Team ${location.teamId} (${location.teamIdSource}); ledger ${location.path}.`;
      const now = new Date().toISOString();
      if (view === "status") {
        const open = openRejections(state);
        const result = {
          events: state.events.length,
          apps: state.apps,
          submissions: state.submissions.length,
          rejections: state.rejections.length,
          open_rejections: open,
          approvals: state.outcomes.filter((o) => o.outcome === "approved").length,
          terminations: state.terminations.map((t) => ({ id: t.id, at: t.at })),
          ota_publishes: state.otaPublishes.length,
        };
        const lines = [
          head,
          ...base.warnings.slice(0, 4).map((w) => `Warning: ${w}`),
          `${state.events.length} event(s): ${state.submissions.length} submission(s), ${state.rejections.length} rejection(s), ${result.approvals} approval(s), ${state.terminations.length} termination notice(s).`,
          ...open.slice(0, 10).map((o) => `Open rejection ${o.id} (${o.guidelines.join(", ") || "no guideline"}, ${o.at.slice(0, 10)}): ${o.tier ?? "not verified"}${o.acked ? ", acknowledged" : ""}`),
          ...(state.events.length ? [] : ["The ledger is empty: import past App Review messages with shield_ledger_import."]),
        ];
        return ok(lines.slice(0, 25).join("\n"), { ...base, result });
      }
      if (view === "timeline") {
        const events = state.events.slice(-limit).map((e) => {
          const { id, at, type, source, bundleId } = e;
          const extra = e.type === "outcome" ? `${e.outcome} ${e.guidelines.join(", ")}` : e.type === "message_sent" ? e.purpose : e.type === "verification" ? tierLabel(e.verification) : e.type === "config_snapshot" ? `${e.kind} ${e.label}` : "";
          return { id, at, type, source, bundleId, summary: extra };
        });
        const lines = [head, ...events.slice(-20).map((e) => `${e.at.slice(0, 10)} ${e.type}${e.summary ? ` ${e.summary}` : ""} [${e.source}] ${e.id}`)];
        return ok(lines.slice(0, 25).join("\n"), { ...base, result: { total: state.events.length, events } });
      }
      if (view === "triggers") {
        const items = triggerChecklist(state, now);
        const lines = [head, "Raw counts with their basis; there are no published thresholds.", ...items.map((i) => `- ${i.title}: ${i.count} (${labelText(i.label)}${i.contextOnly ? ", context only" : ""})`)];
        return ok(lines.slice(0, 25).join("\n"), { ...base, result: { items } });
      }
      const r = findRejection(state, rejection_id);
      if (!r) return fail(unknownRejection(state, rejection_id));
      const lines = [
        head,
        `Rejection ${r.id} on ${r.at.slice(0, 10)}${r.bundleId ? ` (${r.bundleId})` : ""}: ${r.guidelines.join(", ") || "no guideline cited"}; ${r.approvedBy ? `approved later by ${r.approvedBy}` : "open"}.`,
        `Interpretation: ${r.interpretation ? clip(r.interpretation, 200) : "none recorded"}.`,
        `Spec: ${r.spec ? `${r.spec.feature} (${r.spec.terms.length} terms, ${r.spec.inputPaths.length} input paths)` : "none saved"}. Verification: ${r.verification ? tierLabel(r.verification) : "none"}.`,
        `Messages sent: ${r.messages.length}; Apple replies: ${r.appleReplies.length}; attestations: ${r.attestations.length}; acknowledged: ${r.acked ? "yes" : "no"}.`,
      ];
      return ok(lines.join("\n"), { ...base, result: { rejection: r as unknown as Record<string, unknown> } });
    }),
  );

  // ---- shield_evidence_pack
  server.registerTool(
    "shield_evidence_pack",
    {
      title: "Evidence pack for notes, replies and appeals",
      description:
        "Typed facts (each with its ledger event id) plus a purpose-specific section scaffold and byte budget, for review_notes, reply, clarification, appeal_review_board or appeal_termination. Includes what must be disclosed from the repo inventory (remote config, OTA, AI services). Appeal packs add privateHypotheses: guesses for the developer only, never to be pasted into anything sent to Apple. Write the text from these facts, then lint it with shield_lint_text.",
      inputSchema: z.object({
        project_path: projectPath,
        force,
        purpose: z.enum(PURPOSES),
        rejection_id: z.string().optional(),
        letter: z.string().optional().describe("Termination or notice letter text, for appeal purposes"),
      }),
      outputSchema: z.object({
        purpose: z.string(),
        facts: z.array(z.object({ id: z.string(), text: z.string(), eventId: z.string().optional(), kind: z.string() })),
        scaffold: z.array(z.object({ section: z.string(), guidance: z.string() })),
        byteBudget: z.number().nullable(),
        privateHypotheses: z.unknown().optional(),
        warnings: z.array(z.string()),
      }),
      annotations: { title: "Evidence pack", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    wrap(async ({ project_path, force: forced, purpose, rejection_id, letter }) => {
      const p = checkProjectPath(project_path, forced);
      if ("error" in p) return fail(p.error);
      const { state } = await ledgerFor(p.root);
      if (rejection_id && !findRejection(state, rejection_id)) return fail(unknownRejection(state, rejection_id));
      const scan = await runScan(p.root);
      const open = scan.findings.filter((f) => f.severity === "block" || f.severity === "high");
      const pack = evidencePack(state, purpose as EvidencePurpose, { rejectionId: rejection_id, letter, inventory: disclosureInventory(scan), findings: open, now: new Date().toISOString() });
      // evidencePack only ties findings to a cited rejection guideline; a first submission's notes
      // must not describe a missing safeguard either.
      for (const g of safeguardGaps(scan.findings)) {
        if (g.finding.severity === "medium" || pack.warnings.some((w) => w.includes(g.finding.rule))) continue;
        pack.warnings.push(`The scan still reports ${g.finding.rule}${g.finding.file ? ` at ${g.finding.file}${g.finding.line ? `:${g.finding.line}` : ""}` : ""}: the text must not say the app has ${g.what} until the finding is fixed.`);
      }
      // A removed review-time condition is a fact only a diff can produce; an empty list from a
      // verification that had no pre-fix commit must not read as "nothing to disclose".
      const unDiffed = state.rejections.filter((r) => (rejection_id ? r.id === rejection_id : !r.approvedBy) && r.verification && !r.verification.baseRef);
      if (unDiffed.length && (await isGitWorkTree(p.root))) {
        pack.warnings.push(`The verification of ${unDiffed.map((r) => r.id).join(", ")} ran without base_ref: ${NO_BASE_REF}. Run shield_remediation verify again with base_ref = the commit or tag of the rejected build before writing the text.`);
      }
      const lines = [
        `${pack.facts.length} fact(s) for ${purpose}${pack.byteBudget ? `; budget ${pack.byteBudget} bytes` : ""}.`,
        ...pack.facts.slice(0, 12).map((f) => `- [${f.id}${f.eventId ? ` ${f.eventId}` : ""}] ${clip(f.text, 160)}`),
        `Sections: ${pack.scaffold.map((s) => s.section).join(" → ")}.`,
        ...pack.warnings.slice(0, 6).map((w) => `Warning: ${w}`),
        ...(pack.privateHypotheses ? ["privateHypotheses are for the developer only. Never paste them into anything sent to Apple."] : []),
        `Next: draft from these facts only, then shield_lint_text with ${rejection_id ? `rejection_id ${rejection_id}` : "fact_ids set to the event ids (ev_…) of the facts you used"}.`,
      ];
      return ok(lines.slice(0, 25).join("\n"), pack as unknown as Record<string, unknown>);
    }),
  );

  // ---- shield_lint_text
  server.registerTool(
    "shield_lint_text",
    {
      title: "Lint text before it goes to Apple",
      description:
        "Lint review notes, Resolution Center replies, clarification questions and appeals before they are sent: review notes over 4000 bytes, absolute claims not backed by PROBED 100% plus a clean build, attestations not worded as the developer's statement, pasted secrets, combative or legalistic tone, generic change descriptions (2.3.1(a)), undisclosed remote config / OTA / AI services found in the repo, safeguards (report, block, moderation, age gate, AI-sharing consent, account deletion, Restore Purchases) the scan reports missing, speculative admissions in appeals. Admissions count as confirmed only through attestations the developer recorded with `appstore-shield attest`. Fix every error and lint again.",
      inputSchema: z.object({
        project_path: projectPath,
        force,
        purpose: z.enum(PURPOSES),
        text: z.string().max(65536).describe("The text to lint, up to 64 KB"),
        rejection_id: z.string().optional().describe("The rejection this text answers; its verification decides which claims are backed"),
        fact_ids: z.array(z.string()).optional().describe("Ledger event ids (each fact's eventId in shield_evidence_pack, ev_…) that the text relies on; they pick which rejection's verification backs the text when rejection_id is not given. Pack-local F-numbers identify nothing and are reported back"),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
        bytes: z.number(),
        byteLimit: z.number().nullable(),
        issues: z.array(z.object({ rule: z.string(), severity: z.enum(["error", "warning"]), excerpt: z.string(), message: z.string(), fix: z.string() })),
      }),
      annotations: { title: "Lint outgoing text", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    wrap(async ({ project_path, force: forced, purpose, text: body, rejection_id, fact_ids }) => {
      const p = checkProjectPath(project_path, forced);
      if ("error" in p) return fail(p.error);
      const { state } = await ledgerFor(p.root);
      if (rejection_id && !findRejection(state, rejection_id)) return fail(unknownRejection(state, rejection_id));
      const scanned = await textScan(p.root);
      const base = lintText({ purpose: purpose as EvidencePurpose, text: body, inventory: scanned.inventory, state, strongestTier: tierFor(state, rejection_id, fact_ids), findings: scanned.findings });
      const issues: { rule: string; severity: "error" | "warning"; excerpt: string; message: string; fix: string }[] = [...base.issues, ...safeguardClaimIssues(body, scanned.findings, { aiOnlyNoBlock: scanned.aiOnlyNoBlock })];
      const facts = rejection_id ? undefined : rejectionForFacts(state, fact_ids);
      // An input that silently matched nothing would let the latest rejection's tier back the text instead.
      if (facts && !facts.rejection && facts.unresolved.length) {
        issues.push({
          rule: "fact_ids_unresolved",
          severity: "warning",
          excerpt: facts.unresolved.slice(0, 5).join(", "),
          message: "None of these fact_ids is a ledger event id tied to a rejection, so they did not pick which verification backs the text.",
          fix: "Pass rejection_id, or the eventId values (ev_…) of the shield_evidence_pack facts the text uses.",
        });
      }
      const res = { ...base, issues, ok: !issues.some((i) => i.severity === "error") };
      const lines = [
        `${res.ok ? "OK" : "Not ready"}: ${res.issues.filter((i) => i.severity === "error").length} error(s), ${res.issues.filter((i) => i.severity === "warning").length} warning(s); ${res.bytes} bytes${res.byteLimit ? ` of ${res.byteLimit}` : ""}.`,
        ...res.issues.slice(0, 20).map((i) => `- [${i.severity}] ${i.rule}: "${clip(i.excerpt, 80)}" → ${i.fix}`),
      ];
      return ok(lines.slice(0, 25).join("\n"), res as unknown as Record<string, unknown>);
    }),
  );

  // ---- resources
  server.registerResource(
    "playbook",
    "shield://playbook",
    { title: "Playbook", description: "Mechanisms M1–M12 behind rejections and 3.2(f) terminations, with source/apple/inferred labels, and the operating rules", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: await reference("playbook.md") }] }),
  );
  server.registerResource(
    "guidelines",
    "shield://guidelines",
    { title: "Guideline map", description: "App Review Guideline / DPLA section → check id → what a complete fix looks like", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: await reference("guidelines-map.md") }] }),
  );
  server.registerResource(
    "checks",
    "shield://checks",
    { title: "Check catalog", description: "Every shield_scan check with its guidelines", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: checksCatalog() }] }),
  );

  // ---- prompts
  const promptArgs = { project_path: z.string().describe("Absolute path of the app repo") };
  server.registerPrompt(
    "preflight",
    { title: "Pre-submission check", description: "Gate, fix and write linted review notes before submitting", argsSchema: promptArgs },
    ({ project_path }) => ({
      messages: [{ role: "user", content: { type: "text", text: `Run shield_preflight on ${project_path}. If HOLD, explain each reason and fix by removing or disclosing, never by hiding; do not submit. Otherwise get shield_evidence_pack (review_notes), draft the notes from its facts, lint with shield_lint_text until clean, and walk me through the manual checklist. Record nothing as sent until I confirm.` } }],
    }),
  );
  server.registerPrompt(
    "remediate",
    { title: "Remediate a rejection", description: "Remove a rejected capability on every input path and verify it", argsSchema: { ...promptArgs, rejection: z.string().optional().describe("Rejection id, or the pasted App Review message") } },
    ({ project_path, rejection }) => ({
      messages: [{ role: "user", content: { type: "text", text: `Help me remediate an App Store rejection in ${project_path}. ${rejection ? `Rejection: ${rejection}. ` : ""}Make sure it is in the ledger (shield_ledger_query status; shield_ledger_import if not), write a capability-level interpretation, draft a clarifying question in parallel, then shield_remediation find_surface → trace sources to sinks → save_spec → remove the capability across every input path and store surface → verify until at least STATIC_CLEAN → probe_suite for AI capabilities. Never hide, rename or flag-gate the feature.` } }],
    }),
  );
  server.registerPrompt(
    "respond",
    { title: "Reply to App Review", description: "A calm, specific Resolution Center reply or clarification question", argsSchema: { ...promptArgs, rejection_id: z.string().optional() } },
    ({ project_path, rejection_id }) => ({
      messages: [{ role: "user", content: { type: "text", text: `Draft a Resolution Center reply or clarification question for ${rejection_id ? `rejection ${rejection_id}` : "my latest rejection"} in ${project_path}. Use shield_evidence_pack (reply or clarification), keep it calm and specific without arguing, offer to request a call with App Review, and lint it with shield_lint_text until clean.` } }],
    }),
  );
  server.registerPrompt(
    "appeal",
    { title: "Appeal", description: "App Review Board appeal or reinstatement request after a 3.2(f) termination", argsSchema: { ...promptArgs, letter: z.string().optional().describe("The notice or termination letter") } },
    ({ project_path, letter }) => ({
      messages: [{ role: "user", content: { type: "text", text: `Help me with an appeal for the developer account behind ${project_path}.${letter ? ` The letter: ${letter}` : ""} Decide first whether this is an App Review Board appeal (rejection, or account facing termination) or a reinstatement request (already terminated). Use shield_ledger_query timeline and shield_evidence_pack (appeal_review_board or appeal_termination). Apologize only for mistakes I confirm one by one and record myself with appstore-shield attest in my terminal, explain how each happened and the plan to prevent it, and politely ask Apple to identify the conduct. Keep private hypotheses out of the text. Lint with shield_lint_text. Suggest counsel.` } }],
    }),
  );

  return server;
}

export async function startStdioServer(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error(`appstore-shield ${VERSION} MCP server on stdio`);
}

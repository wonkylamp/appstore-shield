#!/usr/bin/env node
import { createRequire as __shieldCreateRequire } from "node:module";
const require = __shieldCreateRequire(import.meta.url);
import {
  VERSION
} from "./chunks/chunk-J73L7BNZ.js";
import {
  MAX_HOOK_COMMAND,
  agentEnvironment,
  bashLedgerWrite,
  classifyCommand,
  clearedEnvironment,
  deliverConfigSubmit,
  detachedCliRun,
  fastfileLanes,
  fastlaneLane,
  fileToolDecision,
  hookOutput,
  humanOnlyRun,
  isSubmitMcpTool,
  lineageProblem,
  looseOta,
  looseSubmit,
  nonProductionChannel,
  readCapped,
  resolveGateRoot,
  scriptFileHit
} from "./chunks/chunk-NOEU6W5P.js";
import {
  CHECK_IDS
} from "./chunks/chunk-NJWBMBWQ.js";
import "./chunks/chunk-XC6NGD3F.js";

// src/cli.ts
import { execFileSync, spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
var lazy = {
  finding: () => import("./chunks/finding-UBQ5ZU5M.js"),
  format: () => import("./chunks/format-L7JDI4WW.js"),
  importer: () => import("./chunks/import-CT33RXK2.js"),
  store: () => import("./chunks/store-DSLNVEOQ.js"),
  triggers: () => import("./chunks/triggers-WC5SZ3DT.js"),
  preflight: () => import("./chunks/preflight-UVP2IAUV.js")
};
var SPECS = {
  scan: { values: ["project", "checks", "paths"], bools: ["include-tests", "full", "json", "force"], positional: "project" },
  preflight: { values: ["project", "build", "version", "build-number", "bundle-id"], bools: ["no-record", "full", "json", "force"], positional: "project" },
  gate: { values: ["project"], bools: ["json", "force"], positional: "project" },
  status: { values: ["project"], bools: ["json"], positional: "project" },
  import: { values: ["project", "bundle-id"], bools: ["commit", "json"], positional: "file" },
  attest: { values: ["project", "rejection", "statement"], bools: [], positional: "none" },
  ack: { values: ["project", "rejection", "note"], bools: [], positional: "none" },
  lint: { values: ["project", "purpose", "rejection", "fact-ids"], bools: ["json", "force"], positional: "file" },
  hook: { values: [], bools: [], positional: "none" },
  mcp: { values: [], bools: [], positional: "none" }
};
function parseArgs(cmd, argv) {
  const spec = SPECS[cmd];
  const more = `Run appstore-shield ${cmd} --help.`;
  const positional = [];
  const flags = /* @__PURE__ */ new Map();
  let onlyPositional = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (onlyPositional || !a.startsWith("-") || a === "-") {
      positional.push(a);
      continue;
    }
    if (a === "--") {
      onlyPositional = true;
      continue;
    }
    if (!a.startsWith("--")) throw new UsageError(`Unknown option ${a}. ${more}`);
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (flags.has(name)) throw new UsageError(`--${name} was given more than once. ${more}`);
    if (spec.values.includes(name)) {
      let v = eq > 0 ? a.slice(eq + 1) : argv[i + 1];
      if (eq < 0) {
        if (v !== void 0 && !v.startsWith("--")) i++;
        else v = void 0;
      }
      if (v === void 0 || !v.trim()) throw new UsageError(`--${name} needs a value (an empty one usually means an unset shell variable). ${more}`);
      flags.set(name, v);
    } else if (spec.bools.includes(name)) {
      if (eq > 0) throw new UsageError(`--${name} does not take a value. ${more}`);
      flags.set(name, true);
    } else {
      throw new UsageError(`Unknown option --${name} for ${cmd}. ${more}`);
    }
  }
  const allowed = spec.positional === "none" ? 0 : 1;
  if (positional.length > allowed) {
    throw new UsageError(`Unexpected argument${positional.length - allowed > 1 ? "s" : ""}: ${positional.slice(allowed).join(" ")}. ${more}`);
  }
  if (spec.positional === "project" && positional.length === 1) {
    if (flags.has("project")) throw new UsageError(`Pass the project once: either ${positional[0]} or --project ${flags.get("project")}.`);
    flags.set("project", positional.shift());
  }
  return { positional, flags };
}
var LINT_PURPOSES = ["review_notes", "reply", "clarification", "appeal_review_board", "appeal_termination"];
var MAX_LINT_CHARS = 64 * 1024;
var HELP = {
  main: `appstore-shield ${VERSION}: local, offline App Review / 3.2(f) helper for iOS, SwiftUI and React Native/Expo apps.

Usage: appstore-shield <command> [options]

Commands:
  scan       Static checks; findings grouped by rule
  preflight  Gate verdict, drift, triggers and manual checklist; records config snapshots
  gate       Exit 1 on HOLD (for fastlane, EAS, CI)
  status     Ledger location, open rejections, trigger counts
  import     Parse an App Review message or asc JSON export into the ledger
  attest     Human-only: record a statement (terminal + typed confirmation)
  ack        Human-only: acknowledge an open rejection (terminal + typed confirmation)
  lint       Lint Notes for Review, a reply or an appeal before it goes to Apple (exit 1 on errors)
  hook       Claude Code PreToolUse hook (reads JSON on stdin)
  mcp        Run the MCP server on stdio

Run appstore-shield <command> --help for options. No command contacts Apple or the network.
Exit codes: 0 success (gate: CLEAR or WARN), 1 gate HOLD or an error, 2 usage error.`,
  scan: `Usage: appstore-shield scan [DIR | --project DIR] [--checks a,b] [--paths p,q] [--include-tests] [--full] [--json] [--force]

  DIR, --project DIR
                    App repo root (default: current directory)
  --checks a,b      Only these checks: ${CHECK_IDS.join(", ")}
  --paths p,q       Only these repo-relative files or directories
  --include-tests   Also scan test sources
  --full            Print every finding with why/fix
  --json            Machine-readable output
  --force           Scan even when no iOS, SwiftUI or React Native/Expo project is detected`,
  preflight: `Usage: appstore-shield preflight [DIR | --project DIR] [--build PATH] [--version V --build-number N [--bundle-id ID]] [--no-record] [--full] [--json] [--force]

  DIR, --project DIR  App repo root (default: current directory)
  --build PATH        Local .ipa / .xcarchive / .app to sweep for residue of open rejections
  --version, --build-number
                      Record a submission event for this version and build (only after you submitted)
  --bundle-id ID      Bundle id for the submission event (default: detected)
  --no-record         Do not append config/metadata snapshot events
  --full              Print every HOLD reason, warning and finding (default: the first few)
  --json              Machine-readable output
  --force             Run even when no iOS, SwiftUI or React Native/Expo project is detected`,
  gate: `Usage: appstore-shield gate [DIR | --project DIR] [--json] [--force]

Exits 1 on HOLD, 0 on CLEAR or WARN, 2 on a usage error. Appends nothing to the ledger. HOLD only on
deterministic conditions: a block finding, an open rejection below STATIC_CLEAN without a human
ack (or verified clean earlier but below STATIC_CLEAN when its saved spec is swept again now), a
high finding under a guideline an open rejection cites, a check that failed, or undisclosed
post-approval drift that touches content or price. CLEAR and WARN print a not-a-guarantee
caveat under the verdict. A directory with no iOS,
SwiftUI or React Native/Expo project is refused (exit 2) rather than reported CLEAR; --force
gates it anyway. Any error exits non-zero, so a broken gate never reads as a pass.`,
  status: `Usage: appstore-shield status [DIR | --project DIR] [--json]`,
  import: `Usage: appstore-shield import <file> [--project DIR] [--bundle-id ID] [--commit] [--json]

Parses a saved App Review email / Resolution Center text or an asc JSON export and shows the
proposed ledger events. Stores them with --commit, or after you confirm in a terminal.
Approvals close open rejections, so storing one needs the same human check as attest: an
interactive terminal you opened yourself, outside any AI agent session, and a typed one-time
code. Anywhere else (an agent, CI, a detached job) approvals are shown but not stored.`,
  attest: `Usage: appstore-shield attest [--project DIR] [--rejection ID] [--statement TEXT]

Human-only. Records a statement you make (e.g. that a server-side prompt was removed), worded
"The developer states \u2026". Needs an interactive terminal that no AI agent process started and a
typed confirmation that includes a one-time code.`,
  ack: `Usage: appstore-shield ack --rejection ID [--project DIR] [--note TEXT]

Human-only. Acknowledges an open rejection so the gate no longer holds on it. Use it only when you
have decided, as the developer, to submit without a STATIC_CLEAN verification. Needs an
interactive terminal outside any AI agent session and a typed confirmation that includes a
one-time code. This check deters agents; it is not a security boundary against a program
running with your own user account.`,
  lint: `Usage: appstore-shield lint FILE|- [--project DIR] [--purpose P] [--rejection ID] [--fact-ids a,b] [--json] [--force]

Lints text before it is sent to Apple, with the same checks as the shield_lint_text MCP tool:
review notes over 4000 bytes, claims the ledger's verification does not back, attestations not
worded as the developer's statement, pasted secrets, combative tone, generic change descriptions
(2.3.1(a)), and remote config, OTA or AI services found in the repo that the text does not disclose.
Reads FILE (at most 64 KB), or stdin with -. Exits 1 when there is an error, 0 when there are
only warnings or none, 2 on a usage error, so CI can lint
fastlane/metadata/review_information/notes.txt before a submission.

  --project DIR     App repo root (default: current directory)
  --purpose P       ${LINT_PURPOSES.join(", ")} (default: review_notes)
  --rejection ID    The rejection this text answers; its verification decides which claims are backed
  --fact-ids a,b    Ledger event ids (ev_\u2026) the text relies on, when --rejection is not given
  --json            Machine-readable output
  --force           Lint even when no iOS, SwiftUI or React Native/Expo project is detected`,
  hook: `Usage: appstore-shield hook   (reads Claude Code PreToolUse JSON on stdin)

Gates submit-for-review commands (asc review submit, asc review submissions-submit,
asc review submissions-update --submitted=true, asc publish appstore --submit, fastlane deliver
submit_for_review:true, fastlane *release*/*submit* lanes and Fastfile lanes that submit, App Store
Connect API reviewSubmissions calls, also inside bash -c, eval, subshells, shell variables, a
script file or -c/-e code the command runs, package.json scripts, make targets, just recipes and
asc workflow run steps) and App Store Connect MCP tools that submit for review or create a review
submission. HOLD \u2192 exit 2 with reasons on stderr; WARN \u2192 asks.
Over-the-air publishes (eas update, expo publish, appcenter codepush release*/promote,
code-push release*, shorebird patch, hot-updater deploy) skip App Review: a gate HOLD, or a
rejected-then-approved capability back in the code, holds them (exit 2); otherwise they ask with
a 2.5.2 reminder. A channel named dev/preview/staging asks instead of holding. A lane named like a release lane whose Fastfile shows it does not submit \u2192 asks.
Wrapped forms count: timeout, nice, caffeinate, sudo, env, op/doppler/infisical run, dotenv,
npx, find -exec, xargs and the like run the command behind them. A command handed to a terminal
window or multiplexer (osascript do script, open -a Terminal, tmux send-keys/new-window, screen)
\u2192 asks, and the command it hands over is checked too. Agent-run attest/ack in the spellings it recognises \u2192 denied; this CLI run through
env -i, setsid, nohup, a background job or a pty driver \u2192 denied or asks; agent writes to the
ledger or anywhere in the shield home \u2192 denied; creating or editing .appstore-shield config or
baseline \u2192 asks. Appends nothing to the ledger: the
command has not run yet. Commands over 64 KB are not parsed; they ask, as does a command that
runs more scripts or tasks than the hook checks in one call (8 task files, 64 texts, 15 s).
The gate runs for the session's project and for any directory the command cd's into; a HOLD in
either holds. A gate that does not finish within 20 s asks instead of letting the command through.
Uploads (altool, iTMSTransporter, eas submit, asc builds upload) are not gated.
This is a guardrail for a cooperative agent, not a sandbox: see SECURITY.md.`,
  mcp: `Usage: appstore-shield mcp   (MCP server on stdio)`
};
function projectOf(a) {
  const p = a.flags.get("project");
  const root = path.resolve(typeof p === "string" ? p : process.cwd());
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new UsageError(`--project ${root} is not a directory. Pass the app repo root.`);
  }
  return root;
}
var UsageError = class extends Error {
};
var MAX_MANIFEST_BYTES = 1024 * 1024;
function noAppError(cmd, root) {
  return new UsageError(
    `no iOS, SwiftUI or React Native/Expo project found in ${root} (no .xcodeproj, .xcworkspace, Package.swift, .swift files, or react-native/expo in package.json or app.json). Pass the app repo root (appstore-shield ${cmd} DIR), or add --force to ${cmd} this directory anyway.`
  );
}
async function appProjectOf(cmd, a) {
  const root = projectOf(a);
  const { looksLikeApp } = await lazy.preflight();
  if (!a.flags.has("force") && !looksLikeApp(root)) throw noAppError(cmd, root);
  return root;
}
function requireDetectedPlatform(cmd, a, root, platforms) {
  if (!a.flags.has("force") && !platforms.length) throw noAppError(cmd, root);
}
function list(v) {
  return typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : void 0;
}
function scanJson(scan) {
  const { ctx: _ctx, ...rest } = scan;
  return rest;
}
function preflightJson(r) {
  const { scan, state: _state, location: _location, ...rest } = r;
  return { ...rest, findings: scan.findings, counts: scan.counts, suppressed: scan.suppressed.length };
}
function print(s) {
  process.stdout.write(`${s}
`);
}
async function cmdScan(a) {
  const checks = list(a.flags.get("checks"));
  const bad = checks?.filter((c) => !CHECK_IDS.includes(c));
  if (bad?.length) throw new UsageError(`Unknown check(s): ${bad.join(", ")}. Known: ${CHECK_IDS.join(", ")}.`);
  const { runScan } = await lazy.preflight();
  const { scanSummary } = await lazy.format();
  const { formatFindings } = await lazy.finding();
  const root = await appProjectOf("scan", a);
  const paths = scanPaths(root, list(a.flags.get("paths")));
  const scan = await runScan(root, { checks, paths, includeTests: a.flags.has("include-tests") });
  if (!paths) requireDetectedPlatform("scan", a, root, scan.platforms);
  else {
    const seen = [...scan.ctx.files.map((f) => f.path), ...(scan.ctx.skipped ?? []).map((f) => f.path)];
    const empty = paths.filter((p) => !seen.some((f) => f === p || f.startsWith(`${p}/`)));
    if (empty.length) {
      throw new UsageError(`--paths ${empty.join(", ")} matched no source file the scan reads${a.flags.has("include-tests") ? "" : " (test sources need --include-tests)"}. Check the path; it is relative to ${root}.`);
    }
  }
  if (a.flags.has("json")) print(JSON.stringify(scanJson(scan), null, 2));
  else {
    print(scanSummary(scan, 200));
    if (a.flags.has("full")) print(`
${formatFindings(scan.findings)}`);
    else if (scan.findings.length) print("\nRun with --full for why/fix on every finding.");
  }
  return 0;
}
function scanPaths(root, raw) {
  if (!raw) return void 0;
  if (!raw.length) throw new UsageError("--paths needs at least one repo-relative file or directory.");
  const out = [];
  const outside = [];
  const missing = [];
  for (const p of raw) {
    const rel = path.relative(root, path.resolve(root, p));
    if (rel.startsWith("..") || path.isAbsolute(rel)) outside.push(p);
    else if (!existsSync(path.join(root, rel))) missing.push(p);
    else out.push(rel === "" ? "." : rel.split(path.sep).join("/"));
  }
  if (outside.length) throw new UsageError(`--paths ${outside.join(", ")} ${outside.length === 1 ? "is" : "are"} outside the project ${root}. Pass paths inside the repo, relative to its root.`);
  if (missing.length) throw new UsageError(`--paths ${missing.join(", ")} ${missing.length === 1 ? "does" : "do"} not exist in ${root}. Paths are relative to the repo root.`);
  return out.includes(".") ? void 0 : out;
}
async function cmdPreflight(a) {
  const version = a.flags.get("version");
  const build = a.flags.get("build-number");
  if (typeof version === "string" !== (typeof build === "string")) throw new UsageError("Pass both --version and --build-number to record a submission.");
  const buildPath = a.flags.get("build");
  const { runPreflight } = await lazy.preflight();
  const { preflightSummary } = await lazy.format();
  const { formatFindings } = await lazy.finding();
  const root = await appProjectOf("preflight", a);
  const r = await runPreflight(root, {
    buildPath: typeof buildPath === "string" ? path.resolve(buildPath) : void 0,
    recordSubmission: typeof version === "string" && typeof build === "string" ? { version, build, bundleId: a.flags.get("bundle-id") || void 0 } : void 0,
    record: !a.flags.has("no-record"),
    source: preflightSource()
  });
  requireDetectedPlatform("preflight", a, root, r.scan.platforms);
  if (a.flags.has("json")) {
    print(JSON.stringify(preflightJson(r), null, 2));
    return 0;
  }
  const full = a.flags.has("full");
  print(preflightSummary(r, 60));
  if (full) {
    if (r.gate.holdReasons.length) print(`
All HOLD reasons (${r.gate.holdReasons.length}):
${r.gate.holdReasons.map((h) => `- ${h}`).join("\n")}`);
    if (r.gate.warnings.length) print(`
All warnings (${r.gate.warnings.length}):
${r.gate.warnings.map((w) => `- ${w}`).join("\n")}`);
  } else if (r.gate.holdReasons.length > 8 || r.gate.warnings.length > 5) {
    print("Run with --full to list every HOLD reason and warning.");
  }
  if (r.scan.findings.length) {
    print(full ? "\nFindings:" : "\nTop findings:");
    print(formatFindings(full ? r.scan.findings : r.scan.findings.slice(0, 10)));
  }
  print("\nManual checklist:");
  for (const m of r.manualChecklist) print(`- [ ] ${m.item} (${m.guideline})`);
  return 0;
}
function preflightSource() {
  if (agentEnvironment()) return "agent";
  const table = processTable();
  if (table && agentAncestor(table)) return "agent";
  return process.stdin.isTTY ? "human" : "ci";
}
async function cmdGate(a) {
  const { runPreflight } = await lazy.preflight();
  const root = await appProjectOf("gate", a);
  const r = await runPreflight(root, { record: false, source: "ci" });
  requireDetectedPlatform("gate", a, root, r.scan.platforms);
  const code = r.gate.verdict === "CLEAR" || r.gate.verdict === "WARN" ? 0 : 1;
  process.exitCode = code;
  if (a.flags.has("json")) print(JSON.stringify({ verdict: r.gate.verdict, holdReasons: r.gate.holdReasons, warnings: r.gate.warnings, coverage: r.coverage }, null, 2));
  else {
    const { gateCaveat, coverageNotes } = await lazy.format();
    print(`appstore-shield gate: ${r.gate.verdict}`);
    if (code === 0) print(gateCaveat(r.gate.verdict));
    for (const h of r.gate.holdReasons) print(`HOLD: ${h}`);
    for (const w of r.gate.warnings) print(`WARN: ${w}`);
    for (const n of coverageNotes(r.coverage)) if (!r.gate.warnings.includes(n)) print(`NOTE: ${n}`);
  }
  return code;
}
async function cmdStatus(a) {
  const { locateLedger, loadState } = await lazy.store();
  const { openRejections } = await lazy.preflight();
  const { triggerChecklist } = await lazy.triggers();
  const { labelText } = await lazy.format();
  const loc = await locateLedger(projectOf(a));
  const { state, invalid } = await loadState(loc);
  const open = openRejections(state);
  const triggers = triggerChecklist(state, (/* @__PURE__ */ new Date()).toISOString());
  if (a.flags.has("json")) {
    print(JSON.stringify({ teamId: loc.teamId, teamIdSource: loc.teamIdSource, ledgerPath: loc.path, warnings: loc.warnings, invalidLines: invalid, openRejections: open, triggers }, null, 2));
    return 0;
  }
  print(`Team ${loc.teamId} (${loc.teamIdSource})
Ledger: ${loc.path}`);
  for (const w of loc.warnings) print(`Warning: ${w}`);
  for (const i of invalid) print(`Warning: ledger line ${i.line} skipped${i.torn ? " (torn)" : ""}: ${i.error}`);
  print(`${state.events.length} event(s); ${state.rejections.length} rejection(s), ${open.length} open; ${state.terminations.length} termination notice(s).`);
  for (const o of open) print(`- open ${o.id} ${o.at.slice(0, 10)} ${o.guidelines.join(", ") || "(no guideline)"}: ${o.tier ?? "not verified"}${o.acked ? ", acknowledged" : ""}`);
  print("\nTrigger checklist (raw counts; no published thresholds):");
  for (const t of triggers) print(`- ${t.title}: ${t.count} (${labelText(t.label)})`);
  return 0;
}
async function ask(q, toStderr = false) {
  const rl = createInterface({ input: process.stdin, output: toStderr ? process.stderr : process.stdout });
  try {
    return (await rl.question(q)).trim();
  } finally {
    rl.close();
  }
}
async function cmdImport(a) {
  const file = a.positional[0];
  if (!file) throw new UsageError("Pass the file to import: appstore-shield import <file>.");
  const { locateLedger, loadState } = await lazy.store();
  const { importAppleData, commitImport, isFutureDated } = await lazy.importer();
  const loc = await locateLedger(projectOf(a));
  const { state } = await loadState(loc);
  const res = await importAppleData({ filePath: path.resolve(file) }, { bundleId: a.flags.get("bundle-id") || void 0, existing: state.events });
  const json = a.flags.has("json");
  if (json && !a.flags.has("commit")) {
    print(JSON.stringify(res, null, 2));
    return 0;
  }
  const say = json ? () => {
  } : print;
  const done = (stored2, warnings, code) => {
    if (json) print(JSON.stringify({ teamId: loc.teamId, ledgerPath: loc.path, format: res.format, proposed: res.proposed, warnings, ignored: res.ignored, stored: stored2 }, null, 2));
    return code;
  };
  say(`Team ${loc.teamId}; ledger ${loc.path}`);
  say(`${res.proposed.length} proposed event(s) (${res.format}):`);
  for (const p of res.proposed) say(`- ${p.event.type}: ${p.summary}${p.duplicateOf ? ` (duplicate of ${p.duplicateOf}; skipped)` : ""}`);
  for (const w of res.warnings) say(`Warning: ${w}`);
  for (const i of res.ignored) say(`Not understood: ${i.slice(0, 160)}`);
  const fresh = res.proposed.filter((p) => !p.duplicateOf).length;
  if (!fresh) return done([], res.warnings, 0);
  const future = res.proposed.filter((p) => !p.duplicateOf && isFutureDated(p));
  if (future.length) {
    throw new UsageError(`${future.length} proposed event(s) are dated in the future (${future.map((p) => p.event.at).join(", ")}). App Review messages describe what already happened; check the date in the file.`);
  }
  let commit = a.flags.has("commit");
  if (!commit && process.stdin.isTTY) commit = /^y(es)?$/i.test(await ask(`Store ${fresh} event(s)? [y/N] `));
  if (!commit) {
    print("Nothing stored. Re-run with --commit to store.");
    return 0;
  }
  const table = processTable();
  const agent = agentEnvironment() ?? (table ? agentAncestor(table) : void 0);
  const before = res.warnings.length;
  let toStore = res;
  let mismatch = false;
  const approvals = res.proposed.filter((p) => !p.duplicateOf && p.event.type === "outcome" && p.event.outcome === "approved");
  if (approvals.length && !agent) {
    const why = notHuman(table);
    let refusal;
    if (why) refusal = `Approvals close open rejections, so they are stored only when the developer imports them in their own terminal; here ${why}.`;
    else {
      const phrase = `approve ${confirmationCode()}`;
      process[json ? "stderr" : "stdout"].write(`
${approvals.length} approval(s) will close open rejections for team ${loc.teamId}.
`);
      if (await ask(`Type "${phrase}" to store the approval: `, json) !== phrase) {
        refusal = "The confirmation did not match.";
        mismatch = true;
      }
    }
    if (refusal) {
      for (const p of approvals) res.warnings.push(`Not stored: ${p.summary}. ${refusal}`);
      toStore = { ...res, proposed: res.proposed.filter((p) => !approvals.includes(p)) };
    }
  }
  const stored = await commitImport(loc, toStore, { source: agent ? "agent" : "import" });
  say(`Stored ${stored.length} event(s): ${stored.map((e) => e.id).join(", ")}`);
  for (const w of res.warnings.slice(before)) say(`Warning: ${w}`);
  return done(
    stored.map((e) => ({ id: e.id, type: e.type })),
    res.warnings,
    mismatch ? 1 : 0
  );
}
var AGENT_PROCESS = /^(claude|claude-code|codex|aider|gemini|cursor-agent|goose|opencode|amp|copilot|windsurf|cline)$/i;
var AGENT_ARGS = /@anthropic-ai\/claude-code|\/claude-code\/|@openai\/codex|\/codex-cli\/|@google\/gemini-cli/i;
function processTable() {
  if (process.platform === "win32") return void 0;
  const ps = existsSync("/bin/ps") ? "/bin/ps" : "ps";
  const table = /* @__PURE__ */ new Map();
  try {
    for (const line of execFileSync(ps, ["-A", "-o", "pid=,ppid=,tty=,comm="], { encoding: "utf8", timeout: 5e3 }).split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      if (m) table.set(Number(m[1]), { ppid: Number(m[2]), tty: m[3], comm: m[4].trim(), args: "" });
    }
    for (const line of execFileSync(ps, ["-A", "-o", "pid=,args="], { encoding: "utf8", timeout: 5e3 }).split("\n")) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      const row = m ? table.get(Number(m[1])) : void 0;
      if (row) row.args = m[2];
    }
  } catch {
    return void 0;
  }
  return table.size ? table : void 0;
}
function agentAncestor(table, startPid = process.ppid) {
  const extra = new Set((process.env.APPSTORE_SHIELD_AGENT_PROCESSES ?? "").split(",").map((x) => x.trim()).filter(Boolean));
  let pid = startPid;
  for (let i = 0; i < 128 && pid > 1; i++) {
    const row = table.get(pid);
    if (!row) return void 0;
    const name = path.basename(row.comm);
    if (AGENT_PROCESS.test(name) || extra.has(name) || AGENT_ARGS.test(row.args)) return `${name} (pid ${pid})`;
    pid = row.ppid;
  }
  return void 0;
}
function notHuman(table = processTable()) {
  const agent = agentEnvironment();
  if (agent) return `this shell was started by an AI agent session (${agent} is set)`;
  if (process.platform !== "win32") {
    if (!table) return "the process table could not be read, so what started this process cannot be checked";
    const ancestor = agentAncestor(table);
    if (ancestor) return `this process was started by an AI agent (${ancestor})`;
    const cleared = clearedEnvironment();
    if (cleared) return cleared;
    const lineage = lineageProblem(table, process.pid);
    if (lineage) return lineage;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) return "it is not attached to an interactive terminal";
  return void 0;
}
function requireHuman(cmd) {
  const why = notHuman();
  if (why) {
    throw new UsageError(`${cmd} is human-only and ${why}. The developer runs it in a terminal app they opened themselves, outside any AI agent session; agents and scripts cannot record ${cmd} events.`);
  }
}
function confirmationCode() {
  return String(randomInt(1e5, 1e6));
}
async function cmdAttest(a) {
  requireHuman("attest");
  const { locateLedger, loadState, appendEvent } = await lazy.store();
  const loc = await locateLedger(projectOf(a));
  const { state } = await loadState(loc);
  const rejectionId = a.flags.get("rejection");
  if (typeof rejectionId === "string" && !state.rejections.some((r) => r.id === rejectionId)) {
    throw new UsageError(`No rejection ${rejectionId} in ${loc.path}. Run appstore-shield status to list rejection ids.`);
  }
  let statement = typeof a.flags.get("statement") === "string" ? a.flags.get("statement") : await ask("Your statement (what you, the developer, state is true): ");
  statement = statement.trim();
  if (statement.length < 20) throw new UsageError("The statement must say specifically what you are attesting (at least 20 characters).");
  if (!/^the developer states\b/i.test(statement)) statement = `The developer states that ${statement.replace(/^./, (c) => c.toLowerCase())}`;
  print(`
Team ${loc.teamId}${typeof rejectionId === "string" ? `, rejection ${rejectionId}` : ""}:
  ${statement}
`);
  const phrase = `I attest this is true ${confirmationCode()}`;
  const typed = await ask(`Type "${phrase}" to record it: `);
  if (typed !== phrase) {
    print("Not recorded.");
    return 1;
  }
  const ev = await appendEvent(loc, { type: "attestation", statement, rejectionId: typeof rejectionId === "string" ? rejectionId : void 0 }, { source: "human" });
  print(`Recorded attestation ${ev.id}.`);
  return 0;
}
async function cmdAck(a) {
  requireHuman("ack");
  const rejectionId = a.flags.get("rejection");
  const { locateLedger, loadState, appendEvent } = await lazy.store();
  const { openRejections } = await lazy.preflight();
  const loc = await locateLedger(projectOf(a));
  const { state } = await loadState(loc);
  const open = openRejections(state);
  if (typeof rejectionId !== "string") {
    print(open.length ? `Open rejections:
${open.map((o) => `- ${o.id} ${o.at.slice(0, 10)} ${o.guidelines.join(", ")}: ${o.tier ?? "not verified"}`).join("\n")}` : "No open rejections.");
    throw new UsageError("Pass --rejection ID.");
  }
  const r = open.find((o) => o.id === rejectionId);
  if (!r) throw new UsageError(`${rejectionId} is not an open rejection in ${loc.path}. Run appstore-shield status.`);
  const note = typeof a.flags.get("note") === "string" ? a.flags.get("note") : await ask("Why are you acknowledging it without a STATIC_CLEAN verification? ");
  if (note.trim().length < 20) throw new UsageError("Explain the decision in at least 20 characters.");
  print(`
Acknowledging ${rejectionId} (${r.guidelines.join(", ")}; verification ${r.tier ?? "none"}). The gate will no longer hold on it. Apple still sees the full history.`);
  const phrase = `ack ${rejectionId} ${confirmationCode()}`;
  const typed = await ask(`Type "${phrase}" to confirm: `);
  if (typed !== phrase) {
    print("Not recorded.");
    return 1;
  }
  const ev = await appendEvent(loc, { type: "ack", rejectionId, note: note.trim() }, { source: "human" });
  print(`Recorded ack ${ev.id}.`);
  return 0;
}
async function cmdLint(a) {
  const file = a.positional[0];
  if (!file) throw new UsageError("Pass the text to lint: appstore-shield lint FILE, or - to read stdin.");
  const purpose = typeof a.flags.get("purpose") === "string" ? a.flags.get("purpose") : "review_notes";
  if (!LINT_PURPOSES.includes(purpose)) throw new UsageError(`Unknown --purpose ${purpose}. Use one of: ${LINT_PURPOSES.join(", ")}.`);
  const root = projectOf(a);
  let text;
  if (file === "-") text = await readStdin();
  else {
    const abs = path.resolve(file);
    if (!existsSync(abs)) throw new UsageError(`${file} does not exist.`);
    text = readCapped(abs, MAX_LINT_CHARS * 4);
    if (text === void 0) throw new UsageError(`${file} is not a regular file of at most 64 KB.`);
  }
  if (text.length > MAX_LINT_CHARS) throw new UsageError(`The text is ${Math.round(text.length / 1024)} KB; lint takes at most 64 KB.`);
  if (!text.trim()) throw new UsageError(`${file === "-" ? "stdin" : file} is empty; there is nothing to lint.`);
  const rejection = a.flags.get("rejection");
  const factIds = list(a.flags.get("fact-ids"));
  const { createServer } = await import("./chunks/server-OPBAPKTX.js");
  const { Client } = await import("./chunks/client-NVHKDDHO.js");
  const { InMemoryTransport } = await import("./chunks/inMemory-J2WBAI6G.js");
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverSide);
  const client = new Client({ name: "appstore-shield-cli", version: VERSION });
  await client.connect(clientSide);
  try {
    const r = await client.callTool({
      name: "shield_lint_text",
      arguments: {
        project_path: root,
        purpose,
        text,
        ...typeof rejection === "string" ? { rejection_id: rejection } : {},
        ...factIds?.length ? { fact_ids: factIds } : {},
        ...a.flags.has("force") ? { force: true } : {}
      }
    });
    const summary = (r.content ?? []).map((c) => c.text ?? "").join("\n");
    if (r.isError) throw new UsageError(summary.replace(/\bpass force: true\b/g, "add --force"));
    const res = r.structuredContent;
    print(a.flags.has("json") ? JSON.stringify(res, null, 2) : summary);
    return res?.ok === true ? 0 : 1;
  } finally {
    await client.close();
    await server.close();
  }
}
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}
var FILE_TOOLS = /* @__PURE__ */ new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
function isAppRoot(root) {
  if (root === path.parse(root).root || root === homedir()) return false;
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return false;
  }
  if (names.some((n) => n.endsWith(".xcodeproj") || n.endsWith(".xcworkspace"))) return true;
  if (["Package.swift", "Podfile", "app.json", "app.config.js", "app.config.ts", "eas.json", ".appstore-shield", "ios"].some((m) => names.includes(m))) return true;
  try {
    const pkg = JSON.parse(readCapped(path.join(root, "package.json"), MAX_MANIFEST_BYTES) ?? "{}");
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return "react-native" in deps || "expo" in deps;
  } catch {
    return false;
  }
}
var DEFAULT_HOOK_DEADLINE_MS = 2e4;
function hookDeadlineMs() {
  const v = Number(process.env.APPSTORE_SHIELD_HOOK_DEADLINE_MS);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 25e3) : DEFAULT_HOOK_DEADLINE_MS;
}
function gateInChild(root, ms) {
  return new Promise((resolve) => {
    const script = process.argv[1];
    if (!script) {
      resolve({ root, holdReasons: [], warnings: [], error: "could not locate the appstore-shield CLI to run the gate" });
      return;
    }
    const child = spawn(process.execPath, [...process.execArgv, script, "gate", "--project", root, "--json"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ root, holdReasons: [], warnings: [], error: `the gate did not finish within ${Math.round(ms / 100) / 10} s` });
    }, ms);
    child.stdout.on("data", (d) => out += d.toString("utf8"));
    child.stderr.on("data", (d) => err += d.toString("utf8"));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ root, holdReasons: [], warnings: [], error: e.message });
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out);
        resolve({ root, verdict: j.verdict, holdReasons: j.holdReasons ?? [], warnings: j.warnings ?? [] });
      } catch {
        resolve({ root, holdReasons: [], warnings: [], error: err.trim().split("\n").pop() || "the gate exited without a verdict" });
      }
    });
  });
}
function humanOnlyDeny(verb) {
  return `appstore-shield ${verb} is human-only: it records the developer's own judgment. Ask the developer to run it themselves in their own terminal; an agent must not run it in any form.`;
}
function humanOnlyAsk(verb, how) {
  return `appstore-shield: this command may run the human-only ${verb} command ${how}. Only the developer may run it, in their own terminal; confirm this command does something else.`;
}
function gateDirs(gateCwd, cwdIn) {
  return [...new Set([gateCwd, cwdIn, process.env.CLAUDE_PROJECT_DIR?.trim() || void 0].filter((d) => !!d).map((d) => resolveGateRoot(path.resolve(d))))];
}
function hookFailed(why) {
  print(hookOutput("ask", `appstore-shield hook failed (${why}), so it could not check this tool call for a submission, a human-only command or a ledger write. Confirm what it does.`));
  return 0;
}
async function cmdHook() {
  let parsed;
  try {
    parsed = JSON.parse(await readStdin());
  } catch (e) {
    return hookFailed(`its input was not JSON: ${e.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return hookFailed("its input was not a JSON object");
  const input = parsed;
  if (input.tool_input !== void 0 && (typeof input.tool_input !== "object" || input.tool_input === null)) return hookFailed("tool_input was not an object");
  const tool = typeof input.tool_name === "string" ? input.tool_name : "Bash";
  const cwdIn = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  if (FILE_TOOLS.has(tool)) {
    const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
    const d = typeof target === "string" ? fileToolDecision(target, cwdIn) : void 0;
    if (d) print(hookOutput(d.decision, d.reason));
    return 0;
  }
  let what;
  let gateCwd = cwdIn;
  let unparsed = false;
  let ota;
  if (tool.startsWith("mcp__")) {
    if (!isSubmitMcpTool(tool)) return 0;
    what = tool;
  } else if (tool === "Bash" || typeof input.tool_input?.command === "string") {
    const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
    if (command.length > MAX_HOOK_COMMAND) {
      print(hookOutput("ask", `appstore-shield: this command is ${Math.round(command.length / 1024)} KB, too long for the hook to check for a submission, a human-only command or a ledger write. Confirm what it does.`));
      return 0;
    }
    const c = classifyCommand(command, cwdIn);
    const human = c.kind === "human_only" ? { verb: c.what ?? "attest/ack", decision: "deny" } : humanOnlyRun(command);
    if (human) {
      print(hookOutput(human.decision, human.decision === "deny" ? humanOnlyDeny(human.verb) : humanOnlyAsk(human.verb, "through a shell wrapper")));
      return 0;
    }
    const detached = detachedCliRun(command);
    if (detached) {
      const sensitive = detached.verb === "attest" || detached.verb === "ack" || detached.verb === "import" && detached.commit;
      print(
        hookOutput(
          sensitive ? "deny" : "ask",
          sensitive ? `appstore-shield ${detached.verb}${detached.verb === "import" ? " --commit" : ""} run through ${detached.wrapper} is denied: that wrapper detaches the CLI from this session or clears its environment, which is how its human-only check is avoided. Ask the developer to run it themselves in their own terminal.` : `appstore-shield run through ${detached.wrapper}: an agent has no need to detach this CLI or clear its environment. Confirm this command.`
        )
      );
      return 0;
    }
    const write = bashLedgerWrite(command, c.cwd);
    if (write) {
      print(hookOutput(write.decision, write.reason));
      return 0;
    }
    gateCwd = c.cwd;
    const script = c.kind === "submit" ? void 0 : scriptFileHit(command, c.cwd);
    if (script?.humanOnly) {
      const h = script.humanOnly;
      print(hookOutput(h.decision, h.decision === "deny" ? humanOnlyDeny(h.verb) : humanOnlyAsk(h.verb, `from ${script.file}`)));
      return 0;
    }
    const loose = c.kind === "submit" ? void 0 : looseSubmit(command) ?? script?.submit;
    const lane = c.kind === "submit" ? c.lane : fastlaneLane(command) ?? script?.lane;
    const lanes = lane ? fastfileLanes(gateDirs(gateCwd, cwdIn)) : void 0;
    const configured = c.kind === "submit" ? void 0 : deliverConfigSubmit(command, lane, gateDirs(gateCwd, cwdIn));
    const nameOnly = c.kind === "submit" && c.lane !== void 0 || loose === "fastlane submit/release lane";
    if (lane && lanes && nameOnly && lanes.defined.has(lane) && !lanes.submit.has(lane) && !lanes.unclear.has(lane)) {
      print(
        hookOutput(
          "ask",
          `appstore-shield: fastlane lane "${lane}" is named like a release or submit lane, but its Fastfile definition does not call deliver or upload_to_app_store with submit_for_review, or a submit command, so the pre-submission gate was not run. Confirm this lane does not send a build to App Review.`
        )
      );
      return 0;
    }
    if (c.kind === "submit") what = c.what ?? "submit for review";
    else if (loose) {
      what = `${loose} (wrapped or unusual form)`;
      unparsed = true;
    } else if (configured) {
      what = `fastlane ${lane} (${configured})`;
    } else if (lane && lanes?.submit.has(lane)) {
      what = `fastlane lane "${lane}" (its Fastfile submits for review)`;
    } else if (ota = c.kind === "ota" ? { what: c.what ?? "an over-the-air update", channel: c.channel } : looseOta(command) ?? script?.ota) {
      what = ota.what;
    } else if (script?.tooMuch) {
      print(hookOutput("ask", `appstore-shield: this command runs ${script.tooMuch}, more than the hook checks in one call, so the rest was not checked for a submission, an over-the-air publish or a human-only command. Confirm what it runs.`));
      return 0;
    } else if (script?.unreadable) {
      print(hookOutput("ask", `appstore-shield: this command runs ${script.unreadable}, which could not be read (not a regular file, or too large), so the hook cannot check it for a submission or a human-only command. Confirm what it runs.`));
      return 0;
    } else if (script?.leavesSession) {
      print(
        hookOutput(
          "ask",
          `appstore-shield: this command hands a shell command to a terminal window (${script.leavesSession}). That runs outside this session, where neither this hook nor appstore-shield's human-only check can tell an agent started it. Confirm what it runs.`
        )
      );
      return 0;
    } else return 0;
  } else return 0;
  const candidates = gateDirs(gateCwd, cwdIn);
  const roots = candidates.filter(isAppRoot);
  if (!roots.length) {
    print(hookOutput("ask", `appstore-shield: ${what} looks like a submission for review, but no iOS app project was found at ${candidates.join(" or ")}, so the pre-submission gate did not run. Run \`appstore-shield gate --project <app repo>\` before submitting.`));
    return 0;
  }
  const ms = hookDeadlineMs();
  const results = await Promise.all(roots.map((root) => gateInChild(root, ms)));
  if (ota) return otaDecision(ota, results, roots);
  const held = results.filter((r) => r.verdict === "HOLD");
  if (held.length) {
    process.stderr.write(
      held.map((r) => `appstore-shield gate: HOLD for ${r.root}. Do not submit for review (${what}).
${r.holdReasons.map((h) => `- ${h}`).join("\n")}`).join("\n") + "\nFix or remove what is listed, then run shield_preflight (MCP) or `appstore-shield gate` (CLI) again. Do not try to work around this hold.\n"
    );
    return 2;
  }
  const failed = results.filter((r) => r.error);
  if (failed.length) {
    print(hookOutput("ask", `appstore-shield could not finish the pre-submission gate for ${failed.map((r) => `${r.root} (${r.error})`).join("; ")}. Run \`appstore-shield gate --project <app repo>\` yourself before submitting for review.`));
    return 0;
  }
  const record = "Once the developer confirms the submission went through, record it with shield_preflight record_submission (MCP) or `appstore-shield preflight --version V --build-number N` (CLI).";
  const where = roots.join(", ");
  const warnings = results.flatMap((r) => r.verdict === "WARN" ? r.warnings : []);
  if (warnings.length) {
    print(hookOutput("ask", `appstore-shield gate: WARN before ${what} (${where}). ${warnings.slice(0, 6).join(" | ")}${warnings.length > 6 ? " | \u2026" : ""}. ${record}`));
    return 0;
  }
  if (unparsed) {
    print(hookOutput("ask", `appstore-shield: this looks like a submit-for-review command (${what}). The gate for ${where} is CLEAR. ${record}`));
  }
  return 0;
}
var REGRESSED_APPROVAL = /\blater approved, but a sweep\b/;
function otaDecision(ota, results, roots) {
  const reasons = results.flatMap((r) => [...r.verdict === "HOLD" ? r.holdReasons : [], ...r.warnings.filter((w) => REGRESSED_APPROVAL.test(w))].map((h) => ({ root: r.root, h })));
  const rule = "An over-the-air update changes what users of the reviewed build run without App Review: it may only fix bugs (Guideline 2.5.2): ship any feature or content change in a build that goes through App Review, and name this publish in the next build's Notes for Review (DPLA 3.2(e), post-review modifications).";
  const record = "Once the developer confirms the update was published, record it with shield_ledger_record type ota_publish (channel, message) (an MCP tool: run it from Claude Code or another MCP client).";
  if (reasons.length && !nonProductionChannel(ota.channel)) {
    const byRoot = [...new Set(reasons.map((x) => x.root))];
    process.stderr.write(
      byRoot.map((root) => `appstore-shield gate: HOLD for ${root}. Do not publish this over-the-air update (${ota.what}).
${reasons.filter((x) => x.root === root).map((x) => `- ${x.h}`).join("\n")}`).join("\n") + `
${rule} Remove what is listed, then run shield_preflight (MCP) or \`appstore-shield gate\` (CLI) again. Do not try to work around this hold.
`
    );
    return 2;
  }
  const failed = results.filter((r) => r.error);
  if (failed.length) {
    print(hookOutput("ask", `appstore-shield could not finish the gate before ${ota.what} for ${failed.map((r) => `${r.root} (${r.error})`).join("; ")}. ${rule} Run \`appstore-shield gate --project <app repo>\` yourself before publishing.`));
    return 0;
  }
  const where = roots.join(", ");
  const listed = reasons.length ? ` The gate holds for ${where}, which would stop a production update: ${reasons.slice(0, 4).map((x) => x.h).join(" | ")}${reasons.length > 4 ? " | \u2026" : ""}. Channel "${ota.channel}" looks like development or preview; confirm it does not reach App Store users.` : "";
  print(hookOutput("ask", `appstore-shield: ${ota.what} publishes an over-the-air update.${listed} ${rule} ${record}`));
  return 0;
}
function hookWatchdogMs() {
  const v = Number(process.env.APPSTORE_SHIELD_HOOK_WATCHDOG_MS);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 27e3) : 27e3;
}
function hookWithDeadline() {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const ask2 = hookOutput("ask", "appstore-shield: the hook did not finish in time, so it could not check this command for a submission, a human-only command or a ledger write. Confirm what it does.");
      process.stdout.write(`${ask2}
`, () => process.exit(0));
    }, hookWatchdogMs());
    cmdHook().then(
      (code) => {
        clearTimeout(timer);
        resolve(code);
      },
      (e) => {
        clearTimeout(timer);
        resolve(hookFailed(e?.message ?? String(e)));
      }
    );
  });
}
async function main(argv) {
  const [cmd, ...rest] = argv;
  process.stdout.on("error", (e) => {
    if (e.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw e;
  });
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    print(HELP.main);
    return 0;
  }
  if (cmd === "--version" || cmd === "-v") {
    print(VERSION);
    return 0;
  }
  if (!SPECS[cmd]) {
    process.stderr.write(`Unknown command "${cmd}".

${HELP.main}
`);
    return 2;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    print(HELP[cmd]);
    return 0;
  }
  if (cmd === "gate") process.exitCode = 1;
  try {
    const a = parseArgs(cmd, rest);
    switch (cmd) {
      case "mcp": {
        const { startStdioServer } = await import("./chunks/server-OPBAPKTX.js");
        await startStdioServer();
        return -1;
      }
      case "scan":
        return await cmdScan(a);
      case "preflight":
        return await cmdPreflight(a);
      case "gate":
        return await cmdGate(a);
      case "status":
        return await cmdStatus(a);
      case "import":
        return await cmdImport(a);
      case "attest":
        return await cmdAttest(a);
      case "ack":
        return await cmdAck(a);
      case "lint":
        return await cmdLint(a);
      case "hook":
        return await hookWithDeadline();
      default:
        return 2;
    }
  } catch (e) {
    process.stderr.write(`appstore-shield ${cmd}: ${e.message}
`);
    return e instanceof UsageError ? 2 : 1;
  }
}
main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`${e.stack ?? String(e)}
`);
    process.exitCode = 1;
  }
);
export {
  main
};

import type { Finding, Severity } from "./finding.js";
import type { PreflightResult, ScanCoverage, ScanRun } from "./preflight.js";
import { DISCLOSED_CONTENT_GUIDANCE } from "./ledger/triggers.js";

/** Human-readable summaries shared by the MCP text content and the CLI. */

export interface RuleGroup {
  rule: string;
  severity: Severity;
  guideline: string;
  count: number;
  suppressible: boolean;
  locations: string[];
}

/**
 * The same guidance is printed by the MCP server and by the CLI, and a CLI or fastlane user
 * cannot call an MCP tool: every tool a shared message names also says how to reach it there.
 */
const CLI_EQUIVALENT: Readonly<Record<string, string>> = {
  shield_scan: "appstore-shield scan",
  shield_preflight: "appstore-shield preflight",
  shield_ledger_import: "appstore-shield import",
  shield_lint_text: "appstore-shield lint",
};

export function toolRef(tool: string, args = ""): string {
  const call = args ? `${tool} ${args}` : tool;
  const cli = CLI_EQUIVALENT[tool];
  return cli ? `${call} (MCP) or \`${cli}\` (CLI)` : `${call} (an MCP tool: run it from Claude Code or another MCP client)`;
}

export function loc(f: Pick<Finding, "file" | "line">): string {
  return f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "(project)";
}

/** Findings grouped by rule, most severe first; each group keeps up to `maxLocations` locations. */
export function groupByRule(findings: Finding[], maxLocations = 5): RuleGroup[] {
  const groups = new Map<string, RuleGroup>();
  for (const f of findings) {
    const g = groups.get(f.rule);
    if (g) {
      g.count++;
      g.suppressible &&= f.suppressible;
      if (g.locations.length < maxLocations) g.locations.push(loc(f));
    } else {
      groups.set(f.rule, { rule: f.rule, severity: f.severity, guideline: f.guideline, count: 1, suppressible: f.suppressible, locations: [loc(f)] });
    }
  }
  return [...groups.values()];
}

/** Trigger basis labels in words; bare "[source]" or "[apple]" means nothing to a reader. */
export function labelText(label: string): string {
  if (label === "source") return "per Shoemaker's report";
  if (label === "apple") return "Apple text";
  if (label === "inferred") return "our inference";
  return label;
}

const someOf = (xs: string[]) => `${xs.slice(0, 3).join(", ")}${xs.length > 3 ? ", …" : ""}`;

function truncatedNote(c: ScanCoverage): string {
  return `Scan incomplete: the file budget was reached and ${c.notRead ? `${c.notRead} file(s) were` : "some files were"} not read, so findings in them are missing. Set "appPaths" in .appstore-shield/config.json to the app folders that ship, or narrow with --paths.`;
}

function unreadShippingNote(c: ScanCoverage): string {
  return `${c.unreadShipping.length} file(s) that ship in the app were not read (over the size cap or unreadable), so findings in them are missing: ${someOf(c.unreadShipping)}.`;
}

/** The coverage gaps that keep a gate from saying CLEAR: unread files that may hold a finding. */
export function gateCoverageWarnings(c: ScanCoverage): string[] {
  const out: string[] = [];
  if (c.truncated) out.push(truncatedNote(c));
  if (c.unreadShipping?.length) out.push(unreadShippingNote(c));
  return out;
}

/** Plain-language lines about what the scan did not cover, and which apps it covered. */
export function coverageNotes(c: ScanCoverage): string[] {
  const out: string[] = [...(c.appNotes ?? [])];
  if (c.truncated) out.push(truncatedNote(c));
  if (c.unreadShipping?.length) out.push(unreadShippingNote(c));
  const otherLarge = c.tooLarge.filter((p) => !c.unreadShipping?.includes(p));
  if (otherLarge.length) out.push(`${otherLarge.length}${c.unreadShipping?.length ? " other" : ""} file(s) over the size cap were not read: ${someOf(otherLarge)}.`);
  if (c.excludedWorktrees.length)
    out.push(`Skipped ${c.excludedWorktrees.length} git worktree(s) inside the project (other checkouts, not this tree): ${someOf(c.excludedWorktrees)}.`);
  return out;
}

/** CLEAR and WARN only mean no deterministic hold condition was found, never that the app is safe to submit. */
export function gateCaveat(verdict: string): string {
  return `${verdict} means no deterministic hold condition was found. Static checks miss things; this is not a guarantee of approval or against termination.`;
}

export function countsLine(c: Record<Severity, number>): string {
  return `${c.block} block, ${c.high} high, ${c.medium} medium, ${c.info} info`;
}

function cap(lines: string[], max: number, more: string): string[] {
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max - 1), more];
}

export function scanSummary(scan: ScanRun, max = 25): string {
  const head = [
    `appstore-shield scan of ${scan.root} (${scan.platforms.join(", ") || "platform not detected"}, ${scan.filesScanned} files)`,
    `Findings: ${countsLine(scan.counts)}${scan.suppressed.length ? `; ${scan.suppressed.length} suppressed by baseline` : ""}.`,
  ];
  for (const c of scan.checks.filter((x) => x.error)) head.push(`Check ${c.id} failed: ${c.error}`);
  head.push(...coverageNotes(scan.coverage));
  for (const p of scan.baselineProblems) head.push(`Baseline: ${p}`);
  if (scan.refusedSuppressions.length) head.push(`${scan.refusedSuppressions.length} baseline suppression(s) ignored: those findings can only be cleared by fixing the code.`);
  const body = groupByRule(scan.findings).map(
    (g) => `- [${g.severity.toUpperCase()}] ${g.rule} (${g.guideline}) x${g.count}: ${g.locations.slice(0, 3).join(", ")}${g.count > 3 ? ", …" : ""}`,
  );
  if (!body.length) body.push("No findings. Static checks miss things; this is not a guarantee of approval.");
  return cap([...head, ...body], max, `… more rules; narrow with checks/paths or use detail: "full".`).join("\n");
}

/** One line per rejection the --build sweep covered, so an unswept build never reads as a clean one. */
export function builtProductLines(r: Pick<PreflightResult, "builtProduct">): string[] {
  if (!r.builtProduct) return [];
  return r.builtProduct.map((b) => {
    if (!b.rejectionId) return `Built product: ${b.notes.join(" ")}`;
    if (b.error) return `Built product NOT swept for rejection ${b.rejectionId}: ${b.error}`;
    const partial = b.complete === false || b.encrypted ? " (partial sweep: not every file was read)" : "";
    return `Built product, rejection ${b.rejectionId}: ${b.hits ?? 0} residue match(es)${partial}${b.notes.length ? `. ${b.notes.join(" ")}` : "."}`;
  });
}

export function preflightSummary(r: PreflightResult, max = 25): string {
  const g = r.gate;
  const lines = [
    `Gate: ${g.verdict} for ${r.root}${r.bundleId ? ` (${r.bundleId})` : ""}. Team ${r.ledger.teamId} (${r.ledger.teamIdSource}).`,
    `Findings: ${countsLine(r.scan.counts)}.`,
  ];
  for (const w of r.ledger.warnings) lines.push(`Ledger warning: ${w}`);
  for (const c of r.scan.checks.filter((x) => x.error)) lines.push(`Check ${c.id} failed: ${c.error}`);
  // Gaps that already WARN are printed with the warnings; the rest (which apps, skipped worktrees) here.
  for (const n of coverageNotes(r.scan.coverage)) if (!g.warnings.includes(n)) lines.push(n);
  // Block findings are listed with their fixes under the findings, so the HOLD lines only name them.
  const blocks = g.holdReasons.filter((h) => h.startsWith("Block finding "));
  const others = g.holdReasons.filter((h) => !h.startsWith("Block finding "));
  if (blocks.length) {
    const rules = groupByRule(r.scan.findings.filter((f) => f.severity === "block")).map((x) => (x.count > 1 ? `${x.rule} x${x.count}` : x.rule));
    lines.push(`HOLD: ${blocks.length} block finding(s): ${rules.join(", ")}. Each must be fixed; the fixes are listed with the findings.`);
  }
  for (const h of others.slice(0, 8)) lines.push(`HOLD: ${h}`);
  if (others.length > 8) lines.push(`HOLD: … ${others.length - 8} more`);
  for (const w of g.warnings.slice(0, 5)) lines.push(`WARN: ${w}`);
  if (g.warnings.length > 5) lines.push(`WARN: … ${g.warnings.length - 5} more`);
  if (r.openRejections.length) {
    lines.push(`Open rejections: ${r.openRejections.map((o) => `${o.id} (${o.guidelines.join(", ") || "?"}, ${o.tier ?? "unverified"}${o.acked ? ", acked" : ""})`).join("; ")}`);
  }
  if (r.drift.approvalId) {
    const undisclosed = r.drift.changes.filter((c) => !c.disclosed);
    lines.push(`Drift since approval ${r.drift.approvalAt?.slice(0, 10)}: ${r.drift.changes.length} change(s), ${undisclosed.length} not disclosed in pending notes.`);
    // Disclosed changes are listed too: naming an OTA publish such as "re-enable spicy styles" in the
    // notes does not make it a bug fix, so the developer has to see what each change was.
    const ordered = [...r.drift.changes].sort((a, b) => Number(b.contentOrPrice) - Number(a.contentOrPrice));
    for (const c of ordered.slice(0, 6)) {
      const guidance = c.contentOrPrice && c.disclosed ? ` — ${DISCLOSED_CONTENT_GUIDANCE}` : "";
      lines.push(`- ${c.contentOrPrice ? "content/price " : ""}${c.disclosed ? "(disclosed) " : "(not disclosed) "}${c.detail}${guidance}`);
    }
    if (ordered.length > 6) lines.push(`- … ${ordered.length - 6} more change(s) in drift.changes`);
  } else {
    lines.push("Drift: no approval recorded, so there is no baseline yet.");
  }
  lines.push(...builtProductLines(r));
  lines.push(`Manual checklist: ${r.manualChecklist.length} item(s) to confirm by hand before submitting.`);
  if (r.recorded.snapshotEvents.length || r.recorded.metadataEventId) {
    lines.push(`Recorded ${r.recorded.snapshotEvents.length} config snapshot(s)${r.recorded.metadataEventId ? " and a metadata snapshot" : ""}.`);
  }
  if (r.recorded.submissionEventId) lines.push(`Recorded submission event ${r.recorded.submissionEventId}.`);
  // The caveat goes second so the line cap can never drop it.
  if (g.verdict !== "HOLD") lines.splice(1, 0, gateCaveat(g.verdict));
  if (g.verdict !== "HOLD") return cap(lines, max, "… (see structured output for the rest)").join("\n");
  // Likewise the do-not-submit line goes after the cap, never under it.
  return [...cap(lines, max - 1, "… (see structured output for the rest)"), "Do not submit for review: fix or remove what the HOLD reasons name, then run preflight again."].join("\n");
}

import { createHash } from "node:crypto";

export type Severity = "block" | "high" | "medium" | "info";
export type Confidence = "high" | "medium" | "low";

export const SEVERITY_ORDER: Record<Severity, number> = { block: 0, high: 1, medium: 2, info: 3 };

export interface Finding {
  /** stable across line shifts: hash of rule + file + normalized evidence */
  id: string;
  rule: string;
  severity: Severity;
  /** e.g. "1.2", "2.5.19", "3.1.2", "DPLA 3.2(f)", "5.1.1" */
  guideline: string;
  /** repo-relative POSIX path */
  file?: string;
  /** 1-based */
  line?: number;
  /** trimmed snippet, max ~160 chars */
  evidence?: string;
  why: string;
  /** Always "remove" or "disclose" style guidance; never "rename", "move" or "hide". */
  fix: string;
  confidence: Confidence;
  /** false for findings that may only be cleared by fixing, not by baseline suppression */
  suppressible: boolean;
}

export type FindingInput = Omit<Finding, "id" | "confidence" | "suppressible"> &
  Partial<Pick<Finding, "confidence" | "suppressible">>;

export function finding(f: FindingInput): Finding {
  const evidence = f.evidence ? clip(f.evidence) : undefined;
  const key = `${f.rule}|${f.file ?? "project"}|${(evidence ?? f.why).replace(/\s+/g, " ").toLowerCase()}`;
  const id = `${f.rule}:${createHash("sha1").update(key).digest("hex").slice(0, 10)}`;
  return { confidence: "medium", suppressible: true, ...f, id, evidence };
}

export function clip(s: string, max = 160): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

// Within a severity, conduct Apple treats as deceiving App Review (3.2(f), 2.3.1(a), 2.5.19)
// comes first: a truncated list must still show the findings most likely to end the account.
const RISK_RANK: ReadonlyArray<[RegExp, number]> = [
  [/^review_gating\./, 0],
  [/^remote_config\.content_gating$/, 0],
  [/^genai\.nudification$/, 1],
  [/^ratings\.incentivized_review$/, 2],
  [/^genai\.safety_disabled$/, 3],
];

export function riskRank(rule: string): number {
  return RISK_RANK.find(([rx]) => rx.test(rule))?.[1] ?? RISK_RANK.length + 1;
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      riskRank(a.rule) - riskRank(b.rule) ||
      (a.file ?? "").localeCompare(b.file ?? "") ||
      (a.line ?? 0) - (b.line ?? 0),
  );
}

/** Same rule on the same file with the same evidence collapses to one. */
export function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Map<string, Finding>();
  for (const f of findings) if (!seen.has(f.id)) seen.set(f.id, f);
  return [...seen.values()];
}

export function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const out: Record<Severity, number> = { block: 0, high: 0, medium: 0, info: 0 };
  for (const f of findings) out[f.severity]++;
  return out;
}

export function formatFindings(findings: Finding[]): string {
  if (findings.length === 0) return "No findings.";
  return sortFindings(findings)
    .map((f) => {
      const loc = f.file ? ` — ${f.file}${f.line ? `:${f.line}` : ""}` : "";
      const ev = f.evidence ? `\n  evidence: \`${f.evidence}\`` : "";
      return `- [${f.severity.toUpperCase()}, confidence: ${f.confidence}] ${f.rule} (Guideline ${f.guideline})${loc}${ev}\n  why: ${f.why}\n  fix: ${f.fix}\n  id: ${f.id}`;
    })
    .join("\n");
}

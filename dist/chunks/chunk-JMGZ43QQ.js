#!/usr/bin/env node
import { createRequire as __shieldCreateRequire } from "node:module";
const require = __shieldCreateRequire(import.meta.url);

// src/finding.ts
import { createHash } from "node:crypto";
var SEVERITY_ORDER = { block: 0, high: 1, medium: 2, info: 3 };
function finding(f) {
  const evidence = f.evidence ? clip(f.evidence) : void 0;
  const key = `${f.rule}|${f.file ?? "project"}|${(evidence ?? f.why).replace(/\s+/g, " ").toLowerCase()}`;
  const id = `${f.rule}:${createHash("sha1").update(key).digest("hex").slice(0, 10)}`;
  return { confidence: "medium", suppressible: true, ...f, id, evidence };
}
function clip(s, max = 160) {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}\u2026` : one;
}
var RISK_RANK = [
  [/^review_gating\./, 0],
  [/^remote_config\.content_gating$/, 0],
  [/^genai\.nudification$/, 1],
  [/^ratings\.incentivized_review$/, 2],
  [/^genai\.safety_disabled$/, 3]
];
function riskRank(rule) {
  return RISK_RANK.find(([rx]) => rx.test(rule))?.[1] ?? RISK_RANK.length + 1;
}
function sortFindings(findings) {
  return [...findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || riskRank(a.rule) - riskRank(b.rule) || (a.file ?? "").localeCompare(b.file ?? "") || (a.line ?? 0) - (b.line ?? 0)
  );
}
function dedupeFindings(findings) {
  const seen = /* @__PURE__ */ new Map();
  for (const f of findings) if (!seen.has(f.id)) seen.set(f.id, f);
  return [...seen.values()];
}
function countBySeverity(findings) {
  const out = { block: 0, high: 0, medium: 0, info: 0 };
  for (const f of findings) out[f.severity]++;
  return out;
}
function formatFindings(findings) {
  if (findings.length === 0) return "No findings.";
  return sortFindings(findings).map((f) => {
    const loc = f.file ? ` \u2014 ${f.file}${f.line ? `:${f.line}` : ""}` : "";
    const ev = f.evidence ? `
  evidence: \`${f.evidence}\`` : "";
    return `- [${f.severity.toUpperCase()}, confidence: ${f.confidence}] ${f.rule} (Guideline ${f.guideline})${loc}${ev}
  why: ${f.why}
  fix: ${f.fix}
  id: ${f.id}`;
  }).join("\n");
}

export {
  SEVERITY_ORDER,
  finding,
  clip,
  riskRank,
  sortFindings,
  dedupeFindings,
  countBySeverity,
  formatFindings
};

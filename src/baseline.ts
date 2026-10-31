import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import type { Finding } from "./finding.js";

/**
 * Per-repo suppressions in .appstore-shield/baseline.json. A suppression records a human
 * judgment that a finding is a false positive or accepted risk, so it must say why.
 * Findings marked not suppressible (review gating around content, disabled AI safety,
 * nudification, remote code…) can only be cleared by fixing the code.
 */

export const BASELINE_REL = ".appstore-shield/baseline.json";
export const MIN_JUSTIFICATION = 20;
const MAX_BASELINE_BYTES = 1024 * 1024;

export interface Suppression {
  /** exact finding id (stable across line shifts), e.g. "paywall.hardcoded_price:1a2b3c4d5e" */
  id?: string;
  /** a whole rule, optionally limited to one file */
  rule?: string;
  file?: string;
  justification: string;
  addedBy?: string;
  addedAt?: string;
}

export interface BaselineLoad {
  path: string;
  exists: boolean;
  suppressions: Suppression[];
  /** entries that were skipped, with why, so a typo never silently suppresses nothing (or everything) */
  problems: string[];
}

export interface BaselineApplied {
  active: Finding[];
  suppressed: { finding: Finding; justification: string }[];
  /** suppressions that matched a non-suppressible finding and were ignored */
  refused: { finding: Finding; justification: string }[];
}

export async function loadBaseline(root: string): Promise<BaselineLoad> {
  const file = path.join(root, BASELINE_REL);
  let text: string;
  try {
    // O_NONBLOCK so a FIFO here cannot hang the gate in CI; the type is checked on the opened
    // descriptor, so swapping the file after a check cannot get a FIFO or device read.
    const fh = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const st = await fh.stat();
      if (!st.isFile()) return { path: file, exists: true, suppressions: [], problems: [`${BASELINE_REL} is not a regular file; no suppressions applied.`] };
      if (st.size > MAX_BASELINE_BYTES) {
        return { path: file, exists: true, suppressions: [], problems: [`${BASELINE_REL} is ${st.size} bytes (limit ${MAX_BASELINE_BYTES}); no suppressions applied.`] };
      }
      text = await fh.readFile("utf8");
    } finally {
      await fh.close();
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { path: file, exists: false, suppressions: [], problems: [] };
    return { path: file, exists: true, suppressions: [], problems: [`Cannot read ${BASELINE_REL}: ${(e as Error).message}`] };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { path: file, exists: true, suppressions: [], problems: [`${BASELINE_REL} is not valid JSON (${(e as Error).message}); no suppressions applied.`] };
  }
  const list = Array.isArray(json) ? json : (json as { suppressions?: unknown } | null)?.suppressions;
  if (!Array.isArray(list)) {
    return { path: file, exists: true, suppressions: [], problems: [`${BASELINE_REL} must be {"suppressions": [{"id" or "rule", "justification"}]}; no suppressions applied.`] };
  }
  const suppressions: Suppression[] = [];
  const problems: string[] = [];
  list.forEach((raw: unknown, i) => {
    const s = (raw ?? {}) as Record<string, unknown>;
    const id = typeof s.id === "string" && s.id.trim() ? s.id.trim() : undefined;
    const rule = typeof s.rule === "string" && s.rule.trim() ? s.rule.trim() : undefined;
    const fileSel = typeof s.file === "string" && s.file.trim() ? s.file.trim().replace(/^\.\//, "") : undefined;
    const justification = typeof s.justification === "string" ? s.justification.trim() : "";
    if (!id && !rule) {
      problems.push(`suppressions[${i}] has neither "id" nor "rule"; skipped.`);
      return;
    }
    if (justification.length < MIN_JUSTIFICATION) {
      problems.push(
        `suppressions[${i}] (${id ?? rule}) skipped: "justification" must explain why in at least ${MIN_JUSTIFICATION} characters.`,
      );
      return;
    }
    suppressions.push({
      id,
      rule,
      file: fileSel,
      justification,
      addedBy: typeof s.addedBy === "string" ? s.addedBy : undefined,
      addedAt: typeof s.addedAt === "string" ? s.addedAt : undefined,
    });
  });
  return { path: file, exists: true, suppressions, problems };
}

function matches(s: Suppression, f: Finding): boolean {
  if (s.id) return s.id === f.id;
  if (s.rule !== f.rule) return false;
  return !s.file || s.file === f.file;
}

export function applyBaseline(findings: Finding[], suppressions: Suppression[]): BaselineApplied {
  const out: BaselineApplied = { active: [], suppressed: [], refused: [] };
  for (const f of findings) {
    const s = suppressions.find((x) => matches(x, f));
    if (!s) out.active.push(f);
    else if (!f.suppressible) {
      out.active.push(f);
      out.refused.push({ finding: f, justification: s.justification });
    } else out.suppressed.push({ finding: f, justification: s.justification });
  }
  return out;
}

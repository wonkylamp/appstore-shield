import type { Finding } from "./finding.js";
import type { ScanContext } from "./project.js";

export const CHECK_IDS = [
  "review_gating",
  "remote_config",
  "ota_updates",
  "genai_safety",
  "ugc_safeguards",
  "ai_data_disclosure",
  "ratings_integrity",
  "paywall",
  "metadata",
  "account_deletion",
  "privacy_manifest",
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

export interface CheckResult {
  findings: Finding[];
  /** check-specific inventory, e.g. remote flags, AI sources/sinks, metadata snapshots */
  data?: Record<string, unknown>;
}

export interface Check {
  id: CheckId;
  title: string;
  /** guideline / DPLA sections this check maps to, e.g. ["2.5.19", "DPLA 3.2(e)"] */
  guidelines: string[];
  run(ctx: ScanContext): Promise<CheckResult>;
}

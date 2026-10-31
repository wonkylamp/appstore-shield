import { describe, expect, it } from "vitest";
import { finding, riskRank, sortFindings } from "../../src/finding.js";

const f = (rule: string, severity: "block" | "high", file: string) => finding({ rule, severity, guideline: "2.5.19", file, line: 1, why: "w", fix: "Remove it." });

describe("sortFindings", () => {
  it("puts review-time gating ahead of other findings of the same severity, whatever the path", () => {
    const sorted = sortFindings([f("genai.safety_disabled", "block", "a.ts"), f("genai.nudification", "block", "b.ts"), f("review_gating.apple_ip", "block", "z/worker.ts"), f("ratings.incentivized_review", "block", "c.ts")]);
    expect(sorted.map((x) => x.rule)).toEqual(["review_gating.apple_ip", "genai.nudification", "ratings.incentivized_review", "genai.safety_disabled"]);
  });

  it("never ranks a lower severity above a higher one", () => {
    const sorted = sortFindings([f("review_gating.region", "high", "a.ts"), f("paywall.missing_restore", "block", "z.ts")]);
    expect(sorted.map((x) => x.rule)).toEqual(["paywall.missing_restore", "review_gating.region"]);
  });

  it("keeps path order among rules without a risk rank", () => {
    expect(riskRank("paywall.missing_restore")).toBe(riskRank("metadata.field_limit"));
    expect(sortFindings([f("paywall.x", "high", "b.ts"), f("metadata.y", "high", "a.ts")]).map((x) => x.file)).toEqual(["a.ts", "b.ts"]);
  });
});

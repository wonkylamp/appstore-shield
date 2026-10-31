import { describe, expect, it } from "vitest";
import { getChecks } from "../../src/scanners/index.js";
import { ctxFromFiles } from "../helpers.js";

/**
 * The hook and MCP server scan on demand, so large repos must stay fast. 5,000 ordinary
 * source files (about 10 MB) is a mid-size production app.
 */
function swiftFile(i: number): string {
  const body = Array.from(
    { length: 40 },
    (_, j) => `    func handle${j}(_ value: Int) -> String {\n        let label = "Item \\(value) of ${i}"\n        return label.isEmpty ? "none" : label\n    }`,
  ).join("\n");
  return `import Foundation\nimport UIKit\n\nfinal class Controller${i}: UIViewController {\n${body}\n}\n`;
}

describe("scan budget", () => {
  it("runs the AI and store checks over 5,000 files within budget", async () => {
    const files: Record<string, string> = { "App.xcodeproj/project.pbxproj": "// !$*UTF8*$!\n{}" };
    for (let i = 0; i < 5000; i++) files[`App/Feature${i % 50}/Controller${i}.swift`] = swiftFile(i);
    const ctx = await ctxFromFiles(files);
    const ids = ["genai_safety", "ugc_safeguards", "ai_data_disclosure", "paywall", "ratings_integrity", "metadata", "account_deletion", "privacy_manifest"];
    const timings: Record<string, number> = {};
    // CPU time, not wall time: the budget is about the scanners' cost, and wall time on a loaded
    // machine (parallel test files, other builds) measures the machine instead.
    for (const c of getChecks().filter((c) => ids.includes(c.id))) {
      const t = process.cpuUsage();
      await c.run(ctx);
      const d = process.cpuUsage(t);
      timings[c.id] = Math.round((d.user + d.system) / 1000);
    }
    const total = Object.values(timings).reduce((a, b) => a + b, 0);
    expect(total, JSON.stringify(timings)).toBeLessThan(15_000);
  }, 120_000);
});

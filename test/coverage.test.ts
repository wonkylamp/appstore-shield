import { describe, expect, it } from "vitest";
import { coverageNotes } from "../src/format.js";
import { coverageOf, runScan } from "../src/preflight.js";
import { loadContext } from "../src/project.js";
import { tempProject } from "./helpers.js";

const plist = (purpose: string) =>
  `<?xml version="1.0"?><plist><dict><key>NSCameraUsageDescription</key><string>${purpose}</string></dict></plist>`;

describe("worktrees and generated folders", () => {
  it("does not walk linked git worktrees, agent worktree folders or generated server bundles", async () => {
    const root = await tempProject({
      "App/App.swift": "import SwiftUI\n",
      "App/Info.plist": plist("Scan receipts to log expenses."),
      ".claude/worktrees/feature-x/App/Info.plist": plist("TODO"),
      ".worktrees/release-1.0/App/Info.plist": plist("TODO"),
      "branches/hotfix/.git": "gitdir: /src/app/.git/worktrees/hotfix\n",
      "branches/hotfix/App/Info.plist": plist("TODO"),
      "apps/api/.wrangler/tmp/dev-1/index.js": "export const x = 1;\n",
    });
    const ctx = await loadContext(root);
    const paths = ctx.files.map((f) => f.path);
    expect(paths).toContain("App/Info.plist");
    expect(paths.some((p) => p.startsWith(".claude/") || p.startsWith(".worktrees/") || p.startsWith("branches/") || p.includes(".wrangler/"))).toBe(false);
    expect(ctx.excludedWorktrees).toEqual(["branches/hotfix"]);
    const scan = await runScan(root);
    expect(scan.findings.filter((f) => f.rule === "metadata.placeholder_purpose_string")).toEqual([]);
    expect(coverageNotes(scan.coverage).join("\n")).toContain("Skipped 1 git worktree(s)");
  });

  it("still walks submodules, which ship", async () => {
    const root = await tempProject({
      "App/App.swift": "import SwiftUI\n",
      "Vendor/Kit/.git": "gitdir: ../../.git/modules/Kit\n",
      "Vendor/Kit/Kit.swift": "public struct Kit {}\n",
    });
    const ctx = await loadContext(root);
    expect(ctx.files.map((f) => f.path)).toContain("Vendor/Kit/Kit.swift");
    expect(ctx.excludedWorktrees).toEqual([]);
  });
});

describe("scan coverage", () => {
  it("reports a budget-truncated scan so it never reads as clean", () => {
    const c = coverageOf({
      root: "/x",
      project: {} as never,
      files: [],
      skipped: [{ path: "a.swift", reason: "budget", bytes: 10, remaining: 42 }],
    });
    expect(c.truncated).toBe(true);
    expect(coverageNotes(c)[0]).toContain("42 file(s) were not read");
  });

  it("says nothing when the scan read everything", () => {
    expect(coverageNotes(coverageOf({ root: "/x", project: {} as never, files: [], skipped: [] }))).toEqual([]);
  });
});

describe("detectBundleId", () => {
  it("skips test targets and picks the app over its extensions", async () => {
    const { detectBundleId } = await import("../src/preflight.js");
    const pbx = [
      "uk.co.example.notes.integration-tests",
      "uk.co.example.NailAITests",
      "uk.co.example.notes.widget",
      "uk.co.example.notes",
      "uk.co.example.notes.ShareExt",
    ].map((id) => `PRODUCT_BUNDLE_IDENTIFIER = ${id};`).join("\n");
    const root = await tempProject({ "App.xcodeproj/project.pbxproj": pbx, "App/App.swift": "import SwiftUI\n" });
    expect(detectBundleId(await loadContext(root))).toBe("uk.co.example.notes");
  });
});

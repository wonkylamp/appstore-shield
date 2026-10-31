import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { preflightSummary } from "../../src/format.js";
import { shieldHomeDir } from "../../src/hookGuard.js";
import { DISCLOSED_CONTENT_GUIDANCE } from "../../src/ledger/triggers.js";
import { disclosureInventory, runScan, safeguardClaimIssues } from "../../src/preflight.js";
import type { PreflightResult } from "../../src/preflight.js";
import { tempProject } from "../helpers.js";

/** Wiring that spans the hook, the store, the scan and the preflight summary. */

const prevHome = process.env.APPSTORE_SHIELD_HOME;

beforeAll(async () => {
  process.env.APPSTORE_SHIELD_HOME = await mkdtemp(path.join(tmpdir(), "shield-crossfile-"));
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.APPSTORE_SHIELD_HOME;
  else process.env.APPSTORE_SHIELD_HOME = prevHome;
});

describe("hook shield home matches the store", () => {
  it("guards the default home when APPSTORE_SHIELD_HOME is relative, since the store refuses it", () => {
    const saved = process.env.APPSTORE_SHIELD_HOME;
    try {
      process.env.APPSTORE_SHIELD_HOME = "relative/home";
      expect(shieldHomeDir()).toBe(path.join(homedir(), ".appstore-shield"));
      process.env.APPSTORE_SHIELD_HOME = "~/custom-shield";
      expect(shieldHomeDir()).toBe(path.join(homedir(), "custom-shield"));
    } finally {
      process.env.APPSTORE_SHIELD_HOME = saved;
    }
  });
});

describe("a claim that generated images are moderated needs image moderation", () => {
  it("text-only omni-moderation next to an image generator does not back the claim", async () => {
    const root = await tempProject({
      "package.json": JSON.stringify({ name: "x", dependencies: { "react-native": "0.76.0", expo: "52.0.0", "@fal-ai/client": "1.0.0" } }),
      "app.json": JSON.stringify({ expo: { name: "X", ios: { bundleIdentifier: "com.example.x" } } }),
      "src/gen.ts": `import { fal } from "@fal-ai/client";\nexport const gen = (prompt: string) => fal.subscribe("fal-ai/flux/dev", { input: { prompt } });\n`,
      "src/moderate.ts": `export async function moderate(text: string) {\n  const body = JSON.stringify({ model: "omni-moderation-latest", input: text });\n  return fetch("https://api.openai.com/v1/moderations", { method: "POST", body });\n}\n`,
    });
    const scan = await runScan(root);
    const issues = safeguardClaimIssues("All prompts and all generated images are now moderated.", scan.findings);
    expect(issues.map((i) => i.rule)).toContain("safeguard_claim_unbacked");
  });
});

describe("preflight summary", () => {
  const base = (over: Partial<PreflightResult["drift"]>, verdict: "HOLD" | "WARN" = "WARN"): PreflightResult =>
    ({
      root: "/x",
      gate: { verdict, holdReasons: verdict === "HOLD" ? Array.from({ length: 30 }, (_, i) => `reason ${i}`) : [], warnings: [] },
      scan: { counts: { block: 0, high: 0, medium: 0, low: 0, info: 0 }, checks: [], findings: [], coverage: { truncated: false, notRead: 0, tooLarge: [], excludedWorktrees: [], unreadShipping: [], appRoots: [], appNotes: [] } },
      ledger: { teamId: "T", teamIdSource: "config", warnings: [] },
      openRejections: [],
      drift: { changes: [], unbaselined: [], guidance: "", ...over },
      manualChecklist: [],
      recorded: { snapshotEvents: [] },
    }) as unknown as PreflightResult;

  it("lists a disclosed OTA publish's message, not only undisclosed changes", () => {
    const text = preflightSummary(
      base({
        approvalId: "ev_1",
        approvalAt: "2026-10-01T00:00:00Z",
        changes: [{ kind: "ota_publish", label: "ota", change: "published", contentOrPrice: true, mentions: [], disclosed: true, detail: "OTA update published 2026-10-20: re-enable spicy illustration styles" }],
      }),
    );
    expect(text).toMatch(/\(disclosed\) OTA update published 2026-10-20: re-enable spicy illustration styles/);
    // disclosure records a content change; it does not make it compliant
    expect(text).toContain(`re-enable spicy illustration styles — ${DISCLOSED_CONTENT_GUIDANCE}`);
  });

  it("keeps the do-not-submit line on a HOLD past the line cap", () => {
    const text = preflightSummary(base({}, "HOLD"), 10);
    expect(text.split("\n")).toHaveLength(10);
    expect(text.split("\n").at(-1)).toMatch(/^Do not submit for review/);
  });
});

describe("disclosure inventory", () => {
  it("names each remote AI call site so a false on-device claim can point at it", async () => {
    const root = await tempProject({
      "App.xcodeproj/project.pbxproj": "",
      "App/Chat.swift": 'import Foundation\nlet url = URL(string: "https://api.openai.com/v1/chat/completions")!\n',
    });
    const inv = disclosureInventory(await runScan(root));
    expect(inv.aiServices?.length).toBeGreaterThan(0);
    expect(inv.aiSinks).toContainEqual(expect.objectContaining({ file: "App/Chat.swift", line: 2 }));
  });
});

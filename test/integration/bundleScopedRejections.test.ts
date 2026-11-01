import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { finding } from "../../src/finding.js";
import { LedgerEvent } from "../../src/ledger/schema.js";
import { appendEvent, foldEvents, locateLedger } from "../../src/ledger/store.js";
import { openRejectionHolds, runPreflight } from "../../src/preflight.js";
import { createServer } from "../../src/server.js";

/** Cross-file wiring: a team ledger's rejection holds only the app it was for. */

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const prevHome = process.env.APPSTORE_SHIELD_HOME;
let client: Client;

beforeAll(async () => {
  process.env.APPSTORE_SHIELD_HOME = await mkdtemp(path.join(tmpdir(), "shield-bundle-home-"));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  client = new Client({ name: "bundle-test", version: "0" });
  await client.connect(b);
});

afterAll(async () => {
  await client?.close();
  if (prevHome === undefined) delete process.env.APPSTORE_SHIELD_HOME;
  else process.env.APPSTORE_SHIELD_HOME = prevHome;
});

async function appWithOtherAppsRejection(team: string): Promise<{ app: string; rejectionId: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "shield-bundle-app-"));
  const app = path.join(dir, "app");
  await cp(path.join(FIX, "clean-swiftui"), app, { recursive: true });
  await mkdir(path.join(app, ".appstore-shield"), { recursive: true });
  await writeFile(path.join(app, ".appstore-shield", "config.json"), JSON.stringify({ teamId: team }));
  const loc = await locateLedger(app);
  const rej = await appendEvent(
    loc,
    { type: "outcome", outcome: "rejected", guidelines: ["4.3"], bundleId: "com.example.otherapp", at: new Date(Date.now() - 3_600_000).toISOString(), reviewerMessage: "Guideline 4.3 - Design - Spam." },
    { source: "import" },
  );
  return { app, rejectionId: rej.id };
}

describe("rejections scoped to their bundle id", () => {
  it("openRejectionHolds skips a rejection recorded for another app", () => {
    const st = foldEvents("T", [LedgerEvent.parse({ id: "ev_r7a", type: "outcome", at: "2026-10-30T10:00:00.000Z", source: "import", outcome: "rejected", guidelines: ["1.2"], bundleId: "com.example.otherapp" })]);
    const f = finding({ check: "ugc", rule: "ugc.no_report", severity: "high", guideline: "1.2", file: "A.swift", line: 1, why: "w", fix: "Add a report action.", confidence: "high" });
    expect(openRejectionHolds(st, [f], "com.example.thisapp")).toEqual([]);
    expect(openRejectionHolds(st, [f], "com.example.otherapp").join(" ")).toMatch(/ugc\.no_report/);
    expect(openRejectionHolds(st, [f]).join(" ")).toMatch(/ugc\.no_report/);
  });

  it("runPreflight does not hold one app on another app's open rejection", async () => {
    const { app } = await appWithOtherAppsRejection("STABR70001");
    const r = await runPreflight(app, { record: false });
    expect(r.gate.holdReasons.join(" ")).not.toMatch(/Open rejection/);
  });

  it("shield_remediation verify refuses another app's rejection unless forced", async () => {
    const { app, rejectionId } = await appWithOtherAppsRejection("STABR70002");
    const spec = { feature: "Spam", capability: "c", terms: ["Quill"], symbols: [], assets: [], strings: [], endpoints: [], flags: [], promptFragments: [], inputPaths: [], confirmedPaths: [], metadataSurfaces: [] };
    const r = (await client.callTool({ name: "shield_remediation", arguments: { project_path: app, action: "verify", rejection_id: rejectionId, spec } })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n")).toMatch(/is for com\.example\.otherapp, but .* builds app\.quillwriter\.ios/);
  });
});

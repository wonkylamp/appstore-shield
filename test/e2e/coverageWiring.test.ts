import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { preflightSummary, scanSummary } from "../../src/format.js";
import { runPreflight, runScan } from "../../src/preflight.js";
import { createServer } from "../../src/server.js";
import { tempProject } from "../helpers.js";

/** Which apps a scan covered, and which shipping files it never read, reach every surface. */

const prevHome = process.env.APPSTORE_SHIELD_HOME;
let client: Client;

beforeAll(async () => {
  process.env.APPSTORE_SHIELD_HOME = await mkdtemp(path.join(tmpdir(), "shield-coverage-home-"));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  client = new Client({ name: "coverage-test", version: "0" });
  await client.connect(b);
});

afterAll(async () => {
  await client?.close();
  if (prevHome === undefined) delete process.env.APPSTORE_SHIELD_HOME;
  else process.env.APPSTORE_SHIELD_HOME = prevHome;
});

const RN_PKG = JSON.stringify({ name: "x", dependencies: { "react-native": "0.76.0", expo: "52.0.0" } });
const monorepo = () =>
  tempProject({
    ".appstore-shield/config.json": JSON.stringify({ teamId: "COVWIRE001" }),
    "apps/mobile/package.json": RN_PKG,
    "apps/mobile/app.json": JSON.stringify({ expo: { name: "Mobile", ios: { bundleIdentifier: "com.example.mobile" } } }),
    "apps/mobile/App.tsx": "export default function App() { return null; }\n",
    "apps/legacy/package.json": RN_PKG,
    "apps/legacy/app.json": JSON.stringify({ expo: { name: "Legacy", ios: { bundleIdentifier: "com.example.legacy" } } }),
    "apps/legacy/App.tsx": "export default function App() { return null; }\n",
  });

describe("app roots and coverage in scan, preflight and MCP output", () => {
  it("names every app root found and how to scan only the shipping one", async () => {
    const root = await monorepo();
    const scan = await runScan(root);
    expect(scan.coverage.appRoots.map((r) => r.path)).toEqual(["apps/legacy", "apps/mobile"]);
    expect(scanSummary(scan)).toMatch(/Found 2 app roots: .*appPaths/);
    const r = await runPreflight(root, { record: false, source: "ci" });
    expect(r.coverage.appNotes.join("\n")).toMatch(/Found 2 app roots/);
    expect(preflightSummary(r, 60)).toMatch(/Found 2 app roots/);

    const res = (await client.callTool({ name: "shield_preflight", arguments: { project_path: root } })) as CallToolResult & { structuredContent: Record<string, unknown> };
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    expect((res.structuredContent.app_roots as { path: string }[]).map((x) => x.path)).toEqual(["apps/legacy", "apps/mobile"]);
    expect((res.structuredContent.coverage_notes as string[]).join("\n")).toMatch(/Found 2 app roots/);
    const sc = (await client.callTool({ name: "shield_scan", arguments: { project_path: root } })) as CallToolResult & { structuredContent: Record<string, unknown> };
    expect((sc.structuredContent.app_roots as unknown[]).length).toBe(2);
  }, 60_000);

  it("a shipping source file too large to read keeps the gate from CLEAR", async () => {
    const root = await tempProject({
      ".appstore-shield/config.json": JSON.stringify({ teamId: "COVWIRE002" }),
      "App/App.swift": "import SwiftUI\n",
      "App/Generated.swift": `// generated\n${"let x = 1\n".repeat(200_000)}`,
    });
    const r = await runPreflight(root, { record: false, source: "ci" });
    expect(r.coverage.unreadShipping).toContain("App/Generated.swift");
    expect(r.gate.verdict).not.toBe("CLEAR");
    expect(r.gate.warnings.join("\n")).toMatch(/ship in the app were not read.*App\/Generated\.swift/);
  }, 60_000);
});

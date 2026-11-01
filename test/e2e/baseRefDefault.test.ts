import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../../src/server.js";

/**
 * verify without base_ref used to skip the removed-gating check entirely, so a fix that dropped a
 * TestFlight check produced no disclosure fact. It now diffs against the pre-rejection commit.
 */

const run = promisify(execFile);
const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const MSG = "Guideline 1.2 - Your app lets users generate sexually suggestive images of the companion, including lingerie outfits.";
const SPEC = {
  feature: "lingerie outfits",
  capability: "A user can no longer generate images of the companion in lingerie through the picker or free text.",
  terms: ["lingerie"],
  flags: ["spicy_mode"],
  inputPaths: ["free-text prompt (Sources/Views/CompanionStudioView.swift:38) → AI generation (Sources/AI/ImageGenerator.swift:10)"],
};
const day = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const prevHome = process.env.APPSTORE_SHIELD_HOME;
let home: string;
let client: Client;

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), "shield-baseref-home-"));
  process.env.APPSTORE_SHIELD_HOME = home;
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  client = new Client({ name: "baseref-test", version: "0" });
  await client.connect(b);
}, 60_000);

afterAll(async () => {
  await client?.close();
  if (prevHome === undefined) delete process.env.APPSTORE_SHIELD_HOME;
  else process.env.APPSTORE_SHIELD_HOME = prevHome;
});

/** The companion fixture committed `commitDaysAgo` days ago, rejected 3 days ago, with the fix (gate and flag removed) uncommitted. */
async function fixedRepo(team: string, commitDaysAgo: number): Promise<string> {
  const root = path.join(await mkdtemp(path.join(tmpdir(), "shield-baseref-")), "app");
  await cp(path.join(FIX, "swiftui-ai-companion"), root, { recursive: true });
  await mkdir(path.join(root, ".appstore-shield"), { recursive: true });
  await writeFile(path.join(root, ".appstore-shield", "config.json"), JSON.stringify({ teamId: team }));
  const at = day(commitDaysAgo);
  const env = { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at };
  await run("git", ["init", "-q", "-b", "main"], { cwd: root });
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "1.3 (42)"], { cwd: root, env });
  const rel = "Sources/Views/CompanionStudioView.swift";
  const t = (await readFile(path.join(root, rel), "utf8"))
    .replace(/\s*if RemoteConfig\.remoteConfig\(\)\["spicy_mode"\]\.boolValue \{[\s\S]*?\n {8}\}/, "")
    .replace("var outfits = standard", "let outfits = standard")
    .replace(/\n {16}if !AppEnvironment\.isTestFlight \{\n([\s\S]*?)\n {16}\}\n/, "\n$1\n");
  await writeFile(path.join(root, rel), t);
  const events = [
    { id: "ev_r1", type: "outcome", at: day(3), source: "import", outcome: "rejected", guidelines: ["1.2"], reviewerMessage: MSG },
    { id: "ev_s1", type: "residue_spec", at: day(2), source: "agent", rejectionId: "ev_r1", spec: SPEC },
  ];
  await mkdir(path.join(home, "teams", team), { recursive: true });
  await writeFile(path.join(home, "teams", team, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return root;
}

type Res = CallToolResult & { structuredContent?: Record<string, unknown> };
const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as Res;
const textOf = (r: CallToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

describe("shield_remediation verify without base_ref", () => {
  it("diffs against the last commit before the rejection, so a removed TestFlight gate is still found", async () => {
    const root = await fixedRepo("BASEREF001", 10);
    const r = await call("shield_remediation", { project_path: root, action: "verify", rejection_id: "ev_r1" });
    expect(r.isError, textOf(r)).toBeFalsy();
    const result = r.structuredContent!.result as { removed_conditions: { condition: string }[]; base_ref: { inferred: boolean } | null };
    expect(result.removed_conditions.some((c) => c.condition.includes("AppEnvironment.isTestFlight"))).toBe(true);
    expect(result.base_ref?.inferred).toBe(true);
    expect(textOf(r)).toMatch(/No base_ref given: diffed against [0-9a-f]{12} \(the last commit before the rejection/);
    const pack = await call("shield_evidence_pack", { project_path: root, purpose: "review_notes", rejection_id: "ev_r1" });
    const facts = pack.structuredContent!.facts as { kind: string; text: string }[];
    expect(facts.some((f) => f.kind === "removed_condition" && f.text.includes("isTestFlight"))).toBe(true);
    expect((pack.structuredContent!.warnings as string[]).some((w) => w.includes("ran without base_ref"))).toBe(false);
  }, 60_000);

  it("says the removed-gating check did not run, in verify and in the evidence pack, when no pre-fix commit exists", async () => {
    // the only commit is newer than the rejection, so nothing in history is the rejected build
    const root = await fixedRepo("BASEREF002", 0);
    const r = await call("shield_remediation", { project_path: root, action: "verify", rejection_id: "ev_r1" });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(textOf(r)).toMatch(/none could be inferred: review-time conditions the fix removed/);
    expect(r.structuredContent!.next).toMatch(/base_ref = the commit or tag of the rejected build/);
    const pack = await call("shield_evidence_pack", { project_path: root, purpose: "review_notes", rejection_id: "ev_r1" });
    expect((pack.structuredContent!.warnings as string[]).some((w) => w.includes("ev_r1 ran without base_ref"))).toBe(true);
  }, 60_000);
});

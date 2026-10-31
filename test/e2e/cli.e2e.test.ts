import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Exercises the bundled dist/cli.js the plugin actually ships: MCP over stdio, the hook, the gate. */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// Built into a private dir, not the shipped dist/: a rebuild mid-run must never leave the
// installed plugin's hook or MCP server on a half-edited bundle. The dir keeps the dist/cli.js
// shape so commands naming it read the same as the shipped ones.
let OUT = "";
let CLI = "";
const FIX = path.join(ROOT, "test", "fixtures");
const run = promisify(execFile);

let home: string;

beforeAll(async () => {
  OUT = path.join(await mkdtemp(path.join(tmpdir(), "shield-dist-")), "dist");
  CLI = path.join(OUT, "cli.js");
  await run(process.execPath, [path.join(ROOT, "scripts", "build.mjs")], { cwd: ROOT, timeout: 120_000, env: { ...process.env, APPSTORE_SHIELD_OUTDIR: OUT } });
  // shield:// resources are read from skills/, which lives in the repo, not next to the private build.
  process.env.CLAUDE_PLUGIN_ROOT = ROOT;
  home = await mkdtemp(path.join(tmpdir(), "shield-cli-home-"));
}, 120_000);

afterAll(async () => {
  await rm(path.dirname(OUT), { recursive: true, force: true });
});

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

function cli(args: string[], input?: string, env: Record<string, string> = {}): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, APPSTORE_SHIELD_HOME: home, CLAUDE_PROJECT_DIR: "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}

function hookInput(command: string, cwd: string): string {
  return JSON.stringify({ session_id: "t", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd });
}

function toolInput(tool_name: string, tool_input: Record<string, unknown>, cwd: string): string {
  return JSON.stringify({ session_id: "t", hook_event_name: "PreToolUse", tool_name, tool_input, cwd });
}

function decision(stdout: string): { permissionDecision: string; permissionDecisionReason: string } | undefined {
  return stdout.trim() ? (JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput : undefined;
}

/** A human terminal: no agent-session variables. */
function humanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(CLAUDECODE|CLAUDE_CODE_|AI_AGENT)/.test(k)) env[k] = v;
  return env;
}

/** A copy of a fixture with its own Team ID, so its ledger starts empty. */
async function isolatedProject(fixture: string, teamId: string): Promise<string> {
  const dir = path.join(await mkdtemp(path.join(tmpdir(), "shield-iso-")), fixture);
  await cp(path.join(FIX, fixture), dir, { recursive: true });
  await mkdir(path.join(dir, ".appstore-shield"), { recursive: true });
  await writeFile(path.join(dir, ".appstore-shield", "config.json"), JSON.stringify({ teamId }));
  return dir;
}

/** Runs a shell line and waits for `file` to say something final: for double-forked jobs. */
async function detachedRun(line: string, file: string, done: RegExp, env: Record<string, string> = {}): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    const sh = spawn("/bin/sh", ["-c", line], { env: { ...process.env, ...env }, stdio: "ignore" });
    sh.on("error", reject);
    sh.on("close", () => resolve());
  });
  for (let i = 0; i < 80; i++) {
    const out = existsSync(file) ? await readFile(file, "utf8") : "";
    if (done.test(out)) return out;
    await new Promise((r) => setTimeout(r, 250));
  }
  return existsSync(file) ? readFile(file, "utf8") : "";
}

function approvalDated(text: string, d: Date): string {
  return text.replace(/^Date: .*$/m, `Date: ${d.toUTCString()}`);
}

describe("MCP stdio server (dist/cli.js mcp)", () => {
  let client: Client;
  beforeAll(async () => {
    client = new Client({ name: "e2e", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env: { ...(process.env as Record<string, string>), APPSTORE_SHIELD_HOME: home }, stderr: "pipe" }),
    );
  }, 30_000);
  afterAll(async () => {
    await client?.close();
  });

  it("lists the 8 tools with output schemas and local-only annotations", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["shield_evidence_pack", "shield_ledger_import", "shield_ledger_query", "shield_ledger_record", "shield_lint_text", "shield_preflight", "shield_remediation", "shield_scan"].sort(),
    );
    for (const t of tools) {
      expect(t.outputSchema, t.name).toBeDefined();
      expect(t.annotations?.openWorldHint, t.name).toBe(false);
    }
    const ro = Object.fromEntries(tools.map((t) => [t.name, t.annotations?.readOnlyHint]));
    expect(ro).toMatchObject({ shield_scan: true, shield_ledger_query: true, shield_evidence_pack: true, shield_lint_text: true, shield_preflight: false, shield_ledger_record: false });
    expect(client.getInstructions()?.length).toBeLessThanOrEqual(4096);
    expect(client.getInstructions()).toMatch(/^App Store rejection/);
  });

  it("shield_scan returns a short summary and schema-valid structured findings", async () => {
    const res = await client.callTool({ name: "shield_scan", arguments: { project_path: path.join(FIX, "swiftui-ai-companion") } });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { counts: { block: number }; findings: { rule: string }[]; truncated: boolean; by_rule: unknown[]; data: { remoteControls?: { key: string }[] } };
    expect(sc.counts.block).toBeGreaterThan(0);
    expect(sc.findings.length).toBeLessThanOrEqual(30);
    expect(sc.findings.map((f) => f.rule)).toContain("review_gating.environment");
    expect(sc.data.remoteControls?.map((c) => c.key)).toContain("spicy_mode");
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    expect(text.split("\n").length).toBeLessThanOrEqual(25);
  });

  it("shield_scan narrows by rule and returns everything with detail full", async () => {
    const res = await client.callTool({ name: "shield_scan", arguments: { project_path: path.join(FIX, "expo-ai-photo"), rule: "genai.", detail: "full" } });
    const sc = res.structuredContent as { findings: { rule: string }[]; data: Record<string, unknown> };
    expect(sc.findings.length).toBeGreaterThan(0);
    expect(sc.findings.every((f) => f.rule.startsWith("genai."))).toBe(true);
    expect(Object.keys(sc.data)).toContain("genai_safety");
  });

  it("shield_preflight returns HOLD with reasons and records snapshots", async () => {
    const res = await client.callTool({ name: "shield_preflight", arguments: { project_path: path.join(FIX, "expo-ai-photo") } });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { verdict: string; hold_reasons: string[]; ledger: { team_id: string }; manual_checklist: { id: string }[]; recorded: { snapshot_events: string[] } };
    expect(sc.verdict).toBe("HOLD");
    expect(sc.hold_reasons.length).toBeGreaterThan(0);
    expect(sc.ledger.team_id).toBe("ZYXWV98765");
    expect(sc.manual_checklist.map((m) => m.id)).toEqual(expect.arrayContaining(["demo_account", "two_factor", "notes_specificity", "disclose_ota"]));
    expect(sc.recorded.snapshot_events.length).toBeGreaterThan(0);
    // unchanged snapshots are not appended again
    const again = await client.callTool({ name: "shield_preflight", arguments: { project_path: path.join(FIX, "expo-ai-photo") } });
    expect((again.structuredContent as { recorded: { snapshot_events: string[] } }).recorded.snapshot_events).toEqual([]);
  });

  it("returns actionable errors for a bad project_path", async () => {
    const rel = await client.callTool({ name: "shield_scan", arguments: { project_path: "test/fixtures/clean-expo" } });
    expect(rel.isError).toBe(true);
    expect((rel.content as { text: string }[])[0]!.text).toMatch(/absolute/);
    const missing = await client.callTool({ name: "shield_scan", arguments: { project_path: "/definitely/not/here" } });
    expect(missing.isError).toBe(true);
    expect((missing.content as { text: string }[])[0]!.text).toMatch(/does not exist/);
  });

  it("rejects scan paths that leave the repo, do not exist, or reach no read file", async () => {
    const project_path = path.join(FIX, "swiftui-ai-companion");
    const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]!.text);
    const outside = await client.callTool({ name: "shield_scan", arguments: { project_path, paths: ["../clean-expo"] } });
    expect(outside.isError).toBe(true);
    expect(text(outside)).toMatch(/outside the project/);
    const missing = await client.callTool({ name: "shield_scan", arguments: { project_path, paths: ["Nope"] } });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/do(es)? not exist/);
    const ok = await client.callTool({ name: "shield_scan", arguments: { project_path, paths: ["."] } });
    expect(ok.isError).toBeFalsy();
  });

  it("refuses agent-recorded approvals but records other outcomes", async () => {
    const project_path = path.join(FIX, "clean-swiftui");
    const approved = await client.callTool({ name: "shield_ledger_record", arguments: { project_path, event: { type: "outcome", outcome: "approved", at: "2026-10-30T00:00:00.000Z" } } });
    expect(approved.isError).toBe(true);
    expect((approved.content as { text: string }[])[0]!.text).toMatch(/shield_ledger_import/);
    const future = await client.callTool({ name: "shield_ledger_record", arguments: { project_path, event: { type: "note", text: "x", at: "2099-01-01T00:00:00.000Z" } } });
    expect(future.isError).toBe(true);
    const rejected = await client.callTool({ name: "shield_ledger_record", arguments: { project_path, event: { type: "outcome", outcome: "withdrawn" } } });
    expect(rejected.isError).toBeFalsy();
  });

  it("refuses human-only ledger events and records agent events", async () => {
    const project_path = path.join(FIX, "clean-swiftui");
    const denied = await client.callTool({ name: "shield_ledger_record", arguments: { project_path, event: { type: "ack", rejectionId: "x", note: "agent tries to ack" } } });
    expect(denied.isError).toBe(true);
    expect((denied.content as { text: string }[])[0]!.text).toMatch(/appstore-shield ack/);
    const okRes = await client.callTool({ name: "shield_ledger_record", arguments: { project_path, event: { type: "note", text: "e2e note" } } });
    expect(okRes.isError).toBeFalsy();
    expect((okRes.structuredContent as { event: { source: string } }).event.source).toBe("agent");
  });

  it("does not let an MCP-imported approval clear an open rejection", async () => {
    const project_path = await isolatedProject("clean-swiftui", "MCPIMP0001");
    const rejection = await readFile(path.join(FIX, "ledger", "rejection-1.2.txt"), "utf8");
    const rej = await client.callTool({ name: "shield_ledger_import", arguments: { project_path, text: rejection, commit: true } });
    expect((rej.structuredContent as { committed: { type: string }[] }).committed.map((c) => c.type)).toContain("outcome");
    const gate = async () => ((await client.callTool({ name: "shield_preflight", arguments: { project_path } })).structuredContent as { verdict: string }).verdict;
    expect(await gate()).toBe("HOLD");

    const approval = await readFile(path.join(FIX, "ledger", "approval.txt"), "utf8");
    const future = await client.callTool({ name: "shield_ledger_import", arguments: { project_path, text: approvalDated(approval, new Date(Date.now() + 2 * 86_400_000)), commit: true } });
    expect(future.isError).toBe(true);
    expect((future.content as { text: string }[])[0]!.text).toMatch(/future/);

    const past = await client.callTool({ name: "shield_ledger_import", arguments: { project_path, text: approvalDated(approval, new Date(Date.now() - 86_400_000)), commit: true } });
    expect(past.isError).toBeFalsy();
    const out = past.structuredContent as { committed: { type: string }[]; warnings: string[] };
    expect(out.committed).toEqual([]);
    expect(out.warnings.join(" ")).toMatch(/appstore-shield import/);
    expect(await gate()).toBe("HOLD");
  });

  it("imports a rejection, then queries it and builds an evidence pack", async () => {
    const project_path = path.join(FIX, "swiftui-ai-companion");
    const text = await readFile(path.join(FIX, "ledger", "rejection-1.1.txt"), "utf8");
    const imp = await client.callTool({ name: "shield_ledger_import", arguments: { project_path, text, commit: true } });
    expect(imp.isError).toBeFalsy();
    const committed = (imp.structuredContent as { committed: { id: string; type: string }[] }).committed;
    const rej = committed.find((c) => c.type === "outcome");
    expect(rej).toBeDefined();
    const q = await client.callTool({ name: "shield_ledger_query", arguments: { project_path, view: "rejection", rejection_id: rej!.id } });
    expect(q.isError).toBeFalsy();
    const pack = await client.callTool({ name: "shield_evidence_pack", arguments: { project_path, purpose: "review_notes", rejection_id: rej!.id } });
    expect(pack.isError).toBeFalsy();
    expect((pack.structuredContent as { byteBudget: number }).byteBudget).toBe(4000);
    const lint = await client.callTool({ name: "shield_lint_text", arguments: { project_path, purpose: "review_notes", text: "We guarantee the app never shows anything bad.", rejection_id: rej!.id } });
    expect((lint.structuredContent as { ok: boolean }).ok).toBe(false);

    const surface = await client.callTool({ name: "shield_remediation", arguments: { project_path, action: "find_surface", rejection_id: rej!.id } });
    expect(surface.isError).toBeFalsy();
    const draft = (surface.structuredContent as { result: { draft: Record<string, unknown> } }).result.draft;
    expect(draft).toHaveProperty("capability");
    const bogus = await client.callTool({
      name: "shield_remediation",
      arguments: { project_path, action: "save_spec", rejection_id: rej!.id, spec: { feature: "x", capability: "y", symbols: ["TotallyInventedSymbolXYZ"] } },
    });
    expect(bogus.isError).toBe(true);
    expect((bogus.content as { text: string }[])[0]!.text).toMatch(/Spec not saved/);
    const verifyWithoutSpec = await client.callTool({ name: "shield_remediation", arguments: { project_path, action: "verify", rejection_id: rej!.id } });
    expect(verifyWithoutSpec.isError).toBe(true);
    expect((verifyWithoutSpec.content as { text: string }[])[0]!.text).toMatch(/save_spec/);
  });

  it("serves the three resources and four prompts", async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual(["shield://checks", "shield://guidelines", "shield://playbook"]);
    const playbook = await client.readResource({ uri: "shield://playbook" });
    expect((playbook.contents[0] as { text: string }).text).not.toMatch(/was not found/);
    const checks = await client.readResource({ uri: "shield://checks" });
    expect((checks.contents[0] as { text: string }).text).toContain("review_gating");
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["appeal", "preflight", "remediate", "respond"]);
  });
});

describe("hook (dist/cli.js hook)", () => {
  it("exits 2 with reasons on stderr for a submit-for-review command on a HOLD project", async () => {
    const r = await cli(["hook"], hookInput("asc review submit --app 123 --version 1.4.0 --build-id B1 --confirm", path.join(FIX, "expo-ai-photo")));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/HOLD/);
    expect(r.stdout).toBe("");
  });

  it("follows a leading cd to the project being submitted", async () => {
    const r = await cli(["hook"], hookInput(`cd ${path.join(FIX, "swiftui-ai-companion")} && asc review submit --app 1 --version 1.3`, "/"));
    expect(r.code).toBe(2);
  });

  it("asks, rather than holds, for a release-named lane whose Fastfile shows it does not submit", async () => {
    // swiftui-ai-companion's `release` lane uploads with submit_for_review: false.
    const r = await cli(["hook"], hookInput(`cd ${path.join(FIX, "swiftui-ai-companion")} && bundle exec fastlane ios release`, "/"));
    expect(r.code).toBe(0);
    expect(decision(r.stdout)?.permissionDecision).toBe("ask");
    expect(decision(r.stdout)?.permissionDecisionReason).toMatch(/does not call deliver/);
    const app = await isolatedProject("expo-ai-photo", "LANE000002");
    await mkdir(path.join(app, "fastlane"), { recursive: true });
    await writeFile(path.join(app, "fastlane", "Fastfile"), "lane :release_notes do\n  changelog_from_git_commits\nend\n");
    const notes = await cli(["hook"], hookInput("fastlane ios release_notes", app));
    expect(notes.code).toBe(0);
    expect(decision(notes.stdout)?.permissionDecision).toBe("ask");
    // A release-named lane the Fastfile does not define is still gated by its name.
    expect((await cli(["hook"], hookInput("fastlane ios release_candidate", app))).code).toBe(2);
  });

  it("is silent for unrelated commands and for uploads", async () => {
    for (const command of ["ls -la", "eas submit -p ios", "xcrun altool --upload-app -f App.ipa", "asc builds upload --ipa App.ipa", "asc publish appstore --app 1 --ipa a.ipa --version 1.0"]) {
      const r = await cli(["hook"], hookInput(command, path.join(FIX, "expo-ai-photo")));
      expect(r.code, command).toBe(0);
      expect(r.stdout, command).toBe("");
      expect(r.stderr, command).toBe("");
    }
  });

  it("denies an agent running the human-only attest/ack commands", async () => {
    for (const command of ["appstore-shield attest", "node /x/dist/cli.js ack --rejection ev_1"]) {
      const r = await cli(["hook"], hookInput(command, "/"));
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
      expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/human-only/);
    }
  });

  it("allows a CLEAR submission without recording it (the command has not run yet)", async () => {
    const project = path.join(FIX, "clean-expo");
    const ledgerFile = path.join(home, "teams", "LMNOP13579", "events.jsonl");
    const before = existsSync(ledgerFile) ? await readFile(ledgerFile, "utf8") : "";
    for (let i = 0; i < 2; i++) {
      const r = await cli(["hook"], hookInput("asc review submissions-submit --id S1 --confirm", project));
      expect(r.code).toBe(0);
      // a second attempt must not turn into WARN because of the first one
      expect(r.stdout).toBe("");
    }
    const after = existsSync(ledgerFile) ? await readFile(ledgerFile, "utf8") : "";
    expect(after).toBe(before);
    expect(after).not.toMatch(/"submission"/);
  });

  it("asks on WARN", async () => {
    const warnHome = await mkdtemp(path.join(tmpdir(), "shield-warn-home-"));
    await mkdir(path.join(warnHome, "teams", "QRSTU24680"), { recursive: true });
    await writeFile(
      path.join(warnHome, "teams", "QRSTU24680", "events.jsonl"),
      `${JSON.stringify({ id: "ev_t1", at: "2026-10-01T00:00:00.000Z", source: "import", type: "termination", letter: "Your membership is being terminated under 3.2(f)." })}\n`,
    );
    const r = await cli(["hook"], hookInput("asc publish appstore --app 1 --ipa a.ipa --version 1.0 --submit --confirm", path.join(FIX, "clean-swiftui")), { APPSTORE_SHIELD_HOME: warnHome });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { permissionDecision: string } };
    expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
  });
});

describe("hook hardening", () => {
  it("gates the React Native root when fastlane runs from ios/", async () => {
    const rn = path.join(await mkdtemp(path.join(tmpdir(), "shield-rn-")), "rn");
    await cp(path.join(FIX, "expo-ai-photo"), rn, { recursive: true });
    await mkdir(path.join(rn, "ios", "GlowUp.xcodeproj"), { recursive: true });
    await mkdir(path.join(rn, "ios", "fastlane"), { recursive: true });
    await writeFile(path.join(rn, "ios", "fastlane", "Fastfile"), "lane :release do\n  deliver(submit_for_review: true)\nend\n");
    const r = await cli(["hook"], hookInput("bundle exec fastlane release", path.join(rn, "ios")));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(`HOLD for ${rn}.`);
    expect(r.stderr).toMatch(/genai\.safety_disabled/);
    expect(existsSync(path.join(home, "teams", "ZYXWV98765", "events.jsonl")) ? await readFile(path.join(home, "teams", "ZYXWV98765", "events.jsonl"), "utf8") : "").not.toMatch(/"submission"/);
  });

  it("holds wrapped submit-for-review forms on a HOLD project", async () => {
    const project = path.join(FIX, "expo-ai-photo");
    for (const command of [
      "bash -c 'asc review submit --version 1.0'",
      "(asc review submit --version 1.0)",
      "true & asc review submit --version 1.0",
      "if true; then asc review submit; fi",
      "\\asc review submit",
      "asc --profile prod review submit",
      "eval asc review submit",
    ]) {
      const r = await cli(["hook"], hookInput(command, project));
      expect(r.code, command).toBe(2);
    }
  });

  it("asks for a wrapped submit on a CLEAR project and ignores submit phrases in text", async () => {
    const ask = await cli(["hook"], hookInput("bash -c 'asc review submit --version 1.0'", path.join(FIX, "clean-expo")));
    expect(ask.code).toBe(0);
    expect(decision(ask.stdout)?.permissionDecision).toBe("ask");
    const text = await cli(["hook"], hookInput("git commit -m 'asc review submit now gated'", path.join(FIX, "expo-ai-photo")));
    expect(text.code).toBe(0);
    expect(text.stdout).toBe("");
  });

  it("denies every spelling of agent-run attest/ack", async () => {
    for (const command of [
      "node dist/cli.js 'attest'",
      `node dist/cli.js "ack" --rejection x`,
      "appstore-shield at''test",
      "C=attest; appstore-shield $C",
      "npx appstore-shield@latest attest",
      "printf attest | xargs appstore-shield",
      "cp dist/cli.js /tmp/s.mjs && node /tmp/s.mjs attest",
    ]) {
      const r = await cli(["hook"], hookInput(command, "/"));
      expect(decision(r.stdout)?.permissionDecision, command).toBe("deny");
    }
  });

  it("denies agent writes to the ledger and allows reads", async () => {
    const write = await cli(["hook"], hookInput(`echo '{"type":"ack","source":"human"}' >> ~/.appstore-shield/teams/LMNOP13579/events.jsonl`, "/"));
    expect(decision(write.stdout)?.permissionDecision).toBe("deny");
    const viaHome = await cli(["hook"], hookInput(`printf x >> ${home}/teams/LMNOP13579/events.jsonl`, "/"));
    expect(decision(viaHome.stdout)?.permissionDecision).toBe("deny");
    const edit = await cli(["hook"], toolInput("Write", { file_path: path.join(home, "teams", "LMNOP13579", "events.jsonl"), content: "{}" }, "/"));
    expect(decision(edit.stdout)?.permissionDecision).toBe("deny");
    const read = await cli(["hook"], hookInput(`cat ${home}/teams/LMNOP13579/events.jsonl`, "/"));
    expect(read.stdout).toBe("");
    const src = await cli(["hook"], toolInput("Edit", { file_path: "/repo/src/App.tsx", old_string: "a", new_string: "b" }, "/"));
    expect(src.stdout).toBe("");
  });

  it("gates the session project as well as a cd target, and asks when no app is found", async () => {
    const other = await mkdtemp(path.join(tmpdir(), "shield-other-"));
    await mkdir(path.join(other, ".git"));
    const swap = await cli(["hook"], hookInput(`cd ${other} && asc review submit --app 123 --version 1.0`, path.join(FIX, "expo-ai-photo")));
    expect(swap.code).toBe(2);
    expect(swap.stderr).toContain(`HOLD for ${path.join(FIX, "expo-ai-photo")}`);
    const viaEnv = await cli(["hook"], hookInput(`cd ${other} && asc review submit --app 123 --version 1.0`, other), { CLAUDE_PROJECT_DIR: path.join(FIX, "swiftui-ai-companion") });
    expect(viaEnv.code).toBe(2);
    const none = await cli(["hook"], hookInput(`cd ${other} && asc review submit --app 123 --version 1.0`, "/"));
    expect(none.code).toBe(0);
    expect(decision(none.stdout)?.permissionDecision).toBe("ask");
    expect(decision(none.stdout)?.permissionDecisionReason).toMatch(/no iOS app project/);
  });

  it("asks instead of letting the command through when the gate misses its deadline", async () => {
    const r = await cli(["hook"], hookInput("asc review submit --version 1.0", path.join(FIX, "expo-ai-photo")), { APPSTORE_SHIELD_HOOK_DEADLINE_MS: "1" });
    expect(r.code).toBe(0);
    expect(decision(r.stdout)?.permissionDecision).toBe("ask");
    expect(decision(r.stdout)?.permissionDecisionReason).toMatch(/did not finish/);
  });

  it("does not treat attest/ack as an argument of unrelated commands as a run", async () => {
    for (const command of ['rg -n ack src && npm test', 'grep -rn attest docs | bash -c "wc -l"', "echo attest > notes.txt && node build.js", "ls dist/cli.js && rg ack", "node dist/cli.js status --project . && grep ack x"]) {
      const r = await cli(["hook"], hookInput(command, "/"));
      expect(r.stdout, command).toBe("");
    }
    const wrapped = await cli(["hook"], hookInput("bash -c 'appstore-shield attest'", "/"));
    expect(decision(wrapped.stdout)?.permissionDecision).toBe("deny");
    const evald = await cli(["hook"], hookInput('eval "$TOOL attest"', "/"));
    expect(decision(evald.stdout)?.permissionDecision).toBe("ask");
  });

  it("allows quoted text that mentions attest/ack in commit messages, searches and echo", async () => {
    for (const command of ['git commit -m "docs: explain appstore-shield attest flow"', 'grep -rn "appstore-shield attest" README.md', 'echo "run appstore-shield ack later"']) {
      const r = await cli(["hook"], hookInput(command, "/"));
      expect(r.stdout, command).toBe("");
      expect(r.code, command).toBe(0);
    }
    const quotedProgram = await cli(["hook"], hookInput('"appstore-shield" ack --rejection x', "/"));
    expect(decision(quotedProgram.stdout)?.permissionDecision).toBe("deny");
  });

  it("holds over-the-air publishes on a HOLD project, in plain, wrapped and package-script forms", async () => {
    const app = await isolatedProject("expo-ai-photo", "OTAHOLD001");
    const pkg = JSON.parse(await readFile(path.join(app, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    pkg.scripts = { ...pkg.scripts, "ota:prod": "eas update --branch production --auto" };
    await writeFile(path.join(app, "package.json"), JSON.stringify(pkg));
    for (const command of [
      "eas update --branch production --message restore",
      "npx appcenter codepush release-react -a me/app -d Production",
      "shorebird patch ios",
      "bash -c 'npx eas-cli@latest update --auto'",
      "npm run ota:prod",
    ]) {
      const r = await cli(["hook"], hookInput(command, app));
      expect(r.code, command).toBe(2);
      expect(r.stderr, command).toMatch(/Do not publish this over-the-air update/);
      expect(r.stderr, command).toMatch(/genai\.nudification|Block finding/);
      expect(r.stderr, command).toMatch(/2\.5\.2/);
    }
    const preview = await cli(["hook"], hookInput("eas update --branch preview", app));
    expect(preview.code).toBe(0);
    expect(decision(preview.stdout)?.permissionDecision).toBe("ask");
    expect(decision(preview.stdout)?.permissionDecisionReason).toMatch(/development or preview/);
    for (const command of ["eas update:list", "shorebird patch android", "eas submit -p ios --latest"]) {
      const r = await cli(["hook"], hookInput(command, app));
      expect(r.code, command).toBe(0);
      expect(r.stdout, command).toBe("");
    }
  });

  it("asks before an OTA publish on a clean project, and holds when an approved rejection's capability is back", async () => {
    const app = await isolatedProject("clean-expo", "OTAREGR001");
    const clear = await cli(["hook"], hookInput("eas update --branch production", app));
    expect(clear.code).toBe(0);
    expect(decision(clear.stdout)?.permissionDecision).toBe("ask");
    expect(decision(clear.stdout)?.permissionDecisionReason).toMatch(/2\.5\.2.*ota_publish/s);
    const t = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
    const verification = { at: t(8), tier: "STATIC_CLEAN", removedInDiff: [], residue: [], inputPaths: [], unverifiable: [], summary: "clean" };
    const spec = { feature: "outfits", capability: "no sexualized outfit generation", terms: ["lingerie outfit"] };
    const events = [
      { id: "ev_r1", type: "outcome", at: t(10), source: "import", outcome: "rejected", guidelines: ["1.1"] },
      { id: "ev_s1", type: "residue_spec", at: t(9), source: "agent", rejectionId: "ev_r1", spec },
      { id: "ev_v1", type: "verification", at: t(8), source: "agent", rejectionId: "ev_r1", verification },
      { id: "ev_a1", type: "outcome", at: t(5), source: "import", outcome: "approved" },
    ];
    await mkdir(path.join(home, "teams", "OTAREGR001"), { recursive: true });
    await writeFile(path.join(home, "teams", "OTAREGR001", "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    await writeFile(path.join(app, "src", "Outfits.ts"), 'export const STYLES = ["lingerie outfit", "suit"];\n');
    const gate = await cli(["gate", app, "--json"]);
    expect(gate.code, gate.stderr).toBe(0);
    expect(gate.stdout).toMatch(/later approved/);
    const ota = await cli(["hook"], hookInput("eas update --branch production", app));
    expect(ota.code).toBe(2);
    expect(ota.stderr).toMatch(/ev_r1.*later approved/);
  });

  it("holds asc's low-level submit and asc workflow steps that submit, and lets TestFlight beta review through", async () => {
    const app = path.join(FIX, "expo-ai-photo");
    for (const command of ["asc review submissions-update --id SUB123 --submitted=true --confirm", "asc review submissions-update --id SUB123 --submitted true --confirm", "bash -c 'asc review submissions-update --id S --submitted --confirm'"]) {
      const r = await cli(["hook"], hookInput(command, app));
      expect(r.code, command).toBe(2);
    }
    const draft = await cli(["hook"], hookInput("asc review submissions-update --id S --submitted=false", app));
    expect(draft.stdout).toBe("");
    const wf = await isolatedProject("expo-ai-photo", "ASCWF00001");
    await mkdir(path.join(wf, ".asc"), { recursive: true });
    await writeFile(
      path.join(wf, ".asc", "workflow.json"),
      `{
  // JSONC, as asc accepts
  "workflows": {
    "beta": { "steps": ["asc builds info --app 1 --latest"] },
    "release": { "steps": [{ "name": "stage", "run": "asc release stage --app 1 --confirm" }, { "workflow": "send" }] },
    "send": { "steps": [{ "run": "asc review submit --app 1 --confirm" }], },
  },
}`,
    );
    const release = await cli(["hook"], hookInput("asc workflow run release VERSION:1.3", wf));
    expect(release.code).toBe(2);
    expect(release.stderr).toMatch(/workflow/);
    const beta = await cli(["hook"], hookInput("asc workflow run beta", wf));
    expect(beta.code).toBe(0);
    expect(beta.stdout).toBe("");
    const tf = await cli(["hook"], hookInput("asc testflight review submit --build-id B --confirm", app));
    expect(tf.code).toBe(0);
    expect(tf.stdout).toBe("");
  });

  it("denies relative and cd-then-relative writes to a configured ledgerPath", async () => {
    const app = await isolatedProject("clean-swiftui", "RELLEDGER1");
    await mkdir(path.join(app, "compliance"), { recursive: true });
    await writeFile(path.join(app, ".appstore-shield", "config.json"), JSON.stringify({ teamId: "RELLEDGER1", ledgerPath: "compliance/ledger.jsonl" }));
    for (const command of [
      `echo '{"type":"ack","source":"human"}' >> compliance/ledger.jsonl`,
      "cd compliance && echo x >> ledger.jsonl",
      "sed -i '' 's/rejected/approved/' compliance/ledger.jsonl",
      "printf x | tee -a ./compliance/../compliance/ledger.jsonl",
      "rm -rf compliance",
    ]) {
      const r = await cli(["hook"], hookInput(command, app));
      expect(decision(r.stdout)?.permissionDecision, command).toBe("deny");
    }
    const read = await cli(["hook"], hookInput("cat compliance/ledger.jsonl | wc -l", app));
    expect(read.stdout).toBe("");
  });

  it("denies the CLI run through env -i or a background subshell, and an expect script that drives attest", async () => {
    const forged = await cli(["hook"], hookInput("(env -i PATH=$PATH HOME=$HOME npx appstore-shield import ~/Downloads/approval.txt --commit &)", path.join(FIX, "clean-swiftui")));
    expect(decision(forged.stdout)?.permissionDecision).toBe("deny");
    expect(decision(forged.stdout)?.permissionDecisionReason).toMatch(/env -i/);
    const dir = await mkdtemp(path.join(tmpdir(), "shield-exp-"));
    await writeFile(path.join(dir, "a.exp"), `spawn node ${CLI} attest --statement "the prompt was removed"\nexpect -re {Type "(.*)"}\n`);
    const viaExpect = await cli(["hook"], hookInput("(/usr/bin/env -i PATH=$PATH HOME=$HOME /usr/bin/expect $PWD/a.exp > out.txt 2>&1 &)", dir));
    expect(decision(viaExpect.stdout)?.permissionDecision).toBe("deny");
    const bg = await cli(["hook"], hookInput("nohup appstore-shield gate &", path.join(FIX, "clean-swiftui")));
    expect(decision(bg.stdout)?.permissionDecision).toBe("ask");
  });

  it("holds variable-expanded, API and custom-lane submit forms on a HOLD project", async () => {
    const project = path.join(FIX, "expo-ai-photo");
    for (const command of [
      "A=asc; $A review submit --app 1",
      "x=review; asc $x submit",
      `curl -X PATCH https://api.appstoreconnect.apple.com/v1/reviewSubmissions/abc -d '{"data":{"attributes":{"submitted":true}}}'`,
    ]) {
      const r = await cli(["hook"], hookInput(command, project));
      expect(r.code, command).toBe(2);
    }
    const app = await isolatedProject("expo-ai-photo", "LANE000001");
    await mkdir(path.join(app, "fastlane"), { recursive: true });
    await writeFile(path.join(app, "fastlane", "Fastfile"), "lane :ship_it do\n  upload_to_app_store(submit_for_review: true)\nend\nlane :beta_upload do\n  pilot\nend\n");
    await writeFile(path.join(app, "ship.sh"), "#!/bin/sh\nasc review submit --app 1\n");
    expect((await cli(["hook"], hookInput("bundle exec fastlane ios ship_it", app))).code).toBe(2);
    expect((await cli(["hook"], hookInput("bash ship.sh", app))).code).toBe(2);
    const beta = await cli(["hook"], hookInput("bundle exec fastlane ios beta_upload", app));
    expect(beta.code).toBe(0);
    expect(beta.stdout).toBe("");
  });

  it("answers a padded command quickly: over 64 KB asks, under it still holds", async () => {
    const project = path.join(FIX, "expo-ai-photo");
    let t = Date.now();
    const huge = await cli(["hook"], hookInput(`true asc ${"review ".repeat(60_000)}; bash -c "asc review submit --app 1"`, project));
    expect(Date.now() - t).toBeLessThan(10_000);
    expect(decision(huge.stdout)?.permissionDecision).toBe("ask");
    expect(decision(huge.stdout)?.permissionDecisionReason).toMatch(/too long/);
    t = Date.now();
    const padded = await cli(["hook"], hookInput(`true asc ${"review ".repeat(9_000)}; bash -c "asc review submit --app 1"`, project));
    expect(padded.code).toBe(2);
    expect(Date.now() - t).toBeLessThan(15_000);
  }, 30_000);

  it("ack refuses when an agent process started it, even with the agent variables cleared", async () => {
    const r = await cli(["ack", "--project", path.join(FIX, "clean-swiftui"), "--rejection", "ev_x", "--note", "Agent decided this is fine to submit anyway"], undefined, { ...humanEnv(), APPSTORE_SHIELD_HOME: home, CLAUDE_PROJECT_DIR: "", APPSTORE_SHIELD_AGENT_PROCESSES: path.basename(process.execPath) });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/started by an AI agent/);
  });

  it("gates App Store Connect MCP submit tools and ignores other MCP tools", async () => {
    const hold = await cli(["hook"], toolInput("mcp__asc__review_submit", { version: "1.0" }, path.join(FIX, "expo-ai-photo")));
    expect(hold.code).toBe(2);
    const submission = await cli(["hook"], toolInput("mcp__asc__update_review_submission", { submitted: true }, path.join(FIX, "expo-ai-photo")));
    expect(submission.code).toBe(2);
    for (const tool of ["mcp__asc__validate_and_submit_for_review", "mcp__app-store-connect__submit_app_store_version_with_status_check"]) {
      const r = await cli(["hook"], toolInput(tool, {}, path.join(FIX, "expo-ai-photo")));
      expect(r.code, tool).toBe(2);
    }
    const status = await cli(["hook"], toolInput("mcp__asc__get_review_submission_status", {}, path.join(FIX, "expo-ai-photo")));
    expect(status.stdout).toBe("");
    const other = await cli(["hook"], toolInput("mcp__claude-in-chrome__form_submit", {}, path.join(FIX, "expo-ai-photo")));
    expect(other.code).toBe(0);
    expect(other.stdout).toBe("");
  });

  it("holds submissions run through package.json scripts, make and just on a HOLD project", async () => {
    const app = await isolatedProject("expo-ai-photo", "TASKS00001");
    const pkg = JSON.parse(await readFile(path.join(app, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    pkg.scripts = { ...pkg.scripts, "submit:ios": "cd ios && bundle exec fastlane deliver submit_for_review:true --force", release: "asc review submit --app 123 --version 1.0", ship: "npm run release" };
    await writeFile(path.join(app, "package.json"), JSON.stringify(pkg));
    await writeFile(path.join(app, "Makefile"), "submit:\n\tasc review submit --app 1\n");
    await writeFile(path.join(app, "justfile"), "ship:\n    asc review submit --app 1\n");
    for (const command of ["npm run submit:ios", "yarn release", "npm run release", "npm run ship", "pnpm release", "make submit", "just ship"]) {
      const r = await cli(["hook"], hookInput(command, app));
      expect(r.code, command).toBe(2);
      expect(r.stderr, command).toMatch(/HOLD/);
    }
    const build = await cli(["hook"], hookInput("npm run lint", app));
    expect(build.code).toBe(0);
    expect(build.stdout).toBe("");
  });

  it("asks before creating .appstore-shield/config.json and denies writes anywhere in the shield home", async () => {
    const app = path.join(await mkdtemp(path.join(tmpdir(), "shield-newcfg-")), "app");
    await cp(path.join(FIX, "clean-expo"), app, { recursive: true });
    const create = await cli(["hook"], toolInput("Write", { file_path: path.join(app, ".appstore-shield", "config.json"), content: '{"teamId":"ABCDE12345"}' }, app));
    expect(decision(create.stdout)?.permissionDecision).toBe("ask");
    const repos = await cli(["hook"], toolInput("Write", { file_path: path.join(home, "repos.json"), content: "{}" }, app));
    expect(decision(repos.stdout)?.permissionDecision).toBe("deny");
    const viaBash = await cli(["hook"], hookInput(`echo '{}' > ${home}/repos.json`, app));
    expect(decision(viaBash.stdout)?.permissionDecision).toBe("deny");
  });

  it.skipIf(process.platform === "win32")("answers quickly when .appstore-shield/config.json or package.json is a FIFO", async () => {
    const app = path.join(await mkdtemp(path.join(tmpdir(), "shield-fifo-")), "app");
    await mkdir(path.join(app, ".appstore-shield"), { recursive: true });
    await mkdir(path.join(app, "App.xcodeproj"));
    await run("mkfifo", [path.join(app, ".appstore-shield", "config.json")]);
    await run("mkfifo", [path.join(app, "package.json")]);
    const t = Date.now();
    for (const [tool, input] of [
      ["Bash", { command: "echo hi > /tmp/shield-x" }],
      ["Bash", { command: "rm -rf build" }],
      ["Bash", { command: "npm run build" }],
      ["Write", { file_path: path.join(app, "x.swift"), content: "" }],
    ] as const) {
      const r = await cli(["hook"], toolInput(tool, input, app));
      expect(r.code, JSON.stringify(input)).toBe(0);
    }
    expect(Date.now() - t).toBeLessThan(15_000);
    const mk = await cli(["hook"], hookInput("mkdir -p .appstore-shield && mkfifo .appstore-shield/config.json", app));
    expect(decision(mk.stdout)?.permissionDecision).toBe("ask");
  }, 30_000);

  it("asks for a command handed to a terminal window, and denies one that runs ack from a script", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "shield-osa-"));
    await writeFile(path.join(dir, "x.sh"), 'appstore-shield ack --rejection ev_1 --note "decided to ship anyway"\n');
    const ack = await cli(["hook"], hookInput(`osascript -e 'tell app "Terminal" to do script "bash ${dir}/x.sh"'`, dir));
    expect(decision(ack.stdout)?.permissionDecision).toBe("deny");
    const other = await cli(["hook"], hookInput(`osascript -e 'tell app "Terminal" to do script "npm run dev"'`, dir));
    expect(decision(other.stdout)?.permissionDecision).toBe("ask");
    expect(decision(other.stdout)?.permissionDecisionReason).toMatch(/terminal window/);
  });

  it("answers ask when the hook itself stalls", async () => {
    const child = spawn(process.execPath, [CLI, "hook"], { env: { ...process.env, APPSTORE_SHIELD_HOME: home, APPSTORE_SHIELD_HOOK_WATCHDOG_MS: "800" }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    // stdin stays open, so reading the hook input never finishes.
    child.stdin.write('{"tool_name":"Bash",');
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(code).toBe(0);
    expect(decision(stdout)?.permissionDecision).toBe("ask");
    expect(decision(stdout)?.permissionDecisionReason).toMatch(/did not finish in time/);
  });

  it("ack refuses inside an agent session", async () => {
    const r = await cli(["ack", "--project", path.join(FIX, "clean-swiftui"), "--rejection", "ev_x", "--note", "Agent decided this is fine to submit anyway"], undefined, { CLAUDECODE: "1" });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/AI agent session/);
  });

  it.skipIf(process.platform !== "darwin")("ack under script(1) with a piped phrase is not recorded", async () => {
    const ackHome = await mkdtemp(path.join(tmpdir(), "shield-ack-home-"));
    const ledger = path.join(ackHome, "teams", "QRSTU24680", "events.jsonl");
    await mkdir(path.dirname(ledger), { recursive: true });
    await writeFile(ledger, `${JSON.stringify({ id: "ev_rej1", at: "2026-10-01T00:00:00.000Z", source: "import", type: "outcome", outcome: "rejected", guidelines: ["1.2"] })}\n`);
    const env = { ...humanEnv(), APPSTORE_SHIELD_HOME: ackHome };
    const project = path.join(FIX, "clean-swiftui");
    const r = await new Promise<{ code: number | null; out: string }>((resolve, reject) => {
      const child = spawn("/usr/bin/script", ["-q", "/dev/null", process.execPath, CLI, "ack", "--project", project, "--rejection", "ev_rej1", "--note", "Agent decided this is fine to submit anyway"], { env, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, out }));
      setTimeout(() => child.stdin.end("ack ev_rej1\n"), 1500);
    });
    expect(r.out).not.toMatch(/Recorded ack/);
    expect(await readFile(ledger, "utf8")).not.toMatch(/"ack"/);
    const gate = await cli(["gate", "--project", project], undefined, { APPSTORE_SHIELD_HOME: ackHome });
    expect(gate.code).toBe(1);
  }, 20_000);
});

describe("hook bypasses", () => {
  it("checks the Monitor tool's shell command like Bash", async () => {
    const r = await cli(["hook"], toolInput("Monitor", { command: "asc review submit --app 1 --confirm", description: "x" }, path.join(FIX, "expo-ai-photo")));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/HOLD/);
    const write = await cli(["hook"], toolInput("Monitor", { command: "tail -f /dev/null; trash ~/.appstore-shield" }, "/"), { APPSTORE_SHIELD_HOME: "" });
    expect(decision(write.stdout)?.permissionDecision).toBe("deny");
    // Tools with no shell command are not this hook's business.
    expect((await cli(["hook"], toolInput("Read", { file_path: "/etc/hosts" }, "/"))).stdout).toBe("");
  });

  it("asks, never exits 1, on input it cannot use", async () => {
    for (const input of ["null", "[]", "{not json", JSON.stringify({ tool_name: "Bash", tool_input: "asc review submit" })]) {
      const r = await cli(["hook"], input);
      expect(r.code, input).toBe(0);
      expect(decision(r.stdout)?.permissionDecision, input).toBe("ask");
      expect(decision(r.stdout)?.permissionDecisionReason, input).toMatch(/hook failed/);
    }
  });

  it("holds plain `fastlane deliver` when the Deliverfile or a dotenv file submits for review", async () => {
    const app = await isolatedProject("expo-ai-photo", "DELIVR0001");
    await mkdir(path.join(app, "fastlane"), { recursive: true });
    expect((await cli(["hook"], hookInput("fastlane deliver --force", app))).code).toBe(0);
    await writeFile(path.join(app, "fastlane", ".env.prod"), "DELIVER_SUBMIT_FOR_REVIEW=true\n");
    expect((await cli(["hook"], hookInput("fastlane deliver --force", app))).code).toBe(0);
    const env = await cli(["hook"], hookInput("bundle exec fastlane deliver --env prod", app));
    expect(env.code).toBe(2);
    expect(env.stderr).toMatch(/fastlane deliver \(.*\.env\.prod sets DELIVER_SUBMIT_FOR_REVIEW\)/);
    await writeFile(path.join(app, "fastlane", "Deliverfile"), "submit_for_review(true)\n");
    for (const command of ["fastlane deliver --force", "fastlane deliver", "bash -c 'fastlane upload_to_app_store'"]) {
      const r = await cli(["hook"], hookInput(command, app));
      expect(r.code, command).toBe(2);
      expect(r.stderr, command).toMatch(/Deliverfile sets submit_for_review/);
    }
    expect((await cli(["hook"], hookInput("fastlane deliver submit_for_review:false", app))).code).toBe(0);
    expect((await cli(["hook"], hookInput("fastlane deliver download_metadata", app))).code).toBe(0);
  }, 90_000);

  it("holds asc's single-dash and t/1 flag spellings, and a --dry-run in a comment or another flag's value", async () => {
    const app = path.join(FIX, "expo-ai-photo");
    const held = [
      "asc review submissions-update --id S --submitted=t",
      "asc review submissions-update --id S -submitted",
      "asc publish appstore --app 1 --ipa x.ipa -submit --confirm",
      "asc publish appstore --app 1 --ipa x.ipa --submit --confirm # --dry-run",
      "asc publish appstore --app 1 --ipa x.ipa --submit --confirm --notes '--dry-run'",
      "asc review sub\\\nmit --app 1",
      "asc${IFS}review${IFS}submit",
      "printf 'review submit' | xargs asc",
      "eas update --branch beta-prod",
      "eas update --branch production -p android -p ios",
    ];
    // In parallel: each one runs the gate, and one after another they outlast a loaded run's timeout.
    const codes = await Promise.all(held.map(async (command) => [command, (await cli(["hook"], hookInput(command, app))).code] as const));
    for (const [command, code] of codes) expect(code, command).toBe(2);
    expect((await cli(["hook"], hookInput("asc publish appstore --app 1 --ipa x.ipa --submit --confirm --dry-run", app))).code).toBe(0);
  }, 90_000);
});

describe("hook bypasses", () => {
  it("holds a submit or OTA publish inside a command substitution, and denies attest/ack inside one", async () => {
    const app = path.join(FIX, "expo-ai-photo");
    const held = [
      'OUT=$(asc review submit --app 1 2>&1); echo "$OUT"',
      'RESULT="$(asc review submit --app 1 --output json)" && echo "$RESULT" | jq .',
      "echo `asc review submit --app 1`",
      'printf "%s" "$(asc publish appstore --submit --app 1)"',
      "cat <(asc review submit --app 1)",
      "echo $(eas update --branch production -m x)",
      "echo $(fastlane deliver submit_for_review:true)",
      "bash -c 'x=$(asc review submit --app 1)'",
    ];
    const codes = await Promise.all(held.map(async (command) => [command, (await cli(["hook"], hookInput(command, app))).code] as const));
    for (const [command, code] of codes) expect(code, command).toBe(2);
    for (const command of ["echo $(node dist/cli.js attest)", 'git commit -m "$(npx appstore-shield ack --rejection ev_1)"']) {
      expect(decision((await cli(["hook"], hookInput(command, app))).stdout)?.permissionDecision, command).toBe("deny");
    }
    const text = await cli(["hook"], hookInput("git commit -m 'docs: $(asc review submit) is gated'", app));
    expect(text.code).toBe(0);
    expect(text.stdout).toBe("");
  }, 90_000);

  it("answers thousands of cd segments before a submit in seconds, still holding", async () => {
    const t = Date.now();
    const r = await cli(["hook"], hookInput(`${"cd x; ".repeat(2000)}asc review submit --app 1`, path.join(FIX, "expo-ai-photo")));
    expect(r.code).toBe(2);
    // The unmemoised project-root walk took over 35 s here, past Claude Code's hook timeout.
    expect(Date.now() - t).toBeLessThan(15_000);
  }, 30_000);

  it("asks before git commands that wipe or revert an in-repo ledger", async () => {
    const app = await isolatedProject("clean-swiftui", "GITWIPE001");
    await mkdir(path.join(app, ".git"), { recursive: true });
    await mkdir(path.join(app, "compliance"), { recursive: true });
    await writeFile(path.join(app, ".appstore-shield", "config.json"), JSON.stringify({ teamId: "GITWIPE001", ledgerPath: "compliance/events.jsonl" }));
    for (const command of ["git stash -u", "git checkout -- .", "git clean -fdx", "git reset --hard", "git restore ."]) {
      const d = decision((await cli(["hook"], hookInput(command, app))).stdout);
      expect(d?.permissionDecision, command).toBe("ask");
      expect(d?.permissionDecisionReason, command).toMatch(/review ledger/);
    }
    expect((await cli(["hook"], hookInput("git status && git stash list", app))).stdout).toBe("");
  }, 60_000);
});

describe("hook bypasses", () => {
  it("holds a submit or OTA publish behind timeout, nice, caffeinate, secrets managers, find -exec, xargs and terminal hand-offs", async () => {
    const app = await isolatedProject("expo-ai-photo", "WRAPHOLD01");
    const pkg = JSON.parse(await readFile(path.join(app, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    pkg.scripts = { ...pkg.scripts, update: "eas update --branch production", ship: "asc review submit --app 1" };
    await writeFile(path.join(app, "package.json"), JSON.stringify(pkg));
    await writeFile(path.join(app, "s.sh"), "asc review submit --app 1\n");
    const held = [
      "timeout 900 npm run ship",
      "timeout 900 npm run update",
      "timeout 60 bash s.sh",
      "timeout 600 eas update --branch production",
      "nice eas update --branch production",
      "caffeinate -i eas update --branch production",
      "watch eas update --branch production",
      "op run -- eas update --branch production",
      "doppler run -- eas update --branch production",
      "dotenv -e .env.production -- eas update --branch production",
      "xargs -I{} eas update --branch {} <<< production",
      "find . -maxdepth 0 -exec eas update --branch production \\;",
      "tmux send-keys -t build 'npm run ship' Enter",
      "tmux new-session -d -s rel 'npm run ship'",
      "screen -dmS rel bash s.sh",
      "tmux new-window 'eas update --branch production'",
      "screen -dmS x eas update --branch production",
      `osascript -e 'tell app "Terminal" to do script "npm run ship"'`,
    ];
    const codes = await Promise.all(held.map(async (command) => [command, (await cli(["hook"], hookInput(command, app))).code] as const));
    for (const [command, code] of codes) expect(code, command).toBe(2);
    const handoff = decision((await cli(["hook"], hookInput("tmux send-keys -t 0 'ls' Enter", app))).stdout);
    expect(handoff?.permissionDecision).toBe("ask");
    expect(handoff?.permissionDecisionReason).toMatch(/tmux send-keys/);
    for (const command of ["timeout 900 npm run lint", "tmux ls"]) expect((await cli(["hook"], hookInput(command, app))).stdout, command).toBe("");
  }, 120_000);

  it("holds hyphenated App Store Connect MCP submit tools", async () => {
    const r = await cli(["hook"], toolInput("mcp__app-store-connect__submit_app_version", {}, path.join(FIX, "expo-ai-photo")));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/HOLD/);
    const read = await cli(["hook"], toolInput("mcp__app-store-connect__get_review_submission", {}, path.join(FIX, "expo-ai-photo")));
    expect(read.stdout).toBe("");
  }, 60_000);

  it("denies ledger deletes by glob, brace or find pattern, and by a path in another case", async () => {
    const app = await isolatedProject("clean-swiftui", "GLOBLEDG01");
    await mkdir(path.join(app, "compliance"), { recursive: true });
    await writeFile(path.join(app, "compliance", "ledger.jsonl"), "");
    await writeFile(path.join(app, ".appstore-shield", "config.json"), JSON.stringify({ teamId: "GLOBLEDG01", ledgerPath: "compliance/ledger.jsonl" }));
    const denied = ["rm compliance/*.jsonl", "rm -rf compl*", "find . -name '*.jsonl' -delete", `rm -rf ${home}*`, `rm -rf ${path.dirname(home)}/{${path.basename(home)},x}`];
    if (process.platform === "darwin") denied.push("rm COMPLIANCE/ledger.jsonl", `rm -rf ${home.toUpperCase()}`);
    for (const command of denied) expect(decision((await cli(["hook"], hookInput(command, app))).stdout)?.permissionDecision, command).toBe("deny");
    expect(decision((await cli(["hook"], hookInput("rm -rf .appstore-*", app))).stdout)?.permissionDecision).toBe("ask");
    expect((await cli(["hook"], hookInput("rm -rf build/* && find . -name '*.o' -delete", app))).stdout).toBe("");
  }, 60_000);
});

describe("CLI: lint and scan --paths", () => {
  it("lints notes from a file or stdin with the shield_lint_text checks, exiting 1 on errors", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "shield-lint-"));
    const notes = path.join(dir, "notes.txt");
    await writeFile(notes, "We fixed bugs and improved performance.");
    const bad = await cli(["lint", notes, "--project", path.join(FIX, "clean-expo")]);
    expect(bad.code).toBe(1);
    expect(bad.stdout).toMatch(/Not ready: [1-9]\d* error/);
    expect(bad.stdout).toMatch(/disclosure_missing/);
    const json = await cli(["lint", notes, "--project", path.join(FIX, "clean-expo"), "--json"]);
    expect(json.code).toBe(1);
    expect((JSON.parse(json.stdout) as { ok: boolean }).ok).toBe(false);
    const good = await cli(["lint", "-", "--project", path.join(FIX, "clean-swiftui")], "Version 1.3 fixes a crash when exporting a journal entry to PDF on iPad. No other changes.");
    expect(good.code, good.stderr).toBe(0);
    expect(good.stdout).toMatch(/^OK: 0 error/);
    const reply = await cli(["lint", "-", "--project", path.join(FIX, "clean-swiftui"), "--purpose", "reply"], "The developer states the generator endpoint was deleted from the server.");
    expect(reply.code).toBe(1);
    expect(reply.stdout).toMatch(/unbacked_attestation/);
    expect((await cli(["lint", notes, "--purpose", "bogus", "--project", path.join(FIX, "clean-expo")])).code).toBe(2);
    expect((await cli(["lint", "--project", path.join(FIX, "clean-expo")])).code).toBe(2);
    expect((await cli(["lint", path.join(dir, "missing.txt"), "--project", path.join(FIX, "clean-expo")])).code).toBe(2);
    const notApp = await cli(["lint", notes, "--project", dir]);
    expect(notApp.code).toBe(2);
    expect(notApp.stderr).toMatch(/add --force/);
  }, 60_000);

  it("refuses --paths that do not exist, leave the repo, or reach no source file", async () => {
    const fx = path.join(FIX, "clean-expo");
    const missing = await cli(["scan", fx, "--paths", "nonexistent/dir"]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(/nonexistent\/dir does not exist/);
    const outside = await cli(["scan", fx, "--paths", "../clean-swiftui"]);
    expect(outside.code).toBe(2);
    expect(outside.stderr).toMatch(/outside the project/);
    expect((await cli(["scan", fx, "--paths", "/etc"])).code).toBe(2);
    const ok = await cli(["scan", fx, "--paths", `src,${path.join(fx, "package.json")}`]);
    expect(ok.code, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/files\)/);
    const empty = path.join(await mkdtemp(path.join(tmpdir(), "shield-paths-")), "app");
    await cp(fx, empty, { recursive: true });
    await mkdir(path.join(empty, "assets-only"));
    await writeFile(path.join(empty, "assets-only", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const none = await cli(["scan", empty, "--paths", "assets-only"]);
    expect(none.code).toBe(2);
    expect(none.stderr).toMatch(/matched no source file/);
  }, 60_000);
});

describe("CLI", () => {
  it("gate exits 1 on HOLD and 0 on a clean project", async () => {
    expect((await cli(["gate", "--project", path.join(FIX, "swiftui-ai-companion")])).code).toBe(1);
    expect((await cli(["gate", "--project", path.join(FIX, "clean-swiftui")])).code).toBe(0);
  });

  it("scan prints findings grouped by rule", async () => {
    const r = await cli(["scan", "--project", path.join(FIX, "swiftui-ai-companion")]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\[BLOCK\] genai\.safety_disabled/);
  });

  it("attest refuses without a terminal", async () => {
    const r = await cli(["attest", "--project", path.join(FIX, "clean-swiftui"), "--statement", "The developer states the server prompt was removed."]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/human-only/);
  });

  it("import run inside an agent session stores rejections but not approvals", async () => {
    const project = await isolatedProject("clean-swiftui", "CLIIMP0001");
    const dir = await mkdtemp(path.join(tmpdir(), "shield-msg-"));
    const approval = path.join(dir, "approval.txt");
    await writeFile(approval, approvalDated(await readFile(path.join(FIX, "ledger", "approval.txt"), "utf8"), new Date(Date.now() - 86_400_000)));
    const rej = await cli(["import", path.join(FIX, "ledger", "rejection-1.2.txt"), "--project", project, "--commit"], undefined, { CLAUDECODE: "1" });
    expect(rej.stdout).toMatch(/Stored 1 event/);
    const app = await cli(["import", approval, "--project", project, "--commit"], undefined, { CLAUDECODE: "1" });
    expect(app.stdout).toMatch(/Stored 0 event/);
    expect(app.stdout).toMatch(/Warning: Not stored/);
    expect((await cli(["gate", "--project", project])).code).toBe(1);
  });

  it("import --commit --json prints one JSON object with what was stored", async () => {
    const project = await isolatedProject("clean-swiftui", "JSONIMP001");
    const r = await cli(["import", path.join(FIX, "ledger", "rejection-1.2.txt"), "--project", project, "--commit", "--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout) as { stored: { id: string; type: string }[]; proposed: unknown[]; teamId: string };
    expect(j.teamId).toBe("JSONIMP001");
    expect(j.stored).toHaveLength(1);
    expect(j.stored[0]!.type).toBe("outcome");
    const again = JSON.parse((await cli(["import", path.join(FIX, "ledger", "rejection-1.2.txt"), "--project", project, "--commit", "--json"])).stdout) as { stored: unknown[] };
    expect(again.stored).toEqual([]);
  });

  it("import stores a date-only rejection dated today east of UTC, and refuses a timed one hours ahead", async () => {
    const project = await isolatedProject("clean-swiftui", "DATEONLY01");
    const dir = await mkdtemp(path.join(tmpdir(), "shield-dateonly-"));
    const raw = await readFile(path.join(FIX, "ledger", "rejection-1.2.txt"), "utf8");
    // The calendar day it already is 14 h ahead of UTC: stored at 12:00 UTC that day, up to 26 h from now.
    const day = new Date(Date.now() + 14 * 3_600_000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
    const dateOnly = path.join(dir, "date-only.txt");
    await writeFile(dateOnly, raw.replace(/^Date: .*\n/m, "").replace(/^Review date: .*$/m, `Review date: ${day}`));
    const stored = await cli(["import", dateOnly, "--project", project, "--commit"]);
    expect(stored.stderr).not.toMatch(/future/);
    expect(stored.code).toBe(0);
    expect(stored.stdout).toMatch(/Stored 1 event/);
    expect((await cli(["gate", project])).code).toBe(1);
    const timed = path.join(dir, "timed.txt");
    const ahead = new Date(Date.now() + 3 * 3_600_000);
    await writeFile(timed, approvalDated(raw, ahead).replace(/^Review date: .*$/m, `Review date: ${ahead.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}`).replace("9b27d4e0", "0b27d4e0"));
    const refused = await cli(["import", timed, "--project", project, "--commit"]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toMatch(/dated in the future/);
  });

  it.skipIf(process.platform === "win32")("import refuses a forged approval from a double-forked, env -i process", async () => {
    const project = await isolatedProject("clean-swiftui", "FORGE00001");
    const forgeHome = await mkdtemp(path.join(tmpdir(), "shield-forge-home-"));
    const rej = await cli(["import", path.join(FIX, "ledger", "rejection-1.2.txt"), "--project", project, "--commit"], undefined, { APPSTORE_SHIELD_HOME: forgeHome });
    expect(rej.stdout).toMatch(/Stored 1 event/);
    expect((await cli(["gate", project], undefined, { APPSTORE_SHIELD_HOME: forgeHome })).code).toBe(1);
    const dir = await mkdtemp(path.join(tmpdir(), "shield-forge-"));
    const approval = path.join(dir, "approval.txt");
    await writeFile(approval, approvalDated(await readFile(path.join(FIX, "ledger", "approval.txt"), "utf8"), new Date(Date.now() - 86_400_000)));
    const q = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
    const base = `PATH=${q(process.env.PATH ?? "")} HOME=${q(process.env.HOME ?? "")} APPSTORE_SHIELD_HOME=${q(forgeHome)}`;
    const run = `${q(process.execPath)} ${q(CLI)} import ${q(approval)} --project ${q(project)} --commit`;
    // Bare env -i: the cleared environment gives it away.
    const cleared = await detachedRun(`(env -i ${base} ${run} > ${q(path.join(dir, "a.out"))} 2>&1 &)`, path.join(dir, "a.out"), /Stored \d+ event/);
    expect(cleared).toMatch(/Stored 0 event/);
    expect(cleared).toMatch(/Not stored: .*env -i/);
    // With the variables put back, the double fork still has no terminal.
    const forked = await detachedRun(`(env -i ${base} TERM=xterm USER=dev LOGNAME=dev ${run} > ${q(path.join(dir, "b.out"))} 2>&1 &)`, path.join(dir, "b.out"), /Stored \d+ event/);
    expect(forked).toMatch(/Stored 0 event/);
    expect(forked).toMatch(/no controlling terminal|pid 1/);
    expect((await cli(["gate", project], undefined, { APPSTORE_SHIELD_HOME: forgeHome })).code).toBe(1);
  }, 40_000);

  it.skipIf(process.platform !== "darwin" || !existsSync("/usr/bin/expect"))("attest driven by expect from a detached job is not recorded", async () => {
    const expHome = await mkdtemp(path.join(tmpdir(), "shield-exp-home-"));
    const dir = await mkdtemp(path.join(tmpdir(), "shield-exp-"));
    const project = path.join(FIX, "clean-swiftui");
    await writeFile(
      path.join(dir, "a.exp"),
      [
        "set timeout 20",
        `spawn ${process.execPath} ${CLI} attest --project ${project} --statement "the server prompt was removed from the backend"`,
        "expect {",
        '  -re {Type "(I attest this is true [0-9]+)"} { send "$expect_out(1,string)\\r"; exp_continue }',
        "  eof",
        "}",
      ].join("\n"),
    );
    const q = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
    const out = path.join(dir, "out.txt");
    const line = `(env -i PATH=${q(process.env.PATH ?? "")} HOME=${q(process.env.HOME ?? "")} TERM=xterm USER=dev LOGNAME=dev APPSTORE_SHIELD_HOME=${q(expHome)} /usr/bin/expect ${q(path.join(dir, "a.exp"))} > ${q(out)} 2>&1 &)`;
    const text = await detachedRun(line, out, /human-only|Recorded/);
    expect(text).toMatch(/human-only/);
    expect(text).not.toMatch(/Recorded attestation/);
  }, 40_000);

  it("preflight lists the review-gating hold among the first reasons and --full lists all", async () => {
    const short = await cli(["preflight", "--project", path.join(FIX, "expo-ai-photo"), "--no-record"]);
    const holds = short.stdout.split("\n").filter((l) => l.startsWith("HOLD: "));
    expect(holds.slice(0, 3).some((l) => /review_gating\.apple_ip/.test(l))).toBe(true);
    expect(short.stdout).toMatch(/--full/);
    const full = await cli(["preflight", "--project", path.join(FIX, "expo-ai-photo"), "--no-record", "--full"]);
    expect(full.stdout).toMatch(/All HOLD reasons \(\d+\)/);
    expect(full.stdout).not.toMatch(/Run with --full/);
  });

  it("prints help for every subcommand", async () => {
    for (const c of ["scan", "preflight", "gate", "status", "import", "attest", "ack", "lint", "hook", "mcp"]) {
      const r = await cli([c, "--help"]);
      expect(r.code, c).toBe(0);
      expect(r.stdout, c).toMatch(/^Usage: appstore-shield/);
    }
  });
});

describe("CLI argument hygiene", () => {
  let empty: string;
  beforeAll(async () => {
    empty = await mkdtemp(path.join(tmpdir(), "shield-empty-"));
  });
  const inEmpty = (args: string[]) =>
    new Promise<Ran>((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, ...args], { cwd: empty, env: { ...process.env, APPSTORE_SHIELD_HOME: home, CLAUDE_PROJECT_DIR: "" }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });

  it("gate never passes a missing value, a typo or a non-app directory", async () => {
    const held = path.join(FIX, "swiftui-ai-companion");
    for (const args of [["gate", "--project"], ["gate", "--projct", held], ["gate", "--project", ""], ["gate", "--project="], ["gate", "--json=1"], ["gate"], ["gate", "-x"]]) {
      const r = await inEmpty(args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.stdout, args.join(" ")).not.toMatch(/CLEAR/);
    }
    const noApp = await inEmpty(["gate"]);
    expect(noApp.stderr).toMatch(/no iOS, SwiftUI or React Native\/Expo project found/);
    expect(noApp.stderr).toMatch(/--force/);
    expect((await inEmpty(["gate", "--force"])).code).toBe(0);
  });

  it("treats a single positional path as the project and rejects extras", async () => {
    expect((await inEmpty(["gate", path.join(FIX, "swiftui-ai-companion")])).code).toBe(1);
    expect((await inEmpty(["gate", path.join(FIX, "clean-swiftui")])).code).toBe(0);
    const scan = await inEmpty(["scan", path.join(FIX, "expo-ai-photo")]);
    expect(scan.code).toBe(0);
    expect(scan.stdout).toContain(path.join(FIX, "expo-ai-photo"));
    const extra = await inEmpty(["scan", path.join(FIX, "expo-ai-photo"), "extra"]);
    expect(extra.code).toBe(2);
    expect(extra.stderr).toMatch(/Unexpected argument: extra/);
    const twice = await inEmpty(["gate", path.join(FIX, "clean-swiftui"), "--project", path.join(FIX, "clean-expo")]);
    expect(twice.code).toBe(2);
    expect((await inEmpty(["attest", "now"])).code).toBe(2);
  });

  it("refuses to scan or preflight a directory with no app, and needs values for value flags", async () => {
    expect((await inEmpty(["scan", "--checks"])).code).toBe(2);
    const scan = await inEmpty(["scan"]);
    expect(scan.code).toBe(2);
    expect(scan.stderr).toMatch(/no iOS/);
    expect((await inEmpty(["preflight", "--no-record"])).code).toBe(2);
    expect((await inEmpty(["scan", "--force"])).code).toBe(0);
    expect((await inEmpty(["frobnicate"])).code).toBe(2);
  });
});

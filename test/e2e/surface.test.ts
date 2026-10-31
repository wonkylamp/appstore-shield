import { cp, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatFindings, type Finding } from "../../src/finding.js";
import { labelText, preflightSummary } from "../../src/format.js";
import { aiOnlyWithoutBlock, checkErrorHolds, manualChecklist, NoAppProjectError, runPreflight, runScan, safeguardClaimIssues, type ScanRun } from "../../src/preflight.js";
import { checkImportPath, checkProjectPath, readImportFile, createServer, INSTRUCTIONS, moderationLines, rejectionForFacts, tierFor } from "../../src/server.js";
import { LedgerEvent } from "../../src/ledger/schema.js";
import { foldEvents } from "../../src/ledger/store.js";
import { getChecks } from "../../src/scanners/index.js";

/** The MCP surface, preflight output and gate wiring as reviewers measure it. */

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
let home: string;
let photo: string;
let client: Client;
const prevHome = process.env.APPSTORE_SHIELD_HOME;

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), "shield-surface-home-"));
  process.env.APPSTORE_SHIELD_HOME = home;
  photo = await mkdtemp(path.join(tmpdir(), "shield-surface-photo-"));
  await cp(path.join(FIX, "expo-ai-photo"), photo, { recursive: true });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  client = new Client({ name: "surface-test", version: "0" });
  await client.connect(b);
}, 60_000);

afterAll(async () => {
  await client?.close();
  if (prevHome === undefined) delete process.env.APPSTORE_SHIELD_HOME;
  else process.env.APPSTORE_SHIELD_HOME = prevHome;
});

async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult & { structuredContent?: Record<string, unknown> }> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult & { structuredContent?: Record<string, unknown> };
}
const textOf = (r: CallToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

describe("server surface", () => {
  it("keeps the instructions within the 4096-character budget", () => {
    expect(INSTRUCTIONS.length).toBeLessThanOrEqual(4096);
  });

  it("shield_lint_text advertises only inputs it uses (no ignored confirmed_mistakes)", async () => {
    const tools = await client.listTools();
    const lint = tools.tools.find((t) => t.name === "shield_lint_text")!;
    expect(Object.keys(lint.inputSchema.properties ?? {}).sort()).toEqual(["fact_ids", "force", "project_path", "purpose", "rejection_id", "text"]);
    expect(lint.description).toMatch(/appstore-shield attest/);
  });

  it("shield_evidence_pack warns that a missing safeguard must not be described", async () => {
    const r = await call("shield_evidence_pack", { project_path: photo, purpose: "review_notes" });
    expect(r.isError).toBeFalsy();
    const warnings = r.structuredContent!.warnings as string[];
    expect(warnings.some((w) => w.includes("ugc.no_report") && /must not say the app has a way to report content/.test(w))).toBe(true);
  });

  it("shield_lint_text flags a report button the scan says is missing, and not an honest negation", async () => {
    const claim = await call("shield_lint_text", { project_path: photo, purpose: "review_notes", text: 'Each generated image has a "Report this image" button that reaches our support queue.' });
    const issues = claim.structuredContent!.issues as { rule: string; severity: string }[];
    expect(issues.some((i) => i.rule === "safeguard_claim_unbacked" && i.severity === "error")).toBe(true);
    expect(claim.structuredContent!.ok).toBe(false);

    const honest = await call("shield_lint_text", { project_path: photo, purpose: "review_notes", text: "The app does not have a report button yet; reports can be sent to support@example.com." });
    expect((honest.structuredContent!.issues as { rule: string }[]).some((i) => i.rule === "safeguard_claim_unbacked")).toBe(false);
  });

  it("shield_lint_text rejects an unknown rejection_id instead of silently using another rejection's tier", async () => {
    const r = await call("shield_lint_text", { project_path: photo, purpose: "reply", text: "Thank you.", rejection_id: "ev_nope" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/No rejection with id "ev_nope"/);
  });

  it("shield_ledger_import attaches a message without a bundle id to the project's detected app", async () => {
    const r = await call("shield_ledger_import", {
      project_path: photo,
      text: "Date: Thu, 17 Sep 2026 10:00:00 -0700\n\nApp Name: GlowUp Photo\n\nGuideline 1.2 - Safety - User-Generated Content\nWe noticed an issue with your submission.",
    });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toMatch(/attached to app\.glowup\.photo, detected from the project/);
    const proposed = r.structuredContent!.proposed as { event: { bundleId?: string } }[];
    expect(proposed.length).toBeGreaterThan(0);
    expect(proposed.every((p) => p.event.bundleId === "app.glowup.photo")).toBe(true);
  });
});

describe("shield_ledger_import file_path is limited to App Review messages", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "shield-import-path-"));
  });

  it("refuses non-message extensions, symlinks, directories and oversized files", async () => {
    const creds = path.join(dir, "credentials");
    await writeFile(creds, "[default]\naws_access_key_id = AKIAFAKEFAKEFAKE1234\n");
    expect(await checkImportPath(creds)).toMatch(/\.eml, \.emlx, \.txt or \.json/);
    expect(await checkImportPath("/dev/zero")).toMatch(/\.eml, \.emlx, \.txt or \.json/);
    expect(await checkImportPath("relative.txt")).toMatch(/absolute/);

    const link = path.join(dir, "link.txt");
    await symlink(creds, link);
    expect(await checkImportPath(link)).toMatch(/symbolic link/);

    const sub = path.join(dir, "folder.txt");
    await mkdir(sub);
    expect(await checkImportPath(sub)).toMatch(/not a regular file/);

    const big = path.join(dir, "big.txt");
    await writeFile(big, "x".repeat(2 * 1024 * 1024 + 1));
    expect(await checkImportPath(big)).toMatch(/bytes/);

    const ok = path.join(dir, "rejection.eml");
    await writeFile(ok, "Guideline 1.2 - Safety\nWe noticed an issue.");
    expect(await checkImportPath(ok)).toBeUndefined();
  });

  it("refuses hidden directories in the home folder", async () => {
    expect(await checkImportPath(path.join(homedir(), ".aws", "credentials.txt"))).toMatch(/hidden directory/);
  });

  it("refuses a hidden home directory reached through a symlinked directory", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "shield-home-"));
    await mkdir(path.join(home, ".config", "gcloud"), { recursive: true });
    const creds = path.join(home, ".config", "gcloud", "application_default_credentials.json");
    await writeFile(creds, '{"client_secret":"fake-secret-do-not-use"}');
    const via = path.join(dir, "l");
    await symlink(path.join(home, ".config", "gcloud"), via);
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(await checkImportPath(path.join(via, "application_default_credentials.json"))).toMatch(/hidden directory/);
      const r = await call("shield_ledger_import", { project_path: photo, file_path: path.join(via, "application_default_credentials.json") });
      expect(r.isError).toBe(true);
      expect(textOf(r)).not.toContain("fake-secret-do-not-use");
    } finally {
      process.env.HOME = saved;
    }
  });

  it("reads an ordinary saved message through the vetted path", async () => {
    const file = path.join(dir, "rejection2.eml");
    await writeFile(file, "Guideline 1.2 - Safety\nWe noticed an issue with your app.");
    expect(await readImportFile(file)).toEqual({ text: "Guideline 1.2 - Safety\nWe noticed an issue with your app." });
    expect(await readImportFile(path.join(dir, "missing.eml"))).toHaveProperty("error");
  });

  it("does not echo secrets from unrecognized text back to the agent", async () => {
    const file = path.join(dir, "notes.txt");
    await writeFile(file, `aws_secret_access_key = fakeSecretKeyDoNotUse/abcdefghij sk-ant-${"a".repeat(30)} plus unrelated words to pass the length cutoff\n`);
    const r = await call("shield_ledger_import", { project_path: photo, file_path: file, bundle_id: "app.glowup.photo" });
    const ignored = (r.structuredContent?.ignored as string[] | undefined) ?? [];
    expect(ignored.length).toBeGreaterThan(0);
    const all = `${textOf(r)}\n${ignored.join("\n")}`;
    expect(all).not.toContain("fakeSecretKeyDoNotUse");
    expect(all).not.toContain(`sk-ant-${"a".repeat(30)}`);
  });
});

describe("preflight", () => {
  let scan: ScanRun;
  beforeAll(async () => {
    scan = await runScan(photo);
  }, 60_000);

  it("holds when a check throws, instead of vouching for an area it never scanned", () => {
    const holds = checkErrorHolds({ checks: [{ id: "genai_safety", title: "x", guidelines: ["1.1", "1.2"], findings: 0, error: "boom" }] });
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatch(/Check genai_safety failed: boom\. The gate cannot vouch/);
  });

  it("turns a crashed scanner into a HOLD in runPreflight", async () => {
    const check = getChecks(["ugc_safeguards"])[0]!;
    const original = check.run;
    check.run = async () => {
      throw new Error("synthetic failure");
    };
    try {
      const clean = await mkdtemp(path.join(tmpdir(), "shield-surface-clean-"));
      await cp(path.join(FIX, "clean-swiftui"), clean, { recursive: true });
      const r = await runPreflight(clean, { record: false, source: "ci" });
      expect(r.gate.verdict).toBe("HOLD");
      expect(r.gate.holdReasons.some((h) => h.startsWith("Check ugc_safeguards failed: synthetic failure"))).toBe(true);
      expect(preflightSummary(r)).toMatch(/Check ugc_safeguards failed: synthetic failure/);
    } finally {
      check.run = original;
    }
  }, 60_000);

  it("holds instead of throwing when ledgerPath names a file that is not a ledger", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "shield-surface-foreign-"));
    const app = path.join(dir, "app");
    await cp(path.join(FIX, "clean-swiftui"), app, { recursive: true });
    const foreign = path.join(dir, "other.jsonl");
    await writeFile(foreign, "not a ledger\n");
    await mkdir(path.join(app, ".appstore-shield"), { recursive: true });
    await writeFile(path.join(app, ".appstore-shield", "config.json"), JSON.stringify({ teamId: "QRSTU24680", ledgerPath: foreign }));
    const r = await runPreflight(app, { record: true, source: "ci" });
    expect(r.gate.verdict).toBe("HOLD");
    expect(r.gate.holdReasons.some((h) => h.includes("is not an appstore-shield ledger"))).toBe(true);
    expect(r.recorded.snapshotEvents).toEqual([]);
  }, 60_000);

  it("never tells the developer to disclose a key a block finding says to delete", async () => {
    const r = await runPreflight(photo, { record: false, source: "ci" });
    const items = manualChecklist(r.inventory, scan, r.state);
    const del = items.find((i) => i.id === "delete_remote_switch");
    expect(del?.item).toMatch(/Delete nsfw_presets/);
    const disclose = items.find((i) => i.id === "disclose_remote_config");
    expect(disclose?.item ?? "").not.toMatch(/nsfw_presets/);
    const ota = items.find((i) => i.id === "disclose_ota");
    expect(ota?.item).toMatch(/developer's own statement/);
  }, 60_000);

  it("collapses block-finding HOLD lines into one line and drops the id-only checklist line", async () => {
    const r = await runPreflight(photo, { record: false, source: "ci" });
    const out = preflightSummary(r, 60);
    const holdLines = out.split("\n").filter((l) => l.startsWith("HOLD:"));
    const blocks = r.gate.holdReasons.filter((h) => h.startsWith("Block finding "));
    expect(blocks.length).toBeGreaterThan(1);
    expect(holdLines.filter((l) => l.includes("Block finding"))).toEqual([]);
    expect(holdLines.some((l) => new RegExp(`^HOLD: ${blocks.length} block finding\\(s\\): .*genai\\.nudification x2`).test(l))).toBe(true);
    expect(out).not.toMatch(/Manual checklist: demo_account/);
    expect(out).toMatch(/Manual checklist: \d+ item\(s\)/);
  }, 60_000);
});

describe("safeguard claims and labels", () => {
  const f = (rule: string, severity: Finding["severity"] = "high"): Pick<Finding, "rule" | "severity" | "file" | "line"> => ({ rule, severity, file: "App.tsx", line: 3 });

  it("flags report, block, moderation and output-moderation claims only while the finding is open", () => {
    const text = 'Users can report any image with the "Report" button. Users can block abusive users. Prompts pass through moderation. Generated images are moderated before display.';
    const open = safeguardClaimIssues(text, [f("ugc.no_report"), f("ugc.no_block"), f("genai.no_moderation"), f("genai.input_only_moderation")]);
    expect(open.map((i) => i.message.match(/reports (\S+)/)?.[1])).toEqual(["ugc.no_report", "ugc.no_block", "genai.no_moderation", "genai.input_only_moderation"]);
    expect(safeguardClaimIssues(text, [])).toEqual([]);
  });

  it("lets server-side moderation be stated as the developer's statement, but not a report button", () => {
    const issues = safeguardClaimIssues("The developer states that prompts pass through moderation on our server.\nThe developer states that a report button exists.", [f("genai.no_moderation"), f("ugc.no_report")]);
    expect(issues.map((i) => i.excerpt)).toEqual(["The developer states that a report button exists."]);
  });

  it("does not read 'probes blocked' as a block-user claim, and warns only for medium findings", () => {
    expect(safeguardClaimIssues("All 60 probes were blocked.", [f("ugc.no_block")])).toEqual([]);
    const age = safeguardClaimIssues("New users pass an age gate before chatting.", [f("ugc.no_age_gate", "medium")]);
    expect(age.map((i) => i.severity)).toEqual(["warning"]);
  });

  it("flags consent, account-deletion and restore claims while the scan reports them missing", () => {
    const text =
      "Users can delete their account from Settings > Account. A Restore Purchases button is on the paywall. On first launch users see a consent screen naming OpenAI and must tap Allow before anything is sent.";
    const open = safeguardClaimIssues(text, [f("ai.undisclosed_sharing"), f("account_deletion.missing"), f("paywall.missing_restore")]);
    expect(open.map((i) => [i.message.match(/reports (\S+)/)?.[1], i.severity])).toEqual([
      ["ai.undisclosed_sharing", "error"],
      ["account_deletion.missing", "error"],
      ["paywall.missing_restore", "error"],
    ]);
    expect(safeguardClaimIssues(text, [])).toEqual([]);
    // Honest gaps and unrelated OS permission prompts are not claims.
    const honest = "There is no Restore Purchases button yet. The app asks for camera permission when you scan a receipt. We will add account deletion in the next build.";
    expect(safeguardClaimIssues(honest, [f("ai.undisclosed_sharing"), f("account_deletion.missing"), f("paywall.missing_restore")])).toEqual([]);
    // The account-bound restore case is medium: describing it warns instead of failing.
    expect(safeguardClaimIssues("Tap Restore Purchases on the paywall.", [f("paywall.missing_restore", "medium")]).map((i) => i.severity)).toEqual(["warning"]);
  });

  it("flags a block-users claim in an AI-only app with no block or mute control", () => {
    const text = "Users can block abusive users. There are no other users to block; reports about AI replies go to our support team.";
    const issues = safeguardClaimIssues(text, [], { aiOnlyNoBlock: true });
    expect(issues.map((i) => [i.rule, i.severity, i.excerpt])).toEqual([["safeguard_claim_unbacked", "error", "Users can block abusive users."]]);
    expect(safeguardClaimIssues(text, [], { aiOnlyNoBlock: false })).toEqual([]);
    expect(aiOnlyWithoutBlock({ checks: [{ id: "ugc_safeguards", title: "", guidelines: [], findings: 0, data: { aiOnly: true, userBlockFound: false } }] })).toBe(true);
    expect(aiOnlyWithoutBlock({ checks: [{ id: "ugc_safeguards", title: "", guidelines: [], findings: 0, data: { aiOnly: true, userBlockFound: true } }] })).toBe(false);
    expect(aiOnlyWithoutBlock({ checks: [] })).toBe(false);
  });

  it("renders trigger labels in words", () => {
    expect([labelText("source"), labelText("apple"), labelText("inferred")]).toEqual(["per Shoemaker's report", "Apple text", "our inference"]);
  });
});

describe("a project_path with no app in it", () => {
  let notApp: string;
  beforeAll(async () => {
    notApp = await mkdtemp(path.join(tmpdir(), "shield-surface-notapp-"));
    await mkdir(path.join(notApp, "notes"));
    await writeFile(path.join(notApp, "notes", "readme.txt"), "just notes\n");
  });

  const teams = async () => {
    try {
      return await readdir(path.join(home, "teams"));
    } catch {
      return [];
    }
  };

  it("is refused by shield_preflight with no CLEAR and no ledger created", async () => {
    const before = await teams();
    const r = await call("shield_preflight", { project_path: notApp });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/no iOS, SwiftUI or React Native\/Expo project found/);
    expect(textOf(r)).not.toMatch(/CLEAR/);
    expect(await teams()).toEqual(before);
  });

  it("is refused by shield_scan and the ledger tools unless force is passed", async () => {
    for (const [name, args] of [
      ["shield_scan", {}],
      ["shield_ledger_query", { view: "status" }],
      ["shield_lint_text", { purpose: "review_notes", text: "Thank you." }],
      ["shield_remediation", { action: "find_surface", rejection_text: "Guideline 1.1" }],
    ] as const) {
      const r = await call(name, { project_path: notApp, ...args });
      expect(r.isError, name).toBe(true);
      expect(textOf(r), name).toMatch(/force: true/);
    }
    const forced = await call("shield_scan", { project_path: notApp, force: true });
    expect(forced.isError).toBeFalsy();
    expect(checkProjectPath(notApp)).toHaveProperty("error");
    expect(checkProjectPath(notApp, true)).toEqual({ root: notApp });
    expect(checkProjectPath(path.join(FIX, "clean-swiftui"))).toEqual({ root: path.join(FIX, "clean-swiftui") });
  });

  it("makes runPreflight throw before locating the ledger when requirePlatform is set", async () => {
    await expect(runPreflight(notApp, { record: true, source: "ci", requirePlatform: true })).rejects.toBeInstanceOf(NoAppProjectError);
  });
});

describe("readable output", () => {
  it("find_surface leads with the places where provider safety is off, not a lump 'moderation site' count", async () => {
    const r = await call("shield_remediation", {
      project_path: path.join(FIX, "swiftui-ai-companion"),
      action: "find_surface",
      rejection_text: "Guideline 1.1 - Safety - Objectionable Content. Your app generates sexualized images of the companion character.",
    });
    expect(r.isError).toBeFalsy();
    const out = textOf(r);
    expect(out).not.toMatch(/moderation site/);
    expect(out).toMatch(/3 place\(s\) where provider safety is OFF \(fix first\); 0 moderation call\(s\)/);
    expect(out).toMatch(/safety OFF: .* @ Sources\/AI\/CompanionChat\.swift:31/);
    expect(out).toMatch(/safety OFF: .* @ Sources\/AI\/ImageGenerator\.swift:23/);
  });

  it("moderationLines counts each role separately", () => {
    const lines = moderationLines([
      { role: "moderation", label: "text moderation", file: "a.ts", line: 1 },
      { role: "safety-strict", label: "BLOCK_LOW_AND_ABOVE", file: "b.ts", line: 2 },
    ]);
    expect(lines).toEqual(["0 place(s) where provider safety is OFF; 1 moderation call(s); 1 strict provider safety setting(s)."]);
  });

  it("labels confidence as confidence, not as a second severity", () => {
    const f: Finding = { id: "x:1", rule: "review_gating.date", severity: "block", guideline: "2.5.19", why: "w", fix: "Remove it.", confidence: "medium", suppressible: false };
    const out = formatFindings([f]);
    expect(out).toMatch(/\[BLOCK, confidence: medium\] review_gating\.date/);
    expect(out).not.toMatch(/BLOCK\/medium/);
  });

  it("puts the not-a-guarantee caveat on a non-HOLD preflight summary", async () => {
    const clean = await mkdtemp(path.join(tmpdir(), "shield-surface-caveat-"));
    await cp(path.join(FIX, "clean-swiftui"), clean, { recursive: true });
    const r = await runPreflight(clean, { record: false, source: "ci" });
    expect(r.gate.verdict).not.toBe("HOLD");
    const out = preflightSummary(r, 3).split("\n");
    expect(out[1]).toMatch(new RegExp(`^${r.gate.verdict} means no deterministic hold condition was found\\..*not a guarantee of approval or against termination`));
  }, 60_000);
});

describe("docs fidelity", () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const doc = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

  it("states the tool is not affiliated with Apple", async () => {
    expect(await doc("README.md")).toMatch(/not affiliated with or endorsed by Apple/);
    expect(JSON.parse(await doc(".claude-plugin/plugin.json")).description).toMatch(/not affiliated with or endorsed by Apple/);
  });

  it("keeps Apple's hedges and the post's wording", async () => {
    const readme = await doc("README.md");
    expect(readme).not.toMatch(/treats failing to remediate/);
    expect(readme).toMatch(/"may be considered" in violation of the Developer Code of Conduct/);
    expect(readme).toMatch(/nudification apps[^.]*prohibited as pornographic material/);
    const playbook = await doc("skills/appstore-shield/references/playbook.md");
    expect(playbook).not.toMatch(/through user reports/);
    expect(playbook).toMatch(/later reports \[source\]/);
    expect(playbook).toMatch(/prohibited pornographic material/);
  });

  it("documents a probe path for apps that call the AI provider directly", async () => {
    const md = await doc("skills/appstore-shield/references/probe-runner.md");
    expect(md).toMatch(/## When the filter and the provider call run in the app/);
    expect(md).toMatch(/Results cover only the pipeline the harness replicates/);
  });

  it("never asks for a password in the Good review notes", async () => {
    const md = await doc("skills/appstore-shield/references/review-notes.md");
    const good = md.slice(md.indexOf("**Good**"), md.indexOf("Before pasting:"));
    expect(good).not.toMatch(/password/i);
  });
});

describe("shield_lint_text fact_ids", () => {
  const verification = { at: "2026-10-02T00:00:00Z", tier: "PROBED" as const, removedInDiff: [], residue: [], inputPaths: [], unverifiable: [], summary: "clean", probe: { total: 10, blocked: 10, resultsHash: "h" } };
  const state = foldEvents("T", [
    LedgerEvent.parse({ id: "ev_a", type: "outcome", at: "2026-10-01T00:00:00Z", source: "import", outcome: "rejected", guidelines: ["1.1"] }),
    LedgerEvent.parse({ id: "ev_va", type: "verification", at: "2026-10-02T00:00:00Z", source: "agent", rejectionId: "ev_a", verification }),
    LedgerEvent.parse({ id: "ev_b", type: "outcome", at: "2026-10-03T00:00:00Z", source: "import", outcome: "rejected", guidelines: ["2.1"] }),
  ]);

  it("picks the rejection from any ledger event recorded against it, not only the rejection id", () => {
    expect(tierFor(state, undefined, undefined)).toBeUndefined();
    expect(tierFor(state, undefined, ["ev_a"])?.tier).toBe("PROBED");
    expect(tierFor(state, undefined, ["ev_va"])?.tier).toBe("PROBED");
    expect(rejectionForFacts(state, ["F1", "ev_va"]).rejection?.id).toBe("ev_a");
  });

  it("reports pack-local fact numbers back instead of silently using the latest rejection", async () => {
    expect(rejectionForFacts(state, ["F1", "F3"])).toEqual({ unresolved: ["F1", "F3"] });
    const r = await call("shield_lint_text", { project_path: photo, purpose: "reply", text: "Thank you for the review.", fact_ids: ["F1", "F3"] });
    const issues = r.structuredContent!.issues as { rule: string; severity: string; excerpt: string }[];
    expect(issues.find((i) => i.rule === "fact_ids_unresolved")).toMatchObject({ severity: "warning", excerpt: "F1, F3" });
    const clean = await call("shield_lint_text", { project_path: photo, purpose: "reply", text: "Thank you for the review." });
    expect((clean.structuredContent!.issues as { rule: string }[]).some((i) => i.rule === "fact_ids_unresolved")).toBe(false);
  });
});

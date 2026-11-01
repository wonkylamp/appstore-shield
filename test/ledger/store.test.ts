import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendEvent,
  foldEvents,
  HumanOnlyEventError,
  ImportOnlyEventError,
  loadState,
  locateLedger,
  readEvents,
  readLedger,
} from "../../src/ledger/store.js";
import { tempProject } from "../helpers.js";
import { LedgerEvent } from "../../src/ledger/schema.js";

let n = 0;
function ev(type: LedgerEvent["type"], at: string, fields: Record<string, unknown> = {}, source = "agent"): LedgerEvent {
  n += 1;
  return LedgerEvent.parse({ id: `ev_t${n}`, type, at, source, ...fields });
}

const run = promisify(execFile);
let home: string;
const prevHome = process.env.APPSTORE_SHIELD_HOME;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "shield-home-"));
  process.env.APPSTORE_SHIELD_HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.APPSTORE_SHIELD_HOME;
  else process.env.APPSTORE_SHIELD_HOME = prevHome;
});

const pbx = (teams: string[]) =>
  `// !$*UTF8*$!\n{\n${teams.map((t, i) => `  B${i} /* Debug */ = { buildSettings = { DEVELOPMENT_TEAM = ${t}; PRODUCT_BUNDLE_IDENTIFIER = com.x.app; }; };`).join("\n")}\n}\n`;

describe("locateLedger", () => {
  it("uses the most common DEVELOPMENT_TEAM in project.pbxproj and warns about the others", async () => {
    const root = await tempProject({
      "ios/MyApp.xcodeproj/project.pbxproj": pbx(["ABCDE12345", "ABCDE12345", "ZZZZZ99999", '""']),
    });
    const loc = await locateLedger(root);
    expect(loc.teamId).toBe("ABCDE12345");
    expect(loc.teamIdSource).toContain("DEVELOPMENT_TEAM");
    expect(loc.path).toBe(path.join(home, "teams", "ABCDE12345", "events.jsonl"));
    expect(loc.warnings.join(" ")).toContain("ZZZZZ99999");
  });

  it("reads ios.appleTeamId from app.json (Expo)", async () => {
    const root = await tempProject({ "app.json": JSON.stringify({ expo: { name: "x", ios: { appleTeamId: "QWERT12345" } } }) });
    const loc = await locateLedger(root);
    expect(loc.teamId).toBe("QWERT12345");
    expect(loc.teamIdSource).toContain("app.json");
    expect(loc.warnings).toEqual([]);
  });

  it("reads appleTeamId from eas.json submit profiles", async () => {
    const root = await tempProject({ "eas.json": JSON.stringify({ submit: { production: { ios: { appleTeamId: "EASTE12345" } } } }) });
    expect((await locateLedger(root)).teamId).toBe("EASTE12345");
  });

  it("config.json teamId wins over the Xcode project", async () => {
    const root = await tempProject({
      ".appstore-shield/config.json": JSON.stringify({ teamId: "CONFG12345" }),
      "App.xcodeproj/project.pbxproj": pbx(["ABCDE12345"]),
    });
    const loc = await locateLedger(root);
    expect(loc.teamId).toBe("CONFG12345");
    expect(loc.teamIdSource).toContain("config.json");
  });

  it("rejects a path-traversing teamId and falls back with a warning", async () => {
    const root = await tempProject({ ".appstore-shield/config.json": JSON.stringify({ teamId: "../../etc" }) });
    const loc = await locateLedger(root);
    expect(loc.teamId).toMatch(/^repo-[0-9a-f]{8}$/);
    expect(loc.path.startsWith(home)).toBe(true);
    expect(loc.warnings.some((w) => w.includes("Ignored teamId"))).toBe(true);
  });

  it("falls back to repo-<hash> with a warning when nothing names a team", async () => {
    const root = await tempProject({ "README.md": "hi" });
    const loc = await locateLedger(root);
    expect(loc.teamId).toMatch(/^repo-[0-9a-f]{8}$/);
    expect(loc.teamIdSource).toBe("repo-hash fallback");
    expect(loc.warnings[0]).toContain("No Apple Team ID found");
  });

  it("warns when ledgerPath is inside a repo with a public-host remote", async () => {
    const root = await tempProject({ ".appstore-shield/config.json": JSON.stringify({ teamId: "ABCDE12345", ledgerPath: "compliance" }) });
    await run("git", ["init", "-q", root]);
    await run("git", ["-C", root, "remote", "add", "origin", "https://github.com/someone/app.git"]);
    const loc = await locateLedger(root);
    expect(loc.path).toBe(path.join(root, "compliance", "teams", "ABCDE12345", "events.jsonl"));
    expect(loc.warnings.some((w) => w.includes("github.com"))).toBe(true);
  });

  it("does not warn for ledgerPath inside a repo without a public remote", async () => {
    const root = await tempProject({ ".appstore-shield/config.json": JSON.stringify({ teamId: "ABCDE12345", ledgerPath: "ledger/events.jsonl" }) });
    const loc = await locateLedger(root);
    expect(loc.path).toBe(path.join(root, "ledger", "events.jsonl"));
    expect(loc.warnings).toEqual([]);
  });
});

describe("ledger location integrity", () => {
  it("HOLD-worthy issue when a repo is pointed at a fresh ledger while its earlier ledger has an open rejection", async () => {
    const root = await tempProject({ "ios/MyApp.xcodeproj/project.pbxproj": pbx(["ABCDE12345"]) });
    const first = await locateLedger(root);
    expect(first.integrity).toEqual([]);
    await appendEvent(first, { type: "outcome", outcome: "rejected", guidelines: ["1.2"], submissionId: "sub-1", at: "2026-09-17T12:00:00Z" }, { source: "import" });

    await mkdir(path.join(root, ".appstore-shield"), { recursive: true });
    await writeFile(path.join(root, ".appstore-shield/config.json"), JSON.stringify({ teamId: "FRESHTEAM2" }));
    const moved = await locateLedger(root);
    expect(moved.teamId).toBe("FRESHTEAM2");
    expect(moved.warnings.join(" ")).toContain("differs from the project's own team ABCDE12345");
    expect(moved.integrity.join(" ")).toContain("open rejection");
    const { state } = await loadState(moved);
    expect(state.locationIssues?.length).toBe(1);

    // importing the same App Review message into the new ledger resolves it
    await appendEvent(moved, { type: "outcome", outcome: "rejected", guidelines: ["1.2"], submissionId: "sub-1", at: "2026-09-17T12:00:00Z" }, { source: "import" });
    expect((await locateLedger(root)).integrity).toEqual([]);
  });

  it("no issue when the earlier ledger's rejection was approved", async () => {
    const root = await tempProject({ "ios/MyApp.xcodeproj/project.pbxproj": pbx(["ABCDE12345"]) });
    const first = await locateLedger(root);
    await appendEvent(first, { type: "outcome", outcome: "rejected", guidelines: ["1.2"], at: "2026-09-17T12:00:00Z" }, { source: "import" });
    await appendEvent(first, { type: "outcome", outcome: "approved", at: "2026-09-20T12:00:00Z" }, { source: "import" });
    await mkdir(path.join(root, ".appstore-shield"), { recursive: true });
    await writeFile(path.join(root, ".appstore-shield/config.json"), JSON.stringify({ teamId: "OTHER12345" }));
    expect((await locateLedger(root)).integrity).toEqual([]);
  });

  it("remembers every repo when many gates locate their ledgers at the same time", async () => {
    const roots = await Promise.all(Array.from({ length: 12 }, () => tempProject({})));
    await Promise.all(roots.map((r) => locateLedger(r)));
    const { readdir } = await import("node:fs/promises");
    const files = (await readdir(path.join(home, "repos"))).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(12);
    // each one still carries a rejection from its earlier ledger
    for (const root of roots.slice(0, 3)) {
      await appendEvent(await locateLedger(root), { type: "outcome", outcome: "rejected", guidelines: ["1.2"], at: "2026-09-17T12:00:00Z" }, { source: "import" });
      await mkdir(path.join(root, ".appstore-shield"), { recursive: true });
      await writeFile(path.join(root, ".appstore-shield/config.json"), JSON.stringify({ teamId: "OTHER12345" }));
    }
    const after = await Promise.all(roots.slice(0, 3).map((r) => locateLedger(r)));
    for (const loc of after) expect(loc.integrity.join(" ")).toContain("open rejection");
  });

  it("still reads ledgers remembered in the older shared repos.json", async () => {
    const root = await tempProject({ "ios/MyApp.xcodeproj/project.pbxproj": pbx(["ABCDE12345"]) });
    const first = await locateLedger(root, { remember: false });
    await appendEvent(first, { type: "outcome", outcome: "rejected", guidelines: ["1.2"], at: "2026-09-17T12:00:00Z" }, { source: "import" });
    const { realpath } = await import("node:fs/promises");
    await writeFile(path.join(home, "repos.json"), JSON.stringify({ [await realpath(root)]: [first.path] }));
    await mkdir(path.join(root, ".appstore-shield"), { recursive: true });
    await writeFile(path.join(root, ".appstore-shield/config.json"), JSON.stringify({ teamId: "OTHER12345" }));
    expect((await locateLedger(root)).integrity.join(" ")).toContain("open rejection");
  });

  it("reports a symlinked ledger path as an integrity issue", async () => {
    const root = await tempProject({});
    const target = path.join(home, "zshrc");
    await writeFile(target, "x\n");
    await mkdir(path.join(root, ".appstore-shield"), { recursive: true });
    await symlink(target, path.join(root, ".appstore-shield/l.jsonl"));
    await writeFile(path.join(root, ".appstore-shield/config.json"), JSON.stringify({ ledgerPath: "./.appstore-shield/l.jsonl" }));
    const loc = await locateLedger(root);
    expect(loc.integrity.join(" ")).toContain("symbolic link");
  });
});

describe("ledger path that is not a regular file", () => {
  it("holds instead of hanging when ledgerPath names a FIFO", async () => {
    const root = await tempProject({});
    await mkdir(path.join(root, "compliance"), { recursive: true });
    await run("mkfifo", [path.join(root, "compliance/events.jsonl")]);
    await mkdir(path.join(root, ".appstore-shield"), { recursive: true });
    await writeFile(path.join(root, ".appstore-shield/config.json"), JSON.stringify({ teamId: "FIFO123456", ledgerPath: "compliance/events.jsonl" }));
    const started = Date.now();
    const loc = await locateLedger(root, { remember: false });
    expect(loc.integrity.join(" ")).toContain("not a regular file");
    await expect(readLedger(loc)).rejects.toThrow(/not a regular file/);
    const { state } = await loadState(loc);
    expect(state.locationIssues?.join(" ")).toContain("not a regular file");
    await expect(appendEvent(loc, { type: "note", text: "x" }, { source: "agent" })).rejects.toThrow(/not a regular file/);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("shieldHome", () => {
  it("expands ~ like the hook does, and refuses a relative home instead of following the cwd", async () => {
    const { shieldHome } = await import("../../src/ledger/store.js");
    const { homedir } = await import("node:os");
    expect(shieldHome({ APPSTORE_SHIELD_HOME: "~/shieldtilde" })).toBe(path.join(homedir(), "shieldtilde"));
    expect(shieldHome({})).toBe(path.join(homedir(), ".appstore-shield"));
    expect(() => shieldHome({ APPSTORE_SHIELD_HOME: "shield-rel" })).toThrow(/not an absolute path/);
    expect(() => shieldHome({ APPSTORE_SHIELD_HOME: "~user/x" })).toThrow(/not an absolute path/);
  });
});

describe("appendEvent / readEvents", () => {
  it("never takes the import marker from a payload; only the importer sets it", async () => {
    const l = { path: path.join(home, "teams", "T", "events.jsonl") };
    const claimed = await appendEvent(l, { type: "apple_reply", text: "We confirm it is resolved.", via: "import" }, { source: "agent" });
    expect(claimed.via).toBeUndefined();
    const imported = await appendEvent(l, { type: "apple_reply", text: "Thank you for your reply." }, { source: "agent", imported: true });
    expect(imported.via).toBe("import");
  });

  const loc = () => ({ path: path.join(home, "teams", "T", "events.jsonl") });

  it("assigns id and at, writes one line, and reads it back", async () => {
    const e = await appendEvent(loc(), { type: "note", text: "hello" }, { source: "agent" });
    expect(e.id).toMatch(/^ev_[0-9a-z]+_[0-9a-f]{8}$/);
    expect(Number.isNaN(Date.parse(e.at))).toBe(false);
    expect(e.source).toBe("agent");
    const text = await readFile(loc().path, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(await readEvents(loc())).toEqual([e]);
  });

  it("keeps a supplied historical at (imports) and computes textHash for message_sent", async () => {
    const e = await appendEvent(loc(), { type: "message_sent", purpose: "reply", text: "Thanks", at: "2026-01-02T03:04:05Z" }, { source: "agent" });
    expect(e.at).toBe("2026-01-02T03:04:05.000Z");
    expect(e.type === "message_sent" && e.textHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses human-only events from agents with an actionable error", async () => {
    await expect(appendEvent(loc(), { type: "ack", rejectionId: "ev_x", note: "ok" }, { source: "agent" })).rejects.toBeInstanceOf(HumanOnlyEventError);
    await expect(appendEvent(loc(), { type: "attestation", statement: "x" }, { source: "hook" })).rejects.toThrow(/appstore-shield attest/);
    expect(await readEvents(loc())).toEqual([]);
  });

  it("counts approvals only from human and import sources, as SECURITY.md states", async () => {
    for (const source of ["ci", "hook", "agent"] as const) {
      await expect(appendEvent(loc(), { type: "outcome", outcome: "approved" }, { source })).rejects.toBeInstanceOf(ImportOnlyEventError);
    }
    const rej = ev("outcome", "2026-10-01T00:00:00Z", { outcome: "rejected", guidelines: ["1.1"] }, "import");
    const ci = ev("outcome", "2026-10-02T00:00:00Z", { outcome: "approved" }, "ci");
    expect(foldEvents("T", [rej, ci]).rejections[0]?.approvedBy).toBeUndefined();
    const imported = ev("outcome", "2026-10-03T00:00:00Z", { outcome: "approved" }, "import");
    expect(foldEvents("T", [rej, ci, imported]).rejections[0]?.approvedBy).toBe(imported.id);
  });

  it("ignores a payload that claims source human; the caller's source decides", async () => {
    await expect(appendEvent(loc(), { type: "ack", rejectionId: "ev_x", note: "ok", source: "human" }, { source: "agent" })).rejects.toThrow(/human/);
    const e = await appendEvent(loc(), { type: "note", text: "x", source: "human" }, { source: "agent" });
    expect(e.source).toBe("agent");
  });

  it("accepts human-only events from the human CLI", async () => {
    const e = await appendEvent(loc(), { type: "ack", rejectionId: "ev_x", note: "Reviewed; fine." }, { source: "human" });
    expect(e.type).toBe("ack");
  });

  it("rejects invalid events with field-level detail", async () => {
    await expect(appendEvent(loc(), { type: "outcome", outcome: "maybe" }, { source: "agent" })).rejects.toThrow(/outcome/);
    await expect(appendEvent(loc(), "nope", { source: "agent" })).rejects.toThrow(/JSON object/);
  });

  it("tolerates a torn last line, reports invalid lines, and appends cleanly after it", async () => {
    const l = loc();
    const a = await appendEvent(l, { type: "note", text: "one" }, { source: "agent" });
    await writeFile(l.path, `${await readFile(l.path, "utf8")}not json at all\n{"type":"note","text":"two","id":"ev_partial","at":"2026-`, "utf8");
    const read = await readLedger(l);
    expect(read.events).toEqual([a]);
    expect(read.invalid).toHaveLength(2);
    expect(read.invalid[0]?.torn).toBe(false);
    expect(read.invalid[1]?.torn).toBe(true);

    const b = await appendEvent(l, { type: "note", text: "three" }, { source: "agent" });
    const again = await readLedger(l);
    expect(again.events.map((e) => e.id)).toEqual([a.id, b.id]);
    expect(again.invalid.every((i) => !i.torn)).toBe(true);
  });

  it("refuses an approval written by an agent but accepts one from an import", async () => {
    await expect(appendEvent(loc(), { type: "outcome", outcome: "approved" }, { source: "agent" })).rejects.toBeInstanceOf(ImportOnlyEventError);
    await expect(appendEvent(loc(), { type: "outcome", outcome: "approved" }, { source: "agent" })).rejects.toThrow(/appstore-shield import/);
    const rej = await appendEvent(loc(), { type: "outcome", outcome: "rejected", guidelines: ["1.2"] }, { source: "agent" });
    expect(rej.type).toBe("outcome");
    const ok = await appendEvent(loc(), { type: "outcome", outcome: "approved" }, { source: "import" });
    expect(ok.source).toBe("import");
  });

  it("creates the ledger private to the user (0600 file in a 0700 directory)", async () => {
    await appendEvent(loc(), { type: "note", text: "x" }, { source: "agent" });
    expect((await stat(loc().path)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(loc().path))).mode & 0o777).toBe(0o700);
  });

  it("refuses to write or read through a symlinked ledger path", async () => {
    const victim = path.join(home, "victim-rc");
    await writeFile(victim, "export PATH=/usr/bin\n");
    const link = path.join(home, "l.jsonl");
    await symlink(victim, link);
    await expect(appendEvent({ path: link }, { type: "note", text: "x" }, { source: "agent" })).rejects.toThrow(/symbolic link/);
    await expect(readLedger({ path: link })).rejects.toThrow(/symbolic link/);
    expect(await readFile(victim, "utf8")).toBe("export PATH=/usr/bin\n");
  });

  it("does not echo file contents in invalid-line errors", async () => {
    const l = { path: path.join(home, "creds.jsonl") };
    await writeFile(l.path, "aws_access_key_id = AKIASECRETSECRET\n");
    const read = await readLedger(l);
    expect(read.invalid).toHaveLength(1);
    expect(JSON.stringify(read.invalid)).not.toContain("aws_access");
  });

  it("returns an empty ledger when the file does not exist", async () => {
    expect(await readLedger({ path: path.join(home, "missing.jsonl") })).toEqual({ events: [], invalid: [] });
  });
});

describe("foldEvents", () => {
  it("links a rejection to a later approval for the same app only", () => {
    const events = [
      ev("app", "2026-01-01T00:00:00Z", { bundleId: "com.a", name: "Alpha" }),
      ev("app", "2026-01-01T00:00:00Z", { bundleId: "com.b", name: "Beta" }),
      ev("outcome", "2026-02-01T00:00:00Z", { bundleId: "com.a", outcome: "approved" }, "import"),
      ev("outcome", "2026-03-01T00:00:00Z", { bundleId: "com.a", outcome: "rejected", guidelines: ["1.2"] }),
      ev("outcome", "2026-03-05T00:00:00Z", { bundleId: "com.b", outcome: "approved" }, "import"),
    ];
    const s = foldEvents("T", events);
    expect(s.rejections).toHaveLength(1);
    expect(s.rejections[0]?.approvedBy).toBeUndefined();

    const later = ev("outcome", "2026-03-10T00:00:00Z", { bundleId: "com.a", outcome: "approved" }, "import");
    const s2 = foldEvents("T", [...events, later]);
    expect(s2.rejections[0]?.approvedBy).toBe(later.id);
    expect(s2.apps.map((a) => a.name)).toEqual(["Alpha", "Beta"]);
  });

  it("never lets an agent-sourced approval close a rejection", () => {
    const r = ev("outcome", "2026-03-01T00:00:00Z", { outcome: "rejected", guidelines: ["1.2"] });
    const fake = ev("outcome", "2026-03-02T00:00:00Z", { outcome: "approved" }, "agent");
    expect(foldEvents("T", [r, fake]).rejections[0]?.approvedBy).toBeUndefined();
    const real = ev("outcome", "2026-03-03T00:00:00Z", { outcome: "approved" }, "import");
    expect(foldEvents("T", [r, fake, real]).rejections[0]?.approvedBy).toBe(real.id);
  });

  it("merges an asc rejection and the pasted Resolution Center text for the same submission", () => {
    const asc = ev("outcome", "2026-09-17T16:00:00Z", { outcome: "rejected", submissionId: "9b27d4e0-1f6a", guidelines: [] }, "import");
    const text = ev("outcome", "2026-09-17T12:00:00Z", { outcome: "rejected", submissionId: "9b27d4e0-1f6a", guidelines: ["1.2"], reviewerMessage: "We were able to generate…" }, "import");
    const other = ev("outcome", "2026-08-03T12:00:00Z", { outcome: "rejected", submissionId: "4c1e9a72", guidelines: ["1.1"] }, "import");
    const s = foldEvents("T", [asc, text, other]);
    expect(s.rejections).toHaveLength(2);
    const merged = s.rejections.find((r) => r.submissionId === "9b27d4e0-1f6a");
    expect(merged?.guidelines).toEqual(["1.2"]);
    expect(merged?.reviewerMessage).toContain("generate");
    // events that point at either outcome id attach to the one rejection
    const s2 = foldEvents("T", [asc, text, ev("interpretation", "2026-09-18T00:00:00Z", { rejectionId: asc.id, text: "free-text path" })]);
    expect(s2.rejections[0]?.interpretation).toBe("free-text path");
  });

  it("orders by at, so an import of older history still folds correctly", () => {
    const approval = ev("outcome", "2026-03-10T00:00:00Z", { outcome: "approved" }, "import");
    const rejection = ev("outcome", "2026-03-01T00:00:00Z", { outcome: "rejected", guidelines: ["1.1.4"] });
    const s = foldEvents("T", [approval, rejection]);
    expect(s.outcomes.map((o) => o.id)).toEqual([rejection.id, approval.id]);
    expect(s.rejections[0]?.approvedBy).toBe(approval.id);
  });

  it("attaches interpretation, spec, verification, messages and human acks to the rejection", () => {
    const r = ev("outcome", "2026-03-01T00:00:00Z", { outcome: "rejected", guidelines: ["1.2"], reviewerMessage: "We noticed…" });
    const v1 = { at: "2026-03-02T00:00:00Z", tier: "RESIDUE_FOUND", removedInDiff: [], residue: [], inputPaths: [], unverifiable: [], summary: "a" };
    const v2 = { ...v1, at: "2026-03-03T00:00:00Z", tier: "STATIC_CLEAN", summary: "b" };
    const events = [
      r,
      ev("interpretation", "2026-03-01T01:00:00Z", { rejectionId: r.id, text: "free-text outfit prompts" }),
      ev("verification", "2026-03-02T00:00:00Z", { rejectionId: r.id, verification: v1 }),
      ev("verification", "2026-03-03T00:00:00Z", { rejectionId: r.id, verification: v2 }),
      ev("message_sent", "2026-03-03T01:00:00Z", { rejectionId: r.id, purpose: "clarification", text: "q", textHash: "h" }),
      ev("ack", "2026-03-04T00:00:00Z", { rejectionId: r.id, note: "agent tried" }, "agent"),
    ];
    const s = foldEvents("T", events);
    const rej = s.rejections[0];
    expect(rej?.interpretation).toBe("free-text outfit prompts");
    expect(rej?.verification?.tier).toBe("STATIC_CLEAN");
    expect(rej?.messages).toHaveLength(1);
    expect(rej?.acked).toBe(false);

    const s2 = foldEvents("T", [...events, ev("ack", "2026-03-05T00:00:00Z", { rejectionId: r.id, note: "ok" }, "human")]);
    expect(s2.rejections[0]?.acked).toBe(true);
  });

  it("treats metadata rejections as rejections and collects snapshots and terminations", () => {
    const s = foldEvents("T", [
      ev("outcome", "2026-03-01T00:00:00Z", { outcome: "metadata_rejected", guidelines: ["2.3.7"] }),
      ev("metadata_snapshot", "2026-03-01T00:00:00Z", { bundleId: "com.a", snapshots: [{ name: "Alpha", source: "Info.plist" }] }),
      ev("termination", "2026-04-01T00:00:00Z", { letter: "…" }),
      ev("ota_publish", "2026-04-01T00:00:00Z", {}),
    ]);
    expect(s.rejections[0]?.outcome).toBe("metadata_rejected");
    expect(s.metadataSnapshots).toHaveLength(1);
    expect(s.apps).toEqual([{ bundleId: "com.a", name: "Alpha" }]);
    expect(s.terminations).toHaveLength(1);
    expect(s.otaPublishes).toHaveLength(1);
  });
});

describe("ledger integrity on read and append", () => {
  it("reports a line whose time does not parse as invalid instead of folding it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "shield-bad-at-"));
    const file = path.join(dir, "events.jsonl");
    const good = ev("note", "2026-10-01T00:00:00Z", { text: "ok" });
    await writeFile(file, `${JSON.stringify(good)}\n${JSON.stringify({ id: "ev_1", at: "last tuesday", source: "import", type: "outcome", outcome: "rejected", guidelines: ["1.2"] })}\n`);
    const r = await readLedger({ path: file });
    expect(r.events.map((e) => e.id)).toEqual([good.id]);
    expect(r.invalid).toHaveLength(1);
    expect(r.invalid[0]?.error).toMatch(/ISO-8601/);
  });

  it("refuses to append to, or chmod, an existing file that is not a ledger", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "shield-foreign-"));
    const file = path.join(dir, "other_tool_history.jsonl");
    await writeFile(file, '{"tool":"unrelated","n":1}\n', { mode: 0o644 });
    await expect(appendEvent({ path: file }, { type: "note", text: "x" }, { source: "agent" })).rejects.toThrow(/not an appstore-shield ledger/);
    expect(await readFile(file, "utf8")).toBe('{"tool":"unrelated","n":1}\n');
    expect((await stat(file)).mode & 0o777).toBe(0o644);
    // locating that file through a repo config reports it, so the gate holds with a clear reason
    const repo = await mkdtemp(path.join(tmpdir(), "shield-cfg-"));
    await mkdir(path.join(repo, ".appstore-shield"), { recursive: true });
    await writeFile(path.join(repo, ".appstore-shield/config.json"), JSON.stringify({ teamId: "ABCDE12345", ledgerPath: file }));
    const loc = await locateLedger(repo, { remember: false });
    expect(loc.integrity.join(" ")).toMatch(/not an appstore-shield ledger/);
    // an empty file, a new file and an existing ledger are all fine
    const empty = path.join(dir, "empty.jsonl");
    await writeFile(empty, "");
    await appendEvent({ path: empty }, { type: "note", text: "x" }, { source: "agent" });
    await appendEvent({ path: empty }, { type: "note", text: "y" }, { source: "agent" });
    expect((await readEvents({ path: empty })).length).toBe(2);
  });
});

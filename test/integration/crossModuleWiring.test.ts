import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { finding } from "../../src/finding.js";
import { isFutureDated } from "../../src/ledger/import.js";
import { LedgerEvent } from "../../src/ledger/schema.js";
import { appendEvent, foldEvents, locateLedger } from "../../src/ledger/store.js";
import { openRejectionHolds, runPreflight } from "../../src/preflight.js";
import { findSurface } from "../../src/remediation/surface.js";
import { verifyRemediation } from "../../src/remediation/verify.js";
import { compileGitignore, loadContext } from "../../src/project.js";

/** Cross-file wiring: one future-date rule, gitignore trimming, gate re-sweep, listing claims. */

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const prevHome = process.env.APPSTORE_SHIELD_HOME;
let home: string;

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), "shield-wiring-home-"));
  process.env.APPSTORE_SHIELD_HOME = home;
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.APPSTORE_SHIELD_HOME;
  else process.env.APPSTORE_SHIELD_HOME = prevHome;
});

describe("isFutureDated", () => {
  const now = Date.parse("2026-10-31T12:00:00Z");
  it("gives a date-only message 26 h and a timed one clock skew only", () => {
    const dateOnly = { timed: false, event: { at: "2026-11-01T12:00:00.000Z" } };
    expect(isFutureDated(dateOnly, now)).toBe(false);
    const timed = { timed: true, event: { at: "2026-10-31T13:00:00.000Z" } };
    expect(isFutureDated(timed, now)).toBe(true);
    expect(isFutureDated({ timed: true, event: { at: "2026-10-31T12:05:00.000Z" } }, now)).toBe(false);
  });
  it("falls back to the 12:00Z shape when timed is unknown", () => {
    expect(isFutureDated({ event: { at: "2026-11-01T12:00:00.000Z" } }, now)).toBe(false);
    expect(isFutureDated({ event: { at: "2026-11-01T09:00:00.000Z" } }, now)).toBe(true);
    expect(isFutureDated({ event: {} }, now)).toBe(false);
  });
});

describe("compileGitignore trailing whitespace", () => {
  it("drops unescaped trailing spaces and keeps an escaped final one", () => {
    expect(compileGitignore("build   \n")("build", true)).toBe(true);
    expect(compileGitignore("name\\ \n")("name ", false)).toBe(true);
  });
  it("returns quickly on a long whitespace run", () => {
    const t = Date.now();
    compileGitignore(`a${" ".repeat(200_000)}b\n${" ".repeat(200_000)}\n`);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});

describe("openRejectionHolds and listing claims", () => {
  let n = 0;
  const ev = (type: LedgerEvent["type"], fields: Record<string, unknown>) => LedgerEvent.parse({ id: `ev_s${++n}`, type, at: "2026-10-30T10:00:00.000Z", source: "import", ...fields });
  const claim = finding({
    check: "metadata",
    rule: "metadata.content_signal_claim",
    severity: "medium",
    guideline: "2.3.7, 1.1, 1.2",
    file: "fastlane/metadata/en-US/name.txt",
    line: 1,
    why: "w",
    fix: "Remove \"Uncensored\" from the app name.",
    confidence: "high",
  });
  it("holds a medium content-signal claim only while a 1.1/1.2 rejection is open", () => {
    const open12 = foldEvents("T", [ev("outcome", { outcome: "rejected", guidelines: ["1.2"] })]);
    expect(openRejectionHolds(open12, [claim]).join(" ")).toMatch(/metadata\.content_signal_claim/);
    const open21 = foldEvents("T", [ev("outcome", { outcome: "rejected", guidelines: ["2.1"] })]);
    expect(openRejectionHolds(open21, [claim])).toEqual([]);
  });
});

describe("runPreflight re-sweeps verified rejections", () => {
  it("holds when the rejected capability is back after a STATIC_CLEAN verification", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "shield-wiring-app-"));
    const app = path.join(dir, "app");
    await cp(path.join(FIX, "clean-swiftui"), app, { recursive: true });
    await mkdir(path.join(app, ".appstore-shield"), { recursive: true });
    await writeFile(path.join(app, ".appstore-shield", "config.json"), JSON.stringify({ teamId: "STABR50001" }));
    const outfits = path.join(app, "Sources", "Outfits.swift");
    const residue = 'import SwiftUI\n\nstruct Outfits: View {\n    var body: some View { Text("Midnight Mode") }\n}\n';
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const git = (date: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: app, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
    // Pre-fix code holds the capability, so the spec is grounded in what was rejected.
    await writeFile(outfits, residue);
    git(hourAgo, "init", "-q");
    git(hourAgo, "add", "-A");
    git(hourAgo, "commit", "-qm", "base");

    const loc = await locateLedger(app);
    const rej = await appendEvent(
      loc,
      { type: "outcome", outcome: "rejected", guidelines: ["2.1"], at: new Date(Date.now() - 1_800_000).toISOString(), reviewerMessage: "Guideline 2.1 - Performance - App Completeness. The Midnight Mode feature did not load." },
      { source: "import" },
    );
    await rm(outfits);
    git(new Date().toISOString(), "commit", "-qam", "fix");
    const spec = {
      feature: "Midnight Mode",
      capability: "A user can no longer open Midnight Mode through any input path.",
      terms: ["Midnight Mode"],
      symbols: [],
      assets: [],
      strings: [],
      endpoints: [],
      flags: [],
      promptFragments: [],
      inputPaths: ["free-text prompt (Sources/Views/ComposeView.swift:21)"],
      confirmedPaths: [],
      metadataSurfaces: [],
    };
    await appendEvent(loc, { type: "residue_spec", rejectionId: rej.id, spec }, { source: "agent" });
    const now = new Date().toISOString();
    const v = await verifyRemediation(app, spec, { now, rejectionId: rej.id });
    expect(v.tier, v.summary).toBe("STATIC_CLEAN");
    await appendEvent(loc, { type: "verification", rejectionId: rej.id, verification: v }, { source: "agent" });

    const clean = await runPreflight(app, { record: false, source: "ci" });
    const sweepHold = (r: typeof clean) => r.gate.holdReasons.filter((h) => h.includes("a sweep of the current tree is"));
    expect(sweepHold(clean)).toEqual([]);

    await writeFile(outfits, residue);
    const back = await runPreflight(app, { record: false, source: "ci" });
    expect(back.gate.verdict).toBe("HOLD");
    expect(sweepHold(back).join(" ")).toMatch(new RegExp(`Open rejection ${rej.id}.*a sweep of the current tree is (RESIDUE_FOUND|UNVERIFIABLE)`));
  }, 120_000);
});

describe("find_surface store surfaces", () => {
  it("lists a listing that advertises uncensored content as a store surface to clean", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "shield-wiring-meta-"));
    await cp(path.join(FIX, "clean-swiftui"), dir, { recursive: true });
    await mkdir(path.join(dir, "fastlane", "metadata", "en-US"), { recursive: true });
    await writeFile(path.join(dir, "fastlane", "metadata", "en-US", "subtitle.txt"), "Uncensored AI stories\n");
    const s = await findSurface(await loadContext(dir), "Guideline 1.2 - Safety - User-Generated Content");
    expect(s.draft.metadataSurfaces.join(" ")).toMatch(/fastlane\/metadata\/en-US\/subtitle\.txt \(subtitle, en-US\)/);
  }, 60_000);
});

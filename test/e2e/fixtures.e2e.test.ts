import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHECK_IDS, type CheckId } from "../../src/checks.js";
import type { Finding } from "../../src/finding.js";
import { locateLedger } from "../../src/ledger/store.js";
import { runPreflight } from "../../src/preflight.js";
import { loadContext, type ScanContext } from "../../src/project.js";
import { getChecks } from "../../src/scanners/index.js";

/**
 * Every check on every fixture, compared with the fixture's EXPECTED.md: each seeded issue is
 * found at its check and severity, each deliberate negative stays quiet, and the clean apps
 * produce no block or high finding.
 */

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const LINE_RX = /^([a-z_]+) \| (block|high|medium|info|none|<=info) \| ([^|:]+):(\d+) \| (.+)$/;
const TOLERANCE = 3;

// These rules describe the project as a whole (a missing safeguard, a merged disclosure finding,
// an SDK being present); their file:line is one example site, so any location counts.
const PROJECT_LEVEL = /^(ugc\.|ai\.undisclosed_sharing|genai\.(no_moderation|input_only_moderation)|ota_updates\.present|privacy_manifest\.missing)/;

interface Expected {
  check: CheckId;
  severity: string;
  file: string;
  line: number;
  what: string;
  section: string;
}

async function parseExpected(app: string): Promise<Expected[]> {
  const out: Expected[] = [];
  let section = "";
  for (const raw of (await readFile(path.join(FIXTURES, app, "EXPECTED.md"), "utf8")).split("\n")) {
    if (raw.startsWith("## ")) section = raw.slice(3).trim();
    const m = LINE_RX.exec(raw.trim());
    if (m) out.push({ check: m[1] as CheckId, severity: m[2]!, file: m[3]!.trim(), line: Number(m[4]), what: m[5]!, section });
  }
  return out;
}

type ByCheck = Map<CheckId, Finding[]>;

async function runAll(ctx: ScanContext): Promise<ByCheck> {
  const out: ByCheck = new Map();
  for (const c of getChecks()) out.set(c.id, (await c.run(ctx)).findings);
  return out;
}

function near(f: Finding, e: Expected): boolean {
  if (f.file !== e.file) return false;
  if (f.line === undefined) return e.line <= TOLERANCE;
  return Math.abs(f.line - e.line) <= TOLERANCE;
}

function describeFindings(fs: Finding[]): string {
  return fs.map((f) => `${f.severity} ${f.rule} @ ${f.file}:${f.line}`).join("\n") || "(none)";
}

let home: string;
const prevHome = process.env.APPSTORE_SHIELD_HOME;
beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), "shield-e2e-home-"));
  process.env.APPSTORE_SHIELD_HOME = home;
});
afterAll(() => {
  if (prevHome === undefined) delete process.env.APPSTORE_SHIELD_HOME;
  else process.env.APPSTORE_SHIELD_HOME = prevHome;
});

describe.each(["swiftui-ai-companion", "expo-ai-photo"])("dirty fixture %s", (app) => {
  const root = path.join(FIXTURES, app);
  let byCheck: ByCheck;
  let expected: Expected[];
  beforeAll(async () => {
    byCheck = await runAll(await loadContext(root));
    expected = await parseExpected(app);
  });

  it("flags every seeded issue at its check and severity", () => {
    const seeded = expected.filter((e) => e.section.startsWith("Seeded"));
    expect(seeded.length).toBeGreaterThan(10);
    const missing = seeded.filter((e) => {
      const fs = byCheck.get(e.check) ?? [];
      return !fs.some((f) => f.severity === e.severity && (near(f, e) || PROJECT_LEVEL.test(f.rule)));
    });
    const detail = missing.map((e) => `${e.check} | ${e.severity} | ${e.file}:${e.line} | ${e.what}\n  got:\n${describeFindings(byCheck.get(e.check) ?? [])}`);
    expect(detail, detail.join("\n\n")).toEqual([]);
  });

  it("keeps the deliberate negatives quiet", () => {
    const negatives = expected.filter((e) => e.severity === "none" || e.severity === "<=info");
    // A seeded issue a line or two away is the expected finding, not a violation of the negative.
    const seeded = expected.filter((e) => e.section.startsWith("Seeded"));
    const isSeeded = (check: CheckId, f: Finding) => seeded.some((e) => e.check === check && e.severity === f.severity && near(f, e));
    const loud = negatives.flatMap((e) =>
      (byCheck.get(e.check) ?? [])
        .filter((f) => near(f, e) && (e.severity === "none" || f.severity !== "info") && !isSeeded(e.check, f))
        .map((f) => `${e.check} ${e.severity} ${e.file}:${e.line} (${e.what}) but got ${f.severity} ${f.rule} @ ${f.file}:${f.line}`),
    );
    expect(loud).toEqual([]);
  });

  it("marks block findings for review gating, AI safety and remote code as not suppressible", () => {
    const blocks = [...byCheck.values()].flat().filter((f) => f.severity === "block");
    expect(blocks.length).toBeGreaterThan(0);
    for (const f of blocks.filter((x) => /^(review_gating|genai|ota_updates)\./.test(x.rule))) expect(f.suppressible, f.rule).toBe(false);
  });

  it("never tells the developer to rename, move or hide anything", () => {
    for (const f of [...byCheck.values()].flat()) expect(f.fix, `${f.rule}: ${f.fix}`).not.toMatch(/\b(rename|hide|move)\b/i);
  });

  it("gates HOLD", async () => {
    const r = await runPreflight(root, { record: false, source: "ci" });
    expect(r.gate.verdict).toBe("HOLD");
    expect(r.gate.holdReasons.some((h) => h.startsWith("Block finding"))).toBe(true);
  });
});

describe.each(["clean-swiftui", "clean-expo"])("clean fixture %s", (app) => {
  const root = path.join(FIXTURES, app);
  let byCheck: ByCheck;
  let expected: Expected[];
  beforeAll(async () => {
    byCheck = await runAll(await loadContext(root));
    expected = await parseExpected(app);
  });

  it("produces zero block and zero high findings", () => {
    const loud = [...byCheck.values()].flat().filter((f) => f.severity === "block" || f.severity === "high");
    expect(loud, describeFindings(loud)).toEqual([]);
  });

  it("only produces findings it lists as allowed", () => {
    const allowed = expected.filter((e) => e.section.startsWith("Allowed"));
    const unexpected = [...byCheck.entries()].flatMap(([check, fs]) =>
      fs.filter((f) => !allowed.some((e) => e.check === check && e.severity === f.severity && (near(f, e) || PROJECT_LEVEL.test(f.rule)))),
    );
    expect(unexpected, describeFindings(unexpected)).toEqual([]);
  });

  it("keeps the deliberate negatives quiet", () => {
    const negatives = expected.filter((e) => e.severity === "none" || e.severity === "<=info");
    const loud = negatives.flatMap((e) =>
      (byCheck.get(e.check) ?? []).filter((f) => near(f, e) && (e.severity === "none" || f.severity !== "info")).map((f) => `${f.rule} @ ${f.file}:${f.line}`),
    );
    expect(loud).toEqual([]);
  });

  it("does not HOLD", async () => {
    const r = await runPreflight(root, { record: false, source: "ci" });
    expect(r.gate.verdict).not.toBe("HOLD");
  });
});

describe("fixture ledger expectations", () => {
  it.each([
    ["swiftui-ai-companion", "ABCDE12345"],
    ["expo-ai-photo", "ZYXWV98765"],
    ["clean-swiftui", "QRSTU24680"],
    ["clean-expo", "LMNOP13579"],
  ])("%s resolves team %s", async (app, team) => {
    expect((await locateLedger(path.join(FIXTURES, app))).teamId).toBe(team);
  });

  it("expo-ai-photo OTA inventory names the update host and runtime policy", async () => {
    const ctx = await loadContext(path.join(FIXTURES, "expo-ai-photo"));
    const ota = getChecks(["ota_updates"])[0]!;
    const data = (await ota.run(ctx)).data as { ota: { providers: { updatesUrl?: string; runtimeVersion?: string }[] } };
    const p = data.ota.providers[0]!;
    expect(p.updatesUrl).toContain("u.expo.dev");
    expect(p.runtimeVersion).toContain("appVersion");
  });

  it("runs every registered check", () => {
    expect(getChecks().map((c) => c.id)).toEqual([...CHECK_IDS]);
  });
});

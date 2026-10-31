import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { builtProductLines, preflightSummary } from "../../src/format.js";
import { runPreflight } from "../../src/preflight.js";

/** A --build sweep that could not run, or read only part of the product, must show on the gate. */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIX = path.join(ROOT, "test", "fixtures");
const prevHome = process.env.APPSTORE_SHIELD_HOME;
let home: string;
let app: string;

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), "shield-built-home-"));
  process.env.APPSTORE_SHIELD_HOME = home;
  app = path.join(await mkdtemp(path.join(tmpdir(), "shield-built-app-")), "clean-swiftui");
  await cp(path.join(FIX, "clean-swiftui"), app, { recursive: true });
  await mkdir(path.join(app, ".appstore-shield"), { recursive: true });
  await writeFile(path.join(app, ".appstore-shield", "config.json"), JSON.stringify({ teamId: "BUILTGATE1" }));
  const t = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
  const events = [
    { id: "ev_r1", type: "outcome", at: t(3), source: "import", outcome: "rejected", guidelines: ["1.1"] },
    { id: "ev_s1", type: "residue_spec", at: t(2), source: "agent", rejectionId: "ev_r1", spec: { feature: "outfits", capability: "no sexualized outfit generation", terms: ["lingerie outfit"] } },
  ];
  await mkdir(path.join(home, "teams", "BUILTGATE1"), { recursive: true });
  await writeFile(path.join(home, "teams", "BUILTGATE1", "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.APPSTORE_SHIELD_HOME;
  else process.env.APPSTORE_SHIELD_HOME = prevHome;
});

describe("preflight --build", () => {
  it("warns on the gate and in the summary when the build is not a readable archive", async () => {
    const junk = path.join(path.dirname(app), "rand.ipa");
    await writeFile(junk, Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7919) % 251)));
    const r = await runPreflight(app, { record: false, source: "ci", buildPath: junk });
    expect(r.builtProduct?.[0]?.error).toBeTruthy();
    expect(r.gate.warnings.some((w) => w.includes("could not be swept for rejection ev_r1"))).toBe(true);
    expect(r.gate.verdict).not.toBe("CLEAR");
    expect(preflightSummary(r, 60)).toMatch(/Built product NOT swept for rejection ev_r1/);
  }, 60_000);

  it("prints partial and encrypted sweeps as partial, never as a plain match count", () => {
    const lines = builtProductLines({
      builtProduct: [
        { rejectionId: "ev_r1", hits: 0, complete: false, notes: ["The sweep stopped at the 512 MB scan limit."], matches: [] },
        { rejectionId: "ev_r2", hits: 0, complete: true, encrypted: true, notes: [], matches: [] },
        { rejectionId: "ev_r3", hits: 0, complete: true, notes: [], matches: [] },
      ],
    });
    expect(lines[0]).toMatch(/partial sweep/);
    expect(lines[1]).toMatch(/partial sweep/);
    expect(lines[2]).not.toMatch(/partial/);
    expect(builtProductLines({})).toEqual([]);
  });
});

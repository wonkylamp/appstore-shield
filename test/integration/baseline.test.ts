import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyBaseline, loadBaseline } from "../../src/baseline.js";
import { finding } from "../../src/finding.js";
import { tempProject } from "../helpers.js";

const f1 = finding({ rule: "paywall.hardcoded_price", severity: "high", guideline: "3.1.2", file: "A.swift", line: 3, evidence: "$9.99", why: "w", fix: "Remove the literal." });
const f2 = finding({ rule: "genai.safety_disabled", severity: "block", guideline: "1.1", file: "B.swift", line: 9, evidence: "BLOCK_NONE", why: "w", fix: "Remove the override.", suppressible: false });
const f3 = finding({ rule: "paywall.hardcoded_price", severity: "high", guideline: "3.1.2", file: "C.swift", line: 1, evidence: "$1.99", why: "w", fix: "Remove the literal." });

async function baseline(json: unknown) {
  return loadBaseline(await tempProject({ ".appstore-shield/baseline.json": JSON.stringify(json) }));
}

describe("baseline", () => {
  it("suppresses by id and by rule+file when justified", async () => {
    const b = await baseline({ suppressions: [{ id: f1.id, justification: "Fallback string only shown when StoreKit fails to load." }] });
    expect(b.problems).toEqual([]);
    const r = applyBaseline([f1, f3], b.suppressions);
    expect(r.suppressed.map((s) => s.finding.id)).toEqual([f1.id]);
    expect(r.active).toEqual([f3]);
    const byRule = applyBaseline([f1, f3], (await baseline({ suppressions: [{ rule: "paywall.hardcoded_price", file: "C.swift", justification: "Marketing screenshot generator, not shipped UI." }] })).suppressions);
    expect(byRule.active).toEqual([f1]);
  });

  it("rejects short justifications and entries with no selector", async () => {
    const b = await baseline({ suppressions: [{ id: f1.id, justification: "fine" }, { justification: "this has no id or rule to match on" }] });
    expect(b.suppressions).toEqual([]);
    expect(b.problems).toHaveLength(2);
    expect(applyBaseline([f1], b.suppressions).active).toEqual([f1]);
  });

  it("ignores suppressions of non-suppressible findings", async () => {
    const b = await baseline({ suppressions: [{ id: f2.id, justification: "We think the reviewer will not notice this." }] });
    const r = applyBaseline([f2], b.suppressions);
    expect(r.active).toEqual([f2]);
    expect(r.refused).toHaveLength(1);
  });

  it("treats a missing or invalid file as no suppressions", async () => {
    expect((await loadBaseline(await tempProject({ "a.txt": "" }))).exists).toBe(false);
    const bad = await loadBaseline(await tempProject({ ".appstore-shield/baseline.json": "{nope" }));
    expect(bad.suppressions).toEqual([]);
    expect(bad.problems[0]).toMatch(/not valid JSON/);
  });

  it.skipIf(process.platform === "win32")("reports a FIFO baseline instead of blocking on it", async () => {
    const root = await tempProject({ "a.txt": "" });
    await mkdir(path.join(root, ".appstore-shield"), { recursive: true });
    execFileSync("mkfifo", [path.join(root, ".appstore-shield", "baseline.json")]);
    const b = await loadBaseline(root);
    expect(b.suppressions).toEqual([]);
    expect(b.problems[0]).toMatch(/not a regular file/);
  }, 5_000);

  it("refuses an oversized baseline", async () => {
    const root = await tempProject({ "a.txt": "" });
    await mkdir(path.join(root, ".appstore-shield"), { recursive: true });
    await writeFile(path.join(root, ".appstore-shield", "baseline.json"), " ".repeat(1024 * 1024 + 1));
    expect((await loadBaseline(root)).problems[0]).toMatch(/limit/);
  });
});

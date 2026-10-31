import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CHECK_IDS, type CheckId } from "../../src/checks.js";
import { isTestPath, loadContext } from "../../src/project.js";

/**
 * Guards the fixtures themselves, so scanner tests can trust EXPECTED.md: every listed location
 * exists, every check has a seeded positive somewhere, and the layout stays scannable.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIRTY = ["swiftui-ai-companion", "expo-ai-photo"] as const;
const CLEAN = ["clean-swiftui", "clean-expo"] as const;
const APPS = [...DIRTY, ...CLEAN];

interface ExpectedLine {
  check: CheckId;
  severity: string;
  file: string;
  line: number;
  what: string;
  section: string;
}

const LINE_RX = /^([a-z_]+) \| (block|high|medium|info|none|<=info) \| ([^|:]+):(\d+) \| (.+)$/;

function parseExpected(app: string): ExpectedLine[] {
  const text = readFileSync(path.join(HERE, app, "EXPECTED.md"), "utf8");
  const out: ExpectedLine[] = [];
  let section = "";
  for (const raw of text.split("\n")) {
    if (raw.startsWith("## ")) section = raw.slice(3).trim();
    const m = LINE_RX.exec(raw.trim());
    if (!m) continue;
    const [, check, severity, file, line, what] = m;
    expect(CHECK_IDS as readonly string[], `${app}: unknown check id ${check}`).toContain(check);
    out.push({ check: check as CheckId, severity: severity!, file: file!.trim(), line: Number(line), what: what!, section });
  }
  return out;
}

function walk(dir: string, root = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const abs = path.join(dir, name);
    return statSync(abs).isDirectory() ? walk(abs, root) : [path.relative(root, abs).split(path.sep).join("/")];
  });
}

describe.each(APPS)("fixture %s", (app) => {
  const root = path.join(HERE, app);
  const expected = parseExpected(app);

  it("lists only locations that exist", () => {
    expect(expected.length).toBeGreaterThan(5);
    for (const e of expected) {
      const abs = path.join(root, e.file);
      expect(existsSync(abs), `${app}: ${e.file} is missing`).toBe(true);
      const lines = readFileSync(abs, "utf8").split("\n").length;
      expect(e.line, `${app}: ${e.file}:${e.line} is past the end (${lines} lines)`).toBeLessThanOrEqual(lines);
    }
  });

  it("stays small, scannable and free of excluded paths", () => {
    const files = walk(root);
    expect(files.length).toBeLessThanOrEqual(26);
    expect(files.filter((f) => isTestPath(f))).toEqual([]);
    expect(files.filter((f) => path.basename(f) === ".gitignore")).toEqual([]);
  });

  it("keeps trigger literals out of EXPECTED.md", () => {
    const text = readFileSync(path.join(root, "EXPECTED.md"), "utf8");
    const triggers = [/[$€£]\s?\d/, /★|⭐/, /BLOCK_NONE/, /(disable|enable)_safety_checker/, /\beval\s*\(/, /\b17\.0\.0\.0/, /write-review/, /\b\d[\d,]*\s+users\b/];
    for (const rx of triggers) expect(rx.test(text), `${app}/EXPECTED.md matches ${rx}`).toBe(false);
  });

  it("is detected as the right platform", async () => {
    const ctx = await loadContext(root);
    const expo = app.includes("expo");
    expect(ctx.project.platforms).toContain(expo ? "expo" : "swift");
    expect(ctx.project.metadataDirs.length).toBe(1);
    expect(ctx.files.some((f) => f.path === "EXPECTED.md")).toBe(true);
  });
});

describe.each(DIRTY)("dirty fixture %s", (app) => {
  it("seeds at least one block finding", () => {
    const seeded = parseExpected(app).filter((e) => e.section.startsWith("Seeded"));
    expect(seeded.some((e) => e.severity === "block")).toBe(true);
  });
});

describe.each(CLEAN)("clean fixture %s", (app) => {
  it("allows nothing above medium", () => {
    for (const e of parseExpected(app)) expect(["medium", "info", "none", "<=info"]).toContain(e.severity);
  });
});

describe("coverage across fixtures", () => {
  it("has a seeded positive for every check", () => {
    const seeded = new Set(DIRTY.flatMap((a) => parseExpected(a).filter((e) => e.section.startsWith("Seeded")).map((e) => e.check)));
    expect([...CHECK_IDS].filter((c) => !seeded.has(c))).toEqual([]);
  });

  it("has a deliberate negative for every check", () => {
    const negatives = new Set(APPS.flatMap((a) => parseExpected(a).filter((e) => e.severity === "none" || e.severity === "<=info").map((e) => e.check)));
    expect([...CHECK_IDS].filter((c) => !negatives.has(c))).toEqual([]);
  });

  it("uses the asc canonical metadata layout in the Expo fixtures", () => {
    for (const app of ["expo-ai-photo", "clean-expo"]) {
      const appInfo = JSON.parse(readFileSync(path.join(HERE, app, "metadata/app-info/en-US.json"), "utf8")) as Record<string, string>;
      expect(Object.keys(appInfo).every((k) => ["name", "subtitle", "privacyPolicyUrl", "privacyChoicesUrl", "privacyPolicyText"].includes(k))).toBe(true);
      const versions = readdirSync(path.join(HERE, app, "metadata/version"));
      expect(versions).toHaveLength(1);
    }
  });
});

describe("ledger samples", () => {
  const dir = path.join(HERE, "ledger");
  const read = (f: string) => readFileSync(path.join(dir, f), "utf8");

  it("rejections carry a submission ID, version (build) and guideline header", () => {
    expect(read("rejection-1.2.txt")).toMatch(/Submission ID: [0-9a-f-]{36}/);
    expect(read("rejection-1.2.txt")).toContain("Version 1.3 (42)");
    expect(read("rejection-1.2.txt")).toMatch(/^Guideline 1\.2 - /m);
    expect(read("rejection-1.1.txt")).toMatch(/^Guideline 1\.1 - /m);
    expect(read("rejection-1.1.txt")).toContain("1.2 (37)");
  });

  it("approval and reply reference the right submissions", () => {
    expect(read("approval.txt")).toContain("1.3 (43)");
    expect(read("resolution-reply.txt")).toContain("9b27d4e0-1f6a-4c83-b5d9-72e0a4c6f193");
  });

  it("the termination notice cites 3.2(f) but names no app or build", () => {
    const t = read("termination-3.2f.txt");
    expect(t).toContain("3.2(f)");
    expect(t).toContain("ABCDE12345");
    expect(t).not.toMatch(/Luna|Submission ID|\(\d+\)/);
  });
});

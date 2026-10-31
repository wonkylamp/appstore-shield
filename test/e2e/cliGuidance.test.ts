import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toolRef } from "../../src/format.js";
import { runPreflight } from "../../src/preflight.js";

/** Guidance printed by both surfaces must be followable by a CLI-only (fastlane) user. */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIX = path.join(ROOT, "test", "fixtures");
const prevHome = process.env.APPSTORE_SHIELD_HOME;
let app: string;

beforeAll(async () => {
  process.env.APPSTORE_SHIELD_HOME = await mkdtemp(path.join(tmpdir(), "shield-cliguide-home-"));
  app = await mkdtemp(path.join(tmpdir(), "shield-cliguide-app-"));
  await cp(path.join(FIX, "swiftui-ai-companion"), app, { recursive: true });
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.APPSTORE_SHIELD_HOME;
  else process.env.APPSTORE_SHIELD_HOME = prevHome;
});

/** Every MCP tool a message names must say how a CLI user reaches it. */
function bareToolMentions(s: string): string[] {
  return [...s.matchAll(/\bshield_[a-z_]+(?:\s+[a-z_]+\b)?/g)].filter((m) => !/^\s*\((?:MCP\)|an MCP tool)/.test(s.slice(m.index + m[0].length))).map((m) => m[0]);
}

describe("CLI-visible guidance", () => {
  it("toolRef names the CLI command when one exists and says MCP-only otherwise", () => {
    expect(toolRef("shield_preflight")).toBe("shield_preflight (MCP) or `appstore-shield preflight` (CLI)");
    expect(toolRef("shield_lint_text")).toBe("shield_lint_text (MCP) or `appstore-shield lint` (CLI)");
    expect(toolRef("shield_remediation", "save_spec")).toMatch(/^shield_remediation save_spec \(an MCP tool/);
  });

  it("the manual checklist and built-product notes never name a bare MCP tool", async () => {
    const r = await runPreflight(app, { record: false, source: "ci", buildPath: app });
    const notes = r.manualChecklist.find((m) => m.id === "notes_specificity")?.item ?? "";
    expect(notes).toContain(toolRef("shield_lint_text"));
    const texts = [...r.manualChecklist.map((m) => m.item), ...(r.builtProduct ?? []).flatMap((b) => b.notes)];
    expect(texts.flatMap(bareToolMentions)).toEqual([]);
  }, 60_000);

  it("preflight.ts and format.ts route every tool name in a message through toolRef", async () => {
    for (const file of ["src/preflight.ts", "src/format.ts"]) {
      const lines = (await readFile(path.join(ROOT, file), "utf8")).split("\n");
      const bare = lines.filter((l) => {
        const t = l.trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/**") || /^shield_[a-z_]+:/.test(t)) return false;
        return /shield_[a-z_]+/.test(t.replace(/toolRef\("shield_[a-z_]+"/g, ""));
      });
      expect(bare, file).toEqual([]);
    }
  });
});

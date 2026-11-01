import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** What a GitHub clone, a marketplace install and an npm install each depend on. */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const json = (rel: string) => JSON.parse(readFileSync(path.join(ROOT, rel), "utf8")) as Record<string, unknown>;

function textFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", ".git"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) textFiles(p, out);
    else if (e.isFile() && statSync(p).size < 2_000_000 && /\.(ts|mjs|js|json|md|yml|yaml|txt|swift|tsx|plist|pbxproj)$|^(LICENSE|\.gitignore|\.mcp\.json)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("publish readiness", () => {
  it("ships an MIT LICENSE, a changelog and contributing notes", () => {
    const license = readFileSync(path.join(ROOT, "LICENSE"), "utf8");
    expect(license).toMatch(/^MIT License/);
    expect(license).toContain("Copyright (c) 2026 wonkylamp");
    expect(readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8")).toMatch(/## \[0\.1\.0\]/);
    expect(existsSync(path.join(ROOT, "CONTRIBUTING.md"))).toBe(true);
  });

  it("the marketplace installs this repo's plugin as appstore-shield@appstore-shield", () => {
    const market = json(".claude-plugin/marketplace.json") as { name: string; plugins: { name: string; source: string }[] };
    const plugin = json(".claude-plugin/plugin.json") as { name: string; version: string };
    expect(market.name).toBe("appstore-shield");
    expect(market.plugins).toEqual([expect.objectContaining({ name: plugin.name, source: "./" })]);
    expect(plugin.version).toBe(json("package.json").version);
    expect(readFileSync(path.join(ROOT, "README.md"), "utf8")).toContain("/plugin install appstore-shield@appstore-shield");
  });

  it("commits dist/ (plugins installed from git are not built) and needs no runtime dependencies", () => {
    const ignored = readFileSync(path.join(ROOT, ".gitignore"), "utf8").split("\n").map((l) => l.trim().replace(/^\/|\/$/g, ""));
    expect(ignored).not.toContain("dist");
    expect(ignored).toContain("node_modules");
    const pkg = json("package.json") as { dependencies?: object; files: string[]; bin: Record<string, string>; engines: { node: string }; scripts: Record<string, string> };
    // Everything is bundled into dist/; a runtime dependency would be installed for nothing, or worse, relied on.
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.files).toEqual(expect.arrayContaining(["dist", "skills", "hooks", ".claude-plugin"]));
    expect(pkg.bin["appstore-shield"]).toBe("dist/cli.js");
    expect(pkg.engines.node).toBe(">=20");
    expect(pkg.scripts.prepublishOnly).toMatch(/build/);
    expect(pkg.scripts["check:dist"]).toBeDefined();
    expect(readFileSync(path.join(ROOT, "hooks/hooks.json"), "utf8")).toContain("${CLAUDE_PLUGIN_ROOT}/dist/cli.js");
  });

  it("declares the MCP server in plugin.json, not a root .mcp.json a contributor's Claude Code would load as a project server", () => {
    // A root .mcp.json is also the project-scope MCP config, where ${CLAUDE_PLUGIN_ROOT} is unset.
    expect(existsSync(path.join(ROOT, ".mcp.json"))).toBe(false);
    const plugin = json(".claude-plugin/plugin.json") as { mcpServers: Record<string, { command: string; args: string[] }>; displayName?: string };
    expect(plugin.mcpServers["appstore-shield"]).toEqual({ command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/dist/cli.js", "mcp"] });
    // The listing name must not present Apple's trademark as the product's own brand.
    expect(plugin.displayName).toBeUndefined();
  });

  it("ships a square PNG listing icon the plugin directory accepts", () => {
    const png = readFileSync(path.join(ROOT, ".claude-plugin", "icon.png"));
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    const w = png.readUInt32BE(16);
    const h = png.readUInt32BE(20);
    expect(w).toBe(h);
    expect(w).toBeGreaterThanOrEqual(512);
    expect(w).toBeLessThanOrEqual(2048);
    expect(png.length).toBeLessThan(2_000_000);
  });

  it("keeps the OWNER placeholder only where scripts/owner.mjs replaces it, and npm publish refuses while it is left", () => {
    const pkg = json("package.json") as { scripts: Record<string, string> };
    expect(pkg.scripts.prepublishOnly).toMatch(/check:owner/);
    expect(pkg.scripts["check:owner"]).toBe("node scripts/owner.mjs check");
    // Any spelling of the owner other than OWNER/appstore-shield would survive `owner.mjs set` and ship as a dead link.
    const stray: string[] = [];
    for (const f of textFiles(ROOT)) {
      const rel = path.relative(ROOT, f);
      if (rel === "package-lock.json" || rel.endsWith("publishReadiness.test.ts") || rel === path.join("scripts", "owner.mjs")) continue;
      for (const line of readFileSync(f, "utf8").split("\n")) {
        const cleaned = line.replace(/\bOWNER\/appstore-shield\b/g, "");
        if (/github\.com\/OWNER\b|\bgithub:OWNER\b|(?:^|\s)OWNER\//.test(cleaned)) stray.push(`${rel}: ${line.trim()}`);
      }
    }
    expect(stray).toEqual([]);
  });

  it("owner.mjs set replaces every placeholder and check then passes", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "owner-"));
    try {
      mkdirSync(path.join(dir, "scripts"));
      mkdirSync(path.join(dir, ".claude-plugin"));
      copyFileSync(path.join(ROOT, "scripts", "owner.mjs"), path.join(dir, "scripts", "owner.mjs"));
      writeFileSync(path.join(dir, "README.md"), "/plugin marketplace add OWNER/appstore-shield\ngit clone https://github.com/OWNER/appstore-shield.git\n");
      writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), '{"homepage":"https://github.com/OWNER/appstore-shield#readme"}\n');
      const run = (...args: string[]) => spawnSync(process.execPath, [path.join(dir, "scripts", "owner.mjs"), ...args], { encoding: "utf8" });
      expect(run("check").status).toBe(1);
      expect(run("set", "../evil").status).toBe(2);
      expect(run("set", "octo-org").status).toBe(0);
      expect(run("check").status).toBe(0);
      expect(readFileSync(path.join(dir, "README.md"), "utf8")).toBe("/plugin marketplace add octo-org/appstore-shield\ngit clone https://github.com/octo-org/appstore-shield.git\n");
      expect(readFileSync(path.join(dir, ".claude-plugin", "plugin.json"), "utf8")).toContain("github.com/octo-org/appstore-shield#readme");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pins dependency versions past known advisories (zod is bundled into dist/)", () => {
    const lock = json("package-lock.json") as { packages: Record<string, { version: string }> };
    const ver = (name: string) => lock.packages[`node_modules/${name}`]?.version.split(".").map(Number) ?? [0, 0, 0];
    const atLeast = (v: number[], min: number[]) => v[0]! > min[0]! || (v[0] === min[0] && (v[1]! > min[1]! || (v[1] === min[1] && v[2]! >= min[2]!)));
    expect(atLeast(ver("zod"), [4, 6, 6])).toBe(true);
    expect(atLeast(ver("vitest"), [4, 1, 11])).toBe(true);
    const tinypool = lock.packages["node_modules/tinypool"];
    if (tinypool) expect(atLeast(ver("tinypool"), [2, 1, 2])).toBe(true);
    expect(existsSync(path.join(ROOT, ".github", "dependabot.yml"))).toBe(true);
  });

  it("the bundle imports only Node built-ins", () => {
    const dist = path.join(ROOT, "dist");
    if (!existsSync(dist)) return;
    const files = textFiles(dist).concat(readdirSync(path.join(dist, "chunks")).map((f) => path.join(dist, "chunks", f)));
    const bare = new Set<string>();
    for (const f of [path.join(dist, "cli.js"), ...files]) {
      if (!existsSync(f)) continue;
      for (const m of readFileSync(f, "utf8").matchAll(/^\s*import\s[^;]*?from\s*"([^"]+)"|\bimport\("([^"]+)"\)/gm)) {
        const spec = m[1] ?? m[2]!;
        if (!spec.startsWith("node:") && !spec.startsWith(".")) bare.add(spec);
      }
    }
    expect([...bare]).toEqual([]);
  });

  it("CI builds, tests and checks dist/ on ubuntu and macos with Node 20, 22 and 24", () => {
    const ci = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
    for (const s of ["ubuntu-latest", "macos-latest", "npm ci", "npm run typecheck", "npm test", "npm run check:dist", "npm run build"]) expect(ci).toContain(s);
    expect(ci).toMatch(/node: \[20, 22, 24\]/);
  });

  it("holds no local absolute paths or personal addresses", () => {
    const leaks: string[] = [];
    for (const f of textFiles(ROOT)) {
      const rel = path.relative(ROOT, f);
      if (rel === "package-lock.json" || rel === path.join("test", "e2e", "publishReadiness.test.ts")) continue;
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/\/private\/tmp\/claude-[^\s"'`]*|\/(?:private\/)?var\/folders\/[A-Za-z0-9_+-]+\/[^\s"'`]*|\/Users\/(?!me\/|x["/])[A-Za-z0-9._-]+\/|[A-Za-z0-9._%+-]+@(?:gmail|icloud|me|outlook|hotmail|yahoo)\.com/g)) leaks.push(`${rel}: ${m[0]}`);
    }
    expect(leaks).toEqual([]);
  });
});

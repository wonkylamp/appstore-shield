import { describe, expect, it } from "vitest";
import * as gating from "../../src/rules/gating.js";
import * as genai from "../../src/rules/genai.js";
import * as store from "../../src/rules/store.js";
import { getChecks } from "../../src/scanners/index.js";
import { ctxFromFiles } from "../helpers.js";

/**
 * Rule regexes run over whole files. A quadratic pattern lets one odd file stall a scan
 * past the hook's timeout, and a timed-out hook does not block, so the gate fails open.
 */
function regexesOf(v: unknown, path: string, out: [string, RegExp][], seen = new Set<unknown>()): [string, RegExp][] {
  if (v instanceof RegExp) out.push([path, v]);
  else if (v && typeof v === "object" && !seen.has(v)) {
    seen.add(v);
    for (const [k, x] of Object.entries(v)) regexesOf(x, `${path}.${k}`, out, seen);
  }
  return out;
}

const N = 100_000;
const INPUTS: Record<string, string> = {
  newlines: "\n".repeat(N),
  word: "a".repeat(N),
  digits: "1".repeat(N),
  dots: ".".repeat(N),
  spaces: " ".repeat(N),
  dashed: "a-".repeat(N / 2),
  quotes: '"'.repeat(N),
};

describe("rule regexes stay linear on pathological input", () => {
  const all = [...regexesOf(gating, "gating", []), ...regexesOf(genai, "genai", []), ...regexesOf(store, "store", [])];

  it("covers the rule tables", () => {
    expect(all.length).toBeGreaterThan(100);
  });

  it("matches 100 KB runs of one character in well under a second per pattern", () => {
    const slow: string[] = [];
    for (const [name, rx] of all) {
      const g = new RegExp(rx.source, rx.flags.includes("g") ? rx.flags : `${rx.flags}g`);
      for (const [kind, s] of Object.entries(INPUTS)) {
        const t = performance.now();
        for (const _ of s.matchAll(g)) if (performance.now() - t > 2000) break;
        const dt = performance.now() - t;
        if (dt > 250) slow.push(`${name} on ${kind}: ${dt.toFixed(0)}ms`);
      }
    }
    expect(slow).toEqual([]);
  }, 120_000);

  it("scans a project with blank and one-word files quickly", async () => {
    const ctx = await ctxFromFiles({
      "package.json": '{"dependencies":{"react-native":"0.74.0"}}',
      "src/blank.ts": "\n".repeat(N),
      "src/word.js": "a".repeat(80_000),
    });
    const t = performance.now();
    for (const c of getChecks()) await c.run(ctx);
    expect(performance.now() - t).toBeLessThan(10_000);
  }, 60_000);

  // Field (correctness r4): every AI-surface hit redacted and regex-tested its whole line, so a
  // 1.4 MB one-line bundle took genai_safety 149 s and the hook fell back to "ask".
  it("scans a long single-line minified bundle with many AI hits in linear time", async () => {
    const unit = 'if(remoteConfig.getBoolean("x")&&__DEV__){a=b?c:d;fetch("https://api.openai.com/v1/images")}';
    const ctx = await ctxFromFiles({
      "package.json": '{"dependencies":{"react-native":"0.74.0"}}',
      "src/min.js": unit.repeat(Math.ceil(700_000 / unit.length)),
    });
    const slow: string[] = [];
    for (const c of getChecks()) {
      const t = performance.now();
      await c.run(ctx);
      const dt = performance.now() - t;
      if (dt > 4000) slow.push(`${c.id}: ${dt.toFixed(0)}ms`);
    }
    expect(slow).toEqual([]);
  }, 120_000);

  // A line of unclosed openers (`"\"\"\…`) made the string-literal regex restart at every
  // quote and scan to the line end.
  it("runs every check over a long line of unclosed escaped quotes in linear time", async () => {
    const ctx = await ctxFromFiles({
      "package.json": '{"dependencies":{"react-native":"0.74.0"}}',
      "src/quotes.js": 'x = "' + '"\\'.repeat(200_000),
    });
    const slow: string[] = [];
    for (const c of getChecks()) {
      const t = performance.now();
      await c.run(ctx);
      const dt = performance.now() - t;
      if (dt > 4000) slow.push(`${c.id}: ${dt.toFixed(0)}ms`);
    }
    expect(slow).toEqual([]);
  }, 120_000);
});

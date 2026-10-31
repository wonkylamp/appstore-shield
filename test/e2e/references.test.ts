import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lintText } from "../../src/ledger/lint.js";

/**
 * Claude imitates the skill's references, so every example they call good must pass the same lint
 * the skill makes Claude run; otherwise Claude loops on lint fixes for text it copied.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REFS = path.join(ROOT, "skills", "appstore-shield", "references");
const read = (name: string) => readFileSync(path.join(REFS, name), "utf8");

/** The first blockquote after `marker`, unquoted. */
function quoteAfter(md: string, marker: string): string {
  const rest = md.slice(md.indexOf(marker) + marker.length).split("\n");
  const start = rest.findIndex((l) => l.startsWith(">"));
  const out: string[] = [];
  for (const l of rest.slice(start)) {
    if (!l.startsWith(">")) break;
    out.push(l.replace(/^> ?/, ""));
  }
  return out.join("\n");
}

describe("reference examples pass shield_lint_text", () => {
  it("review-notes.md names the evidence-pack fact kind that exists and gates the AI consent template on the scan", () => {
    const md = read("review-notes.md");
    const src = readFileSync(path.join(ROOT, "src", "ledger", "evidence.ts"), "utf8");
    expect(src).toContain('"removed_condition"');
    expect(md).toContain("`removed_condition` facts in the evidence pack");
    expect(md).not.toMatch(/`removed_in_diff` facts/);
    const ai = md.slice(md.indexOf("**Third-party AI services"), md.indexOf("**Regional differences**"));
    expect(ai).toMatch(/only once the scan no longer reports `ai\.undisclosed_sharing`/);
  });

  it("review-notes.md Good example has no lint errors", () => {
    const md = read("review-notes.md");
    expect(md).toContain("**Good**");
    const text = quoteAfter(md, "**Good**");
    expect(text.length).toBeGreaterThan(500);
    const errors = lintText({ purpose: "review_notes", text }).issues.filter((i) => i.severity === "error");
    expect(errors).toEqual([]);
  });

  it("every Specific example in review-notes.md's Specificity table has no lint errors", () => {
    const md = read("review-notes.md");
    const table = md.slice(md.indexOf("## Specificity"), md.indexOf("Avoid absolute words"));
    const specific = table
      .split("\n")
      .filter((l) => l.startsWith("| \""))
      .map((l) => l.split("|")[2]!.trim().replace(/^"|"$/g, ""));
    expect(specific.length).toBeGreaterThanOrEqual(4);
    for (const text of specific) {
      const errors = lintText({ purpose: "review_notes", text }).issues.filter((i) => i.severity === "error");
      expect({ text, errors }).toEqual({ text, errors: [] });
    }
  });

  it("replies-and-appeals.md clarification example has no lint errors", () => {
    const md = read("replies-and-appeals.md");
    const text = quoteAfter(md, "## Reply to App Review (clarification)");
    expect(text).toMatch(/Thank you/);
    const errors = lintText({ purpose: "clarification", text }).issues.filter((i) => i.severity === "error");
    expect(errors).toEqual([]);
  });

  it("disclosure templates word forward-looking assurances as the developer's statement", () => {
    const md = read("review-notes.md");
    const templates = md.slice(md.indexOf("## Disclosure templates"), md.indexOf("## Removed review-time gating"));
    const quoted = templates.split("\n").filter((l) => l.startsWith(">")).join(" ");
    expect(quoted).toMatch(/remote configuration/);
    for (const s of quoted.split(/(?<=\.)\s+/)) {
      if (/\b(?:not used to|limited to|will not|do not add)\b/i.test(s)) expect(s).toMatch(/The developer states/);
    }
  });

  it("review-notes.md does not point at the ignored confirmed_mistakes input", () => {
    expect(read("review-notes.md")).not.toContain("confirmed_mistakes");
  });

  it("the demo account guidance matches the evidence-pack scaffold (no pasted passwords)", () => {
    const md = read("review-notes.md");
    expect(md).not.toMatch(/Demo account\.\*\* Credentials/);
    expect(quoteAfter(md, "**Good**")).not.toMatch(/\/ \[password\]/);
  });
});

/** Prose lines of a Markdown file: fenced code, blockquotes and tables hold example text, not claims or citations. */
function proseLines(file: string): { line: number; text: string }[] {
  let fence = false;
  const out: { line: number; text: string }[] = [];
  readFileSync(file, "utf8").split("\n").forEach((l, i) => {
    if (l.trim().startsWith("```")) fence = !fence;
    else if (!fence && !l.startsWith(">") && !l.startsWith("|")) out.push({ line: i + 1, text: l });
  });
  return out;
}

function markdown(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? markdown(p) : p.endsWith(".md") ? [p] : [];
  });
}

describe("source fidelity across the shipped docs", () => {
  const docs = [...markdown(path.join(ROOT, "docs")), ...markdown(path.join(ROOT, "skills")), path.join(ROOT, "README.md"), path.join(ROOT, "PLAN.md")];

  it("quotes Apple and other sources in short phrases only (15 words at most)", () => {
    // These files cite third parties; SKILL.md and review-notes.md quote only our own example wording.
    const citing = docs.filter((f) => f.includes(`${path.sep}docs${path.sep}`) || /(?:playbook|guidelines-map|README|PLAN)\.md$/.test(f));
    expect(citing.length).toBeGreaterThanOrEqual(4);
    const long = citing.flatMap((f) =>
      proseLines(f).flatMap(({ line, text }) =>
        [...text.matchAll(/"([^"]+)"|\u201c([^\u201d]+)\u201d/g)]
          .map((m) => (m[1] ?? m[2] ?? "").trim())
          .filter((q) => q.split(/\s+/).length > 15)
          .map((q) => `${path.relative(ROOT, f)}:${line} ${q.slice(0, 60)}`),
      ),
    );
    expect(long).toEqual([]);
  });

  it("never presents the tool or the record as protection or a guarantee", () => {
    const promise = /\b(?:protects?|protection|protected|guarantee[sd]?|ensures?|safe from|immune)\b/i;
    const negated = /\b(?:no|not|never|cannot|can't|neither|nor|without|doesn't|does not|isn't|won't)\b/i;
    const hits = docs.flatMap((f) =>
      proseLines(f).flatMap(({ line, text }) =>
        text
          .split(/(?<=[.!?])\s+/)
          .filter((s) => promise.test(s) && !negated.test(s))
          .map((s) => `${path.relative(ROOT, f)}:${line} ${s.slice(0, 80)}`),
      ),
    );
    expect(hits).toEqual([]);
  });
});

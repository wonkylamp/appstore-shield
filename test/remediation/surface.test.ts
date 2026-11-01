import { execFile } from "node:child_process";
import { chmod, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ResidueSpec } from "../../src/ledger/schema.js";
import { loadContext } from "../../src/project.js";
import { aiSites, blocklistAt, findSurface, git, inGitHistory, inGitPathHistory, makeNeedle, matchNeedle, specGrounding, termsFromRejection, validateSpec } from "../../src/remediation/surface.js";
import { tempProject } from "../helpers.js";

const run = promisify(execFile);

async function gitRepo(files: Record<string, string>): Promise<string> {
  const root = await tempProject(files);
  await run("git", ["init", "-q", "-b", "main"], { cwd: root });
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "base"], { cwd: root });
  return root;
}

const REJECTION = `Guideline 1.1.4 - Safety - Objectionable Content

Your app includes content that is overtly sexual. Specifically, users can dress the AI girlfriend in "lingerie" outfits.

Next Steps: remove this content from your app.`;

const APP: Record<string, string> = {
  "App/Views/LingeriePicker.swift": `import SwiftUI\nstruct LingeriePicker: View {\n  let outfits = ["lace", "silk"]\n  var body: some View { List(outfits, id: \\.self) { Text($0) } }\n}\n`,
  "App/Views/ChatView.swift": `import SwiftUI\nstruct ChatView: View {\n  @State private var prompt = ""\n  var body: some View {\n    TextField("Describe a look", text: $prompt)\n    if remoteConfig["lingerie_enabled"].boolValue { LingeriePicker() }\n  }\n}\n`,
  "App/Services/Gen.swift": `let endpoint = "https://api.replicate.com/v1/predictions"\nlet stylePrompt = "a photo of her wearing elegant lingerie in soft light"\n`,
  "App/en.lproj/Localizable.strings": `"outfit.option.3" = "Lingerie";\n"greeting" = "Hello";\n`,
  "App/Assets.xcassets/outfit_lingerie_01.imageset/Contents.json": `{"images":[]}`,
  "App/Resources/bg_bikini.png": "png",
};

describe("termsFromRejection", () => {
  it("expands lexicon categories and quoted phrases from the rejection text", () => {
    const r = termsFromRejection(REJECTION);
    const terms = r.terms.map((t) => t.term);
    expect(terms).toContain("lingerie");
    expect(terms).toContain("underwear");
    expect(terms).toContain("nude");
    expect(r.terms.find((t) => t.term === "lingerie")?.origin).toBe("quoted");
    expect(r.categories.map((c) => c.id)).toEqual(expect.arrayContaining(["lingerie", "sexual", "nudity"]));
    expect(r.otherWords).toContain("girlfriend");
    expect(r.otherWords).not.toContain("guideline");
  });

  it("does not invent content terms for an unrelated rejection", () => {
    const r = termsFromRejection("Guideline 2.1 - Performance - App Completeness. The app crashed on launch on iPad Air.");
    expect(r.terms).toEqual([]);
    expect(r.categories).toEqual([]);
  });
});

describe("term needles", () => {
  const n = makeNeedle("term", "lingerie")!;
  const bra = makeNeedle("term", "bra")!;
  it("match camelCase, snake_case, plurals and spelling variants", () => {
    for (const s of ["LingeriePicker", "showLingerie", "outfit_lingerie_01", "LINGERIE_ITEMS", "lingeries", "l1ngerie", "lin-gerie", "LiNgErIe"]) {
      expect(matchNeedle(n, s).length, s).toBe(1);
    }
    expect(matchNeedle(bra, "push-up bras").length).toBe(1);
  });
  it("do not match inside unrelated words", () => {
    for (const s of ["library", "Brand", "BRAND", "vibrant", "algebra", "zebra"]) expect(matchNeedle(bra, s).length, s).toBe(0);
    expect(matchNeedle(n, "lingeriesque").length).toBe(0);
  });
});

describe("findSurface", () => {
  it("drafts a spec with symbols, assets, keys, flags, prompt fragments and input paths", async () => {
    const ctx = await loadContext(await tempProject(APP));
    const s = await findSurface(ctx, REJECTION);
    expect(s.draft.terms).toContain("lingerie");
    expect(s.draft.symbols).toContain("LingeriePicker");
    expect(s.draft.assets).toEqual(expect.arrayContaining(["outfit_lingerie_01", "bg_bikini"]));
    expect(s.draft.strings).toContain("outfit.option.3");
    expect(s.draft.strings).not.toContain("greeting");
    expect(s.draft.flags).toContain("lingerie_enabled");
    expect(s.draft.promptFragments.some((p) => p.includes("elegant lingerie"))).toBe(true);
    expect(s.sinks.some((x) => x.file === "App/Services/Gen.swift")).toBe(true);
    expect(s.sources.some((x) => x.label === "free-text prompt")).toBe(true);
    expect(s.draft.inputPaths.some((p) => p.startsWith("free-text prompt (App/Views/ChatView.swift:5)"))).toBe(true);
    expect(s.draft.capability).toMatch(/^A user can no longer obtain/);
    expect(s.evidence.some((e) => e.startsWith("App/Views/LingeriePicker.swift:2"))).toBe(true);
    const v = await validateSpec(ctx, s.draft);
    expect(v.problems).toEqual([]);
  });

  it("finds nothing for a clean app and says when no AI sink exists", async () => {
    const ctx = await loadContext(await tempProject({ "App/Main.swift": `import SwiftUI\nstruct Main: View { var body: some View { Text("Hi") } }\n` }));
    const s = await findSurface(ctx, REJECTION);
    expect(s.candidates).toEqual([]);
    expect(s.draft.inputPaths).toEqual([]);
    expect(s.notes.join(" ")).toMatch(/No AI generation call/);
  });
});

describe("findSurface on the companion fixture", () => {
  const fixture = path.resolve(__dirname, "../fixtures/swiftui-ai-companion");
  const ledger = (name: string) => readFile(path.resolve(__dirname, "../fixtures/ledger", name), "utf8");

  for (const name of ["rejection-1.1.txt", "rejection-1.2.txt"]) {
    it(`finds the spicy_mode flag, OutfitCatalog and the lingerie prompt for ${name}`, async () => {
      const ctx = await loadContext(fixture);
      const s = await findSurface(ctx, await ledger(name));
      expect(s.candidates.length).toBeGreaterThan(0);
      expect(s.draft.flags).toContain("spicy_mode");
      expect(s.draft.promptFragments.some((p) => p.includes("wearing lace lingerie, bedroom setting"))).toBe(true);
      expect(s.terms.find((t) => t.term === "outfit")?.inRepo).toBeGreaterThan(0);
      // "outfit" names where the feature lived; the compliant picker is context, not residue
      expect(s.draft.terms).not.toContain("outfit");
      expect(s.draft.symbols).not.toContain("OutfitCatalog");
      expect(s.draft.symbols).not.toContain("Outfit");
      expect(s.context.terms).toContain("outfit");
      expect(s.context.symbols).toContain("OutfitCatalog");
      expect(s.draft.promptFragments.some((p) => p.includes("\\(outfit.promptFragment)"))).toBe(false);
      expect(s.notes.join(" ")).toMatch(/not residue/);
      // sign-in and profile-name fields are not input paths
      expect(s.sources.some((x) => x.file === "Sources/Auth/SessionStore.swift")).toBe(false);
      expect(s.draft.inputPaths.some((p) => p.includes("SessionStore.swift"))).toBe(false);
      // the studio's scene prompt is linked to the image generator, not to every AI call
      const studio = s.draft.inputPaths.find((p) => p.startsWith("free-text prompt (Sources/Views/CompanionStudioView.swift"));
      expect(studio).toContain("Sources/AI/ImageGenerator.swift");
      expect(studio).not.toContain("CompanionChat.swift");
      // chat text feeds Gemini only; the selfie goes to the OpenAI vision call only (data flow, not shared view)
      const chat = s.draft.inputPaths.find((p) => p.startsWith("free-text prompt (Sources/Views/ChatView.swift"));
      expect(chat).toContain("Sources/AI/CompanionChat.swift");
      expect(chat).not.toContain("SelfieAvatar.swift");
      const selfie = s.draft.inputPaths.find((p) => p.startsWith("image upload (Sources/Views/ChatView.swift"));
      expect(selfie).toContain("Sources/AI/SelfieAvatar.swift");
      expect(selfie).not.toContain("CompanionChat.swift");
    });
  }

  it("keeps entries reached through a real residue term even when a context noun also finds them", async () => {
    const ctx = await loadContext(await tempProject({
      "App/LingerieOutfits.swift": `struct LingerieOutfitPicker {\n  let options = ["lace"]\n}\n`,
    }));
    const s = await findSurface(ctx, "Guideline 1.1.4 - users can pick sexually suggestive outfits such as lingerie.");
    expect(s.draft.symbols).toContain("LingerieOutfitPicker");
    expect(s.context.symbols).not.toContain("LingerieOutfitPicker");
  });

  it("marks an input that only shares a view with an AI call as inferred, not traced", async () => {
    const ctx = await loadContext(await tempProject({
      "App/ProfileView.swift": `import SwiftUI\nstruct ProfileView: View {\n  @State private var bio = ""\n  private let gen = Gen()\n  var body: some View {\n    TextField("Bio", text: $bio)\n    Button("Avatar") { Task { await gen.make() } }\n  }\n}\n`,
      "App/Gen.swift": `struct Gen {\n  func make() async {\n    _ = URL(string: "https://api.replicate.com/v1/predictions")\n  }\n}\n`,
    }));
    const s = await findSurface(ctx, "Guideline 1.1.4 - nudity.");
    const p = s.draft.inputPaths.find((x) => x.startsWith("free-text prompt (App/ProfileView.swift"));
    expect(p).toMatch(/linkage inferred, not traced/);
  });

  it("does not add garment or outfit terms for a non-sexual rejection", () => {
    const r = termsFromRejection("Guideline 1.1.2 - Safety. Your app includes graphic violence: users can dress characters in outfits covered in blood.");
    expect(r.terms.map((t) => t.term)).not.toContain("outfit");
    expect(r.terms.map((t) => t.term)).not.toContain("lingerie");
  });

  it("reads Firebase subscript flags on the singleton", async () => {
    const ctx = await loadContext(await tempProject({
      "App/Gate.swift": `import FirebaseRemoteConfig\nenum Gate {\n  static var on: Bool { RemoteConfig.remoteConfig()["nsfw_mode"].boolValue }\n}\n`,
    }));
    const s = await findSurface(ctx, "Guideline 1.1.4 - your app includes nsfw content.");
    expect(s.draft.flags).toContain("nsfw_mode");
  });
});

describe("validateSpec", () => {
  const base = { feature: "lingerie", capability: "A user can no longer generate lingerie images." };

  it("rejects hallucinated symbols, assets and keys", async () => {
    const ctx = await loadContext(await tempProject(APP));
    const v = await validateSpec(
      ctx,
      ResidueSpec.parse({ ...base, symbols: ["LingeriePicker", "SpicyOutfitManager"], assets: ["outfit_lingerie_*", "nsfw_pack_*"], strings: ["outfit.option.9"] }),
    );
    expect(v.ok).toBe(false);
    expect(v.problems.join("\n")).toMatch(/SpicyOutfitManager/);
    expect(v.problems.join("\n")).toMatch(/nsfw_pack_\*/);
    expect(v.problems.join("\n")).toMatch(/outfit\.option\.9/);
    expect(v.problems.join("\n")).not.toMatch(/"LingeriePicker"/);
  });

  it("accepts entries already removed but present in git history, with a warning", async () => {
    const root = await gitRepo(APP);
    await rm(path.join(root, "App/Views/LingeriePicker.swift"));
    await rm(path.join(root, "App/Views/ChatView.swift"));
    const ctx = await loadContext(root);
    const v = await validateSpec(ctx, ResidueSpec.parse({ ...base, symbols: ["lingeriepicker"] }));
    expect(v.ok).toBe(true);
    expect(v.warnings.join("\n")).toMatch(/git history/);
  });

  it("warns about terms that never existed, but allows absent terms that did", async () => {
    const root = await gitRepo(APP);
    await rm(path.join(root, "App/Resources/bg_bikini.png"));
    const ctx = await loadContext(root);
    const v = await validateSpec(ctx, ResidueSpec.parse({ ...base, terms: ["lingerie", "corset", "zzqqword"] }));
    expect(v.ok).toBe(true);
    expect(v.warnings.join("\n")).toMatch(/"zzqqword" is absent now and never appeared/);
    // a lexicon term the app never had is a regression guard, summarized once
    expect(v.warnings.join("\n")).toMatch(/1 lexicon term is not in the repo or its git history and is kept as regression guards \(corset\)/);
    expect(v.warnings.join("\n")).not.toMatch(/"lingerie"|"corset" is absent/);
  });

  it("skips the history check outside git and still validates confirmed-path evidence", async () => {
    const ctx = await loadContext(await tempProject(APP));
    const v = await validateSpec(
      ctx,
      ResidueSpec.parse({
        ...base,
        terms: ["corset"],
        confirmedPaths: [
          { source: "TextField", sink: "replicate", evidence: ["App/Views/ChatView.swift:5", "App/Views/Missing.swift:2", "App/Views/ChatView.swift:999"] },
        ],
      }),
    );
    expect(v.warnings.join("\n")).not.toMatch(/corset/);
    expect(v.problems).toHaveLength(2);
    expect(v.problems.join("\n")).toMatch(/Missing\.swift:2": file does not exist/);
    expect(v.problems.join("\n")).toMatch(/past the end/);
  });

  it("warns when the spec leaves out an input source that reaches an AI call, not when it lists it", async () => {
    const fixture = path.resolve(__dirname, "../fixtures/swiftui-ai-companion");
    const ctx = await loadContext(fixture);
    const all = await findSurface(ctx, await readFile(path.resolve(__dirname, "../fixtures/ledger/rejection-1.2.txt"), "utf8"));
    const full = await validateSpec(ctx, all.draft);
    expect(full.warnings.join("\n")).not.toMatch(/is not in the spec/);
    const dropped = await validateSpec(ctx, ResidueSpec.parse({ ...all.draft, inputPaths: all.draft.inputPaths.filter((p) => !p.includes("ChatView.swift")) }));
    expect(dropped.warnings.join("\n")).toMatch(/Sources\/Views\/ChatView\.swift:33\) reaches the AI call in Sources\/AI\/CompanionChat\.swift but is not in the spec/);
  });

  it("flags an empty capability and warns when free-text sources reach AI sinks with no input paths", async () => {
    const ctx = await loadContext(await tempProject(APP));
    const v = await validateSpec(ctx, ResidueSpec.parse({ feature: "x", capability: " " }));
    expect(v.ok).toBe(false);
    expect(v.warnings.join("\n")).toMatch(/No input paths listed/);
  });
});

describe("specGrounding", () => {
  const MSG = "Guideline 1.1.4 - Your app lets users generate images of people in lingerie.";

  it("an entry only counts when it sits next to a term derived from App Review's message", async () => {
    const root = await gitRepo({ "src/t.ts": `export const zzqq = 1;\n`, "Sources/Studio.swift": `struct SpicyPicker { let looks = ["lingerie"] }\n` });
    const ctx = await loadContext(root);
    const bogus = await specGrounding(ctx, ResidueSpec.parse({ feature: "z", capability: "z", terms: ["zzqq"] }), MSG, "HEAD");
    expect(bogus).toMatchObject({ checked: true, grounded: false });
    expect(bogus.terms).toContain("lingerie");
    const sym = await specGrounding(ctx, ResidueSpec.parse({ feature: "z", capability: "z", symbols: ["SpicyPicker"] }), MSG, "HEAD");
    expect(sym.grounded).toBe(true);
    expect(sym.via).toMatch(/^spec symbol "SpicyPicker" was in the code before the fix at Sources\/Studio\.swift:1, on the same line as "lingerie"/);
    // the developer reads this; no commit hashes or search internals
    expect(sym.via).not.toMatch(/\b[0-9a-f]{12}\b|next to/);
    // a lexicon term names the wording of App Review's message it came from
    const lex = await specGrounding(ctx, ResidueSpec.parse({ feature: "z", capability: "z", terms: ["lingerie"] }), "Your app includes sexually suggestive images.", "HEAD");
    expect(lex.via).toMatch(/^spec term "lingerie" was in the code before the fix at Sources\/Studio\.swift:1, and it is one of the terms find_surface derives from App Review's message \("sexually suggestive"\)$/);
    const viaPath = await specGrounding(ctx, ResidueSpec.parse({ feature: "z", capability: "z", inputPaths: ["picker in Studio.swift → generator"] }), MSG, "HEAD");
    expect(viaPath.via).toMatch(/input path file Sources\/Studio\.swift had "lingerie", .* at line \d+ in the code before the fix/);
  });

  it("without git, App Review's own word in the spec grounds it; a lexicon expansion alone does not", async () => {
    const ctx = await loadContext(await tempProject({ "Sources/Main.swift": `let x = 1\n` }));
    expect((await specGrounding(ctx, ResidueSpec.parse({ feature: "z", capability: "z", terms: ["lingerie"] }), MSG)).grounded).toBe(true);
    expect((await specGrounding(ctx, ResidueSpec.parse({ feature: "z", capability: "z", terms: ["corset"] }), MSG)).grounded).toBe(false);
  });

  const NAME_FILTER = `import Foundation
enum NameFilter {
    // Reject nsfw-looking names before they are stored, because the name is shown on share cards.
    static let blockedTerms: [String] = ["nsfw", "lingerie", "nude"]
    static func isAllowed(_ name: String) -> Bool { !blockedTerms.contains { name.lowercased().contains($0) } }
}
`;
  const SUGGESTIVE = "Guideline 1.1.4 - Your app includes sexually suggestive or nsfw content.";

  it("docs, comments and filter lists do not tie a spec to the rejection", async () => {
    const files = { "EXPECTED.md": `# Expected\n\nThe lingerie outfit was behind a flag.\n`, "Sources/Safety/NameFilter.swift": NAME_FILTER, "Sources/Main.swift": `let x = 1\n` };
    const spec = ResidueSpec.parse({ feature: "z", capability: "z", terms: ["lingerie", "nsfw"] });
    const noGit = await specGrounding(await loadContext(await tempProject(files)), spec, SUGGESTIVE);
    expect(noGit.via ?? "").not.toMatch(/EXPECTED\.md|NameFilter\.swift/);
    const root = await gitRepo(files);
    const withGit = await specGrounding(await loadContext(root), spec, SUGGESTIVE, "HEAD");
    expect(withGit.via ?? "").not.toMatch(/EXPECTED\.md|NameFilter\.swift/);
    expect(withGit.grounded).toBe(false);
  });

  it("a code line says 'in the code'; store metadata says 'in the repo'", async () => {
    const spec = ResidueSpec.parse({ feature: "z", capability: "z", terms: ["lingerie"] });
    const code = await specGrounding(await loadContext(await gitRepo({ "Sources/Outfits.swift": `let looks = ["lingerie"]\n` })), spec, SUGGESTIVE, "HEAD");
    expect(code.via).toMatch(/^spec term "lingerie" was in the code before the fix at Sources\/Outfits\.swift:1/);
    const meta = await specGrounding(await loadContext(await gitRepo({ "fastlane/metadata/en-US/description.txt": `Dress your companion in lingerie.\n`, "Sources/Main.swift": `let x = 1\n` })), spec, SUGGESTIVE, "HEAD");
    expect(meta.via).toMatch(/^spec term "lingerie" was in the repo before the fix at fastlane\/metadata\/en-US\/description\.txt:1/);
  });

  it("a request to a moderation endpoint is a filter, not an AI generation call", async () => {
    const ctx = await loadContext(await tempProject({
      "Sources/Safety/Moderator.swift": `import Foundation\nenum Moderator {\n  static func check(_ t: String) async throws {\n    var r = URLRequest(url: URL(string: "https://api.openai.com/v1/moderations")!)\n    r.httpMethod = "POST"\n    _ = try await URLSession.shared.data(for: r)\n  }\n}\n`,
      "Sources/AI/Gen.swift": `import Foundation\nstruct Gen {\n  func make() async throws {\n    let r = URLRequest(url: URL(string: "https://api.openai.com/v1/images/generations")!)\n    _ = try await URLSession.shared.data(for: r)\n  }\n}\n`,
    }));
    const s = aiSites(ctx);
    expect(s.sinks.map((x) => x.file)).toContain("Sources/AI/Gen.swift");
    expect(s.sinks.map((x) => x.file)).not.toContain("Sources/Safety/Moderator.swift");
    expect(s.moderation.some((x) => x.file === "Sources/Safety/Moderator.swift")).toBe(true);
  });

  it("omni-moderation fed only text is text moderation; with an image input it is image moderation", async () => {
    const req = (input: string) => `import Foundation\nenum Moderator {\n  static func check(_ t: String) async throws {\n    var r = URLRequest(url: URL(string: "https://api.openai.com/v1/moderations")!)\n    r.httpBody = try JSONSerialization.data(withJSONObject: ["model": "omni-moderation-latest", "input": ${input}])\n    _ = try await URLSession.shared.data(for: r)\n  }\n}\n`;
    const labels = async (input: string) => aiSites(await loadContext(await tempProject({ "Sources/Safety/Moderator.swift": req(input) }))).moderation.map((x) => x.label);
    const textOnly = await labels("t");
    expect(textOnly).toContain("text moderation (omni-moderation)");
    expect(textOnly.some((l) => l.startsWith("image moderation"))).toBe(false);
    expect(await labels(`[["type": "image_url", "image_url": ["url": t]]]`)).toContain("image moderation (omni-moderation)");
  });

  it("validateSpec warns when the spec is ungrounded and when evidence has no snippet", async () => {
    const root = await gitRepo({ "src/t.ts": `export const zzqq = 1;\n`, "Sources/Studio.swift": `let looks = ["lingerie"]\n` });
    const ctx = await loadContext(root);
    const spec = ResidueSpec.parse({ feature: "z", capability: "A user can no longer obtain z.", terms: ["zzqq"], confirmedPaths: [{ source: "a", sink: "b", evidence: ["src/t.ts:1"] }] });
    const v = await validateSpec(ctx, spec, { rejectionText: MSG });
    expect(v.ok).toBe(true);
    expect(v.warnings.join("\n")).toMatch(/not grounded in the rejection.*cannot clear the open rejection/);
    expect(v.warnings.join("\n")).toMatch(/"src\/t\.ts:1" has no snippet.*src\/t\.ts:1: export const zzqq = 1;/);
  });
});

describe("blocklistAt judges a list by its use, not its name", () => {
  async function at(files: Record<string, string>, rel: string, term = "lingerie") {
    const ctx = await loadContext(await tempProject(files));
    const f = ctx.files.find((x) => x.path === rel)!;
    const idx = (f.code.includes(`"${term}"`) ? f.code : f.text).indexOf(term);
    return blocklistAt(ctx, f, idx);
  }

  it("a JS set merged from two lists and tested with .some() is a filter", async () => {
    const bl = await at(
      {
        "src/guard.ts": `const A = ["lingerie", "nude"];\nconst B = ["bikini"];\nconst ALL = new Set([...A, ...B]);\nexport function check(p: string) {\n  if ([...ALL].some((w) => p.includes(w))) throw new Error("refused");\n}\n`,
      },
      "src/guard.ts",
    );
    expect(bl?.name).toBe("A");
    expect(bl?.used).toBe(true);
  });

  it("a Kotlin any {} test that throws is a filter", async () => {
    const bl = await at({ "app/Check.kt": `object Check {\n  val TERMS = listOf("lingerie", "nude")\n  fun check(p: String) {\n    if (TERMS.any { p.contains(it) }) throw IllegalArgumentException("refused")\n  }\n}\n` }, "app/Check.kt");
    expect(bl?.used).toBe(true);
  });

  it("a chained call on the next line still counts as the membership test", async () => {
    const bl = await at({ "App/F.swift": `enum F {\n  static let words = ["lingerie"]\n  static func ok(_ p: String) -> Bool {\n    return !words\n      .contains { p.contains($0) }\n  }\n}\n` }, "App/F.swift");
    expect(bl?.used).toBe(true);
  });

  it("a list rendered in a loop of buttons is content, whatever its name", async () => {
    const bl = await at(
      { "App/V.swift": `import SwiftUI\nstruct V: View {\n  let blockedLooks = ["lingerie", "bikini"]\n  var body: some View {\n    VStack {\n      ForEach(0..<1) { _ in EmptyView() }\n      for look in blockedLooks { Button(look) { pick(look) } }\n    }\n  }\n}\n` },
      "App/V.swift",
    );
    expect(bl).toBeUndefined();
  });

  it("a list interpolated into a prompt is content", async () => {
    const bl = await at({ "src/p.ts": `const forbiddenStyles = ["lingerie"];\nexport const prompt = \`Pick one of: \${forbiddenStyles.join(", ")}\`;\n` }, "src/p.ts");
    expect(bl).toBeUndefined();
  });

  it("a term outside a list literal is never a filter, even when the enclosing name is tested elsewhere", async () => {
    const view = `import SwiftUI\nstruct V: View {\n  var body: some View { Text("lingerie") }\n}\nfunc ok(_ body: String) -> Bool {\n  if body.contains("x") { return false }\n  return true\n}\n`;
    expect(await at({ "App/V.swift": view }, "App/V.swift")).toBeUndefined();
  });

  it("an unused list keeps the residue exclusion only with an explicit refusal name", async () => {
    expect((await at({ "App/U.swift": `let bannedWords = ["lingerie"]\n` }, "App/U.swift"))?.used).toBe(false);
    expect(await at({ "App/U.swift": `let photoFilters = ["lingerie"]\n` }, "App/U.swift")).toBeUndefined();
  });

  it("data files: a 'filters' key is preset content, a banned-words key is a list", async () => {
    expect(await at({ "assets/presets.json": `{\n  "filters": [\n    { "name": "Boudoir", "prompt": "lingerie" }\n  ]\n}\n` }, "assets/presets.json")).toBeUndefined();
    expect((await at({ "assets/config.json": `{\n  "bannedWords": [\n    "lingerie"\n  ]\n}\n` }, "assets/config.json"))?.name).toBe("bannedWords");
  });
});

describe("find_surface draft saved unchanged", () => {
  it("names the feature after what matched, keeps unseen lexicon terms as one regression-guard line, and leads with grounding", async () => {
    const root = await gitRepo(APP);
    const ctx = await loadContext(root);
    const s = await findSurface(ctx, REJECTION);
    expect(s.draft.feature).toMatch(/^Lingerie/);
    expect(s.draft.feature).not.toBe("sexual");
    expect(s.regressionTerms).toEqual(expect.arrayContaining(["thong", "corset", "nudify"]));
    expect(s.regressionTerms).not.toContain("lingerie");
    expect(s.draft.terms).toEqual(expect.arrayContaining(s.regressionTerms));
    expect(s.notes.join(" ")).toMatch(/lexicon terms were not found in the repo.*regression guards/);
    const v = await validateSpec(ctx, s.draft, { rejectionText: REJECTION });
    expect(v.problems).toEqual([]);
    expect(v.warnings.filter((w) => /is absent now/.test(w))).toEqual([]);
    expect(v.warnings.filter((w) => /lexicon terms? (is|are) not in the repo/.test(w))).toHaveLength(1);
    expect(v.warnings.length).toBeLessThan(6);
    // an ungrounded spec leads the warnings and says why the HOLD stays
    const bogus = await validateSpec(ctx, ResidueSpec.parse({ feature: "z", capability: "A user can no longer obtain z.", terms: ["corset", "thong", "nightie"] }), { rejectionText: REJECTION });
    expect(bogus.warnings[0]).toMatch(/^The spec is not grounded in the rejection.*proves nothing about it.*cannot clear the open rejection, which stays on HOLD/);
  });
});

describe("git reads never run a signature program the checkout names", () => {
  // A checkout's .git/config can turn on log.showSignature and name the verifier; git log and show
  // then run it for every signed commit, which the hook reaches through the gate's re-sweep.
  const FORMATS = [
    { format: "openpgp", banner: "PGP SIGNATURE", key: "gpg.program" },
    { format: "openpgp", banner: "PGP SIGNATURE", key: "gpg.openpgp.program" },
    { format: "ssh", banner: "SSH SIGNATURE", key: "gpg.ssh.program" },
    { format: "x509", banner: "SIGNED MESSAGE", key: "gpg.x509.program" },
  ];

  async function signedRepo(f: (typeof FORMATS)[number]) {
    const root = await gitRepo({ "Sources/Main.swift": "let x = 1\n" });
    const tree = (await run("git", ["rev-parse", "HEAD^{tree}"], { cwd: root })).stdout.trim();
    const parent = (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    const body = `tree ${tree}\nparent ${parent}\nauthor t <t@example.com> 1 +0000\ncommitter t <t@example.com> 1 +0000\ngpgsig -----BEGIN ${f.banner}-----\n abc\n -----END ${f.banner}-----\n\nsigned\n`;
    const obj = path.join(root, "..", `${path.basename(root)}-commit`);
    await writeFile(obj, body);
    const sha = (await run("git", ["hash-object", "-t", "commit", "-w", obj], { cwd: root })).stdout.trim();
    await run("git", ["update-ref", "HEAD", sha], { cwd: root });
    const marker = path.join(root, "..", `${path.basename(root)}-ran`);
    const script = path.join(root, "evil.sh");
    await writeFile(script, `#!/bin/sh\ntouch ${marker}\nexit 1\n`);
    await chmod(script, 0o755);
    await run("git", ["config", "log.showSignature", "true"], { cwd: root });
    if (f.format !== "openpgp") await run("git", ["config", "gpg.format", f.format], { cwd: root });
    if (f.format === "ssh") await run("git", ["config", "gpg.ssh.allowedSignersFile", "/dev/null"], { cwd: root });
    await run("git", ["config", f.key, "./evil.sh"], { cwd: root });
    const ran = async () => (await readdir(path.dirname(root))).includes(path.basename(marker));
    return { root, marker, ran };
  }

  for (const f of FORMATS) {
    it(`${f.key} (${f.format}) is not run by log, pickaxe, show or validateSpec`, async () => {
      const { root, marker, ran } = await signedRepo(f);
      // the fixture is live: plain git log runs the checkout's program
      await run("git", ["log", "-n", "1"], { cwd: root }).catch(() => undefined);
      expect(await ran()).toBe(true);
      await rm(marker);

      expect(await inGitPathHistory(root, makeNeedle("asset", "gone_asset_*")!)).toBe(false);
      expect(await inGitHistory(root, "never_written_needle")).toBe(false);
      expect(await git(root, ["show", "-s", "HEAD"])).toMatch(/signed/);
      const ctx = await loadContext(root);
      await validateSpec(ctx, ResidueSpec.parse({ feature: "x", capability: "A user can no longer obtain x.", terms: ["lingerie"], assets: ["gone_asset_*"] }));
      expect(await ran()).toBe(false);
    });
  }

  it("settings pulled in through include.path are overridden as well", async () => {
    const { root, marker, ran } = await signedRepo(FORMATS[0]!);
    await run("git", ["config", "--unset", "log.showSignature"], { cwd: root });
    await run("git", ["config", "--unset", "gpg.program"], { cwd: root });
    await writeFile(path.join(root, ".git", "extra.cfg"), "[log]\n\tshowSignature = true\n[gpg]\n\tprogram = ./evil.sh\n");
    await run("git", ["config", "include.path", "extra.cfg"], { cwd: root });
    await run("git", ["log", "-n", "1"], { cwd: root }).catch(() => undefined);
    expect(await ran()).toBe(true);
    await rm(marker);
    expect(await inGitHistory(root, "never_written_needle")).toBe(false);
    expect(await ran()).toBe(false);
  });
});

describe("git history is limited to the project folder", () => {
  it("does not credit a symbol that only ever existed elsewhere in the enclosing repo", async () => {
    const outer = await tempProject({
      "tools/notes.ts": "export const TotallyInventedSymbolXYZ = 1;\n",
      "apps/ios/App.swift": "import SwiftUI\nstruct GoneView: View { var body: some View { Text(\"x\") } }\n",
      "apps/ios/old_outfit.png": "png",
    });
    await run("git", ["init", "-q"], { cwd: outer });
    await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: outer });
    await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: outer });
    await rm(path.join(outer, "apps/ios/old_outfit.png"));
    await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "remove asset"], { cwd: outer });
    const app = path.join(outer, "apps/ios");
    expect(await inGitHistory(app, "TotallyInventedSymbolXYZ")).toBe(false);
    expect(await inGitHistory(app, "GoneView")).toBe(true);
    expect(await inGitPathHistory(app, makeNeedle("asset", "old_outfit*")!)).toBe(true);
    expect(await inGitPathHistory(app, makeNeedle("asset", "notes*")!)).toBe(false);
  });
});

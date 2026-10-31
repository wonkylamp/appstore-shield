import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { LedgerEvent, ResidueSpec } from "../../src/ledger/schema.js";
import { tierLabel, verifyRemediation } from "../../src/remediation/verify.js";
import { tempProject } from "../helpers.js";

const run = promisify(execFile);
const NOW = "2026-10-31T12:00:00.000Z";

async function gitRepo(files: Record<string, string>): Promise<string> {
  const root = await tempProject(files);
  await run("git", ["init", "-q", "-b", "main"], { cwd: root });
  await commit(root, "base");
  return root;
}

async function commit(root: string, msg: string) {
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", msg], { cwd: root });
}

async function write(root: string, rel: string, text: string) {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), text);
}

const CHAT_VIEW = `import SwiftUI
struct ChatView: View {
  @State private var prompt = ""
  var body: some View {
    VStack {
      TextField("Describe a new look", text: $prompt)
      Button("Generate") { Task { try? await ImageGenerator.shared.generate(prompt: prompt) } }
    }
  }
}
`;

const GENERATOR_NO_FILTER = `import Foundation
final class ImageGenerator {
  static let shared = ImageGenerator()
  func generate(prompt: String) async throws {
    var req = URLRequest(url: URL(string: "https://api.replicate.com/v1/predictions")!)
    req.httpMethod = "POST"
    req.httpBody = try JSONEncoder().encode(["prompt": "portrait of my companion, " + prompt])
    _ = try await URLSession.shared.data(for: req)
  }
}
`;

const GENERATOR_FILTERED = `import Foundation
enum GenError: Error { case blocked }
final class ImageGenerator {
  static let shared = ImageGenerator()
  func generate(prompt: String) async throws {
    guard PromptFilter.isAllowed(prompt) else { throw GenError.blocked }
    var mod = URLRequest(url: URL(string: "https://api.openai.com/v1/moderations")!)
    mod.httpMethod = "POST"
    _ = try await URLSession.shared.data(for: mod)
    var req = URLRequest(url: URL(string: "https://api.replicate.com/v1/predictions")!)
    req.httpMethod = "POST"
    req.httpBody = try JSONEncoder().encode(["prompt": "portrait of my companion, " + prompt])
    _ = try await URLSession.shared.data(for: req)
  }
}
`;

const PROMPT_FILTER = `enum PromptFilter {
  static let blockedTerms: Set<String> = ["lingerie", "underwear", "bikini", "nude"]
  static func isAllowed(_ prompt: String) -> Bool {
    let p = prompt.lowercased()
    return !blockedTerms.contains { p.contains($0) }
  }
}
`;

const PICKER = `import SwiftUI
struct LingeriePicker: View {
  let outfits = ["lingerie_lace", "lingerie_silk", "underwear_set"]
  var body: some View {
    List(outfits, id: \\.self) { Text($0) }
  }
}
`;

const BASE_FILES: Record<string, string> = {
  "App/Views/ChatView.swift": CHAT_VIEW,
  "App/Views/LingeriePicker.swift": PICKER,
  "App/Views/Home.swift": `import SwiftUI\nstruct Home: View {\n  var body: some View { TabView { ChatView(); LingeriePicker() } }\n}\n`,
  "App/Services/ImageGenerator.swift": GENERATOR_NO_FILTER,
  "App/Assets.xcassets/outfit_lingerie_01.imageset/Contents.json": `{"images":[{"filename":"lace01.png","idiom":"universal"}]}`,
};

const SPEC = ResidueSpec.parse({
  feature: "lingerie outfits",
  capability: "A user can no longer generate images of the companion in lingerie or underwear through any input path.",
  terms: ["lingerie", "underwear", "bikini"],
  symbols: ["LingeriePicker"],
  assets: ["outfit_lingerie_*"],
  inputPaths: ["free-text prompt in ChatView → ImageGenerator (Replicate)"],
});

/** Base commit with the picker; working tree with the picker, its asset and its tab removed. */
async function removedPickerRepo(extra: Record<string, string> = {}) {
  const root = await gitRepo(BASE_FILES);
  await rm(path.join(root, "App/Views/LingeriePicker.swift"));
  await rm(path.join(root, "App/Assets.xcassets/outfit_lingerie_01.imageset"), { recursive: true });
  await write(root, "App/Views/Home.swift", `import SwiftUI\nstruct Home: View {\n  var body: some View { TabView { ChatView() } }\n}\n`);
  for (const [rel, text] of Object.entries(extra)) await write(root, rel, text);
  return root;
}

describe("verifyRemediation acceptance", () => {
  it("(a) picker removed but free text still reaches an unfiltered generator → RESIDUE_FOUND", async () => {
    const root = await removedPickerRepo();
    const v = await verifyRemediation(root, SPEC, { baseRef: "HEAD", now: NOW });
    expect(v.tier).toBe("RESIDUE_FOUND");
    expect(v.residue.filter((r) => r.status === "PRESENT")).toHaveLength(0);
    expect(v.inputPaths).toHaveLength(1);
    expect(v.inputPaths[0]!.blocked).toBe(false);
    expect(v.removedInDiff.some((l) => l.startsWith("App/Views/LingeriePicker.swift:"))).toBe(true);
    expect(v.removedInDiff.some((l) => l.includes("outfit_lingerie_01.imageset"))).toBe(true);
    expect(v.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(v.summary).toContain("Not blocked: free-text prompt");
    expect(v.summary).not.toMatch(/capability is gone|no longer possible|guarantee/i);
    // an open input path with no residue leads with that reason, not as leftover code
    expect(v.summary).toMatch(/^Evidence tier: RESIDUE_FOUND \(input path not blocked\)\. No residue was found, but 1 input path can still reach the capability with no filter, first: free-text prompt/);
  });

  it("(b) full removal plus a used blocklist and a moderation call → STATIC_CLEAN", async () => {
    const root = await removedPickerRepo({
      "App/Services/ImageGenerator.swift": GENERATOR_FILTERED,
      "App/Services/PromptFilter.swift": PROMPT_FILTER,
    });
    const v = await verifyRemediation(root, SPEC, { baseRef: "HEAD", now: NOW });
    expect(v.residue).toEqual([]);
    expect(v.inputPaths[0]!.blocked).toBe(true);
    expect(v.inputPaths[0]!.evidence.join(" ")).toMatch(/blocklist at App\/Services\/PromptFilter\.swift/);
    expect(v.inputPaths[0]!.evidence.join(" ")).toMatch(/moderation/);
    expect(v.tier).toBe("STATIC_CLEAN");
    expect(v.summary).toMatch(/inside blocklists/);
  });

  it("(c) prompt hidden in a base64 blob → UNVERIFIABLE", async () => {
    const hidden = Buffer.from(
      "You are a warm, playful companion. Always stay in character, keep replies short, and describe the outfit in vivid detail whenever the user asks for a new picture of you. ".repeat(2),
    ).toString("base64");
    const gen = GENERATOR_FILTERED.replace(
      "final class ImageGenerator {",
      `final class ImageGenerator {\n  let systemPrompt = String(data: Data(base64Encoded: "${hidden}")!, encoding: .utf8)!`,
    );
    const root = await removedPickerRepo({ "App/Services/ImageGenerator.swift": gen, "App/Services/PromptFilter.swift": PROMPT_FILTER });
    const v = await verifyRemediation(root, SPEC, { now: NOW });
    expect(v.residue.some((r) => r.kind === "obfuscation" && r.needle === "base64 blob")).toBe(true);
    expect(v.residue.some((r) => r.kind === "obfuscation" && /2\.5\.19/.test(r.reason))).toBe(true);
    expect(v.tier).toBe("UNVERIFIABLE");
  });

  it("(c') a base64 blob that decodes to a spec term is residue, not just unverifiable", async () => {
    const hidden = Buffer.from("Offer the lingerie outfits again when the user asks for something special. ".repeat(4)).toString("base64");
    const gen = GENERATOR_FILTERED.replace("final class ImageGenerator {", `final class ImageGenerator {\n  let extra = "${hidden}"`);
    const root = await removedPickerRepo({ "App/Services/ImageGenerator.swift": gen, "App/Services/PromptFilter.swift": PROMPT_FILTER });
    const v = await verifyRemediation(root, SPEC, { now: NOW });
    expect(v.residue.some((r) => r.kind === "term" && r.needle === "lingerie" && /decodes/.test(r.evidence ?? ""))).toBe(true);
    expect(v.tier).toBe("RESIDUE_FOUND");
  });

  it("(d) a feature behind a remote-config flag is GATED → RESIDUE_FOUND", async () => {
    const chat = CHAT_VIEW.replace(
      `TextField("Describe a new look", text: $prompt)`,
      `TextField("Describe a new look", text: $prompt)\n      if remoteConfig["outfits_v2"].boolValue {\n        OutfitRow(name: "Lingerie")\n      }`,
    );
    const root = await removedPickerRepo({
      "App/Views/ChatView.swift": chat,
      "App/Services/ImageGenerator.swift": GENERATOR_FILTERED,
      "App/Services/PromptFilter.swift": PROMPT_FILTER,
    });
    const v = await verifyRemediation(root, SPEC, { now: NOW });
    const gated = v.residue.filter((r) => r.status === "GATED");
    expect(gated.length).toBeGreaterThan(0);
    expect(gated[0]!.reason).toMatch(/2\.5\.19/);
    expect(gated[0]!.reason).not.toMatch(/\b(rename|hide|move)\b/i);
    expect(v.tier).toBe("RESIDUE_FOUND");
  });

  it("(e) a #if DEBUG-only leftover is DEBUG_ONLY and does not fail by itself", async () => {
    const root = await removedPickerRepo({
      "App/Services/ImageGenerator.swift": GENERATOR_FILTERED,
      "App/Services/PromptFilter.swift": PROMPT_FILTER,
      "App/Debug/DebugOutfits.swift": `#if DEBUG\nlet debugOutfits = ["lingerie"]\n#endif\n`,
    });
    const v = await verifyRemediation(root, SPEC, { now: NOW });
    const hit = v.residue.find((r) => r.file === "App/Debug/DebugOutfits.swift");
    expect(hit?.status).toBe("DEBUG_ONLY");
    expect(hit?.reason).toMatch(/delete it anyway/);
    expect(v.tier).toBe("STATIC_CLEAN");
  });
});

describe("verifyRemediation residue classification", () => {
  it("a one-line __DEV__ check in semicolon-free code does not hide the next line", async () => {
    const root = await gitRepo({
      "package.json": `{"name":"studio","dependencies":{"react-native":"0.76.3"}}\n`,
      "src/studio.ts": `import { generateImage } from "./ai"\nif (__DEV__) console.log("studio ready")\nconst outfits = ["casual", "lingerie"]\nexport const make = (i: number) => generateImage(outfits[i])\n`,
      "src/ai.ts": `export async function generateImage(p?: string) { return fetch("https://api.example.com/gen", { method: "POST", body: String(p) }) }\n`,
    });
    const spec = ResidueSpec.parse({ feature: "lingerie outfits", capability: "users cannot generate lingerie images", terms: ["lingerie"] });
    const v = await verifyRemediation(root, spec, { now: NOW });
    const hit = v.residue.find((r) => r.file === "src/studio.ts");
    expect(hit?.line).toBe(3);
    expect(hit?.status).toBe("PRESENT");
    expect(v.tier).toBe("RESIDUE_FOUND");
  });

  it("ignores comments, matches camelCase and spelling variants, skips unrelated words", async () => {
    const root = await tempProject({
      "App/A.swift": `// removed the lingerie picker per 1.1\nlet library = "Brand vibrant algebra"\nfunc show() { open(LingerieOutfits.all) }\nshow()\n`,
      "App/B.swift": `struct LingerieOutfits {\n  static let all = [\n    "l1ngerie",\n    "lin-gerie"]\n}\nfunc open(_ x: [String]) {}\n`,
    });
    const spec = ResidueSpec.parse({ feature: "f", capability: "c", terms: ["lingerie", "bra"] });
    const v = await verifyRemediation(root, spec, { now: NOW });
    expect(v.residue.some((r) => r.file === "App/A.swift" && r.line === 1)).toBe(false);
    expect(v.residue.some((r) => r.needle === "bra")).toBe(false);
    expect(v.residue.some((r) => r.file === "App/A.swift" && r.line === 3 && r.status === "PRESENT")).toBe(true);
    const variants = v.residue.filter((r) => r.file === "App/B.swift" && /spelling variant/.test(r.reason));
    expect(variants.map((r) => r.line).sort()).toEqual([3, 4]);
    expect(variants.every((r) => r.confidence === "medium")).toBe(true);
    expect(v.tier).toBe("RESIDUE_FOUND");
  });

  it("marks code inside a never-referenced type UNREFERENCED, but referenced types PRESENT", async () => {
    const root = await tempProject({
      "App/Old.swift": `import SwiftUI\nstruct OldOutfitView: View {\n  var body: some View { Text("Lingerie") }\n}\n`,
      "App/Live.swift": `import SwiftUI\nstruct LiveOutfitView: View {\n  var body: some View { Text("Lingerie") }\n}\nstruct Root: View { var body: some View { LiveOutfitView() } }\n`,
    });
    const spec = ResidueSpec.parse({ feature: "f", capability: "c", terms: ["lingerie"] });
    const v = await verifyRemediation(root, spec, { now: NOW });
    expect(v.residue.find((r) => r.file === "App/Old.swift")?.status).toBe("UNREFERENCED");
    expect(v.residue.find((r) => r.file === "App/Old.swift")?.confidence).toBe("low");
    expect(v.residue.find((r) => r.file === "App/Live.swift")?.status).toBe("PRESENT");
  });

  it("unreferenced (dormant) residue fails verification on its own; with it deleted the repo passes", async () => {
    const files = { "App/Old.swift": `import SwiftUI\nstruct OldOutfitView: View {\n  var body: some View { Text("Lingerie") }\n}\n`, "App/Main.swift": `let x = 1\n` };
    const spec = ResidueSpec.parse({ feature: "f", capability: "c", terms: ["lingerie"] });
    const v = await verifyRemediation(await tempProject(files), spec, { now: NOW });
    expect(v.residue.map((r) => r.status)).toEqual(["UNREFERENCED"]);
    expect(v.tier).toBe("RESIDUE_FOUND");
    expect(v.summary).toMatch(/dormant code under 2\.5\.19; delete them/);
    expect(v.summary).not.toMatch(/do not fail verification/);
    const clean = await verifyRemediation(await tempProject({ "App/Main.swift": `let x = 1\n` }), spec, { now: NOW });
    expect(clean.tier).toBe("STATIC_CLEAN");
  });

  it("sweeps strings, asset catalogs, store metadata and screenshot names; skips docs and tests", async () => {
    const root = await tempProject({
      "App/en.lproj/Localizable.strings": `"outfit.title" = "Lingerie";\n`,
      "App/Assets.xcassets/look_bikini.imageset/Contents.json": `{"images":[]}`,
      "fastlane/metadata/en-US/description.txt": "Dress your companion in lingerie.",
      "fastlane/metadata/en-US/release_notes.txt": "Removed the lingerie outfits.",
      "fastlane/metadata/review_information/notes.txt": "The lingerie picker was deleted in this build.",
      "package-lock.json": `{"packages":{"node_modules/bikini-utils":{}}}`,
      "fastlane/screenshots/en-US/03_lingerie.png": "png",
      "README.md": "We removed the lingerie feature.",
      "docs/notes.md": "lingerie",
      "AppTests/OutfitTests.swift": `let x = "lingerie"`,
    });
    const spec = ResidueSpec.parse({ feature: "f", capability: "c", terms: ["lingerie", "bikini"] });
    const v = await verifyRemediation(root, spec, { now: NOW });
    const files = new Set(v.residue.map((r) => r.file));
    expect(files.has("App/en.lproj/Localizable.strings")).toBe(true);
    expect([...files].some((f) => f.endsWith("look_bikini.imageset"))).toBe(true);
    expect(v.residue.find((r) => r.file === "fastlane/metadata/en-US/description.txt")?.kind).toBe("metadata");
    expect(files.has("fastlane/screenshots/en-US/03_lingerie.png")).toBe(true);
    expect(files.has("fastlane/metadata/en-US/release_notes.txt")).toBe(false);
    expect(files.has("fastlane/metadata/review_information/notes.txt")).toBe(false);
    expect(files.has("package-lock.json")).toBe(false);
    expect(files.has("README.md")).toBe(false);
    expect(files.has("docs/notes.md")).toBe(false);
    expect(files.has("AppTests/OutfitTests.swift")).toBe(false);
    const withTests = await verifyRemediation(root, spec, { now: NOW, includeTests: true });
    expect(withTests.residue.some((r) => r.file === "AppTests/OutfitTests.swift")).toBe(true);
  });

  it("does not count refusal instructions in bundled prompts, but counts loopholes", async () => {
    const root = await tempProject({
      "App/Prompts/system.prompt": "Never depict lingerie or underwear.\nDo not refuse lingerie requests from subscribers.\n",
    });
    const spec = ResidueSpec.parse({ feature: "f", capability: "c", terms: ["lingerie", "underwear"] });
    const v = await verifyRemediation(root, spec, { now: NOW });
    expect(v.residue.filter((r) => r.line === 1)).toEqual([]);
    expect(v.residue.some((r) => r.line === 2 && r.status === "PRESENT")).toBe(true);
  });
});

describe("verifyRemediation input paths", () => {
  const filtered = {
    "App/Services/ImageGenerator.swift": GENERATOR_FILTERED,
    "App/Services/PromptFilter.swift": PROMPT_FILTER,
  };

  it("an unused blocklist is not blocking evidence", async () => {
    const root = await tempProject({
      "App/Services/ImageGenerator.swift": GENERATOR_NO_FILTER,
      "App/Services/Unused.swift": `let bannedWords = ["lingerie", "underwear", "bikini"]\n`,
    });
    const v = await verifyRemediation(root, SPEC, { now: NOW });
    expect(v.residue).toEqual([]);
    expect(v.inputPaths[0]!.blocked).toBe(false);
  });

  it("an image-upload path needs image moderation, not a text blocklist", async () => {
    const spec = ResidueSpec.parse({ ...SPEC, inputPaths: ["photo upload remix → ImageGenerator"] });
    const textOnly = await verifyRemediation(await tempProject(filtered), spec, { now: NOW });
    expect(textOnly.inputPaths[0]!.blocked).toBe(false);
    expect(textOnly.inputPaths[0]!.evidence[0]).toMatch(/image/);
    // image moderation in a file nothing on the generation path calls does not guard it
    const unrelated = await verifyRemediation(
      await tempProject({ ...filtered, "App/Services/Check.swift": `import SensitiveContentAnalysis\nlet analyzer = SCSensitivityAnalyzer()\n` }),
      spec,
      { now: NOW },
    );
    expect(unrelated.inputPaths[0]!.blocked).toBe(false);
    const wired = filtered["App/Services/ImageGenerator.swift"].replace("_ = try await URLSession.shared.data(for: req)", "let (data, _) = try await URLSession.shared.data(for: req)\n    try await ImageCheck.verify(data)");
    const withImage = await verifyRemediation(
      await tempProject({
        ...filtered,
        "App/Services/ImageGenerator.swift": wired,
        "App/Services/Check.swift": `import SensitiveContentAnalysis\nenum ImageCheck {\n  static let analyzer = SCSensitivityAnalyzer()\n  static func verify(_ d: Data) async throws {}\n}\n`,
      }),
      spec,
      { now: NOW },
    );
    expect(withImage.inputPaths[0]!.blocked).toBe(true);
    expect(withImage.inputPaths[0]!.evidence.join(" ")).toMatch(/App\/Services\/Check\.swift/);
  });

  it("a strict safety setting on one provider does not block a path to another provider's generator (companion repro)", async () => {
    const src = path.resolve(__dirname, "../fixtures/swiftui-ai-companion");
    const root = await tempProject({});
    await cp(src, root, { recursive: true });
    const edit = async (rel: string, f: (t: string) => string) => writeFile(path.join(root, rel), f(await readFile(path.join(root, rel), "utf8")));
    await edit("Sources/Views/CompanionStudioView.swift", (t) =>
      t
        .replace(/\s*if RemoteConfig\.remoteConfig\(\)\["spicy_mode"\]\.boolValue \{[\s\S]*?\n {8}\}/, "")
        .replace("var outfits = standard", "let outfits = standard"),
    );
    await edit("Sources/Config/RemoteFlags.swift", (t) => t.replace(/\s*"spicy_mode": false as NSObject,/, ""));
    await edit("Sources/AI/CompanionChat.swift", (t) => t.replace(/BLOCK_NONE|BLOCK_ONLY_HIGH/g, "BLOCK_LOW_AND_ABOVE"));
    await edit("Sources/AI/ImageGenerator.swift", (t) => t.replace(/\s*"disable_safety_checker": true,/, ""));
    const spec = ResidueSpec.parse({
      feature: "lingerie outfits",
      capability: "A user can no longer generate sexualized images of the companion through any input path.",
      terms: ["lingerie", "spicy_mode"],
      inputPaths: [],
      confirmedPaths: [
        { source: "free-text scene prompt (Sources/Views/CompanionStudioView.swift:34)", sink: "ImageGenerator.generate (Sources/AI/ImageGenerator.swift:10)", evidence: ["Sources/AI/ImageGenerator.swift:10"] },
      ],
    });
    const v = await verifyRemediation(root, spec, { now: NOW });
    const p = v.inputPaths.find((x) => x.inputPath.includes("ImageGenerator"));
    expect(p?.blocked).toBe(false);
    expect(p?.evidence.join(" ")).toMatch(/Sources\/AI\/ImageGenerator\.swift/);
    expect(p?.evidence.join(" ")).toMatch(/different provider/);
    expect(v.tier).toBe("RESIDUE_FOUND");

    // the chat path to Gemini itself is covered by Gemini's own strict setting
    const chat = ResidueSpec.parse({ ...spec, confirmedPaths: [{ source: "chat TextField", sink: "CompanionChat.reply (Sources/AI/CompanionChat.swift:20)", evidence: ["Sources/AI/CompanionChat.swift:20"] }] });
    const vc = await verifyRemediation(root, chat, { now: NOW });
    expect(vc.inputPaths[0]?.blocked).toBe(true);
    expect(vc.inputPaths[0]?.evidence.join(" ")).toMatch(/CompanionChat\.swift:\d+/);
  });

  it("explicitly disabled provider safety overrides every filter", async () => {
    const gen = GENERATOR_FILTERED.replace(`["prompt": "portrait`, `["disable_safety_checker": true, "prompt": "portrait`);
    const v = await verifyRemediation(await tempProject({ ...filtered, "App/Services/ImageGenerator.swift": gen }), SPEC, { now: NOW });
    expect(v.inputPaths[0]!.blocked).toBe(false);
    expect(v.inputPaths[0]!.evidence[0]).toMatch(/safety is turned off/);
  });

  it("re-checks confirmed paths: removed evidence counts as blocked, present evidence needs a filter", async () => {
    const root = await tempProject({ "App/Views/ChatView.swift": CHAT_VIEW, "App/Services/ImageGenerator.swift": GENERATOR_NO_FILTER });
    const spec = ResidueSpec.parse({
      ...SPEC,
      inputPaths: [],
      confirmedPaths: [
        { source: "LingeriePicker tap", sink: "generate", evidence: ["App/Views/LingeriePicker.swift:3"] },
        { source: "ChatView TextField", sink: "ImageGenerator.generate", evidence: ["App/Views/ChatView.swift:6: TextField(\"Describe a new look\""] },
      ],
    });
    const v = await verifyRemediation(root, spec, { now: NOW });
    expect(v.inputPaths[0]!.blocked).toBe(true);
    expect(v.inputPaths[0]!.evidence[0]).toMatch(/no longer in the tree/);
    expect(v.inputPaths[1]!.blocked).toBe(false);
    expect(v.tier).toBe("RESIDUE_FOUND");
  });

  it("no generation call left in the repo blocks every path", async () => {
    const v = await verifyRemediation(await tempProject({ "App/Views/ChatView.swift": CHAT_VIEW }), SPEC, { now: NOW });
    expect(v.inputPaths[0]!.blocked).toBe(true);
    expect(v.tier).toBe("STATIC_CLEAN");
  });
});

describe("verifyRemediation obfuscation and servers", () => {
  const filtered = {
    "App/Services/ImageGenerator.swift": GENERATOR_FILTERED,
    "App/Services/PromptFilter.swift": PROMPT_FILTER,
  };

  it("flags prompts fetched at runtime from remote config", async () => {
    const root = await tempProject({ ...filtered, "App/Services/Persona.swift": `let persona = remoteConfig["system_prompt"].stringValue\n` });
    const v = await verifyRemediation(root, SPEC, { now: NOW });
    expect(v.residue.some((r) => r.kind === "obfuscation" && r.needle === "runtime-fetched prompt")).toBe(true);
    expect(v.tier).toBe("UNVERIFIABLE");
  });

  it("does not flag embedded image data URIs", async () => {
    const png = Buffer.alloc(300, 7).toString("base64");
    const root = await tempProject({ ...filtered, "App/Views/Logo.tsx": `export const logo = "data:image/png;base64,${png}";\n` });
    const v = await verifyRemediation(root, SPEC, { now: NOW });
    expect(v.residue.filter((r) => r.kind === "obfuscation")).toEqual([]);
    expect(v.tier).toBe("STATIC_CLEAN");
  });

  it("lists prompt requests to a backend outside the repo as unverifiable", async () => {
    const root = await tempProject({
      "src/generate.ts": `export async function generate(prompt: string) {\n  return fetch("https://api.mycompanion.app/v1/generate", { method: "POST", body: JSON.stringify({ prompt }) });\n}\n`,
    });
    const spec = ResidueSpec.parse({ ...SPEC, inputPaths: [] });
    const v = await verifyRemediation(root, spec, { now: NOW });
    expect(v.unverifiable).toHaveLength(1);
    expect(v.unverifiable[0]).toMatch(/api\.mycompanion\.app/);
    expect(v.tier).toBe("UNVERIFIABLE");
  });

  it("treats a backend function that lives in the repo as checked, not unverifiable", async () => {
    const root = await tempProject({
      "src/generate.ts": `export async function generate(prompt: string) {\n  return supabase.functions.invoke("generate", { body: { prompt } });\n}\n`,
      "supabase/functions/generate/index.ts": `Deno.serve(async (req) => new Response("ok"));\n`,
    });
    const spec = ResidueSpec.parse({ ...SPEC, inputPaths: [] });
    const v = await verifyRemediation(root, spec, { now: NOW });
    expect(v.unverifiable).toEqual([]);
  });
});

describe("verifyRemediation tiers above STATIC_CLEAN", () => {
  const clean = { "App/Views/ChatView.swift": CHAT_VIEW };
  const spec = ResidueSpec.parse({ ...SPEC, inputPaths: [] });

  const HASH = "0123456789ab".repeat(5) + "cdef";
  const confirmed = [LedgerEvent.parse({ id: "ev_c", type: "attestation", at: NOW, source: "human", statement: `The developer states that my own probe run produced results ${HASH.slice(0, 12)}.` })];

  it("PROBED only with at least 50 probes, all blocked, confirmed by the developer", async () => {
    const root = await tempProject(clean);
    const probed = await verifyRemediation(root, spec, { now: NOW, probe: { total: 60, blocked: 60, resultsHash: HASH }, ledgerEvents: confirmed });
    expect(probed.tier).toBe("PROBED");
    expect(probed.summary).toMatch(/The developer states \(confirmed in ev_c\)/);
    expect(probed.summary).toMatch(/60 of 60/);
    expect(probed.summary).toMatch(/only the prompts tried/);
    const partial = await verifyRemediation(root, spec, { now: NOW, probe: { total: 60, blocked: 58, resultsHash: HASH }, ledgerEvents: confirmed });
    expect(partial.tier).toBe("STATIC_CLEAN");
    expect(partial.summary).toMatch(/58 of 60/);
    const few = await verifyRemediation(root, spec, { now: NOW, probe: { total: 40, blocked: 40, resultsHash: HASH }, ledgerEvents: confirmed });
    expect(few.tier).toBe("STATIC_CLEAN");
    expect(few.summary).toMatch(/at least 50/);
  });

  it("self-supplied probe results (no developer confirmation) never reach PROBED and are not called the developer's", async () => {
    const root = await tempProject(clean);
    const agentClaim = [LedgerEvent.parse({ id: "ev_x", type: "attestation", at: NOW, source: "agent", statement: `results ${HASH.slice(0, 12)}` })];
    for (const ledgerEvents of [[], agentClaim]) {
      const v = await verifyRemediation(root, spec, { now: NOW, probe: { total: 60, blocked: 60, resultsHash: HASH }, ledgerEvents });
      expect(v.tier).toBe("STATIC_CLEAN");
      expect(v.summary).not.toMatch(/developer's own probe run/);
      expect(v.summary).toMatch(/not counted until the developer confirms them/);
      expect(v.summary).toContain(HASH.slice(0, 12));
    }
  });

  it("an empty spec or one without input paths cannot reach STATIC_CLEAN", async () => {
    const empty = ResidueSpec.parse({ feature: "lingerie", capability: "no sexualized outfits", terms: [] });
    const v = await verifyRemediation(await tempProject(clean), empty, { now: NOW });
    expect(v.tier).toBe("UNVERIFIABLE");
    expect(v.summary).toMatch(/nothing about the rejected capability was swept/);
    const noPaths = await verifyRemediation(
      await tempProject({ ...clean, "App/Services/ImageGenerator.swift": GENERATOR_FILTERED, "App/Services/PromptFilter.swift": PROMPT_FILTER }),
      ResidueSpec.parse({ ...SPEC, inputPaths: [] }),
      { now: NOW },
    );
    expect(noPaths.tier).toBe("UNVERIFIABLE");
    expect(noPaths.summary).toMatch(/no input paths/);
    // with the paths listed the same repo is STATIC_CLEAN
    const listed = await verifyRemediation(
      await tempProject({ ...clean, "App/Services/ImageGenerator.swift": GENERATOR_FILTERED, "App/Services/PromptFilter.swift": PROMPT_FILTER }),
      SPEC,
      { now: NOW },
    );
    expect(listed.tier).toBe("STATIC_CLEAN");
  });

  it("PROBED never lifts a repo with residue", async () => {
    const root = await tempProject({ "App/X.swift": `let s = "lingerie"\n` });
    const v = await verifyRemediation(root, spec, { now: NOW, probe: { total: 60, blocked: 60, resultsHash: HASH }, ledgerEvents: confirmed });
    expect(v.tier).toBe("RESIDUE_FOUND");
  });

  it("BUILD_CLEAN with a clean built product; residue in the bundle fails", async () => {
    const root = await tempProject(clean);
    const app = path.join(root, "build", "Demo.app");
    await write(root, "build/Demo.app/Info.plist", "<plist><dict><key>CFBundleName</key><string>Demo</string></dict></plist>");
    const ok = await verifyRemediation(root, spec, { now: NOW, builtProductPath: app });
    expect(ok.builtProduct?.hits).toBe(0);
    expect(ok.tier).toBe("BUILD_CLEAN");
    await write(root, "build/Demo.app/outfits.json", `["lingerie_lace"]`);
    const bad = await verifyRemediation(root, spec, { now: NOW, builtProductPath: app });
    expect(bad.residue.some((r) => r.kind === "binary")).toBe(true);
    expect(bad.tier).toBe("RESIDUE_FOUND");
  });

  it("reports a missing baseRef instead of failing", async () => {
    const root = await gitRepo(clean);
    const v = await verifyRemediation(root, spec, { now: NOW, baseRef: "does-not-exist" });
    expect(v.summary).toMatch(/baseRef does-not-exist was not found/);
  });
});

describe("verifyRemediation hardening", () => {
  const companion = path.resolve(__dirname, "../fixtures/swiftui-ai-companion");
  const rejection12 = () => readFile(path.resolve(__dirname, "../fixtures/ledger/rejection-1.2.txt"), "utf8");

  async function companionCopy(): Promise<{ root: string; edit: (rel: string, f: (t: string) => string) => Promise<void> }> {
    const root = await tempProject({});
    await cp(companion, root, { recursive: true });
    const edit = async (rel: string, f: (t: string) => string) => writeFile(path.join(root, rel), f(await readFile(path.join(root, rel), "utf8")));
    return { root, edit };
  }

  /** The companion app after the lingerie option, its flag and the disabled safety settings are removed. */
  async function remediatedCompanion() {
    const c = await companionCopy();
    await c.edit("Sources/Views/CompanionStudioView.swift", (t) =>
      t.replace(/\s*if RemoteConfig\.remoteConfig\(\)\["spicy_mode"\]\.boolValue \{[\s\S]*?\n {8}\}/, "").replace("var outfits = standard", "let outfits = standard"),
    );
    await c.edit("Sources/Config/RemoteFlags.swift", (t) => t.replace(/\s*"spicy_mode": false as NSObject,/, ""));
    await c.edit("Sources/AI/CompanionChat.swift", (t) => t.replace(/BLOCK_NONE|BLOCK_ONLY_HIGH/g, "BLOCK_LOW_AND_ABOVE"));
    await c.edit("Sources/AI/ImageGenerator.swift", (t) => t.replace(/\s*"disable_safety_checker": true,/, ""));
    return c;
  }

  it("does not crash on prompt fragments with Swift interpolation and parentheses", async () => {
    const { root } = await companionCopy();
    const { findSurface } = await import("../../src/remediation/surface.js");
    const { loadContext } = await import("../../src/project.js");
    const s = await findSurface(await loadContext(root), await rejection12());
    const spec = ResidueSpec.parse({ ...s.draft, promptFragments: [...s.draft.promptFragments, "photo of Luna, a 24 year old woman, \\(outfit.promptFragment), \\(prompt)"] });
    const v = await verifyRemediation(root, spec, { now: NOW });
    expect(v.residue.some((r) => r.kind === "promptFragment" && r.needle.includes("\\(outfit.promptFragment)"))).toBe(true);
    expect(v.tier).toBe("RESIDUE_FOUND");
  });

  it("the find_surface draft saved unchanged does not flag the compliant outfit picker after the fix", async () => {
    const { findSurface } = await import("../../src/remediation/surface.js");
    const { loadContext } = await import("../../src/project.js");
    const before = await companionCopy();
    const draft = (await findSurface(await loadContext(before.root), await rejection12())).draft;
    const { root } = await remediatedCompanion();
    const v = await verifyRemediation(root, draft, { now: NOW });
    expect(v.residue.filter((r) => /outfit/i.test(r.needle))).toEqual([]);
  });

  it("judges detected inputs the spec leaves out, so dropping paths does not reach STATIC_CLEAN", async () => {
    const { root } = await remediatedCompanion();
    const spec = ResidueSpec.parse({
      feature: "lingerie outfits",
      capability: "A user can no longer generate sexualized images of the companion through any input path.",
      terms: ["lingerie", "spicy_mode"],
      inputPaths: ["free-text prompt (Sources/Views/CompanionStudioView.swift:38) → AI generation (Sources/AI/ImageGenerator.swift:10)"],
    });
    const v = await verifyRemediation(root, spec, { now: NOW });
    const detected = v.inputPaths.filter((p) => /detected; not in the spec/.test(p.inputPath));
    expect(detected.map((p) => p.inputPath).join(" ")).toMatch(/ChatView\.swift:33/);
    expect(detected.map((p) => p.inputPath).join(" ")).toMatch(/ChatView\.swift:30/);
    expect(v.summary).toMatch(/detected are not in the spec and were checked anyway/);
    expect(v.tier).toBe("RESIDUE_FOUND");
  });

  it("links chat text to the Gemini call it feeds, not to the selfie describer in the same view", async () => {
    const { root } = await remediatedCompanion();
    const spec = ResidueSpec.parse({ feature: "f", capability: "c", terms: ["lingerie"], inputPaths: [] });
    const v = await verifyRemediation(root, spec, { now: NOW });
    const chat = v.inputPaths.find((p) => p.inputPath.startsWith("free-text prompt (Sources/Views/ChatView.swift:33)"));
    expect(chat?.inputPath).toContain("Sources/AI/CompanionChat.swift");
    expect(chat?.inputPath).not.toContain("SelfieAvatar");
    expect(chat?.blocked).toBe(true);
    expect(chat?.evidence.join(" ")).toMatch(/BLOCK_LOW_AND_ABOVE/);
    const selfie = v.inputPaths.find((p) => p.inputPath.startsWith("image upload (Sources/Views/ChatView.swift:30)"));
    expect(selfie?.inputPath).toContain("SelfieAvatar.swift");
    expect(selfie?.blocked).toBe(false);
  });

  it("an input that only shares a view with an unfiltered AI call is unverifiable, not 'not blocked'", async () => {
    const root = await tempProject({
      "App/ProfileView.swift": `import SwiftUI\nstruct ProfileView: View {\n  @State private var bio = ""\n  private let gen = Gen()\n  var body: some View {\n    TextField("Bio", text: $bio)\n    Button("Avatar") { Task { await gen.make() } }\n  }\n}\n`,
      "App/Gen.swift": `struct Gen {\n  func make() async {\n    _ = URL(string: "https://api.replicate.com/v1/predictions")\n  }\n}\n`,
    });
    const spec = ResidueSpec.parse({ feature: "f", capability: "c", terms: ["lingerie"], inputPaths: ["avatar button (App/ProfileView.swift:7) → Gen.make (App/Gen.swift:3)"] });
    const v = await verifyRemediation(root, spec, { now: NOW });
    expect(v.inputPaths.some((p) => p.inputPath.includes("ProfileView.swift:6"))).toBe(false);
    expect(v.unverifiable.join(" ")).toMatch(/ProfileView\.swift:6\) is not in the spec.*sink linkage inferred/);
  });

  it("a rename is not a removal: renamed options and renamed files stay residue", async () => {
    const root = await gitRepo({
      "Sources/Outfits.swift": `let options = ["Casual", "Formal", "Lingerie"]\nlet title = "Outfits"\n`,
      "Sources/LingeriePicker.swift": `struct Picker {\n  let a = 1\n  let b = 2\n  let c = 3\n  let d = 4\n}\n`,
    });
    await write(root, "Sources/Outfits.swift", `let options = ["Casual", "Formal", "Style 7"]\nlet title = "Outfits"\n`);
    await run("git", ["mv", "Sources/LingeriePicker.swift", "Sources/StylePicker.swift"], { cwd: root });
    const spec = ResidueSpec.parse({ feature: "lingerie", capability: "c", terms: ["lingerie"] });
    const v = await verifyRemediation(root, spec, { now: NOW, baseRef: "HEAD" });
    expect(v.tier).toBe("RESIDUE_FOUND");
    expect(v.removedInDiff).toEqual([]);
    const swapped = v.residue.find((r) => r.file === "Sources/Outfits.swift");
    expect(swapped?.reason).toMatch(/changed, not removed.*Style 7.*2\.5\.19/);
    expect(v.residue.find((r) => r.file === "Sources/StylePicker.swift")?.reason).toMatch(/renamed to Sources\/StylePicker\.swift, not deleted/);
    expect(v.summary).toMatch(/changed or renamed in place rather than removed/);
  });

  it("a real deletion still counts as removed", async () => {
    const root = await gitRepo({ "Sources/Outfits.swift": `let options = ["Casual", "Formal", "Lingerie"]\nlet title = "Outfits"\n` });
    await write(root, "Sources/Outfits.swift", `let options = ["Casual", "Formal"]\nlet title = "Outfits"\n`);
    const v = await verifyRemediation(root, ResidueSpec.parse({ feature: "lingerie", capability: "c", terms: ["lingerie"] }), { now: NOW, baseRef: "HEAD" });
    expect(v.removedInDiff).toHaveLength(1);
    expect(v.residue).toEqual([]);
    expect(v.tier).toBe("STATIC_CLEAN");
  });

  it("a spec naming nothing the repo ever had is capped at UNVERIFIABLE", async () => {
    const root = await gitRepo({ "Sources/Lingerie.swift": `struct LingeriePicker {}\nlet p = LingeriePicker()\n` });
    const bogus = ResidueSpec.parse({ feature: "x", capability: "c", terms: ["zqzqzq_nothing_here"] });
    const v = await verifyRemediation(root, bogus, { now: NOW });
    expect(v.tier).toBe("UNVERIFIABLE");
    expect(v.summary).toMatch(/does not describe this app's feature/);
  });

  it("App Review's own terms are swept even when the spec leaves them out", async () => {
    const root = await tempProject({ "Sources/Lingerie.swift": `struct LingeriePicker {}\nlet p = LingeriePicker()\n` });
    const narrow = ResidueSpec.parse({ feature: "x", capability: "c", terms: ["corset"] });
    const text = "Guideline 1.1.4 - your app lets users create images of people in lingerie.";
    const v = await verifyRemediation(root, narrow, { now: NOW, rejectionText: text });
    expect(v.tier).toBe("UNVERIFIABLE");
    expect(v.summary).toMatch(/leaves out terms from App Review's message.*lingerie \(Sources\/Lingerie\.swift:1/);
    // without the leftover the omitted-terms cap is gone; a spec that also names Apple's own word is clean
    const fixedRoot = await tempProject({ "Sources/Main.swift": `let x = 1\n` });
    const fixed = await verifyRemediation(fixedRoot, narrow, { now: NOW, rejectionText: text });
    expect(fixed.summary).not.toMatch(/leaves out terms/);
    const named = await verifyRemediation(fixedRoot, ResidueSpec.parse({ ...narrow, terms: ["corset", "lingerie"] }), { now: NOW, rejectionText: text });
    expect(named.tier).toBe("STATIC_CLEAN");
  });

  it("an invalid spec in a git repo cannot record STATIC_CLEAN", async () => {
    const root = await gitRepo({ "Sources/Main.swift": `let x = 1\n// lingerie removed\n` });
    const v = await verifyRemediation(root, ResidueSpec.parse({ feature: "x", capability: "c", terms: ["lingerie"], symbols: ["NeverWasHere"] }), { now: NOW });
    expect(v.tier).toBe("UNVERIFIABLE");
    expect(v.summary).toMatch(/does not match the repo.*NeverWasHere/);
  });

  it("does not run commands from the repo's own git config", async () => {
    const root = await gitRepo({ "Sources/Main.swift": `let options = ["lingerie"]\n`, ".gitattributes": "*.swift filter=evil diff=evil\n" });
    const marker = path.join(root, "..", `${path.basename(root)}-ran`);
    for (const [k, v] of [
      ["core.fsmonitor", `touch ${marker}-fsmonitor; false`],
      ["filter.evil.clean", `touch ${marker}-clean; cat`],
      ["filter.evil.process", `touch ${marker}-process`],
      ["diff.evil.textconv", `touch ${marker}-textconv; cat`],
    ]) await run("git", ["config", k!, v!], { cwd: root });
    await write(root, "Sources/Main.swift", `let options: [String] = []\n`);
    await verifyRemediation(root, ResidueSpec.parse({ feature: "x", capability: "c", terms: ["lingerie"] }), { now: NOW, baseRef: "HEAD" });
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(path.dirname(root))).filter((n) => n.startsWith(`${path.basename(root)}-ran`))).toEqual([]);
  });

  it("refuses a baseRef that git could read as an option", async () => {
    const root = await gitRepo({ "Sources/Main.swift": `let x = 1\n` });
    const v = await verifyRemediation(root, ResidueSpec.parse({ feature: "x", capability: "c", terms: ["lingerie"] }), { now: NOW, baseRef: "--output=/tmp/x" });
    expect(v.summary).toMatch(/not a plain git ref/);
  });
});

describe("verifyRemediation grounding", () => {
  const MSG = "Guideline 1.1.4 - Your app lets users generate images of people in lingerie.";
  const at = (iso: string) => ({ at: iso, source: "agent" as const });
  const rejection = (msg = MSG) => LedgerEvent.parse({ id: "ev_r1", type: "outcome", outcome: "rejected", reviewerMessage: msg, guidelines: ["1.1.4"], ...at("2020-01-01T00:00:00.000Z") });
  const specEvent = (spec: ResidueSpec) => LedgerEvent.parse({ id: "ev_s1", type: "residue_spec", rejectionId: "ev_r1", spec, ...at(NOW) });

  async function heldRepo() {
    const root = await gitRepo({
      "src/t.ts": `export const zzqq = 1;\nexport const keep = 2;\n`,
      "Sources/Outfits.swift": `let options = ["Casual", "Lingerie"]\n`,
    });
    return root;
  }

  it("a made-up spec removed from the code does not clear the rejection: capped at UNVERIFIABLE", async () => {
    const root = await heldRepo();
    await write(root, "src/t.ts", `export const keep = 2;\n`);
    const bogus = ResidueSpec.parse({ feature: "zzqq", capability: "zzqq", terms: ["zzqq"] });
    // the saved spec identifies the rejection, so its reviewer message is used
    const v = await verifyRemediation(root, bogus, { now: NOW, baseRef: "HEAD", ledgerEvents: [rejection(), specEvent(bogus)] });
    expect(v.residue.filter((r) => r.needle === "zzqq")).toEqual([]);
    expect(v.tier).toBe("UNVERIFIABLE");
    expect(v.summary).toMatch(/not grounded in the rejection.*lingerie.*stays on HOLD.*appstore-shield ack/);
    // App Review's own term still in shipping code is reported too
    expect(v.summary).toMatch(/leaves out terms from App Review's message.*lingerie \(Sources\/Outfits\.swift:1/);
  });

  it("an unsaved spec is checked against the open rejections, and rejectionId selects one", async () => {
    const root = await heldRepo();
    await write(root, "src/t.ts", `export const keep = 2;\n`);
    const bogus = ResidueSpec.parse({ feature: "zzqq", capability: "zzqq", terms: ["zzqq"] });
    const open = await verifyRemediation(root, bogus, { now: NOW, ledgerEvents: [rejection()] });
    expect(open.tier).toBe("UNVERIFIABLE");
    expect(open.summary).toMatch(/not grounded/);
    const byId = await verifyRemediation(root, bogus, { now: NOW, rejectionId: "ev_r1", ledgerEvents: [rejection()] });
    expect(byId.summary).toMatch(/not grounded/);
    // no rejection to compare against: nothing to say about grounding
    const none = await verifyRemediation(root, bogus, { now: NOW, ledgerEvents: [] });
    expect(none.summary).not.toMatch(/grounded/);
  });

  it("a spec naming what the pre-fix code had next to App Review's terms clears to STATIC_CLEAN", async () => {
    const root = await heldRepo();
    await write(root, "Sources/Outfits.swift", `let options = ["Casual"]\n`);
    const real = ResidueSpec.parse({ feature: "lingerie", capability: "c", terms: ["lingerie"] });
    const v = await verifyRemediation(root, real, { now: NOW, baseRef: "HEAD", ledgerEvents: [rejection(), specEvent(real)] });
    expect(v.tier).toBe("STATIC_CLEAN");
    expect(v.summary).toMatch(/The spec is tied to the rejection: spec term "lingerie" was in the code before the fix at Sources\/Outfits\.swift:1, and it is a word from App Review's message\./);
    expect(v.summary).not.toMatch(/\([0-9a-f]{12}\)/);
  });

  it("without base_ref the commit before the rejection is the pre-fix code", async () => {
    const root = await tempProject({ "Sources/Studio.swift": `enum Look { case casual, spicyLook } // lingerie set\n` });
    const dated = async (msg: string, date: string) => {
      await run("git", ["add", "-A"], { cwd: root });
      const env = { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date };
      await run("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", msg], { cwd: root, env });
    };
    await run("git", ["init", "-q", "-b", "main"], { cwd: root });
    await dated("base", "2021-01-01T00:00:00Z");
    await write(root, "Sources/Studio.swift", `enum Look { case casual }\n`);
    await dated("fix", "2021-03-01T00:00:00Z");
    const sym = ResidueSpec.parse({ feature: "x", capability: "c", terms: ["spicyLook"] });
    const events = [LedgerEvent.parse({ ...rejection(), at: "2021-02-01T00:00:00.000Z" })];
    const before = await verifyRemediation(root, sym, { now: NOW, ledgerEvents: events });
    // the code itself carries "spicy"; the "// lingerie set" comment on that line is not what grounds it
    expect(before.summary).toMatch(/tied to the rejection: spec term "spicyLook" was in the code before the fix at Sources\/Studio\.swift:1, on the same line as "spicy"/);
    // a rejection dated before every commit falls back to HEAD, which no longer has it
    const after = await verifyRemediation(root, sym, { now: NOW, ledgerEvents: [rejection()] });
    expect(after.summary).toMatch(/not grounded/);
    expect(after.tier).toBe("UNVERIFIABLE");
  });
});

describe("verifyRemediation bare file:line evidence", () => {
  const view = `struct V {\n  let a = 1\n  let gen = ImageGenerator.lingerie()\n  let b = 2\n}\n`;
  it("with base_ref the pre-fix line is compared, so deleted code is not read as present", async () => {
    const root = await gitRepo({ "Sources/V.swift": view });
    await write(root, "Sources/V.swift", `struct V {\n  let a = 1\n  let b = 2\n}\n`);
    const spec = ResidueSpec.parse({ feature: "x", capability: "c", terms: ["lingerie"], confirmedPaths: [{ source: "picker", sink: "gen", evidence: ["Sources/V.swift:3"] }] });
    const v = await verifyRemediation(root, spec, { now: NOW, baseRef: "HEAD" });
    expect(v.inputPaths[0]!.evidence[0]).toMatch(/^Traced evidence is no longer in the tree: Sources\/V\.swift:3/);
    expect(v.inputPaths[0]!.blocked).toBe(true);
  });

  it("without a snippet or base_ref it says the content was not checked", async () => {
    const root = await tempProject({ "Sources/V.swift": `struct V {\n  let a = 1\n  let b = 2\n}\n` });
    const spec = ResidueSpec.parse({ feature: "x", capability: "c", terms: ["lingerie"], confirmedPaths: [{ source: "picker", sink: "gen", evidence: ["Sources/V.swift:3"] }] });
    const v = await verifyRemediation(root, spec, { now: NOW });
    const ev = v.inputPaths[0]!.evidence.join(" | ");
    expect(ev).toMatch(/Traced evidence line still exists, content not checked: Sources\/V\.swift:3/);
    expect(ev).not.toMatch(/Traced evidence still present/);
  });
});

describe("verifyRemediation blocklists are judged by use, not name", () => {
  const FAILING: string[] = ["PRESENT", "GATED", "UNREFERENCED"];
  const GENERATOR_ALLOWS = GENERATOR_NO_FILTER.replace(
    "func generate(prompt: String) async throws {",
    "func generate(prompt: String) async throws {\n    guard PromptFilter.allows(prompt) else { throw GenError.refused }",
  ).replace("import Foundation", "import Foundation\nenum GenError: Error { case refused }");
  const refusedFilter = (name: string) => `enum PromptFilter {
  static let ${name} = ["lingerie", "nude", "underwear", "bikini"]
  static func allows(_ prompt: String) -> Bool {
    let p = prompt.lowercased()
    return !${name}.contains { p.contains($0) }
  }
}
`;

  it("a refused-terms list used in a membership test is a filter whatever its name", async () => {
    const root = await removedPickerRepo({ "App/Services/ImageGenerator.swift": GENERATOR_ALLOWS, "App/Services/PromptFilter.swift": refusedFilter("refusedTerms") });
    const v = await verifyRemediation(root, SPEC, { baseRef: "HEAD", now: NOW });
    expect(v.residue.filter((r) => r.status === "PRESENT")).toEqual([]);
    expect(v.inputPaths[0]!.blocked).toBe(true);
    expect(v.inputPaths[0]!.evidence.join(" ")).toMatch(/blocklist at App\/Services\/PromptFilter\.swift/);
    expect(v.tier).toBe("STATIC_CLEAN");
    // each skipped list is named so the developer can check it
    expect(v.summary).toMatch(/Lists treated as filters and not counted as residue: refusedTerms \(App\/Services\/PromptFilter\.swift:2; lingerie, underwear, bikini\)/);
  });

  it("a content preset list whose name says 'filter' is residue", async () => {
    const presets = `struct Outfit { let id: String; let title: String; let promptFragment: String }
enum OutfitCatalog {
  static let standard: [Outfit] = [Outfit(id: "casual", title: "Casual", promptFragment: "in a denim jacket")]
  static let styleFilters: [Outfit] = [Outfit(id: "boudoir", title: "Boudoir", promptFragment: "in sheer lingerie on a bed")]
  static func available() -> [Outfit] { standard + styleFilters }
}
`;
    const root = await removedPickerRepo({ "App/Services/ImageGenerator.swift": GENERATOR_ALLOWS, "App/Services/PromptFilter.swift": refusedFilter("blockedTerms"), "App/Models/OutfitCatalog.swift": presets });
    const v = await verifyRemediation(root, SPEC, { baseRef: "HEAD", now: NOW });
    expect(v.residue.some((r) => r.file === "App/Models/OutfitCatalog.swift" && r.line === 4 && FAILING.includes(r.status))).toBe(true);
    expect(v.tier).toBe("RESIDUE_FOUND");
  });

  it("a string list shown in a picker is residue even when named like a filter", async () => {
    const view = `import SwiftUI
struct StylePicker: View {
  static let restrictedStyles = ["lingerie", "bikini"]
  var body: some View {
    ForEach(Self.restrictedStyles, id: \\.self) { Text($0) }
  }
}
`;
    const root = await removedPickerRepo({ "App/Views/StylePicker.swift": view });
    const v = await verifyRemediation(root, SPEC, { baseRef: "HEAD", now: NOW });
    expect(v.residue.some((r) => r.file === "App/Views/StylePicker.swift" && FAILING.includes(r.status))).toBe(true);
    expect(v.tier).toBe("RESIDUE_FOUND");
  });

  it("renaming a filter list is not reported as removed capability", async () => {
    const root = await gitRepo({ ...BASE_FILES, "App/Services/ImageGenerator.swift": GENERATOR_ALLOWS, "App/Services/PromptFilter.swift": refusedFilter("refusedTerms") });
    await rm(path.join(root, "App/Views/LingeriePicker.swift"));
    await write(root, "App/Services/PromptFilter.swift", refusedFilter("blockedPromptTerms"));
    const v = await verifyRemediation(root, SPEC, { baseRef: "HEAD", now: NOW });
    expect(v.removedInDiff.some((l) => l.includes("PromptFilter.swift"))).toBe(false);
    expect(v.removedInDiff.some((l) => l.startsWith("App/Views/LingeriePicker.swift:"))).toBe(true);
  });

  it("deleting a filter list outright is not offered as removed capability either", async () => {
    const root = await gitRepo({ ...BASE_FILES, "App/Services/ImageGenerator.swift": GENERATOR_ALLOWS, "App/Services/PromptFilter.swift": refusedFilter("refusedTerms") });
    await write(root, "App/Services/PromptFilter.swift", `enum PromptFilter {\n  static func allows(_ prompt: String) -> Bool { true }\n}\n`);
    const v = await verifyRemediation(root, SPEC, { baseRef: "HEAD", now: NOW });
    expect(v.removedInDiff.some((l) => l.includes("PromptFilter.swift"))).toBe(false);
  });
});

describe("verifyRemediation removed_in_diff keeps commented-out removals", () => {
  it("a line commented out in place still counts as removed", async () => {
    const root = await gitRepo({ "App/Views/Opts.swift": `let outfits = [\n  "casual",\n  "lingerie",\n]\n` });
    await write(root, "App/Views/Opts.swift", `let outfits = [\n  "casual",\n  // "lingerie",\n]\n`);
    const spec = ResidueSpec.parse({ feature: "x", capability: "c", terms: ["lingerie"] });
    const v = await verifyRemediation(root, spec, { baseRef: "HEAD", now: NOW });
    expect(v.removedInDiff.some((l) => l.startsWith("App/Views/Opts.swift:3"))).toBe(true);
  });
});

describe("verifyRemediation moderation category keys are filters, not residue", () => {
  const MODERATION = `import Foundation
struct ModerationResponse: Decodable {
  struct Result: Decodable { let flagged: Bool; let category_scores: [String: Double] }
  let results: [Result]
}
enum Moderation {
  static func isAllowed(_ text: String) async throws -> Bool {
    var req = URLRequest(url: URL(string: "https://api.openai.com/v1/moderations")!)
    req.httpMethod = "POST"
    req.httpBody = try JSONEncoder().encode(["input": text])
    let (data, _) = try await URLSession.shared.data(for: req)
    let r = try JSONDecoder().decode(ModerationResponse.self, from: data).results[0]
    let flagged = r.flagged
    let scores = r.category_scores
    return !flagged && (scores["sexual"] ?? 1) < 0.2
  }
}
`;
  const GENERATOR_MODERATED = GENERATOR_NO_FILTER.replace(
    "  func generate(prompt: String) async throws {\n",
    "  func generate(prompt: String) async throws {\n    guard try await Moderation.isAllowed(prompt) else { return }\n",
  );
  const spec = ResidueSpec.parse({ ...SPEC, terms: [...SPEC.terms, "sexual"] });

  it("reading scores[\"sexual\"] off a moderation result reaches STATIC_CLEAN and is listed as a filter", async () => {
    const root = await removedPickerRepo({ "App/Services/ImageGenerator.swift": GENERATOR_MODERATED, "App/Safety/Moderation.swift": MODERATION });
    const v = await verifyRemediation(root, spec, { baseRef: "HEAD", now: NOW });
    expect(v.residue.filter((r) => r.needle === "sexual")).toEqual([]);
    expect(v.inputPaths[0]!.blocked).toBe(true);
    expect(v.tier).toBe("STATIC_CLEAN");
    expect(v.summary).toMatch(/Moderation category keys treated as filters and not counted as residue: App\/Safety\/Moderation\.swift:15 \(sexual\)/);
  });

  it("App Review's term used as a moderation key does not cap the tier when the spec leaves it out", async () => {
    const root = await removedPickerRepo({ "App/Services/ImageGenerator.swift": GENERATOR_MODERATED, "App/Safety/Moderation.swift": MODERATION });
    const v = await verifyRemediation(root, SPEC, { baseRef: "HEAD", now: NOW, rejectionText: "Guideline 1.1.4 - Your app generates sexual images of people in lingerie." });
    expect(v.summary).not.toMatch(/leaves out terms/);
    expect(v.tier).toBe("STATIC_CLEAN");
  });

  it("covers result handling split from the request, property reads and Gemini harm categories", async () => {
    const root = await removedPickerRepo({
      "App/Services/ImageGenerator.swift": GENERATOR_MODERATED,
      "App/Safety/Moderation.swift": MODERATION.replace(`return !flagged && (scores["sexual"] ?? 1) < 0.2`, "return ModerationPolicy.allows(r)"),
      "App/Safety/ModerationPolicy.swift": `enum ModerationPolicy {\n  static let thresholds: [String: Double] = ["sexual": 0.2, "hate": 0.4]\n  static func allows(_ r: ModerationResponse.Result) -> Bool {\n    !r.flagged && (r.category_scores["hate"] ?? 1) < (thresholds["hate"] ?? 0)\n  }\n}\n`,
      "server/gemini.ts": `const safetySettings = [{ category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_LOW_AND_ABOVE" }];\nexport const cfg = { safetySettings };\n`,
    });
    const v = await verifyRemediation(root, ResidueSpec.parse({ ...spec, terms: [...spec.terms, "hate"] }), { baseRef: "HEAD", now: NOW });
    expect(v.residue.filter((r) => r.needle === "sexual" || r.needle === "hate")).toEqual([]);
    expect(v.tier).toBe("STATIC_CLEAN");
  });

  it("a content map keyed by the term in a file that also moderates is still residue", async () => {
    const gen = GENERATOR_MODERATED.replace(
      "  func generate(prompt: String) async throws {\n",
      `  let styles: [String: String] = ["sexual": "a sexual pose"]\n  func generate(prompt: String) async throws {\n    let extra = styles["sexual"] ?? ""\n`,
    );
    const root = await removedPickerRepo({ "App/Services/ImageGenerator.swift": gen, "App/Safety/Moderation.swift": MODERATION });
    const v = await verifyRemediation(root, spec, { baseRef: "HEAD", now: NOW });
    expect(v.residue.filter((r) => r.needle === "sexual" && r.file === "App/Services/ImageGenerator.swift").length).toBeGreaterThan(0);
    expect(v.tier).toBe("RESIDUE_FOUND");
  });

  it("deleting a moderation category check is not offered as removed capability", async () => {
    const root = await gitRepo({ ...BASE_FILES, "App/Services/ImageGenerator.swift": GENERATOR_MODERATED, "App/Safety/Moderation.swift": MODERATION });
    await write(root, "App/Safety/Moderation.swift", MODERATION.replace(`return !flagged && (scores["sexual"] ?? 1) < 0.2`, "return !flagged"));
    const v = await verifyRemediation(root, spec, { baseRef: "HEAD", now: NOW });
    expect(v.removedInDiff.some((l) => l.includes("Moderation.swift"))).toBe(false);
  });
});

describe("verifyRemediation backend calls outside the repo", () => {
  const REPORTER = `import Foundation
enum ContentReporter {
  static func report(prompt: String, reason: String) async throws {
    var req = URLRequest(url: URL(string: "https://api.lunacompanion.app/v1/reports")!)
    req.httpMethod = "POST"
    req.httpBody = try JSONEncoder().encode(["prompt": prompt, "reason": reason])
    _ = try await URLSession.shared.data(for: req)
  }
}
`;
  const spec = ResidueSpec.parse({ ...SPEC, inputPaths: [] });

  it("an in-app report endpoint with a field named prompt is not a prompt-building request", async () => {
    const root = await tempProject({ "Sources/Safety/ContentReporter.swift": REPORTER });
    const v = await verifyRemediation(root, spec, { now: NOW });
    expect(v.unverifiable).toEqual([]);
  });

  it("one request built and sent in the same function is listed once", async () => {
    const root = await tempProject({ "Sources/Gen.swift": REPORTER.replace("/v1/reports", "/v1/generate").replace("report(prompt", "generate(prompt") });
    const v = await verifyRemediation(root, spec, { now: NOW });
    expect(v.unverifiable).toHaveLength(1);
    expect(v.unverifiable[0]).toMatch(/^Sources\/Gen\.swift:4 sends a prompt-building request to https:\/\/api\.lunacompanion\.app\/v1\/generate/);
  });
});

describe("tierLabel says why a repo is RESIDUE_FOUND", () => {
  it("names an open input path apart from leftover code", async () => {
    const open = await verifyRemediation(await removedPickerRepo(), SPEC, { baseRef: "HEAD", now: NOW });
    expect(tierLabel(open)).toBe("RESIDUE_FOUND (input path not blocked)");
    const both = await verifyRemediation(await gitRepo(BASE_FILES), SPEC, { now: NOW });
    expect(tierLabel(both)).toBe("RESIDUE_FOUND (residue present; input path not blocked)");
    expect(both.summary).toMatch(/^Evidence tier: RESIDUE_FOUND \(residue present; input path not blocked\)\./);
    expect(tierLabel({ tier: "STATIC_CLEAN", residue: [], inputPaths: [] })).toBe("STATIC_CLEAN");
  });
});

describe("verifyRemediation credits a filter only on the guarded call chain", () => {
  const MODERATOR_AND_REPORTER = `import Foundation

/// Screens prompts and generated output with the OpenAI moderation endpoint before anything is shown.
enum ContentModerator {
    private static let apiKey = Bundle.main.object(forInfoDictionaryKey: "OpenAIAPIKey") as? String ?? ""
    private static let endpoint = URL(string: "https://api.openai.com/v1/moderations")!

    static func isAllowed(text: String) async throws -> Bool {
        try await check(input: [["type": "text", "text": text]])
    }

    static func isAllowed(imageURL: URL) async throws -> Bool {
        try await check(input: [["type": "image_url", "image_url": ["url": imageURL.absoluteString]]])
    }

    private static func check(input: [[String: Any]]) async throws -> Bool {
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("Bearer \\(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["model": "omni-moderation-latest", "input": input])
        let (data, _) = try await URLSession.shared.data(for: request)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let results = json?["results"] as? [[String: Any]] ?? []
        // Fail closed: no result means not allowed.
        guard let first = results.first else { return false }
        if first["flagged"] as? Bool == true { return false }
        let scores = first["category_scores"] as? [String: Double] ?? [:]
        return (scores["sexual"] ?? 1) < 0.2
    }
}

/// Sends a user report about generated content to the support queue.
enum ContentReporter {
    static func report(kind: String, prompt: String) async {
        var request = URLRequest(url: URL(string: "https://lunacompanion.app/api/reports")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["kind": kind, "content": prompt])
        _ = try? await URLSession.shared.data(for: request)
    }
}
`;
  const AVATAR = `import UIKit

/// Turns the user's selfie into a text description that seeds Luna's look-alike avatar.
struct SelfieAvatar {
    private let apiKey = Bundle.main.object(forInfoDictionaryKey: "OpenAIAPIKey") as? String ?? ""

    func describe(selfie: UIImage) async throws -> String {
        guard let jpeg = selfie.jpegData(compressionQuality: 0.8) else { return "" }
        let dataURL = "data:image/jpeg;base64,\\(jpeg.base64EncodedString())"

        var request = URLRequest(url: URL(string: "https://api.openai.com/v1/chat/completions")!)
        request.httpMethod = "POST"
        request.setValue("Bearer \\(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body: [String: Any] = [
            "model": "gpt-4o-mini",
            "messages": [[
                "role": "user",
                "content": [
                    ["type": "text", "text": "Describe this person's hair, eye colour and style in one sentence."],
                    ["type": "image_url", "image_url": ["url": dataURL]],
                ],
            ]],
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, _) = try await URLSession.shared.data(for: request)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let choices = json?["choices"] as? [[String: Any]]
        let message = choices?.first?["message"] as? [String: Any]
        return message?["content"] as? String ?? ""
    }
}
`;
  const SELFIE_VIEW = `import SwiftUI
import PhotosUI
struct SelfieView: View {
    @State private var item: PhotosPickerItem?
    var body: some View {
        PhotosPicker(selection: $item, matching: .images) { Text("Pick a selfie") }
        Button("Report") { Task { await ContentReporter.report(kind: "selfie", prompt: "") } }
        Button("Make avatar") { Task { _ = try? await SelfieAvatar().describe(selfie: UIImage()) } }
    }
}
`;
  const spec = ResidueSpec.parse({ ...SPEC, inputPaths: ["image upload (Sources/Views/SelfieView.swift:6) → AI generation (Sources/AI/SelfieAvatar.swift:11)"] });
  const selfiePath = (v: Awaited<ReturnType<typeof verifyRemediation>>) => v.inputPaths.find((p) => p.inputPath.startsWith("image upload (Sources/Views/SelfieView.swift:6)"))!;

  it("a moderator that shares a file with a reporter the view calls does not guard an unmoderated generator", async () => {
    const one = await tempProject({ "Sources/Safety/ContentModerator.swift": MODERATOR_AND_REPORTER, "Sources/AI/SelfieAvatar.swift": AVATAR, "Sources/Views/SelfieView.swift": SELFIE_VIEW });
    const [modPart, repPart] = MODERATOR_AND_REPORTER.split("/// Sends a user report");
    const split = await tempProject({
      "Sources/Safety/ContentModerator.swift": modPart!,
      "Sources/Safety/ContentReporter.swift": `import Foundation\n/// Sends a user report${repPart!}`,
      "Sources/AI/SelfieAvatar.swift": AVATAR,
      "Sources/Views/SelfieView.swift": SELFIE_VIEW,
    });
    const a = await verifyRemediation(one, spec, { now: NOW });
    const b = await verifyRemediation(split, spec, { now: NOW });
    // File layout must not decide the verdict: neither layout moderates the selfie upload.
    expect(selfiePath(a).blocked).toBe(false);
    expect(selfiePath(b).blocked).toBe(false);
    expect(a.tier).toBe("RESIDUE_FOUND");
    expect(selfiePath(a).evidence.join(" ")).not.toMatch(/guards Sources\/AI\/SelfieAvatar\.swift/);
  });

  it("a generator that calls the moderator's public method is guarded through its private helper", async () => {
    const guarded = AVATAR.replace(
      "        let dataURL",
      "        guard try await ContentModerator.isAllowed(imageURL: URL(fileURLWithPath: \"/tmp/selfie.jpg\")) else { return \"\" }\n        let dataURL",
    );
    const root = await tempProject({ "Sources/Safety/ContentModerator.swift": MODERATOR_AND_REPORTER, "Sources/AI/SelfieAvatar.swift": guarded, "Sources/Views/SelfieView.swift": SELFIE_VIEW });
    const v = await verifyRemediation(root, spec, { now: NOW });
    expect(selfiePath(v).blocked).toBe(true);
    expect(selfiePath(v).evidence.join(" ")).toMatch(/moderation.*ContentModerator\.swift:\d+ \(guards Sources\/AI\/SelfieAvatar\.swift\)/);
  });
});

describe("verifyRemediation scopes a path file's filters to the call into the sink", () => {
  const MODERATOR = `import Foundation
enum Moderator {
    static func isAllowed(text: String) async throws -> Bool {
        var request = URLRequest(url: URL(string: "https://api.openai.com/v1/moderations")!)
        request.httpMethod = "POST"
        request.httpBody = try JSONSerialization.data(withJSONObject: ["model": "omni-moderation-latest", "input": text])
        let (data, _) = try await URLSession.shared.data(for: request)
        return (try JSONSerialization.jsonObject(with: data) as? [String: Any]) != nil
    }
    static func isAllowed(image: UIImage) async throws -> Bool {
        var request = URLRequest(url: URL(string: "https://api.openai.com/v1/moderations")!)
        request.httpMethod = "POST"
        let url = "data:image/jpeg;base64," + (image.jpegData(compressionQuality: 0.8)?.base64EncodedString() ?? "")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["model": "omni-moderation-latest", "input": [["type": "image_url", "image_url": ["url": url]]]])
        let (data, _) = try await URLSession.shared.data(for: request)
        return (try JSONSerialization.jsonObject(with: data) as? [String: Any]) != nil
    }
}
`;
  const AVATAR = `import UIKit
struct SelfieAvatar {
    func describe(selfie: UIImage) async throws -> String {
        var request = URLRequest(url: URL(string: "https://api.openai.com/v1/chat/completions")!)
        request.httpMethod = "POST"
        request.httpBody = try JSONSerialization.data(withJSONObject: ["model": "gpt-4o-mini", "image": "x"])
        let (data, _) = try await URLSession.shared.data(for: request)
        return String(data: data, encoding: .utf8) ?? ""
    }
}
`;
  const chatView = (upload: string, send = "        guard (try? await Moderator.isAllowed(text: draft)) == true else { return }") => `import SwiftUI
import PhotosUI
struct ChatView: View {
    @State private var draft = ""
    @State private var selfieItem: PhotosPickerItem?
    var body: some View {
        PhotosPicker(selection: $selfieItem, matching: .images) { Text("Selfie") }
        Button("Send") { Task { await send() } }
            .onChange(of: selfieItem) { _, item in Task { await uploadSelfie(item) } }
    }

    private func send() async {
${send}
    }

    private func uploadSelfie(_ item: PhotosPickerItem?) async {
        let image = UIImage()
${upload}
        _ = try? await SelfieAvatar().describe(selfie: image)
    }
}
`;
  const spec = ResidueSpec.parse({ ...SPEC, inputPaths: ["image upload (Sources/Views/ChatView.swift:7) → AI generation (Sources/AI/SelfieAvatar.swift:4)"] });
  const selfie = (v: Awaited<ReturnType<typeof verifyRemediation>>) => v.inputPaths.find((p) => p.inputPath.startsWith("image upload (Sources/Views/ChatView.swift:7)"))!;

  it("a moderator the view calls on chat text does not guard the selfie upload in a sibling function", async () => {
    const root = await tempProject({ "Sources/Safety/Moderator.swift": MODERATOR, "Sources/AI/SelfieAvatar.swift": AVATAR, "Sources/Views/ChatView.swift": chatView("") });
    const v = await verifyRemediation(root, spec, { now: NOW });
    expect(selfie(v).blocked).toBe(false);
    expect(selfie(v).evidence.join(" ")).not.toMatch(/guards Sources\/AI\/SelfieAvatar\.swift/);
    expect(selfie(v).evidence.join(" ")).toMatch(/not on its call path.*Moderator\.swift/);
  });

  it("a moderation request written inline in the sibling function does not guard it either", async () => {
    const inline = `        var mod = URLRequest(url: URL(string: "https://api.openai.com/v1/moderations")!)\n        mod.httpBody = try? JSONSerialization.data(withJSONObject: ["model": "omni-moderation-latest", "input": draft])\n        _ = try? await URLSession.shared.data(for: mod)`;
    const root = await tempProject({ "Sources/AI/SelfieAvatar.swift": AVATAR, "Sources/Views/ChatView.swift": chatView("", inline) });
    const v = await verifyRemediation(root, spec, { now: NOW });
    expect(selfie(v).blocked).toBe(false);
  });

  it("moderating the image in the function that calls the generator does guard it", async () => {
    const root = await tempProject({
      "Sources/Safety/Moderator.swift": MODERATOR,
      "Sources/AI/SelfieAvatar.swift": AVATAR,
      "Sources/Views/ChatView.swift": chatView("        guard (try? await Moderator.isAllowed(image: image)) == true else { return }"),
    });
    const v = await verifyRemediation(root, spec, { now: NOW });
    expect(selfie(v).blocked).toBe(true);
    expect(selfie(v).evidence.join(" ")).toMatch(/Moderator\.swift:\d+ \(guards Sources\/AI\/SelfieAvatar\.swift\)/);
  });

  it("a generator held in a stored property is followed to the function that calls it", async () => {
    const view = chatView("        guard (try? await Moderator.isAllowed(image: image)) == true else { return }")
      .replace("    @State private var draft = \"\"", "    @State private var draft = \"\"\n    private let avatar = SelfieAvatar()")
      .replace("SelfieAvatar().describe", "avatar.describe");
    const root = await tempProject({ "Sources/Safety/Moderator.swift": MODERATOR, "Sources/AI/SelfieAvatar.swift": AVATAR, "Sources/Views/ChatView.swift": view });
    const s2 = ResidueSpec.parse({ ...spec, inputPaths: ["image upload (Sources/Views/ChatView.swift:8) → AI generation (Sources/AI/SelfieAvatar.swift:4)"] });
    const v = await verifyRemediation(root, s2, { now: NOW });
    expect(v.inputPaths.find((p) => p.inputPath.startsWith("image upload (Sources/Views/ChatView.swift:8)"))!.blocked).toBe(true);
    const bare = await tempProject({ "Sources/Safety/Moderator.swift": MODERATOR, "Sources/AI/SelfieAvatar.swift": AVATAR, "Sources/Views/ChatView.swift": view.replace(/ {8}guard \(try\? await Moderator\.isAllowed\(image: image\)\) == true else \{ return \}\n/, "") });
    const w = await verifyRemediation(bare, s2, { now: NOW });
    expect(w.inputPaths.find((p) => p.inputPath.startsWith("image upload (Sources/Views/ChatView.swift:8)"))!.blocked).toBe(false);
  });
});

describe("verifyRemediation records review-time conditions the fix removed", () => {
  const companion = path.resolve(__dirname, "../fixtures/swiftui-ai-companion");
  const MSG = "Guideline 1.2 - Your app lets users generate sexually suggestive images of the companion, including lingerie outfits.";
  const spec = ResidueSpec.parse({
    feature: "lingerie outfits",
    capability: "A user can no longer generate images of the companion in lingerie through the picker or free text.",
    terms: ["lingerie"],
    flags: ["spicy_mode"],
    inputPaths: ["free-text prompt (Sources/Views/CompanionStudioView.swift:38) → AI generation (Sources/AI/ImageGenerator.swift:10)"],
  });

  async function fixedCompanion(opts: { dropGate: boolean }) {
    const root = await tempProject({});
    await cp(companion, root, { recursive: true });
    await run("git", ["init", "-q", "-b", "main"], { cwd: root });
    await commit(root, "base");
    const rel = "Sources/Views/CompanionStudioView.swift";
    let t = await readFile(path.join(root, rel), "utf8");
    t = t.replace(/\s*if RemoteConfig\.remoteConfig\(\)\["spicy_mode"\]\.boolValue \{[\s\S]*?\n {8}\}/, "").replace("var outfits = standard", "let outfits = standard");
    if (opts.dropGate) t = t.replace(/\n {16}if !AppEnvironment\.isTestFlight \{\n([\s\S]*?)\n {16}\}\n/, "\n$1\n");
    await writeFile(path.join(root, rel), t);
    return root;
  }

  it("the removed TestFlight gate becomes a removed_condition fact and lint flags notes that leave it out", async () => {
    const root = await fixedCompanion({ dropGate: true });
    const v = await verifyRemediation(root, spec, { baseRef: "HEAD", now: NOW, rejectionText: MSG, ledgerEvents: [] });
    const gate = v.removedConditions?.find((c) => c.condition.includes("AppEnvironment.isTestFlight"));
    expect(gate).toMatchObject({ rule: "review_gating.environment", file: "Sources/Views/CompanionStudioView.swift", line: 41, condition: "!AppEnvironment.isTestFlight" });
    expect(gate?.gates).toMatch(/outfit/);
    // the remote flag the fix also removed is a review-time condition too
    expect(v.removedConditions?.some((c) => c.rule === "remote_config.content_gating" && c.condition.includes("spicy_mode"))).toBe(true);
    expect(v.summary).toMatch(/removed 2 review-time conditions that changed what App Review saw: .*!AppEnvironment\.isTestFlight at Sources\/Views\/CompanionStudioView\.swift:41/);

    const { foldEvents } = await import("../../src/ledger/store.js");
    const { evidencePack } = await import("../../src/ledger/evidence.js");
    const { lintText } = await import("../../src/ledger/lint.js");
    const state = foldEvents("T", [
      LedgerEvent.parse({ id: "ev_r", type: "outcome", at: "2026-10-01T00:00:00.000Z", source: "import", outcome: "rejected", guidelines: ["1.2"], reviewerMessage: MSG }),
      LedgerEvent.parse({ id: "ev_v", type: "verification", at: NOW, source: "agent", rejectionId: "ev_r", verification: v }),
    ]);
    const facts = evidencePack(state, "review_notes", { rejectionId: "ev_r", now: NOW }).facts.filter((f) => f.kind === "removed_condition");
    expect(facts.some((f) => f.text.includes("AppEnvironment.isTestFlight"))).toBe(true);
    const silent = "Changes in 1.3: removed the lingerie outfit and the spicy_mode flag from the companion studio.\n\nHow to test: open Studio, enter a prompt and tap Create photo.";
    const issue = lintText({ purpose: "review_notes", text: silent, state }).issues.find((i) => i.rule === "removed_condition_unmentioned" && i.excerpt.includes("isTestFlight"));
    expect(issue).toBeDefined();
    const disclosed = `${silent}\n\nEarlier builds hid the Outfit section on TestFlight and App Review installs (AppEnvironment.isTestFlight); that condition is removed in this build.`;
    expect(lintText({ purpose: "review_notes", text: disclosed, state }).issues.some((i) => i.rule === "removed_condition_unmentioned" && i.excerpt.includes("isTestFlight"))).toBe(false);
  });

  it("a gate that is still in the code is not reported as removed", async () => {
    const root = await fixedCompanion({ dropGate: false });
    const v = await verifyRemediation(root, spec, { baseRef: "HEAD", now: NOW, rejectionText: MSG, ledgerEvents: [] });
    expect(v.removedConditions?.some((c) => c.condition.includes("isTestFlight")) ?? false).toBe(false);
    expect(v.removedConditions?.map((c) => c.rule)).toEqual(["remote_config.content_gating"]);
  });

  it("without base_ref nothing is claimed removed", async () => {
    const root = await fixedCompanion({ dropGate: true });
    const v = await verifyRemediation(root, spec, { now: NOW, rejectionText: MSG, ledgerEvents: [] });
    expect(v.removedConditions).toBeUndefined();
  });
});

describe("verifyRemediation summary wording", () => {
  it("store metadata files in the repo are reported as swept; only what lives in App Store Connect needs a look", async () => {
    const root = await tempProject({
      "fastlane/metadata/en-US/description.txt": "Chat with Luna and create photos together.\n",
      "Sources/App.swift": "import SwiftUI\n",
    });
    const spec = ResidueSpec.parse({ ...SPEC, inputPaths: [], metadataSurfaces: ["fastlane/metadata/en-US/description.txt", "App Store Connect screenshots (6.7-inch)"] });
    const v = await verifyRemediation(root, spec, { now: NOW });
    expect(v.summary).toMatch(/Store metadata files in the repo were swept with the code: fastlane\/metadata\/en-US\/description\.txt\./);
    expect(v.summary).toMatch(/Confirm the live App Store Connect copy, screenshots and previews match the repo metadata; these surfaces are not in the repo and were not checked: App Store Connect screenshots \(6\.7-inch\)\./);
    expect(v.summary).not.toMatch(/outside the repo were not checked and need a manual look: fastlane/);
    expect(v.summary).toMatch(/in-repo server code or the store metadata in the repo\./);
    // residue in a listed repo surface is still found
    await writeFile(path.join(root, "fastlane/metadata/en-US/description.txt"), "Dress Luna in lingerie.\n");
    const dirty = await verifyRemediation(root, spec, { now: NOW });
    expect(dirty.residue.some((r) => r.kind === "metadata" && r.file === "fastlane/metadata/en-US/description.txt")).toBe(true);
  });

  it("a repo without store metadata does not claim to have swept it", async () => {
    const root = await tempProject({ "Sources/App.swift": "import SwiftUI\n" });
    const v = await verifyRemediation(root, ResidueSpec.parse({ ...SPEC, inputPaths: [] }), { now: NOW });
    expect(v.summary).toMatch(/in-repo server code\./);
    expect(v.summary).not.toMatch(/store metadata/);
  });
});

describe("verifyRemediation: a rejection with nothing to ground against stays on HOLD", () => {
  const rejection = (msg?: string) =>
    LedgerEvent.parse({ id: "ev_r1", type: "outcome", outcome: "rejected", guidelines: ["1.2"], ...(msg === undefined ? {} : { reviewerMessage: msg }), at: "2020-01-01T00:00:00.000Z", source: "import" });

  async function cleanedRepo() {
    const root = await gitRepo({ "src/t.ts": `export const zzqq = 1;\nexport const keep = 2;\n` });
    await write(root, "src/t.ts", `export const keep = 2;\n`);
    return root;
  }
  const bogus = ResidueSpec.parse({ feature: "zzqq", capability: "zzqq", terms: ["zzqq"] });

  it("no reviewer message recorded: an arbitrary removed entry does not clear the rejection", async () => {
    const root = await cleanedRepo();
    const v = await verifyRemediation(root, bogus, { now: NOW, baseRef: "HEAD", rejectionId: "ev_r1", ledgerEvents: [rejection()] });
    expect(v.tier).toBe("UNVERIFIABLE");
    expect(v.summary).toMatch(/not grounded in the rejection: App Review's message for it is not recorded in the ledger.*stays on HOLD.*appstore-shield ack/);
  });

  it("a message that names nothing searchable is not grounding either", async () => {
    const root = await cleanedRepo();
    const v = await verifyRemediation(root, bogus, { now: NOW, baseRef: "HEAD", rejectionText: "1.2", ledgerEvents: [] });
    expect(v.tier).toBe("UNVERIFIABLE");
    expect(v.summary).toMatch(/not grounded in the rejection: App Review's message for it names nothing find_surface can search/);
  });

  it("with no rejection to answer to, nothing is said about grounding", async () => {
    const root = await cleanedRepo();
    const v = await verifyRemediation(root, bogus, { now: NOW, baseRef: "HEAD", ledgerEvents: [] });
    expect(v.summary).not.toMatch(/grounded/);
  });
});

describe("verifyRemediation evidence for a path that names no generation call", () => {
  const MODERATOR = `import Foundation
final class ContentModerator {
    static let shared = ContentModerator()
    func isAllowed(text: String) async throws -> Bool {
        try await moderate(input: [["type": "text", "text": text]])
    }
    private func moderate(input: [[String: Any]]) async throws -> Bool {
        var request = URLRequest(url: URL(string: "https://api.openai.com/v1/moderations")!)
        request.httpMethod = "POST"
        request.httpBody = try JSONSerialization.data(withJSONObject: ["model": "text-moderation-latest", "input": input])
        let (data, _) = try await URLSession.shared.data(for: request)
        return (try JSONSerialization.jsonObject(with: data) as? [String: Any]) != nil
    }
}
`;
  const GENERATOR = `import UIKit
struct ImageGenerator {
    func generate(prompt: String) async throws -> Data {
        guard try await ContentModerator.shared.isAllowed(text: prompt) else { return Data() }
        var request = URLRequest(url: URL(string: "https://api.replicate.com/v1/predictions")!)
        request.httpMethod = "POST"
        request.httpBody = try JSONSerialization.data(withJSONObject: ["input": ["prompt": prompt]])
        let (data, _) = try await URLSession.shared.data(for: request)
        return data
    }
}
`;
  const chat = (threshold: string) => `import Foundation
struct CompanionChat {
    private let endpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent"
    func reply(to text: String) async throws -> Data {
        var request = URLRequest(url: URL(string: endpoint)!)
        request.httpMethod = "POST"
        let body: [String: Any] = [
            "contents": [["role": "user", "parts": [["text": text]]]],
            "safetySettings": [
                ["category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "${threshold}"],
                ["category": "HARM_CATEGORY_HARASSMENT", "threshold": "${threshold}"],
                ["category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "${threshold}"],
            ],
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, _) = try await URLSession.shared.data(for: request)
        return data
    }
}
`;
  const STUDIO = `import SwiftUI
struct StudioView: View {
    @State private var outfit = "casual"
    private let generator = ImageGenerator()
    var body: some View {
        Picker("Outfit", selection: $outfit) { Text("Casual").tag("casual") }
        Button("Generate") { Task { await render() } }
    }
    private func render() async {
        guard (try? await ContentModerator.shared.isAllowed(text: outfit)) == true else { return }
        _ = try? await generator.generate(prompt: "portrait wearing " + outfit)
    }
}
`;
  const files = (threshold = "BLOCK_LOW_AND_ABOVE") => ({
    "Sources/Safety/ContentModerator.swift": MODERATOR,
    "Sources/AI/ImageGenerator.swift": GENERATOR,
    "Sources/AI/CompanionChat.swift": chat(threshold),
    "Sources/Views/StudioView.swift": STUDIO,
  });
  const UNNAMED = "outfit picker (Sources/Views/StudioView.swift:6) -> ImageGenerator";
  const NAMED = "outfit picker (Sources/Views/StudioView.swift:6) -> ImageGenerator (Sources/AI/ImageGenerator.swift:5)";
  const spec = ResidueSpec.parse({ ...SPEC, inputPaths: [UNNAMED, NAMED] });
  const byName = (v: Awaited<ReturnType<typeof verifyRemediation>>, n: string) => v.inputPaths.find((p) => p.inputPath === n)!;

  it("groups each generation call's filters under that call, so no other call's setting reads as the picker's filter", async () => {
    const root = await tempProject(files());
    const v = await verifyRemediation(root, spec, { now: NOW });
    const p = byName(v, UNNAMED);
    expect(p.blocked).toBe(true);
    expect(p.evidence[0]).toMatch(/names no generation call, so all 2 generation calls in the repo had to be guarded; each filter below guards only the call named after it/);
    const tagged = p.evidence.filter((e) => /\(guards [^)]+\)$/.test(e));
    expect(tagged).toHaveLength(2);
    for (const e of tagged) {
      const sink = /\(guards ([^)]+)\)$/.exec(e)![1]!;
      // a Gemini setting is listed only under the Gemini call, a moderation call only under the call that makes it
      if (/Gemini/.test(e)) expect(sink).toBe("Sources/AI/CompanionChat.swift");
      if (/moderation/.test(e)) expect(sink).toBe("Sources/AI/ImageGenerator.swift");
    }
    // one setting written for three harm categories is one filter
    expect(p.evidence.join(" ").match(/safety setting at/g)).toHaveLength(1);
  });

  it("a call site and the moderator it calls into are one filter, not three", async () => {
    const root = await tempProject(files());
    const v = await verifyRemediation(root, spec, { now: NOW });
    const p = byName(v, NAMED);
    expect(p.blocked).toBe(true);
    const text = p.evidence.join("\n");
    expect(text).not.toMatch(/ContentModerator\.swift:\d+/);
    expect(text).toMatch(/\(ContentModerator\) at Sources\/AI\/ImageGenerator\.swift:4 \(guards Sources\/AI\/ImageGenerator\.swift\)/);
  });

  it("the picker's own moderation is not lent to a generation call the picker never names", async () => {
    // The chat call has no filter of its own; the view moderates only before calling the image generator.
    const root = await tempProject(files("BLOCK_NONE_DISABLED_NOT_A_SETTING"));
    // cited at the generate call, inside the function that moderates
    const atCall = "outfit picker (Sources/Views/StudioView.swift:11) -> ImageGenerator";
    const v = await verifyRemediation(root, ResidueSpec.parse({ ...SPEC, inputPaths: [atCall, NAMED] }), { now: NOW });
    const p = byName(v, atCall);
    expect(p.blocked).toBe(false);
    expect(p.evidence.join(" ")).toMatch(/generation call in Sources\/AI\/CompanionChat\.swift .*has no filter of its own/);
    expect(byName(v, NAMED).blocked).toBe(true);
  });

  it("save_spec warns when an input path names no generation call by file:line", async () => {
    const root = await tempProject(files());
    const ctx = await (await import("../../src/project.js")).loadContext(root);
    const { validateSpec } = await import("../../src/remediation/surface.js");
    const w = (await validateSpec(ctx, spec)).warnings;
    expect(w.filter((x) => /names no generation call by file:line/.test(x))).toHaveLength(1);
    expect(w.join(" ")).toMatch(/input path "outfit picker \(Sources\/Views\/StudioView\.swift:6\) -> ImageGenerator" names no generation call by file:line, so verify requires a filter on all 2 of them/);
  });
});

describe("verifyRemediation counts a moderation helper in the generator's file only when the call path reaches it", () => {
  const generator = (generateBody: string) => `import UIKit
struct ImageGenerator {
    func generate(prompt: String) async throws -> Data {
${generateBody}
        return try await send(prompt)
    }
    private func send(_ prompt: String) async throws -> Data {
        var request = URLRequest(url: URL(string: "https://api.replicate.com/v1/predictions")!)
        request.httpMethod = "POST"
        request.httpBody = try JSONSerialization.data(withJSONObject: ["input": ["prompt": prompt]])
        let (data, _) = try await URLSession.shared.data(for: request)
        return data
    }
    private func screen(_ text: String) async throws {
        var mod = URLRequest(url: URL(string: "https://api.openai.com/v1/moderations")!)
        mod.httpMethod = "POST"
        _ = try await URLSession.shared.data(for: mod)
    }
}
`;
  const VIEW = `import SwiftUI
struct StudioView: View {
    @State private var prompt = ""
    var body: some View {
        TextField("Describe", text: $prompt)
        Button("Go") { Task { _ = try? await ImageGenerator().generate(prompt: prompt) } }
    }
}
`;
  const spec = ResidueSpec.parse({ ...SPEC, inputPaths: ["free-text prompt (Sources/Views/StudioView.swift:5) -> AI generation (Sources/AI/ImageGenerator.swift:9)"] });

  it("a helper defined next to the generation call but never called does not guard it", async () => {
    const root = await tempProject({ "Sources/AI/ImageGenerator.swift": generator(""), "Sources/Views/StudioView.swift": VIEW });
    const v = await verifyRemediation(root, spec, { now: NOW });
    expect(v.inputPaths[0]!.blocked).toBe(false);
    expect(v.inputPaths[0]!.evidence.join(" ")).toMatch(/not on its call path.*ImageGenerator\.swift:15/);
  });

  it("the same helper does guard it once the function that leads to the request calls it", async () => {
    const root = await tempProject({ "Sources/AI/ImageGenerator.swift": generator("        try await screen(prompt)"), "Sources/Views/StudioView.swift": VIEW });
    const v = await verifyRemediation(root, spec, { now: NOW });
    expect(v.inputPaths[0]!.blocked).toBe(true);
    expect(v.inputPaths[0]!.evidence.join(" ")).toMatch(/moderations\) at Sources\/AI\/ImageGenerator\.swift:15 \(guards Sources\/AI\/ImageGenerator\.swift\)/);
  });
});

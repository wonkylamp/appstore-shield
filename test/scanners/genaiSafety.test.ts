import { describe, expect, it } from "vitest";
import type { Finding } from "../../src/finding.js";
import { check } from "../../src/scanners/genaiSafety.js";
import { ctxFromFiles } from "../helpers.js";

async function run(files: Record<string, string>) {
  const res = await check.run(await ctxFromFiles(files));
  const surface = (res.data?.surface ?? {}) as { providers: { id: string }[]; sources: { kind: string }[]; sinks: { kind: string }[]; prompts: { kind: string }[]; moderation: { kind: string }[] };
  return { findings: res.findings, surface };
}

const rules = (fs: Finding[]) => fs.map((f) => f.rule);

describe("genai_safety provider detection", () => {
  const cases: [string, string, string, string][] = [
    ["openai", "src/ai.ts", `import OpenAI from "openai";\nconst c = new OpenAI();\nawait c.chat.completions.create({ model: "gpt-4o", messages });`, `const s = "openai is cool";\nimport { open } from "fs";`],
    ["openai", "App/Chat.swift", `import OpenAI\nlet openAI = OpenAI(apiToken: token)\nlet r = try await openAI.chats(query: q)`, `import OpenAPIRuntime\nlet x = 1`],
    ["anthropic", "src/ai.ts", `import Anthropic from "@anthropic-ai/sdk";\nawait new Anthropic().messages.create({ model, messages });`, `import { anthropometry } from "./body";`],
    ["gemini", "App/Gen.swift", `import FirebaseAI\nlet model = FirebaseAI.firebaseAI(backend: .googleAI()).generativeModel(modelName: "gemini-2.5-flash")\nlet r = try await model.generateContent(prompt)`, `import FirebaseFirestore\nlet db = Firestore.firestore()`],
    ["gemini", "src/gen.ts", `import { GoogleGenAI } from "@google/genai";\nconst ai = new GoogleGenAI({});`, `import { google } from "googleapis";`],
    ["gemini", "src/vertex.ts", `import { getAI, getGenerativeModel } from "firebase/ai";`, `import { getFirestore } from "firebase/firestore";`],
    ["replicate", "server/gen.ts", `import Replicate from "replicate";\nawait replicate.run("black-forest-labs/flux-schnell", { input });`, `import { replicate } from "./utils/array";`],
    ["fal", "src/fal.ts", `import { fal } from "@fal-ai/client";\nawait fal.subscribe("fal-ai/flux/dev", { input });`, `const falafel = "fal";`],
    ["stability", "src/s.ts", `await fetch("https://api.stability.ai/v2beta/stable-image/generate/core", opts);`, `const stability = "high";`],
    ["together", "src/t.ts", `await fetch("https://api.together.xyz/v1/chat/completions", opts);`, `const together = true;`],
    ["openrouter", "src/o.ts", `const BASE = "https://openrouter.ai/api/v1/chat/completions";`, `const BASE = "https://openroute.example.com/api";`],
    ["groq", "src/g.ts", `import Groq from "groq-sdk";`, `const grok = 1;`],
    ["xai", "src/x.ts", `const url = "https://api.x.ai/v1/chat/completions";`, `const url = "https://api.xaix.example.com/v1";`],
    ["bfl", "src/b.ts", `const url = "https://api.bfl.ai/v1/flux-pro-1.1";`, `const url = "https://api.bflx.dev/v1";`],
    ["huggingface", "src/h.ts", `import { InferenceClient } from "@huggingface/inference";`, `const docs = "https://huggingface.co/docs";`],
    ["runway", "src/r.ts", `import RunwayML from "@runwayml/sdk";`, `const runway = "airport";`],
    ["leonardo", "src/l.ts", `const u = "https://cloud.leonardo.ai/api/rest/v1/generations";`, `const painter = "leonardo da vinci";`],
    ["elevenlabs", "src/e.ts", `import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";`, `const elevenLabels = 11;`],
    ["coreml", "App/Classifier.swift", `import CoreML\nlet m = try MLModel(contentsOf: url)`, `import CoreData\nlet m = NSManagedObjectModel()`],
    ["mlx", "App/Local.swift", `import MLXLLM\nlet c = try await LLMModelFactory.shared.loadContainer(configuration: cfg)`, `import MLXSomethingElse`],
    ["llamacpp", "App/Llama.swift", `import llama\nlet ctx = llama_init_from_model(model, params)`, `import Llamas`],
    ["foundationmodels", "App/Assist.swift", `import FoundationModels\nlet session = LanguageModelSession()\nlet r = try await session.respond(to: prompt)`, `import Foundation\nlet s = URLSession.shared`],
    ["bedrock", "server/b.ts", `import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";`, `import { S3Client } from "@aws-sdk/client-s3";`],
    ["mistral", "server/m.ts", `const u = "https://api.mistral.ai/v1/chat/completions";`, `const wind = "mistral";`],
    ["deepseek", "server/d.ts", `const u = "https://api.deepseek.com/chat/completions";`, `const deepSeek = () => 1;`],
    ["cloudflare-ai", "worker/src/index.ts", `const r = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", { prompt });`, `const r = await env.DB.prepare("select 1").run();`],
    ["imageplayground", "App/Play.swift", `import ImagePlayground\n.imagePlaygroundSheet(isPresented: $show, concept: c)`, `import PlaygroundSupport`],
  ];
  it.each(cases)("detects %s (and not its look-alike)", async (id, file, pos, neg) => {
    const p = await run({ [file]: pos });
    expect(p.surface.providers.map((x) => x.id)).toContain(id);
    const n = await run({ [file]: neg });
    expect(n.surface.providers.map((x) => x.id)).not.toContain(id);
  });

  it("detects Core ML models referenced from the Xcode project", async () => {
    const { surface } = await run({ "App.xcodeproj/project.pbxproj": `/* Begin PBXFileReference section */\n A1 /* NSFWDetector.mlmodel */ = {isa = PBXFileReference; path = NSFWDetector.mlmodel; };` });
    expect(surface.providers.map((x) => x.id)).toContain("coreml");
  });
});

describe("genai_safety explicit safety disabled", () => {
  const blocked = async (files: Record<string, string>) => (await run(files)).findings.filter((f) => f.rule === "genai.safety_disabled");

  it("blocks Gemini BLOCK_NONE (JS) and is not suppressible", async () => {
    const fs = await blocked({ "src/g.ts": `import { HarmBlockThreshold, HarmCategory } from "@google/generative-ai";\nconst safetySettings = [{ category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE }];` });
    expect(fs).toHaveLength(1);
    expect(fs[0]!.severity).toBe("block");
    expect(fs[0]!.suppressible).toBe(false);
    expect(fs[0]!.line).toBe(2);
  });

  it("blocks Gemini .blockNone / .off (Swift, Firebase AI Logic)", async () => {
    const fs = await blocked({ "App/G.swift": `import FirebaseAI\nlet s = [SafetySetting(harmCategory: .harassment, threshold: .blockNone), SafetySetting(harmCategory: .sexuallyExplicit, threshold: .off)]` });
    expect(fs.length).toBeGreaterThanOrEqual(1);
  });

  it("blocks threshold \"OFF\" as a string", async () => {
    const fs = await blocked({ "server/g.ts": `const safetySettings = [{ category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" }];` });
    expect(fs).toHaveLength(1);
  });

  it("does NOT block BLOCK_MEDIUM_AND_ABOVE, and counts it as moderation", async () => {
    const { findings, surface } = await run({ "src/g.ts": `import { GoogleGenerativeAI, HarmBlockThreshold } from "@google/generative-ai";\nconst m = genAI.getGenerativeModel({ model: "gemini-2.5-flash", safetySettings: [{ category, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE }] });\nawait m.generateContent(prompt);` });
    expect(rules(findings)).not.toContain("genai.safety_disabled");
    expect(rules(findings)).not.toContain("genai.no_moderation");
    expect(surface.moderation.length).toBeGreaterThan(0);
  });

  it("blocks Replicate disable_safety_checker: true, not false", async () => {
    expect(await blocked({ "server/r.ts": `await replicate.run(model, { input: { prompt, disable_safety_checker: true } });` })).toHaveLength(1);
    expect(await blocked({ "server/r.ts": `await replicate.run(model, { input: { prompt, disable_safety_checker: false } });` })).toHaveLength(0);
  });

  it("blocks fal enable_safety_checker: false, not true", async () => {
    expect(await blocked({ "src/f.ts": `await fal.subscribe("fal-ai/flux/dev", { input: { prompt, enable_safety_checker: false } });` })).toHaveLength(1);
    expect(await blocked({ "src/f.ts": `await fal.subscribe("fal-ai/flux/dev", { input: { prompt, enable_safety_checker: true } });` })).toHaveLength(0);
  });

  it("blocks BFL safety_tolerance >= 5, not 2", async () => {
    expect(await blocked({ "src/b.ts": `body: JSON.stringify({ prompt, safety_tolerance: 6 })` })).toHaveLength(1);
    expect(await blocked({ "src/b.ts": `body: JSON.stringify({ prompt, safety_tolerance: 5 })` })).toHaveLength(1);
    expect(await blocked({ "src/b.ts": `body: JSON.stringify({ prompt, safety_tolerance: 2 })` })).toHaveLength(0);
  });

  it("blocks Stable Diffusion disableSafety: true, not false", async () => {
    expect(await blocked({ "App/SD.swift": `import StableDiffusion\nlet p = try StableDiffusionPipeline(resourcesAt: url, controlNet: [], configuration: c, disableSafety: true)` })).toHaveLength(1);
    expect(await blocked({ "App/SD.swift": `import StableDiffusion\nlet p = try StableDiffusionPipeline(resourcesAt: url, controlNet: [], configuration: c, disableSafety: false)` })).toHaveLength(0);
  });

  it("downgrades a debug-only override to suppressible medium", async () => {
    const { findings } = await run({ "App/G.swift": `import FirebaseAI\n#if DEBUG\nlet s = SafetySetting(harmCategory: .harassment, threshold: .blockNone)\n#endif` });
    const f = findings.find((x) => x.rule === "genai.safety_disabled_debug");
    expect(f?.severity).toBe("medium");
    expect(rules(findings)).not.toContain("genai.safety_disabled");
  });

  it("ignores overrides that only appear in comments", async () => {
    expect(await blocked({ "src/g.ts": `import { GoogleGenAI } from "@google/genai";\n// threshold: HarmBlockThreshold.BLOCK_NONE was removed` })).toHaveLength(0);
  });
});

describe("genai_safety unsafe models", () => {
  it("blocks uncensored / nsfw model and LoRA ids", async () => {
    const { findings } = await run({
      "server/gen.ts": `import Replicate from "replicate";\nawait replicate.run("someone/sdxl-nsfw-lora:abc123", { input });\nconst model = "dolphin-2.9-llama3-uncensored";`,
    });
    const fs = findings.filter((f) => f.rule === "genai.unsafe_model");
    expect(fs).toHaveLength(2);
    expect(fs.every((f) => f.severity === "block" && !f.suppressible)).toBe(true);
  });

  it("blocks an abliterated gguf bundled for llama.cpp", async () => {
    const { findings } = await run({ "App/Llama.swift": `import llama\nlet path = Bundle.main.path(forResource: "Llama-3.2-3B-Instruct-abliterated.Q4_K_M.gguf", ofType: nil)` });
    expect(rules(findings)).toContain("genai.unsafe_model");
  });

  it("does not flag NSFW classifiers, prose, or subreddit paths", async () => {
    const { findings } = await run({
      "server/gen.ts": `import Replicate from "replicate";\nconst classifier = "Falconsai/nsfw_image_detection";\nconst msg = "nsfw content is not allowed";\nconst sub = "r/nsfw";\nconst label = "uncensored";`,
    });
    expect(rules(findings)).not.toContain("genai.unsafe_model");
  });
});

const photoEditApp = (prompt: string, extra = "") => ({
  "App/Editor.swift": `import SwiftUI\nimport PhotosUI\nimport OpenAI\nstruct Editor: View {\n  @State var item: PhotosPickerItem?\n  var body: some View { PhotosPicker("Pick", selection: $item) }\n  func run(_ data: Data) async throws {\n    let q = ImageEditsQuery(images: [data], prompt: "${prompt}")\n    _ = try await openAI.imageEdits(query: q)\n  }\n}\n${extra}`,
});

describe("genai_safety nudification and likeness", () => {
  it("blocks clothing removal on user photos", async () => {
    const { findings } = await run(photoEditApp("Remove her clothes and make the photo realistic"));
    const f = findings.find((x) => x.rule === "genai.nudification");
    expect(f?.severity).toBe("block");
    expect(f?.suppressible).toBe(false);
    expect(f?.fix).toMatch(/^Remove/);
  });

  it("blocks an 'Undress AI' preset next to an image generator", async () => {
    const { findings } = await run({ "src/presets.ts": `import { fal } from "@fal-ai/client";\nexport const presets = [{ title: "Undress AI", model: "fal-ai/flux/dev" }];\nawait fal.subscribe("fal-ai/flux/dev", { input });` });
    expect(rules(findings)).toContain("genai.nudification");
  });

  it("blocks swapping clothing for lingerie on user photos", async () => {
    const { findings } = await run(photoEditApp("Change her outfit to lingerie"));
    expect(rules(findings)).toContain("genai.nudification");
  });

  it("does not block a benign AI photo editor", async () => {
    const { findings } = await run(
      photoEditApp("Remove the background", `let presets = ["Change the outfit to a red dress", "Make lips a nude shade", "Nude lipstick look", "Remove clothing items from the wardrobe list"]`),
    );
    expect(rules(findings)).not.toContain("genai.nudification");
  });

  it("does not block a classic photo-filter app with no AI", async () => {
    const { findings } = await run({
      "App/Filters.swift": `import SwiftUI\nimport PhotosUI\nimport CoreImage.CIFilterBuiltins\nlet filters = ["Noir", "Nude Glow", "X-ray filter", "See-through glass"]\nlet f = CIFilter.photoEffectNoir()\nstruct P: View { var body: some View { PhotosPicker("Pick", selection: $item) } }`,
    });
    expect(findings.filter((f) => f.severity === "block")).toHaveLength(0);
  });

  it("does not block blocklists or prohibitions that name the terms", async () => {
    const { findings } = await run(
      photoEditApp(
        "Restyle the photo as a watercolor",
        `let bannedWords = ["undress", "nude photo", "remove her clothes", "celebrity"]\nlet system = "Never undress or remove clothing from people in photos."\nfunc isSafe(_ p: String) -> Bool { !p.localizedCaseInsensitiveContains("undress") }`,
      ),
    );
    expect(findings.filter((f) => f.severity === "block")).toHaveLength(0);
  });

  it("blocks face-swap SDKs and models", async () => {
    const { findings } = await run({ "src/swap.ts": `import { fal } from "@fal-ai/client";\nawait fal.subscribe("fal-ai/face-swap", { input: { base_image_url, swap_image_url } });` });
    expect(rules(findings)).toContain("genai.face_swap");
    const sdk = await run({ "server/swap.ts": `const MODEL = "inswapper_128.onnx";` });
    expect(rules(sdk.findings)).toContain("genai.face_swap");
  });

  it("does not flag face-swap words in a non-AI app", async () => {
    const { findings } = await run({ "src/game.ts": `const tip = "Swap tiles to match faces";` });
    expect(rules(findings)).not.toContain("genai.face_swap");
  });

  it("blocks celebrity-likeness prompts but not refusals", async () => {
    const pos = await run(photoEditApp("Generate a photo of me with a celebrity"));
    expect(rules(pos.findings)).toContain("genai.celebrity_likeness");
    const neg = await run(photoEditApp("Do not generate images of celebrities or real people"));
    expect(rules(neg.findings)).not.toContain("genai.celebrity_likeness");
  });
});

describe("genai_safety moderation coverage", () => {
  it("flags a text generator with no moderation anywhere", async () => {
    const { findings } = await run({ "src/chat.ts": `import OpenAI from "openai";\nexport async function ask(p) { return client.chat.completions.create({ model: "gpt-4o", messages: [{ role: "system", content: "You are Mia" }, { role: "user", content: p }] }); }` });
    const f = findings.find((x) => x.rule === "genai.no_moderation");
    expect(f?.severity).toBe("high");
    expect(f?.file).toBe("src/chat.ts");
  });

  it("accepts the moderation endpoint for a text generator", async () => {
    const { findings } = await run({ "src/chat.ts": `import OpenAI from "openai";\nconst mod = await client.moderations.create({ model: "omni-moderation-latest", input: p });\nawait client.chat.completions.create({ model, messages });` });
    expect(rules(findings)).not.toContain("genai.no_moderation");
  });

  it("accepts an in-repo server-side blocklist", async () => {
    const { findings } = await run({ "server/chat.ts": `import Anthropic from "@anthropic-ai/sdk";\nconst BANNED_TERMS = loadTerms();\nexport function checkPromptSafety(p) { return !BANNED_TERMS.some((t) => p.includes(t)); }\nawait anthropic.messages.create({ model, messages });` });
    expect(rules(findings)).not.toContain("genai.no_moderation");
  });

  it("does not count prose that mentions moderation", async () => {
    const { findings } = await run({ "src/chat.ts": `import OpenAI from "openai";\nconst hint = "Use moderation in all things";\nawait client.chat.completions.create({ model, messages });` });
    expect(rules(findings)).toContain("genai.no_moderation");
  });

  it("flags an image generator that only moderates the prompt", async () => {
    const { findings } = await run({ "src/img.ts": `import OpenAI from "openai";\nconst m = await client.moderations.create({ model: "text-moderation-latest", input: prompt });\nconst img = await client.images.generate({ model: "gpt-image-1", prompt });` });
    expect(rules(findings)).toContain("genai.input_only_moderation");
    expect(rules(findings)).not.toContain("genai.no_moderation");
  });

  it("accepts output image classification for an image generator", async () => {
    const { findings } = await run({
      "App/Gen.swift": `import OpenAI\nimport SensitiveContentAnalysis\nlet q = ImagesQuery(prompt: prompt, model: .gpt_image_1)\nlet r = try await openAI.images(query: q)\nlet analyzer = SCSensitivityAnalyzer()\nlet m = try await openAI.moderations(query: ModerationsQuery(input: prompt))`,
    });
    expect(rules(findings)).not.toContain("genai.input_only_moderation");
    expect(rules(findings)).not.toContain("genai.no_moderation");
  });

  it("treats Apple Foundation Models guardrails as moderation", async () => {
    const { findings } = await run({ "App/Assist.swift": `import FoundationModels\nlet session = LanguageModelSession(instructions: "Summarize notes")\nlet r = try await session.respond(to: text)` });
    expect(rules(findings)).not.toContain("genai.no_moderation");
  });

  it("does not require moderation for transcription-only use", async () => {
    const { findings } = await run({ "src/stt.ts": `import OpenAI from "openai";\nawait client.audio.transcriptions.create({ file, model: "whisper-1" });` });
    expect(rules(findings)).not.toContain("genai.no_moderation");
  });

  it("reports nothing for an app without AI", async () => {
    const { findings, surface } = await run({ "App/Home.swift": `import SwiftUI\nstruct Home: View { @State var t = ""; var body: some View { TextField("Name", text: $t) } }` });
    expect(findings).toHaveLength(0);
    expect(surface.providers).toHaveLength(0);
  });
});

describe("genai_safety surface", () => {
  it("lists providers, sources, sinks, prompts and moderation without linking them", async () => {
    const res = await check.run(
      await ctxFromFiles({
        "App/Chat.swift": `import SwiftUI\nimport PhotosUI\nimport AVFoundation\nimport OpenAI\nstruct Chat: View {\n  @State var text = ""\n  var body: some View { VStack { TextField("Ask", text: $text); PhotosPicker("Photo", selection: $item) } }\n  let rec = try AVAudioRecorder(url: u, settings: [:])\n  let systemPrompt = "You are a friendly companion"\n  func send() async throws { _ = try await openAI.chats(query: ChatQuery(messages: [.system(.init(content: systemPrompt))], model: .gpt4_o)) }\n}`,
        "server/key.ts": `const r = await fetch("https://api.openai.com/v1/chat/completions", { headers: { Authorization: "Bearer sk-proj-abcdefghijklmnopqrstuvwxyz0123456789" } });`,
      }),
    );
    const s = res.data?.surface as Record<string, unknown> & { sources: { kind: string }[]; sinks: { kind: string; text: string }[]; prompts: unknown[]; note: string };
    expect(s.sources.map((x) => x.kind).sort()).toEqual(expect.arrayContaining(["mic", "photo", "text"]));
    expect(s.sinks.length).toBeGreaterThanOrEqual(2);
    expect(s.prompts.length).toBeGreaterThan(0);
    expect(s.note).toMatch(/not linked/);
    expect(JSON.stringify(s)).not.toContain("sk-proj-abcdefghij");
  });
});

describe("genai_safety precision guards from field tests", () => {
  it("ignores generated .d.ts catalogs and dev-only scripts", async () => {
    const { findings, surface } = await run({
      "relay/worker-configuration.d.ts": `interface AiModels { "@cf/black-forest-labs/flux-1-schnell": BaseAiTextToImage; }`,
      "scripts/bakeoff.mjs": `import { fal } from "@fal-ai/client";\nawait fal.subscribe("fal-ai/flux/dev", { input: { enable_safety_checker: false } });`,
      "worker/experiments/tts.mjs": `await fetch("https://api.openai.com/v1/chat/completions");`,
    });
    expect(findings).toHaveLength(0);
    expect(surface.providers).toHaveLength(0);
  });

  it("does not read 'look-alike' in prose as a celebrity likeness prompt", async () => {
    const { findings } = await run(photoEditApp("Its nearest look-alike in this set is the folded note, render it as a photo"));
    expect(rules(findings)).not.toContain("genai.celebrity_likeness");
  });

  it("does not treat a person named Roop as a face-swap SDK", async () => {
    const { findings } = await run({ "src/credits.ts": `import { fal } from "@fal-ai/client";\nconst authors = ["Hunar Roop Kahlon"];` });
    expect(rules(findings)).not.toContain("genai.face_swap");
  });

  it("keeps model ids readable while redacting keys", async () => {
    const res = await check.run(await ctxFromFiles({ "worker/src/ai.ts": `const r = await env.AI.run("@cf/stabilityai/stable-diffusion-xl-base-1.0", { prompt, key: "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEf" });` }));
    const text = JSON.stringify(res.data);
    expect(text).toContain("@cf/stabilityai/stable-diffusion-xl-base-1.0");
    expect(text).not.toContain("AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEf");
  });
});

describe("genai_safety ambiguous image sink names (field: FlowDown)", () => {
  const emoji = `import UIKit\nextension String {\n    func textToImage(size: CGFloat) -> UIImage? {\n        let r = UIGraphicsImageRenderer(size: CGSize(width: size, height: size))\n        return r.image { _ in (self as NSString).draw(at: .zero) }\n    }\n}\nstruct Folder { var icon: Data = "📁".textToImage(size: 64)?.pngData() ?? .init() }\n`;
  const chat = `import FoundationModels\nfunc reply(_ s: String) async throws -> String {\n    let session = LanguageModelSession()\n    return try await session.respond(to: s).content\n}\n`;

  it("does not treat the app's own textToImage helper as an image generator", async () => {
    const { findings, surface } = await run({ "App/Emoji.swift": emoji, "App/Chat.swift": chat });
    expect(rules(findings)).not.toContain("genai.input_only_moderation");
    expect(surface.sinks.filter((s) => s.kind === "image")).toHaveLength(0);
  });

  it("still treats a provider's textToImage call as an image sink", async () => {
    const { findings, surface } = await run({
      "src/gen.ts": `import { HfInference } from "@huggingface/inference";\nconst hf = new HfInference(token);\nconst m = await mod.moderations.create({ input: prompt });\nexport const img = await hf.textToImage({ model: "stabilityai/sdxl", inputs: prompt });`,
    });
    expect(surface.sinks.some((s) => s.kind === "image")).toBe(true);
    expect(rules(findings)).toContain("genai.input_only_moderation");
  });
});

describe("genai_safety platform guardrails are scoped to their platform", () => {
  const fm = `import FoundationModels\nfunc summarize(_ s: String) async throws -> String {\n  let session = LanguageModelSession()\n  return try await session.respond(to: s).content\n}\n`;
  const cloud = `import OpenAI\nfunc ask(_ q: String) async throws {\n  let r = try await openAI.chats(query: ChatQuery(messages: [.user(.init(content: .string(q)))], model: .gpt4_o))\n  _ = r\n}\n`;

  it("flags a cloud generator that Foundation Models guardrails do not cover", async () => {
    const { findings } = await run({ "App/Summary.swift": fm, "App/CloudChat.swift": cloud });
    const f = findings.find((x) => x.rule === "genai.no_moderation");
    expect(f?.file).toBe("App/CloudChat.swift");
  });

  it("flags an MLX model in an app whose only safeguard is Foundation Models (field: FlowDown)", async () => {
    const { findings } = await run({
      "App/Summary.swift": fm,
      "App/AppDelegate.swift": `import UIKit\nimport MLX\nimport MLXLLM\nfinal class AppDelegate: UIResponder {}\n`,
      "Resources/Privacy.txt": "We integrate MLX models.",
    });
    const f = findings.find((x) => x.rule === "genai.no_moderation");
    expect(f?.file).toBe("App/AppDelegate.swift");
  });

  it("keeps a Foundation Models-only app free of moderation findings", async () => {
    const { findings } = await run({ "App/Summary.swift": fm });
    expect(rules(findings)).not.toContain("genai.no_moderation");
  });
});

describe("genai_safety anchors on shipping calls (field: pocketpal-ai)", () => {
  it("ignores string literals in a TS type union and prefers a shipping call over a debug screen", async () => {
    const { findings, surface } = await run({
      "src/screens/DevToolsScreen/TestCompletionScreen.tsx": `import { initLlama } from "llama.rn";\ntype TestId =\n  | 'chatCompletion'\n  | 'textCompletion';\nexport async function runTest(ctx) { return ctx.chatCompletion(messages); }\n`,
      "src/store/ChatStore.ts": `import { initLlama } from "llama.rn";\nexport async function send(ctx, messages) {\n  return await ctx.chatCompletion({ messages });\n}\n`,
    });
    expect((surface.sinks as { text: string }[]).some((s) => s.text.startsWith("|"))).toBe(false);
    const f = findings.find((x) => x.rule === "genai.no_moderation");
    expect(f?.file).toBe("src/store/ChatStore.ts");
  });
});

describe("genai anchors and provider media (field: pocketpal-ai, FlowDown, react-native-ai)", () => {
  it("does not take a hostname comparison as provider evidence", async () => {
    const { surface, findings } = await run({
      "src/utils/serverTypes.ts": `export function isOpenAI(url: string) {\n  if (new URL(url).hostname.endsWith('api.openai.com')) {\n    return true;\n  }\n  return url === "https://api.openai.com/v1";\n}\n`,
      "src/api/completionEngines.ts": `import { initLlama, LlamaContext } from "llama.rn";\nexport async function complete(ctx: LlamaContext, messages) {\n  return await ctx.completion({ messages });\n}\n`,
    });
    expect(surface.providers.map((p) => p.id)).toEqual(["llamacpp"]);
    for (const f of findings) expect(f.file).not.toBe("src/utils/serverTypes.ts");
  });

  it("anchors on a model call before an import in the app entry file", async () => {
    const { findings } = await run({
      "FlowDown/Application/AppDelegate.swift": `import UIKit\nimport MLX\nclass AppDelegate: UIResponder {}\n`,
      "FlowDown/Backend/Model/ModelManager.swift": `import MLXLLM\nfinal class ModelManager {}\n`,
    });
    const f = findings.find((x) => x.rule === "genai.no_moderation");
    expect(f?.file).toBe("FlowDown/Backend/Model/ModelManager.swift");
  });

  it("prefers an app call site over server code", async () => {
    const { findings } = await run({
      "server/src/chat/claude.ts": `import Anthropic from "@anthropic-ai/sdk";\nconst anthropic = new Anthropic();\nexport const go = (m) => anthropic.messages.create({ model, messages: m });\n`,
      "app/src/chat.ts": `export async function send(messages) {\n  return fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: JSON.stringify({ messages }) });\n}\n`,
    });
    const f = findings.find((x) => x.rule === "genai.no_moderation");
    expect(f?.file).toBe("app/src/chat.ts");
  });

  it("reports a provider's media from the calls the app makes", async () => {
    const res = await check.run(await ctxFromFiles({ "src/ai.ts": `import OpenAI from "openai";\nconst c = new OpenAI();\nawait c.chat.completions.create({ model: "gpt-4o", messages });` }));
    const providers = (res.data?.surface as { providers: { id: string; media: string[] }[] }).providers;
    expect(providers.find((p) => p.id === "openai")?.media).toEqual(["text"]);
  });
});

describe("monorepo sibling web apps (field: apps/web beside apps/mobile)", () => {
  it("does not count a sibling web site's AI calls as the mobile app's surface", async () => {
    const base = {
      "package.json": JSON.stringify({ private: true, workspaces: ["apps/*"] }),
      "apps/mobile/package.json": JSON.stringify({ dependencies: { expo: "~52.0.0", "react-native": "0.76.0" } }),
      "apps/mobile/app.json": JSON.stringify({ expo: { name: "Notes" } }),
      "apps/mobile/App.tsx": "export default function App() { return null; }",
      "apps/web/app/api/chat/route.ts": 'import OpenAI from "openai";\nconst client = new OpenAI();\nexport async function POST(req: Request) { const { prompt } = await req.json(); return Response.json(await client.images.generate({ model: "dall-e-3", prompt })); }',
    };
    const sibling = await run(base);
    expect(sibling.surface.providers.map((p) => p.id)).toEqual([]);
    const inApp = await run({ ...base, "apps/mobile/src/gen.ts": base["apps/web/app/api/chat/route.ts"] });
    expect(inApp.surface.providers.length).toBeGreaterThan(0);
  });
});

// Field (swift-coreml-diffusers): apple/ml-stable-diffusion runs its safety checker unless disableSafety is true.
describe("on-device Stable Diffusion safety checker", () => {
  const gen = (opt: string) =>
    `import StableDiffusion\nimport CoreML\nfinal class Generator {\n  let pipeline: StableDiffusionPipeline\n  init(url: URL) throws { pipeline = try StableDiffusionPipeline(resourcesAt: url, controlNet: [], configuration: MLModelConfiguration()${opt}) }\n  func generate(prompt: String) throws -> CGImage? {\n    let config = StableDiffusionPipeline.Configuration(prompt: prompt)\n    return try pipeline.generateImages(configuration: config).first ?? nil\n  }\n}\n`;

  it("counts the default checker (and an explicit disableSafety: false) as image moderation", async () => {
    for (const opt of ["", ", disableSafety: false"]) {
      const { findings, surface } = await run({ "App/Gen.swift": gen(opt) });
      expect(rules(findings), opt).not.toContain("genai.no_moderation");
      expect(rules(findings), opt).not.toContain("genai.input_only_moderation");
      expect(surface.moderation.some((m) => m.kind === "image"), opt).toBe(true);
    }
  });

  it("attributes the pipeline call to Stable Diffusion, not to the Core ML import beside it", async () => {
    const { surface } = await run({ "App/Gen.swift": gen("") });
    const sinks = surface.sinks as unknown as { provider?: string }[];
    expect(sinks.length).toBeGreaterThan(0);
    expect(sinks.every((s) => s.provider === "stablediffusion-ondevice")).toBe(true);
  });

  it("gives no credit once disableSafety: true appears", async () => {
    const { findings } = await run({ "App/Gen.swift": gen(", disableSafety: true") });
    expect(rules(findings)).toContain("genai.safety_disabled");
    expect(rules(findings)).toContain("genai.no_moderation");
  });

  it("reports a user-facing switch that turns the checker off", async () => {
    const { findings } = await run({
      "App/Gen.swift": gen(""),
      "App/Controls.swift": `import SwiftUI\nstruct Controls: View {\n  @Binding var generation: GenerationContext\n  var body: some View { Toggle("Disable Safety Checker", isOn: $generation.disableSafety) }\n}\n`,
    });
    const f = findings.find((x) => x.rule === "genai.user_safety_toggle");
    expect(f?.severity).toBe("medium");
    expect(f?.file).toBe("App/Controls.swift");
    expect(f?.fix).toMatch(/^Remove the user-facing switch/);
    expect(rules(findings)).not.toContain("genai.no_moderation");
  });

  it("does not let the checker vouch for a chat model elsewhere in the app", async () => {
    const { findings } = await run({
      "App/Gen.swift": gen(""),
      "App/Chat.swift": `import OpenAI\nlet openAI = OpenAI(apiToken: token)\nlet r = try await openAI.chats(query: q)\n`,
    });
    const f = findings.find((x) => x.rule === "genai.no_moderation");
    expect(f?.file).toBe("App/Chat.swift");
  });
});

// Field: LLMFarm (RagTestIOS embeddings target), fullmoon (credits link), FlowDown (privacy text), pocketpal (DevTools).
describe("genai anchors when no shipping call is recognised", () => {
  it("skips a provider that generates nothing and a separate test target", async () => {
    const { findings } = await run({
      "RagTestIOS/RagTestIOS/DistilbertEmbeddings.swift": `import CoreML\nlet modelConfig = MLModelConfiguration()\n`,
      "LLMFarm/AIChatModel.swift": `import Foundation\nimport llmfarm_core\nfinal class AIChatModel {}\n`,
    });
    expect(findings.find((x) => x.rule === "genai.no_moderation")?.file).toBe("LLMFarm/AIChatModel.swift");
  });

  it("prefers an SDK import over a package name inside a credits link", async () => {
    const { findings } = await run({
      "fullmoon/Views/Settings/CreditsView.swift": `import SwiftUI\nstruct CreditsView: View { var body: some View { Link("MLX Swift", destination: URL(string: "https://github.com/ml-explore/mlx-swift")!) } }\n`,
      "fullmoon/Models/LLMEvaluator.swift": `import MLXLLM\nfinal class LLMEvaluator {}\n`,
    });
    expect(findings.find((x) => x.rule === "genai.no_moderation")?.file).toBe("fullmoon/Models/LLMEvaluator.swift");
  });

  it("anchors on the provider import when the only call sits in a dev-tools screen", async () => {
    const { findings } = await run({
      "src/screens/DevToolsScreen/TestCompletionScreen.tsx": `import { initLlama } from "llama.rn";\nexport async function runTest(ctx) { return ctx.chatCompletion(messages); }\n`,
      "src/api/completionEngines.ts": `import { LlamaContext } from "llama.rn";\nexport class LocalCompletionEngine { constructor(private context: LlamaContext) {} }\n`,
    });
    expect(findings.find((x) => x.rule === "genai.no_moderation")?.file).toBe("src/api/completionEngines.ts");
  });
});

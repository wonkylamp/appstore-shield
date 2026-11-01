import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Finding } from "../../src/finding.js";
import { check as genai } from "../../src/scanners/genaiSafety.js";
import { check as ugc } from "../../src/scanners/ugcSafeguards.js";
import { ctxFromFiles } from "../helpers.js";

type Sink = { kind: string; file: string; line: number; provider?: string };
type Mod = { kind: string; label?: string };

async function run(files: Record<string, string>) {
  const ctx = await ctxFromFiles(files);
  const g = await genai.run(ctx);
  const u = await ugc.run(ctx);
  const surface = (g.data?.surface ?? {}) as { sinks: Sink[]; moderation: Mod[]; providers: { id: string }[]; hasImageGenerator: boolean };
  return { genai: g.findings, ugc: u.findings, all: [...g.findings, ...u.findings], surface };
}
const rules = (fs: Finding[]) => fs.map((f) => f.rule);
const fixture = (rel: string) => readFile(path.join(__dirname, "../fixtures/swiftui-ai-companion", rel), "utf8");

// Field (indie-dev r7): a Replicate REST image generator with prompt-only moderation reported nothing.
describe("generic generation calls that return images", () => {
  const textMod = `import Foundation\nenum Moderator {\n  static func check(_ text: String) async throws -> Bool {\n    var r = URLRequest(url: URL(string: "https://api.openai.com/v1/moderations")!)\n    r.httpBody = try JSONSerialization.data(withJSONObject: ["model": "text-moderation-latest", "input": text])\n    _ = try await URLSession.shared.data(for: r)\n    return true\n  }\n}\n`;

  it("treats the companion fixture's Replicate predictions call as an image generator", async () => {
    const gen = (await fixture("Sources/AI/ImageGenerator.swift")).replace(/\s*"disable_safety_checker": true,\n/, "\n");
    const { genai: fs, surface } = await run({ "Sources/AI/ImageGenerator.swift": gen, "Sources/Safety/Moderator.swift": textMod });
    expect(surface.hasImageGenerator).toBe(true);
    expect(surface.sinks.find((x) => x.file === "Sources/AI/ImageGenerator.swift")?.kind).toBe("image");
    expect(rules(fs)).toContain("genai.input_only_moderation");
  });

  it("keeps a Replicate text call (no bitmap, no diffusion parameters) as generic generation", async () => {
    const llm = `import Foundation\nfunc ask(_ p: String) async throws {\n  var r = URLRequest(url: URL(string: "https://api.replicate.com/v1/predictions")!)\n  r.httpBody = try JSONSerialization.data(withJSONObject: ["input": ["prompt": p, "max_tokens": 200]])\n  _ = try await URLSession.shared.data(for: r)\n}\n`;
    const { surface } = await run({ "Sources/Ask.swift": llm });
    expect(surface.sinks[0]?.kind).toBe("generation");
    expect(surface.hasImageGenerator).toBe(false);
  });
});

// Field (indie-dev r7): omni-moderation fed only the prompt counted as image moderation.
describe("omni-moderation counts as image moderation only when an image is sent", () => {
  const imageGen = `import { fal } from "@fal-ai/client";\nexport const gen = (prompt: string) => fal.subscribe("fal-ai/flux/dev", { input: { prompt } });\n`;

  it("text-only omni-moderation next to an image generator raises input_only_moderation", async () => {
    const mod = `export async function moderate(text: string) {\n  const body = JSON.stringify({ model: "omni-moderation-latest", input: text });\n  return fetch("https://api.openai.com/v1/moderations", { method: "POST", body });\n}\n`;
    const { genai: fs, surface } = await run({ "src/gen.ts": imageGen, "src/moderate.ts": mod });
    expect(surface.moderation.find((m) => /omni/.test(m.label ?? ""))?.kind).toBe("text");
    expect(rules(fs)).toContain("genai.input_only_moderation");
  });

  it("omni-moderation that receives the generated image covers image output", async () => {
    const mod = `export async function moderateImage(url: string) {\n  return fetch("https://api.openai.com/v1/moderations", { method: "POST", body: JSON.stringify({ model: "omni-moderation-latest", input: [{ type: "image_url", image_url: { url } }] }) });\n}\n`;
    const { genai: fs, surface } = await run({ "src/gen.ts": imageGen, "src/moderate.ts": mod });
    expect(surface.moderation.find((m) => /omni/.test(m.label ?? ""))?.kind).toBe("both");
    expect(rules(fs)).not.toContain("genai.input_only_moderation");
  });
});

describe("genai.safety_disabled fix names the provider's own setting", () => {
  it("fal and Replicate get their checker flags, not Gemini thresholds", async () => {
    const { genai: fs } = await run({
      "src/fal.ts": `import { fal } from "@fal-ai/client";\nawait fal.subscribe("fal-ai/flux/dev", { input: { prompt, enable_safety_checker: false } });\n`,
      "src/rep.ts": `import Replicate from "replicate";\nawait replicate.run("black-forest-labs/flux-schnell", { input: { prompt, disable_safety_checker: true } });\n`,
    });
    const off = fs.filter((f) => f.rule === "genai.safety_disabled");
    expect(off).toHaveLength(2);
    for (const f of off) expect(f.fix).not.toMatch(/BLOCK_MEDIUM_AND_ABOVE/);
    expect(off.find((f) => f.file === "src/fal.ts")?.fix).toMatch(/enable_safety_checker/);
    expect(off.find((f) => f.file === "src/rep.ts")?.fix).toMatch(/disable_safety_checker/);
  });

  it("Gemini BLOCK_NONE still points at a blocking threshold", async () => {
    const { genai: fs } = await run({ "src/g.ts": `import { HarmBlockThreshold } from "@google/generative-ai";\nconst s = [{ threshold: HarmBlockThreshold.BLOCK_NONE }];\n` });
    expect(fs.find((f) => f.rule === "genai.safety_disabled")?.fix).toMatch(/BLOCK_MEDIUM_AND_ABOVE/);
  });
});

// Field (field-test r7): non-AI apps got three highs from ambiguous method names.
describe("ambiguous generation names in apps without a generator", () => {
  const noAi = (fs: Finding[]) => fs.filter((f) => /^(genai|ugc)\./.test(f.rule));

  it("a SwiftUI WrappingHStack generateContent helper is not an AI call", async () => {
    const { all } = await run({
      "App/WrappingHStack.swift": `import SwiftUI\nstruct WrappingHStack: View {\n  var body: some View {\n    GeometryReader { geometry in\n      self.generateContent(in: geometry)\n    }\n  }\n  private func generateContent(in g: GeometryProxy) -> some View { EmptyView() }\n}\n`,
    });
    expect(noAi(all)).toEqual([]);
  });

  it("a Core ML upscaler does not make generateContent an AI call (Aidoku)", async () => {
    const { all } = await run({
      "App/Upscale.swift": `import CoreML\nlet m = try MLModel(contentsOf: url)\n`,
      "App/HCollectionGrid.swift": `import SwiftUI\nstruct Grid: View {\n  var body: some View { self.generateContent() }\n  func generateContent() -> some View { EmptyView() }\n}\n`,
    });
    expect(noAi(all)).toEqual([]);
  });

  it("Twilio messages.create is an SMS, not an LLM call", async () => {
    const { all } = await run({
      "package.json": JSON.stringify({ dependencies: { twilio: "^5.0.0" } }),
      "src/sendOtp.ts": `import twilio from "twilio";\nconst client = twilio(sid, token);\nexport async function sendOtp(to: string, code: string) {\n  await client.messages.create({ body: \`Your code is \${code}\`, to, from });\n}\n`,
    });
    expect(noAi(all)).toEqual([]);
  });

  it("an Apollo ChatQuery class is a GraphQL query", async () => {
    const { all } = await run({
      "App/API/ChatQuery.graphql.swift": `import Apollo\npublic class ChatQuery: GraphQLQuery {\n  public init() {}\n}\n`,
      "App/Inbox.swift": `import Apollo\nfunc load() {\n  apollo.fetch(query: ChatQuery()) { _ in }\n}\n`,
    });
    expect(noAi(all)).toEqual([]);
  });

  it("still counts a provider call inside the app's own generateContent wrapper", async () => {
    const { surface } = await run({
      "App/Gen.swift": `import GoogleGenerativeAI\nstruct Gen {\n  let model = GenerativeModel(name: "gemini-2.5-flash", apiKey: key)\n  func generateContent(_ p: String) async throws -> String {\n    try await model.generateContent(p).text ?? ""\n  }\n}\n`,
    });
    expect(surface.sinks.some((x) => x.file === "App/Gen.swift" && x.line === 5)).toBe(true);
  });

  it("still counts Anthropic messages.create when the client is built in another file", async () => {
    const { surface } = await run({
      "server/anthropic.ts": `import Anthropic from "@anthropic-ai/sdk";\nexport const anthropic = new Anthropic();\n`,
      "server/route.ts": `import { anthropic } from "./anthropic";\nexport const go = (messages: any[]) => anthropic.messages.create({ model: "claude-sonnet-4-5", max_tokens: 500, messages });\n`,
    });
    expect(surface.sinks.some((x) => x.file === "server/route.ts")).toBe(true);
  });
});

// Field (field-test r7): SDXL / SD3 sinks were blamed on Core ML and anchored at a model catalogue.
describe("Stable Diffusion XL / 3 pipelines", () => {
  it("are attributed to a provider with no safety checker and anchored at the pipeline constructor", async () => {
    const { genai: fs, surface } = await run({
      "Diffusion/Common/ModelInfo.swift": `import CoreML\nstruct ModelInfo { let id: String }\nextension ModelInfo {\n  static let sd3 = ModelInfo(id: "coreml-stable-diffusion-3-medium")\n}\n`,
      "Diffusion/Common/Pipeline/PipelineLoader.swift": `import CoreML\nimport StableDiffusion\nfunc load(url: URL, xl: Bool) throws -> StableDiffusionPipelineProtocol {\n  if xl {\n    return try StableDiffusionXLPipeline(resourcesAt: url, configuration: cfg)\n  }\n  return try StableDiffusionPipeline(resourcesAt: url, controlNet: [], configuration: cfg, disableSafety: false)\n}\n`,
    });
    expect(surface.providers.map((p) => p.id)).toContain("stablediffusion-xl-ondevice");
    expect(surface.sinks.find((x) => /PipelineLoader/.test(x.file) && x.line === 5)?.provider).toBe("stablediffusion-xl-ondevice");
    const f = fs.find((x) => x.rule === "genai.no_moderation");
    expect(f?.severity).toBe("high");
    expect(f?.file).toBe("Diffusion/Common/Pipeline/PipelineLoader.swift");
    expect(f?.line).toBe(5);
    expect(f?.why).toMatch(/without the package's safety checker/);
    expect(f?.fix).toMatch(/image classifier/);
  });
});

// Dogfood (real app): ugc.no_report pointed at a model-family lookup in a config file.
describe("AI findings point at the call or the view, never a model lookup", () => {
  it("skips a config lookup line for the provider call and the view that shows the image", async () => {
    const { all } = await run({
      "apps/api/src/config/styles.ts": `export function styleFor(family: string) {\n  if (family === "recraft-v4" || family === "flux-pro") return { steps: 30 };\n  return {};\n}\n`,
      "apps/api/src/routes/generate.ts": `import { fal } from "@fal-ai/client";\nexport async function generate(prompt: string) {\n  return fal.subscribe("fal-ai/recraft/v3", { input: { prompt } });\n}\n`,
      "apps/mobile/app/create.tsx": `import { Image } from "react-native";\nexport function Create({ imageUrl }: { imageUrl: string }) {\n  const generateImage = () => fetch("/generate");\n  return <Image source={{ uri: imageUrl }} />;\n}\n`,
    });
    const report = all.find((f) => f.rule === "ugc.no_report");
    const mod = all.find((f) => f.rule === "genai.no_moderation");
    expect(report?.file).toBe("apps/mobile/app/create.tsx");
    expect(mod?.file).toBe("apps/api/src/routes/generate.ts");
    for (const f of all) expect(f.file).not.toBe("apps/api/src/config/styles.ts");
  });
});

describe("sink mentions", () => {
  it("a call line that also names a model id is a call, not a mention", async () => {
    const { surface } = await run({ "src/gen.ts": `import { fal } from "@fal-ai/client";\nexport const gen = (prompt: string) => fal.subscribe("fal-ai/flux/dev", { input: { prompt } });\n` });
    const sink = surface.sinks.find((x) => x.line === 2) as (Sink & { mention?: boolean }) | undefined;
    expect(sink).toBeDefined();
    expect(sink?.mention).toBeUndefined();
  });
});

// Dogfood (real app): text-only hosted generation with structured output is a disclose item, not a high.
describe("genai.no_moderation severity calibration", () => {
  const fuel = `import Anthropic from "@anthropic-ai/sdk";\nconst anthropic = new Anthropic();\nexport async function fuelTip(stats: string) {\n  const r = await anthropic.messages.create({\n    model: "claude-sonnet-4-5",\n    max_tokens: 400,\n    tool_choice: { type: "tool", name: "fuel_tip" },\n    tools: [{ name: "fuel_tip", input_schema: { type: "object", properties: { litres: { type: "number" } } } }],\n    messages: [{ role: "user", content: stats }],\n  });\n  return r;\n}\n`;
  const sev = (fs: Finding[]) => fs.find((f) => f.rule === "genai.no_moderation")?.severity;

  it("is medium with a disclose fix for hosted text-only generation with structured output", async () => {
    const { genai: fs } = await run({ "server/fuel.ts": fuel });
    const f = fs.find((x) => x.rule === "genai.no_moderation");
    expect(f?.severity).toBe("medium");
    expect(f?.fix).toMatch(/^Disclose/);
    expect(f?.why).toMatch(/Anthropic/);
  });

  it("stays high without schema validation of the output", async () => {
    const plain = fuel.replace(/\s*tool_choice:[^\n]*\n\s*tools:[^\n]*\n/, "\n");
    expect(sev((await run({ "server/fuel.ts": plain })).genai)).toBe("high");
  });

  it("stays high for companion or roleplay persona chat", async () => {
    const persona = fuel.replace("const anthropic", `const companionPersona = "You are Mia, the user's girlfriend";\nconst anthropic`);
    expect(sev((await run({ "server/fuel.ts": persona })).genai)).toBe("high");
  });

  it("stays high when an image generator is also present", async () => {
    const files = { "server/fuel.ts": fuel, "server/img.ts": `import OpenAI from "openai";\nexport const img = (p: string) => new OpenAI().images.generate({ model: "gpt-image-1", prompt: p });\n` };
    expect(sev((await run(files)).genai)).toBe("high");
  });

  it("stays high for open-weight on-device models", async () => {
    const files = { "server/fuel.ts": fuel, "App/Local.swift": `import MLXLLM\nlet c = try await LLMModelFactory.shared.loadContainer(configuration: cfg)\n` };
    expect(sev((await run(files)).genai)).toBe("high");
  });

  it("never downgrades when provider safety is explicitly disabled", async () => {
    const gem = `import { GoogleGenerativeAI, HarmBlockThreshold } from "@google/generative-ai";\nconst model = new GoogleGenerativeAI(key).getGenerativeModel({ model: "gemini-2.5-flash", safetySettings: [{ category, threshold: HarmBlockThreshold.BLOCK_NONE }], generationConfig: { responseMimeType: "application/json", responseSchema: schema } });\nexport const run = (p: string) => model.generateContent(p);\n`;
    const { genai: fs } = await run({ "server/gem.ts": gem });
    expect(rules(fs)).toContain("genai.safety_disabled");
    expect(sev(fs)).toBe("high");
  });
});

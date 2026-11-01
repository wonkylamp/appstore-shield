import { describe, expect, it } from "vitest";
import type { Finding } from "../../src/finding.js";
import { RESTORE } from "../../src/rules/store.js";
import { check as disclosure } from "../../src/scanners/aiDataDisclosure.js";
import { check as genai } from "../../src/scanners/genaiSafety.js";
import { check as paywall } from "../../src/scanners/paywall.js";
import { check as privacy } from "../../src/scanners/privacyManifest.js";
import { check as ugc } from "../../src/scanners/ugcSafeguards.js";
import { ctxFromFiles } from "../helpers.js";

type Sink = { kind: string; file: string; line: number; provider?: string; mention?: boolean };
type Mod = { kind: string; label?: string; file: string };

async function run(files: Record<string, string>) {
  const ctx = await ctxFromFiles(files);
  const g = await genai.run(ctx);
  const u = await ugc.run(ctx);
  const d = await disclosure.run(ctx);
  const surface = (g.data?.surface ?? {}) as { sinks: Sink[]; moderation: Mod[]; providers: { id: string }[]; hasImageGenerator: boolean };
  return { genai: g.findings, ugc: u.findings, disclosure: d.findings, all: [...g.findings, ...u.findings, ...d.findings], surface, ugcData: u.data as Record<string, unknown>, discData: d.data as Record<string, unknown> };
}
const rules = (fs: Finding[]) => fs.map((f) => f.rule);
const RN_PKG = JSON.stringify({ name: "app", dependencies: { "react-native": "0.76.0" } });

// Field (notesnook): document.createComment in a DOM shim made the app a UGC platform.
describe("DOM createComment is not user-generated content", () => {
  it("a DOM call or a DOM shim method yields no UGC findings", async () => {
    const { ugc: fs, ugcData } = await run({
      "package.json": RN_PKG,
      "src/htmlToDom.ts": `export function toDom(node: Node, data: string) {\n  node.appendChild(document.createComment(data));\n  node.appendChild(node.ownerDocument.createComment(data));\n}\n`,
      "src/domShim.js": `class Doc {\n  createTextNode(t) { return { t }; }\n  createComment(textContent) {\n    return { textContent };\n  }\n}\n`,
    });
    expect(ugcData.applies).toBe(false);
    expect(rules(fs)).toEqual([]);
  });

  it("a rollup bundle with a DOM implementation is not UGC evidence", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `const append$${i} = (a) => a;`).join("\n");
    const { ugcData } = await run({ "package.json": RN_PKG, "worker.js": `${ids}\nfunction mk$2(data) { return createComment(data); }\n` });
    expect(ugcData.applies).toBe(false);
  });

  it("still counts a comments API call in an app", async () => {
    const { ugcData } = await run({ "package.json": RN_PKG, "src/post.tsx": `export async function send(postId: string, body: string) {\n  await api.createComment({ postId, body });\n}\n` });
    expect(ugcData.applies).toBe(true);
  });
});

// Field (notesnook): a report dialog in a separate web app satisfied the mobile app's report check.
describe("safeguards in another app of the monorepo do not count", () => {
  it("ignores a sibling app's report dialog when one mobile app is detected", async () => {
    const { ugc: fs } = await run({
      "package.json": JSON.stringify({ private: true, workspaces: ["apps/*"] }),
      "apps/mobile/package.json": JSON.stringify({ name: "mobile", dependencies: { expo: "~52.0.0", "react-native": "0.76.0" } }),
      "apps/mobile/app.json": JSON.stringify({ expo: { name: "Notes" } }),
      "apps/mobile/src/Feed.tsx": `export function Feed() {\n  const send = (t: string) => addComment(t);\n  return null;\n}\n`,
      "apps/monograph/package.json": JSON.stringify({ name: "monograph", dependencies: { react: "18" } }),
      "apps/monograph/app/report-modal.tsx": `export default function ReportDialog() {\n  return <button title="Report">Report</button>;\n}\n`,
    });
    expect(rules(fs)).toContain("ugc.no_report");
  });

  it("keeps a sibling package the app depends on", async () => {
    const { ugc: fs } = await run({
      "package.json": JSON.stringify({ private: true, workspaces: ["apps/*"] }),
      "apps/mobile/package.json": JSON.stringify({ name: "mobile", dependencies: { expo: "~52.0.0", "react-native": "0.76.0", "@notes/ui": "*" } }),
      "apps/mobile/app.json": JSON.stringify({ expo: { name: "Notes" } }),
      "apps/mobile/src/Feed.tsx": `export function Feed() {\n  const send = (t: string) => addComment(t);\n  return null;\n}\n`,
      "apps/ui/package.json": JSON.stringify({ name: "@notes/ui" }),
      "apps/ui/src/ReportSheet.tsx": `export function ReportSheet() {\n  return <button>Report post</button>;\n}\n`,
    });
    expect(rules(fs)).not.toContain("ugc.no_report");
  });
});

// Dogfood (real app): `AppStore.sync()` never matched because of a trailing word boundary.
describe("paywall restore detection", () => {
  it("matches a bare AppStore.sync() call and a custom Restore label", () => {
    expect(RESTORE.test("try await AppStore.sync()")).toBe(true);
    expect(RESTORE.test(`Button("Restore Membership") { }`)).toBe(true);
  });

  it("does not report missing restore for StoreKit 2 with AppStore.sync and a custom label", async () => {
    const r = await paywall.run(
      await ctxFromFiles({
        "App/Membership/MembershipStore.swift": `import StoreKit\nfinal class MembershipStore {\n  func buy(_ p: Product) async throws { _ = try await p.purchase() }\n  func restore() async throws { try await AppStore.sync() }\n}\n`,
        "App/Membership/MembershipSheet.swift": `import SwiftUI\nstruct MembershipSheet: View {\n  let store: MembershipStore\n  var body: some View { Button("Bring back my membership") { Task { try await store.restore() } } }\n}\n`,
      }),
    );
    expect(r.findings.map((f) => f.rule)).not.toContain("paywall.missing_restore");
  });
});

// Dogfood (real app): omni-moderation on generated pixels through a helper in the same file.
describe("image moderation through a shared helper", () => {
  it("counts omni-moderation as image moderation when the file sends image_url to the helper", async () => {
    const pad = Array.from({ length: 60 }, (_, i) => `const filler${i} = ${i};`).join("\n");
    const { genai: fs, surface } = await run({
      "worker/src/providers/claude.ts": `const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";\nexport async function chat(p: string) {\n  return fetch(ANTHROPIC_URL, { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: p }] }) });\n}\n`,
      "worker/src/providers/openai.ts": `const MODERATION_URL = "https://api.openai.com/v1/moderations";\nconst OPENAI_MODERATION_MODEL = "omni-moderation-latest";\n${pad}\nexport class OpenAIProvider {\n  async callModeration(input: unknown[]) {\n    return fetch(MODERATION_URL, { method: "POST", body: JSON.stringify({ model: OPENAI_MODERATION_MODEL, input }) });\n  }\n  async moderateImage(image: { url: string }) {\n    return this.callModeration([{ type: "image_url", image_url: { url: image.url } }]);\n  }\n  async image(prompt: string) {\n    return fetch("https://api.openai.com/v1/images/generations", { method: "POST", body: JSON.stringify({ model: "gpt-image-1", prompt }) });\n  }\n}\n`,
    });
    expect(surface.hasImageGenerator).toBe(true);
    expect(surface.moderation.some((m) => m.kind === "both")).toBe(true);
    expect(rules(fs)).not.toContain("genai.input_only_moderation");
  });

  it("anchors input_only_moderation on the image call, not a text provider's URL constant", async () => {
    const { genai: fs } = await run({
      "worker/src/providers/claude.ts": `const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";\nexport async function chat(p: string) {\n  return fetch(ANTHROPIC_URL, { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: p }] }) });\n}\n`,
      "worker/src/image.ts": `import OpenAI from "openai";\nconst client = new OpenAI();\nexport const img = (p: string) => client.images.generate({ model: "gpt-image-1", prompt: p });\n`,
      "worker/src/mod.ts": `import OpenAI from "openai";\nexport const mod = (t: string) => new OpenAI().moderations.create({ model: "text-moderation-latest", input: t });\n`,
    });
    const f = fs.find((x) => x.rule === "genai.input_only_moderation");
    expect(f?.file).toBe("worker/src/image.ts");
  });
});

// Dogfood (real app): "Report scope", "Report period" and crowd reports counted as content reports.
describe("report labels that are nouns are not a content report", () => {
  const chat = `import SwiftUI\nstruct AskView: View {\n  @State var messages: [Msg] = []\n  var body: some View { List(messages) { message in Text(message.text) } }\n  func ask(_ q: String) async throws {\n    var r = URLRequest(url: URL(string: "https://api.openai.com/v1/chat/completions")!)\n    r.httpMethod = "POST"\n    _ = try await URLSession.shared.data(for: r)\n  }\n}\n`;
  it("an AI chat with only report-export copy still yields ugc.no_report", async () => {
    const { ugc: fs } = await run({
      "Till/AskView.swift": chat,
      "Till/Localization/ReportsCopy.swift": `enum ReportsCopy {\n  static func scope(_ period: String) -> String { "Report scope: \\(period)" }\n  static let period = "Report period"\n  static let nearby = "Report when nearby"\n}\n`,
    });
    expect(rules(fs)).toContain("ugc.no_report");
  });

  it("a generic Report label outside the chat view does not cover chat replies", async () => {
    const { ugc: fs } = await run({ "Till/AskView.swift": chat, "Till/Fuel/AvailabilityCard.swift": `import SwiftUI\nstruct AvailabilityCard: View {\n  var body: some View { Button("Report") { } }\n}\n` });
    expect(rules(fs)).toContain("ugc.no_report");
  });

  it("still accepts a report control on the chat view", async () => {
    const withReport = chat.replace("Text(message.text) }", `Text(message.text).contextMenu { Button("Report") { } } }`);
    const { ugc: fs } = await run({ "Till/AskView.swift": withReport });
    expect(rules(fs)).not.toContain("ugc.no_report");
  });
});

// Dogfood (real app): a marketing word list read only by tests counted as moderation.
describe("in-repo filter identifiers must be used", () => {
  const assistant = `import Anthropic from "@anthropic-ai/sdk";\nconst anthropic = new Anthropic();\nexport const ask = (q: string) => anthropic.messages.create({ model: "claude-sonnet-4-5", max_tokens: 300, messages: [{ role: "user", content: q }] });\n`;
  it("a declared but unused forbiddenWords list is not moderation", async () => {
    const { genai: fs, surface } = await run({
      "ai-worker/src/index.ts": assistant,
      "Calc/Assistant/AssistantCopy.swift": `enum AssistantCopy {\n  static let forbiddenWords = ["free", "subscription", "price"]\n}\n`,
    });
    expect(surface.moderation.length).toBe(0);
    expect(rules(fs)).toContain("genai.no_moderation");
  });

  it("a filter list that is applied still counts", async () => {
    const { genai: fs } = await run({
      "ai-worker/src/index.ts": assistant.replace("export const ask = (q: string) =>", `const BANNED_TERMS = ["x"];\nexport const ask = (q: string) => BANNED_TERMS.some((t) => q.includes(t)) ? null :`),
    });
    expect(rules(fs)).not.toContain("genai.no_moderation");
  });
});

// Dogfood (real app): paywall marketing "Deep AI analysis" counted as an AI data disclosure.
describe("AI data disclosure", () => {
  const files = {
    "App/Services/AIPrompts.swift": `import Foundation\nimport HealthKit\nlet store = HKHealthStore()\nfunc prompt(sleep: Double) -> String { "Sleep: \\(sleep)" }\nfunc send(_ text: String) async throws {\n  var r = URLRequest(url: URL(string: "https://api.anthropic.com/v1/messages")!)\n  r.httpMethod = "POST"\n  _ = try await URLSession.shared.data(for: r)\n}\n`,
    "App/Features/Paywall/PaywallView.swift": `import SwiftUI\nstruct PaywallView: View {\n  var body: some View { Text("Deep AI analysis of your week with personalized recommendations") }\n}\n`,
  };
  it("paywall marketing is not consent, and HealthKit data counts as shared data", async () => {
    const { disclosure: fs, discData } = await run(files);
    expect(discData.consent).toEqual([]);
    expect(discData.dataKinds).toContain("health data");
    const f = fs.find((x) => x.rule === "ai.undisclosed_sharing");
    expect(f?.why).toMatch(/5\.1\.3/);
  });

  it("a real disclosure naming the provider still counts", async () => {
    const { disclosure: fs } = await run({ ...files, "App/Onboarding/Consent.swift": `import SwiftUI\nstruct Consent: View {\n  var body: some View { Text("Your sleep data is sent to Anthropic to generate insights.") }\n}\n` });
    expect(rules(fs)).not.toContain("ai.undisclosed_sharing");
  });
});

// Dogfood (real app): anchors must be the generation call, not an import, error string or router.
describe("AI finding anchors", () => {
  it("anchors MLX findings on the generate call, not an import in an unrelated model file", async () => {
    const { genai: fs } = await run({
      "fullmoon/Models/DeviceStat.swift": `import Foundation\nimport MLXLLM\nstruct DeviceStat { let gpu: Double }\n`,
      "fullmoon/Models/LLMEvaluator.swift": `import MLXLLM\nimport MLXLMCommon\nfinal class LLMEvaluator {\n  func run(_ prompt: String, context: ModelContext) throws {\n    let input = try context.processor.prepare(input: .init(prompt: prompt))\n    _ = try MLXLMCommon.generate(input: input, parameters: .init(), context: context) { _ in .more }\n  }\n}\n`,
    });
    const f = fs.find((x) => x.rule === "genai.no_moderation");
    expect(f?.file).toBe("fullmoon/Models/LLMEvaluator.swift");
    expect(f?.line).toBe(6);
  });

  it("skips a provider name inside an error message", async () => {
    const { surface } = await run({
      "apps/api/src/services/fal-client.ts": `export async function call(params: { url: string }) {\n  const r = await fetch(params.url);\n  if (!r.ok) throw new AppError(502, "GENERATION_FAILED", \`GENERATION_FAILED: fal.ai error \${r.status}\`);\n  return r.json();\n}\nimport { fal } from "@fal-ai/client";\nexport const gen = (prompt: string) => fal.subscribe("fal-ai/flux/dev", { input: { prompt } });\n`,
    });
    expect(surface.sinks.some((x) => x.line === 3)).toBe(false);
  });

  it("ranks a free-text call above a structured router call to the same provider", async () => {
    const { genai: fs } = await run({
      "apps/api/src/services/assistant/claude.ts": `import Anthropic from "@anthropic-ai/sdk";\nconst anthropic = new Anthropic();\nexport const route = (q: string) => anthropic.messages.create({ model: "claude-haiku-4-5", max_tokens: 50, tool_choice: { type: "tool", name: "route" }, messages: [{ role: "user", content: q }] });\n`,
      "apps/api/src/services/assistant/composer.ts": `import Anthropic from "@anthropic-ai/sdk";\nconst anthropic = new Anthropic();\nexport const compose = (q: string) => anthropic.messages.create({ model: "claude-sonnet-4-5", max_tokens: 400, messages: [{ role: "user", content: q }] });\n`,
    });
    const f = fs.find((x) => x.rule === "genai.no_moderation");
    expect(f?.file).toBe("apps/api/src/services/assistant/composer.ts");
  });

  it("treats a URL constant line as a mention, so a real call is the anchor", async () => {
    const { surface } = await run({
      "lib/engine/API/DefaultAPI.ts": `export const defaults = {\n  name: "openai",\n  endpoint: "https://api.openai.com/v1/chat/completions",\n};\nexport const go = () => fetch(defaults.endpoint);\n`,
    });
    expect(surface.sinks.find((x) => x.line === 3)?.mention).toBe(true);
  });
});

// Dogfood (real app): a missing manifest is not medium when nothing requires one.
describe("privacy_manifest.missing severity", () => {
  it("is info for a Swift app with no required-reason API and no tracking SDK", async () => {
    const r = await privacy.run(await ctxFromFiles({ "App/App.swift": "@main struct A: App {}" }));
    expect(r.findings.map((f) => [f.rule, f.severity])).toEqual([["privacy_manifest.missing", "info"]]);
  });

  it("stays medium when a required-reason API is used", async () => {
    const r = await privacy.run(await ctxFromFiles({ "App/App.swift": `@main struct A: App {}\nlet seen = UserDefaults.standard.bool(forKey: "s")` }));
    expect(r.findings.find((f) => f.rule === "privacy_manifest.missing")?.severity).toBe("medium");
  });
});

// Dogfood (real app): three hardcoded prices on one line were three findings.
describe("paywall.hardcoded_price per line", () => {
  it("merges price literals on the same line into one finding", async () => {
    const r = await paywall.run(
      await ctxFromFiles({
        "Wedge/PaywallPricing.swift": `import StoreKit\nstruct PaywallPricing {\n  let monthly: String; let yearly: String; let trial: String\n  static let fallback = PaywallPricing(monthly: "£7.99", yearly: "£59.99", trial: "£5.00")\n  func buy(_ p: Product) async throws { _ = try await p.purchase() }\n}\n`,
      }),
    );
    const prices = r.findings.filter((f) => f.rule === "paywall.hardcoded_price");
    expect(prices.length).toBe(1);
    expect(prices[0]?.why).toMatch(/£7\.99.*£59\.99.*£5\.00/);
  });
});

// Dogfood (real app): severity of genai.no_moderation for hosted text.
describe("genai.no_moderation calibration for hosted text over REST", () => {
  const worker = (body: string) =>
    `export class Provider {\n  async respond(input, signal) {\n    const response = await this.transport('https://api.openai.com/v1/responses', {\n      method: 'POST',\n      body: JSON.stringify({ model: this.env.AI_MODEL, input, ${body} }),\n      signal,\n    });\n    return response.json();\n  }\n}\n`;
  const sev = (fs: Finding[]) => fs.find((f) => f.rule === "genai.no_moderation")?.severity;

  it("is medium for a Responses API call with forced tool output", async () => {
    const { genai: fs, surface } = await run({ "ai-worker/src/provider.js": worker("tools, tool_choice: 'required'") });
    expect(surface.sinks.find((x) => x.file === "ai-worker/src/provider.js")?.kind).toBe("text");
    expect(sev(fs)).toBe("medium");
  });

  it("stays high for a streamed free-text reply", async () => {
    expect(sev((await run({ "ai-worker/src/provider.js": worker("stream: true") })).genai)).toBe("high");
  });

  it("an images endpoint on the same host is image generation", async () => {
    const { surface } = await run({ "worker/img.ts": `export const gen = (p: string) => fetch("https://api.openai.com/v1/images/generations", { method: "POST", body: JSON.stringify({ prompt: p }) });\n` });
    expect(surface.hasImageGenerator).toBe(true);
  });

  it("a moderation or model-list URL is not a generation sink", async () => {
    const { surface } = await run({ "worker/mod.ts": `const MODERATION_URL = "https://api.openai.com/v1/moderations";\nconst MODELS = "https://api.openai.com/v1/models";\nexport const m = (t: string) => fetch(MODERATION_URL, { method: "POST", body: t });\n` });
    expect(surface.sinks).toEqual([]);
  });

  it("a notification job's companionOk flag is not persona chat", async () => {
    const acme = `import Anthropic from "@anthropic-ai/sdk";\nconst client = new Anthropic();\nexport async function tip(q: string) {\n  let companionOk = false;\n  let companionSent = 0;\n  return client.messages.create({ model: "claude-sonnet-4-5", max_tokens: 300, output_config: { format: { type: "json_schema", schema } }, messages: [{ role: "user", content: q }] });\n}\n`;
    expect(sev((await run({ "apps/api/src/claude.ts": acme })).genai)).toBe("medium");
  });
});

describe("chat display anchors", () => {
  const api = `import Foundation\nfunc ask(_ q: String) async throws {\n  var r = URLRequest(url: URL(string: "https://api.openai.com/v1/chat/completions")!)\n  r.httpMethod = "POST"\n  _ = try await URLSession.shared.data(for: r)\n}\n`;
  it("anchors ugc.no_report on the chat screen, not a screenshot scene", async () => {
    const { ugc: fs } = await run({
      "Till/AI/Ask.swift": api,
      "Till/Views/Companion/AskKashView.swift": `import SwiftUI\nstruct AskKashView: View {\n  let messages: [Msg]\n  var body: some View {\n    ForEach(messages) { message in CompanionMessageText(message: message) }\n  }\n}\n`,
      "Till/Views/Companion/CompanionScreenshotScene.swift": `import SwiftUI\nstruct CompanionScreenshotScene: View {\n  let messages: [Msg]\n  var body: some View { ForEach(messages) { message in Text(message.text) } }\n}\n`,
    });
    expect(fs.find((f) => f.rule === "ugc.no_report")?.file).toBe("Till/Views/Companion/AskKashView.swift");
  });

  it("anchors on a llama.rn completion call, not an embeddings screen import", async () => {
    const { genai: fs } = await run({
      "app/screens/EmbeddingScreen.tsx": `import { initLlama } from 'llama.rn'\nexport const Embed = () => null\n`,
      "lib/engine/Local/LlamaLocal.ts": `import { initLlama } from 'llama.rn'\nexport async function gen(ctx: any, params: any) {\n  return ctx\n    .completion(params, (data: any) => data)\n}\n`,
    });
    const f = fs.find((x) => x.rule === "genai.no_moderation");
    expect(f?.file).toBe("lib/engine/Local/LlamaLocal.ts");
    expect(f?.line).toBe(4);
  });
});

describe("privacy_manifest.missing for web-view frameworks", () => {
  it("stays medium for a Capacitor app, whose runtime uses required-reason APIs", async () => {
    const r = await privacy.run(
      await ctxFromFiles({
        "package.json": JSON.stringify({ dependencies: { "@capacitor/core": "6.0.0", "@capacitor/ios": "6.0.0" } }),
        "ios/App/App.xcodeproj/project.pbxproj": "// !$*UTF8*$!\n{ }\n",
        "ios/App/App/AppDelegate.swift": "import UIKit\n",
      }),
    );
    expect(r.findings.find((f) => f.rule === "privacy_manifest.missing")?.severity).toBe("medium");
  });
});

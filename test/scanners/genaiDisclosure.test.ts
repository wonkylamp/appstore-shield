import { describe, expect, it } from "vitest";
import { check } from "../../src/scanners/aiDataDisclosure.js";
import { ctxFromFiles } from "../helpers.js";

async function run(files: Record<string, string>) {
  const res = await check.run(await ctxFromFiles(files));
  return { findings: res.findings, rules: res.findings.map((f) => f.rule), data: res.data ?? {} };
}

const photoToFal = `import { fal } from "@fal-ai/client";\nimport * as ImagePicker from "expo-image-picker";\nexport async function stylize() {\n  const r = await ImagePicker.launchImageLibraryAsync({});\n  return fal.subscribe("fal-ai/flux/dev/image-to-image", { input: { image_url: r.assets[0].uri } });\n}`;

describe("ai_data_disclosure", () => {
  it("flags user photos sent to a cloud AI host with no disclosure", async () => {
    const { findings } = await run({ "src/stylize.ts": photoToFal });
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.severity).toBe("high");
    expect(f.guideline).toBe("5.1.2(i)");
    expect(f.why).toMatch(/fal\.ai/);
    expect(f.fix).toMatch(/^Disclose/);
  });

  it("accepts an in-app string naming the AI provider and the sharing", async () => {
    const { findings } = await run({
      "src/stylize.ts": photoToFal,
      "src/Consent.tsx": `export const Consent = () => (<View><Text>Your photo is sent to fal.ai, a third-party AI service, to create your portrait.</Text><Button title="Agree" /></View>);`,
    });
    expect(findings).toHaveLength(0);
  });

  it("accepts persisted AI consent such as @AppStorage(\"aiConsent\")", async () => {
    const { findings, data } = await run({
      "App/Gen.swift": `import SwiftUI\nimport OpenAI\nstruct Gen: View {\n  @AppStorage("aiConsent") var aiConsent = false\n  var body: some View { PhotosPicker("Pick", selection: $item) }\n  func go() async throws { _ = try await openAI.imageEdits(query: q) }\n}`,
    });
    expect(findings).toHaveLength(0);
    expect((data.consent as unknown[]).length).toBeGreaterThan(0);
  });

  it("accepts a Localizable.strings disclosure", async () => {
    const { findings } = await run({
      "App/Chat.swift": `import OpenAI\nstruct Chat: View { @State var t = ""; var body: some View { TextField("Ask", text: $t) }\n func send() async throws { _ = try await openAI.chats(query: q) } }`,
      "App/en.lproj/Localizable.strings": `"ai_notice" = "Messages you type are sent to OpenAI to generate replies.";`,
    });
    expect(findings).toHaveLength(0);
  });

  it("flags typed text sent to a chat model without disclosure", async () => {
    const { findings } = await run({
      "App/Chat.swift": `import OpenAI\nstruct Chat: View { @State var t = ""; var body: some View { TextField("Ask", text: $t) }\n func send() async throws { _ = try await openAI.chats(query: q) } }`,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.why).toMatch(/text/);
  });

  it("does not count unrelated consent or AI-free prose", async () => {
    const { findings } = await run({
      "src/stylize.ts": photoToFal,
      "src/Settings.tsx": `const [emailConsent, setEmailConsent] = useState(false);\nconst said = "We said we would send you a newsletter";\nconst brand = "Powered by fal.ai";`,
    });
    expect(findings).toHaveLength(1);
  });

  it("does not fire for on-device models", async () => {
    const { findings, data } = await run({
      "App/Assist.swift": `import FoundationModels\nstruct A: View { @State var t = ""; var body: some View { TextField("Ask", text: $t) } }\nlet r = try await LanguageModelSession().respond(to: t)`,
    });
    expect(findings).toHaveLength(0);
    expect(data.applies).toBe(false);
  });

  it("does not fire when a cloud AI is used but no user input is collected", async () => {
    const { findings } = await run({ "server/quote.ts": `import OpenAI from "openai";\nexport const daily = () => client.chat.completions.create({ model, messages: [{ role: "user", content: "A quote" }] });` });
    expect(findings).toHaveLength(0);
  });

  it("flags voice recordings sent to a cloud speech service", async () => {
    const { findings } = await run({
      "App/Voice.swift": `import AVFoundation\nlet rec = try AVAudioRecorder(url: u, settings: [:])\nlet url = URL(string: "https://api.elevenlabs.io/v1/speech-to-text")!`,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.why).toMatch(/voice/);
  });
});

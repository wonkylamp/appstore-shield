import { describe, expect, it } from "vitest";
import { check } from "../../src/scanners/genaiSafety.js";
import { ctxFromFiles } from "../helpers.js";

const gemini = `
let safety = [["category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_MEDIUM_AND_ABOVE"]]
func chat(_ text: String) async throws {
  var req = URLRequest(url: URL(string: "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent")!)
  req.httpBody = try JSONSerialization.data(withJSONObject: ["contents": text, "safetySettings": safety])
  _ = try await URLSession.shared.data(for: req)
}
`;
const replicate = `
func generate(prompt: String) async throws {
  var req = URLRequest(url: URL(string: "https://api.replicate.com/v1/predictions")!)
  req.httpBody = try JSONSerialization.data(withJSONObject: ["input": ["prompt": prompt]])
  _ = try await URLSession.shared.data(for: req)
}
`;

const rules = async (files: Record<string, string>) => (await check.run(await ctxFromFiles(files))).findings.map((f) => f.rule);

describe("genai.no_moderation with provider-scoped safety settings", () => {
  it("flags a second generator that a Gemini safety setting does not cover", async () => {
    const r = await check.run(await ctxFromFiles({ "Sources/Chat.swift": gemini, "Sources/Images.swift": replicate }));
    const f = r.findings.find((x) => x.rule === "genai.no_moderation");
    expect(f?.file).toBe("Sources/Images.swift");
  });

  it("does not flag a Gemini-only app whose safety settings block", async () => {
    expect(await rules({ "Sources/Chat.swift": gemini })).not.toContain("genai.no_moderation");
  });

  it("does not flag when an app-wide moderation call exists", async () => {
    const mod = `func check(_ t: String) async throws { _ = try await openAI.moderations(query: ModerationsQuery(input: t)) }`;
    expect(await rules({ "Sources/Chat.swift": gemini, "Sources/Images.swift": replicate, "Sources/Mod.swift": mod })).not.toContain("genai.no_moderation");
  });
});

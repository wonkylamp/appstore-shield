import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MetadataSnapshot } from "../../src/ledger/schema.js";
import { check, metadataTexts } from "../../src/scanners/metadata.js";
import { ctxFromFiles } from "../helpers.js";

async function scan(files: Record<string, string>) {
  const ctx = await ctxFromFiles(files);
  return { ctx, result: await check.run(ctx) };
}
const pairs = (r: { findings: { rule: string; severity: string }[] }) => r.findings.map((f) => [f.rule, f.severity]);

const plist = (entries: Record<string, string>) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${Object.entries(entries).map(([k, v]) => `\t<key>${k}</key>\n\t<string>${v}</string>`).join("\n")}
\t<key>UIApplicationSupportsIndirectInputEvents</key>
\t<true/>
</dict>
</plist>
`;

describe("metadata", () => {
  it("flags fastlane field limits", async () => {
    const { result } = await scan({
      "fastlane/metadata/en-US/name.txt": "Snapcook Recipe Planner And Grocery List\n",
      "fastlane/metadata/en-US/subtitle.txt": "Plan meals, shop smarter, cook more often",
      "fastlane/metadata/ja/keywords.txt": "レシピ,料理,献立,買い物リスト,食事計画,健康,簡単,時短,節約,家族,作り置き,お弁当",
      "fastlane/metadata/en-US/promotional_text.txt": "x".repeat(171),
      "fastlane/metadata/en-US/description.txt": "Plan your week.",
    });
    const limits = result.findings.filter((f) => f.rule === "metadata.field_limit");
    expect(limits.map((f) => f.file).sort()).toEqual([
      "fastlane/metadata/en-US/name.txt",
      "fastlane/metadata/en-US/promotional_text.txt",
      "fastlane/metadata/en-US/subtitle.txt",
    ]);
    expect(limits.every((f) => f.severity === "high")).toBe(true);
  });

  // Field: Pocket Casts uploads 80-char/198-byte ja and 100-char/102-byte es-ES keyword sets that ASC accepts.
  it("counts keywords in characters, not UTF-8 bytes", async () => {
    const ja = "ポッドキャスト,ラジオ,音声,番組,ニュース,音楽,オーディオ,エピソード,購読,再生,プレーヤー,オフライン,ダウンロード,話題,学習,英語,";
    const es = "podcast,radio,audio,episodios,música,noticias,reproductor,suscripción,descargas,programas,álbum,ok";
    const { result } = await scan({
      "fastlane/metadata/ja/keywords.txt": ja,
      "fastlane/metadata/es-ES/keywords.txt": es,
      "fastlane/metadata/en-US/keywords.txt": "x,".repeat(50) + "y",
    });
    expect([...ja].length).toBeLessThanOrEqual(100);
    expect(Buffer.byteLength(ja)).toBeGreaterThan(100);
    expect([...es].length).toBeLessThanOrEqual(100);
    expect(Buffer.byteLength(es)).toBeGreaterThan(100);
    const high = result.findings.filter((f) => f.severity === "high");
    expect(high.map((f) => f.file)).toEqual(["fastlane/metadata/en-US/keywords.txt"]);
    expect(high[0]!.why).toContain("101 characters");
    const notes = result.findings.filter((f) => f.rule === "metadata.keywords_bytes_note");
    expect(notes.map((f) => [f.file, f.severity]).sort()).toEqual([
      ["fastlane/metadata/es-ES/keywords.txt", "info"],
      ["fastlane/metadata/ja/keywords.txt", "info"],
    ]);
  });

  it("passes clean fastlane metadata and snapshots it", async () => {
    const { result } = await scan({
      "fastlane/metadata/en-US/name.txt": "Snapcook",
      "fastlane/metadata/en-US/subtitle.txt": "Weekly meal planner",
      "fastlane/metadata/en-US/keywords.txt": "recipes,meal plan,grocery list",
      "fastlane/metadata/en-US/description.txt": "Plan your week of meals.",
      "fastlane/metadata/review_information/notes.txt": "Demo account in notes",
    });
    expect(result.findings).toEqual([]);
    const snaps = result.data?.snapshots as MetadataSnapshot[];
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({
      locale: "en-US",
      name: "Snapcook",
      subtitle: "Weekly meal planner",
      keywords: "recipes,meal plan,grocery list",
      descriptionHash: createHash("sha256").update("Plan your week of meals.").digest("hex"),
    });
    expect(snaps[0]!.source).toContain("fastlane/metadata/en-US/name.txt");
  });

  it("reads the asc canonical layout, latest version only", async () => {
    const { result } = await scan({
      "metadata/app-info/en-US.json": JSON.stringify({ name: "PhotoAI", subtitle: "Uncensored AI art", privacyPolicyUrl: "" }, null, 2),
      "metadata/version/1.0.0/en-US.json": JSON.stringify({ description: "", keywords: "chatgpt,nsfw", promotionalText: "", whatsNew: "" }),
      "metadata/version/1.10.0/en-US.json": JSON.stringify({ description: "Make art.", keywords: "art,photo", promotionalText: "", whatsNew: "" }),
      "metadata/version/1.9.0/en-US.json": JSON.stringify({ description: "", keywords: "midjourney", promotionalText: "", whatsNew: "" }),
    });
    expect(pairs(result)).toEqual([["metadata.content_signal_claim", "medium"]]);
    expect(result.findings[0]!.file).toBe("metadata/app-info/en-US.json");
    expect(result.findings[0]!.line).toBe(3);
    const snaps = result.data?.snapshots as MetadataSnapshot[];
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ locale: "en-US", name: "PhotoAI", keywords: "art,photo" });
    expect(snaps[0]!.source).toBe("metadata/app-info/en-US.json + metadata/version/1.10.0/en-US.json");
  });

  it("flags third-party brands and prices in name, subtitle and keywords", async () => {
    const { result } = await scan({
      "fastlane/metadata/en-US/name.txt": "AI Chat with ChatGPT",
      "fastlane/metadata/en-US/subtitle.txt": "Pro features for $4.99",
      "fastlane/metadata/en-US/keywords.txt": "gemini ai,assistant,tiktok",
    });
    expect(pairs(result).sort()).toEqual([
      ["metadata.price_in_metadata", "high"],
      ["metadata.third_party_brand", "high"],
      ["metadata.third_party_brand", "high"],
    ]);
    const kw = result.findings.find((f) => f.file.endsWith("keywords.txt"))!;
    expect(kw.why).toContain("TikTok");
    expect(kw.why).toContain("Gemini");
    for (const f of result.findings) expect(f.fix).not.toMatch(/\b(rename|move|hide)\b/i);
  });

  it("does not treat zodiac Gemini or brand-like words without AI context as brands", async () => {
    const { result } = await scan({
      "fastlane/metadata/en-US/name.txt": "Gemini Daily Horoscope",
      "fastlane/metadata/en-US/keywords.txt": "astrology,zodiac,gemini,leo,claude monet",
      "fastlane/metadata/en-US/description.txt": "The best horoscope app. Works great alongside Instagram stories.",
    });
    expect(result.findings).toEqual([]);
  });

  it("flags strong claims in the description but not plain marketing words", async () => {
    const { result } = await scan({
      "fastlane/metadata/en-US/description.txt": "The best way to chat. Number one for planning.",
    });
    expect(pairs(result)).toEqual([["metadata.unverifiable_claim", "medium"]]);
  });

  it("reports content-signalling claims separately, under 1.1/1.2, at medium without generated or user content", async () => {
    const { result } = await scan({
      "fastlane/metadata/en-US/description.txt": "The best way to chat. No filters, totally uncensored.",
    });
    expect(pairs(result)).toEqual([["metadata.content_signal_claim", "medium"]]);
    expect(result.findings[0]!.guideline).toBe("2.3.14, 1.1, 1.2");
  });

  // Field (indie-dev r4): "Uncensored" in an AI companion's name ranked below paywall findings despite an open 1.2 rejection.
  it("raises content-signalling claims to high in an app that generates content, so an open 1.2 rejection holds on them", async () => {
    const { result } = await scan({
      "fastlane/metadata/en-US/name.txt": "AI Girlfriend Uncensored",
      "Sources/AI/CompanionChat.swift": `struct CompanionChat {\n  let endpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent"\n}\n`,
    });
    const f = result.findings.find((x) => x.rule === "metadata.content_signal_claim");
    expect(f?.severity).toBe("high");
    expect(f?.guideline).toBe("2.3.7, 1.1, 1.2");
    expect(f?.fix).toMatch(/^Remove "Uncensored"/);
    // Field (fidelity-ethics r7): relabelling alone while the output stays unfiltered is cosmetic.
    expect(f?.fix).toMatch(/remove or filter the capability itself/);
    expect(f?.why).not.toMatch(/likely to repeat/);
    expect(f?.why).toMatch(/what the app actually does/);
    const { guidelineWithin } = await import("../../src/preflight.js");
    expect(guidelineWithin(f!.guideline, "1.2")).toBe(true);
    expect(guidelineWithin(f!.guideline, "1.1")).toBe(true);
  });

  it("flags placeholder and generic purpose strings in Info.plist", async () => {
    const { result } = await scan({
      "App/Info.plist": plist({
        CFBundleDisplayName: "Snapcook",
        CFBundleName: "$(PRODUCT_NAME)",
        NSCameraUsageDescription: "TODO",
        NSMicrophoneUsageDescription: "We need access to your microphone",
        NSPhotoLibraryUsageDescription: "We need access to your photos to attach pictures to recipes.",
        NSLocationWhenInUseUsageDescription: "Used to find grocery stores near you.",
      }),
      "App/App.swift": "@main struct A: App {}",
    });
    expect(pairs(result)).toEqual([
      ["metadata.placeholder_purpose_string", "medium"],
      ["metadata.placeholder_purpose_string", "medium"],
    ]);
    expect(result.findings.map((f) => f.evidence?.split(" ")[0])).toEqual(["NSCameraUsageDescription", "NSMicrophoneUsageDescription"]);
    expect(result.findings[0]!.line).toBe(9);
  });

  // Field (field-test r7): "needs permission to save pages" was read as naming the resource only.
  it("keeps a 'to <verb>' purpose clause after a permission lead, and still flags resource-only strings", async () => {
    const { result } = await scan({
      "App/Info.plist": plist({
        NSPhotoLibraryAddUsageDescription: "Aidoku needs permission to save pages in your photo library",
        NSLocationWhenInUseUsageDescription: "Allow MyApp to access your location",
        NSMicrophoneUsageDescription: "MyApp needs access to your microphone",
        NSCameraUsageDescription: "Receipts needs access to scan the receipts you choose to add",
      }),
      "App/App.swift": "@main struct A: App {}",
    });
    expect(result.findings.map((f) => f.evidence?.split(" ")[0]).sort()).toEqual(["NSLocationWhenInUseUsageDescription", "NSMicrophoneUsageDescription"]);
  });

  it("reads generated INFOPLIST_KEY_* settings from project.pbxproj", async () => {
    const { result, ctx } = await scan({
      "App.xcodeproj/project.pbxproj": `\t\t\t\tINFOPLIST_KEY_CFBundleDisplayName = "ChatGPT Pro";\n\t\t\t\tINFOPLIST_KEY_NSPhotoLibraryUsageDescription = "";\n\t\t\t\tINFOPLIST_KEY_NSCameraUsageDescription = "Scan recipe cards you choose to import.";\n\t\t\t\tINFOPLIST_KEY_NSPhotoLibraryUsageDescription = "";\n`,
    });
    expect(pairs(result).sort()).toEqual([
      ["metadata.placeholder_purpose_string", "medium"],
      ["metadata.third_party_brand", "high"],
    ]);
    expect(metadataTexts(ctx).filter((t) => t.field === "usageDescription")).toHaveLength(2);
  });

  it("reads Expo app.json name, infoPlist and plugin permission strings", async () => {
    const { result, ctx } = await scan({
      "package.json": JSON.stringify({ dependencies: { expo: "~52.0.0", "react-native": "0.76.0" } }),
      "app.json": JSON.stringify(
        {
          expo: {
            name: "Snapcook",
            ios: { infoPlist: { NSCameraUsageDescription: "Take photos of dishes to add them to your recipes." } },
            plugins: [["expo-image-picker", { photosPermission: "Allow $(PRODUCT_NAME) to access your photos" }]],
          },
        },
        null,
        2,
      ),
    });
    expect(pairs(result)).toEqual([["metadata.placeholder_purpose_string", "medium"]]);
    expect(result.findings[0]!.evidence).toContain("expo-image-picker.photosPermission");
    const texts = metadataTexts(ctx);
    expect(texts.find((t) => t.field === "displayName")).toMatchObject({ text: "Snapcook", file: "app.json", surface: "bundle" });
  });

  it("exposes store texts for residue sweeps", async () => {
    const { ctx } = await scan({
      "fastlane/metadata/de-DE/description.txt": "Outfits inklusive Dessous",
      "metadata/version/2.0/en-US.json": JSON.stringify({ promotionalText: "New lingerie outfits!" }),
    });
    const texts = metadataTexts(ctx);
    expect(texts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: "fastlane/metadata/de-DE/description.txt", field: "description", locale: "de-DE", text: "Outfits inklusive Dessous" }),
        expect.objectContaining({ file: "metadata/version/2.0/en-US.json", field: "promotionalText", locale: "en-US", text: "New lingerie outfits!" }),
      ]),
    );
  });

  it("flags 'free' in a subtitle at medium", async () => {
    const { result } = await scan({ "fastlane/metadata/en-US/subtitle.txt": "Free meal planner" });
    expect(pairs(result)).toEqual([["metadata.price_in_metadata", "medium"]]);
  });
});

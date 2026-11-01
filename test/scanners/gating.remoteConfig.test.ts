import { describe, expect, it } from "vitest";
import { check as remoteConfig, isConfigUrl, type RemoteControlEntry } from "../../src/scanners/remoteConfig.js";
import { RemoteControl } from "../../src/ledger/schema.js";
import { ctxFromFiles } from "../helpers.js";

async function scan(files: Record<string, string>) {
  const r = await remoteConfig.run(await ctxFromFiles(files));
  return { ...r, inventory: (r.data?.inventory ?? []) as RemoteControlEntry[] };
}
const entry = (inv: RemoteControlEntry[], key: string) => inv.find((e) => e.key === key);
const FIX = "Remove the remote switch, or disclose it specifically in Notes for Review (2.3.1(a), 2.5.19).";

describe("remote_config", () => {
  it("inventories a Firebase Swift flag that gates adult content, with its plist default", async () => {
    const r = await scan({
      "App/Flags.swift": `import FirebaseRemoteConfig\nlet rc = RemoteConfig.remoteConfig()\nfunc setup() {\n  rc.setDefaults(fromPlist: "RemoteConfigDefaults")\n}\nstruct Picker: View {\n  var body: some View {\n    if rc["spicy_mode"].boolValue {\n      LingeriePicker()\n    }\n  }\n}\n`,
      "App/RemoteConfigDefaults.plist": `<?xml version="1.0"?>\n<plist version="1.0"><dict>\n<key>spicy_mode</key><false/>\n</dict></plist>\n`,
    });
    const e = entry(r.inventory, "spicy_mode");
    expect(e?.provider).toBe("Firebase Remote Config");
    expect(e?.classification).toBe("content-gating");
    expect(e?.defaultValue).toBe("false");
    expect(e?.readSites).toEqual([{ file: "App/Flags.swift", line: 8 }]);
    const f = r.findings.find((x) => x.rule === "remote_config.content_gating");
    // A server switch over adult content can only be fixed by deleting it.
    expect(f?.severity).toBe("block");
    expect(f?.suppressible).toBe(false);
    expect(f?.fix).toMatch(/^Delete the flag and the adult or nudification content it gates\./);
    expect(f?.fix).not.toMatch(/disclose it/i);
    // The inventory must stay compatible with the ledger schema.
    expect(RemoteControl.safeParse(e).success).toBe(true);
  });

  it("classifies a JS kill switch around a generator as safety-killswitch (info)", async () => {
    const r = await scan({
      "src/gen.ts": `import remoteConfig from '@react-native-firebase/remote-config'\nexport async function run(prompt: string) {\n  if (remoteConfig().getValue('generation_disabled').asBoolean()) {\n    return showMaintenance()\n  }\n  return generateImage(prompt)\n}\n`,
    });
    expect(entry(r.inventory, "generation_disabled")?.classification).toBe("safety-killswitch");
    expect(r.findings.map((f) => `${f.rule}:${f.severity}`)).toEqual(["remote_config.inventory:info"]);
  });

  it("flags a remote switch over moderation as content-gating", async () => {
    const r = await scan({
      "src/mod.ts": `import remoteConfig from '@react-native-firebase/remote-config'\nexport async function send(text: string) {\n  if (remoteConfig().getBoolean('moderation_enabled')) {\n    await moderate(text)\n  }\n}\n`,
    });
    expect(entry(r.inventory, "moderation_enabled")?.classification).toBe("content-gating");
    // Not adult content itself: stays high, suppressible, with the remove-or-disclose fix.
    const f = r.findings.find((x) => x.rule === "remote_config.content_gating");
    expect(f?.severity).toBe("high");
    expect(f?.suppressible).toBe(true);
    expect(f?.fix).toBe(FIX);
  });

  it("flags LaunchDarkly price gating as high (3.1.2) and records the default", async () => {
    const r = await scan({
      "App/Pay.swift": `import LaunchDarkly\nfunc maybePaywall() {\n  if LDClient.get()!.boolVariation(forKey: "hard-paywall", defaultValue: false) {\n    presentPaywall()\n  }\n}\n`,
    });
    const e = entry(r.inventory, "hard-paywall");
    expect(e?.classification).toBe("price-gating");
    expect(e?.defaultValue).toBe("false");
    const f = r.findings.find((x) => x.rule === "remote_config.price_gating");
    expect(f?.severity).toBe("high");
    expect(f?.guideline).toBe("3.1.2");
  });

  it("follows a PostHog flag through a variable into JSX", async () => {
    const r = await scan({
      "src/Home.tsx": `import { useFeatureFlagEnabled } from 'posthog-react-native'\nexport function Home() {\n  const showGf = useFeatureFlagEnabled('ai-girlfriend')\n  return (<View>{showGf && (<CompanionChat />)}</View>)\n}\n`,
    });
    const e = entry(r.inventory, "ai-girlfriend");
    expect(e?.provider).toBe("PostHog");
    expect(e?.classification).toBe("content-gating");
  });

  it("rates an ordinary product flag info and keeps it in the inventory", async () => {
    const r = await scan({
      "src/Onboarding.tsx": `import Statsig from 'statsig-react-native'\nexport function next(navigation) {\n  if (Statsig.checkGate('new_onboarding')) {\n    navigation.navigate('OnboardingV2')\n  }\n}\n`,
    });
    expect(entry(r.inventory, "new_onboarding")?.classification).toBe("product");
    expect(r.findings.every((f) => f.severity === "info")).toBe(true);
  });

  it("reads custom JSON config from workers.dev and classifies its fields", async () => {
    const r = await scan({
      "src/config.ts": `export async function Outfits() {\n  const res = await fetch("https://cfg.myapp.workers.dev/config.json")\n  const config = await res.json()\n  if (config.showSpicy) {\n    return <SpicyOutfits />\n  }\n  return null\n}\n`,
    });
    const e = entry(r.inventory, "showSpicy");
    expect(e?.provider).toBe("Custom JSON (cfg.myapp.workers.dev)");
    expect(e?.classification).toBe("content-gating");
  });

  it("does not inventory API calls to workers.dev or ordinary dictionaries", async () => {
    const r = await scan({
      "src/ai.ts": `export const gen = (p: string) => fetch("https://ai.myapp.workers.dev/generate", { method: "POST", body: p })\n`,
      "App/Dict.swift": `let config: [String: String] = ["theme": "dark"]\nif config["theme"] == "dark" { applyDark() }\n`,
    });
    expect(r.inventory).toEqual([]);
    expect(r.findings).toEqual([]);
  });

  it("falls back to the key name only at low confidence, and to unknown otherwise", async () => {
    const r = await scan({
      "App/K.swift": `import FirebaseRemoteConfig\nlet rc = RemoteConfig.remoteConfig()\nlet a = rc["nsfw_enabled"].boolValue\nlet b = rc["welcome_copy"].stringValue\n`,
    });
    expect(entry(r.inventory, "nsfw_enabled")?.classification).toBe("content-gating");
    expect(r.findings.find((f) => f.rule === "remote_config.content_gating")?.confidence).toBe("low");
    expect(entry(r.inventory, "welcome_copy")?.classification).toBe("unknown");
  });

  it("lists RevenueCat remote paywalls as product, not price-gating", async () => {
    const r = await scan({
      "App/Paywall.swift": `import RevenueCat\nimport RevenueCatUI\nstruct Root: View {\n  var body: some View {\n    ContentView().presentPaywallIfNeeded(requiredEntitlementIdentifier: "pro")\n  }\n}\n`,
    });
    expect(r.inventory[0]?.provider).toBe("RevenueCat Paywalls");
    expect(r.inventory[0]?.classification).toBe("product");
    expect(r.findings.some((f) => f.severity === "high")).toBe(false);
  });

  it("skips flag reads compiled only into debug builds", async () => {
    const r = await scan({
      "App/D.swift": `import FirebaseRemoteConfig\n#if DEBUG\nfunc d() { if rc["nsfw_preview"].boolValue { showNSFW() } }\n#endif\n`,
    });
    expect(r.inventory).toEqual([]);
  });

  it("attributes GrowthBook, Superwall and Supabase-table reads to their providers", async () => {
    const r = await scan({
      "src/gb.tsx": `import { useFeatureIsOn } from '@growthbook/growthbook-react'\nexport function Studio() {\n  const on = useFeatureIsOn('bikini-styles')\n  return on ? <BikiniStyles /> : null\n}\n`,
      "App/SW.swift": `import SuperwallKit\nfunc gate() {\n  Superwall.shared.register(placement: "campaign_trigger") {\n    openEditor()\n  }\n}\n`,
      "src/cfg.ts": `export async function load() {\n  const { data: flags } = await supabase.from('feature_flags').select('*')\n  return flags\n}\n`,
    });
    expect(entry(r.inventory, "bikini-styles")).toMatchObject({ provider: "GrowthBook", classification: "content-gating" });
    expect(entry(r.inventory, "campaign_trigger")).toMatchObject({ provider: "Superwall", classification: "product" });
    expect(entry(r.inventory, "feature_flags")?.provider).toBe("Custom config (Supabase table)");
  });

  it("rates a key by its strongest use, whatever order the files are read in", async () => {
    const gen = `import remoteConfig from '@react-native-firebase/remote-config'\nexport async function make() {\n  if (remoteConfig().getValue('extra_mode').asBoolean()) {\n    await openai.images.generate({ prompt })\n  }\n}\n`;
    const adult = `import remoteConfig from '@react-native-firebase/remote-config'\nexport function presets(list: string[]) {\n  if (remoteConfig().getValue('extra_mode').asBoolean()) {\n    list.push('nude')\n  }\n}\n`;
    for (const files of [{ "src/a.ts": gen, "src/b.ts": adult }, { "src/z.ts": gen, "src/b.ts": adult }]) {
      const r = await scan(files);
      const fs = r.findings.filter((f) => f.rule === "remote_config.content_gating");
      expect(fs).toHaveLength(1);
      expect(fs[0]).toMatchObject({ severity: "block", file: "src/b.ts", suppressible: false });
    }
  });

  it("keeps a generator-only key high when no read gates adult content", async () => {
    const gen = `import remoteConfig from '@react-native-firebase/remote-config'\nexport async function make() {\n  if (remoteConfig().getValue('extra_mode').asBoolean()) {\n    await openai.images.generate({ prompt })\n  }\n}\n`;
    const r = await scan({ "src/a.ts": gen, "src/b.ts": gen.replace("make", "make2") });
    expect(r.findings.filter((f) => f.rule === "remote_config.content_gating").map((f) => f.severity)).toEqual(["high"]);
  });

  it("does not skip reads under #if DEBUG || X, which also compiles into release", async () => {
    const src = (cond: string) => `import FirebaseRemoteConfig\nstruct Flags: View {\n  var body: some View {\n#if ${cond}\n    if RemoteConfig.remoteConfig()["spicy_mode"].boolValue { Text("Lingerie outfit") }\n#endif\n  }\n}\n`;
    expect((await scan({ "Sources/Flags.swift": src("DEBUG || INTERNAL") })).findings.map((f) => `${f.rule}:${f.severity}`)).toContain("remote_config.content_gating:block");
    expect((await scan({ "Sources/Flags.swift": src("DEBUG") })).findings).toEqual([]);
  });
});

describe("remote_config cost on malformed and large files", () => {
  const cpu = async (fn: () => Promise<unknown>) => {
    const t = process.cpuUsage();
    await fn();
    const d = process.cpuUsage(t);
    return (d.user + d.system) / 1000;
  };

  it("stays linear when unclosed brackets make every read's scope run to the end of the file", async () => {
    const unit = 'if (remoteConfig().getValue("x").asBoolean() && ';
    const ctx = await ctxFromFiles({ "Sources/x.swift": unit.repeat(Math.ceil((200 * 1024) / unit.length)) });
    // Before the per-file trace budget and the opener cap this took over a minute of CPU.
    expect(await cpu(() => remoteConfig.run(ctx))).toBeLessThan(10_000);
  }, 60_000);

  it("says when a read was left untraced because the file exhausted its trace budget", async () => {
    const src = Array.from({ length: 3000 }, (_, i) => `if (remoteConfig().getValue("k${i}").asBoolean() && `).join("");
    const r = await scan({ "Sources/x.swift": src });
    expect(r.inventory.some((e) => /per-file trace budget/.test(e.gates))).toBe(true);
    expect(entry(r.inventory, "k0")?.gates).not.toMatch(/per-file trace budget/);
  }, 60_000);

  it("still traces every read in a large, well-formed file", async () => {
    const reads = Array.from({ length: 1500 }, (_, i) => `  if (remoteConfig().getValue("flag_${i}").asBoolean()) {\n    showBanner(${i})\n  }`).join("\n");
    const r = await scan({
      "src/flags.ts": `import remoteConfig from '@react-native-firebase/remote-config'\nexport function render() {\n${reads}\n  if (remoteConfig().getValue("late_flag").asBoolean()) {\n    showLingeriePicker()\n  }\n}\n`,
    });
    const e = entry(r.inventory, "late_flag");
    expect(e?.classification).toBe("content-gating");
    expect(e?.basis).toBe("scope");
  }, 60_000);
});

describe("static downloads are not remote config", () => {
  it("does not treat images, datasets or generic raw-file downloaders as config", () => {
    for (const u of [
      "https://raw.githubusercontent.com/ethereum-optimism/brand-kit/main/assets/images/Profile-Logo.png",
      "https://raw.githubusercontent.com/fgnt/mnist/master/",
      "https://raw.githubusercontent.com/\\(owner)/\\(repository)/\\(revision)/\\(fileName)",
      "https://raw.githubusercontent.com/${owner}/${repo}/main/${file}",
      "https://x.cloudfront.net/config/train-images-idx3-ubyte.gz",
      "https://cdn.example.r2.dev/remote/model.gguf",
    ]) expect(isConfigUrl(u), u).toBe(false);
  });

  it("still treats config files on raw GitHub, gists and config paths as config", () => {
    for (const u of [
      "https://raw.githubusercontent.com/acme/app-config/main/flags.json",
      "https://raw.githubusercontent.com/acme/app/main/system_prompt.md",
      "https://gist.githubusercontent.com/acme/abc123/raw",
      "https://gist.githubusercontent.com/acme/abc123/raw/",
      "https://my-app.workers.dev/config",
      "https://x.supabase.co/storage/v1/object/public/remote/settings.json",
    ]) expect(isConfigUrl(u), u).toBe(true);
  });

  it("leaves a brand logo fetched from raw GitHub out of the inventory", async () => {
    const r = await scan({
      "ios/PriceWidget/IconProvider.swift": `import SwiftUI\nfunc loadIcon() async throws -> Data {\n  let url = URL(string: "https://raw.githubusercontent.com/ethereum-optimism/brand-kit/main/assets/images/Profile-Logo.png")!\n  let (data, _) = try await URLSession.shared.data(from: url)\n  return data\n}\n`,
      "Libraries/MNIST/Files.swift": `let baseURL = URL(string: "https://raw.githubusercontent.com/fgnt/mnist/master/")!\nfunc download(_ name: String) async throws { _ = try await URLSession.shared.data(from: baseURL.appending(component: name)) }\n`,
    });
    expect(r.inventory).toEqual([]);
    expect(r.findings).toEqual([]);
  });
});

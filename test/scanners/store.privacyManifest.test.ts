import { describe, expect, it } from "vitest";
import { asDict, parsePlist } from "../../src/rules/store.js";
import { check } from "../../src/scanners/privacyManifest.js";
import { ctxFromFiles } from "../helpers.js";

async function scan(files: Record<string, string>) {
  return check.run(await ctxFromFiles(files));
}
const pairs = (r: { findings: { rule: string; severity: string }[] }) => r.findings.map((f) => [f.rule, f.severity]);

function manifest(opts: { tracking?: boolean; domains?: string[]; apis?: Record<string, string[]> }): string {
  const apis = Object.entries(opts.apis ?? {})
    .map(
      ([cat, reasons]) => `\t\t<dict>
\t\t\t<key>NSPrivacyAccessedAPIType</key>
\t\t\t<string>${cat}</string>
\t\t\t<key>NSPrivacyAccessedAPITypeReasons</key>
\t\t\t<array>${reasons.map((r) => `<string>${r}</string>`).join("")}</array>
\t\t</dict>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<!-- generated -->
\t<key>NSPrivacyTracking</key>
\t<${opts.tracking ? "true" : "false"}/>
\t<key>NSPrivacyTrackingDomains</key>
\t<array>${(opts.domains ?? []).map((d) => `<string>${d}</string>`).join("")}</array>
\t<key>NSPrivacyCollectedDataTypes</key>
\t<array/>
\t<key>NSPrivacyAccessedAPITypes</key>
\t<array>
${apis}
\t</array>
</dict>
</plist>
`;
}

describe("parsePlist", () => {
  it("parses nested dicts, arrays, booleans, numbers and entities", () => {
    const v = asDict(
      parsePlist(
        '<?xml version="1.0"?><plist version="1.0"><dict><key>a</key><string>x &amp; y</string><key>b</key><array><integer>3</integer><real>1.5</real></array><key>c</key><dict><key>d</key><true /></dict><key>e</key><string/></dict></plist>',
      ),
    );
    expect(v).toEqual({ a: "x & y", b: [3, 1.5], c: { d: true }, e: "" });
  });

  it("tolerates truncated input and rejects non-plists", () => {
    expect(parsePlist("<plist><dict><key>a</key><string>b</string><key>c</key>")).toEqual({ a: "b" });
    expect(parsePlist("bplist00")).toBeUndefined();
  });
});

describe("privacy_manifest", () => {
  it("is not applicable outside iOS projects", async () => {
    const r = await scan({ "server/index.ts": "export const x = 1" });
    expect(r.findings).toEqual([]);
    expect(r.data?.applicable).toBe(false);
  });

  it("flags a Swift app with no manifest (advisory while it uses no required-reason API)", async () => {
    const r = await scan({ "App/App.swift": "@main struct A: App {}" });
    expect(pairs(r)).toEqual([["privacy_manifest.missing", "info"]]);
  });

  it("does not count a committed SDK bundle's manifest as the app's own", async () => {
    const r = await scan({ "App/App.swift": "@main struct A: App {}", "Vendor/SDK.bundle/PrivacyInfo.xcprivacy": manifest({}) });
    expect(pairs(r)).toEqual([["privacy_manifest.missing", "info"]]);
    const own = await scan({ "App/App.swift": "@main struct A: App {}", "App/PrivacyInfo.xcprivacy": manifest({}) });
    expect(pairs(own)).toEqual([]);
  });

  it("flags undeclared required-reason APIs with the valid reason codes", async () => {
    const r = await scan({
      "App/PrivacyInfo.xcprivacy": manifest({ apis: { NSPrivacyAccessedAPICategoryUserDefaults: ["CA92.1"] } }),
      "App/Store.swift": 'let seen = UserDefaults.standard.bool(forKey: "seen")\nlet up = ProcessInfo.processInfo.systemUptime\nlet attrs = try FileManager.default.attributesOfItem(atPath: p)',
    });
    expect(pairs(r)).toEqual([
      ["privacy_manifest.undeclared_required_reason_api", "medium"],
      ["privacy_manifest.undeclared_required_reason_api", "medium"],
    ]);
    const boot = r.findings.find((f) => f.why.includes("SystemBootTime"))!;
    expect(boot.fix).toContain("35F9.1");
    expect(boot.line).toBe(2);
    expect(r.findings.some((f) => f.why.includes("FileTimestamp"))).toBe(true);
  });

  it("does not mistake PHAsset.creationDate or debug-only code for required-reason use", async () => {
    const r = await scan({
      "App/PrivacyInfo.xcprivacy": manifest({}),
      "App/Photos.swift": "let d = asset.creationDate\n#if DEBUG\nlet t = mach_absolute_time()\n#endif",
    });
    expect(r.findings).toEqual([]);
  });

  it("flags reason codes that do not belong to the category", async () => {
    const r = await scan({
      "App/PrivacyInfo.xcprivacy": manifest({ apis: { NSPrivacyAccessedAPICategoryUserDefaults: ["35F9.1"] } }),
      "App/S.swift": "@AppStorage(\"x\") var x = false",
    });
    expect(pairs(r)).toEqual([["privacy_manifest.invalid_reason", "medium"]]);
  });

  it("flags tracking SDKs when NSPrivacyTracking is false, not when declared with domains", async () => {
    const files = { "App/AppDelegate.swift": "import AppsFlyerLib\nimport AppTrackingTransparency\nATTrackingManager.requestTrackingAuthorization { _ in }" };
    const off = await scan({ ...files, "App/PrivacyInfo.xcprivacy": manifest({ tracking: false }) });
    expect(pairs(off)).toEqual([["privacy_manifest.tracking_undeclared", "medium"]]);
    const on = await scan({ ...files, "App/PrivacyInfo.xcprivacy": manifest({ tracking: true, domains: ["appsflyer.com"] }) });
    expect(on.findings).toEqual([]);
    const noDomains = await scan({ ...files, "App/PrivacyInfo.xcprivacy": manifest({ tracking: true }) });
    expect(pairs(noDomains)).toEqual([["privacy_manifest.tracking_domains_missing", "medium"]]);
  });

  it("accepts Expo ios.privacyManifests as the manifest", async () => {
    const r = await scan({
      "package.json": JSON.stringify({ dependencies: { expo: "~52.0.0", "react-native": "0.76.0", "react-native-appsflyer": "6.0.0" } }),
      "app.json": JSON.stringify({
        expo: {
          name: "Snapcook",
          ios: {
            privacyManifests: {
              NSPrivacyTracking: true,
              NSPrivacyTrackingDomains: ["appsflyer.com"],
              NSPrivacyAccessedAPITypes: [{ NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryUserDefaults", NSPrivacyAccessedAPITypeReasons: ["CA92.1"] }],
            },
          },
        },
      }),
      "src/settings.ts": "import { Settings } from 'react-native';\nSettings.set({ a: 1 });",
    });
    expect(r.findings).toEqual([]);
  });

  it("flags a managed Expo app without privacyManifests at low confidence", async () => {
    const r = await scan({
      "package.json": JSON.stringify({ dependencies: { expo: "~52.0.0", "react-native": "0.76.0" } }),
      "app.json": JSON.stringify({ expo: { name: "Snapcook" } }),
    });
    expect(r.findings.map((f) => [f.rule, f.confidence])).toEqual([["privacy_manifest.missing", "low"]]);
  });
});

describe("privacy_manifest in a monorepo", () => {
  it("reads a prebuilt ios/ folder under the app root as a native project, not managed Expo", async () => {
    const files = {
      "package.json": JSON.stringify({ private: true, workspaces: ["apps/*"] }),
      "apps/mobile/package.json": JSON.stringify({ dependencies: { expo: "~52.0.0", "react-native": "0.76.0" } }),
      "apps/mobile/app.json": JSON.stringify({ expo: { name: "Snapcook" } }),
      "apps/mobile/App.tsx": "export default function App() { return null; }",
    };
    const managed = await check.run(await ctxFromFiles(files));
    expect(managed.findings.map((f) => [f.rule, f.confidence])).toEqual([["privacy_manifest.missing", "low"]]);
    const ctx = await ctxFromFiles({ ...files, "apps/mobile/ios/Snapcook/AppDelegate.swift": "import UIKit" });
    expect(ctx.project.appRoot).toBe("apps/mobile");
    const prebuilt = await check.run(ctx);
    expect(prebuilt.findings.map((f) => [f.rule, f.confidence])).toEqual([["privacy_manifest.missing", "medium"]]);
  });
});

describe("privacy_manifest anchor (field: habitica-ios, FlowDown)", () => {
  const appPbx = `// !$*UTF8*$!\n{ objects = { A = { isa = PBXNativeTarget; productType = "com.apple.product-type.application"; }; }; }\n`;
  const fwPbx = `// !$*UTF8*$!\n{ objects = { B = { isa = PBXNativeTarget; productType = "com.apple.product-type.framework"; }; }; }\n`;

  it("anchors on the app target's project, not a framework or example project", async () => {
    const r = await scan({
      "Examples/ModelExchange.xcodeproj/project.pbxproj": appPbx,
      "Habitica API Client/Habitica API Client.xcodeproj/project.pbxproj": fwPbx,
      "Habitica.xcodeproj/project.pbxproj": appPbx,
      "App/App.swift": "@main struct A: App {}",
    });
    const f = r.findings.find((x) => x.rule === "privacy_manifest.missing");
    expect(f?.file).toBe("Habitica.xcodeproj/project.pbxproj");
  });

  it("does not state an upload rejection as certain", async () => {
    const r = await scan({ "App/App.swift": "@main struct A: App {}\nlet seen = UserDefaults.standard.bool(forKey: \"s\")" });
    expect(r.findings.length).toBeGreaterThan(0);
    for (const f of r.findings) expect(f.why).not.toMatch(/App Store Connect rejects/);
    expect(r.findings.find((x) => x.rule === "privacy_manifest.missing")?.why).toContain("may flag or reject");
  });
});

// Field (apple-browsers): a Mac-only file was checked against the iOS app's manifest.
describe("privacy_manifest required-reason APIs in Mac-only code", () => {
  const disk = `import Foundation\nlet free = try url.resourceValues(forKeys: [.volumeAvailableCapacityKey])\n`;
  const iosManifest = manifest({ apis: {} });
  const undeclared = (r: { findings: { rule: string; file?: string }[] }) =>
    r.findings.filter((f) => f.rule === "privacy_manifest.undeclared_required_reason_api").map((f) => f.file);

  it("skips a macOS/ tree that has no manifest of its own", async () => {
    const r = await scan({
      "iOS/DuckDuckGo/PrivacyInfo.xcprivacy": iosManifest,
      "macOS/DuckDuckGo/Feedback/QuickFeedbackDiagnosticsCollector.swift": disk,
      "DuckDuckGo-macOS/Disk.swift": disk,
    });
    expect(undeclared(r)).toEqual([]);
  });

  it("still checks iOS code and a Mac tree that carries its own manifest", async () => {
    const r = await scan({
      "iOS/DuckDuckGo/PrivacyInfo.xcprivacy": iosManifest,
      "iOS/DuckDuckGo/Disk.swift": disk,
    });
    expect(undeclared(r)).toEqual(["iOS/DuckDuckGo/Disk.swift"]);
    const mac = await scan({ "macOS/App/PrivacyInfo.xcprivacy": iosManifest, "macOS/App/Disk.swift": disk });
    expect(undeclared(mac)).toEqual(["macOS/App/Disk.swift"]);
    const shared = await scan({ "iOS/App/PrivacyInfo.xcprivacy": iosManifest, "Shared-iOS-macOS/Disk.swift": disk });
    expect(undeclared(shared)).toEqual(["Shared-iOS-macOS/Disk.swift"]);
  });

  it("skips a Swift file that imports AppKit unconditionally, but not one behind #if os(macOS)", async () => {
    const appKit = await scan({ "App/PrivacyInfo.xcprivacy": iosManifest, "Sources/Disk.swift": `import AppKit\n${disk}` });
    expect(undeclared(appKit)).toEqual([]);
    const guarded = await scan({ "App/PrivacyInfo.xcprivacy": iosManifest, "Sources/Disk.swift": `#if os(macOS)\nimport AppKit\n#endif\n${disk}` });
    expect(undeclared(guarded)).toEqual(["Sources/Disk.swift"]);
    const both = await scan({ "App/PrivacyInfo.xcprivacy": iosManifest, "Sources/Disk.swift": `import UIKit\nimport AppKit\n${disk}` });
    expect(undeclared(both)).toEqual(["Sources/Disk.swift"]);
  });
});

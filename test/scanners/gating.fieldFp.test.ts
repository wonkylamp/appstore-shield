import { describe, expect, it } from "vitest";
import type { Finding } from "../../src/finding.js";
import { classifySinks } from "../../src/rules/gating.js";
import { check as reviewGating } from "../../src/scanners/reviewGating.js";
import { ctxFromFiles } from "../helpers.js";

/** Regressions from running review_gating on large open-source apps (false positives). */
async function scan(files: Record<string, string>) {
  return reviewGating.run(await ctxFromFiles(files));
}
const rules = (fs: Finding[]) => fs.map((f) => `${f.rule}:${f.severity}`);
const loud = (fs: Finding[]) => fs.filter((f) => f.severity === "block" || f.severity === "high" || f.severity === "medium");

describe("review_gating: taint tracing stays local", () => {
  it("does not turn an object built with a gate argument into a gate", async () => {
    const r = await scan({
      "App/Config.swift": `enum BuildType { case appStore }\nextension BuildType {\n  var isReviewBuild: Bool { appStoreReceiptURL?.lastPathComponent == "sandboxReceipt" }\n}\nfunc make() {\n  let wideEvent = WideEvent(useMockRequests: buildType.isReviewBuild)\n  register(wideEvent)\n}\n`,
      "App/Other.swift": `func refresh() {\n  if let observer = wideEvent.observer {\n    observer.purchase(premium: true)\n  }\n  if wideEvent.isActive {\n    showPaywall(price: 9)\n  }\n}\n`,
    });
    expect(r.findings.filter((f) => f.file === "App/Other.swift")).toEqual([]);
  });

  it("does not follow an assigned generic property (.isEnabled) into other files", async () => {
    const r = await scan({
      "App/Store.swift": `final class ChromeStoreScript {\n  var isEnabled = false\n  init() {\n    self.isEnabled = Bundle.main.isTestFlight\n  }\n}\n`,
      "App/Env.swift": `extension Bundle {\n  var isTestFlight: Bool { appStoreReceiptURL?.lastPathComponent == "sandboxReceipt" }\n}\n`,
      "App/LinkCleaner.swift": `func clean() {\n  if privacyConfig.isEnabled(featureKey: .ampLinks) {\n    showUnlockedPremium()\n  }\n}\n`,
      "App/Vault.swift": `func vault() {\n  if passwordManager.isEnabled {\n    unlockPremiumVault()\n  }\n}\n`,
    });
    expect(r.findings.filter((f) => f.file !== "App/Store.swift" && f.file !== "App/Env.swift")).toEqual([]);
  });

  it("still follows a distinctive, singly-declared helper across files", async () => {
    const r = await scan({
      "App/Env.swift": `extension Bundle {\n  var isTestFlight: Bool {\n    appStoreReceiptURL?.lastPathComponent == "sandboxReceipt"\n  }\n}\n`,
      "App/Home.swift": `struct Home: View {\n  var body: some View {\n    if !Bundle.main.isTestFlight {\n      SpicyOutfitPicker(style: "lingerie")\n    }\n  }\n}\n`,
    });
    expect(rules(r.findings)).toContain("review_gating.environment:block");
  });

  it("collapses one symbol gating many sites into a single finding", async () => {
    const uses = Array.from({ length: 5 }, (_, i) => `func f${i}() {\n  if isReviewerSession {\n    unlockPremium${i}()\n  }\n}\n`).join("");
    const r = await scan({
      "App/Session.swift": `let isReviewerSession = user.email == "review@apple.com"\n${uses}`,
    });
    const branch = r.findings.filter((f) => f.rule === "review_gating.reviewer_branch");
    expect(branch.length).toBe(1);
    expect(branch[0]!.why).toMatch(/also gates \d other site/);
  });
});

describe("review_gating: build configuration is not review detection", () => {
  it("reports a bundle-identifier review flag once, as info", async () => {
    const r = await scan({
      "App/BuildType.swift": `struct ApplicationBuildType {\n  var isReviewBuild: Bool {\n    Bundle.main.bundleIdentifier?.contains(".review") ?? false\n  }\n}\n`,
      "App/AppDelegate.swift": `func launch() {\n  if buildType.isReviewBuild {\n    unlockPremium()\n  }\n  if buildType.isReviewBuild {\n    showDebugMenu()\n  }\n}\n`,
    });
    expect(loud(r.findings)).toEqual([]);
    expect(rules(r.findings)).toEqual(["review_gating.build_config:info"]);
    expect(r.findings[0]!.fix).not.toMatch(/\b(rename|move|hide)\b/i);
  });

  it("treats #if compile flags and Expo env vars as build configuration", async () => {
    const r = await scan({
      "App/Flags.swift": `#if APPSTORE\nlet isAppStoreBuild = true\n#else\nlet isAppStoreBuild = false\n#endif\nfunc f() {\n  if isAppStoreBuild {\n    showPaywall(price: 4)\n  }\n}\n`,
      "src/env/common.ts": `export const ENV: string = process.env.EXPO_PUBLIC_ENV ?? 'development'\nexport const IS_TESTFLIGHT = ENV === 'testflight'\n`,
      "src/screens/Settings.tsx": `import { IS_TESTFLIGHT } from '../env/common'\nexport function Settings() {\n  return IS_TESTFLIGHT && <DebugMenu />\n}\n`,
    });
    expect(loud(r.findings)).toEqual([]);
  });

  it("keeps runtime receipt detection loud", async () => {
    const r = await scan({
      "App/Env.swift": `let isTestFlight = Bundle.main.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt"\nfunc f() {\n  if isTestFlight {\n    showLingerieOutfits()\n  }\n}\n`,
    });
    expect(rules(r.findings)).toContain("review_gating.environment:block");
  });

  it("ignores a backend environment that is not StoreKit's", async () => {
    const r = await scan({
      "WMF/Configuration.swift": `struct Configuration {\n  enum Environment { case local, staging, production }\n  let environment: Environment\n}\n`,
      "WMF/ArticleFetcher.swift": `func url() -> URL {\n  if configuration.environment == .production {\n    return URL(string: apiBaseURL)!\n  }\n  return stagingURL\n}\n`,
    });
    expect(r.findings).toEqual([]);
  });

  it("never reports Expo build configuration files", async () => {
    const r = await scan({
      "app.config.js": `const IS_TESTFLIGHT = process.env.EXPO_PUBLIC_ENV === 'testflight'\nmodule.exports = { ios: { associatedDomains: IS_TESTFLIGHT ? ['applinks:staging.example.com'] : ['applinks:example.com'] } }\n`,
    });
    expect(r.findings).toEqual([]);
  });
});

describe("review_gating: region precision", () => {
  it("does not treat phone-number country codes, language codes or cache keys as region gates", async () => {
    const r = await scan({
      "App/Phone.swift": `func code(_ n: PhoneNumber) -> String {\n  if let c = phoneNumberUtil.bestEffortCallingCode(fromCountryCode: n.countryCode) {\n    showCompanionCharacters(c)\n  }\n  return ""\n}\n`,
      "App/Text.swift": `func fit(_ text: String) {\n  let cacheKey = "\\(text)-\\(Locale.current.regionCode ?? "")"\n  if let cached = textThatFitsCache.object(forKey: cacheKey) {\n    maxCharacters = cached.characters\n  }\n}\n`,
    });
    expect(r.findings).toEqual([]);
  });

  it("does not read 'characters' in text-length code as a persona feature", async () => {
    const r = await scan({
      "App/Trim.swift": `func trim() {\n  if Locale.current.regionCode == "US" {\n    label.text = String(text.prefix(maxCharacters)) + " characters"\n  }\n}\n`,
    });
    expect(loud(r.findings)).toEqual([]);
  });

  it("treats age-assurance code that disables adult content as legal, not hidden content", async () => {
    const r = await scan({
      "src/ageAssurance/useAgeAssurance.ts": `export function useAgeAssurance() {\n  const region = RNLocalize.getCountry()\n  if (region === 'GB') {\n    return { flags: { adultContentDisabled: true } }\n  }\n  return { flags: { adultContentDisabled: false } }\n}\n`,
      "src/screens/Moderation.tsx": `export function Moderation() {\n  const country = RNLocalize.getCountry()\n  if (country === 'AU') {\n    prefs.adultContentEnabled = false\n  }\n}\n`,
    });
    expect(loud(r.findings)).toEqual([]);
  });

  it("still rates region-gated adult content high with a remove-only fix", async () => {
    const r = await scan({
      "App/Gate.swift": `func gate() {\n  if Locale.current.region?.identifier == "US" {\n    showLingerieOutfits()\n  }\n}\n`,
    });
    const f = r.findings.find((x) => x.rule === "review_gating.region");
    expect(f?.severity).toBe("high");
    expect(f?.fix).toMatch(/^Remove the switch and the adult/);
    expect(f?.fix).not.toMatch(/Notes for Review/);
  });
});

describe("review_gating: demo flags and adult date gates", () => {
  it("does not treat an App Clip's isDemo as a demo account", async () => {
    const r = await scan({
      "Sources/GameOver/GameOverView.swift": `struct GameOverView: View {\n  var isDemo: Bool\n  var body: some View {\n    if isDemo {\n      Button("Get the full game") { openStore() }\n    }\n  }\n}\n`,
    });
    expect(r.findings).toEqual([]);
  });

  it("classifies a date gate by the presets it returns and never offers 'ship it active' for nudification", async () => {
    const r = await scan({
      "src/presets.ts": `export const LAUNCH_DATE = Date.parse("2026-11-15T00:00:00Z")\nexport const BASE_PRESETS = [{ id: "anime", label: "Anime" }]\nexport const BODY_PRESETS = [{ id: "rc", label: "Remove Clothes" }, { id: "xr", label: "X-Ray", prompt: "see-through clothing" }]\nexport function availablePresets() {\n  if (Date.now() > LAUNCH_DATE) {\n    return [...BASE_PRESETS, ...BODY_PRESETS]\n  }\n  return BASE_PRESETS\n}\n`,
    });
    const f = r.findings.find((x) => x.rule === "review_gating.date");
    expect(f?.severity).toBe("block");
    expect(f?.why).toMatch(/adult/);
    expect(f?.fix).not.toMatch(/ship the behavior active/);
    expect(f?.suppressible).toBe(false);
  });
});

describe("review_gating: restriction is judged by direction", () => {
  it("still flags a negated restriction that turns adult content on by region", async () => {
    const r = await scan({
      "src/Feed.tsx": `export function Feed() {\n  const country = RNLocalize.getCountry()\n  if (country === 'US' && !prefs.nsfwDisabled) {\n    showLingerieFeed()\n  }\n}\n`,
    });
    expect(rules(r.findings)).toContain("review_gating.region:high");
  });
});

describe("review_gating: DuckDuckGo build-type shape (protocol + stored bundle-ID flags)", () => {
  const buildType = `public protocol ApplicationBuildType {
    var isDebugBuild: Bool { get }
    var isAppStoreBuild: Bool { get }
    var isReviewBuild: Bool { get }
}

public final class StandardApplicationBuildType: ApplicationBuildType {
    public init() {}
    public var isDebugBuild: Bool {
#if DEBUG
        return true
#else
        return false
#endif
    }
    public let isReviewBuild: Bool = Bundle.main.bundleIdentifier?.contains(".review") ?? false
    public let isAppStoreBuild: Bool = Bundle.main.bundleIdentifier?.hasPrefix("com.duckduckgo.mobile.ios") ?? false
}
`;
  const appDelegate = `final class AppDelegate {
    let buildType: ApplicationBuildType
    func launch() {
        if buildType.isDebugBuild || buildType.isReviewBuild {
            unlockPremium()
        }
        if buildType.isAppStoreBuild {
            let updateController = appStoreFactory.instantiate(internalUserDecider: decider, promoBridge: UpdateNotificationPromoBridge())
            self.updateController = updateController
        }
    }
}
`;

  it("treats protocol-declared, bundle-ID-derived flags as build configuration", async () => {
    const r = await scan({
      "LocalPackages/AppKitExtensions/Sources/AppKitExtensions/ApplicationBuildType.swift": buildType,
      "App/AppDelegate.swift": appDelegate,
      "App/PromoDebugMenu.swift": `struct PromoServiceFactory {\n    static var includeTestPromos: Bool { buildType.isReviewBuild }\n}\nfunc menu() {\n    if PromoServiceFactory.includeTestPromos {\n        showPromo(price: 3)\n    }\n}\n`,
    });
    expect(loud(r.findings)).toEqual([]);
    expect(rules(r.findings).sort()).toEqual(["review_gating.build_config:info", "review_gating.build_config:info"]);
  });

  it("follows a stored property whose initializer forwards its parameter", async () => {
    const r = await scan({
      "Common/AppVersion.swift": `public struct AppVersion {\n  var bundleId: String { Bundle.main.bundleIdentifier ?? "" }\n  public var isAppStoreBuild: Bool { bundleId.hasPrefix("com.example.ios") }\n}\n`,
      "App/Updates.swift": `final class UpdateController {\n    private let isAppStoreBuild: Bool\n    init(isAppStoreBuild: Bool) {\n        self.isAppStoreBuild = isAppStoreBuild\n    }\n    func run() {\n        if isAppStoreBuild {\n            showPaywall(price: 4)\n        }\n    }\n}\n`,
    });
    expect(loud(r.findings)).toEqual([]);
  });

  it("ignores mock definitions when deciding where a flag comes from", async () => {
    const r = await scan({
      "App/BuildType.swift": buildType,
      "App/Mocks/MockApplicationBuildType.swift": `final class MockApplicationBuildType: ApplicationBuildType {\n    var isDebugBuild: Bool = false\n    var isAppStoreBuild: Bool = true\n    var isReviewBuild: Bool = true\n}\n`,
      "App/AppDelegate.swift": appDelegate,
    });
    expect(loud(r.findings)).toEqual([]);
  });

  it("stays loud when the stored flag is set at runtime from the receipt", async () => {
    const r = await scan({
      "App/BuildType.swift": `protocol BuildTyping {\n    var isAppStoreBuild: Bool { get }\n}\nfinal class BuildType: BuildTyping {\n    let isAppStoreBuild: Bool\n    init() {\n        self.isAppStoreBuild = Bundle.main.appStoreReceiptURL?.lastPathComponent != "sandboxReceipt"\n    }\n}\n`,
      "App/Gallery.swift": `func gallery() {\n    if buildType.isAppStoreBuild {\n        showLingerieOutfits()\n    }\n}\n`,
    });
    expect(rules(r.findings)).toContain("review_gating.environment:block");
  });

  it("rates an isReviewBuild of unknown origin as a review-mode flag, not reviewer detection", async () => {
    const r = await scan({
      "App/Session.swift": `final class Session {\n    var isReviewBuild: Bool { UserDefaults.standard.bool(forKey: "qa_review_build") }\n}\nfunc open() {\n    if session.isReviewBuild {\n        unlockPremium()\n    }\n}\n`,
    });
    expect(rules(r.findings)).toEqual(["review_gating.review_state:high"]);
  });

  it("never reports declarations, and collapses every site of one runtime reviewer flag", async () => {
    const r = await scan({
      "App/Reviewer.swift": `protocol ReviewDetecting {\n    var isAppleReviewer: Bool { get }\n}\nfinal class ReviewDetector: ReviewDetecting {\n    public let isAppleReviewer: Bool = UserDefaults.standard.string(forKey: "email") == "review@apple.com"\n}\n`,
      "App/A.swift": `func a() {\n  if detector.isAppleReviewer {\n    unlockPremium()\n  }\n}\n`,
      "App/B.swift": `func b() {\n  if detector.isAppleReviewer {\n    unlockPro()\n  }\n}\n`,
      "App/C.swift": `func c() {\n  if detector.isAppleReviewer {\n    unlockAll()\n  }\n}\n`,
    });
    const branch = r.findings.filter((f) => f.rule === "review_gating.reviewer_branch");
    expect(branch.some((f) => f.file === "App/Reviewer.swift" && f.line === 2)).toBe(false);
    const sites = branch.filter((f) => f.file !== "App/Reviewer.swift");
    expect(sites).toHaveLength(1);
    expect(sites[0]!.why).toMatch(/also gates 2 other site\(s\): App\/B\.swift:2, App\/C\.swift:2/);
  });

  it("does not read a Promo type name as pricing, but still reads promo UI", () => {
    expect(classifySinks("let c = factory.instantiate(promoBridge: UpdateNotificationPromoBridge())").kinds).not.toContain("price");
    expect(classifySinks("showPromo()").kinds).toContain("price");
    expect(classifySinks("PromoCodeSheet()").kinds).toContain("price");
  });
});

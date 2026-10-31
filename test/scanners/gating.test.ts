import { describe, expect, it } from "vitest";
import type { Finding } from "../../src/finding.js";
import { check as reviewGating } from "../../src/scanners/reviewGating.js";
import { ctxFromFiles } from "../helpers.js";

async function scan(files: Record<string, string>) {
  return reviewGating.run(await ctxFromFiles(files));
}
const rules = (fs: Finding[]) => fs.map((f) => `${f.rule}:${f.severity}`);
const EVASIVE = /\b(rename|renaming|move|moving|hide|hiding|obfuscat\w*)\b/i;

function noEvasionAdvice(fs: Finding[]) {
  for (const f of fs) {
    expect(f.fix, f.rule).not.toMatch(EVASIVE);
    // A non-suppressible finding is one disclosure cannot cure, so its fix must not offer it.
    if (!f.suppressible) expect(f.fix, f.rule).not.toMatch(/\bdisclose\b/i);
  }
}

const ENV_EXT = `import Foundation\nextension Bundle {\n  var isTestFlight: Bool {\n    appStoreReceiptURL?.lastPathComponent == "sandboxReceipt"\n  }\n}\n`;

describe("review_gating: environment", () => {
  it("blocks a sandbox-receipt check (via a computed property) around adult content", async () => {
    const r = await scan({
      "App/Env.swift": `import Foundation\nextension Bundle {\n  var isTestFlight: Bool {\n    appStoreReceiptURL?.lastPathComponent == "sandboxReceipt"\n  }\n}\n`,
      "App/Home.swift": `struct Home: View {\n  var body: some View {\n    if !Bundle.main.isTestFlight {\n      SpicyOutfitPicker(style: "lingerie")\n    }\n  }\n}\n`,
    });
    expect(rules(r.findings)).toContain("review_gating.environment:block");
    noEvasionAdvice(r.findings);
  });

  it("blocks AppTransaction.environment gating a premium unlock", async () => {
    const r = await scan({
      "App/Store.swift": `func boot() async {\n  let tx = try? await AppTransaction.shared.payloadValue\n  if tx?.environment == .sandbox {\n    store.isPremium = true\n  }\n}\n`,
    });
    const f = r.findings.find((x) => x.rule === "review_gating.environment");
    expect(f?.severity).toBe("block");
    expect(f?.line).toBe(3);
  });

  it("does not flag StoreKit environment checks used only for receipt validation or logging", async () => {
    const r = await scan({
      "App/Receipt.swift": `func verifyURL() -> URL {\n  let url = isSandbox ? "https://sandbox.itunes.apple.com/verifyReceipt" : "https://buy.itunes.apple.com/verifyReceipt"\n  return URL(string: url)!\n}\nfunc onTx(_ transaction: Transaction) {\n  if transaction.environment == .sandbox {\n    logger.debug("sandbox purchase of \\(transaction.productID) for paywall test")\n  }\n}\n`,
    });
    expect(r.findings).toEqual([]);
  });

  it("rates a TestFlight-gated debug menu medium", async () => {
    const r = await scan({
      "src/Settings.tsx": `import { isTestFlight } from './env'\nexport function Settings() {\n  return (<View>{isTestFlight && (<DebugMenu />)}</View>)\n}\n`,
    });
    expect(rules(r.findings)).toEqual(["review_gating.environment_debug:medium"]);
  });

  it("ignores gates that only ship in debug builds", async () => {
    const r = await scan({
      "App/Dev.swift": `#if DEBUG\nfunc dev() {\n  if Bundle.main.isTestFlight { showNSFWPreview() }\n}\n#endif\n`,
    });
    expect(r.findings).toEqual([]);
  });

  it("flags an install-source check that swaps the backend as medium", async () => {
    const r = await scan({
      "src/api.ts": `import * as Application from 'expo-application'\nexport async function baseUrl() {\n  const type = await Application.getIosApplicationReleaseTypeAsync()\n  if (type !== Application.ApplicationReleaseType.APP_STORE) {\n    return STAGING_API_URL\n  }\n  return PROD_API_URL\n}\n`,
    });
    expect(rules(r.findings)).toContain("review_gating.environment_backend:medium");
  });

  it("gives a remove-only fix when a TestFlight check hides companion or generator content", async () => {
    const r = await scan({
      "App/Env.swift": ENV_EXT,
      "App/Home.swift": `struct Home: View {\n  var body: some View {\n    if !Bundle.main.isTestFlight {\n      CompanionChatView(persona: girlfriendPersona)\n      ImageGeneratorView()\n    }\n  }\n}\n`,
    });
    const f = r.findings.find((x) => x.rule === "review_gating.environment");
    expect(f?.severity).toBe("block");
    expect(f?.suppressible).toBe(false);
    expect(f?.fix).toMatch(/does not cure/);
    noEvasionAdvice(r.findings);
  });

  it("keeps the disclose option for a price-only TestFlight difference", async () => {
    const r = await scan({
      "App/Env.swift": ENV_EXT,
      "App/Store.swift": `struct P: View {\n  var body: some View {\n    if Bundle.main.isTestFlight {\n      PaywallView(price: discountedPrice)\n    }\n  }\n}\n`,
    });
    const f = r.findings.find((x) => x.rule === "review_gating.environment");
    expect(f?.suppressible).toBe(true);
    expect(f?.fix).toMatch(/disclose it specifically/);
  });

  it("does not call a TestFlight update banner a backend switch because it names backendClient", async () => {
    const r = await scan({
      "App/Env.swift": ENV_EXT,
      "App/Feeds.swift": `struct FeedsView: View {\n  var body: some View {\n    VStack {\n      if Bundle.main.isTestFlight, let testflightUrl = backendClient.testflightUpdate, lastTestFlightUpdate != testflightUrl {\n        UpdateBannerView(url: testflightUrl)\n      }\n    }\n  }\n}\n`,
    });
    expect(rules(r.findings)).not.toContain("review_gating.environment_backend:medium");
    expect(r.findings.every((f) => f.severity === "info")).toBe(true);
  });

  it("still flags a TestFlight check that assigns a staging base URL", async () => {
    const r = await scan({
      "App/Env.swift": ENV_EXT,
      "App/Api.swift": `final class Api {\n  func configure() {\n    if Bundle.main.isTestFlight {\n      client.baseURL = URL(string: "https://staging.example.com")!\n    }\n  }\n}\n`,
    });
    expect(rules(r.findings)).toContain("review_gating.environment_backend:medium");
  });
});

describe("review_gating: Apple network, location and reviewer identity", () => {
  it("blocks an Apple 17.x IP check in in-repo server code, not suppressible", async () => {
    const r = await scan({
      "workers/index.ts": `export default {\n  async fetch(request: Request) {\n    const ip = request.headers.get("cf-connecting-ip") ?? ""\n    if (ip.startsWith("17.")) {\n      return Response.json({ nsfw: false })\n    }\n    return Response.json({ nsfw: true })\n  }\n}\n`,
    });
    const f = r.findings.find((x) => x.rule === "review_gating.apple_ip");
    expect(f?.severity).toBe("block");
    expect(f?.suppressible).toBe(false);
    expect(f?.why).toMatch(/^Server code/);
  });

  it("blocks a 17.0.0.0/8 CIDR outside webhook code", async () => {
    const r = await scan({ "server/gate.ts": `const APPLE = "17.0.0.0/8"\nexport const isApple = (ip: string) => inRange(ip, APPLE)\n` });
    expect(rules(r.findings)).toContain("review_gating.apple_ip:block");
  });

  it("does not flag Apple's documented 17.0.0.0/8 allowlist for App Store Server Notifications, or iOS 17 version checks", async () => {
    const r = await scan({
      "server/notifications.ts": `export async function handle(req) {\n  if (!inRange(req.ip, "17.0.0.0/8")) return 403\n  const { signedPayload } = await req.json()\n  return verify(signedPayload)\n}\n`,
      "App/Version.swift": `if UIDevice.current.systemVersion.hasPrefix("17.") {\n  useLegacyLayout()\n}\n`,
    });
    expect(r.findings).toEqual([]);
  });

  it("blocks a Cupertino geofence but not a map centred on Apple Park", async () => {
    const pos = await scan({
      "App/Geo.swift": `func check(_ loc: CLLocation) {\n  let park = CLLocation(latitude: 37.3349, longitude: -122.0090)\n  if loc.distance(from: park) < 5000 {\n    disableCompanions()\n  }\n}\n`,
    });
    expect(rules(pos.findings)).toContain("review_gating.geofence:block");
    const neg = await scan({
      "App/Map.swift": `struct MapScreen: View {\n  @State var region = MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: 37.3349, longitude: -122.0090), span: MKCoordinateSpan(latitudeDelta: 0.05, longitudeDelta: 0.05))\n}\n`,
    });
    expect(neg.findings).toEqual([]);
  });

  it("blocks a Cupertino city comparison", async () => {
    const r = await scan({ "src/geo.ts": `if (place.city === "Cupertino") {\n  setSafeMode(true)\n}\n` });
    expect(rules(r.findings)).toContain("review_gating.geofence:block");
  });

  it("blocks a reviewer-email branch and a review-version comparison", async () => {
    const r = await scan({
      "src/auth.ts": `export function after(user) {\n  if (user.email === "appreview@mycompany.com") {\n    setTheme('dark')\n  }\n}\n`,
      "App/Config.swift": `func apply(_ cfg: ServerConfig) {\n  if Bundle.main.appVersion == cfg.reviewVersion {\n    characters = []\n  }\n}\n`,
    });
    const blocks = r.findings.filter((f) => f.rule === "review_gating.reviewer_branch");
    expect(blocks.map((f) => f.file).sort()).toEqual(["App/Config.swift", "src/auth.ts"]);
    expect(blocks.every((f) => f.severity === "block" && !f.suppressible)).toBe(true);
  });

  it("treats an ambiguous review-mode flag by what it gates", async () => {
    const flashcards = await scan({ "src/Deck.tsx": `if (reviewMode) {\n  showNextCard()\n}\n` });
    expect(flashcards.findings).toEqual([]);
    const evasive = await scan({ "App/Gen.swift": `func run() async {\n  guard !isInReview else { return }\n  await generateImage(prompt: "nude portrait")\n}\n` });
    expect(rules(evasive.findings)).toContain("review_gating.review_state:high");
  });

  it("blocks a demo-account branch around an unlock, and rates a plain demo mode medium", async () => {
    const r = await scan({
      "src/session.ts": `export function onLogin(user) {\n  if (user.email === DEMO_EMAIL) {\n    store.isPremium = true\n  }\n}\n`,
      "src/sample.ts": `export function boot() {\n  if (isDemoUser) {\n    loadSampleData()\n  }\n}\n`,
    });
    const byFile = Object.fromEntries(r.findings.map((f) => [f.file, `${f.rule}:${f.severity}`]));
    expect(byFile["src/session.ts"]).toBe("review_gating.demo_account:block");
    expect(byFile["src/sample.ts"]).toBe("review_gating.demo_account:medium");
  });
});

describe("review_gating: date and install-age gates", () => {
  it("blocks a launch-date switch around a persona feature", async () => {
    const r = await scan({ "App/Gate.swift": `func load() {\n  if Date() > Config.unlockDate {\n    showCompanionMode()\n  }\n}\n` });
    expect(rules(r.findings)).toContain("review_gating.date:block");
  });

  it("blocks a hardcoded date literal derived into a flag", async () => {
    const r = await scan({
      "src/flags.ts": `const isLive = Date.now() > 1767225600000\nexport function Menu() {\n  return isLive ? <UncensoredGenerator /> : <SafeGenerator />\n}\n`,
    });
    expect(rules(r.findings)).toContain("review_gating.date:block");
  });

  it("does not flag dates that describe data (a movie's release date)", async () => {
    const r = await scan({ "src/Movie.tsx": `if (movie.releaseDate > new Date()) {\n  return <BuyTickets price={movie.price} />\n}\n` });
    expect(r.findings).toEqual([]);
  });

  it("blocks install-age gating of adult content but rates a delayed paywall medium", async () => {
    const r = await scan({
      "App/A.swift": `func a() {\n  if daysSinceInstall > 3 {\n    enableNSFW()\n  }\n}\n`,
      "App/B.swift": `func b() {\n  if launchCount > 3 {\n    showPaywall()\n  }\n}\n`,
    });
    const byFile = Object.fromEntries(r.findings.map((f) => [f.file, `${f.rule}:${f.severity}`]));
    expect(byFile["App/A.swift"]).toBe("review_gating.install_age:block");
    expect(byFile["App/B.swift"]).toBe("review_gating.install_age:medium");
  });
});

describe("review_gating: region, storefront and timezone", () => {
  it("rates storefront-based legal gating info with a disclose fix", async () => {
    const r = await scan({
      "App/Pay.swift": `func links() async {\n  if await Storefront.current?.countryCode == "USA" {\n    showExternalPurchaseLink()\n  }\n}\n`,
    });
    const f = r.findings.find((x) => x.rule === "review_gating.region_legal");
    expect(f?.severity).toBe("info");
    expect(f?.fix).toMatch(/^Disclose/);
  });

  it("rates region-gated adult content high, and ignores harmless locale branches", async () => {
    const pos = await scan({ "App/R.swift": `func r() {\n  if Locale.current.region?.identifier != "US" {\n    enableUncensoredMode()\n  }\n}\n` });
    expect(rules(pos.findings)).toContain("review_gating.region:high");
    const neg = await scan({ "App/U.swift": `func u() {\n  if Locale.current.regionCode == "US" {\n    unit = .imperial\n  }\n}\n` });
    expect(neg.findings).toEqual([]);
  });

  it("flags server-side IP-country gating of prompts", async () => {
    const r = await scan({
      "supabase/functions/chat/index.ts": `Deno.serve(async (req) => {\n  const country = req.headers.get("cf-ipcountry")\n  let system = SAFE_PROMPT\n  if (country !== "US") {\n    system = "You are an uncensored companion"\n  }\n  return reply(system)\n})\n`,
    });
    const f = r.findings.find((x) => x.rule === "review_gating.region");
    expect(f?.severity).toBe("high");
    expect(f?.file).toBe("supabase/functions/chat/index.ts");
  });

  it("blocks a Pacific-timezone switch around content", async () => {
    const r = await scan({
      "App/T.swift": `func t() {\n  if TimeZone.current.identifier == "America/Los_Angeles" {\n    aiCharacters = safeAiCharacters\n  }\n}\n`,
    });
    expect(rules(r.findings)).toContain("review_gating.timezone:block");
  });

  it("returns gate data and never suggests evasion", async () => {
    const r = await scan({
      "App/All.swift": `func all() {\n  if Bundle.main.isTestFlight { showLingerie() }\n  if user.email == "review@apple.com" { x() }\n}\n`,
    });
    expect(Array.isArray(r.data?.gates)).toBe(true);
    expect(r.findings.length).toBeGreaterThan(0);
    noEvasionAdvice(r.findings);
  });
});

describe("review_gating: receipt handling", () => {
  it("does not flag a server notification handler that skips sandbox events", async () => {
    const r = await scan({
      "server/appstore.ts": `export async function onNotification(body) {\n  const tx = await verifier.verifyAndDecodeNotification(body.signedPayload)\n  if (tx.data.environment === "Sandbox") return;\n  await grantEntitlement(tx.data.appAccountToken, "premium")\n  await unlockAll(tx)\n}\n`,
    });
    expect(r.findings).toEqual([]);
  });

  it("follows a custom-named sandbox helper used as a member property", async () => {
    const r = await scan({
      "App/Env.swift": `extension Bundle {\n  var isBetaInstall: Bool { appStoreReceiptURL?.lastPathComponent == "sandboxReceipt" }\n}\n`,
      "App/V.swift": `struct V: View {\n  var body: some View {\n    if !Bundle.main.isBetaInstall { NSFWGallery() }\n  }\n}\n`,
    });
    const f = r.findings.find((x) => x.rule === "review_gating.environment");
    expect(f?.severity).toBe("block");
    expect(f?.suppressible).toBe(false);
  });
});

describe("review_gating regressions", () => {
  it("still blocks a reviewer-email branch after a one-line __DEV__ log in semicolon-less code", async () => {
    const r = await scan({
      "src/a.ts": `export function feed(user) {\n  if (__DEV__) console.log("feed")\n  const hidden = user.email === "appreview@apple.com"\n  return hidden ? safeFeed() : nsfwFeed()\n}\n`,
    });
    const f = r.findings.find((x) => x.rule === "review_gating.reviewer_branch");
    expect(f?.file).toBe("src/a.ts");
    expect(f?.severity).toBe("block");
  });

  it("rates a review-mode swap to a web view or real-money betting high", async () => {
    const r = await scan({
      "src/Home.tsx": `export function Home({ url }) {\n  if (reviewMode) {\n    return <Calculator />;\n  }\n  return <WebView source={{ uri: url }} />;\n}\n`,
      "src/Bet.tsx": `export function Bet() {\n  return inReview ? <Notes /> : <SportsBetting realMoneyWagers />;\n}\n`,
    });
    const byFile = Object.fromEntries(r.findings.map((f) => [f.file, `${f.rule}:${f.severity}`]));
    expect(byFile["src/Home.tsx"]).toBe("review_gating.review_state:high");
    expect(byFile["src/Bet.tsx"]).toBe("review_gating.review_state:high");
    noEvasionAdvice(r.findings);
  });

  it("rates an environment-gated web view medium and region-gated betting as a legal disclosure", async () => {
    const r = await scan({
      "App/Home.swift": `struct Home: View {\n  var body: some View {\n    if Bundle.main.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt" {\n      Text("Notes")\n    } else {\n      WebView(url: remoteURL)\n    }\n  }\n}\n`,
      "src/Sports.tsx": `export function Sports() {\n  if (storefront.countryCode === "GB") {\n    return <SportsBetting />\n  }\n  return null\n}\n`,
    });
    const byFile = Object.fromEntries(r.findings.map((f) => [f.file, `${f.rule}:${f.severity}`]));
    expect(byFile["App/Home.swift"]).toBe("review_gating.environment:medium");
    expect(byFile["src/Sports.tsx"]).toBe("review_gating.region_legal:info");
  });

  it("gives reviewer-detection findings a remove-only fix that rules out disclosure", async () => {
    const r = await scan({
      "server/api/feed.ts": `export function feed(req) {\n  if (req.ip.startsWith("17.")) {\n    return calculatorScreen()\n  }\n  return realScreen()\n}\n`,
      "src/auth.ts": `export function after(user) {\n  if (user.email === "appreview@mycompany.com") {\n    setTheme('dark')\n  }\n}\n`,
    });
    const blocks = r.findings.filter((f) => f.rule === "review_gating.reviewer_branch" || f.rule === "review_gating.apple_ip");
    expect(blocks.map((f) => f.rule).sort()).toEqual(["review_gating.apple_ip", "review_gating.reviewer_branch"]);
    for (const f of blocks) {
      expect(f.fix).toMatch(/^Remove the check entirely/);
      expect(f.fix).not.toMatch(/reachable during review/);
    }
    noEvasionAdvice(r.findings);
  });

  it("does not treat a promo cadence as pricing, and downgrades a delayed paywall when a purchase path is ungated", async () => {
    const promo = await scan({
      "App/Promo.swift": `final class SubscriptionPromoCoordinator {\n  func show() {\n    let shouldShow = isReturningUser && daysSinceInstall > 3\n    guard shouldShow else { return }\n    presentPromo()\n  }\n}\n`,
    });
    expect(promo.findings.filter((f) => f.rule === "review_gating.install_age")).toEqual([]);
    const both = await scan({
      "App/B.swift": `func b() {\n  if launchCount > 3 {\n    showPaywall()\n  }\n}\n`,
      "App/Settings.swift": `struct Settings: View {\n  var body: some View {\n    Button("Upgrade") { Task { try await product.purchase() } }\n  }\n}\n`,
    });
    expect(both.findings.find((f) => f.rule === "review_gating.install_age")?.severity).toBe("info");
  });
});

describe("review_gating: long statements", () => {
  it("analyzes many detector hits in one long statement in linear time", async () => {
    // 4,000 hits in one 56 KB statement took ~50 s when every hit walked the whole statement.
    const t = performance.now();
    const r = await scan({ "src/a.ts": `export const x = ${"isReviewer && ".repeat(4000)}1\n` });
    expect(performance.now() - t).toBeLessThan(10_000);
    expect(r.findings.filter((f) => f.severity === "block")).toEqual([]);
  }, 60_000);

  it("caps the hits analyzed per file so a megabyte of one repeated term stays cheap", async () => {
    const ctx = await ctxFromFiles({ "src/a.ts": `let a = ${"isReviewer || ".repeat(100_000)}x\n` });
    const t = process.cpuUsage();
    await reviewGating.run(ctx);
    const d = process.cpuUsage(t);
    // 100,000 hits (1.4 MB) each walking an 8 KB statement window took about 8 s of CPU before the cap.
    expect((d.user + d.system) / 1000).toBeLessThan(4_000);
  }, 60_000);

  it("does not let one repeated term starve the other detectors in the same file", async () => {
    const filler = `let a = ${"isReviewer || ".repeat(20_000)}x\n`;
    const r = await scan({
      "App/Env.swift": ENV_EXT,
      "App/Studio.swift": `${filler}struct Studio: View {\n  var body: some View {\n    if Bundle.main.isTestFlight {\n      LingeriePicker()\n    }\n  }\n}\n`,
    });
    expect(r.findings.some((f) => f.file === "App/Studio.swift" && /environment|testflight|sandbox/i.test(`${f.rule} ${f.why}`))).toBe(true);
  }, 60_000);

  it("still reports reviewer detection in a file below the hit cap", async () => {
    const filler = Array.from({ length: 200 }, (_, i) => `const v${i} = isReviewer ? 1 : 0`).join("\n");
    const r = await scan({ "src/a.ts": `${filler}\nexport function Studio() {\n  if (isReviewer) {\n    return <LingeriePicker />\n  }\n}\n` });
    expect(r.findings.some((f) => f.rule.startsWith("review_gating."))).toBe(true);
  }, 60_000);
});

describe("a device-timezone display branch is not a legal regional difference", () => {
  it("does not report a site-vs-device timezone label as region_legal", async () => {
    const r = await scan({
      "App/SiteStatsInformation.swift": `import Foundation\nfinal class SiteStatsInformation {\n  static let sharedInstance = SiteStatsInformation()\n  var siteTimeZone: TimeZone?\n  func timeZoneMatchesDevice() -> Bool {\n    return siteTimeZone == TimeZone.current\n  }\n}\n`,
      "App/SiteStatsTableHeaderView.swift": `import UIKit\nfinal class SiteStatsTableHeaderView: UIView {\n  let timezoneLabel = UILabel()\n  func displayTimezone() {\n    guard !SiteStatsInformation.sharedInstance.timeZoneMatchesDevice(),\n      let siteTimeZone = SiteStatsInformation.sharedInstance.siteTimeZone\n    else {\n      timezoneLabel.isHidden = true\n      return\n    }\n    timezoneLabel.text = siteTimeZone.identifier\n    timezoneLabel.isHidden = false\n  }\n}\n`,
    });
    expect(r.findings.filter((f) => f.rule.startsWith("review_gating.region"))).toEqual([]);
  });

  it("still reports a storefront branch that hides a feature as region_legal", async () => {
    const r = await scan({
      "App/Gen.swift": `import StoreKit\nfunc configure() async {\n  if await Storefront.current?.countryCode == "CHN" {\n    generateButton.isHidden = true\n  }\n}\n`,
    });
    expect(rules(r.findings)).toContain("review_gating.region_legal:info");
  });
});

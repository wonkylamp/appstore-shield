import { describe, expect, it } from "vitest";
import { check, delaySeconds } from "../../src/scanners/paywall.js";
import { ctxFromFiles } from "../helpers.js";

async function scan(files: Record<string, string>) {
  return check.run(await ctxFromFiles(files));
}
const rules = (r: { findings: { rule: string }[] }) => r.findings.map((f) => f.rule);

const BAD_SWIFT_PAYWALL = `import StoreKit
import SwiftUI

struct PaywallView: View {
  @State private var showClose = false
  let product: Product
  var body: some View {
    VStack {
      if showClose {
        Button { dismiss() } label: { Image(systemName: "xmark") }
      }
      Text("Unlock everything")
      Text("Only $9.99/month")
      Button("Continue") { Task { try await product.purchase() } }
    }
    .onAppear {
      DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
        withAnimation { showClose = true }
      }
    }
  }
}
`;

const GOOD_SWIFT_PAYWALL = `import StoreKit
import SwiftUI

struct PaywallView: View {
  let product: Product
  var body: some View {
    VStack {
      Button { dismiss() } label: { Image(systemName: "xmark") }
      Text("\\(product.displayName) – \\(product.displayPrice) per month")
      Text("Subscription renews automatically unless cancelled at least 24 hours before the end of the period.")
      Button("Continue") { Task { try await product.purchase() } }
      Button("Restore Purchases") { Task { try? await AppStore.sync() } }
      Link("Terms of Use", destination: URL(string: "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/")!)
      Link("Privacy Policy", destination: URL(string: "https://example.com/privacy")!)
    }
  }
}
`;

describe("paywall", () => {
  it("does nothing without any purchase code", async () => {
    const r = await scan({ "App/ContentView.swift": 'struct ContentView: View { var body: some View { Text("$9.99") } }' });
    expect(r.findings).toEqual([]);
    expect(r.data?.paywall).toBe(false);
  });

  it("flags a custom paywall with hardcoded price, delayed close, no restore, no legal links, no renewal terms", async () => {
    const r = await scan({ "App/PaywallView.swift": BAD_SWIFT_PAYWALL });
    const ids = rules(r);
    expect(ids).toContain("paywall.hardcoded_price");
    expect(ids).toContain("paywall.delayed_dismiss");
    expect(ids).toContain("paywall.missing_restore");
    expect(ids).toContain("paywall.missing_legal_links");
    // "$9.99/month" shows price and period; only the renewal wording is missing.
    expect(ids).not.toContain("paywall.missing_subscription_terms");
    expect(r.findings.find((f) => f.rule === "paywall.renewal_wording")?.severity).toBe("medium");
    const price = r.findings.find((f) => f.rule === "paywall.hardcoded_price")!;
    expect(price.severity).toBe("high");
    expect(price.line).toBe(13);
    const delay = r.findings.find((f) => f.rule === "paywall.delayed_dismiss")!;
    expect(delay.severity).toBe("high");
    expect(delay.why).toContain("4s");
    for (const f of r.findings) expect(f.fix).not.toMatch(/\b(rename|move|hide)\b/i);
  });

  it("passes a compliant custom paywall", async () => {
    const r = await scan({ "App/PaywallView.swift": GOOD_SWIFT_PAYWALL });
    expect(r.findings).toEqual([]);
    expect(r.data?.restore).toBe(true);
  });

  it("treats SubscriptionStoreView as providing restore and terms", async () => {
    const r = await scan({
      "App/Store.swift": `import StoreKit\nstruct S: View { var body: some View { SubscriptionStoreView(groupID: "123")\n .subscriptionStorePolicyDestination(url: URL(string: "https://example.com/terms")!, for: .termsOfService) } }`,
    });
    expect(rules(r)).not.toContain("paywall.missing_restore");
    expect(rules(r)).not.toContain("paywall.missing_legal_links");
    expect(r.findings.filter((f) => f.severity !== "info")).toEqual([]);
  });

  it("notes RevenueCat PaywallView policy links only as info", async () => {
    const r = await scan({ "App/Paywall.swift": "import RevenueCatUI\nstruct P: View { var body: some View { PaywallView() } }" });
    expect(r.findings.map((f) => [f.rule, f.severity])).toEqual([["paywall.managed_policy_links", "info"]]);
  });

  it("flags a delayed close on a react-native-purchases paywall but not a sub-second animation delay", async () => {
    const base = (ms: number) => `import Purchases from 'react-native-purchases';
export function Paywall() {
  const [showClose, setShowClose] = useState(false);
  useEffect(() => { setTimeout(() => { setShowClose(true) }, ${ms}) }, []);
  const buy = async (pkg) => { await Purchases.purchasePackage(pkg) };
  return <View><Text>{pkg.product.priceString} per month, auto-renews until cancelled</Text><Button title="Restore" onPress={() => Purchases.restorePurchases()} /><Text>Terms of Use</Text><Text>Privacy Policy</Text></View>;
}`;
    const slow = await scan({ "src/screens/Paywall.tsx": base(5000), "package.json": '{"dependencies":{"react-native":"0.76.0"}}' });
    expect(rules(slow)).toEqual(["paywall.delayed_dismiss"]);
    const fast = await scan({ "src/screens/Paywall.tsx": base(300), "package.json": '{"dependencies":{"react-native":"0.76.0"}}' });
    expect(fast.findings).toEqual([]);
  });

  it("flags a near-invisible close button", async () => {
    const r = await scan({
      "App/PaywallView.swift": GOOD_SWIFT_PAYWALL.replace('Image(systemName: "xmark") }', 'Image(systemName: "xmark").opacity(0.1) }'),
    });
    expect(rules(r)).toEqual(["paywall.hidden_dismiss"]);
  });

  it("flags a fixed discount claim but not one computed from prices", async () => {
    const fixed = await scan({ "App/PaywallView.swift": GOOD_SWIFT_PAYWALL.replace('Text("Subscription', 'Text("Save 90% today")\n      Text("Subscription') });
    expect(rules(fixed)).toEqual(["paywall.hardcoded_discount"]);
    expect(fixed.findings[0]!.severity).toBe("medium");
    const computed = await scan({
      "App/PaywallView.swift": GOOD_SWIFT_PAYWALL.replace('Text("Subscription', 'Text("Save \\(savingsPercent)%")\n      Text("Subscription'),
    });
    expect(computed.findings).toEqual([]);
  });

  it("flags hardcoded trial wording without intro-offer data or post-trial terms", async () => {
    const trial = GOOD_SWIFT_PAYWALL.replace('Text("Subscription', 'Text("Start your 7-day free trial")\n      Text("Subscription');
    const r = await scan({ "App/PaywallView.swift": trial });
    expect(rules(r)).toEqual(["paywall.trial_terms"]);
    const ok = await scan({ "App/PaywallView.swift": trial.replace("let product: Product", "let product: Product\n  var intro: Product.SubscriptionOffer? { product.subscription?.introductoryOffer }") });
    expect(ok.findings).toEqual([]);
  });

  it("ignores prices inside SwiftUI previews and mock files", async () => {
    const r = await scan({
      "App/PaywallView.swift": `${GOOD_SWIFT_PAYWALL}\n#Preview {\n  Text("$4.99")\n}\n`,
      "App/Mocks/MockProducts.swift": 'let mockPrice = "$9.99"\nfunc buy() async { try await product.purchase() }',
    });
    expect(r.findings).toEqual([]);
  });

  it("downgrades a price literal used as a fallback next to displayPrice", async () => {
    const r = await scan({
      "App/PaywallView.swift": GOOD_SWIFT_PAYWALL.replace('Text("Subscription', 'Text(product.displayPrice.isEmpty ? "$4.99" : product.displayPrice)\n      Text("Subscription'),
    });
    expect(r.findings.map((f) => [f.rule, f.severity])).toEqual([["paywall.hardcoded_price", "medium"]]);
  });

  it("does not require restore for consumable-only stores", async () => {
    const r = await scan({
      "App/CoinShop.swift": 'import StoreKit\nfunc buy(_ p: Product) async throws { _ = try await p.purchase() }\nlet kind = Product.ProductType.consumable\nlet label = "Buy 100 coins for \\(p.displayPrice)"',
    });
    expect(rules(r)).not.toContain("paywall.missing_restore");
  });

  it("reads delay durations", () => {
    expect(delaySeconds("asyncAfter(deadline: .now() + 3) {")).toBe(3);
    expect(delaySeconds("Task.sleep(nanoseconds: 5_000_000_000)")).toBe(5);
    expect(delaySeconds("Task.sleep(for: .seconds(2))")).toBe(2);
    expect(delaySeconds("setTimeout(() => { setShow(true) }, 2500)")).toBe(2.5);
    expect(delaySeconds("asyncAfter(deadline: delay) {")).toBeUndefined();
  });
});

describe("paywall subscription detection", () => {
  const NATIVE_STORE = `import { requestPurchase, getProducts } from 'react-native-iap'\nexport async function buy(sku: string) {\n  const products = await getProducts({ skus: [sku] })\n  return requestPurchase({ sku, type: 'in-app' })\n}\n`;

  it("does not infer a subscription from period words in unrelated UI copy", async () => {
    const r = await scan({
      "src/services/iap/NativeStore.ts": NATIVE_STORE,
      "src/locales/en.json": `{ "feedback": { "usageFrequency": { "weekly": "Weekly", "monthly": "Monthly" } }, "restore": "Restore Purchases" }`,
    });
    expect(r.data?.subscription).toBe(false);
    expect(rules(r)).not.toContain("paywall.missing_subscription_terms");
  });

  it("infers a subscription from product-type evidence", async () => {
    const r = await scan({
      "src/services/iap/NativeStore.ts": NATIVE_STORE.replace("type: 'in-app'", "type: 'subs'"),
      "src/locales/en.json": `{ "restore": "Restore Purchases" }`,
    });
    expect(r.data?.subscription).toBe(true);
    expect(rules(r)).toContain("paywall.missing_subscription_terms");
  });

  it("sees renewal terms disclosed in a large String Catalog", async () => {
    const pad = Array.from({ length: 30000 }, (_, i) => `"k${i}":{"localizations":{"en":{"stringUnit":{"state":"translated","value":"${"x".repeat(50)}"}}}}`).join(",");
    const r = await scan({
      "App/SupportView.swift": `import StoreKit\nstruct SupportView: View {\n  let product: Product\n  var body: some View {\n    Text(product.displayPrice)\n    Button("Subscribe") { Task { try await product.purchase() } }\n    Button("Restore Purchases") { Task { try? await AppStore.sync() } }\n    Link("Terms of Use", destination: terms)\n    Link("Privacy Policy", destination: privacy)\n    Text(product.subscription?.subscriptionPeriod.debugDescription ?? "")\n  }\n}\n`,
      "App/Localizable.xcstrings": `{"sourceLanguage":"en","strings":{${pad},"settings.support.subscription-info":{"localizations":{"en":{"stringUnit":{"state":"translated","value":"The supporter subscription is a monthly auto renewable subscription, automatically renewed unless you cancel."}}}}}}`,
    });
    expect(rules(r)).not.toContain("paywall.missing_subscription_terms");
  });
});

describe("paywall: subscription findings point at subscription code", () => {
  const oneTime = `import StoreKit\nfinal class RegistrationCoordinator {\n  func buyLogin(product: Product) async throws {\n    let purchaseResult = try await product.purchase()\n    _ = purchaseResult\n  }\n}\n`;
  const manager = `import StoreKit\nfinal class BackupSubscriptionManager {\n  func subscribe(product: Product) async throws {\n    guard product.subscription?.subscriptionPeriod != nil else { return }\n    _ = try await product.purchase()\n  }\n}\n`;

  it("anchors on the subscription manager, not a one-time purchase elsewhere", async () => {
    const r = await scan({
      "Signal/Registration/RegistrationCoordinator.swift": oneTime,
      "SignalServiceKit/Subscriptions/BackupSubscriptionManager.swift": manager,
      "Signal/en.lproj/Localizable.strings": `"BACKUP_PRICE" = "%@/month";\n"RESTORE" = "Restore Purchases";\n`,
    });
    const f = r.findings.find((x) => x.rule === "paywall.missing_subscription_terms");
    expect(f?.file).toBe("SignalServiceKit/Subscriptions/BackupSubscriptionManager.swift");
    expect(f?.line).toBe(5);
  });

  it("cites subscription evidence when the only purchase call is in a non-subscription file", async () => {
    const r = await scan({
      "App/Store.swift": oneTime,
      "App/Plans.swift": `import StoreKit\nfunc period(_ p: Product) -> String? { p.subscription?.subscriptionPeriod.debugDescription }\n`,
      "App/en.lproj/Localizable.strings": `"RESTORE" = "Restore Purchases";\n`,
    });
    const f = r.findings.find((x) => x.rule === "paywall.missing_subscription_terms");
    expect(f?.file).toBe("App/Plans.swift");
    expect(r.findings.find((x) => x.rule === "paywall.missing_restore")).toBeUndefined();
  });

  it("keeps one-time-only apps free of subscription findings", async () => {
    const r = await scan({ "App/Store.swift": oneTime, "App/en.lproj/Localizable.strings": `"RESTORE" = "Restore Purchases";\n` });
    expect(rules(r)).not.toContain("paywall.missing_subscription_terms");
  });
});


describe("paywall: Schedule 2 §3.8(b) items vs renewal wording (field: Signal-iOS)", () => {
  const compliant = `import SwiftUI
import StoreKit
struct PaywallView: View {
    let product: Product
    var body: some View {
        VStack {
            Text("Pro Backup")
            Text("\\(product.displayPrice)/month")
            Text(product.subscription?.subscriptionPeriod.debugDescription ?? "")
            Button("Subscribe") { Task { _ = try? await product.purchase() } }
            Button("Restore Purchases") { Task { try? await AppStore.sync() } }
            Link("Terms of Use", destination: URL(string: "https://example.com/terms")!)
            Link("Privacy Policy", destination: URL(string: "https://example.com/privacy")!)
        }
    }
}
`;

  it("does not raise the high §3.8(b) finding when title, price, period and links are shown", async () => {
    const r = await scan({ "App/PaywallView.swift": compliant });
    expect(rules(r)).not.toContain("paywall.missing_subscription_terms");
    const f = r.findings.find((x) => x.rule === "paywall.renewal_wording");
    expect(f?.severity).toBe("medium");
    expect(f?.guideline).toBe("3.1.2");
    expect(f?.why).not.toContain("3.8(b)");
  });

  it("accepts \"renews monthly\" wording as the renewal disclosure", async () => {
    const r = await scan({
      "App/PaywallView.swift": compliant,
      "App/en.lproj/Localizable.strings": `"SUB_NOTE" = "Your subscription will renew monthly until you cancel it.";\n"RENEWS" = "Renews %@";\n`,
    });
    expect(rules(r)).not.toContain("paywall.renewal_wording");
  });

  it("raises the high finding when the price is never shown", async () => {
    const r = await scan({ "App/PaywallView.swift": compliant.replace("\\(product.displayPrice)/month", "Billed monthly") });
    const f = r.findings.find((x) => x.rule === "paywall.missing_subscription_terms");
    expect(f?.severity).toBe("high");
    expect(f?.why).toContain("price");
    expect(f?.why).not.toContain("auto-renewal");
  });

  it("anchors on the subscription purchase even when it is called on an expression", async () => {
    const r = await scan({
      "Signal/Registration/RegistrationCoordinatorImpl.swift": `import StoreKit\nfinal class Reg {\n  func buy() async throws {\n    let product = try await Product.products(for: ["signup"]).first!\n    purchaseResult = try await product.purchase()\n  }\n}\n`,
      "SignalServiceKit/Subscriptions/Backups/BackupSubscriptionManager.swift": `import StoreKit\nfinal class BackupSubscriptionManager {\n  func log() { Logger.info("Setting up new subscription") }\n  func buy() async throws {\n    switch try await getPaidTierProduct().purchase() { default: break }\n  }\n}\n`,
      "Signal/translations/en.lproj/Localizable.strings": `"RESTORE" = "Restore Purchases";\n`,
    });
    const subs = r.findings.filter((x) => x.rule.startsWith("paywall.") && x.rule !== "paywall.missing_restore");
    expect(subs.length).toBeGreaterThan(0);
    for (const f of subs) expect(f.file).not.toContain("Registration");
    expect(subs.find((x) => x.rule === "paywall.renewal_wording")?.line).toBe(5);
  });

  it("does not anchor subscription findings on a one-time purchase when only renewal wording shows a subscription", async () => {
    const r = await scan({
      "App/Store.swift": `import StoreKit\nfunc buy(_ p: Product) async throws { _ = try await p.purchase() }\n`,
      "App/en.lproj/Localizable.strings": `"RESTORE" = "Restore Purchases";\n"NOTE" = "Renews automatically until cancelled.";\n`,
    });
    for (const f of r.findings.filter((x) => x.rule !== "paywall.missing_restore")) expect(f.file).not.toBe("App/Store.swift");
  });
});

describe("paywall: non-shipping paths (field: DuckDuckGo, Signal-iOS)", () => {
  it("ignores prices in debug menus and build scripts", async () => {
    const debugVc = `import StoreKit\nfinal class SubscriptionDebugViewController {\n  func buy(_ p: Product) async throws { _ = try await p.purchase() }\n  let label = "Only $9.99"\n}\n`;
    const r = await scan({
      "iOS/DuckDuckGo/Settings/Debug/SubscriptionDebugViewController.swift": debugVc,
      "macOS/DebugMenu/SubscriptionDebugMenu.swift": debugVc,
      "Scripts/PriceGenerator.swift": debugVc,
      ".claude/worktrees/feature/App/PaywallView.swift": debugVc,
      ".worktrees/release/App/PaywallView.swift": debugVc,
    });
    expect(r.data?.paywall).toBe(false);
  });
});

// Field (damus Purple): purchases carry appAccountToken and the receipt is posted under the user's account.
describe("paywall.missing_restore with account-bound purchases", () => {
  const purple = (purchase: string) => `import StoreKit
import SwiftUI

struct PurpleView: View {
  let product: Product
  var body: some View {
    Text("\\(product.displayPrice) per month, renews automatically until you cancel.")
    Link("Terms of Use", destination: URL(string: "https://damus.io/eula")!)
    Link("Privacy Policy", destination: URL(string: "https://damus.io/privacy")!)
    Button("Subscribe") { Task { ${purchase} } }
  }
}
`;

  it("downgrades to medium with low confidence when purchases are bound to the user's account", async () => {
    const r = await scan({ "damus/Features/Purple/PurpleView.swift": purple("try await product.purchase(options: [.appAccountToken(id)])") });
    const f = r.findings.find((x) => x.rule === "paywall.missing_restore");
    expect(f?.severity).toBe("medium");
    expect(f?.confidence).toBe("low");
    expect(f?.why).toContain("tied to your account");
    expect(f?.fix).toMatch(/^Add a visible "Restore Purchases"/);
  });

  it("treats a RevenueCat logIn as account-bound", async () => {
    const r = await scan({
      "App/PaywallView.swift": purple("try await product.purchase()"),
      "App/Session.swift": `import RevenueCat\nfunc signIn(_ id: String) async throws { _ = try await Purchases.shared.logIn(id) }\n`,
    });
    expect(r.findings.find((x) => x.rule === "paywall.missing_restore")?.severity).toBe("medium");
  });

  it("stays high without account-bound evidence", async () => {
    const r = await scan({ "App/PaywallView.swift": purple("try await product.purchase()") });
    const f = r.findings.find((x) => x.rule === "paywall.missing_restore");
    expect(f?.severity).toBe("high");
    expect(f?.confidence).toBe("medium");
  });
});

// Field (Proton Mail): StoreKit code lives in a gitignored local package; purchases bind to the session.
describe("paywall.missing_restore when the store implementation is outside the repo", () => {
  const upsell = `import PaymentsNG\nimport SwiftUI\nfinal class UpsellModel {\n  let planPurchasing: PlanPurchasing\n  init(p: PlanPurchasing) { planPurchasing = p }\n  func buy(id: String) async throws { try await planPurchasing.purchase(storeKitProductId: id) }\n}\nstruct UpsellView: View { var body: some View { Text("Upgrade to Mail Plus, auto-renewing subscription, $4.99/month") } }\n`;
  const pkg = `// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(name: "IAP", dependencies: [.package(path: "../../VendorPackages/PaymentsNG"), .package(path: "../Core")], targets: [.target(name: "IAP", dependencies: ["PaymentsNG"])])\n`;

  it("downgrades to medium with low confidence and names the missing local package", async () => {
    const r = await scan({
      "Modules/IAP/Package.swift": pkg,
      "Modules/IAP/Sources/Upsell.swift": upsell,
      "Modules/Core/Sources/Core.swift": "public struct Core {}\n",
    });
    const f = r.findings.find((x) => x.rule === "paywall.missing_restore");
    expect(f?.severity).toBe("medium");
    expect(f?.confidence).toBe("low");
    expect(f?.why).toContain("not in this repo");
    expect(f?.why).toContain("../../VendorPackages/PaymentsNG");
    expect(f?.why).not.toContain("../Core");
    expect(f?.fix).toMatch(/^Check the purchase and restore code/);
  });

  it("downgrades a wrapper purchase call even without a Package.swift", async () => {
    const r = await scan({ "App/Upsell.swift": upsell });
    expect(r.findings.find((x) => x.rule === "paywall.missing_restore")?.severity).toBe("medium");
  });

  it("treats a transaction observer configured with the user's session as account-bound", async () => {
    const r = await scan({
      "App/PaywallView.swift": `import StoreKit\nstruct PaywallView: View {\n  let product: Product\n  var body: some View { Button("Buy") { Task { try await product.purchase() } } }\n}\n`,
      "App/Payments.swift": `final class PaymentsService { func start(session: UserSession) { transactionsObserver.setConfiguration(.init(rustSession: session)) } }\n`,
    });
    const f = r.findings.find((x) => x.rule === "paywall.missing_restore");
    expect(f?.severity).toBe("medium");
    expect(f?.why).toContain("tied to your account");
  });

  it("stays high when StoreKit is called in the repo", async () => {
    const r = await scan({
      "App/PaywallView.swift": `import StoreKit\nstruct PaywallView: View {\n  let product: Product\n  var body: some View { Button("Buy") { Task { try await product.purchase(options: []) } } }\n}\n`,
    });
    expect(r.findings.find((x) => x.rule === "paywall.missing_restore")?.severity).toBe("high");
  });
});

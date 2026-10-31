import { describe, expect, it } from "vitest";
import { check } from "../../src/scanners/ratingsIntegrity.js";
import { ctxFromFiles } from "../helpers.js";

async function scan(files: Record<string, string>) {
  return check.run(await ctxFromFiles(files));
}
const rules = (r: { findings: { rule: string }[] }) => r.findings.map((f) => f.rule);

describe("ratings_integrity", () => {
  it("blocks rate-to-unlock copy and makes it non-suppressible", async () => {
    const r = await scan({
      "App/RewardsView.swift": 'struct R: View { var body: some View { Text("Rate us 5 stars to unlock 100 free coins!") } }',
    });
    const f = r.findings.find((x) => x.rule === "ratings.incentivized_review");
    expect(f?.severity).toBe("block");
    expect(f?.suppressible).toBe(false);
  });

  it("blocks rewards granted right after a review request", async () => {
    const r = await scan({
      "src/review.ts": "import * as StoreReview from 'expo-store-review';\nexport async function ask() {\n  await StoreReview.requestReview();\n  user.coins += 50;\n}",
    });
    expect(r.findings.map((f) => [f.rule, f.severity])).toEqual([["ratings.incentivized_review", "block"]]);
  });

  it("allows a plain system review request and a settings link", async () => {
    const r = await scan({
      "App/ReviewManager.swift": "import StoreKit\nfunc maybeAsk(_ requestReview: RequestReviewAction) {\n  if launches >= 5 { requestReview() }\n}",
      "App/SettingsView.swift": 'Link("Write a Review", destination: URL(string: "https://apps.apple.com/app/id123?action=write-review")!)',
    });
    expect(r.findings).toEqual([]);
    expect((r.data?.reviewRequestSites as unknown[]).length).toBe(2);
  });

  it("flags a sentiment pre-gate that routes unhappy users to feedback", async () => {
    const r = await scan({
      "App/RatePrompt.swift": `import StoreKit
struct RatePrompt: View {
  @Environment(\\.requestReview) var requestReview
  var body: some View {
    Text("Enjoying Snapcook?")
    Button("Yes!") { requestReview() }
    Button("Not really") { openURL(URL(string: "mailto:help@example.com")!) }
  }
}`,
    });
    expect(r.findings.map((f) => [f.rule, f.severity])).toEqual([["ratings.sentiment_gate", "high"]]);
  });

  it("does not treat non-question 'enjoying' copy as a pre-gate", async () => {
    const r = await scan({
      "App/Done.swift": 'import StoreKit\nfunc done() {\n  banner("Keep enjoying your recipes")\n  requestReview()\n  showFeedback("Send feedback")\n}',
    });
    expect(r.findings).toEqual([]);
  });

  it("blocks a custom star-rating prompt that bypasses the system API", async () => {
    const r = await scan({
      "App/StarPrompt.swift": `struct StarPrompt: View {
  @State var rating = 0
  var body: some View {
    HStack { ForEach(1...5, id: \\.self) { i in Image(systemName: i <= rating ? "star.fill" : "star") } }
    Button("Submit") { if rating >= 4 { openURL(URL(string: "itms-apps://itunes.apple.com/app/id123?action=write-review")!) } }
  }
}`,
    });
    expect(rules(r)).toContain("ratings.custom_prompt");
    expect(r.findings.find((f) => f.rule === "ratings.custom_prompt")?.severity).toBe("block");
  });

  it("flags a custom 'rate us' alert that links to the store", async () => {
    const r = await scan({
      "src/RateAlert.ts": "import { Alert, Linking } from 'react-native';\nexport const ask = () => Alert.alert('Rate us', 'Please leave a 5-star review!', [{ text: 'OK', onPress: () => Linking.openURL('https://apps.apple.com/app/id1?action=write-review') }]);",
    });
    expect(r.findings.map((f) => [f.rule, f.severity])).toEqual([["ratings.custom_prompt", "high"]]);
  });

  it("flags hardcoded social proof on a paywall, not elsewhere", async () => {
    const r = await scan({
      "App/PaywallView.swift": 'struct PaywallView: View { var body: some View { Text("Rated 4.9★ by 10,000+ happy users")\n Text("Version 2.0") } }',
      "App/AboutView.swift": 'struct AboutView: View { var body: some View { Text("Loved by 10,000+ users") } }',
    });
    expect(r.findings.map((f) => [f.rule, f.file, f.severity])).toEqual([["ratings.hardcoded_social_proof", "App/PaywallView.swift", "medium"]]);
  });

  it("checks onboarding copy in RN JSX text", async () => {
    const r = await scan({
      "src/onboarding/Welcome.tsx": "export const W = () => <View><Text>The #1 AI photo app</Text><Text>Welcome!</Text></View>;",
    });
    expect(rules(r)).toEqual(["ratings.hardcoded_social_proof"]);
  });

  it("ignores review prompts in comments", async () => {
    const r = await scan({ "App/X.swift": '// Text("Rate us to unlock premium")\nlet x = 1' });
    expect(r.findings).toEqual([]);
  });
});

describe("ratings_integrity false-positive guards", () => {
  it("allows a 'Rate us' settings row in a file that uses an unrelated sheet", async () => {
    const r = await scan({
      "App/SettingsView.swift": `struct SettingsView: View {
  @State var showAbout = false
  var body: some View {
    List {
      Button("About") { showAbout = true }
      Button("Rate us on the App Store") { openURL(URL(string: "https://apps.apple.com/app/id1?action=write-review")!) }
    }
    .sheet(isPresented: $showAbout) { AboutView() }
  }
}`,
    });
    expect(r.findings).toEqual([]);
  });

  it("treats react-native-rate with preferInApp as the system prompt", async () => {
    const r = await scan({
      "src/rate.ts": "import Rate from 'react-native-rate';\nexport const ask = () => Alert.alert('Rate us', 'Leave a review?', [{ text: 'OK', onPress: () => Rate.rate({ AppleAppID: '1', preferInApp: true }) }]);",
    });
    expect(r.findings).toEqual([]);
  });
});

// Field (pocket-casts-ios): decorative stars on each review card were flagged; the bundled App Store rating JSON was not.
describe("ratings.hardcoded_social_proof anchors on the real figure", () => {
  const dir = "podcasts/Onboarding/Plus/UpgradeExperiment/Reviews";
  it("ignores a bare star run on a review card and flags the bundled rating JSON", async () => {
    const r = await scan({
      [`${dir}/PlusPaywallReviewCard.swift`]: 'import SwiftUI\nstruct PlusPaywallReviewCard: View {\n  let review: Review\n  var body: some View {\n    VStack { Text("★★★★★"); Text(review.text) }\n  }\n}\n',
      [`${dir}/PlusPaywallReviewsStars.swift`]: 'import SwiftUI\nstruct PlusPaywallReviewsStars: View {\n  var body: some View { Text(L10n.upgradeExperimentReviewsAppStoreInfo(appStoreInfo.rating, appStoreInfo.reviewCount)) }\n}\n',
      [`${dir}/appStoreInfo.json`]: '{\n  "rating": "4.1",\n  "review_count": "5.7"\n}\n',
    });
    expect(r.findings.map((f) => [f.rule, f.file, f.line])).toEqual([["ratings.hardcoded_social_proof", `${dir}/appStoreInfo.json`, 2]]);
  });

  it("still flags star runs that state a rating", async () => {
    const r = await scan({ "App/PaywallView.swift": 'struct PaywallView: View { var body: some View { Text("★★★★★ 4.8 on the App Store") } }' });
    expect(rules(r)).toEqual(["ratings.hardcoded_social_proof"]);
  });

  it("ignores JSON outside paywall/onboarding and non-numeric or age-rating values", async () => {
    const r = await scan({
      "App/Data/catalog.json": '{ "rating": "4.5" }',
      "App/Onboarding/strings.json": '{ "rating": "Rate us", "ageRating": "4+" }',
      "App/Onboarding/content.json": '{ "rating": "4+" }',
    });
    expect(r.findings).toEqual([]);
  });
});

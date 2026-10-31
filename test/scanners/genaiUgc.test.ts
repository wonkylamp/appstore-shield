import { describe, expect, it } from "vitest";
import { check } from "../../src/scanners/ugcSafeguards.js";
import { ctxFromFiles } from "../helpers.js";

async function run(files: Record<string, string>) {
  const res = await check.run(await ctxFromFiles(files));
  return { findings: res.findings, rules: res.findings.map((f) => f.rule), data: res.data ?? {} };
}

const feed = `import SwiftUI\nimport FirebaseFirestore\nstruct CommunityFeed: View {\n  var body: some View { List(posts) { PostRow(post: $0) } }\n  func load() { Firestore.firestore().collection("posts").getDocuments { _, _ in } }\n  func addComment(_ t: String) {}\n}`;

describe("ugc_safeguards", () => {
  it("does not fire when no UGC or AI content is shown", async () => {
    const { findings, data } = await run({ "App/Settings.swift": `import SwiftUI\nstruct Settings: View { var body: some View { Toggle("Dark", isOn: $dark) } }` });
    expect(findings).toHaveLength(0);
    expect(data.applies).toBe(false);
  });

  it("flags every missing safeguard on a community feed", async () => {
    const { findings, rules } = await run({ "App/Feed.swift": feed });
    expect(rules.sort()).toEqual(["ugc.no_age_gate", "ugc.no_block", "ugc.no_contact", "ugc.no_filter", "ugc.no_report"]);
    expect(findings.find((f) => f.rule === "ugc.no_age_gate")?.severity).toBe("medium");
    expect(findings.find((f) => f.rule === "ugc.no_age_gate")?.guideline).toBe("1.2.1(a)");
    expect(findings.filter((f) => f.rule !== "ugc.no_age_gate").every((f) => f.severity === "high")).toBe(true);
    expect(findings[0]?.file).toBe("App/Feed.swift");
  });

  it("is satisfied when filter, report, block, contact and age gating exist", async () => {
    const { findings } = await run({
      "App/Feed.swift": feed,
      "App/Safety.swift": `import DeclaredAgeRange\nfunc reportPost(_ id: String) {}\nfunc blockUser(_ id: String) {}\nlet supportLink = URL(string: "mailto:support@myapp.io")!\nfunc moderateText(_ t: String) -> Bool { true }\nlet ok = moderateText(draft)\nlet r = try await AgeRangeService.shared.requestAgeRange(ageGates: 18)`,
    });
    expect(findings).toHaveLength(0);
  });

  it("accepts plain UI strings for report and block, and support_url metadata for contact", async () => {
    const { rules } = await run({
      "App/Feed.swift": feed,
      "App/Menu.swift": `Menu { Button("Report") { send() }; Button("Block user") { block() } } label: { Image(systemName: "ellipsis") }`,
      "fastlane/metadata/en-US/support_url.txt": "https://myapp.io/support\n",
    });
    expect(rules).not.toContain("ugc.no_report");
    expect(rules).not.toContain("ugc.no_block");
    expect(rules).not.toContain("ugc.no_contact");
  });

  it("treats AI chat as AI content: report and contact needed, block and filter left to genai_safety", async () => {
    const { rules, data } = await run({ "src/chat.ts": `import OpenAI from "openai";\nawait client.chat.completions.create({ model, messages });` });
    expect(rules).toContain("ugc.no_report");
    expect(rules).toContain("ugc.no_contact");
    expect(rules).not.toContain("ugc.no_block");
    expect(rules).not.toContain("ugc.no_filter");
    expect(data.aiContent).toBe(true);
  });

  it("does not treat a single-user AI chat history store as UGC", async () => {
    const { rules } = await run({ "src/history.ts": `db.collection("users").doc(uid).collection("messages").add(m);` });
    expect(rules).toHaveLength(0);
  });

  it("does not count a word blocklist as a block-user feature", async () => {
    const { rules } = await run({ "App/Feed.swift": feed, "App/Filter.swift": `let blocklist = ["spam"]\nlet clean = !blocklist.contains(text)` });
    expect(rules).toContain("ugc.no_block");
    expect(rules).not.toContain("ugc.no_filter");
  });

  it("does not treat an on-device Foundation Models writing aid as a content platform", async () => {
    const { findings, data } = await run({ "App/Enhance.swift": `import FoundationModels\nlet session = LanguageModelSession()\nlet stream = session.streamResponse(to: prompt, generating: Script.self)` });
    expect(findings).toHaveLength(0);
    expect(data.applies).toBe(false);
  });
});

describe("ugc_safeguards vendor SDK detection", () => {
  it("does not treat an app type named StreamChatParams as the Stream Chat SDK", async () => {
    const { data } = await run({
      "src/api/openai.ts": `export interface StreamChatParams {\n  messages: { role: string; content: string }[]\n  stream: boolean\n}\nexport function toStreamChatParams(m: string[]): StreamChatParams { return { messages: [], stream: true } }\n`,
    });
    expect(data.applies).toBe(false);
  });

  it("detects Stream Chat by import or package", async () => {
    const swift = await run({ "App/Chat.swift": `import StreamChatUI\nimport StreamChat\nlet client = ChatClient(config: config)\n` });
    expect(swift.rules).toContain("ugc.no_report");
    const js = await run({ "src/Chat.tsx": `import { StreamChat } from 'stream-chat'\nconst client = StreamChat.getInstance(KEY)\n` });
    expect(js.rules).toContain("ugc.no_report");
  });

  it("recognises natural report labels and report services, but not bug reports", async () => {
    const reports = [
      `Button("Report inappropriate content") { showReport = true }`,
      `Button("Report this image") { ReportService.report(image: image) }`,
      `Button(action: { flag() }) { Text("Flag as offensive") }`,
      `.sheet(isPresented: $show) { ReportContentSheet(item: item) }`,
      `func send() { moderation.report(content: post, reason: .abuse) }`,
    ];
    for (const r of reports) {
      const { rules } = await run({ "App/Feed.swift": feed, "App/Menu.swift": `import SwiftUI\nstruct M: View {\n  var body: some View { ${r} }\n}\n` });
      expect(rules, r).not.toContain("ugc.no_report");
    }
    for (const r of [`Button("Report a bug") { openBugForm() }`, `Button("Report a problem") { mail() }`, `let reporter = CrashReportService()`, `errorReporter.report(error)`]) {
      const { rules } = await run({ "App/Feed.swift": feed, "App/Menu.swift": `import SwiftUI\nstruct M: View {\n  var body: some View { ${r} }\n}\n` });
      expect(rules, r).toContain("ugc.no_report");
    }
  });
});


describe("ugc_safeguards anchors AI findings on shipping calls (field: pocketpal-ai)", () => {
  it("points at the production generator call, not a debug screen", async () => {
    const { findings } = await run({
      "src/screens/DevToolsScreen/TestCompletionScreen.tsx": `import { initLlama } from "llama.rn";\nexport async function runTest(ctx) { return ctx.chatCompletion; }\n`,
      "src/store/ChatStore.ts": `import { initLlama } from "llama.rn";\nexport async function send(ctx, messages) {\n  return await ctx.chatCompletion({ messages });\n}\n`,
    });
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) expect(f.file).toBe("src/store/ChatStore.ts");
  });
});

describe("ugc_safeguards report coverage per AI output (field: indie-dev r4)", () => {
  const chatView = `import SwiftUI\nstruct ChatView: View {\n  @State var messages: [ChatMessage] = []\n  var body: some View {\n    ForEach(messages) { message in\n      Text(message.text)\n    }\n  }\n}\n`;
  const chatApi = `struct CompanionChat {\n  let endpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent"\n}\n`;
  const imageGen = `struct ImageGenerator {\n  func generate(prompt: String) async throws -> UIImage {\n    var request = URLRequest(url: URL(string: "https://api.replicate.com/v1/predictions")!)\n    return UIImage()\n  }\n}\n`;
  const studio = (report: string) =>
    `import SwiftUI\nstruct StudioView: View {\n  @State var image: UIImage?\n  let generator = ImageGenerator()\n  var body: some View {\n    if let image {\n      Image(uiImage: image)\n      ${report}\n    }\n  }\n}\n`;

  it("a Report button on generated images does not cover chat replies", async () => {
    const { findings } = await run({
      "Sources/Views/ChatView.swift": chatView,
      "Sources/AI/CompanionChat.swift": chatApi,
      "Sources/AI/ImageGenerator.swift": imageGen,
      "Sources/Views/StudioView.swift": studio(`Button("Report this image") { ContentReporter.report(kind: "image") }`),
    });
    const report = findings.filter((f) => f.rule === "ugc.no_report");
    expect(report.map((f) => [f.file, f.line, f.severity])).toEqual([["Sources/Views/ChatView.swift", 6, "high"]]);
    expect(report[0]!.why).toContain("Report path missing for: chat replies (Sources/Views/ChatView.swift:6)");
  });

  it("is satisfied when chat replies and images each have a report action", async () => {
    const { rules } = await run({
      "Sources/Views/ChatView.swift": chatView.replace("Text(message.text)", `Text(message.text).contextMenu { Button("Report") { report(message) } }`),
      "Sources/AI/CompanionChat.swift": chatApi,
      "Sources/AI/ImageGenerator.swift": imageGen,
      "Sources/Views/StudioView.swift": studio(`Button("Report this image") { ContentReporter.report(kind: "image") }`),
    });
    expect(rules).not.toContain("ugc.no_report");
  });

  it("a report action on chat messages does not cover generated images", async () => {
    const { findings } = await run({
      "Sources/Views/ChatView.swift": chatView.replace("Text(message.text)", `Text(message.text).contextMenu { Button("Report message") { report(message) } }`),
      "Sources/AI/CompanionChat.swift": chatApi,
      "Sources/AI/ImageGenerator.swift": imageGen,
      "Sources/Views/StudioView.swift": studio(""),
    });
    const report = findings.filter((f) => f.rule === "ugc.no_report");
    expect(report.map((f) => f.file)).toEqual(["Sources/Views/StudioView.swift"]);
    expect(report[0]!.why).toContain("generated images");
  });

  it("a report service outside any AI view still counts for every output", async () => {
    const { rules } = await run({
      "Sources/Views/ChatView.swift": chatView,
      "Sources/AI/CompanionChat.swift": chatApi,
      "Sources/Safety/Reporting.swift": `final class ReportContentSheet {}\n`,
    });
    expect(rules).not.toContain("ugc.no_report");
  });
});

describe("ugc.no_age_gate is limited to public / creator content (1.2.1(a))", () => {
  it("does not fire for a single-user AI chat", async () => {
    const { rules, data } = await run({ "Shared/ChatGPTAPI.swift": `import OpenAI\nfunc sendMessageStream(text: String) async throws { _ = try await client.chats(query: q) }\nlet q = ChatQuery(messages: [])\n` });
    expect(rules).toContain("ugc.no_report");
    expect(rules).not.toContain("ugc.no_age_gate");
    expect((data.safeguards as Record<string, unknown>).age).toMatch(/not applicable/);
  });

  it("does not fire for team chat posts to the user's own server", async () => {
    const { rules } = await run({
      "app/actions/remote/post.ts": `export async function createPost(serverUrl: string, post: Partial<Post>) {\n  const client = NetworkManager.getClient(serverUrl);\n  return client.createPost({ ...post, channel_id: post.channel_id });\n}\n`,
    });
    expect(rules).toContain("ugc.no_block");
    expect(rules).not.toContain("ugc.no_age_gate");
  });

  it("fires for community posting (Lemmy-style) and follower feeds", async () => {
    const lemmy = await run({ "Mlem/NewPostAction.swift": `func open() { navigation.openSheet(.createPost(community: self.entity, type: nil)) }\nlet communityId = entity.id\n` });
    expect(lemmy.rules).toContain("ugc.no_age_gate");
    const social = await run({ "damus/Views/DirectMessagesView.swift": `struct DirectMessagesView: View { let followers: FollowersModel }\n` });
    expect(social.rules).toContain("ugc.no_age_gate");
  });
});

describe("ugc_safeguards report coverage looks past the listed report sites", () => {
  it("finds a chat report action after many image report sites", async () => {
    const files: Record<string, string> = {
      "Sources/AI/CompanionChat.swift": `struct CompanionChat {\n  let endpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent"\n}\n`,
      "Sources/Views/ZChatView.swift": `import SwiftUI\nstruct ChatView: View {\n  var body: some View {\n    ForEach(messages) { message in\n      Text(message.text).contextMenu { Button("Report message") { report(message) } }\n    }\n  }\n}\n`,
    };
    for (let i = 0; i < 12; i++) files[`Sources/Gallery/A${i}.swift`] = `Button("Report this image") { ContentReporter.report(kind: "image") }\n`;
    const { rules } = await run(files);
    expect(rules).not.toContain("ugc.no_report");
  });
});

describe("ugc_safeguards evidence precision", () => {
  const aiChat = `import OpenAI from "openai";\nawait client.chat.completions.create({ model, messages });`;
  const swiftChat = `import OpenAI\nlet openAI = OpenAI(apiToken: token)\nlet r = try await openAI.chats(query: q)`;

  it("does not count emoji tags in a bundled emoji table as a report action (FlowDown)", async () => {
    const emoji = `[\n  {\n    "emoji": "🇩🇪",\n    "tags": ["flag", "germany"],\n    "category": "Flags"\n  }\n]`;
    const { rules, data } = await run({
      "FlowDown/Chat.swift": swiftChat,
      "FlowDown/BundledResources/Emoji.json": emoji,
      "FlowDown/Support.swift": `let u = URL(string: "mailto:help@flowdown.app")!`,
    });
    expect(rules).toContain("ugc.no_report");
    expect((data.safeguards as { report: unknown[] }).report).toHaveLength(0);
  });

  it("does not count lowercase asset or symbol names as report labels", async () => {
    const { rules } = await run({ "App/Chat.swift": `${swiftChat}\nlet i = UIImage(named: "flag")\nImage(systemName: "flag")` });
    expect(rules).toContain("ugc.no_report");
  });

  it("does not count emoji-picker strings or self-named constants as report actions (Mattermost)", async () => {
    const { rules } = await run({
      "src/chat.ts": aiChat,
      "src/parser.ts": `export enum FieldType {\n    Flag = 'Flag',\n}`,
      "assets/i18n/en.json": `{\n  "emoji_picker.flags": "Flag"\n}`,
    });
    expect(rules).toContain("ugc.no_report");
  });

  it("still counts Lingui tagged-template report labels (graysky)", async () => {
    const { rules } = await run({ "src/chat.ts": aiChat, "src/menu.tsx": `<DropdownMenu.SubTrigger key="report" textValue={_(msg\`Report post\`)} />` });
    expect(rules).not.toContain("ugc.no_report");
  });

  it("does not count asset-catalog @2x filenames as a contact email (react-native-ai)", async () => {
    const { findings, data } = await run({
      "src/chat.ts": aiChat,
      "app/ios/app/Images.xcassets/SplashScreenLogo.imageset/Contents.json": `{\n  "images": [\n    { "idiom": "universal", "filename": "image@2x.png", "scale": "2x" }\n  ]\n}`,
      "src/logo.ts": `export const logo = require("./logo@3x.png");`,
    });
    expect(findings.find((f) => f.rule === "ugc.no_contact")?.severity).toBe("high");
    expect((data.safeguards as { contact: unknown[] }).contact).toHaveLength(0);
  });

  it("still counts a real support address, and ignores mock accounts (Mastodon previews)", async () => {
    const real = await run({ "src/chat.ts": aiChat, "src/about.ts": `export const SUPPORT = "support@myapp.io";` });
    expect(real.rules).not.toContain("ugc.no_contact");
    const mock = await run({
      "src/chat.ts": aiChat,
      "App/PreviewSupport.swift": `let json = """\n{ "acct": "testodon@mastodon.social" }\n"""\nlet mockUser = User(email: "someone@mastodon.social")`,
    });
    expect(mock.rules).toContain("ugc.no_contact");
  });

  it("does not treat a bundler blockList as a content filter (Metro)", async () => {
    const { rules, data } = await run({
      "App/Feed.swift": feed,
      "metro.config.js": `module.exports = {\n  resolver: {\n    blockList: [/node_modules\\/.*\\/test\\/.*/],\n  },\n};`,
    });
    expect(rules).toContain("ugc.no_filter");
    expect(data.safeguards).toMatchObject({ filter: [] });
  });

  it("does not count a Lottie animation as an age gate (Kickstarter onboarding)", async () => {
    const lottie = `{"v":"5.7.4","fr":60,"ip":0,"op":120,"w":375,"h":812,"nm":"onboarding 18+ over 18","layers":[]}`;
    const { rules } = await run({ "App/Feed.swift": feed, "Library/Resources/onboarding-flow-en.json": lottie });
    expect(rules).toContain("ugc.no_age_gate");
  });

  it("does not treat workflow-run followers as a public audience (Mattermost Playbooks)", async () => {
    const team = `import StreamChat\nlet client = ChatClient(config: config)`;
    const playbook = `const count = metadataRes.metadata!.followers.length;\nconst [followersCount, setFollowersCount] = useState(0);`;
    const workspace = await run({ "App/Chat.swift": team, "app/products/playbooks/post_update.tsx": playbook });
    expect(workspace.rules).not.toContain("ugc.no_age_gate");
    const social = await run({ "App/Chat.swift": team, "App/Profile.swift": `struct ProfileView: View { var body: some View { FollowersView(user: u) } }` });
    expect(social.rules).toContain("ugc.no_age_gate");
    const sameView = await run({ "App/Feed.swift": `func createPost() {}\nlet followers = user.followers` });
    expect(sameView.rules).toContain("ugc.no_age_gate");
  });

  it("downgrades no_contact to medium when an About screen links to the developer's site (fullmoon, LLMFarm)", async () => {
    const credits = await run({ "App/Chat.swift": swiftChat, "App/Views/CreditsView.swift": `Link("Mainframe", destination: URL(string: "https://mainfra.me")!)` });
    const f = credits.findings.find((x) => x.rule === "ugc.no_contact");
    expect(f?.severity).toBe("medium");
    expect(f?.why).toContain("App/Views/CreditsView.swift:1");
    expect(f?.why).toContain("Support URL");
    const thirdParty = await run({ "App/Chat.swift": swiftChat, "App/Settings/About.swift": `Link("Model card", destination: URL(string: "https://huggingface.co/mlx-community")!)` });
    expect(thirdParty.findings.find((x) => x.rule === "ugc.no_contact")?.severity).toBe("high");
    const elsewhere = await run({ "App/Chat.swift": `${swiftChat}\nLink("Docs", destination: URL(string: "https://mainfra.me")!)` });
    expect(elsewhere.findings.find((x) => x.rule === "ugc.no_contact")?.severity).toBe("high");
  });
});

// Field (Kickstarter ios-oss): comments go through the app's GraphQL API and the server flags or removes them.
describe("ugc.no_filter when moderation runs on the server", () => {
  const comments = `import SwiftUI\nstruct CommentComposer {\n  func send(_ body: String) async throws { try await api.postComment(body: body) }\n}\n`;
  const safety = `func blockUser(_ id: String) {}\nfunc reportComment(_ id: String) {}\nlet supportEmail = "support@kickstarter.com"\n`;

  it("credits server-set moderation state on posted content as a filter", async () => {
    for (const state of [
      `struct Row: View { let c: Comment; var body: some View { if c.isDeletedOrFlagged { Text("x") } else { Text(c.body) } } }`,
      `let removed = "This comment has been removed by Kickstarter."`,
      `let notice = "Removed for violating our community guidelines"`,
    ]) {
      const { rules, data } = await run({ "App/Comments.swift": `${comments}${state}\n`, "App/Help.swift": safety });
      expect(rules, state).not.toContain("ugc.no_filter");
      expect((data.safeguards as { filter: { label?: string }[] }).filter[0]?.label, state).toBe("server-set moderation state on posted content");
    }
  });

  it("does not take a removed call participant as moderation", async () => {
    const { rules } = await run({ "App/Comments.swift": comments, "App/Help.swift": safety, "app/calls/errors.ts": `export const hostRemovedErr = new Error('user was removed by host');` });
    expect(rules).toContain("ugc.no_filter");
  });

  it("lowers to medium when posts go through the app's API and report and block exist", async () => {
    const { findings } = await run({ "App/Comments.swift": comments, "App/Help.swift": safety });
    const f = findings.find((x) => x.rule === "ugc.no_filter");
    expect(f?.severity).toBe("medium");
    expect(f?.confidence).toBe("low");
    expect(f?.why).toContain("not visible in client code");
    expect(f?.fix).toMatch(/^Disclose in Review Notes/);
  });

  it("stays high for direct client-to-database posting, or without report and block", async () => {
    const direct = await run({ "App/Feed.swift": feed, "App/Help.swift": safety });
    const f = direct.findings.find((x) => x.rule === "ugc.no_filter");
    expect(f?.severity).toBe("high");
    expect(f?.why).toContain("straight from the app to a shared database");
    const noBlock = await run({ "App/Comments.swift": comments, "App/Help.swift": `func reportComment(_ id: String) {}\nlet supportEmail = "support@kickstarter.com"\n` });
    expect(noBlock.findings.find((x) => x.rule === "ugc.no_filter")?.severity).toBe("high");
  });
});

describe("ugc.no_age_gate audience and wording (field: Kickstarter, mlem)", () => {
  const comments = `import SwiftUI\nstruct CommentComposer {\n  func send(_ body: String) async throws { try await api.postComment(body: body) }\n}\n`;

  it("does not take a help-centre 'community' topic as a public audience", async () => {
    const help = await run({ "App/Comments.swift": comments, "App/Help.swift": `enum HelpType { case community, privacy }\nfunc open() { show(HelpType.community) }\n` });
    expect(help.rules).not.toContain("ugc.no_age_gate");
    const guidelines = await run({ "App/Comments.swift": `${comments}let link = community // Community Guidelines\nlet communityGuidelines = HelpType.community\n` });
    expect(guidelines.rules).not.toContain("ugc.no_age_gate");
  });

  it("still counts a community in a file that shows posts", async () => {
    const { rules } = await run({ "App/Feed.swift": `func createPost(in community: Community) {}\n` });
    expect(rules).toContain("ugc.no_age_gate");
  });

  it("says content identification was found when NSFW labelling exists", async () => {
    const { findings, data } = await run({
      "App/Feed.swift": feed,
      "App/Settings/NsfwBlurBehavior.swift": `enum NsfwBlurBehavior { case always, never }\nlet safety_blurNsfw: NsfwBlurBehavior = .always\n`,
    });
    const f = findings.find((x) => x.rule === "ugc.no_age_gate");
    expect(f?.why).toContain("Content identification was found (App/Settings/NsfwBlurBehavior.swift:1)");
    expect(f?.why).toContain("no age restriction was found");
    expect(f?.why).not.toContain("no age identification");
    expect((data.safeguards as { contentLabels?: unknown[] }).contentLabels).toHaveLength(1);
  });

  it("anchors AI-only safeguards on generator code, never on a privacy statement", async () => {
    const { findings } = await run({
      "Resources/Privacy/PrivacyStatements.txt": "We use MLX on device.\nimport MLX\n",
      "FlowDown/Backend/ModelManager.swift": `import MLXLLM\nfinal class ModelManager {}\n`,
    });
    const f = findings.find((x) => x.rule === "ugc.no_report");
    expect(f?.file).toBe("FlowDown/Backend/ModelManager.swift");
  });
});

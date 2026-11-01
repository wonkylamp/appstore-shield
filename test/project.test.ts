import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appRootNotes, compileGitignore, isTestPath, lineOf, loadContext, parseAppPaths, search, stripComments, unreadShippingFiles } from "../src/project.js";
import { tempProject } from "./helpers.js";

describe("stripComments", () => {
  it("blanks swift comments but keeps strings and line numbers", () => {
    const src = 'let a = "// not a comment" // real comment\n/* block /* nested */ still */ let b = 1\nlet c = """\n// kept\n"""';
    const out = stripComments(src, "swift");
    expect(out).toContain('"// not a comment"');
    expect(out).not.toContain("real comment");
    expect(out).not.toContain("nested");
    expect(out).not.toContain("still");
    expect(out).toContain("let b = 1");
    expect(out).toContain("// kept");
    expect(out.length).toBe(src.length);
    expect(out.split("\n").length).toBe(src.split("\n").length);
  });

  it("handles js quotes and template literals", () => {
    const src = "const u = `http://x.dev/${a}` // c\nconst s = 'a//b'";
    const out = stripComments(src, "ts");
    expect(out).toContain("`http://x.dev/${a}`");
    expect(out).toContain("'a//b'");
    expect(out).not.toContain("// c");
  });
});

describe("loadContext", () => {
  it("walks, ignores tests/vendor, detects platforms", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ass-"));
    await mkdir(path.join(root, "App.xcodeproj"), { recursive: true });
    await mkdir(path.join(root, "App"), { recursive: true });
    await mkdir(path.join(root, "AppTests"), { recursive: true });
    await mkdir(path.join(root, "Pods/X"), { recursive: true });
    await writeFile(path.join(root, "App/ContentView.swift"), "// nsfw\nlet mode = \"nsfw\"\n");
    await writeFile(path.join(root, "AppTests/T.swift"), "let nsfw = 1");
    await writeFile(path.join(root, "Pods/X/Y.swift"), "let nsfw = 1");
    await writeFile(path.join(root, "App/Info.plist"), "<plist/>");
    await writeFile(path.join(root, ".gitignore"), "secret.md\n");
    await writeFile(path.join(root, "App/secret.md"), "nsfw");
    const ctx = await loadContext(root);
    expect(ctx.project.platforms).toEqual(["swift"]);
    expect(ctx.project.infoPlists).toEqual(["App/Info.plist"]);
    const hits = search(ctx, /nsfw/);
    expect(hits.map((h) => `${h.file}:${h.line}`)).toEqual(["App/ContentView.swift:2"]);
  });
});

describe("isTestPath", () => {
  it("excludes test targets and JS test tooling", () => {
    for (const p of [
      "AppTests/T.swift", "AppUITests/T.swift", "Tests/X.swift", "src/__tests__/a.ts", "src/__mocks__/a.ts", "test/a.ts",
      "e2e/login.ts", "jest/setup.ts", "detox/shared/server.ts", "src/__automation__/fakeStore.ts", "src/a.test.tsx",
      "src/a.spec.ts", "jest.config.js", "jest.setup.ts", ".detoxrc.js", "maestro/flow.yaml",
    ]) expect(isTestPath(p), p).toBe(true);
  });

  it("keeps product folders whose names merely contain 'tests'", () => {
    for (const p of [
      "Sources/ABTests/OutfitExperiment.swift", "src/abtests/x.ts", "src/contests/Prize.tsx", "app/Protests/List.swift",
      "app/spec/x.ts", "src/latestNews/a.ts", "src/Attestation/a.swift",
    ]) expect(isTestPath(p), p).toBe(false);
  });

  it("scans an ABTests folder in loadContext", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ass-"));
    await mkdir(path.join(root, "Sources/ABTests"), { recursive: true });
    await writeFile(path.join(root, "Sources/ABTests/OutfitExperiment.swift"), 'if RemoteConfig.remoteConfig()["lingerie_enabled"].boolValue { showLingerieOutfits() }\n');
    const ctx = await loadContext(root);
    expect(ctx.files.map((f) => f.path)).toEqual(["Sources/ABTests/OutfitExperiment.swift"]);
  });
});

describe("loadContext decoding and skipped files", () => {
  it("reads UTF-16 .strings files with and without a BOM", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ass-"));
    await mkdir(path.join(root, "Resources/en.lproj"), { recursive: true });
    await mkdir(path.join(root, "Resources/fr.lproj"), { recursive: true });
    const body = '"outfit_lingerie_title" = "Lingerie";\n';
    const be = Buffer.from(body, "utf16le").swap16();
    await writeFile(path.join(root, "Resources/en.lproj/Localizable.strings"), Buffer.concat([Buffer.from([0xfe, 0xff]), be]));
    await writeFile(path.join(root, "Resources/fr.lproj/Localizable.strings"), Buffer.from(body, "utf16le"));
    const ctx = await loadContext(root);
    expect(search(ctx, /outfit_lingerie_title/).map((h) => h.file).sort()).toEqual([
      "Resources/en.lproj/Localizable.strings",
      "Resources/fr.lproj/Localizable.strings",
    ]);
    expect(ctx.skipped).toEqual([]);
  });

  it("reports binary and oversized files instead of dropping them silently", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ass-"));
    await writeFile(path.join(root, "blob.json"), Buffer.from([0x7b, 0x00, 0x01, 0x02, 0x00, 0x00, 0x00, 0x7d, 0x00, 0x00]));
    await writeFile(path.join(root, "big.ts"), `export const x = "${"a".repeat(1_600_000)}";\n`);
    await writeFile(path.join(root, "Localizable.xcstrings"), `{"sourceLanguage":"en","strings":{"k":{"comment":"${"b".repeat(2_300_000)}","localizations":{"en":{"stringUnit":{"value":"Monthly auto renewable subscription"}}}}}}`);
    const ctx = await loadContext(root);
    expect(ctx.files.map((f) => f.path)).toEqual(["Localizable.xcstrings"]);
    expect(ctx.skipped?.map((s) => `${s.path}:${s.reason}`).sort()).toEqual(["big.ts:too-large", "blob.json:binary"]);
  });
});

describe("lineOf", () => {
  it("agrees with a naive count on large text", () => {
    const text = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    for (const idx of [0, 5, 4999, 30000, text.length - 1]) {
      expect(lineOf(text, idx)).toBe(text.slice(0, idx).split("\n").length);
    }
  });
});

describe(".gitignore handling", () => {
  async function project(files: Record<string, string>) {
    const root = await mkdtemp(path.join(tmpdir(), "ass-"));
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await writeFile(path.join(root, rel), text);
    }
    return (await loadContext(root)).files.map((f) => f.path).sort();
  }

  it("applies negations with the last matching rule winning", () => {
    const ig = compileGitignore("*\n!*/\n!*.ts\n");
    expect(ig("src", true)).toBe(false);
    expect(ig("src/a.ts", false)).toBe(false);
    expect(ig("src/a.md", false)).toBe(true);
    const wl = compileGitignore("/*\n!/src/\n!/package.json\n");
    expect(wl("src", true)).toBe(false);
    expect(wl("docs", true)).toBe(true);
    expect(wl("package.json", false)).toBe(false);
    expect(wl("README.md", false)).toBe(true);
    expect(compileGitignore("build/\n")("build", false)).toBe(false);
  });

  it("matches leading **/, trailing /**, inner /**/ and character classes as git does", () => {
    const c = (p: string, rel: string, dir = false) => compileGitignore(p)(rel, dir);
    expect(c("**/foo", "foo")).toBe(true);
    expect(c("**/foo", "a/b/foo")).toBe(true);
    expect(c("**/foo", "barfoo")).toBe(false);
    expect(c("**/foo", "a/barfoo")).toBe(false);
    expect(c("*.py[cod]", "x.pyc")).toBe(true);
    expect(c("*.py[cod]", "a/x.pyd")).toBe(true);
    expect(c("*.py[cod]", "x.pyx")).toBe(false);
    expect(c("[!a]b", "cb")).toBe(true);
    expect(c("[!a]b", "ab")).toBe(false);
    expect(c("foo/**", "foo", true)).toBe(false);
    expect(c("foo/**", "foo/x/y")).toBe(true);
    expect(c("a/**/b", "a/b")).toBe(true);
    expect(c("a/**/b", "a/x/y/b")).toBe(true);
    expect(c("a/**/b", "xa/b")).toBe(false);
    expect(c("doc/frotz", "a/doc/frotz")).toBe(false);
    expect(c("/build", "x/build", true)).toBe(false);
    expect(c("build", "x/build", true)).toBe(true);
  });

  it("matches a pathological .gitignore in linear time (untrusted repo input)", () => {
    const ig = compileGitignore(`${"**/".repeat(40)}zzz\n${"*a".repeat(200)}b\n${"**".repeat(100)}q\n`);
    const t = performance.now();
    expect(ig("src/components/screens/settings/account/profile/ProfileEditScreenContainer.tsx", false)).toBe(false);
    expect(ig("a".repeat(2000), false)).toBe(false);
    expect(performance.now() - t).toBeLessThan(500);
  });

  it("still scans a whitelist-style repo instead of seeing no files", async () => {
    const files = await project({
      ".gitignore": "/*\n!/src/\n!/package.json\n!/app.json\n!/.gitignore\n",
      "package.json": `{"dependencies":{"expo":"1"}}`,
      "src/Gen.tsx": "export const preset = 'nude'\n",
      "src/notes.md": "kept: src/ is re-included",
      "docs/plan.md": "ignored",
    });
    expect(files).toEqual(["package.json", "src/Gen.tsx", "src/notes.md"]);
  });

  it("never lets .gitignore hide shipping sources, but still skips ignored docs", async () => {
    const files = await project({
      ".gitignore": "Sources/AI/\nSources/Views/\n*.md\n",
      "Sources/AI/Generator.swift": "let mode = \"nsfw\"\n",
      "Sources/Views/Info.plist": "<plist/>",
      "Sources/AI/notes.md": "x",
      "README.md": "x",
      "Sources/App.swift": "let a = 1\n",
    });
    expect(files).toEqual(["Sources/AI/Generator.swift", "Sources/App.swift", "Sources/Views/Info.plist"]);
  });

  it("skips a gitignored ios/ prebuild only in an EAS project", async () => {
    const base = { ".gitignore": "/ios\n", "package.json": `{"dependencies":{"expo":"1"}}`, "ios/App/AppDelegate.swift": "let a = 1\n", "App.tsx": "export {}\n" };
    expect(await project({ ...base, "eas.json": "{}" })).toEqual(["App.tsx", "eas.json", "package.json"]);
    expect(await project(base)).toContain("ios/App/AppDelegate.swift");
  });
});

describe("lexing", () => {
  it("does not treat a URL in JSX text as a line comment", () => {
    const src = `const v = (<View>{__DEV__ && <Text>Docs at https://wiki</Text>}\n<Gen /></View>) // real\n`;
    const out = stripComments(src, "tsx");
    expect(out).toContain("https://wiki</Text>}");
    expect(out).not.toContain("// real");
  });

  it("does not let an apostrophe in JSX text hide a later comment or open a string", () => {
    const out = stripComments(`<Text>Don't do it</Text> // note\nconst s = 'kept' // c2\n`, "tsx");
    expect(out).toContain("Don't do it</Text>");
    expect(out).not.toContain("note");
    expect(out).toContain("'kept'");
    expect(out).not.toContain("c2");
  });

  it("skips regex literals, so `/[/*]/` is not a block comment and `/'/` is not a string", () => {
    const out = stripComments(`const a = s.split(/[/*]/)\nconst b = s.replace(/'/g, "") // c\nconst c = x / y / z // d\n`, "ts");
    expect(out).toContain("/[/*]/");
    expect(out).toContain(`s.replace(/'/g, "")`);
    expect(out).not.toContain("// c");
    expect(out).toContain("x / y / z");
    expect(out).not.toContain("// d");
  });
});

describe("loadContext robustness and scope", () => {
  it("reports an unreadable file as skipped instead of aborting the scan", async () => {
    if (process.getuid?.() === 0) return; // root reads mode-000 files
    const root = await mkdtemp(path.join(tmpdir(), "ass-"));
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src/ok.ts"), "export const ok = 1\n");
    await writeFile(path.join(root, "src/locked.ts"), "export const locked = 1\n");
    await chmod(path.join(root, "src/locked.ts"), 0o000);
    try {
      const ctx = await loadContext(root);
      expect(ctx.files.map((f) => f.path)).toEqual(["src/ok.ts"]);
      expect(ctx.skipped).toEqual([{ path: "src/locked.ts", reason: "unreadable", bytes: expect.any(Number), shipping: true }]);
    } finally {
      await chmod(path.join(root, "src/locked.ts"), 0o644);
    }
  });

  it("does not walk vendored binary frameworks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ass-"));
    for (const [rel, text] of Object.entries({
      "App/Chat.swift": "import llama\n",
      "llama.xcframework/ios-arm64/llama.framework/Headers/llama.h": "// deprecated: use llama_moderation\n",
      "Vendor/Foo.framework/Headers/Foo.h": "void foo(void);\n",
    })) {
      await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await writeFile(path.join(root, rel), text);
    }
    expect((await loadContext(root)).files.map((f) => f.path)).toEqual(["App/Chat.swift"]);
  });

  it("excludes test-mock, test-support and scratch test targets but keeps experiment folders", () => {
    for (const p of ["GraphAPI/GraphAPITestMocks/Mutation+Mock.graphql.swift", "FineTune_Test/main.swift", "AppTestSupport/Stub.swift", "Kit/KitTestHelpers/A.swift"]) {
      expect(isTestPath(p), p).toBe(true);
    }
    for (const p of ["Sources/AB_Tests/Outfit.swift", "Sources/SplitTest/Outfit.swift", "app/Contest/List.swift", "Sources/Testimonials/A.swift"]) {
      expect(isTestPath(p), p).toBe(false);
    }
  });
});

describe(".gitignore cost", () => {
  it("bounds the cost of an adversarial .gitignore and then fails open (scans more)", () => {
    const rules = Array.from({ length: 4000 }, (_, i) => `*${i}${"a".repeat(230)}b`).join("\n");
    const t = performance.now();
    const ig = compileGitignore(rules, 20_000_000);
    for (let i = 0; i < 500; i++) expect(ig(`Sources/${"a".repeat(240)}${i}.swift`, false)).toBe(false);
    expect(performance.now() - t).toBeLessThan(10_000);
  });

  it("collapses repeated lines without changing which rule wins", () => {
    const ig = compileGitignore(`${"*.log\n".repeat(3000)}!keep.log\n*.log\n`);
    expect(ig("a/keep.log", false)).toBe(true);
    const neg = compileGitignore(`${"*.log\n".repeat(3000)}!keep.log\n`);
    expect(neg("a/keep.log", false)).toBe(false);
    expect(neg("a/other.log", false)).toBe(true);
  });

  it("stops matching once its step budget is spent", () => {
    const ig = compileGitignore("*.tmp\n", 50);
    expect(ig("a.tmp", false)).toBe(true);
    let last = true;
    for (let i = 0; i < 100; i++) last = ig(`dir${i}/deeper/file${i}.tmp`, false);
    expect(last).toBe(false);
  });
});

describe("monorepo app detection", () => {
  it("detects an Expo app in apps/expo when the root package.json is a workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ass-"));
    for (const [rel, text] of Object.entries({
      "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*", "packages/*"] }),
      "apps/expo/package.json": JSON.stringify({ dependencies: { expo: "~54.0.0", "react-native": "0.81.0", "expo-updates": "~0.28.0" } }),
      "apps/expo/app.config.ts": `export default { expo: { name: "x", updates: { url: "https://u.expo.dev/abc" } } }\n`,
      "apps/expo/eas.json": JSON.stringify({ build: { preview: { channel: "preview" }, production: { channel: "production" } } }),
      "apps/nextjs/package.json": JSON.stringify({ dependencies: { next: "15.0.0" } }),
      "packages/ui/package.json": JSON.stringify({ devDependencies: { "react-native": "0.81.0" } }),
      "examples/demo/package.json": JSON.stringify({ dependencies: { expo: "~54.0.0" } }),
      "apps/expo/ios/App/AppDelegate.swift": "import UIKit\n",
    })) {
      await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await writeFile(path.join(root, rel), text);
    }
    const ctx = await loadContext(root);
    expect(ctx.project.platforms).toEqual(["swift", "react-native", "expo"]);
    expect(ctx.project.appRoot).toBe("apps/expo");
    expect(ctx.project.packageJson).toBe("apps/expo/package.json");
    expect(ctx.project.expoConfig).toBe("apps/expo/app.config.ts");
  });

  it("keeps a root app as the app root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ass-"));
    await mkdir(path.join(root, "apps/other"), { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { "react-native": "0.81.0" } }));
    await writeFile(path.join(root, "apps/other/package.json"), JSON.stringify({ dependencies: { expo: "~54.0.0" } }));
    const ctx = await loadContext(root);
    expect(ctx.project.platforms).toEqual(["react-native"]);
    expect(ctx.project.appRoot).toBeUndefined();
    expect(ctx.project.packageJson).toBe("package.json");
  });
});

describe("appPaths chooses which app folders ship", () => {
  const MONOREPO = {
    "package.json": JSON.stringify({ name: "acme", private: true, workspaces: ["apps/*", "packages/*"], devDependencies: { turbo: "2.0.0" } }),
    "apps/ios/Acme.xcodeproj/project.pbxproj": `/* */\n{ objects = { ABC /* XCLocalSwiftPackageReference "AcmeKit" */ = { isa = XCLocalSwiftPackageReference; relativePath = ../../Shared/AcmeKit; }; }; }\n`,
    "apps/ios/Acme/ContentView.swift": `import SwiftUI\nstruct ContentView: View { var body: some View { Text("hi") } }\n`,
    "apps/ios/Acme/Info.plist": "<plist/>",
    "apps/ios/Acme/PrivacyInfo.xcprivacy": "<plist/>",
    "apps/mobile/package.json": JSON.stringify({ name: "mobile", dependencies: { expo: "51.0.0", "react-native": "0.74.0", "@acme/ui": "workspace:*" } }),
    "apps/mobile/app.json": JSON.stringify({ expo: { name: "Acme" } }),
    "apps/mobile/src/Stale.tsx": "export const stale = 'nsfw';\n",
    "apps/web/src/page.tsx": "export const web = 'nsfw';\n",
    "packages/ui/package.json": JSON.stringify({ name: "@acme/ui" }),
    "packages/ui/src/Button.tsx": "export const ui = 'nsfw';\n",
    "Shared/AcmeKit/Package.swift": "// swift-tools-version:5.9\nimport PackageDescription\n",
    "Shared/AcmeKit/Sources/Kit/Kit.swift": `let kit = "nsfw"\n`,
    "fastlane/metadata/en-US/description.txt": "nsfw notes",
    "workers/api/src/index.ts": "export const worker = 'nsfw';\n",
  };

  it("lists every app root when appPaths is not set, and says how to choose", async () => {
    const ctx = await loadContext(await tempProject(MONOREPO));
    expect(ctx.project.appRoots).toEqual([
      { path: "apps/ios", platform: "swift" },
      { path: "apps/mobile", platform: "expo" },
    ]);
    expect(ctx.project.appPaths).toBeUndefined();
    expect(appRootNotes(ctx.project)).toEqual([
      'Found 2 app roots: apps/ios (swift), apps/mobile (expo); scanning both. If only some ship, set "appPaths" in .appstore-shield/config.json (for example {"appPaths": ["apps/ios"]}) to scan just those.',
    ]);
    expect(search(ctx, /nsfw/).map((h) => h.file)).toContain("apps/mobile/src/Stale.tsx");
  });

  it("scans only the chosen app, linked local packages, repo metadata and server code", async () => {
    const root = await tempProject({ ...MONOREPO, ".appstore-shield/config.json": JSON.stringify({ teamId: "ABCDE12345", appPaths: ["./apps/ios/"] }) });
    const ctx = await loadContext(root);
    expect(ctx.project.appPaths).toEqual(["apps/ios"]);
    expect(ctx.project.platforms).toEqual(["swift"]);
    expect(ctx.project.appRoot).toBeUndefined();
    expect(ctx.project.packageJson).toBeUndefined();
    expect(ctx.project.infoPlists).toEqual(["apps/ios/Acme/Info.plist"]);
    expect(ctx.project.privacyManifests).toEqual(["apps/ios/Acme/PrivacyInfo.xcprivacy"]);
    expect(ctx.project.metadataDirs).toEqual(["fastlane/metadata"]);
    const files = search(ctx, /nsfw/, { raw: true }).map((h) => h.file).sort();
    expect(files).toEqual(["Shared/AcmeKit/Sources/Kit/Kit.swift", "fastlane/metadata/en-US/description.txt", "workers/api/src/index.ts"]);
    // The stale app is still listed, so the developer can see what was left out.
    expect(ctx.project.appRoots.map((r) => r.path)).toEqual(["apps/ios", "apps/mobile"]);
    expect(appRootNotes(ctx.project)).toEqual([
      "Scanning only appPaths from .appstore-shield/config.json: apps/ios, plus repo-level store metadata and in-repo server code. Not scanned: apps/mobile (expo).",
    ]);
  });

  it("follows an Expo app's workspace dependencies into packages/", async () => {
    const root = await tempProject({ ...MONOREPO, ".appstore-shield/config.json": JSON.stringify({ appPaths: ["apps/mobile"] }) });
    const ctx = await loadContext(root);
    expect(ctx.project.platforms).toEqual(["react-native", "expo"]);
    expect(ctx.project.appRoot).toBe("apps/mobile");
    const files = search(ctx, /nsfw/).map((h) => h.file).sort();
    expect(files).toEqual(["apps/mobile/src/Stale.tsx", "fastlane/metadata/en-US/description.txt", "packages/ui/src/Button.tsx", "workers/api/src/index.ts"]);
  });

  it("rejects absolute, parent-relative and missing folders, and then scans the whole repo", async () => {
    const p = parseAppPaths(["/etc", "../other", "apps/../../x", "C:\\\\app", "~/app", "", 7, "apps/ios", "apps/ios/"]);
    expect(p.paths).toEqual(["apps/ios"]);
    expect(p.problems).toHaveLength(7);
    expect(parseAppPaths("apps/ios").problems[0]).toMatch(/must be an array/);
    expect(parseAppPaths([".", "apps/ios"]).paths).toEqual([]);

    const root = await tempProject({ ...MONOREPO, ".appstore-shield/config.json": JSON.stringify({ appPaths: ["../outside", "apps/nope"] }) });
    const ctx = await loadContext(root);
    expect(ctx.project.appPaths).toBeUndefined();
    expect(ctx.project.configProblems?.join("\n")).toMatch(/must not contain ".."[\s\S]*"apps\/nope" is not a scannable folder[\s\S]*whole repo was scanned/);
    expect(search(ctx, /nsfw/).map((h) => h.file)).toContain("apps/mobile/src/Stale.tsx");
  });

  it("follows a Swift package's local path dependencies, but never out of the repo", async () => {
    const root = await tempProject({
      "apps/ios/Package.swift": `let package = Package(name: "App", dependencies: [.package(path: "../../Core"), .package(name: "Esc", path: "../../../outside")])\n`,
      "apps/ios/Sources/App.swift": "let a = 1\n",
      "Core/Sources/Core.swift": `let core = "nsfw"\n`,
      "Other/Sources/Other.swift": `let other = "nsfw"\n`,
      ".appstore-shield/config.json": JSON.stringify({ appPaths: ["apps/ios"] }),
    });
    const ctx = await loadContext(root);
    expect(search(ctx, /nsfw/).map((h) => h.file)).toEqual(["Core/Sources/Core.swift"]);
  });

  it("lets an explicit paths request override appPaths", async () => {
    const root = await tempProject({ ...MONOREPO, ".appstore-shield/config.json": JSON.stringify({ appPaths: ["apps/ios"] }) });
    const ctx = await loadContext(root, { paths: ["apps/mobile"] });
    expect(ctx.project.appPaths).toBeUndefined();
    expect(search(ctx, /nsfw/).map((h) => h.file)).toEqual(["apps/mobile/src/Stale.tsx"]);
  });

  it("treats a bare RN app's ios/ project as part of it, and a root Swift app's vendored project as part of it", async () => {
    const rn = await loadContext(await tempProject({
      "package.json": JSON.stringify({ dependencies: { "react-native": "0.74.0" } }),
      "ios/App.xcodeproj/project.pbxproj": "",
      "src/App.tsx": "export {}\n",
    }));
    expect(rn.project.appRoots).toEqual([{ path: ".", platform: "react-native" }]);
    const sw = await loadContext(await tempProject({
      "App.xcodeproj/project.pbxproj": "",
      "Vendor/Lib/Lib.xcodeproj/project.pbxproj": "",
      "App/A.swift": "let a = 1\n",
      "examples/Demo/Demo.xcodeproj/project.pbxproj": "",
    }));
    expect(sw.project.appRoots).toEqual([{ path: ".", platform: "swift" }]);
  });

  it("marks unread shipping sources so a verdict cannot vouch for them", async () => {
    const big = `let x = 1\n${"let pad = 0\n".repeat(140_000)}`;
    const ctx = await loadContext(await tempProject({ "App.xcodeproj/project.pbxproj": "", "Sources/Big.swift": big, "docs/big.md": big }));
    expect(unreadShippingFiles(ctx).map((s) => `${s.path}:${s.reason}`)).toEqual(["Sources/Big.swift:too-large"]);
  });

  it("does not report unread docs or test scripts as shipping", async () => {
    const ctx = await loadContext(await tempProject({
      "package.json": '{"dependencies":{"react-native":"0.74.0"}}',
      "src/App.tsx": "export {}\n",
      "docs/help/scripts/check-strings.mjs": "const nul = '\u0000\u0000';\n",
      "__tests__/fixture.js": "const nul = '\u0000\u0000';\n",
      "src/blob.js": "const nul = '\u0000\u0000';\n",
    }));
    expect(unreadShippingFiles(ctx).map((s) => s.path)).toEqual(["src/blob.js"]);
  });
});

describe("lexing cost and build products", () => {
  it("scans a 1 MB line of unclosed quote openers in linear time", async () => {
    const { blankStrings } = await import("../src/scope.js");
    for (const line of [`x = "${'"\\'.repeat(500_000)}`, `x = '${"'\\".repeat(500_000)}`, `x = (${"[/".repeat(500_000)}`]) {
      const t = Date.now();
      for (const ext of ["ts", "swift"]) {
        stripComments(line, ext);
        blankStrings(line, ext);
      }
      expect(Date.now() - t).toBeLessThan(4000);
    }
  });

  it("keeps quote and regex lexing results unchanged for ordinary code", async () => {
    const { blankStrings } = await import("../src/scope.js");
    const src = `const a = "it's" // c\nconst b = 'say "hi"' /* c */\nconst re = /["']/g\n<Text>Don't</Text>\nconst c = "\\"\\""\n`;
    expect(stripComments(src, "tsx")).toBe(`const a = "it's"     \nconst b = 'say "hi"'        \nconst re = /["']/g\n<Text>Don't</Text>\nconst c = "\\"\\""\n`);
    expect(blankStrings(src, "tsx").split("\n")[0]).toBe(`const a = "    " // c`);
  });

  it("does not walk archives, built .app bundles or a custom derived-data Build/Products", async () => {
    const root = await tempProject({
      "Till.xcodeproj/project.pbxproj": "",
      "Till/App.swift": "import SwiftUI\nlet d = UserDefaults.standard\n",
      ".asc/artifacts/Till-2.5.1-12.xcarchive/Products/Applications/Till.app/Info.plist": "<plist/>",
      ".asc/artifacts/Till-2.5.1-12.xcarchive/Products/Applications/Till.app/PostHog_PostHog.bundle/PrivacyInfo.xcprivacy": "<plist/>",
      ".dd-main/Build/Products/Release-iphoneos/Till.app/Info.plist": "<plist/>",
      ".dd-main/Build/Intermediates.noindex/Till.build/x.swift": "let x = 1\n",
      "Local/Till.app/Contents/Info.plist": "<plist/>",
      "Till/App.dSYM/Contents/Info.plist": "<plist/>",
      // A source folder named like a domain is not a built bundle.
      "web/acme.app/src/index.ts": "export const a = 1\n",
    });
    const ctx = await loadContext(root);
    const paths = ctx.files.map((f) => f.path).sort();
    expect(paths).toEqual(["Till.xcodeproj/project.pbxproj", "Till/App.swift", "web/acme.app/src/index.ts"]);
    expect(ctx.project.privacyManifests).toEqual([]);
    expect(ctx.project.infoPlists).toEqual([]);
    expect(unreadShippingFiles(ctx)).toEqual([]);
    // An archived SDK's manifest no longer hides the app's own missing one.
    const { check } = await import("../src/scanners/privacyManifest.js");
    expect((await check.run(ctx)).findings.map((f) => f.rule)).toContain("privacy_manifest.missing");
  });

  it("does not count probe or spike apps as app roots", async () => {
    const ctx = await loadContext(await tempProject({
      "app/Notes.xcodeproj/project.pbxproj": "",
      "probes/alarmkit/Probe.xcodeproj/project.pbxproj": "",
      "spikes/voice/Spike.xcodeproj/project.pbxproj": "",
    }));
    expect(ctx.project.appRoots).toEqual([{ path: "app", platform: "swift" }]);
  });
});

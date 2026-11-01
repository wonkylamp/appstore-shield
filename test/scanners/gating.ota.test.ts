import { describe, expect, it } from "vitest";
import { check as ota, type OtaData } from "../../src/scanners/otaUpdates.js";
import { ctxFromFiles } from "../helpers.js";

async function scan(files: Record<string, string>) {
  const r = await ota.run(await ctxFromFiles(files));
  return { ...r, ota: r.data?.ota as OtaData };
}
const rules = (r: { findings: { rule: string; severity: string }[] }) => r.findings.map((f) => `${f.rule}:${f.severity}`);

describe("ota_updates: OTA providers", () => {
  it("reports expo-updates with its URL, runtimeVersion and EAS channels as info + disclosure", async () => {
    const r = await scan({
      "package.json": JSON.stringify({ dependencies: { expo: "~54.0.0", "expo-updates": "~0.28.0", "react-native": "0.81.0" } }),
      "app.json": JSON.stringify({ expo: { name: "x", runtimeVersion: { policy: "appVersion" }, updates: { url: "https://u.expo.dev/abc" } } }),
      "eas.json": JSON.stringify({ build: { production: { channel: "production" }, preview: { channel: "preview" } } }),
      "src/App.tsx": `import * as Updates from 'expo-updates'\nexport async function check() {\n  const u = await Updates.checkForUpdateAsync()\n  if (u.isAvailable) await Updates.fetchUpdateAsync()\n}\n`,
    });
    expect(rules(r)).toEqual(["ota_updates.present:info"]);
    expect(r.findings[0]?.fix).toMatch(/^Disclose/);
    expect(r.findings[0]?.why).toMatch(/drift/);
    const p = r.ota.providers.find((x) => x.provider.startsWith("expo-updates"));
    expect(p?.updatesUrl).toBe("https://u.expo.dev/abc");
    expect(p?.runtimeVersion).toBe("policy:appVersion");
    expect(p?.channels).toEqual(["production", "preview"]);
    expect(p?.usage.length).toBe(2);
    expect(r.ota.present).toBe(true);
  });

  it("does not report expo-updates when updates are disabled", async () => {
    const r = await scan({
      "package.json": JSON.stringify({ dependencies: { "expo-updates": "~0.28.0" } }),
      "app.json": JSON.stringify({ expo: { updates: { enabled: false } } }),
    });
    expect(r.findings).toEqual([]);
    expect(r.ota.present).toBe(false);
  });

  it("reports CodePush and Shorebird", async () => {
    const r = await scan({
      "package.json": JSON.stringify({ dependencies: { "react-native-code-push": "^9.0.0" } }),
      "shorebird.yaml": "app_id: 123\n",
    });
    expect(r.ota.providers.map((p) => p.provider).sort()).toEqual(["CodePush", "Shorebird"]);
    expect(r.findings.every((f) => f.severity === "info")).toBe(true);
  });

  it("finds nothing in a project without OTA", async () => {
    const r = await scan({ "package.json": JSON.stringify({ dependencies: { "react-native": "0.81.0" } }), "src/a.ts": "export const a = 1\n" });
    expect(r.findings).toEqual([]);
    expect(r.ota.present).toBe(false);
  });
});

describe("ota_updates: downloaded code", () => {
  it("blocks eval / new Function on fetched text", async () => {
    const r = await scan({
      "src/plugins.ts": `export async function load(url: string) {\n  const res = await fetch(url)\n  const code = await res.text()\n  return new Function('React', code)(React)\n}\n`,
      "src/inline.js": `export const run = async (u) => eval(await (await fetch(u)).text())\n`,
    });
    expect(rules(r).filter((x) => x === "ota_updates.remote_code:block").length).toBe(2);
  });

  it("does not flag eval of literals or the globalThis polyfill, or eval in server code", async () => {
    const r = await scan({
      "src/poly.js": `var g = Function('return this')()\nvar two = eval("1 + 1")\n`,
      "server/sandbox.ts": `export async function run(u) { const t = await (await fetch(u)).text(); return eval(t) }\n`,
    });
    expect(r.findings).toEqual([]);
  });

  it("blocks JavaScriptCore evaluateScript on downloaded code but not on a bundled script", async () => {
    const pos = await scan({
      "App/Scripts.swift": `import JavaScriptCore\nfunc run(url: URL) async throws {\n  let (data, _) = try await URLSession.shared.data(from: url)\n  let script = String(data: data, encoding: .utf8)!\n  let ctx = JSContext()!\n  ctx.evaluateScript(script)\n}\n`,
    });
    expect(rules(pos)).toEqual(["ota_updates.remote_code:block"]);
    const neg = await scan({
      "App/Local.swift": `import JavaScriptCore\nfunc run() {\n  let path = Bundle.main.path(forResource: "rules", ofType: "js")!\n  let ctx = JSContext()!\n  ctx.evaluateScript(try! String(contentsOfFile: path))\n}\n`,
    });
    expect(neg.findings).toEqual([]);
  });

  it("blocks dlopen of a downloaded library but not of a system library", async () => {
    const pos = await scan({
      "App/Loader.swift": `func load(name: String) {\n  let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]\n  let path = dir.appendingPathComponent(name).path\n  dlopen(path, RTLD_NOW)\n}\n`,
    });
    expect(rules(pos)).toEqual(["ota_updates.remote_code:block"]);
    const neg = await scan({ "App/Z.swift": `func z() {\n  dlopen("/usr/lib/libz.dylib", RTLD_NOW)\n}\n` });
    expect(neg.findings).toEqual([]);
  });

  it("blocks native hot-patching frameworks, not suppressible", async () => {
    const r = await scan({ Podfile: "platform :ios, '15.0'\ntarget 'App' do\n  pod 'JSPatch'\nend\n" });
    const f = r.findings.find((x) => x.rule === "ota_updates.native_hotpatch");
    expect(f?.severity).toBe("block");
    expect(f?.suppressible).toBe(false);
  });
});

describe("ota_updates: monorepo app root", () => {
  it("finds expo-updates and its EAS channels in apps/expo when the root package.json is a workspace", async () => {
    const r = await scan({
      "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"] }),
      "apps/expo/package.json": JSON.stringify({ dependencies: { expo: "~54.0.0", "expo-updates": "~0.28.0", "react-native": "0.81.0" } }),
      "apps/expo/app.json": JSON.stringify({ expo: { name: "x", updates: { url: "https://u.expo.dev/abc" } } }),
      "apps/expo/eas.json": JSON.stringify({ build: { preview: { channel: "preview" }, production: { channel: "production" } } }),
      "apps/nextjs/package.json": JSON.stringify({ dependencies: { next: "15.0.0" } }),
    });
    expect(r.ota.present).toBe(true);
    const p = r.ota.providers.find((x) => x.provider.startsWith("expo-updates"));
    expect(p?.sources).toEqual(["apps/expo/package.json", "apps/expo/app.json", "apps/expo/eas.json"]);
    expect(p?.channels).toEqual(["preview", "production"]);
    expect(p?.updatesUrl).toBe("https://u.expo.dev/abc");
  });
});

describe("remote_code is scoped to the function that evaluates the text", () => {
  // pdf.js compiles PostScript functions from the document; another function nearby fetches.
  const PDFJS = `class PostScriptCompiler{compile(l){return "dest[0]=src[0];"}}function construct(t,l){if(t){const e=(new PostScriptCompiler).compile(l);if(e)return new Function("src","srcOffset","dest","destOffset",e)}}async function loadDoc(u){const e=await fetch(u);return e.arrayBuffer()}`;
  const unminified = PDFJS.replace(/([;{}])/g, "$1\n");
  const RN = {
    "package.json": JSON.stringify({ dependencies: { "react-native": "0.76.0" } }),
    "ios/App.xcodeproj/project.pbxproj": "",
  };

  it("does not block a minified vendored bundle; it reports it as a suppressible lead", async () => {
    const r = await scan({ ...RN, "assets/pdf/pdf.worker.min.js": PDFJS });
    expect(rules(r).filter((x) => x.startsWith("ota_updates.remote_code:block"))).toEqual([]);
  });

  it("does not block the same code unminified", async () => {
    const r = await scan({ ...RN, "src/pdf/worker.js": unminified });
    expect(rules(r)).toEqual([]);
  });

  it("does not scan a sibling web app in a monorepo", async () => {
    const r = await scan({
      "package.json": JSON.stringify({ private: true, workspaces: ["apps/*"] }),
      "apps/mobile/package.json": JSON.stringify({ dependencies: { expo: "~54.0.0", "react-native": "0.81.0" } }),
      "apps/mobile/app.json": JSON.stringify({ expo: { name: "m" } }),
      "apps/web/public/pdf.worker.min.js": PDFJS,
      "apps/web/src/plugins.ts": `export async function load(url: string) {\n  const code = await (await fetch(url)).text()\n  return new Function(code)()\n}\n`,
    });
    expect(r.ota.remoteCode).toEqual([]);
  });

  it("emits high, suppressible, for a vendored bundle that does evaluate fetched text", async () => {
    const r = await scan({ ...RN, "assets/lib/loader.min.js": `async function l(u){const c=await (await fetch(u)).text();return new Function(c)()}` });
    expect(rules(r)).toEqual(["ota_updates.remote_code:high"]);
    expect(r.findings[0]?.suppressible).not.toBe(false);
    expect(r.findings[0]?.fix).toMatch(/remove that path/);
  });

  it("still blocks fetched text evaluated in a promise callback or at top level", async () => {
    const r = await scan({
      "src/a.ts": `export function load(u) {\n  return fetch(u)\n    .then((r) => r.text())\n    .then((code) => {\n      new Function(code)()\n    })\n}\n`,
      "src/b.js": `const res = await fetch(u)\nconst code = await res.text()\neval(code)\n`,
      "App/Run.swift": `import JavaScriptCore\nfunc run(url: URL) {\n  URLSession.shared.dataTask(with: url) { data, _, _ in\n    let script = String(data: data!, encoding: .utf8)!\n    if true {\n      JSContext()!.evaluateScript(script)\n    }\n  }.resume()\n}\n`,
    });
    expect(r.ota.remoteCode.map((x) => x.file).sort()).toEqual(["App/Run.swift", "src/a.ts", "src/b.js"]);
    expect(rules(r).every((x) => x === "ota_updates.remote_code:block")).toBe(true);
  });

  it("does not let a fetch in a neighbouring function vouch for a parameter", async () => {
    const r = await scan({
      "src/c.ts": `async function fetchDoc(u) {\n  const code = await fetch(u)\n  return code.arrayBuffer()\n}\nfunction run(code) {\n  return new Function(code)()\n}\n`,
    });
    expect(r.ota.remoteCode).toEqual([]);
  });
});

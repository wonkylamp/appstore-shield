import { describe, expect, it } from "vitest";
import { stripComments } from "../src/project.js";
import { ResidueSpec } from "../src/ledger/schema.js";
import { verifyRemediation } from "../src/remediation/verify.js";
import { enclosingConditions, isDebugOnly, isRuntimeGated } from "../src/scope.js";
import { check as genaiSafety } from "../src/scanners/genaiSafety.js";
import { ctxFromFiles, tempProject } from "./helpers.js";

function at(src: string, ext: string, needle: string) {
  const code = stripComments(src, ext);
  return enclosingConditions(code, code.indexOf(needle), ext);
}

describe("enclosingConditions", () => {
  it("finds a swift remote-config if around a view", () => {
    const src = `struct V: View {\n  var body: some View {\n    if remoteConfig["spicy_mode"].boolValue {\n      SpicyPicker()\n    }\n  }\n}`;
    const s = at(src, "swift", "SpicyPicker");
    expect(isRuntimeGated(s)).toBe(true);
    expect(s.conditions.some((c) => c.kind === "if" && c.signals.includes("flag"))).toBe(true);
  });

  it("finds a JSX && flag container", () => {
    const src = `export function S() {\n  const on = useFeatureFlag('nsfw')\n  return (<View>{useFeatureFlag('nsfw') && (<Outfits kind="lingerie" />)}</View>)\n}`;
    const s = at(src, "tsx", "<Outfits");
    expect(s.signals).toContain("flag");
  });

  it("detects swift guard and environment", () => {
    const src = `func load() {\n  guard !isTestFlight else { return }\n  showUncensored()\n}`;
    const s = at(src, "swift", "showUncensored");
    expect(s.signals).toContain("environment");
  });

  it("detects #if DEBUG as debug-only", () => {
    const src = `#if DEBUG\nlet menu = DebugMenu()\n#endif\nlet x = 1`;
    const s = at(src, "swift", "DebugMenu");
    expect(isDebugOnly(s)).toBe(true);
    expect(isRuntimeGated(s)).toBe(false);
  });

  it("ignores braces inside strings and reports ungated code", () => {
    const src = `func f() {\n  let s = "if flag { }"\n  generate(prompt)\n}`;
    const s = at(src, "swift", "generate(");
    expect(isRuntimeGated(s)).toBe(false);
  });

  it("finds date gates", () => {
    const src = `if (Date.now() > launchDate) {\n  enableAdult()\n}`;
    const s = at(src, "ts", "enableAdult");
    expect(s.signals).toContain("date");
  });
});

describe("__DEV__ branches", () => {
  it("treats the false arm of a __DEV__ ternary as shipping code", () => {
    const s = at(`const x = __DEV__ ? null : NSFW_FEATURE();\n`, "ts", "NSFW_FEATURE");
    expect(isDebugOnly(s)).toBe(false);
  });

  it("treats the true arm of a __DEV__ ternary as debug-only", () => {
    const s = at(`const x = __DEV__ ? DebugPanel() : null;\n`, "ts", "DebugPanel");
    expect(isDebugOnly(s)).toBe(true);
  });

  it("treats a JSX __DEV__ ternary's release arm as shipping", () => {
    const src = `export function Studio() {\n  return (<View>{__DEV__ ? null : <Text>lingerieOutfitPicker</Text>}</View>)\n}\n`;
    expect(isDebugOnly(at(src, "tsx", "lingerieOutfitPicker"))).toBe(false);
    const dbg = `export function Studio() {\n  return (<View>{__DEV__ ? <Text>debugOverlay</Text> : null}</View>)\n}\n`;
    expect(isDebugOnly(at(dbg, "tsx", "debugOverlay"))).toBe(true);
  });

  it("treats !__DEV__, `__DEV__ || x` and the else block of if (__DEV__) as shipping", () => {
    expect(isDebugOnly(at(`const v = !__DEV__ && <Feature/>\n`, "tsx", "<Feature"))).toBe(false);
    expect(isDebugOnly(at(`if (__DEV__ || isInternal) {\n  showTools()\n}\n`, "ts", "showTools"))).toBe(false);
    expect(isDebugOnly(at(`if (__DEV__) {\n  a()\n} else {\n  shipped()\n}\n`, "ts", "shipped"))).toBe(false);
    expect(isDebugOnly(at(`if (__DEV__) {\n  devOnly()\n}\n`, "ts", "devOnly"))).toBe(true);
  });
});

describe("JSX expression containers versus function bodies", () => {
  it("does not read a function's first statement as a condition on the rest of the body", () => {
    const ts = `export async function gen(prompt: string) {\n  const verbose = __DEV__ && prompt.length > 0\n  return fal.subscribe("m", { input: { enable_safety_checker: false } })\n}\n`;
    expect(isDebugOnly(at(ts, "ts", "enable_safety_checker"))).toBe(false);
    const tern = `function f(): Promise<void> {\n  const x = __DEV__ ? 1 : 2\n  ship()\n}\n`;
    expect(isDebugOnly(at(tern, "ts", "ship()"))).toBe(false);
    const arrow = `const S = () => {\n  const v = __DEV__ && x\n  return <Spicy/>\n}\n`;
    expect(isDebugOnly(at(arrow, "tsx", "<Spicy"))).toBe(false);
    const swift = `func gen() {\n  let style = RemoteConfig.remoteConfig()["s"].stringValue ?? "a"\n  makeImage(style)\n}\n`;
    expect(isRuntimeGated(at(swift, "swift", "makeImage"))).toBe(false);
  });

  it("still reads conditions in child and attribute containers", () => {
    const child = `export function S() {\n  return (\n    <View>\n      {useFeatureFlag('nsfw') && (<Outfits />)}\n    </View>\n  )\n}`;
    expect(at(child, "tsx", "<Outfits").signals).toContain("flag");
    const attr = `export function S() {\n  return <Picker item={remoteConfig().getValue('x').asBoolean() ? <Spicy/> : null} />\n}`;
    expect(at(attr, "tsx", "<Spicy").signals).toContain("flag");
    expect(isDebugOnly(at(`export function S() {\n  return <View>{__DEV__ && <DebugPanel/>}</View>\n}`, "tsx", "<DebugPanel"))).toBe(true);
  });

  it("does not read `??` or `?.` as a ternary", () => {
    const s = at(`export function S() {\n  return <View>{config?.flags ?? <Spicy/>}</View>\n}`, "tsx", "<Spicy");
    expect(s.conditions.some((c) => c.kind === "ternary")).toBe(false);
  });
});

describe("enclosingConditions performance", () => {
  it("stays linear on a large file with many lookups", () => {
    let src = "";
    for (let i = 0; src.length < 400_000; i++) src += `export function f${i}() {\n  if (remoteConfig().getValue("k${i}").asBoolean() && isTestFlight) {\n    show${i}()\n  }\n}\n`;
    const code = stripComments(src, "ts");
    const t = performance.now();
    let n = 0;
    for (let k = code.indexOf("show"); k >= 0 && n < 4000; k = code.indexOf("show", k + 1), n++) {
      expect(enclosingConditions(code, k, "ts").signals).toContain("flag");
    }
    expect(performance.now() - t).toBeLessThan(3000);
  });

  it("finds the enclosing condition across a minified single line", () => {
    const src = `function a(){if(remoteConfig.flag){x()}}function b(){if(isTestFlight){spicy()}}`;
    const s = at(src, "js", "spicy");
    expect(s.signals).toEqual(["environment"]);
  });
});

describe("isDebugOnly: #if conditions", () => {
  const swift = (cond: string) => `#if ${cond}\nif RemoteConfig.remoteConfig()["spicy_mode"].boolValue { Text("Lingerie outfit") }\n#endif\n`;

  it("treats #if DEBUG and #if DEBUG && X as debug-only", () => {
    expect(isDebugOnly(at(swift("DEBUG"), "swift", "Lingerie"))).toBe(true);
    expect(isDebugOnly(at(swift("DEBUG && targetEnvironment(simulator)"), "swift", "Lingerie"))).toBe(true);
    expect(isDebugOnly(at(swift("(DEBUG)"), "swift", "Lingerie"))).toBe(true);
  });

  it("does not treat conditions that also compile into release as debug-only", () => {
    expect(isDebugOnly(at(swift("DEBUG || INTERNAL"), "swift", "Lingerie"))).toBe(false);
    expect(isDebugOnly(at(swift("INTERNAL || DEBUG"), "swift", "Lingerie"))).toBe(false);
    expect(isDebugOnly(at(swift("!DEBUG"), "swift", "Lingerie"))).toBe(false);
    expect(isDebugOnly(at(swift("DEBUG_MENU"), "swift", "Lingerie"))).toBe(false);
    expect(isDebugOnly(at(`#if DEBUG\nlet a = 1\n#else\nText("Lingerie outfit")\n#endif\n`, "swift", "Lingerie"))).toBe(false);
  });
});

describe("isDebugOnly: simulator-only code", () => {
  const swift = (cond: string) => `#if ${cond}\nlet modes = UITextInputMode.activeInputModes\n#endif\n`;

  it("treats #if targetEnvironment(simulator) as non-shipping, alone or OR-ed with DEBUG", () => {
    expect(isDebugOnly(at(swift("targetEnvironment(simulator)"), "swift", "activeInputModes"))).toBe(true);
    expect(isDebugOnly(at(swift("targetEnvironment(simulator) && os(iOS)"), "swift", "activeInputModes"))).toBe(true);
    expect(isDebugOnly(at(swift("DEBUG || targetEnvironment(simulator)"), "swift", "activeInputModes"))).toBe(true);
    expect(isDebugOnly(at(swift("DEBUG && !os(macOS)"), "swift", "activeInputModes"))).toBe(true);
  });

  it("keeps device builds, negations and project-defined flags as shipping", () => {
    expect(isDebugOnly(at(swift("!targetEnvironment(simulator)"), "swift", "activeInputModes"))).toBe(false);
    expect(isDebugOnly(at(swift("targetEnvironment(simulator) || INTERNAL"), "swift", "activeInputModes"))).toBe(false);
    expect(isDebugOnly(at(swift("!(INTERNAL && DEBUG)"), "swift", "activeInputModes"))).toBe(false);
    expect(isDebugOnly(at(swift("UITESTING"), "swift", "activeInputModes"))).toBe(false);
    expect(isDebugOnly(at(`#if targetEnvironment(simulator)\nlet a = 1\n#else\nlet modes = UITextInputMode.activeInputModes\n#endif\n`, "swift", "activeInputModes"))).toBe(false);
  });
});

describe("semicolon-less statements", () => {
  it("does not read a one-line `if (__DEV__) log()` as the header of the next statement", () => {
    const src = `export async function studio(user) {\n  if (__DEV__) console.log("studio opened")\n  return generateImage({ prompt: \`\${user} wearing lingerie\` })\n}\n`;
    const s = at(src, "ts", "generateImage");
    expect(isDebugOnly(s)).toBe(false);
    expect(s.conditions.some((c) => /__DEV__/.test(c.text))).toBe(false);
    const block = `function f() {\n  if (__DEV__) console.log("x")\n  if (flag) {\n    shipped()\n  }\n}\n`;
    expect(isDebugOnly(at(block, "ts", "shipped"))).toBe(false);
  });

  it("still joins a brace-less if header, a dangling else and continued expressions", () => {
    expect(isDebugOnly(at(`function f() {\n  if (__DEV__)\n    devOnly()\n}\n`, "ts", "devOnly"))).toBe(true);
    expect(isDebugOnly(at(`function f() {\n  if (__DEV__)\n  {\n    devOnly()\n  }\n}\n`, "ts", "devOnly"))).toBe(true);
    expect(isDebugOnly(at(`function f() {\n  if (__DEV__) a()\n  else\n    shipped()\n}\n`, "ts", "shipped"))).toBe(false);
    expect(isDebugOnly(at(`function f() {\n  if (__DEV__) a()\n  else if (flag) {\n    shipped()\n  }\n}\n`, "ts", "shipped"))).toBe(false);
    expect(at(`const v = remoteConfig.getBoolean("x")\n  ? spicyFeed()\n  : safeFeed()\n`, "ts", "spicyFeed").signals).toContain("flag");
    expect(at(`const v = remoteConfig.getBoolean("x") &&\n  spicyFeed()\n`, "ts", "spicyFeed").signals).toContain("flag");
  });

  it("does not join a statement ending in a postfix, non-null, JSX or regex closer onto the next line", () => {
    const body = (line: string) => `export async function generate(prompt) {\n  ${line}\n  const out = shippedCall(prompt)\n}\n`;
    for (const line of ["if (__DEV__) calls++", "if (__DEV__) retries--", "const ok = __DEV__ && x!", "if (__DEV__) el = <A />", "if (__DEV__) re = /abc/", "if (__DEV__) n = a > b ? 1 : 0"]) {
      expect(isDebugOnly(at(body(line), "tsx", "shippedCall")), line).toBe(false);
    }
    // Binary operators at a line end still continue the statement.
    for (const line of ["const v = __DEV__ &&", "const v = __DEV__ ?", "const v = __DEV__ && a +", "const v = __DEV__ && a -", "const v = __DEV__ && !", "const f = () =>"]) {
      expect(isDebugOnly(at(`function f() {\n  ${line}\n    shippedCall()\n}\n`, "ts", "shippedCall")), line).toBe(line !== "const f = () =>");
    }
  });

  it("keeps a safety-off call at block severity below a semicolon-less `if (__DEV__) calls++`", async () => {
    const ctx = await ctxFromFiles({
      "package.json": JSON.stringify({ dependencies: { "react-native": "0.76.0", replicate: "1.0.0" } }),
      "ios/App.xcodeproj/project.pbxproj": "",
      "src/gen.ts": `export async function generate(prompt) {\n  if (__DEV__) calls++\n  const out = await replicate.run("x", { input: { prompt, disable_safety_checker: true } })\n  return out\n}\n`,
    });
    const ids = (await genaiSafety.run(ctx)).findings.map((f) => `${f.rule}:${f.severity}`);
    expect(ids).toContain("genai.safety_disabled:block");
    expect(ids.some((i) => i.startsWith("genai.safety_disabled_debug"))).toBe(false);
  });

  it("keeps the condition on a Swift guard's else body", () => {
    const s = at(`func f() {\n  guard remoteConfig["safe"].boolValue else {\n    showSpicy()\n    return\n  }\n}\n`, "swift", "showSpicy");
    expect(s.conditions.some((c) => c.kind === "guard" && c.signals.includes("flag"))).toBe(true);
  });

  it("does not end a statement at a newline inside a multi-line template literal", () => {
    const src = `const p = __DEV__ ? \`\n  debug prompt\n  devPrompt\n\` : ""\n`;
    expect(isDebugOnly(at(src, "ts", "devPrompt"))).toBe(true);
  });
});

describe("__DEV__ arms and lexing of JSX text", () => {
  const view = (body: string) => `export function A() {\n  return (<View>\n    ${body}\n  </View>)\n}\n`;

  it("keeps the release arm of a JSX __DEV__ ternary shipping when that arm has its own braces", () => {
    const rel = view(`{__DEV__ ? <DevMenu /> : <Button onPress={() => fal.subscribe("m", { input: { prompt, enable_safety_checker: false } })} />}`);
    expect(isDebugOnly(at(rel, "tsx", "enable_safety_checker"))).toBe(false);
    const dbg = view(`{__DEV__ ? <DevMenu onPress={() => devOnly()} /> : null}`);
    expect(isDebugOnly(at(dbg, "tsx", "devOnly"))).toBe(true);
  });

  it("keeps the release arm of a plain __DEV__ ternary shipping when it holds an object literal", () => {
    expect(isDebugOnly(at(`const x = __DEV__ ? a : b({ k: shipped })\n`, "ts", "shipped"))).toBe(false);
    expect(isDebugOnly(at(`function f() {\n  return __DEV__ ? null : run(() => { shipped() })\n}\n`, "ts", "shipped"))).toBe(false);
  });

  it("does not let an apostrophe in JSX text swallow the brace that closes a __DEV__ container", () => {
    const src = view(`{__DEV__ && <Text>Don't use in prod</Text>}\n    <Gen onPress={() => fal.subscribe("m", { enable_safety_checker: false })} />`);
    expect(isDebugOnly(at(src, "tsx", "enable_safety_checker"))).toBe(false);
    // Text inside the container is still debug-only.
    expect(isDebugOnly(at(view(`{__DEV__ && <Text>You're on devBuildBanner</Text>}`), "tsx", "devBuildBanner"))).toBe(true);
  });

  it("does not let a quote inside a regex literal swallow the brace that closes an if (__DEV__) block", () => {
    const src = `function f(s) {\n  if (__DEV__) { log(s.replace(/'/g, "")) }\n  shippedCall()\n}\n`;
    expect(isDebugOnly(at(src, "ts", "shippedCall"))).toBe(false);
    const dq = `function f(s) {\n  if (__DEV__) { log(s.replace(/"/g, "'")) }\n  shippedCall()\n}\n`;
    expect(isDebugOnly(at(dq, "ts", "shippedCall"))).toBe(false);
    expect(isDebugOnly(at(`function f(s) {\n  if (__DEV__) { log(s.replace(/'/g, "")); devOnly() }\n}\n`, "ts", "devOnly"))).toBe(true);
  });

  it("does not read a URL in JSX text as a comment that hides the container's closing brace", () => {
    const src = view(`{__DEV__ && <Text>Docs at https://wiki</Text>}\n    <Gen onPress={() => run(shippedTarget)} />`);
    expect(isDebugOnly(at(src, "tsx", "shippedTarget"))).toBe(false);
  });

  it("verifyRemediation still reports residue after a JSX apostrophe inside a __DEV__ container", async () => {
    const spec = ResidueSpec.parse({
      feature: "lingerie outfits",
      capability: "A user can no longer pick a lingerie outfit.",
      terms: ["lingerie"],
    });
    const studio = (text: string) =>
      `import { Text, View, Button } from "react-native";\nexport function Studio() {\n  return (\n    <View>\n      {__DEV__ && <Text>${text}</Text>}\n      <Button title="Lingerie" onPress={() => pick("lingerie")} />\n    </View>\n  );\n}\n`;
    for (const text of ["Don't use in prod", "Do not use in prod"]) {
      const root = await tempProject({ "package.json": JSON.stringify({ dependencies: { "react-native": "0.81.0" } }), "src/Studio.tsx": studio(text) });
      const v = await verifyRemediation(root, spec, { now: "2026-10-31T12:00:00.000Z" });
      expect(v.tier, text).toBe("RESIDUE_FOUND");
      expect(v.residue.filter((r) => r.file === "src/Studio.tsx").map((r) => r.status), text).toContain("PRESENT");
    }
  });
});

describe("__DEV__ conditions are evaluated, not pattern-matched", () => {
  const guarded = (guard: string) => `function f() {\n  if (${guard}) {\n    target()\n  }\n}\n`;

  it("reads every spelling of a release-only guard as shipping", () => {
    for (const g of ["!(__DEV__)", "false === __DEV__", "true !== __DEV__", "false == __DEV__", "!!!__DEV__", "!(__DEV__ && x)", "(__DEV__) === false", "__DEV__ ? false : true", "!__DEV__ && true", "!(((__DEV__)))", "__DEV__ || x", "(__DEV__ && a) || b", "x ?? __DEV__"]) {
      expect(isDebugOnly(at(guarded(g), "ts", "target")), g).toBe(false);
    }
  });

  it("still reads every spelling of a debug-only guard as debug-only", () => {
    for (const g of ["__DEV__", "(__DEV__)", "!!__DEV__", "__DEV__ === true", "true === __DEV__", "false !== __DEV__", "!(!__DEV__)", "__DEV__ && (a || b)", "__DEV__ && user.flags?.x > 0", "!(!__DEV__ || x)", "__DEV__ && foo(a, b)!"]) {
      expect(isDebugOnly(at(guarded(g), "ts", "target")), g).toBe(true);
    }
  });

  it("evaluates the release value of logical and ternary arms in inline guards", () => {
    expect(isDebugOnly(at(`const v = !(__DEV__) && <Feature/>\n`, "tsx", "<Feature"))).toBe(false);
    expect(isDebugOnly(at(`const v = false === __DEV__ ? <Feature/> : null\n`, "tsx", "<Feature"))).toBe(false);
    expect(isDebugOnly(at(`const v = !__DEV__ ? null : <Feature/>\n`, "tsx", "<Feature"))).toBe(true);
    expect(isDebugOnly(at(`const v = !__DEV__ || <Feature/>\n`, "tsx", "<Feature"))).toBe(true);
    expect(isDebugOnly(at(`const v = __DEV__ || <Feature/>\n`, "tsx", "<Feature"))).toBe(false);
    expect(isDebugOnly(at(`run(__DEV__ && x, <Feature/>)\n`, "tsx", "<Feature"))).toBe(false);
  });

  it("treats a condition it cannot parse as shipping", () => {
    expect(isDebugOnly(at(guarded("(__DEV__) (x)"), "ts", "target"))).toBe(false);
    expect(isDebugOnly(at(guarded("__DEV__ as boolean"), "ts", "target"))).toBe(false);
  });

  it("keeps a safety-off generation call under a negated __DEV__ at block severity", async () => {
    for (const g of ["!__DEV__", "!(__DEV__)", "false === __DEV__", "true !== __DEV__", "__DEV__"]) {
      const ctx = await ctxFromFiles({
        "package.json": JSON.stringify({ dependencies: { expo: "54.0.0", "react-native": "0.81.0", "@fal-ai/client": "1.0.0" } }),
        "src/gen.ts": `import { fal } from "@fal-ai/client";\nexport async function gen(prompt: string) {\n  if (${g}) {\n    return fal.subscribe("fal-ai/flux/dev", { input: { prompt, enable_safety_checker: false } })\n  }\n}\n`,
      });
      const ids = (await genaiSafety.run(ctx)).findings.map((f) => `${f.rule}:${f.severity}`);
      if (g === "__DEV__") {
        expect(ids.some((i) => i.startsWith("genai.safety_disabled_debug")), g).toBe(true);
        continue;
      }
      expect(ids, g).toContain("genai.safety_disabled:block");
      expect(ids.some((i) => i.startsWith("genai.safety_disabled_debug")), g).toBe(false);
    }
  });
});

describe("scope lookups stay cheap in malformed code", () => {
  it("bounds the opener walk when unclosed brackets nest every later offset", () => {
    const unit = "if (isReviewer() && ";
    const src = unit.repeat(20_000);
    const t = process.cpuUsage();
    for (let k = 0; k < src.length; k += unit.length * 7) enclosingConditions(src, k + 4, "swift");
    const d = process.cpuUsage(t);
    expect((d.user + d.system) / 1000).toBeLessThan(10_000);
  }, 60_000);

  it("still sees an `if (__DEV__)` many levels out in ordinary nesting", () => {
    const depth = 60;
    const src = `if (__DEV__) {\n${"run(() => {\n".repeat(depth)}  devOnly()\n${"})\n".repeat(depth)}}\n`;
    expect(isDebugOnly(at(src, "ts", "devOnly"))).toBe(true);
  });
});

describe("preprocessor lines inside string literals", () => {
  it("ignores a `#if DEBUG` line inside a Swift multi-line string", () => {
    const src = `let codegenTemplate = """\n#if DEBUG\nprint("generated")\n"""\nlet model = GenerativeModel(name: "gemini")\n`;
    const s = at(src, "swift", "GenerativeModel");
    expect(s.conditions.map((c) => c.text)).not.toContain("#if DEBUG");
    expect(isDebugOnly(s)).toBe(false);
  });

  it("ignores a `#if DEBUG` line inside a JS template literal", () => {
    const src = "const tpl = `\n#if DEBUG\nlog()\n`;\nexport const target = 1;\n";
    expect(isDebugOnly(at(src, "ts", "target"))).toBe(false);
  });

  it("still honours a real #if DEBUG after a multi-line string", () => {
    const src = `let t = """\nhello\n"""\n#if DEBUG\nlet menu = DebugMenu()\n#endif\n`;
    expect(isDebugOnly(at(src, "swift", "DebugMenu"))).toBe(true);
  });

  it("keeps a safety-off Gemini call at block severity below a codegen template", async () => {
    const ctx = await ctxFromFiles({
      "App.xcodeproj/project.pbxproj": "",
      "Sources/Chat.swift": `import GoogleGenerativeAI\nlet codegenTemplate = """\n#if DEBUG\nprint("generated")\n"""\nlet model = GenerativeModel(name: "gemini-1.5-flash", apiKey: key,\n  safetySettings: [SafetySetting(harmCategory: .sexuallyExplicit, threshold: .blockNone)])\n`,
    });
    const ids = (await genaiSafety.run(ctx)).findings.map((f) => `${f.rule}:${f.severity}`);
    expect(ids).toContain("genai.safety_disabled:block");
  });
});

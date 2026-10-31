import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ascBoolFlag, classifyCommand, exposeSubstitutions, findProjectRoot, hookOutput, nonProductionChannel, normalizeShell, stripShellComments, stripWrappers } from "../../src/hook.js";

/** CPU milliseconds `fn` takes: unlike wall time, a loaded CI machine does not inflate it much. */
function cpuMs(fn: () => void): number {
  const t = process.cpuUsage();
  fn();
  const d = process.cpuUsage(t);
  return (d.user + d.system) / 1000;
}

const kind = (cmd: string) => classifyCommand(cmd, "/repo").kind;

describe("classifyCommand: submit-for-review commands are gated", () => {
  it.each([
    "asc review submit --app 123 --version 1.2.3 --build-id B --confirm",
    "asc review submissions-submit --id S1 --confirm",
    "asc publish appstore --app 1 --ipa app.ipa --version 1.2.3 --submit --confirm",
    "ASC_APP_ID=1 asc publish appstore --ipa app.ipa --submit --confirm",
    "fastlane deliver submit_for_review:true",
    "bundle exec fastlane deliver --submit_for_review true --force",
    "fastlane run upload_to_app_store submit_for_review:true",
    "fastlane ios release",
    "bundle exec fastlane submit_review",
    "npm run build && fastlane ios release_appstore",
  ])("%s", (cmd) => expect(kind(cmd)).toBe("submit"));
});

describe("classifyCommand: uploads and everything else pass through", () => {
  it.each([
    "ls -la",
    "eas submit -p ios --latest",
    "xcrun altool --upload-app -f App.ipa -t ios",
    "iTMSTransporter -m upload -assetFile App.ipa",
    "asc builds upload --ipa App.ipa",
    "asc publish appstore --app 1 --ipa app.ipa --version 1.0",
    "asc publish appstore --app 1 --ipa app.ipa --submit --dry-run",
    "asc review submissions list --app 1",
    "asc review history --app 1",
    "fastlane deliver",
    "fastlane deliver submit_for_review:false",
    "fastlane beta",
    "fastlane ios pilot",
    "git commit -m 'release notes for submit'",
    "grep -r release_date src",
  ])("%s", (cmd) => expect(kind(cmd)).toBe("none"));
});

describe("classifyCommand: human-only commands", () => {
  it.each(["appstore-shield attest", "npx appstore-shield ack --rejection ev_1", "node ./dist/cli.js attest --statement x", "cd app && appstore-shield ack"])("%s is denied", (cmd) =>
    expect(kind(cmd)).toBe("human_only"),
  );
  it.each(["appstore-shield status", "node dist/cli.js gate --project .", "grep ack file.txt"])("%s is not", (cmd) => expect(kind(cmd)).not.toBe("human_only"));
});

describe("classifyCommand: quoted text that mentions the CLI is not a run", () => {
  it.each(['git commit -m "docs: explain appstore-shield attest flow"', 'grep -rn "appstore-shield attest" README.md', 'echo "run appstore-shield ack later"', "rg 'node dist/cli.js ack' docs"])("%s", (cmd) =>
    expect(kind(cmd)).toBe("none"),
  );
  it.each(['"appstore-shield" attest', "node --no-warnings dist/cli.js ack --rejection x", "npx appstore-shield@1.0.0 attest"])("%s is still human-only", (cmd) => expect(kind(cmd)).toBe("human_only"));
});

describe("classifyCommand: asc's low-level submit and over-the-air publishes", () => {
  it.each(["asc review submissions-update --id S --submitted=true --confirm", "asc review submissions-update --id S --submitted true --confirm", "asc review submissions-update --id S --confirm --submitted"])("%s submits", (cmd) =>
    expect(kind(cmd)).toBe("submit"),
  );
  it.each(["asc review submissions-update --id S --submitted=false", "asc review submissions-update --id S --platform IOS", "asc testflight review submit --build-id B"])("%s does not", (cmd) => expect(kind(cmd)).toBe("none"));
  it.each(["eas update --branch production", "npx eas-cli update --auto", "expo publish", "appcenter codepush release-react -a me/app", "code-push release MyApp ./build 1.0", "shorebird patch ios", "shorebird patch --platforms=ios"])(
    "%s is an OTA publish",
    (cmd) => expect(kind(cmd)).toBe("ota"),
  );
  it.each(["eas update:list", "eas build -p ios", "eas submit -p ios", "shorebird patch android", "eas update --platform android", "appcenter codepush deployment list -a me/app"])("%s is not", (cmd) => expect(kind(cmd)).toBe("none"));
  it("a submit in the same line outranks the OTA publish, and the channel is reported", () => {
    expect(kind("eas update --auto && asc review submit --app 1")).toBe("submit");
    expect(classifyCommand("eas update --branch preview", "/repo")).toMatchObject({ kind: "ota", channel: "preview" });
  });
});

describe("classifyCommand details", () => {
  it("follows cd and extracts the version", () => {
    const c = classifyCommand("cd ios && asc review submit --app 1 --version 2.0 --build-number 42 --confirm", "/work/app");
    expect(c).toMatchObject({ kind: "submit", cwd: "/work/app/ios", version: "2.0", build: "42" });
  });

  it("marks lanes that are submits only by name, so the hook can check the Fastfile", () => {
    expect(classifyCommand("fastlane ios release_notes", "/repo")).toMatchObject({ kind: "submit", lane: "release_notes" });
    expect(classifyCommand("bundle exec fastlane submit_review", "/repo").lane).toBe("submit_review");
    expect(classifyCommand("fastlane deliver submit_for_review:true", "/repo").lane).toBeUndefined();
    expect(classifyCommand("asc review submit --app 1", "/repo").lane).toBeUndefined();
  });

  it("finds the project root above a subdirectory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hook-root-"));
    await mkdir(path.join(root, "My.xcodeproj"));
    await mkdir(path.join(root, "Sources", "Deep"), { recursive: true });
    await writeFile(path.join(root, "Sources", "Deep", "a.swift"), "");
    expect(findProjectRoot(path.join(root, "Sources", "Deep"))).toBe(root);
  });

  it("emits the PreToolUse decision shape", () => {
    expect(JSON.parse(hookOutput("deny", "r"))).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "r" } });
  });
});

describe("classifyCommand: asc flags as Go's flag package reads them", () => {
  it.each([
    "asc review submissions-update --id S --submitted=t",
    "asc review submissions-update --id S --submitted=TRUE",
    "asc review submissions-update --id S -submitted=true",
    "asc review submissions-update --id S -submitted",
    // Go never lets a bare bool flag take the next word: `false` is a stray argument.
    "asc review submissions-update --id S --submitted false",
    "asc publish appstore --app 1 --ipa x.ipa -submit --confirm",
    "asc publish appstore --app 1 --ipa x.ipa --submit=1 --confirm",
    "asc publish appstore --app 1 --ipa x.ipa --submit --dry-run=false",
    // The last occurrence wins.
    "asc publish appstore --ipa x.ipa --submit --dry-run --dry-run=f",
  ])("%s submits", (cmd) => expect(kind(cmd)).toBe("submit"));
  it.each([
    "asc review submissions-update --id S --submitted=f",
    "asc review submissions-update --id S -submitted=0",
    "asc publish appstore --app 1 --ipa x.ipa -submit -dry-run",
    "asc publish appstore --app 1 --ipa x.ipa --submit --dry-run=t",
    "asc publish appstore --app 1 --ipa x.ipa --submit=false",
  ])("%s does not", (cmd) => expect(kind(cmd)).toBe("none"));

  it("a --dry-run that is another flag's value, or in a comment, does not cancel the submit", () => {
    expect(kind("asc publish appstore --app 1 --ipa x.ipa --submit --confirm --notes '--dry-run'")).toBe("submit");
    expect(kind("asc publish appstore --app 1 --ipa x.ipa --submit --confirm # --dry-run")).toBe("submit");
    expect(kind("asc publish appstore --app 1 --ipa x.ipa --submit --confirm --dry-run # real dry run")).toBe("none");
    expect(ascBoolFlag(["--notes", "--dry-run"], "dry-run", true)).toBeUndefined();
    expect(ascBoolFlag(["--confirm", "--dry-run"], "dry-run", true)).toBe(true);
    expect(ascBoolFlag(["--app=1", "-dry-run"], "dry-run", true)).toBe(true);
  });

  it("text after # still counts, for a shell that does not read it as a comment", () => {
    expect(kind("echo hi #; asc review submit --app 1")).toBe("submit");
  });
});

describe("classifyCommand: shell text normalised the way bash reads it", () => {
  it.each(["asc review sub\\\nmit --app 1", "asc review submit${IFS}--app 1", "asc${IFS}review${IFS}submit", "asc$IFS'review'$IFS'submit'"])("%s submits", (cmd) => expect(kind(cmd)).toBe("submit"));
  it("normalizeShell joins continued lines and breaks words at $IFS, in linear time", () => {
    expect(normalizeShell("a\\\nb ${IFS:0:1}c $IFSX")).toBe("ab  c $IFSX");
    expect(cpuMs(() => normalizeShell("${IFS".repeat(100_000)))).toBeLessThan(5000);
  });
  it("stripShellComments keeps quoted and mid-word #, and drops comments to the end of the line", () => {
    expect(stripShellComments("echo '#x' \"#y\" a#b ${#v} # gone\nnext # also")).toBe("echo '#x' \"#y\" a#b ${#v} \nnext ");
    expect(stripShellComments("#!/bin/sh\nasc review submit")).toBe("\nasc review submit");
    expect(stripShellComments("echo \\# kept")).toBe("echo \\# kept");
  });
});

describe("over-the-air channels and platforms", () => {
  it.each(["preview", "staging", "dev", "preview-pr-12", "beta2", "qa/feature-x", "development"])("%s is a development channel", (c) => expect(nonProductionChannel(c)).toBe(true));
  it.each(["production", "beta-prod", "qa-release", "testing-prod", "staging-main", "devops", "betamax", "live", undefined])("%s is not", (c) => expect(nonProductionChannel(c)).toBe(false));
  it("an update is Android-only only when every platform it names is android", () => {
    expect(kind("eas update --branch production -p android -p ios")).toBe("ota");
    expect(kind("eas update --branch production --platform android,ios")).toBe("ota");
    expect(kind("eas update --branch production -p android --platform=android")).toBe("none");
    expect(kind("eas update --branch production # -p android")).toBe("ota");
  });
  it("reports a production channel when the command names several", () => {
    expect(classifyCommand("eas update --branch preview --channel production", "/repo").channel).toBe("production");
  });
});

describe("classifyCommand stays fast on adversarial input", () => {
  it.each([
    ["repeated words", `asc ${"review ".repeat(70_000)}submit`],
    ["unclosed quotes", `asc review ${'"x '.repeat(150_000)}`],
    ["long assignment chain", `${"A=b ".repeat(120_000)}asc review submit`],
    ["submit_for_review spaces", `fastlane deliver submit_for_review${" ".repeat(500_000)}:x`],
    ["comment markers", `asc review submit ${" #\n".repeat(150_000)}`],
    ["unclosed quote before a comment", `asc publish appstore --submit "${"# ".repeat(150_000)}`],
    ["dash flags", `asc publish appstore ${"-x ".repeat(150_000)}--submit`],
  ])("%s", (_label, cmd) => {
    // Generous: catastrophic backtracking takes minutes, not seconds.
    expect(cpuMs(() => classifyCommand(cmd, "/repo"))).toBeLessThan(5000);
  });
});

describe("classifyCommand: command substitution runs its body", () => {
  it.each([
    'OUT=$(asc review submit --app 1 2>&1); echo "$OUT"',
    'RESULT="$(asc review submit --app 1 --output json)" && echo "$RESULT" | jq .',
    "echo `asc review submit --app 1`",
    'printf "%s" "$(asc publish appstore --submit --app 1)"',
    "cat <(asc review submit --app 1)",
    "tee >(asc review submit --app 1) < /dev/null",
    "echo $(fastlane deliver submit_for_review:true)",
    'x="$(echo "$(asc review submit --app 1)")"',
  ])("%s submits", (cmd) => expect(kind(cmd)).toBe("submit"));
  it.each(["echo $(eas update --branch production -m x)", 'LOG="$(npx eas-cli update --branch production)"'])("%s is an OTA publish", (cmd) => expect(kind(cmd)).toBe("ota"));
  it.each(["echo $(node dist/cli.js attest)", 'git commit -m "$(npx appstore-shield ack --rejection ev_1)"', "V=`appstore-shield attest`"])("%s is human-only", (cmd) =>
    expect(kind(cmd)).toBe("human_only"),
  );
  it.each([
    // Single quotes and comments run nothing.
    "git commit -m 'docs: $(asc review submit) is gated'",
    "echo 'run `asc review submit` later'",
    "ls # $(asc review submit)",
    'echo "$(date)" && git status',
    "echo $((1 + 2))",
  ])("%s does not", (cmd) => expect(kind(cmd)).toBe("none"));

  it("exposeSubstitutions moves each body before its segment and leaves a dynamic word, sparing quotes, comments and plain parens", () => {
    expect(exposeSubstitutions('a; b "$(c (d) e)" f')).toBe('a;\nc (d) e\n b "$__" f');
    expect(exposeSubstitutions("x `y` 'c $(d)' # $(e)")).toBe("\ny\nx $__ 'c $(d)' # $(e)");
    expect(exposeSubstitutions("p <(q) >(r) && s")).toBe("\nq\nr\np $__ $__ && s");
    expect(exposeSubstitutions("$(a $(b)) c")).toBe("\n\nb\na $__\n$__ c");
    expect(exposeSubstitutions("asc x 2>&1 $(y)")).toBe("\ny\nasc x 2>&1 $__");
    // An escaped `$` or backtick is text.
    expect(exposeSubstitutions("x \\$(w)")).toBe("x \\$(w)");
    expect(exposeSubstitutions("a \\`b` c")).toBe("\n c\na \\`b$__");
    expect(exposeSubstitutions("plain (sub) text")).toBe("plain (sub) text");
  });

  it("stays linear on nested and unclosed substitutions", () => {
    for (const cmd of ["$(".repeat(200_000), "`".repeat(400_000), `"$(${"'".repeat(200_000)}`, "$(a)".repeat(100_000)]) {
      expect(cpuMs(() => classifyCommand(cmd, "/repo"))).toBeLessThan(5000);
    }
  });
});

describe("classifyCommand and findProjectRoot: many cd segments", () => {
  it("follows each cd in linear time, and stops at a path longer than any directory can have", () => {
    // CPU time: under the full parallel suite wall time measures the machine.
    const t = process.cpuUsage();
    const c = classifyCommand(`${"cd x; ".repeat(10_000)}asc review submit --app 1`, "/repo");
    const d = process.cpuUsage(t);
    expect((d.user + d.system) / 1000).toBeLessThan(5000);
    expect(c.kind).toBe("submit");
    expect(c.cwd.length).toBeLessThanOrEqual(4096);
  });

  it("with a memo, looks at each directory once however many lookups pass it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hook-memo-"));
    await writeFile(path.join(root, "package.json"), "{}");
    const memo = new Map<string, string | null>();
    let dir = root;
    for (let i = 0; i < 300; i++) {
      dir = path.join(dir, "x");
      expect(findProjectRoot(dir, memo)).toBe(root);
    }
    // One entry per directory passed: each lookup stopped at its remembered parent.
    expect(memo.size).toBe(301);
    expect(findProjectRoot("/nonexistent-a/b", memo)).toBe("/nonexistent-a/b");
  });
});

describe("stripWrappers: one list of wrappers, each with its own options", () => {
  it.each([
    [["timeout", "900", "npm", "run", "ship"], ["npm", "run", "ship"]],
    [["timeout", "-k", "5", "--preserve-status", "900", "eas", "update"], ["eas", "update"]],
    [["nice", "-n", "10", "eas", "update"], ["eas", "update"]],
    [["nice", "-5", "eas"], ["eas"]],
    [["caffeinate", "-i", "-t", "60", "eas"], ["eas"]],
    [["stdbuf", "-oL", "eas"], ["eas"]],
    [["sudo", "-u", "ci", "A=1", "eas"], ["eas"]],
    [["env", "-u", "X", "A=1", "eas"], ["eas"]],
    [["env", "-S", "eas update", "--auto"], ["eas", "update", "--auto"]],
    [["op", "run", "--env-file", ".env", "--", "eas", "update"], ["eas", "update"]],
    [["doppler", "run", "--command", "eas update"], ["eas", "update"]],
    [["dotenv", "-e", ".env.production", "--", "eas"], ["eas"]],
    [["npx", "-y", "-p", "eas-cli", "eas", "update"], ["eas", "update"]],
    [["bundle", "exec", "fastlane", "release"], ["fastlane", "release"]],
    [["npm", "exec", "--", "eas", "update"], ["eas", "update"]],
    [["xcrun", "-sdk", "iphoneos", "altool"], ["altool"]],
    [["arch", "-arm64", "eas"], ["eas"]],
    [["script", "-q", "/dev/null", "eas", "update"], ["eas", "update"]],
    [["watch", "-n", "5", "eas", "update"], ["eas", "update"]],
    [["then", "time", "-p", "nohup", "eas"], ["eas"]],
    [["xargs", "-0", "-I{}", "eas", "update"], ["eas", "update"]],
    [["find", ".", "-name", "x", "-exec", "eas", "update", "{}", ";"], ["eas", "update", "{}", ";"]],
    [["npm", "run", "ship"], ["npm", "run", "ship"]],
    [["op", "item", "get", "x"], ["op", "item", "get", "x"]],
  ])("%j → %j", (words, want) => expect(stripWrappers(words)).toEqual(want));

  it("without descend, find and xargs are the program", () => {
    expect(stripWrappers(["timeout", "5", "find", ".", "-exec", "rm", "{}", ";"], false)[0]).toBe("find");
    expect(stripWrappers(["xargs", "rm"], false)[0]).toBe("xargs");
  });

  it.each(["timeout 600 eas update --branch production", "caffeinate -i eas update --branch production", "op run -- eas update --branch production", "find . -maxdepth 0 -exec eas update --branch production \\;"])(
    "classifyCommand: %s is an OTA publish",
    (cmd) => expect(kind(cmd)).toBe("ota"),
  );
  it.each(["timeout 60 asc review submit --app 1", "nice -n 5 bundle exec fastlane deliver submit_for_review:true"])("classifyCommand: %s submits", (cmd) => expect(kind(cmd)).toBe("submit"));
  it("classifyCommand: timeout 5 appstore-shield ack is human-only", () => expect(kind("timeout 5 appstore-shield ack --rejection x")).toBe("human_only"));

  it("stays linear on deep wrapper chains", () => {
    expect(cpuMs(() => stripWrappers([..."timeout 1 ".repeat(5000).trim().split(" "), "eas"]))).toBeLessThan(5000);
  });
});

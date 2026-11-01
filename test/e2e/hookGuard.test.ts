import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { finding, type Finding } from "../../src/finding.js";
import {
  agentEnvironment,
  bashLedgerWrite,
  clearedEnvironment,
  deliverConfigSubmit,
  detachedCliRun,
  fastfileLanes,
  fastfileSubmitLanes,
  fastlaneLane,
  fileToolDecision,
  humanOnlyRun,
  isSubmitMcpTool,
  lineageProblem,
  looseHumanOnly,
  looseOta,
  looseSubmit,
  type ProcRow,
  resolveGateRoot,
  scriptFileHit,
  stripJsonc,
} from "../../src/hookGuard.js";
import type { LedgerState, RejectionState } from "../../src/ledger/schema.js";
import { guidelineWithin, openRejectionHolds } from "../../src/preflight.js";

describe("looseHumanOnly: attest/ack in any spelling is caught", () => {
  it.each([
    "node dist/cli.js 'attest'",
    `node dist/cli.js "ack" --rejection x`,
    "appstore-shield at''test",
    "C=attest; appstore-shield $C",
    "node dist/cli attest",
    "npx appstore-shield@latest attest",
    "npm exec appstore-shield -- attest",
    "printf attest | xargs appstore-shield",
    "cp dist/cli.js /tmp/s.mjs && node /tmp/s.mjs attest",
    "(sleep 1; printf 'ack ev_rej1\\n') | script -q /dev/null node dist/cli.js 'ack' --project . --rejection ev_rej1",
  ])("%s", (cmd) => expect(looseHumanOnly(cmd)).toBeDefined());

  it.each(["grep ack file.txt", "git commit -m 'ack the reviewer feedback'", "node dist/cli.js gate --project .", "appstore-shield status", "cat acknowledgements.md", "ack TODO src/*.js", "rg -n ack src && ack --js pattern"])(
    "%s is not",
    (cmd) => expect(looseHumanOnly(cmd)).toBeUndefined(),
  );
});

describe("looseSubmit: wrapped submit-for-review forms", () => {
  it.each([
    "bash -c 'asc review submit --version 1.0'",
    "(asc review submit --version 1.0)",
    "true & asc review submit --version 1.0",
    "if true; then asc review submit; fi",
    "\\asc review submit",
    "asc --profile prod review submit",
    "eval asc review submit",
    "sh -c 'asc publish appstore --ipa a.ipa --submit --confirm'",
    "zsh -c 'fastlane deliver submit_for_review:true'",
    "bash -lc 'cd ios && bundle exec fastlane release'",
  ])("%s", (cmd) => expect(looseSubmit(cmd)).toBeDefined());

  it.each([
    "git commit -m 'asc review submit now works'",
    "echo asc review submit",
    "grep -r 'submit_for_review: true' fastlane",
    "asc review submissions list --app 1",
    "bash -c 'asc publish appstore --ipa a.ipa --submit --dry-run'",
    "bash -c 'fastlane deliver submit_for_review:false'",
    "bash -c 'fastlane pilot upload'",
    "ls -la",
  ])("%s is not", (cmd) => expect(looseSubmit(cmd)).toBeUndefined());
});

describe("looseSubmit: asc's low-level submit, and TestFlight beta review", () => {
  it.each([
    "asc review submissions-update --id SUB123 --submitted=true --confirm",
    "asc review submissions-update --id SUB123 --submitted true --confirm",
    "bash -c 'asc review submissions-update --id S --submitted --confirm'",
    "asc --profile prod review submissions update --id S --submitted=yes --confirm",
  ])("%s", (cmd) => expect(looseSubmit(cmd)).toBeDefined());
  it.each(["asc review submissions-update --id S --submitted=false", "asc review submissions-update --id S --canceled=true --confirm", "asc testflight review submit --build-id B --confirm", "bash -c 'asc testflight review submit --build-id B'"])(
    "%s is not",
    (cmd) => expect(looseSubmit(cmd)).toBeUndefined(),
  );
});

describe("looseOta: over-the-air publishes", () => {
  it.each([
    ["eas update --branch production", "eas update"],
    ["bash -c 'npx eas-cli@latest update --auto'", "eas update"],
    ["(npx appcenter codepush release-react -a me/app -d Production)", "appcenter codepush release-react"],
    ["appcenter codepush promote -a me/app -s Staging -d Production", "appcenter codepush promote"],
    ["code-push release-react MyApp ios", "code-push release-react"],
    ["eval shorebird patch ios", "shorebird patch"],
    ["npx expo publish --release-channel prod", "expo publish"],
    ["npx hot-updater deploy -p ios", "hot-updater deploy"],
  ])("%s", (cmd, what) => expect(looseOta(cmd)?.what).toBe(what));
  it.each(["eas update:list", "eas update:configure", "eas submit -p ios", "eas build -p ios", "shorebird patch android", "eas update --platform android", "git commit -m 'eas update fixes'", "echo eas update", "grep -r 'shorebird patch' docs"])(
    "%s is not",
    (cmd) => expect(looseOta(cmd)).toBeUndefined(),
  );
  it("reports the channel the update goes to", () => {
    expect(looseOta("bash -c 'eas update --branch preview'")?.channel).toBe("preview");
  });
});

describe("looseSubmit: variable-expanded and API submit forms", () => {
  it.each([
    "A=asc; $A review submit --app 1",
    "x=review; asc $x submit",
    "S=submit; asc review $S",
    'CMD="asc review submit --app 1"; eval $CMD',
    "`which asc` review submit",
    `curl -X PATCH https://api.appstoreconnect.apple.com/v1/reviewSubmissions/abc -d '{"data":{"attributes":{"submitted":true}}}'`,
    `python3 -c "import requests; requests.patch('https://api.appstoreconnect.apple.com/v1/reviewSubmissions/x', json={'data': {'attributes': {'submitted': True}}})"`,
    "fastlane deliver submit_for_review: true",
    "fastlane deliver --submit-for-review",
    "fastlane deliver --submit_for_review=yes",
  ])("%s", (cmd) => expect(looseSubmit(cmd)).toBeDefined());

  it.each([
    "curl https://api.appstoreconnect.apple.com/v1/reviewSubmissions?filter[app]=1",
    "echo $A review submit",
    "grep -rn reviewSubmissions src",
    "fastlane deliver --submit-for-review false",
    "asc review submissions list --app 1",
    "$EDITOR notes.md",
  ])("%s is not", (cmd) => expect(looseSubmit(cmd)).toBeUndefined());
});

describe("looseSubmit: asc's Go flag spellings, comments, line continuation, $IFS and xargs", () => {
  it.each([
    "bash -c 'asc review submissions-update --id S --submitted=t'",
    "bash -c 'asc review submissions-update --id S -submitted=true'",
    "bash -c 'asc review submissions-update --id S -submitted'",
    // A bare bool flag never takes the next word in Go: this is --submitted=true plus an argument.
    "bash -c 'asc review submissions-update --id S --submitted false'",
    "bash -c 'asc publish appstore --app 1 --ipa x.ipa -submit --confirm'",
    "bash -c 'asc publish appstore --app 1 --ipa x.ipa --submit=T --confirm'",
    "(asc publish appstore --app 1 --ipa x.ipa --submit --confirm # --dry-run\n)",
    "bash -c \"asc publish appstore --app 1 --ipa x.ipa --submit --confirm --notes '--dry-run'\"",
    "bash -c 'asc publish appstore --ipa x.ipa --submit --dry-run=false'",
    "(asc review sub\\\nmit --app 1)",
    "(asc review submit${IFS}--app 1)",
    "(asc${IFS}review${IFS}submit)",
    "printf 'review submit' | xargs asc",
    "echo release | xargs fastlane",
    "xargs -I{} asc review submit --app {} < ids.txt",
  ])("%s", (cmd) => expect(looseSubmit(cmd)).toBeDefined());

  it.each([
    "bash -c 'asc publish appstore --app 1 --ipa x.ipa --submit --confirm --dry-run'",
    "bash -c 'asc publish appstore --app 1 --ipa x.ipa -submit -dry-run'",
    "bash -c 'asc review submissions-update --id S -submitted=F'",
    "echo 123 | xargs asc builds info --id",
    "ls | xargs wc -l",
  ])("%s is not", (cmd) => expect(looseSubmit(cmd)).toBeUndefined());

  it("a comment cannot make an OTA publish Android-only", () => {
    expect(looseOta("bash -c 'eas update --branch production' # -p android")?.what).toBe("eas update");
  });
});

describe("deliverConfigSubmit: fastlane deliver submits when its configuration says so", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "guard-deliver-"));
    await mkdir(path.join(repo, "fastlane"));
  });
  const env = {} as NodeJS.ProcessEnv;

  it("a Deliverfile with submit_for_review(true), with or without a Fastfile", async () => {
    await writeFile(path.join(repo, "fastlane", "Deliverfile"), "app_identifier 'com.x'\nsubmit_for_review(true)\n");
    expect(deliverConfigSubmit("fastlane deliver --force", "deliver", [repo], env)).toMatch(/Deliverfile sets submit_for_review/);
    expect(deliverConfigSubmit("bundle exec fastlane upload_to_app_store", "upload_to_app_store", [repo], env)).toBeDefined();
    // The command line's explicit false wins; downloads and init upload nothing.
    expect(deliverConfigSubmit("fastlane deliver submit_for_review:false", "deliver", [repo], env)).toBeUndefined();
    expect(deliverConfigSubmit("fastlane deliver --submit_for_review false", "deliver", [repo], env)).toBeUndefined();
    expect(deliverConfigSubmit("fastlane deliver download_metadata", "deliver", [repo], env)).toBeUndefined();
    // A comment is not an explicit false.
    expect(deliverConfigSubmit("fastlane deliver # submit_for_review:false", "deliver", [repo], env)).toBeDefined();
    expect(deliverConfigSubmit("fastlane beta", "beta", [repo], env)).toBeUndefined();
  });

  it("a commented-out or false Deliverfile setting does not count", async () => {
    await writeFile(path.join(repo, "fastlane", "Deliverfile"), "# submit_for_review(true)\nsubmit_for_review(false)\n");
    expect(deliverConfigSubmit("fastlane deliver", "deliver", [repo], env)).toBeUndefined();
  });

  it("DELIVER_SUBMIT_FOR_REVIEW in fastlane/.env, .env.default, .env.<--env> or the environment", async () => {
    await writeFile(path.join(repo, "fastlane", ".env.prod"), "FOO=1\nexport DELIVER_SUBMIT_FOR_REVIEW=\"true\"\n");
    expect(deliverConfigSubmit("fastlane deliver", "deliver", [repo], env)).toBeUndefined();
    expect(deliverConfigSubmit("fastlane deliver --env prod", "deliver", [repo], env)).toMatch(/\.env\.prod sets DELIVER_SUBMIT_FOR_REVIEW/);
    expect(deliverConfigSubmit("fastlane deliver --env=staging,prod", "deliver", [repo], env)).toBeDefined();
    await writeFile(path.join(repo, "fastlane", ".env.default"), "DELIVER_SUBMIT_FOR_REVIEW=yes\n");
    expect(deliverConfigSubmit("fastlane deliver", "deliver", [repo], env)).toMatch(/\.env\.default/);
    const other = await mkdtemp(path.join(tmpdir(), "guard-deliver-env-"));
    expect(deliverConfigSubmit("fastlane deliver", "deliver", [other], { DELIVER_SUBMIT_FOR_REVIEW: "1" })).toMatch(/environment/);
    expect(deliverConfigSubmit("fastlane deliver", "deliver", [other], env)).toBeUndefined();
  });

  it("a Fastfile lane that calls deliver submits when the dotenv file turns it on", async () => {
    await writeFile(path.join(repo, "fastlane", "Fastfile"), "lane :ship do\n  deliver(force: true)\nend\n");
    expect(fastfileSubmitLanes([repo]).has("ship")).toBe(false);
    await writeFile(path.join(repo, "fastlane", ".env"), "DELIVER_SUBMIT_FOR_REVIEW=true\n");
    expect(fastfileSubmitLanes([repo]).has("ship")).toBe(true);
  });
});

describe("hook parsing is linear-time", () => {
  // Each of these took seconds to minutes with the old backtracking patterns.
  const big = 500_000;
  const inputs: [string, string][] = [
    ["asc review…", `true asc ${"review ".repeat(big / 7)}; bash -c "asc review submit --app 1"`],
    ["--submit-for-review + spaces", `--submit-for-review${" ".repeat(big)}x`],
    ["submit_for_review + spaces", `fastlane deliver submit_for_review${" ".repeat(big)}x`],
    ["asc publish…", `asc ${"publish ".repeat(big / 8)} --submit`],
    ["closing parens", `${")".repeat(big)}x appstore-shield attest`],
    ["opening parens", `appstore-shield ${"(".repeat(big)}`],
    ["ampersands", `appstore-shield ${"&>".repeat(big / 2)}`],
    ["dollar words", `appstore-shield ${"$x ".repeat(big / 3)}`],
    ["sed flags", `sed ${"-n ".repeat(big / 3)} ~/.appstore-shield/teams/T/events.jsonl`],
    ["api text", `python3 -c "${"appstoreconnect.apple.com reviewSubmission ".repeat(big / 44)}"`],
    ["inline code", `python3 -c '${"a/b.sh ".repeat(big / 7)}'`],
    ["package scripts", `${"npm run x; ".repeat(big / 11)}`],
    ["unclosed quote", `bash -c "${"x ".repeat(big / 2)}`],
  ];
  it.each(inputs)("%s", (_label, cmd) => {
    // CPU time, not wall time: under the full parallel suite wall time measures the machine.
    const t = process.cpuUsage();
    looseSubmit(cmd);
    looseOta(cmd);
    humanOnlyRun(cmd);
    looseHumanOnly(cmd);
    detachedCliRun(cmd);
    bashLedgerWrite(cmd, "/");
    scriptFileHit(cmd, "/nonexistent-dir");
    fastlaneLane(cmd);
    // About 1-3 s of CPU for all eight together at 500 KB, while any backtracking pattern takes
    // minutes. The hook itself never parses over 64 KB.
    const d = process.cpuUsage(t);
    expect((d.user + d.system) / 1000).toBeLessThan(5000);
  });
});

describe("detachedCliRun: the CLI detached from the session or with its environment cleared", () => {
  it.each([
    ["(env -i PATH=$PATH HOME=$HOME npx appstore-shield import ~/Downloads/approval.txt --commit &)", "env -i", "import"],
    ["setsid appstore-shield import a.txt --commit", "setsid", "import"],
    ["nohup node dist/cli.js ack --rejection ev_1", "nohup", "ack"],
    ["appstore-shield import a.txt --commit & disown", "disown", "import"],
    ["bash -c 'appstore-shield gate &'", "a background job (&)", undefined],
    ["env - appstore-shield attest", "env -i", "attest"],
    ["tmux new-session -d 'appstore-shield attest'", "tmux", "attest"],
  ])("%s", (cmd, wrapper, verb) => {
    expect(detachedCliRun(cmd)).toMatchObject({ wrapper, verb });
  });

  it.each([
    "appstore-shield gate --project . 2>&1 | tail -3",
    "node dist/cli.js scan &> out.txt",
    "npm test & wait",
    "git commit -m 'run nohup appstore-shield in CI'",
    "appstore-shield scan . && echo done",
    "env APPSTORE_SHIELD_HOME=/tmp/x appstore-shield status",
  ])("%s is not", (cmd) => expect(detachedCliRun(cmd)).toBeUndefined());
});

describe("scriptFileHit: what a script file the command runs would do", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "guard-script-"));
    await writeFile(path.join(dir, "a.exp"), 'spawn env -i node /x/dist/cli.js attest --statement "removed"\nexpect -re {Type "(.*)"}\n');
    await writeFile(path.join(dir, "ship.sh"), "#!/bin/bash\nset -e\nasc review submit --app 1 --version 2.0\n");
    await writeFile(path.join(dir, "notes.sh"), "#!/bin/bash\n# later: asc review submit --app 1\necho ok\n");
    await writeFile(path.join(dir, "submit.py"), "import requests\nrequests.patch('https://api.appstoreconnect.apple.com/v1/reviewSubmissions/1', json={'data': {'attributes': {'submitted': True}}})\n");
    await writeFile(path.join(dir, "forge.py"), "import subprocess\nsubprocess.run(['appstore-shield', 'import', 'ok.txt', '--commit'])\n");
  });

  it("denies an expect script that drives attest", () => {
    expect(scriptFileHit("(env -i PATH=$PATH /usr/bin/expect $PWD/a.exp > out.txt 2>&1 &)", dir)?.humanOnly).toEqual({ verb: "attest", decision: "deny" });
  });

  it("finds a submit inside a shell or python script", () => {
    expect(scriptFileHit("bash ship.sh", dir)?.submit).toMatch(/asc review submit in ship\.sh/);
    expect(scriptFileHit("./ship.sh", dir)?.submit).toBeDefined();
    expect(scriptFileHit("python3 submit.py", dir)?.submit).toMatch(/App Store Connect API/);
  });

  it("asks for a script that imports with --commit", () => {
    expect(scriptFileHit("python3 forge.py", dir)?.humanOnly).toEqual({ verb: "import --commit", decision: "ask" });
  });

  it("asks when an expect script cannot be read, and ignores comments and unrelated scripts", () => {
    expect(scriptFileHit("expect $SCRIPT", dir)?.humanOnly?.decision).toBe("ask");
    expect(scriptFileHit("bash notes.sh", dir)).toBeUndefined();
    expect(scriptFileHit("cat ship.sh", dir)).toBeUndefined();
    expect(scriptFileHit("bash /dev/zero", dir)).toBeUndefined();
  });
});

describe("scriptFileHit: package scripts, make targets and just recipes", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "guard-tasks-"));
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({
        scripts: {
          "submit:ios": "cd ios && bundle exec fastlane deliver submit_for_review:true --force",
          release: "asc review submit --app 123 --version 1.0",
          ship: "npm run release",
          prepublishit: "appstore-shield ack --rejection ev_1",
          publishit: "echo done",
          shiplane: "cd ios && fastlane ship_it",
          build: "tsc -p .",
          test: "vitest run",
        },
      }),
    );
    await writeFile(path.join(dir, "Makefile"), "# Release targets\n.PHONY: submit all\nall: build\nbuild:\n\tnpm run build\nsubmit: build\n\t@asc review submit --app 1\nupload: ; asc publish appstore --app 1 --ipa a.ipa --submit\n");
    await writeFile(path.join(dir, "justfile"), "set shell := [\"bash\", \"-c\"]\n\nship version='1.0': build\n    asc review submit --app 1 --version {{version}}\nbuild:\n    echo build\n");
  });

  it.each([
    ["npm run submit:ios", /submit_for_review/],
    ["npm run-script release", /asc review submit/],
    ["yarn release", /asc review submit/],
    ["yarn run release", /asc review submit/],
    ["pnpm release", /asc review submit/],
    ["pnpm run release", /asc review submit/],
    ["bun run release", /asc review submit/],
    ["npm run ship", /asc review submit/],
    ["npm --prefix . run release", /asc review submit/],
    ["make submit", /asc review submit/],
    ["make upload", /asc publish/],
    ["just ship 2.0", /asc review submit/],
    ["cd sub && npm run release", /asc review submit/],
  ])("%s submits", async (cmd, what) => {
    await mkdir(path.join(dir, "sub"), { recursive: true });
    expect(scriptFileHit(cmd, dir)?.submit).toMatch(what);
  });

  it("runs pre- and post-scripts, and reports a lane a script runs", () => {
    expect(scriptFileHit("npm run publishit", dir)?.humanOnly).toEqual({ verb: "ack", decision: "deny" });
    expect(scriptFileHit("npm run shiplane", dir)?.lane).toBe("ship_it");
  });

  it.each(["npm run build", "npm test", "yarn install", "pnpm add left-pad", "make", "make build", "just build", "npm run missing"])("%s is not a submission", (cmd) => {
    expect(scriptFileHit(cmd, dir)).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("asks when the package.json a script comes from cannot be read", async () => {
    const fifo = await mkdtemp(path.join(tmpdir(), "guard-fifo-pkg-"));
    execFileSync("mkfifo", [path.join(fifo, "package.json")]);
    expect(scriptFileHit("npm run release", fifo)?.unreadable).toMatch(/package\.json script "release"/);
  });
});

describe("scriptFileHit: inline code, terminal hand-off and the read budget", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "guard-inline-"));
    await writeFile(path.join(dir, "x.sh"), 'appstore-shield ack --rejection ev_1 --note "decided to ship anyway"\n');
    await writeFile(path.join(dir, "s.sh"), "asc review submit --app 1\n");
  });

  it.each([
    `osascript -e 'tell app "Terminal" to do script "bash DIR/x.sh"'`,
    `osascript -e 'tell application "Terminal" to do script "sh x.sh"'`,
    `node -e "require('child_process').execSync('bash x.sh')"`,
    "bash a b c d x.sh",
    "bash -c 'bash x.sh'",
  ])("%s runs attest/ack from a script", (cmd) => {
    expect(scriptFileHit(cmd.replace("DIR", dir), dir)?.humanOnly?.decision).toBe("deny");
  });

  it("finds a submit in a script named by python -c code, and in python code itself", () => {
    expect(scriptFileHit(`python3 -c "import subprocess; subprocess.run(['bash','s.sh'])"`, dir)?.submit).toMatch(/asc review submit in s\.sh/);
    expect(scriptFileHit(`python3 -c "import subprocess; subprocess.run(['asc','review','submit','--app','1'])"`, dir)?.submit).toMatch(/asc review submit/);
  });

  it("flags commands handed to a terminal window", () => {
    expect(scriptFileHit(`osascript -e 'tell app "Terminal" to do script "npm run dev"'`, dir)?.leavesSession).toMatch(/do script/);
    expect(scriptFileHit("open -a Terminal ./run.sh", dir)?.leavesSession).toMatch(/open -a Terminal/);
    expect(scriptFileHit(`osascript -e 'display notification "done"'`, dir)).toBeUndefined();
    expect(scriptFileHit("open -a Safari https://example.com", dir)).toBeUndefined();
  });
});

describe("Fastfile lanes classified by what they do", () => {
  it("lists defined lanes, and separates a release-named lane that does not submit from one computed at run time", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "guard-lanes-"));
    await mkdir(path.join(repo, "fastlane"));
    await writeFile(
      path.join(repo, "fastlane", "Fastfile"),
      [
        "lane :release_notes do",
        "  changelog_from_git_commits",
        "end",
        "lane :release do",
        "  upload_to_app_store(submit_for_review: false)",
        "end",
        "lane :release_maybe do",
        '  deliver(submit_for_review: ENV["SUBMIT"] == "1")',
        "end",
        "lane :via_sh do",
        '  sh("asc review submit --app 1")',
        "end",
      ].join("\n"),
    );
    const lanes = fastfileLanes([repo]);
    expect([...lanes.defined].sort()).toEqual(["release", "release_maybe", "release_notes", "via_sh"]);
    expect([...lanes.submit]).toEqual(["via_sh"]);
    expect([...lanes.unclear]).toEqual(["release_maybe"]);
  });

  it("finds custom lanes that submit, directly, through Deliverfile or through another lane", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "guard-fastlane-"));
    await mkdir(path.join(repo, "fastlane"));
    await writeFile(
      path.join(repo, "fastlane", "Fastfile"),
      [
        "default_platform(:ios)",
        "platform :ios do",
        "  lane :ship_it do",
        "    build_app",
        "    upload_to_app_store(submit_for_review: true, force: true)",
        "  end",
        "  lane :beta do",
        "    pilot",
        "  end",
        "  lane :everything do",
        "    beta",
        "    ship_it",
        "  end",
        "  lane :metadata_only do",
        "    # deliver(submit_for_review: true)",
        "    deliver(skip_binary_upload: true)",
        "  end",
        "end",
      ].join("\n"),
    );
    const lanes = fastfileSubmitLanes([repo]);
    expect([...lanes].sort()).toEqual(["everything", "ship_it"]);
    expect(fastlaneLane("bundle exec fastlane ios ship_it")).toBe("ship_it");
    expect(fastlaneLane("fastlane run upload_to_app_store")).toBeUndefined();

    await writeFile(path.join(repo, "fastlane", "Deliverfile"), "submit_for_review(true)\n");
    expect(fastfileSubmitLanes([repo]).has("metadata_only")).toBe(true);
  });
});

describe("human check: process lineage and environment", () => {
  const row = (ppid: number, tty: string, comm: string): ProcRow => ({ ppid, tty, comm, args: comm });
  const terminal = new Map<number, ProcRow>([
    [710, row(1, "??", "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal")],
    [800, row(710, "ttys001", "login")],
    [801, row(800, "ttys001", "-zsh")],
    [900, row(801, "ttys001", "node")],
  ]);

  it("passes a shell in a terminal app, over ssh and in tmux", () => {
    expect(lineageProblem(terminal, 900)).toBeUndefined();
    const tmux = new Map<number, ProcRow>([
      [50, row(1, "??", "tmux")],
      [51, row(50, "ttys009", "zsh")],
      [52, row(51, "ttys009", "node")],
    ]);
    expect(lineageProblem(tmux, 52)).toBeUndefined();
  });

  it("refuses no controlling terminal, a double fork to pid 1, and a pty driven by expect", () => {
    expect(lineageProblem(new Map([[5, row(1, "??", "node")]]), 5)).toMatch(/no controlling terminal/);
    expect(lineageProblem(new Map([[5, row(1, "ttys003", "node")]]), 5)).toMatch(/pid 1/);
    const expectPty = new Map<number, ProcRow>([
      [40, row(1, "??", "/usr/bin/expect")],
      [41, row(40, "ttys012", "node")],
    ]);
    expect(lineageProblem(expectPty, 41)).toMatch(/driven by expect/);
    const orphanShell = new Map<number, ProcRow>([
      [60, row(1, "ttys013", "zsh")],
      [61, row(60, "ttys013", "node")],
    ]);
    expect(lineageProblem(orphanShell, 61)).toMatch(/re-parented to pid 1/);
    expect(lineageProblem(new Map(), 61)).toMatch(/missing/);
  });

  it("treats an environment cleared with env -i as not a person's terminal", () => {
    expect(clearedEnvironment({ PATH: "/usr/bin", HOME: "/Users/x" })).toMatch(/TERM, USER\/LOGNAME are not set/);
    expect(clearedEnvironment({ PATH: "/usr/bin", HOME: "/Users/x", TERM: "xterm-256color", USER: "x" })).toBeUndefined();
  });
});

describe("humanOnlyRun", () => {
  it.each(["appstore-shield attest", "node dist/cli.js ack --rejection x", "osascript -e 'tell app \"Terminal\" to do script \"appstore-shield attest\"'"])("%s is denied", (cmd) =>
    expect(humanOnlyRun(cmd)?.decision).toBe("deny"),
  );
  it.each(["rg -n ack src && npm test", "appstore-shield status"])("%s is not", (cmd) => expect(humanOnlyRun(cmd)).toBeUndefined());
});

describe("scriptFileHit: asc workflows, OTA in tasks, and the per-call budget", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "guard-budget-"));
  });

  it("strips JSONC comments and trailing commas outside strings", () => {
    expect(JSON.parse(stripJsonc('{\n // c\n "a": "x // not a comment", /* b */ "b": [1, 2,],\n}'))).toEqual({ a: "x // not a comment", b: [1, 2] });
  });

  it("follows asc workflow run into .asc/workflow.json, sub-workflows and hooks, and asks when it cannot parse it", async () => {
    await mkdir(path.join(dir, ".asc"));
    await writeFile(
      path.join(dir, ".asc", "workflow.json"),
      JSON.stringify({ after_all: "echo done", workflows: { beta: { steps: ["asc builds info --latest"] }, release: { steps: [{ workflow: "send" }] }, send: { steps: [{ run: "asc review submit --app 1 --confirm" }] } } }),
    );
    expect(scriptFileHit("asc workflow run release VERSION:1.0", dir)?.submit).toMatch(/asc review submit in .*workflow "release"/);
    expect(scriptFileHit("asc workflow run beta", dir)).toBeUndefined();
    expect(scriptFileHit("asc workflow run --dry-run release", dir)).toBeUndefined();
    await writeFile(path.join(dir, "other.json"), '{"before_all": "asc review submit --app 1", "workflows": {}}');
    expect(scriptFileHit("asc workflow run --file other.json beta", dir)?.submit).toMatch(/asc review submit/);
    await writeFile(path.join(dir, ".asc", "workflow.json"), "{ not json");
    expect(scriptFileHit("asc workflow run release", dir)?.unreadable).toMatch(/workflow/);
  });

  it("reports an OTA publish in a package script or make target, and still prefers a submit", async () => {
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: { ota: "eas update --branch production --auto", both: "eas update --auto && asc review submit --app 1" } }));
    await writeFile(path.join(dir, "Makefile"), "ota:\n\tnpx shorebird patch ios\n");
    expect(scriptFileHit("npm run ota", dir)?.ota?.what).toMatch(/eas update in package\.json script "ota"/);
    expect(scriptFileHit("make ota", dir)?.ota?.what).toMatch(/shorebird patch/);
    expect(scriptFileHit("npm run both", dir)?.submit).toMatch(/asc review submit/);
  });

  it("reads a task file once however often a recipe names it", async () => {
    // all → 1000 × `make t`, t → 1000 × `make u`: a million re-parses before the cache.
    const rep = (s: string) => Array(1000).fill(s).join("; ");
    await writeFile(path.join(dir, "Makefile"), `all:\n\t${rep("make t")}\nt:\n\t${rep("make u")}\nu:\n\techo u\n`);
    await writeFile(path.join(dir, "ship.sh"), "asc review submit --version 1.0\n");
    // CPU time: on a loaded machine wall time measures the machine, not the parse.
    const t = process.cpuUsage();
    expect(scriptFileHit("make all; bash ship.sh", dir)?.submit).toMatch(/asc review submit/);
    const d = process.cpuUsage(t);
    expect((d.user + d.system) / 1000).toBeLessThan(5000);
  });

  it("asks once the call is over its budget instead of reporting nothing", async () => {
    const targets = Array.from({ length: 80 }, (_, i) => `t${i}`);
    await writeFile(path.join(dir, "Makefile"), targets.map((t, i) => `${t}:\n\tmake ${targets[(i + 1) % 80]} && echo ${t}`).join("\n") + "\n");
    // 80 distinct targets, each a separate task: past the 64-analysis cap.
    expect(scriptFileHit(targets.map((t) => `make ${t}`).join("; "), dir)?.tooMuch).toMatch(/more than 64/);
    expect(scriptFileHit("make t0", dir, -1)?.tooMuch).toMatch(/of parsing/);
  });
});

describe("ledger and settings writes", () => {
  let home: string;
  const saved = process.env.APPSTORE_SHIELD_HOME;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "guard-home-"));
    process.env.APPSTORE_SHIELD_HOME = home;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.APPSTORE_SHIELD_HOME;
    else process.env.APPSTORE_SHIELD_HOME = saved;
  });

  it.each([
    `echo '{"type":"ack","source":"human"}' >> ~/.appstore-shield/teams/LMNOP13579/events.jsonl`,
    "printf x | tee -a $APPSTORE_SHIELD_HOME/teams/T/events.jsonl",
    "sed -i '' '$d' ~/.appstore-shield/teams/T/events.jsonl",
    "rm ~/.appstore-shield/teams/T/events.jsonl",
    "python3 -c 'open(\"events.jsonl\",\"a\").write(\"x\")'",
  ])("denies %s", (cmd) => expect(bashLedgerWrite(cmd, "/")?.decision).toBe("deny"));

  it("denies writes to the configured APPSTORE_SHIELD_HOME by absolute path", () => {
    expect(bashLedgerWrite(`cat x >> ${home}/teams/T/x.log`, "/")?.decision).toBe("deny");
  });

  it("asks for writes to repo shield settings", () => {
    expect(bashLedgerWrite(`echo '{}' > .appstore-shield/baseline.json`, "/")?.decision).toBe("ask");
  });

  it.each(["cat ~/.appstore-shield/teams/T/events.jsonl", "jq . ~/.appstore-shield/teams/T/events.jsonl 2>/dev/null", "appstore-shield scan > out.txt", "echo hi > notes.txt"])(
    "allows %s",
    (cmd) => expect(bashLedgerWrite(cmd, "/")).toBeUndefined(),
  );

  // Any program not known to only read is a writer: the writers cannot be listed, the readers can.
  it.each([
    "find ~/.appstore-shield -name '*.jsonl' -delete",
    "find ~/.appstore-shield -type f -exec truncate -s0 {} +",
    "trash ~/.appstore-shield",
    "git clean -fdx ~/.appstore-shield",
    "git checkout -- ~/.appstore-shield/teams/T/events.jsonl",
    "shred -u ~/.appstore-shield/teams/T/events.jsonl",
    "vim -es -c '%d' -c wq ~/.appstore-shield/teams/X/events.jsonl",
    "ed -s ~/.appstore-shield/teams/X/events.jsonl",
    "curl -o ~/.appstore-shield/teams/X/events.jsonl https://example.com/x",
    "wget -O ~/.appstore-shield/teams/X/events.jsonl https://example.com/x",
    "unzip -o x.zip -d ~/.appstore-shield",
    "tar -C ~/.appstore-shield -xf x.tar",
    "sponge ~/.appstore-shield/teams/X/events.jsonl",
    "patch ~/.appstore-shield/teams/X/events.jsonl < p.diff",
    "swift -e 'print(1)' ~/.appstore-shield/x",
    "cd ~/.appstore-shield/teams/X; : > events.jsonl",
    "F=~/.appstore-shield/teams/X/events.jsonl; : > $F",
    "export F=~/.appstore-shield/teams/X/events.jsonl; rm $F",
    "echo $(rm -rf ~/.appstore-shield)",
    "cat ~/.appstore-shield/teams/T/events.jsonl > /tmp/copy && cat /tmp/x > ~/.appstore-shield/teams/T/events.jsonl",
    "APPSTORE_SHIELD_HOME=/tmp/empty appstore-shield gate",
  ])("denies %s", (cmd) => expect(bashLedgerWrite(cmd, "/")?.decision).toBe("deny"));

  it.each([
    "cat ~/.appstore-shield/teams/T/events.jsonl | wc -l",
    "ls -la ~/.appstore-shield/teams",
    "find ~/.appstore-shield -name '*.jsonl'",
    "tail -n 5 ~/.appstore-shield/teams/T/events.jsonl >&2",
    "F=~/.appstore-shield/teams/X/events.jsonl; cat $F; grep ack $F",
    "git log -- ~/.appstore-shield",
    "echo $APPSTORE_SHIELD_HOME",
    "rm -rf node_modules && find . -name '*.orig' -delete",
  ])("allows %s", (cmd) => expect(bashLedgerWrite(cmd, "/")).toBeUndefined());

  it("denies writes from a shell whose cwd is already inside the shield home", () => {
    expect(bashLedgerWrite("git clean -fdx", path.join(home, "teams"))?.decision).toBe("deny");
    expect(bashLedgerWrite("ls", path.join(home, "teams"))).toBeUndefined();
    expect(bashLedgerWrite(`cd ${home} && git clean -fdx`, "/")?.decision).toBe("deny");
    expect(bashLedgerWrite(`cd ${home}/teams && find . -delete`, "/")?.decision).toBe("deny");
    expect(bashLedgerWrite(`cat ${home}/teams/T/events.jsonl &> /dev/null`, "/")).toBeUndefined();
    expect(bashLedgerWrite(`echo x &> ${home}/teams/T/events.jsonl`, "/")?.decision).toBe("deny");
  });

  it("denies a configured ledgerPath outside the shield home", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "guard-repo-"));
    const ledgerDir = await mkdtemp(path.join(tmpdir(), "guard-ledger-"));
    await mkdir(path.join(repo, ".appstore-shield"));
    await writeFile(path.join(repo, ".appstore-shield", "config.json"), JSON.stringify({ teamId: "T", ledgerPath: ledgerDir }));
    await writeFile(path.join(repo, "package.json"), "{}");
    expect(bashLedgerWrite(`echo x >> ${ledgerDir}/teams/T/events.jsonl`, repo)?.decision).toBe("deny");
    expect(fileToolDecision(path.join(ledgerDir, "teams", "T", "events.jsonl"), repo)?.decision).toBe("deny");
  });

  it("denies relative, cd-then-relative and folder-removing writes to a configured ledgerPath", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "guard-rel-"));
    await mkdir(path.join(repo, ".appstore-shield"));
    await mkdir(path.join(repo, "compliance"));
    await writeFile(path.join(repo, ".appstore-shield", "config.json"), JSON.stringify({ teamId: "T", ledgerPath: "compliance/ledger.jsonl" }));
    await writeFile(path.join(repo, "package.json"), "{}");
    for (const cmd of [
      `echo '{"type":"ack","source":"human"}' >> compliance/ledger.jsonl`,
      "cd compliance && echo x >> ledger.jsonl",
      "cd compliance; sed -i '' 's/a/b/' ledger.jsonl",
      "sed -i '' 's/a/b/' compliance/ledger.jsonl",
      "dd if=/dev/null of=compliance/ledger.jsonl",
      'cd "$LEDGER_DIR" && echo x >> ledger.jsonl',
      "rm -rf compliance",
      "mv compliance /tmp/old",
    ]) {
      expect(bashLedgerWrite(cmd, repo)?.decision, cmd).toBe("deny");
    }
    expect(bashLedgerWrite("cd compliance && echo x >> ledger.jsonl", path.join(repo, "compliance", ".."))?.decision).toBe("deny");
    for (const cmd of ["find compliance -delete", "trash compliance", "vim compliance/ledger.jsonl", "git restore compliance/ledger.jsonl"]) {
      expect(bashLedgerWrite(cmd, repo)?.decision, cmd).toBe("deny");
    }
    for (const cmd of ["cat compliance/ledger.jsonl", "echo hi > compliance/notes.md", "rm -rf node_modules", "cp README.md docs/", "git add compliance/ledger.jsonl", "ls compliance"]) {
      expect(bashLedgerWrite(cmd, repo), cmd).toBeUndefined();
    }
    // Relative to the shield home itself.
    expect(bashLedgerWrite("cd ~ && echo {} > .appstore-shield/repos.json", repo)?.decision).not.toBe(undefined);
    expect(bashLedgerWrite(`cd ${home} && echo {} > repos.json`, repo)?.decision).toBe("deny");
  });

  it("file tools: deny anything in the shield home, including repos.json, and ledger paths behind a symlink", async () => {
    expect(fileToolDecision(path.join(home, "repos.json"), "/")?.decision).toBe("deny");
    expect(fileToolDecision(path.join(home, "anything.json"), "/")?.decision).toBe("deny");
    const linkDir = await mkdtemp(path.join(tmpdir(), "guard-link-"));
    await symlink(home, path.join(linkDir, "l"));
    expect(fileToolDecision(path.join(linkDir, "l", "teams", "T", "events.jsonl"), "/")?.decision).toBe("deny");
    expect(fileToolDecision(path.join(linkDir, "l", "repos.json"), "/")?.decision).toBe("deny");
    expect(fileToolDecision(path.join(linkDir, "other.txt"), "/")).toBeUndefined();
  });

  it("asks for commands that create files or FIFOs inside .appstore-shield", () => {
    expect(bashLedgerWrite("mkdir -p .appstore-shield && mkfifo .appstore-shield/config.json", "/")?.decision).toBe("ask");
    expect(bashLedgerWrite("mknod .appstore-shield/config.json p", "/")?.decision).toBe("ask");
  });

  it.skipIf(process.platform === "win32")("reads config.json only when it is a regular file, so a FIFO cannot hang the hook", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "guard-fifo-"));
    await mkdir(path.join(repo, ".appstore-shield"));
    await writeFile(path.join(repo, "package.json"), "{}");
    execFileSync("mkfifo", [path.join(repo, ".appstore-shield", "config.json")]);
    const t = performance.now();
    expect(bashLedgerWrite("echo hi > /tmp/x", repo)).toBeUndefined();
    expect(fileToolDecision(path.join(repo, "x.swift"), repo)).toBeUndefined();
    expect(scriptFileHit("npm run build", repo)).toBeUndefined();
    // A FIFO read blocks forever, so any finite bound tells; 10 s leaves room for a loaded machine.
    expect(performance.now() - t).toBeLessThan(10_000);
  });

  it("file tools: deny ledger and probe results, ask for baseline and existing config, allow source", async () => {
    expect(fileToolDecision(path.join(home, "teams", "T", "events.jsonl"), "/")?.decision).toBe("deny");
    expect(fileToolDecision("/repo/.appstore-shield/probes/ev_1/results.jsonl", "/")?.decision).toBe("deny");
    expect(fileToolDecision("/repo/.appstore-shield/baseline.json", "/")?.decision).toBe("ask");
    // Creating it asks too: a new config.json with another teamId points the gate at an empty history.
    expect(fileToolDecision("/repo/.appstore-shield/config.json", "/")?.decision).toBe("ask");
    const repo = await mkdtemp(path.join(tmpdir(), "guard-cfg-"));
    await mkdir(path.join(repo, ".appstore-shield"));
    await writeFile(path.join(repo, ".appstore-shield", "config.json"), "{}");
    expect(fileToolDecision(path.join(repo, ".appstore-shield", "config.json"), repo)?.decision).toBe("ask");
    expect(fileToolDecision("/repo/src/App.tsx", "/")).toBeUndefined();
    expect(fileToolDecision("/repo/.appstore-shield/probes/ev_1/suite.jsonl", "/")).toBeUndefined();
  });
});

describe("isSubmitMcpTool", () => {
  const SUBMITTING = [
    "mcp__asc__review_submit",
    "mcp__appstore__submit_for_review",
    "mcp__app_store_connect__submitAppForReview",
    "mcp__asc__create_review_submission",
    "mcp__asc__update_review_submission",
    "mcp__app_store_connect__updateReviewSubmission",
  ];
  const OTHER = ["mcp__claude-in-chrome__form_submit", "mcp__asc__list_review_submissions", "mcp__asc__review_submission_status", "mcp__asc__get_review_submission", "mcp__asc__getReviewSubmission", "Bash", "mcp__asc__builds_upload"];
  // Judged by the leading verb: a tool that validates or checks status and also submits is a submit.
  it.each(["mcp__asc__validate_and_submit_for_review", "mcp__app-store-connect__submit_app_store_version_with_status_check", "mcp__asc__checkAndSubmitForReview"])("%s submits", (n) =>
    expect(isSubmitMcpTool(n)).toBe(true),
  );
  it.each(["mcp__asc__get_review_submission_status", "mcp__asc__cancel_review_submission", "mcp__asc__submit_for_review_dry_run", "mcp__asc__validate_review_submission"])("%s does not", (n) =>
    expect(isSubmitMcpTool(n)).toBe(false),
  );
  it.each(SUBMITTING)("%s", (n) => expect(isSubmitMcpTool(n)).toBe(true));
  it.each(OTHER)("%s is not", (n) => expect(isSubmitMcpTool(n)).toBe(false));

  it("the hooks.json MCP matcher sends every submitting tool name to the hook", () => {
    const hooks = JSON.parse(readFileSync(path.join(__dirname, "..", "..", "hooks", "hooks.json"), "utf8")) as { hooks: { PreToolUse: { matcher: string }[] } };
    const matchers = hooks.hooks.PreToolUse.map((h) => new RegExp(`^(?:${h.matcher})$`));
    for (const n of SUBMITTING) expect(matchers.some((m) => m.test(n)), n).toBe(true);
  });
});

describe("resolveGateRoot", () => {
  it("gates the React Native root when run from ios/", async () => {
    const rn = await mkdtemp(path.join(tmpdir(), "guard-rn-"));
    await writeFile(path.join(rn, "package.json"), "{}");
    await mkdir(path.join(rn, "ios", "GlowUp.xcodeproj"), { recursive: true });
    await mkdir(path.join(rn, "ios", "fastlane"), { recursive: true });
    expect(resolveGateRoot(path.join(rn, "ios"))).toBe(rn);
    expect(resolveGateRoot(path.join(rn, "ios", "fastlane"))).toBe(rn);
  });

  it("keeps a native repo whose folder happens to be named ios", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "guard-native-"));
    await mkdir(path.join(parent, "ios", "App.xcodeproj"), { recursive: true });
    expect(resolveGateRoot(path.join(parent, "ios"))).toBe(path.join(parent, "ios"));
  });

  it("keeps an ios/ that is its own git repo", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "guard-sub-"));
    await writeFile(path.join(parent, "package.json"), "{}");
    await mkdir(path.join(parent, "ios", "App.xcodeproj"), { recursive: true });
    await mkdir(path.join(parent, "ios", ".git"));
    expect(resolveGateRoot(path.join(parent, "ios"))).toBe(path.join(parent, "ios"));
  });

  it("never climbs into the home directory", () => {
    expect(resolveGateRoot(homedir())).not.toBe(path.dirname(homedir()));
  });
});

describe("agentEnvironment", () => {
  it("detects an agent shell and not a plain terminal", () => {
    expect(agentEnvironment({ CLAUDECODE: "1" })).toBe("CLAUDECODE");
    expect(agentEnvironment({ HOME: "/Users/x", TERM: "xterm" })).toBeUndefined();
  });
});

function rejection(over: Partial<RejectionState>): RejectionState {
  return { id: "ev_r1", at: "2026-10-01T00:00:00.000Z", outcome: "rejected", guidelines: ["1.2"], messages: [], appleReplies: [], attestations: [], acked: false, ...over } as RejectionState;
}

function stateWith(...rejections: RejectionState[]): LedgerState {
  return { rejections } as unknown as LedgerState;
}

const noReport: Finding = finding({ rule: "ugc.no_report", severity: "high", guideline: "1.2", file: "src/Feed.tsx", line: 4, why: "w", fix: "Add an in-app way to report content." });
const ageGate: Finding = finding({ rule: "ugc.no_age_gate", severity: "medium", guideline: "1.2.1(a)", why: "w", fix: "f" });
const paywall: Finding = finding({ rule: "paywall.missing_terms", severity: "high", guideline: "3.1.2", why: "w", fix: "f" });

describe("open rejections hold on high findings under the cited guideline", () => {
  it("holds on ugc.no_report after a 1.2 rejection even when verification is STATIC_CLEAN", () => {
    const r = rejection({ verification: { tier: "STATIC_CLEAN" } as RejectionState["verification"] });
    const holds = openRejectionHolds(stateWith(r), [noReport, ageGate, paywall]);
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatch(/ev_r1 cites Guideline 1\.2, and ugc\.no_report .* at src\/Feed\.tsx:4/);
  });

  it("treats 4.7.1 as asking for the 1.2 safeguards", () => {
    expect(openRejectionHolds(stateWith(rejection({ guidelines: ["4.7.1"] })), [noReport])).toHaveLength(1);
  });

  it.each([
    ["another guideline", rejection({ guidelines: ["3.1.1"] })],
    ["an acknowledged rejection", rejection({ acked: true })],
    ["an approved rejection", rejection({ approvedBy: "ev_ok" })],
    ["a metadata rejection", rejection({ outcome: "metadata_rejected" })],
  ])("does not hold for %s", (_label, r) => {
    expect(openRejectionHolds(stateWith(r), [noReport])).toEqual([]);
  });

  it("matches subsections, not lookalike numbers", () => {
    expect(guidelineWithin("1.2.1(a)", "1.2")).toBe(true);
    expect(guidelineWithin("2.1(a)", "2.1")).toBe(true);
    expect(guidelineWithin("1.20", "1.2")).toBe(false);
    expect(guidelineWithin("1.2", "1.2.1")).toBe(false);
    expect(guidelineWithin("2.5.19, 1.2", "1.2")).toBe(true);
  });
});

describe("command substitution: the body is a command of its own", () => {
  it.each([
    'OUT=$(asc review submit --app 1 2>&1); echo "$OUT"',
    'echo "$(fastlane deliver submit_for_review:true)"',
    "cat <(asc review submit --app 1)",
    // The substitution computes the program; the outer segment keeps that word.
    "$(which asc) review submit --app 1",
    "`command -v asc` review submit",
  ])("looseSubmit finds %s", (cmd) => expect(looseSubmit(cmd)).toBeDefined());
  it.each(["git commit -m 'note: $(asc review submit) is gated'", 'echo "$(git rev-parse HEAD)"', "ls # $(asc review submit)"])("looseSubmit leaves %s", (cmd) =>
    expect(looseSubmit(cmd)).toBeUndefined(),
  );

  it("looseOta finds a publish inside echo or an assignment", () => {
    expect(looseOta("echo $(eas update --branch production -m x)")?.what).toBe("eas update");
    expect(looseOta('LOG="$(bunx eas-cli update --branch production)"')?.what).toBe("eas update");
  });

  it.each(['git commit -m "$(npx appstore-shield ack --rejection ev_1)"', "echo $(node dist/cli.js attest)", "$(which appstore-shield) attest", "printf %s `appstore-shield ack`"])(
    "humanOnlyRun denies %s",
    (cmd) => expect(humanOnlyRun(cmd)?.decision).toBe("deny"),
  );

  it("scriptFileHit reads `bash -c` code as a script of its own, where single quotes start afresh", () => {
    expect(scriptFileHit("bash -c 'x=$(asc review submit --app 1); echo $x'", "/nonexistent-dir")?.submit).toMatch(/asc review submit/);
    expect(scriptFileHit("sh -c 'echo $(eas update --branch production)'", "/nonexistent-dir")?.ota?.what).toMatch(/eas update/);
  });

  it("the ledger check still treats a segment with a substitution as a writer", () => {
    expect(bashLedgerWrite("X=$(rm ~/.appstore-shield/teams/T/events.jsonl)", "/")?.decision).toBe("deny");
    expect(bashLedgerWrite('echo "$(cat ~/.appstore-shield/teams/T/events.jsonl)" > /tmp/copy', "/")?.decision).toBe("deny");
  });
});

describe("ledger check with many cd segments", () => {
  let home: string;
  const saved = process.env.APPSTORE_SHIELD_HOME;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "guard-cds-"));
    process.env.APPSTORE_SHIELD_HOME = home;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.APPSTORE_SHIELD_HOME;
    else process.env.APPSTORE_SHIELD_HOME = saved;
  });

  it("looks up each directory once, so thousands of cds answer in linear time, and keeps following absolute ones", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "guard-cds-repo-"));
    await writeFile(path.join(repo, "package.json"), "{}");
    // CPU time: under the full parallel suite wall time measures the machine.
    const t = process.cpuUsage();
    expect(bashLedgerWrite(`${"cd x; ".repeat(2000)}cd ${home}/teams/T && echo {} >> events.jsonl`, repo)?.decision).toBe("deny");
    expect(bashLedgerWrite(`${"cd x; ".repeat(2000)}cd ${home} && echo {} > repos.json`, repo)?.decision).toBe("deny");
    expect(bashLedgerWrite(`${"cd x; ".repeat(10_000)}asc review submit --app 1`, repo)).toBeUndefined();
    const d = process.cpuUsage(t);
    // The unmemoised walk took about 18 s for 500 cds.
    expect((d.user + d.system) / 1000).toBeLessThan(5000);
  });
});

describe("git commands that wipe or revert an in-repo ledger", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "guard-git-"));
    await mkdir(path.join(repo, ".git"));
    await mkdir(path.join(repo, ".appstore-shield"));
    await mkdir(path.join(repo, "compliance"));
    await mkdir(path.join(repo, "src"));
    await writeFile(path.join(repo, ".appstore-shield", "config.json"), JSON.stringify({ teamId: "T", ledgerPath: "compliance/events.jsonl" }));
    await writeFile(path.join(repo, "compliance", "events.jsonl"), "");
  });

  it.each([
    "git stash -u",
    "git stash",
    "git stash -m wip",
    "git stash push --include-untracked",
    "git checkout -- .",
    "git checkout .",
    "git checkout HEAD~1 -- .",
    "git restore .",
    "git restore --source HEAD~3 :/",
    "git clean -fdx",
    "git reset --hard",
    "git reset --hard origin/main && npm test",
    "git switch -f main",
    "git -C . clean -fd",
  ])("asks before %s", (cmd) => {
    const d = bashLedgerWrite(cmd, repo);
    expect(d?.decision, cmd).toBe("ask");
    expect(d?.reason).toMatch(/delete or revert this repo's review ledger/);
  });

  it.each(["git status", "git checkout main", "git checkout -b feature", "git stash list", "git stash pop", "git clean -n -d", "git restore --staged .", "git reset HEAD~1", "git clean -fd src", "git log -p"])(
    "leaves %s alone",
    (cmd) => expect(bashLedgerWrite(cmd, repo), cmd).toBeUndefined(),
  );

  it("still denies a command that names the ledger's folder", () => {
    expect(bashLedgerWrite("git clean -fdx compliance", repo)?.decision).toBe("deny");
  });

  it("asks nothing in a repo whose ledger is outside it", async () => {
    await writeFile(path.join(repo, ".appstore-shield", "config.json"), JSON.stringify({ teamId: "T" }));
    expect(bashLedgerWrite("git reset --hard", repo)).toBeUndefined();
    expect(bashLedgerWrite("git clean -fdx", path.join(repo, "src"))).toBeUndefined();
  });
});

describe("wrappers: the command behind timeout, nice, caffeinate, secrets managers, find -exec and xargs", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "guard-wrap-"));
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: { update: "eas update --branch production", ship: "asc review submit --app 1", lint: "eslint ." } }));
    await writeFile(path.join(dir, "s.sh"), "asc review submit --app 1\n");
    await writeFile(path.join(dir, "a.sh"), 'appstore-shield ack --rejection ev_1 --note "decided to ship anyway"\n');
  });

  it.each([
    "timeout 600 eas update --branch production",
    "gtimeout -k 5 600 eas update --branch production",
    "nice eas update --branch production",
    "nice -n 10 eas update --branch production",
    "caffeinate -i eas update --branch production",
    "caffeinate -t 3600 eas update --branch production",
    "watch eas update --branch production",
    "watch -n 5 eas update --branch production",
    "op run -- eas update --branch production",
    "op run --env-file=.env -- eas update --branch production",
    "doppler run -- eas update --branch production",
    "infisical run --env=prod -- eas update --branch production",
    "dotenv -e .env.production -- eas update --branch production",
    "dotenvx run -f .env -- eas update --branch production",
    "env -S 'eas update --branch production'",
    "sudo -u ci eas update --branch production",
    "stdbuf -oL eas update --branch production",
    "npx -y eas-cli update --branch production",
    "xargs -I{} eas update --branch {} <<< production",
    "find . -maxdepth 0 -exec eas update --branch production \;",
    "bash -c 'timeout 60 eas update --branch production'",
  ])("looseOta: %s", (cmd) => expect(looseOta(cmd)?.what).toMatch(/eas update/));

  it.each(["timeout 900 npm run update", "caffeinate -i npm run update", "op run -- npm run update"])("scriptFileHit follows the package script behind %s", (cmd) =>
    expect(scriptFileHit(cmd, dir)?.ota?.what).toMatch(/eas update/),
  );

  it.each(["timeout 900 npm run ship", "timeout 60 bash s.sh", "nice -n 5 bash s.sh", "doppler run -- bash s.sh", "find . -maxdepth 0 -exec bash s.sh \;", "echo s.sh | xargs bash s.sh"])(
    "scriptFileHit finds the submit behind %s",
    (cmd) => expect(scriptFileHit(cmd, dir)?.submit).toMatch(/asc review submit/),
  );

  it.each(["timeout 60 bash a.sh", "find . -maxdepth 0 -exec bash a.sh \;"])("scriptFileHit finds attest/ack behind %s", (cmd) => expect(scriptFileHit(cmd, dir)?.humanOnly?.decision).toBe("deny"));

  it.each(["timeout 60 appstore-shield ack --rejection x", "find . -maxdepth 0 -exec appstore-shield ack {} \;", "nice -n 5 node dist/cli.js attest"])("humanOnlyRun: %s", (cmd) =>
    expect(humanOnlyRun(cmd)?.decision).toBe("deny"),
  );

  it.each(["timeout 900 npm run lint", "nice -n 5 make build", "find . -name '*.log'", "timeout 5 cat package.json", "xargs -n1 echo"])("leaves %s alone", (cmd) => {
    expect(looseOta(cmd)).toBeUndefined();
    expect(scriptFileHit(cmd, dir)).toBeUndefined();
  });
});

describe("terminal hand-offs: tmux, screen, JXA, open, kitty and wezterm", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "guard-handoff-"));
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: { update: "eas update --branch production", ship: "asc review submit --app 1" } }));
    await writeFile(path.join(dir, "s.sh"), "asc review submit --app 1\n");
    await writeFile(path.join(dir, "r.sh"), 'appstore-shield ack --rejection ev_1 --note "decided to ship anyway"\n');
    await writeFile(path.join(dir, "ok.sh"), "echo hello\n");
  });

  it.each([
    "tmux send-keys -t build 'npm run ship' Enter",
    "tmux new-session -d -s rel 'npm run ship'",
    "tmux -L sock new-window 'bash s.sh'",
    "screen -dmS rel npm run ship",
    "screen -dmS rel bash s.sh",
    "screen -S rel -X stuff 'asc review submit --app 1\n'",
    `osascript -e 'tell app "Terminal" to do script "npm run ship"'`,
    `osascript -l JavaScript -e 'Application("Terminal").doScript("bash s.sh")'`,
    "wezterm cli send-text --pane-id 1 'npm run ship'",
  ])("the submit handed over by %s is still found", (cmd) => expect(scriptFileHit(cmd, dir)?.submit).toMatch(/asc review submit/));

  it.each(["tmux send-keys -t build 'eas update --branch production' Enter", "tmux new-window 'eas update --branch production'", "screen -dmS x eas update --branch production", "tmux split-window -h 'npm run update'"])(
    "the OTA publish handed over by %s is still found",
    (cmd) => expect(scriptFileHit(cmd, dir)?.ota?.what).toMatch(/eas update/),
  );

  it.each([
    "tmux send-keys -t 0 'bash r.sh' Enter",
    `osascript -l JavaScript -e 'Application("Terminal").doScript("bash r.sh")'`,
    "open -na Terminal --args r.sh",
    "open -b com.apple.Terminal r.sh",
  ])("attest/ack handed over by %s is found", (cmd) => expect(scriptFileHit(cmd, dir)?.humanOnly?.decision).toBe("deny"));

  it.each([
    ["tmux send-keys -t 0 'ls' Enter", /tmux send-keys/],
    ["tmux new-session -d 'bash ok.sh'", /tmux new-session/],
    ["screen -dmS x top", /screen/],
    [`osascript -l JavaScript -e 'Application("Terminal").doScript("ls")'`, /do script/],
    ["open -na Terminal --args ok.sh", /open -a Terminal/],
    ["open -b com.googlecode.iterm2 ok.sh", /open -b/],
    ["kitty @ send-text --match title:x ls", /kitty @ send-text/],
  ])("%s asks as a hand-off", (cmd, via) => expect(scriptFileHit(cmd as string, dir)?.leavesSession).toMatch(via as RegExp));

  it.each(["tmux ls", "tmux capture-pane -p -t 0", "tmux kill-session -t x", "screen -ls", "open -a Safari https://example.com", "open ."])("leaves %s alone", (cmd) => expect(scriptFileHit(cmd, dir)).toBeUndefined());
});

describe("ledger protection: globs, braces, find patterns and case-insensitive paths", () => {
  let repo: string;
  let base: string;
  let home: string;
  const saved = process.env.APPSTORE_SHIELD_HOME;
  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "guard-glob-"));
    home = path.join(base, ".appstore-shield");
    await mkdir(path.join(home, "teams", "T"), { recursive: true });
    process.env.APPSTORE_SHIELD_HOME = home;
    repo = path.join(base, "evilapp");
    await mkdir(path.join(repo, ".appstore-shield"), { recursive: true });
    await mkdir(path.join(repo, "compliance"));
    await writeFile(path.join(repo, "package.json"), "{}");
    await writeFile(path.join(repo, ".appstore-shield", "config.json"), JSON.stringify({ teamId: "T", ledgerPath: "compliance/ledger.jsonl" }));
    await writeFile(path.join(repo, "compliance", "ledger.jsonl"), "");
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.APPSTORE_SHIELD_HOME;
    else process.env.APPSTORE_SHIELD_HOME = saved;
  });

  it.each(["rm compliance/*.jsonl", "rm -rf compl*", "rm -f compliance/ledger.json?", "rm compliance/[a-z]*", "mv compliance/{ledger,old}.jsonl /tmp", "find . -name '*.jsonl' -delete", "find . -name compliance -exec rm -rf {} +", "find . -path './compliance/*' -delete", "find . -type f -delete", "find . -regex '.*' -delete"])(
    "denies %s in a repo with an in-repo ledger",
    (cmd) => expect(bashLedgerWrite(cmd, repo)?.decision, cmd).toBe("deny"),
  );

  it.each(["rm -rf .appstore-*", "rm -rf .apps*/config.json", "rm .appstore-shield/{config,baseline}.json"])("asks for %s on .appstore-shield", (cmd) => expect(bashLedgerWrite(cmd, repo)?.decision, cmd).toBe("ask"));

  it.each(["rm -rf node_modules/*", "rm *.log", "rm -rf build/{a,b}", "find . -name '*.o' -delete", "find . -name '*.jsonl' -exec cat {} \;", "find . -maxdepth 1 -name '*.tmp' -delete", "ls compl*", "sed -i '' 's/a*/b/' src/x.ts"])(
    "leaves %s alone",
    (cmd) => expect(bashLedgerWrite(cmd, repo), cmd).toBeUndefined(),
  );

  it.each(["rm -rf BASE/.appstore-*", "rm -rf BASE/.{appstore-shield,cache}", "rm -rf BASE/.appstore-shiel?", "rm BASE/.appstore-shield/teams/*/events.jsonl", "cd BASE && rm -rf .appstore*", "cd BASE && find . -maxdepth 1 -name '.appstore*' -exec rm -rf {} +", "find BASE -name '*.jsonl' -delete"])(
    "denies %s on the shield home",
    (cmd) => expect(bashLedgerWrite(cmd.replace(/BASE/g, base), "/")?.decision, cmd).toBe("deny"),
  );

  it.each(["rm -rf BASE/*", "find BASE -maxdepth 1 -name '*.pyc' -delete", "rm -rf BASE/evilapp/node_modules/*"])("leaves %s alone", (cmd) => expect(bashLedgerWrite(cmd.replace(/BASE/g, base), "/")).toBeUndefined());

  it("reads the default home's globs with ~ too", () => {
    delete process.env.APPSTORE_SHIELD_HOME;
    for (const cmd of ["rm -rf ~/.appstore-*", "rm -rf ~/.{appstore-shield,cache}", "rm -rf ~/.appstore-shiel?", "cd ~ && rm -rf .appstore*"]) expect(bashLedgerWrite(cmd, "/")?.decision, cmd).toBe("deny");
    expect(bashLedgerWrite("rm -rf ~/Library/Caches/*", "/")).toBeUndefined();
  });

  it.runIf(process.platform === "darwin")("compares paths case-insensitively on a case-insensitive volume", () => {
    for (const cmd of ["rm COMPLIANCE/ledger.jsonl", "rm compliance/LEDGER.jsonl", "rm -rf Compliance", `rm -rf ${home.toUpperCase()}`, `cd ${home.toUpperCase()} && rm -rf teams`]) {
      expect(bashLedgerWrite(cmd, repo)?.decision, cmd).toBe("deny");
    }
    expect(bashLedgerWrite("echo x > .APPSTORE-SHIELD/config.json", repo)?.decision).toBe("ask");
    expect(fileToolDecision(path.join(home.toUpperCase(), "teams", "T", "events.jsonl"), repo)?.decision).toBe("deny");
    expect(fileToolDecision(path.join(base, ".Appstore-Shield", "repos", "x.json"), repo)?.decision).toBe("deny");
    expect(fileToolDecision(path.join(repo, "COMPLIANCE", "ledger.jsonl"), repo)?.decision).toBe("deny");
    expect(fileToolDecision(path.join(repo, ".APPSTORE-SHIELD", "config.json"), repo)?.decision).toBe("ask");
    expect(fileToolDecision(path.join(repo, "src", "App.tsx"), repo)).toBeUndefined();
  });

  it("stays fast on brace and glob bombs", () => {
    const t = process.cpuUsage();
    // Past the variant cap the braced span reads as `*`, which can only match more; only the time matters here.
    bashLedgerWrite(`rm ${"{a,b}".repeat(200)}`, repo);
    expect(bashLedgerWrite(`rm ${"*".repeat(1000)}x ${"[".repeat(1000)} ${"*a".repeat(500)}b`, repo)).toBeUndefined();
    expect(bashLedgerWrite(Array.from({ length: 2000 }, (_, i) => `rm -rf x${i}/*`).join("; "), repo)).toBeUndefined();
    const d = process.cpuUsage(t);
    expect((d.user + d.system) / 1000).toBeLessThan(5000);
  });
});

describe("isSubmitMcpTool: hyphenated server names", () => {
  it.each(["mcp__app-store-connect__submit_app_version", "mcp__app-store__submit_for_review", "mcp__store-connect__createReviewSubmission"])("%s submits", (n) => expect(isSubmitMcpTool(n)).toBe(true));
  it.each(["mcp__app-store-connect__get_review_submission", "mcp__claude-in-chrome__form_submit"])("%s does not", (n) => expect(isSubmitMcpTool(n)).toBe(false));
});

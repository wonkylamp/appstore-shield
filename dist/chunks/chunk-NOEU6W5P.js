#!/usr/bin/env node
import { createRequire as __shieldCreateRequire } from "node:module";
const require = __shieldCreateRequire(import.meta.url);

// src/hook.ts
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
var MAYBE = /\b(asc|fastlane|attest|ack|eas|expo|codepush|code-push|shorebird|hot-updater|revopush)\b/;
function normalizeShell(cmd) {
  return exposeSubstitutions(joinWords(cmd));
}
function joinWords(cmd) {
  return cmd.replace(/\\\r?\n/g, "").replace(/\$\{IFS[^}]{0,64}\}|\$IFS(?![A-Za-z0-9_])/g, " ");
}
function exposeSubstitutions(cmd) {
  if (!/\$\(|`|[<>]\(/.test(cmd)) return cmd;
  const frame = (close) => ({ close, dq: false, depth: 0, done: [], cur: "", bodies: [] });
  const text = (f) => f.done.join("") + (f.bodies.length ? `
${f.bodies.join("\n")}
` : "") + f.cur;
  const stack = [frame("")];
  const closeTop = () => {
    const f = stack.pop();
    const parent = stack[stack.length - 1];
    parent.bodies.push(text(f));
    parent.cur += "$__";
  };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    const f = stack[stack.length - 1];
    if (ch === "\\") {
      f.cur += cmd.slice(i, i + 2);
      i++;
    } else if (!f.dq && ch === "'") {
      const end = cmd.indexOf("'", i + 1);
      const j = end === -1 ? cmd.length : end + 1;
      f.cur += cmd.slice(i, j);
      i = j - 1;
    } else if (!f.dq && ch === "#" && (i === 0 || " 	\n;&|(".includes(cmd[i - 1]))) {
      const nl = cmd.indexOf("\n", i);
      const j = nl === -1 ? cmd.length : nl;
      f.cur += cmd.slice(i, j);
      i = j - 1;
    } else if (ch === '"') {
      f.dq = !f.dq;
      f.cur += ch;
    } else if (ch === "`" && f.close === "`") {
      closeTop();
    } else if (ch === "`" && stack.length <= MAX_SUBST_DEPTH) {
      stack.push(frame("`"));
    } else if ((ch === "$" || !f.dq && (ch === "<" || ch === ">")) && cmd[i + 1] === "(" && stack.length <= MAX_SUBST_DEPTH) {
      stack.push(frame(")"));
      i++;
    } else if (!f.dq && ch === "(") {
      f.depth++;
      f.cur += ch;
    } else if (!f.dq && ch === ")" && f.depth === 0 && f.close === ")") {
      closeTop();
    } else if (!f.dq && (ch === ";" || ch === "\n" || ch === "|" || ch === "&" && !"<>".includes(cmd[i - 1] ?? "") && cmd[i + 1] !== ">")) {
      const op = (ch === "&" || ch === "|") && cmd[i + 1] === ch ? ch + ch : ch;
      i += op.length - 1;
      f.done.push(text({ ...f, done: [], cur: f.cur + op }));
      f.cur = "";
      f.bodies = [];
    } else {
      if (!f.dq && ch === ")" && f.depth > 0) f.depth--;
      f.cur += ch;
    }
  }
  while (stack.length > 1) closeTop();
  return text(stack[0]);
}
var MAX_SUBST_DEPTH = 32;
function stripShellComments(cmd) {
  if (!cmd.includes("#")) return cmd;
  let out = "";
  let start = 0;
  let q = "";
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q) {
      if (ch === q) q = "";
      else if (q === '"' && ch === "\\") i++;
      continue;
    }
    if (ch === "\\") i++;
    else if (ch === "'" || ch === '"') q = ch;
    else if (ch === "#" && (i === 0 || " 	\n;&|()".includes(cmd[i - 1]))) {
      out += cmd.slice(start, i);
      const nl = cmd.indexOf("\n", i);
      if (nl === -1) return out;
      start = nl;
      i = nl - 1;
    }
  }
  return out + cmd.slice(start);
}
function segments(cmd) {
  return cmd.split(/&&|\|\||;|\||\n/).map((s) => s.trim()).filter(Boolean);
}
function tokens(seg) {
  const out = [];
  for (const m of seg.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push((m[1] ?? m[2] ?? m[3] ?? "").replace(/^["']+|["']+$/g, ""));
  return out;
}
var WRAPPER_SPECS = {
  sudo: { short: "ugCDhprtUT", long: ["--user", "--group", "--chdir", "--host", "--prompt", "--role", "--type", "--other-user", "--command-timeout", "--close-from"], assigns: true },
  doas: { short: "uC" },
  env: { short: "uSCP", long: ["--unset", "--split-string", "--chdir", "--argv0"], assigns: true, command: ["-S", "--split-string"] },
  "cross-env": { assigns: true },
  "cross-env-shell": { assigns: true },
  "env-cmd": { short: "fer", long: ["--file", "--environments", "--rc-file"] },
  dotenv: { short: "evcp" },
  "dotenv-cli": { short: "evcp" },
  command: {},
  builtin: {},
  exec: { short: "a" },
  time: { short: "fo", long: ["--format", "--output"] },
  nohup: {},
  setsid: {},
  nice: { short: "n", long: ["--adjustment"] },
  timeout: { short: "sk", long: ["--signal", "--kill-after"], operands: 1 },
  gtimeout: { short: "sk", long: ["--signal", "--kill-after"], operands: 1 },
  caffeinate: { short: "tw" },
  stdbuf: { short: "ioe", long: ["--input", "--output", "--error"] },
  chrt: { short: "TPD", long: ["--sched-runtime", "--sched-period", "--sched-deadline"], operands: 1 },
  ionice: { short: "cn", long: ["--class", "--classdata"] },
  taskset: { operands: 1 },
  watch: { short: "nq", long: ["--interval", "--equexit"] },
  arch: { long: ["-arch", "-e", "-d"] },
  xcrun: { long: ["-sdk", "--sdk", "--toolchain", "-log"] },
  // BSD `script [-q] FILE COMMAND…`; util-linux `script -c COMMAND FILE`.
  script: { short: "tFTEIOBc", long: ["--command", "--timing", "--log-in", "--log-out", "--log-io", "--echo"], operands: 1, command: ["-c", "--command"] },
  npx: { short: "pc", long: ["--package", "--call"], command: ["-c", "--call"] },
  pnpx: { short: "pc", long: ["--package", "--call"], command: ["-c", "--call"] },
  bunx: { short: "p", long: ["--package"] }
};
var SUBCOMMAND_WRAPPERS = {
  op: { sub: ["run"], spec: { long: ["--env-file", "--account", "--config", "--session"] } },
  doppler: { sub: ["run"], spec: { short: "pc", long: ["--project", "--config", "--token", "--command", "--mount", "--mount-format", "--mount-template", "--name-transformer", "--fallback", "--scope"], command: ["--command"] } },
  infisical: { sub: ["run"], spec: { long: ["--env", "--path", "--projectId", "--token", "--command", "--tags", "--domain"], command: ["--command"] } },
  dotenvx: { sub: ["run"], spec: { short: "fe", long: ["--env-file", "--env", "--convention"] } },
  "aws-vault": { sub: ["exec"], spec: { short: "d", long: ["--duration", "--region", "--mfa-token"], operands: 1 } },
  npm: { sub: ["exec", "x"], spec: { short: "pcw", long: ["--package", "--call", "--workspace", "--prefix"], command: ["-c", "--call"] } },
  pnpm: { sub: ["exec", "dlx"], spec: { short: "pcC", long: ["--package", "--filter", "--dir"], command: ["-c"] } },
  yarn: { sub: ["exec", "dlx"], spec: { short: "p", long: ["--package"] } },
  bun: { sub: ["x"], spec: {} },
  bundle: { sub: ["exec"], spec: {} }
};
var LEAD_KEYWORDS = /* @__PURE__ */ new Set(["then", "do", "else", "elif", "if", "while", "until", "!", "{", "("]);
var ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
function skipWrapperArgs(w, start, spec) {
  let i = start;
  let operands2 = spec.operands ?? 0;
  let inline;
  const takes = (flag, value) => {
    if (value !== void 0 && spec.command?.includes(flag)) inline ??= value;
  };
  while (i < w.length && inline === void 0) {
    const a = w[i];
    if (a === "--") {
      i++;
      break;
    }
    if (spec.long?.includes(a)) {
      takes(a, w[i + 1]);
      i += 2;
    } else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) takes(a.slice(0, eq), a.slice(eq + 1));
      i++;
    } else if (a.startsWith("-") && a.length > 1) {
      let consumed = 1;
      for (let k = 1; k < a.length; k++) {
        if (!spec.short?.includes(a[k])) continue;
        const attached = a.slice(k + 1);
        takes(`-${a[k]}`, attached || w[i + 1]);
        if (!attached) consumed = 2;
        break;
      }
      i += consumed;
    } else if (spec.assigns && ASSIGN.test(a)) i++;
    else if (operands2 > 0) {
      operands2--;
      i++;
    } else break;
  }
  return { at: i, inline };
}
function unwrapOnce(w, descend) {
  const first = w[0];
  if (first === void 0) return void 0;
  if (LEAD_KEYWORDS.has(first) || ASSIGN.test(first)) return w.slice(1);
  const name = path.basename(first);
  const spec = WRAPPER_SPECS[name];
  const sub = SUBCOMMAND_WRAPPERS[name];
  let found;
  if (spec) found = skipWrapperArgs(w, 1, spec);
  else if (sub && w[1] !== void 0 && sub.sub.includes(w[1])) found = skipWrapperArgs(w, 2, sub.spec);
  else if (descend && name === "xargs") found = skipWrapperArgs(w, 1, XARGS_SPEC);
  else if (descend && name === "find") {
    const x = w.findIndex((a) => FIND_EXEC.has(a));
    if (x !== -1) found = { at: x + 1 };
  }
  if (!found) return void 0;
  if (found.inline !== void 0) return [...found.inline.split(/\s+/).filter(Boolean), ...w.slice(found.at)];
  return w.slice(found.at);
}
var XARGS_SPEC = { short: "InLPsdEaRSJ", long: ["--max-args", "--max-lines", "--max-procs", "--max-chars", "--delimiter", "--eof", "--arg-file", "--replace", "--process-slot-var"] };
var FIND_EXEC = /* @__PURE__ */ new Set(["-exec", "-execdir", "-ok", "-okdir"]);
function stripWrappers(words, descend = true) {
  let w = words;
  for (let guard = 0; guard < 64 && w.length; guard++) {
    const next = unwrapOnce(w, descend);
    if (next === void 0) break;
    w = next;
  }
  return [...w];
}
function program(tok) {
  return stripWrappers(tok);
}
function flagValue(tok, names) {
  for (let i = 0; i < tok.length; i++) {
    const t = tok[i];
    for (const n of names) {
      if (t === n) return tok[i + 1];
      if (t.startsWith(`${n}=`)) return t.slice(n.length + 1);
    }
  }
  return void 0;
}
function isTrueish(v) {
  return v === void 0 || /^(true|yes|1)$/i.test(v);
}
function submitForReviewOn(seg, tok) {
  const kv = /\bsubmit_for_review\s*[:=]\s*["']?(\w+)/i.exec(seg);
  if (kv) return isTrueish(kv[1]);
  const i = tok.findIndex((t) => t === "--submit_for_review" || t === "--submit-for-review");
  if (i === -1) return false;
  const next = tok[i + 1];
  return next === void 0 || next.startsWith("-") || isTrueish(next);
}
var LAUNCHER = /(?:^|\/)(?:appstore-shield(?:@\S*)?|cli\.[cm]?js)$/;
var JS_RUNTIMES = /* @__PURE__ */ new Set(["node", "nodejs", "bun", "deno", "tsx"]);
function humanOnlyVerb(tok) {
  let i = 0;
  if (JS_RUNTIMES.has(path.basename(tok[0] ?? ""))) {
    i = 1;
    while (tok[i]?.startsWith("-")) i++;
  }
  if (!LAUNCHER.test(tok[i] ?? "")) return void 0;
  const v = tok[i + 1] === "--" ? tok[i + 2] : tok[i + 1];
  return v === "attest" || v === "ack" ? v : void 0;
}
var ASC_BOOL_FLAGS = /* @__PURE__ */ new Set(["submit", "submitted", "dry-run", "confirm", "canceled", "wait", "json", "force", "yes", "help", "debug", "verbose", "pretty"]);
function ascBoolFlag(tok, name, negation = false) {
  let v;
  for (let i = 0; i < tok.length; i++) {
    const t = tok[i];
    if (!t.startsWith("-")) continue;
    const body = t.replace(/^--?/, "");
    const eq = body.indexOf("=");
    if ((eq === -1 ? body : body.slice(0, eq)) !== name) continue;
    if (negation && i > 0) {
      const prev = /^--?([^=]+)$/.exec(tok[i - 1]);
      if (prev && !ASC_BOOL_FLAGS.has(prev[1])) continue;
    }
    v = eq === -1 ? true : !/^(0|f|false)$/i.test(body.slice(eq + 1));
  }
  return v;
}
function submittedTrue(tok) {
  return ascBoolFlag(tok, "submitted") === true;
}
function ascPublishSubmits(args) {
  return ascBoolFlag(args, "submit") === true && ascBoolFlag(args, "dry-run", true) !== true;
}
var NON_PRODUCTION = /^(dev|develop|development|preview|staging|stage|test|testing|qa|internal|beta|canary)(?:$|[-_./0-9])/i;
var PRODUCTION_WORD = /prod|release|live|main|master|store/i;
function flagValues(tok, names) {
  const out = [];
  for (let i = 0; i < tok.length; i++) {
    const t = tok[i];
    for (const n of names) {
      if (t === n && tok[i + 1] !== void 0) out.push(tok[i + 1]);
      else if (t.startsWith(`${n}=`)) out.push(t.slice(n.length + 1));
    }
  }
  return out;
}
function androidOnly(args, platformWord) {
  const ps = flagValues(args, ["--platform", "-p", "--platforms"]);
  if (platformWord && !platformWord.startsWith("-")) ps.push(platformWord);
  return ps.length > 0 && ps.every((p) => p.toLowerCase() === "android");
}
function otaPublish(tok) {
  const name = path.basename(tok[0] ?? "").replace(/(.)@[^/]*$/, "$1");
  const bin = name === "eas-cli" ? "eas" : name;
  const args = tok.slice(1);
  const [a, b] = args;
  const channels = flagValues(args, ["--branch", "--channel", "--deployment-name", "--deployment", "-d", "--track"]);
  const channel = channels.find((c) => !nonProductionChannel(c)) ?? channels[0];
  if (bin === "eas" && (a === "update" || a === "update:republish") && !androidOnly(args)) return { what: `eas ${a}`, channel };
  if ((bin === "expo" || bin === "expo-cli") && a === "publish") return { what: "expo publish", channel: flagValue(args, ["--release-channel"]) ?? channel };
  if (bin === "appcenter" && a === "codepush" && b && /^(release(-react|-cordova|-electron)?|promote)$/.test(b)) return { what: `appcenter codepush ${b}`, channel };
  if ((bin === "code-push" || bin === "code-push-standalone" || bin === "revopush") && a && /^(release(-react|-cordova|-electron)?|promote)$/.test(a)) return { what: `${bin} ${a}`, channel };
  if (bin === "shorebird" && a === "patch" && !androidOnly(args, b)) return { what: "shorebird patch", channel };
  if (bin === "hot-updater" && a === "deploy" && !androidOnly(args)) return { what: "hot-updater deploy", channel };
  return void 0;
}
function nonProductionChannel(channel) {
  return !!channel && NON_PRODUCTION.test(channel) && !PRODUCTION_WORD.test(channel);
}
function classifySegment(seg) {
  const tok = program(tokens(seg));
  const verb = humanOnlyVerb(tok);
  if (verb) return { kind: "human_only", segment: seg, what: verb };
  const bin = path.basename(tok[0] ?? "");
  const args = tok.slice(1);
  const ota = otaPublish(tok);
  if (ota) return { kind: "ota", segment: seg, what: ota.what, channel: ota.channel };
  if (bin === "asc") {
    const [a, b] = args;
    const version = flagValue(args, ["--version"]);
    const build = flagValue(args, ["--build-number", "--build"]);
    if (a === "review" && (b === "submit" || b === "submissions-submit")) return { kind: "submit", segment: seg, version, build, what: `asc review ${b}` };
    if (a === "review" && (b === "submissions-update" || b === "submissions" && args[2] === "update") && submittedTrue(args)) {
      return { kind: "submit", segment: seg, version, build, what: "asc review submissions-update --submitted=true" };
    }
    if (a === "publish" && b === "appstore" && ascPublishSubmits(args)) {
      return { kind: "submit", segment: seg, version, build, what: "asc publish appstore --submit" };
    }
    return { kind: "none" };
  }
  if (bin === "fastlane") {
    let rest = args;
    if (rest[0] === "run") rest = rest.slice(1);
    if (rest[0] === "ios" || rest[0] === "mac" || rest[0] === "tvos") rest = rest.slice(1);
    const lane = rest[0] ?? "";
    const version = flagValue(args, ["version", "--app_version", "--version"]) ?? /\bapp_version\s*:\s*["']?([\w.]+)/.exec(seg)?.[1];
    if (/^(deliver|upload_to_app_store|appstore)$/.test(lane)) {
      return submitForReviewOn(seg, args) ? { kind: "submit", segment: seg, version, what: `fastlane ${lane} submit_for_review` } : { kind: "none" };
    }
    if (/^(pilot|upload_to_testflight|testflight|gym|build_app|match|snapshot|scan|supply)$/.test(lane)) return { kind: "none" };
    if (/submit|release/i.test(lane)) return { kind: "submit", segment: seg, version, what: `fastlane lane "${lane}"`, lane };
    if (submitForReviewOn(seg, args)) return { kind: "submit", segment: seg, version, what: `fastlane ${lane} submit_for_review` };
  }
  return { kind: "none" };
}
var MAX_CWD_CHARS = 4096;
var RANK = { none: 0, ota: 1, submit: 2, human_only: 3 };
function classifyCommand(cmdIn, cwdIn) {
  const cmd = normalizeShell(cmdIn);
  const full = classifyLines(cmd, cwdIn);
  const bare = stripShellComments(cmd);
  if (bare === cmd) return full;
  const stripped = classifyLines(bare, cwdIn);
  return RANK[stripped.kind] > RANK[full.kind] ? stripped : full;
}
function classifyLines(cmd, cwdIn) {
  let cwd = cwdIn;
  if (!MAYBE.test(cmd)) return { kind: "none", cwd };
  let found;
  for (const seg of segments(cmd)) {
    const tok = tokens(seg);
    if (tok[0] === "cd" && tok[1]) {
      const target = tok[1].replace(/^~(?=$|\/)/, process.env.HOME ?? "~");
      const grows = !path.isAbsolute(target) && !target.includes("..");
      const next = grows && cwd.length + target.length >= MAX_CWD_CHARS ? void 0 : path.resolve(cwd, target);
      if (next !== void 0 && next.length <= MAX_CWD_CHARS) cwd = next;
      continue;
    }
    const c = classifySegment(seg);
    if (c.kind === "human_only") return { ...c, cwd };
    if (c.kind === "submit" && found?.kind !== "submit") found = { ...c, cwd };
    else if (c.kind === "ota" && !found) found = { ...c, cwd };
  }
  return found ?? { kind: "none", cwd };
}
function findProjectRoot(dir, memo) {
  const start = path.resolve(dir);
  const passed = [];
  let cur = start;
  let found = null;
  for (; ; ) {
    const known = memo?.get(cur);
    if (known !== void 0) {
      found = known;
      break;
    }
    passed.push(cur);
    if ([".git", ".appstore-shield", "package.json", "Package.swift", "app.json"].some((m) => existsSync(path.join(cur, m))) || safeList(cur).some((n) => n.endsWith(".xcodeproj") || n.endsWith(".xcworkspace"))) {
      found = cur;
      break;
    }
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  if (memo) for (const p of passed) memo.set(p, found);
  return found ?? start;
}
function safeList(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
function hookOutput(decision, reason) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason }
  });
}

// src/hookGuard.ts
import { closeSync, existsSync as existsSync2, openSync, readFileSync, readSync, readdirSync as readdirSync2, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path2 from "node:path";
function flatten(cmd) {
  return normalizeShell(cmd).replace(/['"\\]/g, "");
}
function flattenKeepingSubstitutions(cmd) {
  return joinWords(cmd).replace(/['"\\]/g, "");
}
function shieldHomeDir() {
  const fallback = path2.join(homedir(), ".appstore-shield");
  const env = process.env.APPSTORE_SHIELD_HOME?.trim();
  if (!env) return fallback;
  const expanded = env.replace(/^~(?=$|[/\\])/, homedir());
  return path2.isAbsolute(expanded) ? path2.resolve(expanded) : fallback;
}
var MAX_CONFIG_BYTES = 256 * 1024;
function readCapped(file, max) {
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > max) return void 0;
    return readFileSync(file, "utf8");
  } catch {
    return void 0;
  }
}
function newMemo() {
  return { roots: /* @__PURE__ */ new Map(), ledgers: /* @__PURE__ */ new Map(), real: /* @__PURE__ */ new Map(), gitRoots: /* @__PURE__ */ new Map() };
}
function configuredLedger(dir, memo = newMemo()) {
  const root = findProjectRoot(dir, memo.roots);
  if (memo.ledgers.has(root)) return memo.ledgers.get(root);
  let ledger;
  try {
    const raw = readCapped(path2.join(root, ".appstore-shield", "config.json"), MAX_CONFIG_BYTES);
    const cfg = raw === void 0 ? void 0 : JSON.parse(raw);
    if (cfg && typeof cfg.ledgerPath === "string" && cfg.ledgerPath.trim()) ledger = path2.resolve(root, cfg.ledgerPath.trim().replace(/^~(?=$|\/)/, homedir()));
  } catch {
    ledger = void 0;
  }
  memo.ledgers.set(root, ledger);
  return ledger;
}
function gitRoot(dir, memo) {
  const passed = [];
  let cur = dir;
  let found = null;
  for (; ; ) {
    const known = memo.gitRoots.get(cur);
    if (known !== void 0) {
      found = known;
      break;
    }
    passed.push(cur);
    if (existsSync2(path2.join(cur, ".git"))) {
      found = cur;
      break;
    }
    const up = path2.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  for (const p of passed) memo.gitRoots.set(p, found);
  return found ?? void 0;
}
var LEDGER_DENY = "appstore-shield: the review ledger and the rest of the shield home (~/.appstore-shield, including its record of which ledgers each repo used) are written only by the shield tools and the developer's own `appstore-shield` commands. An agent must not write, edit, move or delete these files; read the ledger with shield_ledger_query and record events with shield_ledger_record or shield_ledger_import.";
var READERS = /* @__PURE__ */ new Set([
  "cat",
  "less",
  "more",
  "head",
  "tail",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "jq",
  "wc",
  "ls",
  "stat",
  "file",
  "du",
  "diff",
  "cmp",
  "shasum",
  "sha1sum",
  "sha256sum",
  "md5",
  "md5sum",
  "cksum",
  "realpath",
  "readlink",
  "basename",
  "dirname",
  "tree",
  "od",
  "hexdump",
  "strings",
  "nl",
  "cut",
  "column",
  "echo",
  "printf",
  "test",
  "[",
  "[[",
  "true",
  ":"
]);
var FIND_WRITE_ACTIONS = /* @__PURE__ */ new Set(["-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);
var FIND_EXEC_ACTIONS = /* @__PURE__ */ new Set(["-exec", "-execdir", "-ok", "-okdir"]);
function findWrites(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (FIND_WRITE_ACTIONS.has(a)) return true;
    if (FIND_EXEC_ACTIONS.has(a)) {
      const cmd = stripWrappers(args.slice(i + 1, i + 65), false)[0];
      if (cmd === void 0 || !READERS.has(base(cmd))) return true;
    }
  }
  return false;
}
var GIT_READS = /* @__PURE__ */ new Set(["log", "diff", "show", "status", "blame", "ls-files", "grep", "add", "commit"]);
var DECLARERS = /* @__PURE__ */ new Set(["export", "declare", "typeset", "local", "readonly"]);
var ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
function segmentKind(seg) {
  const text = seg.join(" ");
  if (text.includes("$(") || text.includes("`") || text.includes("<(") || text.includes(">(")) return "write";
  if (text.replace(/>>?[ \t]*\/dev\/null/g, "").includes(">")) return "write";
  const run = stripWrappers(seg, false);
  const prog = run[0];
  if (prog === void 0 || DECLARERS.has(prog)) return "assign";
  const name = base(prog);
  const args = run.slice(1);
  if (name === "find") return findWrites(args) ? "write" : "read";
  if (name === "git") {
    let j = 0;
    while (j < args.length && args[j].startsWith("-")) j += args[j] === "-C" || args[j] === "-c" ? 2 : 1;
    return GIT_READS.has(args[j] ?? "") ? "read" : "write";
  }
  return READERS.has(name) ? "read" : "write";
}
var CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";
var fold = (p) => CASE_INSENSITIVE_FS ? p.toLowerCase() : p;
var FS_FLAGS = CASE_INSENSITIVE_FS ? "i" : "";
var LEDGER_TEXT = new RegExp(/\.appstore-shield\/teams\b|events\.jsonl|APPSTORE_SHIELD_HOME|~\/\.appstore-shield|\$\{?HOME\}?\/\.appstore-shield/.source, FS_FLAGS);
var SETTINGS_TEXT = new RegExp(/\.appstore-shield\b/.source, FS_FLAGS);
var SETTINGS_DIR = new RegExp(/\/\.appstore-shield(\/|$)/.source, FS_FLAGS);
function bashLedgerWrite(cmd, cwd) {
  const flat = flattenKeepingSubstitutions(cmd);
  const home = shieldHomeDir();
  const memo = newMemo();
  const custom = configuredLedger(cwd, memo);
  const touch = ledgerTouch(flat, cwd, home, custom, memo);
  if (touch === "deny") return { decision: "deny", reason: LEDGER_DENY };
  if (touch === "wipe") {
    return {
      decision: "ask",
      reason: "appstore-shield: this git command can delete or revert this repo's review ledger (its configured ledgerPath is inside the repo): `git clean` deletes it while it is untracked, and `git stash`, `git reset --hard`, `git checkout`/`git restore` of a path that holds it drop the events recorded since the last commit, such as a freshly imported rejection. The gate would then read a shorter history. Commit the ledger first, or confirm this command."
    };
  }
  if (touch === "ask") {
    return {
      decision: "ask",
      reason: "appstore-shield: this command writes inside .appstore-shield/ (config, baseline suppressions or probe results). Those record the developer's own decisions and test results; confirm you want this change."
    };
  }
  return void 0;
}
function under(file, dir) {
  const rel = path2.relative(fold(dir), fold(file));
  return rel === "" || !rel.startsWith("..") && !path2.isAbsolute(rel);
}
var MAX_GLOB_WORD = 1024;
var MAX_GLOB_WORDS = 256;
var MAX_BRACE_VARIANTS = 32;
function hasGlob(w) {
  return /[*?[]/.test(w) || w.includes("{") && w.includes("}");
}
function braceGroup(w) {
  const stack = [];
  const commas = /* @__PURE__ */ new Map();
  const seq = /* @__PURE__ */ new Set();
  let best;
  for (let i = 0; i < w.length; i++) {
    const c = w[i];
    if (c === "{" && w[i - 1] !== "$") stack.push(i);
    else if (c === "}" && stack.length) {
      const start = stack.pop();
      if ((commas.has(start) || seq.has(start)) && (!best || start < best.start)) best = { start, end: i };
    } else if (c === "," && stack.length) {
      const top = stack[stack.length - 1];
      const list = commas.get(top) ?? [];
      list.push(i);
      commas.set(top, list);
    } else if (c === "." && w[i + 1] === "." && stack.length) seq.add(stack[stack.length - 1]);
  }
  if (!best) return void 0;
  const cuts = commas.get(best.start);
  if (!cuts) return best;
  const alts = [];
  let from = best.start + 1;
  for (const k of cuts) {
    alts.push(w.slice(from, k));
    from = k + 1;
  }
  alts.push(w.slice(from, best.end));
  return { ...best, alts };
}
function expandBraces(w) {
  const out = [];
  const queue = [w];
  while (queue.length) {
    if (out.length + queue.length > MAX_BRACE_VARIANTS) {
      const a = w.indexOf("{");
      const b = w.lastIndexOf("}");
      return [`${w.slice(0, a)}*${w.slice(b + 1)}`];
    }
    const cur = queue.shift();
    const g = braceGroup(cur);
    if (!g) out.push(cur);
    else for (const alt of g.alts ?? ["*"]) queue.push(cur.slice(0, g.start) + alt + cur.slice(g.end + 1));
  }
  return out;
}
function globClass(pat, p, ch) {
  let i = p + 1;
  const negate = pat[i] === "!" || pat[i] === "^";
  if (negate) i++;
  let hit = false;
  let first = true;
  for (; i < pat.length; i++) {
    const c = pat[i];
    if (c === "]" && !first) return { end: i + 1, hit: hit !== negate };
    first = false;
    if (pat[i + 1] === "-" && pat[i + 2] !== void 0 && pat[i + 2] !== "]") {
      if (ch >= c && ch <= pat[i + 2]) hit = true;
      i += 2;
    } else if (c === ch) hit = true;
  }
  return void 0;
}
function globMatch(pat, name) {
  let p = 0;
  let n = 0;
  let starP = -1;
  let starN = 0;
  while (n < name.length) {
    const c = pat[p];
    if (c === "*") {
      starP = p++;
      starN = n;
      continue;
    }
    let step = 0;
    if (c === "?") step = 1;
    else if (c === "[") {
      const cls = globClass(pat, p, name[n]);
      if (cls ? cls.hit : name[n] === "[") step = cls ? cls.end - p : 1;
    } else if (c !== void 0 && c === name[n]) step = 1;
    if (step) {
      p += step;
      n++;
    } else if (starP !== -1) {
      p = starP + 1;
      n = ++starN;
    } else return false;
  }
  while (pat[p] === "*") p++;
  return p === pat.length;
}
var comps = (abs) => fold(abs).split(/[\\/]+/).filter(Boolean);
function globReaches(pat, target, stop) {
  const pc = comps(pat);
  const tc = comps(target);
  for (let i = 0; i < pc.length; i++) {
    const p = pc[i];
    if (p === "**") return true;
    if (i >= tc.length) return true;
    const t = tc[i];
    if (t.startsWith(".") && !p.startsWith(".")) return false;
    if (!globMatch(p, t)) return false;
  }
  return pc.length >= tc.length || !stop(path2.join(path2.parse(target).root, ...target.split(/[\\/]+/).filter(Boolean).slice(0, pc.length)));
}
var SHIELD_HOME_NAMES = [["teams", 1], ["repos", 1], ["repos.json", 1], ["events.jsonl", 3]];
var SETTINGS_NAMES = [["config.json", 1], ["baseline.json", 1], ["probes", 1]];
var MAX_PATH_WORDS = 512;
function ledgerTouch(flat, cwdIn, home, custom, memo) {
  const real = (f) => realish(f, memo.real);
  const homes = [home, real(home)];
  const ledgers = /* @__PURE__ */ new Set();
  const addLedger = (l) => {
    if (l && ledgers.size < 8) {
      ledgers.add(l);
      ledgers.add(real(l));
    }
  };
  addLedger(custom);
  const root = findProjectRoot(cwdIn, memo.roots);
  const broad = [root, real(root), homedir(), real(homedir())];
  let wipe = false;
  const textHit = (t) => fold(t).includes(fold(home)) || !!custom && fold(t).includes(fold(custom)) || LEDGER_TEXT.test(t);
  let cwd = cwdIn;
  let unknownCwd = false;
  let n = 0;
  let stored = false;
  let writes = false;
  let settings = false;
  let globWords = 0;
  const stop = (ancestor) => broad.some((b) => under(b, ancestor));
  const settingsDirs = () => {
    const r = findProjectRoot(cwd, memo.roots);
    return [.../* @__PURE__ */ new Set([root, real(root), r, real(r)])].map((d) => path2.join(d, ".appstore-shield"));
  };
  const globHit = (seg) => {
    let found;
    for (const word of seg) {
      for (const piece of word.split(/[=<>]+/)) {
        if (!piece || piece.startsWith("-") || piece.includes("://") || piece.length > MAX_GLOB_WORD || !hasGlob(piece)) continue;
        if (++globWords > MAX_GLOB_WORDS) return found;
        for (const variant of expandBraces(piece)) {
          const abs = expandPath(variant, cwd);
          const parts = abs.split("/");
          const k = parts.findIndex(hasGlob);
          const forms = k > 1 ? [abs, path2.join(real(parts.slice(0, k).join("/")), ...parts.slice(k))] : [abs];
          for (const f of forms) {
            if (homes.some((h) => globReaches(f, h, stop)) || [...ledgers].some((l) => globReaches(f, l, stop))) return "deny";
            if (unknownCwd && [...ledgers].some((l) => globMatch(fold(path2.basename(variant)), fold(path2.basename(l))))) return "deny";
            if (settingsDirs().some((d) => globReaches(f, d, stop))) found = "ask";
          }
        }
      }
    }
    return found;
  };
  const findHit = (args) => {
    let i = 0;
    while (i < args.length && /^-([HLP]|O\d|D)$/.test(args[i])) i += args[i] === "-D" ? 2 : 1;
    const starts = [];
    while (i < args.length && !args[i].startsWith("-") && args[i] !== "!" && args[i] !== "(") starts.push(args[i++]);
    if (!starts.length) starts.push(".");
    const names = [];
    const paths = [];
    let unknown = false;
    let maxdepth = Infinity;
    for (; i < args.length; i++) {
      const a = args[i];
      if (a === "-name" || a === "-iname") names.push(fold(args[++i] ?? ""));
      else if (a === "-path" || a === "-ipath" || a === "-wholename" || a === "-iwholename") paths.push(fold(args[++i] ?? ""));
      else if (a === "-regex" || a === "-iregex" || a === "!" || a === "-not" || a === "-lname" || a === "-ilname") unknown = true;
      else if (a === "-maxdepth") maxdepth = Number(args[++i]) >= 0 ? Number(args[i]) : Infinity;
      else if (FIND_EXEC_ACTIONS.has(a)) break;
    }
    const filtered = names.length > 0 || paths.length > 0;
    const targets = [
      ...homes.map((dir) => ({ dir, inner: SHIELD_HOME_NAMES, verdict: "deny" })),
      ...[...ledgers].map((dir) => ({ dir, inner: [], verdict: "deny" })),
      ...settingsDirs().map((dir) => ({ dir, inner: SETTINGS_NAMES, verdict: "ask" }))
    ];
    let found;
    for (const start of starts) {
      const s0 = expandPath(start, cwd);
      for (const sf of [s0, real(s0)]) {
        for (const t of targets) {
          let hit = under(sf, t.dir);
          if (!hit && under(t.dir, sf)) {
            const rel = path2.relative(fold(sf), fold(t.dir)).split(/[\\/]+/).filter(Boolean);
            const entries = rel.map((name, k) => [name, k + 1, [start, ...rel.slice(0, k + 1)].join("/")]);
            for (const [name, d] of t.inner) entries.push([name, rel.length + d, [start, ...rel, name].join("/")]);
            hit = entries.some(([name, depth, p]) => depth <= maxdepth && (unknown || !filtered || names.some((n2) => globMatch(n2, name)) || paths.some((n2) => globMatch(n2, fold(p)))));
          }
          if (hit && t.verdict === "deny") return "deny";
          if (hit) found = "ask";
        }
      }
    }
    return found;
  };
  const wordHits = (seg) => {
    for (const word of seg) {
      for (const piece of word.split(/[=<>]+/)) {
        if (!piece || piece.startsWith("-") || piece.includes("://")) continue;
        const named = expandPath(piece, cwd);
        const forms = ++n > MAX_PATH_WORDS ? [named] : [named, real(named)];
        for (const f of forms) {
          if (homes.some((h) => under(f, h))) return true;
          for (const l of ledgers) {
            if (under(f, l)) return true;
            if (under(l, f) && !broad.some((b) => under(b, f))) return true;
            if (unknownCwd && fold(path2.basename(f)) === fold(path2.basename(l))) return true;
          }
        }
      }
    }
    return false;
  };
  for (const seg of wordSegments(flat.replace(/[<>]&[0-9-]+/g, " "))) {
    if (seg[0] === "cd" || seg[0] === "pushd") {
      const t = seg[1];
      const before = cwd;
      if (!t) cwd = homedir();
      else if (/[$`]/.test(t.replace(/^(\$HOME|\$\{HOME\}|\$PWD|\$\{PWD\})(?=$|\/)/, ""))) unknownCwd = true;
      else if (!t.startsWith("-")) {
        const grows = !path2.isAbsolute(t) && !/^(~|\$HOME|\$\{HOME\}|\$PWD|\$\{PWD\})(?=$|\/)/.test(t) && !t.includes("..");
        const next = grows && cwd.length + t.length >= MAX_CWD_CHARS ? void 0 : expandPath(t, cwd);
        if (next === void 0 || next.length > MAX_CWD_CHARS) unknownCwd = true;
        else cwd = next;
      }
      if (cwd !== before) addLedger(configuredLedger(cwd, memo));
      continue;
    }
    const kind = segmentKind(seg);
    if (kind === "write") writes = true;
    if (!wipe && ledgers.size && gitWipesLedger(seg, cwd, ledgers, memo)) wipe = true;
    const insideShield = homes.some((h) => under(cwd, h)) || [...ledgers].some((l) => under(cwd, l));
    const named = insideShield || textHit(seg.join(" ")) || wordHits(seg);
    if (named && kind === "assign") stored = true;
    else if (named && kind === "write") return "deny";
    if (kind === "write") {
      const run = stripWrappers(seg, false);
      const pattern = base(run[0] ?? "") === "find" ? findHit(run.slice(1)) : globHit(seg);
      if (pattern === "deny") return "deny";
      if (pattern === "ask") settings = true;
    }
    if (kind === "write" && (SETTINGS_TEXT.test(seg.join(" ")) || SETTINGS_DIR.test(cwd))) settings = true;
  }
  if (stored && writes) return "deny";
  if (wipe) return "wipe";
  return settings ? "ask" : void 0;
}
var STASH_VERBS = /* @__PURE__ */ new Set(["list", "show", "drop", "pop", "apply", "branch", "clear", "create", "store", "push", "save"]);
var GIT_VALUE_OPTS = /* @__PURE__ */ new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);
function gitWipesLedger(seg, cwdIn, ledgers, memo) {
  const run = stripWrappers(seg, false);
  if (base(run[0] ?? "") !== "git") return false;
  seg = run;
  let cwd = cwdIn;
  let i = 1;
  while (i < seg.length && seg[i].startsWith("-")) {
    const opt = seg[i];
    if (opt === "-C" && seg[i + 1]) cwd = expandPath(seg[i + 1], cwd);
    i += GIT_VALUE_OPTS.has(opt) ? 2 : 1;
  }
  const sub = seg[i];
  const args = seg.slice(i + 1);
  const repo = gitRoot(cwd, memo);
  if (!repo) return false;
  const inRepo = [...ledgers].filter((l) => under(l, repo));
  if (!inRepo.length) return false;
  const paths = args.filter((a) => a !== "--" && !a.startsWith("-")).map((a) => a === ":/" || a.startsWith(":/") ? path2.join(repo, a.slice(2)) : expandPath(a, cwd));
  const covers = (dirs) => dirs.some((d) => inRepo.some((l) => under(l, d)));
  switch (sub) {
    case "clean":
      if (args.some((a) => a === "-n" || a === "--dry-run" || /^-[a-z]*n[a-z]*$/.test(a))) return false;
      return paths.length ? covers(paths) : covers([cwd]);
    case "stash": {
      const verb = args.find((a) => STASH_VERBS.has(a));
      return verb === void 0 || verb === "push" || verb === "save";
    }
    case "reset":
      return args.some((a) => a === "--hard" || a === "--merge" || a === "--keep");
    case "switch":
      return args.some((a) => a === "-f" || a === "--force" || a === "--discard-changes");
    case "checkout":
    case "restore": {
      if (sub === "restore" && args.some((a) => a === "--staged" || a === "-S") && !args.some((a) => a === "--worktree" || a === "-W")) return false;
      const dash = args.indexOf("--");
      const specs = dash !== -1 ? paths.slice(args.slice(0, dash).filter((a) => !a.startsWith("-")).length) : sub === "restore" ? paths : paths.filter((p) => existsSync2(p));
      return covers(specs) || args.some((a) => a === "-f" || a === "--force") && covers([repo]);
    }
    default:
      return false;
  }
}
function realish(file, memo) {
  const rest = [];
  const passed = [];
  let dir = file;
  for (let i = 0; i < 256; i++) {
    let r = memo?.get(dir);
    if (r === void 0) {
      try {
        r = realpathSync.native(dir);
      } catch {
        const up = path2.dirname(dir);
        if (up === dir) return file;
        passed.push(dir);
        rest.push(path2.basename(dir));
        dir = up;
        continue;
      }
    }
    if (memo) {
      memo.set(dir, r);
      for (let k = 0; k < passed.length; k++) memo.set(passed[k], path2.join(r, ...rest.slice(k).reverse()));
    }
    return path2.join(r, ...rest.reverse());
  }
  return file;
}
function underAny(files, dirs) {
  return files.some((f) => dirs.some((d) => under(f, d)));
}
function fileToolDecision(filePath, cwd) {
  const resolved = path2.resolve(cwd, filePath);
  const files = [resolved, realish(resolved)];
  const file = files[1];
  const home = shieldHomeDir();
  const custom = configuredLedger(path2.dirname(resolved)) ?? configuredLedger(cwd);
  const guarded = [home, realish(home), ...custom ? [custom, realish(custom)] : []];
  const folded = files.map(fold);
  if (underAny(files, guarded) || folded.some((f) => f.includes("/.appstore-shield/") && f.endsWith(".jsonl") && f.includes("/teams/"))) {
    return { decision: "deny", reason: LEDGER_DENY };
  }
  if (folded.some((f) => f.includes("/.appstore-shield/probes/")) && /result/i.test(path2.basename(file))) {
    return {
      decision: "deny",
      reason: "appstore-shield: probe results must come from running the probe runner against the developer's backend, not from an edited file. Ask the developer to run the suite."
    };
  }
  if (folded.some((f) => f.endsWith("/.appstore-shield/baseline.json"))) {
    return { decision: "ask", reason: "appstore-shield: baseline.json holds the developer's own suppressions, each with a justification. Confirm this change yourself." };
  }
  if (folded.some((f) => f.endsWith("/.appstore-shield/config.json"))) {
    return { decision: "ask", reason: "appstore-shield: config.json chooses the Team ID and ledger location; creating or changing it can point the gate at a different history. Confirm this change yourself." };
  }
  return void 0;
}
var MAX_HOOK_COMMAND = 64 * 1024;
function trimPunct(t) {
  let a = 0;
  let b = t.length;
  let paren = 0;
  let brace = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "(") paren++;
    else if (c === ")") paren--;
    else if (c === "{") brace++;
    else if (c === "}") brace--;
  }
  for (; ; ) {
    const c = t[a];
    if (a < b && c === "!") a++;
    else if (a < b && c === "(" && paren > 0) {
      a++;
      paren--;
    } else if (a < b && c === "{" && brace > 0) {
      a++;
      brace--;
    } else break;
  }
  for (; ; ) {
    const c = t[b - 1];
    if (b > a && c === ")" && paren < 0) {
      b--;
      paren++;
    } else if (b > a && c === "}" && brace < 0) {
      b--;
      brace++;
    } else break;
  }
  return t.slice(a, b);
}
function wordSegments(flat) {
  return flat.split(/&&|\|\||[;|&\n]/).map((seg) => seg.split(/\s+/).map(trimPunct).filter(Boolean));
}
function base(t) {
  const i = t.lastIndexOf("/");
  return i === -1 ? t : t.slice(i + 1);
}
function unassign(t) {
  const m = /^[A-Za-z_][A-Za-z0-9_]*=/.exec(t);
  return m ? t.slice(m[0].length) : t;
}
var KEYWORDS = /* @__PURE__ */ new Set(["then", "do", "else", "elif", "if", "while", "until", "time"]);
function firstProgram(words) {
  return base(words.find((w) => !KEYWORDS.has(w)) ?? "");
}
var dynamic = (w) => w.startsWith("$") || w.startsWith("`");
var TEXT_PROGRAMS = /* @__PURE__ */ new Set(["git", "echo", "printf", "print", "puts", "console.log", "grep", "rg", "ag", "cat", "less", "head", "tail", "gh", "jq", "man", "which", "type", "wc", "diff", "ls"]);
function submitForReviewTrue(words) {
  for (let i = 0; i < words.length; i++) {
    const w = words[i].toLowerCase();
    let k = w.indexOf("submit_for_review");
    if (k === -1) k = w.indexOf("submit-for-review");
    if (k === -1) continue;
    const tail = `${w.slice(k + 17)} ${words.slice(i + 1, i + 3).join(" ")}`.slice(0, 80).replace(/^[\s:=>(]+/, "");
    if (/^(true|yes|1)\b/i.test(tail)) return true;
    const bareFlag = w.startsWith("-") && w.length === k + 17;
    if (bareFlag && (i + 1 >= words.length || words[i + 1].startsWith("-"))) return true;
  }
  return false;
}
var ASC_API_WRITE = /\bsubmitted\b|(^|\s)(-x\s*(post|patch)|--request[\s=]+(post|patch)|-d|--data\S*|--json)(\s|$)|\.(patch|post)\(/i;
function ascApiSubmit(text) {
  return text.includes("appstoreconnect.apple.com") && /reviewsubmission|appstoreversionsubmission/i.test(text) && ASC_API_WRITE.test(text);
}
var INLINE_INTERPRETERS = /* @__PURE__ */ new Set(["python", "python3", "node", "ruby", "perl", "deno", "bun"]);
function submissionsUpdateSubmits(rest) {
  const u = rest.findIndex((w, i) => w === "submissions-update" || w === "submissions" && rest[i + 1] === "update");
  return u !== -1 && ascBoolFlag(rest.slice(u + 1), "submitted") === true;
}
var OTA_TOOL = /\b(eas|expo|appcenter|code-push|revopush|shorebird|hot-updater)/;
var OTA_LEAD = /* @__PURE__ */ new Set(["yarn", "pnpm", "bash", "sh", "zsh", "eval", "-c", "-lc"]);
function looseOta(cmd) {
  const full = looseOtaText(cmd);
  if (full) return full;
  const bare = stripShellComments(normalizeShell(cmd));
  return bare === normalizeShell(cmd) ? void 0 : looseOtaText(bare);
}
function looseOtaText(cmd) {
  const flat = flatten(cmd);
  if (!OTA_TOOL.test(flat)) return void 0;
  for (const seg of wordSegments(flat)) {
    const words = stripWrappers(seg);
    if (!words.length || TEXT_PROGRAMS.has(firstProgram(words))) continue;
    for (let i = 0; i < words.length && i < 16; i++) {
      const w = base(unassign(words[i]));
      const run = i === 0 ? words : stripWrappers([w, ...words.slice(i + 1)]);
      const hit = otaPublish([base(unassign(run[0] ?? "")), ...run.slice(1)]);
      if (hit) return hit;
      if (!OTA_LEAD.has(w) && !ASSIGNMENT.test(words[i]) && !w.startsWith("-")) break;
    }
  }
  return void 0;
}
function looseSubmit(cmd) {
  const full = looseSubmitText(cmd);
  if (full) return full;
  const bare = stripShellComments(normalizeShell(cmd));
  return bare === normalizeShell(cmd) ? void 0 : looseSubmitText(bare);
}
var XARGS_TOOLS = /* @__PURE__ */ new Set(["asc", "fastlane"]);
function looseSubmitText(cmd) {
  const flat = flatten(cmd);
  const segs = wordSegments(flat).filter((w) => w.length && !TEXT_PROGRAMS.has(firstProgram(w)));
  const allWords = new Set(segs.flatMap((w) => w.map(unassign)));
  const submitWord = ["submit", "submissions-submit", "--submit", "-submit"].some((w) => allWords.has(w)) || [...allWords].some((w) => /^--?submit=/.test(w));
  for (const words of segs) {
    const xa = words.findIndex((w) => base(w) === "xargs");
    if (xa !== -1) {
      const t = words.findIndex((w, i) => i > xa && XARGS_TOOLS.has(base(w)));
      const sub = t === -1 ? void 0 : words.slice(t + 1).find((w) => !w.startsWith("-"));
      if (t !== -1 && (sub === void 0 || sub === "review" || sub === "publish" || dynamic(sub))) return `${base(words[t])} run through xargs, with its arguments taken from input`;
    }
    const at = words.findIndex((w) => base(unassign(w)) === "asc");
    if (at !== -1) {
      const rest = words.slice(at + 1);
      const r = rest.indexOf("review");
      const beta = r !== -1 && rest.slice(0, r).includes("testflight");
      if (r !== -1 && !beta && rest.slice(r + 1).some((w) => w === "submit" || w === "submissions-submit")) return "asc review submit";
      if (r !== -1 && !beta && submissionsUpdateSubmits(rest.slice(r + 1))) return "asc review submissions-update --submitted=true";
      const p = rest.indexOf("publish");
      if (p !== -1 && ascPublishSubmits(rest.slice(p + 1))) return "asc publish --submit";
      if (rest.some(dynamic) && submitWord) return "asc with a subcommand from a shell variable";
    }
    const prog = words.find((w) => !KEYWORDS.has(w) && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) ?? "";
    if (dynamic(prog) && (words.includes("review") && words.some((w) => w === "submit" || w === "submissions-submit") || submitWord && (allWords.has("asc") || allWords.has("fastlane")))) {
      return "a submit command run through a shell variable";
    }
    if (submitForReviewTrue(words)) return "submit_for_review";
    const fl = words.findIndex((w) => base(unassign(w)) === "fastlane");
    if (fl !== -1) {
      let j = fl + 1;
      if (words[j] === "run") j++;
      if (words[j] === "ios" || words[j] === "mac" || words[j] === "tvos") j++;
      const lane = /^\w+/.exec(words[j] ?? "")?.[0] ?? "";
      if (/submit|release/i.test(lane) && !/testflight|pilot/i.test(lane)) return "fastlane submit/release lane";
    }
    if (ascApiSubmit(words.join(" "))) return "App Store Connect API review submission";
  }
  if (segs.some((w) => INLINE_INTERPRETERS.has(firstProgram(w))) && ascApiSubmit(flat)) return "App Store Connect API review submission";
  return void 0;
}
var VERBS = /* @__PURE__ */ new Set(["attest", "ack"]);
var NAMED_LAUNCHER = /(?:^|\/)(?:appstore-shield(?:@\S*)?|cli\.[cm]?js|dist\/cli)$/;
var INTERPRETERS = /* @__PURE__ */ new Set(["node", "nodejs", "bun", "deno", "tsx", "ts-node"]);
var NON_RUNNING = /* @__PURE__ */ new Set(["git", "echo", "printf", "grep", "egrep", "rg", "ag", "ack", "cat", "less", "head", "tail", "gh", "jq", "man", "which", "type", "wc", "diff", "ls", "find", "sed", "awk", "cp", "mv", "rm", "touch", "mkdir", "chmod", "ln", "tee", "file", "stat", "code"]);
function humanOnlyRun(cmd) {
  const flat = flatten(cmd);
  const segs = wordSegments(flat);
  const mentioned = flat.split(/[\s;|&()<>=`$,{}]+/).find((t) => VERBS.has(t));
  for (const seg of segs) {
    const tok = stripWrappers(seg);
    if (NON_RUNNING.has(base(tok[0] ?? ""))) continue;
    for (let i = 0; i < tok.length; i++) {
      const t = tok[i];
      const named = NAMED_LAUNCHER.test(t);
      const prev = i > 0 ? base(tok[i - 1]) : "";
      const dynamicProgram = i === 0 && dynamic(t);
      if (!named && !dynamicProgram && !(INTERPRETERS.has(prev) && !t.startsWith("-"))) continue;
      const v = tok[i + 1] === "--" ? tok[i + 2] : tok[i + 1];
      if (v && VERBS.has(v)) return { verb: v, decision: "deny" };
      if (named && (!v || /[$`]/.test(v)) && mentioned) return { verb: mentioned, decision: "deny" };
      if (named && v && /[$`]/.test(v)) return { verb: "attest/ack", decision: "ask" };
    }
  }
  for (const seg of segs) {
    const tok = stripWrappers(seg);
    const prog = base(tok[0] ?? "");
    const wrapper = prog === "eval" || /^(ba|z|da|k)?sh$/.test(prog) && tok.some((t) => /^-[a-z]*c[a-z]*$/.test(t));
    const verb = wrapper ? tok.find((t) => VERBS.has(t)) : void 0;
    if (verb) return { verb, decision: "ask" };
  }
  return void 0;
}
var CLI_MENTION = /appstore-shield|(?:^|[\s/])cli\.[cm]?js\b|\bdist\/cli\b/;
var DETACHERS = /* @__PURE__ */ new Set(["setsid", "nohup", "disown", "daemonize", "launchctl", "at", "batch", "expect", "unbuffer", "script", "tmux", "screen", "osascript", "open", "systemd-run", "su", "sudo"]);
function backgrounds(flat) {
  for (let i = flat.indexOf("&"); i !== -1; i = flat.indexOf("&", i + 1)) {
    const prev = flat[i - 1] ?? "";
    const next = flat[i + 1] ?? "";
    if (next === "&") {
      i++;
      continue;
    }
    if (prev === ">" || prev === "<" || prev === "|" || next === ">") continue;
    return true;
  }
  return false;
}
function detachedCliRun(cmd) {
  const flat = flatten(cmd);
  if (!CLI_MENTION.test(flat)) return void 0;
  let wrapper;
  let verb;
  for (const words of wordSegments(flat)) {
    if (NON_RUNNING.has(firstProgram(words))) continue;
    const cli = words.findIndex((w) => CLI_MENTION.test(w));
    const upto = cli === -1 ? words.length : cli;
    for (let i = 0; i < upto; i++) {
      const w = base(words[i]);
      if (w === "env" && /^(-[a-zA-Z]*i[a-zA-Z]*|-|--ignore-environment)$/.test(words[i + 1] ?? "")) wrapper ??= "env -i";
      else if (DETACHERS.has(w)) wrapper ??= w;
    }
    if (words.includes("disown")) wrapper ??= "disown";
    if (cli !== -1) verb ??= words.slice(cli + 1).find((w) => VERBS.has(w) || w === "import");
  }
  if (!wrapper && backgrounds(flat)) wrapper = "a background job (&)";
  if (!wrapper) return void 0;
  return { wrapper, verb, commit: /(^|\s)--commit\b/.test(flat) };
}
var SCRIPT_RUNNERS = /* @__PURE__ */ new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "source", ".", "expect", "tclsh", "unbuffer", "osascript", "python", "python3", "perl", "ruby", "node", "nodejs", "bun", "deno", "tsx", "open"]);
var SHELLS = /* @__PURE__ */ new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "source", "."]);
var PTY_DRIVERS = /* @__PURE__ */ new Set(["expect", "unbuffer", "tclsh"]);
var MAX_SCRIPT_BYTES = 64 * 1024;
var MAX_SCRIPTS_READ = 4;
var MAX_CANDIDATES = 32;
var MAX_WORDS = 2048;
var MAX_TASK_FILE_BYTES = 1024 * 1024;
var MAX_TASK_FILES = 8;
var MAX_ANALYSES = 64;
var MAX_ANALYZED_BYTES = 4 * 1024 * 1024;
var PARSE_BUDGET_MS = 15e3;
function readHead(file) {
  try {
    const st = statSync(file);
    if (!st.isFile()) return void 0;
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(Math.min(st.size, MAX_SCRIPT_BYTES));
      const n = readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return void 0;
  }
}
function expandPath(w, cwd) {
  const h = homedir();
  const e = w.replace(/^(~|\$HOME|\$\{HOME\})(?=$|\/)/, h).replace(/^(\$PWD|\$\{PWD\})(?=$|\/)/, cwd);
  return path2.resolve(cwd, e);
}
function shellWords(raw) {
  const out = [];
  let cur = "";
  let started = false;
  let q = "";
  for (let i = 0; i < raw.length && out.length < MAX_WORDS; i++) {
    const ch = raw[i];
    if (q === "'") {
      if (ch === "'") q = "";
      else cur += ch;
    } else if (q === '"') {
      if (ch === "\\" && '"\\$`'.includes(raw[i + 1] ?? "x")) cur += raw[++i];
      else if (ch === '"') q = "";
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      q = ch;
      started = true;
    } else if (ch === "\\" && i + 1 < raw.length) {
      cur += raw[++i];
      started = true;
    } else if (ch === " " || ch === "	" || ch === "\n" || ";|&()<>".includes(ch)) {
      if (started) out.push(cur);
      cur = "";
      started = false;
      if (ch !== " " && ch !== "	") out.push(ch);
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) out.push(cur);
  return out;
}
var NOT_SHELL_CODE = /* @__PURE__ */ new Set(["python", "python3", "node", "nodejs", "ruby", "perl", "osascript", "deno", "bun", "tsx"]);
function isCodeFlag(runner, flag) {
  if (SHELLS.has(runner) || PTY_DRIVERS.has(runner)) return /^-[a-zA-Z]*c[a-zA-Z]*$/.test(flag);
  if (runner === "python" || runner === "python3") return /^-[a-zA-Z]*c$/.test(flag);
  return /^-[a-zA-Z]*[eE]$/.test(flag) || ["-p", "--eval", "--print"].includes(flag);
}
var RUNNER_VALUE_OPTS = {
  osascript: ["-l", "-s"],
  node: ["-r", "--require", "--import", "--input-type", "--loader"],
  nodejs: ["-r", "--require", "--import", "--input-type", "--loader"],
  python: ["-W", "-X"],
  python3: ["-W", "-X"]
};
function inlineCode(raw) {
  const words = shellWords(raw);
  const out = [];
  for (let i = 0; i < words.length && out.length < 8; i++) {
    const runner = base(words[i]);
    if (!SCRIPT_RUNNERS.has(runner) && runner !== "deno") continue;
    if (runner === "deno" && words[i + 1] === "eval" && words[i + 2] !== void 0) out.push({ runner, code: words[i + 2] });
    for (let j = i + 1; j < words.length && words[j].startsWith("-") && out.length < 8; j++) {
      if (isCodeFlag(runner, words[j]) && words[j + 1] !== void 0) out.push({ runner, code: words[++j] });
      else if (RUNNER_VALUE_OPTS[runner]?.includes(words[j])) j++;
    }
  }
  return out;
}
function codeWords(code) {
  return code.replace(/[[\](){},;:'"`+]/g, " ");
}
var SCRIPT_PATH = /\/|\.(sh|bash|zsh|command|tool|py|rb|pl|js|mjs|cjs|ts|exp|tcl|applescript)$/;
var TERMINAL_APPS = /^(terminal|iterm2?|warp|ghostty|alacritty|kitty|wezterm|hyper)(\.app)?$/i;
var TERMINAL_BUNDLES = /^(com\.apple\.terminal|com\.googlecode\.iterm2|dev\.warp\.|com\.mitchellh\.ghostty|(io|org)\.alacritty|net\.kovidgoyal\.kitty|com\.github\.wez\.wezterm|co\.zeit\.hyper)/i;
var APPLESCRIPT_HANDOFF = /\bdo\s+script\b|\bwrite\s+text\b|\bdoScript\s*\(|\.write\s*\(/i;
function operandText(args, values, longValues = []) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      out.push(...args.slice(i + 1));
      break;
    }
    if (longValues.includes(a)) i++;
    else if (a.startsWith("--")) continue;
    else if (a.startsWith("-") && a.length > 1) {
      if (values.includes(a[a.length - 1])) i++;
    } else out.push(a);
  }
  return out.join(" ");
}
var TMUX_RUN = {
  "send-keys": "ctN",
  send: "ctN",
  "new-session": "cefFnstxy",
  new: "cefFnstxy",
  "new-window": "ceFnt",
  neww: "ceFnt",
  "split-window": "celtFp",
  splitw: "celtFp",
  "respawn-pane": "cet",
  respawnp: "cet",
  "respawn-window": "cet",
  respawnw: "cet",
  "run-shell": "cdt",
  run: "cdt",
  "display-popup": "bcdehsStTwxy",
  popup: "bcdehsStTwxy"
};
function tmuxHandoff(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    const a = args[i];
    if (a === "-c") return { via: "tmux -c", nested: args.slice(i + 1).join(" ") };
    i += "LSfT".includes(a[a.length - 1]) ? 2 : 1;
  }
  const sub = args[i];
  const values = sub === void 0 ? void 0 : TMUX_RUN[sub];
  if (values === void 0) return void 0;
  return { via: `tmux ${sub}`, nested: operandText(args.slice(i + 1), values) };
}
function screenHandoff(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("-")) return { via: "screen", nested: args.slice(i).join(" ") };
    if (a.endsWith("X")) return { via: `screen -X ${args[i + 1] ?? ""}`.trim(), nested: args.slice(i + 2).join(" ") };
    if (a === "-Logfile" || "SceHhpsTt".includes(a[a.length - 1])) i++;
  }
  return void 0;
}
function openHandoff(args) {
  let app;
  let bundle;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--args") {
      files.push(...args.slice(i + 1));
      break;
    }
    if (a === "--env" || a === "--stdin" || a === "--stdout" || a === "--stderr" || a === "-u") i++;
    else if (a.startsWith("--")) continue;
    else if (a.startsWith("-")) {
      if (a.includes("a")) app = args[++i];
      else if (a.includes("b")) bundle = args[++i];
    } else files.push(a);
  }
  const terminal = app !== void 0 && TERMINAL_APPS.test(base(app)) || bundle !== void 0 && TERMINAL_BUNDLES.test(bundle);
  const command = files.some((f) => /\.(command|tool)$/.test(f));
  if (!terminal && !command) return void 0;
  return { via: terminal ? `open ${app !== void 0 ? `-a ${app}` : `-b ${bundle}`}` : "open of a .command file", nested: files.length ? `sh ${files.join(" ")}` : void 0 };
}
function terminalHandoff(flat, run) {
  const runner = base(run[0] ?? "");
  const args = run.slice(1);
  if (runner === "osascript" && APPLESCRIPT_HANDOFF.test(flat)) return { via: "osascript `do script`" };
  if (runner === "open") return openHandoff(args);
  if (runner === "tmux") return tmuxHandoff(args);
  if (runner === "screen") return screenHandoff(args);
  if ((runner === "kitty" || runner === "kitten") && args[0] === "@" && /^(send-text|launch|new-window)$/.test(args[1] ?? "")) {
    return { via: `kitty @ ${args[1]}`, nested: operandText(args.slice(2), "m", ["--match", "--to", "--type", "--title", "--cwd", "--window-type", "--env", "--var", "--from-file", "--location"]) };
  }
  if (runner === "wezterm" && args[0] === "cli" && /^(send-text|spawn)$/.test(args[1] ?? "")) {
    return { via: `wezterm cli ${args[1]}`, nested: operandText(args.slice(2), "", ["--pane-id", "--cwd", "--domain-name", "--window-id", "--workspace"]) };
  }
  return void 0;
}
function appleScriptCommands(code) {
  const out = [];
  const unescape = (t) => t.replace(/\\n/g, "\n").replace(/\\(.)/g, "$1");
  for (const m of code.matchAll(/\b(?:do\s+script|write\s+text)\s+"((?:[^"\\]|\\.)*)"/gi)) {
    if (out.length >= 4) break;
    out.push(unescape(m[1]));
  }
  for (const m of code.matchAll(/\b(?:doScript|write)\s*\(\s*(?:\{\s*text\s*:\s*)?(["'`])((?:(?!\1)[^\\]|\\.)*)\1/g)) {
    if (out.length >= 4) break;
    out.push(unescape(m[2]));
  }
  return out;
}
var RUNNER_VALUE_FLAGS = {
  npm: ["--prefix", "-w", "--workspace"],
  pnpm: ["-C", "--dir", "--filter", "-F"],
  yarn: ["--cwd"],
  bun: ["--cwd", "--filter", "-F"],
  make: ["-C", "--directory", "-f", "--file", "--makefile", "-I", "-o", "-W"],
  just: ["-f", "--justfile", "-d", "--working-directory", "--shell", "--shell-arg", "--dotenv-path", "--dotenv-filename", "--color"]
};
var NPM_SCRIPT_VERBS = /* @__PURE__ */ new Set(["run", "run-script", "rum", "urn"]);
var NPM_LIFECYCLE = { start: "start", test: "test", t: "test", tst: "test", stop: "stop", restart: "restart" };
function operands(args, valueFlags) {
  const opts = /* @__PURE__ */ new Map();
  const rest = [];
  for (let i = 0; i < args.length && i < 64; i++) {
    const a = args[i];
    if (a === "--") break;
    const eq = a.indexOf("=");
    if (a.startsWith("--") && eq > 0) opts.set(a.slice(0, eq), a.slice(eq + 1));
    else if (valueFlags.includes(a)) opts.set(a, args[++i] ?? "");
    else if (a === "--set") i += 2;
    else if (!a.startsWith("-")) rest.push(a);
  }
  return { opts, rest };
}
function nearestFile(dir, names, walkUp) {
  let cur = dir;
  for (let i = 0; i < 64; i++) {
    for (const n of names) {
      const f = path2.join(cur, n);
      if (existsSync2(f)) return f;
    }
    const up = path2.dirname(cur);
    if (!walkUp || up === cur) return void 0;
    cur = up;
  }
  return void 0;
}
function packageScript(runner, args, cwd, ctx) {
  const { opts, rest } = operands(args, RUNNER_VALUE_FLAGS[runner]);
  const [a, b] = rest;
  let name;
  if (runner === "npm") name = a && NPM_SCRIPT_VERBS.has(a) ? b : a ? NPM_LIFECYCLE[a] : void 0;
  else name = a === "run" || a === "run-script" ? b : a;
  if (!name || /[$`]/.test(name)) return void 0;
  const dirOpt = opts.get("--prefix") ?? opts.get("--cwd") ?? opts.get("-C") ?? opts.get("--dir");
  const file = nearestFile(dirOpt ? expandPath(dirOpt, cwd) : cwd, ["package.json"], true);
  if (!file) return void 0;
  const label = `package.json script "${name}"`;
  const dir = path2.dirname(file);
  const raw = taskFileText(file, ctx);
  let scripts;
  try {
    const parsed = raw === void 0 ? void 0 : JSON.parse(raw);
    scripts = parsed && typeof parsed === "object" ? parsed.scripts ?? {} : void 0;
  } catch {
    scripts = void 0;
  }
  if (!scripts || typeof scripts !== "object") return { label, dir };
  const text = [`pre${name}`, name, `post${name}`].map((k) => scripts[k]).filter((v) => typeof v === "string").join("\n");
  return text ? { label, dir, text } : void 0;
}
function parseRecipes(raw, kind) {
  const recipes = /* @__PURE__ */ new Map();
  let first;
  let current = [];
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("	") || line.startsWith(" ")) {
      const l = line.trim().replace(/^[@+-]+/, "");
      if (l && !l.startsWith("#")) for (const r of current) r.body.push(l);
      continue;
    }
    if (!line.trim() || line.startsWith("#")) continue;
    current = [];
    const c = line.indexOf(":");
    if (c <= 0 || line[c + 1] === "=") continue;
    const head = line.slice(0, c).trim();
    if (kind === "make" && head.includes("=")) continue;
    let tail = line.slice(c + 1).replace(/^:/, "");
    const semi = kind === "make" ? tail.indexOf(";") : -1;
    const inline = semi === -1 ? "" : tail.slice(semi + 1).trim();
    if (semi !== -1) tail = tail.slice(0, semi);
    const names = kind === "just" ? [head.replace(/^@/, "").split(/\s+/)[0] ?? ""] : head.split(/\s+/);
    const deps = tail.replace(/[()]/g, " ").split(/\s+/).filter((d) => /^[\w.-]+$/.test(d));
    for (const n of names) {
      if (!n || n.startsWith("[")) continue;
      const r = { deps, body: inline ? [inline] : [] };
      recipes.set(n, r);
      current.push(r);
      if (!first && !n.startsWith(".") && !n.includes("%")) first = n;
    }
  }
  return { recipes, first };
}
function recipeText(recipes, wanted) {
  const seen = /* @__PURE__ */ new Set();
  const queue = [...wanted];
  const lines = [];
  while (queue.length && seen.size < 32) {
    const n = queue.shift();
    if (seen.has(n)) continue;
    seen.add(n);
    const r = recipes.get(n);
    if (!r) continue;
    queue.push(...r.deps);
    lines.push(...r.body);
  }
  return lines.join("\n");
}
function recipeTask(runner, args, cwd, ctx) {
  const { opts, rest } = operands(args, RUNNER_VALUE_FLAGS[runner]);
  const dirOpt = opts.get("-C") ?? opts.get("--directory") ?? opts.get("-d") ?? opts.get("--working-directory");
  const dir = dirOpt ? expandPath(dirOpt, cwd) : cwd;
  const named = opts.get("-f") ?? opts.get("--file") ?? opts.get("--makefile") ?? opts.get("--justfile");
  const file = named ? expandPath(named, dir) : runner === "make" ? nearestFile(dir, ["GNUmakefile", "makefile", "Makefile"], false) : nearestFile(dir, ["justfile", "Justfile", ".justfile", "JUSTFILE"], true);
  if (!file || !existsSync2(file)) return void 0;
  const targets = runner === "make" ? rest.filter((t) => !t.includes("=")) : rest.slice(0, 1);
  if (targets.some((t) => /[$`]/.test(t))) return void 0;
  const raw = taskFileText(file, ctx);
  if (raw === void 0) return { label: `${path2.basename(file)} ${targets.join(" ") || "(default)"}`.trim(), dir };
  const key = `${runner}\0${file}`;
  let parsed = ctx.recipes.get(key);
  if (!parsed) ctx.recipes.set(key, parsed = parseRecipes(raw, runner));
  const { recipes, first } = parsed;
  const wanted = targets.length ? targets : first ? [first] : [];
  const text = recipeText(recipes, wanted);
  return text ? { label: `${path2.basename(file)} ${runner === "make" ? "target" : "recipe"} "${wanted.join(" ")}"`, dir: runner === "just" ? path2.dirname(file) : dir, text } : void 0;
}
function stripJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
    } else if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] !== "}" && text[j] !== "]") out += ch;
    } else out += ch;
  }
  return out;
}
function workflowCommands(def, name) {
  if (!def || typeof def !== "object") return [];
  const d = def;
  const out = [];
  const push = (v, queue2) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) for (const x of v.slice(0, 256)) push(x, queue2);
    else if (v && typeof v === "object") {
      const o = v;
      if (typeof o.run === "string") out.push(o.run);
      if (typeof o.workflow === "string") queue2.push(o.workflow);
    }
  };
  const flows = d.workflows && typeof d.workflows === "object" ? d.workflows : {};
  const hooks = [];
  for (const h of [d.before_all, d.after_all, d.error]) push(h, hooks);
  const queue = name && !/[$`]/.test(name) && Object.hasOwn(flows, name) ? [name] : Object.keys(flows);
  const seen = /* @__PURE__ */ new Set();
  while (queue.length && seen.size < 64) {
    const n = queue.shift();
    if (seen.has(n) || !Object.hasOwn(flows, n)) continue;
    seen.add(n);
    const wf = flows[n];
    push(wf?.steps, queue);
  }
  return out;
}
function ascWorkflow(args, cwd, ctx) {
  const { opts, rest } = operands(args, ["--file", "--resume", "--output", "--profile"]);
  const w = rest.indexOf("workflow");
  if (w === -1 || rest[w + 1] !== "run" || args.includes("--dry-run")) return void 0;
  const name = rest[w + 2];
  const named = opts.get("--file");
  const file = named ? expandPath(named, cwd) : nearestFile(cwd, [path2.join(".asc", "workflow.json")], true);
  if (!file || !existsSync2(file)) return void 0;
  const label = `${named ? path2.basename(file) : ".asc/workflow.json"} workflow "${name ?? "(none)"}"`;
  const dir = named ? cwd : path2.dirname(path2.dirname(file));
  const raw = taskFileText(file, ctx);
  if (raw === void 0) return { label, dir };
  try {
    const text = workflowCommands(JSON.parse(stripJsonc(raw)), name).join("\n");
    return text ? { label, dir, text } : void 0;
  } catch {
    return { label, dir };
  }
}
function taskFileText(file, ctx) {
  if (ctx.taskFiles.has(file)) return ctx.taskFiles.get(file);
  if (ctx.taskFiles.size >= MAX_TASK_FILES) {
    ctx.tooMuch ??= `more than ${MAX_TASK_FILES} package.json, Makefile, justfile or workflow files`;
    return void 0;
  }
  const text = readCapped(file, MAX_TASK_FILE_BYTES);
  ctx.taskFiles.set(file, text);
  return text;
}
function taskFor(runner, args, cwd, ctx) {
  if (RUNNER_VALUE_FLAGS[runner] && (runner === "npm" || runner === "pnpm" || runner === "yarn" || runner === "bun")) return packageScript(runner, args, cwd, ctx);
  if (runner === "make" || runner === "gmake") return recipeTask("make", args, cwd, ctx);
  if (runner === "just") return recipeTask("just", args, cwd, ctx);
  if (runner === "asc") return ascWorkflow(args, cwd, ctx);
  return void 0;
}
function spend(ctx, bytes) {
  if (ctx.tooMuch) return false;
  if (Date.now() > ctx.deadline) ctx.tooMuch = `more than ${PARSE_BUDGET_MS / 1e3} s of parsing`;
  else if (++ctx.analyses > MAX_ANALYSES) ctx.tooMuch = `more than ${MAX_ANALYSES} scripts, recipes and package scripts`;
  else if ((ctx.bytes += bytes) > MAX_ANALYZED_BYTES) ctx.tooMuch = `more than ${MAX_ANALYZED_BYTES / 1024 / 1024} MB of script text`;
  return !ctx.tooMuch;
}
function analyzeText(text, label, runner, dir, ctx, depth) {
  if (!spend(ctx, text.length)) return void 0;
  const code = text.split("\n").filter((l) => !l.trimStart().startsWith("#") && !l.trimStart().startsWith("//")).join("\n");
  const shellish = NOT_SHELL_CODE.has(runner) ? `${code}
${codeWords(code)}` : code;
  const run = humanOnlyRun(shellish);
  const driver = PTY_DRIVERS.has(runner) || /^#!.*\b(expect|unbuffer|tclsh)\b/.test(text);
  if (run) return { file: label, humanOnly: { verb: run.verb, decision: driver ? "deny" : run.decision } };
  if (CLI_MENTION.test(flatten(code))) {
    const words = new Set(flatten(code).split(/[^\w-]+/));
    const verb = words.has("attest") ? "attest" : words.has("ack") ? "ack" : words.has("import") && words.has("--commit") ? "import --commit" : void 0;
    if (verb) return { file: label, humanOnly: { verb, decision: driver ? "deny" : "ask" } };
  }
  const direct = classifyCommand(code, dir);
  const submit = looseSubmit(shellish) ?? (direct.kind === "submit" ? direct.what : void 0);
  const where = label.includes("/") ? path2.basename(label) : label;
  if (submit) return { file: label, submit: `${submit} in ${where}` };
  const ota = direct.kind === "ota" ? { what: direct.what ?? "an over-the-air update", channel: direct.channel } : looseOta(shellish);
  if (ota) ctx.ota ??= { what: `${ota.what} in ${where}`, channel: ota.channel };
  if (runner === "osascript" && APPLESCRIPT_HANDOFF.test(code)) {
    ctx.leaves ??= `osascript \`do script\` in ${path2.basename(label)}`;
    for (const typed of appleScriptCommands(code)) {
      const hit = analyzeText(typed, `the command osascript hands to a terminal in ${path2.basename(label)}`, "sh", dir, ctx, depth);
      if (hit) return hit;
    }
  }
  ctx.lane ??= fastlaneLane(code);
  if (depth < 2) return scan(shellish, dir, ctx, depth + 1);
  return void 0;
}
function scan(cmd, cwd, ctx, depth) {
  const flat = flatten(cmd);
  const files = [];
  const drivers = /* @__PURE__ */ new Set();
  let words = 0;
  for (const seg of wordSegments(flat)) {
    if ((words += seg.length) > MAX_WORDS || ctx.tooMuch) break;
    const run = stripWrappers(seg);
    const prog = run[0];
    if (!prog || NON_RUNNING.has(base(prog))) continue;
    const runner = base(prog);
    const handoff = terminalHandoff(flat, run);
    if (handoff) {
      ctx.leaves ??= handoff.via;
      if (handoff.nested) {
        const hit = analyzeText(handoff.nested, `the command ${handoff.via} hands over`, "sh", cwd, ctx, depth);
        if (hit) return hit;
      }
    }
    const task = taskFor(runner, run.slice(1), cwd, ctx);
    if (task) {
      if (task.text === void 0) ctx.unreadable ??= task.label;
      else {
        const key = `${task.dir}\0${task.label}`;
        if (!ctx.seenTasks.has(key)) {
          ctx.seenTasks.add(key);
          const hit = analyzeText(task.text, task.label, "sh", task.dir, ctx, depth);
          if (hit) return hit;
        }
      }
    }
    if (SCRIPT_RUNNERS.has(runner)) {
      for (const w of run.slice(1)) {
        if (files.length >= MAX_CANDIDATES) break;
        if (w.startsWith("-") || NAMED_LAUNCHER.test(w)) continue;
        const resolved = expandPath(w, cwd);
        if (!/[$`]/.test(resolved)) files.push({ file: resolved, runner });
      }
    } else if (prog.includes("/") && !NAMED_LAUNCHER.test(prog) && files.length < MAX_CANDIDATES) {
      const resolved = expandPath(prog, cwd);
      if (!/[$`]/.test(resolved)) files.push({ file: resolved, runner });
    }
    if (PTY_DRIVERS.has(runner)) drivers.add(runner);
  }
  if (depth < 2) {
    for (const { runner, code } of inlineCode(cmd)) {
      if (NOT_SHELL_CODE.has(runner)) {
        const hit = analyzeText(code, `${runner} inline code`, runner, cwd, ctx, depth);
        if (hit) return hit;
        for (const w of codeWords(code).split(/\s+/)) {
          if (files.length >= MAX_CANDIDATES) break;
          if (SCRIPT_PATH.test(w) && !/^[a-z]+:\/\//i.test(w) && !/[$`]/.test(w)) files.push({ file: expandPath(w, cwd), runner: "sh" });
        }
      } else {
        const hit = analyzeText(code, `${runner} -c code`, runner, cwd, ctx, depth);
        if (hit) return hit;
      }
    }
  }
  const read = /* @__PURE__ */ new Set();
  for (const { file, runner } of files) {
    if (ctx.read >= MAX_SCRIPTS_READ || ctx.tried >= MAX_CANDIDATES || ctx.tooMuch) break;
    ctx.tried++;
    const text = readHead(file);
    if (!text) continue;
    ctx.read++;
    read.add(runner);
    const hit = analyzeText(text, file, runner, path2.dirname(file), ctx, depth);
    if (hit) return hit;
  }
  const blind = [...drivers].find((d) => !read.has(d));
  if (blind) return { file: blind, humanOnly: { verb: "attest/ack", decision: "ask" } };
  return void 0;
}
function scriptFileHit(cmd, cwd, budgetMs = PARSE_BUDGET_MS) {
  const ctx = { read: 0, tried: 0, deadline: Date.now() + budgetMs, analyses: 0, bytes: 0, taskFiles: /* @__PURE__ */ new Map(), recipes: /* @__PURE__ */ new Map(), seenTasks: /* @__PURE__ */ new Set() };
  const hit = scan(cmd, cwd, ctx, 0);
  if (hit) return hit;
  if (ctx.tooMuch) return { file: "", tooMuch: ctx.tooMuch };
  if (ctx.unreadable) return { file: ctx.unreadable, unreadable: ctx.unreadable };
  if (ctx.lane || ctx.leaves || ctx.ota) return { file: "", lane: ctx.lane, leavesSession: ctx.leaves, ota: ctx.ota };
  return void 0;
}
function fastlaneLane(cmd) {
  for (const words of wordSegments(flatten(cmd))) {
    if (TEXT_PROGRAMS.has(firstProgram(words))) continue;
    const at = words.findIndex((w) => base(unassign(w)) === "fastlane");
    if (at === -1) continue;
    let j = at + 1;
    if (words[j] === "run") continue;
    if (words[j] === "ios" || words[j] === "mac" || words[j] === "tvos") j++;
    const lane = /^\w+/.exec(words[j] ?? "")?.[0];
    if (lane) return lane;
  }
  return void 0;
}
var UPLOAD_ACTION = /\b(deliver|upload_to_app_store|appstore)\b/;
var LANE_DEF = /^[ \t]*(?:private_)?lane[ \t]+:(\w+)/gm;
var MAX_FASTFILE_BYTES = 256 * 1024;
function uncommented(text) {
  return text.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
}
var FASTLANE_DIRS = (dir) => [path2.join(dir, "fastlane"), dir, path2.join(dir, "ios", "fastlane")];
var TRUE_ENV = /^(true|yes|1|on)$/i;
var DELIVER_ENV = /^[ \t]*(?:export[ \t]+)?DELIVER_SUBMIT_FOR_REVIEW[ \t]*=[ \t]*["']?(?:true|yes|1|on)\b/im;
function deliverDirSubmits(fdir, envNames) {
  const deliverfile = path2.join(fdir, "Deliverfile");
  const df = readCapped(deliverfile, MAX_FASTFILE_BYTES);
  if (df && submitForReviewTrue(uncommented(df).split(/\s+/))) return `${deliverfile} sets submit_for_review`;
  for (const name of [".env", ".env.default", ...envNames.map((e) => `.env.${e}`)]) {
    const f = path2.join(fdir, name);
    const t = readCapped(f, MAX_FASTFILE_BYTES);
    if (t && DELIVER_ENV.test(t)) return `${f} sets DELIVER_SUBMIT_FOR_REVIEW`;
  }
  return void 0;
}
var DELIVER_LANE = /^(deliver|upload_to_app_store|appstore)$/;
var DELIVER_NON_UPLOAD = /\b(deliver|upload_to_app_store|appstore)\s+(init|download_metadata|download_screenshots|generate_summary)\b/;
var SUBMIT_OFF = /submit[_-]for[_-]review[\s:=]+(false|no|0)\b/i;
function deliverConfigSubmit(cmd, lane, dirs, env = process.env) {
  if (!lane || !DELIVER_LANE.test(lane)) return void 0;
  const bare = flatten(stripShellComments(normalizeShell(cmd)));
  if (SUBMIT_OFF.test(bare) || DELIVER_NON_UPLOAD.test(bare)) return void 0;
  if (TRUE_ENV.test(env.DELIVER_SUBMIT_FOR_REVIEW ?? "")) return "DELIVER_SUBMIT_FOR_REVIEW is set in the environment";
  const envNames = [];
  for (const words of wordSegments(bare)) {
    for (let i = 0; i < words.length; i++) {
      const v = words[i] === "--env" ? words[i + 1] : words[i].startsWith("--env=") ? words[i].slice(6) : void 0;
      if (v) envNames.push(...v.split(",").filter((e) => /^[\w-]{1,64}$/.test(e)));
    }
  }
  const seen = /* @__PURE__ */ new Set();
  for (const dir of dirs) {
    for (const fdir of FASTLANE_DIRS(dir)) {
      if (seen.has(fdir)) continue;
      seen.add(fdir);
      const hit = deliverDirSubmits(fdir, envNames.slice(0, 8));
      if (hit) return hit;
    }
  }
  return void 0;
}
function fastfileLanes(dirs) {
  const lanes = /* @__PURE__ */ new Set();
  const defined = /* @__PURE__ */ new Set();
  const unclear = /* @__PURE__ */ new Set();
  const seen = /* @__PURE__ */ new Set();
  for (const dir of dirs) {
    for (const fdir of FASTLANE_DIRS(dir)) {
      const fastfile = path2.join(fdir, "Fastfile");
      if (seen.has(fastfile)) continue;
      seen.add(fastfile);
      const raw = readCapped(fastfile, MAX_FASTFILE_BYTES);
      if (!raw) continue;
      const text = uncommented(raw);
      const deliverSubmits = deliverDirSubmits(fdir, []) !== void 0;
      const defs = [...text.matchAll(LANE_DEF)];
      const bodies = defs.map((m, i) => ({ name: m[1], body: text.slice(m.index + m[0].length, defs[i + 1]?.index ?? text.length) }));
      for (const { name, body } of bodies) {
        defined.add(name);
        if (UPLOAD_ACTION.test(body) && (deliverSubmits || submitForReviewTrue(body.split(/\s+/)))) lanes.add(name);
        else if (looseSubmit(codeWords(body))) lanes.add(name);
        else if (/submit_for_review/.test(body) && !/submit_for_review\s*(:|=>)\s*false\b/.test(body)) unclear.add(name);
      }
      for (let pass = 0; pass < 5; pass++) {
        let grew = false;
        for (const { name, body } of bodies) {
          if (lanes.has(name)) continue;
          if (body.split(/[^\w]+/).some((w) => lanes.has(w))) {
            lanes.add(name);
            grew = true;
          }
        }
        if (!grew) break;
      }
    }
  }
  return { defined, submit: lanes, unclear };
}
function isSubmitMcpTool(name) {
  if (!name.startsWith("mcp__")) return false;
  const n = name.toLowerCase().replace(/-/g, "_");
  if (!/submi(t|ssion)/.test(n) || !/(review|app_?store|asc|store_?connect)/.test(n)) return false;
  const words = name.slice(name.lastIndexOf("__") + 2).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const writes = words.some((w) => w === "submit" || w === "create" || w === "update" || w === "patch" || w === "post");
  const dryRun = words.includes("dryrun") || words.some((w, i) => w === "dry" && words[i + 1] === "run");
  if (dryRun) return false;
  if (READ_ONLY_VERBS.has(words[0] ?? "")) return words.slice(1).includes("submit");
  return writes || !words.some((w) => READ_ONLY_VERBS.has(w));
}
var READ_ONLY_VERBS = /* @__PURE__ */ new Set(["list", "get", "read", "fetch", "show", "describe", "search", "find", "query", "status", "history", "cancel", "delete", "remove", "validate", "check", "view", "lookup", "count", "poll", "wait", "watch"]);
function safeList2(dir) {
  try {
    return readdirSync2(dir);
  } catch {
    return [];
  }
}
function resolveGateRoot(dir) {
  const near = findProjectRoot(dir);
  const parent = path2.dirname(near);
  if (parent === near || parent === homedir() || near === homedir()) return near;
  if (!["ios", "macos"].includes(path2.basename(near))) return near;
  if (existsSync2(path2.join(near, ".git")) || existsSync2(path2.join(near, ".appstore-shield"))) return near;
  const native = safeList2(near).some((n) => n.endsWith(".xcodeproj") || n.endsWith(".xcworkspace") || n === "Podfile");
  const js = ["package.json", "app.json", "app.config.js", "app.config.ts", ".appstore-shield"].some((m) => existsSync2(path2.join(parent, m)));
  return native && js ? parent : near;
}
function agentEnvironment(env = process.env) {
  return ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "AI_AGENT"].find((k) => env[k]);
}
var NO_TTY = /^(\?\??|-|)$/;
var PTY_HOSTS = /^(expect|unbuffer|script|empty|socat|tclsh[\d.]*|python[\d.]*|perl[\d.]*|ruby[\d.]*|node|nodejs|bun|deno|osascript)$/i;
function lineageProblem(table, selfPid) {
  const self = table.get(selfPid);
  if (!self) return "this process is missing from the process table";
  if (NO_TTY.test(self.tty)) return "it has no controlling terminal (it was started in the background or by a program, not typed into a terminal)";
  if (self.ppid <= 1) return "its parent exited and it was re-parented to pid 1, as a detached or double-forked process is";
  let pid = self.ppid;
  for (let i = 0; i < 128; i++) {
    const row = table.get(pid);
    if (!row) return "a process on its terminal is missing from the process table";
    if (row.tty !== self.tty) {
      const name = base(row.comm);
      return PTY_HOSTS.test(name) ? `its terminal is driven by ${name} (pid ${pid}), a program, not a terminal app a person types into` : void 0;
    }
    if (row.ppid <= 1) return "the shells on its terminal were re-parented to pid 1, as a detached or double-forked process is";
    pid = row.ppid;
  }
  return void 0;
}
function clearedEnvironment(env = process.env) {
  const missing = ["TERM", "HOME"].filter((k) => !env[k]);
  if (!env.USER && !env.LOGNAME) missing.push("USER/LOGNAME");
  return missing.length ? `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set, as in an environment cleared with \`env -i\`` : void 0;
}

export {
  nonProductionChannel,
  classifyCommand,
  hookOutput,
  readCapped,
  bashLedgerWrite,
  fileToolDecision,
  MAX_HOOK_COMMAND,
  looseOta,
  looseSubmit,
  humanOnlyRun,
  detachedCliRun,
  scriptFileHit,
  fastlaneLane,
  deliverConfigSubmit,
  fastfileLanes,
  isSubmitMcpTool,
  resolveGateRoot,
  agentEnvironment,
  lineageProblem,
  clearedEnvironment
};

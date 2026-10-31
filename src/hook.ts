import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Claude Code PreToolUse (Bash) hook logic. Submit-for-review commands are gated: uploads
 * (altool, iTMSTransporter, `eas submit`, `asc builds upload`, `asc publish` without --submit) put
 * a build in App Store Connect but do not send anything to App Review. Over-the-air publishes
 * (`eas update`, CodePush, Shorebird) are gated too, because they reach users without review.
 */

export type CommandKind = "submit" | "ota" | "human_only" | "none";

export interface Classified {
  kind: CommandKind;
  /** the segment that matched */
  segment?: string;
  /** directory the segment runs in, after any leading `cd` */
  cwd: string;
  version?: string;
  build?: string;
  what?: string;
  /** set when only the lane's name (`release`, `submit_*`) says it submits; the caller checks the Fastfile */
  lane?: string;
  /** OTA only: the branch, channel, deployment or track the update goes to, when the command names it */
  channel?: string;
}

// Cheap prefilter: an unrelated command costs one regex test here, not a parse. (Starting node
// and loading the bundle dominate the hook's time either way.)
const MAYBE = /\b(asc|fastlane|attest|ack|eas|expo|codepush|code-push|shorebird|hot-updater|revopush)\b/;

/**
 * What bash does to the text before it splits words, in the cheap cases: a backslash-newline
 * joins the halves into one word (`sub\<newline>mit` is `submit`), and `$IFS` / `${IFS}` is a
 * word break. The `{0,64}` bound keeps a run of unclosed `${IFS` linear.
 */
export function normalizeShell(cmd: string): string {
  return exposeSubstitutions(joinWords(cmd));
}

/** normalizeShell without exposeSubstitutions, for checks that treat a substitution itself as the signal. */
export function joinWords(cmd: string): string {
  return cmd.replace(/\\\r?\n/g, "").replace(/\$\{IFS[^}]{0,64}\}|\$IFS(?![A-Za-z0-9_])/g, " ");
}

/**
 * `$(…)`, backticks, `<(…)` and `>(…)` run their body as a command of its own, also inside
 * double quotes (`OUT=$(asc review submit)`, `echo "$(eas update)"`, `git commit -m "$(… ack)"`).
 * Each body is moved out to a line of its own just before the segment that holds it (bash runs
 * it first), and the substitution is left as the dynamic word `$__`, so every check that splits
 * on control operators sees the body as a command, and the outer segment keeps a word computed
 * at run time (`$(which asc) review submit`). Single quotes and `#` comments are left alone,
 * since bash runs nothing in them. One pass; nesting deeper than MAX_SUBST_DEPTH stays as text,
 * which keeps the copying linear.
 */
export function exposeSubstitutions(cmd: string): string {
  if (!/\$\(|`|[<>]\(/.test(cmd)) return cmd;
  interface Frame {
    close: ")" | "`" | "";
    dq: boolean;
    depth: number;
    /** finished segments, each with the bodies moved before it */
    done: string[];
    cur: string;
    bodies: string[];
  }
  const frame = (close: Frame["close"]): Frame => ({ close, dq: false, depth: 0, done: [], cur: "", bodies: [] });
  const text = (f: Frame) => f.done.join("") + (f.bodies.length ? `\n${f.bodies.join("\n")}\n` : "") + f.cur;
  const stack: Frame[] = [frame("")];
  const closeTop = () => {
    const f = stack.pop()!;
    const parent = stack[stack.length - 1]!;
    parent.bodies.push(text(f));
    parent.cur += "$__";
  };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    const f = stack[stack.length - 1]!;
    if (ch === "\\") {
      f.cur += cmd.slice(i, i + 2);
      i++;
    } else if (!f.dq && ch === "'") {
      const end = cmd.indexOf("'", i + 1);
      const j = end === -1 ? cmd.length : end + 1;
      f.cur += cmd.slice(i, j);
      i = j - 1;
    } else if (!f.dq && ch === "#" && (i === 0 || " \t\n;&|(".includes(cmd[i - 1]!))) {
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
    } else if ((ch === "$" || (!f.dq && (ch === "<" || ch === ">"))) && cmd[i + 1] === "(" && stack.length <= MAX_SUBST_DEPTH) {
      stack.push(frame(")"));
      i++;
    } else if (!f.dq && ch === "(") {
      f.depth++;
      f.cur += ch;
    } else if (!f.dq && ch === ")" && f.depth === 0 && f.close === ")") {
      closeTop();
    } else if (!f.dq && (ch === ";" || ch === "\n" || ch === "|" || (ch === "&" && !"<>".includes(cmd[i - 1] ?? "") && cmd[i + 1] !== ">"))) {
      // A control operator ends the segment; `&&` and `||` stay whole.
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
  return text(stack[0]!);
}

const MAX_SUBST_DEPTH = 32;

/**
 * The text with unquoted `#` comments removed (a `#` that starts a word, through the end of the
 * line). One pass, no regex. Callers classify both this and the full text and keep the stronger
 * result, so a comment can neither cancel a submit (`… --submit # --dry-run`) nor, in a shell that
 * does not treat `#` as a comment, hide one.
 */
export function stripShellComments(cmd: string): string {
  if (!cmd.includes("#")) return cmd;
  let out = "";
  let start = 0;
  let q = "";
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (q) {
      if (ch === q) q = "";
      else if (q === '"' && ch === "\\") i++;
      continue;
    }
    if (ch === "\\") i++;
    else if (ch === "'" || ch === '"') q = ch;
    else if (ch === "#" && (i === 0 || " \t\n;&|()".includes(cmd[i - 1]!))) {
      out += cmd.slice(start, i);
      const nl = cmd.indexOf("\n", i);
      if (nl === -1) return out;
      start = nl;
      i = nl - 1;
    }
  }
  return out + cmd.slice(start);
}

/** Splits on shell control operators; good enough for gating, not a shell parser. */
function segments(cmd: string): string[] {
  return cmd
    .split(/&&|\|\||;|\||\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function tokens(seg: string): string[] {
  const out: string[] = [];
  // A segment cut at a `;` inside quotes leaves a stray quote on its first or last word.
  for (const m of seg.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push((m[1] ?? m[2] ?? m[3] ?? "").replace(/^["']+|["']+$/g, ""));
  return out;
}

/**
 * How a wrapper reads its own arguments before the command it runs: short options that take a
 * value (`timeout -s KILL`), long options that take one as the next word (`--signal KILL`, or a
 * single-dash long one such as xcrun's `-sdk`), how many operands come before the command
 * (timeout's DURATION), whether `NAME=value` words are allowed, and options whose value is
 * itself a command line (`env -S 'eas update'`, `npx -c 'eas update'`).
 */
interface WrapperSpec {
  short?: string;
  long?: string[];
  operands?: number;
  assigns?: boolean;
  command?: string[];
}

const WRAPPER_SPECS: Record<string, WrapperSpec> = {
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
  bunx: { short: "p", long: ["--package"] },
};

/** `op run -- CMD`, `npm exec CMD`, `bundle exec CMD`: a program and subcommand that run what follows. */
const SUBCOMMAND_WRAPPERS: Record<string, { sub: string[]; spec: WrapperSpec }> = {
  op: { sub: ["run"], spec: { long: ["--env-file", "--account", "--config", "--session"] } },
  doppler: { sub: ["run"], spec: { short: "pc", long: ["--project", "--config", "--token", "--command", "--mount", "--mount-format", "--mount-template", "--name-transformer", "--fallback", "--scope"], command: ["--command"] } },
  infisical: { sub: ["run"], spec: { long: ["--env", "--path", "--projectId", "--token", "--command", "--tags", "--domain"], command: ["--command"] } },
  dotenvx: { sub: ["run"], spec: { short: "fe", long: ["--env-file", "--env", "--convention"] } },
  "aws-vault": { sub: ["exec"], spec: { short: "d", long: ["--duration", "--region", "--mfa-token"], operands: 1 } },
  npm: { sub: ["exec", "x"], spec: { short: "pcw", long: ["--package", "--call", "--workspace", "--prefix"], command: ["-c", "--call"] } },
  pnpm: { sub: ["exec", "dlx"], spec: { short: "pcC", long: ["--package", "--filter", "--dir"], command: ["-c"] } },
  yarn: { sub: ["exec", "dlx"], spec: { short: "p", long: ["--package"] } },
  bun: { sub: ["x"], spec: {} },
  bundle: { sub: ["exec"], spec: {} },
};

// `then asc …` and `if eas update …; then`: the word after a keyword is the program.
const LEAD_KEYWORDS = new Set(["then", "do", "else", "elif", "if", "while", "until", "!", "{", "("]);
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Index of the wrapped command in `w` after `start`, and the words of any option whose value is
 * a command line. Bounded by the word count: one pass.
 */
function skipWrapperArgs(w: readonly string[], start: number, spec: WrapperSpec): { at: number; inline?: string } {
  let i = start;
  let operands = spec.operands ?? 0;
  let inline: string | undefined;
  const takes = (flag: string, value: string | undefined) => {
    if (value !== undefined && spec.command?.includes(flag)) inline ??= value;
  };
  // Once an option gave the command line itself, what follows are that command's arguments.
  while (i < w.length && inline === undefined) {
    const a = w[i]!;
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
      // A cluster such as `-dmS NAME` or `-n5`: the first value-taking letter ends it.
      let consumed = 1;
      for (let k = 1; k < a.length; k++) {
        if (!spec.short?.includes(a[k]!)) continue;
        const attached = a.slice(k + 1);
        takes(`-${a[k]}`, attached || w[i + 1]);
        if (!attached) consumed = 2;
        break;
      }
      i += consumed;
    } else if (spec.assigns && ASSIGN.test(a)) i++;
    else if (operands > 0) {
      operands--;
      i++;
    } else break;
  }
  return { at: i, inline };
}

/** One wrapper removed from the front of `w`, or undefined when `w[0]` is the program itself. */
function unwrapOnce(w: readonly string[], descend: boolean): string[] | undefined {
  const first = w[0];
  if (first === undefined) return undefined;
  if (LEAD_KEYWORDS.has(first) || ASSIGN.test(first)) return w.slice(1);
  const name = path.basename(first);
  const spec = WRAPPER_SPECS[name];
  const sub = SUBCOMMAND_WRAPPERS[name];
  let found: { at: number; inline?: string } | undefined;
  if (spec) found = skipWrapperArgs(w, 1, spec);
  else if (sub && w[1] !== undefined && sub.sub.includes(w[1])) found = skipWrapperArgs(w, 2, sub.spec);
  else if (descend && name === "xargs") found = skipWrapperArgs(w, 1, XARGS_SPEC);
  else if (descend && name === "find") {
    // `find … -exec CMD {} ;` runs CMD for every match.
    const x = w.findIndex((a) => FIND_EXEC.has(a));
    if (x !== -1) found = { at: x + 1 };
  }
  if (!found) return undefined;
  // A command line given as an option value is the command (`env -S 'eas update'`).
  if (found.inline !== undefined) return [...found.inline.split(/\s+/).filter(Boolean), ...w.slice(found.at)];
  return w.slice(found.at);
}

const XARGS_SPEC: WrapperSpec = { short: "InLPsdEaRSJ", long: ["--max-args", "--max-lines", "--max-procs", "--max-chars", "--delimiter", "--eof", "--arg-file", "--replace", "--process-slot-var"] };
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/**
 * The words from the program a segment actually runs: env assignments, shell keywords and
 * wrappers that start another command (`timeout 900`, `nice -n 5`, `caffeinate -i`, `op run --`,
 * `doppler run --`, `dotenv -e f --`, `sudo -u u`, `npx -y`, `bundle exec`) are dropped with their
 * own options and operands. With `descend`, `xargs [opts] CMD` and `find … -exec CMD` count as
 * running CMD. Every check that asks "which program is this" uses this one list, so they cannot
 * disagree about a wrapper. At most 64 wrappers deep, each step one pass over the segment.
 */
export function stripWrappers(words: readonly string[], descend = true): string[] {
  let w: readonly string[] = words;
  for (let guard = 0; guard < 64 && w.length; guard++) {
    const next = unwrapOnce(w, descend);
    if (next === undefined) break;
    w = next;
  }
  return [...w];
}

/** Drops env assignments and wrappers (see stripWrappers). */
function program(tok: string[]): string[] {
  return stripWrappers(tok);
}

function flagValue(tok: string[], names: string[]): string | undefined {
  for (let i = 0; i < tok.length; i++) {
    const t = tok[i]!;
    for (const n of names) {
      if (t === n) return tok[i + 1];
      if (t.startsWith(`${n}=`)) return t.slice(n.length + 1);
    }
  }
  return undefined;
}

function isTrueish(v: string | undefined): boolean {
  return v === undefined || /^(true|yes|1)$/i.test(v);
}

function submitForReviewOn(seg: string, tok: string[]): boolean {
  const kv = /\bsubmit_for_review\s*[:=]\s*["']?(\w+)/i.exec(seg);
  if (kv) return isTrueish(kv[1]);
  const i = tok.findIndex((t) => t === "--submit_for_review" || t === "--submit-for-review");
  if (i === -1) return false;
  const next = tok[i + 1];
  return next === undefined || next.startsWith("-") || isTrueish(next);
}

const LAUNCHER = /(?:^|\/)(?:appstore-shield(?:@\S*)?|cli\.[cm]?js)$/;
const JS_RUNTIMES = new Set(["node", "nodejs", "bun", "deno", "tsx"]);

/**
 * attest/ack when this CLI is the segment's program (`appstore-shield ack`, `node dist/cli.js
 * attest`). The words inside `git commit -m "…appstore-shield attest…"` or `grep` are text, not a
 * run; shell-string wrappers (`bash -c`, `eval`) are hookGuard's humanOnlyRun.
 */
function humanOnlyVerb(tok: string[]): string | undefined {
  let i = 0;
  if (JS_RUNTIMES.has(path.basename(tok[0] ?? ""))) {
    i = 1;
    while (tok[i]?.startsWith("-")) i++;
  }
  if (!LAUNCHER.test(tok[i] ?? "")) return undefined;
  const v = tok[i + 1] === "--" ? tok[i + 2] : tok[i + 1];
  return v === "attest" || v === "ack" ? v : undefined;
}

// asc's flags that take no value. Any other flag written without `=` takes the next word as its
// value, so a `--dry-run` right after it is that value, not a flag.
const ASC_BOOL_FLAGS = new Set(["submit", "submitted", "dry-run", "confirm", "canceled", "wait", "json", "force", "yes", "help", "debug", "verbose", "pretty"]);

/**
 * A boolean flag the way asc reads it (Go's `flag` package): one or two leading dashes, a bare
 * flag is true and never takes the next word, `=v` is false only for 0/f/false in any case (an
 * invalid value makes asc fail, which is not a dry run), and the last occurrence wins. With
 * `negation`, an occurrence that is the value of the flag before it does not count: it decides
 * whether a submit is skipped, so it has to be a real flag.
 */
export function ascBoolFlag(tok: string[], name: string, negation = false): boolean | undefined {
  let v: boolean | undefined;
  for (let i = 0; i < tok.length; i++) {
    const t = tok[i]!;
    if (!t.startsWith("-")) continue;
    const body = t.replace(/^--?/, "");
    const eq = body.indexOf("=");
    if ((eq === -1 ? body : body.slice(0, eq)) !== name) continue;
    if (negation && i > 0) {
      const prev = /^--?([^=]+)$/.exec(tok[i - 1]!);
      if (prev && !ASC_BOOL_FLAGS.has(prev[1]!)) continue;
    }
    v = eq === -1 ? true : !/^(0|f|false)$/i.test(body.slice(eq + 1));
  }
  return v;
}

/** asc's flag that sends a review submission, in any spelling asc accepts. */
function submittedTrue(tok: string[]): boolean {
  return ascBoolFlag(tok, "submitted") === true;
}

/** `asc publish appstore --submit` that is not a dry run. */
export function ascPublishSubmits(args: string[]): boolean {
  return ascBoolFlag(args, "submit") === true && ascBoolFlag(args, "dry-run", true) !== true;
}

// A development channel's name starts with one of these and goes on, if at all, after a separator.
const NON_PRODUCTION = /^(dev|develop|development|preview|staging|stage|test|testing|qa|internal|beta|canary)(?:$|[-_./0-9])/i;
// `beta-prod`, `qa-release`, `staging-main`: a name that also says production is production.
const PRODUCTION_WORD = /prod|release|live|main|master|store/i;

function flagValues(tok: string[], names: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tok.length; i++) {
    const t = tok[i]!;
    for (const n of names) {
      if (t === n && tok[i + 1] !== undefined) out.push(tok[i + 1]!);
      else if (t.startsWith(`${n}=`)) out.push(t.slice(n.length + 1));
    }
  }
  return out;
}

/** Android-only updates never reach the iOS app; every platform the command names must be android. */
function androidOnly(args: string[], platformWord?: string): boolean {
  const ps = flagValues(args, ["--platform", "-p", "--platforms"]);
  if (platformWord && !platformWord.startsWith("-")) ps.push(platformWord);
  return ps.length > 0 && ps.every((p) => p.toLowerCase() === "android");
}

/**
 * Over-the-air publishes: they change what users of the reviewed build run without a new App
 * Review, so 2.5.2 and DPLA 3.2(e) apply. Rollbacks, listings and configuration are not publishes.
 */
export function otaPublish(tok: string[]): { what: string; channel?: string } | undefined {
  // `npx eas-cli@latest update` runs the same publish as `eas update`.
  const name = path.basename(tok[0] ?? "").replace(/(.)@[^/]*$/, "$1");
  const bin = name === "eas-cli" ? "eas" : name;
  const args = tok.slice(1);
  const [a, b] = args;
  // With several, report one that is not a development channel, so it cannot soften a HOLD.
  const channels = flagValues(args, ["--branch", "--channel", "--deployment-name", "--deployment", "-d", "--track"]);
  const channel = channels.find((c) => !nonProductionChannel(c)) ?? channels[0];
  if (bin === "eas" && (a === "update" || a === "update:republish") && !androidOnly(args)) return { what: `eas ${a}`, channel };
  if ((bin === "expo" || bin === "expo-cli") && a === "publish") return { what: "expo publish", channel: flagValue(args, ["--release-channel"]) ?? channel };
  if (bin === "appcenter" && a === "codepush" && b && /^(release(-react|-cordova|-electron)?|promote)$/.test(b)) return { what: `appcenter codepush ${b}`, channel };
  if ((bin === "code-push" || bin === "code-push-standalone" || bin === "revopush") && a && /^(release(-react|-cordova|-electron)?|promote)$/.test(a)) return { what: `${bin} ${a}`, channel };
  if (bin === "shorebird" && a === "patch" && !androidOnly(args, b)) return { what: "shorebird patch", channel };
  if (bin === "hot-updater" && a === "deploy" && !androidOnly(args)) return { what: "hot-updater deploy", channel };
  return undefined;
}

/** A channel the command names that is clearly not the production one. */
export function nonProductionChannel(channel: string | undefined): boolean {
  return !!channel && NON_PRODUCTION.test(channel) && !PRODUCTION_WORD.test(channel);
}

function classifySegment(seg: string): Omit<Classified, "cwd"> {
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
    // The low-level create → add items → submit flow ends here.
    if (a === "review" && (b === "submissions-update" || (b === "submissions" && args[2] === "update")) && submittedTrue(args)) {
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

/** Longer than PATH_MAX on macOS (1024) and Linux (4096). */
export const MAX_CWD_CHARS = 4096;

const RANK: Record<CommandKind, number> = { none: 0, ota: 1, submit: 2, human_only: 3 };

/**
 * Classifies a Bash command line, following a leading `cd DIR` so the gate checks the right repo.
 * The text is read with and without its comments and the stronger result kept (see
 * stripShellComments).
 */
export function classifyCommand(cmdIn: string, cwdIn: string): Classified {
  const cmd = normalizeShell(cmdIn);
  const full = classifyLines(cmd, cwdIn);
  const bare = stripShellComments(cmd);
  if (bare === cmd) return full;
  const stripped = classifyLines(bare, cwdIn);
  return RANK[stripped.kind] > RANK[full.kind] ? stripped : full;
}

function classifyLines(cmd: string, cwdIn: string): Classified {
  let cwd = cwdIn;
  if (!MAYBE.test(cmd)) return { kind: "none", cwd };
  let found: Classified | undefined;
  for (const seg of segments(cmd)) {
    const tok = tokens(seg);
    if (tok[0] === "cd" && tok[1]) {
      const target = tok[1].replace(/^~(?=$|\/)/, process.env.HOME ?? "~");
      // No directory has a path longer than MAX_CWD_CHARS, so such a `cd` fails and the next
      // segment runs where it was. Checked before resolving, so `cd x; ` repeated thousands of
      // times stays linear.
      const grows = !path.isAbsolute(target) && !target.includes("..");
      const next = grows && cwd.length + target.length >= MAX_CWD_CHARS ? undefined : path.resolve(cwd, target);
      if (next !== undefined && next.length <= MAX_CWD_CHARS) cwd = next;
      continue;
    }
    const c = classifySegment(seg);
    if (c.kind === "human_only") return { ...c, cwd };
    // A submit outranks an OTA publish in the same command line.
    if (c.kind === "submit" && found?.kind !== "submit") found = { ...c, cwd };
    else if (c.kind === "ota" && !found) found = { ...c, cwd };
  }
  return found ?? { kind: "none", cwd };
}

/**
 * Nearest ancestor that looks like an app repo; falls back to `dir`. With `memo` (one per hook
 * call), every directory the walk passes is remembered, so a command with thousands of `cd`
 * segments looks at each directory once in all instead of walking the ancestors once per `cd`.
 */
export function findProjectRoot(dir: string, memo?: Map<string, string | null>): string {
  const start = path.resolve(dir);
  const passed: string[] = [];
  let cur = start;
  let found: string | null = null;
  for (;;) {
    const known = memo?.get(cur);
    if (known !== undefined) {
      found = known;
      break;
    }
    passed.push(cur);
    if (
      [".git", ".appstore-shield", "package.json", "Package.swift", "app.json"].some((m) => existsSync(path.join(cur, m))) ||
      safeList(cur).some((n) => n.endsWith(".xcodeproj") || n.endsWith(".xcworkspace"))
    ) {
      found = cur;
      break;
    }
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  // null: no marker anywhere above, which every directory passed shares.
  if (memo) for (const p of passed) memo.set(p, found);
  return found ?? start;
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function hookOutput(decision: "ask" | "deny", reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason },
  });
}

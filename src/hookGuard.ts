import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ascBoolFlag, ascPublishSubmits, classifyCommand, findProjectRoot, joinWords, MAX_CWD_CHARS, normalizeShell, otaPublish, stripShellComments, stripWrappers } from "./hook.js";

/**
 * Second line of defence for the PreToolUse hook. hook.ts classifies the common, well-formed
 * commands; these checks look at the raw text with quoting removed so that alternate spellings,
 * shell wrappers and direct ledger writes still reach a human. They stay regex-only (no heavy
 * imports) because the hook runs on every agent tool call.
 */

export interface GuardDecision {
  decision: "deny" | "ask";
  reason: string;
}

/**
 * Quotes and backslashes removed: `at''test`, `"ack"` and `\asc` all read as the bare word. The
 * body of a command substitution is its own segment (see exposeSubstitutions).
 */
export function flatten(cmd: string): string {
  return normalizeShell(cmd).replace(/['"\\]/g, "");
}

/** flatten with substitutions left in place: the ledger check counts a segment that has one as a writer. */
function flattenKeepingSubstitutions(cmd: string): string {
  return joinWords(cmd).replace(/['"\\]/g, "");
}

const WORD_SPLIT = /[\s;|&()<>=`$,{}]+/;

// Anything that can launch the CLI under another name: package runners, interpreters, xargs,
// eval, pty wrappers. A verb plus any of these is enough to stop and ask the human.
const RUNNER = /appstore-shield|cli\.m?js|\bdist\/cli\b|\b(node|npx|npm|pnpm|yarn|bunx|bun|deno|xargs|eval|script|expect|env|sh|bash|zsh)\b|\.m?js\b/;

/** attest/ack in any spelling that could reach the CLI. */
export function looseHumanOnly(cmd: string): "attest" | "ack" | undefined {
  const flat = flatten(cmd);
  // As the program itself, `ack` is the grep-like search tool, not our subcommand.
  const words = flat.split(/&&|\|\||[;|&\n]/).flatMap((seg) => seg.split(WORD_SPLIT).filter(Boolean).slice(1));
  const verb = words.includes("attest") ? "attest" : words.includes("ack") ? "ack" : undefined;
  return verb && RUNNER.test(flat) ? verb : undefined;
}

/**
 * Mirrors shieldHome() in ledger/store.ts without importing it (the hook stays light). The store
 * refuses a relative APPSTORE_SHIELD_HOME rather than resolving it against whatever cwd it runs
 * in, so no ledger can live there; the hook then guards the default home, where real ledgers are.
 */
export function shieldHomeDir(): string {
  const fallback = path.join(homedir(), ".appstore-shield");
  const env = process.env.APPSTORE_SHIELD_HOME?.trim();
  if (!env) return fallback;
  const expanded = env.replace(/^~(?=$|[/\\])/, homedir());
  return path.isAbsolute(expanded) ? path.resolve(expanded) : fallback;
}

const MAX_CONFIG_BYTES = 256 * 1024;

/** A regular file's text, or undefined: FIFOs and devices block or never end, and the hook must answer in time. */
export function readCapped(file: string, max: number): string | undefined {
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > max) return undefined;
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Filesystem lookups shared by one hook call's checks. Every lookup is remembered, so the work
 * grows with the number of distinct directories a command names, never with how often it names
 * them (`cd x; ` repeated thousands of times).
 */
interface FsMemo {
  roots: Map<string, string | null>;
  ledgers: Map<string, string | undefined>;
  real: Map<string, string>;
  gitRoots: Map<string, string | null>;
}

function newMemo(): FsMemo {
  return { roots: new Map(), ledgers: new Map(), real: new Map(), gitRoots: new Map() };
}

/** Configured ledgerPath for the repo around `dir`, resolved, if any. */
function configuredLedger(dir: string, memo: FsMemo = newMemo()): string | undefined {
  const root = findProjectRoot(dir, memo.roots);
  if (memo.ledgers.has(root)) return memo.ledgers.get(root);
  let ledger: string | undefined;
  try {
    // A FIFO planted here would block the hook past its timeout, and a timed-out hook lets the command run.
    const raw = readCapped(path.join(root, ".appstore-shield", "config.json"), MAX_CONFIG_BYTES);
    const cfg = raw === undefined ? undefined : (JSON.parse(raw) as { ledgerPath?: unknown });
    if (cfg && typeof cfg.ledgerPath === "string" && cfg.ledgerPath.trim()) ledger = path.resolve(root, cfg.ledgerPath.trim().replace(/^~(?=$|\/)/, homedir()));
  } catch {
    ledger = undefined;
  }
  memo.ledgers.set(root, ledger);
  return ledger;
}

/** The git work tree around `dir` (nearest ancestor with `.git`), if any. */
function gitRoot(dir: string, memo: FsMemo): string | undefined {
  const passed: string[] = [];
  let cur = dir;
  let found: string | null = null;
  for (;;) {
    const known = memo.gitRoots.get(cur);
    if (known !== undefined) {
      found = known;
      break;
    }
    passed.push(cur);
    if (existsSync(path.join(cur, ".git"))) {
      found = cur;
      break;
    }
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  for (const p of passed) memo.gitRoots.set(p, found);
  return found ?? undefined;
}

const LEDGER_DENY =
  "appstore-shield: the review ledger and the rest of the shield home (~/.appstore-shield, including its record of which ledgers each repo used) are written only by the shield tools and the developer's own `appstore-shield` commands. An agent must not write, edit, move or delete these files; read the ledger with shield_ledger_query and record events with shield_ledger_record or shield_ledger_import.";

// Programs that only read the files they name. The writers are an open-ended list (editors,
// deleters, downloaders, archivers, interpreters, `find -delete`, `git clean`), the readers are
// not, so a segment that names the ledger or the shield home with anything else is a write.
const READERS = new Set([
  "cat", "less", "more", "head", "tail", "grep", "egrep", "fgrep", "rg", "ag", "jq", "wc", "ls", "stat", "file", "du", "diff", "cmp",
  "shasum", "sha1sum", "sha256sum", "md5", "md5sum", "cksum", "realpath", "readlink", "basename", "dirname", "tree", "od", "hexdump",
  "strings", "nl", "cut", "column", "echo", "printf", "test", "[", "[[", "true", ":",
]);
const FIND_WRITE_ACTIONS = new Set(["-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);
const FIND_EXEC_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/** `find` that deletes or writes files: -delete, -fprint…, or -exec of anything but a reader (`-exec cat {} ;` only reads). */
function findWrites(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (FIND_WRITE_ACTIONS.has(a)) return true;
    if (FIND_EXEC_ACTIONS.has(a)) {
      const cmd = stripWrappers(args.slice(i + 1, i + 65), false)[0];
      if (cmd === undefined || !READERS.has(base(cmd))) return true;
    }
  }
  return false;
}
// `add` and `commit` record a configured in-repo ledger without changing the file.
const GIT_READS = new Set(["log", "diff", "show", "status", "blame", "ls-files", "grep", "add", "commit"]);
const DECLARERS = new Set(["export", "declare", "typeset", "local", "readonly"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Whether a segment only reads what it names, writes, or only stores values for a later segment. */
function segmentKind(seg: string[]): "read" | "write" | "assign" {
  const text = seg.join(" ");
  // Command and process substitution run programs this check does not look at.
  if (text.includes("$(") || text.includes("`") || text.includes("<(") || text.includes(">(")) return "write";
  // Output redirection writes, except to /dev/null or another descriptor.
  if (text.replace(/>>?[ \t]*\/dev\/null/g, "").includes(">")) return "write";
  // Not descending into `find -exec` or `xargs`: their own actions decide below.
  const run = stripWrappers(seg, false);
  const prog = run[0];
  if (prog === undefined || DECLARERS.has(prog)) return "assign";
  const name = base(prog);
  const args = run.slice(1);
  if (name === "find") return findWrites(args) ? "write" : "read";
  if (name === "git") {
    let j = 0;
    while (j < args.length && args[j]!.startsWith("-")) j += args[j] === "-C" || args[j] === "-c" ? 2 : 1;
    return GIT_READS.has(args[j] ?? "") ? "read" : "write";
  }
  return READERS.has(name) ? "read" : "write";
}

/**
 * macOS (APFS, HFS+) and Windows volumes are case-insensitive by default: `~/.APPSTORE-SHIELD`
 * is the shield home there, so paths and path text are compared case-folded.
 */
const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";
const fold = (p: string) => (CASE_INSENSITIVE_FS ? p.toLowerCase() : p);
const FS_FLAGS = CASE_INSENSITIVE_FS ? "i" : "";

const LEDGER_TEXT = new RegExp(/\.appstore-shield\/teams\b|events\.jsonl|APPSTORE_SHIELD_HOME|~\/\.appstore-shield|\$\{?HOME\}?\/\.appstore-shield/.source, FS_FLAGS);
const SETTINGS_TEXT = new RegExp(/\.appstore-shield\b/.source, FS_FLAGS);
const SETTINGS_DIR = new RegExp(/\/\.appstore-shield(\/|$)/.source, FS_FLAGS);

/**
 * Bash commands that write to the ledger, the shield home, or repo shield settings. Each
 * control-operator segment that names one of them, by text or by a path that resolves into it
 * (after any `cd`, through symlinks), or that runs inside one, is denied unless it only reads
 * (see READERS). A ledger path stored in a variable is denied when any segment writes.
 */
export function bashLedgerWrite(cmd: string, cwd: string): GuardDecision | undefined {
  const flat = flattenKeepingSubstitutions(cmd);
  const home = shieldHomeDir();
  const memo = newMemo();
  const custom = configuredLedger(cwd, memo);
  const touch = ledgerTouch(flat, cwd, home, custom, memo);
  if (touch === "deny") return { decision: "deny", reason: LEDGER_DENY };
  if (touch === "wipe") {
    return {
      decision: "ask",
      reason:
        "appstore-shield: this git command can delete or revert this repo's review ledger (its configured ledgerPath is inside the repo): `git clean` deletes it while it is untracked, and `git stash`, `git reset --hard`, `git checkout`/`git restore` of a path that holds it drop the events recorded since the last commit, such as a freshly imported rejection. The gate would then read a shorter history. Commit the ledger first, or confirm this command.",
    };
  }
  if (touch === "ask") {
    return {
      decision: "ask",
      reason:
        "appstore-shield: this command writes inside .appstore-shield/ (config, baseline suppressions or probe results). Those record the developer's own decisions and test results; confirm you want this change.",
    };
  }
  return undefined;
}

function under(file: string, dir: string): boolean {
  const rel = path.relative(fold(dir), fold(file));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// ---------- globs and brace expansion in paths ----------

/** Words longer than any path, and globs past this many per command, are not expanded. */
const MAX_GLOB_WORD = 1024;
const MAX_GLOB_WORDS = 256;
const MAX_BRACE_VARIANTS = 32;

export function hasGlob(w: string): boolean {
  return /[*?[]/.test(w) || (w.includes("{") && w.includes("}"));
}

/** The first `{…}` group bash expands (a top-level `,` or `..` inside, not `${…}`), found in one pass. */
function braceGroup(w: string): { start: number; end: number; alts?: string[] } | undefined {
  const stack: number[] = [];
  const commas = new Map<number, number[]>();
  const seq = new Set<number>();
  let best: { start: number; end: number } | undefined;
  for (let i = 0; i < w.length; i++) {
    const c = w[i];
    if (c === "{" && w[i - 1] !== "$") stack.push(i);
    else if (c === "}" && stack.length) {
      const start = stack.pop()!;
      if ((commas.has(start) || seq.has(start)) && (!best || start < best.start)) best = { start, end: i };
    } else if (c === "," && stack.length) {
      const top = stack[stack.length - 1]!;
      const list = commas.get(top) ?? [];
      list.push(i);
      commas.set(top, list);
    } else if (c === "." && w[i + 1] === "." && stack.length) seq.add(stack[stack.length - 1]!);
  }
  if (!best) return undefined;
  const cuts = commas.get(best.start);
  if (!cuts) return best;
  const alts: string[] = [];
  let from = best.start + 1;
  for (const k of cuts) {
    alts.push(w.slice(from, k));
    from = k + 1;
  }
  alts.push(w.slice(from, best.end));
  return { ...best, alts };
}

/**
 * Bash brace expansion, bounded: `~/.{appstore-shield,cache}` → both paths. A sequence
 * (`{1..9}`) reads as `*`; past MAX_BRACE_VARIANTS the whole braced span reads as `*`, which can
 * only match more.
 */
export function expandBraces(w: string): string[] {
  const out: string[] = [];
  const queue = [w];
  while (queue.length) {
    if (out.length + queue.length > MAX_BRACE_VARIANTS) {
      const a = w.indexOf("{");
      const b = w.lastIndexOf("}");
      return [`${w.slice(0, a)}*${w.slice(b + 1)}`];
    }
    const cur = queue.shift()!;
    const g = braceGroup(cur);
    if (!g) out.push(cur);
    else for (const alt of g.alts ?? ["*"]) queue.push(cur.slice(0, g.start) + alt + cur.slice(g.end + 1));
  }
  return out;
}

/** A `[…]` class at `p`: where it ends and whether `ch` is in it; undefined when unclosed (a literal `[`). */
function globClass(pat: string, p: number, ch: string): { end: number; hit: boolean } | undefined {
  let i = p + 1;
  const negate = pat[i] === "!" || pat[i] === "^";
  if (negate) i++;
  let hit = false;
  let first = true;
  for (; i < pat.length; i++) {
    const c = pat[i]!;
    if (c === "]" && !first) return { end: i + 1, hit: hit !== negate };
    first = false;
    if (pat[i + 1] === "-" && pat[i + 2] !== undefined && pat[i + 2] !== "]") {
      if (ch >= c && ch <= pat[i + 2]!) hit = true;
      i += 2;
    } else if (c === ch) hit = true;
  }
  return undefined;
}

/**
 * fnmatch for one name: `*`, `?` and `[…]`. Iterative, with one remembered `*`, so it never
 * backtracks more than once per character of the name. `*` matches `/` too; callers split paths.
 */
export function globMatch(pat: string, name: string): boolean {
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
      const cls = globClass(pat, p, name[n]!);
      if (cls ? cls.hit : name[n] === "[") step = cls ? cls.end - p : 1;
    } else if (c !== undefined && c === name[n]) step = 1;
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

const comps = (abs: string) => fold(abs).split(/[\\/]+/).filter(Boolean);

/**
 * Whether the glob path `pat` (absolute) names `target` or something inside it, or an ancestor of
 * it that `stop` does not rule out (deleting `compl*` deletes the ledger in `compliance/`). A
 * leading `.` must be matched literally, as bash does without dotglob, so `rm -rf ~/*` does not
 * reach `~/.appstore-shield`; `**` matches anything below.
 */
function globReaches(pat: string, target: string, stop: (ancestor: string) => boolean): boolean {
  const pc = comps(pat);
  const tc = comps(target);
  for (let i = 0; i < pc.length; i++) {
    const p = pc[i]!;
    if (p === "**") return true;
    // Past the target's own components the pattern names something inside it.
    if (i >= tc.length) return true;
    const t = tc[i]!;
    if (t.startsWith(".") && !p.startsWith(".")) return false;
    if (!globMatch(p, t)) return false;
  }
  return pc.length >= tc.length || !stop(path.join(path.parse(target).root, ...target.split(/[\\/]+/).filter(Boolean).slice(0, pc.length)));
}

// What the shield home and .appstore-shield hold, with their depth below it: the names a find
// pattern could reach there.
const SHIELD_HOME_NAMES: [string, number][] = [["teams", 1], ["repos", 1], ["repos.json", 1], ["events.jsonl", 3]];
const SETTINGS_NAMES: [string, number][] = [["config.json", 1], ["baseline.json", 1], ["probes", 1]];

/** Words whose symlinks are resolved (a syscall each); the rest are still compared as written. */
const MAX_PATH_WORDS = 512;

/**
 * The per-segment walk behind bashLedgerWrite. `echo … >> compliance/ledger.jsonl` and `cd
 * compliance && sed -i … ledger.jsonl` name the ledger without its absolute path; `rm -rf
 * compliance` removes the folder that holds it.
 */
function ledgerTouch(flat: string, cwdIn: string, home: string, custom: string | undefined, memo: FsMemo): "deny" | "ask" | "wipe" | undefined {
  const real = (f: string) => realish(f, memo.real);
  const homes = [home, real(home)];
  const ledgers = new Set<string>();
  const addLedger = (l: string | undefined) => {
    if (l && ledgers.size < 8) {
      ledgers.add(l);
      ledgers.add(real(l));
    }
  };
  addLedger(custom);
  const root = findProjectRoot(cwdIn, memo.roots);
  // Both spellings: a word's resolved form (/private/var/…) is compared with the root as given (/var/…).
  const broad = [root, real(root), homedir(), real(homedir())];
  let wipe = false;
  const textHit = (t: string) => fold(t).includes(fold(home)) || (!!custom && fold(t).includes(fold(custom))) || LEDGER_TEXT.test(t);
  let cwd = cwdIn;
  let unknownCwd = false;
  let n = 0;
  let stored = false;
  let writes = false;
  let settings = false;
  let globWords = 0;
  // An ancestor that is the repo root, the home directory or above them is rarely about the ledger.
  const stop = (ancestor: string) => broad.some((b) => under(b, ancestor));
  const settingsDirs = (): string[] => {
    const r = findProjectRoot(cwd, memo.roots);
    return [...new Set([root, real(root), r, real(r)])].map((d) => path.join(d, ".appstore-shield"));
  };
  /** Globs and braces bash expands to the ledger, the shield home or .appstore-shield (`rm compliance/*.jsonl`, `rm -rf ~/.appstore-*`). */
  const globHit = (seg: string[]): "deny" | "ask" | undefined => {
    let found: "ask" | undefined;
    for (const word of seg) {
      for (const piece of word.split(/[=<>]+/)) {
        if (!piece || piece.startsWith("-") || piece.includes("://") || piece.length > MAX_GLOB_WORD || !hasGlob(piece)) continue;
        if (++globWords > MAX_GLOB_WORDS) return found;
        for (const variant of expandBraces(piece)) {
          const abs = expandPath(variant, cwd);
          const parts = abs.split("/");
          const k = parts.findIndex(hasGlob);
          // Symlinks in the literal part are resolved; the rest is matched as written.
          const forms = k > 1 ? [abs, path.join(real(parts.slice(0, k).join("/")), ...parts.slice(k))] : [abs];
          for (const f of forms) {
            if (homes.some((h) => globReaches(f, h, stop)) || [...ledgers].some((l) => globReaches(f, l, stop))) return "deny";
            if (unknownCwd && [...ledgers].some((l) => globMatch(fold(path.basename(variant)), fold(path.basename(l))))) return "deny";
            if (settingsDirs().some((d) => globReaches(f, d, stop))) found = "ask";
          }
        }
      }
    }
    return found;
  };
  /**
   * `find START … -delete` (or -exec of a writer): whether a file it would reach below START is
   * the ledger, part of the shield home or .appstore-shield, judged by -name/-path/-maxdepth.
   * A test it cannot judge (-regex, `!`) counts as matching.
   */
  const findHit = (args: string[]): "deny" | "ask" | undefined => {
    let i = 0;
    while (i < args.length && /^-([HLP]|O\d|D)$/.test(args[i]!)) i += args[i] === "-D" ? 2 : 1;
    const starts: string[] = [];
    while (i < args.length && !args[i]!.startsWith("-") && args[i] !== "!" && args[i] !== "(") starts.push(args[i++]!);
    if (!starts.length) starts.push(".");
    const names: string[] = [];
    const paths: string[] = [];
    let unknown = false;
    let maxdepth = Infinity;
    for (; i < args.length; i++) {
      const a = args[i]!;
      if (a === "-name" || a === "-iname") names.push(fold(args[++i] ?? ""));
      else if (a === "-path" || a === "-ipath" || a === "-wholename" || a === "-iwholename") paths.push(fold(args[++i] ?? ""));
      else if (a === "-regex" || a === "-iregex" || a === "!" || a === "-not" || a === "-lname" || a === "-ilname") unknown = true;
      else if (a === "-maxdepth") maxdepth = Number(args[++i]) >= 0 ? Number(args[i]) : Infinity;
      else if (FIND_EXEC_ACTIONS.has(a)) break;
    }
    const filtered = names.length > 0 || paths.length > 0;
    const targets: { dir: string; inner: [string, number][]; verdict: "deny" | "ask" }[] = [
      ...homes.map((dir) => ({ dir, inner: SHIELD_HOME_NAMES, verdict: "deny" as const })),
      ...[...ledgers].map((dir) => ({ dir, inner: [] as [string, number][], verdict: "deny" as const })),
      ...settingsDirs().map((dir) => ({ dir, inner: SETTINGS_NAMES, verdict: "ask" as const })),
    ];
    let found: "ask" | undefined;
    for (const start of starts) {
      const s0 = expandPath(start, cwd);
      for (const sf of [s0, real(s0)]) {
        for (const t of targets) {
          let hit = under(sf, t.dir);
          if (!hit && under(t.dir, sf)) {
            const rel = path.relative(fold(sf), fold(t.dir)).split(/[\\/]+/).filter(Boolean);
            const entries: [string, number, string][] = rel.map((name, k) => [name, k + 1, [start, ...rel.slice(0, k + 1)].join("/")]);
            for (const [name, d] of t.inner) entries.push([name, rel.length + d, [start, ...rel, name].join("/")]);
            hit = entries.some(([name, depth, p]) => depth <= maxdepth && (unknown || !filtered || names.some((n) => globMatch(n, name)) || paths.some((n) => globMatch(n, fold(p)))));
          }
          if (hit && t.verdict === "deny") return "deny";
          if (hit) found = "ask";
        }
      }
    }
    return found;
  };
  const wordHits = (seg: string[]): boolean => {
    for (const word of seg) {
      for (const piece of word.split(/[=<>]+/)) {
        if (!piece || piece.startsWith("-") || piece.includes("://")) continue;
        const named = expandPath(piece, cwd);
        const forms = ++n > MAX_PATH_WORDS ? [named] : [named, real(named)];
        for (const f of forms) {
          if (homes.some((h) => under(f, h))) return true;
          for (const l of ledgers) {
            if (under(f, l)) return true;
            // A folder that holds the ledger: deleting or moving it removes the ledger too. The
            // repo root and the home directory are left out, since naming them is rarely about it.
            if (under(l, f) && !broad.some((b) => under(b, f))) return true;
            // `cd "$DIR" && … >> ledger.jsonl`: where it lands is unknown, so its name decides.
            if (unknownCwd && fold(path.basename(f)) === fold(path.basename(l))) return true;
          }
        }
      }
    }
    return false;
  };
  // `>&2` and `2<&-` duplicate descriptors and write no file; dropped before `&` splits segments.
  for (const seg of wordSegments(flat.replace(/[<>]&[0-9-]+/g, " "))) {
    if (seg[0] === "cd" || seg[0] === "pushd") {
      const t = seg[1];
      const before = cwd;
      if (!t) cwd = homedir();
      else if (/[$`]/.test(t.replace(/^(\$HOME|\$\{HOME\}|\$PWD|\$\{PWD\})(?=$|\/)/, ""))) unknownCwd = true;
      else if (!t.startsWith("-")) {
        // No directory has a path this long, so `cd` fails there; it also keeps each resolve
        // bounded, so `cd x; ` repeated thousands of times stays linear.
        const grows = !path.isAbsolute(t) && !/^(~|\$HOME|\$\{HOME\}|\$PWD|\$\{PWD\})(?=$|\/)/.test(t) && !t.includes("..");
        const next = grows && cwd.length + t.length >= MAX_CWD_CHARS ? undefined : expandPath(t, cwd);
        if (next === undefined || next.length > MAX_CWD_CHARS) unknownCwd = true;
        else cwd = next;
      }
      // Memoised: each new directory costs one lookup, however many `cd`s lead there.
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
      // find's own -name/-path patterns are matched by findHit, not expanded as paths.
      const pattern = base(run[0] ?? "") === "find" ? findHit(run.slice(1)) : globHit(seg);
      if (pattern === "deny") return "deny";
      if (pattern === "ask") settings = true;
    }
    if (kind === "write" && (SETTINGS_TEXT.test(seg.join(" ")) || SETTINGS_DIR.test(cwd))) settings = true;
  }
  if (stored && writes) return "deny";
  if (wipe) return "wipe";
  return settings ? "ask" : undefined;
}

const STASH_VERBS = new Set(["list", "show", "drop", "pop", "apply", "branch", "clear", "create", "store", "push", "save"]);

/** Global git options that take a value; `-C DIR` also moves where git runs. */
const GIT_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);

/**
 * Repo-wide git commands that delete or revert files without naming them: `git clean` (deletes
 * untracked files under where it runs or under its paths), `git stash` (push/save; reverts every
 * change, and with -u removes untracked files), `git reset --hard|--merge|--keep`, and `git
 * checkout`/`git restore` of a path that holds the ledger (`.`, `:/`, the repo root). A configured
 * ledger inside the repo is erased or reverted by them, so the gate would read a shorter history.
 * Paths that name the ledger's own folder are already writes (wordHits); these name no such path.
 */
function gitWipesLedger(seg: string[], cwdIn: string, ledgers: Set<string>, memo: FsMemo): boolean {
  const run = stripWrappers(seg, false);
  if (base(run[0] ?? "") !== "git") return false;
  seg = run;
  let cwd = cwdIn;
  let i = 1;
  while (i < seg.length && seg[i]!.startsWith("-")) {
    const opt = seg[i]!;
    if (opt === "-C" && seg[i + 1]) cwd = expandPath(seg[i + 1]!, cwd);
    i += GIT_VALUE_OPTS.has(opt) ? 2 : 1;
  }
  const sub = seg[i];
  const args = seg.slice(i + 1);
  const repo = gitRoot(cwd, memo);
  if (!repo) return false;
  const inRepo = [...ledgers].filter((l) => under(l, repo));
  if (!inRepo.length) return false;
  const paths = args.filter((a) => a !== "--" && !a.startsWith("-")).map((a) => (a === ":/" || a.startsWith(":/") ? path.join(repo, a.slice(2)) : expandPath(a, cwd)));
  const covers = (dirs: string[]) => dirs.some((d) => inRepo.some((l) => under(l, d)));
  switch (sub) {
    case "clean":
      if (args.some((a) => a === "-n" || a === "--dry-run" || /^-[a-z]*n[a-z]*$/.test(a))) return false;
      return paths.length ? covers(paths) : covers([cwd]);
    case "stash": {
      // `git stash -m msg` and `git stash -u` are pushes too; the other subcommands leave the working tree alone.
      const verb = args.find((a) => STASH_VERBS.has(a));
      return verb === undefined || verb === "push" || verb === "save";
    }
    case "reset":
      return args.some((a) => a === "--hard" || a === "--merge" || a === "--keep");
    case "switch":
      return args.some((a) => a === "-f" || a === "--force" || a === "--discard-changes");
    case "checkout":
    case "restore": {
      // Only unstages; the working tree keeps the ledger as it is.
      if (sub === "restore" && args.some((a) => a === "--staged" || a === "-S") && !args.some((a) => a === "--worktree" || a === "-W")) return false;
      // `git checkout BRANCH` switches branches and refuses to overwrite local changes; only a
      // pathspec (after `--`, or a path that exists) restores files over them.
      const dash = args.indexOf("--");
      const specs = dash !== -1 ? paths.slice(args.slice(0, dash).filter((a) => !a.startsWith("-")).length) : sub === "restore" ? paths : paths.filter((p) => existsSync(p));
      return covers(specs) || (args.some((a) => a === "-f" || a === "--force") && covers([repo]));
    }
    default:
      return false;
  }
}

/**
 * `file` with symlinks in its nearest existing ancestor resolved: path.resolve keeps a link
 * (`/tmp/l` → the shield home) as written, so the ledger would not be recognised behind it.
 */
function realish(file: string, memo?: Map<string, string>): string {
  const rest: string[] = [];
  const passed: string[] = [];
  let dir = file;
  for (let i = 0; i < 256; i++) {
    let r = memo?.get(dir);
    if (r === undefined) {
      try {
        // .native returns each existing component's on-disk case (`~/.APPSTORE-SHIELD` → the home).
        r = realpathSync.native(dir);
      } catch {
        const up = path.dirname(dir);
        if (up === dir) return file;
        passed.push(dir);
        rest.push(path.basename(dir));
        dir = up;
        continue;
      }
    }
    // Remember the directories that did not exist too, so the next word below them is one lookup.
    if (memo) {
      memo.set(dir, r);
      for (let k = 0; k < passed.length; k++) memo.set(passed[k]!, path.join(r, ...rest.slice(k).reverse()));
    }
    return path.join(r, ...rest.reverse());
  }
  return file;
}

function underAny(files: string[], dirs: string[]): boolean {
  return files.some((f) => dirs.some((d) => under(f, d)));
}

/** Write/Edit/MultiEdit/NotebookEdit on ledger files, the shield home, probe results, config or baseline. */
export function fileToolDecision(filePath: string, cwd: string): GuardDecision | undefined {
  const resolved = path.resolve(cwd, filePath);
  const files = [resolved, realish(resolved)];
  const file = files[1]!;
  const home = shieldHomeDir();
  const custom = configuredLedger(path.dirname(resolved)) ?? configuredLedger(cwd);
  // All of the shield home, not only teams/: repos/ there remembers which ledgers this repo
  // used, and emptying it would hide rejections carried over from an earlier ledger.
  const guarded = [home, realish(home), ...(custom ? [custom, realish(custom)] : [])];
  const folded = files.map(fold);
  if (underAny(files, guarded) || folded.some((f) => f.includes("/.appstore-shield/") && f.endsWith(".jsonl") && f.includes("/teams/"))) {
    return { decision: "deny", reason: LEDGER_DENY };
  }
  if (folded.some((f) => f.includes("/.appstore-shield/probes/")) && /result/i.test(path.basename(file))) {
    return {
      decision: "deny",
      reason:
        "appstore-shield: probe results must come from running the probe runner against the developer's backend, not from an edited file. Ask the developer to run the suite.",
    };
  }
  if (folded.some((f) => f.endsWith("/.appstore-shield/baseline.json"))) {
    return { decision: "ask", reason: "appstore-shield: baseline.json holds the developer's own suppressions, each with a justification. Confirm this change yourself." };
  }
  // Creating it counts too: a new config.json with another teamId points the gate at an empty history.
  if (folded.some((f) => f.endsWith("/.appstore-shield/config.json"))) {
    return { decision: "ask", reason: "appstore-shield: config.json chooses the Team ID and ledger location; creating or changing it can point the gate at a different history. Confirm this change yourself." };
  }
  return undefined;
}

/**
 * The hook has to answer inside its 30 s timeout whatever text the agent sends, because Claude
 * Code runs the command when a hook times out. So everything below is a token scan, indexOf or a
 * regex that cannot backtrack, and a command longer than this is not parsed at all: the hook asks.
 */
export const MAX_HOOK_COMMAND = 64 * 1024;

// Shell syntax around a word: `(asc`, `{ asc`, `!asc`, `submit)`. A bracket the word itself
// closes or opens stays (`~/.{appstore-shield,cache}`, `${HOME}`, `{}`), so brace expansion and
// variables still read whole.
function trimPunct(t: string): string {
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
  for (;;) {
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
  for (;;) {
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

/** Control-operator segments of flattened text, each as words with shell punctuation trimmed. */
export function wordSegments(flat: string): string[][] {
  return flat.split(/&&|\|\||[;|&\n]/).map((seg) => seg.split(/\s+/).map(trimPunct).filter(Boolean));
}

function base(t: string): string {
  const i = t.lastIndexOf("/");
  return i === -1 ? t : t.slice(i + 1);
}

/** `CMD=asc` → `asc`: a value stored for later still names the program it runs. */
function unassign(t: string): string {
  const m = /^[A-Za-z_][A-Za-z0-9_]*=/.exec(t);
  return m ? t.slice(m[0].length) : t;
}

const KEYWORDS = new Set(["then", "do", "else", "elif", "if", "while", "until", "time"]);

function firstProgram(words: string[]): string {
  return base(words.find((w) => !KEYWORDS.has(w)) ?? "");
}

const dynamic = (w: string) => w.startsWith("$") || w.startsWith("`");

// Programs whose arguments are text, so a submit phrase in them is not a submission.
const TEXT_PROGRAMS = new Set(["git", "echo", "printf", "print", "puts", "console.log", "grep", "rg", "ag", "cat", "less", "head", "tail", "gh", "jq", "man", "which", "type", "wc", "diff", "ls"]);

/** `submit_for_review: true`, `--submit-for-review`, `submit_for_review(true)` and similar. */
function submitForReviewTrue(words: string[]): boolean {
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!.toLowerCase();
    let k = w.indexOf("submit_for_review");
    if (k === -1) k = w.indexOf("submit-for-review");
    if (k === -1) continue;
    const tail = `${w.slice(k + 17)} ${words.slice(i + 1, i + 3).join(" ")}`.slice(0, 80).replace(/^[\s:=>(]+/, "");
    if (/^(true|yes|1)\b/i.test(tail)) return true;
    const bareFlag = w.startsWith("-") && w.length === k + 17;
    if (bareFlag && (i + 1 >= words.length || words[i + 1]!.startsWith("-"))) return true;
  }
  return false;
}

const ASC_API_WRITE = /\bsubmitted\b|(^|\s)(-x\s*(post|patch)|--request[\s=]+(post|patch)|-d|--data\S*|--json)(\s|$)|\.(patch|post)\(/i;

/** A direct App Store Connect API call that submits a version (curl, python, node one-liners). */
function ascApiSubmit(text: string): boolean {
  return text.includes("appstoreconnect.apple.com") && /reviewsubmission|appstoreversionsubmission/i.test(text) && ASC_API_WRITE.test(text);
}

const INLINE_INTERPRETERS = new Set(["python", "python3", "node", "ruby", "perl", "deno", "bun"]);

/** `submissions-update … --submitted=true` (or `submissions update`): asc's low-level submit. */
function submissionsUpdateSubmits(rest: string[]): boolean {
  const u = rest.findIndex((w, i) => w === "submissions-update" || (w === "submissions" && rest[i + 1] === "update"));
  return u !== -1 && ascBoolFlag(rest.slice(u + 1), "submitted") === true;
}

const OTA_TOOL = /\b(eas|expo|appcenter|code-push|revopush|shorebird|hot-updater)/;
// Shell-string runners and package managers a publish can sit behind once stripWrappers has
// dropped the wrappers (`bash -c 'eas update'` reads as words here, `yarn eas update` runs the bin).
const OTA_LEAD = new Set(["yarn", "pnpm", "bash", "sh", "zsh", "eval", "-c", "-lc"]);

/**
 * Over-the-air publishes in wrapped forms (`bash -c 'eas update'`, `npx eas-cli update`, a
 * subshell): hook.ts finds the plain ones. Returns the publish and the channel it names.
 */
export function looseOta(cmd: string): { what: string; channel?: string } | undefined {
  // Read with and without comments: `-p android` in a comment must not make it Android-only.
  const full = looseOtaText(cmd);
  if (full) return full;
  const bare = stripShellComments(normalizeShell(cmd));
  return bare === normalizeShell(cmd) ? undefined : looseOtaText(bare);
}

function looseOtaText(cmd: string): { what: string; channel?: string } | undefined {
  const flat = flatten(cmd);
  // Most commands name no OTA tool; skip the word split for them.
  if (!OTA_TOOL.test(flat)) return undefined;
  for (const seg of wordSegments(flat)) {
    const words = stripWrappers(seg);
    if (!words.length || TEXT_PROGRAMS.has(firstProgram(words))) continue;
    for (let i = 0; i < words.length && i < 16; i++) {
      const w = base(unassign(words[i]!));
      // After `bash -c` the code may start with a wrapper of its own (`bash -c 'timeout 60 eas update'`).
      const run = i === 0 ? words : stripWrappers([w, ...words.slice(i + 1)]);
      const hit = otaPublish([base(unassign(run[0] ?? "")), ...run.slice(1)]);
      if (hit) return hit;
      if (!OTA_LEAD.has(w) && !ASSIGNMENT.test(words[i]!) && !w.startsWith("-")) break;
    }
  }
  return undefined;
}

/**
 * Submit-for-review phrases anywhere in the command, after hook.ts found none. Catches wrappers
 * (`bash -c`, `eval`, subshells, `&`, `if … then`), global flags before the subcommand, programs
 * and subcommands taken from shell variables, and direct App Store Connect API calls.
 */
export function looseSubmit(cmd: string): string | undefined {
  // A comment can cancel nothing (`… --submit # --dry-run`) and hide nothing.
  const full = looseSubmitText(cmd);
  if (full) return full;
  const bare = stripShellComments(normalizeShell(cmd));
  return bare === normalizeShell(cmd) ? undefined : looseSubmitText(bare);
}

const XARGS_TOOLS = new Set(["asc", "fastlane"]);

function looseSubmitText(cmd: string): string | undefined {
  const flat = flatten(cmd);
  const segs = wordSegments(flat).filter((w) => w.length && !TEXT_PROGRAMS.has(firstProgram(w)));
  const allWords = new Set(segs.flatMap((w) => w.map(unassign)));
  const submitWord = ["submit", "submissions-submit", "--submit", "-submit"].some((w) => allWords.has(w)) || [...allWords].some((w) => /^--?submit=/.test(w));
  for (const words of segs) {
    // `printf 'review submit' | xargs asc`: the subcommand arrives on stdin, unseen.
    const xa = words.findIndex((w) => base(w) === "xargs");
    if (xa !== -1) {
      const t = words.findIndex((w, i) => i > xa && XARGS_TOOLS.has(base(w)));
      const sub = t === -1 ? undefined : words.slice(t + 1).find((w) => !w.startsWith("-"));
      if (t !== -1 && (sub === undefined || sub === "review" || sub === "publish" || dynamic(sub))) return `${base(words[t]!)} run through xargs, with its arguments taken from input`;
    }
    const at = words.findIndex((w) => base(unassign(w)) === "asc");
    if (at !== -1) {
      const rest = words.slice(at + 1);
      const r = rest.indexOf("review");
      // `asc testflight review submit` sends a build to TestFlight beta review, not App Review.
      const beta = r !== -1 && rest.slice(0, r).includes("testflight");
      if (r !== -1 && !beta && rest.slice(r + 1).some((w) => w === "submit" || w === "submissions-submit")) return "asc review submit";
      if (r !== -1 && !beta && submissionsUpdateSubmits(rest.slice(r + 1))) return "asc review submissions-update --submitted=true";
      const p = rest.indexOf("publish");
      if (p !== -1 && ascPublishSubmits(rest.slice(p + 1))) return "asc publish --submit";
      if (rest.some(dynamic) && submitWord) return "asc with a subcommand from a shell variable";
    }
    const prog = words.find((w) => !KEYWORDS.has(w) && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) ?? "";
    if (dynamic(prog) && ((words.includes("review") && words.some((w) => w === "submit" || w === "submissions-submit")) || (submitWord && (allWords.has("asc") || allWords.has("fastlane"))))) {
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
  // `python3 -c "…; requests.patch(url, …)"` splits at its own semicolons; look at the whole text.
  if (segs.some((w) => INLINE_INTERPRETERS.has(firstProgram(w))) && ascApiSubmit(flat)) return "App Store Connect API review submission";
  return undefined;
}

const VERBS = new Set(["attest", "ack"]);
// Tokens that are this CLI under its own names (npx appstore-shield@x, dist/cli.js, a copy *.mjs).
const NAMED_LAUNCHER = /(?:^|\/)(?:appstore-shield(?:@\S*)?|cli\.[cm]?js|dist\/cli)$/;
const INTERPRETERS = new Set(["node", "nodejs", "bun", "deno", "tsx", "ts-node"]);
// Programs whose arguments are text or paths: a launcher name or verb in them runs nothing.
const NON_RUNNING = new Set(["git", "echo", "printf", "grep", "egrep", "rg", "ag", "ack", "cat", "less", "head", "tail", "gh", "jq", "man", "which", "type", "wc", "diff", "ls", "find", "sed", "awk", "cp", "mv", "rm", "touch", "mkdir", "chmod", "ln", "tee", "file", "stat", "code"]);

/**
 * attest/ack run through this CLI. The verb has to be the CLI's first argument (that is how
 * main() reads it), so a word elsewhere in an unrelated command (`rg -n ack src && npm test`)
 * is not a run. Forms whose verb is computed at run time are caught when the command also
 * names the verb, and shell-string wrappers that mention it ask instead of deny.
 */
export function humanOnlyRun(cmd: string): { verb: string; decision: "deny" | "ask" } | undefined {
  const flat = flatten(cmd);
  const segs = wordSegments(flat);
  const mentioned = flat.split(/[\s;|&()<>=`$,{}]+/).find((t) => VERBS.has(t));
  for (const seg of segs) {
    // `timeout 60 appstore-shield ack`, `find . -exec appstore-shield ack \;`: the wrapped program counts.
    const tok = stripWrappers(seg);
    if (NON_RUNNING.has(base(tok[0] ?? ""))) continue;
    for (let i = 0; i < tok.length; i++) {
      const t = tok[i]!;
      const named = NAMED_LAUNCHER.test(t);
      const prev = i > 0 ? base(tok[i - 1]!) : "";
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
    const wrapper = prog === "eval" || (/^(ba|z|da|k)?sh$/.test(prog) && tok.some((t) => /^-[a-z]*c[a-z]*$/.test(t)));
    const verb = wrapper ? tok.find((t) => VERBS.has(t)) : undefined;
    if (verb) return { verb, decision: "ask" };
  }
  return undefined;
}

const CLI_MENTION = /appstore-shield|(?:^|[\s/])cli\.[cm]?js\b|\bdist\/cli\b/;

// Ways to start a process that no longer descends from the agent, has no terminal, or has a
// terminal a program types into. The CLI's human check looks for exactly those signs.
const DETACHERS = new Set(["setsid", "nohup", "disown", "daemonize", "launchctl", "at", "batch", "expect", "unbuffer", "script", "tmux", "screen", "osascript", "open", "systemd-run", "su", "sudo"]);

/** A lone `&` (background), not `&&`, `>&`, `<&`, `&>` or `|&`. */
function backgrounds(flat: string): boolean {
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

export interface Detached {
  wrapper: string;
  /** the CLI subcommand, when the command names one */
  verb?: string;
  commit: boolean;
}

/**
 * The CLI run through `env -i`, `setsid`, `nohup`, a backgrounded subshell or a pty/scheduler
 * wrapper. An agent has no reason to detach this CLI, and doing so is how its human check is
 * dodged, so the hook stops these before they run.
 */
export function detachedCliRun(cmd: string): Detached | undefined {
  const flat = flatten(cmd);
  if (!CLI_MENTION.test(flat)) return undefined;
  let wrapper: string | undefined;
  let verb: string | undefined;
  for (const words of wordSegments(flat)) {
    if (NON_RUNNING.has(firstProgram(words))) continue;
    const cli = words.findIndex((w) => CLI_MENTION.test(w));
    const upto = cli === -1 ? words.length : cli;
    for (let i = 0; i < upto; i++) {
      const w = base(words[i]!);
      if (w === "env" && /^(-[a-zA-Z]*i[a-zA-Z]*|-|--ignore-environment)$/.test(words[i + 1] ?? "")) wrapper ??= "env -i";
      else if (DETACHERS.has(w)) wrapper ??= w;
    }
    if (words.includes("disown")) wrapper ??= "disown";
    if (cli !== -1) verb ??= words.slice(cli + 1).find((w) => VERBS.has(w) || w === "import");
  }
  if (!wrapper && backgrounds(flat)) wrapper = "a background job (&)";
  if (!wrapper) return undefined;
  return { wrapper, verb, commit: /(^|\s)--commit\b/.test(flat) };
}

const SCRIPT_RUNNERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "source", ".", "expect", "tclsh", "unbuffer", "osascript", "python", "python3", "perl", "ruby", "node", "nodejs", "bun", "deno", "tsx", "open"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "source", "."]);
const PTY_DRIVERS = new Set(["expect", "unbuffer", "tclsh"]);
export const MAX_SCRIPT_BYTES = 64 * 1024;
/** Files actually read per hook call; paths that do not exist do not count. */
const MAX_SCRIPTS_READ = 4;
/** Paths tried per hook call, and words looked at, so a long argument list stays cheap. */
const MAX_CANDIDATES = 32;
const MAX_WORDS = 2048;
const MAX_TASK_FILE_BYTES = 1024 * 1024;
/**
 * Whole-call limits on following task runners: a recipe that runs `make t` a thousand times,
 * each `t` running `make u` a thousand times, must not cost a million re-parses. Past any of
 * these the hook asks. The deadline sits well inside the 27 s watchdog, which a synchronous scan
 * would block.
 */
const MAX_TASK_FILES = 8;
const MAX_ANALYSES = 64;
const MAX_ANALYZED_BYTES = 4 * 1024 * 1024;
const PARSE_BUDGET_MS = 15_000;

export interface ScriptHit {
  file: string;
  humanOnly?: { verb: string; decision: "deny" | "ask" };
  submit?: string;
  /** a fastlane lane the script or package script runs, for the caller to check against the Fastfile */
  lane?: string;
  /** the command hands a shell command to a new terminal window, outside this session and this hook */
  leavesSession?: string;
  /** a package.json, Makefile or justfile the command runs that exists but could not be read */
  unreadable?: string;
  /** an over-the-air publish the script, package script or recipe runs */
  ota?: { what: string; channel?: string };
  /** the command runs more scripts and tasks than the hook checks in one call */
  tooMuch?: string;
}

function readHead(file: string): string | undefined {
  try {
    const st = statSync(file);
    // Only regular files: a FIFO or device would block or never end.
    if (!st.isFile()) return undefined;
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(Math.min(st.size, MAX_SCRIPT_BYTES));
      const n = readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

function expandPath(w: string, cwd: string): string {
  const h = homedir();
  const e = w.replace(/^(~|\$HOME|\$\{HOME\})(?=$|\/)/, h).replace(/^(\$PWD|\$\{PWD\})(?=$|\/)/, cwd);
  return path.resolve(cwd, e);
}

/**
 * Shell words with quotes removed and each quoted span kept in one word, so the code after
 * `-c` or `-e` arrives whole. Control operators are words of their own. Linear in the input.
 */
function shellWords(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let started = false;
  let q = "";
  for (let i = 0; i < raw.length && out.length < MAX_WORDS; i++) {
    const ch = raw[i]!;
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
    } else if (ch === " " || ch === "\t" || ch === "\n" || ";|&()<>".includes(ch)) {
      if (started) out.push(cur);
      cur = "";
      started = false;
      if (ch !== " " && ch !== "\t") out.push(ch);
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) out.push(cur);
  return out;
}

const NOT_SHELL_CODE = new Set(["python", "python3", "node", "nodejs", "ruby", "perl", "osascript", "deno", "bun", "tsx"]);

function isCodeFlag(runner: string, flag: string): boolean {
  if (SHELLS.has(runner) || PTY_DRIVERS.has(runner)) return /^-[a-zA-Z]*c[a-zA-Z]*$/.test(flag);
  if (runner === "python" || runner === "python3") return /^-[a-zA-Z]*c$/.test(flag);
  return /^-[a-zA-Z]*[eE]$/.test(flag) || ["-p", "--eval", "--print"].includes(flag);
}

const RUNNER_VALUE_OPTS: Record<string, string[]> = {
  osascript: ["-l", "-s"],
  node: ["-r", "--require", "--import", "--input-type", "--loader"],
  nodejs: ["-r", "--require", "--import", "--input-type", "--loader"],
  python: ["-W", "-X"],
  python3: ["-W", "-X"],
};

/** Code passed inline (`bash -c '…'`, `python3 -c '…'`, `osascript -e '…'`, `deno eval '…'`). */
function inlineCode(raw: string): { runner: string; code: string }[] {
  const words = shellWords(raw);
  const out: { runner: string; code: string }[] = [];
  for (let i = 0; i < words.length && out.length < 8; i++) {
    const runner = base(words[i]!);
    if (!SCRIPT_RUNNERS.has(runner) && runner !== "deno") continue;
    if (runner === "deno" && words[i + 1] === "eval" && words[i + 2] !== undefined) out.push({ runner, code: words[i + 2]! });
    for (let j = i + 1; j < words.length && words[j]!.startsWith("-") && out.length < 8; j++) {
      if (isCodeFlag(runner, words[j]!) && words[j + 1] !== undefined) out.push({ runner, code: words[++j]! });
      // `osascript -l JavaScript -e '…'`: an option's value is not where the options end.
      else if (RUNNER_VALUE_OPTS[runner]?.includes(words[j]!)) j++;
    }
  }
  return out;
}

/** Python, JS or AppleScript as words a shell reader understands: `run(['asc','review'])` → `run asc review`. */
function codeWords(code: string): string {
  return code.replace(/[[\](){},;:'"`+]/g, " ");
}

const SCRIPT_PATH = /\/|\.(sh|bash|zsh|command|tool|py|rb|pl|js|mjs|cjs|ts|exp|tcl|applescript)$/;
const TERMINAL_APPS = /^(terminal|iterm2?|warp|ghostty|alacritty|kitty|wezterm|hyper)(\.app)?$/i;
const TERMINAL_BUNDLES = /^(com\.apple\.terminal|com\.googlecode\.iterm2|dev\.warp\.|com\.mitchellh\.ghostty|(io|org)\.alacritty|net\.kovidgoyal\.kitty|com\.github\.wez\.wezterm|co\.zeit\.hyper)/i;
// AppleScript `do script` / iTerm `write text`, and their JXA forms `doScript(…)` / `write({text: …})`.
const APPLESCRIPT_HANDOFF = /\bdo\s+script\b|\bwrite\s+text\b|\bdoScript\s*\(|\.write\s*\(/i;

/** A command handed to another terminal, and the command text it hands over when the words show it. */
export interface Handoff {
  via: string;
  nested?: string;
}

/**
 * The operands of a subcommand, without its options or their values: `send-keys -t build npm run
 * ship Enter` → `npm run ship Enter`. `values` lists the option letters (or whole long options)
 * that take the next word; a cluster ending in one of those letters takes it too.
 */
function operandText(args: string[], values: string, longValues: string[] = []): string {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      out.push(...args.slice(i + 1));
      break;
    }
    if (longValues.includes(a)) i++;
    else if (a.startsWith("--")) continue;
    else if (a.startsWith("-") && a.length > 1) {
      if (values.includes(a[a.length - 1]!)) i++;
    } else out.push(a);
  }
  return out.join(" ");
}

// Option letters that take a value, per tmux subcommand that runs or types a command.
const TMUX_RUN: Record<string, string> = {
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
  popup: "bcdehsStTwxy",
};

function tmuxHandoff(args: string[]): Handoff | undefined {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) {
    const a = args[i]!;
    // `tmux -c CMD` runs CMD with the default shell.
    if (a === "-c") return { via: "tmux -c", nested: args.slice(i + 1).join(" ") };
    i += "LSfT".includes(a[a.length - 1]!) ? 2 : 1;
  }
  const sub = args[i];
  const values = sub === undefined ? undefined : TMUX_RUN[sub];
  if (values === undefined) return undefined;
  return { via: `tmux ${sub}`, nested: operandText(args.slice(i + 1), values) };
}

function screenHandoff(args: string[]): Handoff | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("-")) return { via: "screen", nested: args.slice(i).join(" ") };
    // `-X stuff TEXT` types TEXT into a session; `-X screen CMD` opens a window running CMD.
    if (a.endsWith("X")) return { via: `screen -X ${args[i + 1] ?? ""}`.trim(), nested: args.slice(i + 2).join(" ") };
    if (a === "-Logfile" || "SceHhpsTt".includes(a[a.length - 1]!)) i++;
  }
  return undefined;
}

function openHandoff(args: string[]): Handoff | undefined {
  let app: string | undefined;
  let bundle: string | undefined;
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--args") {
      files.push(...args.slice(i + 1));
      break;
    }
    if (a === "--env" || a === "--stdin" || a === "--stdout" || a === "--stderr" || a === "-u") i++;
    else if (a.startsWith("--")) continue;
    else if (a.startsWith("-")) {
      // `-na Terminal`, `-b com.apple.Terminal`: a cluster whose letters include a or b takes the name.
      if (a.includes("a")) app = args[++i];
      else if (a.includes("b")) bundle = args[++i];
    } else files.push(a);
  }
  const terminal = (app !== undefined && TERMINAL_APPS.test(base(app))) || (bundle !== undefined && TERMINAL_BUNDLES.test(bundle));
  const command = files.some((f) => /\.(command|tool)$/.test(f));
  if (!terminal && !command) return undefined;
  // A terminal app runs the files it is given as scripts.
  return { via: terminal ? `open ${app !== undefined ? `-a ${app}` : `-b ${bundle}`}` : "open of a .command file", nested: files.length ? `sh ${files.join(" ")}` : undefined };
}

/**
 * Hands a command to a terminal window or a multiplexer session: that runs outside this session,
 * so neither this hook nor the CLI's lineage check sees the agent behind it. `run` is the segment
 * with its wrappers stripped. The command text it hands over, when the words show it, is checked
 * like any other command, so a HOLD still holds.
 */
function terminalHandoff(flat: string, run: string[]): Handoff | undefined {
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
  return undefined;
}

/** The command strings AppleScript or JXA hands to a terminal (`do script "…"`, `doScript("…")`, `write({text: "…"})`). */
function appleScriptCommands(code: string): string[] {
  const out: string[] = [];
  const unescape = (t: string) => t.replace(/\\n/g, "\n").replace(/\\(.)/g, "$1");
  for (const m of code.matchAll(/\b(?:do\s+script|write\s+text)\s+"((?:[^"\\]|\\.)*)"/gi)) {
    if (out.length >= 4) break;
    out.push(unescape(m[1]!));
  }
  for (const m of code.matchAll(/\b(?:doScript|write)\s*\(\s*(?:\{\s*text\s*:\s*)?(["'`])((?:(?!\1)[^\\]|\\.)*)\1/g)) {
    if (out.length >= 4) break;
    out.push(unescape(m[2]!));
  }
  return out;
}

// ---------- package scripts, make targets and just recipes ----------

interface TaskText {
  label: string;
  /** directory the task's commands run in */
  dir: string;
  /** undefined when the file exists but could not be read (not a regular file, or too large) */
  text?: string;
}

const RUNNER_VALUE_FLAGS: Record<string, string[]> = {
  npm: ["--prefix", "-w", "--workspace"],
  pnpm: ["-C", "--dir", "--filter", "-F"],
  yarn: ["--cwd"],
  bun: ["--cwd", "--filter", "-F"],
  make: ["-C", "--directory", "-f", "--file", "--makefile", "-I", "-o", "-W"],
  just: ["-f", "--justfile", "-d", "--working-directory", "--shell", "--shell-arg", "--dotenv-path", "--dotenv-filename", "--color"],
};
const NPM_SCRIPT_VERBS = new Set(["run", "run-script", "rum", "urn"]);
const NPM_LIFECYCLE: Record<string, string> = { start: "start", test: "test", t: "test", tst: "test", stop: "stop", restart: "restart" };

function operands(args: string[], valueFlags: string[]): { opts: Map<string, string>; rest: string[] } {
  const opts = new Map<string, string>();
  const rest: string[] = [];
  for (let i = 0; i < args.length && i < 64; i++) {
    const a = args[i]!;
    if (a === "--") break;
    const eq = a.indexOf("=");
    if (a.startsWith("--") && eq > 0) opts.set(a.slice(0, eq), a.slice(eq + 1));
    else if (valueFlags.includes(a)) opts.set(a, args[++i] ?? "");
    else if (a === "--set") i += 2;
    else if (!a.startsWith("-")) rest.push(a);
  }
  return { opts, rest };
}

function nearestFile(dir: string, names: string[], walkUp: boolean): string | undefined {
  let cur = dir;
  for (let i = 0; i < 64; i++) {
    for (const n of names) {
      const f = path.join(cur, n);
      if (existsSync(f)) return f;
    }
    const up = path.dirname(cur);
    if (!walkUp || up === cur) return undefined;
    cur = up;
  }
  return undefined;
}

/** `npm run X`, `npm test`, `yarn X`, `pnpm [run] X`, `bun run X`: the scripts package.json runs, with pre/post. */
function packageScript(runner: string, args: string[], cwd: string, ctx: ScanCtx): TaskText | undefined {
  const { opts, rest } = operands(args, RUNNER_VALUE_FLAGS[runner]!);
  const [a, b] = rest;
  let name: string | undefined;
  if (runner === "npm") name = a && NPM_SCRIPT_VERBS.has(a) ? b : a ? NPM_LIFECYCLE[a] : undefined;
  else name = a === "run" || a === "run-script" ? b : a;
  if (!name || /[$`]/.test(name)) return undefined;
  const dirOpt = opts.get("--prefix") ?? opts.get("--cwd") ?? opts.get("-C") ?? opts.get("--dir");
  const file = nearestFile(dirOpt ? expandPath(dirOpt, cwd) : cwd, ["package.json"], true);
  if (!file) return undefined;
  const label = `package.json script "${name}"`;
  const dir = path.dirname(file);
  const raw = taskFileText(file, ctx);
  let scripts: Record<string, unknown> | undefined;
  try {
    const parsed = raw === undefined ? undefined : (JSON.parse(raw) as { scripts?: unknown });
    scripts = parsed && typeof parsed === "object" ? ((parsed.scripts ?? {}) as Record<string, unknown>) : undefined;
  } catch {
    scripts = undefined;
  }
  if (!scripts || typeof scripts !== "object") return { label, dir };
  // `yarn install` and other built-ins are not scripts; nothing to check unless one is defined.
  const text = [`pre${name}`, name, `post${name}`]
    .map((k) => scripts[k])
    .filter((v): v is string => typeof v === "string")
    .join("\n");
  return text ? { label, dir, text } : undefined;
}

interface Recipe {
  deps: string[];
  body: string[];
}

/** Targets or recipes and their command lines. A scan of lines with indexOf, no backtracking. */
function parseRecipes(raw: string, kind: "make" | "just"): { recipes: Map<string, Recipe>; first?: string } {
  const recipes = new Map<string, Recipe>();
  let first: string | undefined;
  let current: Recipe[] = [];
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("\t") || line.startsWith(" ")) {
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
      const r: Recipe = { deps, body: inline ? [inline] : [] };
      recipes.set(n, r);
      current.push(r);
      if (!first && !n.startsWith(".") && !n.includes("%")) first = n;
    }
  }
  return { recipes, first };
}

function recipeText(recipes: Map<string, Recipe>, wanted: string[]): string {
  const seen = new Set<string>();
  const queue = [...wanted];
  const lines: string[] = [];
  while (queue.length && seen.size < 32) {
    const n = queue.shift()!;
    if (seen.has(n)) continue;
    seen.add(n);
    const r = recipes.get(n);
    if (!r) continue;
    queue.push(...r.deps);
    lines.push(...r.body);
  }
  return lines.join("\n");
}

/** `make [TARGET…]` and `just [RECIPE]`: the command lines they run, prerequisites included. */
function recipeTask(runner: "make" | "just", args: string[], cwd: string, ctx: ScanCtx): TaskText | undefined {
  const { opts, rest } = operands(args, RUNNER_VALUE_FLAGS[runner]!);
  const dirOpt = opts.get("-C") ?? opts.get("--directory") ?? opts.get("-d") ?? opts.get("--working-directory");
  const dir = dirOpt ? expandPath(dirOpt, cwd) : cwd;
  const named = opts.get("-f") ?? opts.get("--file") ?? opts.get("--makefile") ?? opts.get("--justfile");
  const file = named
    ? expandPath(named, dir)
    : runner === "make"
      ? nearestFile(dir, ["GNUmakefile", "makefile", "Makefile"], false)
      : nearestFile(dir, ["justfile", "Justfile", ".justfile", "JUSTFILE"], true);
  if (!file || !existsSync(file)) return undefined;
  const targets = runner === "make" ? rest.filter((t) => !t.includes("=")) : rest.slice(0, 1);
  if (targets.some((t) => /[$`]/.test(t))) return undefined;
  const raw = taskFileText(file, ctx);
  if (raw === undefined) return { label: `${path.basename(file)} ${targets.join(" ") || "(default)"}`.trim(), dir };
  const key = `${runner}\0${file}`;
  let parsed = ctx.recipes.get(key);
  if (!parsed) ctx.recipes.set(key, (parsed = parseRecipes(raw, runner)));
  const { recipes, first } = parsed;
  const wanted = targets.length ? targets : first ? [first] : [];
  const text = recipeText(recipes, wanted);
  return text ? { label: `${path.basename(file)} ${runner === "make" ? "target" : "recipe"} "${wanted.join(" ")}"`, dir: runner === "just" ? path.dirname(file) : dir, text } : undefined;
}

/** JSONC (comments, trailing commas) to JSON, outside strings. One pass, no backtracking. */
export function stripJsonc(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
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
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] !== "}" && text[j] !== "]") out += ch;
    } else out += ch;
  }
  return out;
}

/** Shell commands of `asc workflow run NAME`: its steps, sub-workflows it calls, and the file's hooks. */
function workflowCommands(def: unknown, name: string | undefined): string[] {
  if (!def || typeof def !== "object") return [];
  const d = def as Record<string, unknown>;
  const out: string[] = [];
  const push = (v: unknown, queue: string[]) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) for (const x of v.slice(0, 256)) push(x, queue);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.run === "string") out.push(o.run);
      if (typeof o.workflow === "string") queue.push(o.workflow);
    }
  };
  const flows = (d.workflows && typeof d.workflows === "object" ? d.workflows : {}) as Record<string, unknown>;
  const hooks: string[] = [];
  for (const h of [d.before_all, d.after_all, d.error]) push(h, hooks);
  // An unknown or computed name: every workflow in the file could be the one that runs.
  const queue = name && !/[$`]/.test(name) && Object.hasOwn(flows, name) ? [name] : Object.keys(flows);
  const seen = new Set<string>();
  while (queue.length && seen.size < 64) {
    const n = queue.shift()!;
    if (seen.has(n) || !Object.hasOwn(flows, n)) continue;
    seen.add(n);
    const wf = flows[n] as { steps?: unknown } | undefined;
    push(wf?.steps, queue);
  }
  return out;
}

/** `asc workflow run [--file F] NAME`: the shell steps .asc/workflow.json runs. */
function ascWorkflow(args: string[], cwd: string, ctx: ScanCtx): TaskText | undefined {
  const { opts, rest } = operands(args, ["--file", "--resume", "--output", "--profile"]);
  const w = rest.indexOf("workflow");
  if (w === -1 || rest[w + 1] !== "run" || args.includes("--dry-run")) return undefined;
  const name = rest[w + 2];
  const named = opts.get("--file");
  const file = named ? expandPath(named, cwd) : nearestFile(cwd, [path.join(".asc", "workflow.json")], true);
  if (!file || !existsSync(file)) return undefined;
  const label = `${named ? path.basename(file) : ".asc/workflow.json"} workflow "${name ?? "(none)"}"`;
  const dir = named ? cwd : path.dirname(path.dirname(file));
  const raw = taskFileText(file, ctx);
  if (raw === undefined) return { label, dir };
  try {
    const text = workflowCommands(JSON.parse(stripJsonc(raw)), name).join("\n");
    return text ? { label, dir, text } : undefined;
  } catch {
    // asc would run it, and the hook cannot tell what it runs: a person decides.
    return { label, dir };
  }
}

/** A task file's text, read once per hook call and counted against MAX_TASK_FILES. */
function taskFileText(file: string, ctx: ScanCtx): string | undefined {
  if (ctx.taskFiles.has(file)) return ctx.taskFiles.get(file);
  if (ctx.taskFiles.size >= MAX_TASK_FILES) {
    ctx.tooMuch ??= `more than ${MAX_TASK_FILES} package.json, Makefile, justfile or workflow files`;
    return undefined;
  }
  const text = readCapped(file, MAX_TASK_FILE_BYTES);
  ctx.taskFiles.set(file, text);
  return text;
}

function taskFor(runner: string, args: string[], cwd: string, ctx: ScanCtx): TaskText | undefined {
  if (RUNNER_VALUE_FLAGS[runner] && (runner === "npm" || runner === "pnpm" || runner === "yarn" || runner === "bun")) return packageScript(runner, args, cwd, ctx);
  if (runner === "make" || runner === "gmake") return recipeTask("make", args, cwd, ctx);
  if (runner === "just") return recipeTask("just", args, cwd, ctx);
  if (runner === "asc") return ascWorkflow(args, cwd, ctx);
  return undefined;
}

// ---------- the scan ----------

/** Shared by every level of one hook call's scan, so the limits are per call, not per level. */
interface ScanCtx {
  read: number;
  tried: number;
  lane?: string;
  leaves?: string;
  /** set when a task file exists but cannot be read */
  unreadable?: string;
  ota?: { what: string; channel?: string };
  deadline: number;
  analyses: number;
  bytes: number;
  taskFiles: Map<string, string | undefined>;
  recipes: Map<string, { recipes: Map<string, Recipe>; first?: string }>;
  /** tasks already checked with no hit: the same `make t` named again costs nothing */
  seenTasks: Set<string>;
  tooMuch?: string;
}

/** Counts one more text to analyse; false once the call is over any of its limits. */
function spend(ctx: ScanCtx, bytes: number): boolean {
  if (ctx.tooMuch) return false;
  if (Date.now() > ctx.deadline) ctx.tooMuch = `more than ${PARSE_BUDGET_MS / 1000} s of parsing`;
  else if (++ctx.analyses > MAX_ANALYSES) ctx.tooMuch = `more than ${MAX_ANALYSES} scripts, recipes and package scripts`;
  else if ((ctx.bytes += bytes) > MAX_ANALYZED_BYTES) ctx.tooMuch = `more than ${MAX_ANALYZED_BYTES / 1024 / 1024} MB of script text`;
  return !ctx.tooMuch;
}

function analyzeText(text: string, label: string, runner: string, dir: string, ctx: ScanCtx, depth: number): ScriptHit | undefined {
  if (!spend(ctx, text.length)) return undefined;
  // Comment lines (`# asc review submit`) describe; they do not run.
  const code = text
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#") && !l.trimStart().startsWith("//"))
    .join("\n");
  const shellish = NOT_SHELL_CODE.has(runner) ? `${code}\n${codeWords(code)}` : code;
  const run = humanOnlyRun(shellish);
  const driver = PTY_DRIVERS.has(runner) || /^#!.*\b(expect|unbuffer|tclsh)\b/.test(text);
  if (run) return { file: label, humanOnly: { verb: run.verb, decision: driver ? "deny" : run.decision } };
  if (CLI_MENTION.test(flatten(code))) {
    const words = new Set(flatten(code).split(/[^\w-]+/));
    const verb = words.has("attest") ? "attest" : words.has("ack") ? "ack" : words.has("import") && words.has("--commit") ? "import --commit" : undefined;
    if (verb) return { file: label, humanOnly: { verb, decision: driver ? "deny" : "ask" } };
  }
  const direct = classifyCommand(code, dir);
  const submit = looseSubmit(shellish) ?? (direct.kind === "submit" ? direct.what : undefined);
  const where = label.includes("/") ? path.basename(label) : label;
  if (submit) return { file: label, submit: `${submit} in ${where}` };
  const ota = direct.kind === "ota" ? { what: direct.what ?? "an over-the-air update", channel: direct.channel } : looseOta(shellish);
  if (ota) ctx.ota ??= { what: `${ota.what} in ${where}`, channel: ota.channel };
  if (runner === "osascript" && APPLESCRIPT_HANDOFF.test(code)) {
    ctx.leaves ??= `osascript \`do script\` in ${path.basename(label)}`;
    // The command typed into the new window runs like any other: follow its scripts and package scripts.
    for (const typed of appleScriptCommands(code)) {
      const hit = analyzeText(typed, `the command osascript hands to a terminal in ${path.basename(label)}`, "sh", dir, ctx, depth);
      if (hit) return hit;
    }
  }
  ctx.lane ??= fastlaneLane(code);
  // One more level: a script that runs `npm run x`, `make y` or `bash z.sh`.
  if (depth < 2) return scan(shellish, dir, ctx, depth + 1);
  return undefined;
}

function scan(cmd: string, cwd: string, ctx: ScanCtx, depth: number): ScriptHit | undefined {
  const flat = flatten(cmd);
  const files: { file: string; runner: string }[] = [];
  const drivers = new Set<string>();
  let words = 0;
  for (const seg of wordSegments(flat)) {
    if ((words += seg.length) > MAX_WORDS || ctx.tooMuch) break;
    // `timeout 900 npm run ship`, `op run -- bash s.sh`, `find . -exec bash s.sh \;`: the wrapped command runs.
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
      if (task.text === undefined) ctx.unreadable ??= task.label;
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
  // Inline code: shell code is scanned as a command; other languages for script paths they name.
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
        // Read as a script of its own: quoting starts afresh inside it, so `bash -c 'x=$(asc
        // review submit)'` has a substitution that the outer text keeps in single quotes.
        const hit = analyzeText(code, `${runner} -c code`, runner, cwd, ctx, depth);
        if (hit) return hit;
      }
    }
  }
  const read = new Set<string>();
  for (const { file, runner } of files) {
    if (ctx.read >= MAX_SCRIPTS_READ || ctx.tried >= MAX_CANDIDATES || ctx.tooMuch) break;
    ctx.tried++;
    const text = readHead(file);
    if (!text) continue;
    ctx.read++;
    read.add(runner);
    const hit = analyzeText(text, file, runner, path.dirname(file), ctx, depth);
    if (hit) return hit;
  }
  // A pty driver types into whatever it spawns; when its script cannot be read, a person decides.
  const blind = [...drivers].find((d) => !read.has(d));
  if (blind) return { file: blind, humanOnly: { verb: "attest/ack", decision: "ask" } };
  return undefined;
}

/**
 * What the command runs beyond its own text: script files (`bash x.sh`, `expect a.exp`,
 * `./ship.command`), code passed with `-c`/`-e`, package.json scripts (`npm run x`, `yarn x`),
 * make targets, just recipes and `asc workflow run` steps. The hook only sees the command line,
 * so a submit or attest written into one of those would otherwise pass unseen. Reads at most
 * 64 KB of each of at most four script files and eight task files, analyses at most 64 texts,
 * follows two levels of nesting, stops after 15 s, and never reads FIFOs or devices.
 */
export function scriptFileHit(cmd: string, cwd: string, budgetMs = PARSE_BUDGET_MS): ScriptHit | undefined {
  const ctx: ScanCtx = { read: 0, tried: 0, deadline: Date.now() + budgetMs, analyses: 0, bytes: 0, taskFiles: new Map(), recipes: new Map(), seenTasks: new Set() };
  const hit = scan(cmd, cwd, ctx, 0);
  if (hit) return hit;
  // Past a limit the rest was not checked, so nothing found does not mean nothing there.
  if (ctx.tooMuch) return { file: "", tooMuch: ctx.tooMuch };
  if (ctx.unreadable) return { file: ctx.unreadable, unreadable: ctx.unreadable };
  if (ctx.lane || ctx.leaves || ctx.ota) return { file: "", lane: ctx.lane, leavesSession: ctx.leaves, ota: ctx.ota };
  return undefined;
}

/** The lane a `fastlane <lane>` command runs, if any (`fastlane run <action>` runs an action). */
export function fastlaneLane(cmd: string): string | undefined {
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
  return undefined;
}

const UPLOAD_ACTION = /\b(deliver|upload_to_app_store|appstore)\b/;
const LANE_DEF = /^[ \t]*(?:private_)?lane[ \t]+:(\w+)/gm;
const MAX_FASTFILE_BYTES = 256 * 1024;

function uncommented(text: string): string {
  return text
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");
}

const FASTLANE_DIRS = (dir: string) => [path.join(dir, "fastlane"), dir, path.join(dir, "ios", "fastlane")];
const TRUE_ENV = /^(true|yes|1|on)$/i;
// One line of a dotenv file. `[ \t]*` cannot cross a line, so this stays linear.
const DELIVER_ENV = /^[ \t]*(?:export[ \t]+)?DELIVER_SUBMIT_FOR_REVIEW[ \t]*=[ \t]*["']?(?:true|yes|1|on)\b/im;

/** Where one fastlane folder's Deliverfile or dotenv files turn deliver's submit_for_review on. */
function deliverDirSubmits(fdir: string, envNames: string[]): string | undefined {
  const deliverfile = path.join(fdir, "Deliverfile");
  const df = readCapped(deliverfile, MAX_FASTFILE_BYTES);
  if (df && submitForReviewTrue(uncommented(df).split(/\s+/))) return `${deliverfile} sets submit_for_review`;
  for (const name of [".env", ".env.default", ...envNames.map((e) => `.env.${e}`)]) {
    const f = path.join(fdir, name);
    const t = readCapped(f, MAX_FASTFILE_BYTES);
    if (t && DELIVER_ENV.test(t)) return `${f} sets DELIVER_SUBMIT_FOR_REVIEW`;
  }
  return undefined;
}

const DELIVER_LANE = /^(deliver|upload_to_app_store|appstore)$/;
const DELIVER_NON_UPLOAD = /\b(deliver|upload_to_app_store|appstore)\s+(init|download_metadata|download_screenshots|generate_summary)\b/;
const SUBMIT_OFF = /submit[_-]for[_-]review[\s:=]+(false|no|0)\b/i;

/**
 * `fastlane deliver` (or upload_to_app_store) with no submit_for_review on its command line
 * still submits when the repo's Deliverfile says `submit_for_review(true)` or a dotenv file
 * fastlane loads (fastlane/.env, .env.default, .env.<--env>) sets DELIVER_SUBMIT_FOR_REVIEW, as
 * does the variable in the environment the command inherits. Returns where it is turned on.
 */
export function deliverConfigSubmit(cmd: string, lane: string | undefined, dirs: string[], env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!lane || !DELIVER_LANE.test(lane)) return undefined;
  // An explicit false on the command line wins over the Deliverfile; a comment is not one.
  const bare = flatten(stripShellComments(normalizeShell(cmd)));
  if (SUBMIT_OFF.test(bare) || DELIVER_NON_UPLOAD.test(bare)) return undefined;
  if (TRUE_ENV.test(env.DELIVER_SUBMIT_FOR_REVIEW ?? "")) return "DELIVER_SUBMIT_FOR_REVIEW is set in the environment";
  const envNames: string[] = [];
  for (const words of wordSegments(bare)) {
    for (let i = 0; i < words.length; i++) {
      const v = words[i] === "--env" ? words[i + 1] : words[i]!.startsWith("--env=") ? words[i]!.slice(6) : undefined;
      if (v) envNames.push(...v.split(",").filter((e) => /^[\w-]{1,64}$/.test(e)));
    }
  }
  const seen = new Set<string>();
  for (const dir of dirs) {
    for (const fdir of FASTLANE_DIRS(dir)) {
      if (seen.has(fdir)) continue;
      seen.add(fdir);
      const hit = deliverDirSubmits(fdir, envNames.slice(0, 8));
      if (hit) return hit;
    }
  }
  return undefined;
}

/**
 * Lanes in the repo's Fastfile that send a build to App Review: they call deliver /
 * upload_to_app_store with submit_for_review true (or a Deliverfile that sets it), run a submit
 * command through `sh`, or call another such lane. Custom lane names (`ship_it`) are classified
 * by what they do.
 */
export function fastfileSubmitLanes(dirs: string[]): Set<string> {
  return fastfileLanes(dirs).submit;
}

/**
 * Lanes the repo's Fastfiles define, those that submit (see fastfileSubmitLanes), and those whose
 * submit_for_review is computed at run time (`ENV["SUBMIT"]`), which only running them can tell.
 */
export function fastfileLanes(dirs: string[]): { defined: Set<string>; submit: Set<string>; unclear: Set<string> } {
  const lanes = new Set<string>();
  const defined = new Set<string>();
  const unclear = new Set<string>();
  const seen = new Set<string>();
  for (const dir of dirs) {
    for (const fdir of FASTLANE_DIRS(dir)) {
      const fastfile = path.join(fdir, "Fastfile");
      if (seen.has(fastfile)) continue;
      seen.add(fastfile);
      const raw = readCapped(fastfile, MAX_FASTFILE_BYTES);
      if (!raw) continue;
      const text = uncommented(raw);
      const deliverSubmits = deliverDirSubmits(fdir, []) !== undefined;
      const defs = [...text.matchAll(LANE_DEF)];
      const bodies = defs.map((m, i) => ({ name: m[1]!, body: text.slice(m.index! + m[0].length, defs[i + 1]?.index ?? text.length) }));
      for (const { name, body } of bodies) {
        defined.add(name);
        if (UPLOAD_ACTION.test(body) && (deliverSubmits || submitForReviewTrue(body.split(/\s+/)))) lanes.add(name);
        else if (looseSubmit(codeWords(body))) lanes.add(name);
        else if (/submit_for_review/.test(body) && !/submit_for_review\s*(:|=>)\s*false\b/.test(body)) unclear.add(name);
      }
      // A lane that calls a submitting lane submits too; a few passes cover realistic nesting.
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

/**
 * MCP tools from App Store Connect servers that send a version to App Review. The API resource
 * is `reviewSubmissions`, so "submission" counts as well as "submit". Must match the same names
 * as the mcp__ matcher in hooks/hooks.json, or the hook never sees the call.
 */
export function isSubmitMcpTool(name: string): boolean {
  if (!name.startsWith("mcp__")) return false;
  // Server keys are often hyphenated (`mcp__app-store-connect__…`); read `-` as `_`.
  const n = name.toLowerCase().replace(/-/g, "_");
  if (!/submi(t|ssion)/.test(n) || !/(review|app_?store|asc|store_?connect)/.test(n)) return false;
  const words = name
    .slice(name.lastIndexOf("__") + 2)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  // Judged by what the tool does, not every word in its name: `validate_and_submit_for_review`
  // submits, `get_review_submission_status` only reads.
  const writes = words.some((w) => w === "submit" || w === "create" || w === "update" || w === "patch" || w === "post");
  const dryRun = words.includes("dryrun") || words.some((w, i) => w === "dry" && words[i + 1] === "run");
  if (dryRun) return false;
  if (READ_ONLY_VERBS.has(words[0] ?? "")) return words.slice(1).includes("submit");
  return writes || !words.some((w) => READ_ONLY_VERBS.has(w));
}

const READ_ONLY_VERBS = new Set(["list", "get", "read", "fetch", "show", "describe", "search", "find", "query", "status", "history", "cancel", "delete", "remove", "validate", "check", "view", "lookup", "count", "poll", "wait", "watch"]);

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * The repo to gate. In React Native and Expo apps fastlane usually runs from ios/, whose
 * .xcodeproj makes it look like a root; the JS that ships in the app lives one level up.
 */
export function resolveGateRoot(dir: string): string {
  const near = findProjectRoot(dir);
  const parent = path.dirname(near);
  if (parent === near || parent === homedir() || near === homedir()) return near;
  if (!["ios", "macos"].includes(path.basename(near))) return near;
  if (existsSync(path.join(near, ".git")) || existsSync(path.join(near, ".appstore-shield"))) return near;
  const native = safeList(near).some((n) => n.endsWith(".xcodeproj") || n.endsWith(".xcworkspace") || n === "Podfile");
  const js = ["package.json", "app.json", "app.config.js", "app.config.ts", ".appstore-shield"].some((m) => existsSync(path.join(parent, m)));
  return native && js ? parent : near;
}

/** Set in shells that Claude Code (and similar agents) start; a human terminal does not have them. */
export function agentEnvironment(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "AI_AGENT"].find((k) => env[k]);
}

/** One row of `ps -A -o pid=,ppid=,tty=,comm=` (plus args). */
export interface ProcRow {
  ppid: number;
  tty: string;
  comm: string;
  args: string;
}

const NO_TTY = /^(\?\??|-|)$/;
// Programs that drive a pseudo-terminal for another program. A terminal app a person types
// into is a GUI app, sshd or a multiplexer, never one of these.
const PTY_HOSTS = /^(expect|unbuffer|script|empty|socat|tclsh[\d.]*|python[\d.]*|perl[\d.]*|ruby[\d.]*|node|nodejs|bun|deno|osascript)$/i;

/**
 * Why this process does not look like a person at a terminal, from the process table: no
 * controlling terminal, re-parented to pid 1 (a double fork or a detached job), or a terminal
 * owned by a pty-driving program such as expect. The developer's own Terminal, iTerm, VS Code,
 * ssh or tmux session passes.
 */
export function lineageProblem(table: ReadonlyMap<number, ProcRow>, selfPid: number): string | undefined {
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
      return PTY_HOSTS.test(name) ? `its terminal is driven by ${name} (pid ${pid}), a program, not a terminal app a person types into` : undefined;
    }
    if (row.ppid <= 1) return "the shells on its terminal were re-parented to pid 1, as a detached or double-forked process is";
    pid = row.ppid;
  }
  return undefined;
}

/** `env -i` and launchers that start programs without a login environment leave these unset. */
export function clearedEnvironment(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const missing = ["TERM", "HOME"].filter((k) => !env[k]);
  if (!env.USER && !env.LOGNAME) missing.push("USER/LOGNAME");
  return missing.length ? `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set, as in an environment cleared with \`env -i\`` : undefined;
}

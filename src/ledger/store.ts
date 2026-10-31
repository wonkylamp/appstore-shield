import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsc, existsSync } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  HUMAN_ONLY_EVENTS,
  LedgerEvent,
  type EventSource,
  type LedgerEventType,
  type LedgerState,
  type RejectionState,
} from "./schema.js";

/** Default home: ~/.appstore-shield (override with APPSTORE_SHIELD_HOME). Ledger: <home>/teams/<teamId>/events.jsonl */
export interface LedgerLocation {
  teamId: string;
  /** how the team id was found: config, pbxproj DEVELOPMENT_TEAM, app.json ios.appleTeamId, or repo-hash fallback */
  teamIdSource: string;
  path: string;
  warnings: string[];
  /**
   * Problems with where the ledger lives that should stop a submission: e.g. this repo's
   * earlier ledger has an open rejection that the current ledger does not know about.
   */
  integrity: string[];
}

/** Folded state plus the location problems found when the ledger was located; the gate reads both. */
export interface LedgerStateWithLocation extends LedgerState {
  locationIssues?: string[];
}

export interface RepoConfig {
  teamId?: string;
  ledgerPath?: string;
  [k: string]: unknown;
}

export const CONFIG_REL = ".appstore-shield/config.json";

/** Event input as a caller supplies it: the store assigns id, at (when absent) and source. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type LedgerEventInput = DistributiveOmit<z.input<typeof LedgerEvent>, "id" | "at" | "source"> & {
  at?: string;
  id?: string;
  source?: EventSource;
};

export class HumanOnlyEventError extends Error {
  constructor(type: string) {
    super(
      `"${type}" events record human judgment and can only be added by the developer: run \`appstore-shield ${type === "ack" ? "ack" : "attest"}\` in a terminal (it asks for a typed confirmation). Agents and MCP callers cannot append them.`,
    );
    this.name = "HumanOnlyEventError";
  }
}

/**
 * An approval closes open rejections, so an agent must not be able to write one: it would
 * clear the gate on its own say-so. Approvals come only from Apple's own message, imported.
 */
export class ImportOnlyEventError extends HumanOnlyEventError {
  constructor() {
    super("outcome");
    this.message =
      "Approvals close open rejections, so agents and MCP callers cannot record them. Import Apple's own approval message instead: the developer runs `appstore-shield import <saved email or asc export>` in a terminal.";
    this.name = "ImportOnlyEventError";
  }
}

/**
 * Sources whose approvals count, as SECURITY.md states. An agent-written approval never closes a
 * rejection, and "ci"/"hook" are left out too: a non-interactive run may be an agent's shell.
 */
const APPROVAL_SOURCES: ReadonlySet<EventSource> = new Set(["human", "import"]);
export function approvalCounts(e: { source: EventSource }): boolean {
  return APPROVAL_SOURCES.has(e.source);
}

export class ShieldHomeError extends Error {
  constructor(value: string) {
    super(
      `APPSTORE_SHIELD_HOME is "${value}", which is not an absolute path. A relative home would move the ledger with the current directory, so a gate run elsewhere would read an empty history. Set it to an absolute path (a leading ~/ is expanded).`,
    );
    this.name = "ShieldHomeError";
  }
}

/**
 * `~` is expanded here because JSON and launchd configs pass the value unexpanded, and the hook
 * expands it: both must agree on one ledger. A relative value throws rather than resolving
 * against the cwd, so the gate fails instead of reporting CLEAR over an empty ledger.
 */
export function shieldHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.APPSTORE_SHIELD_HOME?.trim();
  if (!raw) return path.join(homedir(), ".appstore-shield");
  const expanded = raw.replace(/^~(?=$|[/\\])/, homedir());
  if (!path.isAbsolute(expanded)) throw new ShieldHomeError(raw);
  return path.resolve(expanded);
}

const TEAM_ID_RX = /^[A-Z0-9]{10}$/;
// Team ids become a path segment, so anything else could escape the ledger home.
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Config files are a few KB; anything far larger was not written by this tool. */
const MAX_JSON_BYTES = 1_000_000;

async function readJson(file: string): Promise<unknown> {
  try {
    // A FIFO or device here would block the gate forever; only a regular file is read.
    const st = await stat(file);
    if (!st.isFile() || st.size > MAX_JSON_BYTES) return undefined;
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

function get(obj: unknown, ...keys: string[]): unknown {
  let cur = obj;
  for (const k of keys) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

export async function readRepoConfig(repoRoot: string): Promise<RepoConfig | undefined> {
  const cfg = await readJson(path.join(repoRoot, CONFIG_REL));
  return cfg && typeof cfg === "object" && !Array.isArray(cfg) ? (cfg as RepoConfig) : undefined;
}

const SKIP_DIRS = new Set(["node_modules", "Pods", ".git", "build", "DerivedData", "dist", ".build", "Carthage", "vendor"]);

/** *.xcodeproj dirs at the root and up to two levels down (RN keeps them under ios/). */
async function findXcodeProjects(root: string, depth = 2): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
    const abs = path.join(root, e.name);
    if (e.name.endsWith(".xcodeproj")) out.push(abs);
    else if (depth > 0) out.push(...(await findXcodeProjects(abs, depth - 1)));
  }
  return out;
}

async function teamFromPbxproj(root: string): Promise<{ teamId: string; file: string; others: string[] } | undefined> {
  const counts = new Map<string, number>();
  let firstFile = "";
  for (const proj of await findXcodeProjects(root)) {
    let text: string;
    try {
      text = await readFile(path.join(proj, "project.pbxproj"), "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(/\bDEVELOPMENT_TEAM(?:\[[^\]]*\])?\s*=\s*"?([A-Za-z0-9]+)"?\s*;/g)) {
      const id = m[1] ?? "";
      if (!TEAM_ID_RX.test(id)) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
      if (!firstFile) firstFile = path.relative(root, path.join(proj, "project.pbxproj"));
    }
  }
  if (counts.size === 0) return undefined;
  // Most common value wins: a stray target (e.g. a widget signed by a contractor) should not move the ledger.
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [teamId] = ranked[0] as [string, number];
  return { teamId, file: firstFile, others: ranked.slice(1).map(([id]) => id) };
}

async function teamFromExpo(root: string): Promise<{ teamId: string; file: string } | undefined> {
  for (const file of ["app.json", "app.config.json"]) {
    const json = await readJson(path.join(root, file));
    const v = get(json, "expo", "ios", "appleTeamId") ?? get(json, "ios", "appleTeamId");
    if (typeof v === "string" && v.trim()) return { teamId: v.trim(), file: `${file} ios.appleTeamId` };
  }
  const eas = await readJson(path.join(root, "eas.json"));
  const submit = get(eas, "submit");
  if (submit && typeof submit === "object") {
    for (const [profile, cfg] of Object.entries(submit as Record<string, unknown>)) {
      const v = get(cfg, "ios", "appleTeamId");
      if (typeof v === "string" && v.trim()) return { teamId: v.trim(), file: `eas.json submit.${profile}.ios.appleTeamId` };
    }
  }
  return undefined;
}

function gitRemotes(repoRoot: string): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", ["-C", repoRoot, "remote", "-v"], { timeout: 3000 }, (err, stdout) => resolve(err ? "" : String(stdout)));
  });
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export async function locateLedger(repoRootIn: string, opts: { remember?: boolean } = {}): Promise<LedgerLocation> {
  const repoRoot = path.resolve(repoRootIn);
  const warnings: string[] = [];
  const cfg = await readRepoConfig(repoRoot);

  let teamId: string | undefined;
  let teamIdSource = "";
  const integrity: string[] = [];
  if (typeof cfg?.teamId === "string" && cfg.teamId.trim()) {
    if (SAFE_SEGMENT.test(cfg.teamId.trim())) {
      teamId = cfg.teamId.trim();
      teamIdSource = `${CONFIG_REL} teamId`;
    } else {
      warnings.push(`Ignored teamId in ${CONFIG_REL}: it must be letters, digits, ".", "_" or "-" (an Apple Team ID is 10 characters, e.g. ABCDE12345).`);
    }
  }
  if (!teamId) {
    const pbx = await teamFromPbxproj(repoRoot);
    if (pbx) {
      teamId = pbx.teamId;
      teamIdSource = `DEVELOPMENT_TEAM in ${pbx.file}`;
      if (pbx.others.length) {
        warnings.push(
          `Xcode targets use more than one DEVELOPMENT_TEAM (${[pbx.teamId, ...pbx.others].join(", ")}); using ${pbx.teamId}. Set teamId in ${CONFIG_REL} if the App Store account is a different one.`,
        );
      }
    }
  }
  if (!teamId) {
    const expo = await teamFromExpo(repoRoot);
    if (expo && SAFE_SEGMENT.test(expo.teamId)) {
      teamId = expo.teamId;
      teamIdSource = expo.file;
    }
  }
  if (!teamId) {
    let real = repoRoot;
    try {
      real = await realpath(repoRoot);
    } catch {
      // keep the resolved path; the repo may not exist yet
    }
    teamId = `repo-${createHash("sha1").update(real).digest("hex").slice(0, 8)}`;
    teamIdSource = "repo-hash fallback";
    warnings.push(
      `No Apple Team ID found (checked ${CONFIG_REL}, DEVELOPMENT_TEAM in *.xcodeproj, ios.appleTeamId in app.json/app.config.json/eas.json). History is being kept per repo, so other apps on the same developer account are not counted. Add {"teamId": "<your 10-character Team ID>"} to ${CONFIG_REL}.`,
    );
  }
  if (teamId !== teamId.toUpperCase() && TEAM_ID_RX.test(teamId.toUpperCase())) {
    teamId = teamId.toUpperCase();
  }
  if (teamIdSource.startsWith(CONFIG_REL)) {
    // A repo file can point the gate at any ledger; say so when it disagrees with the project's signing team.
    const project = (await teamFromPbxproj(repoRoot))?.teamId ?? (await teamFromExpo(repoRoot))?.teamId;
    if (project && project.toUpperCase() !== teamId.toUpperCase()) {
      warnings.push(
        `teamId ${teamId} in ${CONFIG_REL} differs from the project's own team ${project}. History for ${project} is not being checked. If ${teamId} is not the App Store account that submits this app, correct ${CONFIG_REL}.`,
      );
    }
  }

  let ledgerFile = path.join(shieldHome(), "teams", teamId, "events.jsonl");
  if (typeof cfg?.ledgerPath === "string" && cfg.ledgerPath.trim()) {
    const raw = cfg.ledgerPath.trim().replace(/^~(?=$|\/)/, homedir());
    const base = path.resolve(repoRoot, raw);
    ledgerFile = base.endsWith(".jsonl") ? base : path.join(base, "teams", teamId, "events.jsonl");
    if (isInside(ledgerFile, repoRoot)) {
      const remotes = await gitRemotes(repoRoot);
      const publicHost = /(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)/i.exec(remotes)?.[1];
      if (publicHost) {
        warnings.push(
          `ledgerPath points inside this repo and the repo has a ${publicHost} remote. If that remote is public, App Review messages, attestations and termination letters would be published. Keep the ledger in a private location (e.g. a private compliance repo) or make sure this remote is private.`,
        );
      }
    }
  }
  if (await isSymlink(ledgerFile)) {
    integrity.push(`The ledger path ${ledgerFile} is a symbolic link. appstore-shield refuses to read or write through it, because it could point at any file. Point ledgerPath at the real ledger file.`);
  } else {
    const problem = await ledgerFileProblem(ledgerFile);
    if (problem) integrity.push(problem);
  }
  integrity.push(...(await carriedRejections(repoRoot, ledgerFile, opts.remember ?? true)));
  return { teamId, teamIdSource, path: ledgerFile, warnings, integrity };
}

/**
 * Why the file at the ledger path cannot be read as a ledger, if it cannot: a FIFO or device
 * (reading one blocks the gate forever), a file too large to be ours, or a non-empty file that is
 * not a ledger (e.g. a repo config naming some other tool's log).
 */
async function ledgerFileProblem(p: string): Promise<string | undefined> {
  let fh;
  try {
    fh = await open(p, LEDGER_READ_FLAGS);
  } catch {
    return undefined;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return new NotARegularLedgerError(p).message;
    if (st.size > LEDGER_MAX_BYTES) return new OversizedLedgerError(p, st.size).message;
    return st.size > 0 && !(await looksLikeLedger(fh, st.size)) ? new NotALedgerError(p).message : undefined;
  } catch {
    return undefined;
  } finally {
    await fh.close();
  }
}

async function isSymlink(p: string): Promise<boolean> {
  try {
    return (await lstat(p)).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Written by earlier versions as one shared map; still read so no remembered ledger is forgotten. */
function legacyReposFile(): string {
  return path.join(shieldHome(), "repos.json");
}

/**
 * One file per repo: gates run in parallel for several roots (and the hook and MCP preflight
 * overlap), and a shared read-modify-write lost the other repos' entries.
 */
function repoMemoryFile(realRoot: string): string {
  return path.join(shieldHome(), "repos", `${createHash("sha256").update(realRoot).digest("hex").slice(0, 32)}.json`);
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

async function rememberedLedgers(realRoot: string): Promise<string[]> {
  const own = await readJson(repoMemoryFile(realRoot));
  const ownList = own && typeof own === "object" && (own as { repo?: unknown }).repo === realRoot ? stringList((own as { ledgers?: unknown }).ledgers) : [];
  const legacy = await readJson(legacyReposFile());
  const legacyList = legacy && typeof legacy === "object" && !Array.isArray(legacy) ? stringList((legacy as Record<string, unknown>)[realRoot]) : [];
  return [...new Set([...legacyList, ...ownList])];
}

/** tmp + rename, so a reader never sees a truncated file and treats it as "nothing remembered". */
async function rememberLedger(realRoot: string, ledger: string): Promise<void> {
  const file = repoMemoryFile(realRoot);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // Re-read right before writing so a concurrent gate on the same repo is merged, not overwritten.
  const ledgers = [...new Set([...(await rememberedLedgers(realRoot)), ledger])];
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify({ repo: realRoot, ledgers }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(tmp, file);
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
}

/** Same rejection recorded in two ledgers: Apple's submission id, or the same day and guidelines. */
function sameRejection(a: RejectionState, b: RejectionState): boolean {
  if (a.submissionId && b.submissionId) return sameReviewDecision(a, b);
  const key = (r: RejectionState) => `${r.at.slice(0, 10)}|${[...r.guidelines].sort().join(",")}`;
  return key(a) === key(b);
}

/**
 * Remembers every ledger this repo has used (outside the repo, in the shield home). Pointing
 * the repo at a fresh ledger must not make an open rejection disappear from the gate, so an
 * open rejection in an earlier ledger that the current ledger does not also hold is reported.
 */
async function carriedRejections(repoRoot: string, current: string, remember: boolean): Promise<string[]> {
  let real = repoRoot;
  try {
    real = await realpath(repoRoot);
  } catch {
    // keep the resolved path
  }
  const used = await rememberedLedgers(real);
  const issues: string[] = [];
  const others = used.filter((p) => p !== current && existsSync(p));
  if (others.length) {
    let currentRejections: RejectionState[] = [];
    try {
      currentRejections = foldEvents("current", (await readLedger({ path: current })).events).rejections;
    } catch {
      // an unreadable current ledger is reported where it is read
    }
    for (const other of others) {
      let open: RejectionState[];
      try {
        // Same condition the gate holds on, so moving ledgers is neither stricter nor looser than staying.
        open = foldEvents("previous", (await readLedger({ path: other })).events).rejections.filter(
          (r) => !r.approvedBy && !r.acked && r.outcome === "rejected" && tierRank(r.verification?.tier) < tierRank("STATIC_CLEAN"),
        );
      } catch {
        continue;
      }
      const missing = open.filter((r) => !currentRejections.some((c) => sameRejection(r, c)));
      if (missing.length) {
        issues.push(
          `This repo used the ledger ${other} before, and it has ${missing.length} open rejection(s) (${missing.map((r) => `${r.id} ${r.at.slice(0, 10)} ${r.guidelines.join(", ") || "no guideline"}`).join("; ")}) that the current ledger ${current} does not hold. Changing teamId or ledgerPath does not close a rejection. Ask the developer to point ${CONFIG_REL} back at the right account, or import those App Review messages into the current ledger.`,
        );
      }
    }
  }
  if (remember && !used.includes(current)) {
    try {
      await rememberLedger(real, current);
    } catch {
      // remembering is best effort; the ledger itself still works
    }
  }
  return issues;
}

export interface InvalidLine {
  line: number;
  error: string;
  /** true for an unterminated final line, which is what an interrupted append leaves behind */
  torn: boolean;
}

export interface LedgerRead {
  events: LedgerEvent[];
  invalid: InvalidLine[];
}

/** Reads the ledger, skipping (and reporting) lines that do not parse or validate. Missing file = empty ledger. */
export async function readLedger(loc: Pick<LedgerLocation, "path">): Promise<LedgerRead> {
  let text: string;
  try {
    const fh = await open(loc.path, LEDGER_READ_FLAGS);
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw new NotARegularLedgerError(loc.path);
      if (st.size > LEDGER_MAX_BYTES) throw new OversizedLedgerError(loc.path, st.size);
      text = await fh.readFile("utf8");
    } finally {
      await fh.close();
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { events: [], invalid: [] };
    if (code === "ELOOP") throw new SymlinkLedgerError(loc.path);
    throw e;
  }
  const lines = text.split("\n");
  const endsClean = text.endsWith("\n");
  const events: LedgerEvent[] = [];
  const invalid: InvalidLine[] = [];
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const torn = !endsClean && i === lines.length - 1;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      // JSON.parse messages quote the line, which would echo whatever file the path points at.
      invalid.push({ line: i + 1, error: "not a JSON object", torn });
      return;
    }
    const parsed = LedgerEvent.safeParse(json);
    if (parsed.success) events.push(parsed.data);
    else invalid.push({ line: i + 1, error: parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; "), torn });
  });
  return { events, invalid };
}

/**
 * O_NONBLOCK: ledgerPath can come from a cloned repo's config, and opening or reading a FIFO
 * there would block the gate (and a thread-pool thread of the MCP server) forever.
 */
const LEDGER_READ_FLAGS = fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK;
/** Far beyond any real account's history; a larger file was not written by this tool. */
export const LEDGER_MAX_BYTES = 256 * 1024 * 1024;

// Both carry NotALedgerError's name: callers that turn a refused ledger into a HOLD match on it.
export class NotARegularLedgerError extends Error {
  constructor(p: string) {
    super(`The ledger path ${p} is not a regular file (a FIFO, device or directory). appstore-shield refuses to read or write it, because reading one can block forever. Point ledgerPath in ${CONFIG_REL} at a ledger file.`);
    this.name = "NotALedgerError";
  }
}

export class OversizedLedgerError extends Error {
  constructor(p: string, size: number) {
    super(`The ledger at ${p} is ${Math.round(size / 1024 / 1024)} MB, larger than the ${LEDGER_MAX_BYTES / 1024 / 1024} MB any appstore-shield ledger reaches. It was not written by this tool, so it is not read. Point ledgerPath in ${CONFIG_REL} at the real ledger.`);
    this.name = "NotALedgerError";
  }
}

export class SymlinkLedgerError extends Error {
  constructor(p: string) {
    super(`The ledger path ${p} is a symbolic link; appstore-shield refuses to read or write through it, because it could point at any file. Point ledgerPath in ${CONFIG_REL} at the real ledger file.`);
    this.name = "SymlinkLedgerError";
  }
}

export async function readEvents(loc: Pick<LedgerLocation, "path">): Promise<LedgerEvent[]> {
  return (await readLedger(loc)).events;
}

export function newEventId(now = Date.now()): string {
  return `ev_${now.toString(36)}_${randomBytes(4).toString("hex")}`;
}

export function textHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function validIso(s: unknown): s is string {
  return typeof s === "string" && !Number.isNaN(Date.parse(s));
}

/**
 * Validates, assigns id and at, and appends one JSON line. `source` comes from the
 * caller's own context, never from the event payload, so a payload cannot claim to be human.
 */
export async function appendEvent(
  loc: Pick<LedgerLocation, "path">,
  input: unknown,
  opts: { source: EventSource; imported?: boolean },
): Promise<LedgerEvent> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Ledger event must be a JSON object with a \"type\" field (e.g. {\"type\":\"note\",\"text\":\"…\"}).");
  }
  const raw = input as Record<string, unknown>;
  const type = String(raw.type ?? "");
  if (HUMAN_ONLY_EVENTS.includes(type as LedgerEventType) && opts.source !== "human") {
    throw new HumanOnlyEventError(type);
  }
  if (type === "outcome" && raw.outcome === "approved" && !approvalCounts({ source: opts.source })) {
    throw new ImportOnlyEventError();
  }
  // `via` says the text was parsed from Apple's own message; like `source`, a payload cannot claim it.
  const { via: _claimed, ...fields } = raw;
  const candidate: Record<string, unknown> = {
    ...fields,
    ...(opts.imported ? { via: "import" } : {}),
    id: newEventId(),
    at: validIso(raw.at) ? new Date(raw.at).toISOString() : new Date().toISOString(),
    source: opts.source,
  };
  if (type === "message_sent" && typeof raw.text === "string" && typeof raw.textHash !== "string") {
    candidate.textHash = textHash(raw.text);
  }
  const parsed = LedgerEvent.safeParse(candidate);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((x) => `${x.path.join(".") || "(event)"}: ${x.message}`).join("; ");
    throw new Error(`Invalid ledger event (${type || "missing type"}): ${detail}. Fix these fields and append again.`);
  }
  // The ledger holds reviewer messages and attestations: keep it private to the user.
  await mkdir(path.dirname(loc.path), { recursive: true, mode: 0o700 });
  // O_APPEND keeps each single write() of a line contiguous for one writer; a leading newline
  // seals a torn tail left by an interrupted append so the new event is not glued onto it.
  // O_NOFOLLOW: a repo-supplied path must not turn into a write to some other file via a symlink.
  let fh;
  try {
    fh = await open(loc.path, fsc.O_RDWR | fsc.O_APPEND | fsc.O_CREAT | fsc.O_NOFOLLOW | fsc.O_NONBLOCK, 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOOP") throw new SymlinkLedgerError(loc.path);
    throw e;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new NotARegularLedgerError(loc.path);
    const { size, mode } = st;
    // ledgerPath can come from a cloned repo's config: never append to, or chmod, a file that is not a ledger.
    if (size > 0 && !(await looksLikeLedger(fh, size))) throw new NotALedgerError(loc.path);
    if (mode & 0o077) await fh.chmod(0o600).catch(() => undefined);
    let prefix = "";
    if (size > 0) {
      const last = Buffer.alloc(1);
      await fh.read(last, 0, 1, size - 1);
      if (last[0] !== 0x0a) prefix = "\n";
    }
    await fh.write(`${prefix}${JSON.stringify(parsed.data)}\n`);
  } finally {
    await fh.close();
  }
  return parsed.data;
}

const EVENT_TYPES = new Set<string>(LedgerEvent.options.map((o) => o.shape.type.value));

/** First non-empty line is a JSON object with a string id and a known event type. */
async function looksLikeLedger(fh: import("node:fs/promises").FileHandle, size: number): Promise<boolean> {
  const buf = Buffer.alloc(Math.min(size, 65_536));
  const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
  const text = buf.subarray(0, bytesRead).toString("utf8");
  const first = text.split("\n").find((l) => l.trim());
  if (first === undefined) return true;
  try {
    const o = JSON.parse(first) as Record<string, unknown>;
    return !!o && typeof o === "object" && typeof o.id === "string" && typeof o.type === "string" && EVENT_TYPES.has(o.type);
  } catch {
    // An interrupted first append leaves one torn line; appendEvent seals it, so it is still ours.
    return !text.includes("\n") && /^\{"id":"ev_/.test(first.trim());
  }
}

export class NotALedgerError extends Error {
  constructor(p: string) {
    super(`${p} already exists and is not an appstore-shield ledger (its first line is not a ledger event). appstore-shield will not append to it or change its permissions. Point ledgerPath in ${CONFIG_REL} at a new file or an existing ledger.`);
    this.name = "NotALedgerError";
  }
}

export function ledgerExists(loc: Pick<LedgerLocation, "path">): boolean {
  return existsSync(loc.path);
}

const HOUR_MS = 3_600_000;

function messageKey(m: string | undefined): string {
  return (m ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Imports store a message that gave only a calendar date at 12:00 UTC. */
function dateOnly(at: string | undefined): boolean {
  return !!at && /T12:00:00(?:\.000)?Z$/.test(at);
}

/**
 * True when two rejection records of one App Store Connect submission describe the same review
 * decision, not a second rejection after a resubmission under the same id. An asc export row has
 * no message and stands for the submission's decision, so it joins any record of that submission.
 * Two messages join when identical and within 36 h (an .eml and a paste of one email), or when
 * different and within an hour (14 h if one side has only a calendar date): the email and the
 * Resolution Center text of one decision differ in wording but not in time.
 */
export function sameReviewDecision(
  a: { at?: string; submissionId?: string; reviewerMessage?: string },
  b: { at?: string; submissionId?: string; reviewerMessage?: string },
): boolean {
  if (!a.submissionId || !b.submissionId || a.submissionId !== b.submissionId) return false;
  const ma = messageKey(a.reviewerMessage);
  const mb = messageKey(b.reviewerMessage);
  if (!ma || !mb) return true;
  const gap = a.at && b.at ? Math.abs(Date.parse(a.at) - Date.parse(b.at)) : Number.NaN;
  // An undated message is stored at import time, so only its text can match it to a record.
  if (Number.isNaN(gap)) return ma === mb;
  if (ma === mb) return gap <= 36 * HOUR_MS;
  return gap <= (dateOnly(a.at) || dateOnly(b.at) ? 14 : 1) * HOUR_MS;
}

/** The latest rejection of the submission decided at or before the reply (a day of slack for date-only messages). */
function replyTarget(candidates: RejectionState[], at: string): RejectionState | undefined {
  const t = Date.parse(at);
  return candidates.filter((x) => Date.parse(x.at) <= t + 24 * HOUR_MS).at(-1) ?? candidates.at(-1);
}

function chronological(events: LedgerEvent[]): LedgerEvent[] {
  return events
    .map((e, i) => ({ e, i, t: Date.parse(e.at) }))
    .sort((a, b) => (a.t - b.t) || (a.i - b.i))
    .map((x) => x.e);
}

/** Pure fold. Events are ordered by `at` (file order breaks ties) because imports carry historical dates. */
export function foldEvents(teamId: string, eventsIn: LedgerEvent[]): LedgerState {
  const events = chronological(eventsIn);
  const apps = new Map<string, { bundleId: string; name?: string }>();
  const touchApp = (bundleId?: string, name?: string) => {
    if (!bundleId) return;
    const cur = apps.get(bundleId) ?? { bundleId };
    if (name) cur.name = name;
    apps.set(bundleId, cur);
  };

  const state: LedgerState = {
    teamId,
    events,
    apps: [],
    submissions: [],
    outcomes: [],
    rejections: [],
    metadataSnapshots: [],
    configSnapshots: [],
    otaPublishes: [],
    terminations: [],
  };
  const rejById = new Map<string, RejectionState>();

  for (const e of events) {
    switch (e.type) {
      case "app":
        touchApp(e.bundleId, e.name);
        break;
      case "submission":
        touchApp(e.bundleId);
        state.submissions.push(e);
        break;
      case "outcome":
        touchApp(e.bundleId);
        state.outcomes.push(e);
        if (e.outcome === "rejected" || e.outcome === "metadata_rejected") {
          // The asc export and the Resolution Center text describe the same rejection: merge them,
          // so the guidelines and reviewer message reach the one rejection the gate and triggers count.
          // A rejected submission is resubmitted under the same id, so a shared id alone does not make
          // two outcomes one rejection; a second rejection gets its own state, ack and verification.
          const same = [...state.rejections]
            .reverse()
            .find((x) => (!x.bundleId || !e.bundleId || x.bundleId === e.bundleId) && sameReviewDecision(x, e));
          if (same) {
            for (const g of e.guidelines) if (!same.guidelines.includes(g)) same.guidelines.push(g);
            if (!same.reviewerMessage && e.reviewerMessage) {
              same.reviewerMessage = e.reviewerMessage;
              same.reviewerMessageEventId = e.id;
            }
            if (!same.bundleId && e.bundleId) same.bundleId = e.bundleId;
            rejById.set(e.id, same);
            break;
          }
          const r: RejectionState = {
            id: e.id,
            at: e.at,
            bundleId: e.bundleId,
            submissionId: e.submissionId,
            outcome: e.outcome,
            guidelines: [...e.guidelines],
            reviewerMessage: e.reviewerMessage,
            ...(e.reviewerMessage ? { reviewerMessageEventId: e.id } : {}),
            messages: [],
            appleReplies: [],
            attestations: [],
            acked: false,
          };
          rejById.set(e.id, r);
          state.rejections.push(r);
        }
        break;
      case "metadata_snapshot":
        touchApp(e.bundleId);
        state.metadataSnapshots.push(e);
        break;
      case "config_snapshot":
        state.configSnapshots.push(e);
        break;
      case "ota_publish":
        state.otaPublishes.push(e);
        break;
      case "termination":
        state.terminations.push(e);
        break;
      default:
        break;
    }
  }

  // A single-app ledger may have events without a bundle id; treat them as that app.
  const singleApp = apps.size <= 1;
  const sameApp = (a?: string, b?: string) => a === b || (singleApp && (!a || !b));

  for (const e of events) {
    const rid = "rejectionId" in e ? e.rejectionId : undefined;
    const r = rid
      ? rejById.get(rid)
      : e.type === "apple_reply" && e.submissionId
        ? replyTarget(state.rejections.filter((x) => x.submissionId === e.submissionId), e.at)
        : undefined;
    if (!r) continue;
    switch (e.type) {
      case "interpretation":
        r.interpretation = e.text;
        break;
      case "residue_spec":
        r.spec = e.spec;
        break;
      case "verification":
        r.verification = e.verification;
        break;
      case "message_sent":
        r.messages.push({ purpose: e.purpose, at: e.at, eventId: e.id });
        break;
      case "apple_reply":
        r.appleReplies.push({ at: e.at, eventId: e.id });
        break;
      case "attestation":
        r.attestations.push({ statement: e.statement, at: e.at, eventId: e.id });
        break;
      case "ack":
        if (e.source === "human") r.acked = true;
        break;
      default:
        break;
    }
  }

  for (const r of state.rejections) {
    const t = Date.parse(r.at);
    const approval = state.outcomes.find(
      (o) => o.outcome === "approved" && approvalCounts(o) && Date.parse(o.at) > t && sameApp(o.bundleId, r.bundleId),
    );
    if (approval) r.approvedBy = approval.id;
  }

  for (const s of state.metadataSnapshots) {
    if (!s.bundleId) continue;
    const named = s.snapshots.find((x) => x.name);
    if (named?.name && !apps.get(s.bundleId)?.name) touchApp(s.bundleId, named.name);
  }
  state.apps = [...apps.values()].sort((a, b) => a.bundleId.localeCompare(b.bundleId));
  return state;
}

export async function loadState(
  loc: Pick<LedgerLocation, "teamId" | "path"> & Partial<Pick<LedgerLocation, "integrity">>,
): Promise<{ state: LedgerStateWithLocation; invalid: InvalidLine[] }> {
  let read: LedgerRead;
  const issues = [...(loc.integrity ?? [])];
  try {
    read = await readLedger(loc);
  } catch (e) {
    // A ledger the tool refuses to read must HOLD the gate, not end it with no verdict.
    if (!(e instanceof NotARegularLedgerError || e instanceof OversizedLedgerError || e instanceof SymlinkLedgerError)) throw e;
    read = { events: [], invalid: [] };
    if (!issues.includes(e.message)) issues.push(e.message);
  }
  const state: LedgerStateWithLocation = foldEvents(loc.teamId, read.events);
  if (issues.length) state.locationIssues = issues;
  return { state, invalid: read.invalid };
}

/**
 * Probe results are a file anyone with shell access can write, so they count as evidence only
 * after the developer confirms them in a terminal: a human attestation naming the results hash
 * (its first 12 hex characters are enough). Returns that attestation's id.
 */
export function probeConfirmation(events: LedgerEvent[], resultsHash: string | undefined): string | undefined {
  const short = resultsHash?.slice(0, 12).toLowerCase();
  if (!short || short.length < 12) return undefined;
  return events.find((e) => e.type === "attestation" && e.source === "human" && e.statement.toLowerCase().includes(short))?.id;
}

export const TIER_ORDER = ["RESIDUE_FOUND", "UNVERIFIABLE", "STATIC_CLEAN", "BUILD_CLEAN", "PROBED"] as const;
export function tierRank(tier: string | undefined): number {
  return tier ? TIER_ORDER.indexOf(tier as (typeof TIER_ORDER)[number]) : -1;
}

#!/usr/bin/env node
import { createRequire as __shieldCreateRequire } from "node:module";
const require = __shieldCreateRequire(import.meta.url);
import {
  external_exports
} from "./chunk-TGZWIHKL.js";

// src/ledger/store.ts
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsc, existsSync } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

// src/ledger/schema.ts
var isoDate = external_exports.string().refine((s) => !Number.isNaN(Date.parse(s)), "not an ISO-8601 timestamp").describe("ISO-8601 timestamp");
var EventSource = external_exports.enum(["human", "agent", "hook", "import", "ci"]).describe("Who appended the event. attestation/ack events must be human (CLI with a TTY).");
var ResidueSpec = external_exports.object({
  feature: external_exports.string().describe("Short name of the rejected feature"),
  capability: external_exports.string().describe("What must become impossible for a user to do or produce, not which screen was hidden"),
  terms: external_exports.array(external_exports.string()).default([]),
  symbols: external_exports.array(external_exports.string()).default([]),
  assets: external_exports.array(external_exports.string()).default([]).describe("Asset names or globs, e.g. outfit_lingerie_*"),
  strings: external_exports.array(external_exports.string()).default([]).describe("Localization keys"),
  endpoints: external_exports.array(external_exports.string()).default([]),
  flags: external_exports.array(external_exports.string()).default([]).describe("Remote-config / feature-flag keys"),
  promptFragments: external_exports.array(external_exports.string()).default([]),
  inputPaths: external_exports.array(external_exports.string()).default([]).describe("Every way a user could still reach the capability: free-text prompt, remix, picker, image upload, deep link\u2026"),
  confirmedPaths: external_exports.array(external_exports.object({ source: external_exports.string(), sink: external_exports.string(), evidence: external_exports.array(external_exports.string()) })).default([]).describe("Source\u2192sink paths traced by the agent, with file:line evidence; re-checked on every verify"),
  metadataSurfaces: external_exports.array(external_exports.string()).default([]).describe("Store surfaces that may still show the feature: screenshots, preview video, promo text, IAP names\u2026")
});
var ResidueStatus = external_exports.enum(["PRESENT", "GATED", "DEBUG_ONLY", "UNREFERENCED"]);
var ResidueHit = external_exports.object({
  kind: external_exports.enum(["term", "symbol", "asset", "string", "endpoint", "flag", "promptFragment", "metadata", "binary", "obfuscation"]),
  needle: external_exports.string(),
  file: external_exports.string(),
  line: external_exports.number().optional(),
  evidence: external_exports.string().optional(),
  status: ResidueStatus,
  confidence: external_exports.enum(["high", "medium", "low"]),
  reason: external_exports.string()
});
var EvidenceTier = external_exports.enum(["RESIDUE_FOUND", "UNVERIFIABLE", "STATIC_CLEAN", "BUILD_CLEAN", "PROBED"]);
var Verification = external_exports.object({
  at: isoDate,
  sha: external_exports.string().optional(),
  baseRef: external_exports.string().optional(),
  tier: EvidenceTier,
  removedInDiff: external_exports.array(external_exports.string()).describe("Files/lines in the diff that removed residue items"),
  // Review-time conditions (review_gating, remote content gating) present at baseRef and gone now.
  // They are not residue of the spec, but 2.5.19 makes them the disclosure that matters most.
  removedConditions: external_exports.array(external_exports.object({ rule: external_exports.string(), file: external_exports.string(), line: external_exports.number().optional(), condition: external_exports.string(), gates: external_exports.string().optional() })).optional().describe("Review-time conditions found at baseRef (review_gating.*, remote_config.content_gating) that the diff removed"),
  residue: external_exports.array(ResidueHit),
  inputPaths: external_exports.array(external_exports.object({ inputPath: external_exports.string(), blocked: external_exports.boolean(), evidence: external_exports.array(external_exports.string()) })),
  unverifiable: external_exports.array(external_exports.string()).describe("Items needing developer attestation, e.g. server prompts outside the repo"),
  builtProduct: external_exports.object({ path: external_exports.string(), kind: external_exports.string(), hermes: external_exports.boolean(), hits: external_exports.number(), notes: external_exports.array(external_exports.string()) }).optional(),
  probe: external_exports.object({ total: external_exports.number(), blocked: external_exports.number(), resultsHash: external_exports.string() }).optional(),
  summary: external_exports.string()
});
var MetadataSnapshot = external_exports.object({
  locale: external_exports.string().default("default"),
  name: external_exports.string().optional(),
  subtitle: external_exports.string().optional(),
  displayName: external_exports.string().optional(),
  keywords: external_exports.string().optional(),
  promotionalText: external_exports.string().optional(),
  descriptionHash: external_exports.string().optional(),
  source: external_exports.string().describe("Where it was read from, e.g. metadata/app-info/en-US.json or Info.plist")
});
var RemoteControl = external_exports.object({
  key: external_exports.string(),
  provider: external_exports.string(),
  file: external_exports.string().optional(),
  line: external_exports.number().optional(),
  defaultValue: external_exports.string().optional(),
  gates: external_exports.string().describe("What the gated scope does, as far as code shows"),
  classification: external_exports.enum(["content-gating", "price-gating", "safety-killswitch", "product", "unknown"])
});
var base = {
  id: external_exports.string(),
  at: isoDate,
  source: EventSource,
  bundleId: external_exports.string().optional(),
  repo: external_exports.string().optional().describe("Repo root the event was recorded from"),
  // Set only by the importer: the text was parsed from Apple's own message or export, not typed in.
  via: external_exports.literal("import").optional().describe("Set by the importer; never accepted from a payload")
};
var LedgerEvent = external_exports.discriminatedUnion("type", [
  external_exports.object({
    ...base,
    type: external_exports.literal("submission"),
    version: external_exports.string().optional(),
    build: external_exports.string().optional(),
    sha: external_exports.string().optional(),
    channel: external_exports.enum(["app_review", "testflight_external"]).default("app_review"),
    notesEventId: external_exports.string().optional()
  }),
  external_exports.object({
    ...base,
    type: external_exports.literal("outcome"),
    submissionId: external_exports.string().optional(),
    outcome: external_exports.enum(["approved", "rejected", "withdrawn", "developer_rejected", "metadata_rejected"]),
    reviewerMessage: external_exports.string().optional().describe("Verbatim App Review message"),
    guidelines: external_exports.array(external_exports.string()).default([]),
    screenshots: external_exports.array(external_exports.string()).default([])
  }),
  external_exports.object({
    ...base,
    type: external_exports.literal("interpretation"),
    rejectionId: external_exports.string().describe("id of the outcome event with outcome=rejected"),
    text: external_exports.string().describe("Capability-level reading of the rejection, written before the fix")
  }),
  external_exports.object({
    ...base,
    type: external_exports.literal("message_sent"),
    rejectionId: external_exports.string().optional(),
    purpose: external_exports.enum(["review_notes", "reply", "clarification", "appeal_review_board", "appeal_termination"]),
    text: external_exports.string().describe("Exact text sent to Apple"),
    textHash: external_exports.string()
  }),
  external_exports.object({
    ...base,
    type: external_exports.literal("apple_reply"),
    rejectionId: external_exports.string().optional(),
    // An imported reply can name its submission before the rejection's event id exists.
    submissionId: external_exports.string().optional().describe("App Store Connect submission id; links the reply to that submission's rejection"),
    text: external_exports.string()
  }),
  external_exports.object({ ...base, type: external_exports.literal("residue_spec"), rejectionId: external_exports.string(), spec: ResidueSpec }),
  external_exports.object({ ...base, type: external_exports.literal("verification"), rejectionId: external_exports.string(), verification: Verification }),
  external_exports.object({
    ...base,
    type: external_exports.literal("config_snapshot"),
    kind: external_exports.enum(["remote_config", "server_prompt", "model_id", "ota", "paywall", "flags_inventory"]),
    label: external_exports.string(),
    hash: external_exports.string(),
    summary: external_exports.string(),
    data: external_exports.unknown().optional()
  }),
  external_exports.object({ ...base, type: external_exports.literal("metadata_snapshot"), snapshots: external_exports.array(MetadataSnapshot) }),
  external_exports.object({
    ...base,
    type: external_exports.literal("ota_publish"),
    channel: external_exports.string().optional(),
    runtimeVersion: external_exports.string().optional(),
    updateId: external_exports.string().optional(),
    message: external_exports.string().optional()
  }),
  external_exports.object({ ...base, type: external_exports.literal("attestation"), rejectionId: external_exports.string().optional(), statement: external_exports.string() }),
  external_exports.object({ ...base, type: external_exports.literal("ack"), rejectionId: external_exports.string(), note: external_exports.string() }),
  external_exports.object({ ...base, type: external_exports.literal("termination"), letter: external_exports.string() }),
  external_exports.object({ ...base, type: external_exports.literal("app"), bundleId: external_exports.string(), name: external_exports.string().optional(), note: external_exports.string().optional() }),
  external_exports.object({ ...base, type: external_exports.literal("note"), text: external_exports.string() })
]);
var HUMAN_ONLY_EVENTS = ["attestation", "ack"];

// src/ledger/store.ts
var CONFIG_REL = ".appstore-shield/config.json";
var HumanOnlyEventError = class extends Error {
  constructor(type) {
    super(
      `"${type}" events record human judgment and can only be added by the developer: run \`appstore-shield ${type === "ack" ? "ack" : "attest"}\` in a terminal (it asks for a typed confirmation). Agents and MCP callers cannot append them.`
    );
    this.name = "HumanOnlyEventError";
  }
};
var ImportOnlyEventError = class extends HumanOnlyEventError {
  constructor() {
    super("outcome");
    this.message = "Approvals close open rejections, so agents and MCP callers cannot record them. Import Apple's own approval message instead: the developer runs `appstore-shield import <saved email or asc export>` in a terminal.";
    this.name = "ImportOnlyEventError";
  }
};
var APPROVAL_SOURCES = /* @__PURE__ */ new Set(["human", "import"]);
function approvalCounts(e) {
  return APPROVAL_SOURCES.has(e.source);
}
var ShieldHomeError = class extends Error {
  constructor(value) {
    super(
      `APPSTORE_SHIELD_HOME is "${value}", which is not an absolute path. A relative home would move the ledger with the current directory, so a gate run elsewhere would read an empty history. Set it to an absolute path (a leading ~/ is expanded).`
    );
    this.name = "ShieldHomeError";
  }
};
function shieldHome(env = process.env) {
  const raw = env.APPSTORE_SHIELD_HOME?.trim();
  if (!raw) return path.join(homedir(), ".appstore-shield");
  const expanded = raw.replace(/^~(?=$|[/\\])/, homedir());
  if (!path.isAbsolute(expanded)) throw new ShieldHomeError(raw);
  return path.resolve(expanded);
}
var TEAM_ID_RX = /^[A-Z0-9]{10}$/;
var SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
var MAX_JSON_BYTES = 1e6;
async function readJson(file) {
  try {
    const st = await stat(file);
    if (!st.isFile() || st.size > MAX_JSON_BYTES) return void 0;
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return void 0;
  }
}
function get(obj, ...keys) {
  let cur = obj;
  for (const k of keys) {
    if (!cur || typeof cur !== "object") return void 0;
    cur = cur[k];
  }
  return cur;
}
async function readRepoConfig(repoRoot) {
  const cfg = await readJson(path.join(repoRoot, CONFIG_REL));
  return cfg && typeof cfg === "object" && !Array.isArray(cfg) ? cfg : void 0;
}
var SKIP_DIRS = /* @__PURE__ */ new Set(["node_modules", "Pods", ".git", "build", "DerivedData", "dist", ".build", "Carthage", "vendor"]);
async function findXcodeProjects(root, depth = 2) {
  const out = [];
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
    else if (depth > 0) out.push(...await findXcodeProjects(abs, depth - 1));
  }
  return out;
}
async function teamFromPbxproj(root) {
  const counts = /* @__PURE__ */ new Map();
  let firstFile = "";
  for (const proj of await findXcodeProjects(root)) {
    let text;
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
  if (counts.size === 0) return void 0;
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [teamId] = ranked[0];
  return { teamId, file: firstFile, others: ranked.slice(1).map(([id]) => id) };
}
async function teamFromExpo(root) {
  for (const file of ["app.json", "app.config.json"]) {
    const json = await readJson(path.join(root, file));
    const v = get(json, "expo", "ios", "appleTeamId") ?? get(json, "ios", "appleTeamId");
    if (typeof v === "string" && v.trim()) return { teamId: v.trim(), file: `${file} ios.appleTeamId` };
  }
  const eas = await readJson(path.join(root, "eas.json"));
  const submit = get(eas, "submit");
  if (submit && typeof submit === "object") {
    for (const [profile, cfg] of Object.entries(submit)) {
      const v = get(cfg, "ios", "appleTeamId");
      if (typeof v === "string" && v.trim()) return { teamId: v.trim(), file: `eas.json submit.${profile}.ios.appleTeamId` };
    }
  }
  return void 0;
}
function gitRemotes(repoRoot) {
  return new Promise((resolve) => {
    execFile("git", ["-C", repoRoot, "remote", "-v"], { timeout: 3e3 }, (err, stdout) => resolve(err ? "" : String(stdout)));
  });
}
function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || !rel.startsWith("..") && !path.isAbsolute(rel);
}
async function locateLedger(repoRootIn, opts = {}) {
  const repoRoot = path.resolve(repoRootIn);
  const warnings = [];
  const cfg = await readRepoConfig(repoRoot);
  let teamId;
  let teamIdSource = "";
  const integrity = [];
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
          `Xcode targets use more than one DEVELOPMENT_TEAM (${[pbx.teamId, ...pbx.others].join(", ")}); using ${pbx.teamId}. Set teamId in ${CONFIG_REL} if the App Store account is a different one.`
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
    }
    teamId = `repo-${createHash("sha1").update(real).digest("hex").slice(0, 8)}`;
    teamIdSource = "repo-hash fallback";
    warnings.push(
      `No Apple Team ID found (checked ${CONFIG_REL}, DEVELOPMENT_TEAM in *.xcodeproj, ios.appleTeamId in app.json/app.config.json/eas.json). History is being kept per repo, so other apps on the same developer account are not counted. Add {"teamId": "<your 10-character Team ID>"} to ${CONFIG_REL}.`
    );
  }
  if (teamId !== teamId.toUpperCase() && TEAM_ID_RX.test(teamId.toUpperCase())) {
    teamId = teamId.toUpperCase();
  }
  if (teamIdSource.startsWith(CONFIG_REL)) {
    const project = (await teamFromPbxproj(repoRoot))?.teamId ?? (await teamFromExpo(repoRoot))?.teamId;
    if (project && project.toUpperCase() !== teamId.toUpperCase()) {
      warnings.push(
        `teamId ${teamId} in ${CONFIG_REL} differs from the project's own team ${project}. History for ${project} is not being checked. If ${teamId} is not the App Store account that submits this app, correct ${CONFIG_REL}.`
      );
    }
  }
  let ledgerFile = path.join(shieldHome(), "teams", teamId, "events.jsonl");
  if (typeof cfg?.ledgerPath === "string" && cfg.ledgerPath.trim()) {
    const raw = cfg.ledgerPath.trim().replace(/^~(?=$|\/)/, homedir());
    const base2 = path.resolve(repoRoot, raw);
    ledgerFile = base2.endsWith(".jsonl") ? base2 : path.join(base2, "teams", teamId, "events.jsonl");
    if (isInside(ledgerFile, repoRoot)) {
      const remotes = await gitRemotes(repoRoot);
      const publicHost = /(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)/i.exec(remotes)?.[1];
      if (publicHost) {
        warnings.push(
          `ledgerPath points inside this repo and the repo has a ${publicHost} remote. If that remote is public, App Review messages, attestations and termination letters would be published. Keep the ledger in a private location (e.g. a private compliance repo) or make sure this remote is private.`
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
  integrity.push(...await carriedRejections(repoRoot, ledgerFile, opts.remember ?? true));
  return { teamId, teamIdSource, path: ledgerFile, warnings, integrity };
}
async function ledgerFileProblem(p) {
  let fh;
  try {
    fh = await open(p, LEDGER_READ_FLAGS);
  } catch {
    return void 0;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return new NotARegularLedgerError(p).message;
    if (st.size > LEDGER_MAX_BYTES) return new OversizedLedgerError(p, st.size).message;
    return st.size > 0 && !await looksLikeLedger(fh, st.size) ? new NotALedgerError(p).message : void 0;
  } catch {
    return void 0;
  } finally {
    await fh.close();
  }
}
async function isSymlink(p) {
  try {
    return (await lstat(p)).isSymbolicLink();
  } catch {
    return false;
  }
}
function legacyReposFile() {
  return path.join(shieldHome(), "repos.json");
}
function repoMemoryFile(realRoot) {
  return path.join(shieldHome(), "repos", `${createHash("sha256").update(realRoot).digest("hex").slice(0, 32)}.json`);
}
function stringList(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}
async function rememberedLedgers(realRoot) {
  const own = await readJson(repoMemoryFile(realRoot));
  const ownList = own && typeof own === "object" && own.repo === realRoot ? stringList(own.ledgers) : [];
  const legacy = await readJson(legacyReposFile());
  const legacyList = legacy && typeof legacy === "object" && !Array.isArray(legacy) ? stringList(legacy[realRoot]) : [];
  return [.../* @__PURE__ */ new Set([...legacyList, ...ownList])];
}
async function rememberLedger(realRoot, ledger) {
  const file = repoMemoryFile(realRoot);
  await mkdir(path.dirname(file), { recursive: true, mode: 448 });
  const ledgers = [.../* @__PURE__ */ new Set([...await rememberedLedgers(realRoot), ledger])];
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify({ repo: realRoot, ledgers }, null, 2)}
`, { mode: 384, flag: "wx" });
    await rename(tmp, file);
  } catch (e) {
    await unlink(tmp).catch(() => void 0);
    throw e;
  }
}
function sameRejection(a, b) {
  if (a.submissionId && b.submissionId) return sameReviewDecision(a, b);
  const key = (r) => `${r.at.slice(0, 10)}|${[...r.guidelines].sort().join(",")}`;
  return key(a) === key(b);
}
async function carriedRejections(repoRoot, current, remember) {
  let real = repoRoot;
  try {
    real = await realpath(repoRoot);
  } catch {
  }
  const used = await rememberedLedgers(real);
  const issues = [];
  const others = used.filter((p) => p !== current && existsSync(p));
  if (others.length) {
    let currentRejections = [];
    try {
      currentRejections = foldEvents("current", (await readLedger({ path: current })).events).rejections;
    } catch {
    }
    for (const other of others) {
      let open2;
      try {
        open2 = foldEvents("previous", (await readLedger({ path: other })).events).rejections.filter(
          (r) => !r.approvedBy && !r.acked && r.outcome === "rejected" && tierRank(r.verification?.tier) < tierRank("STATIC_CLEAN")
        );
      } catch {
        continue;
      }
      const missing = open2.filter((r) => !currentRejections.some((c) => sameRejection(r, c)));
      if (missing.length) {
        issues.push(
          `This repo used the ledger ${other} before, and it has ${missing.length} open rejection(s) (${missing.map((r) => `${r.id} ${r.at.slice(0, 10)} ${r.guidelines.join(", ") || "no guideline"}`).join("; ")}) that the current ledger ${current} does not hold. Changing teamId or ledgerPath does not close a rejection. Ask the developer to point ${CONFIG_REL} back at the right account, or import those App Review messages into the current ledger.`
        );
      }
    }
  }
  if (remember && !used.includes(current)) {
    try {
      await rememberLedger(real, current);
    } catch {
    }
  }
  return issues;
}
async function readLedger(loc) {
  let text;
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
    const code = e.code;
    if (code === "ENOENT") return { events: [], invalid: [] };
    if (code === "ELOOP") throw new SymlinkLedgerError(loc.path);
    throw e;
  }
  const lines = text.split("\n");
  const endsClean = text.endsWith("\n");
  const events = [];
  const invalid = [];
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const torn = !endsClean && i === lines.length - 1;
    let json;
    try {
      json = JSON.parse(line);
    } catch {
      invalid.push({ line: i + 1, error: "not a JSON object", torn });
      return;
    }
    const parsed = LedgerEvent.safeParse(json);
    if (parsed.success) events.push(parsed.data);
    else invalid.push({ line: i + 1, error: parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; "), torn });
  });
  return { events, invalid };
}
var LEDGER_READ_FLAGS = fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK;
var LEDGER_MAX_BYTES = 256 * 1024 * 1024;
var NotARegularLedgerError = class extends Error {
  constructor(p) {
    super(`The ledger path ${p} is not a regular file (a FIFO, device or directory). appstore-shield refuses to read or write it, because reading one can block forever. Point ledgerPath in ${CONFIG_REL} at a ledger file.`);
    this.name = "NotALedgerError";
  }
};
var OversizedLedgerError = class extends Error {
  constructor(p, size) {
    super(`The ledger at ${p} is ${Math.round(size / 1024 / 1024)} MB, larger than the ${LEDGER_MAX_BYTES / 1024 / 1024} MB any appstore-shield ledger reaches. It was not written by this tool, so it is not read. Point ledgerPath in ${CONFIG_REL} at the real ledger.`);
    this.name = "NotALedgerError";
  }
};
var SymlinkLedgerError = class extends Error {
  constructor(p) {
    super(`The ledger path ${p} is a symbolic link; appstore-shield refuses to read or write through it, because it could point at any file. Point ledgerPath in ${CONFIG_REL} at the real ledger file.`);
    this.name = "SymlinkLedgerError";
  }
};
async function readEvents(loc) {
  return (await readLedger(loc)).events;
}
function newEventId(now = Date.now()) {
  return `ev_${now.toString(36)}_${randomBytes(4).toString("hex")}`;
}
function textHash(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
function validIso(s) {
  return typeof s === "string" && !Number.isNaN(Date.parse(s));
}
async function appendEvent(loc, input, opts) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error('Ledger event must be a JSON object with a "type" field (e.g. {"type":"note","text":"\u2026"}).');
  }
  const raw = input;
  const type = String(raw.type ?? "");
  if (HUMAN_ONLY_EVENTS.includes(type) && opts.source !== "human") {
    throw new HumanOnlyEventError(type);
  }
  if (type === "outcome" && raw.outcome === "approved" && !approvalCounts({ source: opts.source })) {
    throw new ImportOnlyEventError();
  }
  const { via: _claimed, ...fields } = raw;
  const candidate = {
    ...fields,
    ...opts.imported ? { via: "import" } : {},
    id: newEventId(),
    at: validIso(raw.at) ? new Date(raw.at).toISOString() : (/* @__PURE__ */ new Date()).toISOString(),
    source: opts.source
  };
  if (type === "message_sent" && typeof raw.text === "string" && typeof raw.textHash !== "string") {
    candidate.textHash = textHash(raw.text);
  }
  const parsed = LedgerEvent.safeParse(candidate);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((x) => `${x.path.join(".") || "(event)"}: ${x.message}`).join("; ");
    throw new Error(`Invalid ledger event (${type || "missing type"}): ${detail}. Fix these fields and append again.`);
  }
  await mkdir(path.dirname(loc.path), { recursive: true, mode: 448 });
  let fh;
  try {
    fh = await open(loc.path, fsc.O_RDWR | fsc.O_APPEND | fsc.O_CREAT | fsc.O_NOFOLLOW | fsc.O_NONBLOCK, 384);
  } catch (e) {
    if (e.code === "ELOOP") throw new SymlinkLedgerError(loc.path);
    throw e;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new NotARegularLedgerError(loc.path);
    const { size, mode } = st;
    if (size > 0 && !await looksLikeLedger(fh, size)) throw new NotALedgerError(loc.path);
    if (mode & 63) await fh.chmod(384).catch(() => void 0);
    let prefix = "";
    if (size > 0) {
      const last = Buffer.alloc(1);
      await fh.read(last, 0, 1, size - 1);
      if (last[0] !== 10) prefix = "\n";
    }
    await fh.write(`${prefix}${JSON.stringify(parsed.data)}
`);
  } finally {
    await fh.close();
  }
  return parsed.data;
}
var EVENT_TYPES = new Set(LedgerEvent.options.map((o) => o.shape.type.value));
async function looksLikeLedger(fh, size) {
  const buf = Buffer.alloc(Math.min(size, 65536));
  const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
  const text = buf.subarray(0, bytesRead).toString("utf8");
  const first = text.split("\n").find((l) => l.trim());
  if (first === void 0) return true;
  try {
    const o = JSON.parse(first);
    return !!o && typeof o === "object" && typeof o.id === "string" && typeof o.type === "string" && EVENT_TYPES.has(o.type);
  } catch {
    return !text.includes("\n") && /^\{"id":"ev_/.test(first.trim());
  }
}
var NotALedgerError = class extends Error {
  constructor(p) {
    super(`${p} already exists and is not an appstore-shield ledger (its first line is not a ledger event). appstore-shield will not append to it or change its permissions. Point ledgerPath in ${CONFIG_REL} at a new file or an existing ledger.`);
    this.name = "NotALedgerError";
  }
};
function ledgerExists(loc) {
  return existsSync(loc.path);
}
var HOUR_MS = 36e5;
function messageKey(m) {
  return (m ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}
function dateOnly(at) {
  return !!at && /T12:00:00(?:\.000)?Z$/.test(at);
}
function sameReviewDecision(a, b) {
  if (!a.submissionId || !b.submissionId || a.submissionId !== b.submissionId) return false;
  const ma = messageKey(a.reviewerMessage);
  const mb = messageKey(b.reviewerMessage);
  if (!ma || !mb) return true;
  const gap = a.at && b.at ? Math.abs(Date.parse(a.at) - Date.parse(b.at)) : Number.NaN;
  if (Number.isNaN(gap)) return ma === mb;
  if (ma === mb) return gap <= 36 * HOUR_MS;
  return gap <= (dateOnly(a.at) || dateOnly(b.at) ? 14 : 1) * HOUR_MS;
}
function replyTarget(candidates, at) {
  const t = Date.parse(at);
  return candidates.filter((x) => Date.parse(x.at) <= t + 24 * HOUR_MS).at(-1) ?? candidates.at(-1);
}
function chronological(events) {
  return events.map((e, i) => ({ e, i, t: Date.parse(e.at) })).sort((a, b) => a.t - b.t || a.i - b.i).map((x) => x.e);
}
function foldEvents(teamId, eventsIn) {
  const events = chronological(eventsIn);
  const apps = /* @__PURE__ */ new Map();
  const touchApp = (bundleId, name) => {
    if (!bundleId) return;
    const cur = apps.get(bundleId) ?? { bundleId };
    if (name) cur.name = name;
    apps.set(bundleId, cur);
  };
  const state = {
    teamId,
    events,
    apps: [],
    submissions: [],
    outcomes: [],
    rejections: [],
    metadataSnapshots: [],
    configSnapshots: [],
    otaPublishes: [],
    terminations: []
  };
  const rejById = /* @__PURE__ */ new Map();
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
          const same = [...state.rejections].reverse().find((x) => (!x.bundleId || !e.bundleId || x.bundleId === e.bundleId) && sameReviewDecision(x, e));
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
          const r = {
            id: e.id,
            at: e.at,
            bundleId: e.bundleId,
            submissionId: e.submissionId,
            outcome: e.outcome,
            guidelines: [...e.guidelines],
            reviewerMessage: e.reviewerMessage,
            ...e.reviewerMessage ? { reviewerMessageEventId: e.id } : {},
            messages: [],
            appleReplies: [],
            attestations: [],
            acked: false
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
  const singleApp = apps.size <= 1;
  const sameApp = (a, b) => a === b || singleApp && (!a || !b);
  for (const e of events) {
    const rid = "rejectionId" in e ? e.rejectionId : void 0;
    const r = rid ? rejById.get(rid) : e.type === "apple_reply" && e.submissionId ? replyTarget(state.rejections.filter((x) => x.submissionId === e.submissionId), e.at) : void 0;
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
      (o) => o.outcome === "approved" && approvalCounts(o) && Date.parse(o.at) > t && sameApp(o.bundleId, r.bundleId)
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
async function loadState(loc) {
  let read;
  const issues = [...loc.integrity ?? []];
  try {
    read = await readLedger(loc);
  } catch (e) {
    if (!(e instanceof NotARegularLedgerError || e instanceof OversizedLedgerError || e instanceof SymlinkLedgerError)) throw e;
    read = { events: [], invalid: [] };
    if (!issues.includes(e.message)) issues.push(e.message);
  }
  const state = foldEvents(loc.teamId, read.events);
  if (issues.length) state.locationIssues = issues;
  return { state, invalid: read.invalid };
}
function probeConfirmation(events, resultsHash) {
  const short = resultsHash?.slice(0, 12).toLowerCase();
  if (!short || short.length < 12) return void 0;
  return events.find((e) => e.type === "attestation" && e.source === "human" && e.statement.toLowerCase().includes(short))?.id;
}
var TIER_ORDER = ["RESIDUE_FOUND", "UNVERIFIABLE", "STATIC_CLEAN", "BUILD_CLEAN", "PROBED"];
function tierRank(tier) {
  return tier ? TIER_ORDER.indexOf(tier) : -1;
}

export {
  ResidueSpec,
  MetadataSnapshot,
  RemoteControl,
  HUMAN_ONLY_EVENTS,
  CONFIG_REL,
  HumanOnlyEventError,
  ImportOnlyEventError,
  approvalCounts,
  ShieldHomeError,
  shieldHome,
  readRepoConfig,
  locateLedger,
  readLedger,
  LEDGER_MAX_BYTES,
  NotARegularLedgerError,
  OversizedLedgerError,
  SymlinkLedgerError,
  readEvents,
  newEventId,
  textHash,
  appendEvent,
  NotALedgerError,
  ledgerExists,
  sameReviewDecision,
  foldEvents,
  loadState,
  probeConfirmation,
  TIER_ORDER,
  tierRank
};

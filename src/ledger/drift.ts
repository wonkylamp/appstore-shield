import { createHash } from "node:crypto";
import path from "node:path";
import type { ScanContext, SourceFile } from "../project.js";
import type { LedgerEvent, LedgerState, RemoteControl } from "./schema.js";

/**
 * Post-approval drift. Apple "distrusts fixes made on a server" [source] and DPLA 3.2(e)
 * forbids deceiving "through post-review modifications" [apple]. This module only reports
 * what changed since the last approval; it never says a change is acceptable without review.
 */

type ConfigSnapshotEvent = Extract<LedgerEvent, { type: "config_snapshot" }>;
export type SnapshotKind = ConfigSnapshotEvent["kind"];

/** A config_snapshot event without id/at/source, ready for appendEvent. */
export interface SnapshotInput {
  type: "config_snapshot";
  kind: SnapshotKind;
  label: string;
  hash: string;
  summary: string;
  data?: unknown;
  bundleId?: string;
  repo?: string;
}

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

export function stableHash(v: unknown): string {
  return createHash("sha256").update(stableStringify(v)).digest("hex").slice(0, 16);
}

/**
 * The hash covers the raw data so any change is caught; the stored data is redacted, because
 * the ledger keeps every snapshot forever and prompt, paywall and config files hold keys.
 */
function snap(kind: SnapshotKind, label: string, summary: string, data: unknown): SnapshotInput {
  return { type: "config_snapshot", kind, label, hash: stableHash(data), summary, data: redactDeep(data) };
}

const SECRET_RX: RegExp[] = [
  /\bhttps?:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9/_-]+/g,
  /\bhttps?:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\/[A-Za-z0-9/_-]+/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\bBasic\s+[A-Za-z0-9+/]{12,}={0,2}/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{8,}/g,
  /\bsk-(?:ant-|proj-|live-)?[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bA(?:KIA|SIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\br8_[A-Za-z0-9]{20,}/g,
  /\bhf_[A-Za-z0-9]{30,}/g,
  // fal.ai keys are "<uuid>:<hex secret>"
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{32,}\b/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
const SECRET_NAME = String.raw`(?:api[_-]?key|secret|token|password|passwd|passphrase|pwd|pass|deployment[_-]?key|private[_-]?key|access[_-]?key|service[_-]?role(?:[_-]?key)?|credentials?|dsn|webhook(?:[_-]?url)?|connection[_-]?string|database[_-]?url|db[_-]?url|auth)`;
const SECRET_NAME_RX = new RegExp(SECRET_NAME, "i");
/*
 * A bare "key" or "token" name also labels flag keys and cache keys, so under those names only a
 * value shaped like a credential (32+ base64/hex characters with a digit, no dots or spaces) is redacted.
 */
const LOOSE_SECRET_NAME = /key|secret|token/i;
const SECRET_SHAPE = /^(?=\D*\d)(?=[^A-Za-z]*[A-Za-z])[A-Za-z0-9_+/=-]{32,}$/;
// AWS secret access keys are 40 base64 characters, often with "/" or "+", which HIGH_ENTROPY excludes.
const AWS_SECRET = /(\b(?:aws|secret)[^\n]{0,40}?)(?<![A-Za-z0-9/+])(?=[A-Za-z0-9/+]{0,39}[/+0-9])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/gi;
/*
 * Every pattern below runs on text from the developer's repo (Info.plist values, OTA URLs), so
 * each one may start only at a bounded set of positions and scan a bounded distance: a repeated
 * unanchored `[\w-]*` prefix took minutes on 100 KB of "a-a-a-".
 */
// The value after "=", ":" or a plist </key><string>; the key name in front is checked separately.
const ASSIGN_SEP = /[:=]|<\/key>\s*<string>/g;
const ASSIGN_VALUE = /\s*["']?([^\s"'<,}]{6,})/y;
// Credentials inside a URL (postgres://user:pass@host, Sentry DSN keys) keep the scheme and host.
const URL_USERINFO = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,31}:\/\/)(?:[^\s/:@"'<>]+:[^\s@"'<>/]+|[0-9a-f]{16,})@/gi;
// Signed-URL and API-key query parameters (?key=, &sig=, X-Amz-Signature=) carry the secret in the value.
const URL_QUERY_SECRET = /([?&](?:key|apikey|api_key|api-key|k|sig|signature|x-amz-signature|x-amz-credential|x-amz-security-token|code|hmac|token|access_token|auth)=)([^&#\s"'<>]+)/gi;
// "admin password hunter2hunter2": prose, not an assignment; needs a digit or symbol so "password protected" stays.
const PROSE_PASSWORD = /(\b(?:password|passwd|passphrase|pwd)\b(?:\s+is)?(?:\s*[:=-])?\s+)((?=[^\s"'<,}]*[\d!@#$%^&*_-])[^\s"'<,}]{6,})/gi;
// Long mixed-case alphanumeric runs (32+ chars) are almost always keys, not prose.
const HIGH_ENTROPY = /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g;
/** Strings longer than this are stored as a placeholder; the snapshot hash still covers the raw text. */
const MAX_REDACT_CHARS = 4096;

function redactAssignments(text: string): string {
  let out = "";
  let last = 0;
  ASSIGN_SEP.lastIndex = 0;
  for (let m = ASSIGN_SEP.exec(text); m; m = ASSIGN_SEP.exec(text)) {
    const before = text.slice(Math.max(0, m.index - 80), m.index).replace(/["'\s]+$/, "");
    const name = /[\w-]{1,64}$/.exec(before)?.[0] ?? "";
    const strict = SECRET_NAME_RX.test(name);
    if (!strict && !LOOSE_SECRET_NAME.test(name)) continue;
    ASSIGN_VALUE.lastIndex = m.index + m[0].length;
    const v = ASSIGN_VALUE.exec(text);
    // Already redacted by an earlier pattern; matching again would swallow the next "&name=value".
    if (!v?.[1] || v[1].startsWith("[redacted")) continue;
    if (!strict && !SECRET_SHAPE.test(v[1])) continue;
    out += `${text.slice(last, ASSIGN_VALUE.lastIndex - v[1].length)}[redacted]`;
    // Resume after the value, so separators inside a redacted value are not scanned again.
    last = ASSIGN_SEP.lastIndex = ASSIGN_VALUE.lastIndex;
  }
  return out + text.slice(last);
}

export function redactSecrets(text: string): string {
  if (text.length > MAX_REDACT_CHARS) return `[redacted: ${text.length} characters not stored]`;
  let out = text;
  for (const rx of SECRET_RX) out = out.replace(rx, "[redacted]");
  out = out.replace(AWS_SECRET, "$1[redacted]");
  out = out.replace(URL_USERINFO, "$1[redacted]@");
  out = out.replace(URL_QUERY_SECRET, "$1[redacted]");
  out = redactAssignments(out);
  out = out.replace(PROSE_PASSWORD, (_m, k: string) => `${k}[redacted]`);
  return out.replace(HIGH_ENTROPY, "[redacted]");
}

const SECRET_KEY_NAME = new RegExp(`^[\\w.-]*${SECRET_NAME}[\\w.-]*$`, "i");

function redactDeep(v: unknown, key?: string): unknown {
  if (typeof v === "string") {
    if (key && key.length <= 128 && SECRET_KEY_NAME.test(key) && v.length >= 4) return "[redacted]";
    if (key && key.length <= 128 && LOOSE_SECRET_NAME.test(key) && SECRET_SHAPE.test(v)) return "[redacted]";
    return redactSecrets(v);
  }
  if (Array.isArray(v)) return v.map((x) => redactDeep(x));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, redactDeep(x, k)]));
  return v;
}

function keyPaths(v: unknown, prefix = "", out: string[] = []): string[] {
  if (out.length >= 200 || !v || typeof v !== "object") return out;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const p = Array.isArray(v) ? `${prefix}[]` : prefix ? `${prefix}.${k}` : k;
    if (!out.includes(p)) out.push(p);
    keyPaths(x, p, out);
  }
  return out;
}

/**
 * Whole files are hashed, never stored: the ledger is kept forever (maybe in a shared repo) and
 * prompt, paywall and config files hold credentials no pattern list catches. Only their shape is kept.
 */
function fileShape(file: string, text: string): Record<string, unknown> {
  const shape: Record<string, unknown> = { file, chars: text.length, lines: text.split("\n").length };
  try {
    const json: unknown = JSON.parse(text);
    if (json && typeof json === "object") shape.keys = keyPaths(json);
  } catch {
    const plistKeys = [...text.matchAll(/<key>([^<]{1,80})<\/key>/g)].map((m) => m[1] as string);
    if (plistKeys.length) shape.keys = [...new Set(plistKeys)].slice(0, 200);
  }
  return shape;
}

/** Like snap(), for a whole file: hash of the raw text, stored data only its shape. */
function fileSnap(kind: SnapshotKind, label: string, summary: string, file: string, text: string): SnapshotInput {
  return { type: "config_snapshot", kind, label, hash: stableHash({ file, text }), summary, data: fileShape(file, text) };
}

// ---------- flags inventory ----------

/**
 * Only fields that mean a behavior change. `gates` is left out: it names file:line, so moving
 * code (or adding a blank line) would read as a changed content-gating flag and HOLD the gate.
 */
export interface FlagEntry {
  key: string;
  provider: string;
  classification: RemoteControl["classification"];
  defaultValue?: string;
}

const flagIdentity = (f: FlagEntry) => stableStringify({ key: f.key, provider: f.provider, classification: f.classification, defaultValue: f.defaultValue });

export function flagsSnapshot(controls: RemoteControl[]): SnapshotInput {
  const flags: FlagEntry[] = controls
    .map((c) => ({ key: c.key, provider: c.provider, classification: c.classification, defaultValue: c.defaultValue }))
    .sort((a, b) => a.key.localeCompare(b.key) || a.provider.localeCompare(b.provider));
  const seen = new Set<string>();
  const unique = flags.filter((f) => {
    const k = `${f.provider}|${f.key}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const sensitive = unique.filter((f) => f.classification === "content-gating" || f.classification === "price-gating").length;
  return snap("flags_inventory", "flags", `${unique.length} remote flag(s), ${sensitive} gating content or price`, { flags: unique });
}

// ---------- OTA config ----------

function jsonOf(f: SourceFile | undefined): unknown {
  if (!f) return undefined;
  try {
    return JSON.parse(f.text);
  } catch {
    return undefined;
  }
}

function pick(obj: unknown, ...keys: string[]): unknown {
  let cur = obj;
  for (const k of keys) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

export function otaSnapshot(ctx: ScanContext): SnapshotInput | undefined {
  const byPath = (p: string) => ctx.files.find((f) => f.path === p);
  const data: Record<string, unknown> = {};
  const appJson = jsonOf(byPath("app.json")) ?? jsonOf(byPath("app.config.json"));
  const expo = pick(appJson, "expo") ?? appJson;
  const updates = pick(expo, "updates");
  if (updates !== undefined) data.expoUpdates = updates;
  const runtime = pick(expo, "runtimeVersion");
  if (runtime !== undefined) data.runtimeVersion = runtime;
  const eas = jsonOf(byPath("eas.json"));
  const build = pick(eas, "build");
  if (build && typeof build === "object") {
    const channels: Record<string, unknown> = {};
    for (const [profile, cfg] of Object.entries(build as Record<string, unknown>)) {
      const ch = pick(cfg, "channel");
      if (ch !== undefined) channels[profile] = ch;
    }
    if (Object.keys(channels).length) data.easChannels = channels;
  }
  const pkg = jsonOf(byPath("package.json"));
  const deps = { ...((pick(pkg, "dependencies") as object) ?? {}), ...((pick(pkg, "devDependencies") as object) ?? {}) } as Record<string, string>;
  const otaDeps = Object.keys(deps)
    .filter((d) => /^(expo-updates|react-native-code-push|@code-push-next\/react-native-code-push|@revopush\/react-native-code-push|react-native-ota-hot-update|@hot-updater\/.+|hot-updater|@shorebird\/.+)$/.test(d))
    .sort()
    .map((d) => `${d}@${deps[d]}`);
  if (otaDeps.length) data.packages = otaDeps;
  const plistKeys: string[] = [];
  for (const f of ctx.files.filter((x) => x.ext === "plist")) {
    for (const m of f.text.matchAll(/<key>(CodePushDeploymentKey|CodePushServerURL|EXUpdatesURL|EXUpdatesRuntimeVersion|EXUpdatesEnabled)<\/key>\s*<[^>]+>([^<]*)</g)) {
      plistKeys.push(`${f.path}:${m[1]}=${(m[2] ?? "").trim()}`);
    }
  }
  if (plistKeys.length) data.plist = plistKeys.sort();
  const shorebird = byPath("shorebird.yaml");
  if (shorebird) data.shorebird = shorebird.text.trim();
  if (Object.keys(data).length === 0) return undefined;
  return snap("ota", "ota", `OTA update configuration (${Object.keys(data).sort().join(", ")})`, data);
}

// ---------- server prompts ----------

const SERVER_DIR = /(^|\/)(server|servers|backend|api|functions|supabase\/functions|netlify\/functions|cloud-functions|worker|workers|edge|lambda|lambdas|services?)\//i;
const PROMPT_FILE = /(^|\/)prompts?\/|\.prompt$|(^|\/)[^/]*(system[-_]?prompt|prompt)[^/]*\.(txt|md|json|ya?ml)$/i;
const SYSTEM_PROMPT_STRING =
  /(?:role\s*:\s*["']system["']\s*,\s*content\s*:|systemPrompt\s*[:=]|system_prompt\s*[:=]|SYSTEM_PROMPT\s*=|systemInstruction\s*:)\s*(`[^`]{20,}`|"[^"\n]{20,}"|'[^'\n]{20,}')/g;

export function serverPromptSnapshots(ctx: ScanContext): SnapshotInput[] {
  const out: SnapshotInput[] = [];
  for (const f of ctx.files) {
    if (PROMPT_FILE.test(f.path) && ["txt", "md", "json", "yaml", "yml", "prompt"].includes(f.ext)) {
      out.push(fileSnap("server_prompt", f.path, `prompt file ${f.path} (${f.text.length} chars)`, f.path, f.text));
      continue;
    }
    if (!SERVER_DIR.test(f.path)) continue;
    const prompts = [...f.code.matchAll(SYSTEM_PROMPT_STRING)].map((m) => (m[1] ?? "").slice(1, -1));
    if (prompts.length) {
      const raw = { file: f.path, prompts };
      out.push({
        type: "config_snapshot",
        kind: "server_prompt",
        label: f.path,
        hash: stableHash(raw),
        summary: `${prompts.length} system prompt string(s) in ${f.path}`,
        data: { file: f.path, prompts: prompts.length, chars: prompts.reduce((n, p) => n + p.length, 0) },
      });
    }
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

// ---------- model ids ----------

const MODEL_ID =
  /["'`]((?:gpt-[0-9][\w.-]*|o[134](?:-mini|-pro)?|chatgpt-[\w.-]+|dall-e-[23]|gpt-image-[\w.-]+|claude-[\w.-]+|gemini-[\w.-]+|imagen-[\w.-]+|grok-[\w.-]+|llama-?[0-9][\w.-]*|mistral-[\w.-]+|mixtral-[\w.-]+|deepseek-[\w.-]+|qwen[\w.-]*|sdxl[\w.-]*|stable-diffusion[\w./:-]*|flux[\w./:-]*|fal-ai\/[\w./-]+|black-forest-labs\/[\w./:-]+|stability-ai\/[\w./:-]+|[a-z0-9-]+\/[a-z0-9._-]+:[0-9a-f]{64}))["'`]/gi;

export function modelIdSnapshot(ctx: ScanContext): SnapshotInput | undefined {
  const ids = new Map<string, Set<string>>();
  for (const f of ctx.files) {
    if (!["swift", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "json", "yaml", "yml", "kt", "plist", "env", "toml"].includes(f.ext)) continue;
    if (f.path === "package.json" || f.path.endsWith("package-lock.json")) continue;
    for (const m of f.code.matchAll(MODEL_ID)) {
      const id = m[1] ?? "";
      if (!ids.has(id)) ids.set(id, new Set());
      ids.get(id)?.add(f.path);
    }
  }
  if (ids.size === 0) return undefined;
  const models = [...ids.entries()].map(([id, files]) => ({ id, files: [...files].sort() })).sort((a, b) => a.id.localeCompare(b.id));
  return snap("model_id", "models", `${models.length} model id(s): ${models.map((m) => m.id).slice(0, 6).join(", ")}`, { models: models.map((m) => m.id) });
}

// ---------- paywall config ----------

const PAYWALL_FILE = /(paywall|offering|pricing|products?|subscriptions?|storekit|superwall|adapty|revenuecat|iap)[^/]*\.(json|ya?ml|plist)$/i;

export function paywallSnapshots(ctx: ScanContext): SnapshotInput[] {
  return ctx.files
    .filter((f) => PAYWALL_FILE.test(path.posix.basename(f.path)) && f.path !== "package.json")
    .map((f) => fileSnap("paywall", f.path, `paywall/pricing config ${f.path}`, f.path, f.text))
    .sort((a, b) => a.label.localeCompare(b.label));
}

// ---------- remote config defaults ----------

const RC_DEFAULTS = /(remote[-_]?config[-_]?defaults?|RemoteConfigDefaults|remote_config)[^/]*\.(json|plist|xml)$/i;

export function remoteConfigDefaultsSnapshots(ctx: ScanContext): SnapshotInput[] {
  return ctx.files
    .filter((f) => RC_DEFAULTS.test(path.posix.basename(f.path)))
    .map((f) => fileSnap("remote_config", f.path, `remote config defaults ${f.path}`, f.path, f.text))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Every snapshot this module can build from the repo; `remoteControls` comes from the remote_config check. */
export function buildSnapshots(ctx: ScanContext, opts: { remoteControls?: RemoteControl[]; bundleId?: string } = {}): SnapshotInput[] {
  const out: SnapshotInput[] = [];
  if (opts.remoteControls) out.push(flagsSnapshot(opts.remoteControls));
  const ota = otaSnapshot(ctx);
  if (ota) out.push(ota);
  out.push(...serverPromptSnapshots(ctx));
  const models = modelIdSnapshot(ctx);
  if (models) out.push(models);
  out.push(...paywallSnapshots(ctx));
  out.push(...remoteConfigDefaultsSnapshots(ctx));
  return out.map((s) => ({ ...s, repo: ctx.root, ...(opts.bundleId ? { bundleId: opts.bundleId } : {}) }));
}

// ---------- diff ----------

export interface DriftChange {
  kind: SnapshotKind | "ota_publish";
  label: string;
  change: "added" | "removed" | "changed" | "published";
  /** true when the change can alter what users see or pay (prompts, models, content/price flags, paywall config) */
  contentOrPrice: boolean;
  /** words whose presence in pending Notes for Review counts as a specific disclosure */
  mentions: string[];
  disclosed: boolean;
  /**
   * The notes touch the topic ("we use a model") without naming this change; reported so the
   * agent sees why a content or price change still holds the gate.
   */
  mentionedOnly?: boolean;
  detail: string;
  beforeEventId?: string;
}

export interface DriftReport {
  /** id/at of the approval the comparison is against; undefined when no approval is recorded */
  approvalId?: string;
  approvalAt?: string;
  changes: DriftChange[];
  /** snapshot kinds present now but never recorded at or before the approval, so no baseline exists */
  unbaselined: string[];
  pendingNotesEventId?: string;
  guidance: string;
}

/**
 * Apple's 2.5.19 text treats changing content after approval as the conduct itself, so for a
 * content or price change, naming it in the next notes records it; it does not make it compliant.
 */
export const CONTENT_DRIFT_GUIDANCE =
  "Revert it, or ship it in a build that goes through App Review, and disclose it factually in the next Notes for Review. Disclosure records a change made after approval; it does not make it compliant (Guideline 2.5.19, DPLA 3.2(e) on post-review modifications).";
export const OTHER_DRIFT_GUIDANCE = "Resubmit or disclose it: ship a build that includes it, or name it specifically in Notes for Review (Guideline 2.3.1(a)).";
/** Downloaded code may only fix bugs, so naming an OTA publish in notes never covers a feature or content change. */
export const OTA_DRIFT_GUIDANCE =
  "An over-the-air update may only fix bugs (Guideline 2.5.2): ship any feature or content change in a build that goes through App Review. Name this publish (date, channel, what it changed) in the next Notes for Review.";
export const DRIFT_GUIDANCE = `Content or price changes since the last approval (prompts, models, content or price flags, paywall, OTA publishes that add or restore something): ${CONTENT_DRIFT_GUIDANCE} Other OTA publishes: ${OTA_DRIFT_GUIDANCE} Other changes: ${OTHER_DRIFT_GUIDANCE} Remove anything that should not be live.`;

const KIND_PHRASES: Record<DriftChange["kind"], string[]> = {
  server_prompt: ["server prompt", "system prompt", "server-side prompt"],
  model_id: ["model"],
  paywall: ["paywall", "pricing", "price"],
  flags_inventory: [],
  remote_config: ["remote config", "remote configuration"],
  ota: ["over-the-air", "ota", "expo-updates", "eas update", "codepush", "code push", "shorebird"],
  ota_publish: ["over-the-air", "ota", "eas update", "codepush", "code push", "shorebird"],
};

const termRx = (t: string) => new RegExp(`(^|[^a-z0-9])${t.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`);

function textMentions(notes: string | undefined, terms: string[]): boolean {
  if (!notes) return false;
  const lower = notes.toLowerCase();
  return terms.some((t) => !!t && termRx(t).test(lower));
}

const CHANGE_WORDS = /\b(?:chang\w*|updat\w*|replac\w*|switch\w*|swapp?\w*|added|adds|new|now|turned (?:on|off)|enabled|disabled|remov\w*|edit\w*|revis\w*|upgrad\w*|migrat\w*|moved?|since (?:version|build|the last|approval|\d))/i;
// Words that still say "it changed" once a denial is taken out; "since …", "new" and "now" do not.
const AFFIRMED_CHANGE = /\b(?:chang\w*|updat\w*|replac\w*|switch\w*|swapp?\w*|added|adds|turned (?:on|off)|flipped|enabled|disabled|remov\w*|edit\w*|revis\w*|upgrad\w*|migrat\w*)/i;

// Shipping verbs deny a change as much as "changed" does: "we have not shipped any OTA update".
// "add" is spelled out: as a stem it would read "not addressed" as a denial of a change.
const CHANGE_VERB = String.raw`(?:(?:chang|updat|modif|edit|alter|replac|switch|swapp?|touch|flipp?|toggl|ship|publish|push|deploy|releas|roll(?:ed|ing)?\s+out)\w*|add(?:s|ed|ing)?\b)`;
// "Is not enabled" describes today's state, which may be true; only the historical forms deny a change.
const ENABLE_VERB = String.raw`(?:enabl|activat|turn(?:ed)?\s+on|switch(?:ed)?\s+on)\w*`;
const REVIEWED = String.raw`(?:app\s+review|the\s+reviewers?|reviewers?|review|you|apple)\s+(?:have\s+|had\s+)?(?:saw|sees|see|seen|reviewed|approved|tested)`;
const CHANGE_DENIAL = new RegExp(
  [
    String.raw`\b(?:not|never)\s+(?:been\s+|be\s+|yet\s+|once\s+)?${CHANGE_VERB}`,
    String.raw`n['’]t\s+(?:been\s+|be\s+)?${CHANGE_VERB}`,
    String.raw`\b(?:never\s+(?:been\s+|once\s+)?|(?:not|n['’]t)\s+(?:once\s+)?been\s+|(?:did|do)\s*(?:not|n['’]t)\s+)${ENABLE_VERB}`,
    // "has always been off": a flag whose default the ledger saw flip did not always hold one value
    String.raw`\balways\s+(?:been\s+|stayed\s+|remained\s+)?(?:off|on|disabled|enabled|false|true|the same|identical)\b`,
    String.raw`\b(?:matche[sd]|match(?:ing)?|identical\s+to|the\s+same\s+as|same\s+as|consistent\s+with|no\s+different\s+from)\s+(?:exactly\s+)?(?:what\s+|the\s+(?:versions?|builds?|apps?)\s+(?:that\s+)?)${REVIEWED}`,
    String.raw`\b(?:users?|customers?|people|everyone)\s+(?:\w+\s+)?(?:see|saw|get|got|receive[sd]?)\s+(?:exactly\s+|only\s+)?what\s+${REVIEWED}`,
    // "the same one you approved", "identical to the version you approved"
    String.raw`\b(?:same|identical)\s+(?:(?:one|version|build|binary|app|code)\s+)?(?:(?:as|to)\s+(?:the\s+)?(?:(?:one|version|build|binary|app|code)\s+)?)?(?:that\s+|which\s+)?${REVIEWED}`,
    String.raw`\bno\s+(?:\w+\s+)?(?:changes?|updates?|modifications?|edits?|alterations?)\b`,
    // "no server configuration was modified after approval"
    String.raw`\bno\s+(?!longer\b)(?:[\w-]+\s+){1,3}(?:was|were|has been|have been|had been|got)\s+${CHANGE_VERB}`,
    String.raw`\bnothing\b[^.!?\n]{0,40}?\b(?:new|chang\w*|updat\w*|modif\w*|differen\w*)`,
    String.raw`\b(?:unchanged|unmodified|untouched)\b`,
    String.raw`\bremains?\s+(?:the same|as (?:it was|approved|before))`,
    String.raw`\bsame as (?:before|approved|the approved|in the approved)`,
    String.raw`\bwithout (?:any )?(?:changes?|modifications?)`,
  ].join("|"),
  "gi",
);

// The object of a denied verb ("not shipped any OTA update") names a change only to deny it.
const DENIED_OBJECT = /\b(?:any|a single|one)\s+(?:[\w-]+\s+){0,2}?(?:chang|updat|edit|modif|revis|upgrad|migrat)\w*/gi;

/**
 * True when a sentence says something did NOT change ("has not changed", "No changes to X",
 * "nothing new in") and affirms no other change. A denial is the opposite of a disclosure.
 */
export function deniesChange(sentence: string): boolean {
  CHANGE_DENIAL.lastIndex = 0;
  if (!CHANGE_DENIAL.test(sentence)) return false;
  CHANGE_DENIAL.lastIndex = 0;
  return !AFFIRMED_CHANGE.test(sentence.replace(CHANGE_DENIAL, " ").replace(DENIED_OBJECT, " "));
}

const CLAUSE_SPLIT = /[,;:()]|\s[-–—]\s|\s(?:and|but|while|whereas|although)\s/i;

export function clausesOf(sentence: string): string[] {
  return sentence.split(CLAUSE_SPLIT).map((c) => c.trim()).filter(Boolean);
}

/**
 * Clauses that deny a change, e.g. "nothing was changed after approval" in "We answered each
 * rejection by changing the app, and nothing was changed after approval". "Nothing else changed"
 * beside an affirmed change limits the disclosure rather than denying it, so it is left out.
 */
export function denialClauses(sentence: string): string[] {
  const clauses = clausesOf(sentence);
  const affirmsElsewhere = clauses.some((c) => !deniesChange(c) && AFFIRMED_CHANGE.test(c));
  return clauses.filter((c) => deniesChange(c) && !(affirmsElsewhere && /\b(?:else|other)\b/i.test(c)));
}

/**
 * A content or price change is disclosed only when one sentence names this change's own label
 * (prompt file, model id, paywall file, flag key) and says it changed. "We use a model" is not a
 * disclosure of a model swap, and "X has not changed" is not a disclosure of anything.
 */
function specificallyDisclosed(notes: string | undefined, specific: string[]): boolean {
  if (!notes || !specific.length) return false;
  const sentences = notes.split(/(?<=[.!?])\s+|\n+/);
  return sentences.some(
    (s) => textMentions(s, specific) && CHANGE_WORDS.test(s) && !deniesChange(s) && !denialClauses(s).some((c) => textMentions(c, specific)),
  );
}

function flagsOf(data: unknown): FlagEntry[] {
  const flags = pick(data, "flags");
  return Array.isArray(flags) ? (flags as FlagEntry[]) : [];
}

const SENSITIVE = new Set(["content-gating", "price-gating"]);

function diffFlags(before: unknown, after: unknown, beforeEventId: string): Omit<DriftChange, "disclosed">[] {
  const key = (f: FlagEntry) => `${f.provider}|${f.key}`;
  const b = new Map(flagsOf(before).map((f) => [key(f), f]));
  const a = new Map(flagsOf(after).map((f) => [key(f), f]));
  const out: Omit<DriftChange, "disclosed">[] = [];
  for (const [k, f] of a) {
    const prev = b.get(k);
    if (!prev) {
      out.push({ kind: "flags_inventory", label: `flag ${f.key}`, change: "added", contentOrPrice: SENSITIVE.has(f.classification), mentions: [f.key], detail: `new ${f.provider} flag "${f.key}" (${f.classification})`, beforeEventId });
    } else if (flagIdentity(prev) !== flagIdentity(f)) {
      out.push({
        kind: "flags_inventory",
        label: `flag ${f.key}`,
        change: "changed",
        contentOrPrice: SENSITIVE.has(f.classification) || SENSITIVE.has(prev.classification),
        mentions: [f.key],
        detail: `${f.provider} flag "${f.key}" changed (default ${prev.defaultValue ?? "?"} → ${f.defaultValue ?? "?"}, ${prev.classification} → ${f.classification})`,
        beforeEventId,
      });
    }
  }
  for (const [k, f] of b) {
    if (!a.has(k)) out.push({ kind: "flags_inventory", label: `flag ${f.key}`, change: "removed", contentOrPrice: false, mentions: [f.key], detail: `${f.provider} flag "${f.key}" no longer read`, beforeEventId });
  }
  return out;
}

function modelsOf(data: unknown): string[] {
  const m = pick(data, "models");
  return Array.isArray(m) ? m.map(String) : [];
}

/**
 * Wording in an OTA publish message that adds, restores or enables something. Guideline 2.5.2
 * lets downloaded code fix bugs only, so a publish described this way changed features or content
 * after review, and disclosing it does not make it compliant.
 */
const OTA_FEATURE_WORDS =
  /\b(?:re-?enabl\w*|enabl\w*|restor\w*|reinstat\w*|unlock\w*|unhid\w*|un-?hide|bring(?:s|ing)?\s+back|brought\s+back|turn(?:s|ed|ing)?\s+on|switch(?:es|ed|ing)?\s+on|introduc\w*|activat\w*|roll(?:s|ed|ing)?\s+out)\b/i;
// "add" and "new" also describe bug fixes ("fix crash for new users"), so they count only in a message that names no fix.
const OTA_WEAK_FEATURE_WORDS = /\b(?:add(?:s|ed|ing)?|new|allow(?:s|ed|ing)?|expand\w*)\b/i;
const OTA_FIX_WORDS = /\b(?:fix\w*|bug\w*|crash\w*|typo\w*|patch\w*|hotfix\w*|regression\w*|issue\w*)\b/i;

/** Words naming each rejected capability (feature, terms, flags from its saved spec, and its guideline-free feature name). */
function rejectedCapabilityTerms(state: LedgerState): string[] {
  const out = new Set<string>();
  for (const r of state.rejections) {
    for (const t of [r.spec?.feature, ...(r.spec?.terms ?? []), ...(r.spec?.flags ?? [])]) if (t && t.trim().length >= 4) out.add(t.trim());
  }
  return [...out];
}

/** True when `notes` disclose this change: by its own label for content, price and OTA publishes, by any mention otherwise. */
export function changeDisclosedBy(c: Pick<DriftChange, "kind" | "mentions" | "contentOrPrice">, notes: string | undefined): boolean {
  const generic = new Set((KIND_PHRASES[c.kind] ?? []).map((x) => x.toLowerCase()));
  const specific = c.mentions.filter((m) => m && !generic.has(m.toLowerCase()));
  // "The app uses EAS Update for bug fixes" names the mechanism, not this publish: an OTA
  // publish is disclosed only by a sentence naming its own id, day or message.
  if (c.contentOrPrice || c.kind === "ota_publish") return specificallyDisclosed(notes, specific);
  const affirming = notes?.split(/(?<=[.!?])\s+|\n+/).filter((x) => !deniesChange(x)).join("\n");
  return textMentions(affirming, c.mentions);
}

/** True when the publish message adds or restores something, or names a rejected capability. No message: nothing to read, so not assumed. */
export function otaChangesContent(message: string | undefined, rejectedTerms: string[]): boolean {
  if (!message) return false;
  return OTA_FEATURE_WORDS.test(message) || (OTA_WEAK_FEATURE_WORDS.test(message) && !OTA_FIX_WORDS.test(message)) || textMentions(message, rejectedTerms);
}

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** What a sentence must name to disclose this publish specifically: its update id, its day, or its message. */
function otaSpecificTerms(p: Extract<LedgerEvent, { type: "ota_publish" }>): string[] {
  const d = new Date(p.at);
  const month = MONTH_NAMES[d.getUTCMonth()] ?? "";
  const day = d.getUTCDate();
  const nth = `${day}${[11, 12, 13].includes(day) ? "th" : (["th", "st", "nd", "rd"][day % 10] ?? "th")}`;
  return [
    ...(p.updateId ? [p.updateId] : []),
    p.at.slice(0, 10),
    ...[String(day), nth].flatMap((dd) => [`${month} ${dd}`, `${month.slice(0, 3)} ${dd}`, `${dd} ${month}`, `${dd} of ${month}`]),
    ...(p.message && p.message.trim().length >= 8 ? [p.message.trim()] : []),
  ];
}

/** The most recent review_notes text recorded after `afterAt` (i.e. for the next submission). */
export function pendingReviewNotes(state: LedgerState, afterAt?: string): Extract<LedgerEvent, { type: "message_sent" }> | undefined {
  const t = afterAt ? Date.parse(afterAt) : -Infinity;
  const notes = state.events.filter(
    (e): e is Extract<LedgerEvent, { type: "message_sent" }> => e.type === "message_sent" && e.purpose === "review_notes" && Date.parse(e.at) > t,
  );
  return notes[notes.length - 1];
}

function sameBundle(eventBundle: string | undefined, want: string | undefined): boolean {
  return !want || !eventBundle || eventBundle === want;
}

/**
 * Compares current snapshots with the latest snapshot of the same kind+label recorded at or
 * before the last approval. OTA publishes after the approval are listed too.
 */
export function diffSinceApproved(
  state: LedgerState,
  current: SnapshotInput[],
  opts: { bundleId?: string; pendingNotes?: string } = {},
): DriftReport {
  const approvals = state.outcomes.filter((o) => o.outcome === "approved" && sameBundle(o.bundleId, opts.bundleId));
  const approval = approvals[approvals.length - 1];
  if (!approval) {
    return { changes: [], unbaselined: [], guidance: "No approval is recorded in the ledger, so there is no approved baseline to compare against. Import your App Review history (shield_ledger_import (MCP) or `appstore-shield import` (CLI)) to enable drift checks." };
  }
  const approvedAt = Date.parse(approval.at);
  const notesEvent = pendingReviewNotes(state, approval.at);
  const notes = opts.pendingNotes ?? notesEvent?.text;

  const baseline = new Map<string, ConfigSnapshotEvent>();
  const kindsWithBaseline = new Set<string>();
  for (const s of state.configSnapshots) {
    if (Date.parse(s.at) > approvedAt || !sameBundle(s.bundleId, opts.bundleId)) continue;
    baseline.set(`${s.kind}|${s.label}`, s);
    kindsWithBaseline.add(s.kind);
  }

  const raw: Omit<DriftChange, "disclosed">[] = [];
  const unbaselined = new Set<string>();
  const currentKeys = new Set<string>();
  for (const cur of current) {
    const k = `${cur.kind}|${cur.label}`;
    currentKeys.add(k);
    const prev = baseline.get(k);
    if (!kindsWithBaseline.has(cur.kind)) {
      unbaselined.add(cur.kind);
      continue;
    }
    const contentKind = cur.kind === "server_prompt" || cur.kind === "model_id" || cur.kind === "paywall";
    const labelTerms = cur.kind === "server_prompt" || cur.kind === "paywall" || cur.kind === "remote_config" ? [cur.label, path.posix.basename(cur.label).replace(/\.[^.]+$/, "")] : [];
    if (!prev) {
      if (cur.kind === "flags_inventory") raw.push(...diffFlags(undefined, cur.data, ""));
      else raw.push({ kind: cur.kind, label: cur.label, change: "added", contentOrPrice: contentKind, mentions: [...labelTerms, ...KIND_PHRASES[cur.kind]], detail: cur.summary });
      continue;
    }
    if (prev.hash === cur.hash) continue;
    if (cur.kind === "flags_inventory") {
      raw.push(...diffFlags(prev.data, cur.data, prev.id));
    } else if (cur.kind === "model_id") {
      const before = new Set(modelsOf(prev.data));
      const after = modelsOf(cur.data);
      const added = after.filter((m) => !before.has(m));
      const removed = [...before].filter((m) => !after.includes(m));
      raw.push({
        kind: "model_id",
        label: cur.label,
        change: "changed",
        contentOrPrice: true,
        mentions: [...added, ...removed, ...KIND_PHRASES.model_id],
        detail: `model ids changed: +[${added.join(", ")}] -[${removed.join(", ")}]`,
        beforeEventId: prev.id,
      });
    } else {
      raw.push({ kind: cur.kind, label: cur.label, change: "changed", contentOrPrice: contentKind, mentions: [...labelTerms, ...KIND_PHRASES[cur.kind]], detail: `${cur.summary} (hash ${prev.hash} → ${cur.hash})`, beforeEventId: prev.id });
    }
  }
  for (const [k, prev] of baseline) {
    if (currentKeys.has(k) || prev.kind === "flags_inventory") continue;
    // Only report removals for kinds this run actually measured; otherwise absence means "not scanned".
    if (!current.some((c) => c.kind === prev.kind)) continue;
    raw.push({ kind: prev.kind, label: prev.label, change: "removed", contentOrPrice: false, mentions: [prev.label], detail: `${prev.summary} no longer present`, beforeEventId: prev.id });
  }
  const rejected = rejectedCapabilityTerms(state);
  for (const p of state.otaPublishes) {
    if (Date.parse(p.at) <= approvedAt || !sameBundle(p.bundleId, opts.bundleId)) continue;
    const content = otaChangesContent(p.message, rejected);
    raw.push({
      kind: "ota_publish",
      label: p.updateId ?? p.id,
      change: "published",
      contentOrPrice: content,
      mentions: [...otaSpecificTerms(p), ...KIND_PHRASES.ota_publish],
      detail: `OTA update published ${p.at.slice(0, 10)}${p.channel ? ` to ${p.channel}` : ""}${p.message ? `: ${p.message}` : ""} (Guideline 2.5.2 limits downloaded code to bug fixes${content ? "; its recorded message describes a feature or content change" : ""})`,
      beforeEventId: p.id,
    });
  }

  const changes = raw.map((c) => {
    const disclosed = changeDisclosedBy(c, notes);
    const mentionedOnly = !disclosed && textMentions(notes, c.mentions);
    return { ...c, disclosed, ...(mentionedOnly ? { mentionedOnly } : {}) };
  });
  return {
    approvalId: approval.id,
    approvalAt: approval.at,
    changes,
    unbaselined: [...unbaselined].sort(),
    pendingNotesEventId: opts.pendingNotes ? undefined : notesEvent?.id,
    guidance: DRIFT_GUIDANCE,
  };
}

/** A post-approval change the ledger itself records, with the event that shows it. */
export interface RecordedChange extends DriftChange {
  eventId: string;
  at: string;
  approvalId: string;
  approvalAt: string;
}

/**
 * Changes after the last approval that the ledger already holds: later snapshots whose content
 * differs from the approved baseline, and OTA publishes. These are facts, not guesses, so any
 * text sent to Apple must not contradict them.
 */
export function recordedPostApprovalChanges(state: LedgerState): RecordedChange[] {
  const bundles: (string | undefined)[] = state.apps.length > 1 ? state.apps.map((a) => a.bundleId) : [undefined];
  const out: RecordedChange[] = [];
  const seen = new Set<string>();
  for (const bundleId of bundles) {
    const approval = state.outcomes.filter((o) => o.outcome === "approved" && sameBundle(o.bundleId, bundleId)).at(-1);
    if (!approval) continue;
    const t = Date.parse(approval.at);
    const latest = new Map<string, ConfigSnapshotEvent>();
    for (const s of state.configSnapshots) {
      if (Date.parse(s.at) > t && sameBundle(s.bundleId, bundleId)) latest.set(`${s.kind}|${s.label}`, s);
    }
    const current: SnapshotInput[] = [...latest.values()].map((s) => ({ type: "config_snapshot", kind: s.kind, label: s.label, hash: s.hash, summary: s.summary, data: s.data }));
    const report = diffSinceApproved(state, current, { bundleId, pendingNotes: "" });
    for (const c of report.changes) {
      if (c.change === "removed") continue;
      const ev =
        c.kind === "ota_publish"
          ? state.otaPublishes.find((p) => p.id === c.beforeEventId)
          : [...latest.values()].find((s) => s.kind === c.kind && (s.label === c.label || c.kind === "flags_inventory"));
      if (!ev) continue;
      const key = `${ev.id}|${c.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...c, eventId: ev.id, at: ev.at, approvalId: approval.id, approvalAt: approval.at });
    }
  }
  return out;
}

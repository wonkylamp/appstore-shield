#!/usr/bin/env node
import { createRequire as __shieldCreateRequire } from "node:module";
const require = __shieldCreateRequire(import.meta.url);
import {
  sameReviewDecision,
  tierRank
} from "./chunk-KHNZSQW4.js";

// src/ledger/drift.ts
import { createHash } from "node:crypto";
import path from "node:path";
function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v;
  return `{${Object.keys(o).filter((k) => o[k] !== void 0).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}
function stableHash(v) {
  return createHash("sha256").update(stableStringify(v)).digest("hex").slice(0, 16);
}
function snap(kind, label, summary, data) {
  return { type: "config_snapshot", kind, label, hash: stableHash(data), summary, data: redactDeep(data) };
}
var SECRET_RX = [
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
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
];
var SECRET_NAME = String.raw`(?:api[_-]?key|secret|token|password|passwd|passphrase|pwd|pass|deployment[_-]?key|private[_-]?key|access[_-]?key|service[_-]?role(?:[_-]?key)?|credentials?|dsn|webhook(?:[_-]?url)?|connection[_-]?string|database[_-]?url|db[_-]?url|auth)`;
var SECRET_NAME_RX = new RegExp(SECRET_NAME, "i");
var LOOSE_SECRET_NAME = /key|secret|token/i;
var SECRET_SHAPE = /^(?=\D*\d)(?=[^A-Za-z]*[A-Za-z])[A-Za-z0-9_+/=-]{32,}$/;
var AWS_SECRET = /(\b(?:aws|secret)[^\n]{0,40}?)(?<![A-Za-z0-9/+])(?=[A-Za-z0-9/+]{0,39}[/+0-9])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/gi;
var ASSIGN_SEP = /[:=]|<\/key>\s*<string>/g;
var ASSIGN_VALUE = /\s*["']?([^\s"'<,}]{6,})/y;
var URL_USERINFO = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,31}:\/\/)(?:[^\s/:@"'<>]+:[^\s@"'<>/]+|[0-9a-f]{16,})@/gi;
var URL_QUERY_SECRET = /([?&](?:key|apikey|api_key|api-key|k|sig|signature|x-amz-signature|x-amz-credential|x-amz-security-token|code|hmac|token|access_token|auth)=)([^&#\s"'<>]+)/gi;
var PROSE_PASSWORD = /(\b(?:password|passwd|passphrase|pwd)\b(?:\s+is)?(?:\s*[:=-])?\s+)((?=[^\s"'<,}]*[\d!@#$%^&*_-])[^\s"'<,}]{6,})/gi;
var HIGH_ENTROPY = /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g;
var MAX_REDACT_CHARS = 4096;
function redactAssignments(text) {
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
    if (!v?.[1] || v[1].startsWith("[redacted")) continue;
    if (!strict && !SECRET_SHAPE.test(v[1])) continue;
    out += `${text.slice(last, ASSIGN_VALUE.lastIndex - v[1].length)}[redacted]`;
    last = ASSIGN_SEP.lastIndex = ASSIGN_VALUE.lastIndex;
  }
  return out + text.slice(last);
}
function redactSecrets(text) {
  if (text.length > MAX_REDACT_CHARS) return `[redacted: ${text.length} characters not stored]`;
  let out = text;
  for (const rx of SECRET_RX) out = out.replace(rx, "[redacted]");
  out = out.replace(AWS_SECRET, "$1[redacted]");
  out = out.replace(URL_USERINFO, "$1[redacted]@");
  out = out.replace(URL_QUERY_SECRET, "$1[redacted]");
  out = redactAssignments(out);
  out = out.replace(PROSE_PASSWORD, (_m, k) => `${k}[redacted]`);
  return out.replace(HIGH_ENTROPY, "[redacted]");
}
var SECRET_KEY_NAME = new RegExp(`^[\\w.-]*${SECRET_NAME}[\\w.-]*$`, "i");
function redactDeep(v, key) {
  if (typeof v === "string") {
    if (key && key.length <= 128 && SECRET_KEY_NAME.test(key) && v.length >= 4) return "[redacted]";
    if (key && key.length <= 128 && LOOSE_SECRET_NAME.test(key) && SECRET_SHAPE.test(v)) return "[redacted]";
    return redactSecrets(v);
  }
  if (Array.isArray(v)) return v.map((x) => redactDeep(x));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x, k)]));
  return v;
}
function keyPaths(v, prefix = "", out = []) {
  if (out.length >= 200 || !v || typeof v !== "object") return out;
  for (const [k, x] of Object.entries(v)) {
    const p = Array.isArray(v) ? `${prefix}[]` : prefix ? `${prefix}.${k}` : k;
    if (!out.includes(p)) out.push(p);
    keyPaths(x, p, out);
  }
  return out;
}
function fileShape(file, text) {
  const shape = { file, chars: text.length, lines: text.split("\n").length };
  try {
    const json = JSON.parse(text);
    if (json && typeof json === "object") shape.keys = keyPaths(json);
  } catch {
    const plistKeys = [...text.matchAll(/<key>([^<]{1,80})<\/key>/g)].map((m) => m[1]);
    if (plistKeys.length) shape.keys = [...new Set(plistKeys)].slice(0, 200);
  }
  return shape;
}
function fileSnap(kind, label, summary, file, text) {
  return { type: "config_snapshot", kind, label, hash: stableHash({ file, text }), summary, data: fileShape(file, text) };
}
var flagIdentity = (f) => stableStringify({ key: f.key, provider: f.provider, classification: f.classification, defaultValue: f.defaultValue });
function flagsSnapshot(controls) {
  const flags = controls.map((c) => ({ key: c.key, provider: c.provider, classification: c.classification, defaultValue: c.defaultValue })).sort((a, b) => a.key.localeCompare(b.key) || a.provider.localeCompare(b.provider));
  const seen = /* @__PURE__ */ new Set();
  const unique = flags.filter((f) => {
    const k = `${f.provider}|${f.key}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const sensitive = unique.filter((f) => f.classification === "content-gating" || f.classification === "price-gating").length;
  return snap("flags_inventory", "flags", `${unique.length} remote flag(s), ${sensitive} gating content or price`, { flags: unique });
}
function jsonOf(f) {
  if (!f) return void 0;
  try {
    return JSON.parse(f.text);
  } catch {
    return void 0;
  }
}
function pick(obj, ...keys) {
  let cur = obj;
  for (const k of keys) {
    if (!cur || typeof cur !== "object") return void 0;
    cur = cur[k];
  }
  return cur;
}
function otaSnapshot(ctx) {
  const byPath = (p) => ctx.files.find((f) => f.path === p);
  const data = {};
  const appJson = jsonOf(byPath("app.json")) ?? jsonOf(byPath("app.config.json"));
  const expo = pick(appJson, "expo") ?? appJson;
  const updates = pick(expo, "updates");
  if (updates !== void 0) data.expoUpdates = updates;
  const runtime = pick(expo, "runtimeVersion");
  if (runtime !== void 0) data.runtimeVersion = runtime;
  const eas = jsonOf(byPath("eas.json"));
  const build = pick(eas, "build");
  if (build && typeof build === "object") {
    const channels = {};
    for (const [profile, cfg] of Object.entries(build)) {
      const ch = pick(cfg, "channel");
      if (ch !== void 0) channels[profile] = ch;
    }
    if (Object.keys(channels).length) data.easChannels = channels;
  }
  const pkg = jsonOf(byPath("package.json"));
  const deps = { ...pick(pkg, "dependencies") ?? {}, ...pick(pkg, "devDependencies") ?? {} };
  const otaDeps = Object.keys(deps).filter((d) => /^(expo-updates|react-native-code-push|@code-push-next\/react-native-code-push|@revopush\/react-native-code-push|react-native-ota-hot-update|@hot-updater\/.+|hot-updater|@shorebird\/.+)$/.test(d)).sort().map((d) => `${d}@${deps[d]}`);
  if (otaDeps.length) data.packages = otaDeps;
  const plistKeys = [];
  for (const f of ctx.files.filter((x) => x.ext === "plist")) {
    for (const m of f.text.matchAll(/<key>(CodePushDeploymentKey|CodePushServerURL|EXUpdatesURL|EXUpdatesRuntimeVersion|EXUpdatesEnabled)<\/key>\s*<[^>]+>([^<]*)</g)) {
      plistKeys.push(`${f.path}:${m[1]}=${(m[2] ?? "").trim()}`);
    }
  }
  if (plistKeys.length) data.plist = plistKeys.sort();
  const shorebird = byPath("shorebird.yaml");
  if (shorebird) data.shorebird = shorebird.text.trim();
  if (Object.keys(data).length === 0) return void 0;
  return snap("ota", "ota", `OTA update configuration (${Object.keys(data).sort().join(", ")})`, data);
}
var SERVER_DIR = /(^|\/)(server|servers|backend|api|functions|supabase\/functions|netlify\/functions|cloud-functions|worker|workers|edge|lambda|lambdas|services?)\//i;
var PROMPT_FILE = /(^|\/)prompts?\/|\.prompt$|(^|\/)[^/]*(system[-_]?prompt|prompt)[^/]*\.(txt|md|json|ya?ml)$/i;
var SYSTEM_PROMPT_STRING = /(?:role\s*:\s*["']system["']\s*,\s*content\s*:|systemPrompt\s*[:=]|system_prompt\s*[:=]|SYSTEM_PROMPT\s*=|systemInstruction\s*:)\s*(`[^`]{20,}`|"[^"\n]{20,}"|'[^'\n]{20,}')/g;
function serverPromptSnapshots(ctx) {
  const out = [];
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
        data: { file: f.path, prompts: prompts.length, chars: prompts.reduce((n, p) => n + p.length, 0) }
      });
    }
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}
var MODEL_ID = /["'`]((?:gpt-[0-9][\w.-]*|o[134](?:-mini|-pro)?|chatgpt-[\w.-]+|dall-e-[23]|gpt-image-[\w.-]+|claude-[\w.-]+|gemini-[\w.-]+|imagen-[\w.-]+|grok-[\w.-]+|llama-?[0-9][\w.-]*|mistral-[\w.-]+|mixtral-[\w.-]+|deepseek-[\w.-]+|qwen[\w.-]*|sdxl[\w.-]*|stable-diffusion[\w./:-]*|flux[\w./:-]*|fal-ai\/[\w./-]+|black-forest-labs\/[\w./:-]+|stability-ai\/[\w./:-]+|[a-z0-9-]+\/[a-z0-9._-]+:[0-9a-f]{64}))["'`]/gi;
function modelIdSnapshot(ctx) {
  const ids = /* @__PURE__ */ new Map();
  for (const f of ctx.files) {
    if (!["swift", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "json", "yaml", "yml", "kt", "plist", "env", "toml"].includes(f.ext)) continue;
    if (f.path === "package.json" || f.path.endsWith("package-lock.json")) continue;
    for (const m of f.code.matchAll(MODEL_ID)) {
      const id = m[1] ?? "";
      if (!ids.has(id)) ids.set(id, /* @__PURE__ */ new Set());
      ids.get(id)?.add(f.path);
    }
  }
  if (ids.size === 0) return void 0;
  const models = [...ids.entries()].map(([id, files]) => ({ id, files: [...files].sort() })).sort((a, b) => a.id.localeCompare(b.id));
  return snap("model_id", "models", `${models.length} model id(s): ${models.map((m) => m.id).slice(0, 6).join(", ")}`, { models: models.map((m) => m.id) });
}
var PAYWALL_FILE = /(paywall|offering|pricing|products?|subscriptions?|storekit|superwall|adapty|revenuecat|iap)[^/]*\.(json|ya?ml|plist)$/i;
function paywallSnapshots(ctx) {
  return ctx.files.filter((f) => PAYWALL_FILE.test(path.posix.basename(f.path)) && f.path !== "package.json").map((f) => fileSnap("paywall", f.path, `paywall/pricing config ${f.path}`, f.path, f.text)).sort((a, b) => a.label.localeCompare(b.label));
}
var RC_DEFAULTS = /(remote[-_]?config[-_]?defaults?|RemoteConfigDefaults|remote_config)[^/]*\.(json|plist|xml)$/i;
function remoteConfigDefaultsSnapshots(ctx) {
  return ctx.files.filter((f) => RC_DEFAULTS.test(path.posix.basename(f.path))).map((f) => fileSnap("remote_config", f.path, `remote config defaults ${f.path}`, f.path, f.text)).sort((a, b) => a.label.localeCompare(b.label));
}
function buildSnapshots(ctx, opts = {}) {
  const out = [];
  if (opts.remoteControls) out.push(flagsSnapshot(opts.remoteControls));
  const ota = otaSnapshot(ctx);
  if (ota) out.push(ota);
  out.push(...serverPromptSnapshots(ctx));
  const models = modelIdSnapshot(ctx);
  if (models) out.push(models);
  out.push(...paywallSnapshots(ctx));
  out.push(...remoteConfigDefaultsSnapshots(ctx));
  return out.map((s) => ({ ...s, repo: ctx.root, ...opts.bundleId ? { bundleId: opts.bundleId } : {} }));
}
var CONTENT_DRIFT_GUIDANCE = "Revert it, or ship it in a build that goes through App Review, and disclose it factually in the next Notes for Review. Disclosure records a change made after approval; it does not make it compliant (Guideline 2.5.19, DPLA 3.2(e) on post-review modifications).";
var OTHER_DRIFT_GUIDANCE = "Resubmit or disclose it: ship a build that includes it, or name it specifically in Notes for Review (Guideline 2.3.1(a)).";
var OTA_DRIFT_GUIDANCE = "An over-the-air update may only fix bugs (Guideline 2.5.2): ship any feature or content change in a build that goes through App Review. Name this publish (date, channel, what it changed) in the next Notes for Review.";
var DRIFT_GUIDANCE = `Content or price changes since the last approval (prompts, models, content or price flags, paywall, OTA publishes that add or restore something): ${CONTENT_DRIFT_GUIDANCE} Other OTA publishes: ${OTA_DRIFT_GUIDANCE} Other changes: ${OTHER_DRIFT_GUIDANCE} Remove anything that should not be live.`;
var KIND_PHRASES = {
  server_prompt: ["server prompt", "system prompt", "server-side prompt"],
  model_id: ["model"],
  paywall: ["paywall", "pricing", "price"],
  flags_inventory: [],
  remote_config: ["remote config", "remote configuration"],
  ota: ["over-the-air", "ota", "expo-updates", "eas update", "codepush", "code push", "shorebird"],
  ota_publish: ["over-the-air", "ota", "eas update", "codepush", "code push", "shorebird"]
};
var termRx = (t) => new RegExp(`(^|[^a-z0-9])${t.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`);
function textMentions(notes, terms) {
  if (!notes) return false;
  const lower = notes.toLowerCase();
  return terms.some((t) => !!t && termRx(t).test(lower));
}
var CHANGE_WORDS = /\b(?:chang\w*|updat\w*|replac\w*|switch\w*|swapp?\w*|added|adds|new|now|turned (?:on|off)|enabled|disabled|remov\w*|edit\w*|revis\w*|upgrad\w*|migrat\w*|moved?|since (?:version|build|the last|approval|\d))/i;
var AFFIRMED_CHANGE = /\b(?:chang\w*|updat\w*|replac\w*|switch\w*|swapp?\w*|added|adds|turned (?:on|off)|flipped|enabled|disabled|remov\w*|edit\w*|revis\w*|upgrad\w*|migrat\w*)/i;
var CHANGE_VERB = String.raw`(?:(?:chang|updat|modif|edit|alter|replac|switch|swapp?|touch|flipp?|toggl|ship|publish|push|deploy|releas|roll(?:ed|ing)?\s+out)\w*|add(?:s|ed|ing)?\b)`;
var ENABLE_VERB = String.raw`(?:enabl|activat|turn(?:ed)?\s+on|switch(?:ed)?\s+on)\w*`;
var REVIEWED = String.raw`(?:app\s+review|the\s+reviewers?|reviewers?|review|you|apple)\s+(?:have\s+|had\s+)?(?:saw|sees|see|seen|reviewed|approved|tested)`;
var CHANGE_DENIAL = new RegExp(
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
    String.raw`\bwithout (?:any )?(?:changes?|modifications?)`
  ].join("|"),
  "gi"
);
var DENIED_OBJECT = /\b(?:any|a single|one)\s+(?:[\w-]+\s+){0,2}?(?:chang|updat|edit|modif|revis|upgrad|migrat)\w*/gi;
function deniesChange(sentence) {
  CHANGE_DENIAL.lastIndex = 0;
  if (!CHANGE_DENIAL.test(sentence)) return false;
  CHANGE_DENIAL.lastIndex = 0;
  return !AFFIRMED_CHANGE.test(sentence.replace(CHANGE_DENIAL, " ").replace(DENIED_OBJECT, " "));
}
var CLAUSE_SPLIT = /[,;:()]|\s[-–—]\s|\s(?:and|but|while|whereas|although)\s/i;
function clausesOf(sentence) {
  return sentence.split(CLAUSE_SPLIT).map((c) => c.trim()).filter(Boolean);
}
function denialClauses(sentence) {
  const clauses = clausesOf(sentence);
  const affirmsElsewhere = clauses.some((c) => !deniesChange(c) && AFFIRMED_CHANGE.test(c));
  return clauses.filter((c) => deniesChange(c) && !(affirmsElsewhere && /\b(?:else|other)\b/i.test(c)));
}
function specificallyDisclosed(notes, specific) {
  if (!notes || !specific.length) return false;
  const sentences = notes.split(/(?<=[.!?])\s+|\n+/);
  return sentences.some(
    (s) => textMentions(s, specific) && CHANGE_WORDS.test(s) && !deniesChange(s) && !denialClauses(s).some((c) => textMentions(c, specific))
  );
}
function flagsOf(data) {
  const flags = pick(data, "flags");
  return Array.isArray(flags) ? flags : [];
}
var SENSITIVE = /* @__PURE__ */ new Set(["content-gating", "price-gating"]);
function diffFlags(before, after, beforeEventId) {
  const key = (f) => `${f.provider}|${f.key}`;
  const b = new Map(flagsOf(before).map((f) => [key(f), f]));
  const a = new Map(flagsOf(after).map((f) => [key(f), f]));
  const out = [];
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
        detail: `${f.provider} flag "${f.key}" changed (default ${prev.defaultValue ?? "?"} \u2192 ${f.defaultValue ?? "?"}, ${prev.classification} \u2192 ${f.classification})`,
        beforeEventId
      });
    }
  }
  for (const [k, f] of b) {
    if (!a.has(k)) out.push({ kind: "flags_inventory", label: `flag ${f.key}`, change: "removed", contentOrPrice: false, mentions: [f.key], detail: `${f.provider} flag "${f.key}" no longer read`, beforeEventId });
  }
  return out;
}
function modelsOf(data) {
  const m = pick(data, "models");
  return Array.isArray(m) ? m.map(String) : [];
}
var OTA_FEATURE_WORDS = /\b(?:re-?enabl\w*|enabl\w*|restor\w*|reinstat\w*|unlock\w*|unhid\w*|un-?hide|bring(?:s|ing)?\s+back|brought\s+back|turn(?:s|ed|ing)?\s+on|switch(?:es|ed|ing)?\s+on|introduc\w*|activat\w*|roll(?:s|ed|ing)?\s+out)\b/i;
var OTA_WEAK_FEATURE_WORDS = /\b(?:add(?:s|ed|ing)?|new|allow(?:s|ed|ing)?|expand\w*)\b/i;
var OTA_FIX_WORDS = /\b(?:fix\w*|bug\w*|crash\w*|typo\w*|patch\w*|hotfix\w*|regression\w*|issue\w*)\b/i;
function rejectedCapabilityTerms(state) {
  const out = /* @__PURE__ */ new Set();
  for (const r of state.rejections) {
    for (const t of [r.spec?.feature, ...r.spec?.terms ?? [], ...r.spec?.flags ?? []]) if (t && t.trim().length >= 4) out.add(t.trim());
  }
  return [...out];
}
function changeDisclosedBy(c, notes) {
  const generic = new Set((KIND_PHRASES[c.kind] ?? []).map((x) => x.toLowerCase()));
  const specific = c.mentions.filter((m) => m && !generic.has(m.toLowerCase()));
  if (c.contentOrPrice || c.kind === "ota_publish") return specificallyDisclosed(notes, specific);
  const affirming = notes?.split(/(?<=[.!?])\s+|\n+/).filter((x) => !deniesChange(x)).join("\n");
  return textMentions(affirming, c.mentions);
}
function otaChangesContent(message, rejectedTerms) {
  if (!message) return false;
  return OTA_FEATURE_WORDS.test(message) || OTA_WEAK_FEATURE_WORDS.test(message) && !OTA_FIX_WORDS.test(message) || textMentions(message, rejectedTerms);
}
var MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
function otaSpecificTerms(p) {
  const d = new Date(p.at);
  const month = MONTH_NAMES[d.getUTCMonth()] ?? "";
  const day2 = d.getUTCDate();
  const nth = `${day2}${[11, 12, 13].includes(day2) ? "th" : ["th", "st", "nd", "rd"][day2 % 10] ?? "th"}`;
  return [
    ...p.updateId ? [p.updateId] : [],
    p.at.slice(0, 10),
    ...[String(day2), nth].flatMap((dd) => [`${month} ${dd}`, `${month.slice(0, 3)} ${dd}`, `${dd} ${month}`, `${dd} of ${month}`]),
    ...p.message && p.message.trim().length >= 8 ? [p.message.trim()] : []
  ];
}
function pendingReviewNotes(state, afterAt) {
  const t = afterAt ? Date.parse(afterAt) : -Infinity;
  const notes = state.events.filter(
    (e) => e.type === "message_sent" && e.purpose === "review_notes" && Date.parse(e.at) > t
  );
  return notes[notes.length - 1];
}
function sameBundle(eventBundle, want) {
  return !want || !eventBundle || eventBundle === want;
}
function diffSinceApproved(state, current, opts = {}) {
  const approvals = state.outcomes.filter((o) => o.outcome === "approved" && sameBundle(o.bundleId, opts.bundleId));
  const approval = approvals[approvals.length - 1];
  if (!approval) {
    return { changes: [], unbaselined: [], guidance: "No approval is recorded in the ledger, so there is no approved baseline to compare against. Import your App Review history (shield_ledger_import (MCP) or `appstore-shield import` (CLI)) to enable drift checks." };
  }
  const approvedAt = Date.parse(approval.at);
  const notesEvent = pendingReviewNotes(state, approval.at);
  const notes = opts.pendingNotes ?? notesEvent?.text;
  const baseline = /* @__PURE__ */ new Map();
  const kindsWithBaseline = /* @__PURE__ */ new Set();
  for (const s of state.configSnapshots) {
    if (Date.parse(s.at) > approvedAt || !sameBundle(s.bundleId, opts.bundleId)) continue;
    baseline.set(`${s.kind}|${s.label}`, s);
    kindsWithBaseline.add(s.kind);
  }
  const raw = [];
  const unbaselined = /* @__PURE__ */ new Set();
  const currentKeys = /* @__PURE__ */ new Set();
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
      if (cur.kind === "flags_inventory") raw.push(...diffFlags(void 0, cur.data, ""));
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
        beforeEventId: prev.id
      });
    } else {
      raw.push({ kind: cur.kind, label: cur.label, change: "changed", contentOrPrice: contentKind, mentions: [...labelTerms, ...KIND_PHRASES[cur.kind]], detail: `${cur.summary} (hash ${prev.hash} \u2192 ${cur.hash})`, beforeEventId: prev.id });
    }
  }
  for (const [k, prev] of baseline) {
    if (currentKeys.has(k) || prev.kind === "flags_inventory") continue;
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
      beforeEventId: p.id
    });
  }
  const changes = raw.map((c) => {
    const disclosed = changeDisclosedBy(c, notes);
    const mentionedOnly = !disclosed && textMentions(notes, c.mentions);
    return { ...c, disclosed, ...mentionedOnly ? { mentionedOnly } : {} };
  });
  return {
    approvalId: approval.id,
    approvalAt: approval.at,
    changes,
    unbaselined: [...unbaselined].sort(),
    pendingNotesEventId: opts.pendingNotes ? void 0 : notesEvent?.id,
    guidance: DRIFT_GUIDANCE
  };
}
function recordedPostApprovalChanges(state) {
  const bundles = state.apps.length > 1 ? state.apps.map((a) => a.bundleId) : [void 0];
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const bundleId of bundles) {
    const approval = state.outcomes.filter((o) => o.outcome === "approved" && sameBundle(o.bundleId, bundleId)).at(-1);
    if (!approval) continue;
    const t = Date.parse(approval.at);
    const latest = /* @__PURE__ */ new Map();
    for (const s of state.configSnapshots) {
      if (Date.parse(s.at) > t && sameBundle(s.bundleId, bundleId)) latest.set(`${s.kind}|${s.label}`, s);
    }
    const current = [...latest.values()].map((s) => ({ type: "config_snapshot", kind: s.kind, label: s.label, hash: s.hash, summary: s.summary, data: s.data }));
    const report = diffSinceApproved(state, current, { bundleId, pendingNotes: "" });
    for (const c of report.changes) {
      if (c.change === "removed") continue;
      const ev = c.kind === "ota_publish" ? state.otaPublishes.find((p) => p.id === c.beforeEventId) : [...latest.values()].find((s) => s.kind === c.kind && (s.label === c.label || c.kind === "flags_inventory"));
      if (!ev) continue;
      const key = `${ev.id}|${c.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...c, eventId: ev.id, at: ev.at, approvalId: approval.id, approvalAt: approval.at });
    }
  }
  return out;
}

// src/format.ts
var CLI_EQUIVALENT = {
  shield_scan: "appstore-shield scan",
  shield_preflight: "appstore-shield preflight",
  shield_ledger_import: "appstore-shield import",
  shield_lint_text: "appstore-shield lint"
};
function toolRef(tool, args = "") {
  const call = args ? `${tool} ${args}` : tool;
  const cli = CLI_EQUIVALENT[tool];
  return cli ? `${call} (MCP) or \`${cli}\` (CLI)` : `${call} (an MCP tool: run it from Claude Code or another MCP client)`;
}
function loc(f) {
  return f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "(project)";
}
function groupByRule(findings, maxLocations = 5) {
  const groups = /* @__PURE__ */ new Map();
  for (const f of findings) {
    const g = groups.get(f.rule);
    if (g) {
      g.count++;
      g.suppressible &&= f.suppressible;
      if (g.locations.length < maxLocations) g.locations.push(loc(f));
    } else {
      groups.set(f.rule, { rule: f.rule, severity: f.severity, guideline: f.guideline, count: 1, suppressible: f.suppressible, locations: [loc(f)] });
    }
  }
  return [...groups.values()];
}
function labelText(label) {
  if (label === "source") return "per Shoemaker's report";
  if (label === "apple") return "Apple text";
  if (label === "inferred") return "our inference";
  return label;
}
var someOf = (xs) => `${xs.slice(0, 3).join(", ")}${xs.length > 3 ? ", \u2026" : ""}`;
function truncatedNote(c) {
  return `Scan incomplete: the file budget was reached and ${c.notRead ? `${c.notRead} file(s) were` : "some files were"} not read, so findings in them are missing. Set "appPaths" in .appstore-shield/config.json to the app folders that ship, or narrow with --paths.`;
}
function unreadShippingNote(c) {
  return `${c.unreadShipping.length} file(s) that ship in the app were not read (over the size cap or unreadable), so findings in them are missing: ${someOf(c.unreadShipping)}.`;
}
function gateCoverageWarnings(c) {
  const out = [];
  if (c.truncated) out.push(truncatedNote(c));
  if (c.unreadShipping?.length) out.push(unreadShippingNote(c));
  return out;
}
function coverageNotes(c) {
  const out = [...c.appNotes ?? []];
  if (c.truncated) out.push(truncatedNote(c));
  if (c.unreadShipping?.length) out.push(unreadShippingNote(c));
  const otherLarge = c.tooLarge.filter((p) => !c.unreadShipping?.includes(p));
  if (otherLarge.length) out.push(`${otherLarge.length}${c.unreadShipping?.length ? " other" : ""} file(s) over the size cap were not read: ${someOf(otherLarge)}.`);
  if (c.excludedWorktrees.length)
    out.push(`Skipped ${c.excludedWorktrees.length} git worktree(s) inside the project (other checkouts, not this tree): ${someOf(c.excludedWorktrees)}.`);
  return out;
}
function gateCaveat(verdict) {
  return `${verdict} means no deterministic hold condition was found. Static checks miss things; this is not a guarantee of approval or against termination.`;
}
function countsLine(c) {
  return `${c.block} block, ${c.high} high, ${c.medium} medium, ${c.info} info`;
}
function cap(lines, max, more) {
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max - 1), more];
}
function scanSummary(scan, max = 25) {
  const head = [
    `appstore-shield scan of ${scan.root} (${scan.platforms.join(", ") || "platform not detected"}, ${scan.filesScanned} files)`,
    `Findings: ${countsLine(scan.counts)}${scan.suppressed.length ? `; ${scan.suppressed.length} suppressed by baseline` : ""}.`
  ];
  for (const c of scan.checks.filter((x) => x.error)) head.push(`Check ${c.id} failed: ${c.error}`);
  head.push(...coverageNotes(scan.coverage));
  for (const p of scan.baselineProblems) head.push(`Baseline: ${p}`);
  if (scan.refusedSuppressions.length) head.push(`${scan.refusedSuppressions.length} baseline suppression(s) ignored: those findings can only be cleared by fixing the code.`);
  const body = groupByRule(scan.findings).map(
    (g) => `- [${g.severity.toUpperCase()}] ${g.rule} (${g.guideline}) x${g.count}: ${g.locations.slice(0, 3).join(", ")}${g.count > 3 ? ", \u2026" : ""}`
  );
  if (!body.length) body.push("No findings. Static checks miss things; this is not a guarantee of approval.");
  return cap([...head, ...body], max, `\u2026 more rules; narrow with checks/paths or use detail: "full".`).join("\n");
}
function builtProductLines(r) {
  if (!r.builtProduct) return [];
  return r.builtProduct.map((b) => {
    if (!b.rejectionId) return `Built product: ${b.notes.join(" ")}`;
    if (b.error) return `Built product NOT swept for rejection ${b.rejectionId}: ${b.error}`;
    const partial = b.complete === false || b.encrypted ? " (partial sweep: not every file was read)" : "";
    return `Built product, rejection ${b.rejectionId}: ${b.hits ?? 0} residue match(es)${partial}${b.notes.length ? `. ${b.notes.join(" ")}` : "."}`;
  });
}
function preflightSummary(r, max = 25) {
  const g = r.gate;
  const lines = [
    `Gate: ${g.verdict} for ${r.root}${r.bundleId ? ` (${r.bundleId})` : ""}. Team ${r.ledger.teamId} (${r.ledger.teamIdSource}).`,
    `Findings: ${countsLine(r.scan.counts)}.`
  ];
  for (const w of r.ledger.warnings) lines.push(`Ledger warning: ${w}`);
  for (const c of r.scan.checks.filter((x) => x.error)) lines.push(`Check ${c.id} failed: ${c.error}`);
  for (const n of coverageNotes(r.scan.coverage)) if (!g.warnings.includes(n)) lines.push(n);
  const blocks = g.holdReasons.filter((h) => h.startsWith("Block finding "));
  const others = g.holdReasons.filter((h) => !h.startsWith("Block finding "));
  if (blocks.length) {
    const rules = groupByRule(r.scan.findings.filter((f) => f.severity === "block")).map((x) => x.count > 1 ? `${x.rule} x${x.count}` : x.rule);
    lines.push(`HOLD: ${blocks.length} block finding(s): ${rules.join(", ")}. Each must be fixed; the fixes are listed with the findings.`);
  }
  for (const h of others.slice(0, 8)) lines.push(`HOLD: ${h}`);
  if (others.length > 8) lines.push(`HOLD: \u2026 ${others.length - 8} more`);
  for (const w of g.warnings.slice(0, 5)) lines.push(`WARN: ${w}`);
  if (g.warnings.length > 5) lines.push(`WARN: \u2026 ${g.warnings.length - 5} more`);
  if (r.openRejections.length) {
    lines.push(`Open rejections: ${r.openRejections.map((o) => `${o.id} (${o.guidelines.join(", ") || "?"}, ${o.tier ?? "unverified"}${o.acked ? ", acked" : ""})`).join("; ")}`);
  }
  if (r.drift.approvalId) {
    const undisclosed = r.drift.changes.filter((c) => !c.disclosed);
    lines.push(`Drift since approval ${r.drift.approvalAt?.slice(0, 10)}: ${r.drift.changes.length} change(s), ${undisclosed.length} not disclosed in pending notes.`);
    const ordered = [...r.drift.changes].sort((a, b) => Number(b.contentOrPrice) - Number(a.contentOrPrice));
    for (const c of ordered.slice(0, 6)) {
      const guidance = c.contentOrPrice && c.disclosed ? ` \u2014 ${DISCLOSED_CONTENT_GUIDANCE}` : "";
      lines.push(`- ${c.contentOrPrice ? "content/price " : ""}${c.disclosed ? "(disclosed) " : "(not disclosed) "}${c.detail}${guidance}`);
    }
    if (ordered.length > 6) lines.push(`- \u2026 ${ordered.length - 6} more change(s) in drift.changes`);
  } else {
    lines.push("Drift: no approval recorded, so there is no baseline yet.");
  }
  lines.push(...builtProductLines(r));
  lines.push(`Manual checklist: ${r.manualChecklist.length} item(s) to confirm by hand before submitting.`);
  if (r.recorded.snapshotEvents.length || r.recorded.metadataEventId) {
    lines.push(`Recorded ${r.recorded.snapshotEvents.length} config snapshot(s)${r.recorded.metadataEventId ? " and a metadata snapshot" : ""}.`);
  }
  if (r.recorded.submissionEventId) lines.push(`Recorded submission event ${r.recorded.submissionEventId}.`);
  if (g.verdict !== "HOLD") lines.splice(1, 0, gateCaveat(g.verdict));
  if (g.verdict !== "HOLD") return cap(lines, max, "\u2026 (see structured output for the rest)").join("\n");
  return [...cap(lines, max - 1, "\u2026 (see structured output for the rest)"), "Do not submit for review: fix or remove what the HOLD reasons name, then run preflight again."].join("\n");
}

// src/ledger/triggers.ts
function resweepFromVerification(rejectionId, v) {
  const hits = v.residue.filter((h) => h.status === "PRESENT" || h.status === "GATED");
  const hit = hits[0];
  return {
    rejectionId,
    tier: v.tier,
    ...hit ? { detail: `${hit.needle} @ ${hit.file}${hit.line ? `:${hit.line}` : ""}` } : {},
    residueHits: hits.length,
    openInputPaths: v.inputPaths.filter((p) => !p.blocked).map((p) => p.inputPath)
  };
}
function rejectionAppliesTo(r, bundleId) {
  return !bundleId || !r.bundleId || r.bundleId === bundleId;
}
var DAY = 864e5;
function within(at, nowMs, days) {
  const t = Date.parse(at);
  return t <= nowMs && t > nowMs - days * DAY;
}
function isObjectionableGuideline(g) {
  return /^1\.[12](?:$|[.(\s])/.test(g.trim());
}
function day(at) {
  const t = Date.parse(at);
  return Number.isNaN(t) ? at.slice(0, 10) || "(no date)" : new Date(t).toISOString().slice(0, 10);
}
function sameApp(state, a, b) {
  return a === b || state.apps.length <= 1 && (!a || !b);
}
function normalizeAppName(name) {
  return name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\b(app|apps|pro|lite|free|plus|hd|ai|the)\b/g, " ").replace(/[^a-z0-9]+/g, "");
}
function levenshtein(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] ?? 0;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j] ?? 0;
      prev[j] = Math.min((prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length] ?? 0;
}
function nearDuplicateNames(names) {
  const pairs = [];
  const uniq = [...new Set(names.filter(Boolean))];
  for (let i = 0; i < uniq.length; i++) {
    for (let j = i + 1; j < uniq.length; j++) {
      const a = uniq[i];
      const b = uniq[j];
      const na = normalizeAppName(a);
      const nb = normalizeAppName(b);
      if (!na || !nb) continue;
      const allowed = Math.max(1, Math.floor(Math.min(na.length, nb.length) * 0.2));
      if (na === nb || levenshtein(na, nb) <= allowed) pairs.push([a, b]);
    }
  }
  return pairs;
}
function diffNames(events, at = (ev) => ev.at) {
  const last = /* @__PURE__ */ new Map();
  const out = [];
  for (const ev of events) {
    for (const s of ev.snapshots) {
      const key = `${ev.bundleId ?? ""}|${s.locale}`;
      const prev = last.get(key);
      for (const field of ["name", "subtitle"]) {
        const now = s[field];
        if (now === void 0) continue;
        const before = prev?.[field];
        if (before !== void 0 && before !== now) {
          out.push({ eventId: ev.id, at: at(ev), field, locale: s.locale, from: before, to: now });
        }
      }
      last.set(key, { name: s.name ?? prev?.name, subtitle: s.subtitle ?? prev?.subtitle });
    }
  }
  return out;
}
function submittedSnapshots(state) {
  const out = [];
  for (const sub of reviewSubmissions(state)) {
    const t = Date.parse(sub.at);
    const bundleId = state.submissions.find((s) => s.id === sub.eventId)?.bundleId ?? state.outcomes.find((o) => o.id === sub.eventId)?.bundleId;
    const ev = [...state.metadataSnapshots].reverse().find((m) => Date.parse(m.at) <= t && sameApp(state, m.bundleId, bundleId));
    if (ev && out.at(-1)?.ev !== ev) out.push({ ev, submittedAt: sub.at });
  }
  return out;
}
function metadataNameChanges(state) {
  const subs = submittedSnapshots(state);
  const when = new Map(subs.map((x) => [x.ev, x.submittedAt]));
  return diffNames(subs.map((x) => x.ev), (ev) => when.get(ev) ?? ev.at);
}
function unsubmittedNameEdits(state) {
  const last = submittedSnapshots(state).at(-1);
  const from = last ? state.metadataSnapshots.indexOf(last.ev) : 0;
  return diffNames(state.metadataSnapshots.slice(Math.max(0, from)));
}
function clarifiedBefore(state, r, beforeMs) {
  return state.events.some(
    (e) => Date.parse(e.at) <= beforeMs && (e.type === "interpretation" && e.rejectionId === r.id || e.type === "message_sent" && e.rejectionId === r.id && (e.purpose === "clarification" || e.purpose === "reply"))
  );
}
function verificationReason(v) {
  if (/not grounded in the rejection/i.test(v.summary)) return " (spec not grounded in the rejection)";
  const hit = v.residue.find((h) => h.status === "PRESENT" || h.status === "GATED" || h.status === "UNREFERENCED");
  if (hit) return ` (${hit.needle} @ ${hit.file}${hit.line ? `:${hit.line}` : ""})`;
  const open = v.inputPaths.find((p) => !p.blocked);
  if (open) return ` (input path not blocked: ${open.inputPath})`;
  return "";
}
function appLabel(state, bundleId) {
  if (bundleId) return bundleId;
  const only = state.apps.length === 1 ? state.apps[0] : void 0;
  return only ? only.name ?? only.bundleId : "app not recorded";
}
function reviewSubmissions(state) {
  const recorded = state.submissions.filter((s) => s.channel === "app_review");
  const out = recorded.map((s) => ({
    eventId: s.id,
    at: s.at,
    label: `${day(s.at)} ${appLabel(state, s.bundleId)} ${s.version ?? ""}${s.build ? ` (${s.build})` : ""}`.trim()
  }));
  const claimed = /* @__PURE__ */ new Set();
  const seenDecisions = [];
  for (const o of state.outcomes) {
    if (o.outcome !== "rejected" && o.outcome !== "approved" && o.outcome !== "metadata_rejected") continue;
    if (seenDecisions.some((x) => x.outcome === o.outcome && sameReviewDecision(x, o))) continue;
    const named = o.submissionId ? recorded.find((s) => s.id === o.submissionId) : void 0;
    const t = Date.parse(o.at);
    const paired = named ?? [...recorded].reverse().find((s) => !claimed.has(s.id) && Date.parse(s.at) <= t && sameApp(state, s.bundleId, o.bundleId));
    seenDecisions.push(o);
    if (paired) {
      claimed.add(paired.id);
      continue;
    }
    out.push({ eventId: o.id, at: o.at, label: `${day(o.at)} ${appLabel(state, o.bundleId)} ${o.outcome.replace("_", " ")} (inferred from outcome)` });
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
var OUR_WINDOW = "window chosen by appstore-shield; no source gives one";
var OUR_WINDOW_MARK = "*";
var OUR_WINDOW_LEGEND = `(${OUR_WINDOW_MARK} ${OUR_WINDOW})`;
var DISCLOSED_CONTENT_PREFIX = "Disclosed post-approval change:";
var DISCLOSED_CONTENT_GUIDANCE = "Disclosure records it; it does not make it compliant. Ship it in the build you submit so App Review sees it, or revert it (Guidelines 2.5.2, 2.5.19; DPLA 3.2(e)).";
function triggerChecklist(state, now) {
  const nowMs = Date.parse(now);
  const items = [];
  const reviewSubs = state.submissions.filter((s) => s.channel === "app_review");
  const counted = reviewSubmissions(state);
  for (const days of [7, 30, 90]) {
    const subs = counted.filter((s) => within(s.at, nowMs, days));
    items.push({
      id: `submissions_${days}d`,
      title: `App Review submissions, last ${days} days${OUR_WINDOW_MARK}`,
      windowNote: OUR_WINDOW,
      count: subs.length,
      window: `${days}d`,
      detail: subs.map((s) => s.label),
      basis: "Shoemaker reports that the 3.2(f) triggers he sees are rejection history: many submissions, many app name changes, many 1.1 rejections (anecdotal; no numbers given).",
      label: "source",
      contextOnly: true,
      eventIds: subs.map((s) => s.eventId)
    });
  }
  const recentRej = state.rejections.filter((r) => within(r.at, nowMs, 180));
  const byGuideline = /* @__PURE__ */ new Map();
  for (const r of recentRej) for (const g of r.guidelines.length ? r.guidelines : ["(none cited)"]) {
    byGuideline.set(g, [...byGuideline.get(g) ?? [], r]);
  }
  items.push({
    id: "rejections_180d",
    title: `Rejections by guideline, last 180 days${OUR_WINDOW_MARK}`,
    windowNote: OUR_WINDOW,
    count: recentRej.length,
    window: "180d",
    detail: [...byGuideline.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).map(([g, rs]) => `${g}: ${rs.length}`),
    basis: "Reviewers see prior rejection reasons, notes and screenshots; Shoemaker names rejection history as the trigger he sees.",
    label: "source",
    contextOnly: true,
    eventIds: recentRej.map((r) => r.id)
  });
  const objectionable = recentRej.filter((r) => r.guidelines.some(isObjectionableGuideline));
  items.push({
    id: "objectionable_rejections_180d",
    title: `Rejections under 1.1 (objectionable content) or 1.2 (user-generated content), last 180 days${OUR_WINDOW_MARK}`,
    windowNote: OUR_WINDOW,
    count: objectionable.length,
    window: "180d",
    detail: objectionable.map((r) => `${day(r.at)} ${appLabel(state, r.bundleId)} ${r.guidelines.filter(isObjectionableGuideline).join(", ")}${r.approvedBy ? " (later approved)" : " (open)"}`),
    basis: 'Shoemaker: "too many 1.1 rejections". Guideline 1.2: developers who "fail to remediate identified violations after notice may be considered in violation" of the Code of Conduct.',
    label: "source",
    contextOnly: false,
    eventIds: objectionable.map((r) => r.id)
  });
  const repeats = [...byGuideline.entries()].filter(([g, rs]) => g !== "(none cited)" && rs.length > 1);
  items.push({
    id: "repeat_guideline_rejections",
    title: `Guidelines cited in more than one rejection, last 180 days${OUR_WINDOW_MARK}`,
    windowNote: OUR_WINDOW,
    count: repeats.length,
    window: "180d",
    detail: repeats.map(([g, rs]) => `${g}: ${rs.map((r) => day(r.at)).join(", ")}`),
    basis: 'Guideline 2.3.1(b): "egregious or repeated behavior" leads to Program removal; 5.6: repeated manipulative or misleading behavior means removal.',
    label: "apple",
    contextOnly: false,
    eventIds: repeats.flatMap(([, rs]) => rs.map((r) => r.id))
  });
  const nameChanges = metadataNameChanges(state).filter((c) => within(c.at, nowMs, 90));
  items.push({
    id: "name_changes_90d",
    title: `App name or subtitle changes submitted to App Review, last 90 days${OUR_WINDOW_MARK}`,
    windowNote: OUR_WINDOW,
    count: nameChanges.length,
    window: "90d",
    detail: nameChanges.map((c) => `${day(c.at)} ${c.locale} ${c.field}: "${c.from}" \u2192 "${c.to}"`),
    basis: 'Shoemaker: "too many app name changes". Counted only between the metadata of recorded submissions; local edits never sent to Apple are listed separately.',
    label: "source",
    contextOnly: false,
    eventIds: [...new Set(nameChanges.map((c) => c.eventId))]
  });
  const localEdits = unsubmittedNameEdits(state);
  items.push({
    id: "local_name_edits",
    title: "Local metadata name or subtitle edits since the last submission (not sent to Apple)",
    count: localEdits.length,
    window: "since last submission",
    detail: localEdits.map((c) => `${day(c.at)} ${c.locale} ${c.field}: "${c.from}" \u2192 "${c.to}"`),
    basis: "Recorded preflight snapshots of local metadata files. Apple sees a name change only when it is submitted.",
    label: "inferred",
    contextOnly: true,
    eventIds: [...new Set(localEdits.map((c) => c.eventId))]
  });
  const quick = [];
  for (const r of recentRej.filter((x) => x.guidelines.some(isObjectionableGuideline))) {
    const t = Date.parse(r.at);
    for (const s of reviewSubs) {
      const st = Date.parse(s.at);
      if (st > t && st <= t + DAY && sameApp(state, s.bundleId, r.bundleId) && !clarifiedBefore(state, r, st)) {
        quick.push({ r, s });
      }
    }
  }
  items.push({
    id: "quick_resubmissions",
    title: "Resubmissions within 24h of a 1.1/1.2 rejection with no recorded interpretation or clarification",
    count: quick.length,
    window: "180d",
    detail: quick.map(({ r, s }) => `rejected ${r.at.slice(0, 16)} (${r.guidelines.join(", ")}) \u2192 resubmitted ${s.at.slice(0, 16)}`),
    basis: "Shoemaker's fair case for Apple: Apple may only learn of a cosmetic fix from later reports [source]. 1.2 asks for removal plus a compliance plan, which a same-day resubmission rarely shows.",
    label: "inferred",
    contextOnly: false,
    eventIds: quick.flatMap(({ r, s }) => [r.id, s.id])
  });
  const openUnverified = state.rejections.filter((r) => !r.approvedBy && !r.verification);
  items.push({
    id: "open_rejections_unverified",
    title: "Open rejections (no later approval) with no verification recorded",
    count: openUnverified.length,
    window: "all",
    detail: openUnverified.map((r) => `${r.id} ${day(r.at)} ${appLabel(state, r.bundleId)} ${r.guidelines.join(", ") || "(no guideline)"}`),
    basis: "Approval does not visibly close an earlier issue; reviewers see prior rejections. Treat every rejection as permanent history and close it with verification evidence.",
    label: "inferred",
    contextOnly: false,
    eventIds: openUnverified.map((r) => r.id)
  });
  const names = state.apps.map((a) => a.name).filter((n) => Boolean(n));
  const dupes = nearDuplicateNames(names);
  items.push({
    id: "apps_on_account",
    title: "Apps recorded on this developer account",
    count: state.apps.length,
    window: "all",
    detail: state.apps.map((a) => `${a.bundleId}${a.name ? ` "${a.name}"` : ""}`),
    basis: 'Guideline 4.3(b): "Repeated submissions of this kind may lead to removal from the Apple Developer Program."',
    label: "apple",
    contextOnly: true,
    eventIds: []
  });
  items.push({
    id: "near_duplicate_app_names",
    title: "Pairs of apps on this account with near-identical names",
    count: dupes.length,
    window: "all",
    detail: dupes.map(([a, b]) => `"${a}" ~ "${b}"`),
    basis: "Guideline 4.3(a) (no multiple Bundle IDs for the same app) and 4.3(b) (spam; repeated submissions may lead to removal from the Program). These are the developer's own apps; DPLA 3.2(f)'s naming clause is about names similar to a third-party app.",
    label: "apple",
    contextOnly: false,
    eventIds: []
  });
  const automated = reviewSubs.filter((s) => (s.source === "hook" || s.source === "ci") && within(s.at, nowMs, 30));
  const perDay = /* @__PURE__ */ new Map();
  for (const s of automated) perDay.set(day(s.at), (perDay.get(day(s.at)) ?? 0) + 1);
  items.push({
    id: "automation_volume_30d",
    title: `Submissions recorded by hooks or CI, last 30 days${OUR_WINDOW_MARK}`,
    windowNote: OUR_WINDOW,
    count: automated.length,
    window: "30d",
    detail: [...perDay.entries()].sort().map(([d, n]) => `${d}: ${n}`),
    basis: "An Apple Developer Forums report (thread 843244) suspects the developer's own App Store Connect automation led to the termination of about 50 apps. Secondary and anecdotal.",
    label: "inferred",
    contextOnly: false,
    eventIds: automated.map((s) => s.id)
  });
  for (const i of items) if (i.windowNote) i.basis = `${i.basis} Window (${i.window}): ${i.windowNote}.`;
  const first = items.find((i) => i.windowNote);
  if (first) first.title = `${first.title} ${OUR_WINDOW_LEGEND}`;
  return items;
}
function rejectionsToResweep(state, bundleId) {
  const staticClean = tierRank("STATIC_CLEAN");
  return state.rejections.filter(
    (r) => r.spec && r.outcome === "rejected" && !r.acked && rejectionAppliesTo(r, bundleId) && (r.approvedBy || tierRank(r.verification?.tier) >= staticClean)
  );
}
function resweepCause(fresh) {
  const open = fresh.openInputPaths ?? [];
  const residue = fresh.residueHits ?? (fresh.detail ? 1 : 0);
  if (residue > 0) {
    return `The rejected capability's code is back in the tree; remove it again and re-run ${toolRef("shield_remediation", "verify")}.`;
  }
  if (open.length) {
    return `No residue was found, but ${open.length} input path(s) no longer have a filter on their generation call, first: ${open[0]}. Add moderation to that call or remove the path, then re-run ${toolRef("shield_remediation", "verify")}.`;
  }
  if (fresh.tier === "UNVERIFIABLE") {
    return `No residue was found, but part of the spec can no longer be checked from the current tree (for example code it names was obfuscated or moved out of the repo). Run ${toolRef("shield_remediation", "verify")} to see which item, and resolve it.`;
  }
  return `Run ${toolRef("shield_remediation", "verify")} to see what changed since the recorded verification, and resolve it.`;
}
var HIGH_WARNING = /^\d+ high finding\(s\)/;
function namesRule(text, rule) {
  return new RegExp(`(?:^|[^\\w.])${rule.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.])`).test(text);
}
function highFindingsWarning(findings, holdReasons) {
  const high = findings.filter((x) => x.severity === "high");
  const rules = [...new Set(high.map((f) => f.rule))];
  const held = rules.filter((r) => holdReasons.some((h) => namesRule(h, r)));
  const rest = rules.filter((r) => !held.includes(r));
  if (!rest.length) return void 0;
  const count = high.filter((f) => rest.includes(f.rule)).length;
  return `${count} high finding(s): ${rest.slice(0, 8).join(", ")}${rest.length > 8 ? ", \u2026" : ""}${held.length ? ` (${held.length} more rule(s) not repeated here: already HOLD reasons above)` : ""}.`;
}
function refreshHighFindingsWarning(gate, findings) {
  const at = gate.warnings.findIndex((w) => HIGH_WARNING.test(w));
  const next = highFindingsWarning(findings, gate.holdReasons);
  if (at === -1) {
    if (next) gate.warnings.push(next);
  } else if (next) gate.warnings[at] = next;
  else gate.warnings.splice(at, 1);
}
function gateDecision(state, findings, now, drift, resweep = [], opts = {}) {
  const holdReasons = [];
  const warnings = [];
  for (const issue of state.locationIssues ?? []) holdReasons.push(issue);
  for (const f of findings.filter((x) => x.severity === "block")) {
    holdReasons.push(`Block finding ${f.rule} (Guideline ${f.guideline})${f.file ? ` at ${f.file}${f.line ? `:${f.line}` : ""}` : ""}: ${f.fix}`);
  }
  const staticClean = tierRank("STATIC_CLEAN");
  for (const r of state.rejections) {
    if (r.approvedBy || r.acked) continue;
    const g = r.guidelines.join(", ") || "no guideline cited";
    if (!rejectionAppliesTo(r, opts.bundleId)) {
      warnings.push(
        `Open rejection ${r.id} (Guideline ${g}, ${day(r.at)}) is for ${r.bundleId}, another app on this account, not ${opts.bundleId}. It stays in the account's history; verify its fix from that app's own repo (this tree cannot show it).`
      );
      continue;
    }
    if (r.outcome === "metadata_rejected") {
      warnings.push(`Open metadata rejection ${r.id} (${g}, ${day(r.at)}): confirm the store metadata was corrected before submitting.`);
      continue;
    }
    const fresh = resweep.find((x) => x.rejectionId === r.id);
    if (r.verification && tierRank(r.verification.tier) >= staticClean && fresh && tierRank(fresh.tier) < staticClean) {
      holdReasons.push(
        `Open rejection ${r.id} (Guideline ${g}, ${day(r.at)}): verified ${r.verification.tier} on ${day(r.verification.at)}${r.verification.sha ? ` at ${r.verification.sha.slice(0, 10)}` : ""}, but a sweep of the current tree is ${fresh.tier}${fresh.detail ? ` (${fresh.detail})` : ""}. ${resweepCause(fresh)}`
      );
      continue;
    }
    if (tierRank(r.verification?.tier) < staticClean) {
      const tier = r.verification ? `latest verification is ${r.verification.tier}${verificationReason(r.verification)}` : "no verification is recorded";
      holdReasons.push(
        `Open rejection ${r.id} (Guideline ${g}, ${day(r.at)}${r.bundleId ? `, ${r.bundleId}` : ""}): ${tier}. Remove the rejected capability and run ${toolRef("shield_remediation", "verify")} until it reaches STATIC_CLEAN or better, or the developer can acknowledge it themselves with \`appstore-shield ack\` in a terminal.`
      );
    }
  }
  for (const x of resweep) {
    const r = state.rejections.find((y) => y.id === x.rejectionId);
    if (!r?.approvedBy || r.acked || tierRank(x.tier) >= staticClean || !rejectionAppliesTo(r, opts.bundleId)) continue;
    warnings.push(
      `Rejection ${r.id} (Guideline ${r.guidelines.join(", ") || "no guideline cited"}, ${day(r.at)}) was later approved, but a sweep of the current tree against its saved spec is ${x.tier}${x.detail ? ` (${x.detail})` : ""}. Submitting the rejected capability again adds to the rejection history; remove it, or describe it specifically in Notes for Review if it changed.`
    );
  }
  if (drift) {
    for (const c of drift.changes) {
      if (c.contentOrPrice && !c.disclosed) {
        holdReasons.push(
          `Post-approval change not disclosed: ${c.detail}. ${CONTENT_DRIFT_GUIDANCE} Record the notes with ${toolRef("shield_ledger_record", "message_sent (purpose review_notes)")}.`
        );
      } else if (!c.contentOrPrice && !c.disclosed) {
        warnings.push(`Change since last approval: ${c.detail}. ${c.kind === "ota_publish" ? OTA_DRIFT_GUIDANCE : OTHER_DRIFT_GUIDANCE}`);
      }
    }
    const notesEvent = drift.pendingNotesEventId ? state.events.find((e) => e.id === drift.pendingNotesEventId) : void 0;
    const relied = drift.changes.filter((c) => c.contentOrPrice && c.disclosed);
    let reliedHeld = false;
    if (notesEvent && notesEvent.source !== "human" && relied.length) {
      const confirmed = state.events.some((e) => e.type === "attestation" && e.source === "human" && Date.parse(e.at) >= Date.parse(notesEvent.at) && e.statement.includes(notesEvent.id));
      if (!confirmed) {
        reliedHeld = true;
        holdReasons.push(
          `The disclosure of ${relied.map((c) => c.label).join(", ")} rests on Notes for Review recorded by the ${notesEvent.source} (${notesEvent.id}), not by the developer. Until the developer pastes those exact notes into App Store Connect and confirms it in a terminal with \`appstore-shield attest --statement "I pasted the Notes for Review ${notesEvent.id} into App Store Connect"\`, the change counts as undisclosed.`
        );
      }
    }
    if (!reliedHeld) for (const c of relied) warnings.push(`${DISCLOSED_CONTENT_PREFIX} ${c.detail}. ${DISCLOSED_CONTENT_GUIDANCE}`);
    if (drift.unbaselined.length) {
      warnings.push(`No snapshot recorded at the last approval for: ${drift.unbaselined.join(", ")}; drift for these cannot be checked until the next approval.`);
    }
  }
  const high = highFindingsWarning(findings, holdReasons);
  if (high) warnings.push(high);
  let legend = false;
  for (const item of triggerChecklist(state, now)) {
    if (item.contextOnly || item.count === 0) continue;
    const bare = item.title.replace(` ${OUR_WINDOW_LEGEND}`, "");
    const title = item.windowNote && !legend ? `${bare} ${OUR_WINDOW_LEGEND}` : bare;
    if (item.windowNote) legend = true;
    warnings.push(`${title}: ${item.count} (${labelText(item.label)}). ${item.detail.slice(0, 3).join("; ")}`);
  }
  if (state.terminations.length) {
    warnings.push(`${state.terminations.length} termination notice(s) recorded on this account; follow the appeal flow before submitting anything.`);
  }
  const verdict = holdReasons.length ? "HOLD" : warnings.length ? "WARN" : "CLEAR";
  return { verdict, holdReasons, warnings };
}

export {
  stableHash,
  redactSecrets,
  buildSnapshots,
  clausesOf,
  denialClauses,
  changeDisclosedBy,
  diffSinceApproved,
  recordedPostApprovalChanges,
  resweepFromVerification,
  rejectionAppliesTo,
  isObjectionableGuideline,
  normalizeAppName,
  nearDuplicateNames,
  metadataNameChanges,
  unsubmittedNameEdits,
  reviewSubmissions,
  OUR_WINDOW,
  OUR_WINDOW_MARK,
  OUR_WINDOW_LEGEND,
  DISCLOSED_CONTENT_PREFIX,
  DISCLOSED_CONTENT_GUIDANCE,
  triggerChecklist,
  rejectionsToResweep,
  highFindingsWarning,
  refreshHighFindingsWarning,
  gateDecision,
  toolRef,
  loc,
  groupByRule,
  labelText,
  gateCoverageWarnings,
  coverageNotes,
  gateCaveat,
  countsLine,
  scanSummary,
  builtProductLines,
  preflightSummary
};

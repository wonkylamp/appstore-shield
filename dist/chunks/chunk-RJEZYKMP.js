#!/usr/bin/env node
import { createRequire as __shieldCreateRequire } from "node:module";
const require = __shieldCreateRequire(import.meta.url);
import {
  agentEnvironment
} from "./chunk-NOEU6W5P.js";
import {
  appendEvent,
  approvalCounts,
  sameReviewDecision
} from "./chunk-KHNZSQW4.js";

// src/ledger/import.ts
import { constants } from "node:fs";
import { open } from "node:fs/promises";
function decodeQuotedPrintable(s) {
  return s.replace(/=\r?\n/g, "").replace(/(?:=[0-9A-F]{2})+/g, (m) => {
    const bytes = m.split("=").filter(Boolean).map((h) => parseInt(h, 16));
    return Buffer.from(bytes).toString("utf8");
  });
}
function htmlToText(s) {
  return s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&lsquo;/g, "'");
}
function normalizeText(raw) {
  let s = raw.replace(/\r\n?/g, "\n");
  if (/content-transfer-encoding:\s*quoted-printable/i.test(s) || /=\n/.test(s) || /=(?:3D|20|E2)/.test(s)) s = decodeQuotedPrintable(s);
  if (/<(html|body|div|p|table|br)[\s>/]/i.test(s)) s = htmlToText(s);
  return s.replace(/[   ]/g, " ").replace(/[–—]/g, "-").replace(/[‘’]/g, "'");
}
var SEGMENT_BREAK = /^\s*(?:-{3,}.*|_{3,}|={3,}|Begin forwarded message:?|-+\s*Original Message\s*-+|On .{4,80} wrote:)\s*$/im;
function splitSegments(text) {
  const lines = text.split("\n");
  const segs = [[]];
  for (const line of lines) {
    const cur = segs[segs.length - 1];
    const startsHeader = /^\s*From:\s/i.test(line) && cur.some((l) => l.trim());
    if (SEGMENT_BREAK.test(line) || startsHeader) {
      segs.push(startsHeader ? [line] : []);
      continue;
    }
    cur.push(line.replace(/^>+\s?/, ""));
  }
  return segs.map((s) => s.join("\n").trim()).filter(Boolean);
}
var GUIDELINE_NUM = String.raw`\d+(?:\.\d+)+(?:\s*\([a-z]{1,4}\))?`;
var GUIDELINE_RX = new RegExp(String.raw`Guidelines?\s+(${GUIDELINE_NUM}(?:\s*(?:,|and|&)\s*${GUIDELINE_NUM})*)`, "gi");
function extractGuidelines(text) {
  const out = [];
  for (const m of text.matchAll(GUIDELINE_RX)) {
    for (const part of (m[1] ?? "").split(/\s*(?:,|and|&)\s*/)) {
      const g = part.replace(/\s+/g, "").trim();
      if (g && !out.includes(g)) out.push(g);
    }
  }
  return out;
}
var GUIDELINE_HEADER_RX = new RegExp(String.raw`^[ \t]*Guidelines?[ \t]+(${GUIDELINE_NUM})[ \t]+-[ \t]+\S[^\n]*$`, "gim");
function citedGuidelines(text) {
  const headers = [...text.matchAll(GUIDELINE_HEADER_RX)].map((m) => (m[1] ?? "").replace(/\s+/g, ""));
  return headers.length ? [...new Set(headers)] : extractGuidelines(text);
}
function extractDplaSections(text) {
  const out = [];
  for (const m of text.matchAll(/(?:Section|§)\s*(\d+(?:\.\d+)+(?:\s*\([a-z]{1,4}\))?)/gi)) {
    const s = `DPLA ${(m[1] ?? "").replace(/\s+/g, "")}`;
    if (!out.includes(s)) out.push(s);
  }
  if (!out.length && /\b3\.2\s*\(f\)/i.test(text)) out.push("DPLA 3.2(f)");
  return out;
}
function extractVersion(text) {
  const vb = /\bVersion(?:\s+reviewed)?\s*:?\s*(?:(?:iOS|iPadOS|macOS|tvOS|watchOS|visionOS)\s+)?(\d+(?:\.\d+){0,3})\s*\((\d+(?:\.\d+)*)\)/i.exec(text);
  if (vb) return { version: vb[1], build: vb[2] };
  const v = /\bApp Version(?: Number)?\s*:\s*(\d+(?:\.\d+){0,3})/i.exec(text) ?? /\bVersion\s*:\s*(\d+(?:\.\d+){0,3})\b/i.exec(text);
  const b = /\bBuild(?: Number)?\s*:\s*(\d+(?:\.\d+)*)/i.exec(text);
  return { version: v?.[1], build: b?.[1] };
}
function extractField(text, rx) {
  const m = rx.exec(text);
  const v = m?.[1]?.trim().replace(/^["']|["']$/g, "");
  return v || void 0;
}
var MONTH_DATE = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+\d{1,2},?\s+\d{4}(?:,?\s+(?:at\s+)?\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]\.?M\.?(?![A-Za-z]))?)?/i;
var TRAILING_ZONE = /^[ \t]*\(?((?:GMT|UTC)[+-]\d{1,2}(?::?\d{2})?|[A-Z]{1,4}T|UTC|GMT|Z)\)?(?![A-Za-z])/;
var GMT_OFFSET = /\s*\(?(?:GMT|UTC)\s?([+-])(\d{1,2})(?::?(\d{2}))?\)?$/i;
var HAS_TIME = /\d{1,2}:\d{2}/;
var NUMERIC_OFFSET = /([+-])(\d{2}):?(\d{2})$/;
var MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
var ZONE_OFFSETS = {
  Z: 0,
  UT: 0,
  UTC: 0,
  GMT: 0,
  EST: -300,
  EDT: -240,
  CST: -360,
  CDT: -300,
  MST: -420,
  MDT: -360,
  PST: -480,
  PDT: -420,
  AKST: -540,
  AKDT: -480,
  HST: -600,
  WET: 0,
  WEST: 60,
  BST: 60,
  CET: 60,
  CEST: 120,
  EET: 120,
  EEST: 180,
  JST: 540,
  KST: 540,
  AEST: 600,
  AEDT: 660,
  NZST: 720,
  NZDT: 780
};
function formatOffset(minutes) {
  const a = Math.abs(minutes);
  return `${minutes < 0 ? "-" : "+"}${String(Math.floor(a / 60)).padStart(2, "0")}${String(a % 60).padStart(2, "0")}`;
}
var NUMERIC_DATE = /^(?:[A-Za-z]+\.?,?\s+)?(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?=$|[\s,T])/;
var NUMERIC_DATE_ANYWHERE = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/g;
function numericDayMonth(a, b) {
  if (a < 1 || b < 1 || a > 31 || b > 31) return void 0;
  if (a > 12 && b <= 12) return { day: a, month: b };
  if (b > 12 && a <= 12) return { day: b, month: a };
  if (a === b && a <= 12) return { day: a, month: a };
  return void 0;
}
var MONTH_LABELS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function ambiguousNumericDate(text) {
  for (const m of text.matchAll(NUMERIC_DATE_ANYWHERE)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a >= 1 && b >= 1 && a <= 12 && b <= 12 && a !== b) {
      return { date: m[0], dayFirst: `${a} ${MONTH_LABELS[b - 1]} ${m[3]}`, monthFirst: `${MONTH_LABELS[a - 1]} ${b}, ${m[3]}` };
    }
  }
  return void 0;
}
function parseDate(s) {
  let cleaned = s.replace(/\bat\b/i, "").replace(/(\d)(st|nd|rd|th)\b/, "$1").replace(/\s+/g, " ").trim();
  const num = NUMERIC_DATE.exec(cleaned);
  if (num) {
    const dm = numericDayMonth(Number(num[1]), Number(num[2]));
    if (!dm) return void 0;
    const pad = (n) => String(n).padStart(2, "0");
    cleaned = `${num[3]}-${pad(dm.month)}-${pad(dm.day)}${cleaned.slice(num[0].length).replace(/^,/, "")}`;
  }
  let unknownZone;
  let localZone = false;
  const gmt = GMT_OFFSET.exec(cleaned);
  if (gmt && HAS_TIME.test(cleaned)) {
    if (Number(gmt[2]) > 14 || Number(gmt[3] ?? 0) > 59) return void 0;
    cleaned = `${cleaned.slice(0, gmt.index).trim()} ${gmt[1]}${gmt[2].padStart(2, "0")}${gmt[3] ?? "00"}`;
  }
  const zone = /\s\(?([A-Z]{2,5}|Z)\)?$/.exec(cleaned);
  if (zone && !/^(?:AM|PM)$/.test(zone[1])) {
    cleaned = cleaned.slice(0, zone.index).trim();
    if (!NUMERIC_OFFSET.test(cleaned)) {
      const off = ZONE_OFFSETS[zone[1]];
      if (off === void 0) unknownZone = zone[1];
      else cleaned = `${cleaned} ${formatOffset(off)}`;
    }
  }
  let badClock = false;
  cleaned = cleaned.replace(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP])\.?M\.?(?![A-Za-z])/i, (_m, h, mi, se, ap) => {
    const hour = Number(h);
    if (hour < 1 || hour > 12) badClock = true;
    const h24 = hour % 12 + (ap.toUpperCase() === "P" ? 12 : 0);
    return `${String(h24).padStart(2, "0")}:${mi}${se ? `:${se}` : ""}`;
  });
  if (badClock) return void 0;
  let t;
  let offset = 0;
  const dateOnly = unknownZone ? cleaned.replace(/,?\s*\d{1,2}:\d{2}(?::\d{2})?.*$/, "").trim() : cleaned;
  if (unknownZone || !HAS_TIME.test(cleaned)) {
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOnly);
    const md = /^(?:[A-Za-z]+,?\s+)?([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(dateOnly);
    const dm = /^(?:[A-Za-z]+,?\s+)?(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})$/.exec(dateOnly);
    if (iso) t = Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 12);
    else if (md && MONTHS.includes(md[1].toLowerCase())) t = Date.UTC(Number(md[3]), MONTHS.indexOf(md[1].toLowerCase()), Number(md[2]), 12);
    else if (dm && MONTHS.includes(dm[2].toLowerCase())) t = Date.UTC(Number(dm[3]), MONTHS.indexOf(dm[2].toLowerCase()), Number(dm[1]), 12);
    else return void 0;
  } else {
    const off = NUMERIC_OFFSET.exec(cleaned);
    const zoned = Boolean(off) || /Z$/i.test(cleaned);
    if (off) offset = (off[1] === "-" ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3]));
    const spaced = /\s[+-]\d{2}:?\d{2}$/.test(cleaned) ? cleaned.replace(/T(?=\d)/, " ") : cleaned;
    if (zoned) t = Date.parse(spaced);
    else {
      t = Date.parse(cleaned.replace(/T(?=\d)/, " "));
      localZone = true;
      if (!Number.isNaN(t)) offset = -new Date(t).getTimezoneOffset();
    }
  }
  if (Number.isNaN(t)) return void 0;
  const y = new Date(t).getUTCFullYear();
  if (y < 2008 || y > 2100) return void 0;
  return {
    at: new Date(t).toISOString(),
    timed: !unknownZone && HAS_TIME.test(cleaned),
    offset,
    ...unknownZone ? { unknownZone } : {},
    ...localZone ? { localZone: true } : {}
  };
}
function localDay(p) {
  return new Date(Date.parse(p.at) + p.offset * 6e4).toISOString().slice(0, 10);
}
var hitOf = (p) => ({
  at: p.at,
  timed: p.timed,
  ...p.unknownZone ? { unknownZone: p.unknownZone } : {},
  ...p.localZone ? { localZone: true } : {}
});
function extractDateHit(text) {
  let dateOnly;
  for (const label of ["Review date", "Date", "Sent", "Received"]) {
    const m = new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, "im").exec(text);
    const raw = m?.[1];
    const d2 = raw ? parseDate(raw) : void 0;
    if (!raw || !d2) continue;
    if (!d2.timed) {
      dateOnly ??= hitOf(d2);
      continue;
    }
    if (!dateOnly || dateOnly.at.slice(0, 10) === localDay(d2)) return hitOf(d2);
  }
  if (dateOnly) return dateOnly;
  const iso = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/.exec(text);
  if (iso) {
    const d2 = parseDate(iso[0].replace(" ", "T"));
    if (d2) return hitOf(d2);
  }
  const md = MONTH_DATE.exec(text);
  if (!md) return void 0;
  const zone = HAS_TIME.test(md[0]) ? TRAILING_ZONE.exec(text.slice(md.index + md[0].length)) : null;
  const d = parseDate(zone ? `${md[0]} ${zone[1]}` : md[0]);
  return d ? hitOf(d) : void 0;
}
function extractDate(text) {
  return extractDateHit(text)?.at;
}
var TERMINATION_RX = /(?:membership|account)[^.\n]{0,80}\b(?:has been|have been|will be|is being|was)\s+terminated|\bterminat(?:e|ed|ing|ion of)\s+your\s+(?:Apple\s+Developer\s+Program\s+)?(?:membership|account)|notice of (?:pending\s+)?termination|pending termination|Section\s+3\.2\s*\(f\)|\b3\.2\s*\(f\)\s+of the/i;
var REJECTION_RX = /\bGuidelines?\s+\d+\.\d|\bwe noticed\b|\bwe (?:found|identified)\b[^.\n]{0,60}\b(?:issue|problem)|\bissue with your (?:app|submission)|\bdid not (?:comply|meet)|\bdoes not (?:comply|meet)|\bunresolved issues\b|\b(?:was|has been|have been) rejected\b|\bstatus\b[^.\n]{0,40}\bRejected\b|\bcouldn't approve|\bcould not approve|\bunable to approve/i;
var APPROVAL_RX = /ready for distribution|ready for sale|review of your (?:app|submission)[^.\n]{0,80}\bis complete|(?:has been|was) approved|eligible for distribution|pending developer release|accepted for distribution/i;
var APPLE_REPLY_RX = /^[ \t]*From Apple[ \t]*$|\bthank you for your (?:reply|response)\b|\bupon re-?review\b/im;
var CONDITIONAL_RX = /\b(?:may|might|could|can)\s+(?:result|lead)\b|\bif\b|\bcontinued\b|\bfurther\b|\brepeated\b/i;
function isTerminationNotice(text) {
  return text.split(/(?<=[.!?])\s+|\n+/).some((sentence) => TERMINATION_RX.test(sentence) && !CONDITIONAL_RX.test(sentence));
}
function classifySegment(text) {
  if (isTerminationNotice(text)) return "termination";
  if (/\bmetadata rejected\b/i.test(text)) return "metadata_rejected";
  if (APPLE_REPLY_RX.test(text)) return "apple_reply";
  if (/\bdeveloper rejected\b/i.test(text)) return "developer_rejected";
  if (REJECTION_RX.test(text)) return "rejected";
  if (APPROVAL_RX.test(text)) return "approved";
  return void 0;
}
var MAX_MESSAGE = 2e4;
function parseAppleText(raw, opts = {}) {
  const text = normalizeText(raw);
  const proposed = [];
  const ignored = [];
  const warnings = [];
  const segments = splitSegments(text);
  const pieces = segments.filter((s) => classifySegment(s)).length === 0 && classifySegment(text) ? [text.trim()] : segments;
  for (const seg of pieces) {
    let kind = classifySegment(seg);
    if (!kind) {
      if (seg.replace(/\s+/g, " ").length > 40) ignored.push(`Unrecognized text: "${seg.replace(/\s+/g, " ").slice(0, 100)}\u2026"`);
      continue;
    }
    const hit = extractDateHit(seg);
    const at = hit?.at;
    const named = extractField(seg, /\bBundle ID(?:entifier)?\s*:\s*([A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z0-9.-]+)/i);
    const bundleId = named ?? (kind === "termination" ? void 0 : opts.bundleId);
    const appName = extractField(seg, /^\s*App Name\s*:\s*(.+)$/im) ?? extractField(seg, /review of your (?:app|submission) for\s+(.+?)\s+is complete/i);
    const submissionId = extractField(seg, /\bSubmission ID\s*:\s*([0-9A-Za-z-]{8,})/i);
    let replyTo;
    if (kind === "apple_reply") {
      const isRejection = (e) => e.type === "outcome" && (e.outcome === "rejected" || e.outcome === "metadata_rejected") && e.submissionId === submissionId;
      const recorded = submissionId ? (opts.existing ?? []).filter((e) => isRejection(e)).at(-1) : void 0;
      const inBatch = submissionId ? proposed.some((p) => isRejection(p.event)) : false;
      if (recorded) replyTo = recorded.id;
      else if (!inBatch) {
        if (!REJECTION_RX.test(seg)) {
          if (seg.replace(/\s+/g, " ").length > 40) ignored.push(`Reply from Apple with no recorded rejection to attach it to${submissionId ? ` (submission ${submissionId})` : ""}: "${seg.replace(/\s+/g, " ").slice(0, 100)}\u2026"`);
          continue;
        }
        kind = "rejected";
        warnings.push(`A reply from App Review${submissionId ? ` for submission ${submissionId}` : ""} matches no recorded rejection, so it is recorded as a rejection. Import the original rejection message first to record it as Apple's reply instead.`);
      }
    }
    const { version, build } = extractVersion(seg);
    const vText = version ? ` ${version}${build ? ` (${build})` : ""}` : "";
    const where = `${appName ?? bundleId ?? "app?"}${vText}`;
    const dateNote = at ? at.slice(0, 10) : "no date found (will be recorded at import time; add at: to correct it)";
    if (hit?.unknownZone) {
      warnings.push(`The ${kind.replace("_", " ")} message for ${where} gives its time in "${hit.unknownZone}", a zone this tool cannot convert; only the calendar date was kept. Set "at" to the exact time if you have it.`);
    }
    if (hit?.timed && hit.localZone) {
      warnings.push(`The ${kind.replace("_", " ")} message for ${where} gives its time without a time zone; it was read as this computer's local time (${Intl.DateTimeFormat().resolvedOptions().timeZone}). Set "at" to the exact time if the email was shown in another zone.`);
    }
    const zoneKnown = Boolean(hit?.timed && !hit.localZone);
    const ambiguous = at ? void 0 : ambiguousNumericDate(seg);
    if (ambiguous) {
      warnings.push(`The ${kind.replace("_", " ")} message for ${where} gives an ambiguous day/month date ("${ambiguous.date}" is ${ambiguous.dayFirst} in day/month order and ${ambiguous.monthFirst} in month/day order), so no date was taken from it; it will be recorded with the import time unless you set "at".`);
    } else if (!at) warnings.push(`No date found in a ${kind} message for ${where}; it will be recorded with the import time unless you set "at".`);
    else if (!hit?.timed && kind !== "termination") {
      warnings.push(
        `Only a calendar date (${at.slice(0, 10)}) was found in the ${kind.replace("_", " ")} message for ${where}; it is recorded at 12:00 UTC, so it may be ordered wrongly against another App Review message from the same day. Set "at" to the time in the email header if you have it.`
      );
    }
    if (kind === "apple_reply") {
      const g = citedGuidelines(seg);
      proposed.push({
        event: {
          type: "apple_reply",
          text: seg.slice(0, MAX_MESSAGE),
          ...replyTo ? { rejectionId: replyTo } : {},
          ...submissionId ? { submissionId } : {},
          ...bundleId ? { bundleId } : {},
          ...at ? { at } : {}
        },
        ...at ? { timed: zoneKnown } : {},
        summary: `Apple reply ${where} ${dateNote}${g.length ? ` \u2014 Guideline ${g.join(", ")}` : ""} \u2014 submission ${submissionId}${replyTo ? ` (reply to rejection ${replyTo})` : " (reply to the rejection above)"}`
      });
    } else if (kind === "termination") {
      const sections = extractDplaSections(seg);
      const g = extractGuidelines(seg);
      proposed.push({
        event: { type: "termination", letter: seg.slice(0, MAX_MESSAGE), ...at ? { at } : {}, ...bundleId ? { bundleId } : {} },
        ...at ? { timed: zoneKnown } : {},
        summary: `Termination notice ${dateNote}${sections.length || g.length ? ` citing ${[...sections, ...g.map((x) => `Guideline ${x}`)].join(", ")}` : ""}`
      });
    } else {
      const guidelines = citedGuidelines(seg);
      if ((kind === "rejected" || kind === "metadata_rejected") && guidelines.length === 0) {
        warnings.push(`Rejection for ${where} names no guideline number; add guidelines manually if the Resolution Center message shows them.`);
      }
      proposed.push({
        event: {
          type: "outcome",
          outcome: kind,
          guidelines,
          ...kind === "approved" ? {} : { reviewerMessage: seg.slice(0, MAX_MESSAGE) },
          ...submissionId ? { submissionId } : {},
          ...bundleId ? { bundleId } : {},
          ...at ? { at } : {}
        },
        ...at ? { timed: zoneKnown } : {},
        summary: `${kind.replace("_", " ")} ${where} ${dateNote}${guidelines.length ? ` \u2014 Guideline ${guidelines.join(", ")}` : ""}${submissionId ? ` \u2014 submission ${submissionId}` : ""}`
      });
    }
    if (bundleId && (appName || !opts.bundleId)) {
      proposed.push({ event: { type: "app", bundleId, ...appName ? { name: appName } : {} }, summary: `app ${bundleId}${appName ? ` "${appName}"` : ""}` });
    } else if (appName && !bundleId) {
      warnings.push(`Message names app "${appName}" but no bundle id; pass bundle_id so events attach to the right app.`);
    }
  }
  return finalize({ format: "apple_text", proposed, ignored, warnings }, opts);
}
var KNOWN_ASC_FIELDS = /* @__PURE__ */ new Set([
  "id",
  "type",
  "attributes",
  "relationships",
  "links",
  "submissionId",
  "state",
  "platform",
  "versionString",
  "submittedDate",
  "outcome",
  "lastUpdatedDate",
  "appId",
  "items",
  "version",
  "build",
  "buildNumber",
  "bundleId",
  "createdDate",
  "updatedDate"
]);
function str(v) {
  return typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : void 0;
}
function looksLikeSubmission(o) {
  return "submittedDate" in o || "state" in o || "attributes" in o;
}
function collectEntries(json) {
  const ignored = [];
  if (Array.isArray(json)) return { entries: json.filter((x) => x && typeof x === "object"), ignored };
  if (json && typeof json === "object") {
    const o = json;
    for (const key of ["data", "history", "submissions", "results", "items"]) {
      const v = o[key];
      const single = v && typeof v === "object" && !Array.isArray(v) && looksLikeSubmission(v);
      if (Array.isArray(v) || single) {
        for (const k of Object.keys(o)) if (k !== key && k !== "links" && k !== "meta") ignored.push(`top-level field "${k}"`);
        const list = Array.isArray(v) ? v : [v];
        return { entries: list.filter((x) => x && typeof x === "object"), ignored };
      }
    }
    if (looksLikeSubmission(o)) return { entries: [o], ignored };
  }
  ignored.push("input is not a list of review submissions");
  return { entries: [], ignored };
}
function parseAscJson(input, opts = {}) {
  let json = input;
  const warnings = [];
  if (typeof input === "string") {
    try {
      json = JSON.parse(input);
    } catch (e) {
      return { format: "asc_json", proposed: [], ignored: [`not valid JSON: ${e.message}`], warnings };
    }
  }
  const { entries, ignored } = collectEntries(json);
  const proposed = [];
  const unknownFields = /* @__PURE__ */ new Set();
  entries.forEach((entry, i) => {
    const attrs = entry.attributes && typeof entry.attributes === "object" ? entry.attributes : {};
    const e = { ...entry, ...attrs };
    for (const k of [...Object.keys(entry), ...Object.keys(attrs)]) if (!KNOWN_ASC_FIELDS.has(k)) unknownFields.add(k);
    const submittedAt = str(e.submittedDate) ?? str(e.createdDate);
    const state = str(e.state)?.toUpperCase();
    const outcomeRaw = str(e.outcome)?.toLowerCase();
    const ascId = str(e.submissionId) ?? str(e.id);
    const version = str(e.versionString) ?? str(e.version);
    const build = str(e.buildNumber) ?? str(e.build);
    const bundleId = str(e.bundleId) ?? opts.bundleId;
    const label = `entry ${i + 1}${ascId ? ` (${ascId})` : ""}`;
    if (!submittedAt || Number.isNaN(Date.parse(submittedAt))) {
      ignored.push(`${label}: no submittedDate${state ? ` (state ${state})` : ""}, so it was never submitted for review`);
      return;
    }
    const at = new Date(submittedAt).toISOString();
    const timed = /T\d/.test(submittedAt);
    proposed.push({
      timed,
      event: { type: "submission", at, channel: "app_review", ...version ? { version } : {}, ...build ? { build } : {}, ...bundleId ? { bundleId } : {} },
      summary: `submission ${at.slice(0, 10)}${version ? ` v${version}` : ""}${ascId ? ` (${ascId})` : ""}`
    });
    let outcome;
    if (outcomeRaw === "approved" || outcomeRaw === "accepted") outcome = "approved";
    else if (outcomeRaw === "rejected" || state === "UNRESOLVED_ISSUES") outcome = "rejected";
    else if (state === "CANCELING" || state === "CANCELED" || state === "CANCELLED" || outcomeRaw === "canceled" || outcomeRaw === "cancelled") outcome = "withdrawn";
    if (!outcome) {
      if (state === "COMPLETE" || state === "COMPLETING" || outcomeRaw && !["waiting_for_review", "in_review"].includes(outcomeRaw)) {
        ignored.push(`${label}: outcome "${outcomeRaw ?? state}" is not approved/rejected; no outcome recorded`);
      }
      return;
    }
    const decidedAt = str(e.lastUpdatedDate);
    const outAt = decidedAt && !Number.isNaN(Date.parse(decidedAt)) && Date.parse(decidedAt) >= Date.parse(at) ? new Date(decidedAt).toISOString() : at;
    proposed.push({
      timed: outAt === at ? timed : /T\d/.test(decidedAt ?? ""),
      event: { type: "outcome", at: outAt, outcome, guidelines: [], ...ascId ? { submissionId: ascId } : {}, ...bundleId ? { bundleId } : {} },
      summary: `${outcome} ${outAt.slice(0, 10)}${version ? ` v${version}` : ""}${ascId ? ` (${ascId})` : ""}`
    });
    if (outcome === "rejected") {
      warnings.push(`${label}: the export has no guideline numbers; paste the Resolution Center message too so the rejection carries its guidelines.`);
    }
  });
  if (unknownFields.size) ignored.push(`fields not used: ${[...unknownFields].sort().join(", ")}`);
  if (!opts.bundleId && proposed.some((p) => !p.event.bundleId)) {
    warnings.push("The export has no bundle ids; pass bundle_id so these events attach to the right app.");
  }
  return finalize({ format: "asc_json", proposed, ignored, warnings }, opts);
}
function guidelinesKey(v) {
  return Array.isArray(v) ? [...v].map(String).sort().join(",") : "";
}
function enriches(p, e) {
  const have = new Set(Array.isArray(e.guidelines) ? e.guidelines.map(String) : []);
  const newGuidelines = Array.isArray(p.guidelines) && p.guidelines.some((g) => !have.has(String(g)));
  const newMessage = typeof p.reviewerMessage === "string" && p.reviewerMessage.trim() !== "" && !e.reviewerMessage;
  return newGuidelines || newMessage;
}
var optStr = (v) => typeof v === "string" ? v : void 0;
function decision(o) {
  return { at: optStr(o.at), submissionId: optStr(o.submissionId), reviewerMessage: optStr(o.reviewerMessage) };
}
function isDuplicate(p, e) {
  if (p.type !== e.type) return false;
  const near = (ms) => !p.at || !e.at || Math.abs(Date.parse(p.at) - Date.parse(e.at)) <= ms;
  switch (p.type) {
    case "app":
      return p.bundleId === e.bundleId && (!p.name || p.name === e.name);
    case "termination":
      return String(p.letter).trim() === String(e.letter ?? "").trim();
    case "apple_reply":
      return String(p.text).trim() === String(e.text ?? "").trim();
    case "submission":
      return p.bundleId === e.bundleId && p.version === e.version && p.build === e.build && near(6e4);
    case "outcome":
      if (p.outcome !== e.outcome || p.bundleId !== e.bundleId && p.bundleId && e.bundleId) return false;
      if (p.submissionId && e.submissionId) return sameReviewDecision(decision(p), decision(e)) && !enriches(p, e);
      if (p.bundleId !== e.bundleId) return false;
      return guidelinesKey(p.guidelines) === guidelinesKey(e.guidelines) && near(36e5);
    default:
      return false;
  }
}
function finalize(result, opts) {
  const existing = opts.existing ?? [];
  const accepted = [];
  result.proposed.forEach((p, i) => {
    const dup = existing.find((e) => isDuplicate(p.event, e)) ?? accepted.find((e) => isDuplicate(p.event, e));
    if (dup) {
      p.duplicateOf = dup.id;
      return;
    }
    const priors = p.event.type === "outcome" && typeof p.event.submissionId === "string" ? existing.filter((e) => e.type === "outcome" && e.submissionId === p.event.submissionId && e.outcome === p.event.outcome) : [];
    const sameReview = priors.find((e) => sameReviewDecision(decision(p.event), decision(e)));
    if (sameReview) {
      p.summary = `${p.summary} \u2014 adds the guidelines and App Review message to ${sameReview.id} (same review of this submission)`;
    } else if (priors.length) {
      const what = p.event.outcome === "rejected" ? "rejection" : p.event.outcome === "metadata_rejected" ? "metadata rejection" : `${String(p.event.outcome).replace("_", " ")} outcome`;
      p.summary = `${p.summary} \u2014 a new ${what} of a submission already decided in ${priors.map((e) => e.id).join(", ")} (resubmitted under the same id); recorded as its own ${what}`;
    }
    accepted.push({ ...p.event, id: `proposed_${i}` });
  });
  return result;
}
function looksJson(s) {
  const t = s.trim();
  return (t.startsWith("{") || t.startsWith("[")) && (t.endsWith("}") || t.endsWith("]"));
}
var IMPORT_FILE_MAX_BYTES = 2 * 1024 * 1024;
async function readImportPath(file) {
  const fh = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error("not a regular file");
    if (st.size > IMPORT_FILE_MAX_BYTES) throw new Error(`larger than ${IMPORT_FILE_MAX_BYTES / 1024 / 1024} MB`);
    return await fh.readFile("utf8");
  } finally {
    await fh.close();
  }
}
async function importAppleData(input, opts = {}) {
  let text = input.text;
  if (text === void 0 && input.filePath) {
    try {
      text = await readImportPath(input.filePath);
    } catch (e) {
      throw new Error(`Cannot read ${input.filePath}: ${e.message}. Pass an absolute path to a saved email (.eml/.txt) or an asc JSON export.`);
    }
  }
  if (!text?.trim()) throw new Error("Nothing to import: pass the pasted App Review message as text, or file_path to a saved email or asc JSON export.");
  if (looksJson(text)) {
    try {
      return parseAscJson(JSON.parse(text), opts);
    } catch {
    }
  }
  return parseAppleText(text, opts);
}
var FUTURE_SLACK_MS = 26 * 36e5;
var TIMED_SLACK_MS = 10 * 6e4;
function isFutureDated(p, now = Date.now()) {
  if (typeof p.event.at !== "string") return false;
  const timed = p.timed ?? !/T12:00:00(\.000)?Z$/.test(p.event.at);
  return Date.parse(p.event.at) > now + (timed ? TIMED_SLACK_MS : FUTURE_SLACK_MS);
}
async function commitImport(loc, result, opts = {}) {
  const requested = opts.source ?? "import";
  const source = requested === "import" && agentEnvironment(opts.env ?? process.env) ? "agent" : requested;
  const now = opts.now ?? Date.now();
  const out = [];
  for (const p of result.proposed) {
    if (p.duplicateOf) continue;
    if (typeof p.event.at === "string" && Date.parse(p.event.at) > now + FUTURE_SLACK_MS) {
      result.warnings.push(`Not stored: ${p.summary}. It is dated ${p.event.at}, after today; App Review messages cannot come from the future.`);
      continue;
    }
    if (p.event.type === "outcome" && p.event.outcome === "approved" && !approvalCounts({ source })) {
      result.warnings.push(`Not stored: ${p.summary}. Approvals close open rejections, so the developer imports them with \`appstore-shield import <file>\` in a terminal.`);
      continue;
    }
    out.push(await appendEvent(loc, p.event, { source, imported: true }));
  }
  return out;
}

export {
  normalizeText,
  extractGuidelines,
  citedGuidelines,
  extractDplaSections,
  extractVersion,
  ambiguousNumericDate,
  extractDateHit,
  extractDate,
  classifySegment,
  parseAppleText,
  parseAscJson,
  importAppleData,
  isFutureDated,
  commitImport
};

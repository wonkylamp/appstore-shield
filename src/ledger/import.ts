import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { agentEnvironment } from "../hookGuard.js";
import type { EventSource, LedgerEvent } from "./schema.js";
import { appendEvent, approvalCounts, sameReviewDecision, type LedgerLocation } from "./store.js";

/**
 * Parses what the developer already has (App Review emails, Resolution Center text,
 * `asc review history|submissions list --output json` exports they generated with their
 * own credentials) into proposed ledger events. Nothing here touches the network.
 */

export type ProposedEventInput = Record<string, unknown> & { type: LedgerEvent["type"]; at?: string };

export interface ProposedEvent {
  event: ProposedEventInput;
  summary: string;
  /** id of an existing ledger event this duplicates; duplicates are skipped on commit */
  duplicateOf?: string;
  /**
   * false when the message gave only a calendar date (stored at 12:00 UTC), or a time with no
   * zone: that one was read in this machine's zone, which may not be the zone it was written in,
   * so it gets the date-only slack in isFutureDated.
   */
  timed?: boolean;
}

export interface ImportResult {
  format: "apple_text" | "asc_json";
  proposed: ProposedEvent[];
  /** input pieces that were not understood, so the developer can check nothing was lost */
  ignored: string[];
  warnings: string[];
}

export interface ImportOptions {
  /** bundle id to attach when the input does not name one */
  bundleId?: string;
  /** existing ledger events, used to flag duplicates */
  existing?: LedgerEvent[];
}

// ---------- text normalization ----------

function decodeQuotedPrintable(s: string): string {
  return s
    .replace(/=\r?\n/g, "")
    .replace(/(?:=[0-9A-F]{2})+/g, (m) => {
      const bytes = m.split("=").filter(Boolean).map((h) => parseInt(h, 16));
      return Buffer.from(bytes).toString("utf8");
    });
}

function htmlToText(s: string): string {
  return s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'");
}

export function normalizeText(raw: string): string {
  let s = raw.replace(/\r\n?/g, "\n");
  if (/content-transfer-encoding:\s*quoted-printable/i.test(s) || /=\n/.test(s) || /=(?:3D|20|E2)/.test(s)) s = decodeQuotedPrintable(s);
  if (/<(html|body|div|p|table|br)[\s>/]/i.test(s)) s = htmlToText(s);
  return s.replace(/[   ]/g, " ").replace(/[–—]/g, "-").replace(/[‘’]/g, "'");
}

const SEGMENT_BREAK = /^\s*(?:-{3,}.*|_{3,}|={3,}|Begin forwarded message:?|-+\s*Original Message\s*-+|On .{4,80} wrote:)\s*$/im;

function splitSegments(text: string): string[] {
  const lines = text.split("\n");
  const segs: string[][] = [[]];
  for (const line of lines) {
    const cur = segs[segs.length - 1] as string[];
    const startsHeader = /^\s*From:\s/i.test(line) && cur.some((l) => l.trim());
    if (SEGMENT_BREAK.test(line) || startsHeader) {
      segs.push(startsHeader ? [line] : []);
      continue;
    }
    cur.push(line.replace(/^>+\s?/, ""));
  }
  return segs.map((s) => s.join("\n").trim()).filter(Boolean);
}

// ---------- field extraction ----------

const GUIDELINE_NUM = String.raw`\d+(?:\.\d+)+(?:\s*\([a-z]{1,4}\))?`;
const GUIDELINE_RX = new RegExp(String.raw`Guidelines?\s+(${GUIDELINE_NUM}(?:\s*(?:,|and|&)\s*${GUIDELINE_NUM})*)`, "gi");

export function extractGuidelines(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(GUIDELINE_RX)) {
    for (const part of (m[1] ?? "").split(/\s*(?:,|and|&)\s*/)) {
      const g = part.replace(/\s+/g, "").trim();
      if (g && !out.includes(g)) out.push(g);
    }
  }
  return out;
}

// App Review's own heading for each issue: "Guideline 1.1 - Safety - Objectionable Content".
const GUIDELINE_HEADER_RX = new RegExp(String.raw`^[ \t]*Guidelines?[ \t]+(${GUIDELINE_NUM})[ \t]+-[ \t]+\S[^\n]*$`, "gim");

/**
 * The guidelines a message cites. When it has header lines, only those count: a body sentence
 * pointing elsewhere ("the safeguards described in Guideline 1.2") is advice, not a citation, and
 * counting it would report 1.2 as cited twice. Without headers every mention is all there is.
 */
export function citedGuidelines(text: string): string[] {
  const headers = [...text.matchAll(GUIDELINE_HEADER_RX)].map((m) => (m[1] ?? "").replace(/\s+/g, ""));
  return headers.length ? [...new Set(headers)] : extractGuidelines(text);
}

export function extractDplaSections(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:Section|§)\s*(\d+(?:\.\d+)+(?:\s*\([a-z]{1,4}\))?)/gi)) {
    const s = `DPLA ${(m[1] ?? "").replace(/\s+/g, "")}`;
    if (!out.includes(s)) out.push(s);
  }
  if (!out.length && /\b3\.2\s*\(f\)/i.test(text)) out.push("DPLA 3.2(f)");
  return out;
}

export function extractVersion(text: string): { version?: string; build?: string } {
  // "App Version: iOS 1.3 (43)" names the platform before the number.
  const vb = /\bVersion(?:\s+reviewed)?\s*:?\s*(?:(?:iOS|iPadOS|macOS|tvOS|watchOS|visionOS)\s+)?(\d+(?:\.\d+){0,3})\s*\((\d+(?:\.\d+)*)\)/i.exec(text);
  if (vb) return { version: vb[1], build: vb[2] };
  const v = /\bApp Version(?: Number)?\s*:\s*(\d+(?:\.\d+){0,3})/i.exec(text) ?? /\bVersion\s*:\s*(\d+(?:\.\d+){0,3})\b/i.exec(text);
  const b = /\bBuild(?: Number)?\s*:\s*(\d+(?:\.\d+)*)/i.exec(text);
  return { version: v?.[1], build: b?.[1] };
}

function extractField(text: string, rx: RegExp): string | undefined {
  const m = rx.exec(text);
  const v = m?.[1]?.trim().replace(/^["']|["']$/g, "");
  return v || undefined;
}

const MONTH_DATE = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+\d{1,2},?\s+\d{4}(?:,?\s+(?:at\s+)?\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]\.?M\.?(?![A-Za-z]))?)?/i;
// Case-sensitive on purpose: a capitalized word after a date ("… 2:00 PM Guideline 1.1") is not a zone.
const TRAILING_ZONE = /^[ \t]*\(?((?:GMT|UTC)[+-]\d{1,2}(?::?\d{2})?|[A-Z]{1,4}T|UTC|GMT|Z)\)?(?![A-Za-z])/;
// Gmail and Outlook write "GMT-7" / "GMT+05:30"; read as plain GMT, the time was off by the offset.
const GMT_OFFSET = /\s*\(?(?:GMT|UTC)\s?([+-])(\d{1,2})(?::?(\d{2}))?\)?$/i;

const HAS_TIME = /\d{1,2}:\d{2}/;
const NUMERIC_OFFSET = /([+-])(\d{2}):?(\d{2})$/;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Minutes east of UTC for the zone names that appear in App Store Connect mail. Ambiguous ones (IST, CST in China) are left out. */
const ZONE_OFFSETS: Record<string, number> = {
  Z: 0, UT: 0, UTC: 0, GMT: 0,
  EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360, PST: -480, PDT: -420,
  AKST: -540, AKDT: -480, HST: -600,
  WET: 0, WEST: 60, BST: 60, CET: 60, CEST: 120, EET: 120, EEST: 180,
  JST: 540, KST: 540, AEST: 600, AEDT: 660, NZST: 720, NZDT: 780,
};

function formatOffset(minutes: number): string {
  const a = Math.abs(minutes);
  return `${minutes < 0 ? "-" : "+"}${String(Math.floor(a / 60)).padStart(2, "0")}${String(a % 60).padStart(2, "0")}`;
}

interface ParsedDate {
  at: string;
  timed: boolean;
  /** minutes east of UTC the time was written in; 0 when it named no zone */
  offset: number;
  /** a zone name we cannot convert; the time is dropped and only the calendar date kept */
  unknownZone?: string;
  /** the time named no zone and was read in this machine's zone, as the mail client showed it */
  localZone?: true;
}

const NUMERIC_DATE = /^(?:[A-Za-z]+\.?,?\s+)?(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?=$|[\s,T])/;
const NUMERIC_DATE_ANYWHERE = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/g;

/**
 * Day and month of a numeric date, only when the numbers themselves decide the order: a number
 * above 12 can only be the day. "06/10/2026" is June 10 in the US and October 6 in the UK; a guess
 * would move the event by months, out of or into the windows the gate counts.
 */
function numericDayMonth(a: number, b: number): { day: number; month: number } | undefined {
  if (a < 1 || b < 1 || a > 31 || b > 31) return undefined;
  if (a > 12 && b <= 12) return { day: a, month: b };
  if (b > 12 && a <= 12) return { day: b, month: a };
  if (a === b && a <= 12) return { day: a, month: a };
  return undefined;
}

const MONTH_LABELS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A numeric date whose day and month order cannot be told ("06/10/2026"), if the text has one. */
export function ambiguousNumericDate(text: string): { date: string; dayFirst: string; monthFirst: string } | undefined {
  for (const m of text.matchAll(NUMERIC_DATE_ANYWHERE)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a >= 1 && b >= 1 && a <= 12 && b <= 12 && a !== b) {
      return { date: m[0], dayFirst: `${a} ${MONTH_LABELS[b - 1]} ${m[3]}`, monthFirst: `${MONTH_LABELS[a - 1]} ${b}, ${m[3]}` };
    }
  }
  return undefined;
}

/**
 * A date without a time is a calendar date and is stored at noon UTC, so its date part is the
 * same everywhere ("September 17, 2026" read as local midnight lands on September 16 in UTC for
 * anyone east of Greenwich). A time with no zone ("Sent: Sunday, November 1, 2026 3:13 AM", as
 * Outlook and Gmail copy it) is in the reader's own zone, so it is read in this machine's zone.
 */
function parseDate(s: string): ParsedDate | undefined {
  let cleaned = s.replace(/\bat\b/i, "").replace(/(\d)(st|nd|rd|th)\b/, "$1").replace(/\s+/g, " ").trim();
  // Date.parse reads "06/10/2026" as June 10 everywhere; a UK or EU mail client means October 6.
  const num = NUMERIC_DATE.exec(cleaned);
  if (num) {
    const dm = numericDayMonth(Number(num[1]), Number(num[2]));
    if (!dm) return undefined;
    const pad = (n: number) => String(n).padStart(2, "0");
    cleaned = `${num[3]}-${pad(dm.month)}-${pad(dm.day)}${cleaned.slice(num[0].length).replace(/^,/, "")}`;
  }
  let unknownZone: string | undefined;
  let localZone = false;
  const gmt = GMT_OFFSET.exec(cleaned);
  if (gmt && HAS_TIME.test(cleaned)) {
    if (Number(gmt[2]) > 14 || Number(gmt[3] ?? 0) > 59) return undefined;
    cleaned = `${cleaned.slice(0, gmt.index).trim()} ${gmt[1]}${gmt[2]!.padStart(2, "0")}${gmt[3] ?? "00"}`;
  }
  const zone = /\s\(?([A-Z]{2,5}|Z)\)?$/.exec(cleaned);
  // "PM" ends the time; read as a zone it was dropped and every afternoon became morning.
  if (zone && !/^(?:AM|PM)$/.test(zone[1]!)) {
    cleaned = cleaned.slice(0, zone.index).trim();
    if (!NUMERIC_OFFSET.test(cleaned)) {
      const off = ZONE_OFFSETS[zone[1]!];
      if (off === undefined) unknownZone = zone[1];
      else cleaned = `${cleaned} ${formatOffset(off)}`;
    }
  }
  let badClock = false;
  cleaned = cleaned.replace(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP])\.?M\.?(?![A-Za-z])/i, (_m, h: string, mi: string, se: string | undefined, ap: string) => {
    const hour = Number(h);
    if (hour < 1 || hour > 12) badClock = true;
    const h24 = (hour % 12) + (ap.toUpperCase() === "P" ? 12 : 0);
    return `${String(h24).padStart(2, "0")}:${mi}${se ? `:${se}` : ""}`;
  });
  if (badClock) return undefined;

  let t: number;
  let offset = 0;
  // An unknown zone could move the time by up to a day either way; keep only the calendar date.
  const dateOnly = unknownZone ? cleaned.replace(/,?\s*\d{1,2}:\d{2}(?::\d{2})?.*$/, "").trim() : cleaned;
  if (unknownZone || !HAS_TIME.test(cleaned)) {
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOnly);
    const md = /^(?:[A-Za-z]+,?\s+)?([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(dateOnly);
    const dm = /^(?:[A-Za-z]+,?\s+)?(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})$/.exec(dateOnly);
    if (iso) t = Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 12);
    else if (md && MONTHS.includes(md[1]!.toLowerCase())) t = Date.UTC(Number(md[3]), MONTHS.indexOf(md[1]!.toLowerCase()), Number(md[2]), 12);
    else if (dm && MONTHS.includes(dm[2]!.toLowerCase())) t = Date.UTC(Number(dm[3]), MONTHS.indexOf(dm[2]!.toLowerCase()), Number(dm[1]), 12);
    else return undefined;
  } else {
    const off = NUMERIC_OFFSET.exec(cleaned);
    const zoned = Boolean(off) || /Z$/i.test(cleaned);
    if (off) offset = (off[1] === "-" ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3]));
    // "2026-10-01T10:00 +0000" does not parse; the same with a space does.
    const spaced = /\s[+-]\d{2}:?\d{2}$/.test(cleaned) ? cleaned.replace(/T(?=\d)/, " ") : cleaned;
    if (zoned) t = Date.parse(spaced);
    else {
      // Without "Z" or an offset, Date.parse reads a time in the process's own zone.
      t = Date.parse(cleaned.replace(/T(?=\d)/, " "));
      localZone = true;
      if (!Number.isNaN(t)) offset = -new Date(t).getTimezoneOffset();
    }
  }
  if (Number.isNaN(t)) return undefined;
  const y = new Date(t).getUTCFullYear();
  if (y < 2008 || y > 2100) return undefined;
  return {
    at: new Date(t).toISOString(),
    timed: !unknownZone && HAS_TIME.test(cleaned),
    offset,
    ...(unknownZone ? { unknownZone } : {}),
    ...(localZone ? { localZone: true as const } : {}),
  };
}

/** The calendar day a timed date names in its own zone ("Tue, 6 Oct 2026 21:00 -0700" is October 6). */
function localDay(p: ParsedDate): string {
  return new Date(Date.parse(p.at) + p.offset * 60_000).toISOString().slice(0, 10);
}

export interface DateHit {
  at: string;
  /** false when only a calendar date was found; `at` is then a synthetic 12:00 UTC */
  timed: boolean;
  /** a time zone name that could not be converted, so the time was dropped */
  unknownZone?: string;
  /** the time named no zone and was read in this machine's zone */
  localZone?: true;
}

const hitOf = (p: ParsedDate): DateHit => ({
  at: p.at,
  timed: p.timed,
  ...(p.unknownZone ? { unknownZone: p.unknownZone } : {}),
  ...(p.localZone ? { localZone: true as const } : {}),
});

export function extractDateHit(text: string): DateHit | undefined {
  let dateOnly: DateHit | undefined;
  for (const label of ["Review date", "Date", "Sent", "Received"]) {
    const m = new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, "im").exec(text);
    const raw = m?.[1];
    const d = raw ? parseDate(raw) : undefined;
    if (!raw || !d) continue;
    if (!d.timed) {
      dateOnly ??= hitOf(d);
      continue;
    }
    // A date-only "Review date" pinned to noon UTC would order a same-day approval before the
    // rejection it answers; the timed header of the same day is the real moment.
    if (!dateOnly || dateOnly.at.slice(0, 10) === localDay(d)) return hitOf(d);
  }
  if (dateOnly) return dateOnly;
  const iso = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/.exec(text);
  if (iso) {
    const d = parseDate(iso[0].replace(" ", "T"));
    if (d) return hitOf(d);
  }
  const md = MONTH_DATE.exec(text);
  if (!md) return undefined;
  const zone = HAS_TIME.test(md[0]) ? TRAILING_ZONE.exec(text.slice(md.index + md[0].length)) : null;
  const d = parseDate(zone ? `${md[0]} ${zone[1]}` : md[0]);
  return d ? hitOf(d) : undefined;
}

export function extractDate(text: string): string | undefined {
  return extractDateHit(text)?.at;
}

// ---------- classification ----------

type Kind = "termination" | "metadata_rejected" | "developer_rejected" | "rejected" | "approved" | "apple_reply";

const TERMINATION_RX =
  /(?:membership|account)[^.\n]{0,80}\b(?:has been|have been|will be|is being|was)\s+terminated|\bterminat(?:e|ed|ing|ion of)\s+your\s+(?:Apple\s+Developer\s+Program\s+)?(?:membership|account)|notice of (?:pending\s+)?termination|pending termination|Section\s+3\.2\s*\(f\)|\b3\.2\s*\(f\)\s+of the/i;
const REJECTION_RX =
  /\bGuidelines?\s+\d+\.\d|\bwe noticed\b|\bwe (?:found|identified)\b[^.\n]{0,60}\b(?:issue|problem)|\bissue with your (?:app|submission)|\bdid not (?:comply|meet)|\bdoes not (?:comply|meet)|\bunresolved issues\b|\b(?:was|has been|have been) rejected\b|\bstatus\b[^.\n]{0,40}\bRejected\b|\bcouldn't approve|\bcould not approve|\bunable to approve/i;
const APPROVAL_RX =
  /ready for distribution|ready for sale|review of your (?:app|submission)[^.\n]{0,80}\bis complete|(?:has been|was) approved|eligible for distribution|pending developer release|accepted for distribution/i;

// App Review answering the developer in an existing Resolution Center thread, not a new decision.
const APPLE_REPLY_RX = /^[ \t]*From Apple[ \t]*$|\bthank you for your (?:reply|response)\b|\bupon re-?review\b/im;

// Rejections often warn that "continued violations may result in termination"; that is not a notice.
const CONDITIONAL_RX = /\b(?:may|might|could|can)\s+(?:result|lead)\b|\bif\b|\bcontinued\b|\bfurther\b|\brepeated\b/i;

function isTerminationNotice(text: string): boolean {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .some((sentence) => TERMINATION_RX.test(sentence) && !CONDITIONAL_RX.test(sentence));
}

export function classifySegment(text: string): Kind | undefined {
  if (isTerminationNotice(text)) return "termination";
  if (/\bmetadata rejected\b/i.test(text)) return "metadata_rejected";
  if (APPLE_REPLY_RX.test(text)) return "apple_reply";
  if (/\bdeveloper rejected\b/i.test(text)) return "developer_rejected";
  if (REJECTION_RX.test(text)) return "rejected";
  if (APPROVAL_RX.test(text)) return "approved";
  return undefined;
}

const MAX_MESSAGE = 20_000;

/** Parses pasted App Review emails / Resolution Center messages / termination letters. */
export function parseAppleText(raw: string, opts: ImportOptions = {}): ImportResult {
  const text = normalizeText(raw);
  const proposed: ProposedEvent[] = [];
  const ignored: string[] = [];
  const warnings: string[] = [];
  const segments = splitSegments(text);
  // A single message pasted with stray separators should not be split into unclassifiable shards.
  const pieces = segments.filter((s) => classifySegment(s)).length === 0 && classifySegment(text) ? [text.trim()] : segments;

  for (const seg of pieces) {
    let kind = classifySegment(seg);
    if (!kind) {
      if (seg.replace(/\s+/g, " ").length > 40) ignored.push(`Unrecognized text: "${seg.replace(/\s+/g, " ").slice(0, 100)}…"`);
      continue;
    }
    const hit = extractDateHit(seg);
    const at = hit?.at;
    const named = extractField(seg, /\bBundle ID(?:entifier)?\s*:\s*([A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z0-9.-]+)/i);
    // A termination acts on the whole account; the letter must not be pinned to an app it does not name.
    const bundleId = named ?? (kind === "termination" ? undefined : opts.bundleId);
    const appName =
      extractField(seg, /^\s*App Name\s*:\s*(.+)$/im) ??
      extractField(seg, /review of your (?:app|submission) for\s+(.+?)\s+is complete/i);
    const submissionId = extractField(seg, /\bSubmission ID\s*:\s*([0-9A-Za-z-]{8,})/i);
    // A reply links to its rejection through the submission id. With no recorded rejection to link
    // to, a reply that names an issue is the only record of that rejection, so it is kept as one.
    let replyTo: string | undefined;
    if (kind === "apple_reply") {
      const isRejection = (e: Record<string, unknown>) => e.type === "outcome" && (e.outcome === "rejected" || e.outcome === "metadata_rejected") && e.submissionId === submissionId;
      const recorded = submissionId ? (opts.existing ?? []).filter((e) => isRejection(e as unknown as Record<string, unknown>)).at(-1) : undefined;
      const inBatch = submissionId ? proposed.some((p) => isRejection(p.event)) : false;
      if (recorded) replyTo = recorded.id;
      else if (!inBatch) {
        if (!REJECTION_RX.test(seg)) {
          if (seg.replace(/\s+/g, " ").length > 40) ignored.push(`Reply from Apple with no recorded rejection to attach it to${submissionId ? ` (submission ${submissionId})` : ""}: "${seg.replace(/\s+/g, " ").slice(0, 100)}…"`);
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
    const ambiguous = at ? undefined : ambiguousNumericDate(seg);
    if (ambiguous) {
      warnings.push(`The ${kind.replace("_", " ")} message for ${where} gives an ambiguous day/month date ("${ambiguous.date}" is ${ambiguous.dayFirst} in day/month order and ${ambiguous.monthFirst} in month/day order), so no date was taken from it; it will be recorded with the import time unless you set "at".`);
    } else if (!at) warnings.push(`No date found in a ${kind} message for ${where}; it will be recorded with the import time unless you set "at".`);
    else if (!hit?.timed && kind !== "termination") {
      warnings.push(
        `Only a calendar date (${at.slice(0, 10)}) was found in the ${kind.replace("_", " ")} message for ${where}; it is recorded at 12:00 UTC, so it may be ordered wrongly against another App Review message from the same day. Set "at" to the time in the email header if you have it.`,
      );
    }

    if (kind === "apple_reply") {
      const g = citedGuidelines(seg);
      proposed.push({
        event: {
          type: "apple_reply",
          text: seg.slice(0, MAX_MESSAGE),
          ...(replyTo ? { rejectionId: replyTo } : {}),
          ...(submissionId ? { submissionId } : {}),
          ...(bundleId ? { bundleId } : {}),
          ...(at ? { at } : {}),
        },
        ...(at ? { timed: zoneKnown } : {}),
        summary: `Apple reply ${where} ${dateNote}${g.length ? ` — Guideline ${g.join(", ")}` : ""} — submission ${submissionId}${replyTo ? ` (reply to rejection ${replyTo})` : " (reply to the rejection above)"}`,
      });
    } else if (kind === "termination") {
      const sections = extractDplaSections(seg);
      const g = extractGuidelines(seg);
      proposed.push({
        event: { type: "termination", letter: seg.slice(0, MAX_MESSAGE), ...(at ? { at } : {}), ...(bundleId ? { bundleId } : {}) },
        ...(at ? { timed: zoneKnown } : {}),
        summary: `Termination notice ${dateNote}${sections.length || g.length ? ` citing ${[...sections, ...g.map((x) => `Guideline ${x}`)].join(", ")}` : ""}`,
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
          ...(kind === "approved" ? {} : { reviewerMessage: seg.slice(0, MAX_MESSAGE) }),
          ...(submissionId ? { submissionId } : {}),
          ...(bundleId ? { bundleId } : {}),
          ...(at ? { at } : {}),
        },
        ...(at ? { timed: zoneKnown } : {}),
        summary: `${kind.replace("_", " ")} ${where} ${dateNote}${guidelines.length ? ` — Guideline ${guidelines.join(", ")}` : ""}${submissionId ? ` — submission ${submissionId}` : ""}`,
      });
    }
    if (bundleId && (appName || !opts.bundleId)) {
      proposed.push({ event: { type: "app", bundleId, ...(appName ? { name: appName } : {}) }, summary: `app ${bundleId}${appName ? ` "${appName}"` : ""}` });
    } else if (appName && !bundleId) {
      warnings.push(`Message names app "${appName}" but no bundle id; pass bundle_id so events attach to the right app.`);
    }
  }
  return finalize({ format: "apple_text", proposed, ignored, warnings }, opts);
}

// ---------- asc JSON ----------

const KNOWN_ASC_FIELDS = new Set([
  "id", "type", "attributes", "relationships", "links",
  "submissionId", "state", "platform", "versionString", "submittedDate", "outcome", "lastUpdatedDate", "appId", "items",
  "version", "build", "buildNumber", "bundleId", "createdDate", "updatedDate",
]);

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : undefined;
}

function looksLikeSubmission(o: Record<string, unknown>): boolean {
  return "submittedDate" in o || "state" in o || "attributes" in o;
}

function collectEntries(json: unknown): { entries: Record<string, unknown>[]; ignored: string[] } {
  const ignored: string[] = [];
  if (Array.isArray(json)) return { entries: json.filter((x) => x && typeof x === "object") as Record<string, unknown>[], ignored };
  if (json && typeof json === "object") {
    const o = json as Record<string, unknown>;
    for (const key of ["data", "history", "submissions", "results", "items"]) {
      const v = o[key];
      // A JSON:API GET of one review submission returns {"data": {…}}, a single resource rather than a list.
      const single = v && typeof v === "object" && !Array.isArray(v) && looksLikeSubmission(v as Record<string, unknown>);
      if (Array.isArray(v) || single) {
        for (const k of Object.keys(o)) if (k !== key && k !== "links" && k !== "meta") ignored.push(`top-level field "${k}"`);
        const list = Array.isArray(v) ? (v as unknown[]) : [v];
        return { entries: list.filter((x) => x && typeof x === "object") as Record<string, unknown>[], ignored };
      }
    }
    if (looksLikeSubmission(o)) return { entries: [o], ignored };
  }
  ignored.push("input is not a list of review submissions");
  return { entries: [], ignored };
}

/** Parses `asc review history` / `asc review submissions list` JSON (also JSON:API `data[].attributes`). */
export function parseAscJson(input: unknown, opts: ImportOptions = {}): ImportResult {
  let json = input;
  const warnings: string[] = [];
  if (typeof input === "string") {
    try {
      json = JSON.parse(input);
    } catch (e) {
      return { format: "asc_json", proposed: [], ignored: [`not valid JSON: ${(e as Error).message}`], warnings };
    }
  }
  const { entries, ignored } = collectEntries(json);
  const proposed: ProposedEvent[] = [];
  const unknownFields = new Set<string>();

  entries.forEach((entry, i) => {
    const attrs = (entry.attributes && typeof entry.attributes === "object" ? entry.attributes : {}) as Record<string, unknown>;
    const e: Record<string, unknown> = { ...entry, ...attrs };
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
      event: { type: "submission", at, channel: "app_review", ...(version ? { version } : {}), ...(build ? { build } : {}), ...(bundleId ? { bundleId } : {}) },
      summary: `submission ${at.slice(0, 10)}${version ? ` v${version}` : ""}${ascId ? ` (${ascId})` : ""}`,
    });

    let outcome: string | undefined;
    if (outcomeRaw === "approved" || outcomeRaw === "accepted") outcome = "approved";
    else if (outcomeRaw === "rejected" || state === "UNRESOLVED_ISSUES") outcome = "rejected";
    else if (state === "CANCELING" || state === "CANCELED" || state === "CANCELLED" || outcomeRaw === "canceled" || outcomeRaw === "cancelled") outcome = "withdrawn";
    if (!outcome) {
      if (state === "COMPLETE" || state === "COMPLETING" || (outcomeRaw && !["waiting_for_review", "in_review"].includes(outcomeRaw))) {
        ignored.push(`${label}: outcome "${outcomeRaw ?? state}" is not approved/rejected; no outcome recorded`);
      }
      return;
    }
    const decidedAt = str(e.lastUpdatedDate);
    const outAt = decidedAt && !Number.isNaN(Date.parse(decidedAt)) && Date.parse(decidedAt) >= Date.parse(at) ? new Date(decidedAt).toISOString() : at;
    proposed.push({
      timed: outAt === at ? timed : /T\d/.test(decidedAt ?? ""),
      event: { type: "outcome", at: outAt, outcome, guidelines: [], ...(ascId ? { submissionId: ascId } : {}), ...(bundleId ? { bundleId } : {}) },
      summary: `${outcome} ${outAt.slice(0, 10)}${version ? ` v${version}` : ""}${ascId ? ` (${ascId})` : ""}`,
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

// ---------- duplicates + entry point ----------

function guidelinesKey(v: unknown): string {
  return Array.isArray(v) ? [...v].map(String).sort().join(",") : "";
}

/** True when the proposal adds what the existing record lacks (an asc export has no guidelines or message). */
function enriches(p: ProposedEventInput, e: Record<string, unknown>): boolean {
  const have = new Set(Array.isArray(e.guidelines) ? e.guidelines.map(String) : []);
  const newGuidelines = Array.isArray(p.guidelines) && p.guidelines.some((g) => !have.has(String(g)));
  const newMessage = typeof p.reviewerMessage === "string" && p.reviewerMessage.trim() !== "" && !e.reviewerMessage;
  return newGuidelines || newMessage;
}

const optStr = (v: unknown) => (typeof v === "string" ? v : undefined);
function decision(o: Record<string, unknown>): { at?: string; submissionId?: string; reviewerMessage?: string } {
  return { at: optStr(o.at), submissionId: optStr(o.submissionId), reviewerMessage: optStr(o.reviewerMessage) };
}

function isDuplicate(p: ProposedEventInput, e: { type: string; at?: string } & Record<string, unknown>): boolean {
  if (p.type !== e.type) return false;
  const near = (ms: number) => !p.at || !e.at || Math.abs(Date.parse(p.at) - Date.parse(e.at)) <= ms;
  switch (p.type) {
    case "app":
      return p.bundleId === e.bundleId && (!p.name || p.name === e.name);
    case "termination":
      return String(p.letter).trim() === String(e.letter ?? "").trim();
    case "apple_reply":
      return String(p.text).trim() === String(e.text ?? "").trim();
    case "submission":
      return p.bundleId === e.bundleId && p.version === e.version && p.build === e.build && near(60_000);
    case "outcome":
      if (p.outcome !== e.outcome || (p.bundleId !== e.bundleId && p.bundleId && e.bundleId)) return false;
      if (p.submissionId && e.submissionId) return sameReviewDecision(decision(p), decision(e)) && !enriches(p, e);
      if (p.bundleId !== e.bundleId) return false;
      return guidelinesKey(p.guidelines) === guidelinesKey(e.guidelines) && near(3_600_000);
    default:
      return false;
  }
}

function finalize(result: ImportResult, opts: ImportOptions): ImportResult {
  const existing = (opts.existing ?? []) as unknown as ({ id: string; type: string; at?: string } & Record<string, unknown>)[];
  const accepted: ({ id: string; type: string } & Record<string, unknown>)[] = [];
  result.proposed.forEach((p, i) => {
    const dup = existing.find((e) => isDuplicate(p.event, e)) ?? accepted.find((e) => isDuplicate(p.event, e));
    if (dup) {
      p.duplicateOf = dup.id;
      return;
    }
    const priors =
      p.event.type === "outcome" && typeof p.event.submissionId === "string"
        ? existing.filter((e) => e.type === "outcome" && e.submissionId === p.event.submissionId && e.outcome === p.event.outcome)
        : [];
    const sameReview = priors.find((e) => sameReviewDecision(decision(p.event), decision(e)));
    if (sameReview) {
      p.summary = `${p.summary} — adds the guidelines and App Review message to ${sameReview.id} (same review of this submission)`;
    } else if (priors.length) {
      const what = p.event.outcome === "rejected" ? "rejection" : p.event.outcome === "metadata_rejected" ? "metadata rejection" : `${String(p.event.outcome).replace("_", " ")} outcome`;
      p.summary = `${p.summary} — a new ${what} of a submission already decided in ${priors.map((e) => e.id).join(", ")} (resubmitted under the same id); recorded as its own ${what}`;
    }
    accepted.push({ ...p.event, id: `proposed_${i}` });
  });
  return result;
}

function looksJson(s: string): boolean {
  const t = s.trim();
  return (t.startsWith("{") || t.startsWith("[")) && (t.endsWith("}") || t.endsWith("]"));
}

const IMPORT_FILE_MAX_BYTES = 2 * 1024 * 1024;

/** O_NONBLOCK plus an fstat check, so a FIFO or device answers with an error instead of hanging the import. */
async function readImportPath(file: string): Promise<string> {
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

export async function importAppleData(input: { text?: string; filePath?: string }, opts: ImportOptions = {}): Promise<ImportResult> {
  let text = input.text;
  if (text === undefined && input.filePath) {
    try {
      text = await readImportPath(input.filePath);
    } catch (e) {
      throw new Error(`Cannot read ${input.filePath}: ${(e as Error).message}. Pass an absolute path to a saved email (.eml/.txt) or an asc JSON export.`);
    }
  }
  if (!text?.trim()) throw new Error("Nothing to import: pass the pasted App Review message as text, or file_path to a saved email or asc JSON export.");
  if (looksJson(text)) {
    try {
      return parseAscJson(JSON.parse(text), opts);
    } catch {
      // not JSON after all; fall through to text parsing
    }
  }
  return parseAppleText(text, opts);
}

/** Apple's messages carry a date; one far ahead of now was typed, not received. Wide enough for date-only messages in any time zone. */
const FUTURE_SLACK_MS = 26 * 3_600_000;
const TIMED_SLACK_MS = 10 * 60_000;

/**
 * True when a proposal is dated after now. A date-only message is stored at 12:00 UTC, which is
 * still ahead of the clock for most of the day east of UTC, so it gets 26 h; a message with a
 * time gets clock skew only. Proposals without `timed` (built by hand) fall back to the 12:00Z shape.
 */
export function isFutureDated(p: Pick<ProposedEvent, "timed"> & { event: { at?: unknown } }, now = Date.now()): boolean {
  if (typeof p.event.at !== "string") return false;
  const timed = p.timed ?? !/T12:00:00(\.000)?Z$/.test(p.event.at);
  return Date.parse(p.event.at) > now + (timed ? TIMED_SLACK_MS : FUTURE_SLACK_MS);
}

/**
 * Appends every non-duplicate proposal, validated by appendEvent. `source` defaults to
 * "import"; a caller acting for an agent passes "agent", and then approvals are skipped
 * (with a warning on the result) because an approval closes open rejections.
 *
 * An "import" from a process an AI agent started (the MCP server, or the CLI run from an agent's
 * shell) is stored as "agent": the text came through the agent, so it cannot vouch for an approval.
 */
export async function commitImport(
  loc: Pick<LedgerLocation, "path">,
  result: ImportResult,
  opts: { source?: EventSource; env?: NodeJS.ProcessEnv; now?: number } = {},
): Promise<LedgerEvent[]> {
  const requested = opts.source ?? "import";
  const source: EventSource = requested === "import" && agentEnvironment(opts.env ?? process.env) ? "agent" : requested;
  const now = opts.now ?? Date.now();
  const out: LedgerEvent[] = [];
  for (const p of result.proposed) {
    if (p.duplicateOf) continue;
    // The backstop keeps the wide window for every event; callers refuse timed ones sooner with isFutureDated.
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

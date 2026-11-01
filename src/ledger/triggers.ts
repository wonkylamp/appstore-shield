import type { Finding } from "../finding.js";
import { CONTENT_DRIFT_GUIDANCE, OTA_DRIFT_GUIDANCE, OTHER_DRIFT_GUIDANCE, type DriftReport } from "./drift.js";
import type { EvidenceTier, LedgerEvent, LedgerState, RejectionState, Verification } from "./schema.js";
import { labelText, toolRef } from "../format.js";
import { sameReviewDecision, tierRank, type LedgerStateWithLocation } from "./store.js";

/**
 * Not a score. A checklist of the triggers Shoemaker reports (anecdotal, from his own
 * inbox) and Apple's own "repeated" language, with raw counts and the basis quote.
 * No invented thresholds and never a "distance to threshold": that would coach
 * rate-limit gaming rather than fixing the underlying problem.
 */
export interface TriggerItem {
  id: string;
  title: string;
  count: number;
  window: string;
  detail: string[];
  /** quote or paraphrase of where this signal comes from */
  basis: string;
  /** source = Shoemaker's post, apple = Apple primary text, inferred = our reading */
  label: "source" | "apple" | "inferred";
  /** context-only items (plain counts) are shown but never turn the gate to WARN */
  contextOnly: boolean;
  eventIds: string[];
  /** set when appstore-shield chose the window; the title then carries OUR_WINDOW_MARK */
  windowNote?: string;
}

export interface GateDecision {
  verdict: "CLEAR" | "WARN" | "HOLD";
  /** deterministic reasons only */
  holdReasons: string[];
  warnings: string[];
}

/** A fresh static residue sweep of the current tree against a rejection's saved spec. */
export interface ResweepResult {
  rejectionId: string;
  tier: EvidenceTier;
  /** what the sweep found, e.g. "lingerie outfit @ Sources/Prompt.swift:12" */
  detail?: string;
  /** residue hits still PRESENT or GATED; undefined when the caller did not count them */
  residueHits?: number;
  /** input paths the sweep found with no filter on their generation call */
  openInputPaths?: string[];
}

/** The resweep summary of a fresh verification, keeping why it fell short so the HOLD names the real cause. */
export function resweepFromVerification(rejectionId: string, v: Pick<Verification, "tier" | "residue" | "inputPaths">): ResweepResult {
  const hits = v.residue.filter((h) => h.status === "PRESENT" || h.status === "GATED");
  const hit = hits[0];
  return {
    rejectionId,
    tier: v.tier,
    ...(hit ? { detail: `${hit.needle} @ ${hit.file}${hit.line ? `:${hit.line}` : ""}` } : {}),
    residueHits: hits.length,
    openInputPaths: v.inputPaths.filter((p) => !p.blocked).map((p) => p.inputPath),
  };
}

export interface GateOptions {
  /** bundle id of the project being gated; rejections recorded for another app on the account do not hold it */
  bundleId?: string;
}

/**
 * A rejection belongs to the gated project unless both bundle ids are known and differ. The
 * ledger is per team, so another app's rejection is account history, not this tree's to verify.
 */
export function rejectionAppliesTo(r: Pick<RejectionState, "bundleId">, bundleId: string | undefined): boolean {
  return !bundleId || !r.bundleId || r.bundleId === bundleId;
}

const DAY = 86_400_000;

type Submission = Extract<LedgerEvent, { type: "submission" }>;

function within(at: string, nowMs: number, days: number): boolean {
  const t = Date.parse(at);
  return t <= nowMs && t > nowMs - days * DAY;
}

export function isObjectionableGuideline(g: string): boolean {
  return /^1\.[12](?:$|[.(\s])/.test(g.trim());
}

function day(at: string): string {
  const t = Date.parse(at);
  // Folded events are validated, but a caller-built state must not crash the gate on one bad date.
  return Number.isNaN(t) ? at.slice(0, 10) || "(no date)" : new Date(t).toISOString().slice(0, 10);
}

function sameApp(state: LedgerState, a?: string, b?: string): boolean {
  return a === b || (state.apps.length <= 1 && (!a || !b));
}

export function normalizeAppName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\b(app|apps|pro|lite|free|plus|hd|ai|the)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "");
}

function levenshtein(a: string, b: string): number {
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

/** Similar names among the developer's own apps, for Guideline 4.3(a)/(b); a text-similarity cut, not a risk threshold. */
export function nearDuplicateNames(names: string[]): [string, string][] {
  const pairs: [string, string][] = [];
  const uniq = [...new Set(names.filter(Boolean))];
  for (let i = 0; i < uniq.length; i++) {
    for (let j = i + 1; j < uniq.length; j++) {
      const a = uniq[i] as string;
      const b = uniq[j] as string;
      const na = normalizeAppName(a);
      const nb = normalizeAppName(b);
      if (!na || !nb) continue;
      const allowed = Math.max(1, Math.floor(Math.min(na.length, nb.length) * 0.2));
      if (na === nb || levenshtein(na, nb) <= allowed) pairs.push([a, b]);
    }
  }
  return pairs;
}

interface NameChange {
  eventId: string;
  at: string;
  field: "name" | "subtitle";
  locale: string;
  from: string;
  to: string;
}

type MetadataEvent = LedgerState["metadataSnapshots"][number];

function diffNames(events: MetadataEvent[], at: (ev: MetadataEvent) => string = (ev) => ev.at): NameChange[] {
  const last = new Map<string, { name?: string; subtitle?: string }>();
  const out: NameChange[] = [];
  for (const ev of events) {
    for (const s of ev.snapshots) {
      const key = `${ev.bundleId ?? ""}|${s.locale}`;
      const prev = last.get(key);
      for (const field of ["name", "subtitle"] as const) {
        const now = s[field];
        if (now === undefined) continue;
        const before = prev?.[field];
        if (before !== undefined && before !== now) {
          out.push({ eventId: ev.id, at: at(ev), field, locale: s.locale, from: before, to: now });
        }
      }
      last.set(key, { name: s.name ?? prev?.name, subtitle: s.subtitle ?? prev?.subtitle });
    }
  }
  return out;
}

/**
 * The metadata each App Review submission carried: per app, the latest local snapshot at or
 * before it. Every preflight records a snapshot, so most snapshots are local edits Apple never saw.
 */
function submittedSnapshots(state: LedgerState): { ev: MetadataEvent; submittedAt: string }[] {
  const out: { ev: MetadataEvent; submittedAt: string }[] = [];
  for (const sub of reviewSubmissions(state)) {
    const t = Date.parse(sub.at);
    const bundleId = state.submissions.find((s) => s.id === sub.eventId)?.bundleId ?? state.outcomes.find((o) => o.id === sub.eventId)?.bundleId;
    const ev = [...state.metadataSnapshots].reverse().find((m) => Date.parse(m.at) <= t && sameApp(state, m.bundleId, bundleId));
    if (ev && out.at(-1)?.ev !== ev) out.push({ ev, submittedAt: sub.at });
  }
  return out;
}

/** Name/subtitle changes Apple saw: between the metadata of consecutive App Review submissions, dated at the submission. */
export function metadataNameChanges(state: LedgerState): NameChange[] {
  const subs = submittedSnapshots(state);
  const when = new Map(subs.map((x) => [x.ev, x.submittedAt]));
  return diffNames(subs.map((x) => x.ev), (ev) => when.get(ev) ?? ev.at);
}

/** Name/subtitle edits in local metadata since the last submission (or since the first snapshot); not sent to Apple. */
export function unsubmittedNameEdits(state: LedgerState): NameChange[] {
  const last = submittedSnapshots(state).at(-1);
  const from = last ? state.metadataSnapshots.indexOf(last.ev) : 0;
  return diffNames(state.metadataSnapshots.slice(Math.max(0, from)));
}

function clarifiedBefore(state: LedgerState, r: RejectionState, beforeMs: number): boolean {
  return state.events.some(
    (e) =>
      Date.parse(e.at) <= beforeMs &&
      ((e.type === "interpretation" && e.rejectionId === r.id) ||
        (e.type === "message_sent" && e.rejectionId === r.id && (e.purpose === "clarification" || e.purpose === "reply"))),
  );
}

/** Why a verification stayed below STATIC_CLEAN, so a HOLD names the thing to fix and not only the tier. */
function verificationReason(v: NonNullable<RejectionState["verification"]>): string {
  if (/not grounded in the rejection/i.test(v.summary)) return " (spec not grounded in the rejection)";
  const hit = v.residue.find((h) => h.status === "PRESENT" || h.status === "GATED" || h.status === "UNREFERENCED");
  if (hit) return ` (${hit.needle} @ ${hit.file}${hit.line ? `:${hit.line}` : ""})`;
  const open = v.inputPaths.find((p) => !p.blocked);
  if (open) return ` (input path not blocked: ${open.inputPath})`;
  return "";
}

/** A bundle id when recorded; else the account's only recorded app; never a bare "app?". */
function appLabel(state: LedgerState, bundleId: string | undefined): string {
  if (bundleId) return bundleId;
  const only = state.apps.length === 1 ? state.apps[0] : undefined;
  return only ? (only.name ?? only.bundleId) : "app not recorded";
}

interface CountedSubmission {
  eventId: string;
  at: string;
  label: string;
}

/**
 * Recorded App Review submissions plus those an outcome proves but nobody recorded (backfilled
 * history), so importing a rejection never shows "0 submissions" beside it. An outcome is the
 * same submission as a recorded one when it names it, or when it is the first outcome for that
 * app after it; records of one review decision of an Apple submission id count once, and a
 * resubmission under that id (a later, different decision) counts again.
 */
export function reviewSubmissions(state: LedgerState): CountedSubmission[] {
  const recorded = state.submissions.filter((s) => s.channel === "app_review");
  const out: CountedSubmission[] = recorded.map((s) => ({
    eventId: s.id,
    at: s.at,
    label: `${day(s.at)} ${appLabel(state, s.bundleId)} ${s.version ?? ""}${s.build ? ` (${s.build})` : ""}`.trim(),
  }));
  const claimed = new Set<string>();
  const seenDecisions: typeof state.outcomes = [];
  for (const o of state.outcomes) {
    if (o.outcome !== "rejected" && o.outcome !== "approved" && o.outcome !== "metadata_rejected") continue;
    if (seenDecisions.some((x) => x.outcome === o.outcome && sameReviewDecision(x, o))) continue;
    const named = o.submissionId ? recorded.find((s) => s.id === o.submissionId) : undefined;
    const t = Date.parse(o.at);
    const paired =
      named ??
      [...recorded].reverse().find((s) => !claimed.has(s.id) && Date.parse(s.at) <= t && sameApp(state, s.bundleId, o.bundleId));
    seenDecisions.push(o);
    if (paired) {
      claimed.add(paired.id);
      continue;
    }
    out.push({ eventId: o.id, at: o.at, label: `${day(o.at)} ${appLabel(state, o.bundleId)} ${o.outcome.replace("_", " ")} (inferred from outcome)` });
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * Printed beside each count, after which the CLI adds the trigger's source ("per Shoemaker's
 * report"): neither Apple nor Shoemaker gives a window or a number, so the window is marked as ours.
 */
export const OUR_WINDOW = "window chosen by appstore-shield; no source gives one";
/** Marks a count whose window is ours; the legend is printed once, on the first marked line. */
export const OUR_WINDOW_MARK = "*";
export const OUR_WINDOW_LEGEND = `(${OUR_WINDOW_MARK} ${OUR_WINDOW})`;

export const DISCLOSED_CONTENT_PREFIX = "Disclosed post-approval change:";
export const DISCLOSED_CONTENT_GUIDANCE =
  "Disclosure records it; it does not make it compliant. Ship it in the build you submit so App Review sees it, or revert it (Guidelines 2.5.2, 2.5.19; DPLA 3.2(e)).";

export function triggerChecklist(state: LedgerState, now: string): TriggerItem[] {
  const nowMs = Date.parse(now);
  const items: TriggerItem[] = [];
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
      basis: 'Shoemaker reports that the 3.2(f) triggers he sees are rejection history: many submissions, many app name changes, many 1.1 rejections (anecdotal; no numbers given).',
      label: "source",
      contextOnly: true,
      eventIds: subs.map((s) => s.eventId),
    });
  }

  const recentRej = state.rejections.filter((r) => within(r.at, nowMs, 180));
  const byGuideline = new Map<string, RejectionState[]>();
  for (const r of recentRej) for (const g of r.guidelines.length ? r.guidelines : ["(none cited)"]) {
    byGuideline.set(g, [...(byGuideline.get(g) ?? []), r]);
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
    eventIds: recentRej.map((r) => r.id),
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
    eventIds: objectionable.map((r) => r.id),
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
    eventIds: repeats.flatMap(([, rs]) => rs.map((r) => r.id)),
  });

  const nameChanges = metadataNameChanges(state).filter((c) => within(c.at, nowMs, 90));
  items.push({
    id: "name_changes_90d",
    title: `App name or subtitle changes submitted to App Review, last 90 days${OUR_WINDOW_MARK}`,
    windowNote: OUR_WINDOW,
    count: nameChanges.length,
    window: "90d",
    detail: nameChanges.map((c) => `${day(c.at)} ${c.locale} ${c.field}: "${c.from}" → "${c.to}"`),
    basis: 'Shoemaker: "too many app name changes". Counted only between the metadata of recorded submissions; local edits never sent to Apple are listed separately.',
    label: "source",
    contextOnly: false,
    eventIds: [...new Set(nameChanges.map((c) => c.eventId))],
  });
  const localEdits = unsubmittedNameEdits(state);
  items.push({
    id: "local_name_edits",
    title: "Local metadata name or subtitle edits since the last submission (not sent to Apple)",
    count: localEdits.length,
    window: "since last submission",
    detail: localEdits.map((c) => `${day(c.at)} ${c.locale} ${c.field}: "${c.from}" → "${c.to}"`),
    basis: "Recorded preflight snapshots of local metadata files. Apple sees a name change only when it is submitted.",
    label: "inferred",
    contextOnly: true,
    eventIds: [...new Set(localEdits.map((c) => c.eventId))],
  });

  const quick: { r: RejectionState; s: Submission }[] = [];
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
    detail: quick.map(({ r, s }) => `rejected ${r.at.slice(0, 16)} (${r.guidelines.join(", ")}) → resubmitted ${s.at.slice(0, 16)}`),
    basis: "Shoemaker's fair case for Apple: Apple may only learn of a cosmetic fix from later reports [source]. 1.2 asks for removal plus a compliance plan, which a same-day resubmission rarely shows.",
    label: "inferred",
    contextOnly: false,
    eventIds: quick.flatMap(({ r, s }) => [r.id, s.id]),
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
    eventIds: openUnverified.map((r) => r.id),
  });

  const names = state.apps.map((a) => a.name).filter((n): n is string => Boolean(n));
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
    eventIds: [],
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
    eventIds: [],
  });

  const automated = reviewSubs.filter((s) => (s.source === "hook" || s.source === "ci") && within(s.at, nowMs, 30));
  const perDay = new Map<string, number>();
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
    eventIds: automated.map((s) => s.id),
  });

  // Structured output keeps the full caveat on every item (concise MCP output carries basis, not windowNote).
  for (const i of items) if (i.windowNote) i.basis = `${i.basis} Window (${i.window}): ${i.windowNote}.`;
  const first = items.find((i) => i.windowNote);
  if (first) first.title = `${first.title} ${OUR_WINDOW_LEGEND}`;
  return items;
}

/**
 * Rejections whose saved spec the caller should re-sweep before the gate: a verification is a
 * record of one moment, and a later commit can bring the residue back.
 */
export function rejectionsToResweep(state: LedgerState, bundleId?: string): RejectionState[] {
  const staticClean = tierRank("STATIC_CLEAN");
  // Another app's spec swept against this tree finds "nothing the spec names" and would hold with a false cause.
  return state.rejections.filter(
    (r) => r.spec && r.outcome === "rejected" && !r.acked && rejectionAppliesTo(r, bundleId) && (r.approvedBy || tierRank(r.verification?.tier) >= staticClean),
  );
}

/** Why a fresh sweep fell below STATIC_CLEAN, from what it found; never claims residue it did not see. */
function resweepCause(fresh: ResweepResult): string {
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

const HIGH_WARNING = /^\d+ high finding\(s\)/;

function namesRule(text: string, rule: string): boolean {
  return new RegExp(`(?:^|[^\\w.])${rule.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.])`).test(text);
}

/**
 * The advisory list of high findings, without the rules a HOLD reason already names: listing a
 * rule both as blocking and as advisory leaves the reader unsure which it is.
 */
export function highFindingsWarning(findings: Pick<Finding, "rule" | "severity">[], holdReasons: string[]): string | undefined {
  const high = findings.filter((x) => x.severity === "high");
  const rules = [...new Set(high.map((f) => f.rule))];
  const held = rules.filter((r) => holdReasons.some((h) => namesRule(h, r)));
  const rest = rules.filter((r) => !held.includes(r));
  if (!rest.length) return undefined;
  const count = high.filter((f) => rest.includes(f.rule)).length;
  return `${count} high finding(s): ${rest.slice(0, 8).join(", ")}${rest.length > 8 ? ", …" : ""}${held.length ? ` (${held.length} more rule(s) not repeated here: already HOLD reasons above)` : ""}.`;
}

/** For a caller that adds HOLD reasons after gateDecision: rebuilds the high-findings warning against the final list. */
export function refreshHighFindingsWarning(gate: GateDecision, findings: Pick<Finding, "rule" | "severity">[]): void {
  const at = gate.warnings.findIndex((w) => HIGH_WARNING.test(w));
  const next = highFindingsWarning(findings, gate.holdReasons);
  if (at === -1) {
    if (next) gate.warnings.push(next);
  } else if (next) gate.warnings[at] = next;
  else gate.warnings.splice(at, 1);
}

/**
 * HOLD only on deterministic conditions (PLAN §6): a block finding; an open binary
 * rejection whose latest verification is below STATIC_CLEAN and has no human ack, or whose
 * fresh re-sweep (`resweep`) no longer reaches STATIC_CLEAN; post-approval drift touching
 * content or price that pending notes do not disclose.
 */
export function gateDecision(
  state: LedgerState,
  findings: Finding[],
  now: string,
  drift?: DriftReport,
  resweep: ResweepResult[] = [],
  opts: GateOptions = {},
): GateDecision {
  const holdReasons: string[] = [];
  const warnings: string[] = [];

  for (const issue of (state as LedgerStateWithLocation).locationIssues ?? []) holdReasons.push(issue);

  for (const f of findings.filter((x) => x.severity === "block")) {
    holdReasons.push(`Block finding ${f.rule} (Guideline ${f.guideline})${f.file ? ` at ${f.file}${f.line ? `:${f.line}` : ""}` : ""}: ${f.fix}`);
  }

  const staticClean = tierRank("STATIC_CLEAN");
  for (const r of state.rejections) {
    if (r.approvedBy || r.acked) continue;
    const g = r.guidelines.join(", ") || "no guideline cited";
    if (!rejectionAppliesTo(r, opts.bundleId)) {
      warnings.push(
        `Open rejection ${r.id} (Guideline ${g}, ${day(r.at)}) is for ${r.bundleId}, another app on this account, not ${opts.bundleId}. It stays in the account's history; verify its fix from that app's own repo (this tree cannot show it).`,
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
        `Open rejection ${r.id} (Guideline ${g}, ${day(r.at)}): verified ${r.verification.tier} on ${day(r.verification.at)}${r.verification.sha ? ` at ${r.verification.sha.slice(0, 10)}` : ""}, but a sweep of the current tree is ${fresh.tier}${fresh.detail ? ` (${fresh.detail})` : ""}. ${resweepCause(fresh)}`,
      );
      continue;
    }
    if (tierRank(r.verification?.tier) < staticClean) {
      const tier = r.verification ? `latest verification is ${r.verification.tier}${verificationReason(r.verification)}` : "no verification is recorded";
      holdReasons.push(
        `Open rejection ${r.id} (Guideline ${g}, ${day(r.at)}${r.bundleId ? `, ${r.bundleId}` : ""}): ${tier}. Remove the rejected capability and run ${toolRef("shield_remediation", "verify")} until it reaches STATIC_CLEAN or better, or the developer can acknowledge it themselves with \`appstore-shield ack\` in a terminal.`,
      );
    }
  }

  for (const x of resweep) {
    const r = state.rejections.find((y) => y.id === x.rejectionId);
    if (!r?.approvedBy || r.acked || tierRank(x.tier) >= staticClean || !rejectionAppliesTo(r, opts.bundleId)) continue;
    warnings.push(
      `Rejection ${r.id} (Guideline ${r.guidelines.join(", ") || "no guideline cited"}, ${day(r.at)}) was later approved, but a sweep of the current tree against its saved spec is ${x.tier}${x.detail ? ` (${x.detail})` : ""}. Submitting the rejected capability again adds to the rejection history; remove it, or describe it specifically in Notes for Review if it changed.`,
    );
  }

  if (drift) {
    for (const c of drift.changes) {
      if (c.contentOrPrice && !c.disclosed) {
        holdReasons.push(
          `Post-approval change not disclosed: ${c.detail}. ${CONTENT_DRIFT_GUIDANCE} Record the notes with ${toolRef("shield_ledger_record", "message_sent (purpose review_notes)")}.`,
        );
      } else if (!c.contentOrPrice && !c.disclosed) {
        warnings.push(`Change since last approval: ${c.detail}. ${c.kind === "ota_publish" ? OTA_DRIFT_GUIDANCE : OTHER_DRIFT_GUIDANCE}`);
      }
    }
    // The ledger cannot see App Store Connect, and CI passes on WARN: notes an agent recorded lift
    // the HOLD only once the developer confirms in a terminal that they pasted them.
    const notesEvent = drift.pendingNotesEventId ? state.events.find((e) => e.id === drift.pendingNotesEventId) : undefined;
    const relied = drift.changes.filter((c) => c.contentOrPrice && c.disclosed);
    let reliedHeld = false;
    if (notesEvent && notesEvent.source !== "human" && relied.length) {
      const confirmed = state.events.some((e) => e.type === "attestation" && e.source === "human" && Date.parse(e.at) >= Date.parse(notesEvent.at) && e.statement.includes(notesEvent.id));
      if (!confirmed) {
        reliedHeld = true;
        holdReasons.push(
          `The disclosure of ${relied.map((c) => c.label).join(", ")} rests on Notes for Review recorded by the ${notesEvent.source} (${notesEvent.id}), not by the developer. Until the developer pastes those exact notes into App Store Connect and confirms it in a terminal with \`appstore-shield attest --statement "I pasted the Notes for Review ${notesEvent.id} into App Store Connect"\`, the change counts as undisclosed.`,
        );
      }
    }
    // Disclosure records a content change; it does not make it reviewed. Until a later approval
    // resets the baseline the content is live without review, so the gate keeps saying so.
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

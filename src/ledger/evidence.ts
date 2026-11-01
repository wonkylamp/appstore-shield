import type { Finding } from "../finding.js";
import type { LedgerEvent, LedgerState, RejectionState, RemoteControl } from "./schema.js";
import { changeDisclosedBy, recordedPostApprovalChanges, type RecordedChange } from "./drift.js";
import { probeConfirmation, tierRank } from "./store.js";
import { isObjectionableGuideline, metadataNameChanges, nearDuplicateNames, reviewSubmissions } from "./triggers.js";

/**
 * Facts, not prose. Claude writes the text from these typed facts and shield_lint_text
 * checks it. Every fact carries the ledger event it came from so nothing is invented.
 */

export type EvidencePurpose = "review_notes" | "reply" | "clarification" | "appeal_review_board" | "appeal_termination";

export interface DisclosureInventory {
  remoteControls?: RemoteControl[];
  ota?: { provider: string; detail?: string }[];
  /** AI providers / hosts the app sends user data to, e.g. "OpenAI", "fal.ai" */
  aiServices?: string[];
  /** where the scan saw each AI service called, so a denial can be answered with the call site */
  aiSinks?: { provider: string; file: string; line?: number }[];
}

export interface Fact {
  id: string;
  text: string;
  /** ledger event the fact comes from; absent for repo inventory facts */
  eventId?: string;
  kind: string;
}

export interface ScaffoldSection {
  section: string;
  guidance: string;
}

export interface PrivateHypothesis {
  rank: number;
  category: string;
  basis: string;
  supportingEventIds: string[];
}

export interface EvidencePack {
  purpose: EvidencePurpose;
  facts: Fact[];
  scaffold: ScaffoldSection[];
  /** UTF-8 byte limit for the outgoing text, when Apple documents one */
  byteBudget: number | null;
  /** appeal purposes only; guesses about what Apple may mean. Never paste these into anything sent to Apple. */
  privateHypotheses?: { neverPaste: true; warning: string; items: PrivateHypothesis[] };
  warnings: string[];
}

const day = (at: string) => at.slice(0, 10);

type Attestation = Extract<LedgerEvent, { type: "attestation" }>;

/** Only attestations the developer typed in a terminal count; anything else is the agent's wording. */
export function humanAttestations(state: LedgerState): Attestation[] {
  return state.events.filter((e): e is Attestation => e.type === "attestation" && e.source === "human");
}

const ATTEST_STOP = new Set(
  "that this with from have been were will would which their there these those they them then than into onto over also only just when what where while about after before because developer developers states stated confirms attests attested".split(" "),
);

function contentWords(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9][a-z0-9'-]{3,}/g) ?? [])
    .map((w) => w.replace(/'s$/, "").replace(/(?:ing|ed|es|s)$/, ""))
    .filter((w) => w.length >= 3 && !ATTEST_STOP.has(w));
}

/**
 * The human attestation a sentence worded as "The developer states …" rests on, if any: most of
 * the sentence's content words must appear in one statement the developer recorded.
 */
export function attestationMatching(state: LedgerState, sentence: string): Attestation | undefined {
  const words = [...new Set(contentWords(sentence.replace(/^\s*(?:[-*•]\s*)?the developer (?:states|confirms|attests)(?: that)?/i, "")))];
  if (!words.length) return humanAttestations(state)[0];
  return humanAttestations(state).find((a) => {
    const have = new Set(contentWords(a.statement));
    return words.filter((w) => have.has(w)).length / words.length >= 0.6;
  });
}

/** Wording that confesses conduct; an appeal may only admit what the developer confirmed in a terminal. */
export const MISTAKE_RX = /\bmistakes?\b|\berrors?\b|\bwe were wrong\b|manipulat|mislead|misled|decei|decept|dishonest|untruth|\bl(?:ied|ying)\b|fraud|\bhid\b|\bhidden\b|conceal|trick|cheat|\bfake|fabricat|bait/i;

/** "I am not aware of …", "we did not knowingly …": the developer's own denial of the conduct. */
export const NOT_AWARE_RX = /\b(?:not|never been)\s+aware\b|\bunaware\b|\bno knowledge\b|\bno idea\b|\bnever knew\b|\b(?:did not|didn't|do not|don't)\s+know\b|\bnot knowingly\b|\bnever knowingly\b/i;
const NEGATED_CONDUCT = /\b(?:not|never|no|n't)\b(?:\s+\w+){0,3}?\s+(?:manipulat|mislead|misled|decei|decept|dishonest|untruth|lied\b|lying\b|fraud|hid\b|hidden|conceal|trick|cheat|fake|fabricat|bait|mistake|error)\w*/gi;

/** Statements of mistakes the developer confirmed (human attestations that admit something). A denial is not an admission. */
export function confirmedMistakeStatements(state: LedgerState): string[] {
  return humanAttestations(state)
    .map((a) => a.statement)
    .filter((s) => MISTAKE_RX.test(s.replace(new RegExp(`(?:${NOT_AWARE_RX.source})[^,;.]*`, "gi"), " ").replace(NEGATED_CONDUCT, " ")));
}

/**
 * Apple's words are on record only when parsed from Apple's own message or export by the importer
 * (`via: "import"`), imported in a terminal, or entered by the developer. Text an agent recorded by
 * hand with shield_ledger_record is the agent's account of what Apple said, never Apple's words.
 */
export function isAppleRecord(e: Pick<LedgerEvent, "source"> & { via?: string }): boolean {
  return e.source === "import" || e.source === "human" || e.via === "import";
}

/** Appended to a fact whose Apple text an agent recorded by hand, so it is not quoted as Apple's. */
export const AGENT_APPLE_TEXT =
  " [Recorded by an agent with shield_ledger_record, not imported from Apple's message; check it against App Store Connect before quoting it, or import Apple's message with shield_ledger_import.]";
/** Appended to any other fact an agent recorded by hand: the ledger holds the agent's word for it. */
export const AGENT_RECORD = " [Recorded by an agent with shield_ledger_record; confirm it with the developer before stating it.]";

/** Each piece of Apple text the ledger holds, with whether it is on record as Apple's own (see isAppleRecord). */
export function appleTexts(state: LedgerState): { text: string; apple: boolean; eventId: string }[] {
  const out: { text: string; apple: boolean; eventId: string }[] = [];
  for (const e of state.events) {
    if (e.type === "outcome" && e.reviewerMessage) out.push({ text: e.reviewerMessage, apple: isAppleRecord(e), eventId: e.id });
    else if (e.type === "apple_reply") out.push({ text: e.text, apple: isAppleRecord(e), eventId: e.id });
    else if (e.type === "termination") out.push({ text: e.letter, apple: isAppleRecord(e), eventId: e.id });
  }
  return out;
}

/**
 * What a fact rests on when it is not Apple's own record. A hook or CI records what it observed,
 * so only an agent's hand-written record is "confirm it with the developer"; Apple text from any
 * source but an import is still not Apple's message.
 */
function provenance(state: LedgerState, eventId: string | undefined, appleText: boolean): string {
  const e = eventId ? state.events.find((x) => x.id === eventId) : undefined;
  if (!e || isAppleRecord(e)) return "";
  if (e.source === "agent") return appleText ? AGENT_APPLE_TEXT : AGENT_RECORD;
  return appleText ? ` [Recorded by ${e.source === "ci" ? "CI" : `a ${e.source}`}, not imported from Apple's message; check it against App Store Connect before quoting it.]` : "";
}

/** True when a block finding says to delete this remote switch: disclosing it does not fix it. */
export function switchMustBeDeleted(c: Pick<RemoteControl, "key" | "file" | "line">, findings: FindingRef[]): boolean {
  return findings.some(
    (f) =>
      f.rule === "remote_config.content_gating" &&
      f.severity === "block" &&
      (f.why?.includes(`key "${c.key}"`) || (f.file !== undefined && f.file === c.file && f.line === c.line)),
  );
}

/** The developer's own terminal-recorded statement that they are not aware of the conduct, if any. */
export function nonAwarenessAttestation(state: LedgerState): Attestation | undefined {
  return humanAttestations(state).find((a) => NOT_AWARE_RX.test(a.statement));
}

/** Changes the ledger records after an approval that touch content, price or shipped code (OTA). */
export function materialPostApprovalChanges(state: LedgerState): RecordedChange[] {
  return recordedPostApprovalChanges(state).filter((c) => c.contentOrPrice || c.kind === "ota_publish");
}

type MessageSent = Extract<LedgerEvent, { type: "message_sent" }>;

/**
 * The message to App Review that disclosed a recorded change: sent after it, naming it
 * specifically, and on record as the developer's (typed by them, or an agent's draft they confirmed
 * pasting in a terminal). The ledger cannot see App Store Connect, so an agent's draft alone shows nothing was sent.
 */
export function disclosingMessage(state: LedgerState, c: RecordedChange): MessageSent | undefined {
  const human = humanAttestations(state);
  return state.events.find(
    (e): e is MessageSent =>
      e.type === "message_sent" &&
      (e.purpose === "review_notes" || e.purpose === "reply") &&
      Date.parse(e.at) >= Date.parse(c.at) &&
      changeDisclosedBy(c, e.text) &&
      (e.source === "human" || human.some((a) => Date.parse(a.at) >= Date.parse(e.at) && a.statement.includes(e.id))),
  );
}

export type RemovedCondition = NonNullable<NonNullable<RejectionState["verification"]>["removedConditions"]>[number];

/** Review-time conditions the latest verification of each open rejection found removed in its diff. */
export function removedReviewConditions(state: LedgerState, rejections: RejectionState[] = state.rejections.filter((r) => !r.approvedBy)): { condition: RemovedCondition; eventId?: string }[] {
  const out: { condition: RemovedCondition; eventId?: string }[] = [];
  for (const r of rejections) {
    const verEv = [...state.events].reverse().find((e) => e.type === "verification" && e.rejectionId === r.id);
    for (const c of r.verification?.removedConditions ?? []) {
      if (!out.some((o) => o.condition.file === c.file && o.condition.line === c.line && o.condition.condition === c.condition)) out.push({ condition: c, ...(verEv ? { eventId: verEv.id } : {}) });
    }
  }
  return out;
}

export function removedConditionText(c: RemovedCondition): string {
  return `Removed review-time condition: ${c.condition} at ${c.file}${c.line ? `:${c.line}` : ""}${c.gates ? ` (${c.gates})` : ""}; flagged as ${c.rule} before the fix. Disclose its removal factually in the notes (2.5.19, 3.2(f)).`;
}

/** Binary rejections with no later approval and no fix verified at STATIC_CLEAN or better. */
export function unresolvedRejections(state: LedgerState): RejectionState[] {
  return state.rejections.filter((r) => r.outcome === "rejected" && !r.approvedBy && tierRank(r.verification?.tier) < tierRank("STATIC_CLEAN"));
}

function attestationText(statement: string): string {
  return /^\s*the developer (?:states|confirms|attests)\b/i.test(statement) ? statement : `The developer states: ${statement}`;
}

function rejectionText(r: RejectionState): string {
  const kind = r.outcome === "metadata_rejected" ? "Metadata rejected" : "Rejected";
  const status = r.approvedBy ? "a later submission was approved" : "no later approval recorded";
  return `${kind} on ${day(r.at)}${r.bundleId ? ` (${r.bundleId})` : ""} under ${r.guidelines.length ? `Guideline ${r.guidelines.join(", ")}` : "no cited guideline"}; ${status}.`;
}

const TIER_MEANING: Record<string, string> = {
  RESIDUE_FOUND: "residue is still present in source, or an input path reaches the capability with no filter",
  UNVERIFIABLE: "part of the capability cannot be checked from the repo (e.g. server prompts or obfuscated code)",
  STATIC_CLEAN: "no residue found in source; says nothing about model behavior",
  BUILD_CLEAN: "no residue found in source or in the built app; says nothing about model behavior",
  PROBED: "the developer states, confirmed in a terminal, that their own probe run blocked every prompt in the suite; covers only the prompts tried",
};

function excerpt(s: string | undefined, max = 280): string {
  if (!s) return "";
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

class FactList {
  readonly facts: Fact[] = [];
  add(kind: string, text: string, eventId?: string): void {
    if (this.facts.some((f) => f.text === text && f.eventId === eventId)) return;
    this.facts.push({ id: `F${this.facts.length + 1}`, kind, text, ...(eventId ? { eventId } : {}) });
  }
}

function rejectionFacts(fl: FactList, r: RejectionState, state: LedgerState, opts: { reviewerExcerpt: boolean }): void {
  fl.add("rejection", `${rejectionText(r)}${provenance(state, r.id, false)}`, r.id);
  if (opts.reviewerExcerpt && r.reviewerMessage) {
    const from = r.reviewerMessageEventId ?? r.id;
    const label = provenance(state, from, true);
    fl.add("reviewer_message", `${label ? "Recorded as App Review's message" : "App Review wrote"}: "${excerpt(r.reviewerMessage)}"${label}`, from);
  }
  if (r.interpretation) {
    const ev = state.events.find((e) => e.type === "interpretation" && e.rejectionId === r.id && e.text === r.interpretation);
    fl.add("interpretation", `Capability-level reading of the rejection: ${r.interpretation}`, ev?.id);
  }
  const specEv = [...state.events].reverse().find((e) => e.type === "residue_spec" && e.rejectionId === r.id);
  if (r.spec && specEv) {
    // The capability line is the fix's goal as the agent wrote it, not a checked result; label it so it is not quoted as fact.
    fl.add("spec", `Spec goal (what the fix is meant to remove; a target, not a verified result): ${r.spec.capability} (feature: ${r.spec.feature}).`, specEv.id);
    if (r.spec.inputPaths.length) fl.add("spec", `Input paths covered by the removal: ${r.spec.inputPaths.join("; ")}.`, specEv.id);
    if (r.spec.metadataSurfaces.length) fl.add("spec", `Store surfaces the developer must check by hand (not checked by the tool): ${r.spec.metadataSurfaces.join("; ")}.`, specEv.id);
  }
  const verEv = [...state.events].reverse().find((e) => e.type === "verification" && e.rejectionId === r.id);
  if (r.verification && verEv) {
    const v = r.verification;
    const confirmed = v.probe ? probeConfirmation(state.events, v.probe.resultsHash) : undefined;
    const probe = !v.probe
      ? ""
      : confirmed
        ? ` The developer states their own probe run blocked ${v.probe.blocked} of ${v.probe.total} prompts (confirmed in ${confirmed}).`
        : ` Probe results were supplied without the developer's confirmation (${v.probe.blocked} of ${v.probe.total} marked blocked); they are not evidence until the developer confirms them in a terminal.`;
    fl.add("verification", `Verification on ${day(v.at)}: tier ${v.tier} (${TIER_MEANING[v.tier] ?? v.tier}).${probe} ${v.summary}`.trim(), verEv.id);
    if (v.removedInDiff.length) fl.add("verification", `Removed in the diff: ${v.removedInDiff.slice(0, 12).join(", ")}${v.removedInDiff.length > 12 ? ", …" : ""}.`, verEv.id);
    for (const c of v.removedConditions ?? []) fl.add("removed_condition", removedConditionText(c), verEv.id);
    // Each blocked path cites only the filters verify tied to its own generation call ("… (guards <sink file>)"),
    // all of them, so the notes cannot credit one provider's setting to another provider's call.
    const GUARDS = /\(guards [^)]+\)$/;
    const blockedOn = (p: (typeof v.inputPaths)[number]) => p.evidence.filter((e) => GUARDS.test(e) && !/^Traced evidence/.test(e));
    const capped = (text: string) => (text.length > 600 ? `${text.slice(0, 599)}…` : text);
    // A path that names no generation call is blocked only because every call in the repo is
    // guarded; listing those filters as "its" filters would overstate what guards the path.
    const filtered = v.inputPaths
      .filter((p) => p.blocked && blockedOn(p).length)
      .map((p) =>
        /^The path names no generation call/.test(p.evidence[0] ?? "")
          ? `${p.inputPath} (names no generation call; each call checked: ${capped(blockedOn(p).join("; "))})`
          : `${p.inputPath} (filters: ${capped(blockedOn(p).join("; "))})`,
      );
    const gone = v.inputPaths.filter((p) => p.blocked && !blockedOn(p).length && p.evidence.some((e) => /no longer in the tree/.test(e))).map((p) => p.inputPath);
    const noGeneration = v.inputPaths.filter((p) => p.blocked && !blockedOn(p).length && p.evidence.some((e) => /No AI generation call/.test(e))).map((p) => p.inputPath);
    const open = v.inputPaths.filter((p) => !p.blocked).map((p) => p.inputPath);
    if (filtered.length) fl.add("verification", `Input paths with a filter found on their own generation call: ${filtered.join("; ")}.`, verEv.id);
    if (gone.length) fl.add("verification", `Input paths whose traced code is no longer in the tree (not a filter): ${gone.join("; ")}.`, verEv.id);
    if (noGeneration.length) fl.add("verification", `Input paths with no AI generation call left in the repo to reach (not a filter): ${noGeneration.join("; ")}.`, verEv.id);
    if (open.length) fl.add("verification", `Input paths NOT verified as blocked: ${open.join("; ")}.`, verEv.id);
    if (v.unverifiable.length) fl.add("verification", `Not verifiable from the repo: ${v.unverifiable.join("; ")}.`, verEv.id);
  }
  const human = new Set(humanAttestations(state).map((a) => a.id));
  for (const a of r.attestations) if (human.has(a.eventId)) fl.add("attestation", attestationText(a.statement), a.eventId);
  for (const m of r.messages) fl.add("message", `${m.purpose.replace(/_/g, " ")} sent to Apple on ${day(m.at)}.${provenance(state, m.eventId, false)}`, m.eventId);
  for (const m of r.appleReplies) {
    const ev = state.events.find((e) => e.id === m.eventId);
    const label = provenance(state, m.eventId, true);
    const quoted = ev && ev.type === "apple_reply" ? `: "${excerpt(ev.text, 200)}"` : ".";
    fl.add("apple_reply", `${label ? `Recorded as Apple's reply of ${day(m.at)}` : `Apple replied on ${day(m.at)}`}${quoted}${label}`, m.eventId);
  }
  if (r.approvedBy) {
    const ap = state.outcomes.find((o) => o.id === r.approvedBy);
    if (ap) fl.add("approval", `Approved on ${day(ap.at)}${ap.bundleId ? ` (${ap.bundleId})` : ""}, after this rejection.`, ap.id);
  }
}

export type FindingRef = Pick<Finding, "rule" | "severity" | "guideline" | "file" | "line"> & { why?: string };

function inventoryFacts(fl: FactList, inv: DisclosureInventory | undefined, findings: FindingRef[]): void {
  if (!inv) return;
  for (const c of inv.remoteControls ?? []) {
    if (c.classification !== "content-gating" && c.classification !== "price-gating") continue;
    // Disclosing a switch a block finding says to delete does not fix it; the notes must not present it as kept.
    const mustDelete = switchMustBeDeleted(c, findings);
    fl.add(
      "inventory",
      `Remote ${c.provider} flag "${c.key}" (${c.classification}${c.defaultValue !== undefined ? `, default ${c.defaultValue}` : ""}) gates: ${c.gates}${c.file ? ` [${c.file}${c.line ? `:${c.line}` : ""}]` : ""}.${mustDelete ? " A block finding says to delete this switch before submitting; delete it rather than disclose it." : ""}`,
    );
  }
  for (const o of inv.ota ?? []) fl.add("inventory", `Over-the-air updates via ${o.provider}${o.detail ? ` (${o.detail})` : ""}.`);
  if (inv.aiServices?.length) fl.add("inventory", `AI services the app sends user content to: ${inv.aiServices.join(", ")}.`);
}

function scopeRejections(state: LedgerState, rejectionId?: string): { target?: RejectionState; related: RejectionState[]; warnings: string[] } {
  const warnings: string[] = [];
  if (!rejectionId) return { related: state.rejections, warnings };
  const target = state.rejections.find((r) => r.id === rejectionId);
  if (!target) {
    warnings.push(`No rejection with id ${rejectionId}; use shield_ledger_query view "status" to list rejection ids. Showing all rejections instead.`);
    return { related: state.rejections, warnings };
  }
  const related = state.rejections.filter((r) => !target.bundleId || !r.bundleId || r.bundleId === target.bundleId);
  return { target, related, warnings };
}

const SCAFFOLDS: Record<EvidencePurpose, ScaffoldSection[]> = {
  review_notes: [
    { section: "What changed in this build", guidance: "Name each new feature or change specifically: screen, capability, and what a user can now do or no longer do (Guideline 2.3.1(a) requires specificity; generic notes like \"bug fixes\" get rejected)." },
    { section: "Prior rejections", guidance: "List each prior rejection with its date and guideline, from the facts. One line each; no argument about whether it was fair." },
    { section: "What was removed", guidance: "Describe the removal at capability level: what a user can no longer produce, and every input path covered (picker, free text, remix, upload, deep link). Use only facts with a verification event; state the evidence tier honestly. Every removed_condition fact (a TestFlight, reviewer, region or remote-flag condition that changed the app during review) is disclosed by default: say what the condition was, what it changed, and that it was removed. Do not characterize why it existed unless the developer has confirmed it." },
    { section: "What stays and why", guidance: "Name related features that remain and why they are within the guideline, with the safeguards that apply to them." },
    { section: "Remote controls, OTA and AI services", guidance: "Disclose every remote flag that gates content or price, any OTA update mechanism, and every AI service that receives user content (2.5.19, 5.1.2(i)). Statements about servers you control go in the form \"The developer states …\"." },
    { section: "Moderation and UGC safeguards", guidance: "If users or AI create content: the filter, the in-app report flow and response time, user blocking, and published contact info (1.2). Say where in the app each one is." },
    { section: "How to test", guidance: "Numbered steps the reviewer can follow in a few minutes to reach each changed feature and each safeguard." },
    { section: "Demo account", guidance: "Placeholders only, e.g. \"Demo account: see the Sign-In Information fields\". Never paste real credentials or API keys into notes. The account must not expire; subscription apps should also offer an expired-subscription account; mention any 2FA handling." },
  ],
  reply: [
    { section: "Acknowledge", guidance: "One calm line thanking the reviewer. No arguing, no complaints about the process." },
    { section: "Answer the question", guidance: "Answer exactly what App Review asked, using facts with event ids. Avoid absolute claims unless probe and build evidence back them." },
    { section: "What was done", guidance: "Capability-level description of changes already made, with the honest evidence tier." },
    { section: "Specific question", guidance: "If anything is unclear, ask which feature, output or screen the concern refers to, and whether a screenshot or steps can be shared." },
    { section: "Offer a call", guidance: "Offer to discuss on a call with App Review (a call can be requested; usually within 3–5 business days)." },
  ],
  clarification: [
    { section: "Acknowledge", guidance: "One calm line. A clarification is not an appeal; do not argue the decision." },
    { section: "Your reading", guidance: "State your capability-level interpretation of the rejection in one or two sentences, so the reviewer can correct it." },
    { section: "Specific question", guidance: "Ask which specific feature, generated output, or screen the concern refers to, and whether the reviewer can share a screenshot or the steps they took." },
    { section: "Parallel fix", guidance: "Say you are already removing the broadest reasonable reading of the issue while you wait; do not promise a date you cannot keep." },
    { section: "Offer a call", guidance: "Ask whether a call with App Review would help." },
  ],
  appeal_review_board: [
    { section: "Precondition: reply in App Store Connect first", guidance: "Apple asks developers to reply to the notice in App Store Connect before appealing. Confirm that reply was sent (record it as message_sent purpose reply)." },
    { section: "Cite the specific terms", guidance: "Quote the guideline or DPLA sections the notice lists, exactly as written." },
    { section: "Rebut each listed instance", guidance: "For every instance the notice lists, give the facts that answer it, with dates. Facts only; no speculation about Apple's motives and no combative wording." },
    { section: "What was changed", guidance: "Capability-level remediation with honest evidence tiers. Concede real mistakes plainly and only those the developer confirms." },
    { section: "Request", guidance: "One specific, polite request (e.g. reconsider the rejection, or identify the conduct so it can be corrected)." },
  ],
  appeal_termination: [
    { section: "Channel", guidance: "Already terminated: use the \"Re-instate a Terminated Developer Program Membership\" form, not an App Review Board appeal. Facing termination: reply in App Store Connect, then appeal. EU developers have DSA out-of-court options. Consider speaking to counsel." },
    { section: "Apology (confirmed mistakes only)", guidance: "Apologize only for real mistakes the developer confirms one by one. Never apologize for conduct the developer did not do, and never write speculative admissions (\"if we did\", \"we may have\")." },
    { section: "How it happened", guidance: "Explain each confirmed mistake factually from the ledger facts: dates, what was submitted, what Apple said, what was changed." },
    { section: "Prevention plan", guidance: "A concrete written improvement plan (Guideline 5.6 allows one): the processes now in place, e.g. preflight gate before every submission, specific review notes, disclosure of remote controls and OTA, verification of fixes, a single owner for submissions." },
    { section: "Ask Apple to identify the conduct", guidance: "Politely ask Apple to identify the specific app, build, date or conduct the notice refers to, so it can be corrected. Do not guess in the letter." },
  ],
};

/** Shoemaker's central argument: the developer was rejected, fixed what Apple named, and Apple approved the fix. */
const SEQUENCE_SECTION: ScaffoldSection = {
  section: "Rejection, fix and approval sequence",
  guidance: "For each rejection in the facts: its date and guideline, what was changed in response (with the verification tier), and the later approval date, each with its event id. Facts only; no argument about whether the rejection was fair.",
};

const IMPROVEMENTS_SECTION: ScaffoldSection = {
  section: "Improvements going forward",
  guidance: "Forward-looking improvements, not admissions (Guideline 5.6 allows a written plan): preflight gate before every submission, specific review notes, disclosure of remote controls and OTA, verification of fixes, a single owner for submissions.",
};

/** Facts the ledger holds that a letter must state, never deny (termination notices, as Shoemaker reports them, list misleading support or App Store Connect responses; DPLA 3.2(f) itself bars misleading or dishonest acts). */
const RECORDED_CHANGES_SECTION: ScaffoldSection = {
  section: "Recorded changes after approval",
  guidance: "The ledger records changes after an approval (the post_approval_change facts). Describe each one factually: date, what changed, and whether it was disclosed in Notes for Review or shipped in a reviewed build. Never write that nothing changed after approval, and do not characterize intent the developer has not confirmed.",
};

/** Rejections later approved with no interpretation, spec or verification on record: nothing shows the app was changed. */
export function approvedWithoutChangeEvidence(state: LedgerState): RejectionState[] {
  return state.rejections.filter((r) => r.outcome === "rejected" && r.approvedBy && !r.interpretation && !r.spec && !r.verification);
}

/** What the ledger shows for one rejection, worded so it claims no change the ledger does not hold. */
function rejectionRecord(r: RejectionState, state: LedgerState): string {
  const head = `Rejection ${r.id} (${day(r.at)}, ${r.guidelines.length ? `Guideline ${r.guidelines.join(", ")}` : "no guideline cited"})`;
  const approval = r.approvedBy ? state.outcomes.find((o) => o.id === r.approvedBy) : undefined;
  const approved = approval ? ` and approved on ${day(approval.at)}` : "";
  if (r.verification && tierRank(r.verification.tier) >= tierRank("STATIC_CLEAN")) return `${head}: the app was changed (verification tier ${r.verification.tier})${approved}`;
  if (r.verification) return `${head}: a fix was attempted, but the latest verification is ${r.verification.tier} (${TIER_MEANING[r.verification.tier] ?? "not clean"})${approved}`;
  if (r.interpretation || r.spec) return `${head}: a fix was planned (interpretation recorded), with no verification on record${approved}`;
  if (approval) {
    const appealed = r.messages.some((m) => m.purpose === "appeal_review_board");
    return `${head} was approved on ${day(approval.at)}${appealed ? " after an App Review Board appeal" : ""}; the ledger records no change for it, so do not say the app was changed`;
  }
  return `${head} is open: no later approval recorded`;
}

/**
 * The good-faith "not aware" framing is the developer's statement, so it is offered only after
 * they record it in a terminal; the absence of confirmed mistakes proves nothing either way.
 * Each rejection is described from its own events: an approval alone does not show the app changed,
 * and App Review rarely says what to change, so "as App Review asked" is never ours to claim.
 */
function goodFaithSection(state: LedgerState): ScaffoldSection {
  const open = unresolvedRejections(state);
  const records = state.rejections.filter((r) => r.outcome === "rejected").map((r) => rejectionRecord(r, state));
  const answered = [
    open.length ? `List the open rejections as open (the facts mark them "no later approval recorded"); do not say every rejection was fixed.` : "",
    records.length ? `For each rejection, state only what the ledger shows: ${records.join("; ")}.` : "",
  ].filter(Boolean).join(" ");
  return {
    section: "Good-faith record",
    guidance: `The developer recorded that they are not aware of the conduct the notice refers to; state it in their words as "The developer states …". ${answered} It must not contradict any recorded fact, including changes after approval. Do not apologize for conduct nobody has identified, and never write speculative admissions ("if we did", "we may have").`.replace(/\s+/g, " "),
  };
}

const CONFIRM_AWARENESS_SECTION: ScaffoldSection = {
  section: "Developer confirmation needed",
  guidance: "The ledger cannot say whether the developer knew of the conduct, and nothing may be said on their behalf. Ask the developer. If they are not aware of it, they record that themselves with `appstore-shield attest --statement \"I am not aware of …\"` in a terminal; if they made a mistake, they confirm it the same way. Until then, state only the facts below: no denial of awareness, no admission, no claim that every rejection was fixed.",
};

function appealTerminationScaffold(state: LedgerState): ScaffoldSection[] {
  const base = SCAFFOLDS.appeal_termination;
  const channel = base.filter((s) => s.section === "Channel");
  const ask = base.filter((s) => s.section === "Ask Apple to identify the conduct");
  const recorded = materialPostApprovalChanges(state).length ? [RECORDED_CHANGES_SECTION] : [];
  if (!confirmedMistakeStatements(state).length) {
    const opening = nonAwarenessAttestation(state) ? goodFaithSection(state) : CONFIRM_AWARENESS_SECTION;
    return [...channel, opening, SEQUENCE_SECTION, ...recorded, IMPROVEMENTS_SECTION, ...ask];
  }
  const middle = base.filter((s) => s.section !== "Channel" && s.section !== "Ask Apple to identify the conduct");
  return [...channel, ...middle.slice(0, 2), SEQUENCE_SECTION, ...recorded, ...middle.slice(2), ...ask];
}

function recordedChangeFacts(fl: FactList, state: LedgerState): void {
  for (const c of materialPostApprovalChanges(state)) {
    fl.add("post_approval_change", `Recorded after the approval of ${day(c.approvalAt)}: ${c.detail} (recorded ${day(c.at)}).${provenance(state, c.eventId, false)}`, c.eventId);
  }
}

const HYPOTHESIS_WARNING =
  "PRIVATE: these are guesses about what Apple might mean, ranked by how much ledger evidence touches each one. They are not findings. Never paste them into anything sent to Apple, and never apologize for a category the developer has not confirmed.";

function hypotheses(state: LedgerState, letter: string | undefined, nowMs: number): PrivateHypothesis[] {
  const L = (letter ?? "").toLowerCase();
  const raw: (Omit<PrivateHypothesis, "rank"> & { letterMatch: boolean })[] = [];
  const add = (category: string, basis: string, ids: string[], letterRx?: RegExp) => {
    const boosted = Boolean(letterRx && letterRx.test(L));
    if (!ids.length && !boosted) return;
    raw.push({ category, basis: boosted ? `${basis} The letter uses related wording.` : basis, supportingEventIds: [...new Set(ids)], letterMatch: boosted });
  };

  const objectionable = state.rejections.filter((r) => r.guidelines.some(isObjectionableGuideline));
  add("Repeated objectionable-content (1.1/1.2) rejections", "Shoemaker reports \"too many 1.1 rejections\" as a trigger he sees; under 1.2, developers who fail to remediate identified violations after notice may be considered in violation of the Code of Conduct.", objectionable.map((r) => r.id), /objectionable|user.generated|1\.[12]\b/);

  const byG = new Map<string, string[]>();
  for (const r of state.rejections) for (const g of r.guidelines) byG.set(g, [...(byG.get(g) ?? []), r.id]);
  const repeated = [...byG.values()].filter((ids) => ids.length > 1).flat();
  add("Same guideline cited repeatedly", "Guideline 2.3.1(b) and 5.6 name repeated behavior as grounds for removal.", repeated, /repeat|pattern/);

  // The changes themselves are facts (post_approval_change); only whether the notice means them is a guess.
  const postApproval = materialPostApprovalChanges(state).map((c) => c.eventId);
  add("Post-review modification (server, remote config or OTA changes after approval)", "The recorded changes are listed as facts and must not be denied. Whether the notice refers to them is the guess: DPLA 3.2(e) forbids code that would \"deceive regarding the identity, purpose, or behavior\" of the app, \"including through post-review modifications that would cause harm to others, including end users or Apple\"; 2.5.19 bans hidden or dormant features; Shoemaker says Apple distrusts fixes made on a server.", postApproval, /bait|switch|post.review|hidden|dormant|concept or feature/);

  // Each rejection is answered by a resubmission, so only submissions beyond that are volume; no source gives a number.
  const in90 = (at: string) => Date.parse(at) > nowMs - 90 * 86_400_000 && Date.parse(at) <= nowMs;
  const subs90 = reviewSubmissions(state).filter((s) => in90(s.at));
  const rej90 = state.rejections.filter((r) => in90(r.at)).length;
  add(
    "Submission volume",
    `Shoemaker lists "too many submissions"; in a forum report, a developer suspects their own App Store Connect automation led to a termination (secondary, anecdotal). No source gives a number: ${subs90.length} submission(s) in 90 days is not known to be many.`,
    subs90.length > rej90 + 1 ? subs90.map((s) => s.eventId) : [],
    /volume|spam|automat/,
  );

  add("App name or subtitle churn", "Shoemaker lists \"too many app name changes\".", metadataNameChanges(state).map((c) => c.eventId), /name/);

  const dupes = nearDuplicateNames(state.apps.map((a) => a.name ?? "").filter(Boolean));
  const dupeIds = state.events.filter((e): e is Extract<LedgerEvent, { type: "app" }> => e.type === "app" && dupes.some(([a, b]) => e.name === a || e.name === b)).map((e) => e.id);
  add("Similar or duplicate apps", "Guideline 4.3(a)/(b) (multiple Bundle IDs for the same app; spam). DPLA 3.2(f)'s naming clause is about names similar to a third-party app, not the developer's own.", dupeIds, /similar|duplicate|spam|4\.3/);

  add("Ratings or review manipulation", "Guideline 5.6.3 and DPLA 3.2(f) (fraudulent reviews). The ledger has no events for this; only the letter can suggest it.", [], /rating|review manipulation|fraudulent review|fake review/);

  // What the letter names comes first: the prevention plan should answer the conduct Apple described.
  return raw
    .sort((a, b) => Number(b.letterMatch) - Number(a.letterMatch) || b.supportingEventIds.length - a.supportingEventIds.length)
    .map(({ letterMatch: _, ...h }, i) => ({ rank: i + 1, ...h }));
}

export function evidencePack(
  state: LedgerState,
  purpose: EvidencePurpose,
  opts: {
    rejectionId?: string;
    /** review-time conditions a caller found removed against a base ref, beyond those on a recorded verification */
    removedConditions?: RemovedCondition[];
    letter?: string;
    inventory?: DisclosureInventory;
    now?: string;
    /** current scan findings; open high/block findings under a rejection's guideline become warnings */
    findings?: FindingRef[];
  } = {},
): EvidencePack {
  const fl = new FactList();
  const { target, related, warnings } = scopeRejections(state, opts.rejectionId);
  const appeal = purpose === "appeal_review_board" || purpose === "appeal_termination";

  if (target) rejectionFacts(fl, target, state, { reviewerExcerpt: purpose !== "review_notes" });
  for (const r of related) {
    if (r === target) continue;
    if (purpose === "review_notes" || purpose === "reply" || purpose === "clarification") fl.add("rejection", rejectionText(r), r.id);
    else rejectionFacts(fl, r, state, { reviewerExcerpt: true });
  }

  if (appeal) {
    const approvals = state.outcomes.filter((o) => o.outcome === "approved");
    for (const a of approvals) fl.add("approval", `Approved on ${day(a.at)}${a.bundleId ? ` (${a.bundleId})` : ""}.`, a.id);
    const subs = state.submissions;
    if (subs.length) fl.add("submissions", `${subs.length} App Review submission(s) recorded, ${day(subs[0]?.at ?? "")} to ${day(subs[subs.length - 1]?.at ?? "")}.`, subs[subs.length - 1]?.id);
    const letterText = opts.letter ?? state.terminations[state.terminations.length - 1]?.letter;
    const letterEvent = opts.letter ? undefined : state.terminations[state.terminations.length - 1];
    if (letterText) fl.add("letter", `Notice text: "${excerpt(letterText, 400)}"${provenance(state, letterEvent?.id, true)}`, letterEvent?.id);
    for (const e of state.events) {
      if (e.type === "attestation" && e.source === "human" && !e.rejectionId) fl.add("attestation", attestationText(e.statement), e.id);
    }
  }

  if (appeal || purpose === "reply") {
    recordedChangeFacts(fl, state);
    const unresolved = unresolvedRejections(state);
    if (unresolved.length) {
      warnings.push(
        `Open rejection(s) with no later approval and no fix verified at STATIC_CLEAN: ${unresolved.map((r) => `${r.id} (${day(r.at)}, ${r.guidelines.join(", ") || "no guideline"})`).join("; ")}. The text must not say every rejection was fixed.`,
      );
    }
    if (materialPostApprovalChanges(state).length) {
      warnings.push("The ledger records changes after approval (post_approval_change facts). The text must not deny them or say nothing changed after approval.");
    }
  }

  if (purpose === "review_notes" || appeal) inventoryFacts(fl, opts.inventory, opts.findings ?? []);
  // Every purpose: a removed review-time condition is the fact a reviewer most needs, and it must not depend on a rejection id.
  for (const { condition, eventId } of removedReviewConditions(state, target ? [target] : related.filter((r) => !r.approvedBy))) fl.add("removed_condition", removedConditionText(condition), eventId);
  for (const c of opts.removedConditions ?? []) fl.add("removed_condition", removedConditionText(c));

  if (purpose === "review_notes" && !target && state.rejections.some((r) => !r.approvedBy)) {
    warnings.push("There are open rejections; pass rejection_id to include the remediation facts for the one this build addresses.");
  }
  if ((purpose === "reply" || purpose === "clarification") && !target) {
    warnings.push("Pass rejection_id so the reply is tied to a specific rejection and recorded against it.");
  }

  // The notes must not claim a safeguard the scan still finds missing (e.g. no report flow under 1.2).
  const guidelines = new Set((target ? [target] : related.filter((r) => !r.approvedBy)).flatMap((r) => r.guidelines));
  for (const f of opts.findings ?? []) {
    if (f.severity !== "high" && f.severity !== "block") continue;
    if (appeal && f.severity === "block") {
      warnings.push(`Open block finding ${f.rule} (Guideline ${f.guideline})${f.file ? ` at ${f.file}${f.line ? `:${f.line}` : ""}` : ""}: the app currently has this issue, so the text must not say the app complies.`);
      continue;
    }
    const fg = f.guideline.split(/[,;]\s*|\s+/).filter(Boolean);
    const g = [...guidelines].find((x) => fg.some((y) => y === x || y.startsWith(`${x}.`) || x.startsWith(`${y}.`) || x.startsWith(`${y}(`)));
    if (!g) continue;
    warnings.push(
      `Open ${f.severity} finding ${f.rule} (Guideline ${f.guideline})${f.file ? ` at ${f.file}${f.line ? `:${f.line}` : ""}` : ""} falls under the rejection's Guideline ${g}. The text must not say this safeguard exists until the finding is fixed.`,
    );
  }

  const pack: EvidencePack = {
    purpose,
    facts: fl.facts,
    scaffold: purpose === "appeal_termination" ? appealTerminationScaffold(state) : SCAFFOLDS[purpose],
    byteBudget: purpose === "review_notes" ? 4000 : null,
    warnings,
  };
  if (appeal) {
    pack.privateHypotheses = {
      neverPaste: true,
      warning: HYPOTHESIS_WARNING,
      items: hypotheses(state, opts.letter ?? state.terminations[state.terminations.length - 1]?.letter, opts.now ? Date.parse(opts.now) : Date.now()),
    };
  }
  return pack;
}

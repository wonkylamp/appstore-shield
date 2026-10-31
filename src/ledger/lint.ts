import { clausesOf, denialClauses } from "./drift.js";
import {
  appleTexts,
  approvedWithoutChangeEvidence,
  attestationMatching,
  confirmedMistakeStatements,
  disclosingMessage,
  humanAttestations,
  materialPostApprovalChanges,
  nonAwarenessAttestation,
  NOT_AWARE_RX,
  removedReviewConditions,
  switchMustBeDeleted,
  unresolvedRejections,
  type DisclosureInventory,
  type FindingRef,
  type EvidencePurpose,
  type RemovedCondition,
} from "./evidence.js";
import type { LedgerState, Verification } from "./schema.js";
import { probeConfirmation, tierRank } from "./store.js";
import { isObjectionableGuideline, reviewSubmissions } from "./triggers.js";

/**
 * Every outgoing text is linted because "every honest argument with App Review becomes
 * evidence of bad character" [source], termination notices list misleading App Store Connect
 * responses (as Shoemaker reports them) [source], and DPLA 3.2(f) bars misleading or dishonest acts [apple]. Precision over recall: errors must be things worth rewriting.
 */

export type LintSeverity = "error" | "warning";

export interface LintIssue {
  rule:
    | "byte_limit"
    | "absolute_claim"
    | "unattributed_attestation"
    | "unbacked_attestation"
    | "comparison"
    | "pressure"
    | "secret"
    | "combative_tone"
    | "generic_change"
    | "disclosure_missing"
    | "false_disclosure"
    | "speculative_admission"
    | "unconfirmed_admission"
    | "contradicts_ledger"
    | "prior_rejection_unmentioned"
    | "safeguard_claim_unbacked"
    | "remote_toggle_fix"
    | "history_understated"
    | "cosmetic_fix"
    | "intent_characterization"
    | "removed_condition_unmentioned"
    | "deferred_return"
    | "unrecorded_apple_quote"
    | "review_specific_behavior"
    | "compliance_assertion";
  severity: LintSeverity;
  excerpt: string;
  message: string;
  fix: string;
}

export interface LintResult {
  ok: boolean;
  bytes: number;
  byteLimit: number | null;
  issues: LintIssue[];
}

/** The evidence a strong claim needs: probe 100% blocked and a clean built-product sweep. */
export type TierEvidence = Pick<Verification, "tier" | "probe" | "builtProduct"> & { buildClean?: boolean };

export interface LintInput {
  purpose: EvidencePurpose;
  text: string;
  inventory?: DisclosureInventory;
  state?: LedgerState;
  strongestTier?: TierEvidence;
  /**
   * Ignored. A caller-supplied list could silence the false-confession guard with no record that
   * the developer confirmed anything; confirmed mistakes are read from human attestations in `state`.
   */
  confirmedMistakes?: string[];
  /** ISO time that "this year" / "the last 3 months" in the text are measured from; defaults to now */
  now?: string;
  /** review-time conditions removed against a base ref, beyond those on recorded verifications (review_notes) */
  removedConditions?: RemovedCondition[];
  /** current scan findings: a remote switch a block finding says to delete gets "delete", not "disclose" */
  findings?: FindingRef[];
}

export const REVIEW_NOTES_BYTE_LIMIT = 4000;

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function clip(s: string, max = 140): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

interface Sentence {
  text: string;
  paragraph: string;
}

function sentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  for (const paragraph of text.split(/\n\s*\n/)) {
    for (const line of paragraph.split("\n")) {
      for (const s of line.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(“])/)) {
        if (s.trim()) out.push({ text: s.trim(), paragraph: paragraph.trim() });
      }
    }
  }
  return out;
}

const QUOTED = /"[^"\n]{1,300}"|“[^”\n]{1,300}”/g;

// Quoted text is usually Apple's own wording being cited; judging it as the developer's claim misfires.
function maskQuotes(s: string): string {
  return s.replace(QUOTED, (m) => " ".repeat(m.length));
}

const norm = (s: string) => s.toLowerCase().replace(/[“”"‘’']/g, "").replace(/\s+/g, " ").trim();

/** Each piece of a quote between ellipses must appear in the corpus; an elided quote is still Apple's words. */
function quotedIn(corpus: string, quote: string): boolean {
  const pieces = quote
    .slice(1, -1)
    .split(/\.{3}|…|\[\s*\.*\s*\]/)
    .map(norm)
    .filter((x) => x.length >= 3);
  return pieces.length > 0 && pieces.every((x) => corpus.includes(x));
}

/**
 * For checks against the ledger, a quote is masked only when it is Apple's recorded wording
 * (rejection, reply or termination letter) as Apple's own record: quoting one's own denial, or a
 * reply an agent typed in, does not make it Apple's.
 */
function appleQuoteMasker(state: LedgerState): (s: string) => string {
  const corpus = norm(appleTexts(state).filter((t) => t.apple).map((t) => t.text).join("\n"));
  return (s) => s.replace(QUOTED, (m) => (quotedIn(corpus, m) ? " ".repeat(m.length) : m));
}

// "Apple replied: "…"", "App Review's message said "…"", or the quote first: ""…," the reviewer said".
const APPLE_SPEAKER = String.raw`(?:apple|app\s+review(?:\s+board)?|the\s+(?:app\s+review\s+)?board|(?:the|your|a|an)\s+reviewers?|reviewers?|the\s+review\s+team)`;
const APPLE_SAID = String.raw`(?:repl(?:ied|ies|y)|wrote|writes|said|says|stated?|states|confirm(?:ed|s)?|told\s+us|responded|noted|indicated|advised|explained|acknowledged|agreed|answered)`;
const APPLE_NOUN = String.raw`(?:reply|response|message|email|note|answer|notice|letter)`;
const ATTRIBUTED_BEFORE = new RegExp(
  String.raw`\b${APPLE_SPEAKER}(?:['’]s\s+${APPLE_NOUN})?\s+(?:(?:has|had|also|then|later|clearly|explicitly|that)\s+)?(?:${APPLE_SAID}|${APPLE_NOUN})\b[^.!?]{0,60}$|\b${APPLE_SPEAKER}['’]s\s+${APPLE_NOUN}\b[^.!?]{0,60}$`,
  "i",
);
const ATTRIBUTED_AFTER = new RegExp(String.raw`^\s*,?\s*${APPLE_SPEAKER}\s+${APPLE_SAID}\b`, "i");

/**
 * A quote presented as Apple's must be Apple's text on record: the ledger's Apple messages are what
 * App Review and the Board can check it against, and words an agent recorded as a reply, or that
 * no recorded message contains, would put words in Apple's mouth (DPLA 3.2(f)). Read per line, not
 * per sentence, because a quote of Apple's often spans sentences.
 */
function unrecordedAppleQuotes(text: string, state: LedgerState, appeal: boolean): LintIssue[] {
  const texts = appleTexts(state);
  const official = norm(texts.filter((t) => t.apple).map((t) => t.text).join("\n"));
  const agentOnly = norm(texts.filter((t) => !t.apple).map((t) => t.text).join("\n"));
  const out: LintIssue[] = [];
  for (const line of text.split("\n")) {
    for (const m of line.matchAll(QUOTED)) {
      const quote = m[0];
      if (norm(quote.slice(1, -1)).length < 3 || quotedIn(official, quote)) continue;
      // Other quotes are blanked so words inside them cannot supply the attribution.
      const before = line.slice(Math.max(0, m.index - 160), m.index).replace(QUOTED, (q) => " ".repeat(q.length));
      const after = line.slice(m.index + quote.length, m.index + quote.length + 60);
      if (!ATTRIBUTED_BEFORE.test(before) && !ATTRIBUTED_AFTER.test(after)) continue;
      const byAgent = quotedIn(agentOnly, quote);
      // Ledgers written before imports were marked hold Apple's real text as agent records too, so
      // outside an appeal such a quote is a warning; words no record contains are an error anywhere.
      out.push({
        rule: "unrecorded_apple_quote",
        severity: byAgent && !appeal ? "warning" : "error",
        excerpt: clip(quote),
        message: byAgent
          ? `Quotes ${clip(quote, 80)} as Apple's words, but the ledger has them only as text an agent recorded by hand (shield_ledger_record), not Apple's message itself. App Review and the Board can compare any quote with what Apple actually sent.`
          : `Quotes ${clip(quote, 80)} as Apple's words, but no App Review message, reply or notice in the ledger contains them. Words attributed to Apple that Apple did not write are a misleading statement (DPLA 3.2(f)).`,
        fix: "Quote only Apple's own message as imported (shield_ledger_import, or `appstore-shield import <saved email>`), exactly; otherwise remove the quote and describe the exchange factually without attributing words to Apple.",
      });
    }
  }
  return out;
}

function isBacked(e: TierEvidence | undefined): boolean {
  if (!e || e.tier !== "PROBED" || !e.probe || e.probe.total <= 0 || e.probe.blocked !== e.probe.total) return false;
  return e.buildClean === true || (e.builtProduct !== undefined && e.builtProduct.hits === 0);
}

/** PROBED counts only when the developer confirmed those probe results in a terminal (human attestation naming the results hash). */
function probeConfirmedIn(state: LedgerState | undefined, e: TierEvidence | undefined): boolean {
  return Boolean(state && e?.probe && probeConfirmation(state.events, e.probe.resultsHash));
}

function backedByState(state: LedgerState | undefined): boolean {
  return Boolean(state?.rejections.some((r) => r.verification && isBacked(r.verification) && probeConfirmedIn(state, r.verification)));
}

// "Over-the-air updates: none." answers a disclosure question; it is not a claim that something can never happen.
function maskDisclosureAnswers(s: string): string {
  return s.replace(/:\s*(?:none|never)\b/gi, (m) => " ".repeat(m.length));
}

const ABSOLUTE_RX = new RegExp(
  [
    String.raw`\bnone\b`,
    String.raw`\bnever\b`,
    String.raw`\bimpossible\b`,
    String.raw`\bguarantee(?:s|d)?\b`,
    String.raw`\b100\s?%`,
    String.raw`\b(?:completely|entirely|fully|totally)\s+(?:removed|eliminated|deleted|gone|blocked)\b`,
    String.raw`\bfully\s+compliant\b`,
    String.raw`\b(?:removed|deleted|eliminated|blocked|filtered|disabled)\s+all\b`,
    String.raw`\b(?:blocks|removes|filters|prevents|stops|rejects|disables)\s+all\b`,
    // "disabled for all users" claims a state for every install, which a remote switch cannot show
    String.raw`\b(?:disabled|unavailable|removed|hidden|turned off|switched off|blocked)\b[^.!?]{0,40}\bfor\s+(?:all|every)\s+users?\b`,
    String.raw`\ball\s+(?:traces?|references?|instances?|occurrences?|ways?|paths?|outputs?|nsfw|explicit|inappropriate|objectionable|such|possible)\b`,
    String.raw`\ball\s+(?:of\s+)?(?:the\s+)?(?:offending|inappropriate|explicit|objectionable|related)\b`,
    // claims about what the model or app can produce, which only a probe could support
    String.raw`\b(?:cannot|can\s*not|can't|can no longer)\s+(?:be\s+)?(?:produc|generat|creat|obtain|output|render)\w*`,
    String.raw`\b(?:no longer|not)\s+possible\b`,
    String.raw`\b(?:by|through|via)\s+any\s+(?:route|means|path|input|method|way|prompt)\w*`,
  ].join("|"),
  "i",
);

/**
 * Only App Review decides compliance, and the tool itself never says an app is safe or compliant.
 * Even probe-tested evidence supports "what was tested", not "compliant", so this holds at every tier.
 */
const COMPLIANCE_RX = new RegExp(
  [
    String.raw`\b(?:is|are|now|fully|remains?|was|were)\s+(?:now\s+|fully\s+|completely\s+)?compliant\b`,
    String.raw`\bcomplies\s+with\b`,
    String.raw`\b(?:is|are|now)\s+(?:now\s+|fully\s+)?in\s+(?:full\s+)?compliance\s+with\b`,
    String.raw`\bmeets?\s+(?:all|every|the|your|apple['’]s)\b[^.!?]{0,30}\b(?:guidelines?|requirements)\b`,
    String.raw`\b(?:is|are)\s+(?:now\s+|completely\s+|totally\s+|perfectly\s+)?safe\b(?!\s+to\b)`,
    String.raw`\bwill\s+(?:now\s+|certainly\s+|definitely\s+)?(?:pass|clear)\s+(?:app\s+)?review\b|\bwill\s+(?:now\s+|certainly\s+|definitely\s+)?(?:be|get)\s+approved\b`,
  ].join("|"),
  "i",
);
const COMPLIANCE_NEGATED = /(?:\b(?:not|never|no|cannot|whether|if)\b|n['’]t\b)(?:\s+[\w'’-]+){0,4}\s*$/i;

/**
 * A difference between what App Review sees and what users get, written as the app's behavior:
 * "no longer shown during App Review", "hidden for reviewers". That is the conduct Guideline 2.5.19
 * and DPLA 3.2(e) forbid, so writing it into App Store Connect records it. An account of a past
 * condition that was removed ("earlier builds hid X during review; it was removed") is candor and
 * is left to the admission check.
 */
const REVIEW_AUDIENCE = String.raw`(?:(?:the\s+|your\s+)?app\s+review(?:\s+team)?(?!['’]s)|(?:the\s+|your\s+|a\s+)?reviewers?(?!['’]s)|(?:the\s+)?review\s+(?:devices?|installs?|builds?|accounts?|team|period|process|session)|testflight(?:\s+(?:users?|builds?|testers?|installs?))?|sandbox\s+(?:users?|accounts?))`;
const REVIEW_SPECIFIC = new RegExp(
  [
    String.raw`\b(?:(?:no\s+longer|not|never)\s+(?:be\s+|being\s+)?(?:shown|visible|displayed|available|accessible|reachable|offered|enabled|included|served|loaded|returned)|hidden|hides?|hiding|disabled|disables?|turned\s+off|switched\s+off|suppress\w*|gated|withheld|excluded|different(?:ly)?)\b[^.!?]{0,40}?\b(?:during|to|for|from|on|while)\s+(?:in\s+)?(?:${REVIEW_AUDIENCE}|(?:the\s+|app\s+)?review\b)`,
    String.raw`\bonly\s+(?:to|for|during|on)\s+${REVIEW_AUDIENCE}`,
    String.raw`\b(?:except|unless|other\s+than|but\s+not)\s+(?:for\s+|to\s+|on\s+|during\s+)?(?:${REVIEW_AUDIENCE}|(?:the\s+|app\s+)?review\b)`,
    String.raw`\b(?:detects?|detected|detecting|identif\w+|recogni[sz]\w+)\s+(?:when\s+)?(?:the\s+)?(?:app\s+review|reviewers?|review\s+(?:devices?|accounts?))`,
  ].join("|"),
  "i",
);
// "does not behave differently for App Review" denies a difference; it describes none.
// "No longer hidden from App Review installs" says the difference is gone.
const REVIEW_SAME = /(?:\b(?:not|never|no)\b|n['’]t\b)(?:\s+[\w'’-]+){0,3}?\s+(?:different(?:ly)?|differ)\b|\bthe\s+same\b|(?:\b(?:no\s+longer|not|never)|n['’]t)\s+(?:be(?:ing)?\s+|been\s+)?(?:hidden|hides?|hiding|disabled|gated|suppress\w*|withheld|excluded|turned\s+off|switched\s+off)\b/i;
const PAST_ACCOUNT = /\b(?:was|were|had|earlier|previous(?:ly)?|prior|used\s+to|older)\b/i;
const PRESENT_STATE = /\b(?:now|no\s+longer|is|are|will|remains?|stays?|hides|disables|suppresses|detects|only)\b/i;

function reviewSpecificBehavior(s: Sentence, masked: string): LintIssue | undefined {
  if (/\?\s*$/.test(s.text)) return undefined;
  for (const clause of clausesOf(masked)) {
    const m = REVIEW_SPECIFIC.exec(clause);
    if (!m || REVIEW_SAME.test(clause) || !PRESENT_STATE.test(clause)) continue;
    // "We removed a check that turned X off for App Review" reports the removal.
    if ((PAST_ACCOUNT.test(clause) && !/\b(?:now|no\s+longer)\b/i.test(clause)) || /\b(?:removed|deleted|stripped)\b/i.test(clause.slice(0, m.index))) continue;
    return {
      rule: "review_specific_behavior",
      severity: "error",
      excerpt: clip(s.text),
      message: `Describes the app behaving differently for App Review ("${m[0].trim()}"). Showing App Review something other than what users get is the hidden or dormant feature Guideline 2.5.19 bans and the deception DPLA 3.2(e) forbids; written into App Store Connect, it is a record of that conduct.`,
      fix: "Remove the review-specific behavior and the capability it kept from App Review, so the build App Review sees is the build users get. Then describe what the app does for every user and how that was verified.",
    };
  }
  return undefined;
}

// "the API" alone is too common in plain descriptions ("calls the Gemini API"); "our API" is a claim about our servers.
const ATTESTATION_SUBJECT =
  /\bour\s+(?:own\s+)?(?:servers?|back-?ends?|apis?|cloud functions?|edge functions?|server prompts?|system prompts?|moderation (?:service|pipeline|endpoint))\b|\bthe\s+(?:servers?|back-?ends?|cloud functions?|edge functions?|server prompts?|system prompts?|moderation (?:service|pipeline|endpoint))\b|\bserver[- ]side\b/i;
const ATTESTATION_PREFIX = /^\s*(?:[-*•]\s*)?the developer (?:states|confirms|attests)\b/i;
// A promise about what a remote switch or OTA channel will carry is about future behaviour App
// Review cannot check in the build, so it is the developer's statement, never a fact we assert.
const REMOTE_CHANNEL = /\b(?:remote[- ]?config(?:uration)?|feature[- ]?flags?|remote (?:keys?|switch(?:es)?|flags?)|kill[- ]?switch(?:es)?|over[- ]the[- ]air|OTA|code[- ]?push|EAS updates?|expo-updates)\b/i;
const FORWARD_ASSURANCE = /\b(?:(?:is|are) not used to|never used to|(?:is|are) (?:only )?limited to|will not|won'?t|will only|(?:is|are) only used (?:to|for))\b/i;

// A switch flipped on a server, presented as the fix. Apple distrusts fixes made on a server
// [source]; 2.5.19 and DPLA 3.2(e) make a feature that can come back after review the problem.
const DISABLE_VERB =
  /\b(?:turn(?:ed|ing|s)?|switch(?:ed|es|ing)?|toggl(?:e|ed|es|ing)|flipp(?:ed|ing)|flips?|shut)\s+(?:[\w"'`.-]+\s+){0,3}?off\b|\bdisabl(?:e|ed|es|ing)\b|\bdeactivat(?:e|ed|es|ing)\b|\bhid(?:e|es|den|ing)\b|\bset\s+(?:[\w"'`.-]+\s+){1,3}?to\s+(?:false|0|off|disabled)\b/i;
const SERVER_SIDE =
  /\b(?:on|in|from|via|through|using)\s+(?:our|the)\s+(?:servers?|back-?ends?|dashboard|console|admin (?:panel|console))\b|\bserver[- ]side\b|\b(?:firebase|launchdarkly|statsig|configcat|optimizely|growthbook|flagsmith|unleash|posthog)\b/i;
const FIX_FRAMING =
  /\b(?:resolv(?:e|ed|es)|fix(?:ed|es)?|address(?:ed|es)?|remediat\w*|now\s+(?:disabled|off|hidden|unavailable|gone)|no longer\s+(?:available|accessible|shown|visible|possible|enabled|reachable)|for (?:all|every) users?|to comply|complies|compliant)\b/i;
const FIRST_PERSON_ACTION = /\b(?:we|i|our team)\s+(?:have\s+|had\s+)?(?:now\s+)?(?:turned|switched|toggled|flipped|shut|set|disabled|deactivated|hid)\b/i;
const BUILD_REMOVAL =
  /\b(?:removed|deleted|stripped)\b[^.!?]{0,60}\b(?:from|in|out of)\s+(?:the\s+|this\s+)?(?:app|build|binary|code(?:base)?|source|client|bundle)\b|\b(?:removed|deleted)\s+the\s+(?:code|flag|key|switch|check)\b/i;

const SECRET_PATTERNS: { rx: RegExp; what: string }[] = [
  { rx: /\b(?:password|passcode|passwd|pwd)\s*[:=]\s*(\S+)/i, what: "password" },
  { rx: /\bsk-(?:ant-|proj-|live-)?[A-Za-z0-9_-]{16,}/, what: "API secret key (sk-…)" },
  { rx: /\b[rs]k_live_[0-9a-zA-Z]{16,}/, what: "Stripe live key" },
  { rx: /\bAIza[0-9A-Za-z_-]{35}\b/, what: "Google API key" },
  { rx: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/i, what: "bearer token" },
  { rx: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: "private key" },
  { rx: /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/, what: "GitHub token" },
  { rx: /\bAKIA[0-9A-Z]{16}\b/, what: "AWS access key" },
  { rx: /\bxox[abpr]-[A-Za-z0-9-]{10,}/, what: "Slack token" },
  { rx: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, what: "JWT" },
];
// Demo credentials pasted as "luna@example.com / Review2026!" or "(pw Review2026!)", without "password:".
const CREDENTIAL_PATTERNS: { rx: RegExp; what: string }[] = [
  { rx: /(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+\s*(?:\/|\||,|;|\s)\s*(?:(?:pw|pwd|pass(?:word)?)\s*[:=]?\s*)?((?=\S*\d)(?=\S*[A-Za-z])[^\s,;)]{6,})/, what: "login and password" },
  { rx: /\b(?:pw|pwd|pass)\b\.?\s*[:=]?\s*((?=\S*[\d!@#$%^&*])[^\s,;)]{4,})/i, what: "password" },
];
const CREDENTIAL_CONTEXT = /\b(?:log ?in|sign[- ]?in|demo|account|credentials?|user(?:name)?|pw|pwd|pass(?:word)?)\b/i;

const COMPARISON_RX =
  /\bother apps\b|\bsimilar apps\b|\bcompetitors?\b|\bcompeting apps?\b|\bapps like\b|\b(?:same|similar) (?:as|to) (?:other|those|many|several)\b|\b(?:is|are) already (?:approved|available|on the App Store)\b/i;
const PRESSURE_RX =
  /\bapprove\b[^.!?]{0,40}\b(?:quickly|asap|immediately|urgently|right away|today|as soon as possible)\b|\b(?:asap|urgent(?:ly)?)\b|\bas soon as possible\b|\bwe are losing (?:money|revenue|users)\b/i;

const PASSWORD_PLACEHOLDER = /^(?:[<[{(]|see\b|provided\b|in\b|n\/a\b|\*+$|x{3,}|•+$|\.{3}|…|\$\{|\{\{|redacted\b|placeholder\b)/i;

const TONE_RULES: { rx: RegExp; severity: LintSeverity }[] = [
  { rx: /\b(?:lawyers?|attorneys?|legal action|lawsuits?|litigation|sue|sued|suing)\b/i, severity: "error" },
  { rx: /\byou(?:'re|’re| are) (?:wrong|mistaken|incorrect)\b/i, severity: "error" },
  // The same verdict in the third person ("your reviewer was clearly mistaken") argues the decision as much.
  {
    rx: /\b(?:(?:the|your|this|that|our)\s+)?(?:(?:previous|prior|last|first|app)\s+)?(?:reviewers?|app review)\s+(?:(?:was|were|is|are|has been|have been)\s+)(?:(?:clearly|simply|obviously|plainly|just|completely|totally)\s+)?(?:wrong|mistaken|incorrect|in error)\b/i,
    severity: "error",
  },
  // Blaming the reviewer argues the decision instead of answering it.
  {
    rx: /\b(?:the\s+|your\s+)?(?:previous\s+|prior\s+|last\s+|first\s+)?reviewers?\b[^.!?]{0,30}?\b(?:misunderstood|misread|missed|overlooked|got it wrong|(?:did not|didn't|failed to|clearly did not)\s+(?:understand|read|notice|see|look|test))\b/i,
    severity: "warning",
  },
  { rx: /\byou\s+(?:have\s+|clearly\s+)?(?:misunderstood|misread|missed|overlooked)\b/i, severity: "warning" },
  { rx: /(?<!\b(?:we|i)\s+(?:have\s+|had\s+)?)\bmisunderstood\s+(?:the|our|my|this)\s+(?:app|feature|submission|functionality)\b/i, severity: "warning" },
  { rx: /\bas\s+(?:we|i)\s+(?:have\s+)?(?:already|previously)\s+(?:explained|stated|said|mentioned|told you)\b|\bas\s+(?:already|previously)\s+(?:explained|stated)\b/i, severity: "warning" },
  { rx: /\b(?:unfair(?:ly)?|ridiculous|absurd|incompetent|outrageous|nonsense)\b/i, severity: "warning" },
  { rx: /\bdiscriminat\w*/i, severity: "warning" },
  { rx: /(?<!\bon[- ])\bdemand(?:s|ed|ing)?\b(?!\s+(?:video|content|access|streaming|generation))/i, severity: "warning" },
  { rx: /\bunacceptable\b(?!\s+(?:content|material|images?|posts?|messages?|behaviou?r|uses?))/i, severity: "warning" },
];

const GENERIC_CHANGE_RX =
  /\b(?:bug\s*fix(?:es)?|(?:performance|stability|ui|general|various|minor|small)\s+(?:improvements?|enhancements?|changes|updates|fixes|tweaks)|improvements|minor changes|general updates|small tweaks)\b/gi;
const STOPWORDS = new Set(["and", "the", "for", "with", "this", "that", "some", "our", "made", "includes", "include", "contains", "version", "build", "update", "release", "new", "other", "also", "various", "minor", "general", "few", "several"]);

const SPECULATIVE_RX =
  /\bif (?:we|our app|the app) (?:did|have|has|had|was|were)\b|\bwe (?:may|might|could) have\b|\bperhaps (?:we|our)\b|\bmaybe (?:we|our)\b|\bit(?:'s| is) possible (?:that )?(?:we|our)\b|\bwe (?:probably|possibly)\b|\bin case we\b|\bwhatever we did\b|\bif anything we\b/i;

/**
 * `mechanism` categories describe what code did ("turned off for App Review"), which a diff can
 * show; they are confirmed by any matching statement the developer recorded, not only a confession.
 */
const ADMISSION_CATEGORIES: { rx: RegExp; category: string; stems: RegExp; mechanism?: boolean }[] = [
  { rx: /\bwe\s+(?:have\s+|had\s+)?(?:manipulat\w+)|apologi[sz]e for manipulat\w+/i, category: "manipulation", stems: /manipulat/i },
  { rx: /\bwe\s+(?:have\s+|had\s+)?misled\b|\bwe were misleading\b|apologi[sz]e for (?:misleading|being misleading)/i, category: "misleading", stems: /mislead|misled/i },
  { rx: /\bwe\s+(?:have\s+|had\s+)?deceived\b|\bwe were deceptive\b|apologi[sz]e for (?:deceiving|deception|being deceptive)/i, category: "deception", stems: /decei|decept/i },
  { rx: /\bwe\s+(?:have\s+|had\s+)?(?:hid|hidden|concealed)\b|apologi[sz]e for (?:hiding|concealing)/i, category: "concealment", stems: /hid|conceal/i },
  { rx: /\bwe\s+(?:have\s+|had\s+)?(?:tricked|cheated)\b|apologi[sz]e for (?:tricking|cheating)/i, category: "tricking review", stems: /trick|cheat/i },
  { rx: /\bwe\s+(?:have\s+|had\s+)?(?:faked|fabricated)\b|apologi[sz]e for (?:fake|fabricat)/i, category: "fake reviews or ratings", stems: /fake|fabricat|review/i },
  // Bounded gaps: an unbounded one is quadratic on a long run of "we" with no sentence end.
  { rx: /\bbait[- ]and[- ]switch\b(?=[^.!?]{0,200}\b(?:we|our)\b)|\b(?:we|our)\b[^.!?]{0,200}\bbait[- ]and[- ]switch\b/i, category: "bait-and-switch", stems: /bait/i },
  {
    // Wording that says a feature was kept from App Review is a 2.5.19 / 3.2(f) admission, even phrased as a fix.
    rx: /\b(?:hid(?:den|ing)?|conceal\w*|withheld)\b[^.!?]{0,60}\b(?:from|for|on|during|to)\s+(?:the\s+)?(?:app\s+review|reviewers?|review(?:er)?\s+(?:devices?|installs?|builds?|accounts?|team|process)|testflight|sandbox|the review)\b/i,
    category: "hiding features from App Review",
    stems: /hid|conceal|withh|review/i,
  },
  {
    rx: /\b(?:gated|gating|not shown|not visible|disabled|turned off|switched off|suppressed)\b[^.!?]{0,60}\b(?:from|for|on|during|to)\s+(?:the\s+)?(?:app\s+review|reviewers?|review(?:er)?\s+(?:devices?|installs?|builds?|accounts?|team|process)|testflight|sandbox|the review)\b|\b(?:app\s+review|reviewers?|review(?:er)?\s+(?:devices?|installs?|builds?|accounts?))\b[^.!?]{0,40}\b(?:could not|couldn't|did not|didn't|would not|wouldn't|never)\s+(?:see|reach|access|find)\b/i,
    category: "a condition that changed the app during review",
    stems: /gat|disabl|turn|switch|suppress|shown|visible|review|testflight|sandbox/i,
    mechanism: true,
  },
];

/**
 * Admissions of conduct in any grammatical form, beyond the verb shapes above: a label
 * ("our deceptive practices", "our conduct was dishonest") or an apology for an act ("sorry for
 * concealing …"). Shoemaker warns against confessing to an act nobody named; a label names none.
 */
const CONDUCT_WORDS: { rx: RegExp; category: string; stems: RegExp }[] = [
  { rx: /manipulat/i, category: "manipulation", stems: /manipulat/i },
  { rx: /mislead|misled/i, category: "misleading", stems: /mislead|misled/i },
  { rx: /decei|decept/i, category: "deception", stems: /decei|decept/i },
  { rx: /dishonest|untruth|\bl(?:ied|ying)\b/i, category: "dishonesty", stems: /dishonest|untruth|\bl(?:ie|ied|ying)\b/i },
  { rx: /conceal|\bhid/i, category: "concealment", stems: /hid|conceal/i },
  { rx: /trick|cheat/i, category: "tricking review", stems: /trick|cheat/i },
  { rx: /fraud/i, category: "fraud", stems: /fraud/i },
  { rx: /fak|fabricat/i, category: "fake reviews or ratings", stems: /fake|fabricat/i },
];
const CONDUCT_ADJ = String.raw`(?:deceptive|deceitful|dishonest|manipulative|misleading|fraudulent|untruthful|underhanded)`;
const CONDUCT_NOUN = String.raw`(?:practices?|conduct|behaviou?rs?|patterns?|submissions?|actions?|acts?|tactics?|methods?|notes|responses?|statements?|metadata|descriptions?|claims?|marketing|schemes?|activit(?:y|ies)|business|manner)`;
const OWNER = /\b(?:we|i|us|our|my|the developer|the team|our team|our company)\b/i;
const ADMIT_FRAME = String.raw`(?:apologi[sz]\w*|sorry|regret\w*|admit\w*|accept\w*|acknowledg\w*|confess\w*|own\s+up|(?:take|takes|took|taking)\s+(?:full\s+|complete\s+)?responsibility)`;
const CONDUCT_SHAPES: { rx: RegExp; label: boolean }[] = [
  // a label on the developer's own conduct: "our deceptive practices", "a pattern of manipulative behavior"
  { rx: new RegExp(String.raw`\b${CONDUCT_ADJ}\s+(?:[\w-]+\s+){0,2}?${CONDUCT_NOUN}\b`, "i"), label: true },
  // the same label as a predicate: "our conduct was dishonest", "we were deceitful"
  {
    rx: new RegExp(String.raw`\b(?:we|i|our\s+(?:[\w-]+\s+){0,2}?(?:conduct|behaviou?r|notes|submissions?|responses?|statements?|actions?|metadata|descriptions?|listing|app))\s+(?:was|were|had been|have been|has been|are|is)\s+(?:(?:clearly|very|somewhat|partly|deliberately|intentionally)\s+)?${CONDUCT_ADJ}`, "i"),
    label: true,
  },
  // an apology or acceptance for an act: "sorry for concealing", "we admit we misled"
  {
    rx: new RegExp(String.raw`\b${ADMIT_FRAME}\b(?:\s+[\w'’-]+){0,6}?\s+(?:conceal\w*|hiding|hid|mislead\w*|misled|deceiv\w*|decept\w*|manipulat\w*|trick\w*|cheat\w*|fak(?:ed|ing)|fabricat\w*|l(?:ied|ying)|dishonest\w*|fraud\w*)`, "i"),
    label: false,
  },
  { rx: /\b(?:we|i)\s+(?:have\s+|had\s+)?(?:lied|cheated|defrauded)\b/i, label: false },
];
const CONDUCT_NEGATED = /(?:\b(?:not|never|no|nothing|without|neither|nor|deny|denies|denied)\b|n['’]t\b)(?:\s+[\w'’-]+){0,4}\s*$/i;
const CONDUCT_ASKED = /\b(?:which|what|whichever|whatever)\s+$/i;
// "The notice refers to deceptive practices" reports Apple's allegation; it confesses nothing.
const ALLEGATION = /\b(?:notice|letter|apple|email|message|termination|reviewer|app review)\b[^.!?]{0,40}\b(?:refer|allege|describ|mention|cit|say|said|state|claim|accus|list)\w*/i;

function conductAdmission(masked: string): { category: string; stems: RegExp; phrase: string; label: boolean } | undefined {
  for (const clause of clausesOf(masked)) {
    if (ALLEGATION.test(clause)) continue;
    const framed = new RegExp(String.raw`\b${ADMIT_FRAME}\b`, "i").test(masked);
    for (const shape of CONDUCT_SHAPES) {
      const m = shape.rx.exec(clause);
      if (!m) continue;
      const before = clause.slice(0, m.index);
      if (CONDUCT_NEGATED.test(before) || CONDUCT_ASKED.test(before)) continue;
      if (!OWNER.test(clause) && !framed) continue;
      const word = CONDUCT_WORDS.find((w) => w.rx.test(m[0]));
      if (word) return { category: word.category, stems: word.stems, phrase: m[0].trim(), label: shape.label };
    }
  }
  return undefined;
}

/**
 * Explanations of why something existed or how it happened ("legacy code from testing", "accidental",
 * "good faith"). Only the developer knows; an agent writing them is a denial on their behalf.
 * review-notes.md forbids them unless the developer confirmed the wording.
 */
const INTENT_RX = new RegExp(
  [
    String.raw`\blegacy\s+(?:code|check|condition|flag|logic|branch)\b`,
    String.raw`\bleft\s?over\s+from\b|\bleftover\s+(?:code|check|condition|flag|logic|branch|from)\b`,
    String.raw`\bonly\s+(?:(?:ever\s+)?(?:used|meant|intended|there)\s+)?for\s+(?:internal\s+)?(?:testing|tests|QA|debug(?:ging)?|development)\b`,
    String.raw`\bexisted\s+only\s+for\b`,
    String.raw`\bfor\s+(?:QA|internal(?:\s+testing)?|testing|debug(?:ging)?)\s+purposes\b`,
    String.raw`\b(?:was|were|is)\s+(?:an?\s+|purely\s+|entirely\s+|completely\s+)?(?:accident(?:al)?|inadvertent|unintentional|oversight|honest mistake)\b`,
    String.raw`\b(?:we|i|the team|it|this|that|they)\s+(?:\w+\s+)?(?:accidentally|inadvertently|unintentionally|mistakenly)\b`,
    String.raw`\bby\s+(?:accident|mistake)\b|\b(?:an|through an|due to an)\s+oversight\b`,
    String.raw`\bno idea\b|\bnever knew\b|\bnever\s+(?:meant|intended)\b|\b(?:did not|didn't|do not|don't)\s+(?:mean|intend)\s+to\b`,
    String.raw`\bgood[- ]faith\b|\bhonest mistake\b`,
  ].join("|"),
  "i",
);
// "Only for testing" about a demo account is a plain fact, not an explanation of intent.
const DEMO_FACT = /\b(?:demo|test|sandbox|review(?:er)?)\s+(?:account|login|credentials?|user)\b/i;

// The developer's own denial of awareness ("we were not aware of …").
const AWARENESS_DENIAL = new RegExp(String.raw`\b(?:we|i|the developer|the team|our team|our company)\b[^.!?]{0,40}?(?:${NOT_AWARE_RX.source})`, "i");
const ALL_FIXED =
  /\b(?:each|every|all)\s+(?:of\s+(?:the|our)\s+)?(?:prior\s+|previous\s+|past\s+)?rejections?\b[^.!?]{0,80}\b(?:fixed|addressed|resolved|answered|remediated|corrected)\b|\b(?:fixed|addressed|resolved|remediated|corrected)\s+(?:each|every|all)\s+(?:of\s+(?:the|our)\s+)?(?:issues?|rejections?|problems?)\b/i;
// "What App Review saw" places the claim against the reviewed build as much as "since approval" does.
const POST_APPROVAL_CONTEXT =
  /\b(?:since|after)\b[^.!?]{0,40}\b(?:approv\w*|review\w*|release\w*)|\bpost-?(?:approval|review)\b|\bwhat\s+(?:app\s+review|the\s+reviewers?|reviewers?)\s+(?:saw|sees|see|reviewed|approved|tested)\b|\b(?:approved|reviewed)\s+(?:versions?|builds?|binar(?:y|ies))\b/i;

// "you approved" places a claim against the reviewed build as much as "since approval" does.
const REVIEWED_REF = /\b(?:you|apple|app\s+review|the\s+reviewers?|reviewers?|the\s+(?:review\s+)?board)\s+(?:have\s+|had\s+)?(?:approved|reviewed|accepted)\b|\b(?:approved|reviewed)\s+(?:versions?|builds?|binar(?:y|ies)|apps?)\b/i;

/**
 * A change described as nothing but bug fixes. Against a recorded change to content or price it
 * understates the change; 2.5.2 allows downloaded code to fix bugs, so "only bug fixes" is exactly
 * the claim that makes a content change look allowed.
 */
const MINIMIZED = /\b(?:only|just|merely|purely|solely)\s+(?:[\w-]+\s+){0,2}?(?:(?:minor|small)\s+)?(?:bug[- ]?fix(?:es)?|fix(?:ed|es)?\s+(?:(?:a\s+few|some|minor|small)\s+)?(?:bugs?|crash(?:es)?|typos?)|(?:minor|small)\s+(?:fixes|changes|tweaks|updates))\b|\b(?:bug[- ]?fix(?:es)?|fixed\s+bugs?)\s+only\b|\bnothing\s+(?:but|except|other\s+than|beyond)\s+(?:minor\s+|small\s+)?(?:bug[- ]?fix(?:es)?|bugs?)\b|\b(?:were|was|are|is)\s+(?:all\s+|just\s+|only\s+)?(?:minor\s+|small\s+)?bug[- ]?fix(?:es)?\b|\bonly\s+tweak\w*|\bonly\s+(?:made\s+)?(?:small|minor|cosmetic)\s+\w+/i;

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** Ways a text names the day a change was recorded: 2026-10-20, October 20, Oct 20, 20 October. */
function dayMentioned(sentence: string, at: string): boolean {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return false;
  const month = MONTHS[d.getUTCMonth()]!;
  const day = d.getUTCDate();
  const m = String.raw`(?:${month}|${month.slice(0, 3)}\.?)`;
  return new RegExp(String.raw`\b${at.slice(0, 10)}\b|\b${m}\s+${day}(?:st|nd|rd|th)?\b|\b${day}(?:st|nd|rd|th)?\s+(?:of\s+)?${m}\b`, "i").test(sentence);
}

const OTA_REF = /\b(?:over[- ]the[- ]air|OTA|EAS\s+updates?|expo[- ]updates|code\s*push|shorebird|hot\s+updates?|(?:js|javascript)\s+bundle\s+updates?)\b/i;

/** The recorded changes a clause is about: it names one (its key, file or id), its day, or, for an OTA publish, OTA itself. */
function changesReferenced(clause: string, changes: ReturnType<typeof materialPostApprovalChanges>): ReturnType<typeof materialPostApprovalChanges> {
  return changes.filter((c) => namesAny(clause, c.mentions.filter((x) => x.length >= 4 && !/^(?:ota|model|price|pricing|paywall)$/i.test(x))) || dayMentioned(clause, c.at) || (c.kind === "ota_publish" && OTA_REF.test(clause)));
}

const CHANGE_CLAIM = /\b(?:fix\w*|remediat\w*|correct(?:ed|ing)|chang(?:ed|ing|es)|modif\w*|updat(?:ed|ing)|remov(?:ed|ing)|revis(?:ed|ing))\b/i;

const COUNT_WORDS: Record<string, number> = { once: 1, one: 1, single: 1, twice: 2, two: 2, couple: 2, thrice: 3, three: 3, few: 3, four: 4, five: 5 };
const COUNT = String.raw`(?:once|twice|thrice|(?:one|two|three|four|five|\d{1,3})\s+times?|a\s+(?:couple(?:\s+of)?|few)\s+times|a\s+single\s+time)`;
const REJ_COUNT_RX = new RegExp(
  [
    String.raw`\brejected\s+(?:only\s+)?(${COUNT})`,
    String.raw`\bonly\s+(?:been\s+)?rejected\s+(${COUNT})`,
    String.raw`\bonly\s+(one|two|three|four|five|\d{1,3}|a\s+(?:couple(?:\s+of)?|few)|a\s+single)\s+(?:prior\s+|previous\s+|past\s+)?(?:[\w()./-]+\s+){0,2}?rejections?\b`,
    // "This is the first time our app has been rejected" claims one rejection in all; the ordinal in a history ("our first rejection was …") does not
    String.raw`\b(?:this|it)\s+is\s+(?:the|our|my|its)\s+(?:very\s+)?first(?:[- ]ever)?\s+(?:time\b[^.!?]{0,40}?\b(?:rejected|rejections?)\b|rejection\b)`,
    String.raw`\b(?:is|was)\s+(?:the|our|my|its)\s+(?:very\s+)?first(?:[- ]ever)?\s+rejection\s+ever\b|\b(?:is|was)\s+(?:the|our|my|its)\s+(?:very\s+)?first[- ]ever\s+rejection\b`,
    String.raw`\bfirst\s+time\s+ever\b[^.!?]{0,40}?\brejected\b`,
  ].join("|"),
  "i",
);
const REJ_NONE_RX =
  /\bno\s+(?:prior\s+|previous\s+|past\s+|other\s+)?(?:history\s+of\s+)?(?:[\w()./-]+\s+){0,3}?rejections?\b|\bnever\s+(?:been\s+|got\s+|gotten\s+)?rejected\b|\bnever\s+(?:had|received|got)\s+(?:a|any)\s+(?:[\w-]+\s+){0,2}?rejections?\b|\bclean\s+(?:app\s+)?(?:review\s+|submission\s+)?(?:history|record)\b|\bzero\s+rejections?\b/i;
const SUB_COUNT_RX = new RegExp(
  [
    String.raw`\bsubmi\w*\b[^.!?]{0,40}?\bonly\s+(?:ever\s+)?(${COUNT})`,
    String.raw`\bonly\s+(?:ever\s+)?(?:(?:had|made|sent|done|filed)\s+)?(one|two|three|four|five|\d{1,3}|a\s+(?:couple(?:\s+of)?|few)|a\s+single)\s+(?:times|submissions?)\b`,
    String.raw`\bonly\s+(?:ever\s+)?submitted\s+(?:(?:it|the app|this app|our app)\s+)?(${COUNT})`,
    String.raw`\b(?:this|it)\s+is\s+(?:the|our|my|its)\s+(?:very\s+)?first(?:[- ]ever)?\s+submission\b`,
  ].join("|"),
  "i",
);

function countOf(phrase: string): number {
  const digits = /\d+/.exec(phrase);
  if (digits) return Number(digits[0]);
  const word = Object.keys(COUNT_WORDS).find((w) => new RegExp(`\\b${w}\\b`, "i").test(phrase));
  return word ? (COUNT_WORDS[word] ?? 1) : 1;
}

/** The period a history claim covers, if it names one; undefined means all recorded history. */
function claimWindow(sentence: string, nowMs: number): { from: number; label: string } | undefined | null {
  if (/\bthis year\b/i.test(sentence)) return { from: Date.UTC(new Date(nowMs).getUTCFullYear(), 0, 1), label: "this year" };
  const last = /\b(?:last|past)\s+(\d{1,3}|few|couple of)?\s*(days?|weeks?|months?|years?)\b/i.exec(sentence);
  if (last) {
    const n = last[1] ? (/\d/.test(last[1]) ? Number(last[1]) : countOf(last[1])) : 1;
    const unit = { d: 1, w: 7, m: 30, y: 365 }[last[2]!.toLowerCase()[0] as "d" | "w" | "m" | "y"];
    return { from: nowMs - n * unit * 86_400_000, label: last[0] };
  }
  // "no rejections since the fix" names a window we cannot place; judging it against all history would misfire.
  if (/\b(?:since|after|following)\b/i.test(sentence)) return null;
  return undefined;
}

/** A claim scoped to a guideline ("no 1.1 rejections", "objectionable-content rejections") counts only those. */
function claimScope(sentence: string): { label: string; test: (g: string[]) => boolean } | undefined {
  const G = String.raw`\d+\.\d+(?:\.\d+)*(?:\([a-z]\))?`;
  const named = [
    ...[...sentence.matchAll(new RegExp(String.raw`\b(?:Guidelines?|under)\s+(${G}(?:\s*(?:,|and|or|\/)\s*${G})*)`, "gi"))].flatMap((m) => m[1]!.split(/\s*(?:,|and|or|\/)\s*/)),
    ...[...sentence.matchAll(new RegExp(String.raw`\b(${G})\s+(?:[\w-]+\s+)?rejections?\b`, "gi"))].map((m) => m[1]!),
  ].filter(Boolean);
  if (named.length) return { label: ` under Guideline ${named.join(", ")}`, test: (gs) => gs.some((g) => named.some((n) => g === n || g.startsWith(`${n}.`) || g.startsWith(`${n}(`))) };
  if (/objectionable|user[- ]generated|\bugc\b/i.test(sentence)) return { label: " under 1.1/1.2", test: (gs) => gs.some(isObjectionableGuideline) };
  return undefined;
}

/** Statements that count or deny rejections or submissions with a lower number than the ledger holds. */
function historyUnderstated(sents: Sentence[], state: LedgerState, nowMs: number, flagged: Set<string>, mask: (s: string) => string): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const s of sents) {
    if (flagged.has(s.text) || /\?\s*$/.test(s.text)) continue;
    const masked = mask(s.text);
    const rej = REJ_COUNT_RX.exec(masked);
    const none = rej ? null : REJ_NONE_RX.exec(masked);
    const sub = /submi/i.test(masked) ? SUB_COUNT_RX.exec(masked) : null;
    if (!rej && !none && !sub) continue;
    const window = claimWindow(masked, nowMs);
    if (window === null) continue;
    const inWindow = (at: string) => !window || (Date.parse(at) >= window.from && Date.parse(at) <= nowMs);
    const where = window ? ` ${window.label}` : "";
    // "no open rejections" or "this version was rejected once" may be true; the ledger cannot place them.
    const narrowed = /\b(?:open|unresolved|outstanding|pending|current|remaining|new|further|additional|recent|version|build|this (?:update|release))\b/i.test(masked);
    if ((rej || none) && !narrowed) {
      const scope = claimScope(masked);
      const matching = state.rejections.filter((r) => inWindow(r.at) && (!scope || scope.test(r.guidelines)));
      // "This app was rejected once" on a multi-app account: only a count every app exceeds is surely wrong.
      const byApp = new Map<string, typeof matching>();
      for (const r of matching) byApp.set(r.bundleId ?? "", [...(byApp.get(r.bundleId ?? "") ?? []), r]);
      const appScoped = /\b(?:this|the|our|my)\s+app\b/i.test(masked) && state.apps.length > 1;
      const recorded = appScoped ? (state.apps.length > byApp.size ? [] : [...byApp.values()].sort((a, b) => a.length - b.length)[0] ?? []) : matching;
      const claimed = none ? 0 : countOf(rej?.slice(1).find(Boolean) ?? "");
      if (recorded.length > claimed) {
        flagged.add(s.text);
        issues.push({
          rule: "history_understated",
          severity: "error",
          excerpt: clip(s.text),
          message: `Claims ${claimed === 0 ? "no" : `${claimed}`} rejection(s)${scope?.label ?? ""}${where}, but the ledger records ${recorded.length}: ${recorded.slice(0, 6).map((r) => `${r.id} (${r.at.slice(0, 10)}, ${r.guidelines.join(", ") || "no guideline"})`).join("; ")}${recorded.length > 6 ? "; …" : ""}. Apple has the same history; understating it is a misleading statement in App Store Connect (DPLA 3.2(f)).`,
          fix: "State the recorded count and dates, e.g. \"The app was rejected N times (dates, guidelines)\", and what was changed after each.",
        });
        continue;
      }
    }
    if (sub) {
      const recorded = reviewSubmissions(state).filter((x) => inWindow(x.at));
      const claimed = countOf(sub.slice(1).find(Boolean) ?? "");
      if (recorded.length > claimed) {
        flagged.add(s.text);
        issues.push({
          rule: "history_understated",
          severity: "error",
          excerpt: clip(s.text),
          message: `Claims ${claimed} submission(s)${where}, but the ledger records ${recorded.length}: ${recorded.slice(0, 6).map((x) => `${x.eventId} (${x.at.slice(0, 10)})`).join("; ")}${recorded.length > 6 ? "; …" : ""}. App Store Connect shows Apple every submission.`,
          fix: "State the recorded count and dates instead of an estimate.",
        });
      }
    }
  }
  return issues;
}

/**
 * A rename, a move into a menu, or "only reachable from" presented as the answer to a rejection.
 * App Review rejects a capability, not its label or location, and Shoemaker's fair case for Apple
 * is exactly the cosmetic fix that passes once and is reported later [source].
 */
const COSMETIC_CHANGE = new RegExp(
  [
    String.raw`\b(?:renam(?:e|ed|es|ing)|re-?label(?:l?ed|l?ing|s)?|re-?titl(?:e|ed|ing)|re-?word(?:ed|ing)|re-?brand(?:ed|ing))\b`,
    String.raw`\b(?:mov(?:e|ed|es|ing)|relocat(?:e|ed|es|ing))\b(?:\s+[\w"'’>&-]+){0,6}?\s+(?:in|into|to|under|behind|inside|deeper)\s+(?:a\s+|an\s+|the\s+)?(?:[\w-]+\s+){0,2}?(?:settings|advanced|submenu|sub-menu|menu|overflow|more\s+tab|secondary|hidden|separate|another|long[- ]press)\b`,
    String.raw`\bonly\s+(?:be\s+)?(?:reachable|available|accessible|shown|visible|found|opened)\s+(?:from|via|in|through|behind|after|under|by|with)\b`,
    String.raw`\bbehind\s+(?:a|an|the)\s+(?:[\w-]+\s+){0,2}?(?:menu|gesture|long[- ]press|toggle|swipe|switch|setting)\b`,
    String.raw`\btuck(?:ed)?\s+away\b|\bburied\b|\bless\s+prominent\b`,
    // a new label for the same thing: "the Lingerie category is now called Evening"
    String.raw`\b(?:is|are)\s+now\s+(?:called|named|labell?ed|titled|listed\s+as|shown\s+as)\b`,
    // still in the app, only out of the reviewer's path: "hidden until the user completes onboarding"
    String.raw`\b(?:hidden|unavailable|locked|not\s+shown)\s+until\b`,
  ].join("|"),
  "i",
);
/**
 * Rejected content kept in the build behind a gate, an opt-in, a region or a substitute: still
 * there for users, only out of the reviewer's path. Tied by naming the open rejection's own terms.
 */
const GATING_CHANGE = new RegExp(
  [
    String.raw`\bonly\s+(?:appear|unlock|show|display|become\s+available|be\s+(?:shown|available|unlocked))\w*\s+(?:after|once|when|for|to|if)\b`,
    String.raw`\b(?:appear|unlock|show)s?\s+only\s+(?:after|once|when|for|to|if)\b`,
    String.raw`\bopt[- ]in\b`,
    String.raw`\b(?:limited|restricted|available\s+only|only\s+available|offered\s+only|shown\s+only)\s+(?:to\s+)?(?:users?|people|accounts?|customers?)\s+(?:in|outside|from|who)\b`,
    String.raw`\b(?:limited|restricted)\s+to\s+(?:certain\s+|some\s+|select(?:ed)?\s+)?(?:countries|regions|markets|territories|storefronts)\b`,
    String.raw`\brequires?\s+(?:an?\s+)?(?:18\+\s*|adult\s+)?(?:age\s+)?(?:confirmation|verification|check|gate)\b|\bbehind\s+an?\s+(?:age|18\+)\s+(?:gate|check|confirmation)\b`,
    String.raw`\breplac(?:e|ed|es|ing)\b[^.!?]{0,60}?\bwith\b`,
  ].join("|"),
  "i",
);
const AGE_GATE = /\bage\s+(?:gate|rating|verification|confirmation|check)\b|\b18\+|\badults?\s+only\b|\bparental\b/i;

const REJECTION_TIE = /\breject\w*|\bguidelines?\s+\d|\bin response to\b|\bto (?:address|resolve|comply|fix)\b|\b(?:addresses|resolves|fixes)\b|\bapp review(?:'s|’s)? (?:feedback|concerns?|request)/i;
// Moving or renaming a safeguard (a report button, terms, an age gate) or the store name is a real fix, not a disguise.
// An age gate is judged separately: it is a real fix only for an age-rating rejection.
const COSMETIC_EXEMPT = /\b(?:remov|delet|strip)\w*|\breport\w*|\bblock(?:ing)?\b|\bmoderat\w*|\bfilter\w*|\bterms\b|\beula\b|\bprivacy\b|\bconsent\b|\bdelete account\b|\brestore purchases\b|\bcontact\b|\bsupport\b|\bhelp\b|\b(?:app|store|product)\s+(?:name|title)\b|\bsubtitle\b|\bkeywords?\b/i;
const COSMETIC_NEGATED = /(?:\b(?:not|never|rather than|instead of|beyond)\b|n['’]t\b)(?:\s+(?:just|merely|simply|only))?(?:\s+[\w'’-]+){0,2}?\s+(?:renam|re-?label|re-?titl|re-?word|re-?brand|mov|relocat|tuck|bur)/i;

/**
 * A label or location change tied to a rejection: by the sentence, by its paragraph ("in response to
 * App Review's feedback. The Lingerie category is now called Evening."), or by naming the open
 * rejection's own feature. While that rejection is open and its fix is not verified, the rename is
 * the whole of the fix, so it is an error; with no ledger to say so, a warning.
 */
function cosmeticFix(s: Sentence, masked: string, cleared: boolean, open: boolean, rejectedTerms: string[], ageGateFits: boolean): LintIssue | undefined {
  if (cleared || /\?\s*$/.test(s.text)) return undefined;
  const label = COSMETIC_CHANGE.exec(masked);
  const gate = label ? null : GATING_CHANGE.exec(masked);
  const m = label ?? gate;
  if (!m || COSMETIC_EXEMPT.test(masked) || COSMETIC_NEGATED.test(masked) || (ageGateFits && AGE_GATE.test(masked))) return undefined;
  const named = namesAny(masked, rejectedTerms);
  // A gate is an ordinary product change unless it names what the open rejection objected to.
  if (gate && !named && !(rejectedTerms.length === 0 && REJECTION_TIE.test(masked))) return undefined;
  const tied = REJECTION_TIE.test(masked) || named;
  // A tie only through a neighbouring sentence may be about something else in the paragraph.
  if (!tied && !REJECTION_TIE.test(maskQuotes(s.paragraph))) return undefined;
  const what = gate ? "a gate, opt-in, regional limit or substitute" : "a change of label or location";
  return {
    rule: "cosmetic_fix",
    severity: open && tied ? "error" : "warning",
    excerpt: clip(s.text),
    message: `Presents ${what} ("${m[0].trim()}") as the response to a rejection. App Review rejects the capability, not its name, place or audience in the app; content that is renamed, relocated, gated or swapped for a near copy is still in the build and invites another rejection under the same guideline, and repeated rejections are a reported termination trigger.${open ? " The rejection it answers is still open and no fix is verified, so this is the whole of the change." : ""}`,
    fix: "Remove the capability itself, verify it with shield_remediation verify until it reaches STATIC_CLEAN, then describe that removal and how it was checked. If it was already removed, say so instead.",
  };
}

/**
 * Rejected content announced as coming back: "disabled in this build and will return in a future
 * update". Content that returns after approval without review is the hidden or dormant feature
 * 2.5.19 bans and the post-review modification DPLA 3.2(e) forbids, whatever the text calls it.
 */
const RESTORE_VERB = String.raw`(?:re-?enabl\w*|restor\w*|reinstat\w*|bring(?:ing)?\s+(?:it|them|\w+)\s+back|turn(?:ing)?\s+(?:it|them)\s+back\s+on|switch(?:ing)?\s+(?:it|them)\s+back\s+on|unlock\w*)`;
const AFTER_REVIEW = String.raw`(?:after\s+(?:approval|review|the\s+review|we\s+are\s+approved|(?:it|the\s+(?:app|build|update))\s+is\s+approved)|once\s+(?:approved|(?:it|the\s+(?:app|build|update))\s+is\s+approved|(?:the\s+)?review\s+is\s+(?:done|complete|over)))`;
// Tied to review by its own words: a plan to bring something back once App Review has passed it.
const DEFERRED_PAST_REVIEW = new RegExp(
  [
    String.raw`\b${RESTORE_VERB}\b[^.!?]{0,60}\b${AFTER_REVIEW}`,
    String.raw`\b(?:disabled|removed|hidden|turned\s+off|switched\s+off|unavailable|paused|off)\b[^.!?]{0,40}\b(?:until\s+(?:after\s+)?(?:approval|review|the\s+review|we\s+are\s+approved)|during\s+(?:the\s+)?review|for\s+(?:the\s+)?review)\b`,
  ].join("|"),
  "i",
);
// Needs a rejected capability beside it: "will return" and "in a future update" have ordinary uses.
const DEFERRED_RETURN = new RegExp(
  [
    String.raw`(?<!\b(?:we|i)\s)\bwill\s+(?:return|come\s+back|be\s+back|reappear|be\s+(?:re-?)?(?:enabled|activated|restored|reinstated|unlocked|turned\s+(?:back\s+)?on|switched\s+(?:back\s+)?on|available\s+again|added\s+back|brought\s+back))\b`,
    String.raw`\b${RESTORE_VERB}\b[^.!?]{0,60}\b(?:later|in\s+a\s+(?:future|later|subsequent|following|next)\s+(?:update|version|release|build))\b`,
    String.raw`\btemporarily\s+(?:disabled|removed|hidden|turned\s+off|switched\s+off|unavailable|paused|pulled|withdrawn)\b`,
    String.raw`\b(?:disabled|removed|hidden|turned\s+off|switched\s+off|unavailable|paused)\b[^.!?]{0,40}\b(?:for\s+now|for\s+the\s+time\s+being)\b`,
  ].join("|"),
  "i",
);
const DEFERRED_NEGATED = /\b(?:not|never|no\s+plans?\s+to|nor)\b(?:\s+[\w'’-]+){0,3}\s*$/i;

function deferredReturn(s: Sentence, masked: string, rejectedTerms: string[]): LintIssue | undefined {
  if (/\?\s*$/.test(s.text)) return undefined;
  const past = DEFERRED_PAST_REVIEW.exec(masked);
  const m = past ?? DEFERRED_RETURN.exec(masked);
  if (!m || DEFERRED_NEGATED.test(masked.slice(0, m.index))) return undefined;
  // Next to a rejected capability: the sentence removes or disables something, ties to a rejection, or names its feature.
  const context = DISABLE_VERB.test(masked) || /\b(?:remov|delet|pull|withdr[ae]w)\w*/i.test(masked) || REJECTION_TIE.test(masked) || REJECTION_TIE.test(maskQuotes(s.paragraph)) || namesAny(masked, rejectedTerms);
  if (!past && !context) return undefined;
  return {
    rule: "deferred_return",
    severity: "error",
    excerpt: clip(s.text),
    message: `Says the removed or disabled content will come back ("${m[0].trim()}"). Content restored after approval without review is the hidden or dormant feature Guideline 2.5.19 bans and the post-review modification DPLA 3.2(e) forbids; announcing it to App Review records the plan.`,
    fix: "Remove the capability, and do not plan to restore it outside a reviewed build. If it should return, it ships in a build submitted to App Review and described in that build's notes.",
  };
}

// Words every App Review message uses; the rest of a message names what was rejected.
const MESSAGE_STOP = new Set(
  "about after again apple apps based because before being below content could device devices following found further generate generated guideline guidelines hello images include includes including information issue issues please provide provided regards review reviewed reviewer safety should still submission thank their there these thing those through users using which while would your app's".split(" "),
);

/**
 * Words naming what each open, unverified rejection objected to: its saved spec (feature, terms,
 * flags) and the distinctive words of Apple's message ("lingerie"). Renaming or moving one of these
 * is tied to that rejection whatever the sentence says.
 */
function openRejectionTerms(state: LedgerState | undefined): string[] {
  const out = new Set<string>();
  for (const r of state ? unresolvedRejections(state) : []) {
    for (const t of [r.spec?.feature, ...(r.spec?.terms ?? []), ...(r.spec?.flags ?? [])]) if (t && t.trim().length >= 4) out.add(t.trim());
    for (const w of (r.reviewerMessage ?? "").toLowerCase().match(/[a-z][a-z'-]{4,}/g) ?? []) if (!MESSAGE_STOP.has(w)) out.add(w);
  }
  return [...out];
}

/** "AppEnvironment.isTestFlight" is mentioned by "isTestFlight", "TestFlight" or its file name. */
function conditionMentioned(text: string, c: RemovedCondition): boolean {
  const ids = c.condition.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? [];
  const terms = new Set<string>();
  for (const id of ids) {
    terms.add(id);
    const bare = id.replace(/^(?:is|has|should|can|use|enable|enabled)(?=[A-Z_])/, "").replace(/^_+/, "");
    if (bare.length >= 4) terms.add(bare);
    const words = bare.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").trim();
    if (words.length >= 4 && words.includes(" ")) terms.add(words);
  }
  const base = c.file.split("/").pop()?.replace(/\.[A-Za-z]+$/, "");
  if (base && base.length >= 4) terms.add(base);
  const generic = new Set(["environment", "config", "flags", "flag", "settings", "value", "bool", "string", "self", "true", "false", "remote", "remoteconfig", "default", "defaults", "user", "users", "view", "content", "app"]);
  return mentionsAny(text, [...terms].filter((t) => !generic.has(t.toLowerCase())));
}

function namesAny(sentence: string, terms: string[]): boolean {
  const lower = sentence.toLowerCase();
  return terms.some((t) => t.length >= 2 && new RegExp(`(^|[^a-z0-9])${t.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`).test(lower));
}

const DISCLOSE_WORD = String.raw`(?:disclos\w*|transparen\w*|(?:told|informed|notified|updated)\s+(?:app\s+review|apple|you|the\s+reviewers?)|(?:named|listed|described|mentioned)\s+in\s+(?:our|the)\s+(?:review\s+)?notes)`;
// The claim is about the changes: "we disclose all remote flags below" is a disclosure, not a claim about the record.
const UNIVERSAL = /\b(?:always|nothing\s+(?:was\s+)?(?:hidden|undisclosed|withheld))\b|\b(?:every|all|each|any)\s+(?:of\s+(?:the|our)\s+)?(?:[\w-]+\s+){0,2}?(?:changes?|updates?|modifications?|releases?|publish(?:es)?)\b/i;
const DISCLOSE_NEGATED = new RegExp(String.raw`(?:\b(?:not|never|failed\s+to|without)\b|n['’]t\b)(?:\s+[\w'’-]+){0,3}?\s+${DISCLOSE_WORD}`, "i");

/** "We disclosed every change", "fully transparent with App Review": a claim the disclosure record must bear out. */
function disclosureClaim(masked: string): string | undefined {
  const m = new RegExp(String.raw`\b${DISCLOSE_WORD}`, "i").exec(masked);
  if (!m || DISCLOSE_NEGATED.test(masked)) return undefined;
  const transparent = /\b(?:been|were|was|are|is|remained|stayed)\s+(?:\w+\s+)?transparen/i.test(masked);
  if (!UNIVERSAL.test(masked) && !transparent) return undefined;
  return m[0];
}

/** Statements that contradict what the ledger itself records: changes after approval, open rejections, unattested denials. */
function ledgerContradictions(sents: Sentence[], state: LedgerState, nowMs: number): LintIssue[] {
  const issues: LintIssue[] = [];
  const changes = materialPostApprovalChanges(state);
  const unresolved = unresolvedRejections(state);
  const noChange = approvedWithoutChangeEvidence(state);
  const notAware = nonAwarenessAttestation(state);
  const flagged = new Set<string>();
  const mask = appleQuoteMasker(state);
  const push = (s: Sentence, message: string, fix: string, severity: LintSeverity = "error") => {
    if (flagged.has(s.text)) return;
    flagged.add(s.text);
    issues.push({ rule: "contradicts_ledger", severity, excerpt: clip(s.text), message, fix });
  };
  const recorded = (list: typeof changes) => list.slice(0, 4).map((c) => `${c.detail} (${c.eventId}, ${c.at.slice(0, 10)})`).join("; ");
  for (const s of sents) {
    const masked = mask(s.text);
    // One check against the recorded changes: a clause about the post-approval period, or about a
    // recorded change itself, may not deny that change or shrink it to bug fixes.
    if (changes.length && !/\?\s*$/.test(s.text)) {
      const afterApproval = (c: string) => POST_APPROVAL_CONTEXT.test(c) || REVIEWED_REF.test(c);
      const denials = denialClauses(masked);
      const denied = denials.flatMap((d) => changesReferenced(d, changes));
      if (denied.length || denials.some(afterApproval)) {
        push(
          s,
          `Says nothing changed, but the ledger records changes after approval: ${recorded(denied.length ? [...new Set(denied)] : changes)}. A false statement in App Store Connect is among the behaviors termination notices list (as Shoemaker reports them); DPLA 3.2(f) bars misleading or dishonest acts.`,
          "Remove the denial and describe each recorded change factually: date, what changed, and whether it was disclosed or reviewed.",
        );
        continue;
      }
      const claim = disclosureClaim(masked);
      if (claim) {
        const undisclosed = changes.filter((c) => !disclosingMessage(state, c));
        if (undisclosed.length) {
          push(
            s,
            `Claims every change was disclosed ("${claim}"), but the ledger has no Notes for Review or reply, sent after the change and confirmed by the developer as pasted, that names: ${recorded(undisclosed)}. A false claim of disclosure is a misleading statement in App Store Connect (DPLA 3.2(f)).`,
            "Remove the claim. Describe each recorded change factually and say which ones were not disclosed. If a disclosure was sent, record it (shield_ledger_record message_sent) and have the developer confirm in a terminal that they pasted it.",
          );
          continue;
        }
      }
      if (MINIMIZED.test(masked)) {
        const material = changes.filter((c) => c.contentOrPrice);
        const named = changesReferenced(masked, material);
        const shrunk = named.length ? named : afterApproval(masked) ? material : [];
        if (shrunk.length) {
          push(
            s,
            `Describes the change as only bug fixes, but the ledger records a change to content or price after approval: ${recorded(shrunk)}. Understating a recorded change is a misleading statement in App Store Connect (DPLA 3.2(f)); Guideline 2.5.2 limits downloaded code to bug fixes, so the understatement is the claim that matters.`,
            "Remove the characterization and describe each recorded change factually from its record: date, channel, what the record says it changed, and whether it went through App Review.",
          );
          continue;
        }
      }
    }
    if (AWARENESS_DENIAL.test(masked)) {
      if (!notAware) {
        push(
          s,
          "Denies awareness on the developer's behalf. Only the developer can say this, and the ledger has no statement from them.",
          "Ask the developer. If it is true, they record it with `appstore-shield attest --statement \"I am not aware of …\"` in a terminal and the text uses their words. Otherwise remove the sentence and state only the recorded facts.",
        );
        continue;
      }
      if (changes.length || unresolved.length) {
        push(
          s,
          `The developer recorded that they are not aware of the conduct, and the ledger also records ${[changes.length ? `${changes.length} change(s) after approval` : "", unresolved.length ? `${unresolved.length} open rejection(s)` : ""].filter(Boolean).join(" and ")}.`,
          "Keep the developer's statement, and also state those recorded facts plainly so the letter does not read as a denial of them.",
          "warning",
        );
      }
    }
    if (unresolved.length && ALL_FIXED.test(masked)) {
      push(
        s,
        `Says every rejection was fixed, but ${unresolved.length} rejection(s) have no later approval and no fix verified at STATIC_CLEAN: ${unresolved.map((r) => `${r.id} (${r.at.slice(0, 10)}, ${r.guidelines.join(", ") || "no guideline"})`).join("; ")}.`,
        "Name the rejections that were fixed, with their evidence, and list the open ones as open.",
      );
      continue;
    }
    // An approval alone does not show the app changed: it may have been cleared on appeal as it was.
    if (noChange.length && ALL_FIXED.test(masked) && CHANGE_CLAIM.test(masked)) {
      const appealed = noChange.filter((r) => r.messages.some((m) => m.purpose === "appeal_review_board"));
      push(
        s,
        `Says every rejection was answered by changing the app, but the ledger records no change (no interpretation, spec or verification) for: ${noChange.map((r) => `${r.id} (${r.at.slice(0, 10)}, ${r.guidelines.join(", ") || "no guideline"})${r.messages.some((m) => m.purpose === "appeal_review_board") ? ", approved after an App Review Board appeal" : ", approved later"}`).join("; ")}.`,
        appealed.length
          ? "Describe each rejection from the facts: say which ones the app was changed for, and that the appealed ones were approved after the appeal, without a change."
          : "Describe each rejection from the facts: say which ones the app was changed for. If the developer did change the app for the others, record it (shield_ledger_record interpretation) first; otherwise say only that they were later approved.",
        appealed.length ? "error" : "warning",
      );
    }
  }
  issues.push(...historyUnderstated(sents, state, nowMs, flagged, mask));
  return issues;
}

const ADMIT_ACT = /\b(?:admit\w*|confess\w*|acknowledg\w*|apologi[sz]\w*|sorry|(?:we|i)\s+regret|(?:our|my)\s+(?:mistake|error|fault)|(?:we|i)\s+(?:were|was)\s+wrong|(?:take|takes|took|taking)\s+(?:full\s+|complete\s+)?responsibility)\b/i;

/**
 * An admission resting on a change only an agent recorded. The evidence pack marks such a fact
 * "confirm it with the developer before stating it"; admitting it in an appeal confesses
 * post-review modification (DPLA 3.2(e)) the developer never confirmed.
 */
function agentFactAdmissions(sents: Sentence[], state: LedgerState): LintIssue[] {
  const changes = materialPostApprovalChanges(state);
  if (!changes.length) return [];
  const human = humanAttestations(state);
  const byAgent = (c: (typeof changes)[number]) => state.events.find((e) => e.id === c.eventId)?.source === "agent";
  const issues: LintIssue[] = [];
  for (const s of sents) {
    if (/\?\s*$/.test(s.text)) continue;
    const masked = maskQuotes(s.text);
    if (!ADMIT_ACT.test(masked)) continue;
    const named = changesReferenced(masked, changes);
    if (!named.length || !named.every(byAgent)) continue;
    if (named.some((c) => human.some((a) => a.statement.includes(c.eventId))) || attestationMatching(state, s.text)) continue;
    issues.push({
      rule: "unconfirmed_admission",
      severity: "error",
      excerpt: clip(s.text),
      message: `Admits a change that only an agent recorded: ${named.map((c) => `${c.detail} (${c.eventId}, ${c.at.slice(0, 10)})`).join("; ")}. The developer has not confirmed it, and an admission of post-review modification is the confession Shoemaker warns against (DPLA 3.2(e), 3.2(f)).`,
      fix: `Ask the developer whether it is accurate. If it is, they confirm it in a terminal with \`appstore-shield attest --statement "…"\` naming ${named.map((c) => c.eventId).join(", ")}, and the text states the specific act from that statement. If it is not, correct the ledger record.`,
    });
  }
  return issues;
}

function wordsAfterRemoving(sentence: string, rx: RegExp): number {
  return sentence
    .replace(new RegExp(rx.source, "gi"), " ")
    .split(/[^A-Za-z0-9%]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w.toLowerCase())).length;
}

function mentionsAny(text: string, terms: string[]): boolean {
  const lower = text.toLowerCase();
  return terms.some((t) => t && lower.includes(t.toLowerCase()));
}

/** Names a developer would actually write for each AI service label the scanners use. */
const AI_ALIASES: { rx: RegExp; aliases: string[] }[] = [
  { rx: /gemini|vertex|firebase ai/i, aliases: ["gemini", "vertex", "firebase ai"] },
  { rx: /openai/i, aliases: ["openai", "chatgpt", "gpt-", "dall-e", "gpt-image"] },
  { rx: /anthropic/i, aliases: ["anthropic", "claude"] },
  { rx: /replicate/i, aliases: ["replicate"] },
  { rx: /\bfal\b/i, aliases: ["fal.ai", "fal"] },
  { rx: /stability/i, aliases: ["stability", "stable diffusion"] },
  { rx: /together/i, aliases: ["together ai", "together.ai"] },
  { rx: /openrouter/i, aliases: ["openrouter"] },
  { rx: /groq/i, aliases: ["groq"] },
  { rx: /\bxai\b|x\.ai/i, aliases: ["xai", "x.ai", "grok"] },
  { rx: /black forest/i, aliases: ["black forest labs", "bfl", "flux"] },
  { rx: /hugging ?face/i, aliases: ["hugging face", "huggingface"] },
];

function aiServiceNamed(text: string, label: string): boolean {
  const lower = ` ${text.toLowerCase()} `;
  const parts = label.split(/\s*\/\s*|\s*\(incl\.\s*|\)/).map((x) => x.trim()).filter((x) => x.length >= 3);
  const aliases = [label, ...parts, ...AI_ALIASES.filter((a) => a.rx.test(label)).flatMap((a) => a.aliases)];
  return aliases.some((a) => {
    const needle = a.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${needle}`).test(lower);
  });
}

const REMOTE_PHRASES = ["remote config", "remote-config", "remote configuration", "remotely configured", "feature flag", "server-side flag", "server-side switch", "server-side setting", "remote flag", "remote switch", "remote setting", "remote toggle"];
const OTA_PHRASES = ["over-the-air", "over the air", " ota ", "ota update", "expo-updates", "expo updates", "eas update", "codepush", "code push", "shorebird", "hot update", "javascript bundle update", "js bundle update"];

/** A sentence that denies using remote config / OTA ("Remote config: none", "We do not use feature flags"). */
const REMOTE_WORDS = String.raw`(?:remote[- ]config(?:uration)?|remotely configured|feature[- ]flags?|server[- ]side (?:flags?|switch(?:es)?|settings?)|remote (?:flags?|switch(?:es)?|settings?|toggles?))`;
const OTA_WORDS = String.raw`(?:over[- ]the[- ]air(?: updates?)?|ota(?: updates?)?|expo[- ]updates|eas update|code ?push|shorebird|hot updates?|js bundle updates?|javascript bundle updates?)`;
const denialRx = (words: string) =>
  new RegExp(
    [
      String.raw`\b${words}\s*(?:[:=\-–—]|is|are)\s*(?:none|no|n\/?a|not used|unused|never|disabled)\b`,
      String.raw`\b${words}[^.:\n]{1,60}:\s*(?:none|no|n\/?a|not used|never)\b`,
      String.raw`\b(?:no|without|never use|zero)\s+(?:any\s+)?${words}`,
      String.raw`\b(?:does|do|did|will)\s*(?:not|n't)\s+(?:use|have|include|ship|contain|rely on)\s+(?:any\s+)?${words}`,
      String.raw`\b${words}\s+(?:is|are)\s+not\s+(?:used|enabled|present|included)`,
    ].join("|"),
    "i",
  );
// Plain-English denials name no mechanism: "Nothing in the app is controlled remotely".
const REMOTELY = String.raw`(?:remotely|from\s+(?:a|the|our)\s+(?:server|backend|dashboard|console)|server[- ]side|over\s+the\s+network)`;
const REMOTE_PLAIN = [
  String.raw`\b(?:nothing|no\s+(?:\w+\s+){0,2}?(?:features?|content|settings?|behaviou?rs?|parts?|options?|screens?))\b[^.!?\n]{0,40}?\b(?:is|are|was|were|can\s+be|gets?)\s+(?:ever\s+)?(?:controlled|changed|configured|toggled|switched|turned\s+on|enabled|managed|altered|unlocked)\s+${REMOTELY}`,
  String.raw`\b(?:is|are|was|were|can(?:not|['’]t)\s+be|cannot\s+be)\s+(?:not\s+|never\s+)(?:be\s+)?(?:controlled|changed|configured|toggled|switched|enabled|managed|altered|unlocked)\s+${REMOTELY}`,
  String.raw`\b(?:no|never|nothing)\s+(?:\w+\s+){0,2}?server[- ](?:controlled|driven)\b|\bnot\s+server[- ](?:controlled|driven)\b`,
  String.raw`\b(?:does|do|did|will)\s*(?:not|n['’]t)\s+(?:\w+\s+){0,2}?(?:change|control|configure|toggle|unlock)\s+(?:\w+\s+){0,4}?${REMOTELY}`,
].join("|");
const REMOTE_DENIAL = new RegExp(`${denialRx(REMOTE_WORDS).source}|${REMOTE_PLAIN}`, "i");
const OTA_DENIAL = denialRx(OTA_WORDS);

/**
 * A denial that user content reaches an outside service. Against an inventory of AI services the
 * app sends user content to, a denial of transmission is false; "processed on device" alone may be
 * true of one feature while another calls a cloud model, so it is a warning.
 */
const AI_TRANSMIT_DENIAL =
  /\b(?:not|never)\s+(?:be\s+|being\s+|ever\s+)?(?:sent|shared|uploaded|transmitted|passed|forwarded|disclosed)\s+(?:to\s+)?(?:any\s+)?(?:third[- ]part(?:y|ies)|outside\s+(?:services?|parties|the\s+device)|external\s+(?:services?|servers?|parties)|(?:our\s+|any\s+)?servers?|the\s+cloud|cloud)|\bno\s+(?:user\s+|personal\s+)?(?:data|content|photos?|images?|selfies?|messages?|information)\s+(?:ever\s+)?(?:leaves?|is\s+sent|is\s+shared)\b|\bnever\s+leaves?\s+(?:the|your|their|a\s+user['’]s)\s+(?:device|phone|iphone)\b|\b(?:does|do)\s*(?:not|n['’]t)\s+(?:send|share|upload|transmit)\s+(?:\w+\s+){0,3}?(?:to\s+)?(?:any\s+)?(?:third[- ]part(?:y|ies)|servers?|the\s+cloud|external)/i;
const AI_LOCAL_CLAIM = /\b(?:processed|stays?|remains?|handled|generated|runs?|analy[sz]ed)\s+(?:entirely\s+|only\s+|locally\s+|fully\s+|completely\s+)?on[- ](?:the\s+)?device\b|\bon[- ]device\s+only\b/i;

/** Remote flag keys the scan or the ledger knows: the inventory, the latest flags snapshot, and every saved spec. */
function remoteKeys(input: LintInput): string[] {
  const keys = new Set<string>();
  for (const c of input.inventory?.remoteControls ?? []) keys.add(c.key);
  const snap = input.state?.configSnapshots.filter((c) => c.kind === "flags_inventory").at(-1);
  for (const f of (snap?.data as { flags?: { key?: unknown }[] } | undefined)?.flags ?? []) if (typeof f.key === "string") keys.add(f.key);
  for (const r of input.state?.rejections ?? []) for (const f of r.spec?.flags ?? []) keys.add(f);
  return [...keys].filter((k) => k.length >= 3);
}

function remoteToggleFix(s: Sentence, masked: string, purpose: EvidencePurpose, keys: string[]): LintIssue | undefined {
  if (/\?\s*$/.test(s.text) || !DISABLE_VERB.test(masked)) return undefined;
  const key = keys.find((k) => namesAny(masked, [k]));
  if (!key && !REMOTE_CHANNEL.test(masked) && !SERVER_SIDE.test(masked)) return undefined;
  const claimsFix = FIX_FRAMING.test(masked);
  // A neutral disclosure ("spicy_mode is in Remote Config and is disabled") is what 2.5.19 asks for.
  if (!claimsFix && !FIRST_PERSON_ACTION.test(masked)) return undefined;
  const appeal = purpose === "appeal_review_board" || purpose === "appeal_termination";
  const removedToo = BUILD_REMOVAL.test(masked) || BUILD_REMOVAL.test(s.paragraph);
  // In an appeal, an account of what was done in the past is candor; only a claim that the switch resolved it is an error.
  const severity: LintSeverity = removedToo || (appeal && !claimsFix) ? "warning" : "error";
  return {
    rule: "remote_toggle_fix",
    severity,
    excerpt: clip(s.text),
    message: `Presents a ${key ? `switch on "${key}"` : "server-side or remote-config switch"} as the fix. App Review cannot see a server switch and it can be turned back on after approval, so the capability is still in the build (Guideline 2.5.19, DPLA 3.2(e)).${removedToo ? " The text also says something was removed from the build; make sure that removal, not the switch, is what it presents as the fix." : ""}`,
    fix: "Delete the gated code, its assets and the remote key from the app, then describe that removal and how it was verified. Keep any mention of the switch factual (its name, what it controlled, that it was removed), never as the reason the issue is resolved.",
  };
}

export function lintText(input: LintInput): LintResult {
  const { purpose, text } = input;
  const issues: LintIssue[] = [];
  const bytes = utf8Bytes(text);
  const byteLimit = purpose === "review_notes" ? REVIEW_NOTES_BYTE_LIMIT : null;
  const appeal = purpose === "appeal_review_board" || purpose === "appeal_termination";
  const sents = sentences(text);

  if (byteLimit !== null && bytes > byteLimit) {
    issues.push({
      rule: "byte_limit",
      severity: "error",
      excerpt: `${bytes} bytes`,
      message: `Notes for Review are limited to ${byteLimit} bytes (UTF-8 bytes, not characters); this text is ${bytes} bytes. Curly quotes, dashes and emoji take 2–4 bytes each.`,
      fix: `Cut ${bytes - byteLimit} bytes: drop repetition and generic sentences first, keep the specific facts and test steps.`,
    });
  }

  const backed = (isBacked(input.strongestTier) && probeConfirmedIn(input.state, input.strongestTier)) || (!input.strongestTier && backedByState(input.state));
  const mistakes = input.state ? confirmedMistakeStatements(input.state) : [];
  const attested = input.state ? humanAttestations(input.state).map((a) => a.statement) : [];
  const flagKeys = remoteKeys(input);
  // Once the capability is verified gone, a rename or move mentioned beside it is detail, not the fix.
  const openBinary = input.state?.rejections.filter((r) => r.outcome === "rejected" && !r.approvedBy) ?? [];
  const cosmeticCleared =
    tierRank(input.strongestTier?.tier) >= tierRank("STATIC_CLEAN") ||
    (Boolean(input.state) && openBinary.length > 0 && unresolvedRejections(input.state!).length === 0);
  const openUnverified = Boolean(input.state && unresolvedRejections(input.state).length);
  const rejectedTerms = openRejectionTerms(input.state);
  // An age gate answers an age-rating rejection; for content App Review rejected under 1.1 it is a gate in front of the same content.
  const openNow = input.state ? unresolvedRejections(input.state) : [];
  const ageGateFits = !openNow.length || openNow.some((r) => r.guidelines.some((g) => /^(?:1\.2\.1|2\.3\.8)/.test(g)) || /\bage\s+rating\b/i.test(r.reviewerMessage ?? ""));
  for (const s of sents) {
    const masked = maskQuotes(s.text);
    const toggle = remoteToggleFix(s, masked, purpose, flagKeys);
    if (toggle) issues.push(toggle);
    const reviewSpecific = reviewSpecificBehavior(s, masked);
    if (reviewSpecific) issues.push(reviewSpecific);
    // Clarification questions ask what App Review meant; every other purpose can present a rename as the fix.
    if (purpose !== "clarification") {
      const cosmetic = cosmeticFix(s, masked, cosmeticCleared, openUnverified, rejectedTerms, ageGateFits);
      if (cosmetic) issues.push(cosmetic);
    }
    const compliance = /\?\s*$/.test(s.text) ? null : COMPLIANCE_RX.exec(masked);
    if (compliance && !COMPLIANCE_NEGATED.test(masked.slice(0, compliance.index))) {
      issues.push({
        rule: "compliance_assertion",
        severity: "error",
        excerpt: clip(s.text),
        message: `Asserts compliance or an outcome ("${compliance[0].trim()}"). Only App Review decides whether an app complies; evidence on file, even a probe run, supports what was tested, not a verdict. A verdict the ledger does not support reads as an overclaim.`,
        fix: "Describe what was changed and how it was verified (e.g. \"We removed the outfit picker; a source sweep found no remaining references\"); only App Review decides compliance.",
      });
    }
    const deferred = deferredReturn(s, masked, rejectedTerms);
    if (deferred) issues.push(deferred);
    const abs = backed ? null : ABSOLUTE_RX.exec(maskDisclosureAnswers(masked));
    if (abs) {
      issues.push({
        rule: "absolute_claim",
        severity: "error",
        excerpt: clip(s.text),
        message: `Absolute claim "${abs[0].trim()}". A reviewer only needs one counterexample to treat it as misleading, and the evidence on file does not reach probe-tested 100% plus a clean built-product sweep.`,
        fix: "State what was done and how it was checked (e.g. \"We removed the outfit picker and the free-text path; a source sweep found no remaining references\"), not that something can never happen.",
      });
    }

    // Rewording a server toggle as "The developer states …" still presents it as the fix; that rule's advice comes first.
    if (toggle?.severity !== "error" && ATTESTATION_SUBJECT.test(masked) && !/\?\s*$/.test(s.text) && !ATTESTATION_PREFIX.test(s.text) && !ATTESTATION_PREFIX.test(s.paragraph)) {
      issues.push({
        rule: "unattributed_attestation",
        severity: "error",
        excerpt: clip(s.text),
        message: "Statement about servers or backends that App Review cannot inspect, written as fact.",
        fix: "Write it as an attestation: \"The developer states that …\", and only if the developer confirms it is true.",
      });
    }

    if (purpose === "review_notes" && REMOTE_CHANNEL.test(masked) && FORWARD_ASSURANCE.test(masked) && !ATTESTATION_PREFIX.test(s.text)) {
      issues.push({
        rule: "unattributed_attestation",
        severity: "error",
        excerpt: clip(s.text),
        message: "Promise about what a remote switch or over-the-air update will be used for, written as fact. App Review cannot check future use in the build.",
        fix: "Disclose the mechanism factually. Describe its scope only as \"The developer states that …\", and only after the developer records that statement with `appstore-shield attest`.",
      });
    }

    // The prefix alone proves nothing: the statement must match one the developer recorded in a terminal.
    const worded = ATTESTATION_PREFIX.test(s.text) || (ATTESTATION_SUBJECT.test(masked) && ATTESTATION_PREFIX.test(s.paragraph));
    if (worded && input.state && !/\?\s*$/.test(s.text) && !attestationMatching(input.state, s.text)) {
      issues.push({
        rule: "unbacked_attestation",
        severity: "error",
        excerpt: clip(s.text),
        message: "Worded as the developer's statement, but the ledger has no matching attestation recorded by the developer.",
        fix: "Ask the developer to confirm it themselves with `appstore-shield attest --statement \"…\"` in a terminal, then use their wording. Otherwise remove the sentence.",
      });
    }

    const cmp = COMPARISON_RX.exec(masked);
    if (cmp) {
      issues.push({
        rule: "comparison",
        severity: "warning",
        excerpt: clip(s.text),
        message: `Comparison with other apps ("${cmp[0]}"). App Review judges each app on its own; pointing at other apps reads as arguing the decision (Guideline 5.6).`,
        fix: "Remove the comparison and describe what this app does and the safeguards it has.",
      });
    }
    const press = PRESSURE_RX.exec(masked);
    if (press) {
      issues.push({
        rule: "pressure",
        severity: "warning",
        excerpt: clip(s.text),
        message: `Pressure on the reviewer ("${press[0]}"). Urgency does not change the review and can read as bad faith.`,
        fix: "Remove it. If the timing matters, use Apple's expedited review request form instead.",
      });
    }

    for (const t of TONE_RULES) {
      const m = t.rx.exec(masked);
      if (!m) continue;
      issues.push({
        rule: "combative_tone",
        severity: t.severity,
        excerpt: clip(s.text),
        message: `Combative or legalistic wording ("${m[0]}"). Arguments with App Review can read as bad faith (Guideline 5.6).`,
        fix: "Remove the wording; state the facts calmly and ask a specific question instead. Keep legal advice between the developer and counsel.",
      });
      break;
    }

    if (purpose === "review_notes") {
      GENERIC_CHANGE_RX.lastIndex = 0;
      const g = GENERIC_CHANGE_RX.exec(s.text);
      if (g && wordsAfterRemoving(s.text, GENERIC_CHANGE_RX) < 4) {
        issues.push({
          rule: "generic_change",
          severity: "error",
          excerpt: clip(s.text),
          message: `Generic change description ("${g[0]}"). Guideline 2.3.1(a) requires new features and changes to be described with specificity in Notes for Review.`,
          fix: "Name each change: the screen or feature, what a user can now do or no longer do, and how the reviewer can see it.",
        });
      }
    }

    if (appeal) {
      const spec = SPECULATIVE_RX.exec(masked);
      if (spec) {
        issues.push({
          rule: "speculative_admission",
          severity: "error",
          excerpt: clip(s.text),
          message: `Speculative admission ("${spec[0]}"). It concedes conduct nobody has identified and can be read as a confession.`,
          fix: "Remove it. Apologize only for specific mistakes the developer confirms, and politely ask Apple to identify the conduct the notice refers to.",
        });
      }
    }
    const intent = /\?\s*$/.test(s.text) ? null : INTENT_RX.exec(masked);
    // A denial of awareness is judged against the ledger in ledgerContradictions.
    const awareness = Boolean(input.state) && AWARENESS_DENIAL.test(masked);
    if (intent && !awareness && !DEMO_FACT.test(masked) && !(input.state && attestationMatching(input.state, s.text))) {
      issues.push({
        rule: "intent_characterization",
        severity: "error",
        excerpt: clip(s.text),
        message: `Explains intent or good faith ("${intent[0]}") that the developer has not confirmed. Only the developer can say why code existed or how it happened; written by anyone else it is a denial on their behalf, and a false one is a misleading statement in App Store Connect (DPLA 3.2(f)).`,
        fix: "Ask the developer. If it is true, they record it with `appstore-shield attest --statement \"…\"` in a terminal and the text uses their words. Otherwise keep only the facts: what the code did, when, and that it was removed (from the diff), without explaining why it was there.",
      });
    }

    // Review notes and replies are part of the account's record too; an admission there counts as much as in an appeal.
    // There it is a warning: an error would push the drafter to drop a true, diff-backed account of
    // what was removed. In an appeal it is an error: a letter to the Board or a reinstatement request
    // that confesses conduct the developer never confirmed is the confession Shoemaker warns against.
    const admissionSeverity: LintSeverity = appeal ? "error" : "warning";
    const admitted = new Set<string>();
    for (const cat of ADMISSION_CATEGORIES) {
      if (!cat.rx.test(masked)) continue;
      admitted.add(cat.category);
      if ((cat.mechanism ? attested : mistakes).some((c) => cat.stems.test(c))) continue;
      issues.push({
        rule: "unconfirmed_admission",
        severity: admissionSeverity,
        excerpt: clip(s.text),
        message: `Describes ${cat.category} (Guideline 2.5.19, DPLA 3.2(f)), which the developer has not confirmed in a terminal.`,
        fix: cat.mechanism
          ? "Ask the developer to confirm it matches the diff (`appstore-shield attest --statement \"…\"`). If it does, keep it factual, e.g. \"Earlier builds contained a condition (X) that changed Y during review; it has been removed.\" If it is not accurate, correct it."
          : "Ask the developer whether it is true. If it is, they confirm it in a terminal (`appstore-shield attest --statement \"…\"`) and the text keeps it, stating the specific act: exactly what was done, in which build, and that it was removed. If it is not true, correct it.",
      });
    }
    const conduct = conductAdmission(masked);
    if (conduct && !admitted.has(conduct.category) && !mistakes.some((c) => conduct.stems.test(c))) {
      issues.push({
        rule: "unconfirmed_admission",
        severity: admissionSeverity,
        excerpt: clip(s.text),
        message: `Admits ${conduct.category} ("${conduct.phrase}"; Guideline 2.5.19, DPLA 3.2(f)), which the developer has not confirmed in a terminal.${conduct.label ? " It labels the conduct without saying what was done, so it reads as accepting whatever Apple alleges." : ""}`,
        fix: "Ask the developer whether it is true. If it is, they confirm it in a terminal (`appstore-shield attest --statement \"…\"`) and the text states the specific act: what was done, in which build, and that it was removed. If it is not true, correct it.",
      });
    }
  }

  const credentialHits = CREDENTIAL_PATTERNS.flatMap(({ rx, what }) => {
    const m = rx.exec(text);
    if (!m || PASSWORD_PLACEHOLDER.test(m[1] ?? "")) return [];
    const start = text.lastIndexOf("\n", m.index) + 1;
    const nl = text.indexOf("\n", m.index + m[0].length);
    const line = text.slice(start, nl === -1 ? text.length : nl);
    return CREDENTIAL_CONTEXT.test(line) ? [{ m, what }] : [];
  });
  const secretHits = [
    ...SECRET_PATTERNS.flatMap(({ rx, what }) => {
      const m = rx.exec(text);
      return m ? [{ m, what }] : [];
    }),
    ...credentialHits,
  ];
  let reportedPassword = false;
  for (const { m, what } of secretHits) {
    if ((what === "password" || what === "login and password") && PASSWORD_PLACEHOLDER.test(m[1] ?? "")) continue;
    if (what === "password" || what === "login and password") {
      if (reportedPassword) continue;
      reportedPassword = true;
    }
    issues.push({
      rule: "secret",
      severity: "error",
      excerpt: `${m[0].slice(0, Math.min(10, Math.floor(m[0].length / 2)))}…[redacted]`,
      message: `Looks like a ${what}. Anything pasted into App Store Connect text fields is stored in Apple's records of the account.`,
      fix: "Remove it. Demo credentials go in the App Review Information sign-in fields, entered by the developer; keep a placeholder in drafts. Rotate the secret if it was already shared.",
    });
  }

  // A denial of what the scan found is false in a reply or an appeal as much as in the notes;
  // App Review often asks exactly this in the Resolution Center.
  if (input.inventory) {
    const inv = input.inventory;
    // A denial is the opposite of a disclosure; it must not count as one.
    const remoteDenials = sents.filter((x) => REMOTE_DENIAL.test(x.text));
    const otaDenials = sents.filter((x) => OTA_DENIAL.test(x.text));
    const disclosed = sents.filter((x) => !remoteDenials.includes(x) && !otaDenials.includes(x)).map((x) => x.text).join("\n");
    const controls = inv.remoteControls ?? [];
    const isSensitive = (c: (typeof controls)[number]) => c.classification === "content-gating" || c.classification === "price-gating";
    const said = purpose === "review_notes" ? "The notes say" : "The text says";
    for (const d of remoteDenials) {
      // "Remote flags that change content or price: none" denies only the sensitive ones
      const contradicted = /content|price|pricing|paywall|feature/i.test(d.text) ? controls.filter(isSensitive) : controls;
      if (!contradicted.length) continue;
      issues.push({
        rule: "false_disclosure",
        severity: "error",
        excerpt: clip(d.text),
        message: `${said} there is no remote config or feature flag, but the scan found: ${contradicted.slice(0, 6).map((c) => `${c.key} (${c.provider}, ${c.classification})`).join(", ")}${contradicted.length > 6 ? ", …" : ""}. A false statement to App Review is grounds for removal (2.5.19, 3.2(f)).`,
        fix: "Replace the denial with a disclosure of each flag: its name, what it controls and its current value — or remove the flags from the app first.",
      });
      break;
    }
    if (otaDenials.length && inv.ota?.length) {
      issues.push({
        rule: "false_disclosure",
        severity: "error",
        excerpt: clip(otaDenials[0]!.text),
        message: `${said} there are no over-the-air updates, but the scan found ${inv.ota.map((o) => o.provider).join(", ")} (2.5.2, 2.5.19).`,
        fix: "Replace the denial with a disclosure of the OTA mechanism — or remove it from the app first.",
      });
    }
    const ai = inv.aiServices ?? [];
    if (ai.length) {
      for (const x of sents) {
        // A sentence that names the provider is a disclosure ("face detection runs on device; the selfie is sent to OpenAI").
        if (/\?\s*$/.test(x.text) || ai.some((p) => aiServiceNamed(x.text, p))) continue;
        const masked = maskQuotes(x.text);
        const transmit = AI_TRANSMIT_DENIAL.exec(masked);
        const local = transmit ? null : AI_LOCAL_CLAIM.exec(masked);
        if (!transmit && !local) continue;
        const sinks = (inv.aiSinks ?? []).slice(0, 6).map((k) => `${k.provider} at ${k.file}${k.line ? `:${k.line}` : ""}`);
        issues.push({
          rule: "false_disclosure",
          severity: transmit ? "error" : "warning",
          excerpt: clip(x.text),
          message: `${said} user content ${transmit ? "is not sent off the device" : "is processed on device"} ("${(transmit ?? local)![0].trim()}"), but the scan found the app sends user content to ${ai.join(", ")}${sinks.length ? ` (${sinks.join("; ")})` : ""}. ${transmit ? "A false statement to App Review is grounds for removal (Guideline 5.1.2(i), DPLA 3.2(f))." : "If this feature's data does reach one of those services, the statement is false (Guideline 5.1.2(i))."}`,
          fix: "Replace the denial with a disclosure: name each AI service, what user data it receives, and the safeguards on its output. If a feature truly stays on device, name that feature and say which data goes to which service.",
        });
      }
    }
    const sensitive = purpose === "review_notes" ? controls.filter(isSensitive) : [];
    if (sensitive.length) {
      const keys = sensitive.map((c) => c.key);
      const providers = [...new Set(sensitive.map((c) => c.provider))];
      const generic = mentionsAny(disclosed, [...REMOTE_PHRASES, ...providers]);
      const missingKeys = keys.filter((k) => !mentionsAny(disclosed, [k]));
      // A switch a block finding says to delete is fixed only by deleting it; telling the drafter to disclose it would contradict the gate.
      const findings = input.findings;
      const mustDelete = sensitive.filter((c) => missingKeys.includes(c.key) && findings && switchMustBeDeleted(c, findings)).map((c) => c.key);
      const unknownGating = findings ? [] : sensitive.filter((c) => missingKeys.includes(c.key) && c.classification === "content-gating").map((c) => c.key);
      const fixFor = (base: string) =>
        mustDelete.length
          ? `Delete ${mustDelete.join(", ")} and the content ${mustDelete.length > 1 ? "they gate" : "it gates"} (block finding remote_config.content_gating); disclosure does not fix it.${mustDelete.length < missingKeys.length ? ` For the others: ${base}` : ""}`
          : unknownGating.length
            ? `${base} If a block finding (remote_config.content_gating) names ${unknownGating.join(", ")}, delete it and the content it gates instead: disclosure does not fix a block finding.`
            : base;
      if (!generic && missingKeys.length === keys.length) {
        issues.push({
          rule: "disclosure_missing",
          severity: "error",
          excerpt: keys.slice(0, 5).join(", "),
          message: `The app reads remote flags that gate content or price (${keys.slice(0, 5).join(", ")}${keys.length > 5 ? ", …" : ""}) and the notes do not mention them (Guideline 2.5.19, DPLA 3.2(e)).`,
          fix: fixFor("Disclose each flag: its name, what it controls, and its current value — or remove the flag."),
        });
      } else if (missingKeys.length) {
        issues.push({
          rule: "disclosure_missing",
          severity: "error",
          excerpt: missingKeys.slice(0, 5).join(", "),
          message: `The notes describe remote configuration in general but do not name these flags that gate content or price: ${missingKeys.join(", ")} (2.3.1(a) asks for specificity; 2.5.19).`,
          fix: fixFor("Name each flag, what it controls and its current value — or remove the flag."),
        });
      }
    }
    if (purpose === "review_notes" && inv.ota?.length && !mentionsAny(` ${disclosed.toLowerCase()} `, [...OTA_PHRASES, ...inv.ota.map((o) => o.provider)])) {
      issues.push({
        rule: "disclosure_missing",
        severity: "error",
        excerpt: inv.ota.map((o) => o.provider).join(", "),
        message: "The app can receive over-the-air updates and the notes do not mention it (Guidelines 2.5.2, 2.5.19).",
        fix: "Disclose the OTA mechanism and that updates will not change features or content outside review — and only say so if the developer confirms it.",
      });
    }
    const missingAi = purpose === "review_notes" ? (inv.aiServices ?? []).filter((s) => !aiServiceNamed(text, s)) : [];
    if (missingAi.length) {
      issues.push({
        rule: "disclosure_missing",
        severity: "warning",
        excerpt: missingAi.join(", "),
        message: `AI services that receive user content are not named in the notes: ${missingAi.join(", ")} (Guideline 5.1.2(i); App Review asks you to describe AI services).`,
        fix: "Name each AI service, what user data it receives, and the safeguards applied to its output.",
      });
    }
  }

  if (input.state) {
    issues.push(...ledgerContradictions(sents, input.state, input.now ? Date.parse(input.now) : Date.now()));
    if (appeal) {
      for (const i of agentFactAdmissions(sents, input.state)) {
        const dup = issues.findIndex((x) => x.rule === "unconfirmed_admission" && x.excerpt === i.excerpt);
        if (dup === -1) issues.push(i);
        else issues[dup] = i;
      }
    }
    issues.push(...unrecordedAppleQuotes(text, input.state, appeal));
    // A denial of OTA or remote flags the ledger has recorded is false whatever the inventory says.
    // An OTA config snapshot counts too, unless a current scan was passed: it may show OTA was removed since.
    const otaSnap = input.inventory ? undefined : input.state.configSnapshots.filter((c) => c.kind === "ota").at(-1);
    const otaUsed = input.state.otaPublishes.length > 0 || Boolean(otaSnap);
    const flagsSnap = input.state.configSnapshots.filter((c) => c.kind === "flags_inventory").at(-1);
    const gating = ((flagsSnap?.data as { flags?: { key: string; classification: string }[] } | undefined)?.flags ?? []).filter(
      (f) => f.classification === "content-gating" || f.classification === "price-gating",
    );
    const already = new Set(issues.filter((i) => i.rule === "false_disclosure").map((i) => i.excerpt));
    for (const x of sents) {
      if (already.has(clip(x.text))) continue;
      if (otaUsed && OTA_DENIAL.test(x.text)) {
        issues.push({
          rule: "false_disclosure",
          severity: "error",
          excerpt: clip(x.text),
          message: input.state.otaPublishes.length
            ? `Denies over-the-air updates, but the ledger records ${input.state.otaPublishes.length} OTA publish(es), the latest on ${input.state.otaPublishes.at(-1)?.at.slice(0, 10)} (2.5.2, 2.5.19).`
            : `Denies over-the-air updates, but the ledger's latest OTA configuration snapshot (${otaSnap?.id}, ${otaSnap?.at.slice(0, 10)}) records an OTA update mechanism: ${otaSnap?.summary} (2.5.2, 2.5.19).`,
          fix: "Replace the denial with a disclosure of the OTA mechanism and what the recorded updates changed.",
        });
      } else if (gating.length && REMOTE_DENIAL.test(x.text)) {
        issues.push({
          rule: "false_disclosure",
          severity: "error",
          excerpt: clip(x.text),
          message: `Denies remote flags, but the ledger's latest flags snapshot (${flagsSnap?.id}) records flags that gate content or price: ${gating.slice(0, 6).map((f) => f.key).join(", ")} (2.5.19, DPLA 3.2(e)).`,
          fix: "Replace the denial with a disclosure of each flag: its name, what it controls and its current value.",
        });
      }
    }
  }

  if (purpose === "review_notes") {
    const removed = [...(input.state ? removedReviewConditions(input.state).map((x) => x.condition) : []), ...(input.removedConditions ?? [])];
    // A denial or "nothing changed" sentence does not disclose a removal.
    const said = sents.filter((x) => !denialClauses(x.text).length).map((x) => x.text).join("\n");
    const seen = new Set<string>();
    for (const c of removed) {
      const key = `${c.file}:${c.line ?? ""}:${c.condition}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (conditionMentioned(said, c)) continue;
      issues.push({
        rule: "removed_condition_unmentioned",
        severity: "warning",
        excerpt: `${c.condition} at ${c.file}${c.line ? `:${c.line}` : ""}`,
        message: `The fix removed a review-time condition (${c.condition}${c.gates ? `, which ${c.gates}` : ""}; ${c.rule}) and the notes do not mention it. Reviewers judge 2.5.19 on what the app did during review; a removal that is left out reads as concealment.`,
        fix: "Add one factual line: what the condition was, what it changed, and that it was removed in this build. Do not explain why it existed unless the developer has confirmed it.",
      });
    }
  }

  if (purpose === "review_notes" && input.state) {
    for (const r of input.state.rejections.filter((x) => !x.approvedBy && x.guidelines.length)) {
      if (r.guidelines.some((g) => text.includes(g))) continue;
      issues.push({
        rule: "prior_rejection_unmentioned",
        severity: "warning",
        excerpt: `${r.id} ${r.at.slice(0, 10)} Guideline ${r.guidelines.join(", ")}`,
        message: `The open rejection under Guideline ${r.guidelines.join(", ")} (${r.at.slice(0, 10)}) is not referenced. Reviewers see prior rejections.`,
        fix: "Add one line naming the prior rejection and what was changed at capability level to address it.",
      });
    }
  }

  return { ok: !issues.some((i) => i.severity === "error"), bytes, byteLimit, issues };
}

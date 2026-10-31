import type { Check } from "../checks.js";
import { finding, type Finding } from "../finding.js";
import type { ScanContext, SourceFile } from "../project.js";
import {
  ALERT_UI,
  INCENTIVE_LITERAL,
  MANAGED_PAYWALL,
  NEGATIVE_PATH,
  NON_SHIPPING_PATH,
  ONBOARDING_PATH,
  PAYWALL_PATH,
  PURCHASE_CALL,
  RATE_ASK_LITERAL,
  REWARD_CODE,
  SENTIMENT_LITERAL,
  SOCIAL_PROOF,
  SOCIAL_PROOF_JSON_KEY,
  STAR_PICKER,
  SYSTEM_REVIEW,
  WRITE_REVIEW_LINK,
  isCode,
  isUiText,
  lineIndex,
  literalsOf,
  ships,
} from "../rules/store.js";

function lineText(f: SourceFile, line: number): string {
  return f.text.split("\n")[line - 1]?.trim() ?? "";
}

function firstIn(f: SourceFile, rx: RegExp): { index: number; line: number } | undefined {
  const m = new RegExp(rx.source, rx.flags.replace("g", "")).exec(f.code);
  if (!m) return undefined;
  return { index: m.index, line: lineIndex(f.code)(m.index) };
}

export const check: Check = {
  id: "ratings_integrity",
  title: "Ratings and reviews integrity",
  guidelines: ["5.6.1", "5.6.3", "DPLA 3.2(f)"],
  async run(ctx: ScanContext) {
    const findings: Finding[] = [];
    const code = ctx.files.filter((f) => isCode(f) && !NON_SHIPPING_PATH.test(f.path));
    const reviewSites: { file: string; line: number; kind: "system" | "link" }[] = [];

    for (const f of code) {
      const system = firstIn(f, SYSTEM_REVIEW);
      const link = firstIn(f, WRITE_REVIEW_LINK);
      if (system) reviewSites.push({ file: f.path, line: system.line, kind: "system" });
      if (link) reviewSites.push({ file: f.path, line: link.line, kind: "link" });
      const ask = system ?? link;

      // Rewards for rating: user-facing copy.
      for (const lit of literalsOf(f)) {
        const m = INCENTIVE_LITERAL.exec(lit.value);
        if (!m || !ships(f, lit.index)) continue;
        findings.push(
          finding({
            rule: "ratings.incentivized_review",
            severity: "block",
            guideline: "5.6.3",
            file: f.path,
            line: lit.line,
            evidence: lit.value,
            why: `The app offers something in return for a rating or review ("${m[0]}"). Incentivized reviews manipulate ratings (5.6.3); the guidelines' introduction and DPLA §11.2 treat review manipulation as grounds for removal from the Developer Program.`,
            fix: "Remove the reward entirely: ratings must never unlock content, currency or features.",
            confidence: "high",
            suppressible: false,
          }),
        );
      }

      // Rewards for rating: code that grants something right after the review request.
      if (ask) {
        const rx = new RegExp(`${SYSTEM_REVIEW.source}|${WRITE_REVIEW_LINK.source}`, "g");
        for (const m of f.code.matchAll(rx)) {
          const index = m.index ?? 0;
          const after = f.code.slice(index, index + 300);
          const reward = REWARD_CODE.exec(after);
          if (!reward || !ships(f, index)) continue;
          const line = lineIndex(f.code)(index);
          findings.push(
            finding({
              rule: "ratings.incentivized_review",
              severity: "block",
              guideline: "5.6.3",
              file: f.path,
              line,
              evidence: `${lineText(f, line)} … ${reward[0]}`,
              why: "Code grants a reward (currency, credits or premium) right after asking for a rating or review. Incentivized reviews manipulate ratings (5.6.3) and are grounds for Program removal (DPLA §11.2).",
              fix: "Remove the reward from the review flow: nothing may be granted for rating or reviewing.",
              confidence: "medium",
            }),
          );
          break;
        }
      }

      // Sentiment pre-gate: only users who answer positively are sent to the review prompt.
      const sentiment = literalsOf(f).find(
        (l) => SENTIMENT_LITERAL.test(l.value) && (l.value.includes("?") || /^\s*(are you|do you|how)\b/i.test(l.value)) && ships(f, l.index),
      );
      if (sentiment && ask && literalsOf(f).some((l) => NEGATIVE_PATH.test(l.value))) {
        findings.push(
          finding({
            rule: "ratings.sentiment_gate",
            severity: "high",
            guideline: "5.6.3",
            file: f.path,
            line: sentiment.line,
            evidence: sentiment.value,
            why: "A sentiment question (\"Enjoying the app?\") decides who is asked for a review: happy users go to the review prompt, unhappy users to feedback. Filtering who may rate skews ratings, which 5.6.3 prohibits as review manipulation, and 5.6.1 requires the system prompt to be the only rating prompt.",
            fix: "Remove the pre-question: call the system review API (`requestReview`) at a natural moment for every user, and offer feedback through a separate, always-available control.",
            confidence: "medium",
          }),
        );
      } else if (sentiment && ask && /\b(if|guard|\?|switch|case)\b[^\n]{0,80}\b(yes|positive|liked|enjoy|happy|love)\w*/i.test(f.code)) {
        findings.push(
          finding({
            rule: "ratings.sentiment_gate",
            severity: "high",
            guideline: "5.6.3",
            file: f.path,
            line: sentiment.line,
            evidence: sentiment.value,
            why: "A sentiment question decides whether the review prompt is shown, so only users who answer positively are asked to rate. That skews ratings (5.6.3).",
            fix: "Remove the pre-question: call the system review API (`requestReview`) for every user at a natural moment.",
            confidence: "low",
          }),
        );
      }

      // Custom in-app rating UI instead of the system prompt.
      if (!system && link) {
        const stars = STAR_PICKER.exec(f.code);
        // The ask must be the alert's own copy; a "Rate us" settings row next to an unrelated sheet is fine.
        const rateAsk = literalsOf(f).find(
          (l) => RATE_ASK_LITERAL.test(l.value) && ALERT_UI.test(f.code.slice(Math.max(0, l.index - 250), l.index)) && ships(f, l.index),
        );
        if (stars && ships(f, stars.index)) {
          const line = lineIndex(f.code)(stars.index);
          findings.push(
            finding({
              rule: "ratings.custom_prompt",
              severity: "block",
              guideline: "5.6.1",
              file: f.path,
              line,
              evidence: lineText(f, line),
              why: "The app draws its own star-rating prompt and then sends users to the App Store review page. 5.6.1 requires the system API to prompt for ratings; a custom star picker is a prompt that bypasses it and lets the app filter who reaches the store.",
              fix: "Remove the custom star prompt and call the system API instead (`@Environment(\\.requestReview)`, `AppStore.requestReview(in:)`, or `StoreReview.requestReview()` in Expo).",
              confidence: "medium",
            }),
          );
        } else if (rateAsk) {
          findings.push(
            finding({
              rule: "ratings.custom_prompt",
              severity: "high",
              guideline: "5.6.1",
              file: f.path,
              line: rateAsk.line,
              evidence: rateAsk.value,
              why: "The app shows its own \"rate us\" alert or modal and links to the App Store review page instead of using the system rating prompt. 5.6.1 says to use the provided API to prompt users to review. A plain \"Write a Review\" link in settings is fine; an interruptive custom prompt is not.",
              fix: "Remove the custom prompt and call the system API instead (`@Environment(\\.requestReview)`, `AppStore.requestReview(in:)`, `StoreReview.requestReview()` in Expo).",
              confidence: "medium",
            }),
          );
        }
      }
    }

    // Hardcoded social proof on paywall/onboarding screens and their copy tables.
    const proofFiles = ctx.files.filter(
      (f) =>
        isUiText(f) &&
        !NON_SHIPPING_PATH.test(f.path) &&
        (ONBOARDING_PATH.test(f.path) || PAYWALL_PATH.test(f.path) || (isCode(f) && (PURCHASE_CALL.test(f.code) || MANAGED_PAYWALL.test(f.code)))),
    );
    for (const f of proofFiles) {
      for (const lit of literalsOf(f)) {
        const m = SOCIAL_PROOF.exec(lit.value);
        if (!m || !ships(f, lit.index)) continue;
        findings.push(
          finding({
            rule: "ratings.hardcoded_social_proof",
            severity: "medium",
            guideline: "5.6.3",
            file: f.path,
            line: lit.line,
            evidence: lit.value,
            why: `Paywall or onboarding copy states a fixed rating, user count or ranking ("${m[0]}"). Hardcoded figures go stale or were never true; unverifiable claims are consumer misrepresentation under DPLA 3.2(f) and misleading under 5.6.3/2.3.`,
            fix: "Remove the figure unless it is current and verifiable; if you keep a claim, source it from live data and be ready to substantiate it to App Review.",
            confidence: "medium",
          }),
        );
      }
    }

    // A bundled JSON table read by the paywall (e.g. an "App Store rating" block) holds the actual figure the UI shows.
    const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/") + 1);
    const proofDirs = new Set(proofFiles.filter(isCode).map((f) => dirOf(f.path)));
    for (const f of ctx.files) {
      if (f.ext !== "json" || NON_SHIPPING_PATH.test(f.path) || /(^|\/)(package(-lock)?|tsconfig[\w.]*|app|eas|Contents)\.json$/.test(f.path)) continue;
      if (!ONBOARDING_PATH.test(f.path) && !PAYWALL_PATH.test(f.path) && !proofDirs.has(dirOf(f.path))) continue;
      const m = SOCIAL_PROOF_JSON_KEY.exec(f.text);
      if (!m) continue;
      const line = lineIndex(f.text)(m.index);
      findings.push(
        finding({
          rule: "ratings.hardcoded_social_proof",
          severity: "medium",
          guideline: "5.6.3",
          file: f.path,
          line,
          evidence: lineText(f, line),
          why: `A data file bundled with the paywall or onboarding holds a fixed rating or audience figure (${m[0].replace(/\s+/g, " ")}). Hardcoded figures go stale or were never true; unverifiable claims are consumer misrepresentation under DPLA 3.2(f) and misleading under 5.6.3/2.3.`,
          fix: "Remove the figure unless it is current and verifiable; if you keep a claim, source it from live data and be ready to substantiate it to App Review.",
          confidence: "medium",
        }),
      );
    }

    return { findings, data: { reviewRequestSites: reviewSites } };
  },
};

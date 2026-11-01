import type { Check, CheckResult } from "../checks.js";
import { finding } from "../finding.js";
import type { ScanContext, SourceFile } from "../project.js";
import { AI_ACRONYM, AI_PARTY, AI_TOKENS, ANALYZE_VERB, CONSENT_WORD, MARKETING_PATH, SHARE_VERB } from "../rules/genai.js";
import { analyzeAiSurface, primarySink, productFiles, isCode, isShippedText, lineAt, lineTextAt, literalsOf, maskedOf, redact, type SurfaceItem } from "./genaiSafety.js";

const PER_KIND = 10;

function tokens(ident: string): string[] {
  return ident
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_.\-]+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean);
}

/** `aiConsent`, `hasAcceptedAITerms`, `@AppStorage("ai_data_consent")`: persisted consent tied to AI. */
function isAiConsentIdent(ident: string): boolean {
  if (!CONSENT_WORD.test(ident)) return false;
  if (/third_?party/i.test(ident)) return true;
  return tokens(ident).some((t) => AI_TOKENS.has(t));
}

/** Prose that names AI / a provider / a third party together with sharing or consent. */
function isDisclosureProse(s: string): boolean {
  if (!/\s/.test(s.trim())) return false;
  return ((AI_ACRONYM.test(s) || AI_PARTY.test(s)) && SHARE_VERB.test(s)) || (AI_PARTY.test(s) && ANALYZE_VERB.test(s));
}

function consentEvidence(ctx: ScanContext): SurfaceItem[] {
  const out: SurfaceItem[] = [];
  const shipped = isShippedText(ctx);
  const push = (f: SourceFile, index: number, kind: string) => {
    if (out.length < PER_KIND) out.push({ file: f.path, line: lineAt(f, index), text: redact(lineTextAt(f, index)).slice(0, 200), kind });
  };
  for (const f of productFiles(ctx).filter(shipped)) {
    if (MARKETING_PATH.test(f.path)) continue;
    for (const lit of literalsOf(f)) {
      const v = lit.value.trim();
      if (isDisclosureProse(v)) push(f, lit.index, "disclosure-text");
      else if (/^[A-Za-z_][\w.-]*$/.test(v) && isAiConsentIdent(v)) push(f, lit.index, "consent-key");
    }
    if (isCode(f)) {
      for (const m of maskedOf(f).matchAll(/\b[A-Za-z_][A-Za-z0-9_]{3,}\b/g)) {
        if (isAiConsentIdent(m[0])) push(f, m.index ?? 0, "consent-state");
      }
    }
    if (out.length >= PER_KIND) break;
  }
  return out;
}

export const check: Check = {
  id: "ai_data_disclosure",
  title: "Disclosure of user data sent to third-party AI",
  guidelines: ["5.1.2(i)", "4.7.3"],
  async run(ctx: ScanContext): Promise<CheckResult> {
    const s = analyzeAiSurface(ctx);
    const cloud = s.providers.filter((p) => p.kind === "cloud");
    if (cloud.length === 0) return { findings: [], data: { applies: false } };

    const cloudIds = new Set(cloud.map((p) => p.id));
    const cloudSinks = s.sinks.filter((x) => x.provider === undefined || cloudIds.has(x.provider));
    // Nearly every app has a text field, so typed text only counts when something sends text to a model.
    const textToModel = cloudSinks.some((x) => x.kind === "text" || x.kind === "generation");
    const kinds = new Set<string>();
    for (const src of s.sources) {
      if (src.kind === "photo" || src.kind === "camera") kinds.add("photos");
      else if (src.kind === "mic") kinds.add("voice");
      else if (src.kind === "text" && textToModel) kinds.add("text");
      // Health and calendar records reach a model only as prompt text.
      else if (src.kind === "health" && textToModel) kinds.add("health data");
      else if (src.kind === "calendar" && textToModel) kinds.add("calendar events");
    }
    const consent = consentEvidence(ctx);
    const data = {
      applies: kinds.size > 0,
      providers: cloud.map((p) => p.name),
      dataKinds: [...kinds],
      sources: s.sources.slice(0, 30),
      sinks: cloudSinks.slice(0, 30),
      consent,
      note: `${s.note} Consent evidence is not checked for ordering: confirm it appears before the first upload.`,
    };
    if (kinds.size === 0 || consent.length > 0) return { findings: [], data };

    const anchor = primarySink(cloudSinks) ?? cloudSinks[0] ?? cloud[0]?.evidence[0];
    const names = cloud.map((p) => p.name).join(", ");
    return {
      findings: [
        finding({
          rule: "ai.undisclosed_sharing",
          severity: "high",
          guideline: "5.1.2(i)",
          ...(anchor ? { file: anchor.file, line: anchor.line, evidence: anchor.text } : {}),
          why:
            `The app collects user ${[...kinds].join(", ")} and calls a third-party AI service (${names}), but no consent screen, alert, persisted AI consent or string naming AI / the provider / third-party sharing was found. 5.1.2(i) requires clearly disclosing that personal data is shared with third-party AI and obtaining explicit permission first (4.7.3 for chatbot data sharing).` +
            (kinds.has("health data") ? " The app also reads HealthKit or health data; 5.1.3 limits sharing health data with third parties and requires the user's consent first." : ""),
          fix: `Disclose in the app, before the first upload, that ${[...kinds].join(", ")} are sent to ${names} (a third-party AI service) and for what purpose, ask for explicit permission, and disclose the same in the privacy policy and App Privacy details.`,
          // Photos, voice, health and calendar records are personal data on their face; typed text may or may not reach the model.
          confidence: kinds.has("photos") || kinds.has("voice") || kinds.has("health data") || kinds.has("calendar events") ? "medium" : "low",
        }),
      ],
      data,
    };
  },
};

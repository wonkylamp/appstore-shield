import { describe, expect, it } from "vitest";
import { lintText, utf8Bytes, type LintInput } from "../../src/ledger/lint.js";
import { LedgerEvent } from "../../src/ledger/schema.js";
import { foldEvents } from "../../src/ledger/store.js";

const rules = (input: LintInput) => lintText(input).issues.map((i) => i.rule);
const notes = (text: string, extra: Partial<LintInput> = {}) => lintText({ purpose: "review_notes", text, ...extra });
const has = (input: LintInput, rule: string) => rules(input).includes(rule as never);

const GOOD_NOTES = `Changes in 1.3 (build 41):
- Removed the outfit picker screen and the outfit assets from the companion feature.
- The image generator now applies an output filter before images are shown.

Prior rejection: Guideline 1.2 on 2026-10-01. We removed the clothing-change capability from the picker and from free-text prompts.

How to test: open Companion, tap Create, enter a prompt and generate an image.`;

describe("byte_limit", () => {
  it("counts UTF-8 bytes, not characters", () => {
    expect(utf8Bytes("é")).toBe(2);
    expect(utf8Bytes("😀")).toBe(4);
    const text = "é".repeat(2001); // 2001 chars, 4002 bytes
    const r = notes(text);
    expect(r.bytes).toBe(4002);
    expect(r.issues.some((i) => i.rule === "byte_limit")).toBe(true);
    expect(r.ok).toBe(false);
  });

  it("allows exactly 4000 bytes and has no limit outside review notes", () => {
    expect(has({ purpose: "review_notes", text: "a".repeat(4000) }, "byte_limit")).toBe(false);
    expect(has({ purpose: "reply", text: "é".repeat(3000) }, "byte_limit")).toBe(false);
  });
});

describe("absolute_claim", () => {
  it("flags none/never/impossible/guarantee/100%/completely removed/fully compliant/removed all", () => {
    for (const t of [
      "Users can never generate lingerie images.",
      "It is impossible to request this content.",
      "We guarantee the feature is gone.",
      "The filter blocks 100% of requests.",
      "The feature was completely removed.",
      "The app is now fully compliant.",
      "We removed all traces of the feature.",
      "None of the outfits remain.",
    ]) {
      expect(has({ purpose: "reply", text: t }, "absolute_claim"), t).toBe(true);
    }
  });

  it("does not flag ordinary words or quoted reviewer text", () => {
    for (const t of [
      "We removed the outfit picker; a source sweep found no remaining references.",
      "Nonetheless, overall we allow users to report content.",
      'The reviewer wrote "this must never happen" and we removed the picker.',
      "All screens are listed below with steps.",
    ]) {
      expect(has({ purpose: "reply", text: t }, "absolute_claim"), t).toBe(false);
    }
  });

  it("allows absolute claims only with PROBED 100%, a clean build, and probe results the developer confirmed", () => {
    const text = "Users can never generate lingerie images.";
    const hash = "abcdef0123456789".repeat(4);
    const confirmed = foldEvents("T", [
      LedgerEvent.parse({ id: "ev_a", type: "attestation", at: "2026-10-01T00:00:00Z", source: "human", statement: `The developer states that my own probe run produced results ${hash.slice(0, 12)}.` }),
    ]);
    const agentClaim = foldEvents("T", [
      LedgerEvent.parse({ id: "ev_b", type: "attestation", at: "2026-10-01T00:00:00Z", source: "agent", statement: `probe results ${hash.slice(0, 12)}` }),
    ]);
    const probed = { tier: "PROBED" as const, probe: { total: 60, blocked: 60, resultsHash: hash } };
    expect(has({ purpose: "reply", text, state: confirmed, strongestTier: { ...probed, buildClean: true } }, "absolute_claim")).toBe(false);
    // self-attested probe files (no developer confirmation) never unlock absolute claims
    expect(has({ purpose: "reply", text, strongestTier: { ...probed, buildClean: true } }, "absolute_claim")).toBe(true);
    expect(has({ purpose: "reply", text, state: agentClaim, strongestTier: { ...probed, buildClean: true } }, "absolute_claim")).toBe(true);
    expect(has({ purpose: "reply", text, state: confirmed, strongestTier: probed }, "absolute_claim")).toBe(true);
    expect(has({ purpose: "reply", text, state: confirmed, strongestTier: { ...probed, probe: { total: 60, blocked: 59, resultsHash: hash }, buildClean: true } }, "absolute_claim")).toBe(true);
    expect(has({ purpose: "reply", text, strongestTier: { tier: "BUILD_CLEAN", buildClean: true } }, "absolute_claim")).toBe(true);
  });

  it("flags capability claims only a probe could support", () => {
    for (const t of [
      "This content cannot be produced anymore.",
      "A user can no longer generate sexually suggestive images of Luna by any route.",
      "Generating these images is no longer possible.",
      "Sexualized images can't be created through any input path.",
    ]) {
      expect(has({ purpose: "reply", text: t }, "absolute_claim"), t).toBe(true);
    }
  });

  it("does not flag specific statements about what was removed", () => {
    for (const t of [
      "Users can no longer select Lingerie in the outfit picker.",
      "We could not reproduce the crash on iOS 18.",
      "The Create button is disabled until a prompt is entered.",
    ]) {
      expect(has({ purpose: "reply", text: t }, "absolute_claim"), t).toBe(false);
    }
  });

  it("does not flag 'none' or 'never' answering a disclosure label", () => {
    for (const t of ["Over-the-air updates: none.", "Remote flags that change content or price: none.", "Third-party login: never used."]) {
      expect(has({ purpose: "review_notes", text: t }, "absolute_claim"), t).toBe(false);
    }
    expect(has({ purpose: "review_notes", text: "Users will never see these outfits again." }, "absolute_claim")).toBe(true);
  });
});

describe("unattributed_attestation", () => {
  it("flags factual statements about servers/backends", () => {
    expect(has({ purpose: "reply", text: "Our server rejects clothing-change prompts." }, "unattributed_attestation")).toBe(true);
    expect(has({ purpose: "reply", text: "The backend filters every generated image." }, "unattributed_attestation")).toBe(true);
    expect(has({ purpose: "reply", text: "Moderation now happens server-side before display." }, "unattributed_attestation")).toBe(true);
  });

  it("accepts the attestation prefix, questions, and app-only statements", () => {
    expect(has({ purpose: "reply", text: "The developer states that our server rejects clothing-change prompts." }, "unattributed_attestation")).toBe(false);
    expect(has({ purpose: "reply", text: "The developer states:\n- our backend filters every generated image\n- the server prompt was updated" }, "unattributed_attestation")).toBe(false);
    expect(has({ purpose: "clarification", text: "Could you tell us which output the server returned during review?" }, "unattributed_attestation")).toBe(false);
    expect(has({ purpose: "reply", text: "The app shows a report button on every image." }, "unattributed_attestation")).toBe(false);
    expect(has({ purpose: "reply", text: "The app sends the prompt to the Gemini API." }, "unattributed_attestation")).toBe(false);
    expect(has({ purpose: "reply", text: "Our API rejects clothing-change prompts." }, "unattributed_attestation")).toBe(true);
  });
});

describe("forward-looking assurances about remote switches and OTA", () => {
  it("flags a promise about future use written as fact in review notes", () => {
    expect(has({ purpose: "review_notes", text: "The remote config keys will not be used to change content." }, "unattributed_attestation")).toBe(true);
    expect(has({ purpose: "review_notes", text: "OTA updates are limited to bug fixes." }, "unattributed_attestation")).toBe(true);
  });

  it("accepts a factual disclosure and the developer's own statement", () => {
    expect(has({ purpose: "review_notes", text: "This app reads remote configuration from Firebase. Keys: style_list (controls the style picker)." }, "unattributed_attestation")).toBe(false);
    expect(has({ purpose: "review_notes", text: "The developer states that OTA updates are limited to bug fixes." }, "unattributed_attestation")).toBe(false);
  });
});

describe("unbacked_attestation", () => {
  const withAttestation = foldEvents("T", [
    LedgerEvent.parse({ id: "ev_h", type: "attestation", at: "2026-10-01T00:00:00Z", source: "human", statement: "The developer states that the server prompt no longer accepts lingerie requests." }),
  ]);
  const agentOnly = foldEvents("T", [
    LedgerEvent.parse({ id: "ev_g", type: "attestation", at: "2026-10-01T00:00:00Z", source: "agent", statement: "The developer states that the server prompt no longer accepts lingerie requests." }),
  ]);
  const text = "The developer states that the server prompt no longer accepts lingerie requests and output moderation now runs on every image.";

  it("flags a 'The developer states' sentence with no matching human attestation in the ledger", () => {
    expect(has({ purpose: "review_notes", text, state: foldEvents("T", []) }, "unbacked_attestation")).toBe(true);
    expect(has({ purpose: "review_notes", text, state: agentOnly }, "unbacked_attestation")).toBe(true);
    expect(has({ purpose: "review_notes", text: "The developer states that output moderation runs on every image.", state: withAttestation }, "unbacked_attestation")).toBe(true);
  });

  it("accepts the sentence when the developer recorded a matching attestation", () => {
    expect(has({ purpose: "review_notes", text: "The developer states that the server prompt no longer accepts lingerie requests.", state: withAttestation }, "unbacked_attestation")).toBe(false);
    expect(has({ purpose: "review_notes", text: "The app shows a report button on every image.", state: foldEvents("T", []) }, "unbacked_attestation")).toBe(false);
  });
});

describe("comparison and pressure", () => {
  it("warns on comparisons with other apps and on pressure to approve", () => {
    const t = "Other apps in our category, like Replika, offer the same outfits, so please approve this quickly.";
    expect(has({ purpose: "reply", text: t }, "comparison")).toBe(true);
    expect(has({ purpose: "reply", text: t }, "pressure")).toBe(true);
    expect(has({ purpose: "reply", text: "Our competitors already do this." }, "comparison")).toBe(true);
    expect(has({ purpose: "reply", text: "This is urgent for our launch." }, "pressure")).toBe(true);
  });

  it("does not flag ordinary wording", () => {
    for (const t of ["The app works like a journal: users write entries and can approve suggestions.", "Other screens are unchanged.", "Tap Approve to accept a suggestion."]) {
      expect(has({ purpose: "reply", text: t }, "comparison"), t).toBe(false);
      expect(has({ purpose: "reply", text: t }, "pressure"), t).toBe(false);
    }
  });
});

describe("secret", () => {
  it("flags demo credentials pasted without a colon", () => {
    for (const t of ["Demo login: luna@example.com / Review2026! (pw Review2026!)", "Sign in with luna@example.com Review2026", "Account luna@example.com, pass Secr3t!"]) {
      const issue = lintText({ purpose: "review_notes", text: t }).issues.find((i) => i.rule === "secret");
      expect(issue, t).toBeDefined();
      expect(issue?.excerpt).not.toContain("Review2026");
    }
  });

  it("does not flag an email address alone or prose about passing review", () => {
    for (const t of ["Contact us at support@example.com for help.", "Demo login: see the Sign-In Information fields (luna@example.com).", "We hope this build will pass review 2.0 smoothly."]) {
      expect(has({ purpose: "review_notes", text: t }, "secret"), t).toBe(false);
    }
  });

  it("flags credentials and keys, and redacts them in the excerpt", () => {
    const cases = [
      "Demo account: demo@x.com password: Hunter22!",
      "Key sk-proj-abcdefghijklmnopqrstuvwx1234",
      ["AI", "zaSyA1234567890abcdefghijklmnopqrstuv"].join(""), // split so secret scanners do not flag a fake key
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
      "-----BEGIN PRIVATE KEY-----\nMIIE",
    ];
    for (const t of cases) {
      const r = lintText({ purpose: "review_notes", text: t });
      const issue = r.issues.find((i) => i.rule === "secret");
      expect(issue, t).toBeDefined();
      expect(issue?.excerpt).toContain("[redacted]");
      expect(issue?.excerpt).not.toContain("Hunter22");
      expect(issue?.excerpt).not.toContain("qrstuvwx1234");
    }
  });

  it("accepts placeholders that point at the sign-in fields", () => {
    expect(has({ purpose: "review_notes", text: "Demo account: see the Sign-In Information fields. Password: <in App Review Information>" }, "secret")).toBe(false);
    expect(has({ purpose: "review_notes", text: "Password: provided in the sign-in fields." }, "secret")).toBe(false);
    expect(has({ purpose: "review_notes", text: "Users reset their password from Settings." }, "secret")).toBe(false);
  });
});

describe("combative_tone", () => {
  it("flags combative and legalistic wording", () => {
    for (const t of ["This rejection is unfair.", "Our lawyer will review this.", "We demand a different reviewer.", "You are wrong about the feature.", "This is ridiculous.", "We feel discriminated against."]) {
      expect(has({ purpose: "reply", text: t }, "combative_tone"), t).toBe(true);
    }
    const legal = lintText({ purpose: "appeal_termination", text: "We will sue if this is not reversed." });
    expect(legal.issues.find((i) => i.rule === "combative_tone")?.severity).toBe("error");
  });

  it("does not flag benign uses (on-demand, unacceptable content, issue, pursue)", () => {
    for (const t of ["Videos are generated on-demand.", "Users can report unacceptable content from any post.", "We fixed the issue and pursue a full review of prompts."]) {
      expect(has({ purpose: "reply", text: t }, "combative_tone"), t).toBe(false);
    }
  });
});

describe("generic_change", () => {
  it("flags generic notes (2.3.1(a))", () => {
    expect(has({ purpose: "review_notes", text: "Bug fixes and performance improvements." }, "generic_change")).toBe(true);
    expect(has({ purpose: "review_notes", text: "This version includes minor changes." }, "generic_change")).toBe(true);
  });

  it("accepts specific descriptions even when they use the same words, and other purposes", () => {
    expect(has({ purpose: "review_notes", text: "Bug fixes: the photo upload screen no longer crashes when importing HEIC images larger than 20 MB." }, "generic_change")).toBe(false);
    expect(has({ purpose: "review_notes", text: GOOD_NOTES }, "generic_change")).toBe(false);
    expect(has({ purpose: "reply", text: "Bug fixes." }, "generic_change")).toBe(false);
  });
});

describe("disclosure_missing", () => {
  const inventory = {
    remoteControls: [{ key: "nsfw_mode", provider: "firebase", classification: "content-gating" as const, gates: "outfits" }],
    ota: [{ provider: "expo-updates" }],
    aiServices: ["fal.ai"],
  };

  it("flags missing remote-config, OTA and AI-service disclosure", () => {
    const r = notes(GOOD_NOTES, { inventory });
    const d = r.issues.filter((i) => i.rule === "disclosure_missing");
    expect(d.filter((i) => i.severity === "error")).toHaveLength(2);
    expect(d.some((i) => i.excerpt.includes("fal.ai"))).toBe(true);
  });

  it("accepts notes that disclose them, and errors when flags are mentioned generically but not named", () => {
    const full = `${GOOD_NOTES}\n\nRemote controls: the Firebase Remote Config flag nsfw_mode (default false) controls the outfit list. The app uses expo-updates for over-the-air JavaScript updates. Images are generated by fal.ai.`;
    expect(has({ purpose: "review_notes", text: full, inventory }, "disclosure_missing")).toBe(false);
    const generic = notes(`${GOOD_NOTES}\nWe use remote config. OTA updates via expo-updates. Images by fal.ai.`, { inventory });
    const d = generic.issues.filter((i) => i.rule === "disclosure_missing");
    expect(d).toHaveLength(1);
    expect(d[0]?.severity).toBe("error");
    expect(d[0]?.message).toMatch(/do not name these flags that gate content or price: nsfw_mode/);
  });

  it("treats a denial as a false disclosure when the scan found the item, not as a mention", () => {
    const inv = { remoteControls: [{ key: "spicy_mode_enabled", provider: "firebase", classification: "content-gating" as const, gates: "outfits" }], ota: [{ provider: "expo-updates" }] };
    const r = notes(`${GOOD_NOTES}\nRemote config: none. OTA updates: none.`, { inventory: inv });
    expect(r.ok).toBe(false);
    const f = r.issues.filter((i) => i.rule === "false_disclosure");
    expect(f).toHaveLength(2);
    expect(f[0]?.message).toMatch(/spicy_mode_enabled/);
    expect(f[1]?.message).toMatch(/expo-updates/);
    // the denial does not count as mentioning remote config, so the key is reported missing too
    expect(r.issues.some((i) => i.rule === "disclosure_missing" && i.severity === "error" && i.excerpt.includes("spicy_mode_enabled"))).toBe(true);
    for (const t of ["We do not use feature flags.", "The app has no remote config.", "Remote flags that change content or price: none."]) {
      expect(has({ purpose: "review_notes", text: `${GOOD_NOTES}\n${t}`, inventory: inv }, "false_disclosure"), t).toBe(true);
    }
  });

  it("does not report a false disclosure when the denial is true or the item is disclosed", () => {
    const productOnly = { remoteControls: [{ key: "onboarding_v2", provider: "statsig", classification: "product" as const, gates: "onboarding" }] };
    expect(has({ purpose: "review_notes", text: `${GOOD_NOTES}\nRemote config: none.`, inventory: {} }, "false_disclosure")).toBe(false);
    expect(has({ purpose: "review_notes", text: `${GOOD_NOTES}\nRemote flags that change content or price: none.`, inventory: productOnly }, "false_disclosure")).toBe(false);
    const inv = { remoteControls: [{ key: "spicy_mode_enabled", provider: "firebase", classification: "content-gating" as const, gates: "outfits" }] };
    const r = notes(`${GOOD_NOTES}\nRemote config: the Firebase flag spicy_mode_enabled (default false) controls the outfit list.`, { inventory: inv });
    expect(r.issues.some((i) => i.rule === "false_disclosure" || i.rule === "disclosure_missing")).toBe(false);
  });

  it("does not apply when the inventory has only product flags", () => {
    expect(has({ purpose: "review_notes", text: GOOD_NOTES, inventory: { remoteControls: [{ key: "onboarding", provider: "statsig", classification: "product", gates: "x" }] } }, "disclosure_missing")).toBe(false);
  });
});

describe("appeal admissions", () => {
  it("flags speculative admissions in appeals only", () => {
    for (const t of ["If we did anything wrong, we apologize.", "We may have misunderstood the rules.", "Perhaps we submitted too often."]) {
      expect(has({ purpose: "appeal_termination", text: t }, "speculative_admission"), t).toBe(true);
    }
    expect(has({ purpose: "reply", text: "We may have misunderstood the rules." }, "speculative_admission")).toBe(false);
    expect(has({ purpose: "appeal_termination", text: "We apologize for submitting build 34 without describing the change in the notes." }, "speculative_admission")).toBe(false);
  });

  it("flags admissions of unconfirmed categories, and accepts ones the developer confirmed in a terminal", () => {
    const text = "We apologize for misleading App Review about the outfit feature.";
    expect(has({ purpose: "appeal_termination", text }, "unconfirmed_admission")).toBe(true);
    // a caller-supplied list no longer silences the guard
    expect(has({ purpose: "appeal_termination", text, confirmedMistakes: ["misleading reviewers"], state: foldEvents("T", []) }, "unconfirmed_admission")).toBe(true);
    const confirmed = foldEvents("T", [
      LedgerEvent.parse({ id: "ev_m", type: "attestation", at: "2026-10-01T00:00:00Z", source: "human", statement: "The developer states that our review notes for build 34 were misleading about the outfit feature." }),
    ]);
    expect(has({ purpose: "appeal_termination", text, state: confirmed }, "unconfirmed_admission")).toBe(false);
    const agentWritten = foldEvents("T", [
      LedgerEvent.parse({ id: "ev_n", type: "attestation", at: "2026-10-01T00:00:00Z", source: "agent", statement: "We misled App Review." }),
    ]);
    expect(has({ purpose: "appeal_termination", text, state: agentWritten }, "unconfirmed_admission")).toBe(true);
    expect(has({ purpose: "appeal_review_board", text: "We hid the feature behind a flag." }, "unconfirmed_admission")).toBe(true);
    expect(has({ purpose: "appeal_review_board", text: "We removed the outfit picker in build 41." }, "unconfirmed_admission")).toBe(false);
  });

  it("warns (asking the developer to confirm) on unconfirmed admissions in notes and replies, without blocking candor", () => {
    for (const [purpose, t] of [
      ["reply", "We had hidden the outfit picker from App Review devices; it is now visible to everyone."],
      ["review_notes", "The outfit picker is no longer hidden from App Review installs."],
      ["review_notes", "The spicy mode was gated for reviewers and is now removed."],
      ["clarification", "The reviewer could not see the outfit menu because it was off in TestFlight."],
      ["reply", "We misled the reviewer about the picker."],
      ["review_notes", "We removed a TestFlight check that turned off the outfit picker for App Review; the picker is now the same for all users."],
    ] as const) {
      const r = lintText({ purpose, text: t });
      const issue = r.issues.find((i) => i.rule === "unconfirmed_admission");
      expect(issue?.severity, t).toBe("warning");
      expect(issue?.fix, t).toMatch(/appstore-shield attest/);
      expect(issue?.fix, t).not.toMatch(/Do not write it/);
      expect(r.ok, t).toBe(true);
    }
  });

  it("accepts a factual mechanism description once the developer recorded it, even without calling it a mistake", () => {
    const st = foldEvents("T", [
      LedgerEvent.parse({ id: "ev_g", type: "attestation", at: "2026-10-01T00:00:00Z", source: "human", statement: "Build 40 had a TestFlight check that turned off the outfit picker during review; build 41 removes it." }),
    ]);
    const t = "We removed a TestFlight check that turned off the outfit picker for App Review; the picker is now the same for all users.";
    expect(has({ purpose: "review_notes", text: t, state: st }, "unconfirmed_admission")).toBe(false);
  });

  it("does not flag ordinary review instructions, and accepts an admission the developer confirmed", () => {
    for (const t of [
      "Reviewers can find the report button in Settings.",
      "The demo account for App Review is in the Sign-In Information fields.",
      "We removed the outfit picker in build 41.",
      "App Review can test the chat on any device.",
      "We kept the report button visible for reviewers in Settings.",
    ]) {
      expect(has({ purpose: "review_notes", text: t }, "unconfirmed_admission"), t).toBe(false);
    }
    const confirmed = foldEvents("T", [
      LedgerEvent.parse({ id: "ev_h", type: "attestation", at: "2026-10-01T00:00:00Z", source: "human", statement: "we made this mistake: the outfit picker was hidden from App Review devices in build 40" }),
    ]);
    expect(has({ purpose: "review_notes", text: "The outfit picker is no longer hidden from App Review installs.", state: confirmed }, "unconfirmed_admission")).toBe(false);
  });
});

describe("prior_rejection_unmentioned", () => {
  const state = foldEvents("T", [LedgerEvent.parse({ id: "ev_r", type: "outcome", at: "2026-10-01T00:00:00Z", source: "import", outcome: "rejected", guidelines: ["1.2"] })]);
  it("warns when review notes skip an open rejection", () => {
    expect(has({ purpose: "review_notes", text: "Added a dark mode toggle on the Settings screen.", state }, "prior_rejection_unmentioned")).toBe(true);
  });
  it("is satisfied when the guideline is referenced", () => {
    expect(has({ purpose: "review_notes", text: GOOD_NOTES, state }, "prior_rejection_unmentioned")).toBe(false);
  });
});

describe("AI service disclosure", () => {
  const inventory = { aiServices: ["Google Gemini / Vertex AI (incl. Firebase AI Logic)", "fal.ai"] };
  it("accepts the names developers actually write", () => {
    const r = lintText({ purpose: "review_notes", text: "Chat uses Google Gemini; images use fal (flux). Prior rejection Guideline 1.2.", inventory });
    expect(r.issues.filter((i) => i.rule === "disclosure_missing")).toEqual([]);
  });
  it("still warns when a service is not named", () => {
    const r = lintText({ purpose: "review_notes", text: "Chat uses Google Gemini.", inventory });
    expect(r.issues.find((i) => i.rule === "disclosure_missing")?.excerpt).toBe("fal.ai");
  });
});

describe("overall", () => {
  it("a calm, specific, disclosed note passes", () => {
    const r = notes(GOOD_NOTES);
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe("contradicts_ledger", () => {
  const flags = (id: string, at: string, v: string) =>
    LedgerEvent.parse({
      id,
      type: "config_snapshot",
      at,
      source: "hook",
      kind: "flags_inventory",
      label: "flags",
      hash: `h${v}`,
      summary: "1 remote flag(s)",
      data: { flags: [{ key: "lingerie_outfits", provider: "firebase", classification: "content-gating", defaultValue: v }] },
    });
  const approved = LedgerEvent.parse({ id: "ev_ok", type: "outcome", at: "2026-09-02T00:00:00Z", source: "import", outcome: "approved" });
  const flipped = foldEvents("T", [flags("ev_f1", "2026-09-01T00:00:00Z", "false"), approved, flags("ev_f2", "2026-09-20T00:00:00Z", "true")]);
  const notAware = LedgerEvent.parse({ id: "ev_na", type: "attestation", at: "2026-10-05T00:00:00Z", source: "human", statement: "I am not aware of the conduct the notice refers to." });

  it("errors when an appeal denies a post-approval change the ledger records, or denies awareness for the developer", () => {
    const t = "The developer is not aware of the conduct the notice refers to. Each rejection was answered by changing the app as App Review asked, and nothing was changed after approval.";
    const r = lintText({ purpose: "appeal_termination", text: t, state: flipped });
    const found = r.issues.filter((i) => i.rule === "contradicts_ledger");
    expect(found.map((i) => i.severity)).toEqual(["error", "error"]);
    expect(found.map((i) => i.message).join(" ")).toMatch(/ev_f2/);
    expect(found.map((i) => i.message).join(" ")).toMatch(/no statement from them/);
    expect(r.ok).toBe(false);
    expect(has({ purpose: "review_notes", text: "The lingerie_outfits flag has not changed since the last approval.", state: flipped }, "contradicts_ledger")).toBe(true);
    expect(has({ purpose: "reply", text: "No changes to lingerie_outfits.", state: flipped }, "contradicts_ledger")).toBe(true);
  });

  it("accepts a factual description of the change, and the developer's own recorded non-awareness (with a warning to state the facts)", () => {
    expect(has({ purpose: "appeal_termination", text: "On 2026-09-20 the lingerie_outfits flag was turned on after the 2026-09-02 approval; it has since been removed.", state: flipped }, "contradicts_ledger")).toBe(false);
    const st = foldEvents("T", [...flipped.events, notAware]);
    const r = lintText({ purpose: "appeal_termination", text: "The developer states that they are not aware of the conduct the notice refers to.", state: st });
    const i = r.issues.find((x) => x.rule === "contradicts_ledger");
    expect(i?.severity).toBe("warning");
    expect(i?.message).toMatch(/1 change\(s\) after approval/);
    expect(has({ purpose: "appeal_termination", text: "We are not aware of the conduct.", state: foldEvents("T", [notAware]) }, "contradicts_ledger")).toBe(false);
  });

  it("errors on 'every rejection was fixed' while a rejection is open and unverified", () => {
    const open = foldEvents("T", [LedgerEvent.parse({ id: "ev_r1", type: "outcome", at: "2026-10-01T00:00:00Z", source: "import", outcome: "rejected", guidelines: ["1.2"] })]);
    expect(has({ purpose: "appeal_review_board", text: "We fixed every issue App Review raised.", state: open }, "contradicts_ledger")).toBe(true);
    expect(has({ purpose: "appeal_review_board", text: "All prior rejections were addressed in later builds.", state: open }, "contradicts_ledger")).toBe(true);
    expect(has({ purpose: "appeal_review_board", text: "We fixed every issue App Review raised.", state: foldEvents("T", []) }, "contradicts_ledger")).toBe(false);
  });

  it("treats a denial of recorded OTA publishes or content flags as a false disclosure, with or without an inventory", () => {
    const ota = foldEvents("T", [LedgerEvent.parse({ id: "ev_ota", type: "ota_publish", at: "2026-09-10T00:00:00Z", source: "ci", channel: "production" })]);
    expect(has({ purpose: "review_notes", text: "Over-the-air updates: none.", state: ota }, "false_disclosure")).toBe(true);
    expect(has({ purpose: "reply", text: "We do not use feature flags.", state: flipped }, "false_disclosure")).toBe(true);
    expect(has({ purpose: "reply", text: "We do not use feature flags.", state: foldEvents("T", []) }, "false_disclosure")).toBe(false);
  });
});

describe("remote_toggle_fix", () => {
  const inventory = { remoteControls: [{ key: "spicy_mode", provider: "firebase", gates: "lingerie outfit", classification: "content-gating" as const }] };
  const INDIE = "We turned off spicy_mode in Firebase Remote Config, so the Lingerie outfit is now disabled for all users and the issue is resolved. Replicate blocks all sexual images. Bug fixes and improvements.";

  it("errors when review notes present a remote-config switch as the fix, and catches present-tense absolutes", () => {
    const r = lintText({ purpose: "review_notes", text: INDIE, inventory });
    const toggle = r.issues.find((i) => i.rule === "remote_toggle_fix");
    expect(toggle?.severity).toBe("error");
    expect(toggle?.message).toMatch(/spicy_mode.*2\.5\.19.*3\.2\(e\)/);
    expect(toggle?.fix).toMatch(/Delete the gated code/);
    expect(toggle?.fix).not.toMatch(/\b(?:rename|move|hide)\b/i);
    const abs = r.issues.filter((i) => i.rule === "absolute_claim").map((i) => i.excerpt).join(" ");
    expect(abs).toMatch(/blocks all/);
    expect(abs).toMatch(/for all users/);
  });

  it("fires in a reply even when worded as the developer's statement, and does not suggest rewording it as one", () => {
    const r = lintText({ purpose: "reply", text: "We disabled the lingerie outfit on our server." });
    expect(r.issues.find((i) => i.rule === "remote_toggle_fix")?.severity).toBe("error");
    expect(r.issues.some((i) => i.rule === "unattributed_attestation")).toBe(false);
    expect(has({ purpose: "reply", text: "The developer states that the outfit was disabled server-side, so the issue is resolved." }, "remote_toggle_fix")).toBe(true);
  });

  it("names a key from the rejection's saved spec even without remote-config words", () => {
    const rej = LedgerEvent.parse({ id: "ev_rj", type: "outcome", at: "2026-10-01T00:00:00Z", source: "import", outcome: "rejected", guidelines: ["1.1"] });
    const spec = LedgerEvent.parse({ id: "ev_sp", type: "residue_spec", at: "2026-10-02T00:00:00Z", source: "agent", rejectionId: "ev_rj", spec: { feature: "lingerie", capability: "x", flags: ["nsfw_enabled"] } });
    const r = lintText({ purpose: "review_notes", text: "We set nsfw_enabled to false, which fixes the issue.", state: foldEvents("T", [rej, spec]) });
    expect(r.issues.find((i) => i.rule === "remote_toggle_fix")?.message).toMatch(/nsfw_enabled/);
  });

  it("leaves a neutral disclosure alone and only warns when the text also describes removal from the build or an appeal recounts history", () => {
    expect(has({ purpose: "review_notes", text: "The spicy_mode flag in Firebase Remote Config is disabled (false); it gated the lingerie outfit.", inventory }, "remote_toggle_fix")).toBe(false);
    const removed = lintText({ purpose: "review_notes", text: "We turned off spicy_mode in Remote Config and deleted the lingerie outfit code from the app.", inventory });
    expect(removed.issues.find((i) => i.rule === "remote_toggle_fix")?.severity).toBe("warning");
    const history = lintText({ purpose: "appeal_termination", text: "In August we turned off spicy_mode in Remote Config instead of removing it." });
    expect(history.issues.find((i) => i.rule === "remote_toggle_fix")?.severity).toBe("warning");
  });
});

describe("history_understated", () => {
  let k = 0;
  const e = (type: LedgerEvent["type"], at: string, fields: Record<string, unknown> = {}, source = "import") => LedgerEvent.parse({ id: `ev_h${++k}`, type, at, source, ...fields });
  const rej = (at: string, g: string) => e("outcome", at, { bundleId: "com.a", outcome: "rejected", guidelines: [g] });
  const events = [
    e("app", "2026-01-01T00:00:00Z", { bundleId: "com.a", name: "Luna" }),
    ...["2026-03-01", "2026-05-01", "2026-06-01", "2026-08-01", "2026-09-01", "2026-10-01"].map((d) => e("submission", `${d}T00:00:00Z`, { bundleId: "com.a" })),
    rej("2026-05-02T00:00:00Z", "1.1"),
    rej("2026-08-02T00:00:00Z", "1.1"),
    rej("2026-09-02T00:00:00Z", "1.2"),
  ];
  const st = foldEvents("T", events);
  const now = "2026-10-31T00:00:00Z";

  it("errors on sentences that understate the recorded rejections or submissions, quoting the real counts", () => {
    for (const purpose of ["appeal_termination", "reply"] as const) {
      for (const text of [
        "This app was rejected only once, and we fixed it the same day.",
        "We have no history of objectionable-content rejections.",
        "We submitted the app only a couple of times this year.",
        "Our account has a clean review history.",
      ]) {
        const r = lintText({ purpose, text, state: st, now });
        const hit = r.issues.find((i) => i.rule === "history_understated");
        expect(hit?.severity, `${purpose}: ${text}`).toBe("error");
        expect(hit?.message).toMatch(/ledger records (?:3|6)/);
        expect(hit?.fix).toMatch(/recorded count and dates/);
      }
    }
    expect(lintText({ purpose: "reply", text: "We have no 1.1 rejections.", state: st, now }).issues.find((i) => i.rule === "history_understated")?.message).toMatch(/under Guideline 1\.1.*records 2/);
  });

  it("accepts accurate counts and claims the ledger cannot place", () => {
    for (const text of [
      "The app was rejected three times: twice under 1.1 and once under 1.2.",
      "There are no open rejections.",
      "We have no rejections under Guideline 4.3.",
      "There have been no rejections since the October fix.",
      "This version was rejected once.",
    ]) {
      expect(has({ purpose: "appeal_termination", text, state: st, now }, "history_understated"), text).toBe(false);
    }
  });
});

describe("claims of change for rejections approved without one", () => {
  const rej = LedgerEvent.parse({ id: "ev_g1", type: "outcome", at: "2026-08-01T00:00:00Z", source: "import", bundleId: "com.a", outcome: "rejected", guidelines: ["1.1"] });
  const appeal = LedgerEvent.parse({ id: "ev_g2", type: "message_sent", at: "2026-08-02T00:00:00Z", source: "agent", rejectionId: "ev_g1", purpose: "appeal_review_board", text: "We believe the app complies; please reconsider.", textHash: "h" });
  const ok = LedgerEvent.parse({ id: "ev_g3", type: "outcome", at: "2026-08-10T00:00:00Z", source: "import", bundleId: "com.a", outcome: "approved" });
  const notAware = LedgerEvent.parse({ id: "ev_g4", type: "attestation", at: "2026-10-01T00:00:00Z", source: "human", statement: "I am not aware of the conduct the notice refers to." });
  const text = "Each rejection was answered by changing the app as App Review asked.";

  it("errors when a rejection cleared on appeal is described as fixed by a change", () => {
    const r = lintText({ purpose: "appeal_termination", text, state: foldEvents("T", [rej, appeal, ok, notAware]) });
    const hit = r.issues.find((i) => i.rule === "contradicts_ledger");
    expect(hit?.severity).toBe("error");
    expect(hit?.message).toMatch(/ev_g1.*App Review Board appeal/);
  });

  it("warns, naming the rejection, when an approval has no change on record", () => {
    const r = lintText({ purpose: "appeal_termination", text, state: foldEvents("T", [rej, ok, notAware]) });
    const hit = r.issues.find((i) => i.rule === "contradicts_ledger");
    expect(hit?.severity).toBe("warning");
    expect(hit?.message).toMatch(/ev_g1/);
  });
});

describe("denials, blame and unconfirmed intent", () => {
  const spicyFlags = (id: string, at: string, v: string) =>
    LedgerEvent.parse({
      id,
      type: "config_snapshot",
      at,
      source: "hook",
      kind: "flags_inventory",
      label: "flags",
      hash: `h${v}`,
      summary: "1 remote flag(s)",
      data: { flags: [{ key: "spicy_mode", provider: "firebase", classification: "content-gating", defaultValue: v }] },
    });
  const drifted = foldEvents("T", [
    spicyFlags("ev_s1", "2026-03-01T00:00:00Z", "false"),
    LedgerEvent.parse({ id: "ev_ok", type: "outcome", at: "2026-03-20T00:00:00Z", source: "import", outcome: "approved" }),
    spicyFlags("ev_s2", "2026-04-01T00:00:00Z", "true"),
  ]);
  const ALL = ["review_notes", "reply", "clarification", "appeal_review_board", "appeal_termination"] as const;

  it("stays fast on long dotted runs (credential regex is not quadratic)", () => {
    const start = Date.now();
    lintText({ purpose: "reply", text: "1.".repeat(100_000) });
    lintText({ purpose: "reply", text: `https://${"a.".repeat(100_000)}` });
    expect(Date.now() - start).toBeLessThan(3000);
    // still finds a pasted login and password
    expect(has({ purpose: "review_notes", text: "Demo login: luna@example.com / Review2026!" }, "secret")).toBe(true);
  });

  it("warns when a draft blames the reviewer", () => {
    for (const t of [
      "Honestly the previous reviewer misunderstood the app, but we fixed it anyway.",
      "The reviewer clearly did not understand how the filter works.",
      "As we already explained, the feature is optional.",
      "You missed the settings screen.",
    ]) {
      const i = lintText({ purpose: "reply", text: t }).issues.find((x) => x.rule === "combative_tone");
      expect(i?.severity, t).toBe("warning");
    }
    expect(has({ purpose: "reply", text: "We misunderstood the guideline at first and have now removed the picker." }, "combative_tone")).toBe(false);
  });

  it("errors on a denial of what the scan found in replies, clarifications and appeals, not only in notes", () => {
    const inventory = {
      remoteControls: [{ key: "spicy_mode", provider: "firebase", classification: "content-gating" as const, gates: "outfits" }],
      ota: [{ provider: "expo-updates" }],
    };
    for (const purpose of ALL) {
      for (const t of ["Our app does not use any remote config or feature flags.", "The app does not use over-the-air updates.", "Remote config: none. OTA updates: none."]) {
        expect(has({ purpose, text: t, inventory }, "false_disclosure"), `${purpose}: ${t}`).toBe(true);
      }
    }
    // disclosure_missing stays a review-notes rule
    expect(has({ purpose: "reply", text: "Thank you for the review.", inventory }, "disclosure_missing")).toBe(false);
  });

  it("treats a recorded OTA configuration snapshot as OTA in use when no scan is passed", () => {
    const ota = foldEvents("T", [
      LedgerEvent.parse({ id: "ev_o", type: "config_snapshot", at: "2026-09-01T00:00:00Z", source: "hook", kind: "ota", label: "ota", hash: "h", summary: "OTA update configuration (packages)", data: { packages: ["expo-updates@0.25.0"] } }),
    ]);
    for (const purpose of ALL) {
      expect(has({ purpose, text: "The app does not use over-the-air updates.", state: ota }, "false_disclosure"), purpose).toBe(true);
      expect(has({ purpose, text: "OTA updates: none.", state: ota }, "false_disclosure"), purpose).toBe(true);
    }
    // a current scan that finds no OTA is newer evidence than the snapshot
    expect(has({ purpose: "reply", text: "The app does not use over-the-air updates.", state: ota, inventory: { ota: [] } }, "false_disclosure")).toBe(false);
  });

  it("errors on unconfirmed explanations of intent or good faith, unless the developer attested the same wording", () => {
    const st = foldEvents("T", [
      LedgerEvent.parse({ id: "ev_r", type: "outcome", at: "2026-09-01T00:00:00Z", source: "import", outcome: "rejected", guidelines: ["2.5.19"] }),
      LedgerEvent.parse({ id: "ev_t", type: "termination", at: "2026-10-01T00:00:00Z", source: "import", letter: "Your membership has been terminated under Section 3.2(f)." }),
    ]);
    const lines = [
      "The TestFlight check was legacy code left over from internal testing.",
      "We had no idea the flag changed what reviewers saw.",
      "The reviewer-account branch existed only for QA purposes.",
      "Any difference during review was accidental.",
      "We have always acted in good faith.",
    ];
    for (const purpose of ["appeal_termination", "review_notes", "reply"] as const) {
      for (const t of lines) {
        const r = lintText({ purpose, text: t, state: st });
        expect(r.ok, `${purpose}: ${t}`).toBe(false);
        expect(r.issues.some((i) => i.rule === "intent_characterization" || i.rule === "contradicts_ledger"), `${purpose}: ${t}`).toBe(true);
      }
    }
    // the developer's own recorded wording lifts it
    const attested = foldEvents("T", [
      ...st.events,
      LedgerEvent.parse({ id: "ev_h", type: "attestation", at: "2026-10-02T00:00:00Z", source: "human", statement: "The developer states that the TestFlight check was legacy code left over from internal testing." }),
    ]);
    expect(has({ purpose: "appeal_termination", text: "The developer states that the TestFlight check was legacy code left over from internal testing.", state: attested }, "intent_characterization")).toBe(false);
    // plain facts are not intent claims
    for (const t of [
      "The demo account is only for testing; its credentials are in the sign-in fields.",
      "The image generator applies an output filter to prevent unintended content.",
      "Moderators provide human oversight of reported content.",
      "Earlier builds contained a condition (AppEnvironment.isTestFlight) that hid the Outfit section during review; it has been removed.",
    ]) {
      expect(has({ purpose: "review_notes", text: t, state: st }, "intent_characterization"), t).toBe(false);
    }
  });

  it("does not let quotation marks hide the developer's own denial of a recorded change", () => {
    for (const purpose of ["reply", "appeal_termination"] as const) {
      expect(has({ purpose, text: 'To be clear, "nothing changed after the app was approved."', state: drifted }, "contradicts_ledger"), purpose).toBe(true);
      expect(has({ purpose, text: "Our position is simple: “no server configuration was modified after approval”.", state: drifted }, "contradicts_ledger"), purpose).toBe(true);
    }
    // quoting Apple's recorded wording is still masked
    const withRej = foldEvents("T", [
      ...drifted.events,
      LedgerEvent.parse({ id: "ev_rj", type: "outcome", at: "2026-04-05T00:00:00Z", source: "import", outcome: "rejected", guidelines: ["2.3.1"], reviewerMessage: "We noticed that nothing changed after approval in the binary, but the app's behavior differs." }),
    ]);
    expect(has({ purpose: "reply", text: 'You wrote that "nothing changed after approval in the binary"; the spicy_mode flag was turned on on 2026-04-01.', state: withRej }, "contradicts_ledger")).toBe(false);
    // the same applies to rejection counts
    const rejs = foldEvents("T", [
      LedgerEvent.parse({ id: "ev_a1", type: "outcome", at: "2026-08-01T00:00:00Z", source: "import", outcome: "rejected", guidelines: ["1.1"] }),
      LedgerEvent.parse({ id: "ev_a2", type: "outcome", at: "2026-09-01T00:00:00Z", source: "import", outcome: "rejected", guidelines: ["1.1"] }),
    ]);
    expect(has({ purpose: "appeal_termination", text: 'Our record is "the app has never been rejected".', state: rejs }, "history_understated")).toBe(true);
  });

  it("warns when review notes leave out a review-time condition the fix removed", () => {
    const st = foldEvents("T", [
      LedgerEvent.parse({ id: "ev_r", type: "outcome", at: "2026-10-01T00:00:00Z", source: "import", outcome: "rejected", guidelines: ["1.1"] }),
      LedgerEvent.parse({
        id: "ev_v",
        type: "verification",
        at: "2026-10-02T00:00:00Z",
        source: "agent",
        rejectionId: "ev_r",
        verification: {
          at: "2026-10-02T00:00:00Z",
          tier: "STATIC_CLEAN",
          removedInDiff: ["RemoteFlags.swift:10"],
          removedConditions: [{ rule: "review_gating.environment", file: "Sources/CompanionStudioView.swift", line: 41, condition: "AppEnvironment.isTestFlight", gates: "hid the Outfit section" }],
          residue: [],
          inputPaths: [],
          unverifiable: [],
          summary: "clean",
        },
      }),
    ]);
    const r = lintText({ purpose: "review_notes", text: GOOD_NOTES, state: st });
    const i = r.issues.find((x) => x.rule === "removed_condition_unmentioned");
    expect(i?.severity).toBe("warning");
    expect(i?.excerpt).toContain("AppEnvironment.isTestFlight");
    const disclosed = `${GOOD_NOTES}\n\nEarlier builds hid the Outfit section on TestFlight installs (AppEnvironment.isTestFlight); that condition has been removed.`;
    expect(has({ purpose: "review_notes", text: disclosed, state: st }, "removed_condition_unmentioned")).toBe(false);
    // a denial does not count as the mention
    expect(has({ purpose: "review_notes", text: `${GOOD_NOTES}\n\nNothing about TestFlight changed.`, state: st }, "removed_condition_unmentioned")).toBe(true);
    // the caller can pass conditions found against a base ref directly
    expect(has({ purpose: "review_notes", text: GOOD_NOTES, removedConditions: [{ rule: "review_gating.reviewer_branch", file: "App.swift", line: 3, condition: "isReviewerAccount" }] }, "removed_condition_unmentioned")).toBe(true);
  });
});

describe("admissions, history understatements and reviewer blame", () => {
  it("asks the developer to confirm an admission in any grammatical form, and leaves denials, allegations and questions alone", () => {
    for (const t of [
      "We regret our deceptive practices.",
      "We apologize for our dishonest conduct and the misleading submissions.",
      "We accept that we engaged in a pattern of manipulative behavior.",
      "We are sorry for concealing the outfit feature.",
      "We admit our conduct was dishonest.",
      "We take full responsibility for the deceptive pattern.",
      "We apologize for misleading App Review.",
    ]) {
      const r = lintText({ purpose: "appeal_termination", text: t, state: foldEvents("T", []) });
      const i = r.issues.find((x) => x.rule === "unconfirmed_admission");
      // an error in an appeal: an unconfirmed confession there is what Shoemaker warns against
      expect(i?.severity, t).toBe("error");
      expect(r.ok, t).toBe(false);
      expect(i?.fix, t).toMatch(/appstore-shield attest/);
      expect(i?.fix, t).toMatch(/specific act/);
      // in notes and replies a warning, so a true, diff-backed account is confirmed rather than dropped
      const notes = lintText({ purpose: "reply", text: t, state: foldEvents("T", []) });
      expect(notes.issues.find((x) => x.rule === "unconfirmed_admission")?.severity, t).toBe("warning");
    }
    expect(lintText({ purpose: "appeal_termination", text: "We regret our deceptive practices." }).issues.find((x) => x.rule === "unconfirmed_admission")?.message).toMatch(/labels the conduct without saying what was done/);
    for (const t of [
      "The notice refers to deceptive practices; we ask Apple to identify them.",
      "We did not engage in deceptive practices.",
      "We would like to know which deceptive practices Apple means.",
      "Our notes were not misleading.",
      "We removed the hidden outfit menu in build 41.",
    ]) {
      expect(has({ purpose: "appeal_termination", text: t }, "unconfirmed_admission"), t).toBe(false);
    }
    const confirmed = foldEvents("T", [
      LedgerEvent.parse({ id: "ev_d", type: "attestation", at: "2026-10-01T00:00:00Z", source: "human", statement: "Our review notes for build 34 were dishonest: they did not mention the outfit picker." }),
    ]);
    expect(has({ purpose: "appeal_termination", text: "We admit our conduct was dishonest.", state: confirmed }, "unconfirmed_admission")).toBe(false);
  });

  it("errors on denials of an OTA publish or a flag change the ledger records, in any wording", () => {
    const flags = (id: string, at: string, v: string) =>
      LedgerEvent.parse({ id, type: "config_snapshot", at, source: "hook", kind: "flags_inventory", label: "flags", hash: `h${v}`, summary: "1 remote flag(s)", data: { flags: [{ key: "outfits_v2", provider: "firebase", classification: "content-gating", defaultValue: v }] } });
    const st = foldEvents("T", [
      flags("ev_v1", "2026-08-01T00:00:00Z", "false"),
      LedgerEvent.parse({ id: "ev_ap", type: "outcome", at: "2026-08-20T00:00:00Z", source: "import", outcome: "approved" }),
      flags("ev_v2", "2026-09-01T00:00:00Z", "true"),
      LedgerEvent.parse({ id: "ev_ot", type: "ota_publish", at: "2026-09-15T00:00:00Z", source: "ci", channel: "production" }),
    ]);
    for (const t of [
      "We have not shipped any OTA update since the app was approved.",
      "The outfits_v2 flag has always been off in production.",
      "Everything users saw after approval matched what App Review saw.",
      "Users see exactly what App Review saw.",
      "We never enabled outfits_v2 after approval.",
    ]) {
      const i = lintText({ purpose: "appeal_termination", text: t, state: st }).issues.find((x) => x.rule === "contradicts_ledger");
      expect(i?.severity, t).toBe("error");
    }
    // a factual account of the changes, and a statement about today's value, are not denials
    for (const t of ["On 2026-09-01 the outfits_v2 flag default was turned on; on 2026-09-15 we published an OTA update.", "The outfits_v2 flag is not enabled."]) {
      expect(has({ purpose: "appeal_termination", text: t, state: st }, "contradicts_ledger"), t).toBe(false);
    }
  });

  it("errors on 'first time' and 'only ever' claims that understate the recorded history", () => {
    const e = (id: string, type: LedgerEvent["type"], at: string, f: Record<string, unknown> = {}) => LedgerEvent.parse({ id, type, at, source: "import", ...f });
    const st = foldEvents("T", [
      e("ev_s1", "submission", "2026-08-01T00:00:00Z"),
      e("ev_s2", "submission", "2026-09-01T00:00:00Z"),
      e("ev_r1", "outcome", "2026-08-02T00:00:00Z", { outcome: "rejected", guidelines: ["1.1"] }),
      e("ev_r2", "outcome", "2026-09-02T00:00:00Z", { outcome: "rejected", guidelines: ["1.1"] }),
    ]);
    const now = "2026-10-31T00:00:00Z";
    for (const [purpose, t] of [
      ["reply", "This is the first time our app has been rejected."],
      ["appeal_termination", "This was our first rejection ever."],
      ["appeal_termination", "We have only ever had one submission."],
      ["reply", "We have only ever submitted the app once."],
      ["reply", "This is our first submission."],
    ] as const) {
      expect(lintText({ purpose, text: t, state: st, now }).issues.find((i) => i.rule === "history_understated")?.severity, t).toBe("error");
    }
    for (const t of ["Our first rejection was on 2026-08-02, under Guideline 1.1.", "This is the first time this version was rejected."]) {
      expect(has({ purpose: "appeal_termination", text: t, state: st, now }, "history_understated"), t).toBe(false);
    }
    // one recorded rejection makes "the first time" true
    const one = foldEvents("T", [e("ev_q1", "outcome", "2026-09-02T00:00:00Z", { outcome: "rejected", guidelines: ["1.1"] })]);
    expect(has({ purpose: "reply", text: "This is the first time our app has been rejected.", state: one, now }, "history_understated")).toBe(false);
  });

  it("warns when a rename, a move into a menu or reduced reachability is presented as the response to a rejection", () => {
    for (const t of [
      "In response to the 1.1 rejection, we renamed the Outfits tab to Styles.",
      "In response to the 1.1 rejection, we moved the outfit picker into Settings > Advanced.",
      "In response to the 1.1 rejection, the lingerie option is now only reachable from a long-press menu.",
    ]) {
      for (const purpose of ["review_notes", "reply"] as const) {
        const r = lintText({ purpose, text: t });
        const i = r.issues.find((x) => x.rule === "cosmetic_fix");
        expect(i?.severity, `${purpose}: ${t}`).toBe("warning");
        expect(i?.fix).toMatch(/Remove the capability itself/);
        expect(i?.fix).not.toMatch(/\b(?:rename|move|hide)\b/i);
      }
    }
    for (const t of [
      "To address the 1.2 rejection we moved the report button to every post.",
      "We did not just rename the tab; in response to the rejection we removed the outfit capability.",
      "We renamed the app to remove the word Uncensored, in response to the 2.3.7 rejection.",
      "We renamed the Settings screen to Preferences.",
    ]) {
      expect(has({ purpose: "review_notes", text: t }, "cosmetic_fix"), t).toBe(false);
    }
    // once the capability's removal is verified STATIC_CLEAN the rename is detail, not the fix
    const t = "In response to the 1.1 rejection, we renamed the Outfits tab to Styles.";
    expect(has({ purpose: "review_notes", text: t, strongestTier: { tier: "STATIC_CLEAN" } }, "cosmetic_fix")).toBe(false);
    expect(has({ purpose: "review_notes", text: t, strongestTier: { tier: "RESIDUE_FOUND" } }, "cosmetic_fix")).toBe(true);
  });

  it("errors when a draft says the reviewer was wrong, in the third person too", () => {
    for (const t of ["Your reviewer was clearly mistaken about the filter.", "The reviewer is simply wrong about the outfit picker.", "App Review was incorrect in this case."]) {
      expect(lintText({ purpose: "reply", text: t }).issues.find((i) => i.rule === "combative_tone")?.severity, t).toBe("error");
    }
    expect(has({ purpose: "reply", text: "We were mistaken about the guideline and have removed the picker." }, "combative_tone")).toBe(false);
  });
});

describe("evasive fixes, returning content and unsupported quotes", () => {
  const ev = (o: Record<string, unknown>) => LedgerEvent.parse({ source: "import", ...o });
  const openRejection = foldEvents("T", [
    ev({ id: "r1", type: "outcome", outcome: "rejected", at: "2026-10-20T18:00:00Z", guidelines: ["1.1"], reviewerMessage: "the app lets users generate images of the character in lingerie" }),
  ]);
  const afterOta = foldEvents("T", [
    ev({ id: "r1", type: "outcome", outcome: "rejected", at: "2026-08-03T18:00:00Z", bundleId: "app.luna", guidelines: ["1.1"], reviewerMessage: "the app lets users dress the AI character in sexually suggestive outfits" }),
    ev({ id: "s1", type: "submission", at: "2026-10-05T10:00:00Z", bundleId: "app.luna" }),
    ev({ id: "a1", type: "outcome", outcome: "approved", at: "2026-10-06T14:27:00Z", bundleId: "app.luna" }),
    ev({ id: "o1", type: "ota_publish", at: "2026-10-20T10:00:00Z", channel: "production", message: "restore outfit catalog", source: "agent" }),
  ]);

  it("errors on a rename or relocation presented as the fix while the rejection is open and unverified, in every purpose but clarification", () => {
    const cases = [
      "To address the Guideline 1.1 rejection, we renamed the Lingerie category to Style 7.",
      "To address the rejection, the lingerie outfits are now only available from Settings > Labs.",
      "We updated the outfit picker in response to App Review's feedback. The Lingerie category is now called Evening.",
      "To resolve the rejection, the lingerie option is hidden until the user completes onboarding.",
    ];
    for (const purpose of ["review_notes", "reply", "appeal_review_board"] as const) {
      for (const text of cases) {
        const r = lintText({ purpose, text, state: openRejection });
        expect(r.issues.find((i) => i.rule === "cosmetic_fix")?.severity, `${purpose}: ${text}`).toBe("error");
        expect(r.ok, `${purpose}: ${text}`).toBe(false);
      }
    }
    // without a ledger it cannot know the rejection is open: still flagged, as a warning
    expect(lintText({ purpose: "reply", text: cases[0]! }).issues.find((i) => i.rule === "cosmetic_fix")?.severity).toBe("warning");
    // a move tied to the rejection only by a neighbouring sentence, naming nothing it rejected, stays a warning
    const neighbour = lintText({ purpose: "review_notes", text: "Prior rejection: Guideline 1.1 on 2026-10-20. We moved the language picker into the Settings menu.", state: openRejection });
    expect(neighbour.issues.find((i) => i.rule === "cosmetic_fix")?.severity).toBe("warning");
    // an age gate in front of content rejected under 1.1 is the same content behind a gate
    expect(lintText({ purpose: "reply", text: "To comply with Guideline 1.1, lingerie outfits now require an 18+ age confirmation.", state: openRejection }).issues.find((i) => i.rule === "cosmetic_fix")?.severity).toBe("error");
  });

  it("errors on rejected content announced as coming back, in every purpose", () => {
    for (const purpose of ["review_notes", "reply", "appeal_termination"] as const) {
      for (const text of [
        "In response to the rejection, lingerie outfits are disabled in this build and will return in a future update.",
        "The lingerie outfits are temporarily removed.",
        "We will re-enable the outfit catalog once the update is approved.",
        "Lingerie outfits are switched off until after review.",
      ]) {
        const r = lintText({ purpose, text });
        expect(r.issues.find((i) => i.rule === "deferred_return")?.severity, `${purpose}: ${text}`).toBe("error");
      }
    }
    for (const text of [
      "We will return to you with the details you asked for.",
      "We removed the outfit picker; it will not return.",
      "We have no plans to restore the outfit catalog.",
      "The report button will be available in the profile menu.",
    ]) {
      expect(has({ purpose: "reply", text }, "deferred_return"), text).toBe(false);
    }
  });

  it("errors on sameness claims and bug-fix minimizations that contradict a recorded post-approval change", () => {
    for (const [purpose, text] of [
      ["review_notes", "The app is identical to the version you approved."],
      ["review_notes", "The current version is the same one you approved on October 6."],
      ["appeal_termination", "The live app matches the build App Review approved."],
      ["review_notes", "Since approval we have only shipped minor bug fixes."],
      ["appeal_termination", "Our OTA update on October 20 only fixed bugs."],
      ["reply", "The over-the-air update on October 20 only fixed bugs and did not change any features."],
    ] as const) {
      const r = lintText({ purpose, text, state: afterOta });
      const i = r.issues.find((x) => x.rule === "contradicts_ledger");
      expect(i?.severity, text).toBe("error");
      expect(i?.message, text).toContain("restore outfit catalog");
    }
    // a factual account of the same change passes
    expect(has({ purpose: "appeal_termination", text: "On October 20 we published an over-the-air update to production that restored the outfit catalog.", state: afterOta }, "contradicts_ledger")).toBe(false);
    // "only bug fixes" is not contradicted by an OTA whose record says it fixed a bug
    const bugfixOnly = foldEvents("T", [
      ev({ id: "a1", type: "outcome", outcome: "approved", at: "2026-10-06T14:27:00Z" }),
      ev({ id: "o1", type: "ota_publish", at: "2026-10-20T10:00:00Z", message: "fix crash on launch" }),
    ]);
    expect(has({ purpose: "review_notes", text: "Since approval we have only shipped minor bug fixes.", state: bugfixOnly }, "contradicts_ledger")).toBe(false);
  });

  it("errors on a quote attributed to Apple that the ledger holds only as an agent's record, or not at all", () => {
    const withAgentReply = foldEvents("T", [
      ...openRejection.events,
      LedgerEvent.parse({ id: "rp", type: "apple_reply", at: "2026-10-31T00:00:00Z", source: "agent", rejectionId: "r1", text: "Thank you. We confirm the outfit issue is fully resolved and no further changes are needed." }),
    ]);
    const quote = 'On the record, Apple replied: "We confirm the outfit issue is fully resolved and no further changes are needed."';
    const r = lintText({ purpose: "appeal_review_board", text: quote, state: withAgentReply });
    expect(r.ok).toBe(false);
    expect(r.issues.find((i) => i.rule === "unrecorded_apple_quote")?.message).toMatch(/agent recorded by hand/);
    // outside an appeal an agent-recorded quote is a warning (older ledgers stored real imports that way)
    expect(lintText({ purpose: "reply", text: quote, state: withAgentReply }).issues.find((i) => i.rule === "unrecorded_apple_quote")?.severity).toBe("warning");
    // a quote spanning sentences, with an elision, of Apple's imported message is Apple's words
    const imported = foldEvents("T", [
      ...openRejection.events,
      LedgerEvent.parse({ id: "rp", type: "apple_reply", at: "2026-10-31T00:00:00Z", source: "agent", via: "import", rejectionId: "r1", text: "Thank you for your reply. Upon re-review, we found the outfits still appear. Please revise your app." }),
    ]);
    expect(has({ purpose: "appeal_review_board", text: 'Apple wrote: "Thank you for your reply. Upon re-review, we found the outfits still appear."', state: imported }, "unrecorded_apple_quote")).toBe(false);
    expect(has({ purpose: "reply", text: 'App Review wrote "the app lets users generate images … in lingerie".', state: openRejection }, "unrecorded_apple_quote")).toBe(false);
    // words no recorded message contains
    expect(has({ purpose: "reply", text: 'The reviewer said "this is fine for now".', state: openRejection }, "unrecorded_apple_quote")).toBe(true);
    expect(has({ purpose: "reply", text: '"This is fine for now," the reviewer said.', state: openRejection }, "unrecorded_apple_quote")).toBe(true);
    // a quote of the app's own UI is not attributed to Apple
    expect(has({ purpose: "review_notes", text: 'Tap "Report this image" to send a report.', state: openRejection }, "unrecorded_apple_quote")).toBe(false);
  });

  it("tells the drafter to delete, not disclose, a flag a block finding says to delete", () => {
    const inventory = { remoteControls: [{ key: "nsfw_presets", provider: "Firebase Remote Config", classification: "content-gating" as const, gates: "adult presets", file: "src/flags.ts", line: 4 }], ota: [], aiServices: [] };
    const findings = [{ rule: "remote_config.content_gating", severity: "block" as const, guideline: "2.5.19", file: "src/flags.ts", line: 4, why: 'Firebase key "nsfw_presets" (read at src/flags.ts:4) gates adult presets.' }];
    const fix = notes("Changes in 2.0: a new onboarding screen for first launch with three steps.", { inventory, findings }).issues.find((i) => i.rule === "disclosure_missing")?.fix;
    expect(fix).toMatch(/^Delete nsfw_presets/);
    expect(fix).toMatch(/disclosure does not fix it/);
    expect(fix).not.toMatch(/^Disclose/);
    // without findings, the fix still warns that a block finding means delete
    const hedged = notes("Changes in 2.0: a new onboarding screen for first launch with three steps.", { inventory }).issues.find((i) => i.rule === "disclosure_missing")?.fix;
    expect(hedged).toMatch(/delete it and the content it gates/);
  });

  it("stays fast on 64 KB of pathological input", () => {
    const units = ["We ", "our ", "a-", "the ", "not ", "rejected ", "removed ", '"', "only ", "renamed ", "since approval ", "Apple replied ", "will ", "identical ", "temporarily "];
    const slow: string[] = [];
    for (const u of units) {
      const text = u.repeat(Math.floor(64_000 / u.length));
      for (const purpose of ["review_notes", "appeal_termination"] as const) {
        const t = performance.now();
        lintText({ purpose, text, state: afterOta, inventory: { remoteControls: [], ota: [{ provider: "expo-updates" }] } });
        const dt = performance.now() - t;
        if (dt > 1500) slow.push(`${JSON.stringify(u)} ${purpose}: ${dt.toFixed(0)}ms`);
      }
    }
    expect(slow).toEqual([]);
  }, 120_000);
});

describe("review-specific behavior, substitutes and compliance claims", () => {
  const ev = (o: Record<string, unknown>) => LedgerEvent.parse({ source: "import", ...o });
  // An approval, then a content-adding OTA only an agent recorded, then an open 1.1 rejection naming swimwear.
  const swim = foldEvents("T", [
    ev({ id: "a1", type: "outcome", outcome: "approved", at: "2026-08-06T14:27:00Z" }),
    ev({ id: "o1", type: "ota_publish", at: "2026-09-20T10:00:00Z", channel: "production", message: "add swimwear outfit pack", source: "agent" }),
    ev({ id: "r1", type: "outcome", outcome: "rejected", at: "2026-10-20T18:00:00Z", guidelines: ["1.1"], reviewerMessage: "the app lets users dress the character in swimwear and lingerie outfits" }),
  ]);
  const severityOf = (purpose: LintInput["purpose"], text: string, rule: string, state = swim) => lintText({ purpose, text, state }).issues.find((i) => i.rule === rule)?.severity;

  it("errors on a review-specific difference written as the app's behavior, in every purpose", () => {
    for (const purpose of ["review_notes", "reply", "clarification", "appeal_termination"] as const) {
      for (const text of [
        "The swimwear outfits are no longer shown during App Review.",
        "The swimwear pack is now hidden for reviewers and only appears for returning users.",
        "The app detects review devices and disables the outfit picker.",
        "Outfits are shown only to reviewers in the demo account.",
      ]) {
        const r = lintText({ purpose, text, state: swim });
        const i = r.issues.find((x) => x.rule === "review_specific_behavior");
        expect(i?.severity, `${purpose}: ${text}`).toBe("error");
        expect(i?.message).toMatch(/2\.5\.19/);
        expect(i?.message).toMatch(/3\.2\(e\)/);
        expect(i?.fix).toMatch(/^Remove the review-specific behavior/);
        expect(i?.fix).not.toMatch(/\b(?:rename|move|hide)\b/i);
      }
    }
    // an account of a removed condition, a statement that the difference is gone, and ordinary reviewer instructions are not
    for (const text of [
      "Earlier builds contained a condition (isTestFlight) that hid the outfits during review; it has been removed.",
      "We removed a TestFlight check that turned off the outfit picker for App Review; the picker is now the same for all users.",
      "The outfit picker is no longer hidden from App Review installs.",
      "The app does not behave differently for App Review.",
      "The report button is visible to reviewers on every post.",
      "The new feature is available for review under Settings > Labs.",
      "To reach the filter, reviewers can tap Create.",
    ]) {
      expect(has({ purpose: "review_notes", text, state: swim }, "review_specific_behavior"), text).toBe(false);
    }
  });

  it("errors on a gate, opt-in, region limit or substitute for rejected content while the rejection is open", () => {
    for (const text of [
      "Swimwear outfits now only appear after the user unlocks level 10.",
      "We made the swimwear pack opt-in from the profile screen.",
      "The swimwear pack is now limited to users outside the United States.",
      "We replaced the swimwear pack with a beachwear pack.",
      "To comply with Guideline 1.1, lingerie outfits now require an 18+ age confirmation.",
    ]) {
      const i = lintText({ purpose: "reply", text, state: swim }).issues.find((x) => x.rule === "cosmetic_fix");
      expect(i?.severity, text).toBe("error");
      expect(i?.fix).toMatch(/Remove the capability itself/);
      // verified removal clears it: the gate is then detail beside a real fix
      expect(has({ purpose: "reply", text, state: swim, strongestTier: { tier: "STATIC_CLEAN" } }, "cosmetic_fix"), text).toBe(false);
    }
    // an age gate answers an age-rating rejection, and a gate on content no open rejection names is a product change
    const ageRating = foldEvents("T", [ev({ id: "r2", type: "outcome", outcome: "rejected", at: "2026-10-20T18:00:00Z", guidelines: ["2.3.8"], reviewerMessage: "the age rating does not match the swimwear content" })]);
    expect(has({ purpose: "reply", text: "Swimwear outfits now require an 18+ age confirmation.", state: ageRating }, "cosmetic_fix")).toBe(false);
    for (const text of ["Character chat is limited to 20 messages per day.", "We replaced the image model with one that applies a safety filter.", "The new journal theme is opt-in from Settings."]) {
      expect(has({ purpose: "reply", text, state: swim }, "cosmetic_fix"), text).toBe(false);
    }
  });

  it("errors on claims of disclosure, bug-fix minimizations and denials the recorded OTA contradicts", () => {
    for (const purpose of ["appeal_termination", "reply"] as const) {
      for (const text of [
        "We have always disclosed every change to App Review.",
        "Every change since approval was disclosed in our notes.",
        "Our updates have been fully transparent to App Review.",
        "All post-approval updates were bug fixes.",
        "We have not added any content since your approval.",
        "We have not shipped any new content outside of reviewed builds.",
        "Since approval we only tweaked the catalog.",
      ]) {
        const i = lintText({ purpose, text, state: swim }).issues.find((x) => x.rule === "contradicts_ledger");
        expect(i?.severity, `${purpose}: ${text}`).toBe("error");
        expect(i?.message, text).toContain("o1");
      }
    }
    // disclosure the developer confirmed pasting satisfies the claim; an agent's draft alone does not
    const notes = ev({ id: "n1", type: "message_sent", at: "2026-09-21T10:00:00Z", purpose: "review_notes", text: "On September 20 we published an OTA update that added the swimwear outfit pack.", textHash: "h", source: "agent" });
    const drafted = foldEvents("T", [...swim.events, notes]);
    expect(has({ purpose: "reply", text: "We have always disclosed every change to App Review.", state: drafted }, "contradicts_ledger")).toBe(true);
    const pasted = foldEvents("T", [...drafted.events, ev({ id: "h1", type: "attestation", at: "2026-09-21T11:00:00Z", source: "human", statement: "I pasted the Notes for Review n1 into App Store Connect" })]);
    expect(has({ purpose: "reply", text: "We have always disclosed every change to App Review.", state: pasted }, "contradicts_ledger")).toBe(false);
    // a disclosure act, an aim, and "add" in "addressed" are not claims or denials
    for (const text of ["We disclose all remote flags below.", "We aim to be transparent about the changes listed below.", "We have not addressed the crash yet."]) {
      expect(has({ purpose: "reply", text, state: swim }, "contradicts_ledger"), text).toBe(false);
    }
  });

  it("errors on assertions of compliance, safety or approval, whatever the evidence tier", () => {
    const hash = "abcdef0123456789".repeat(4);
    const probed = { tier: "PROBED" as const, probe: { total: 60, blocked: 60, resultsHash: hash }, buildClean: true };
    for (const purpose of ["review_notes", "reply", "appeal_termination"] as const) {
      for (const text of [
        "This version is compliant with Guideline 1.1.",
        "This build is safe and will pass review.",
        "We are confident the app now meets all App Store guidelines.",
        "Apple already approved the outfit feature on August 6, so it complies with the guidelines.",
      ]) {
        const i = lintText({ purpose, text, state: swim, strongestTier: probed }).issues.find((x) => x.rule === "compliance_assertion");
        expect(i?.severity, `${purpose}: ${text}`).toBe("error");
        expect(i?.fix).toMatch(/only App Review decides compliance/);
      }
    }
    for (const text of ["To comply with Guideline 1.1, we removed the outfit picker and its assets.", "Could you confirm whether the build is compliant with 1.1?", "It is safe to delete the demo data after review.", "We do not claim the app is compliant; App Review decides that."]) {
      expect(has({ purpose: "reply", text, state: swim }, "compliance_assertion"), text).toBe(false);
    }
  });

  it("errors in an appeal on admitting a change only an agent recorded, until the developer confirms it", () => {
    for (const text of ["We admit that we used an OTA update to add content after approval.", "Our mistake was shipping the swimwear pack over the air without review."]) {
      const i = lintText({ purpose: "appeal_termination", text, state: swim }).issues.find((x) => x.rule === "unconfirmed_admission");
      expect(i?.severity, text).toBe("error");
      expect(i?.message).toContain("o1");
      expect(i?.fix).toMatch(/appstore-shield attest/);
    }
    // the same OTA recorded by CI is the ledger's fact, not the agent's word
    const ci = foldEvents("T", swim.events.map((e) => (e.id === "o1" ? { ...e, source: "ci" as const } : e)));
    expect(has({ purpose: "appeal_termination", text: "We admit that we used an OTA update to add content after approval.", state: ci }, "unconfirmed_admission")).toBe(false);
    // and the developer's own statement naming the event confirms it
    const confirmed = foldEvents("T", [...swim.events, ev({ id: "h2", type: "attestation", at: "2026-10-25T00:00:00Z", source: "human", statement: "The OTA update o1 on September 20 added the swimwear outfit pack." })]);
    expect(has({ purpose: "appeal_termination", text: "We admit that we used an OTA update to add content after approval.", state: confirmed }, "unconfirmed_admission")).toBe(false);
  });

  it("errors on plain-English denials of remote control and of sending data to AI services the scan found", () => {
    const inventory = {
      remoteControls: [{ key: "chat_daily_limit", provider: "Firebase Remote Config", classification: "content-gating" as const, gates: "daily chat limit", file: "Sources/Flags.swift", line: 3 }],
      ota: [],
      aiServices: ["OpenAI"],
      aiSinks: [{ provider: "OpenAI", file: "Sources/SelfieAvatar.swift", line: 11 }],
    };
    for (const purpose of ["review_notes", "reply"] as const) {
      const remote = lintText({ purpose, text: "Nothing in the app is controlled remotely.", inventory }).issues.find((i) => i.rule === "false_disclosure");
      expect(remote?.severity, purpose).toBe("error");
      expect(remote?.message).toContain("chat_daily_limit");
      const ai = lintText({ purpose, text: "Selfies are processed on device and are not sent to any third party.", inventory }).issues.find((i) => i.rule === "false_disclosure");
      expect(ai?.severity, purpose).toBe("error");
      expect(ai?.message).toContain("OpenAI at Sources/SelfieAvatar.swift:11");
    }
    // a sentence naming the provider discloses it; "on device" alone may be true of one feature, so it warns
    expect(has({ purpose: "reply", text: "Face detection runs on device; the selfie is sent to OpenAI to create the avatar.", inventory }, "false_disclosure")).toBe(false);
    expect(lintText({ purpose: "reply", text: "Voice input is processed on device.", inventory }).issues.find((i) => i.rule === "false_disclosure")?.severity).toBe("warning");
    expect(has({ purpose: "reply", text: "Selfies are not sent to any third party.", inventory: { ...inventory, aiServices: [] } }, "false_disclosure")).toBe(false);
  });

  it("stays fast on 64 KB of input built from the new rules' words", () => {
    const inventory = { remoteControls: [], ota: [{ provider: "expo-updates" }], aiServices: ["OpenAI"] };
    const slow: string[] = [];
    for (const u of ["hidden ", "for reviewers ", "only ", "replaced ", "disclosed ", "every change ", "compliant ", "nothing ", "not sent ", "limited to ", "remotely ", "we admit "]) {
      const text = u.repeat(Math.floor(64_000 / u.length));
      for (const purpose of ["review_notes", "appeal_termination"] as const) {
        const t = performance.now();
        lintText({ purpose, text, state: swim, inventory });
        const dt = performance.now() - t;
        if (dt > 1500) slow.push(`${JSON.stringify(u)} ${purpose}: ${dt.toFixed(0)}ms`);
      }
    }
    expect(slow).toEqual([]);
  }, 120_000);
});

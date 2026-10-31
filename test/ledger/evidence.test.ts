import { describe, expect, it } from "vitest";
import { evidencePack } from "../../src/ledger/evidence.js";
import { LedgerEvent } from "../../src/ledger/schema.js";
import { foldEvents } from "../../src/ledger/store.js";

let n = 0;
function ev(type: LedgerEvent["type"], at: string, fields: Record<string, unknown> = {}, source = "agent"): LedgerEvent {
  n += 1;
  return LedgerEvent.parse({ id: `ev_e${n}`, type, at, source, ...fields });
}

const NOW = "2026-10-31T00:00:00Z";
const r1 = ev("outcome", "2026-06-01T00:00:00Z", { bundleId: "com.a", outcome: "rejected", guidelines: ["1.1.4"], reviewerMessage: "We noticed lingerie outfits." });
const approval = ev("outcome", "2026-06-10T00:00:00Z", { bundleId: "com.a", outcome: "approved" }, "import");
const r2 = ev("outcome", "2026-10-01T00:00:00Z", { bundleId: "com.a", outcome: "rejected", guidelines: ["1.2"], reviewerMessage: "We noticed users can still request lingerie via free text." });
const events = [
  ev("app", "2026-01-01T00:00:00Z", { bundleId: "com.a", name: "Dream GF" }),
  r1,
  approval,
  r2,
  ev("interpretation", "2026-10-01T02:00:00Z", { rejectionId: r2.id, text: "Users must not be able to produce sexualized images of the companion by any input path." }),
  ev("verification", "2026-10-03T00:00:00Z", {
    rejectionId: r2.id,
    verification: {
      at: "2026-10-03T00:00:00Z",
      tier: "STATIC_CLEAN",
      removedInDiff: ["src/Outfits.swift:12"],
      residue: [],
      inputPaths: [{ inputPath: "outfit picker", blocked: true, evidence: [] }, { inputPath: "free-text prompt", blocked: false, evidence: [] }],
      unverifiable: ["server prompt outside repo"],
      summary: "No residue in source.",
    },
  }),
  ev("attestation", "2026-10-03T01:00:00Z", { rejectionId: r2.id, statement: "the server prompt rejects clothing-change requests." }, "human"),
  ev("config_snapshot", "2026-07-01T00:00:00Z", { kind: "server_prompt", label: "p", hash: "h", summary: "s" }),
  ev("submission", "2026-09-20T00:00:00Z", { bundleId: "com.a" }),
  ev("submission", "2026-10-02T00:00:00Z", { bundleId: "com.a" }),
];
const state = foldEvents("T", events);
const ids = new Set(state.events.map((e) => e.id));

describe("evidencePack", () => {
  it("review_notes: prior rejections with dates and guidelines, remediation facts, 4000-byte budget, no hypotheses", () => {
    const pack = evidencePack(state, "review_notes", {
      rejectionId: r2.id,
      inventory: { remoteControls: [{ key: "nsfw_mode", provider: "firebase", classification: "content-gating", gates: "outfit list" }], ota: [{ provider: "expo-updates" }], aiServices: ["fal.ai"] },
    });
    expect(pack.byteBudget).toBe(4000);
    expect(pack.privateHypotheses).toBeUndefined();
    const texts = pack.facts.map((f) => f.text).join("\n");
    expect(texts).toContain("Rejected on 2026-10-01 (com.a) under Guideline 1.2");
    expect(texts).toContain("Rejected on 2026-06-01 (com.a) under Guideline 1.1.4");
    expect(texts).toContain("tier STATIC_CLEAN");
    expect(texts).toContain("NOT verified as blocked: free-text prompt");
    expect(texts).toContain("The developer states: the server prompt");
    expect(texts).toContain('flag "nsfw_mode"');
    expect(texts).toContain("expo-updates");
    expect(texts).toContain("fal.ai");
    for (const f of pack.facts) if (f.eventId) expect(ids.has(f.eventId)).toBe(true);
    expect(pack.facts.filter((f) => f.kind === "inventory").every((f) => !f.eventId)).toBe(true);
    const sections = pack.scaffold.map((s) => s.section);
    expect(sections).toEqual(expect.arrayContaining(["Prior rejections", "What was removed", "What stays and why", "Remote controls, OTA and AI services", "Moderation and UGC safeguards", "How to test", "Demo account"]));
    const demo = pack.scaffold.find((s) => s.section === "Demo account");
    expect(demo?.guidance).toMatch(/Never paste real credentials/);
  });

  it("clarification: calm specific question, offer of a call, reviewer excerpt, no hypotheses", () => {
    const pack = evidencePack(state, "clarification", { rejectionId: r2.id });
    expect(pack.byteBudget).toBeNull();
    expect(pack.privateHypotheses).toBeUndefined();
    expect(pack.facts.some((f) => f.kind === "reviewer_message")).toBe(true);
    const guidance = pack.scaffold.map((s) => s.guidance).join(" ");
    expect(guidance).toMatch(/which specific feature, generated output, or screen/);
    expect(guidance).toMatch(/call/);
  });

  it("appeal_review_board: reply in ASC first, cite terms, rebut each instance", () => {
    const pack = evidencePack(state, "appeal_review_board", {});
    expect(pack.scaffold.map((s) => s.section)).toEqual([
      "Precondition: reply in App Store Connect first",
      "Cite the specific terms",
      "Rebut each listed instance",
      "What was changed",
      "Request",
    ]);
    expect(pack.privateHypotheses?.neverPaste).toBe(true);
  });

  it("appeal_termination with no confirmed mistakes and no statement from the developer: asks them, never denies for them", () => {
    const pack = evidencePack(state, "appeal_termination", { now: NOW });
    const sections = pack.scaffold.map((s) => s.section);
    expect(sections).not.toContain("Apology (confirmed mistakes only)");
    expect(sections).not.toContain("Good-faith record");
    const order = ["Channel", "Developer confirmation needed", "Rejection, fix and approval sequence", "Improvements going forward", "Ask Apple to identify the conduct"].map((s) => sections.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(pack.scaffold.map((s) => s.guidance).join(" ")).not.toMatch(/State plainly that the developer is not aware/);
    expect(pack.scaffold.find((s) => s.section === "Developer confirmation needed")?.guidance).toMatch(/appstore-shield attest/);
  });

  it("appeal_termination: good-faith record only after the developer records non-awareness in a terminal", () => {
    const notAware = ev("attestation", "2026-10-05T00:00:00Z", { statement: "I am not aware of any manipulative conduct in my apps." }, "human");
    const agentSaid = ev("attestation", "2026-10-05T00:00:00Z", { statement: "The developer is not aware of the conduct." }, "agent");
    expect(evidencePack(foldEvents("T", [...events, agentSaid]), "appeal_termination", { now: NOW }).scaffold.map((s) => s.section)).not.toContain("Good-faith record");
    const pack = evidencePack(foldEvents("T", [...events, notAware]), "appeal_termination", { now: NOW });
    const good = pack.scaffold.find((s) => s.section === "Good-faith record")?.guidance ?? "";
    expect(good).toMatch(/not aware of the conduct/);
    // Each rejection is described from its own events; an approval alone is not shown as a change.
    expect(good).not.toMatch(/as App Review asked|each rejection was answered/i);
    expect(good).toMatch(/Rejection ev_e1 \(2026-06-01, Guideline 1\.1\.4\) was approved on 2026-06-10; the ledger records no change for it/);
    expect(good).toMatch(/Rejection ev_e3 \(2026-10-01, Guideline 1\.2\): the app was changed \(verification tier STATIC_CLEAN\)/);
    const open = ev("outcome", "2026-10-20T00:00:00Z", { bundleId: "com.a", outcome: "rejected", guidelines: ["1.1"] }, "import");
    const withOpen = evidencePack(foldEvents("T", [...events, notAware, open]), "appeal_termination", { now: NOW });
    const g2 = withOpen.scaffold.find((s) => s.section === "Good-faith record")?.guidance ?? "";
    expect(g2).toMatch(/List the open rejections as open/);
    expect(g2).not.toMatch(/as App Review asked/);
    expect(withOpen.warnings.join(" ")).toContain(open.id);
  });

  it("appeal_termination: a content flag flipped after approval is a fact the letter must state, not a private guess", () => {
    const flags = (v: string) => ({
      kind: "flags_inventory",
      label: "flags",
      hash: `h${v}`,
      summary: "1 remote flag(s)",
      data: { flags: [{ key: "lingerie_outfits", provider: "firebase", classification: "content-gating", defaultValue: v }] },
    });
    const before = ev("config_snapshot", "2026-09-01T00:00:00Z", flags("false"));
    const ok = ev("outcome", "2026-09-02T00:00:00Z", { outcome: "approved" }, "import");
    const flipped = ev("config_snapshot", "2026-09-20T00:00:00Z", flags("true"));
    const same = ev("config_snapshot", "2026-09-21T00:00:00Z", flags("true"));
    const st = foldEvents("T", [before, ok, flipped]);
    const pack = evidencePack(st, "appeal_termination", { letter: "pattern of manipulative or misleading behavior", now: NOW });
    const fact = pack.facts.find((f) => f.kind === "post_approval_change");
    expect(fact?.eventId).toBe(flipped.id);
    expect(fact?.text).toMatch(/lingerie_outfits.*false → true/);
    expect(pack.scaffold.map((s) => s.section)).toContain("Recorded changes after approval");
    expect(pack.warnings.join(" ")).toMatch(/must not deny them/);
    const hyp = pack.privateHypotheses?.items.find((i) => i.category.startsWith("Post-review modification"));
    expect(hyp?.supportingEventIds).toEqual([flipped.id]);
    // a later snapshot with the same content is not a second change; an unchanged one is none at all
    expect(evidencePack(foldEvents("T", [before, ok, flipped, same]), "reply", {}).facts.filter((f) => f.kind === "post_approval_change")).toHaveLength(1);
    const unchanged = ev("config_snapshot", "2026-09-20T00:00:00Z", flags("false"));
    expect(evidencePack(foldEvents("T", [before, ok, unchanged]), "appeal_termination", { now: NOW }).facts.some((f) => f.kind === "post_approval_change")).toBe(false);
  });

  it("appeal_termination: Shoemaker order and private ranked hypotheses with event ids", () => {
    const letter = "Your membership has been terminated under Section 3.2(f) for a pattern of manipulative or misleading behavior, including bait-and-switch.";
    const mistake = ev("attestation", "2026-10-04T00:00:00Z", { statement: "The developer states that we made a mistake: the notes for build 34 did not mention the outfit picker." }, "human");
    const pack = evidencePack(foldEvents("T", [...events, mistake]), "appeal_termination", { letter, now: NOW });
    const sections = pack.scaffold.map((s) => s.section);
    const order = ["Apology (confirmed mistakes only)", "How it happened", "Rejection, fix and approval sequence", "Prevention plan", "Ask Apple to identify the conduct"].map((s) => sections.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(pack.scaffold.map((s) => s.guidance).join(" ")).toMatch(/counsel/);
    expect(pack.facts.some((f) => f.kind === "letter")).toBe(true);
    const h = pack.privateHypotheses;
    expect(h?.neverPaste).toBe(true);
    expect(h?.warning).toMatch(/Never paste/);
    expect(h?.items.length).toBeGreaterThan(0);
    expect(h?.items.map((i) => i.rank)).toEqual(h?.items.map((_, i) => i + 1));
    const cats = h?.items.map((i) => i.category).join("|") ?? "";
    expect(cats).toContain("Repeated objectionable-content");
    expect(cats).toContain("Post-review modification");
    for (const item of h?.items ?? []) for (const id of item.supportingEventIds) expect(ids.has(id)).toBe(true);
  });

  it("words store surfaces and blocked paths so notes cannot overstate what was checked", () => {
    const rej = ev("outcome", "2026-10-01T00:00:00Z", { outcome: "rejected", guidelines: ["1.2"] }, "import");
    const spec = ev("residue_spec", "2026-10-02T00:00:00Z", { rejectionId: rej.id, spec: { feature: "lingerie", capability: "no lingerie images", metadataSurfaces: ["App Store screenshots"] } });
    const ver = ev("verification", "2026-10-03T00:00:00Z", {
      rejectionId: rej.id,
      verification: {
        at: "2026-10-03T00:00:00Z",
        tier: "STATIC_CLEAN",
        removedInDiff: [],
        residue: [],
        inputPaths: [
          { inputPath: "free-text → ImageGenerator", blocked: true, evidence: ["image moderation (moderateImage()) at Sources/AI/ImageGenerator.swift:22 (guards Sources/AI/ImageGenerator.swift)"] },
          { inputPath: "picker", blocked: true, evidence: ["No AI generation call or prompt-building backend call remains in the repo."] },
          {
            inputPath: "outfit picker (CompanionStudioView.swift:42) → generate",
            blocked: true,
            evidence: [
              "Traced evidence still present: Sources/Views/CompanionStudioView.swift:38",
              "strict Google Gemini safety setting at Sources/AI/CompanionChat.swift:31 (BLOCK_LOW_AND_ABOVE) (guards Sources/AI/CompanionChat.swift)",
              "strict Replicate safety setting at Sources/AI/ImageGenerator.swift:20 (disable_safety_checker: false) (guards Sources/AI/ImageGenerator.swift)",
            ],
          },
          { inputPath: "old picker", blocked: true, evidence: ["Traced evidence is no longer in the tree: Sources/Views/OldPicker.swift:3"] },
          { inputPath: "legacy path", blocked: true, evidence: ["text moderation (moderateText() at Sources/AI/Mod.swift:4"] },
          {
            inputPath: "style picker",
            blocked: true,
            evidence: [
              "The path names no generation call, so all 2 generation calls in the repo had to be guarded; each filter below guards only the call named after it, not this path as a whole.",
              ...Array.from({ length: 6 }, (_, i) => `strict Google Gemini safety setting at Sources/AI/Chat${i}.swift:31 (${"BLOCK_LOW_AND_ABOVE ".repeat(4).trim()}) (guards Sources/AI/Chat${i}.swift)`),
            ],
          },
        ],
        unverifiable: [],
        probe: { total: 60, blocked: 60, resultsHash: "f".repeat(64) },
        summary: "s",
      },
    });
    const s2 = foldEvents("T", [rej, spec, ver]);
    const pack = evidencePack(s2, "review_notes", {
      rejectionId: rej.id,
      findings: [
        { rule: "ugc.no_report", severity: "high", guideline: "1.2", file: "Sources/Views/ChatView.swift", line: 4 },
        { rule: "metadata.limits", severity: "high", guideline: "2.3.7" },
      ],
    });
    const text = pack.facts.map((f) => f.text).join("\n");
    expect(text).toContain("Store surfaces the developer must check by hand");
    expect(text).not.toMatch(/Store surfaces checked/);
    expect(text).toContain("free-text → ImageGenerator (filters: image moderation (moderateImage()) at Sources/AI/ImageGenerator.swift:22 (guards Sources/AI/ImageGenerator.swift))");
    expect(text).not.toMatch(/\bpicker \(filter/);
    // every filter on the path's own calls is listed, and traced-evidence lines are never called filters
    const outfit = pack.facts.find((f) => f.text.includes("outfit picker (CompanionStudioView.swift:42)"))?.text ?? "";
    expect(outfit).toMatch(/Gemini safety setting .* \(guards Sources\/AI\/CompanionChat\.swift\); strict Replicate safety setting .* \(guards Sources\/AI\/ImageGenerator\.swift\)/);
    expect(text).not.toMatch(/filters?: Traced evidence/);
    // a path that names no call is not credited with every call's filters, and long lists are capped
    const style = /style picker \(names no generation call; each call checked: [^\n]*?…\)/.exec(text)?.[0] ?? "";
    expect(style).not.toBe("");
    expect(style.length).toBeLessThan(700);
    expect(text).not.toContain("style picker (filters:");
    expect(text).toContain("Input paths whose traced code is no longer in the tree (not a filter): old picker");
    expect(text).toContain("Input paths with no AI generation call left in the repo to reach (not a filter): picker");
    // a filter not tied to any generation call is not presented as one
    expect(text).not.toContain("legacy path (filter");
    expect(text).toContain("Spec goal (what the fix is meant to remove; a target, not a verified result): no lingerie images");
    expect(text).not.toContain("Rejected capability:");
    expect(text).toContain("supplied without the developer's confirmation");
    expect(pack.warnings.join(" ")).toContain("ugc.no_report");
    expect(pack.warnings.join(" ")).not.toContain("metadata.limits");
  });

  it("only cites human attestations, without doubling the prefix", () => {
    const pack = evidencePack(state, "reply", { rejectionId: r2.id });
    const att = pack.facts.filter((f) => f.kind === "attestation").map((f) => f.text);
    expect(att).toEqual(["The developer states: the server prompt rejects clothing-change requests."]);
    const agent = ev("attestation", "2026-10-03T02:00:00Z", { rejectionId: r2.id, statement: "The developer states that moderation runs on every image." }, "agent");
    const p2 = evidencePack(foldEvents("T", [...events, agent]), "reply", { rejectionId: r2.id });
    expect(p2.facts.filter((f) => f.kind === "attestation")).toHaveLength(1);
  });

  it("warns on an unknown rejection id instead of failing", () => {
    const pack = evidencePack(state, "reply", { rejectionId: "ev_nope" });
    expect(pack.warnings[0]).toContain("No rejection with id ev_nope");
  });

  it("produces no hypotheses from an empty ledger", () => {
    const pack = evidencePack(foldEvents("T", []), "appeal_termination", { now: NOW });
    expect(pack.privateHypotheses?.items).toEqual([]);
  });
});

describe("good-faith record per rejection", () => {
  it("does not claim a change for a rejection approved after an App Review Board appeal", () => {
    const rej = ev("outcome", "2026-08-01T00:00:00Z", { bundleId: "com.a", outcome: "rejected", guidelines: ["1.1"] }, "import");
    const evs = [
      rej,
      ev("message_sent", "2026-08-02T00:00:00Z", { rejectionId: rej.id, purpose: "appeal_review_board", text: "We believe the app complies; please reconsider.", textHash: "h" }),
      ev("outcome", "2026-08-10T00:00:00Z", { bundleId: "com.a", outcome: "approved" }, "import"),
      ev("attestation", "2026-10-01T00:00:00Z", { statement: "I am not aware of the conduct the notice refers to." }, "human"),
    ];
    const good = evidencePack(foldEvents("T", evs), "appeal_termination", { now: NOW }).scaffold.find((s) => s.section === "Good-faith record")?.guidance ?? "";
    expect(good).not.toMatch(/as App Review asked|was changed \(/);
    expect(good).toContain(`Rejection ${rej.id} (2026-08-01, Guideline 1.1) was approved on 2026-08-10 after an App Review Board appeal; the ledger records no change for it`);
  });

  it("states a forum report as the developer's suspicion, not an established link", () => {
    const subs = [ev("submission", "2026-10-01T00:00:00Z"), ev("submission", "2026-10-02T00:00:00Z")];
    const items = evidencePack(foldEvents("T", subs), "appeal_termination", { now: NOW }).privateHypotheses?.items ?? [];
    const basis = items.find((i) => i.category === "Submission volume")?.basis ?? "";
    expect(basis).toMatch(/a developer suspects their own App Store Connect automation/);
    expect(basis).not.toMatch(/\blinks\b/);
  });
});

describe("removed review-time conditions", () => {
  const rej = ev("outcome", "2026-10-01T00:00:00Z", { bundleId: "com.b", outcome: "rejected", guidelines: ["1.1"] });
  const ver = ev("verification", "2026-10-02T00:00:00Z", {
    rejectionId: rej.id,
    verification: {
      at: "2026-10-02T00:00:00Z",
      tier: "STATIC_CLEAN",
      removedInDiff: ["Sources/RemoteFlags.swift:10"],
      removedConditions: [{ rule: "review_gating.environment", file: "Sources/CompanionStudioView.swift", line: 41, condition: "AppEnvironment.isTestFlight", gates: "hid the Outfit section" }],
      residue: [],
      inputPaths: [],
      unverifiable: [],
      summary: "clean",
    },
  });
  const state = foldEvents("T", [rej, ver]);

  it("lists a removed TestFlight condition as a fact in the review-notes pack, with or without a rejection id", () => {
    for (const rejectionId of [rej.id, undefined]) {
      const pack = evidencePack(state, "review_notes", { rejectionId, now: NOW });
      const f = pack.facts.filter((x) => x.kind === "removed_condition");
      expect(f).toHaveLength(1);
      expect(f[0]?.text).toContain("AppEnvironment.isTestFlight at Sources/CompanionStudioView.swift:41 (hid the Outfit section)");
      expect(f[0]?.eventId).toBe(ver.id);
    }
    expect(evidencePack(state, "review_notes", { now: NOW }).scaffold.find((s) => s.section === "What was removed")?.guidance).toMatch(/removed_condition/);
  });

  it("accepts conditions a caller found against a base ref", () => {
    const pack = evidencePack(foldEvents("T", [rej]), "reply", { rejectionId: rej.id, removedConditions: [{ rule: "review_gating.reviewer_branch", file: "App.swift", condition: "isReviewerAccount" }] });
    expect(pack.facts.some((x) => x.kind === "removed_condition" && x.text.includes("isReviewerAccount"))).toBe(true);
  });

  it("does not quote DPLA 3.2(f) as 'confusingly similar names' for the developer's own apps", () => {
    const dupes = foldEvents("T", [ev("app", "2026-01-01T00:00:00Z", { bundleId: "com.x", name: "Photo Magic AI" }), ev("app", "2026-01-02T00:00:00Z", { bundleId: "com.y", name: "PhotoMagic Pro" })]);
    const h = evidencePack(dupes, "appeal_termination", { now: NOW }).privateHypotheses?.items.find((i) => i.category === "Similar or duplicate apps");
    expect(h?.basis).toContain("4.3(a)/(b)");
    expect(h?.basis).not.toMatch(/confusingly similar/);
  });
});

describe("provenance of agent-recorded facts", () => {
  const P = (o: Record<string, unknown>) => LedgerEvent.parse(o);
  it("labels Apple text an agent recorded by hand, and leaves Apple's imported text as Apple's", () => {
    const state = foldEvents("T", [
      P({ id: "r1", type: "outcome", outcome: "rejected", at: "2026-10-01T00:00:00Z", source: "import", guidelines: ["1.1"], reviewerMessage: "Your app includes suggestive outfits." }),
      P({ id: "r2", type: "outcome", outcome: "rejected", at: "2026-10-10T00:00:00Z", source: "agent", guidelines: ["1.2"], reviewerMessage: "Typed in by the agent." }),
      P({ id: "rp1", type: "apple_reply", at: "2026-10-02T00:00:00Z", source: "agent", rejectionId: "r1", text: "We confirm the outfit issue is fully resolved." }),
      P({ id: "rp2", type: "apple_reply", at: "2026-10-03T00:00:00Z", source: "agent", via: "import", rejectionId: "r1", text: "Thank you for your reply. Upon re-review the issue remains." }),
      P({ id: "t1", type: "termination", at: "2026-10-20T00:00:00Z", source: "agent", letter: "Notice of termination under Section 3.2(f)." }),
      P({ id: "a1", type: "outcome", outcome: "approved", at: "2026-09-01T00:00:00Z", source: "import" }),
      P({ id: "o1", type: "ota_publish", at: "2026-10-21T00:00:00Z", source: "agent", message: "restore outfit catalog" }),
    ]);
    const pack = evidencePack(state, "appeal_review_board", {});
    const text = (eventId: string, kind: string) => pack.facts.find((f) => f.eventId === eventId && f.kind === kind)?.text ?? "";
    expect(text("rp1", "apple_reply")).toMatch(/^Recorded as Apple's reply of 2026-10-02/);
    expect(text("rp1", "apple_reply")).toContain("Recorded by an agent with shield_ledger_record, not imported from Apple's message");
    expect(text("rp2", "apple_reply")).toMatch(/^Apple replied on 2026-10-03/);
    expect(text("rp2", "apple_reply")).not.toContain("Recorded by an agent");
    expect(text("r1", "reviewer_message")).toMatch(/^App Review wrote/);
    expect(text("r2", "reviewer_message")).toMatch(/^Recorded as App Review's message: .*not imported from Apple's message/);
    expect(text("r2", "rejection")).toContain("Recorded by an agent");
    expect(text("t1", "letter")).toContain("not imported from Apple's message");
  });
});

describe("appeal hypotheses and change provenance", () => {
  const P = (o: Record<string, unknown>) => LedgerEvent.parse(o);
  const letter = "pattern of manipulative or misleading behavior, including misleading app content and bait-and-switch schemes";
  const base = [
    P({ id: "a1", type: "outcome", outcome: "approved", at: "2026-07-15T00:00:00Z", source: "import" }),
    P({ id: "s1", type: "submission", at: "2026-08-20T00:00:00Z", source: "hook" }),
    P({ id: "r1", type: "outcome", outcome: "rejected", at: "2026-08-21T00:00:00Z", source: "import", guidelines: ["2.1"] }),
    P({ id: "s2", type: "submission", at: "2026-09-05T00:00:00Z", source: "hook" }),
    P({ id: "r2", type: "outcome", outcome: "rejected", at: "2026-09-06T00:00:00Z", source: "import", guidelines: ["4.0"] }),
    P({ id: "s3", type: "submission", at: "2026-10-01T00:00:00Z", source: "hook" }),
    P({ id: "o1", type: "ota_publish", at: "2026-09-20T00:00:00Z", source: "agent", message: "add swimwear outfit pack" }),
  ];

  it("ranks the hypothesis the letter names first, and counts submissions as volume only beyond the resubmissions rejections need", () => {
    const items = evidencePack(foldEvents("T", base), "appeal_termination", { letter, now: NOW }).privateHypotheses?.items ?? [];
    expect(items[0]?.category).toMatch(/^Post-review modification/);
    expect(items[0]?.basis).toMatch(/The letter uses related wording/);
    // three submissions answering two rejections are not volume
    expect(items.some((i) => i.category === "Submission volume")).toBe(false);
    const busy = [...base, ...[1, 2, 3].map((k) => P({ id: `sx${k}`, type: "submission", at: `2026-10-0${k + 1}T00:00:00Z`, source: "hook" }))];
    const vol = (evidencePack(foldEvents("T", busy), "appeal_termination", { now: NOW }).privateHypotheses?.items ?? []).find((i) => i.category === "Submission volume");
    expect(vol?.basis).toMatch(/No source gives a number: 6 submission\(s\) in 90 days is not known to be many/);
  });

  it("labels every post-approval change an agent recorded, and none a hook or CI recorded", () => {
    const flags = (v: string) => ({ kind: "flags_inventory", label: "flags", hash: `h${v}`, summary: "1 flag", data: { flags: [{ key: "swim", provider: "firebase", classification: "content-gating", defaultValue: v }] } });
    const st = foldEvents("T", [
      P({ id: "f0", type: "config_snapshot", at: "2026-07-01T00:00:00Z", source: "hook", ...flags("false") }),
      ...base,
      P({ id: "f1", type: "config_snapshot", at: "2026-09-25T00:00:00Z", source: "agent", ...flags("true") }),
      P({ id: "o2", type: "ota_publish", at: "2026-09-26T00:00:00Z", source: "ci", message: "add beach scenes" }),
    ]);
    const facts = evidencePack(st, "appeal_termination", { now: NOW }).facts.filter((f) => f.kind === "post_approval_change");
    const text = (id: string) => facts.find((f) => f.eventId === id)?.text ?? "";
    expect(text("o1")).toContain("Recorded by an agent");
    expect(text("f1")).toContain("Recorded by an agent");
    expect(text("o2")).not.toContain("Recorded by");
  });
});

import { describe, expect, it } from "vitest";
import type { DriftReport } from "../../src/ledger/drift.js";
import { LedgerEvent } from "../../src/ledger/schema.js";
import { foldEvents } from "../../src/ledger/store.js";
import { gateDecision, nearDuplicateNames, rejectionsToResweep, resweepFromVerification, triggerChecklist } from "../../src/ledger/triggers.js";
import { finding } from "../../src/finding.js";

let n = 0;
function ev(type: LedgerEvent["type"], at: string, fields: Record<string, unknown> = {}, source = "agent"): LedgerEvent {
  n += 1;
  return LedgerEvent.parse({ id: `ev_t${n}`, type, at, source, ...fields });
}
const NOW = "2026-10-31T12:00:00.000Z";
const daysAgo = (d: number, h = 0) => new Date(Date.parse(NOW) - d * 86_400_000 - h * 3_600_000).toISOString();
const item = (items: ReturnType<typeof triggerChecklist>, id: string) => {
  const it = items.find((i) => i.id === id);
  if (!it) throw new Error(`missing ${id}`);
  return it;
};
const verification = (tier: string) => ({ at: NOW, tier, removedInDiff: [], residue: [], inputPaths: [], unverifiable: [], summary: "s" });

describe("triggerChecklist", () => {
  it("counts submissions per window with raw counts and no thresholds", () => {
    const s = foldEvents("T", [
      ev("submission", daysAgo(1)),
      ev("submission", daysAgo(10)),
      ev("submission", daysAgo(40)),
      ev("submission", daysAgo(200)),
      ev("submission", daysAgo(2), { channel: "testflight_external" }),
    ]);
    const items = triggerChecklist(s, NOW);
    expect(item(items, "submissions_7d").count).toBe(1);
    expect(item(items, "submissions_30d").count).toBe(2);
    expect(item(items, "submissions_90d").count).toBe(3);
    expect(item(items, "submissions_7d").label).toBe("source");
    expect(item(items, "submissions_7d").basis).toContain("many submissions");
    // The playbook promises paraphrase with quotes of a few words at most.
    expect(item(items, "submissions_7d").basis).not.toMatch(/"[^"]{60,}"/);
    for (const i of items) {
      expect(JSON.stringify(i)).not.toMatch(/threshold|remaining|until|limit/i);
      expect(["source", "apple", "inferred"]).toContain(i.label);
    }
  });

  it("groups rejections by guideline, highlights 1.1/1.2 and repeats", () => {
    const s = foldEvents("T", [
      ev("outcome", daysAgo(5), { outcome: "rejected", guidelines: ["1.2", "2.3.1(a)"] }),
      ev("outcome", daysAgo(20), { outcome: "rejected", guidelines: ["1.1.4"] }),
      ev("outcome", daysAgo(30), { outcome: "rejected", guidelines: ["1.2"] }),
      ev("outcome", daysAgo(60), { outcome: "rejected", guidelines: ["4.0"] }),
      ev("outcome", daysAgo(400), { outcome: "rejected", guidelines: ["1.2"] }),
    ]);
    const items = triggerChecklist(s, NOW);
    expect(item(items, "rejections_180d").count).toBe(4);
    expect(item(items, "rejections_180d").detail[0]).toBe("1.2: 2");
    expect(item(items, "objectionable_rejections_180d").count).toBe(3);
    expect(item(items, "repeat_guideline_rejections").count).toBe(1);
    expect(item(items, "repeat_guideline_rejections").detail[0]).toMatch(/^1\.2:/);
    expect(item(items, "repeat_guideline_rejections").label).toBe("apple");
  });

  it("does not count 1.10-style or 11.2 guidelines as objectionable", () => {
    const s = foldEvents("T", [ev("outcome", daysAgo(5), { outcome: "rejected", guidelines: ["11.2", "2.1"] })]);
    expect(item(triggerChecklist(s, NOW), "objectionable_rejections_180d").count).toBe(0);
  });

  it("derives name/subtitle changes from the metadata of recorded submissions", () => {
    const snap = (at: string, name: string, subtitle: string) =>
      ev("metadata_snapshot", at, { bundleId: "com.a", snapshots: [{ locale: "en-US", name, subtitle, source: "metadata" }] });
    const sub = (at: string) => ev("submission", at, { bundleId: "com.a" });
    const s = foldEvents("T", [
      snap(daysAgo(120), "Alpha", "Sub"),
      sub(daysAgo(120)),
      snap(daysAgo(50), "Alpha AI", "Sub"),
      sub(daysAgo(50)),
      snap(daysAgo(10), "Alpha AI", "Better sub"),
      sub(daysAgo(10)),
      snap(daysAgo(5), "Alpha AI", "Better sub"),
    ]);
    const it = item(triggerChecklist(s, NOW), "name_changes_90d");
    expect(it.count).toBe(2);
    expect(it.detail.join("|")).toContain('"Alpha" → "Alpha AI"');
  });

  it("does not count local metadata edits that were never submitted as name changes", () => {
    // The live name was already "Luna - AI Companion"; the developer only corrected a stale local file.
    const snap = (at: string, name: string) => ev("metadata_snapshot", at, { bundleId: "com.a", snapshots: [{ locale: "en-US", name, source: "fastlane/metadata" }] });
    const s = foldEvents("T", [
      ev("outcome", daysAgo(3), { outcome: "rejected", guidelines: ["1.1"], bundleId: "com.a" }, "import"),
      snap(daysAgo(2), "AI Girlfriend - ChatGPT Uncensored"),
      snap(daysAgo(1), "Luna - AI Companion"),
    ]);
    const items = triggerChecklist(s, NOW);
    expect(item(items, "name_changes_90d").count).toBe(0);
    const local = item(items, "local_name_edits");
    expect(local.count).toBe(1);
    expect(local.contextOnly).toBe(true);
    expect(local.title).toMatch(/not sent to Apple/);
    expect(gateDecision(s, [], NOW).warnings.join(" ")).not.toMatch(/name or subtitle/i);
    // once that metadata is submitted and later changed and submitted again, it counts
    const s2 = foldEvents("T", [...s.events, ev("submission", daysAgo(0, 5), { bundleId: "com.a" }), snap(daysAgo(0, 3), "Luna"), ev("submission", daysAgo(0, 2), { bundleId: "com.a" })]);
    expect(item(triggerChecklist(s2, NOW), "name_changes_90d").detail).toEqual([`${daysAgo(0, 2).slice(0, 10)} en-US name: "Luna - AI Companion" → "Luna"`]);
  });

  it("cites only Guideline 4.3 for near-identical names among the developer's own apps", () => {
    const basis = item(triggerChecklist(foldEvents("T", []), NOW), "near_duplicate_app_names").basis;
    expect(basis).toContain("4.3(a)");
    expect(basis).not.toMatch(/confusingly similar/);
  });

  it("counts resubmissions within 24h of a 1.1/1.2 rejection only when nothing was clarified", () => {
    const r1 = ev("outcome", daysAgo(10), { outcome: "rejected", guidelines: ["1.2"] });
    const r2 = ev("outcome", daysAgo(5), { outcome: "rejected", guidelines: ["1.1.4"] });
    const s = foldEvents("T", [
      r1,
      ev("submission", daysAgo(10, -3)),
      r2,
      ev("interpretation", daysAgo(5, -1), { rejectionId: r2.id, text: "remove the free-text path" }),
      ev("submission", daysAgo(5, -5)),
      ev("submission", daysAgo(3)),
    ]);
    const it = item(triggerChecklist(s, NOW), "quick_resubmissions");
    expect(it.count).toBe(1);
    expect(it.eventIds).toContain(r1.id);
    expect(it.label).toBe("inferred");
  });

  it("lists open rejections without verification, near-duplicate names and automation volume", () => {
    const r = ev("outcome", daysAgo(3), { bundleId: "com.a", outcome: "rejected", guidelines: ["2.1"] });
    const verified = ev("outcome", daysAgo(3), { bundleId: "com.b", outcome: "rejected", guidelines: ["2.1"] });
    const s = foldEvents("T", [
      ev("app", daysAgo(100), { bundleId: "com.a", name: "Photo Magic AI" }),
      ev("app", daysAgo(100), { bundleId: "com.b", name: "PhotoMagic" }),
      ev("app", daysAgo(100), { bundleId: "com.c", name: "Budget Planner" }),
      r,
      verified,
      ev("verification", daysAgo(2), { rejectionId: verified.id, verification: verification("STATIC_CLEAN") }),
      ev("submission", daysAgo(1), { bundleId: "com.a" }, "ci"),
      ev("submission", daysAgo(1), { bundleId: "com.b" }, "hook"),
      ev("submission", daysAgo(1), { bundleId: "com.c" }, "human"),
    ]);
    const items = triggerChecklist(s, NOW);
    expect(item(items, "open_rejections_unverified").eventIds).toEqual([r.id]);
    expect(item(items, "apps_on_account").count).toBe(3);
    expect(item(items, "near_duplicate_app_names").count).toBe(1);
    expect(item(items, "automation_volume_30d").count).toBe(2);
  });
});

describe("submissions inferred from outcomes", () => {
  it("counts an imported rejection or approval as a submission, once per submission", () => {
    const s = foldEvents("T", [
      ev("outcome", daysAgo(44), { outcome: "rejected", guidelines: ["1.2"], submissionId: "apple-1" }, "import"),
      ev("outcome", daysAgo(44, -1), { outcome: "rejected", guidelines: ["1.2"], submissionId: "apple-1" }, "import"),
      ev("outcome", daysAgo(20), { outcome: "approved" }, "import"),
    ]);
    const s90 = item(triggerChecklist(s, NOW), "submissions_90d");
    expect(s90.count).toBe(2);
    expect(s90.detail.every((d) => d.includes("(inferred from outcome)"))).toBe(true);
    expect(item(triggerChecklist(s, NOW), "submissions_30d").count).toBe(1);
  });

  it("does not double-count an outcome that follows a recorded submission", () => {
    const sub = ev("submission", daysAgo(10), { version: "1.3" });
    const s = foldEvents("T", [sub, ev("outcome", daysAgo(9), { outcome: "rejected", guidelines: ["1.2"] }, "import"), ev("outcome", daysAgo(5), { outcome: "approved" }, "import")]);
    const s30 = item(triggerChecklist(s, NOW), "submissions_30d");
    expect(s30.count).toBe(2);
    expect(s30.eventIds).toContain(sub.id);
    expect(s30.detail.filter((d) => d.includes("inferred")).length).toBe(1);
  });
});

describe("dates", () => {
  it("does not crash the gate on a state whose event time does not parse", () => {
    const s = foldEvents("T", [ev("outcome", daysAgo(3), { outcome: "rejected", guidelines: ["1.2"] }, "import")]);
    const bad = { ...s, rejections: s.rejections.map((r) => ({ ...r, at: "last tuesday" })) };
    expect(() => gateDecision(bad, [], NOW)).not.toThrow();
    expect(() => triggerChecklist(bad, NOW)).not.toThrow();
  });
});

describe("nearDuplicateNames", () => {
  it("matches near-identical names and ignores distinct ones", () => {
    expect(nearDuplicateNames(["Photo Magic AI", "PhotoMagic Pro", "Budget Planner"])).toEqual([["Photo Magic AI", "PhotoMagic Pro"]]);
    expect(nearDuplicateNames(["Budget Planner", "Recipe Box", "Sleep Sounds"])).toEqual([]);
  });
});

describe("gateDecision", () => {
  const block = finding({ rule: "genai_safety.safety_disabled", severity: "block", guideline: "1.2", why: "w", fix: "Remove BLOCK_NONE.", file: "a.ts", line: 3 });
  const high = finding({ rule: "paywall.no_restore", severity: "high", guideline: "3.1.1", why: "w", fix: "f" });

  it("is CLEAR on an empty ledger with no findings", () => {
    expect(gateDecision(foldEvents("T", []), [], NOW)).toEqual({ verdict: "CLEAR", holdReasons: [], warnings: [] });
  });

  it("HOLDs on a block finding", () => {
    const g = gateDecision(foldEvents("T", []), [block], NOW);
    expect(g.verdict).toBe("HOLD");
    expect(g.holdReasons[0]).toContain("genai_safety.safety_disabled");
  });

  it("WARNs (not HOLD) on a high finding", () => {
    const g = gateDecision(foldEvents("T", []), [high], NOW);
    expect(g.verdict).toBe("WARN");
  });

  it("HOLDs on an open rejection with no verification or a weak one", () => {
    const r = ev("outcome", daysAgo(400), { outcome: "rejected", guidelines: ["2.1"] });
    expect(gateDecision(foldEvents("T", [r]), [], NOW).verdict).toBe("HOLD");
    const weak = ev("verification", daysAgo(1), { rejectionId: r.id, verification: verification("UNVERIFIABLE") });
    const g = gateDecision(foldEvents("T", [r, weak]), [], NOW);
    expect(g.verdict).toBe("HOLD");
    expect(g.holdReasons[0]).toContain("UNVERIFIABLE");
    expect(g.holdReasons[0]).toContain("appstore-shield ack");
  });

  it("names what keeps the verification below STATIC_CLEAN", () => {
    const r = ev("outcome", daysAgo(10), { outcome: "rejected", guidelines: ["1.1"] });
    const open = ev("verification", daysAgo(1), { rejectionId: r.id, verification: { ...verification("RESIDUE_FOUND"), inputPaths: [{ inputPath: "free text → generateImage", blocked: false, evidence: [] }] } });
    expect(gateDecision(foldEvents("T", [r, open]), [], NOW).holdReasons[0]).toContain("input path not blocked: free text → generateImage");
    const hit = { kind: "term", needle: "lingerie", file: "src/studio.ts", line: 3, status: "PRESENT", confidence: "high", reason: "r" };
    const residue = ev("verification", daysAgo(0, 1), { rejectionId: r.id, verification: { ...verification("RESIDUE_FOUND"), residue: [hit] } });
    expect(gateDecision(foldEvents("T", [r, residue]), [], NOW).holdReasons[0]).toContain("lingerie @ src/studio.ts:3");
    const ungrounded = ev("verification", daysAgo(0, 0.5), { rejectionId: r.id, verification: { ...verification("UNVERIFIABLE"), summary: "The spec is not grounded in the rejection." } });
    expect(gateDecision(foldEvents("T", [r, ungrounded]), [], NOW).holdReasons[0]).toContain("spec not grounded in the rejection");
  });

  it("does not HOLD when the rejection is verified STATIC_CLEAN, approved later, or acked by a human", () => {
    const r = ev("outcome", daysAgo(400), { outcome: "rejected", guidelines: ["2.1"] });
    const clean = ev("verification", daysAgo(1), { rejectionId: r.id, verification: verification("STATIC_CLEAN") });
    expect(gateDecision(foldEvents("T", [r, clean]), [], NOW).holdReasons).toEqual([]);
    const approved = ev("outcome", daysAgo(300), { outcome: "approved" }, "import");
    expect(gateDecision(foldEvents("T", [r, approved]), [], NOW).holdReasons).toEqual([]);
    // An approval an agent wrote itself must not clear the hold.
    const agentApproval = ev("outcome", daysAgo(300), { outcome: "approved" }, "agent");
    expect(gateDecision(foldEvents("T", [r, agentApproval]), [], NOW).verdict).toBe("HOLD");
    const ack = ev("ack", daysAgo(1), { rejectionId: r.id, note: "reviewed" }, "human");
    expect(gateDecision(foldEvents("T", [r, ack]), [], NOW).holdReasons).toEqual([]);
    const agentAck = ev("ack", daysAgo(1), { rejectionId: r.id, note: "x" }, "agent");
    expect(gateDecision(foldEvents("T", [r, agentAck]), [], NOW).verdict).toBe("HOLD");
  });

  it("HOLDs on ledger-location issues carried in the loaded state", () => {
    const s = Object.assign(foldEvents("T", []), { locationIssues: ["This repo used the ledger /x before, and it has 1 open rejection(s)"] });
    const g = gateDecision(s, [], NOW);
    expect(g.verdict).toBe("HOLD");
    expect(g.holdReasons[0]).toContain("used the ledger");
    expect(gateDecision(foldEvents("T", []), [], NOW).verdict).toBe("CLEAR");
  });

  it("only WARNs on an open metadata rejection", () => {
    const r = ev("outcome", daysAgo(400), { outcome: "metadata_rejected", guidelines: ["2.3.7"] });
    const g = gateDecision(foldEvents("T", [r]), [], NOW);
    expect(g.verdict).toBe("WARN");
    expect(g.warnings[0]).toContain("metadata");
  });

  it("HOLDs on undisclosed content/price drift, and still WARNs on disclosed content drift and non-content drift", () => {
    const base: DriftReport = { approvalId: "a", approvalAt: NOW, changes: [], unbaselined: [], guidance: "" };
    const change = { kind: "server_prompt" as const, label: "server/prompts/system.txt", change: "changed" as const, contentOrPrice: true, mentions: [], detail: "prompt changed" };
    expect(gateDecision(foldEvents("T", []), [], NOW, { ...base, changes: [{ ...change, disclosed: false }] }).verdict).toBe("HOLD");
    // disclosure records a content change; it does not make it reviewed, so the gate keeps saying so
    const disclosed = gateDecision(foldEvents("T", []), [], NOW, { ...base, changes: [{ ...change, disclosed: true }] });
    expect(disclosed.verdict).toBe("WARN");
    expect(disclosed.warnings[0]).toMatch(/^Disclosed post-approval change: prompt changed\. Disclosure records it; it does not make it compliant\./);
    const g = gateDecision(foldEvents("T", []), [], NOW, { ...base, changes: [{ ...change, contentOrPrice: false, disclosed: false }] });
    expect(g.verdict).toBe("WARN");
    expect(g.warnings[0]).toMatch(/Resubmit or disclose/);
  });

  it("says a disclosure resting on agent-recorded notes only counts if the developer sends them", () => {
    const base: DriftReport = { approvalId: "a", approvalAt: NOW, changes: [], unbaselined: [], guidance: "" };
    const change = { kind: "server_prompt" as const, label: "server/prompts/system.txt", change: "changed" as const, contentOrPrice: true, mentions: [], detail: "prompt changed", disclosed: true };
    const agentNotes = ev("message_sent", daysAgo(0, 1), { purpose: "review_notes", text: "We changed the system prompt.", textHash: "h" }, "agent");
    const g = gateDecision(foldEvents("T", [agentNotes]), [], NOW, { ...base, changes: [change], pendingNotesEventId: agentNotes.id });
    // CI passes on WARN, so an agent's own record of notes must not clear the HOLD by itself.
    expect(g.verdict).toBe("HOLD");
    expect(g.holdReasons.join(" ")).toMatch(new RegExp(`recorded by the agent .*appstore-shield attest .*${agentNotes.id}`));
    // an attestation the agent wrote does not count; the developer's own does
    const agentAttest = ev("attestation", daysAgo(0), { statement: `I pasted the Notes for Review ${agentNotes.id} into App Store Connect` }, "agent");
    expect(gateDecision(foldEvents("T", [agentNotes, agentAttest]), [], NOW, { ...base, changes: [change], pendingNotesEventId: agentNotes.id }).verdict).toBe("HOLD");
    const humanAttest = ev("attestation", daysAgo(0), { statement: `The developer states that i pasted the Notes for Review ${agentNotes.id} into App Store Connect` }, "human");
    const pasted = gateDecision(foldEvents("T", [agentNotes, humanAttest]), [], NOW, { ...base, changes: [change], pendingNotesEventId: agentNotes.id });
    expect(pasted.verdict).toBe("WARN");
    expect(pasted.holdReasons).toEqual([]);
    expect(pasted.warnings.join(" ")).toMatch(/Disclosed post-approval change/);
    const humanNotes = ev("message_sent", daysAgo(0, 1), { purpose: "review_notes", text: "We changed the system prompt.", textHash: "h" }, "human");
    expect(gateDecision(foldEvents("T", [humanNotes]), [], NOW, { ...base, changes: [change], pendingNotesEventId: humanNotes.id }).verdict).toBe("WARN");
  });

  it("turns non-context trigger items into warnings but ignores plain submission counts", () => {
    const s = foldEvents("T", [ev("submission", daysAgo(1)), ev("submission", daysAgo(2))]);
    expect(gateDecision(s, [], NOW).verdict).toBe("CLEAR");
    const r = ev("outcome", daysAgo(10), { outcome: "rejected", guidelines: ["1.2"] });
    const s2 = foldEvents("T", [r, ev("outcome", daysAgo(5), { outcome: "approved" }, "import")]);
    const g = gateDecision(s2, [], NOW);
    expect(g.verdict).toBe("WARN");
    expect(g.warnings.join(" ")).toContain("1.1 (objectionable content) or 1.2");
  });
});

describe("gate re-sweep of verified rejections", () => {
  const spec = { feature: "lingerie", capability: "no sexualized outfits", terms: ["lingerie outfit"] };
  const rej = ev("outcome", daysAgo(10), { outcome: "rejected", guidelines: ["1.1"] }, "import");
  const base = [rej, ev("residue_spec", daysAgo(9), { rejectionId: rej.id, spec }), ev("verification", daysAgo(8), { rejectionId: rej.id, verification: { ...verification("STATIC_CLEAN"), sha: "abc1234567890" } })];

  it("holds an open rejection whose verification was clean but whose current tree has the residue again", () => {
    const s = foldEvents("T", base);
    expect(rejectionsToResweep(s).map((r) => r.id)).toEqual([rej.id]);
    expect(gateDecision(s, [], NOW).holdReasons.some((h) => h.includes(rej.id))).toBe(false);
    const g = gateDecision(s, [], NOW, undefined, [{ rejectionId: rej.id, tier: "RESIDUE_FOUND", detail: "lingerie outfit @ Sources/Prompt.swift:12" }]);
    expect(g.verdict).toBe("HOLD");
    expect(g.holdReasons.join(" ")).toMatch(/verified STATIC_CLEAN .* at abc1234567.*RESIDUE_FOUND \(lingerie outfit @ Sources\/Prompt\.swift:12\)/);
    expect(gateDecision(s, [], NOW, undefined, [{ rejectionId: rej.id, tier: "STATIC_CLEAN" }]).holdReasons.some((h) => h.includes(rej.id))).toBe(false);
  });

  it("names the cause the sweep found: residue, an unfiltered input path, or an item it can no longer check", () => {
    const s = foldEvents("T", base);
    const hold = (fresh: Parameters<typeof gateDecision>[4]) => gateDecision(s, [], NOW, undefined, fresh).holdReasons.find((h) => h.includes(rej.id)) ?? "";
    const pathOnly = resweepFromVerification(rej.id, {
      tier: "RESIDUE_FOUND",
      residue: [],
      inputPaths: [{ inputPath: "selfie upload (Sources/SelfieView.swift:30)", blocked: false, evidence: [] }],
    });
    expect(pathOnly).toMatchObject({ residueHits: 0, openInputPaths: ["selfie upload (Sources/SelfieView.swift:30)"] });
    expect(hold([pathOnly])).toMatch(/No residue was found, but 1 input path\(s\) no longer have a filter on their generation call, first: selfie upload/);
    expect(hold([pathOnly])).not.toMatch(/back in the (?:code|tree)/);
    // a caller that reports no residue detail never gets told the capability is back
    expect(hold([{ rejectionId: rej.id, tier: "UNVERIFIABLE" }])).toMatch(/can no longer be checked/);
    expect(hold([{ rejectionId: rej.id, tier: "UNVERIFIABLE" }])).not.toMatch(/back in the/);
    const residue = resweepFromVerification(rej.id, {
      tier: "RESIDUE_FOUND",
      residue: [{ kind: "term", needle: "lingerie outfit", file: "Sources/Prompt.swift", line: 12, status: "PRESENT", confidence: "high", reason: "r" }],
      inputPaths: [],
    });
    expect(hold([residue])).toMatch(/RESIDUE_FOUND \(lingerie outfit @ Sources\/Prompt\.swift:12\)\. The rejected capability's code is back in the tree/);
  });

  it("does not hold, or re-sweep, a rejection recorded for another app on the account", () => {
    const other = ev("outcome", daysAgo(3), { outcome: "rejected", guidelines: ["1.2"], bundleId: "com.example.otherapp" }, "import");
    const otherSpec = ev("residue_spec", daysAgo(2), { rejectionId: other.id, spec });
    const otherVer = ev("verification", daysAgo(1), { rejectionId: other.id, verification: verification("STATIC_CLEAN") });
    const s = foldEvents("T", [other]);
    const g = gateDecision(s, [], NOW, undefined, [], { bundleId: "app.inkwell.journal" });
    expect(g.holdReasons.some((h) => h.includes(other.id))).toBe(false);
    expect(g.warnings.join(" ")).toMatch(new RegExp(`${other.id}.*com\\.example\\.otherapp, another app on this account`));
    // without a bundle id, or for the same app, it still holds
    expect(gateDecision(s, [], NOW).holdReasons.some((h) => h.includes(other.id))).toBe(true);
    expect(gateDecision(s, [], NOW, undefined, [], { bundleId: "com.example.otherapp" }).holdReasons.some((h) => h.includes(other.id))).toBe(true);
    const verified = foldEvents("T", [other, otherSpec, otherVer]);
    expect(rejectionsToResweep(verified, "app.inkwell.journal")).toEqual([]);
    expect(rejectionsToResweep(verified, "com.example.otherapp").map((r) => r.id)).toEqual([other.id]);
    // a stray sweep result for the other app's rejection never turns into a HOLD here
    expect(gateDecision(verified, [], NOW, undefined, [{ rejectionId: other.id, tier: "UNVERIFIABLE" }], { bundleId: "app.inkwell.journal" }).verdict).not.toBe("HOLD");
  });

  it("warns when an approved rejection's residue is back", () => {
    const s = foldEvents("T", [...base, ev("outcome", daysAgo(5), { outcome: "approved" }, "import")]);
    const g = gateDecision(s, [], NOW, undefined, [{ rejectionId: rej.id, tier: "RESIDUE_FOUND" }]);
    expect(g.holdReasons.some((h) => h.includes(rej.id))).toBe(false);
    expect(g.warnings.join(" ")).toMatch(new RegExp(`${rej.id}.*later approved.*RESIDUE_FOUND`));
  });
});

describe("trigger windows and HOLD-reason dedupe", () => {
  it("marks every windowed count's window as ours, so the source label is not read as giving it", () => {
    const items = triggerChecklist(foldEvents("T", []), NOW);
    for (const id of ["submissions_7d", "submissions_30d", "submissions_90d", "rejections_180d", "objectionable_rejections_180d", "repeat_guideline_rejections", "name_changes_90d", "automation_volume_30d"]) {
      const it = item(items, id);
      expect(it.title, id).toMatch(/\*(?: \(|$)/);
      // the full caveat stays in the structured output of every item
      expect(it.windowNote, id).toBe("window chosen by appstore-shield; no source gives one");
      expect(it.basis, id).toContain("window chosen by appstore-shield; no source gives one");
    }
    // printed once, as a legend on the first marked line, not on every line
    expect(items.map((i) => i.title).join("\n").match(/no source gives one/g)).toHaveLength(1);
    expect(item(items, "submissions_7d").title).toBe("App Review submissions, last 7 days* (* window chosen by appstore-shield; no source gives one)");
    expect(item(items, "open_rejections_unverified").title).not.toMatch(/\*/);
  });

  it("prints the window legend once among the gate's warnings", () => {
    const rej = (d: number, g: string) => ev("outcome", daysAgo(d), { outcome: "rejected", guidelines: [g] }, "import");
    const s = foldEvents("T", [rej(10, "1.1"), rej(20, "1.1"), rej(30, "1.2")]);
    const w = gateDecision(s, [], NOW).warnings.filter((x) => /days\*/.test(x));
    expect(w.length).toBeGreaterThan(1);
    expect(w.join("\n").match(/no source gives one/g)).toHaveLength(1);
    expect(w[0]).toMatch(/\(\* window chosen by appstore-shield; no source gives one\)/);
  });

  it("does not repeat a high finding's rule in the advisory list once it is a HOLD reason", async () => {
    const { refreshHighFindingsWarning } = await import("../../src/ledger/triggers.js");
    const high = (rule: string) => finding({ rule, severity: "high", guideline: "1.2", file: "a.ts", line: 1, why: "w", fix: "f", confidence: "high" });
    const findings = [high("genai.no_moderation"), high("ugc.no_report"), high("metadata.field_limit"), finding({ rule: "ugc.no_report", severity: "block", guideline: "1.2", file: "b.ts", line: 2, why: "w", fix: "f", confidence: "high" })];
    const g = gateDecision(foldEvents("T", []), findings, NOW);
    const w = () => g.warnings.find((x) => /high finding\(s\)/.test(x)) ?? "";
    expect(w()).not.toMatch(/ugc\.no_report/);
    expect(w()).toMatch(/genai\.no_moderation, metadata\.field_limit/);
    // a caller that adds a HOLD naming another rule rebuilds the list
    g.holdReasons.push("Open rejection ev_x cites Guideline 1.2, and genai.no_moderation (Guideline 1.2) is still reported at a.ts:1: f");
    refreshHighFindingsWarning(g, findings);
    expect(w()).toBe("1 high finding(s): metadata.field_limit (2 more rule(s) not repeated here: already HOLD reasons above).");
  });
});

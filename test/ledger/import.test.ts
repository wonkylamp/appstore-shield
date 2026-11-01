import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  citedGuidelines,
  classifySegment,
  commitImport,
  extractDateHit,
  extractGuidelines,
  importAppleData,
  isFutureDated,
  parseAppleText,
  parseAscJson,
} from "../../src/ledger/import.js";
import { LedgerEvent } from "../../src/ledger/schema.js";
import { foldEvents, readEvents } from "../../src/ledger/store.js";
import { gateDecision, triggerChecklist } from "../../src/ledger/triggers.js";

// A time with no zone is read in the machine's zone; the expected instants below are written for UTC.
const prevTzAll = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "UTC";
});
afterAll(() => {
  if (prevTzAll === undefined) delete process.env.TZ;
  else process.env.TZ = prevTzAll;
});

let home: string;
const prevHome = process.env.APPSTORE_SHIELD_HOME;
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "shield-import-"));
  process.env.APPSTORE_SHIELD_HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.APPSTORE_SHIELD_HOME;
  else process.env.APPSTORE_SHIELD_HOME = prevHome;
});

const REJECTION = `Hello,

Thank you for your resubmission. Upon further review, we identified additional issues that need your attention.

Submission ID: 7a1c2b3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d
Review date: October 12, 2026
Review Device: iPhone 15 Pro
Version reviewed: 1.2 (34)
Bundle ID: com.example.dreamgf

Guideline 1.2 - Safety - User-Generated Content

Issue Description

We noticed that your app includes user-generated content but does not have all the required precautions.

Guideline 2.3.1(a) - Performance - Accurate Metadata

The Notes for Review did not describe the new features with specificity.

Next Steps

It would be appropriate to implement a mechanism to report offensive content.
Please note that continued violations may result in removal from the Apple Developer Program.

Resources
`;

const APPROVAL = `From: App Store Connect <no_reply@email.apple.com>
Subject: The status of your (iOS) app, Dream GF, is now Ready for Distribution
Date: Tue, 20 Oct 2026 09:12:00 -0700

Dear Developer,

The review of your app is complete, and it is now eligible for distribution.

App Name: Dream GF
App Version Number: 1.3
App SKU: DREAMGF
App Apple ID: 6400000000
`;

const TERMINATION = `Dear Developer,

We are writing to notify you that your Apple Developer Program membership has been terminated.

Pursuant to Section 3.2(f) of the Apple Developer Program License Agreement, you agreed not to engage in a pattern of manipulative or misleading behavior.

Date: November 2, 2026
`;

describe("extractGuidelines", () => {
  it("pulls sub-clauses and lists", () => {
    expect(extractGuidelines("Guideline 2.3.1(a) - Performance and Guideline 5.1.1(v) - Legal")).toEqual(["2.3.1(a)", "5.1.1(v)"]);
    expect(extractGuidelines("Guidelines 2.1 and 4.3, 1.1.4")).toEqual(["2.1", "4.3", "1.1.4"]);
    expect(extractGuidelines("Version 1.2 (34) was reviewed on iOS 26.1")).toEqual([]);
  });
});

describe("parseAppleText", () => {
  it("parses a Resolution Center rejection with guidelines, version, submission id, bundle and date", () => {
    const r = parseAppleText(REJECTION);
    const outcome = r.proposed.find((p) => p.event.type === "outcome")?.event;
    expect(outcome).toMatchObject({
      type: "outcome",
      outcome: "rejected",
      guidelines: ["1.2", "2.3.1(a)"],
      submissionId: "7a1c2b3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d",
      bundleId: "com.example.dreamgf",
    });
    expect(String(outcome?.at)).toMatch(/^2026-10-1[12]/);
    expect(String(outcome?.reviewerMessage)).toContain("We noticed");
    expect(r.proposed.find((p) => p.event.type === "outcome")?.summary).toContain("1.2 (34)");
    expect(r.proposed.some((p) => p.event.type === "app" && p.event.bundleId === "com.example.dreamgf")).toBe(true);
  });

  it("does not treat a rejection that warns about removal or termination as a termination", () => {
    expect(classifySegment(`${REJECTION}\nFurther violations may result in termination of your membership.`)).toBe("rejected");
  });

  it("parses an approval email, including app name and date", () => {
    const r = parseAppleText(APPROVAL, { bundleId: "com.example.dreamgf" });
    const outcome = r.proposed.find((p) => p.event.type === "outcome")?.event;
    expect(outcome).toMatchObject({ outcome: "approved", guidelines: [], bundleId: "com.example.dreamgf" });
    expect(String(outcome?.at)).toBe("2026-10-20T16:12:00.000Z");
    expect(r.proposed.find((p) => p.event.type === "app")?.event).toMatchObject({ name: "Dream GF" });
  });

  it("parses a termination letter citing 3.2(f)", () => {
    const r = parseAppleText(TERMINATION);
    expect(r.proposed).toHaveLength(1);
    const t = r.proposed[0];
    expect(t?.event.type).toBe("termination");
    expect(t?.summary).toContain("DPLA 3.2(f)");
    expect(String(t?.event.at)).toMatch(/^2026-11-0[12]/);
  });

  it("parses metadata rejections separately", () => {
    const r = parseAppleText("Your app status is Metadata Rejected.\n\nGuideline 2.3.7 - Performance - Accurate Metadata\nReview date: 2026-09-01");
    expect(r.proposed[0]?.event).toMatchObject({ outcome: "metadata_rejected", guidelines: ["2.3.7"], at: "2026-09-01T12:00:00.000Z" });
  });

  it("splits a pasted thread into separate messages", () => {
    const r = parseAppleText(`${REJECTION}\n-----Original Message-----\n${APPROVAL}`);
    const outcomes = r.proposed.filter((p) => p.event.type === "outcome").map((p) => p.event.outcome);
    expect(outcomes).toEqual(["rejected", "approved"]);
  });

  it("reports unrecognized text and warns when no date or guideline is present", () => {
    const r = parseAppleText("Hi team, lunch at noon? Bring the slides for the planning meeting please.");
    expect(r.proposed).toEqual([]);
    expect(r.ignored[0]).toContain("Unrecognized");
    const r2 = parseAppleText("We noticed an issue with your submission.");
    expect(r2.proposed[0]?.event.outcome).toBe("rejected");
    expect(r2.warnings.join(" ")).toMatch(/No date/);
    expect(r2.warnings.join(" ")).toMatch(/no guideline/);
  });

  it("decodes quoted-printable and HTML email bodies", () => {
    const html = "<html><body><p>Guideline 4.3(a) - Design - Spam</p><p>We noticed your app duplicates another app.</p><p>Review date: October 1, 2026</p></body></html>";
    const r = parseAppleText(html);
    expect(r.proposed[0]?.event).toMatchObject({ outcome: "rejected", guidelines: ["4.3(a)"] });
    const qp = "Content-Transfer-Encoding: quoted-printable\n\nGuideline 1.1.4 - Safety - Objectionable Content =\nWe noticed sexual content.";
    expect(parseAppleText(qp).proposed[0]?.event.guidelines).toEqual(["1.1.4"]);
  });

  it("flags duplicates of existing ledger events", () => {
    const first = parseAppleText(REJECTION);
    const existing = first.proposed.map((p, i) => ({ ...p.event, id: `ev_${i}`, source: "import", at: p.event.at ?? "2026-10-12T00:00:00Z" }));
    const again = parseAppleText(REJECTION, { existing: existing as never });
    expect(again.proposed.every((p) => p.duplicateOf)).toBe(true);
  });
});

describe("parseAscJson", () => {
  it("parses asc review history entries", () => {
    const json = [
      { submissionId: "s1", state: "COMPLETE", platform: "IOS", versionString: "1.2", submittedDate: "2026-10-10T10:00:00Z", outcome: "rejected" },
      { submissionId: "s2", state: "COMPLETE", platform: "IOS", versionString: "1.3", submittedDate: "2026-10-15T10:00:00Z", outcome: "approved", reviewer: "x" },
      { submissionId: "s3", state: "READY_FOR_REVIEW", platform: "IOS", versionString: "1.4" },
    ];
    const r = parseAscJson(JSON.stringify(json), { bundleId: "com.a" });
    expect(r.proposed.map((p) => `${p.event.type}:${p.event.outcome ?? p.event.version}`)).toEqual([
      "submission:1.2",
      "outcome:rejected",
      "submission:1.3",
      "outcome:approved",
    ]);
    expect(r.proposed[1]?.event).toMatchObject({ submissionId: "s1", bundleId: "com.a" });
    expect(r.ignored.join(" ")).toContain("never submitted");
    expect(r.ignored.join(" ")).toContain("reviewer");
    expect(r.warnings.join(" ")).toContain("no guideline numbers");
  });

  it("parses JSON:API review submissions (data[].attributes) and maps UNRESOLVED_ISSUES to rejected", () => {
    const json = {
      data: [
        { type: "reviewSubmissions", id: "abc", attributes: { platform: "IOS", submittedDate: "2026-10-01T00:00:00Z", state: "UNRESOLVED_ISSUES" } },
        { type: "reviewSubmissions", id: "def", attributes: { platform: "IOS", submittedDate: "2026-10-02T00:00:00Z", state: "WAITING_FOR_REVIEW" } },
      ],
      links: { self: "x" },
    };
    const r = parseAscJson(json);
    expect(r.proposed.map((p) => p.event.type)).toEqual(["submission", "outcome", "submission"]);
    expect(r.proposed[1]?.event.outcome).toBe("rejected");
    expect(r.warnings.join(" ")).toContain("bundle_id");
  });

  it("parses a JSON:API single review submission ({data: {...}}), as a GET of one submission returns", () => {
    const r = parseAscJson(JSON.stringify({ data: { id: "x", type: "reviewSubmissions", attributes: { state: "COMPLETE", submittedDate: "2026-10-01T10:00:00Z" } }, links: { self: "y" } }));
    expect(r.proposed.map((p) => p.event.type)).toContain("submission");
    expect(r.ignored.join(" ")).not.toContain("not a list");
    // an object under "data" that is not a submission is still reported, not guessed at
    expect(parseAscJson({ data: { hello: "world" } }).ignored.join(" ")).toContain("not a list");
  });

  it("reports unknown shapes instead of guessing", () => {
    const r = parseAscJson({ hello: "world" });
    expect(r.proposed).toEqual([]);
    expect(r.ignored[0]).toContain("not a list");
    expect(parseAscJson("{nope").ignored[0]).toContain("not valid JSON");
  });
});

describe("dates and same-submission enrichment", () => {
  const fixture = (name: string) => readFile(path.join(__dirname, "../fixtures/ledger", name), "utf8");

  it("records a date-only Review date as that calendar day in every timezone", async () => {
    const text = await fixture("rejection-1.2.txt");
    const prevTz = process.env.TZ;
    try {
      for (const tz of ["Europe/London", "Asia/Tokyo", "America/Los_Angeles", "UTC"]) {
        process.env.TZ = tz;
        const at = String(parseAppleText(text).proposed.find((p) => p.event.type === "outcome")?.event.at);
        expect(at.slice(0, 10)).toBe("2026-09-17");
      }
    } finally {
      if (prevTz === undefined) delete process.env.TZ;
      else process.env.TZ = prevTz;
    }
  });

  it("prefers a timed Date header over a date-only Review date of the same day, so a same-day approval closes the rejection", () => {
    const rejection = "Date: Tue, 6 Oct 2026 02:05:51 -0700\nReview date: October 6, 2026\n\nGuideline 1.2 - Safety\nWe noticed an issue with your submission.";
    const approval = "Date: Tue, 6 Oct 2026 04:27:03 -0700\n\nThe review of your app is complete, and it is now eligible for distribution.";
    const rej = parseAppleText(rejection);
    const ok = parseAppleText(approval);
    expect(rej.proposed[0]?.event.at).toBe("2026-10-06T09:05:51.000Z");
    expect(rej.warnings.join(" ")).not.toMatch(/Only a calendar date/);
    const toEvent = (e: Record<string, unknown>, id: string) => LedgerEvent.parse({ ...e, id, source: "import" });
    const state = foldEvents("T", [toEvent(rej.proposed[0]!.event, "ev_r"), toEvent(ok.proposed[0]!.event, "ev_a")]);
    expect(state.rejections[0]?.approvedBy).toBe("ev_a");
    // a timed header on a different day does not override the Review date
    const other = parseAppleText("Date: Thu, 8 Oct 2026 10:00:00 -0700\nReview date: October 6, 2026\n\nGuideline 1.2 - Safety\nWe noticed an issue.");
    expect(String(other.proposed[0]?.event.at).slice(0, 10)).toBe("2026-10-06");
    expect(other.warnings.join(" ")).toMatch(/Only a calendar date .* 12:00 UTC/);
  });

  it("uses an explicit offset when the only date carries one", () => {
    const r = parseAppleText("Date: Thu, 17 Sep 2026 23:30:00 -0700\n\nGuideline 1.2 - Safety\nWe noticed an issue with your submission.");
    expect(r.proposed[0]?.event.at).toBe("2026-09-18T06:30:00.000Z");
  });

  it("proposes the Resolution Center text as an enrichment, not a duplicate, after an asc export of the same submission", async () => {
    const text = await fixture("rejection-1.2.txt");
    const subId = /Submission ID:\s*(\S+)/.exec(text)?.[1] ?? "";
    const asc = parseAscJson([{ id: subId, state: "UNRESOLVED_ISSUES", submittedDate: "2026-09-16T10:00:00Z", lastUpdatedDate: "2026-09-17T16:05:00Z" }], { bundleId: "com.luna" });
    expect(asc.warnings.join(" ")).toContain("paste the Resolution Center message");
    const loc = { path: path.join(home, "teams", "T", "events.jsonl") };
    await commitImport(loc, asc);
    const existing = await readEvents(loc);
    const res = parseAppleText(text, { bundleId: "com.luna", existing });
    const outcome = res.proposed.find((p) => p.event.type === "outcome");
    expect(outcome?.duplicateOf).toBeUndefined();
    expect(outcome?.summary).toContain("same review of this submission");
    await commitImport(loc, res);
    const state = foldEvents("T", await readEvents(loc));
    expect(state.rejections).toHaveLength(1);
    expect(state.rejections[0]?.guidelines).toEqual(["1.2"]);
    expect(state.rejections[0]?.reviewerMessage).toContain("free-text description");
    // pasting the same text again is a duplicate
    const again = parseAppleText(text, { bundleId: "com.luna", existing: await readEvents(loc) });
    expect(again.proposed.find((p) => p.event.type === "outcome")?.duplicateOf).toBeDefined();
  });

  it("skips approvals when an agent commits an import", async () => {
    const loc = { path: path.join(home, "teams", "T", "events.jsonl") };
    const res = await importAppleData({ text: APPROVAL }, { bundleId: "com.example.dreamgf" });
    const written = await commitImport(loc, res, { source: "agent" });
    expect(written.some((e) => e.type === "outcome")).toBe(false);
    expect(res.warnings.join(" ")).toContain("appstore-shield import");
  });
});

describe("commitImport from an agent-started process", () => {
  it("stores an approval imported from a human terminal, but not one imported through an agent session", async () => {
    const human = { path: path.join(home, "teams", "H", "events.jsonl") };
    const res = await importAppleData({ text: APPROVAL }, { bundleId: "com.example.dreamgf" });
    const stored = await commitImport(human, res, { env: {} });
    expect(stored.find((e) => e.type === "outcome")).toMatchObject({ outcome: "approved", source: "import" });

    const viaAgent = { path: path.join(home, "teams", "A", "events.jsonl") };
    const again = await importAppleData({ text: APPROVAL }, { bundleId: "com.example.dreamgf" });
    const written = await commitImport(viaAgent, again, { env: { CLAUDECODE: "1" } });
    expect(written.some((e) => e.type === "outcome" && e.outcome === "approved")).toBe(false);
    expect(again.warnings.join(" ")).toMatch(/appstore-shield import <file>.*terminal/);
    expect(foldEvents("A", await readEvents(viaAgent)).outcomes.some((o) => o.outcome === "approved")).toBe(false);
  });

  it("still stores rejections imported through an agent session, as agent events", async () => {
    const loc = { path: path.join(home, "teams", "R", "events.jsonl") };
    const res = await importAppleData({ text: REJECTION });
    const written = await commitImport(loc, res, { env: { CLAUDECODE: "1" } });
    expect(written.find((e) => e.type === "outcome")).toMatchObject({ outcome: "rejected", source: "agent" });
  });

  it("refuses events dated well after now, and keeps ones dated today", async () => {
    const loc = { path: path.join(home, "teams", "F", "events.jsonl") };
    const future = await importAppleData({ text: "Your submission was accepted and the following items are now eligible for distribution.\nApp Name: AI Photo\nDate: Mon, 30 Nov 2026 10:00:00 -0700" });
    const now = Date.parse("2026-10-31T12:00:00Z");
    expect(await commitImport(loc, future, { env: {}, now })).toEqual([]);
    expect(future.warnings.join(" ")).toMatch(/after today/);
    const today = await importAppleData({ text: "Your submission was accepted and the following items are now eligible for distribution.\nApp Name: AI Photo\nDate: Sat, 31 Oct 2026 10:00:00 -0700" });
    expect((await commitImport(loc, today, { env: {}, now })).length).toBeGreaterThan(0);
  });
});

describe("importAppleData + commitImport", () => {
  it("chooses the parser from content and commits non-duplicates with source import", async () => {
    const file = path.join(home, "history.json");
    await writeFile(file, JSON.stringify([{ submissionId: "s1", submittedDate: "2026-10-10T10:00:00Z", outcome: "approved", versionString: "2.0" }]));
    const fromFile = await importAppleData({ filePath: file }, { bundleId: "com.a" });
    expect(fromFile.format).toBe("asc_json");
    const loc = { path: path.join(home, "teams", "T", "events.jsonl") };
    const written = await commitImport(loc, fromFile, { env: {} });
    expect(written).toHaveLength(2);
    expect(written.every((e) => e.source === "import")).toBe(true);

    const text = await importAppleData({ text: REJECTION });
    expect(text.format).toBe("apple_text");
    await commitImport(loc, text);
    const state = foldEvents("T", await readEvents(loc));
    expect(state.rejections[0]?.guidelines).toEqual(["1.2", "2.3.1(a)"]);

    const again = await importAppleData({ filePath: file }, { bundleId: "com.a", existing: await readEvents(loc) });
    expect(again.proposed.every((p) => p.duplicateOf)).toBe(true);
    expect(await commitImport(loc, again)).toEqual([]);
  });

  it("explains what to do when there is nothing to import", async () => {
    await expect(importAppleData({ text: "  " })).rejects.toThrow(/Nothing to import/);
    await expect(importAppleData({ filePath: path.join(home, "missing.eml") })).rejects.toThrow(/Cannot read/);
  });

  it("refuses a FIFO or an oversized file instead of hanging or reading it all", async () => {
    const fifo = path.join(home, "pipe.eml");
    await promisify(execFile)("mkfifo", [fifo]);
    await expect(importAppleData({ filePath: fifo })).rejects.toThrow(/Cannot read .*not a regular file/);
    const big = path.join(home, "big.eml");
    await writeFile(big, "x".repeat(2 * 1024 * 1024 + 1));
    await expect(importAppleData({ filePath: big })).rejects.toThrow(/Cannot read .*larger than/);
  });
});

describe("12-hour times and zone names", () => {
  it("reads PM as afternoon, 12 AM as midnight and 12 PM as noon", () => {
    expect(extractDateHit("September 21, 2026 at 11:18 PM")).toEqual({ at: "2026-09-21T23:18:00.000Z", timed: true, localZone: true });
    expect(extractDateHit("Date: September 21, 2026 at 3:05 PM")?.at).toBe("2026-09-21T15:05:00.000Z");
    expect(extractDateHit("Date: September 21, 2026 at 12:05 AM")?.at).toBe("2026-09-21T00:05:00.000Z");
    expect(extractDateHit("Date: September 21, 2026 at 12:30 PM")?.at).toBe("2026-09-21T12:30:00.000Z");
    expect(extractDateHit("September 21, 2026 at 9:00 am")?.at).toBe("2026-09-21T09:00:00.000Z");
  });

  it("applies US zone abbreviations instead of dropping them", () => {
    expect(extractDateHit("Sent: Monday, September 21, 2026 3:05 PM PDT")?.at).toBe("2026-09-21T22:05:00.000Z");
    expect(extractDateHit("Date: December 1, 2026 at 9:15 AM (PST)")?.at).toBe("2026-12-01T17:15:00.000Z");
    expect(extractDateHit("From Apple\nSeptember 21, 2026 at 11:18 AM EDT\n\nHello")?.at).toBe("2026-09-21T15:18:00.000Z");
    // an offset already present wins over the trailing name
    expect(extractDateHit("Date: Tue, 6 Oct 2026 14:27:03 -0700 (PDT)")?.at).toBe("2026-10-06T21:27:03.000Z");
    // a capitalized word after the time is not a zone
    expect(extractDateHit("September 21, 2026 at 2:00 PM Guideline 1.1")?.at).toBe("2026-09-21T14:00:00.000Z");
  });

  it("reads GMT-7 / GMT+5:30 as offsets, not as plain GMT", () => {
    expect(extractDateHit("Date: Thursday, September 17, 2026 at 10:15:30 AM GMT-7")).toEqual({ at: "2026-09-17T17:15:30.000Z", timed: true });
    expect(extractDateHit("Sent: Thursday, September 17, 2026 at 10:15 AM GMT+05:30")?.at).toBe("2026-09-17T04:45:00.000Z");
    expect(extractDateHit("From Apple\nSeptember 17, 2026 at 10:15 AM GMT+2\n\nHello")?.at).toBe("2026-09-17T08:15:00.000Z");
    expect(extractDateHit("Date: September 17, 2026 at 10:15 AM UTC-3")?.at).toBe("2026-09-17T13:15:00.000Z");
  });

  it("reads a time with no zone as the machine's local time, and gives it the date-only future slack", () => {
    const prev = process.env.TZ;
    try {
      process.env.TZ = "Asia/Tokyo";
      // Outlook / Gmail copy: local time, no zone. In Tokyo at 18:13Z this is 03:13 on November 1.
      const text = "Sent: Sunday, November 1, 2026 3:13 AM\n\nGuideline 1.2 - Safety - User-Generated Content\nWe noticed an issue with your submission.";
      expect(extractDateHit(text)).toEqual({ at: "2026-10-31T18:13:00.000Z", timed: true, localZone: true });
      const r = parseAppleText(text);
      const p = r.proposed[0]!;
      expect(p.event.at).toBe("2026-10-31T18:13:00.000Z");
      expect(p.timed).toBe(false);
      expect(isFutureDated(p, Date.parse("2026-10-31T18:13:00Z"))).toBe(false);
      expect(r.warnings.join(" ")).toMatch(/without a time zone.*Asia\/Tokyo/);
      // Even when this machine's zone is not the one the mail client used, the import is not refused.
      process.env.TZ = "America/Los_Angeles";
      const west = parseAppleText(text).proposed[0]!;
      expect(isFutureDated(west, Date.parse("2026-10-31T18:13:00Z"))).toBe(false);
      // A message with a real offset keeps clock-skew slack only.
      const zoned = parseAppleText("Date: Sun, 1 Nov 2026 03:13:00 +0000\n\nGuideline 1.2 - Safety\nWe noticed an issue with your submission.").proposed[0]!;
      expect(zoned.timed).toBe(true);
      expect(isFutureDated(zoned, Date.parse("2026-10-31T18:13:00Z"))).toBe(true);
    } finally {
      process.env.TZ = prev;
    }
  });

  it("keeps only the calendar date, and warns, when the zone name cannot be converted", () => {
    expect(extractDateHit("Date: September 21, 2026 at 3:05 PM IST")).toEqual({ at: "2026-09-21T12:00:00.000Z", timed: false, unknownZone: "IST" });
    const r = parseAppleText("Date: September 21, 2026 at 3:05 PM IST\n\nGuideline 1.2 - Safety - User-Generated Content\nWe noticed an issue with your submission.");
    expect(r.warnings.join(" ")).toMatch(/"IST".*only the calendar date/);
  });

  it("orders a 9 AM approval before a 2 PM rejection of the same day, so the gate still holds", () => {
    const approval = parseAppleText("September 21, 2026 at 9:00 AM\n\nYour app status is Ready for Distribution.", { bundleId: "com.a" });
    const rejection = parseAppleText("September 21, 2026 at 2:00 PM Guideline 1.1 - Safety - Objectionable Content\nWe noticed sexual content in your app.", { bundleId: "com.a" });
    const a = approval.proposed.find((p) => p.event.type === "outcome")!.event;
    const r = rejection.proposed.find((p) => p.event.type === "outcome")!.event;
    expect(a.at).toBe("2026-09-21T09:00:00.000Z");
    expect(r.at).toBe("2026-09-21T14:00:00.000Z");
    const state = foldEvents("T", [LedgerEvent.parse({ ...a, id: "ev_a", source: "import" }), LedgerEvent.parse({ ...r, id: "ev_r", source: "import" })]);
    expect(state.rejections[0]?.approvedBy).toBeUndefined();
    expect(gateDecision(state, [], "2026-09-22T00:00:00.000Z").verdict).toBe("HOLD");
  });
});

describe("cited guidelines and Apple replies", () => {
  it("takes guidelines from App Review's header lines, not from advice in the body", () => {
    const text = "Guideline 1.1 - Safety - Objectionable Content\n\nApps with AI content must also include the safeguards described in Guideline 1.2.";
    expect(citedGuidelines(text)).toEqual(["1.1"]);
    expect(extractGuidelines(text)).toEqual(["1.1", "1.2"]);
    // with no header line, every mention is all there is
    expect(citedGuidelines("We noticed your app violates Guideline 4.3.")).toEqual(["4.3"]);
  });

  it("records a Resolution Center reply as apple_reply linked to the recorded rejection", async () => {
    const loc = { path: path.join(home, "teams", "AR", "events.jsonl") };
    const rejText = await readFile(path.join(__dirname, "../fixtures/ledger/rejection-1.2.txt"), "utf8");
    const replyText = await readFile(path.join(__dirname, "../fixtures/ledger/resolution-reply.txt"), "utf8");
    await commitImport(loc, parseAppleText(rejText, { bundleId: "com.luna" }), { env: {} });
    const reply = parseAppleText(replyText, { bundleId: "com.luna", existing: await readEvents(loc) });
    const p = reply.proposed.find((x) => x.event.type === "apple_reply");
    expect(p?.duplicateOf).toBeUndefined();
    expect(reply.proposed.some((x) => x.event.type === "outcome")).toBe(false);
    await commitImport(loc, reply, { env: {} });
    const state = foldEvents("AR", await readEvents(loc));
    expect(state.rejections).toHaveLength(1);
    expect(state.rejections[0]?.appleReplies).toHaveLength(1);
    // pasted again, the reply is a duplicate
    const again = parseAppleText(replyText, { bundleId: "com.luna", existing: await readEvents(loc) });
    expect(again.proposed.find((x) => x.event.type === "apple_reply")?.duplicateOf).toBeDefined();
  });

  it("links a reply pasted together with its rejection, and keeps an unmatched reply that names an issue as a rejection", async () => {
    const rejText = await readFile(path.join(__dirname, "../fixtures/ledger/rejection-1.2.txt"), "utf8");
    const replyText = await readFile(path.join(__dirname, "../fixtures/ledger/resolution-reply.txt"), "utf8");
    const both = parseAppleText(`${rejText}\n-----Original Message-----\n${replyText}`, { bundleId: "com.luna" });
    expect(both.proposed.filter((x) => x.event.type !== "app").map((x) => x.event.type)).toEqual(["outcome", "apple_reply"]);
    const loc = { path: path.join(home, "teams", "AB", "events.jsonl") };
    await commitImport(loc, both, { env: {} });
    expect(foldEvents("AB", await readEvents(loc)).rejections[0]?.appleReplies).toHaveLength(1);

    const alone = parseAppleText(replyText, { bundleId: "com.luna" });
    expect(alone.proposed.find((x) => x.event.type === "outcome")?.event).toMatchObject({ outcome: "rejected", guidelines: ["1.2"] });
    expect(alone.warnings.join(" ")).toMatch(/matches no recorded rejection/);
  });
});

describe("test/fixtures/ledger/EXPECTED.md", () => {
  const read = (name: string) => readFile(path.join(__dirname, "../fixtures/ledger", name), "utf8");
  const ORDER = ["rejection-1.1.txt", "rejection-1.2.txt", "resolution-reply.txt", "approval.txt", "termination-3.2f.txt"];

  it("imports all five samples with the expected fields, and a second import adds nothing", async () => {
    const loc = { path: path.join(home, "teams", "ABCDE12345", "events.jsonl") };
    const results: Record<string, Awaited<ReturnType<typeof importAppleData>>> = {};
    for (const f of ORDER) {
      const res = await importAppleData({ text: await read(f) }, { bundleId: "com.luna", existing: await readEvents(loc) });
      results[f] = res;
      await commitImport(loc, res, { env: {}, now: Date.parse("2026-10-31T00:00:00Z") });
    }
    const main = (f: string) => results[f]!.proposed.find((p) => p.event.type !== "app")!;

    const r11 = main("rejection-1.1.txt");
    expect(r11.event).toMatchObject({ type: "outcome", outcome: "rejected", guidelines: ["1.1"], submissionId: "4c1e9a72-58d3-4b0f-a6e2-9d31c7f0b815", at: "2026-08-04T01:42:10.000Z" });
    expect(r11.summary).toContain("Luna - AI Companion 1.2 (37)");
    expect(results["rejection-1.1.txt"]!.proposed.find((p) => p.event.type === "app")?.event).toMatchObject({ name: "Luna - AI Companion" });

    const r12 = main("rejection-1.2.txt");
    expect(r12.event).toMatchObject({ type: "outcome", outcome: "rejected", guidelines: ["1.2"], submissionId: "9b27d4e0-1f6a-4c83-b5d9-72e0a4c6f193", at: "2026-09-17T16:05:51.000Z" });
    expect(r12.summary).toContain("1.3 (42)");
    expect(String(r12.event.reviewerMessage)).toContain("We were able to generate sexually suggestive images of the AI character by entering a free-text description");

    const reply = main("resolution-reply.txt");
    expect(reply.event).toMatchObject({ type: "apple_reply", submissionId: "9b27d4e0-1f6a-4c83-b5d9-72e0a4c6f193", at: "2026-09-21T11:18:00.000Z" });
    expect(reply.duplicateOf).toBeUndefined();
    expect(reply.summary).toContain("Guideline 1.2");

    const ok = main("approval.txt");
    expect(ok.event).toMatchObject({ type: "outcome", outcome: "approved", submissionId: "e5a0c3b1-7d92-4f68-8a14-3bc6d2f9a057", at: "2026-10-06T21:27:03.000Z" });
    expect(ok.summary).toContain("1.3 (43)");

    const term = results["termination-3.2f.txt"]!;
    expect(term.proposed.map((p) => p.event.type)).toEqual(["termination"]);
    expect(term.proposed[0]?.event.bundleId).toBeUndefined();
    expect(term.proposed[0]?.summary).toContain("DPLA 3.2(f)");
    expect(term.proposed[0]?.summary).not.toMatch(/Guideline/);
    expect(String(term.proposed[0]?.event.at).slice(0, 10)).toBe("2026-10-30");

    const state = foldEvents("ABCDE12345", await readEvents(loc));
    expect(state.rejections.map((r) => r.guidelines)).toEqual([["1.1"], ["1.2"]]);
    const rej12 = state.rejections.find((r) => r.submissionId === "9b27d4e0-1f6a-4c83-b5d9-72e0a4c6f193");
    expect(rej12?.appleReplies).toHaveLength(1);
    const approvals = state.outcomes.filter((o) => o.outcome === "approved");
    expect(approvals).toHaveLength(1);
    expect(state.terminations).toHaveLength(1);
    // the approval closes both rejections, as both are for the same app
    expect(state.rejections.map((r) => r.approvedBy)).toEqual([approvals[0]!.id, approvals[0]!.id]);

    const items = triggerChecklist(state, "2026-10-31T00:00:00.000Z");
    const it = (id: string) => items.find((i) => i.id === id)!;
    expect(it("rejections_180d").count).toBe(2);
    expect(it("rejections_180d").detail).toEqual(["1.1: 1", "1.2: 1"]);
    expect(it("repeat_guideline_rejections").count).toBe(0);
    expect(it("open_rejections_unverified").count).toBe(0);

    const count = (await readEvents(loc)).length;
    for (const f of ORDER) {
      const again = await importAppleData({ text: await read(f) }, { bundleId: "com.luna", existing: await readEvents(loc) });
      expect(again.proposed.every((p) => p.duplicateOf), f).toBe(true);
      await commitImport(loc, again, { env: {} });
    }
    expect((await readEvents(loc)).length).toBe(count);
  });
});

describe("a second rejection of a resubmitted submission (same App Store Connect id)", () => {
  const SUB = "9b27d4e0-1f6a-4c83-b5d9-72e0a4c6f193";
  const first = LedgerEvent.parse({
    id: "ev_a1",
    at: "2026-09-17T16:05:51.000Z",
    source: "import",
    type: "outcome",
    outcome: "rejected",
    guidelines: ["1.2"],
    reviewerMessage: "Guideline 1.2 we could generate suggestive images via free text",
    submissionId: SUB,
    bundleId: "app.quillwriter.ios",
  });
  const ack = LedgerEvent.parse({ id: "ev_k1", at: "2026-09-18T10:00:00.000Z", source: "human", type: "ack", rejectionId: "ev_a1", note: "resubmitting with the fix" });
  const email = (guideline: string) =>
    `From: App Store Connect <no_reply@email.apple.com>\nSubject: There's an issue with your submission\nDate: Mon, 5 Oct 2026 10:00:00 -0700\n\nApp Name: Quill\nSubmission ID: ${SUB}\nVersion reviewed: 2.0 (12)\nReview date: October 5, 2026\n\nGuideline ${guideline} - Safety - User-Generated Content\n\nIssue Description\n\nWe were still able to generate objectionable images by uploading a photo.\n`;

  for (const guideline of ["1.2", "2.1"]) {
    it(`records it as its own open rejection that holds the gate, even after the first was acked (Guideline ${guideline})`, async () => {
      const loc = { path: path.join(home, "teams", "T", "events.jsonl") };
      await mkdir(path.dirname(loc.path), { recursive: true });
      await writeFile(loc.path, `${JSON.stringify(first)}\n${JSON.stringify(ack)}\n`);
      const res = parseAppleText(email(guideline), { bundleId: "app.quillwriter.ios", existing: await readEvents(loc) });
      const outcome = res.proposed.find((p) => p.event.type === "outcome");
      expect(outcome?.duplicateOf).toBeUndefined();
      expect(outcome?.summary).toContain("a new rejection of a submission already decided in ev_a1");
      const stored = await commitImport(loc, res, { env: {} });
      // parsed from Apple's message, so its text can be quoted as Apple's
      expect(stored.every((e) => e.via === "import")).toBe(true);
      const state = foldEvents("T", await readEvents(loc));
      expect(state.rejections).toHaveLength(2);
      const second = state.rejections[1]!;
      expect(second.acked).toBe(false);
      expect(state.rejections[0]?.acked).toBe(true);
      const gate = gateDecision(state, [], "2026-10-06T00:00:00.000Z");
      expect(gate.verdict).toBe("HOLD");
      expect(gate.holdReasons.join(" ")).toContain(second.id);
      const objectionable = triggerChecklist(state, "2026-10-06T00:00:00.000Z").find((i) => i.id === "objectionable_rejections_180d");
      expect(objectionable?.count).toBe(guideline === "1.2" ? 2 : 1);
    });
  }

  it("still merges the email and the Resolution Center text of one decision, and an asc row of that submission", () => {
    const rc = LedgerEvent.parse({ ...first, id: "ev_rc", at: "2026-09-17T12:00:00.000Z", reviewerMessage: "Hello, the full Resolution Center message about 1.2", guidelines: ["1.2", "4.0"] });
    const asc = LedgerEvent.parse({ ...first, id: "ev_asc", at: "2026-10-20T00:00:00.000Z", reviewerMessage: undefined, guidelines: [] });
    const state = foldEvents("T", [first, rc, asc]);
    expect(state.rejections).toHaveLength(1);
    expect(state.rejections[0]?.guidelines).toEqual(["1.2", "4.0"]);
  });
});

describe("numeric day/month dates", () => {
  const msg = (d: string) => `From: App Store Connect\nSent: ${d}\nSubject: Submission\n\nHello,\n\nGuideline 2.1 - Performance - App Completeness\n\nWe found an issue with your app.`;
  const withTz = <T>(tz: string, f: () => T): T => {
    const prev = process.env.TZ;
    process.env.TZ = tz;
    try {
      return f();
    } finally {
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  };

  it("refuses an ambiguous en-GB short date instead of reading it as month/day, and says why", () => {
    for (const d of ["06/10/2026 21:00", "06/10/2026", "06.10.2026 21:00"]) {
      const r = withTz("Europe/London", () => parseAppleText(msg(d)));
      expect(r.proposed[0]?.event.at, d).toBeUndefined();
      const w = r.warnings.join(" ");
      expect(w, d).toMatch(/ambiguous day\/month date \("06[/.]10[/.]2026" is 6 October 2026 in day\/month order and June 10, 2026 in month\/day order\)/);
      expect(w, d).not.toMatch(/No date found/);
    }
  });

  it("reads a date whose day is above 12 in the order the numbers decide", () => {
    withTz("Europe/London", () => {
      expect(parseAppleText(msg("13/10/2026 21:00")).proposed[0]?.event.at).toBe("2026-10-13T20:00:00.000Z");
      expect(parseAppleText(msg("13/10/2026 21:00 +0100")).proposed[0]?.event.at).toBe("2026-10-13T20:00:00.000Z");
      expect(parseAppleText(msg("Tue, 13.10.2026 21:00 BST")).proposed[0]?.event.at).toBe("2026-10-13T20:00:00.000Z");
      expect(parseAppleText(msg("10/13/2026 9:00 PM")).proposed[0]?.event.at).toBe("2026-10-13T20:00:00.000Z");
      expect(parseAppleText(msg("13/10/2026")).proposed[0]?.event.at).toBe("2026-10-13T12:00:00.000Z");
    });
    // the same number twice is one date in either order; impossible ones are not dates
    expect(parseAppleText(msg("06/06/2026")).proposed[0]?.event.at).toBe("2026-06-06T12:00:00.000Z");
    expect(parseAppleText(msg("32/10/2026")).proposed[0]?.event.at).toBeUndefined();
    expect(extractDateHit("Sent: 06/10/2026 21:00")).toBeUndefined();
  });
});

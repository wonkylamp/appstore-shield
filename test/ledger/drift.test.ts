import { describe, expect, it } from "vitest";
import {
  buildSnapshots,
  denialClauses,
  diffSinceApproved,
  flagsSnapshot,
  modelIdSnapshot,
  otaSnapshot,
  paywallSnapshots,
  redactSecrets,
  remoteConfigDefaultsSnapshots,
  serverPromptSnapshots,
  stableHash,
  type SnapshotInput,
} from "../../src/ledger/drift.js";
import { LedgerEvent, type RemoteControl } from "../../src/ledger/schema.js";
import { foldEvents } from "../../src/ledger/store.js";
import { ctxFromFiles } from "../helpers.js";

let n = 0;
function ev(type: LedgerEvent["type"], at: string, fields: Record<string, unknown> = {}, source = "agent"): LedgerEvent {
  n += 1;
  return LedgerEvent.parse({ id: `ev_d${n}`, type, at, source, ...fields });
}
const asEvent = (s: SnapshotInput, at: string) => ev("config_snapshot", at, s as unknown as Record<string, unknown>);

const control = (key: string, classification: RemoteControl["classification"], defaultValue = "false"): RemoteControl => ({
  key,
  provider: "firebase",
  classification,
  defaultValue,
  gates: "shows outfit picker",
});

describe("snapshot builders", () => {
  it("hashes stable JSON regardless of key order", () => {
    expect(stableHash({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(stableHash({ b: [1, { d: 3, c: 2 }], a: 1 }));
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
  });

  it("builds a flags inventory snapshot that ignores read-site order", () => {
    const a = flagsSnapshot([control("b", "product"), control("a", "content-gating")]);
    const b = flagsSnapshot([control("a", "content-gating"), control("b", "product"), control("a", "content-gating")]);
    expect(a.hash).toBe(b.hash);
    expect(a.summary).toContain("1 gating content or price");
  });

  it("finds OTA config, server prompts, model ids and paywall config in a repo", async () => {
    const ctx = await ctxFromFiles({
      "package.json": JSON.stringify({ dependencies: { "expo-updates": "~0.25.0", react: "18" } }),
      "app.json": JSON.stringify({ expo: { runtimeVersion: "1.0.0", updates: { url: "https://u.expo.dev/x" } } }),
      "eas.json": JSON.stringify({ build: { production: { channel: "production" } } }),
      "server/prompts/companion.txt": "You are a friendly companion. Keep it PG.",
      "server/chat.ts": 'const messages = [{ role: "system", content: "You are a helpful and safe assistant for the app." }];\nconst model = "gpt-4o-mini";',
      "src/gen.ts": 'replicate.run("black-forest-labs/flux-schnell", { input });',
      "src/paywall.config.json": JSON.stringify({ offering: "default", price: "$4.99" }),
      "src/App.tsx": "export default function App() { return null; }",
    });
    const ota = otaSnapshot(ctx);
    expect(ota?.data).toMatchObject({ runtimeVersion: "1.0.0", easChannels: { production: "production" } });
    expect(JSON.stringify(ota?.data)).toContain("expo-updates");
    const prompts = serverPromptSnapshots(ctx);
    expect(prompts.map((p) => p.label)).toEqual(["server/chat.ts", "server/prompts/companion.txt"]);
    expect(modelIdSnapshot(ctx)?.data).toEqual({ models: ["black-forest-labs/flux-schnell", "gpt-4o-mini"] });
    expect(paywallSnapshots(ctx).map((p) => p.label)).toEqual(["src/paywall.config.json"]);
    const all = buildSnapshots(ctx, { remoteControls: [control("nsfw_enabled", "content-gating")], bundleId: "com.a" });
    expect(all.every((s) => s.bundleId === "com.a" && s.repo === ctx.root)).toBe(true);
    expect(all.map((s) => s.kind)).toContain("flags_inventory");
  });

  it("stores redacted text in snapshots but hashes the raw text, so a key change is still drift", async () => {
    const files = (key: string) => ({
      "server/system_prompt.txt": `You are a companion. Token: ghp_${"D".repeat(30)}${key}`,
      "src/remote_config_defaults.json": JSON.stringify({ stripe: `sk_live_${"E".repeat(20)}${key}`, spicy_mode: false }),
      "ios/App/Info.plist": `<plist><dict><key>CodePushDeploymentKey</key><string>SECRETCODEPUSHKEY_${key}abcdef</string></dict></plist>`,
      "package.json": JSON.stringify({ dependencies: { "react-native-code-push": "8" } }),
    });
    const a = buildSnapshots(await ctxFromFiles(files("1")));
    const b = buildSnapshots(await ctxFromFiles(files("2")));
    const stored = JSON.stringify(a.map((s) => s.data));
    expect(stored).not.toMatch(/ghp_D|sk_live_E|SECRETCODEPUSHKEY/);
    expect(stored).toContain("[redacted]");
    expect(stored).toContain("spicy_mode");
    expect(a.map((s) => s.hash)).not.toEqual(b.map((s) => s.hash));
    expect(remoteConfigDefaultsSnapshots(await ctxFromFiles(files("1")))).toHaveLength(1);
  });

  it("keeps only the shape of whole files, so credentials no pattern catches never reach the ledger", async () => {
    const files = {
      "src/remote_config_defaults.json": JSON.stringify({ db: "postgres://admin:Sup3rS3cretPw@db.internal:5432/app", pwd: "correct-horse-battery", spicy_mode: false }),
      "server/prompts/system.txt": "You are Luna.\nadmin password hunter2hunter2\nAuthorization: Bearer abcdef0123456789abcdef",
      "src/paywall.config.json": JSON.stringify({ webhook: "https://hooks.slack.com/services/T0FAKE000/B0FAKE000/abcdefFAKEwebhook0000", price: "$4.99" }),
    };
    const snaps = buildSnapshots(await ctxFromFiles(files));
    const stored = JSON.stringify(snaps.map((x) => x.data));
    expect(stored).not.toMatch(/Sup3rS3cretPw|correct-horse|hunter2|abcdef0123456789|hooks\.slack\.com|FAKEwebhook/);
    expect(stored).toContain("spicy_mode");
    const changed = buildSnapshots(await ctxFromFiles({ ...files, "server/prompts/system.txt": "You are Luna.\nadmin password hunter3hunter3" }));
    expect(changed.find((x) => x.kind === "server_prompt")?.hash).not.toBe(snaps.find((x) => x.kind === "server_prompt")?.hash);
  });

  it("redacts URL credentials, bearer tokens, webhooks, DSNs and prose passwords in remaining strings", () => {
    const leaks = [
      "postgres://admin:Sup3rS3cretPw@db.internal/app",
      "https://hooks.slack.com/services/T0FAKE000/B0FAKE000/abcdefFAKEwebhook0000",
      "Authorization: Bearer abcdef0123456789abcdef",
      '"pwd": "correct-horse-battery"',
      "admin password hunter2hunter2",
      "https://0123456789abcdef0123456789abcdef@o12345.ingest.sentry.io/678",
      "SUPABASE_SERVICE_ROLE_KEY=abc123def456ghi",
    ];
    for (const l of leaks) expect(redactSecrets(l), l).toContain("[redacted]");
    expect(redactSecrets("postgres://admin:Sup3rS3cretPw@db.internal/app")).toBe("postgres://[redacted]@db.internal/app");
    for (const ok of ["The account is password protected.", "Reset your password from Settings.", "https://example.com/path"]) expect(redactSecrets(ok)).toBe(ok);
  });

  it("leaves ordinary prompt text and model ids alone when redacting", () => {
    const text = 'You are Luna, a friendly companion. Use model "black-forest-labs/flux-schnell" and keep it PG.';
    expect(redactSecrets(text)).toBe(text);
    expect(redactSecrets("apiKey: AbCdEfGh12345678")).toBe("apiKey: [redacted]");
  });

  it("finds nothing in a plain app with no remote surfaces", async () => {
    const ctx = await ctxFromFiles({
      "Sources/App.swift": 'import SwiftUI\nstruct App { let title = "Hello" }',
      "package.json": JSON.stringify({ dependencies: { react: "18" } }),
    });
    expect(buildSnapshots(ctx)).toEqual([]);
  });
});

describe("diffSinceApproved", () => {
  const prompt = (text: string): SnapshotInput => ({
    type: "config_snapshot",
    kind: "server_prompt",
    label: "server/prompts/companion.txt",
    hash: stableHash({ text }),
    summary: "prompt file",
    data: { text },
  });

  it("reports nothing to compare when no approval is recorded", () => {
    const r = diffSinceApproved(foldEvents("T", []), [prompt("a")]);
    expect(r.approvalId).toBeUndefined();
    expect(r.changes).toEqual([]);
  });

  it("compares against the last snapshot at or before the last approval, not later ones", () => {
    const state = foldEvents("T", [
      asEvent(prompt("v1"), "2026-09-01T00:00:00Z"),
      ev("outcome", "2026-09-02T00:00:00Z", { outcome: "approved" }, "import"),
      asEvent(prompt("v2"), "2026-09-10T00:00:00Z"),
    ]);
    const changed = diffSinceApproved(state, [prompt("v2")]);
    expect(changed.changes).toHaveLength(1);
    expect(changed.changes[0]).toMatchObject({ kind: "server_prompt", change: "changed", contentOrPrice: true, disclosed: false });
    expect(diffSinceApproved(state, [prompt("v1")]).changes).toEqual([]);
  });

  it("marks a change disclosed when pending review notes mention it specifically", () => {
    const state = foldEvents("T", [
      asEvent(prompt("v1"), "2026-09-01T00:00:00Z"),
      ev("outcome", "2026-09-02T00:00:00Z", { outcome: "approved" }, "import"),
      ev("message_sent", "2026-09-11T00:00:00Z", { purpose: "review_notes", text: "We changed the companion server prompt to refuse clothing-change requests.", textHash: "h" }),
    ]);
    const r = diffSinceApproved(state, [prompt("v2")]);
    expect(r.changes[0]?.disclosed).toBe(true);
    expect(r.pendingNotesEventId).toBeDefined();
    const undisclosed = diffSinceApproved(state, [prompt("v2")], { pendingNotes: "Bug fixes." });
    expect(undisclosed.changes[0]?.disclosed).toBe(false);
  });

  it("does not count a generic keyword as disclosing a content or price change", () => {
    const models = (ids: string[]): SnapshotInput => ({ kind: "model_id", label: "models", hash: stableHash(ids), summary: ids.join(", "), data: { models: ids } });
    const paywall = (price: string): SnapshotInput => ({ kind: "paywall", label: "src/paywall.config.json", hash: stableHash(price), summary: "paywall", data: { text: price } });
    const state = foldEvents("T", [
      asEvent(prompt("v1"), "2026-09-01T00:00:00Z"),
      asEvent(models(["gpt-4o-mini"]), "2026-09-01T00:00:00Z"),
      asEvent(paywall("$4.99"), "2026-09-01T00:00:00Z"),
      asEvent(flagsSnapshot([control("nsfw_mode", "content-gating", "false")]), "2026-09-01T00:00:00Z"),
      ev("outcome", "2026-09-02T00:00:00Z", { outcome: "approved" }, "import"),
    ]);
    const now = [prompt("v2"), models(["flux-dev-uncensored"]), paywall("$9.99"), flagsSnapshot([control("nsfw_mode", "content-gating", "true")])];
    const vague = diffSinceApproved(state, now, { pendingNotes: "We use a model hosted by fal.ai. Pricing is shown on the paywall. We use remote config and a server prompt." });
    for (const c of vague.changes.filter((x) => x.contentOrPrice)) {
      expect(c.disclosed, c.label).toBe(false);
      if (c.kind !== "flags_inventory") expect(c.mentionedOnly, c.label).toBe(true);
    }
    const specific = diffSinceApproved(state, now, {
      pendingNotes:
        "Since version 1.3 we switched the image model from gpt-4o-mini to flux-dev-uncensored. The paywall.config price changed to $9.99. The flag nsfw_mode now defaults to true. We changed the companion server prompt.",
    });
    for (const c of specific.changes.filter((x) => x.contentOrPrice)) expect(c.disclosed, c.label).toBe(true);
    // naming the label without saying it changed is not a disclosure of the change
    const named = diffSinceApproved(state, now, { pendingNotes: "The app uses flux-dev-uncensored." });
    expect(named.changes.find((c) => c.kind === "model_id")?.disclosed).toBe(false);
  });

  it("never counts a denial as a disclosure", () => {
    const state = foldEvents("T", [
      asEvent(flagsSnapshot([control("lingerie_outfits", "content-gating", "false")]), "2026-09-01T00:00:00Z"),
      asEvent(prompt("v1"), "2026-09-01T00:00:00Z"),
      ev("outcome", "2026-09-02T00:00:00Z", { outcome: "approved" }, "import"),
    ]);
    const now = [flagsSnapshot([control("lingerie_outfits", "content-gating", "true")]), prompt("v2")];
    for (const notes of [
      "The lingerie_outfits flag has not changed since the last approval. The companion server prompt was not updated.",
      "No changes to lingerie_outfits. Nothing new in the companion prompt.",
      "lingerie_outfits is unchanged, and the companion prompt remains the same as approved.",
      "We answered the rejection by changing the picker, and lingerie_outfits hasn't been touched. The companion prompt wasn't modified.",
    ]) {
      const r = diffSinceApproved(state, now, { pendingNotes: notes });
      for (const c of r.changes) expect(c.disclosed, `${c.label}: ${notes}`).toBe(false);
    }
    // a real disclosure that also limits its scope still counts
    const real = diffSinceApproved(state, now, {
      pendingNotes: "The lingerie_outfits flag was turned on, so the model will not change outfits on its own; nothing else changed. We updated the companion prompt so it will not change clothing.",
    });
    for (const c of real.changes) expect(c.disclosed, c.label).toBe(true);
  });

  it("diffs flags per key and only marks content/price flags", () => {
    const state = foldEvents("T", [
      asEvent(flagsSnapshot([control("onboarding_v2", "product"), control("nsfw_mode", "content-gating", "false")]), "2026-09-01T00:00:00Z"),
      ev("outcome", "2026-09-02T00:00:00Z", { outcome: "approved" }, "import"),
    ]);
    const now = flagsSnapshot([control("onboarding_v2", "product", "true"), control("nsfw_mode", "content-gating", "true"), control("promo_price", "price-gating")]);
    const r = diffSinceApproved(state, [now]);
    const byLabel = Object.fromEntries(r.changes.map((c) => [c.label, c]));
    expect(byLabel["flag onboarding_v2"]?.contentOrPrice).toBe(false);
    expect(byLabel["flag nsfw_mode"]).toMatchObject({ change: "changed", contentOrPrice: true });
    expect(byLabel["flag promo_price"]).toMatchObject({ change: "added", contentOrPrice: true });
  });

  it("does not report a flag as changed when only its read site moved (file:line in gates)", () => {
    const at = (line: number): RemoteControl => ({ ...control("nsfw_presets", "content-gating"), gates: `shows presets at src/screens/StyleScreen.tsx:${line}`, line });
    const state = foldEvents("T", [
      asEvent(flagsSnapshot([at(40)]), "2026-09-01T00:00:00Z"),
      ev("outcome", "2026-09-02T00:00:00Z", { outcome: "approved" }, "import"),
    ]);
    expect(diffSinceApproved(state, [flagsSnapshot([at(42)])]).changes).toEqual([]);
    // an old snapshot that still carried `gates` compares on the stable fields only
    const legacy = asEvent({ ...flagsSnapshot([at(40)]), hash: "old", data: { flags: [{ key: "nsfw_presets", provider: "firebase", classification: "content-gating", defaultValue: "false", gates: "at x:1" }] } }, "2026-09-01T00:00:00Z");
    const s2 = foldEvents("T", [legacy, ev("outcome", "2026-09-02T00:00:00Z", { outcome: "approved" }, "import")]);
    expect(diffSinceApproved(s2, [flagsSnapshot([at(99)])]).changes).toEqual([]);
    // a real default change still shows
    expect(diffSinceApproved(state, [flagsSnapshot([{ ...at(42), defaultValue: "true" }])]).changes).toHaveLength(1);
  });

  it("lists OTA publishes after approval and kinds with no baseline", () => {
    const state = foldEvents("T", [
      ev("outcome", "2026-09-02T00:00:00Z", { outcome: "approved" }, "import"),
      ev("ota_publish", "2026-09-05T00:00:00Z", { channel: "production", message: "new outfits" }),
      ev("ota_publish", "2026-09-01T00:00:00Z", { channel: "production" }),
    ]);
    const r = diffSinceApproved(state, [prompt("v1")]);
    expect(r.changes.map((c) => c.kind)).toEqual(["ota_publish"]);
    expect(r.unbaselined).toEqual(["server_prompt"]);
  });

  it("always tells the developer to resubmit or disclose, never that a change is safe", () => {
    const r = diffSinceApproved(foldEvents("T", [ev("outcome", "2026-09-02T00:00:00Z", { outcome: "approved" }, "import")]), []);
    expect(r.guidance).toMatch(/Resubmit or disclose/);
    expect(r.guidance).toMatch(/name it specifically in Notes for Review/);
    expect(r.guidance).not.toMatch(/\bsafe\b|no need|without review/i);
  });

  it("says disclosing a content or price change records it but does not make it compliant", () => {
    const r = diffSinceApproved(foldEvents("T", [ev("outcome", "2026-09-02T00:00:00Z", { outcome: "approved" }, "import")]), []);
    expect(r.guidance).toMatch(/Content or price changes.*Revert it, or ship it in a build that goes through App Review/);
    expect(r.guidance).toMatch(/Disclosure records a change made after approval; it does not make it compliant \(Guideline 2\.5\.19, DPLA 3\.2\(e\)/);
  });
});

describe("redactSecrets on untrusted repo text", () => {
  it("runs in linear time on adversarial strings", () => {
    const units = ["a-", "a.", " ", "token:", "a=", "password ", "a://u:", "?key=a&", "</key> ", "aA1-"];
    for (const unit of units) {
      for (const len of [4000, 200_000]) {
        const s = unit.repeat(Math.ceil(len / unit.length)).slice(0, len);
        const t = performance.now();
        redactSecrets(s);
        expect(performance.now() - t, `${JSON.stringify(unit)} × ${len}`).toBeLessThan(200);
      }
    }
  });

  it("stores an over-long string as a placeholder, while the snapshot hash still sees the raw text", async () => {
    expect(redactSecrets("x".repeat(5000))).toMatch(/^\[redacted: 5000 characters/);
    const plist = (v: string) => ({ "ios/App/Info.plist": `<plist><dict><key>EXUpdatesURL</key><string>https://x.example.com/${v}</string></dict></plist>`, "package.json": JSON.stringify({ dependencies: { "expo-updates": "1" } }) });
    const a = buildSnapshots(await ctxFromFiles(plist("a-".repeat(60_000))));
    const b = buildSnapshots(await ctxFromFiles(plist("b-".repeat(60_000))));
    expect(a.map((x) => x.hash)).not.toEqual(b.map((x) => x.hash));
  });

  it("redacts signing and key query parameters in URLs, keeping the other parameters", () => {
    expect(redactSecrets("https://u.expo.dev/abc?key=zzSECRETzz123456")).toBe("https://u.expo.dev/abc?key=[redacted]");
    expect(redactSecrets("https://h.com/c?sig=7c9e6679f4ac&channel=prod")).toBe("https://h.com/c?sig=[redacted]&channel=prod");
    expect(redactSecrets("https://b.s3.amazonaws.com/x?X-Amz-Signature=abcdef123&X-Amz-Credential=AKIAX%2F1&id=7")).toBe("https://b.s3.amazonaws.com/x?X-Amz-Signature=[redacted]&X-Amz-Credential=[redacted]&id=7");
    expect(redactSecrets("ios/App/Info.plist:CodePushDeploymentKey=SECRETCODEPUSHKEY_1abcdef")).toBe("ios/App/Info.plist:CodePushDeploymentKey=[redacted]");
    expect(redactSecrets("https://example.com/path?channel=production")).toBe("https://example.com/path?channel=production");
  });

  it("redacts AWS secret keys, Hugging Face and fal keys, and credential-shaped values under a bare key name", () => {
    for (const leak of [
      "AWS secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "aws_secret_access_key wJalrXUtnFEMI+K7MDENG+bPxRfiCYEXAMPLEKEY",
      '"key": "lowercasehexsecret0123456789abcdef0123456789"',
.join("_"),
      "fal key: 12345678-1234-1234-1234-123456789abc:0123456789abcdef0123456789abcdef",
    ]) {
      const out = redactSecrets(leak);
      expect(out, leak).toContain("[redacted]");
      expect(out, leak).not.toMatch(/EXAMPLEKEY|0123456789abcdef0123|ABCDEFGH/);
    }
    // a bare "key" also names flag keys and cache keys; those stay readable
    for (const ok of ['"key": "spicy_mode"', '"cacheKey": "outfits_v2"', "Sources/Features/Companion/CompanionStudioView.swift is the secret screen", "keywords: outfit, fashion, style"]) {
      expect(redactSecrets(ok), ok).toBe(ok);
    }
    expect(flagsSnapshot([{ key: "spicy_mode", provider: "firebase", gates: "outfits", classification: "content-gating" }]).data).toMatchObject({ flags: [{ key: "spicy_mode" }] });
  });

  it("stays linear on adversarial input for the AWS-context pattern", () => {
    for (const unit of ["aws ", "secret/", "aws a/+"]) {
      const s = unit.repeat(Math.ceil(4000 / unit.length)).slice(0, 4000);
      const t = performance.now();
      redactSecrets(s);
      expect(performance.now() - t, unit).toBeLessThan(200);
    }
  });
});

describe("denials of a change", () => {
  it("treats shipping verbs, 'always been off' and 'matched what App Review saw' as denials, but not a present-state description", () => {
    for (const t of [
      "We have not shipped any OTA update since the app was approved.",
      "No OTA updates were deployed after approval.",
      "The outfits_v2 flag has always been off in production.",
      "Everything users saw after approval matched what App Review saw.",
      "We never enabled outfits_v2 after approval.",
    ]) {
      expect(denialClauses(t).length, t).toBeGreaterThan(0);
    }
    for (const t of ["The outfits_v2 flag is not enabled.", "On 2026-09-15 we published an OTA update that changed the outfit list.", "We shipped build 42 with the picker removed."]) {
      expect(denialClauses(t), t).toEqual([]);
    }
  });
});

describe("OTA publishes after approval", () => {
  const base = () => [
    ev("outcome", "2026-08-03T18:00:00Z", { outcome: "rejected", guidelines: ["1.1"], reviewerMessage: "spicy illustration styles" }, "import"),
    ev("outcome", "2026-09-12T00:00:00Z", { outcome: "approved" }, "import"),
  ];

  it("treats a publish whose message adds or restores something as a content change that a generic EAS Update mention does not disclose", async () => {
    const { gateDecision } = await import("../../src/ledger/triggers.js");
    const state = foldEvents("T", [...base(), ev("ota_publish", "2026-10-20T10:00:00Z", { channel: "production", message: "re-enable spicy illustration styles" })]);
    const r = diffSinceApproved(state, [], { pendingNotes: "The app uses EAS Update for bug fixes." });
    const c = r.changes.find((x) => x.kind === "ota_publish");
    expect(c).toMatchObject({ contentOrPrice: true, disclosed: false });
    expect(c?.detail).toContain("re-enable spicy illustration styles");
    const g = gateDecision(state, [], "2026-10-31T00:00:00.000Z", r);
    expect(g.verdict).toBe("HOLD");
    expect(g.holdReasons.join(" ")).toMatch(/does not make it compliant/i);
    // naming the publish itself (day and what it changed) is a specific disclosure
    const named = diffSinceApproved(state, [], { pendingNotes: "On October 20 we published an EAS Update to production that re-enabled spicy illustration styles." });
    expect(named.changes.find((x) => x.kind === "ota_publish")?.disclosed).toBe(true);
  });

  it("keeps a bug-fix publish out of the content class, and still needs it named, with OTA guidance rather than 'resubmit or disclose'", async () => {
    const { gateDecision } = await import("../../src/ledger/triggers.js");
    const state = foldEvents("T", [...base(), ev("ota_publish", "2026-10-20T10:00:00Z", { channel: "production", message: "fix crash for new users on launch" })]);
    const r = diffSinceApproved(state, [], { pendingNotes: "The app uses EAS Update for bug fixes." });
    expect(r.changes[0]).toMatchObject({ contentOrPrice: false, disclosed: false });
    const g = gateDecision(state, [], "2026-10-31T00:00:00.000Z", r);
    const w = g.warnings.find((x) => x.startsWith("Change since last approval"));
    expect(w).toMatch(/may only fix bugs \(Guideline 2\.5\.2\)/);
    expect(w).not.toMatch(/Resubmit or disclose/);
  });

  it("counts a publish naming the rejected capability from its spec as a content change", () => {
    const events = base();
    const state = foldEvents("T", [
      ...events,
      ev("residue_spec", "2026-08-04T00:00:00Z", { rejectionId: events[0]!.id, spec: { feature: "outfits", capability: "dress the character in lingerie", terms: ["lingerie"] } }),
      ev("ota_publish", "2026-10-20T10:00:00Z", { message: "lingerie catalog tweaks" }),
    ]);
    expect(diffSinceApproved(state, []).changes[0]?.contentOrPrice).toBe(true);
  });
});

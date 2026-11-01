import { z } from "zod";

/**
 * The ledger is an append-only event log, one JSON object per line, keyed by Apple
 * Developer Team ID because a 3.2(f) termination acts on the whole account and Shoemaker
 * reports that Apple links related accounts; that history accumulates per account is our
 * inference. State is always a pure fold over events; corrections are new events.
 */

export const LEDGER_VERSION = 1;

// A line whose time does not parse must be reported as invalid, not folded: every ordering,
// window and closing-approval decision reads `at`.
const isoDate = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), "not an ISO-8601 timestamp")
  .describe("ISO-8601 timestamp");

export const EventSource = z
  .enum(["human", "agent", "hook", "import", "ci"])
  .describe("Who appended the event. attestation/ack events must be human (CLI with a TTY).");
export type EventSource = z.infer<typeof EventSource>;

export const ResidueSpec = z.object({
  feature: z.string().describe("Short name of the rejected feature"),
  capability: z
    .string()
    .describe("What must become impossible for a user to do or produce, not which screen was hidden"),
  terms: z.array(z.string()).default([]),
  symbols: z.array(z.string()).default([]),
  assets: z.array(z.string()).default([]).describe("Asset names or globs, e.g. outfit_lingerie_*"),
  strings: z.array(z.string()).default([]).describe("Localization keys"),
  endpoints: z.array(z.string()).default([]),
  flags: z.array(z.string()).default([]).describe("Remote-config / feature-flag keys"),
  promptFragments: z.array(z.string()).default([]),
  inputPaths: z
    .array(z.string())
    .default([])
    .describe("Every way a user could still reach the capability: free-text prompt, remix, picker, image upload, deep link…"),
  confirmedPaths: z
    .array(z.object({ source: z.string(), sink: z.string(), evidence: z.array(z.string()) }))
    .default([])
    .describe("Source→sink paths traced by the agent, with file:line evidence; re-checked on every verify"),
  metadataSurfaces: z
    .array(z.string())
    .default([])
    .describe("Store surfaces that may still show the feature: screenshots, preview video, promo text, IAP names…"),
});
export type ResidueSpec = z.infer<typeof ResidueSpec>;

export const ResidueStatus = z.enum(["PRESENT", "GATED", "DEBUG_ONLY", "UNREFERENCED"]);
export type ResidueStatus = z.infer<typeof ResidueStatus>;

export const ResidueHit = z.object({
  kind: z.enum(["term", "symbol", "asset", "string", "endpoint", "flag", "promptFragment", "metadata", "binary", "obfuscation"]),
  needle: z.string(),
  file: z.string(),
  line: z.number().optional(),
  evidence: z.string().optional(),
  status: ResidueStatus,
  confidence: z.enum(["high", "medium", "low"]),
  reason: z.string(),
});
export type ResidueHit = z.infer<typeof ResidueHit>;

/**
 * Evidence tiers, weakest to strongest. Nothing here proves the capability is gone from
 * the model; only PROBED says anything about behavior, and only for the prompts tried.
 */
export const EvidenceTier = z.enum(["RESIDUE_FOUND", "UNVERIFIABLE", "STATIC_CLEAN", "BUILD_CLEAN", "PROBED"]);
export type EvidenceTier = z.infer<typeof EvidenceTier>;

export const Verification = z.object({
  at: isoDate,
  sha: z.string().optional(),
  baseRef: z.string().optional(),
  tier: EvidenceTier,
  removedInDiff: z.array(z.string()).describe("Files/lines in the diff that removed residue items"),
  // Review-time conditions (review_gating, remote content gating) present at baseRef and gone now.
  // They are not residue of the spec, but 2.5.19 makes them the disclosure that matters most.
  removedConditions: z
    .array(z.object({ rule: z.string(), file: z.string(), line: z.number().optional(), condition: z.string(), gates: z.string().optional() }))
    .optional()
    .describe("Review-time conditions found at baseRef (review_gating.*, remote_config.content_gating) that the diff removed"),
  residue: z.array(ResidueHit),
  inputPaths: z.array(z.object({ inputPath: z.string(), blocked: z.boolean(), evidence: z.array(z.string()) })),
  unverifiable: z.array(z.string()).describe("Items needing developer attestation, e.g. server prompts outside the repo"),
  builtProduct: z
    .object({ path: z.string(), kind: z.string(), hermes: z.boolean(), hits: z.number(), notes: z.array(z.string()) })
    .optional(),
  probe: z.object({ total: z.number(), blocked: z.number(), resultsHash: z.string() }).optional(),
  summary: z.string(),
});
export type Verification = z.infer<typeof Verification>;

export const MetadataSnapshot = z.object({
  locale: z.string().default("default"),
  name: z.string().optional(),
  subtitle: z.string().optional(),
  displayName: z.string().optional(),
  keywords: z.string().optional(),
  promotionalText: z.string().optional(),
  descriptionHash: z.string().optional(),
  source: z.string().describe("Where it was read from, e.g. metadata/app-info/en-US.json or Info.plist"),
});
export type MetadataSnapshot = z.infer<typeof MetadataSnapshot>;

export const RemoteControl = z.object({
  key: z.string(),
  provider: z.string(),
  file: z.string().optional(),
  line: z.number().optional(),
  defaultValue: z.string().optional(),
  gates: z.string().describe("What the gated scope does, as far as code shows"),
  classification: z.enum(["content-gating", "price-gating", "safety-killswitch", "product", "unknown"]),
});
export type RemoteControl = z.infer<typeof RemoteControl>;

const base = {
  id: z.string(),
  at: isoDate,
  source: EventSource,
  bundleId: z.string().optional(),
  repo: z.string().optional().describe("Repo root the event was recorded from"),
  // Set only by the importer: the text was parsed from Apple's own message or export, not typed in.
  via: z.literal("import").optional().describe("Set by the importer; never accepted from a payload"),
};

export const LedgerEvent = z.discriminatedUnion("type", [
  z.object({
    ...base,
    type: z.literal("submission"),
    version: z.string().optional(),
    build: z.string().optional(),
    sha: z.string().optional(),
    channel: z.enum(["app_review", "testflight_external"]).default("app_review"),
    notesEventId: z.string().optional(),
  }),
  z.object({
    ...base,
    type: z.literal("outcome"),
    submissionId: z.string().optional(),
    outcome: z.enum(["approved", "rejected", "withdrawn", "developer_rejected", "metadata_rejected"]),
    reviewerMessage: z.string().optional().describe("Verbatim App Review message"),
    guidelines: z.array(z.string()).default([]),
    screenshots: z.array(z.string()).default([]),
  }),
  z.object({
    ...base,
    type: z.literal("interpretation"),
    rejectionId: z.string().describe("id of the outcome event with outcome=rejected"),
    text: z.string().describe("Capability-level reading of the rejection, written before the fix"),
  }),
  z.object({
    ...base,
    type: z.literal("message_sent"),
    rejectionId: z.string().optional(),
    purpose: z.enum(["review_notes", "reply", "clarification", "appeal_review_board", "appeal_termination"]),
    text: z.string().describe("Exact text sent to Apple"),
    textHash: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal("apple_reply"),
    rejectionId: z.string().optional(),
    // An imported reply can name its submission before the rejection's event id exists.
    submissionId: z.string().optional().describe("App Store Connect submission id; links the reply to that submission's rejection"),
    text: z.string(),
  }),
  z.object({ ...base, type: z.literal("residue_spec"), rejectionId: z.string(), spec: ResidueSpec }),
  z.object({ ...base, type: z.literal("verification"), rejectionId: z.string(), verification: Verification }),
  z.object({
    ...base,
    type: z.literal("config_snapshot"),
    kind: z.enum(["remote_config", "server_prompt", "model_id", "ota", "paywall", "flags_inventory"]),
    label: z.string(),
    hash: z.string(),
    summary: z.string(),
    data: z.unknown().optional(),
  }),
  z.object({ ...base, type: z.literal("metadata_snapshot"), snapshots: z.array(MetadataSnapshot) }),
  z.object({
    ...base,
    type: z.literal("ota_publish"),
    channel: z.string().optional(),
    runtimeVersion: z.string().optional(),
    updateId: z.string().optional(),
    message: z.string().optional(),
  }),
  z.object({ ...base, type: z.literal("attestation"), rejectionId: z.string().optional(), statement: z.string() }),
  z.object({ ...base, type: z.literal("ack"), rejectionId: z.string(), note: z.string() }),
  z.object({ ...base, type: z.literal("termination"), letter: z.string() }),
  z.object({ ...base, type: z.literal("app"), bundleId: z.string(), name: z.string().optional(), note: z.string().optional() }),
  z.object({ ...base, type: z.literal("note"), text: z.string() }),
]);
export type LedgerEvent = z.infer<typeof LedgerEvent>;
export type LedgerEventType = LedgerEvent["type"];

/** Event types an agent or MCP caller may never append (they assert human judgment). */
export const HUMAN_ONLY_EVENTS: LedgerEventType[] = ["attestation", "ack"];

export interface RejectionState {
  id: string;
  at: string;
  bundleId?: string;
  submissionId?: string;
  outcome: "rejected" | "metadata_rejected";
  guidelines: string[];
  reviewerMessage?: string;
  /** the outcome event the reviewer message came from, so its provenance can be shown */
  reviewerMessageEventId?: string;
  interpretation?: string;
  spec?: ResidueSpec;
  verification?: Verification;
  messages: { purpose: string; at: string; eventId: string }[];
  appleReplies: { at: string; eventId: string }[];
  attestations: { statement: string; at: string; eventId: string }[];
  acked: boolean;
  /** id of a later approval for the same app, if any */
  approvedBy?: string;
}

export interface LedgerState {
  teamId: string;
  events: LedgerEvent[];
  apps: { bundleId: string; name?: string }[];
  submissions: Extract<LedgerEvent, { type: "submission" }>[];
  outcomes: Extract<LedgerEvent, { type: "outcome" }>[];
  rejections: RejectionState[];
  metadataSnapshots: Extract<LedgerEvent, { type: "metadata_snapshot" }>[];
  configSnapshots: Extract<LedgerEvent, { type: "config_snapshot" }>[];
  otaPublishes: Extract<LedgerEvent, { type: "ota_publish" }>[];
  terminations: Extract<LedgerEvent, { type: "termination" }>[];
}

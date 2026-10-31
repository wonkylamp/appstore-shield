import { CHECK_IDS, type Check, type CheckId } from "../checks.js";
import { check as accountDeletion } from "./accountDeletion.js";
import { check as aiDataDisclosure } from "./aiDataDisclosure.js";
import { check as genaiSafety } from "./genaiSafety.js";
import { check as metadata } from "./metadata.js";
import { check as otaUpdates } from "./otaUpdates.js";
import { check as paywall } from "./paywall.js";
import { check as privacyManifest } from "./privacyManifest.js";
import { check as ratingsIntegrity } from "./ratingsIntegrity.js";
import { check as remoteConfig } from "./remoteConfig.js";
import { check as reviewGating } from "./reviewGating.js";
import { check as ugcSafeguards } from "./ugcSafeguards.js";

const ALL: Check[] = [
  reviewGating,
  remoteConfig,
  otaUpdates,
  genaiSafety,
  ugcSafeguards,
  aiDataDisclosure,
  ratingsIntegrity,
  paywall,
  metadata,
  accountDeletion,
  privacyManifest,
];

/** Registry keyed by check id, in CHECK_IDS order. */
export const CHECKS: ReadonlyMap<CheckId, Check> = new Map(
  CHECK_IDS.map((id) => {
    const c = ALL.find((x) => x.id === id);
    // A missing scanner is a packaging bug; fail loudly at startup rather than silently skipping a check.
    if (!c) throw new Error(`No scanner registered for check "${id}"`);
    return [id, c] as const;
  }),
);

export function getChecks(ids?: readonly CheckId[]): Check[] {
  const want = ids?.length ? new Set(ids) : undefined;
  return [...CHECKS.values()].filter((c) => !want || want.has(c.id));
}

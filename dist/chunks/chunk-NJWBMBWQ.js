#!/usr/bin/env node
import { createRequire as __shieldCreateRequire } from "node:module";
const require = __shieldCreateRequire(import.meta.url);

// src/checks.ts
var CHECK_IDS = [
  "review_gating",
  "remote_config",
  "ota_updates",
  "genai_safety",
  "ugc_safeguards",
  "ai_data_disclosure",
  "ratings_integrity",
  "paywall",
  "metadata",
  "account_deletion",
  "privacy_manifest"
];

export {
  CHECK_IDS
};

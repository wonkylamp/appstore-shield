# expo-ai-photo — expected findings

An Expo / React Native AI photo-restyle app (fal.ai image-to-image, Firebase Remote Config,
RevenueCat, Supabase Auth, expo-updates) with a Cloudflare Worker in `workers/` that picks the
prompt prefix per request. Store metadata uses the asc canonical layout
(`metadata/app-info/<locale>.json`, `metadata/version/<version>/<locale>.json`; checked with
`asc metadata validate`, offline). Team ID comes from `app.json` `ios.appleTeamId` (`ZYXWV98765`).

The nudification preset wording is deliberately clinical: it is detector test data.

Line format: `<check_id> | <severity> | <file>:<approx line> | <what>`. Lines are approximate (±3).
Literal trigger strings are paraphrased here so this file never looks like a finding itself.

## Seeded issues (must be flagged)

genai_safety | block | src/api/fal.ts:23 | fal.ai request sets the provider safety checker to false; not suppressible
genai_safety | block | src/presets.ts:18 | "undress" / clothes-removal style preset applied to the user's own photo through image-to-image (src/api/fal.ts:2, StyleScreen.tsx:17); nudification; fix must be "remove", never "add a disclaimer"; not suppressible
genai_safety | block | src/presets.ts:19 | "x-ray" / see-through clothing preset on a user photo; nudification; not suppressible
genai_safety | high | src/api/fal.ts:12 | image generator with no moderation of the uploaded photo, prompt or output
review_gating | block | src/presets.ts:23 | date gate (current time after a hard-coded launch date) returns the body presets, so they appear only after review; classify by what the scope returns (nudification presets)
review_gating | block | workers/prompt-router/src/index.ts:11 | in-repo server code checks the client IP against Apple's 17/8 range; not suppressible
review_gating | high | workers/prompt-router/src/index.ts:32 | branch on Cloudflare `request.cf.country` plus app version serves a "safe" prompt prefix (block is also acceptable: it is combined with the Apple-range check)
remote_config | block | src/screens/StyleScreen.tsx:14 | `useFeatureFlag("nsfw_presets")` (Firebase Remote Config key, default false at src/hooks/useFeatureFlag.ts:5) chooses between all presets and the base presets; classification content-gating
ota_updates | block | src/lib/remoteFilters.ts:24 | JavaScript fetched from a CDN is evaluated at runtime and can register new presets; not suppressible
ota_updates | info | package.json:17 | expo-updates present (app.json:9 update URL, app.json:7 runtimeVersion policy); disclose in review notes and snapshot for drift
ratings_integrity | block | src/screens/RateScreen.tsx:19 | "rate us five stars to unlock credits" incentive
ratings_integrity | block | src/screens/RateScreen.tsx:5 | custom review flow opens the App Store review-composer deep link directly (bypasses the system prompt) and then grants credits at line 12
ratings_integrity | medium | src/screens/OnboardingScreen.tsx:7 | hardcoded star-rating and user-count social proof
ugc_safeguards | high | src/screens/StyleScreen.tsx:48 | generated image is shown with no way to report it
ai_data_disclosure | high | src/api/fal.ts:12 | the user's photo (base64 from the image picker) is sent to fal.ai with no consent UI or string naming the AI provider
account_deletion | high | src/api/auth.ts:10 | Supabase `auth.signUp` with no in-app account deletion path
remote_config | info | src/api/promptClient.ts:6 | custom JSON from a workers.dev endpoint feeds the generation prompt (inventory; content-gating also acceptable because the response is a prompt prefix)

Note (integrator): an earlier draft also expected a separate missing-block-user finding (high). Every piece of shown content in this app is AI output with no other users, so 1.2's "block abusive users" safeguard has no one to apply to; `ugc_safeguards` deliberately skips that item for AI-only apps and reports the missing report path instead.

Note: an earlier draft also expected a medium no-age-gate finding (1.2.1(a)). 1.2.1(a) concerns creator content published to an audience; this app's restyled photos are shown only to the user who asked for them, so `ugc_safeguards` no longer reports it here.

## Deliberate negatives (must NOT be flagged)

`none` = no finding of that check on that line; `<=info` = info is acceptable, nothing higher.

review_gating | <=info | src/lib/legal.ts:10 | storefront check turns generation OFF for the China storefront for a legal reason and is disclosed in REVIEW_NOTES.md; it removes a feature, never adds one
review_gating | none | src/lib/receipts.ts:11 | StoreKit sandbox flag (`entitlement.isSandbox`) only chooses which log line to write
remote_config | <=info | src/hooks/useFeatureFlag.ts:29 | `daily_free_generations` is a quota/product value
paywall | none | src/screens/PaywallScreen.tsx:8 | RevenueCat hosted paywall renders price, terms and restore itself (an info note about verifying dashboard policy links is acceptable)
privacy_manifest | none | app.json:22 | Expo `ios.privacyManifests` declares UserDefaults, file timestamp, boot time and disk space reasons
metadata | none | metadata/app-info/en-US.json:1 | name (24 chars) and subtitle (28 chars) are within limits, no brands, no claims
metadata | none | metadata/version/1.4.0/en-US.json:1 | keywords under 100 bytes; description has no unverifiable claims
ugc_safeguards | none | src/screens/RateScreen.tsx:21 | published contact info (help mailto) is present

## Ledger / gate expectations

- Team ID resolves to `ZYXWV98765` from `app.json` (also in `eas.json`).
- Gate must return HOLD.
- The OTA inventory should name the update URL host `u.expo.dev` and runtime policy `appVersion`.

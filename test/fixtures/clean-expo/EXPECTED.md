# clean-expo — expected findings

A well-behaved Expo / React Native AI journaling app ("Inkwell"), the Expo counterpart of
`clean-swiftui`. AI reflections go through its own server (`server/`), which moderates the entry
and the reflection. It has a consent screen naming OpenAI, report / block / contact, a custom
RevenueCat paywall that shows store prices, period, renewal terms, restore and legal links with an
always-visible close button, `expo-store-review` used plainly, Sign in with Apple with in-app
deletion, Expo `ios.privacyManifests`, a Remote Config safety kill switch, and expo-updates that is
disclosed in REVIEW_NOTES.md. Metadata uses the asc canonical layout (validated offline with
`asc metadata validate`). Team ID comes from `app.json` (`LMNOP13579`).

**Acceptance: zero `block` and zero `high` findings.** expo-updates must be `info` only.

Line format: `<check_id> | <severity> | <file>:<approx line> | <what>`. Lines are approximate (±3).

## Allowed findings (medium / info only)

ota_updates | info | package.json:17 | expo-updates present (App.tsx:16 checks for updates outside `__DEV__`; app.json update URL and fingerprint runtime policy); disclosed in REVIEW_NOTES.md:4; snapshot for drift
remote_config | info | src/config/killswitch.ts:17 | Firebase Remote Config `generation_killswitch` in the inventory; classification safety-killswitch (scope throws "paused")
ugc_safeguards | medium | server/reflect.ts:15 | 1.2.1(a) age identification is not implemented; acceptable as medium

## Deliberate negatives (must NOT be flagged at block/high)

`none` = no finding of that check on that line; `<=info` = info is acceptable, nothing higher.

ota_updates | <=info | App.tsx:16 | OTA presence alone is never block or high; there is no eval / new Function of fetched code
remote_config | <=info | src/config/killswitch.ts:17 | kill switch only disables reflections
review_gating | none | App.tsx:29 | `if (!__DEV__)` around the update check is a debug-build condition, not review gating
genai_safety | none | server/reflect.ts:15 | generator moderated on input (line 14) and output (line 24)
ai_data_disclosure | none | src/screens/ConsentScreen.tsx:8 | consent names OpenAI as a third-party AI provider before any entry is shared; revocable in Settings
ugc_safeguards | none | src/screens/JournalScreen.tsx:35 | AI reflections can be reported
ugc_safeguards | none | src/screens/CommunityScreen.tsx:35 | shared prompts can be reported and their authors blocked
ugc_safeguards | none | src/screens/SettingsScreen.tsx:26 | published contact info (support mailto)
ratings_integrity | none | src/screens/JournalScreen.tsx:29 | `StoreReview.requestReview()` after the fifth saved entry, no custom prompt or reward
paywall | none | src/screens/PaywallScreen.tsx:34 | price from `product.priceString`, period from package type, renewal terms at line 39, restore at line 42, Terms and Privacy links, close button visible from the start (line 25)
account_deletion | none | src/auth/account.ts:52 | in-app deletion (SettingsScreen.tsx:17) for Sign in with Apple accounts; server revokes the Apple token (server/account.ts:10)
privacy_manifest | none | app.json:17 | Expo `ios.privacyManifests` declares required-reason APIs
metadata | none | metadata/app-info/en-US.json:1 | name 19 chars, subtitle 28 chars, no brands, no claims
metadata | none | metadata/version/2.1.0/en-US.json:1 | keywords under 100 bytes; promotional text under 170 chars

## Ledger / gate expectations

- Team ID resolves to `LMNOP13579` from `app.json` (also in `eas.json`).
- Gate returns CLEAR or WARN (OTA info is not a HOLD reason).

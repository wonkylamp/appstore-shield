# clean-swiftui — expected findings

A well-behaved SwiftUI AI writing assistant ("Quill"). The app never calls a model provider
directly: it posts to its own backend (`server/`), which moderates the user's text before the
model and the model's reply before the user. It has a consent screen naming OpenAI, report /
block / contact, a SubscriptionStoreView paywall, a plain `requestReview` call, in-app account
deletion with Sign in with Apple token revocation, a correct PrivacyInfo.xcprivacy, a Remote
Config flag used only as a safety kill switch, and store metadata within limits. Team ID comes
from `Quill.xcodeproj/project.pbxproj` (`QRSTU24680`).

**Acceptance: zero `block` and zero `high` findings.** `medium` and `info` are allowed where listed.

Line format: `<check_id> | <severity> | <file>:<approx line> | <what>`. Lines are approximate (±3).

## Allowed findings (medium / info only)

remote_config | info | Sources/Config/SafetySwitch.swift:18 | Firebase Remote Config `generation_killswitch` (default false) in the inventory; classification safety-killswitch (its only use, WritingClient.swift:27, throws "temporarily disabled" before any request is made)
ugc_safeguards | medium | Sources/Views/ComposeView.swift:33 | 1.2.1(a) age identification is not implemented; acceptable as medium for a 4+ writing tool with moderation on both sides
paywall | info | Sources/Views/PaywallView.swift:8 | managed paywall note: confirm the policy destinations configured in code are the live Terms and Privacy URLs

## Deliberate negatives (must NOT be flagged at block/high)

`none` = no finding of that check on that line; `<=info` = info is acceptable, nothing higher.

remote_config | <=info | Sources/Config/SafetySwitch.swift:18 | the kill switch only turns generation off; it must not be classified content-gating or price-gating
review_gating | none | Sources/AI/WritingClient.swift:27 | `guard !…killSwitch else { throw }` disables generation; the request below the guard is not inside a gated scope
genai_safety | none | server/src/compose.ts:16 | the generator is moderated on input (line 14) and output (line 26) with the provider moderation endpoint
ai_data_disclosure | none | Sources/Views/AIConsentView.swift:11 | consent screen names OpenAI as a third-party AI provider before first use; Settings has a toggle to withdraw it
ugc_safeguards | none | Sources/Views/ComposeView.swift:35 | AI suggestions can be reported (context menu and button)
ugc_safeguards | none | Sources/Views/TemplatesView.swift:29 | community templates can be reported and their authors blocked
ugc_safeguards | none | Sources/Views/SettingsView.swift:20 | published contact info (support mailto)
ratings_integrity | none | Sources/Views/ComposeView.swift:65 | `requestReview()` called after the third export, with no custom prompt, pre-gate or reward
paywall | none | Sources/Views/PaywallView.swift:16 | SubscriptionStoreView with restore button and Terms / Privacy policy destinations
account_deletion | none | Sources/Auth/AccountService.swift:35 | Sign in with Apple account can be deleted in-app (SettingsView.swift:26); server revokes the Apple token (server/src/account.ts:1)
privacy_manifest | none | Sources/PrivacyInfo.xcprivacy:43 | UserDefaults / @AppStorage use is declared with reason CA92.1; tracking false
metadata | none | fastlane/metadata/en-US/name.txt:1 | name 24 chars, no third-party brand, no claims
metadata | none | fastlane/metadata/en-US/subtitle.txt:1 | subtitle 29 chars
metadata | none | fastlane/metadata/en-US/keywords.txt:1 | keywords 69 bytes
metadata | none | Sources/Info.plist:14 | purpose strings say why the resource is used
ota_updates | none | Sources/QuillApp.swift:1 | no OTA or remote code

## Ledger / gate expectations

- Team ID resolves to `QRSTU24680`.
- Gate returns CLEAR (or WARN only from ledger history, never HOLD from findings).

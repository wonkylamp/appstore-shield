# swiftui-ai-companion — expected findings

A SwiftUI "AI companion" app (Firebase Auth + Remote Config, Gemini chat, Replicate image
generation, OpenAI vision for a selfie avatar, a StoreKit 2 custom paywall). It models the app in
Shoemaker's composite case after a cosmetic fix: the lingerie outfit is still there, now behind a
remote flag and hidden from review installs. Team ID comes from `App.xcodeproj/project.pbxproj`
(`ABCDE12345`).

Line format: `<check_id> | <severity> | <file>:<approx line> | <what>`.
Lines are approximate (±3). Literal trigger strings are paraphrased in this file on purpose, so
the file itself never looks like a finding if a scanner reads `.md` files.

## Seeded issues (must be flagged)

review_gating | block | Sources/Views/CompanionStudioView.swift:41 | outfit picker (feeds the image prompt, includes the lingerie outfit) is wrapped in `if !AppEnvironment.isTestFlight`, a sandbox-receipt check defined in Sources/Config/AppEnvironment.swift:5, so App Review never sees it; not suppressible
remote_config | block | Sources/Views/CompanionStudioView.swift:19 | Firebase Remote Config key `spicy_mode` (default false, Sources/Config/RemoteFlags.swift:10) appends the lingerie outfit to the picker; classification content-gating
genai_safety | block | Sources/AI/CompanionChat.swift:31 | Gemini safetySettings threshold set to the "block none" value for the sexually-explicit category (and harassment on line 32); not suppressible
genai_safety | block | Sources/AI/ImageGenerator.swift:23 | Replicate prediction input turns the provider safety checker off; not suppressible
genai_safety | high | Sources/AI/ImageGenerator.swift:10 | free-text prompt (CompanionStudioView.swift:38) goes to the image generator with no moderation on input or output; the only blocklist in the app (Safety/NameFilter.swift) screens companion names, not prompts
ugc_safeguards | high | Sources/Views/CompanionStudioView.swift:58 | generated images and chat replies (ChatView.swift:18) are shown with no way to report them
ai_data_disclosure | high | Sources/AI/SelfieAvatar.swift:11 | the user's selfie (picked in ChatView.swift:64) is sent as an image to api.openai.com with no consent screen or string naming the AI provider
ai_data_disclosure | high | Sources/AI/CompanionChat.swift:12 | chat text goes to Gemini (generativelanguage.googleapis.com) with no consent UI
ai_data_disclosure | high | Sources/AI/ImageGenerator.swift:10 | prompts go to Replicate with no consent UI (may be merged with the two lines above into one project-level finding)
paywall | high | Sources/Views/PaywallView.swift:16 | weekly price is a hardcoded literal instead of `product.displayPrice`
paywall | high | Sources/Views/PaywallView.swift:46 | close button only appears after a 5-second `asyncAfter` delay
paywall | high | Sources/Views/PaywallView.swift:54 | custom purchase flow with no Restore Purchases control
ratings_integrity | high | Sources/Views/RatingPrompt.swift:10 | custom sentiment pre-gate alert ("enjoying…?") routes happy users to the system review sheet and unhappy users to email
account_deletion | high | Sources/Auth/SessionStore.swift:16 | Firebase `createUser(withEmail:)` sign-up with no in-app account deletion path
privacy_manifest | medium | App.xcodeproj/project.pbxproj:1 | no PrivacyInfo.xcprivacy anywhere in the project
privacy_manifest | medium | Sources/CompanionApp.swift:23 | UserDefaults / @AppStorage used (also CompanionApp.swift:57, ChatView.swift:9) with no manifest declaring a reason
metadata | high | fastlane/metadata/en-US/name.txt:1 | app name is 34 characters (limit 30)
metadata | high | fastlane/metadata/en-US/name.txt:1 | app name contains a third-party AI brand (the OpenAI chatbot's name)
metadata | high | fastlane/metadata/en-US/name.txt:1 | app name advertises "no-censorship" content in an app that shows AI-generated content (content-signal claim)
metadata | medium | Sources/Info.plist:12 | photo-library purpose string is generic ("needs access to your photos") and never says why

Note (integrator): an earlier draft also expected a separate missing-block-user finding (high). Every piece of shown content in this app is AI output with no other users, so 1.2's "block abusive users" safeguard has no one to apply to; `ugc_safeguards` deliberately skips that item for AI-only apps and reports the missing report path instead.

Note: an earlier draft also expected a medium no-age-gate finding (1.2.1(a)). 1.2.1(a) concerns creator content published to an audience; this app's generated images are shown only to the user who asked for them, so `ugc_safeguards` no longer reports it here.

## Deliberate negatives (must NOT be flagged)

`none` = no finding of that check on that line; `<=info` = info is acceptable, nothing higher.

review_gating | none | Sources/Debug/DebugMenu.swift:26 | TestFlight check inside a file wrapped entirely in `#if DEBUG`; never ships
review_gating | none | Sources/CompanionApp.swift:39 | `#if DEBUG` overlay that adds the debug menu button
review_gating | none | Sources/Config/AppEnvironment.swift:5 | the definition of the sandbox-receipt helper is not itself a gate; only its use at CompanionStudioView.swift:41 is
genai_safety | none | Sources/Safety/NameFilter.swift:5 | a comment that mentions the adult-content abbreviation (comments are stripped before matching)
genai_safety | none | Sources/Safety/NameFilter.swift:7 | the adult-content abbreviation as an entry in a moderation blocklist array is not a model ID or an uncensored-model reference
genai_safety | none | Sources/Safety/NameFilter.swift:10 | "nude" in the blocklist next to a selfie upload elsewhere is not nudification (no image-to-image, no undress prompt)
metadata | none | Sources/Safety/NameFilter.swift:7 | blocklist terms are code, not store metadata claims
ratings_integrity | none | Sources/Views/RatingPrompt.swift:12 | the system review API is used, so this is a pre-gate (high), not a bypass/incentive (block)
remote_config | <=info | Sources/Config/RemoteFlags.swift:20 | `chat_daily_limit` is a product/quota flag
paywall | none | Sources/Views/PaywallView.swift:28 | Terms of Use and Privacy Policy links are present
paywall | none | Sources/Views/PaywallView.swift:18 | auto-renewal terms are stated
ugc_safeguards | none | Sources/Views/SettingsView.swift:22 | published contact info (support mailto) is present

## Ledger / gate expectations

- Team ID resolves to `ABCDE12345` from `DEVELOPMENT_TEAM`.
- `shield_preflight` / `appstore-shield gate` must return HOLD (block findings present).

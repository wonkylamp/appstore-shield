# Writing review notes

Notes for Review (App Store Connect → App Review Information → Notes) are where you tell the reviewer what changed and what they cannot see for themselves. Under 2.3.1(a), notes must describe new features and changes with specificity, and generic notes get rejected. Under 2.5.19, anything undocumented counts against you. These notes stay in your account history, so write them as a factual record.

## The limit is 4000 bytes, not characters

App Store Connect says the Notes field can contain up to 4000 bytes. `shield_lint_text` counts UTF-8 bytes.

- Curly quotes, dashes and accented letters take 2–3 bytes each; emoji take 4.
- Use straight quotes and plain hyphens.
- If you are over the limit, cut adjectives and repetition, not disclosures.

## Structure (in this order)

1. **Summary.** One or two sentences: what this version is and, if it answers a rejection, which one (date and guideline).
2. **What changed, specifically.** One bullet per change. For a rejection fix: the capability that was removed, every input path it was removed from, and what was added (for example, output moderation). Write it at capability level, not screen level.
3. **How to see it.** Steps for the reviewer: where to tap, which account to use, what to try.
4. **Disclosures.** Every item the scan inventory lists, using the templates below:
   - remote config that affects content or price;
   - OTA update mechanism;
   - server-side prompts and model settings;
   - third-party AI services;
   - regional differences.
5. **Demo account.** A placeholder pointing at the Sign-In Information fields, never pasted credentials. Describe a second (expired-subscription) account and any 2FA steps without writing passwords into the notes.
6. **Contact.** A name and a way to reach someone during review.

`shield_evidence_pack` with `purpose: "review_notes"` returns the facts, their event IDs, the section scaffold and the byte budget. Draft only from those facts and what the developer confirms.

## Specificity

| Generic (gets rejected, adds nothing to your record) | Specific |
|---|---|
| "Bug fixes and improvements." | "Removed the outfit editor's swimwear and lingerie categories, and the matching keywords in the free-text prompt filter." |
| "We fixed the issue you raised." | "In response to the 1.1 rejection on 2026-10-12, we removed the underwear and swimwear options from the outfit picker and added prompt and output moderation to the free-text prompt, remix and reference-photo paths. In our probe suite, 120 of 120 requests for the companion character in underwear or sexualized poses were refused." |
| "Content is now fully moderated." | "Generated images now pass through output moderation (provider X's image classifier) before display, in addition to prompt moderation. Flagged results are not shown and are logged for review." |
| "The feature is completely removed and can never come back." | "The code, assets, strings and remote-config key for the feature were deleted in this build. The developer states that the server-side prompt templates for this feature were also deleted." |

Avoid absolute words ("never", "impossible", "all", "guarantee", "fully") unless verification is `PROBED` with every probe blocked and `BUILD_CLEAN`. Even then, say what was tested ("all 120 test prompts in our probe suite were refused").

Anything you cannot show from the repo is the developer's statement. Write it as "The developer states that…". The developer records it with `appstore-shield attest` in their own terminal.

## Disclosure templates

Fill these in from the scan inventory. Delete a template only when the inventory has nothing for it. A promise about future use ("will not be used to", "limited to") is something App Review cannot check, so it is always worded as the developer's statement and backed by an attestation the developer records with `appstore-shield attest`. If the inventory holds a key that a `block` finding says must be deleted, delete it; disclosing it does not fix it, so it never goes into this template.

**Remote configuration**
> This app reads remote configuration from [provider]. Keys that affect what users see: [key] (controls [what it gates]; current value [value]; default [default]). The developer states that these keys will not be used to change content or pricing without a new submission, and that any change to them that would alter content or pricing will be described in notes first.

**OTA updates (expo-updates / EAS Update, CodePush, Shorebird)**
> This app uses [mechanism] for over-the-air JavaScript updates on runtime version [x]. The developer states that OTA updates are limited to bug fixes and that feature changes ship in reviewed builds (guideline 2.5.2).

**Server-side prompts and models**
> Image generation uses [model/provider] with a system prompt held on our server. In this version the prompt [what changed]. Provider safety settings are enabled ([setting names]). The developer states that the server prompt matches what is described here.

**Third-party AI services (5.1.2(i))**
Fill this in only once the scan no longer reports `ai.undisclosed_sharing`: until the consent screen exists, describing it is a misleading statement, and `shield_lint_text` reports it as `safeguard_claim_unbacked`. The same holds for account deletion (`account_deletion.missing`) and Restore Purchases (`paywall.missing_restore`).
> User [photos / text / voice] are sent to [provider] to [purpose]. Users see a consent screen naming [provider] before first use ([screen name]); the privacy policy describes this at [section].

**Regional differences**
> [Feature] is unavailable in [regions] because [legal reason]. Everything else is identical across storefronts.

**UGC safeguards (1.2)**
> Filtering: [how]. Reporting: [where the report button is]; reports are reviewed within [time]. Blocking: [where]. Contact: [address in app and on the support page].

## Removed review-time gating

Sometimes the fix removes a condition that made the app behave differently during review: a TestFlight or sandbox-receipt check, a reviewer-account or Apple IP branch, a region or date switch, or a remote-config key that turned content on after approval. The diff shows it (`removed_condition` facts in the evidence pack; `removed_conditions` in the verify result). How you write about it matters, because the notes stay in the account history.

- **Describe what the app does now, for everyone.** "The outfit picker is shown to all users and offers only Casual, Formal and Sporty." "Generation settings are fixed in the build; no remote key changes them." Say it is the same in every build, environment and region, if that is true.
- **Do not characterise past intent.** Do not write why the condition existed, whether it was meant to hide anything, or that it was "a mistake", "legacy code" or "only for testing". Neither Claude nor the tool knows, and a guess is a statement the developer never made. `shield_lint_text` reports such sentences as `intent_characterization` unless the developer confirmed them with `appstore-shield attest`.
- **Disclose the removed mechanism factually, by default.** If the removed condition changed content, price or a feature during review, say so in plain words, without a reason: "Earlier builds contained a condition (a TestFlight receipt check) that changed which styles were shown during review; it has been removed. The style list no longer depends on the build environment or on remote configuration." Leaving it out when the diff shows it reads as concealment; the reviewer may already have seen the other behavior.
- **Admissions are the developer's decision.** Only write that something was wrong if the developer confirms it in their own words (an attestation they recorded with `appstore-shield attest` in their own terminal; `shield_lint_text` ignores any list of mistakes passed by the agent). Quote what they confirmed; do not expand it.
- **Counsel comes before characterising intent, not before disclosing.** The factual disclosure above goes in by default. If the developer wants to say anything about why the condition existed, or if it was deliberate, tell them that this is the conduct DPLA 3.2(f) terminations cite, and suggest they talk to counsel before they write about intent.

## Demo accounts

- **Non-expiring.** The account must work for the whole review and for later reviews. Do not use a trial account that times out.
- **Subscription apps: provide two accounts.** One with an active subscription, and one with an **expired** subscription, so the reviewer can see the paywall and the lapsed-subscriber experience. Say which is which.
- **2FA.** If sign-in needs a code, explain in the notes how the reviewer gets it (for example, a fixed code for the demo account only, or a contact who responds during review). Do not leave it to chance.
- **Same build, same behavior.** The demo account must not unlock or hide anything that a normal account would not. A reviewer-only branch is exactly what 2.5.19 and DPLA 3.2(e) prohibit, and the `review_gating` check blocks it.
- **Credentials go only in the App Review Information fields.** Never put real customer data or production secrets in notes. The lint flags pasted secrets.

## Bad and good: a full example

**Bad** (generic, absolute, combative, no disclosure):

> Hi, we removed the problematic content as requested. Our app is completely safe now and never generates anything inappropriate. We don't understand why we were rejected since other apps do the same thing. Please approve quickly.

**Good** (about 1,100 bytes):

> Version 2.4 (build 87) responds to the guideline 1.1 rejection on 2026-10-12 (submission 2.3, build 81).
>
> What changed:
> - Removed the companion outfit categories "swimwear" and "lingerie", their 46 image assets and their localized strings.
> - The free-text prompt, the remix button and uploaded reference photos now pass through prompt moderation and output image moderation (provider X). Requests for underwear, nudity or sexualized poses of the companion are refused with a message.
> - Removed the remote-config key `outfit_categories`; outfit choices are now fixed in the build.
>
> How to check: sign in with the demo account below, open Companion > Style, and try "put her in lingerie" in the prompt field. The request is refused.
>
> Disclosures: Remote config (Firebase) still controls `daily_free_generations` (number only; no content or price effect). No OTA updates. Image generation uses provider X with safety settings enabled. The developer states that prompts are held on our server and were updated for this version. User photos are sent to provider X only after the consent screen shown on first upload.
>
> Demo accounts: the active-subscription account is in the Sign-In Information fields. A second account with an expired subscription is available on request from the contact below. Neither account uses 2FA.
>
> Contact: Jane Doe, +1 555 0100, during review.

Before pasting: `shield_lint_text` with `purpose: "review_notes"`, the text, and `rejection_id` (or `fact_ids`: the `eventId` values of the facts you used, not their F-numbers).

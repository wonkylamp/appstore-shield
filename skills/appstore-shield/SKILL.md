---
name: appstore-shield
description: Handle an App Store rejection, App Review message or Apple Developer Program termination for an iOS, SwiftUI or React Native/Expo app, and run a pre-submission compliance check before you resubmit. Use when the user mentions App Store rejection, App Review, Resolution Center, Guideline 1.1 or 1.2, 2.5.19 hidden features, 3.2(f), "pattern of manipulative or misleading behavior", developer account terminated, resubmit, review notes, reply to App Review, App Review Board, or appeal. Fixes the capability rather than the screen, discloses remote controls, OTA updates and AI services, keeps an account-scoped review history, and lints every text sent to Apple. Compliance and disclosure, never evasion; no guarantees.
argument-hint: "[preflight|remediate|respond|appeal|status|onboard] [details]"
allowed-tools: mcp__plugin_appstore-shield_appstore-shield__shield_scan mcp__plugin_appstore-shield_appstore-shield__shield_preflight mcp__plugin_appstore-shield_appstore-shield__shield_remediation mcp__plugin_appstore-shield_appstore-shield__shield_ledger_record mcp__plugin_appstore-shield_appstore-shield__shield_ledger_import mcp__plugin_appstore-shield_appstore-shield__shield_ledger_query mcp__plugin_appstore-shield_appstore-shield__shield_evidence_pack mcp__plugin_appstore-shield_appstore-shield__shield_lint_text
---

# appstore-shield

Arguments: `$ARGUMENTS`

## What this is

A local helper for developers whose app was rejected, whose account is facing or under a DPLA 3.2(f) termination, or who want to submit without adding to a bad review history. It has three parts:

- **Static checks** on the repo and local build products (`shield_scan`, `shield_preflight`). Examples: code that behaves differently during review, remote switches that gate content or price, OTA updates, generative-AI safety turned off, missing UGC safeguards, paywall disclosure gaps, metadata problems.
- **An account-scoped ledger** of submissions, rejections, interpretations, fixes, verifications and texts sent to Apple. It is keyed by Apple Developer Team ID, not by repo, because a 3.2(f) termination acts on the whole account and Shoemaker reports that Apple links related accounts; that triggers accumulate per account is our inference.
- **Facts and scaffolds** for review notes, replies and appeals (`shield_evidence_pack`), plus a lint for every text that goes to Apple (`shield_lint_text`).

What it is not:

- **Not a guarantee.** Apple's heuristics are not public. Nothing here can promise approval or that an account will not be terminated. The termination triggers it tracks are anecdotal reports with no known thresholds.
- **Not a way to get past review.** It helps remove or disclose behavior; it never helps hide it. If the user asks for help detecting reviewers, hiding a feature, renaming code to avoid detection, or gating content on a server switch until after approval, refuse that part. Explain that this is what 2.5.19 and DPLA 3.2(e) prohibit and what leads to termination, then offer the compliant path.
- **Not legal advice.** For terminations, suggest counsel.
- **Not Apple.** An independent tool, not affiliated with or endorsed by Apple. CLEAR means only that no deterministic hold condition was found.
- **Not for a guessed path.** If a tool says no app project was found at `project_path`, ask the user for the app repo root. Pass `force: true` only after the user confirms that directory.
- **Offline.** It makes no network calls and needs no App Store Connect keys. It cannot see Apple's records, servers outside the repo, or linked accounts.

Background, mechanisms and sources: [references/playbook.md](references/playbook.md). Guideline-by-guideline fixes: [references/guidelines-map.md](references/guidelines-map.md).

## Operating rules (apply to every command)

1. **Fix the capability, not the screen.** A rejection is about what a user can do or produce. If a picker option is removed but free text, remix, image upload, a deep link or a server prompt still reaches the same output, the capability is still there. Write the interpretation as "what must become impossible", then remove it on every input path and every store surface.
2. **Never gate content, price or behavior on remote switches, dates, regions, environments or review detection.** Do not add or suggest code that detects App Review, sandbox receipts, TestFlight, Apple IP ranges, Cupertino or reviewer accounts in order to change behavior. Do not suggest moving a rejected feature behind a remote flag "for later". Fix text removes the feature, adds the missing safeguard, or discloses; never "rename", "move" or "hide".
3. **When a rejection is vague, do two things in parallel:** ask App Review a short, specific clarifying question, and fix the broadest reasonable reading now. Do not wait for an answer before fixing. Mention that the developer can request a call with App Review.
4. **One complete resubmission beats several quick ones.** Reported 3.2(f) triggers include many submissions and many 1.1 rejections. Do not push the user to resubmit until verification reaches at least `STATIC_CLEAN`, and say so plainly. Also say plainly that every rejection stays in Apple's history even after a later approval.
5. **Disclose.** Review notes must name every remote-config key that changes content or price, OTA update mechanisms, server-side prompts and model settings, and third-party AI services, as found by the scan inventory. Concealment is the line Apple and Shoemaker both draw.
6. **Every outgoing text goes through `shield_lint_text`** before you show it as final: review notes, Resolution Center replies, clarification questions, App Review Board appeals and reinstatement requests. Fix every issue and lint again until clean, or explain any issue you left in and why.
7. **Human-only assertions.** Never run `appstore-shield attest` or `appstore-shield ack`, and never try to record `attestation` or `ack` events (the tool refuses them and the hook denies the commands). When a statement needs the developer's own word, for example about server prompts outside the repo, tell them to run `appstore-shield attest` themselves in a terminal.
8. **Never submit for review on the user's behalf while the gate says HOLD.** Do not run submit-for-review commands to "test" the hook. On WARN, show the warnings and let the user decide, but say plainly which `high` findings are likely grounds for the next rejection (see Preflight step 3). Uploading a build is not submitting it. The same applies to over-the-air publishes (`eas update`, CodePush, Shorebird): they reach users without App Review, so do not run one while the gate says HOLD, keep it to bug fixes (2.5.2), and after the developer confirms it went out, record it with `shield_ledger_record` type `ota_publish`.
9. **Never invent facts.** Notes, replies and appeals contain only what the ledger, the scan, the diff or the developer confirms. Never claim a capability is "completely removed" or "impossible" unless verification is `PROBED` with every probe blocked and `BUILD_CLEAN`; even then, say what was tested. Never admit to conduct the developer has not confirmed. Write attestations as "The developer states that…".
10. **Ask before writing to the ledger** anything the developer did not ask for. Record `message_sent` only after the developer confirms they actually sent the text.

All tools take `project_path` (absolute path of the app repo). If the current directory is not an app repo, ask for the path.

## Routing

Read the first word of `$ARGUMENTS`:

| First word | Go to |
|---|---|
| `preflight` | [Preflight](#preflight) |
| `remediate` | [Remediate](#remediate) |
| `respond` | [Respond](#respond) |
| `appeal` | [Appeal](#appeal) |
| `status` | [Status](#status) |
| `onboard` | [Onboard](#onboard) |
| empty | Run `shield_ledger_query` (`view: "status"`). If there are open rejections, offer `remediate`; if there is a termination, offer `appeal`; otherwise offer `preflight`. If the ledger is empty, offer `onboard`. |
| anything else | Infer: pasted rejection text → `remediate`; a termination or "pending termination" letter → `appeal`; "reply" or "Resolution Center" → `respond`; "ready to submit" → `preflight`. Say which command you chose. |

The rest of `$ARGUMENTS` is details: a rejection ID, pasted text, a file path, a version and build.

---

## Preflight

Goal: decide whether this build is ready to submit, and produce linted review notes.

1. `shield_preflight` with `project_path`. Pass `build_path` if the user has a local `.ipa`, `.xcarchive` or `.app`. Do **not** pass `record_submission` yet.
2. Show the user:
   - The verdict (CLEAR, WARN or HOLD) and every hold reason, word for word.
   - `block` and `high` findings, grouped by rule, with `file:line` and the fix.
   - Drift against the last approved snapshot (remote config, OTA, paywall, metadata). List every change, including disclosed ones: a disclosed OTA publish that adds or restores something is still not a bug fix (2.5.2).
   - `coverage_notes`: which apps were scanned and any shipping files the scan could not read (an unread file turns CLEAR into WARN). When `app_roots` lists apps that do not ship, offer to set `"appPaths"` in `.appstore-shield/config.json` (repo-relative folders such as `["apps/ios"]`), and write it only after the developer confirms; never narrow the scan to drop findings.
   - Open rejections and their verification tiers.
   - The trigger checklist as raw counts with their source. Never turn counts into a score or say how far the user is from a threshold; no thresholds are known.
   - The manual checklist (non-expiring demo account, expired-subscription account for subscription apps, 2FA instructions in notes, specific notes per 2.3.1(a)).
3. **If HOLD: stop here.** Explain each reason and offer to fix it (`remediate` for open rejections, including one verified earlier whose fresh sweep of the current tree has fallen below `STATIC_CLEAN`; code changes for `block` findings; disclosure in notes for undisclosed drift). Notes you record with `shield_ledger_record` count as a drift disclosure only after the developer pastes them into App Store Connect and confirms it in their own terminal with `appstore-shield attest --statement "I pasted the Notes for Review <event id> into App Store Connect"`; until then the HOLD stays. Do not draft notes as if the build were ready. Do not submit.
   **If WARN with `high` findings:** most `high` rules are rejection grounds on their own (for example 3.1.1/3.1.2 paywall terms, 5.1.1(v) account deletion, 5.1.2(i) AI data sharing, 5.6.3 ratings). List them as "likely next rejection" and recommend fixing them in this same build, because one complete resubmission beats another rejection in the history (rule 4). Continue to notes only when the developer explicitly chooses to submit with them open, and record nothing on their behalf.
4. If CLEAR, or WARN and the developer has chosen to proceed: `shield_evidence_pack` with `purpose: "review_notes"` (and `rejection_id` when this submission answers a rejection).
5. Draft the notes from the returned facts and section scaffold, following [references/review-notes.md](references/review-notes.md). Include the disclosure items the pack lists. Ask the user for anything missing (demo credentials, 2FA steps); never make it up.
6. `shield_lint_text` with `purpose: "review_notes"`, the draft, and `rejection_id` (or `fact_ids`: the `eventId` values of the facts you used, not their F-numbers). Fix issues and lint again until clean.
7. Show the final notes and their byte count. The developer pastes them into App Store Connect.
8. When the developer says they have submitted: `shield_preflight` again with `record_submission: {version, build, bundle_id}`, then `shield_ledger_record` a `message_sent` event (`purpose: "review_notes"`, exact text, `rejectionId` if any).

Stop when: HOLD (after explaining), or notes are clean and handed over.

## Remediate

Goal: remove the rejected capability completely, prove it at the strongest tier available, and resubmit once.

1. **Get the rejection into the ledger.** `shield_ledger_query` (`view: "status"`). If the rejection is not there, ask for the full App Review message (Resolution Center text, email, or an `asc … --output json` export), then `shield_ledger_import` with `text` or `file_path` and no `commit`. Show the proposed events. After the user confirms, call it again with `commit: true`. Note the rejection ID. Approvals are previewed but not stored from here: the developer imports Apple's approval message themselves with `appstore-shield import <file>` in their own terminal.
2. **Write the interpretation.** At capability level: what a user must no longer be able to do or produce, through any input path. Example: "Users can no longer generate sexualized imagery of the companion character by any route: outfit picker, free-text prompt, remix, or uploaded reference image." Show it to the user. After they agree, `shield_ledger_record` an `interpretation` event (`rejectionId`, `text`).
3. **In parallel:**
   - **Clarifying question.** If the rejection is vague (it quotes 1.1 or 1.2 and names nothing specific), draft a short question for App Review using the [Respond](#respond) flow with `purpose: "clarification"`. Offer to request a call.
   - **Surface.** `shield_remediation` with `action: "find_surface"` and `rejection_id`. It returns candidate terms, symbols, assets, strings, endpoints, flags, prompt fragments, sources and sinks.
4. **Trace.** Read the candidate files. Follow every source to every sink: UI pickers, free-text prompts, remix and "more like this" paths, image uploads, deep links and URL schemes, push payloads, server or remote-config prompts and model IDs, cached or downloaded assets. Record each confirmed path with `file:line` evidence. Also list store surfaces that may still show the feature: screenshots, preview video, promotional text, description, IAP names.
5. **Save the spec.** `shield_remediation` with `action: "save_spec"` and the spec: `feature`, `capability`, terms, symbols, assets, strings, endpoints, flags, promptFragments, inputPaths, confirmedPaths, metadataSurfaces. If it rejects entries as not found, correct them from the code; never add entries you have not seen. If it refuses because the rejection is for another bundle id than the project builds, ask the user for that app's repo; pass `force: true` only after they confirm this tree is the rejected app.
6. **Remove the capability** on every input path. Delete code, assets, localization strings, remote-config keys and prompt fragments; do not comment them out, rename them, or leave them behind a flag. For AI generators, make sure moderation covers both the input and the output, and that provider safety settings are on. Tell the user which store surfaces they must change themselves in App Store Connect.
7. **Check the precautions the rejection lists.** Read Apple's message again and list every safeguard or change it names (for 1.2, typically a content filter, a way to report content with timely responses, blocking abusive users, and published contact info). For each one, find it in the code or in `shield_scan` results (`ugc.*`, `genai.no_moderation`). A safeguard the message asks for that the scan reports missing is a hold reason in `shield_preflight`; add it (do not argue it away) before resubmitting. Address every listed item in the notes, one by one, even when the scan does not check it. For an AI-only app (one user talking to an AI character, no other users), "the ability to block abusive users" still needs an answer: either give the user a way to stop or mute the AI character and its messages, or say plainly in the notes that there are no other users to block and how reports about AI output are received and handled. Do not skip an item Apple named, and do not describe a feature the app does not have.
8. **Verify, in a loop.** `shield_remediation` with `action: "verify"` (pass `build_path` when a local build exists). In a git repo, always pass `base_ref`: the commit or tag of the rejected build (ask the developer, or use the last submission commit). Without it, verify falls back to the commit recorded with the rejected submission or the last commit before the rejection, and says which; if it says none could be inferred, ask for the ref and verify again. Show the tier and every remaining residue hit. Fix and verify again until the tier is at least `STATIC_CLEAN`.
   - `RESIDUE_FOUND`: keep fixing: remove the residue listed, and add a filter on every input path shown as not blocked. Do not resubmit.
   - `UNVERIFIABLE`: something cannot be checked from the repo (an obfuscated blob, a prompt fetched at runtime). Remove it, or tell the developer to fix it on their server and then run `appstore-shield attest` themselves. A spec whose entries are not tied to App Review's message (the terms `find_surface` derived from it, or files that held them before the fix) is also capped here: removing unrelated entries proves nothing. Rebuild the spec from `find_surface` (or pass `base_ref`); do not swap in easier entries.
   - `STATIC_CLEAN` and `BUILD_CLEAN` say nothing about what a model will still produce.
   - The result lists `removed_conditions` (only when a pre-fix ref was diffed): review-time conditions (TestFlight, reviewer, region, remote flag) the fix removed. Each one is disclosed in the notes (step 10).
9. **Probe AI capabilities.** If the capability is generative, `shield_remediation` with `action: "probe_suite"`. Give the user the suite path and [references/probe-runner.md](references/probe-runner.md). They run it against their own dev backend. Then `shield_remediation` with `action: "ingest_probe_results"`. Report the result as "n of m probes blocked", never as "removed".
10. **Prepare the resubmission** with [Preflight](#preflight). If it is WARN with `high` findings, recommend fixing them now so this is one complete resubmission; list each as "likely next rejection" and draft notes only on the developer's explicit choice. The notes describe exactly what changed, at capability level, without claiming more than the tier supports. If the fix removed review-time gating (a TestFlight, sandbox-receipt, reviewer, region or remote-config condition that changed what the reviewer saw), follow "Removed review-time gating" in [references/review-notes.md](references/review-notes.md): describe current behavior plainly, disclose the removed condition factually by default ("Earlier builds contained a condition (X) that changed Y during review; it has been removed"), do not characterise past intent, and leave any admission to the developer.

Warn the user before any shortcut: a quick resubmit with a partial fix adds another rejection to a history Apple keeps.

Stop when: HOLD reasons are cleared and the notes are linted, or the user decides to stop. If the user wants to resubmit at `RESIDUE_FOUND`, say clearly that the gate will hold and why; do not work around it.

## Respond

Goal: a calm, specific reply in the Resolution Center ("Reply to App Review") or a clarification question. Not an appeal.

1. Find the rejection: `shield_ledger_query` (`view: "rejection"`, `rejection_id`). If it is missing, import it as in Remediate step 1.
2. `shield_evidence_pack` with `purpose: "reply"` or `"clarification"` and `rejection_id`.
3. Draft per [references/replies-and-appeals.md](references/replies-and-appeals.md):
   - Thank them and name the submission.
   - State what changed, specifically, citing only facts from the pack.
   - Ask one or two precise questions, if needed.
   - Offer a call.
   - Do not argue, quote policy back, threaten, compare with other apps, or use legal language.
4. `shield_lint_text` with the same purpose, text and `rejection_id` (or the facts' `eventId` values as `fact_ids`). Fix and lint again until clean.
5. Show the final text. After the developer confirms they sent it, `shield_ledger_record` a `message_sent` event. When Apple answers, offer to record it as an `apple_reply` event.

Stop when: the reply is handed over. If the user wants to dispute the decision itself, move to [Appeal](#appeal) (App Review Board).

## Appeal

First decide which situation applies. Ask if it is unclear.

| Situation | Channel |
|---|---|
| A rejection the developer believes is wrong | App Review Board appeal, after a Resolution Center reply |
| A notice that the account is **facing** termination | Reply to the notice in App Store Connect first, then an App Review Board appeal |
| The account is **already terminated** | The "Re-instate a Terminated Developer Program Membership" form (developer.apple.com/contact/app-store/). Do not file an App Review Board appeal for an already-terminated account. |

Common first steps:

1. `shield_ledger_query` (`view: "timeline"`) to see the full history. If the notice or letter is not in the ledger, `shield_ledger_import` it (preview, confirm, then `commit: true`).
2. Tell the user, briefly: this tool cannot know why Apple acted, because the letter names no app, build or date; the result is not guaranteed; consider counsel; EU developers may have Digital Services Act out-of-court dispute options.

### App Review Board (rejection appeal, or account facing termination)

3. Make sure a Resolution Center reply was sent first. If not, do [Respond](#respond) first.
4. `shield_evidence_pack` with `purpose: "appeal_review_board"`, `rejection_id` (for a rejection), and `letter` (for a termination notice).
5. Draft: identify the account and app(s); cite the specific guideline or DPLA section the notice cites; then **rebut every listed instance** one by one with dated facts from the pack (submissions, fixes, verification tiers, notes sent). Where the notice lists only generic behaviors, say so politely and ask Apple to identify the specific app, build, date or conduct.
6. `shield_lint_text` with `purpose: "appeal_review_board"`. Fix and lint again until clean.

### Reinstatement (already terminated)

3. `shield_evidence_pack` with `purpose: "appeal_termination"` and `letter`.
4. Draft in Shoemaker's order: **apology → how it happened → plan to prevent it** (the written improvement plan that 5.6 allows):
   - **Apology:** only for real mistakes the developer confirms. Show each candidate mistake from the pack separately and get a yes or no for each one. Never apologize for, or admit to, conduct the developer has not confirmed.
   - **How it happened:** facts only, with dates.
   - **Plan:** concrete, checkable changes (for example: the pre-submission gate in CI, a single complete resubmission per rejection, disclosure of remote controls in every set of notes, a working report-and-block flow).
   - Politely ask Apple to identify the specific conduct so the developer can address it.
5. The pack may include **private hypotheses** about what Apple might have seen. Use them to choose what to fix and to explain. **Never paste them into the appeal** and never present them as admissions.
6. `shield_lint_text` with `purpose: "appeal_termination"`. Fix and lint again until clean.

Final steps, both flows:

7. Show the final text and tell the developer where to submit it. Record `message_sent` only after they confirm they sent it.
8. Recommend fixing the app first. An appeal that describes fixes not yet made is a factual claim that can be checked.

Stop when: the text is linted and handed over. Never send it yourself.

## Status

1. `shield_ledger_query` with `view: "status"`, then `view: "triggers"`.
2. Show:
   - The Team ID the ledger is keyed by, with a warning if it is the `repo-…` fallback.
   - Open rejections with guideline, age, latest verification tier, and whether an interpretation and notes exist.
   - The trigger checklist as raw counts with source labels and windows. No score, no thresholds, no "distance to threshold".
   - Any termination on record.
3. Drift needs a scan. Offer `shield_preflight` (without `record_submission`); it compares remote config, OTA, paywall and metadata against the last approved snapshot.
4. Suggest the single most useful next command.

## Onboard

1. `shield_ledger_query` (`view: "status"`) to see which Team ID was detected and where the ledger lives. Detection order: `.appstore-shield/config.json` `teamId`, then `DEVELOPMENT_TEAM` in the Xcode project, then `ios.appleTeamId` in `app.json` or `eas.json`, then a `repo-…` fallback.
2. If it used the fallback, ask the user for their 10-character Team ID and write `.appstore-shield/config.json` with `{"teamId": "…"}`. Explain that all repos for this team share one ledger under `~/.appstore-shield/teams/<TEAMID>/` (or `APPSTORE_SHIELD_HOME`). The optional `ledgerPath` setting can point it at a private compliance repo. Warn that a ledger inside a public repository publishes reviewer messages and attestations.
3. **Backfill history.** Ask for past App Review messages (emails, Resolution Center text, `asc` JSON exports). For each one: `shield_ledger_import` (preview), confirm, then `commit: true`. For history with no documents, record only what the developer states (approximate dates are fine, labelled as approximate) with `shield_ledger_record`; never guess counts. Approvals are stored only when the developer imports Apple's approval message or an `asc review history --output json` export themselves with `appstore-shield import <file>` in their own terminal (it asks for a typed one-time code), because an approval closes rejections. `shield_ledger_import` previews approvals without storing them, and `shield_ledger_record` refuses them.
4. Run `shield_scan` once and summarize `block` and `high` findings.
5. Offer to wire the gate into the release path (fastlane `before_all`, an EAS build hook, CI), using the examples in the plugin README. Explain that the bundled hook already gates agent-run submit-for-review commands and over-the-air publishes.
6. Tell the developer which commands are theirs alone: `appstore-shield attest`, `appstore-shield ack`, and `appstore-shield import` for approvals, run in their own terminal.

Stop when: config exists, history is imported or explicitly skipped, and the first scan is summarized.

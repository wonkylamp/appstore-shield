# Replies and appeals

Everything you send to Apple becomes part of your account history. Termination notices, as Shoemaker reports them, list misleading support or App Store Connect responses among the behaviors; DPLA 3.2(f) itself bars misleading or dishonest acts. Shoemaker argues that if rejection history is treated as proof of fraud, every honest argument with App Review becomes evidence of bad character; we lint tone for that reason. So write every message as a calm, factual record, and lint it with `shield_lint_text` before it goes out.

This is not legal advice. For a termination, or a pending termination, consider talking to a lawyer.

## Pick the right channel

| Situation | Channel | What it is for |
|---|---|---|
| A rejection you want to understand or answer | **Reply to App Review** (Resolution Center in App Store Connect) | Clarifications and explaining changes. Not an appeal. |
| You need to talk it through | **Request a call** from the Resolution Center | App Review usually calls within 3–5 business days. Useful when a 1.1 or 1.2 rejection does not say what to change. |
| You believe a rejection or removal is wrong | **App Review Board** appeal | Disputes about rejections and removals. Reply in the Resolution Center first. |
| Your account is **facing** termination (a notice with a deadline) | Reply to the notice in App Store Connect first, then an **App Review Board** appeal | Cite the specific terms and rebut every listed instance. |
| Your account is **already terminated** | **"Re-instate a Terminated Developer Program Membership"** form, https://developer.apple.com/contact/app-store/ | Reasons plus planned improvements. 5.6 says a terminated developer may submit a written improvement plan. Apple says not to file an App Review Board appeal to reinstate an already-terminated account. |
| You are in the EU | Digital Services Act out-of-court dispute settlement, in addition to the above | Ask counsel whether it applies to you. |

Secondary reports say pending-termination notices give about 30 days. Read the notice for the actual date.

## Tone

- Calm, brief, specific. Thank the reviewer once.
- No arguing, sarcasm, capitals, threats, ultimatums or deadlines.
- Do not compare your app with other apps.
- No legal language ("breach", "unlawful", "we reserve the right") unless counsel wrote it.
- Do not quote the guideline back at the reviewer to prove them wrong.
- State facts with dates. Where a fact is the developer's word and not shown by the code, write "The developer states that…".
- Ask precise questions. "Could you tell us which screen or input showed the content?" is better than "What exactly is wrong?"
- One message per issue. Do not send a stream of follow-ups.

## Reply to App Review (clarification)

Use when a rejection quotes a guideline and names nothing. Send it **while** you fix the broadest reasonable reading; do not wait for the answer.

Structure:

1. The submission (version, build, date) and the guideline cited.
2. Your capability-level reading of the issue, in one sentence.
3. What you have already changed or are changing.
4. One or two specific questions.
5. An offer of a call.

Example:

> Thank you for reviewing version 2.3 (build 81). We understand the 1.1 concern to be that users could generate sexualized images of the companion character. We are removing that capability from every input path (outfit picker, free-text prompt, remix and uploaded reference photos) and adding output moderation. Could you tell us whether the concern also covers the character's default outfit, or only user-generated variations? We would welcome a call if that is easier.

## App Review Board appeal

Use for a rejection or removal you believe is wrong, or a notice that the account is facing termination. Reply in the Resolution Center (or to the notice) first.

Structure:

1. **Account, app(s), and the notice or rejection** you are appealing, with dates.
2. **The specific guideline or DPLA section** the notice cites. If it cites only generic behaviors, say so politely.
3. **Every listed instance, one at a time:** what happened, with dated facts from the ledger (submissions, outcomes, fixes, verification tiers, notes sent). Do not skip any.
4. **What you have changed**, specifically, and how you verified it.
5. **A polite request** that Apple identify any specific app, build, date or conduct you have not addressed.

`shield_evidence_pack` with `purpose: "appeal_review_board"` returns the facts with event IDs in this order.

## Reinstatement request (already terminated)

Shoemaker says Apple wants **an apology, an explanation of how it happened, and a plan to prevent it, in that order**, which he learned working with Jobs, Cook and Schiller.

The problem: a 3.2(f) letter usually names no app, build, date or screenshot, so you have to guess what to apologize for. Handle it like this:

1. **Apology, only for confirmed real mistakes.** The evidence pack lists candidates from your history (for example, a rejection fixed only on one input path, or many resubmissions in a short time). Go through them one at a time and include only those you agree were mistakes. **Never confess to conduct you have not confirmed.** A speculative admission becomes the record.
2. **How it happened.** Facts and dates: what the rejection said, how you read it, what you changed, what you missed and why.
3. **Plan to prevent it.** This is your written improvement plan (5.6). Make it concrete and checkable, for example:
   - a pre-submission gate in CI;
   - one complete resubmission per rejection;
   - capability-level fixes verified before resubmitting;
   - every remote control and OTA mechanism disclosed in notes;
   - working filter, report, block and contact in UGC and AI features;
   - a named person responsible for App Review communication.
4. **Ask Apple, politely, to identify the conduct** so you can address it directly.

Do this first: fix what the plan describes. An appeal that describes fixes not yet made is a factual claim that can be checked.

### Private hypotheses

The `appeal_termination` evidence pack may include private hypotheses: things Apple might have seen, such as residue of a rejected feature or a remote switch. Use them to decide what to fix and to make the plan complete. **Never paste them into the appeal**, and never turn them into admissions.

## What the lint checks

`shield_lint_text` flags:

- absolute claims not backed by `PROBED` (every probe blocked) plus `BUILD_CLEAN`;
- attestations not worded as "The developer states…";
- pasted credentials or secrets;
- combative or legalistic tone;
- generic change descriptions;
- remote controls or OTA in the inventory but missing from the text;
- speculative admissions in appeals.

Fix every issue and lint again until the text is clean.

## Recording

After the developer confirms they sent a message, record it with `shield_ledger_record` as a `message_sent` event with the exact text. When Apple answers, record it as an `apple_reply` event. The record helps you answer the next question from Apple consistently.

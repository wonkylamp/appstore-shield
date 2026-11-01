# ledger samples — expected import results

Sample App Review and Apple Developer Program messages for `shield_ledger_import` and
`appstore-shield import`. They are written from scratch to follow the usual layout of these
messages; they are not copies of real correspondence. All five belong to one story for team
`ABCDE12345` (the `swiftui-ai-companion` fixture's team), in this order:

| File | Event | Key fields |
|---|---|---|
| rejection-1.1.txt | outcome `rejected` | guidelines `["1.1"]`; submissionId `4c1e9a72-58d3-4b0f-a6e2-9d31c7f0b815`; version `1.2`, build `37`; at 2026-08-03; app name "Luna - AI Companion" |
| rejection-1.2.txt | outcome `rejected` | guidelines `["1.2"]`; submissionId `9b27d4e0-1f6a-4c83-b5d9-72e0a4c6f193`; version `1.3`, build `42` (written as "Version 1.3 (42)"); at 2026-09-17; reviewerMessage keeps the Issue Description verbatim |
| resolution-reply.txt | `apple_reply` | linked to the 1.2 rejection through submissionId `9b27d4e0-…`; at 2026-09-21; still cites Guideline 1.2 (free-text prompts, no report/block) |
| approval.txt | outcome `approved` | submissionId `e5a0c3b1-7d92-4f68-8a14-3bc6d2f9a057`; version `1.3`, build `43`; at 2026-10-06; closes the open 1.2 rejection for the same app (`approvedBy`) |
| termination-3.2f.txt | `termination` | DPLA §3.2(f); Team ID `ABCDE12345`; 30-day appeal window; at 2026-10-30; the letter lists only generic behavior categories and names no app, build, date or screenshot |

Parser expectations:

- A guideline header line has the shape `Guideline <n> - <Section> - <Title>`; the number is what goes into `guidelines`.
- Version and build come from `Version reviewed:` (`1.2 (37)` and `Version 1.3 (42)`) or `App Version: iOS 1.3 (43)`.
- Dates: prefer the `Date:` header; the body's `Review date:` is the same day.
- The termination letter must not produce an `outcome` event, and must not be guessed into a specific guideline or app.
- Importing a file twice must not create duplicate events (same submissionId + outcome).
- Trigger checklist after importing all five: 2 rejections (one 1.1, one 1.2), 1 Apple reply, 1 approval, 1 termination notice; open rejections: none (the approval closes both, as both are for the same app).

# appstore-shield

**Catch the App Review problems in your iOS app before Apple does, and keep a clean record when it does.**

appstore-shield scans an iOS, SwiftUI or React Native/Expo repo for the things App Review rejects and the things that get developer accounts terminated: features hidden from reviewers, content behind a server switch, AI with safety turned off, missing report and block buttons, paywall gaps. It runs locally, needs no App Store Connect keys, and makes no network calls.

It ships as a Claude Code plugin (MCP server, skill and a submit-for-review hook) and as a plain CLI you can drop into fastlane, EAS or CI.

Independent tool; not affiliated with or endorsed by Apple. App Store is a trademark of Apple Inc.

```text
$ npx appstore-shield gate .
appstore-shield gate: HOLD
HOLD: Block finding remote_config.content_gating (Guideline 2.5.19) at Sources/Views/CompanionStudioView.swift:19:
      Delete the flag and the adult or nudification content it gates. Content App Review rejects under 1.1
      must not ship behind a server switch, so disclosing the flag does not fix it (2.5.19, DPLA 3.2(e)).
HOLD: Block finding review_gating.environment (Guideline 2.5.19) at Sources/Views/CompanionStudioView.swift:41:
      Remove the environment check so App Review and App Store users get the same app.
HOLD: Block finding genai.safety_disabled (Guideline 1.1) at Sources/AI/CompanionChat.swift:31:
      Remove the BLOCK_NONE / OFF thresholds so Gemini's default safety applies.
WARN: 11 high finding(s): genai.no_moderation, ugc.no_report, account_deletion.missing, paywall.missing_restore, …
```

That is real output from the demo app in [`test/fixtures/swiftui-ai-companion`](test/fixtures/swiftui-ai-companion), trimmed and wrapped to fit. Every finding names the file, the line, the guideline and a fix.

## Why this exists

A rejection costs you a few days. A termination costs you the account, every app on it, and often any account Apple links to it.

On 2026-10-30, former App Review head Phillip Shoemaker [described a pattern he keeps seeing](https://phillipshoemaker.substack.com/p/apple-approved-the-fix-then-it-called): an app is rejected for objectionable content, the developer fixes what they think was meant, App Review approves the update, and months later the account is terminated under DPLA §3.2(f) for a "pattern of manipulative or misleading behavior". The letter names no app, build or date. In his telling the triggers are rejection history (many submissions, name changes, 1.1 rejections), and Apple distrusts fixes made on a server because they can be switched back on.

Apple's rules moved the same way. Its [October 16, 2026 guideline update](https://developer.apple.com/news/?id=vvzx6cul):

- added **2.5.19**, which bans hidden, dormant or undocumented features, including ones hidden by obfuscation;
- requires review notes to describe changes "with specificity" (**2.3.1(a)**);
- states that nudification apps are prohibited as pornographic material;
- requires apps to prevent and remove nonconsensual intimate imagery, including AI-generated imagery (**1.2**);
- says developers who do not remediate after notice "may be considered" in violation of the Developer Code of Conduct (**1.2**).

Nobody outside Apple can know why a given account was terminated. What you can control is whether your fix was complete, whether anything is concealed, and what the written record says. That is what this tool checks. It works through **compliance and disclosure, never evasion**: no fix it suggests is "rename it", "move it to the server" or "hide it from review".

## Quick start

You need Node.js 20 or later. Nothing else.

```sh
cd MyApp
npx --yes github:wonkylamp/appstore-shield scan .     # every finding, grouped by rule
npx --yes github:wonkylamp/appstore-shield gate .     # CLEAR / WARN / HOLD, exit 1 on HOLD
```

Add `--full` to `scan` for the reasoning and fix behind every finding.

Once it is on npm, `npx appstore-shield …` works the same way.

### In Claude Code

```text
/plugin marketplace add wonkylamp/appstore-shield
/plugin install appstore-shield@appstore-shield
```

Restart Claude Code, then try:

- "Is this ready to submit?"
- Paste an App Review rejection and ask what to fix.
- `/appstore-shield:appstore-shield onboard` to record your Team ID and look the repo over once.

Claude then scans, explains each finding in context, helps you fix it, checks the fix actually removed the capability, and drafts your review notes or Resolution Center reply. If an agent tries to submit for review while the gate says HOLD, the hook stops it.

## How it fits your workflow

1. **While you build.** Ask Claude "anything here App Review would reject?" or run `scan`. Findings point at the line and say what to change. Suppress a false positive in `.appstore-shield/baseline.json` with a written reason (`block` findings can't be suppressed).
2. **Before you submit.** `preflight` gives the verdict plus a manual checklist (demo account, subscription states, things static analysis can't see). Claude drafts your Notes for Review from the record, disclosing any remote flags the scan found, and lints them before you paste them in.
3. **When you or an agent submits.** In CI, `gate` fails the job on HOLD. In Claude Code, the hook runs the gate when an agent runs `fastlane deliver --submit_for_review`, an `asc` submit or an OTA publish, and blocks on HOLD.
4. **If you're rejected.** Paste or import the message. The rejection goes in the ledger and the gate holds until it's dealt with. Claude finds the code behind the guideline, you agree what must become impossible for a user, you fix it, and `verify` sweeps for leftovers (and, for AI features, gives you a probe suite to run). Claude then drafts a specific, linted Resolution Center reply.
5. **When you're approved.** Import Apple's approval email in your own terminal. That closes the rejection and records what was approved.
6. **Months later.** Every `preflight` and `gate` compares against what was approved. A removed capability creeping back, content or pricing changing behind a server switch, or an OTA update that adds features shows up before it reaches App Review or users, the kind of server-side change Shoemaker says Apple distrusts.

## What it catches

| Check | Examples | Guideline |
|---|---|---|
| Review-time gating | `if isReviewer`, TestFlight/sandbox checks, date gates that change what the app shows | 2.5.19, 2.3.1 |
| Remote switches | Remote Config or feature flags that unlock content or change price after review | 2.5.19, 2.3.1(a) |
| OTA and remote code | `eas update`, CodePush, `eval` of downloaded code shipping features | 2.5.2 |
| Generative AI safety | `BLOCK_NONE`, `disable_safety_checker`, uncensored models, nudification and face-swap features | 1.1, 1.2 |
| UGC safeguards | AI chat or shared content with no filter, report, block or contact | 1.2 |
| AI data sharing | Sending user data to a third-party model with no consent prompt | 5.1.2(i) |
| Ratings | Asking "do you like the app?" before showing the review prompt | 5.6.3 |
| Paywalls | Hardcoded prices, no Restore Purchases, delayed close buttons | 3.1.1, 3.1.2 |
| Metadata | Over-length names, other brands' names, "uncensored" claims in the listing | 2.3.7, 4.1 |
| Account deletion | Sign-up with no way to delete the account | 5.1.1(v) |
| Privacy manifest | Missing `PrivacyInfo.xcprivacy`, undeclared required-reason APIs, placeholder purpose strings | 5.1.1 |

It reads Swift, Objective-C, TypeScript/JavaScript, plists, Expo config and fastlane metadata, plus server code that lives in the repo.

## More than a linter

- **A review history for your whole account.** Import App Review emails (`appstore-shield import rejection.eml`) and it keeps a local ledger of submissions, rejections, fixes and everything you sent Apple, keyed by Team ID because a termination acts on the whole account. It shows the raw counts Shoemaker describes as triggers, never a made-up risk score.
- **A gate that remembers.** While a rejection is open and its fix is unverified, `gate` holds. If a capability you removed creeps back in, it holds (or warns, once the fix was approved). If content or pricing changes after approval and your notes don't say so, it holds.
- **Proof the fix is complete.** For a rejection, it records what must become impossible for a user, sweeps the repo and local build for leftovers, and for AI features writes a probe suite you run against your own dev backend.
- **Notes and replies that say the right thing.** It drafts review notes, Resolution Center replies and App Review Board appeals from the record, and lints anything you are about to send for vague change descriptions, undisclosed remote controls, overclaims, pasted secrets and safeguards the scan says are missing.
- **Human sign-off stays human.** Statements like "the server prompt was changed" can only be recorded by you, in your own terminal, with a typed one-time code. Agents are refused.

## Use it in CI

`gate` exits 1 on HOLD, 0 on CLEAR or WARN, and 2 on a usage error. Put it in front of anything that submits for review.

**GitHub Actions**

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 22
- name: App Review gate
  run: npx --yes github:wonkylamp/appstore-shield#v0.1.0 gate .
```

**fastlane**

```ruby
# fastlane/Fastfile
before_all do
  sh("npx", "--yes", "github:wonkylamp/appstore-shield#v0.1.0", "gate", File.expand_path(".."))
end
```

Pin a version so a new release never changes a verdict without you noticing. EAS, monorepo setup (`appPaths`) and the full hook behaviour are in [docs/reference.md](docs/reference.md).

## Install options

| How | Command |
|---|---|
| Claude Code plugin | `/plugin marketplace add wonkylamp/appstore-shield` then `/plugin install appstore-shield@appstore-shield` |
| One-off, no install | `npx --yes github:wonkylamp/appstore-shield gate .` |
| On your PATH | `npm install -g github:wonkylamp/appstore-shield` |
| Any MCP client | `npx -y github:wonkylamp/appstore-shield mcp` (stdio) |
| From a checkout | `git clone https://github.com/wonkylamp/appstore-shield.git && node appstore-shield/dist/cli.js gate .` |

`dist/` is committed, so none of these needs a build step. To try the plugin for one session without installing it: `claude --plugin-dir ./appstore-shield`.

## CLI

```sh
appstore-shield scan .            # findings, grouped by rule (--full for why and fix)
appstore-shield preflight .       # verdict, drift, triggers and a manual checklist
appstore-shield gate .            # CLEAR / WARN / HOLD for scripts and CI
appstore-shield import FILE       # add an App Review email, Resolution Center text or asc export to the ledger
appstore-shield status .          # open rejections and trigger counts
appstore-shield lint notes.txt    # lint review notes, a reply or an appeal
appstore-shield attest            # human-only: record a statement
appstore-shield ack               # human-only: acknowledge an open rejection
appstore-shield mcp               # run the MCP server on stdio
```

`appstore-shield <command> --help` lists every option. Flags are strict: a typo like `--projct` is an error, never a silent pass.

## Your data

- **Nothing leaves your machine.** No network calls, no telemetry, no App Store Connect keys.
- **The ledger** lives in `~/.appstore-shield/teams/<TEAMID>/` (or `ledgerPath` in `.appstore-shield/config.json`). It holds reviewer messages and your replies, so keep it out of public repos; the tool warns if it is pointed at one.
- **Probe suites are files.** You run them against your own backend with your own credentials.

## What it can't do

- **It can't guarantee approval**, and it can't tell you why an account was terminated or whether one will be. Apple's heuristics are not public.
- **It is static analysis.** It misses things and flags things that turn out fine; treat findings as leads for a human to check. It cannot see servers outside the repo or Apple's records.
- **A clean gate is not a clean bill of health.** CLEAR and WARN mean no hold condition was found, not that the app will pass.
- **It does not submit, upload or talk to Apple.**
- **It is not legal advice.** If your account is facing termination, consider counsel. EU developers may also have Digital Services Act dispute options.
- **The hook is a guardrail for a cooperative agent, not a sandbox.** See [SECURITY.md](SECURITY.md).

## Contributing

Bug reports with a minimal repro repo are the most useful thing you can send, especially false positives. See [CONTRIBUTING.md](CONTRIBUTING.md). The design and its sources are in [PLAN.md](PLAN.md) and [docs/research](docs/research).

## License

MIT. See [LICENSE](LICENSE).

# appstore-shield reference

The full rules behind the [README](../README.md): what holds the gate, how the hook decides, monorepo config, every CLI rule and where data is stored. For the threat model and known gaps, see [SECURITY.md](../SECURITY.md).

## Severity and confidence

Each finding has a severity (`block`, `high`, `medium`, `info`: how much it matters if real) and a separate confidence (`high`, `medium`, `low`: how sure the static match is), printed as `[BLOCK, confidence: medium]`. A low-confidence finding still needs a human to read the code. Fixes remove the feature, add the missing safeguard, or disclose; none says rename, move or hide.

## What holds the gate

`appstore-shield gate` exits non-zero on deterministic HOLD conditions:

- a `block` finding;
- an open rejection whose fix has not reached `STATIC_CLEAN` and that you have not acknowledged;
- an open rejection verified `STATIC_CLEAN` or better whose saved spec, swept again against the current tree, no longer reaches `STATIC_CLEAN` (a later-approved rejection that regresses is a warning instead);
- a `high` finding under a guideline an open rejection cites, and for an open 1.1/1.2 rejection any "uncensored"/"no filters" claim in the store listing;
- a check that failed to run;
- post-approval drift in content or price that your notes do not disclose.

The ledger is shared by every app on the team, so a rejection recorded with another app's bundle id does not hold this project; `shield_remediation` `save_spec` and `verify` also refuse such a rejection unless the call passes `force: true` after you confirm this tree is the rejected app.

A scan that stopped at its file budget, or a shipping file it could not read (for example one over the size cap), turns CLEAR into WARN, so a verdict never vouches for code nobody read.

CLEAR and WARN mean only that no deterministic HOLD condition was found, and `gate` prints that caveat under the verdict. Static checks miss things, so neither is a guarantee of approval or against termination.

## Remediation evidence

`shield_remediation` records what must become impossible for a user, sweeps the repo and local build for residue, and for AI features generates a probe suite that you run against your own dev backend. Evidence is tiered: `RESIDUE_FOUND < UNVERIFIABLE < STATIC_CLEAN < BUILD_CLEAN < PROBED(n/m)`.

## What the text lint flags

Review notes (4000-byte limit counted in bytes), Resolution Center replies, App Review Board appeals and reinstatement requests are checked for:

- unsupported absolute claims;
- attestations not worded as attestations;
- pasted secrets;
- combative tone;
- generic change descriptions;
- undisclosed remote controls;
- safeguards the scan reports missing (report, block, moderation, age gate, a consent prompt for third-party AI, account deletion, Restore Purchases), and blocking claimed for an AI-only app with no other users;
- explanations of intent the developer has not confirmed with `attest`;
- speculative admissions.

Attestations ("the server prompt was changed") and acknowledgements can only be recorded by you, in a terminal, with a typed confirmation. The MCP tools refuse them, and the hook denies agents that try.

## Monorepos: `appPaths`

The scan finds every app in the repo (a folder with an Xcode project, or a React Native / Expo package with app config or an `ios/` folder) and lists them in the output and in `app_roots` in the MCP results. When a repo holds more than one app, it scans all of them and says so. If only some ship, list them in `.appstore-shield/config.json`:

```json
{
  "teamId": "ABCDE12345",
  "appPaths": ["apps/mobile"]
}
```

- Paths are folders relative to the repo root; absolute paths and `..` are ignored with a warning. `"."` means the whole repo.
- Repo-level store metadata (`fastlane/`, `metadata/`), in-repo server code (`server/`, `api/`, `functions/`, `workers/`, `supabase/` and similar) and local packages the chosen apps build in are still scanned, because they ship or decide what the app shows.
- `--paths` on the CLI (or `paths` on `shield_scan`) narrows a single scan and overrides `appPaths`. A path outside the repo, one that does not exist, or one that reaches no file the scan reads is an error, never an empty "no findings" scan.
- The output names the apps that were not scanned, so a narrowed scan never reads as the whole repo.

## Claude Code skill and MCP tools

The skill is `/appstore-shield:appstore-shield`. Claude also uses it on its own when you paste a rejection or mention App Review, 3.2(f) or a terminated account.

```text
/appstore-shield:appstore-shield onboard
/appstore-shield:appstore-shield preflight
/appstore-shield:appstore-shield remediate   (paste the App Review message)
/appstore-shield:appstore-shield respond
/appstore-shield:appstore-shield appeal
/appstore-shield:appstore-shield status
```

MCP tools (shown in Claude Code as `mcp__plugin_appstore-shield_appstore-shield__<tool>`):

| Tool | What it does |
|---|---|
| `shield_scan` | Runs the checks. |
| `shield_preflight` | Gate verdict, drift, triggers and checklist before submitting. |
| `shield_remediation` | Finds the surface, saves the spec, verifies, generates and ingests probe suites. |
| `shield_ledger_record` | Records an event in the ledger. |
| `shield_ledger_import` | Imports App Review emails, Resolution Center text or `asc` JSON exports. |
| `shield_ledger_query` | Shows status, timeline, triggers or one rejection. |
| `shield_evidence_pack` | Returns facts and section scaffolds for notes, replies and appeals. |
| `shield_lint_text` | Lints any text before it goes to Apple. |

Other MCP clients can run the same server with `npx -y appstore-shield mcp` (or `node /path/to/appstore-shield/dist/cli.js mcp`). The server also exposes the workflows as prompts.

## CLI

The CLI works without Claude. Run `npx appstore-shield <command>`, `node /path/to/appstore-shield/dist/cli.js <command>`, or put `appstore-shield` on your PATH with `npm install -g appstore-shield` (or `npm link` from a checkout).

```sh
appstore-shield scan --project .          # findings, grouped by rule
appstore-shield preflight --project .     # verdict, drift, triggers, checklist
appstore-shield gate --project .          # exit 1 on HOLD, 2 on a usage error; for scripts and CI
appstore-shield import rejection.eml      # parse an App Review message into the ledger
appstore-shield status --project .        # open rejections, trigger counts
appstore-shield attest                    # human-only: record a statement (your terminal + typed one-time code)
appstore-shield ack                       # human-only: acknowledge an open rejection
appstore-shield lint notes.txt            # lint review notes, a reply or an appeal (exit 1 on errors)
appstore-shield mcp                       # stdio MCP server
appstore-shield hook                      # Claude Code PreToolUse hook (reads JSON on stdin)
```

Run `appstore-shield <command> --help` for every option.

- **A single path is the project.** `scan`, `preflight`, `gate` and `status` take `appstore-shield gate DIR` as well as `--project DIR`.
- **Arguments are strict.** An unknown or misspelled flag, an extra path, a repeated flag, or a value flag with no value is a usage error (exit 2), so `gate --projct .` never reads as a pass.
- **A directory with no app is refused.** `scan`, `preflight` and `gate` exit 2 on a directory with no iOS, SwiftUI or React Native/Expo project, rather than reporting CLEAR. `--force` runs them anyway. The MCP tools refuse such a `project_path` the same way unless the call passes `force: true`.
- **Exit codes:** 0 success (`gate`: CLEAR or WARN; `lint`: warnings or nothing), 1 `gate` HOLD, a `lint` error or a failure, 2 usage error.

## Use it as a gate

`appstore-shield gate` reads the repo and the ledger, records nothing, and exits 1 on HOLD. It prints the verdict, then `HOLD:`, `WARN:` and `NOTE:` lines (notes say which apps were scanned); `--json` prints `verdict`, `holdReasons`, `warnings` and `coverage`. Pin the version in CI so a new release never changes a verdict unannounced (`npx --yes github:wonkylamp/appstore-shield#v0.1.2 gate .`), or add it as a dev dependency (`npm install -D github:wonkylamp/appstore-shield#v0.1.2`).

### fastlane

Run the gate before any lane that submits for review:

```ruby
# fastlane/Fastfile
before_all do
  # fastlane runs from ./fastlane; the gate checks the app repo one level up.
  sh("npx", "--yes", "github:wonkylamp/appstore-shield#v0.1.2", "gate", "--project", File.expand_path(".."))
end
```

If you only want it on release lanes, put the same `sh(...)` call at the top of the lane that calls `deliver(submit_for_review: true)`.

### EAS (Expo)

`eas submit` uploads a build; it does not submit for review. Run the gate where you decide to submit. For example, add it as a dev dependency (`npm install -D github:wonkylamp/appstore-shield#v0.1.2`) and a script, and run it before you press "Submit for Review" or call your submission tooling:

```json
{
  "scripts": {
    "shield:gate": "appstore-shield gate --project ."
  }
}
```

You can also run it in an EAS build hook (`"eas-build-pre-install": "appstore-shield gate --project ."`). On EAS servers your ledger is not available unless `ledgerPath` points at a checkout of it, so that run sees only code findings.

### CI (GitHub Actions)

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 22
- name: App Review gate
  run: npx --yes github:wonkylamp/appstore-shield#v0.1.2 gate --project .
```

The step fails on HOLD. Warnings are printed and do not fail the build. For ledger-based conditions (open rejections, drift), set `ledgerPath` in `.appstore-shield/config.json` to a path where CI checks out your **private** compliance repository.

### The Claude Code hook

`hooks/hooks.json` registers a PreToolUse hook on Bash and Monitor (the built-in tools that run a shell command), the file-editing tools, and MCP tools whose name says they submit:

- **Submit-for-review commands** (for example `fastlane deliver … submit_for_review`, release/submit lanes, `asc` submit commands including `asc review submissions-update --submitted=true` and the steps an `asc workflow run` executes, also when wrapped in `bash -c`, `eval` or a subshell, built from shell variables, or sent straight to the App Store Connect API's `reviewSubmissions`; plain `fastlane deliver` or `upload_to_app_store` when the Deliverfile or a dotenv file fastlane loads sets `submit_for_review`). `asc` flags are read the way `asc` itself reads them (one or two dashes, `=true`/`=1`/`=t`, last one wins), and a `#` comment or a `--dry-run` that is only another flag's value does not cancel a submit:
  - HOLD blocks the command, with the reasons;
  - WARN asks you first;
  - a form the hook can only pattern-match asks you even on CLEAR.
- **The gate checks the app root.** Run from `ios/` in a React Native or Expo app, it gates the folder above (where `package.json` is), so JavaScript findings are not missed.
- **The gate checks every candidate app.** `asc` and `fastlane` submit by app ID, not by directory, so a leading `cd` cannot swap your app for another repo: the hook gates both the session's project (`CLAUDE_PROJECT_DIR` and the hook's working directory) and the `cd` target, and holds if either holds. If none of them is an iOS app project, it asks you instead of scanning.
- **The hook fails closed.** The gate runs in a child process with a 20 s deadline (the hook timeout is 30 s, and Claude Code lets a command through when a hook times out). If the gate does not finish, the hook asks you. Input it cannot read and its own internal errors also ask (exit 0); the hook never exits with an error that would let the command through.
- **Over-the-air updates are gated too.** `eas update`, `expo publish`, `appcenter codepush release*`/`promote`, `code-push release*`, `shorebird patch` and `hot-updater deploy` (also through npx, `bash -c`, package scripts, make, just and `asc` workflows) reach users without App Review. Any gate HOLD, or a rejected-then-approved capability back in the code, holds them. Otherwise the hook asks, with a reminder that an OTA update may only fix bugs (2.5.2): any feature or content change ships in a build that goes through App Review, and each publish is named in the next Notes for Review (DPLA 3.2(e)). Record each publish with `shield_ledger_record` type `ota_publish`. A `--branch`, `--channel`, `-d`/`--deployment-name` or `--track` that names a non-production channel (dev, preview, staging, test, qa, internal, beta, canary) asks instead of holding, and Android-only updates pass.
- **Nothing is recorded by the hook.** It runs before the command, which may still be denied or fail. After you confirm a submission went through, record it with `shield_preflight` `record_submission` (or `appstore-shield preflight --version … --build-number …`).
- **Uploads are not gated** (`xcrun altool`, `iTMSTransporter`, `eas submit`).
- **Detached and scripted runs are checked.** `attest`, `ack` or `import --commit` run through `env -i`, `setsid`, `nohup`, `&`, `tmux`, `screen`, `expect`, `unbuffer`, `script`, `osascript`, `launchctl` or `at` are denied; other CLI runs through these wrappers ask. Script files the command runs (`bash x.sh`, `expect a.exp`, `python3 x.py`) are read: an expect script that drives `attest` is denied, and a submit inside a script counts as a submit. Custom Fastfile lanes are classified by what they do (`upload_to_app_store`/`deliver` with `submit_for_review`, or a call to a lane that does). Commands over 64 KB are not parsed; the hook asks.
- **Agent attempts to run `attest` or `ack` are denied**, in any spelling the hook can recognise. The verb has to be the CLI's own subcommand: `rg -n ack src` is not denied. The CLI also refuses them when an agent's environment variables are set or when any parent process is an AI agent (Claude Code, Codex, Gemini CLI and others), and asks for a one-time code shown only on your terminal.
- **Agent writes to the ledger are denied** (file tools, and any shell command that names the ledger, the shield home, a configured `ledgerPath` or `APPSTORE_SHIELD_HOME`, or runs inside one of them after `cd`, unless its program only reads; redirection and command substitution count as writes). Edits to `.appstore-shield/config.json` and `baseline.json` ask you first.
- **Approvals are recorded only by import** of Apple's message or an `asc` export, run by you: `appstore-shield import <file>` in your own terminal. Storing an approval needs the same human check as `attest` (an interactive terminal, not detached, not `env -i`, no agent parent) plus a typed one-time code; anywhere else the approvals are dropped with a "Not stored" warning and the other events are still stored. `shield_ledger_record` refuses approvals, and `shield_ledger_import` (MCP) previews them but does not store them, because the text comes from the agent and an approval closes rejections and resets the drift baseline. Imports dated in the future are refused.
- **Everything else passes** silently.

Limits (see [SECURITY.md](../SECURITY.md) for each layer and the known gaps): the hook is a guard against mistakes, not a sandbox. A determined process with your user's file access can still write the ledger. The human-only checks on `attest`, `ack` and approval imports (environment, process ancestry, `env -i`, controlling terminal, pty drivers such as `expect`, one-time code) deter an agent; they are not a security boundary against a program running under your account, which can detach from its parent (for example through a terminal multiplexer or launchd) and type the code itself. MCP App Store Connect tools are gated only when their name contains "submit" or "submission" plus "review", "appstore", "asc" or "store connect", and is not a read-only call (a name that starts with get, list, validate and similar verbs is gated only if it also says submit, as in `validate_and_submit_for_review`); check any other submission tool yourself.

## Where data lives

- **Ledger:** `${APPSTORE_SHIELD_HOME:-~/.appstore-shield}/teams/<TEAMID>/events.jsonl`. It is append-only JSON lines; corrections are new events. One ledger per Apple Developer Team, shared by all your repos for that team.
- **Team ID** is detected from these sources, in order:
  1. `.appstore-shield/config.json` (`teamId`);
  2. `DEVELOPMENT_TEAM` in your Xcode project;
  3. `ios.appleTeamId` in `app.json` or `eas.json`;
  4. otherwise a `repo-…` placeholder, with a warning.
- **Per repo, `.appstore-shield/`:**
  - `config.json`: `teamId`; `ledgerPath` to keep the ledger in a private compliance repo; `appPaths` to scan only the apps that ship in a monorepo.
  - `baseline.json`: suppressions. Each needs a written justification; `block` findings cannot be suppressed.
  - `probes/`: generated probe suites and your results.

**Keep the ledger out of public repositories.** It holds reviewer messages, your replies and your attestations. The tool warns if `ledgerPath` points inside a repo with a public GitHub or GitLab remote.


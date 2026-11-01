# Security and threat model

appstore-shield is a local guardrail. It runs on your Mac, makes no network calls, holds no
Apple credentials, and submits nothing to Apple. This page says what it protects, who it is meant
to stop, and what it cannot stop.

## What it protects

1. **Submitting while the gate says HOLD.** A submit-for-review command run by a coding agent
   (`asc review submit`, `fastlane deliver submit_for_review:true`, a Fastfile lane that submits,
   an App Store Connect API `reviewSubmissions` call, an App Store Connect MCP submit tool) is
   held while `appstore-shield gate` reports HOLD.
2. **Over-the-air updates while the gate says HOLD.** An OTA publish (`eas update`, CodePush,
   Shorebird) changes what users of an approved build run without App Review. That is the
   post-review modification DPLA 3.2(e) and Guideline 2.5.2 are about, so the hook holds it on
   the same conditions as a submission, and also when a rejected capability that was later
   approved without it is back in the code.
3. **Human-only judgments.** `attest`, `ack` and imported approvals record the developer's own
   statements and decisions. An approval closes open rejections. An agent must not record these.
4. **The review ledger.** The ledger (`~/.appstore-shield/teams/<TEAMID>/events.jsonl`, or a
   configured `ledgerPath`) is an honest, append-only record of what Apple said and what the
   developer did. Agents read it through the MCP tools and must not write it directly.
5. **CI and release scripts.** `appstore-shield gate` must never report a pass by mistake.

## Who it is meant to stop

- **A well-intentioned or confused coding agent.** For example, an agent that tries to "fix" a HOLD
  by acknowledging the rejection itself, or that submits from the wrong directory.
- **Accidental bypass.** Examples are a typo in a flag (`--projct`), an unset variable
  (`--project $IOS_DIR`), a path passed without `--project`, or running the gate in a directory
  that is not the app. Each one is a usage error (exit 2), not a silent pass. Capturing a
  command's output (`OUT=$(asc review submit …)`) or wiping the working tree with `git stash -u`
  or `git clean -fdx` is another: the hook still sees the submission or the ledger it removes.
  So is running a release behind a routine wrapper (`timeout 900 npm run ship`, `op run -- eas
  update`, a tmux pane) or cleaning up with a glob (`rm compliance/*.jsonl`).

## Untrusted repository content

The hook and the gate read the repository they run in on every call, and a repository can come
from anywhere: a clone, a pull request branch, a zip, a dependency. Its files are data, never
instructions.

- **What a checkout chooses.** Its `.appstore-shield/config.json` picks the Team ID and may set
  `ledgerPath`, so a checkout decides which ledger the gate reads for it. A rejection recorded
  for the repo in an earlier ledger is still reported when the config points somewhere else
  (the shield home remembers every ledger each repo used).
- **What a checkout cannot do.** It cannot make the shield write through a symlink (the ledger
  is opened with `O_NOFOLLOW`), append to or change the permissions of a file that is not a
  ledger, or block the hook or the gate with a FIFO or device: every file read (scripts,
  package.json, Makefile, justfile, workflow file, Fastfile, Deliverfile, dotenv files,
  `.appstore-shield/config.json`, the ledger) is checked to be a regular file first, and is
  read only up to a size cap. git runs only through `execFile`, never a shell. The calls that read the working tree
  switch off the repo's hooks, fsmonitor, pager, ssh command, askPass, external diff,
  clean/smudge/process/textconv and diff command drivers, and signature verification
  (`log.showSignature` and the gpg, gpg.openpgp, gpg.ssh and gpg.x509 programs), including
  values pulled in through `include.path`; the others (`rev-parse`, `rev-list`, `remote -v`) read only
  refs and configuration, which run none of the commands a `.git/config` can name. The hook and
  the gate never run the repo's scripts; they read them.
- **What a checkout can do.** Besides choosing the ledger, it can make the hook or the gate
  slow, ask, or hold (a huge tree, a malformed workflow file, a script the hook cannot read).
  Being hard to read never turns into a pass: a file that cannot be read or parsed, and a gate
  that does not finish in time, ask rather than allow.

## What it cannot stop

**It cannot stop a deliberately adversarial process that runs as your user with a shell.** Such a
process has every right you have. It can write the ledger file, edit or disable the plugin and
its hooks, drive your terminal app through GUI scripting, or run its own pseudo-terminal through
a program the checks do not know. It can then type the one-time code. Nothing in this tool is a
sandbox, and no check described here is a security boundary against your own account.

The ledger's `source` field (`human`, `import`, `agent`, `ci`) records how an event was written.
It is not signed. The gate trusts `human` and `import` events. A stronger boundary would need a
signature from a key that requires user presence (for example a Keychain item with an access
control list). That is not implemented.

If you need a hard boundary, run the agent under a different macOS user or in a VM or container
that cannot read or write your ledger and cannot reach your terminal.

## The layers, and the cheap bypasses each one closes

### The Claude Code hook (`hooks/hooks.json` → `appstore-shield hook`)

- **Which tools it sees.** Bash, Monitor (which runs a shell command in the same environment as
  Bash), Write, Edit, MultiEdit, NotebookEdit, and MCP tools whose name contains `submit` or
  `submission`. Any tool that the matcher sends and that carries a shell `command` gets exactly
  the Bash checks.
- **Wrappers.** Every check reads the program a segment actually runs, through one shared list
  of wrappers, each with its own options and operands: `env` (including `-S`), `sudo`, `doas`,
  `command`, `exec`, `time`, `nohup`, `setsid`, `nice -n N`, `timeout`/`gtimeout DURATION`,
  `caffeinate`, `stdbuf`, `chrt`, `ionice`, `taskset`, `watch`, `arch`, `xcrun`, `script`,
  `cross-env`, `env-cmd`, `dotenv … --`, `op run --`, `doppler run --` (or `--command`),
  `infisical run --`, `dotenvx run --`, `aws-vault exec … --`, `npx`/`pnpx`/`bunx` with their
  options, `npm exec`/`npm x`, `pnpm exec`/`dlx`, `yarn exec`/`dlx`, `bun x` and `bundle exec`,
  nested in any order. `xargs [options] CMD` and `find … -exec CMD` count as running CMD, so a
  submit, an OTA publish, a package script, a script file or `attest`/`ack` behind any of them is
  found as if it were typed bare.
- **Submit commands** are found in their usual forms, including asc's low-level flow that ends
  in `asc review submissions-update --submitted=true`. asc's flags are read the way Go's `flag`
  package reads them: one or two dashes (`-submitted`, `-submit`), any true value it accepts
  (`t`, `1`, `TRUE`), a bare flag that never takes the next word (`--submitted false` still
  submits), and the last occurrence winning. A `--dry-run` cancels `asc publish appstore
  --submit` only when it is a real flag: not in a `#` comment, and not the value of the flag
  before it (`--notes '--dry-run'`). The command is read with and without its comments and the
  stronger result kept, so a comment can neither cancel a submit nor hide one. Line
  continuations (`sub\<newline>mit`) and `$IFS` / `${IFS}` word breaks are read as bash reads
  them, and `asc` or `fastlane` run by `xargs` with its arguments from input counts as a submit
  form. `fastlane deliver` and `upload_to_app_store` with no `submit_for_review` on the command
  line still submit when the repo's `Deliverfile` says `submit_for_review(true)`, when a dotenv
  file fastlane loads (`fastlane/.env`, `.env.default`, `.env.<--env>`) sets
  `DELIVER_SUBMIT_FOR_REVIEW`, or when that variable is set in the environment; the hook reads
  those files whether or not a Fastfile exists. An explicit `submit_for_review:false` on the
  command line wins. They are also found inside command substitution (`OUT=$(asc review
  submit)`, `` echo `…` ``, `"$(…)"` in double quotes, `<(…)` and `>(…)`): each body is read as
  a command of its own, in the directory it runs in, and a substitution that computes the
  program (`$(which asc) review submit`) counts as one run through a variable. Single-quoted
  text and `#` comments run nothing and are not read this way, except the code given to `bash -c`
  or `sh -c`, which is read as a script of its own. They are also found inside `bash -c`,
  `eval`, subshells, `if … then`, with global flags before the subcommand, through shell
  variables (`A=asc; $A review submit`, `asc $x submit`), as direct App Store Connect API calls,
  in Fastfile lanes with custom names (classified by whether they call `deliver` or
  `upload_to_app_store` with `submit_for_review: true`, or run a submit command through `sh`),
  in a script file the command runs (`bash ship.sh`, `python3 submit.py`, `./release.command`),
  in code passed inline (`python3 -c`, `node -e`, `osascript -e`) and in any script path that
  code names, and in task runners: `npm run`, `npm test`/`start`, `yarn`, `pnpm`, `bun run`
  (the package.json script with its `pre` and `post` scripts), `make` targets with their
  prerequisites, `just` recipes, and `asc workflow run NAME` (the named workflow's steps in
  `.asc/workflow.json` or `--file`, the sub-workflows it calls, and the file's `before_all`,
  `after_all` and `error` hooks; JSONC comments are allowed). One level of nesting is followed
  (`"ship": "npm run release"`, a make recipe that runs `bash submit.sh`). A package.json,
  Makefile, justfile or workflow file that exists but cannot be read or parsed (not a regular
  file, over 1 MB, or not valid JSON) asks. `asc testflight review submit` sends a build to
  TestFlight beta review, not App Review, and is not gated.
- **Over-the-air publishes** are a class of their own: `eas update` and `eas update:republish`,
  `expo publish`, `appcenter codepush release*` and `promote`, `code-push release*` and
  `promote`, `revopush`, `shorebird patch` and `hot-updater deploy`, in the same wrapped forms
  as submit commands (`npx`, `bash -c`, `eval`, subshells, command substitution, package
  scripts, make targets, just recipes, workflows). The gate runs on them. Any gate HOLD holds the publish (exit 2), and so
  does the gate's warning that a later-approved rejection's saved spec matches the current tree
  again (below STATIC_CLEAN), because an OTA update skips the review that would catch it.
  Otherwise the hook asks, with a reminder to keep the update to bug fixes (2.5.2), to disclose
  behaviour changes, and to record an `ota_publish` event once it is published. A publish whose
  `--branch`, `--channel`, `-d` or `--track` names a development channel (`dev`, `preview`,
  `staging`, `test`, `qa`, `internal`, `beta`, `canary`, alone or followed by a separator, as in
  `preview-pr-12`) asks instead of holding, and lists the HOLD reasons. A name that also says
  `prod`, `release`, `live`, `main`, `master` or `store` (`beta-prod`, `qa-release`) counts as
  production. Android-only publishes (`--platform android`, `shorebird patch android`) are not
  gated; every platform the command names has to be android, so `-p android -p ios` is gated. Rollbacks and listings (`eas update:rollback`, `eas update:list`) are not publishes.
- **Lanes judged by name only.** A fastlane lane whose name contains `release` or `submit` is
  gated by its name, unless the repo's Fastfile defines it and shows that it does not submit
  (no `deliver`/`upload_to_app_store` with `submit_for_review: true`, no submit command, and no
  `submit_for_review` value computed at run time). Then the hook asks instead of holding, so
  `fastlane release_notes` is not stopped by a HOLD.
- **App Store Connect MCP tools** whose name contains `submit` or `submission` (the API resource
  is `reviewSubmissions`) and names App Review or App Store Connect are gated, whether the server
  key is written with hyphens or underscores (`mcp__app-store-connect__…`, `mcp__app_store_connect__…`). A tool is left out
  only when its leading verb reads, lists, cancels, deletes or validates (`get_review_submission`,
  `cancel_review_submission`) and it does not also submit, or when it says it is a dry run. A
  name that also contains `validate` or `status` still counts when it submits
  (`validate_and_submit_for_review`, `submit_…_with_status_check`).
- **Commands handed to a terminal window or a multiplexer** ask: AppleScript `do script` and
  iTerm `write text`, their JXA forms (`osascript -l JavaScript … doScript(…)`, `write({text: …})`),
  `open -a`/`-na`/`-b` of a terminal app (Terminal, iTerm, Warp, Ghostty, Alacritty, kitty,
  WezTerm, Hyper), opening a `.command` file, `tmux send-keys`, `new-session`, `new-window`,
  `split-window`, `respawn-pane`, `run-shell`, `display-popup` and `tmux -c`, `screen` with a
  command (`screen -dmS name CMD`) or `-X stuff`, `kitty @ send-text`/`launch` and `wezterm cli
  send-text`/`spawn`. They run outside the agent's process tree, where neither the hook nor the
  CLI's lineage check can tell that an agent started them. The command text they hand over is
  also checked as a command of its own (its script files and package scripts are followed), so a
  submit or OTA publish handed to a pane still holds on HOLD, and `attest`/`ack` handed over is
  denied.
- **HOLD blocks the command.** WARN asks. A form the hook could only pattern-match asks even when
  the gate is CLEAR. A gate that does not finish within 20 s asks; it never lets the command
  through. Input that is not a JSON object, and any error inside the hook, asks too: Claude Code
  runs the command when a hook exits 1.
- **Running `attest` or `ack` from the agent is denied.** This covers the spellings the hook
  recognises: quoting, `npx`, `node dist/cli.js`, copies of the CLI, `xargs`, an `expect` or
  shell script file that drives them, AppleScript `do script`, and command substitution
  (`git commit -m "$(npx appstore-shield ack …)"` runs `ack`). The CLI has to be the program
  that runs, or the code given to `bash -c`, `eval` or an interpreter: text that only mentions
  it (`git commit -m "explain appstore-shield attest"`, `grep`, `echo`) is not a run.
- **Running the CLI detached is denied or asks.** This covers `env -i`, `setsid`, `nohup`,
  `disown`, a background `( … & )` job, `tmux`, `screen`, `expect`, `unbuffer`, `script`,
  `osascript`, `launchctl` and `at`. With `attest`, `ack` or `import --commit` it is denied.
  Otherwise it asks.
- **Ledger and shield-home writes are denied.** The check works from a short list of programs
  that only read (`cat`, `less`, `head`, `tail`, `grep`, `rg`, `jq`, `wc`, `ls`, `stat`, `file`,
  `shasum`, `diff`, `find` without `-delete` or `-exec`, `git log`/`diff`/`show`/`status`/`add`/
  `commit`, and similar). A command segment that names the ledger, a configured `ledgerPath`,
  anything in the shield home, or `APPSTORE_SHIELD_HOME` with any other program is denied: an
  editor (`vim`, `ed`), a deleter (`trash`, `shred`, `find -delete`, `git clean`), a downloader
  (`curl -o`, `wget -O`), an archiver (`unzip -d`, `tar -C`), an interpreter, or a program the
  list has never heard of. Output redirection (other than to `/dev/null` or another descriptor),
  `$(…)`, backticks and process substitution also make a segment a writer. A segment that runs
  inside the shield home after `cd` counts as naming it, and a ledger path stored in a variable
  is denied when any segment of the command writes. The file tools are denied the same paths.
  This covers the record of which ledgers each repo used (`repos/` in the shield home, and
  `repos.json` from earlier versions), which is how a rejection follows a repo when its Team ID
  or ledger changes. Every word of the
  command is resolved against the directory it runs in, after any `cd`, so relative forms count:
  `echo … >> compliance/ledger.jsonl`, `cd compliance && sed -i … ledger.jsonl`, and
  `rm -rf compliance` or `mv compliance …` on the folder that holds a configured ledger. After a
  `cd` to a directory only known at run time (`cd "$DIR"`), a word with the ledger's file name
  is denied. A path reached through a symlink is resolved before the check. Globs and braces are
  expanded the way bash does before matching (`rm compliance/*.jsonl`, `rm -rf compl*`,
  `rm -rf ~/.appstore-*`, `rm -rf ~/.{appstore-shield,cache}`); like bash without `dotglob`, a
  `*` does not match a leading dot, so `rm -rf ~/*` is not about the shield home. `find` with
  `-delete`, `-fprint` or `-exec`/`-execdir`/`-ok` of a program that is not a reader is denied
  when its start directory holds a protected path and its `-name`, `-path` and `-maxdepth`
  tests could reach it; a test the hook cannot judge (`-regex`, `!`) counts as reaching it, and
  so does a `find` with no name test (`find . -type f -delete` in a repo with an in-repo ledger).
  On macOS and Windows, whose volumes are case-insensitive by default, paths are compared
  case-folded, so `~/.APPSTORE-SHIELD` or `COMPLIANCE/ledger.jsonl` is the same file. Creating or editing
  `.appstore-shield/config.json` asks, whether or not the file exists, as do edits to
  `baseline.json` and commands that create or delete anything inside `.appstore-shield/`
  (`mkdir`, `mkfifo`, `mknod`, redirection, `rm -rf .appstore-*`).
- **Git commands that wipe an in-repo ledger ask.** When the configured `ledgerPath` is inside
  the git work tree, commands that delete or revert files without naming them ask: `git clean`
  (unless `-n`) where it would reach the ledger, `git stash` (push, save, or with `-u`/`-a`),
  `git reset --hard`, `--merge` or `--keep`, `git switch -f`, and `git checkout` or `git restore`
  of a path that holds the ledger (`.`, `:/`, the repo root). They would erase an untracked
  ledger or drop the events added since the last commit, such as a freshly imported rejection,
  and the gate would read the shorter history. `git checkout BRANCH`, `git stash list`/`pop`
  and `git restore --staged` do not ask. A command that names the ledger or its folder is a
  write and is denied, as above.
- **Bounded parsing.** Every pattern is linear in the text it reads, and a command over 64 KB is
  not parsed; the hook asks. Within that cap the checks of the command line itself (the submit,
  OTA, attest/ack, detach and ledger checks) have no time limit of their own: they are linear in
  the command, and the filesystem work they do is bounded by the directories it names. Each
  directory's project root and configured ledger are looked up once per hook call however many
  `cd` segments lead there, and a `cd` to a path longer than 4,096 characters, which no
  directory can have, is not followed. Glob matching keeps one backtrack point per `*`, brace
  expansion stops at 32 variants (past that the braced span reads as `*`, which can only match
  more), and at most 256 glob words of up to 1,024 characters are expanded per command. A command of 10,000 `cd x;` segments before a submit is
  answered in a few seconds. Following scripts and task runners is bounded per hook call, across
  every level of nesting: at most four script files are read (paths that do not exist do not
  count), and only their first 64 KB; at most 32 paths are tried and 2,048 words examined per
  text; at most eight distinct package.json, Makefile, justfile or workflow files are read, each
  once and parsed once; a task already checked is not checked again; at most 64 texts and 4 MB of
  script text are analysed; and following them stops after 15 s. Past any of these limits the
  hook asks, because what it did not check could submit. A recipe that runs `make t` a thousand
  times, each `t` running `make u` a thousand times, is checked in well under a second. Every
  file the hook reads is checked to be a regular file under a size cap first, never a FIFO or
  device. The gate runs in a child process that is killed at 20 s, and a watchdog answers "ask"
  at 27 s if anything asynchronous stalls. This matters because Claude Code runs the command
  when a hook times out. The watchdog cannot interrupt synchronous work, which is why the
  parsing is linear and the limits above exist.

Known gaps in the hook:

- It sees only the tools listed above. Another agent with no hook, a built-in shell tool added
  to Claude Code later and not yet in the matcher, or an MCP tool that submits under an
  unrelated name (for example `mcp__asc__patch_resource` called with a `reviewSubmissions`
  body), is not gated.
- Reads of the ledger are recognised by program name. A program on the read-only list that
  can write in a way the hook does not parse would pass. A read-only program whose output is
  redirected anywhere is treated as a writer, so `grep x ledger > /tmp/out` is denied.
- It cannot read a script path built at run time (`bash "$S"`), except that `expect` and
  `unbuffer` with an unreadable script ask.
- Task runners: workspace scripts (`npm -w app run x`, `pnpm --filter app x`) are looked up in
  the nearest package.json only, not in the workspace package. Make variables that name a target
  (`make $(T)`), make's implicit rules, `include`d makefiles, just `import`/`mod` files, and other
  runners (`task`, `rake`, `turbo`, `nx`, `npx some-script`) are not followed. Only one level of
  nesting is followed. `asc workflow run --resume` is read from the current workflow file, while
  asc reuses the file saved with the run.
- Over-the-air updates published another way are not recognised: a custom script that uploads
  a bundle to your own update server, the Expo or CodePush APIs called directly, or a CI job.
  The channel check reads the channel's name only; a production channel named `beta` asks
  instead of holding.
- Inline code in Python, JavaScript, Ruby, Perl or AppleScript is read as words, not parsed. A
  command assembled from string pieces (`"asc " + "review"`) is not recognised.
- Lanes defined in an imported Fastfile or a fastlane plugin are not followed, and a lane whose
  name says release or submit but whose Fastfile definition shows no submission asks rather
  than holds.
- A terminal multiplexer session started by the agent looks the same as yours, and so does any
  pane of a tmux or screen server that is already running: the CLI's human check sees a
  terminal owned by the multiplexer, not by a program, and the agent is not among its
  ancestors. The hook asks before every `tmux send-keys`, `screen -X stuff` and similar hand-off,
  but reading a pane (`tmux capture-pane`) is not stopped, and a hand-off you approve can type
  the one-time code into a pane that passes the check.
- The ledger and the record of which ledgers each repo used are protected from the agent's
  tools, but neither is hashed or signed, and no high-water mark of the ledger's length is kept.
  If either is removed or truncated by other means (outside the hook, or by a git command the
  developer approves), the gate reads the shorter history instead of reporting an integrity
  problem.
- Command substitution nested more than 32 levels deep is not read as commands, and a command
  built from strings at run time (`eval "$(printf …)"`) is not recognised.

### The CLI's human check (`attest`, `ack`, and storing an imported approval)

A command needs all of these to count as a person at their own terminal:

- **No agent variables:** `CLAUDECODE`, `CLAUDE_CODE_*` or `AI_AGENT` must not be set.
- **No AI agent among its ancestor processes,** such as Claude Code, Codex or Gemini CLI.
- **A normal login environment:** `TERM`, `HOME` and `USER`/`LOGNAME` are set. `env -i` clears
  them.
- **A controlling terminal.** A background or double-forked job has none.
- **Not re-parented to pid 1,** which is what a double fork leaves behind.
- **A terminal owned by a terminal app** (Terminal, iTerm, VS Code, ssh, tmux), not by a program
  that drives a pseudo-terminal (`expect`, `unbuffer`, `script`, `socat`, or a Python, Perl,
  Ruby or Node process). A tmux or screen pane passes, whoever types into it; see the
  multiplexer gap above.
- **Interactive stdin and stdout,** and a typed confirmation containing a one-time code that is
  printed only at that moment.

If the process table cannot be read, the check refuses.

An approval imported anywhere else is shown but not stored. That covers an agent session, CI, a
detached job and a mistyped code. Rejections and other events are still stored, labelled with
their source. The MCP tools never store approvals, `ack` or attestations.

These checks deter an agent that is cooperating, confused, or taking a shortcut. As stated
above, they do not stop a program that is determined to forge a person at a terminal.

### The gate (`appstore-shield gate`)

- **It appends nothing to the ledger** and writes nothing in the shield home.
- **It fails closed.** Only an explicit CLEAR or WARN exits 0. HOLD and any error exit 1. A
  usage error exits 2. The exit code is set before any output is written, so a closed pipe
  cannot turn a HOLD into a pass.
- **Strict arguments.** Unknown flags, a value flag with no value or an empty value, and extra
  arguments are usage errors (exit 2). A single positional path means `--project`.
- **It refuses non-app directories.** A directory with no iOS, SwiftUI or React Native/Expo
  project is refused with exit 2, instead of being scanned and reported CLEAR. `--force`
  overrides this.

## What this tool never does

It does not help hide features from App Review, rename or move code to avoid detection, or alter
the ledger to change what Apple sees. Apple keeps its own history regardless. Findings tell you
what to remove or disclose.

## Reporting a vulnerability

Report privately through GitHub's private vulnerability reporting:
<https://github.com/wonkylamp/appstore-shield/security/advisories/new>. Do not open a public issue
for a bypass. Include the command or tool call, the hook or gate output, your macOS version and
the appstore-shield version (`appstore-shield --version`).

Report a way round one of the checks above that a cooperative or confused agent could hit by
accident, and any way the gate can report a pass it should not. A bypass that needs a
deliberately adversarial process is still worth reporting, but it is expected under this
threat model.

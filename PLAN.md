# appstore-shield — Design

The design and its rationale, built on primary-source research.
- Research: `docs/research/apple-guidelines-2026-10.md` (Apple's text) and `docs/research/mcp-and-claude-code.md` (MCP SDK, plugin, skills, hooks).
- Verified, compiling MCP example: `docs/research/mcp-example.ts`.

This is a local, zero-auth MCP server (TypeScript) plus a Claude Code skill, shipped as one Claude Code plugin. It helps iOS, SwiftUI and React Native/Expo developers avoid App Review rejections and Apple Developer Program terminations under **DPLA §3.2(f)**. It makes no network calls and needs no App Store Connect keys.

Every claim carries a label: **[source]** = Shoemaker's post. **[apple]** = Apple primary text (see research doc). **[inferred]** = our reading. **[guess]** = an assumption we cannot check.

---

## 1. Source analysis

Source: Phillip Shoemaker, *"Apple approved the fix. Then it called the developer a liar."* (subtitle "Who's misleading whom?"), Substack, 2026-10-30.

### 1.1 The case [source]
- **The case.** Shoemaker presents a composite, "a case I'm seeing over and over, with the details changed":
  - An AI photo app with an AI-girlfriend feature was rejected for objectionable content (typically cited as 1.1) because users could dress her in lingerie.
  - The developer removed the lingerie and kept the girlfriend.
  - App Review approved the fix.
  - Months later, with nothing under review, Apple terminated the account under 3.2(f) for a "pattern of manipulative or misleading behavior". The notice named no app, build, date or screenshot.
- **His thesis:** the developer "acted in good faith on what Apple told them". Approval is the only feedback that tells a developer the app is now acceptable, and the termination calls an honest developer a liar.

### 1.2 Shoemaker's thesis vs Apple's possible view
The cause of any given termination is **unknowable**, because the letter names nothing. This tool deliberately designs for **Apple's possible view** (residue, server switches, history) because that is what a developer can act on. **It does not claim residue caused the case above.** In Shoemaker's post the cosmetic-fix scenario is hypothetical, under the heading "The fair case for Apple".

### 1.3 Mechanisms

| # | Mechanism | Label | What we build |
|---|---|---|---|
| M1 | 1.1/1.2 rejections quote the guideline and rarely say what to change. Follow-ups often get "the same guideline paragraph back". The guidelines are vague on purpose. | source | Write down an interpretation at capability level. Send a clarifying question *and* fix the broadest reasonable reading in parallel. Mention that a call with App Review can be requested [apple]. |
| M2 | Reviewers see prior rejection reasons, notes and screenshots. Approval does not visibly close the earlier issue. | source (seeing) / inferred (it counts toward a "pattern") | Treat every rejection as permanent account history. Close it with verification evidence and specific review notes. |
| M3 | **Fair case for Apple:** reviewers get a few minutes per update ("about six when I ran the team"). A cosmetic fix (template removed, free text still works) and Apple may only learn that from later reports. | source (hypothetical) | Capability-level remediation and a probe suite. Working in-app report and moderation, because those later reports may include user reports [inferred]. |
| M4 | Apple "distrusts fixes made on a server" because they can be switched back on. | source | Inventory of remote config, OTA updates and server prompts. A drift check against the last approved snapshot. Disclosure. |
| M5 | 3.2(f) used to come from the Fraud team (real fraud, e.g. 10,000 Nome, Alaska accounts reviewing one app). Since about mid-2026 App Review issues it "with no apparent oversight". The triggers he sees are rejection history: many submissions, many app name changes, many 1.1 rejections. Inquiries are up about 1,000% in 4 months. | source (anecdotal; selection bias from his inbox) | A trigger checklist with raw counts and **no invented thresholds**. |
| M6 | AI image apps "are where nudification tools live, and Apple's post names them." | source + apple (Oct 16 post: nudification as a bait-and-switch example under 2.5.19, NCII under 1.2) | Nudification and real-person-likeness scanner (`block`). |
| M7 | "Every honest argument with App Review becomes evidence of bad character." Termination notices, as Shoemaker reports them, list *misleading support or App Store Connect responses* among the behaviors; DPLA 3.2(f) itself bars misleading or dishonest acts. | source | **Every outgoing text is linted:** no absolute claims, attestations worded as attestations, no combative tone. Our own notes could become evidence against the developer. |
| M8 | "Apple links related developer accounts whenever it can." | source | The ledger is **account-scoped**, keyed by Team ID, not by repo. |
| M9 | Appeals need **an apology, an explanation of how it happened, and a plan to prevent it**, in that order; Shoemaker says Apple wants this, which he learned working with Jobs, Cook and Schiller. The letter names no offense, so the developer must guess what to apologize for. | source | Appeal evidence pack: apologize only for confirmed real mistakes; ask Apple politely to identify the conduct; never make speculative admissions. |
| M10 | Shoemaker's proposal 4 draws the line at concealment: notice and a window to fix "where nothing was concealed". | source | Disclosure is the centre of the product. |
| M11 | Apple's text (Oct 16, 2026): **2.5.19** bans hidden, dormant or undocumented features, including via obfuscation. **1.2:** developers who fail "to remediate identified violations after notice" "may be considered in violation" of the Developer Code of Conduct; Apple wants removal *plus a compliance plan*. **2.3.1(a):** notes must describe changes "with specificity". **DPLA 3.2(e):** no code that would "deceive regarding the identity, purpose, or behavior" of the app, "including through post-review modifications that would cause harm to others". | apple | Rules cite these sections directly. |
| M12 | A forum case suspects the developer's **own App Store Connect automation** caused a termination of about 50 apps. A Japanese developer suspects rapid AI-assisted prototyping of many apps ("concept or feature switch schemes"). | apple forums / secondary | The gate counts submissions and warns about automation volume. The hook makes agents stop before submitting for review. |

**What the post does not say:**
- It never mentions AI coding agents. The link to agents is **[inferred]**, though M12 is suggestive.
- It gives no thresholds.
- The article body gives developers no direct advice; its six proposals are addressed to Apple.

---

## 2. Principles

1. **Compliance and disclosure, never evasion.** The fix text for every finding is "remove" or "disclose", never "rename", "move" or "hide". Classify by behavior (what the gated scope does), not by name. Obfuscation and runtime-fetched prompts downgrade evidence to `UNVERIFIABLE`. Nudification and likeness findings get "remove", never "add a disclaimer". Post-approval drift output always says "resubmit or disclose".
2. **Zero auth, zero network.** Inputs are the repo, local build products, and text or files the developer provides (pasted emails, exports the developer generates with their own credentials).
3. **Facts, not prose, from the TS layer.** Tools return typed facts with ledger event IDs and section scaffolds. Claude writes the prose, and `shield_lint_text` checks it.
4. **No false precision.** No numeric risk score, and no distance-to-threshold. Raw counts with the source quote. HOLD only on deterministic conditions.
5. **Honest evidence tiers.** `RESIDUE_FOUND < UNVERIFIABLE < STATIC_CLEAN < BUILD_CLEAN < PROBED(n/m)`. Nothing claims the capability is gone from the model except a probe, and only for the prompts tried.
6. **Human-only assertions.** `attestation` and `ack` events can be appended only through the CLI on a TTY with a typed confirmation. The MCP tool refuses them, and the hook denies agents running them.
7. **Smallest thing that works.** Regex plus the lexical scope analyzer (`src/scope.ts`). Tree-sitter only if field tests show unacceptable false positives. "Tool finds, LLM traces, tool records" for dataflow.

---

## 3. Architecture

```
appstore-shield/                       # repo root = Claude Code plugin root
  .claude-plugin/plugin.json           # name "appstore-shield"; mcpServers: node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js mcp
  .claude-plugin/marketplace.json      # marketplace "appstore-shield" (source ./): /plugin install appstore-shield@appstore-shield
  hooks/hooks.json                     # PreToolUse Bash → dist/cli.js hook
  skills/appstore-shield/SKILL.md      # + references/*.md
  src/
    finding.ts project.ts scope.ts checks.ts     # shared contracts
    scanners/<check>.ts                # each exports `check: Check`
    scanners/index.ts                  # registry
    rules/*.ts                         # pattern data (lexicons, provider tables)
    ledger/schema.ts                   # event union
    ledger/store.ts                    # locate/read/append/fold + team id
    ledger/import.ts                   # parse App Review emails / asc JSON exports
    ledger/triggers.ts                 # trigger checklist + gate decision
    ledger/drift.ts                    # snapshots + diff vs last approved
    ledger/evidence.ts                 # evidence packs (facts + scaffolds)
    ledger/lint.ts                     # outgoing-text lint
    remediation/surface.ts             # sources/sinks/term candidates for spec building
    remediation/verify.ts              # residue sweep + tiers
    remediation/built.ts               # .ipa/.xcarchive/.app sweep
    remediation/probe.ts               # probe suite generation + results ingest
    baseline.ts                        # .appstore-shield/baseline.json suppressions
    preflight.ts                       # aggregate
    server.ts                          # MCP server (tools, resources, prompts)
    cli.ts                             # mcp | scan | preflight | gate | hook | attest | ack | import | status
  test/                                # vitest; fixtures under test/fixtures
  docs/research/                       # source material
```

- **Stack:** Node ≥20, `@modelcontextprotocol/sdk@1.32.2` (`registerTool` etc. only; `z.object` schemas), `zod@4`, `vitest`, and `esbuild` to bundle `dist/cli.js` into one file so the plugin needs no install.
- **Git:** `git` is called through `execFile` (never a shell) with a timeout.
- **Output:** stdout is reserved for MCP. Log to stderr only.

### Storage
- **Ledger:** `${APPSTORE_SHIELD_HOME:-~/.appstore-shield}/teams/<TEAMID>/events.jsonl`, append-only.
  - Team ID comes from, in order: `.appstore-shield/config.json` `teamId`; `DEVELOPMENT_TEAM` in `*.xcodeproj/project.pbxproj`; `ios.appleTeamId` in `app.json`/`eas.json`; otherwise `repo-<sha1(root)[0:8]>` with a warning.
  - `config.json` `ledgerPath` overrides the location (e.g. a private compliance repo).
- **Per repo, in `.appstore-shield/`:** `config.json`, `baseline.json` (suppressions with a required `justification` of at least 20 characters; non-suppressible findings are ignored there), `probes/` (generated suites and results).
- **Public-repo warning:** if someone points `ledgerPath` inside the repo and `git remote -v` shows github.com/gitlab.com, warn that reviewer messages and attestations would become public.

---

## 4. Checks (`shield_scan` `checks` enum)

Each finding has: stable `id`, `rule`, `severity` (`block|high|medium|info`), `confidence`, `guideline`, `file:line`, `evidence` (≤160 chars), `why`, `fix`, `suppressible`.

| Check | Guidelines | What it detects | Severity rules |
|---|---|---|---|
| `review_gating` | 2.5.19, DPLA 3.2(e), 2.1(a) | Code that behaves differently during review: sandbox receipt / `AppTransaction.environment` / TestFlight detection, date gates, region/IP/timezone gates, Apple IP ranges (17.0.0.0/8), Cupertino geofences, reviewer or demo-account branches (client and in-repo server). Classified by **what the gated scope does** (via `scope.ts` + sink lexicon). | Apple IP / Cupertino / reviewer-account branch → `block`, not suppressible. Environment or date gate around content, generator, persona or price → `block`. Debug-UI-only gate → `medium` ("verify nothing user-facing differs"). Storefront legal gating → `info` + "disclose in review notes". |
| `remote_config` | 2.5.19, 2.3.1(a), DPLA 3.2(e) | Inventory every flag/remote-config read: Firebase Remote Config, LaunchDarkly, Statsig, PostHog, ConfigCat, Optimizely, Unleash, GrowthBook, RevenueCat/Superwall/Adapty remote paywalls, custom JSON from workers.dev/pages.dev/supabase/S3/gist. Records key, default value, read sites, and classifies by gated-scope sinks: `content-gating`, `price-gating`, `safety-killswitch`, `product`, `unknown`. | content-gating over adult or nudification content → `block`, not suppressible (delete the flag and the content; disclosure does not fix it). Other content-gating → `high` (disclose or remove). price-gating → `high` (3.1.2). Others `info`. Inventory goes into `data` for disclosure and drift. |
| `ota_updates` | 2.5.2, 2.5.19, DPLA 3.2(e) | expo-updates/EAS Update, CodePush, Shorebird, hot-update libraries, downloading and evaluating JS (`eval`, `new Function`, JSContext `evaluateScript` on fetched code), dynamic `dlopen`. | OTA present → `info` + disclosure + drift snapshot. Remote code evaluation → `block`. |
| `genai_safety` | 1.1, 1.2, Oct 16 NCII, 4.7 | Provider safety **explicitly disabled**: Gemini `safetySettings` `BLOCK_NONE`/`OFF`, Replicate `disable_safety_checker: true`, fal `enable_safety_checker: false`, BFL `safety_tolerance` ≥ 5, Stability safety off. Model/LoRA IDs matching uncensored/nsfw/abliterated/porn/nude/hentai. **Nudification/likeness:** user-photo image-to-image or face-swap combined with undress/clothes-removal/x-ray/nude/body terms, face-swap SDKs, celebrity prompts. Moderation coverage: input-only moderation on an image generator. Emits the AI **surface** (providers, sources, sinks, prompts) in `data`. | Safety disabled, uncensored model, or nudification → `block`, not suppressible. No moderation on any generator → `high`. Input-only moderation on an image generator → `high`. |
| `ugc_safeguards` | 1.2, 1.2.1(a), 4.7.1 | When UGC/AI content is shown: (1) filter, (2) report with timely response, (3) block user, (4) published contact info; age identification and gating for above-rating content. | Each missing → `high` (when UGC/AI is detected); 1.2.1(a) → `medium`. |
| `ai_data_disclosure` | 5.1.2(i), 4.7.3 | User photos, text or voice sent to a known AI host with no consent UI or string before first use (look for consent/permission/disclosure terms naming AI or the provider). | `high`. |
| `ratings_integrity` | 5.6.1, 5.6.3, 3.2(f) | Custom rating prompts that bypass `SKStoreReviewController`/`requestReview`/`expo-store-review`, rate-to-unlock incentives, sentiment pre-gates, hardcoded social proof ("4.9★ from 10,000 users"). | Incentive or bypass → `block`. Pre-gate → `high`. Hardcoded proof → `medium`. |
| `paywall` | 3.1.1, 3.1.2, Schedule 2 §3.8(b), 5.6 | StoreKit 2 / RevenueCat / react-native-iap / react-native-purchases: hardcoded prices vs `displayPrice`; period and renewal terms; trial terms; Restore Purchases; Terms and Privacy links; delayed or hidden dismiss; hardcoded "% off" not from product data. | Missing restore, terms or price disclosure → `high`. Delayed close → `high`. |
| `metadata` | 2.3.7, 2.3.8, 2.3.14, 4.1(c), 3.2(f) | `Info.plist`, Expo config, `metadata/` / `fastlane/metadata/`: field limits (name 2–30, subtitle 30, keywords 100 bytes, promo 170), prices or other app names in name/subtitle, unverifiable claims ("#1", "best", "uncensored", "no filter"), placeholder purpose strings, and a metadata **snapshot** in `data` for churn tracking. | Limits → `high`. Third-party brands → `high`. Claims → `medium`. |
| `account_deletion` | 5.1.1(v) | Account creation (sign up, createUser, Firebase Auth, Supabase signUp, Sign in with Apple) without an in-app deletion path. | `high`. |
| `privacy_manifest` | 5.1.1, privacy manifest | Missing manifest; required-reason API use (UserDefaults, file timestamps, boot time, disk space, active keyboards) not declared; tracking SDKs vs `NSPrivacyTracking`. Low priority: App Store Connect upload already catches most of this. | `medium`. |

**False-positive gate:** rules are field-tested on real open-source iOS and RN apps. Any rule above ~20% false positives is demoted to `info` or fixed.

---

## 5. MCP surface

All tools take `project_path` (absolute, must exist), return a ≤25-line text summary plus `structuredContent` with an `outputSchema`, are annotated `openWorldHint: false`, and write errors that say what to do next. Default output is concise: findings grouped by rule, the top 30, `truncated` + how to narrow, and `detail: "full"` for everything.

| Tool | Input | Output | Annotations |
|---|---|---|---|
| `shield_scan` | `checks?`, `paths?`, `include_tests?`, `detail?` | Findings, counts, suppressed count, per-check `data` (surface, inventory, snapshot) | readOnly |
| `shield_preflight` | `build_path?`, `record_submission?: {version, build, bundle_id?}` | Gate verdict (CLEAR/WARN/HOLD + reasons), trigger checklist, drift vs last approved snapshot, top findings, open rejections, a manual checklist (demo account non-expiring, expired-subscription account, 2FA in notes, notes specificity per 2.3.1(a)). Records snapshot events; records a submission only when `record_submission` is given. | not readOnly, idempotent=false |
| `shield_remediation` | `action`: `find_surface` \| `save_spec` \| `verify` \| `probe_suite` \| `ingest_probe_results`; `rejection_id`; plus action-specific fields | `find_surface`: candidate terms/symbols/assets/sources/sinks for the rejection text. `save_spec`: validates that symbols/files exist (rejects hallucinated entries) and stores it. `verify`: Verification with tier. `probe_suite`: writes `.appstore-shield/probes/<id>.jsonl` + a runner template. `ingest_probe_results`: n/m blocked, hash. | per action |
| `shield_ledger_record` | `event` (discriminated union minus human-only) | Stored event with id | not readOnly |
| `shield_ledger_import` | `text?` or `file_path?`, `commit?: boolean` | Parsed proposed events (App Review rejection/approval emails, Resolution Center text, `asc … --output json` exports). Stored only when `commit: true`. | — |
| `shield_ledger_query` | `view`: `status` \| `timeline` \| `triggers` \| `rejection`; `rejection_id?` | Folded state views | readOnly |
| `shield_evidence_pack` | `purpose`: `review_notes` \| `reply` \| `clarification` \| `appeal_review_board` \| `appeal_termination`; `rejection_id?`; `letter?` | Typed facts with event IDs, section scaffold (purpose-specific order; termination = Shoemaker's apology → how → plan, with a request to identify the conduct), byte budget, and **private hypotheses** for appeals (never to be pasted) | readOnly |
| `shield_lint_text` | `purpose`, `text`, `rejection_id?`, `fact_ids?` (ledger event ids of the facts used) | Issues: >4000 **bytes** (notes); absolute claims ("none", "never", "impossible", "all", "guarantee") unless backed by `PROBED` 100% + `BUILD_CLEAN`; attestation statements not prefixed "The developer states"; credentials or secrets pasted; combative or legalistic tone; generic change descriptions (2.3.1(a)); undisclosed remote controls or OTA when the inventory has them; speculative admissions in appeals. | readOnly |

- **Resources:** `shield://playbook`, `shield://guidelines` (the guideline map), `shield://checks` (check catalog).
- **Prompts:** `preflight`, `remediate`, `respond`, `appeal`. These mirror the skill so non-Claude-Code MCP clients get the workflows too.
- **Server `instructions`** (≤4,096 chars) lead with the trigger keywords: App Store rejection, App Review, 3.2(f), terminated, resubmit.

---

## 6. Gate, hook, CLI

- **`appstore-shield gate [--project DIR]`** exits 1 on HOLD. It can be called from fastlane `before_all`, EAS build hooks, CI, or Xcode Cloud scripts.
  - **HOLD (deterministic only):**
    - a `block` finding;
    - an open rejection (rejected, no later approval for that app) whose latest verification tier is below `STATIC_CLEAN` and that has no human `ack`;
    - post-approval drift touching content or price that is not disclosed in pending notes.
  - **WARN:** trigger checklist items, high findings.
- **`appstore-shield hook`** (PreToolUse Bash; JSON on stdin):
  1. **Submit-for-review commands** (real `asc` subcommands for submitting for review, `fastlane deliver … submit_for_review`, `fastlane … submit`, `xcrun altool`/`iTMSTransporter` are upload only and **not** gated, `eas submit` is upload only and **not** gated) → run the gate. HOLD → exit 2 with the reasons on stderr. WARN → JSON `permissionDecision: "ask"` with the reasons.
  2. `appstore-shield attest|ack` from the agent → deny ("human-only; run it yourself in a terminal").
  3. Everything else → exit 0 silently, fast (<50 ms when no match).
  4. Hardening: a second, quote-insensitive pass catches wrapped submit forms (`bash -c`, `eval`, subshells) and any spelling of attest/ack; Bash or Write/Edit writes to the ledger are denied, edits to `.appstore-shield/config.json`/`baseline.json` ask; MCP tools named like App Store submit tools are gated; run from `ios/` of an RN/Expo app, the gate checks the parent app root. The hook records nothing (the command has not run yet).
- **`appstore-shield attest|ack`:** requires `process.stdin.isTTY`, no agent-session environment (`CLAUDECODE` etc.), and the user typing a confirmation phrase that includes a one-time code.
- **Approvals** enter the ledger only via import (Apple's message or an `asc` export); `shield_ledger_record` refuses `outcome: approved`, since an approval closes rejections and resets the drift baseline.
- **Open rejection + same-guideline high finding → HOLD**, even at `STATIC_CLEAN`: the rejection named the guideline Apple will check again (e.g. a 1.2 rejection and `ugc.no_report`).
- **`appstore-shield import <file>`, `status`, `scan`, `preflight`:** human-friendly output.

---

## 7. Skill: `skills/appstore-shield/SKILL.md` (<500 lines; detail in `references/`)

Invoked as `/appstore-shield:appstore-shield <command>`, and model-invoked on rejection or 3.2(f) language.

| Command | Flow |
|---|---|
| `preflight` | `shield_preflight`. HOLD → explain, fix, never submit. Otherwise `shield_evidence_pack(review_notes)` → draft → `shield_lint_text` → developer pastes, then `shield_ledger_record(message_sent)` once they confirm it was sent. |
| `remediate` | Import or paste the rejection → write the interpretation → in parallel, draft the clarifying question (`respond`) **and** `find_surface` → trace sources→sinks → `save_spec` → **remove** the capability across all input paths and store surfaces → `verify` (loop) → `probe_suite` for AI capabilities → `ingest_probe_results` → review notes. Warn against quick resubmits; one complete fix beats several fast ones. |
| `respond` | Resolution Center replies and clarification questions: evidence pack → draft → lint → record. Calm and specific; no arguing. Offer to request a call. |
| `appeal` | Two different flows. App Review Board (facing termination or a rejection): reply in App Store Connect first, then rebut each listed instance with facts. Already terminated: reinstatement form plus a written improvement plan (5.6). Shoemaker's order, apologizing only for confirmed real mistakes that the developer approves one by one; politely ask Apple to identify the conduct; suggest counsel. |
| `status` | Trigger checklist, open rejections, drift. |
| `onboard` | Detect team ID, backfill history via import or interview, create `config.json`, explain where the ledger lives. |

**References:**
- `playbook.md`: mechanisms M1–M12 with labels, plus operating rules.
- `guidelines-map.md`: guideline → check → complete fix.
- `review-notes.md`: structure within 4000 bytes, specificity (2.3.1(a)), disclosure of remote controls, OTA and AI services, demo accounts.
- `replies-and-appeals.md`.
- `probe-runner.md`: how to run the probe suite against your own dev backend.

---

## 8. Limits (stated to users in README and SKILL)

- Apple's heuristics are not public. **No tool can guarantee an account will not be terminated.** The triggers are anecdotal reports.
- We cannot see servers outside the repo, Apple's records, or linked accounts.
- Static analysis misses things and produces false positives. Findings are leads for a human.
- The tool does not give legal advice; for terminations, consider counsel.

## Decisions taken

| Question | Decision |
|---|---|
| Q1 distribution | Plugin + bundled CLI usable without Claude |
| Q2 ledger location | Account-scoped, outside the repo by default |
| Q3 enforcement | Block only on deterministic conditions; warn otherwise |
| Q4 platforms | SwiftUI and RN/Expo, with OTA awareness |

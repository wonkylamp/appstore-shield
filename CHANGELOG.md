# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.1] - 2026-11-01

### Fixed

- Scans no longer slow down on Node 20 and 22 for large or minified files. Two patterns were quadratic on V8 before Node 24: AI SDK import detection (2.6 s to 18 ms on 100 KB of whitespace) and review-gating reference tracing (3.2 s to 0.36 s CPU on a 1.4 MB file). A slow scan could outlast the submit hook's deadline.
- `npm ci` works on npm 10 (Node 20 and 22): esbuild is bumped to 0.28 to satisfy vitest's optional peer range.
- Tests no longer assume a macOS terminal (`TERM` set, Node's process name in `ps`), so CI passes on Linux.

### Changed

- README rewritten around the developer workflow; detailed gate, hook and CLI rules moved to `docs/reference.md`.
- Install commands use `github:wonkylamp/appstore-shield` until the package is on npm.

## [0.1.0] - 2026-10-31

First public release.

### Added

- Static scan of iOS, SwiftUI and React Native/Expo repos for review-time gating, remote-config content and price switches, OTA updates and remote code, generative-AI safety gaps, missing UGC safeguards, AI data disclosure, review-prompt manipulation, paywall disclosure, store metadata, account deletion and privacy manifest gaps. Fixes remove the feature, add the missing safeguard, or disclose; none says rename, move or hide.
- `gate` and `preflight`: a CLEAR / WARN / HOLD verdict for scripts, CI, fastlane and EAS, with drift since the last approval, open rejections, a trigger checklist and a manual checklist. CLEAR and WARN are not a guarantee of approval.
- Account-scoped review ledger keyed by Apple Team ID, with import of App Review emails, Resolution Center text and `asc` JSON exports.
- Remediation workflow: surface search, residue spec, verification tiers (`RESIDUE_FOUND` to `PROBED`), built-product sweep and probe suites run against your own backend.
- Evidence packs and a linter for review notes, Resolution Center replies, clarification questions and appeals.
- Claude Code plugin: MCP server, `appstore-shield` skill, and a PreToolUse hook that holds submit-for-review commands and production OTA publishes while the gate says HOLD.
- Human-only `attest` and `ack` commands with a typed one-time code.

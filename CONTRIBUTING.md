# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Setup

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Node.js 20 or later. There are no runtime dependencies: everything is bundled into `dist/` by esbuild.

## Commit dist/

Claude Code runs the plugin from `dist/cli.js` and does not build plugins installed from git, so `dist/` is committed. After any change under `src/`, run `npm run build` and commit the result. CI runs `npm run check:dist` and fails when `dist/` differs from a fresh build.

## Try the plugin from a checkout

```sh
claude --plugin-dir .
claude plugin validate .
```

The MCP server is declared in `.claude-plugin/plugin.json`, not in a root `.mcp.json`, so opening the checkout in Claude Code does not offer a project server that only works inside a plugin.

## Releasing

1. Replace the `OWNER` placeholder with the GitHub user or org: `node scripts/owner.mjs set <owner>`. `npm publish` refuses to run while it is left (`npm run check:owner`).
2. Bump the version in `package.json` and `.claude-plugin/plugin.json`, and add a `CHANGELOG.md` entry.
3. `npm run build`, commit `dist/`, tag `vX.Y.Z` and push.
4. `npm publish`, in the same release, so `npx appstore-shield` never resolves to a package someone else registered.

## Ground rules

- **Compliance and disclosure, never evasion.** Every finding's fix removes the feature, adds the missing safeguard, or discloses. A change that helps an app hide behavior from App Review (renaming, moving, obfuscating, reviewer detection, remote switches) will not be merged.
- **Classify by behavior, not names.** A scanner should match what code does, not what it is called.
- **Precision over recall for `block` and `high`.** A false `block` holds someone's release; when unsure, use a lower severity or confidence.
- **Cite Apple's text.** Rules cite the guideline or DPLA section they rest on (see `docs/research/apple-guidelines-2026-10.md`), and anything based on anecdote is labelled as such.
- **No network.** The CLI, MCP server and hook make no network calls. Do not add telemetry or runtime dependencies.
- **Tests.** Add a regression test with every fix. Fixtures live in `test/fixtures/`.

## Code style

TypeScript, ESM with `.js` import suffixes, `strict` and `noUncheckedIndexedAccess`. Run git through `execFile`, never a shell. Comments explain why, not what.

## Security

See [SECURITY.md](SECURITY.md) for the threat model, and report vulnerabilities privately through GitHub's security advisory form rather than in a public issue.

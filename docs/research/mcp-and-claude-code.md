# MCP + Claude Code plugin reference (researched 2026-10-31)

Verified against the installed `@modelcontextprotocol/sdk@1.32.2` and official docs. A compiled, working example is in `mcp-example.ts` next to this file.

## Decisions
- **SDK:** stay on `@modelcontextprotocol/sdk@1.32.2`. v2 has split packages (`@modelcontextprotocol/server`). v1 is supported until at least about 2027-01. v2 needs zod ≥ 4.2; on older zod it falls back at runtime and drops `.describe()` text.
- **Staying v2-ready:** use only `registerTool`/`registerPrompt`/`registerResource`, never the deprecated `tool()`/`prompt()`/`resource()`. Pass `z.object(...)` schemas, not raw shapes. Migrating later is one command: `npx @modelcontextprotocol/codemod@latest v1-to-v2 .`
- **stdout:** never write to stdout from the stdio server. Log with `console.error`.

## Tools (spec 2026-07-28; SDK speaks 2025-11-25)
- **Fields:** `name` (1–128 chars, `[A-Za-z0-9_.-]`), `title`, `description`, `inputSchema` (`type: object`), `outputSchema`, `annotations`.
- **Annotations:** `readOnlyHint`, `destructiveHint` (default true), `idempotentHint`, `openWorldHint` (default true). In Claude Code, `readOnlyHint: true` lets calls run in parallel and lets an interrupted call be retried. For our local, offline tools, set `openWorldHint: false`.
- **outputSchema:** with one set, the tool **must** return `structuredContent` (an object in SDK 1.32) unless `isError` is set. It **should** also return the same JSON as a text block. We return a short human-readable text summary plus the structured data.
- **Errors:** errors thrown in a handler, including input-validation errors, become `{isError: true, content: [text]}`. Write errors that say what to do next.
- **Resources and prompts:** a resource fits static reference data (guideline map, playbook). A prompt fits a user-triggered template (shows as `/mcp__server__prompt`). Anything the model decides to call is a tool.

## SDK 1.32.2 API
```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
const server = new McpServer({ name, version }, { instructions });
server.registerTool(name, { title, description, inputSchema, outputSchema, annotations }, async (args) => ({ content: [{ type: "text", text }], structuredContent }));
server.registerResource(name, uri | new ResourceTemplate("x://{id}", { list: undefined }), metadata, readCb);
server.registerPrompt(name, { title, description, argsSchema }, cb);
await server.connect(new StdioServerTransport());
```

## Claude Code plugin
- **Layout:** `.claude-plugin/plugin.json` (only `name` is required; optional: `displayName`, `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`). At the plugin root: `skills/<name>/SKILL.md`, `hooks/hooks.json`, `.mcp.json`, `bin/`.
- **Naming:** no `claude-` prefix. Validate with `claude plugin validate . --strict`.
- **MCP servers:** either a root `.mcp.json` or an inline `mcpServers` object in `plugin.json`, e.g. `{"mcpServers":{"appstore-shield":{"command":"node","args":["${CLAUDE_PLUGIN_ROOT}/dist/cli.js","mcp"]}}}`. Tool names become `mcp__plugin_<plugin>_<server>__<tool>`. This repo uses the inline form: a root `.mcp.json` is also where Claude Code looks for project-scoped servers, so a contributor opening the checkout would be offered a server whose `${CLAUDE_PLUGIN_ROOT}` is unset outside plugin context.
- **Dependencies:** they are installed only for marketplace-cached plugins that ship a lockfile, and never for local-path plugins. **Ship a single bundled JS file (esbuild) in `dist/`** so no install is needed.
- **Install:** `claude --plugin-dir ./` for one session, or the repo's `.claude-plugin/marketplace.json` (`{"name":"appstore-shield","owner":{"name":"…"},"plugins":[{"name":"appstore-shield","source":"./"}]}`; `source` is relative to the marketplace root, here the repo root) with `/plugin marketplace add wonkylamp/appstore-shield` (or `./` for a checkout) and then `/plugin install appstore-shield@appstore-shield`.
- **Skills:** invoked as `/<plugin>:<skill>`. Keep SKILL.md under 500 lines and put detail in sibling files. Frontmatter fields: `name`, `description` (key use case first; description plus `when_to_use` is capped at 1,536 chars), `when_to_use`, `argument-hint`, `arguments`, `allowed-tools`, `disable-model-invocation`, `user-invocable`, `model`, `effort`, `context: fork`, `hooks`, `paths`. Arguments arrive as `$ARGUMENTS`, `$0`, `$1`. `${CLAUDE_SKILL_DIR}` and `${CLAUDE_PLUGIN_ROOT}` are available. `` !`cmd` `` injects command output, and a non-zero exit aborts the skill.
- **Hooks:** `hooks/hooks.json` needs a top-level `"hooks"` wrapper: `{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"node","args":["${CLAUDE_PLUGIN_ROOT}/dist/hook.js"],"timeout":30}]}]}}`. Input JSON on stdin includes `tool_name`, `tool_input.command`, and `cwd`.
  - To block: exit code 2, with the reason on stderr.
  - To allow, ask, or deny with context: exit 0 with JSON `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"|"ask"|"allow","permissionDecisionReason":"…"}}`.
- **Output limits:** Claude Code warns when a tool returns more than 10k tokens and caps output at 25k. Keep tool output concise by default and offer a `detail` option.

## Tool-design practice (Anthropic, "Writing effective tools for AI agents")
- Have a few consolidated, workflow-shaped tools, not one per check.
- Prefix tool names with a namespace.
- Return high-signal fields, with concise and detailed formats.
- When truncating, say how to narrow the query.
- Write actionable errors.
- Use unambiguous parameter names (`project_path`).
- Tool search defers MCP tools, so the server `instructions` (≤4,096 chars) and the first words of each tool name and description matter.

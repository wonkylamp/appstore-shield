#!/usr/bin/env node
// Minimal stdio MCP server against @modelcontextprotocol/sdk@1.32.2 + zod@4.1.12.
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod"; // zod 4.x root export is v4; SDK accepts v3 or v4 schemas

const server = new McpServer(
  { name: "appstore-shield", version: "0.1.0" },
  { instructions: "Checks iOS projects for App Review rejection risks." },
);

// Output schema: either a raw shape or a z.object() is accepted (ZodRawShapeCompat | AnySchema).
const Finding = z.object({
  guideline: z.string().describe("App Review Guideline id, e.g. 5.1.1"),
  severity: z.enum(["high", "medium", "low"]),
  message: z.string(),
});
const ScanOutput = z.object({
  findings: z.array(Finding),
  truncated: z.boolean(),
});

server.registerTool(
  "scan_project",
  {
    title: "Scan iOS project",
    description:
      "Scan an Xcode project directory for App Review rejection risks. Read-only. " +
      "Returns at most `limit` findings, highest severity first.",
    // Input: raw shape (also accepts z.object({...})).
    inputSchema: {
      path: z.string().describe("Absolute path to the Xcode project root"),
      limit: z.number().int().min(1).max(200).default(50),
      response_format: z.enum(["concise", "detailed"]).default("concise"),
    },
    outputSchema: ScanOutput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ path, limit, response_format }): Promise<CallToolResult> => {
    if (!path.startsWith("/")) {
      // Tool execution error: visible to the model so it can self-correct.
      return {
        isError: true,
        content: [{ type: "text", text: `path must be absolute; got "${path}". Pass the project root, e.g. /Users/me/MyApp.` }],
      };
    }
    const all: z.infer<typeof Finding>[] = [
      { guideline: "5.1.1", severity: "high", message: `Missing NSCameraUsageDescription (${response_format})` },
    ];
    const findings = all.slice(0, limit);
    const structured = { findings, truncated: false };
    return {
      structuredContent: structured,
      // Backwards compat: also return the serialized JSON (or a readable summary) as text.
      content: [{ type: "text", text: JSON.stringify(structured) }],
    };
  },
);

// Static resource
server.registerResource(
  "guidelines-index",
  "shield://guidelines",
  { title: "Guideline index", description: "Indexed App Review Guidelines", mimeType: "application/json" },
  async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: "[]" }] }),
);

// Templated resource
server.registerResource(
  "guideline",
  new ResourceTemplate("shield://guidelines/{id}", { list: undefined }),
  { title: "Guideline", mimeType: "text/markdown" },
  async (uri, { id }) => ({ contents: [{ uri: uri.href, text: `# Guideline ${String(id)}` }] }),
);

// Prompt (argsSchema is a raw shape of string-ish schemas)
server.registerPrompt(
  "preflight",
  { title: "Pre-submission check", description: "Run a full pre-submission review", argsSchema: { path: z.string() } },
  ({ path }) => ({
    messages: [{ role: "user", content: { type: "text", text: `Run scan_project on ${path} and summarize blockers.` } }],
  }),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Never write to stdout in a stdio server; log to stderr.
  console.error("appstore-shield MCP server running on stdio");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

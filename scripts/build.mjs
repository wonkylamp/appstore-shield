// Bundles the CLI (which also hosts the MCP server and hook) into one ESM file so the
// plugin runs with plain `node dist/cli.js` and needs no npm install.
import { build } from "esbuild";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = path.resolve(process.env.APPSTORE_SHIELD_OUTDIR ?? path.join(root, "dist"));

const result = await build({
  // Paths in the bundle's comments and chunk hashes are relative to this; pinning it to the repo
  // root makes dist/ byte-identical wherever the build runs, so CI can check the committed copy.
  absWorkingDir: root,
  entryPoints: [path.join(root, "src", "cli.ts")],
  outdir,
  entryNames: "[name]",
  chunkNames: "chunks/[name]-[hash]",
  // Splitting keeps the hook's fast path small: scanners and the MCP SDK load only when used.
  splitting: true,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: false,
  legalComments: "none",
  logLevel: "warning",
  // Written below, file by file, so a running hook, MCP server or test never sees dist/ missing.
  write: false,
  // Some bundled CommonJS dependencies call require(); ESM output has no require, so provide one.
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __shieldCreateRequire } from \"node:module\";\nconst require = __shieldCreateRequire(import.meta.url);",
  },
});

// Each file is written beside its target and renamed over it: a process that starts mid-build
// loads either the old file or the new one, never a half-written one. Chunks are content-hashed,
// so they go first and cli.js, which names them, goes last.
const files = [...result.outputFiles].sort((a, b) => Number(path.basename(a.path) === "cli.js") - Number(path.basename(b.path) === "cli.js"));
const written = new Set();
for (const f of files) {
  await mkdir(path.dirname(f.path), { recursive: true });
  const tmp = `${f.path}.${process.pid}.tmp`;
  await writeFile(tmp, f.contents, { mode: path.basename(f.path) === "cli.js" ? 0o755 : 0o644 });
  await rename(tmp, f.path);
  written.add(f.path);
}

// Stale chunks from earlier builds would ship in the plugin otherwise.
async function prune(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await prune(p);
    else if (!written.has(p)) await rm(p, { force: true });
  }
}
await prune(outdir);

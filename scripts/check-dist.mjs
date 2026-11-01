// Plugins installed from git are not built, so the committed dist/ is what users run. This
// rebuilds into a scratch dir and fails when the result differs from dist/, so a source change
// can never ship with a stale bundle.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const committed = path.join(root, "dist");
const scratch = mkdtempSync(path.join(tmpdir(), "appstore-shield-dist-"));
const fresh = path.join(scratch, "dist");

function list(dir, base = dir) {
  let out = [];
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(list(p, base));
    else out.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return out.sort();
}

try {
  execFileSync(process.execPath, [path.join(root, "scripts", "build.mjs")], { env: { ...process.env, APPSTORE_SHIELD_OUTDIR: fresh }, stdio: "inherit" });
  const want = list(fresh);
  const have = list(committed);
  const problems = [];
  for (const f of want) if (!have.includes(f)) problems.push(`missing from dist/: ${f}`);
  for (const f of have) if (!want.includes(f)) problems.push(`stale file in dist/: ${f}`);
  for (const f of want) {
    if (have.includes(f) && !readFileSync(path.join(fresh, f)).equals(readFileSync(path.join(committed, f)))) problems.push(`differs from a fresh build: dist/${f}`);
  }
  if (problems.length) {
    console.error(`dist/ is out of date with src/. Run \`npm run build\` and commit dist/.\n${problems.map((p) => `- ${p}`).join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log(`dist/ matches a fresh build (${want.length} files).`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

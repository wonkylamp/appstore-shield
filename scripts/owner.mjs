// The GitHub owner is a placeholder until the repo is published. Install commands and package
// links that still say OWNER are dead ends, so `npm publish` refuses to run while one is left.
//   node scripts/owner.mjs check          exit 1 while any OWNER/appstore-shield placeholder remains
//   node scripts/owner.mjs set <owner>    replace every placeholder with the real GitHub user or org
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLACEHOLDER = /\bOWNER\/appstore-shield\b/g;
const SKIP = new Set(["node_modules", "dist", ".git", "coverage"]);

function textFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) textFiles(p, out);
    else if (e.isFile() && statSync(p).size < 2_000_000 && /\.(md|json|ya?ml|mjs|ts|txt)$/.test(e.name) && e.name !== "package-lock.json") out.push(p);
  }
  return out;
}

function placeholders(base = root) {
  const hits = [];
  for (const f of textFiles(base)) {
    const lines = readFileSync(f, "utf8").split("\n");
    lines.forEach((l, i) => {
      // This script and its test name the placeholder on purpose.
      if (PLACEHOLDER.test(l) && !/scripts[/\\]owner\.mjs$|publishReadiness\.test\.ts$/.test(f)) hits.push(`${path.relative(base, f)}:${i + 1}`);
      PLACEHOLDER.lastIndex = 0;
    });
  }
  return hits;
}

const [cmd, owner] = process.argv.slice(2);
if (cmd === "check") {
  const hits = placeholders();
  if (hits.length) {
    console.error(`The GitHub owner is still the placeholder OWNER in:\n${hits.map((h) => `- ${h}`).join("\n")}\nRun \`node scripts/owner.mjs set <github-user-or-org>\` first.`);
    process.exitCode = 1;
  } else console.log("No OWNER placeholder left.");
} else if (cmd === "set") {
  if (!owner || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) {
    console.error("Usage: node scripts/owner.mjs set <github-user-or-org>");
    process.exitCode = 2;
  } else {
    const files = [...new Set(placeholders().map((h) => h.replace(/:\d+$/, "")))];
    for (const rel of files) {
      const p = path.join(root, rel);
      writeFileSync(p, readFileSync(p, "utf8").replace(PLACEHOLDER, `${owner}/appstore-shield`));
    }
    console.log(`Replaced OWNER with ${owner} in ${files.length} file(s): ${files.join(", ")}`);
  }
} else {
  console.error("Usage: node scripts/owner.mjs check | set <github-user-or-org>");
  process.exitCode = 2;
}

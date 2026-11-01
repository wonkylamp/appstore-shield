import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadContext, type LoadOptions, type ScanContext } from "../src/project.js";

/** Writes `files` (repo-relative path → contents) into a fresh temp dir. */
export async function tempProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "appstore-shield-"));
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, text);
  }
  return root;
}

/** Builds a real ScanContext from in-memory files. */
export async function ctxFromFiles(files: Record<string, string>, opts?: LoadOptions): Promise<ScanContext> {
  return loadContext(await tempProject(files), opts);
}

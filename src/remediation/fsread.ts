import { constants as fsc } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** Probe results are one short JSON line per prompt; a few thousand of them fit well under this. */
export const RESULTS_MAX_BYTES = 5 * 1024 * 1024;
/** Evidence files are source files in the repo. */
export const EVIDENCE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Reads a path the caller named, refusing anything but a small regular file. A FIFO would block a
 * libuv thread (and process exit) forever and /dev/zero would read until memory runs out, so the
 * type and size are checked before any read, and again on the open handle in case the path was
 * swapped in between. With `within`, the real path must stay inside that directory.
 */
export async function readRegularFile(file: string, max: number, what: string, within?: string): Promise<Buffer> {
  const st = await lstat(file);
  if (st.isSymbolicLink()) throw new Error(`${what} ${file} is a symbolic link; pass the file it points to`);
  if (!st.isFile()) throw new Error(`${what} ${file} is not a regular file`);
  if (st.size > max) throw new Error(`${what} ${file} is ${st.size} bytes (limit ${max})`);
  if (within) {
    const [real, base] = await Promise.all([realpath(file), realpath(within)]);
    if (!real.startsWith(base + path.sep)) throw new Error(`${what} ${file} resolves outside ${within}`);
  }
  // O_NONBLOCK: a FIFO swapped in after the lstat must not block the open itself.
  const fh = await open(file, fsc.O_RDONLY | fsc.O_NOFOLLOW | (fsc.O_NONBLOCK ?? 0));
  try {
    const fst = await fh.stat();
    if (!fst.isFile() || fst.ino !== st.ino || fst.dev !== st.dev) throw new Error(`${what} ${file} changed while it was being opened`);
    if (fst.size > max) throw new Error(`${what} ${file} is ${fst.size} bytes (limit ${max})`);
    const buf = Buffer.alloc(fst.size + 1);
    let n = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
      if (!bytesRead) break;
      n += bytesRead;
      // still growing past what stat reported: refuse rather than chase it
      if (n > fst.size) throw new Error(`${what} ${file} grew while it was being read`);
    }
    return buf.subarray(0, n);
  } finally {
    await fh.close();
  }
}

function insideHiddenDir(file: string, home: string): boolean {
  const rel = path.relative(home, file);
  return !rel.startsWith("..") && !path.isAbsolute(rel) && rel.split(path.sep).some((part) => part.startsWith("."));
}

/**
 * A path the client names is read by this server, not through the client's own file permissions,
 * so it must not be a symlink and must not resolve into the dot-directories in $HOME where
 * credentials live (~/.ssh, ~/.aws). Returns the real path to read through.
 */
export async function vetClientPath(file: string, what: string): Promise<string> {
  const abs = path.resolve(file);
  const st = await lstat(abs);
  if (st.isSymbolicLink()) throw new Error(`${what} ${abs} is a symbolic link; pass the path it points to`);
  const real = await realpath(abs);
  const home = homedir();
  const realHome = await realpath(home).catch(() => home);
  if ([abs, real].some((p) => insideHiddenDir(p, home) || insideHiddenDir(p, realHome))) {
    throw new Error(`${what} ${abs} is inside a hidden directory in your home folder; it is not read from there`);
  }
  return real;
}

import { execFile } from "node:child_process";
import { constants as fsc, createReadStream, createWriteStream, open as openCb } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, rm, stat, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { createInflateRaw } from "node:zlib";
import { ResidueSpec as ResidueSpecSchema, type ResidueSpec } from "../ledger/schema.js";
import { vetClientPath } from "./fsread.js";
import { matchNeedle, needlesOf, type Needle, type NeedleKind } from "./surface.js";

const execFileP = promisify(execFile);
const openFd = promisify(openCb);

const MAX_SCAN_BYTES = 200 * 1024 * 1024;
const MAX_UNCOMPRESSED = 2 * 1024 * 1024 * 1024;
const MAX_MATCHES = 500;
/** Hermes bytecode file magic 0x1F1903C103BC1FC6, stored little-endian. */
const HERMES_MAGIC = Buffer.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f]);
const CDN = /https?:\/\/[^\s"'<>]*?(cloudfront\.net|cloudinary\.com|imgix\.net|firebasestorage\.googleapis\.com|storage\.googleapis\.com|amazonaws\.com|r2\.dev|r2\.cloudflarestorage\.com|supabase\.co\/storage|cdn\.[\w.-]+|bunnycdn|b-cdn\.net)/gi;

export interface BuiltHit {
  kind: NeedleKind;
  needle: string;
  /** path inside the .app bundle */
  file: string;
  evidence: string;
}

export interface BuiltSweep {
  path: string;
  kind: "app" | "xcarchive" | "ipa";
  hermes: boolean;
  /** number of (needle, file) matches */
  hits: number;
  matches: BuiltHit[];
  notes: string[];
  /** a Mach-O in the bundle has LC_ENCRYPTION_INFO cryptid=1 (App Store download) */
  encrypted: boolean;
  /** false when the byte cap stopped the sweep or nothing could be scanned */
  complete: boolean;
  scannedBytes: number;
}

// ---------------------------------------------------------------------------
// zip safety
// ---------------------------------------------------------------------------

/** Entries that would write outside the extraction directory. */
export function unsafeZipEntries(entries: string[], symlinks: string[] = []): string[] {
  const bad: string[] = [];
  const links = symlinks.map((s) => s.replace(/\/+$/, ""));
  for (const e of entries) {
    const segs = e.split(/[\\/]+/);
    if (
      e.includes("\0") ||
      e.startsWith("/") ||
      e.startsWith("\\") ||
      /^[A-Za-z]:/.test(e) ||
      segs.includes("..") ||
      links.some((l) => e.startsWith(`${l}/`))
    ) {
      bad.push(e);
    }
  }
  return bad;
}

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  /** what the central directory claims; the archive controls it, so extraction counts real bytes */
  size: number;
  localOffset: number;
  /** unix mode when the archive was made on unix, else 0 */
  mode: number;
}

const MAX_ENTRIES = 200_000;
const MAX_CENTRAL_DIR = 256 * 1024 * 1024;

async function readAt(fh: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, offset);
  if (bytesRead !== length) throw new Error("refusing to extract: the archive is truncated");
  return buf;
}

/** Central directory entries, read directly so sizes and modes come from the archive itself. */
async function readCentralDirectory(fh: FileHandle, fileSize: number): Promise<ZipEntry[]> {
  const tailLen = Math.min(fileSize, 22 + 0xffff);
  const tail = await readAt(fh, fileSize - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("refusing to extract: not a zip archive (no end of central directory)");
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locAt = fileSize - tailLen + eocd - 20;
    if (locAt < 0) throw new Error("refusing to extract: zip64 locator missing");
    const loc = await readAt(fh, locAt, 20);
    if (loc.readUInt32LE(0) !== 0x07064b50) throw new Error("refusing to extract: zip64 locator missing");
    const z = await readAt(fh, Number(loc.readBigUInt64LE(8)), 56);
    if (z.readUInt32LE(0) !== 0x06064b50) throw new Error("refusing to extract: zip64 end of central directory missing");
    count = Number(z.readBigUInt64LE(32));
    cdSize = Number(z.readBigUInt64LE(40));
    cdOffset = Number(z.readBigUInt64LE(48));
  }
  if (count > MAX_ENTRIES) throw new Error(`refusing to extract: ${count} entries exceeds the ${MAX_ENTRIES} limit`);
  if (cdSize > MAX_CENTRAL_DIR || cdOffset + cdSize > fileSize) throw new Error("refusing to extract: the central directory is out of bounds");
  const cd = await readAt(fh, cdOffset, cdSize);
  const out: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new Error("refusing to extract: malformed central directory");
    const madeBy = cd.readUInt16LE(p + 4) >> 8;
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    if (p + 46 + nameLen + extraLen + commentLen > cd.length) throw new Error("refusing to extract: malformed central directory");
    const e: ZipEntry = {
      name: cd.toString("utf8", p + 46, p + 46 + nameLen),
      flags: cd.readUInt16LE(p + 8),
      method: cd.readUInt16LE(p + 10),
      compressedSize: cd.readUInt32LE(p + 20),
      size: cd.readUInt32LE(p + 24),
      localOffset: cd.readUInt32LE(p + 42),
      mode: madeBy === 3 ? cd.readUInt32LE(p + 38) >>> 16 : 0,
    };
    // zip64 extra field: 64-bit values for whichever 32-bit fields are saturated, in this order
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = cd.readUInt16LE(x);
      const len = cd.readUInt16LE(x + 2);
      if (id === 0x0001) {
        let q = x + 4;
        const next = () => {
          if (q + 8 > x + 4 + len) throw new Error("refusing to extract: malformed zip64 field");
          const v = Number(cd.readBigUInt64LE(q));
          q += 8;
          return v;
        };
        if (e.size === 0xffffffff) e.size = next();
        if (e.compressedSize === 0xffffffff) e.compressedSize = next();
        if (e.localOffset === 0xffffffff) e.localOffset = next();
      }
      x += 4 + len;
    }
    out.push(e);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * Extracts in-process, counting the bytes inflation really produces. The central directory's sizes
 * are written by whoever made the archive, so a small .ipa can claim 1 KB and inflate to gigabytes;
 * an entry that inflates past its stated size, or a total past the cap, stops extraction.
 */
async function extractIpa(ipa: string, maxTotal = MAX_UNCOMPRESSED): Promise<string> {
  const fh = await open(ipa, "r");
  let dest: string | undefined;
  try {
    const fileSize = (await fh.stat()).size;
    const entries = await readCentralDirectory(fh, fileSize);
    const isLink = (e: ZipEntry) => (e.mode & 0o170000) === 0o120000;
    const bad = unsafeZipEntries(
      entries.map((e) => e.name),
      entries.filter(isLink).map((e) => e.name),
    );
    if (bad.length) throw new Error(`refusing to extract: unsafe zip entries (${bad.slice(0, 3).join(", ")})`);
    const claimed = entries.reduce((n, e) => n + e.size, 0);
    if (claimed > maxTotal) throw new Error(`refusing to extract: ${claimed} bytes uncompressed exceeds the ${maxTotal} byte limit`);
    for (const e of entries) {
      if (e.flags & 1) throw new Error(`refusing to extract: ${e.name} is encrypted`);
      if (e.method !== 0 && e.method !== 8) throw new Error(`refusing to extract: ${e.name} uses unsupported compression method ${e.method}`);
    }
    dest = await mkdtemp(path.join(tmpdir(), "appstore-shield-ipa-"));
    const root = dest;
    let total = 0;
    for (const e of entries) {
      // Symlinks are not recreated: the sweep never follows them, and one could point outside the bundle.
      if (isLink(e)) continue;
      const target = path.resolve(root, e.name);
      if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`refusing to extract: unsafe zip entry (${e.name})`);
      if (e.name.endsWith("/")) {
        await mkdir(target, { recursive: true });
        continue;
      }
      await mkdir(path.dirname(target), { recursive: true });
      const lh = await readAt(fh, e.localOffset, 30);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error(`refusing to extract: bad local header for ${e.name}`);
      const dataStart = e.localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      if (dataStart + e.compressedSize > fileSize) throw new Error(`refusing to extract: ${e.name} runs past the end of the archive`);
      let written = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          written += chunk.length;
          total += chunk.length;
          if (written > e.size) return cb(new Error(`refusing to extract: ${e.name} inflates past the ${e.size} bytes its header states (zip bomb)`));
          if (total > maxTotal) return cb(new Error(`refusing to extract: more than ${maxTotal} bytes uncompressed`));
          cb(null, chunk);
        },
      });
      // O_EXCL | O_NOFOLLOW: never write through something already at that path
      const fd = await openFd(target, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o644);
      const sink = createWriteStream("", { fd });
      if (!e.compressedSize) await pipeline(Readable.from([]), counter, sink);
      else {
        const input = createReadStream(ipa, { start: dataStart, end: dataStart + e.compressedSize - 1 });
        if (e.method === 8) await pipeline(input, createInflateRaw(), counter, sink);
        else await pipeline(input, counter, sink);
      }
    }
    return root;
  } catch (err) {
    if (dest) await rm(dest, { recursive: true, force: true });
    const msg = (err as Error).message;
    throw new Error(msg.startsWith("refusing to extract") ? msg : `extraction failed: ${msg}`);
  } finally {
    await fh.close();
  }
}

async function findApp(dir: string): Promise<string | undefined> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const app = entries.find((e) => e.isDirectory() && e.name.endsWith(".app"));
  return app ? path.join(dir, app.name) : undefined;
}

// ---------------------------------------------------------------------------
// Mach-O
// ---------------------------------------------------------------------------

const LC_ENCRYPTION_INFO = 0x21;
const LC_ENCRYPTION_INFO_64 = 0x2c;

/** cryptid of the first LC_ENCRYPTION_INFO(_64) command; 0 when there is none, undefined when not Mach-O. */
export function machoCryptId(buf: Buffer): number | undefined {
  if (buf.length < 32) return undefined;
  const be = buf.readUInt32BE(0);
  if (be === 0xcafebabe || be === 0xcafebabf) {
    const nfat = buf.readUInt32BE(4);
    const wide = be === 0xcafebabf;
    for (let i = 0; i < Math.min(nfat, 8); i++) {
      const base = 8 + i * (wide ? 32 : 20);
      if (base + 16 > buf.length) return undefined;
      const off = wide ? Number(buf.readBigUInt64BE(base + 8)) : buf.readUInt32BE(base + 8);
      if (off >= buf.length) continue;
      const id = machoCryptId(buf.subarray(off));
      if (id !== undefined) return id;
    }
    return undefined;
  }
  const le = buf.readUInt32LE(0);
  if (le !== 0xfeedfacf && le !== 0xfeedface) return undefined;
  const ncmds = buf.readUInt32LE(16);
  let off = le === 0xfeedfacf ? 32 : 28;
  for (let i = 0; i < ncmds && off + 8 <= buf.length; i++) {
    const cmd = buf.readUInt32LE(off);
    const size = buf.readUInt32LE(off + 4);
    if (cmd === LC_ENCRYPTION_INFO || cmd === LC_ENCRYPTION_INFO_64) {
      return off + 20 <= buf.length ? buf.readUInt32LE(off + 16) : undefined;
    }
    if (size < 8) break;
    off += size;
  }
  return 0;
}

function isMachO(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  const le = buf.readUInt32LE(0);
  const be = buf.readUInt32BE(0);
  return le === 0xfeedfacf || le === 0xfeedface || be === 0xcafebabe || be === 0xcafebabf;
}

// ---------------------------------------------------------------------------
// strings
// ---------------------------------------------------------------------------

/** Printable ASCII runs of at least `min` bytes, one per line (what `strings` would print). */
export function printableRuns(buf: Buffer, min = 4): string {
  const out: string[] = [];
  let start = -1;
  for (let i = 0; i <= buf.length; i++) {
    const b = i < buf.length ? buf[i]! : 0;
    const printable = (b >= 0x20 && b < 0x7f) || b === 0x09;
    if (printable) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if (i - start >= min) out.push(buf.toString("latin1", start, i));
      start = -1;
    }
  }
  return out.join("\n");
}

function looksText(buf: Buffer): boolean {
  const head = buf.subarray(0, 4096);
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return true;
  return !head.includes(0);
}

function decodeText(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  return buf.toString("utf8");
}

async function assetCatalogNames(file: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileP("xcrun", ["assetutil", "--info", file], { maxBuffer: 128 * 1024 * 1024, timeout: 60_000 });
    const json = JSON.parse(stdout) as Record<string, unknown>[];
    return json
      .flatMap((e) => [e["Name"], e["RenditionName"], e["AssetType"] === "Image" ? e["Name"] : undefined])
      .filter((v): v is string => typeof v === "string")
      .join("\n");
  } catch {
    return undefined;
  }
}

async function walkFiles(dir: string, base: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    // Never follow symlinks: an extracted archive could point them anywhere.
    const st = await lstat(abs).catch(() => undefined);
    if (!st || st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      out.push(`${path.relative(base, abs).split(path.sep).join("/")}/`);
      await walkFiles(abs, base, out);
    } else if (st.isFile()) out.push(path.relative(base, abs).split(path.sep).join("/"));
  }
}

async function readCapped(abs: string, max: number): Promise<Buffer> {
  const fh = await open(abs, "r");
  try {
    const size = (await fh.stat()).size;
    const len = Math.min(size, max);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    return buf;
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------------------
// sweep
// ---------------------------------------------------------------------------

export async function sweepBuiltProduct(productPath: string, specIn: ResidueSpec, opts: { maxBytes?: number } = {}): Promise<BuiltSweep> {
  const spec = ResidueSpecSchema.parse(specIn);
  if (!(await lstat(path.resolve(productPath)).catch(() => undefined))) throw new Error(`built product not found: ${productPath}`);
  const abs = await vetClientPath(productPath, "build_path");
  const st = await stat(abs);
  const notes: string[] = [];
  let kind: BuiltSweep["kind"];
  let appDir: string | undefined;
  let cleanup: string | undefined;

  if (st.isFile() && /\.ipa$/i.test(abs)) {
    kind = "ipa";
    cleanup = await extractIpa(abs);
    appDir = await findApp(path.join(cleanup, "Payload"));
  } else if (st.isDirectory() && /\.xcarchive$/i.test(abs)) {
    kind = "xcarchive";
    appDir = await findApp(path.join(abs, "Products", "Applications"));
  } else if (st.isDirectory() && /\.app$/i.test(abs)) {
    kind = "app";
    appDir = abs;
  } else {
    throw new Error("unsupported built product: pass a .app directory, an .xcarchive directory or an .ipa file");
  }

  try {
    if (!appDir) {
      notes.push("No .app bundle was found inside the product.");
      return { path: productPath, kind, hermes: false, hits: 0, matches: [], notes, encrypted: false, complete: false, scannedBytes: 0 };
    }
    // Compiled symbols are mangled (`14LingeriePickerV`), so identifier boundaries do not apply.
    const needles = needlesOf(spec).map((n) => (n.kind === "symbol" ? { ...n, accept: undefined } : n));
    const result = await sweepApp(appDir, needles, opts.maxBytes ?? MAX_SCAN_BYTES, notes);
    return { path: productPath, kind, ...result, notes };
  } finally {
    if (cleanup) await rm(cleanup, { recursive: true, force: true });
  }
}

async function sweepApp(appDir: string, needles: Needle[], maxBytes: number, notes: string[]) {
  const rels: string[] = [];
  await walkFiles(appDir, appDir, rels);
  const matches: BuiltHit[] = [];
  const seen = new Set<string>();
  let hermes = false;
  let encrypted = false;
  let sawMachO = false;
  let scanned = 0;
  let complete = true;
  let assetutilMissing = false;
  const cdnHosts = new Set<string>();
  let odr = rels.some((r) => /(^|\/)(OnDemandResources|AssetPackManifest[^/]*\.plist)/.test(r));

  const record = (n: Needle, file: string, text: string) => {
    const key = `${n.kind}|${n.value}|${file}`;
    if (seen.has(key) || matches.length >= MAX_MATCHES) return;
    const m = matchNeedle(n, text, 1)[0];
    if (!m) return;
    seen.add(key);
    const s = text.lastIndexOf("\n", m.index - 1) + 1;
    const e = text.indexOf("\n", m.index);
    matches.push({ kind: n.kind, needle: n.value, file, evidence: text.slice(s, e === -1 ? undefined : e).slice(0, 160) });
  };

  for (const rel of rels) {
    const name = rel.replace(/\/$/, "").split("/").pop() ?? rel;
    for (const n of needles) if (n.kind === "term" || n.kind === "asset" || n.kind === "symbol") record(n, rel, name);
    if (rel.endsWith("/")) continue;
    if (scanned >= maxBytes) {
      complete = false;
      continue;
    }
    const absFile = path.join(appDir, rel);
    const buf = await readCapped(absFile, maxBytes - scanned).catch(() => undefined);
    if (!buf) continue;
    scanned += buf.length;
    const size = (await stat(absFile).catch(() => undefined))?.size ?? buf.length;
    if (size > buf.length) complete = false;

    let text: string;
    if (buf.subarray(0, 8).equals(HERMES_MAGIC)) {
      hermes = true;
      text = printableRuns(buf);
    } else if (isMachO(buf)) {
      sawMachO = true;
      if (machoCryptId(buf) === 1) encrypted = true;
      text = printableRuns(buf);
    } else if (looksText(buf)) {
      text = decodeText(buf);
    } else {
      text = printableRuns(buf);
    }
    if (name === "Assets.car") {
      const names = await assetCatalogNames(absFile);
      if (names !== undefined) text += `\n${names}`;
      else assetutilMissing = true;
    }
    if (/NSBundleResourceRequest/.test(text)) odr = true;
    for (const m of text.matchAll(CDN)) {
      const host = /https?:\/\/([^/\s"'<>]+)/.exec(m[0])?.[1];
      if (host && cdnHosts.size < 10) cdnHosts.add(host);
    }
    for (const n of needles) record(n, rel, text);
  }

  if (hermes) notes.push("The JS bundle is Hermes bytecode: string literals were scanned, but identifiers and code structure were not.");
  if (encrypted) {
    notes.push("The executable is FairPlay-encrypted (LC_ENCRYPTION_INFO cryptid=1, an App Store download), so its strings cannot be read. Sweep the .xcarchive or the exported .ipa instead.");
  } else if (!sawMachO) {
    notes.push("No Mach-O executable was found in the bundle, so compiled code was not checked.");
  }
  if (assetutilMissing) notes.push("xcrun assetutil was unavailable, so Assets.car names were scanned only as raw strings.");
  if (odr) notes.push("The app uses on-demand resources; asset packs hosted by Apple are not in this bundle and could not be checked.");
  if (cdnHosts.size) notes.push(`Remote assets are loaded from ${[...cdnHosts].join(", ")}; their contents cannot be checked from the bundle and need a developer attestation.`);
  if (!complete) notes.push(`The sweep stopped at the ${Math.round(maxBytes / 1024 / 1024)} MB scan limit; files after that were not checked.`);
  if (!rels.length) complete = false;

  return { hermes, hits: matches.length, matches, encrypted, complete, scannedBytes: scanned };
}

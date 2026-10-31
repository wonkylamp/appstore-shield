import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ResidueSpec } from "../../src/ledger/schema.js";
import { machoCryptId, printableRuns, sweepBuiltProduct, unsafeZipEntries } from "../../src/remediation/built.js";

const SPEC = ResidueSpec.parse({
  feature: "lingerie",
  capability: "A user can no longer generate lingerie images.",
  terms: ["lingerie"],
  symbols: ["LingeriePicker"],
  assets: ["outfit_lingerie_*"],
});

// --- minimal fixtures ------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Stored (uncompressed) zip, with unix modes so symlink entries are representable. */
function makeZip(entries: { name: string; data?: string | Buffer; mode?: number; deflate?: boolean; claimSize?: number }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? "");
    const crc = crc32(raw);
    const data = e.deflate ? deflateRawSync(raw) : raw;
    const size = e.claimSize ?? raw.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(e.deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(name.length, 26);
    const local = Buffer.concat([lh, name, data]);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE((3 << 8) | 20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(e.deflate ? 8 : 0, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(((e.mode ?? (e.name.endsWith("/") ? 0o40755 : 0o100644)) << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, name]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** Thin 64-bit Mach-O header with one LC_ENCRYPTION_INFO_64, followed by a string table. */
function makeMachO(cryptid: number, strings: string[]): Buffer {
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(0x0100000c, 4);
  header.writeUInt32LE(2, 12);
  header.writeUInt32LE(1, 16);
  header.writeUInt32LE(24, 20);
  const lc = Buffer.alloc(24);
  lc.writeUInt32LE(0x2c, 0);
  lc.writeUInt32LE(24, 4);
  lc.writeUInt32LE(0x4000, 8);
  lc.writeUInt32LE(0x1000, 12);
  lc.writeUInt32LE(cryptid, 16);
  const tail = Buffer.concat(strings.map((s) => Buffer.concat([Buffer.from(s), Buffer.from([0, 1, 2])])));
  return Buffer.concat([header, lc, Buffer.alloc(16), tail]);
}

const HERMES = Buffer.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f]);

async function makeApp(dir: string, files: Record<string, string | Buffer>): Promise<string> {
  for (const [rel, data] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, data);
  }
  return dir;
}

const tmp = () => mkdtemp(path.join(tmpdir(), "shield-built-"));

// --- tests -----------------------------------------------------------------

describe("unsafeZipEntries", () => {
  it("rejects absolute paths, parent traversal and entries under symlinks", () => {
    expect(unsafeZipEntries(["/etc/passwd", "Payload/../../x", "..\\win", "C:/x", "Payload/link/evil"], ["Payload/link"])).toEqual([
      "/etc/passwd",
      "Payload/../../x",
      "..\\win",
      "C:/x",
      "Payload/link/evil",
    ]);
  });
  it("accepts ordinary bundle paths", () => {
    expect(unsafeZipEntries(["Payload/", "Payload/Demo.app/Info.plist", "Payload/Demo.app/a..b.png"])).toEqual([]);
  });
});

describe("Mach-O and strings helpers", () => {
  it("reads cryptid from LC_ENCRYPTION_INFO_64", () => {
    expect(machoCryptId(makeMachO(1, []))).toBe(1);
    expect(machoCryptId(makeMachO(0, []))).toBe(0);
    expect(machoCryptId(Buffer.from("not a mach-o file at all, just text"))).toBeUndefined();
  });
  it("extracts printable runs of at least four bytes", () => {
    expect(printableRuns(Buffer.from([0, 0x61, 0x62, 0, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 1]))).toBe("hello");
  });
});

describe("sweepBuiltProduct", () => {
  it("finds residue in the binary, strings, file names and a Hermes bundle", async () => {
    const app = await makeApp(path.join(await tmp(), "Demo.app"), {
      Demo: makeMachO(0, ["_$s4Demo14LingeriePickerV4bodyQrvg", "hello"]),
      "en.lproj/Localizable.strings": `"outfit.3" = "Lingerie";`,
      "main.jsbundle": Buffer.concat([HERMES, Buffer.alloc(8), Buffer.from("lingerie_lace\0")]),
      "outfit_lingerie_01.png": "png",
    });
    const r = await sweepBuiltProduct(app, SPEC);
    expect(r.kind).toBe("app");
    expect(r.hermes).toBe(true);
    expect(r.encrypted).toBe(false);
    expect(r.complete).toBe(true);
    const files = r.matches.map((m) => `${m.needle}@${m.file}`);
    expect(files).toContain("LingeriePicker@Demo");
    expect(files).toContain("lingerie@en.lproj/Localizable.strings");
    expect(files).toContain("lingerie@main.jsbundle");
    expect(files).toContain("outfit_lingerie_*@outfit_lingerie_01.png");
    expect(r.notes.join(" ")).toMatch(/Hermes bytecode/);
  });

  it("reports a clean bundle with no hits", async () => {
    const app = await makeApp(path.join(await tmp(), "Demo.app"), {
      Demo: makeMachO(0, ["_$s4Demo8ChatViewV4bodyQrvg"]),
      "Info.plist": "<plist><dict><key>CFBundleName</key><string>Demo</string></dict></plist>",
      "main.jsbundle": "var a = 'hello';",
    });
    const r = await sweepBuiltProduct(app, SPEC);
    expect(r.hits).toBe(0);
    expect(r.hermes).toBe(false);
  });

  it("notes FairPlay encryption, on-demand resources and CDN assets as unverifiable", async () => {
    const app = await makeApp(path.join(await tmp(), "Demo.app"), {
      Demo: makeMachO(1, ["NSBundleResourceRequest", "https://d123.cloudfront.net/outfits/"]),
    });
    const r = await sweepBuiltProduct(app, SPEC);
    expect(r.encrypted).toBe(true);
    const notes = r.notes.join(" ");
    expect(notes).toMatch(/FairPlay-encrypted/);
    expect(notes).toMatch(/on-demand resources/);
    expect(notes).toMatch(/d123\.cloudfront\.net/);
  });

  it("does not follow symlinks out of the bundle", async () => {
    const outside = await makeApp(await tmp(), { "secret.txt": "lingerie" });
    const app = await makeApp(path.join(await tmp(), "Demo.app"), { "Info.plist": "<plist/>" });
    await symlink(path.join(outside, "secret.txt"), path.join(app, "link.txt"));
    const r = await sweepBuiltProduct(app, SPEC);
    expect(r.hits).toBe(0);
  });

  it("refuses a build_path that is a symlink or sits in a hidden home directory", async () => {
    const outside = await makeApp(path.join(await tmp(), "secrets"), { "id_rsa": "lingerie key material" });
    const link = path.join(await tmp(), "x.app");
    await symlink(outside, link);
    await expect(sweepBuiltProduct(link, SPEC)).rejects.toThrow(/build_path .* is a symbolic link/);
    const home = await tmp();
    const app = await makeApp(path.join(home, ".ssh", "Demo.app"), { "outfits.json": `["lingerie"]` });
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      await expect(sweepBuiltProduct(app, SPEC)).rejects.toThrow(/hidden directory in your home folder/);
    } finally {
      process.env.HOME = prev;
    }
  });

  it("opens the .app inside an .xcarchive", async () => {
    const archive = path.join(await tmp(), "Demo.xcarchive");
    await makeApp(path.join(archive, "Products/Applications/Demo.app"), { "outfits.json": `["lingerie"]` });
    const r = await sweepBuiltProduct(archive, SPEC);
    expect(r.kind).toBe("xcarchive");
    expect(r.hits).toBe(1);
  });

  it("extracts a safe .ipa into a temp dir and sweeps it", async () => {
    const ipa = path.join(await tmp(), "Demo.ipa");
    await writeFile(
      ipa,
      makeZip([
        { name: "Payload/" },
        { name: "Payload/Demo.app/" },
        { name: "Payload/Demo.app/outfits.json", data: `["lingerie_lace"]` },
      ]),
    );
    const r = await sweepBuiltProduct(ipa, SPEC);
    expect(r.kind).toBe("ipa");
    expect(r.matches.map((m) => m.file)).toContain("outfits.json");
  });

  it("refuses an .ipa with a traversal entry before extracting anything", async () => {
    const dir = await tmp();
    const ipa = path.join(dir, "Evil.ipa");
    await writeFile(ipa, makeZip([{ name: "Payload/Demo.app/ok.txt", data: "ok" }, { name: "../evil.txt", data: "pwned" }]));
    await expect(sweepBuiltProduct(ipa, SPEC)).rejects.toThrow(/unsafe zip entries \(\.\.\/evil\.txt\)/);
    expect(await readdir(dir)).toEqual(["Evil.ipa"]);
  });

  it("refuses an .ipa that writes through a symlink entry", async () => {
    const ipa = path.join(await tmp(), "Link.ipa");
    await writeFile(
      ipa,
      makeZip([
        { name: "Payload/link", data: "/tmp", mode: 0o120777 },
        { name: "Payload/link/evil.txt", data: "pwned" },
      ]),
    );
    await expect(sweepBuiltProduct(ipa, SPEC)).rejects.toThrow(/unsafe zip entries/);
  });

  it("rejects unsupported paths", async () => {
    const dir = await makeApp(await tmp(), { "x.txt": "x" });
    await expect(sweepBuiltProduct(path.join(dir, "x.txt"), SPEC)).rejects.toThrow(/unsupported built product/);
  });
});

describe("sweepBuiltProduct .ipa extraction counts real bytes", () => {
  it("refuses an entry that inflates past the size its central directory claims, leaving nothing behind", async () => {
    const dir = await tmp();
    const ipa = path.join(dir, "Bomb.ipa");
    // 8 MB of zeros deflates to a few KB; the header claims 1000 bytes, as in the reviewer's bomb
    await writeFile(ipa, makeZip([{ name: "Payload/Demo.app/big.bin", data: Buffer.alloc(8 * 1024 * 1024), deflate: true, claimSize: 1000 }]));
    const before = new Set(await readdir(tmpdir()));
    await expect(sweepBuiltProduct(ipa, SPEC)).rejects.toThrow(/big\.bin inflates past the 1000 bytes its header states/);
    const left = (await readdir(tmpdir())).filter((n) => n.startsWith("appstore-shield-ipa-") && !before.has(n));
    expect(left).toEqual([]);
  });

  it("extracts deflated entries and does not recreate symlink entries", async () => {
    const ipa = path.join(await tmp(), "Deflated.ipa");
    await writeFile(
      ipa,
      makeZip([
        { name: "Payload/Demo.app/outfits.json", data: `["lingerie_lace"]`.repeat(50), deflate: true },
        { name: "Payload/Demo.app/link", data: "/etc/passwd", mode: 0o120777 },
      ]),
    );
    const r = await sweepBuiltProduct(ipa, SPEC);
    expect(r.matches.map((m) => m.file)).toContain("outfits.json");
    expect(r.matches.map((m) => m.file)).not.toContain("link");
  });

  it.runIf(process.platform === "darwin")("reads an archive written by ditto", async () => {
    const dir = await tmp();
    await makeApp(path.join(dir, "src/Payload/Demo.app"), { "outfits.json": `["lingerie_lace"]`, "Info.plist": "<plist/>" });
    const ipa = path.join(dir, "Real.ipa");
    await promisify(execFile)("ditto", ["-c", "-k", "--keepParent", path.join(dir, "src/Payload"), ipa]);
    const r = await sweepBuiltProduct(ipa, SPEC);
    expect(r.matches.map((m) => m.file)).toContain("outfits.json");
  });
});

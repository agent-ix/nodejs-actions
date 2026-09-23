import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Create a fresh temp directory under the OS tmpdir, returning its path. */
export function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Write a minimal-but-valid binary header matching `format` (see pack.mjs TARGETS). */
export function writeFakeBinary(filePath, format) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const buffer = Buffer.alloc(128);
  switch (format.type) {
    case "elf":
      buffer[0] = 0x7f;
      buffer[1] = 0x45; // E
      buffer[2] = 0x4c; // L
      buffer[3] = 0x46; // F
      buffer[4] = 0x02; // 64-bit
      buffer[5] = 0x01; // little-endian
      buffer.writeUInt16LE(format.machine, 18);
      break;
    case "macho":
      buffer[0] = 0xcf;
      buffer[1] = 0xfa;
      buffer[2] = 0xed;
      buffer[3] = 0xfe;
      buffer.writeUInt32LE(format.cputype, 4);
      break;
    case "pe": {
      buffer[0] = 0x4d; // M
      buffer[1] = 0x5a; // Z
      const peOffset = 0x40;
      buffer.writeUInt32LE(peOffset, 0x3c);
      buffer[peOffset] = 0x50; // P
      buffer[peOffset + 1] = 0x45; // E
      buffer[peOffset + 2] = 0x00;
      buffer[peOffset + 3] = 0x00;
      buffer.writeUInt16LE(format.machine, peOffset + 4);
      break;
    }
    default:
      throw new Error(`unknown format type ${format.type}`);
  }
  fs.writeFileSync(filePath, buffer);
}

/** Write a small LICENSE file, returning its path. */
export function writeLicense(dir, text = "AGPL-3.0-or-later license text\n") {
  const filePath = path.join(dir, "LICENSE");
  fs.writeFileSync(filePath, text);
  return filePath;
}

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

/**
 * Install a fake `npm` executable on PATH for the duration of a test. It
 * records every invocation's cwd + argv (one JSON line per call) to a record
 * file, and answers `npm view ... version ...` from an in-memory fixture
 * keyed by `<name>@<version>`. Each fixture value is either a single
 * response or an array of responses consumed in call order (the last one
 * repeats once exhausted). A response is `{ version }` (npm view succeeds),
 * `{ notFound: true }` (npm view fails the way it does for an unpublished
 * spec), or `{ error: "..." }` (npm view fails with some other message, e.g.
 * a network/5xx/auth error). `npm publish` always exits 0 unless
 * `publishExit` is set.
 *
 * Returns `{ dir, recordFile, setFixture, readRecord, restore }`. Call
 * `restore()` (even on failure) to remove the temp dir and put PATH back.
 */
export function installFakeNpm({ publishExit = 0 } = {}) {
  const dir = makeTempDir("publish-native-npm-fake-npm-");
  const recordFile = path.join(dir, "record.jsonl");
  const fixtureFile = path.join(dir, "fixture.json");
  fs.writeFileSync(recordFile, "");
  fs.writeFileSync(fixtureFile, JSON.stringify({}));

  const scriptPath = path.join(dir, "npm");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env node",
      "const fs = require('fs');",
      `const RECORD = ${JSON.stringify(recordFile)};`,
      `const FIXTURE = ${JSON.stringify(fixtureFile)};`,
      `const PUBLISH_EXIT = ${JSON.stringify(publishExit)};`,
      "const argv = process.argv.slice(2);",
      "fs.appendFileSync(RECORD, JSON.stringify({ cwd: process.cwd(), argv }) + '\\n');",
      "if (argv[0] === 'view') {",
      "  const spec = argv[1];",
      "  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));",
      "  let entry = fixture[spec];",
      "  if (Array.isArray(entry)) {",
      "    const stateKey = spec + '::calls';",
      "    const n = fixture[stateKey] || 0;",
      "    entry = entry[Math.min(n, entry.length - 1)];",
      "    fixture[stateKey] = n + 1;",
      "    fs.writeFileSync(FIXTURE, JSON.stringify(fixture));",
      "  }",
      "  if (!entry || entry.notFound) {",
      "    process.stderr.write('npm error code E404\\n');",
      "    process.stderr.write('npm error 404 Not Found - GET ' + spec + ' - Not found\\n');",
      "    process.exit(1);",
      "  }",
      "  if (entry.error) {",
      "    process.stderr.write(entry.error + '\\n');",
      "    process.exit(1);",
      "  }",
      "  process.stdout.write(entry.version + '\\n');",
      "  process.exit(0);",
      "}",
      "if (argv[0] === 'publish') {",
      "  process.exit(PUBLISH_EXIT);",
      "}",
      "process.exit(0);",
      "",
    ].join("\n")
  );
  fs.chmodSync(scriptPath, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${originalPath}`;

  return {
    dir,
    recordFile,
    setFixture(fixture) {
      fs.writeFileSync(fixtureFile, JSON.stringify(fixture));
    },
    readRecord() {
      const raw = fs.readFileSync(recordFile, "utf8");
      return raw
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
    },
    restore() {
      process.env.PATH = originalPath;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { discoverArtifacts } from "../pack.mjs";
import { makeTempDir, writeFakeBinary } from "./helpers.mjs";

// These constants are written literally here, never read off pack.mjs's own
// TARGETS table. If TARGETS ever carried the wrong magic number for a
// triple, a test that derived its expectation from TARGETS itself would not
// catch it — these are independent of that table by construction.
const ELF_MACHINE_X86_64 = 62;
const ELF_MACHINE_AARCH64 = 183;
const MACHO_CPUTYPE_X86_64 = 0x01000007;
const MACHO_CPUTYPE_ARM64 = 0x0100000c;
const PE_MACHINE_X64 = 0x8664;

function acceptedAndRefused({ rust, binName, rightFormat, wrongFormat, refuseMessage }) {
  const okDir = makeTempDir("header-literal-ok-");
  writeFakeBinary(path.join(okDir, rust, binName), rightFormat);
  const artifacts = discoverArtifacts(okDir, binName.replace(/\.exe$/, ""));
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].target.rust, rust);
  fs.rmSync(okDir, { recursive: true, force: true });

  const wrongDir = makeTempDir("header-literal-wrong-");
  writeFakeBinary(path.join(wrongDir, rust, binName), wrongFormat);
  assert.throws(() => discoverArtifacts(wrongDir, binName.replace(/\.exe$/, "")), refuseMessage);
  fs.rmSync(wrongDir, { recursive: true, force: true });
}

test("ELF: x86_64-unknown-linux-gnu accepts e_machine 62, refuses 183", () => {
  acceptedAndRefused({
    rust: "x86_64-unknown-linux-gnu",
    binName: "quoin",
    rightFormat: { type: "elf", machine: ELF_MACHINE_X86_64 },
    wrongFormat: { type: "elf", machine: ELF_MACHINE_AARCH64 },
    refuseMessage: /does not match the expected header/,
  });
});

test("ELF: aarch64-unknown-linux-gnu accepts e_machine 183, refuses 62", () => {
  acceptedAndRefused({
    rust: "aarch64-unknown-linux-gnu",
    binName: "quoin",
    rightFormat: { type: "elf", machine: ELF_MACHINE_AARCH64 },
    wrongFormat: { type: "elf", machine: ELF_MACHINE_X86_64 },
    refuseMessage: /does not match the expected header/,
  });
});

test("Mach-O: x86_64-apple-darwin accepts cputype 0x01000007, refuses 0x0100000c", () => {
  acceptedAndRefused({
    rust: "x86_64-apple-darwin",
    binName: "quoin",
    rightFormat: { type: "macho", cputype: MACHO_CPUTYPE_X86_64 },
    wrongFormat: { type: "macho", cputype: MACHO_CPUTYPE_ARM64 },
    refuseMessage: /does not match the expected header/,
  });
});

test("Mach-O: aarch64-apple-darwin accepts cputype 0x0100000c, refuses 0x01000007", () => {
  acceptedAndRefused({
    rust: "aarch64-apple-darwin",
    binName: "quoin",
    rightFormat: { type: "macho", cputype: MACHO_CPUTYPE_ARM64 },
    wrongFormat: { type: "macho", cputype: MACHO_CPUTYPE_X86_64 },
    refuseMessage: /does not match the expected header/,
  });
});

test("PE: x86_64-pc-windows-msvc accepts machine 0x8664", () => {
  const dir = makeTempDir("header-literal-pe-");
  writeFakeBinary(path.join(dir, "x86_64-pc-windows-msvc", "quoin.exe"), { type: "pe", machine: PE_MACHINE_X64 });
  const artifacts = discoverArtifacts(dir, "quoin");
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].target.rust, "x86_64-pc-windows-msvc");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("PE: x86_64-pc-windows-msvc refuses a non-PE machine value", () => {
  const dir = makeTempDir("header-literal-pe-wrong-");
  // A plausible-but-wrong machine id (0x01c4, ARM Thumb-2) in an otherwise
  // well-formed MZ/PE header.
  writeFakeBinary(path.join(dir, "x86_64-pc-windows-msvc", "quoin.exe"), { type: "pe", machine: 0x01c4 });
  assert.throws(() => discoverArtifacts(dir, "quoin"), /does not match the expected header/);
  fs.rmSync(dir, { recursive: true, force: true });
});

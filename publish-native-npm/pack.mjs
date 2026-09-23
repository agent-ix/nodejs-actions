#!/usr/bin/env node
"use strict";

// publish-native-npm/pack.mjs
//
// Generates a launcher npm package plus one per-platform binary package from
// a directory of prebuilt native binaries, and (optionally) publishes and
// verifies them on public npm. No npm dependencies — only node: builtins.
// Node >= 22.
//
// Usage:
//   node pack.mjs generate --package <pkg> --binary <bin> --version <x.y.z> \
//     --artifacts-dir <dir> --repository <owner/repo> --license <spdx> \
//     --license-file <path> --description <text> \
//     [--self-update-command <cmd>] --out-dir <dir> --publish <true|false>
//
//   node pack.mjs publish --package <pkg> --version <x.y.z> --out-dir <dir>

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY = "https://registry.npmjs.org/";

/** Thrown for expected, user-facing refusals (bad input, failed validation). */
export class PackError extends Error {}

// ---------------------------------------------------------------------------
// Target catalog: Rust triple -> npm os/cpu/libc + expected binary header.
// ---------------------------------------------------------------------------

export const TARGETS = [
  {
    rust: "x86_64-unknown-linux-gnu",
    os: "linux",
    cpu: "x64",
    libc: "glibc",
    format: { type: "elf", machine: 62 },
  },
  {
    rust: "aarch64-unknown-linux-gnu",
    os: "linux",
    cpu: "arm64",
    libc: "glibc",
    format: { type: "elf", machine: 183 },
  },
  {
    rust: "x86_64-unknown-linux-musl",
    os: "linux",
    cpu: "x64",
    libc: "musl",
    format: { type: "elf", machine: 62 },
  },
  {
    rust: "aarch64-unknown-linux-musl",
    os: "linux",
    cpu: "arm64",
    libc: "musl",
    format: { type: "elf", machine: 183 },
  },
  {
    rust: "aarch64-apple-darwin",
    os: "darwin",
    cpu: "arm64",
    libc: null,
    format: { type: "macho", cputype: 0x0100000c },
  },
  {
    rust: "x86_64-apple-darwin",
    os: "darwin",
    cpu: "x64",
    libc: null,
    format: { type: "macho", cputype: 0x01000007 },
  },
  {
    rust: "x86_64-pc-windows-msvc",
    os: "win32",
    cpu: "x64",
    libc: null,
    format: { type: "pe", machine: 0x8664 },
  },
];

const TARGETS_BY_RUST = new Map(TARGETS.map((target) => [target.rust, target]));

// ---------------------------------------------------------------------------
// Binary header validation.
// ---------------------------------------------------------------------------

function readU16LE(buffer, offset) {
  if (offset + 2 > buffer.length) return undefined;
  return buffer.readUInt16LE(offset);
}

function readU32LE(buffer, offset) {
  if (offset + 4 > buffer.length) return undefined;
  return buffer.readUInt32LE(offset);
}

/** Validate a binary's header bytes against a target's expected format. */
export function matchesBinaryFormat(buffer, format) {
  switch (format.type) {
    case "elf": {
      const wantMagic = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]); // \x7fELF, 64-bit, LE
      return buffer.length >= 20 && buffer.subarray(0, 6).equals(wantMagic) && readU16LE(buffer, 18) === format.machine;
    }
    case "macho": {
      const wantMagic = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]); // 64-bit LE Mach-O
      return buffer.length >= 8 && buffer.subarray(0, 4).equals(wantMagic) && readU32LE(buffer, 4) === format.cputype;
    }
    case "pe": {
      if (buffer.length < 0x40 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) return false; // "MZ"
      const peOffset = readU32LE(buffer, 0x3c);
      if (peOffset === undefined) return false;
      const wantPeMagic = Buffer.from([0x50, 0x45, 0x00, 0x00]); // "PE\0\0"
      return (
        buffer.length >= peOffset + 6 &&
        buffer.subarray(peOffset, peOffset + 4).equals(wantPeMagic) &&
        readU16LE(buffer, peOffset + 4) === format.machine
      );
    }
    default:
      return false;
  }
}

function readHeader(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Artifact discovery: validate artifacts-dir before anything is written.
// ---------------------------------------------------------------------------

/**
 * Validate and enumerate the built targets under `artifactsDir`, sorted by
 * Rust target triple name. Throws PackError on anything that would produce
 * an ambiguous or unsafe package set; never touches `outDir`.
 */
export function discoverArtifacts(artifactsDir, binaryName) {
  let entries;
  try {
    entries = fs.readdirSync(artifactsDir, { withFileTypes: true });
  } catch (error) {
    throw new PackError(`cannot read artifacts directory ${artifactsDir}: ${error.message}`);
  }

  if (entries.length === 0) {
    throw new PackError(`artifacts directory ${artifactsDir} contains no target directories`);
  }

  const nonDirs = entries.filter((entry) => !entry.isDirectory()).map((entry) => entry.name);
  if (nonDirs.length > 0) {
    throw new PackError(
      `artifacts directory ${artifactsDir} must contain only target directories, found non-directory entries: ${nonDirs.sort().join(", ")}`
    );
  }

  const dirNames = entries.map((entry) => entry.name).sort();
  const unknown = dirNames.filter((name) => !TARGETS_BY_RUST.has(name));
  if (unknown.length > 0) {
    const known = [...TARGETS_BY_RUST.keys()].sort().join(", ");
    throw new PackError(
      `artifacts directory ${artifactsDir} has unknown target director${unknown.length === 1 ? "y" : "ies"}: ${unknown.join(", ")} (known targets: ${known})`
    );
  }

  const artifacts = [];
  const seenPlatform = new Map();
  for (const name of dirNames) {
    const target = TARGETS_BY_RUST.get(name);
    const dir = path.join(artifactsDir, name);
    const binName = target.os === "win32" ? `${binaryName}.exe` : binaryName;

    const files = fs.readdirSync(dir, { withFileTypes: true });
    if (files.length !== 1 || files[0].name !== binName || !files[0].isFile()) {
      const found = files.map((entry) => entry.name).sort();
      throw new PackError(
        `target directory ${dir} must contain exactly one file named ${binName}, found: ${found.length ? found.join(", ") : "(empty)"}`
      );
    }

    const filePath = path.join(dir, binName);
    const header = readHeader(filePath);
    if (!matchesBinaryFormat(header, target.format)) {
      throw new PackError(
        `binary ${filePath} does not match the expected header for target ${name} (${target.os}/${target.cpu}); refusing before writing any output`
      );
    }

    const platformKey = `${target.os}-${target.cpu}`;
    if (seenPlatform.has(platformKey)) {
      throw new PackError(
        `both ${seenPlatform.get(platformKey)} and ${target.rust} map to npm platform ${platformKey}; a single run must build only one libc variant per os/cpu`
      );
    }
    seenPlatform.set(platformKey, target.rust);

    artifacts.push({ target, filePath });
  }

  return artifacts;
}

// ---------------------------------------------------------------------------
// out-dir safety: refuse to point the generated-package tree somewhere that
// would make `fs.rmSync(outDir, { recursive: true, force: true })` dangerous.
// ---------------------------------------------------------------------------

/** True when `child` is `parent` itself or a path nested under it. */
function isSameOrDescendant(parent, child) {
  if (parent === child) return true;
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Refuse an out-dir that resolves to the workspace root, the filesystem
 * root, `$HOME`, an ancestor of the workspace, or a path equal to or
 * containing `artifacts-dir`. Called before `generate()` writes anything.
 */
export function assertSafeOutDir({ outDir, artifactsDir, workspaceDir = process.cwd(), homeDir = os.homedir() }) {
  const resolvedWorkspace = path.resolve(workspaceDir);
  const resolvedOut = path.resolve(resolvedWorkspace, outDir);
  const resolvedArtifacts = path.resolve(resolvedWorkspace, artifactsDir);
  const resolvedHome = homeDir ? path.resolve(homeDir) : null;
  const filesystemRoot = path.parse(resolvedOut).root;

  if (resolvedOut === filesystemRoot) {
    throw new PackError(`out-dir ${JSON.stringify(outDir)} resolves to the filesystem root (${resolvedOut}); refusing`);
  }
  if (resolvedHome && resolvedOut === resolvedHome) {
    throw new PackError(`out-dir ${JSON.stringify(outDir)} resolves to $HOME (${resolvedHome}); refusing`);
  }
  if (resolvedOut === resolvedWorkspace) {
    throw new PackError(`out-dir ${JSON.stringify(outDir)} resolves to the workspace root (${resolvedWorkspace}); refusing`);
  }
  if (isSameOrDescendant(resolvedOut, resolvedWorkspace)) {
    throw new PackError(
      `out-dir ${JSON.stringify(outDir)} (${resolvedOut}) is an ancestor of the workspace (${resolvedWorkspace}); refusing`
    );
  }
  if (isSameOrDescendant(resolvedOut, resolvedArtifacts)) {
    throw new PackError(
      `out-dir ${JSON.stringify(outDir)} (${resolvedOut}) is equal to or contains artifacts-dir ${JSON.stringify(artifactsDir)} (${resolvedArtifacts}); refusing`
    );
  }
}

// ---------------------------------------------------------------------------
// Manifest builders. Key order is fixed so output is byte-identical across
// runs given identical inputs.
// ---------------------------------------------------------------------------

export function platformPackageJson({ target, packageName, binaryName, version, description, homepage, repositoryUrl, license }) {
  void description; // platform packages get their own generated description
  const pkg = {
    name: `${packageName}-${target.os}-${target.cpu}`,
    version,
    description: `Prebuilt ${binaryName} binary for ${target.os}-${target.cpu}.`,
    homepage,
    repository: { type: "git", url: repositoryUrl },
    license,
    os: [target.os],
    cpu: [target.cpu],
  };
  if (target.libc) {
    pkg.libc = [target.libc];
  }
  pkg.files = ["bin/", "LICENSE"];
  pkg.publishConfig = { registry: REGISTRY, access: "public" };
  return pkg;
}

export function launcherPackageJson({
  packageName,
  binaryName,
  version,
  description,
  homepage,
  repositoryUrl,
  license,
  selfUpdateCommand,
  builtTargets,
}) {
  const optionalDependencies = {};
  for (const name of builtTargets.map((target) => `${packageName}-${target.os}-${target.cpu}`).sort()) {
    optionalDependencies[name] = version;
  }

  const nativeLauncher = { binary: binaryName };
  if (selfUpdateCommand) {
    nativeLauncher.selfUpdateCommand = selfUpdateCommand;
  }

  return {
    name: packageName,
    version,
    description,
    homepage,
    repository: { type: "git", url: repositoryUrl },
    license,
    type: "commonjs",
    bin: { [binaryName]: "bin/launcher.js" },
    files: ["bin/", "LICENSE"],
    engines: { node: ">=16" },
    optionalDependencies,
    publishConfig: { registry: REGISTRY, access: "public" },
    nativeLauncher,
  };
}

function launcherReadme({ packageName, binaryName, description }) {
  return (
    `# ${packageName}\n\n` +
    `${description}\n\n` +
    `## Install\n\n` +
    "```sh\n" +
    `npm install -g ${packageName}\n` +
    "```\n\n" +
    `This installs a small launcher plus the prebuilt \`${binaryName}\` binary for your\n` +
    "platform as an optional dependency. Run it with:\n\n" +
    "```sh\n" +
    `${binaryName} --help\n` +
    "```\n"
  );
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// generate(): validate everything, then write the output tree.
// ---------------------------------------------------------------------------

export function generate({
  packageName,
  binaryName,
  version,
  artifactsDir,
  repositorySlug,
  license,
  licenseFile,
  description,
  selfUpdateCommand,
  outDir,
  workspaceDir,
  homeDir,
}) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new PackError(`version ${JSON.stringify(version)} must be X.Y.Z with no leading v`);
  }

  let licenseText;
  try {
    licenseText = fs.readFileSync(licenseFile);
  } catch (error) {
    throw new PackError(`LICENSE file not found at ${licenseFile}: ${error.message}`);
  }

  // Full validation happens before any write to outDir, so a refusal here
  // leaves outDir untouched.
  const artifacts = discoverArtifacts(artifactsDir, binaryName);
  assertSafeOutDir({
    outDir,
    artifactsDir,
    ...(workspaceDir !== undefined ? { workspaceDir } : {}),
    ...(homeDir !== undefined ? { homeDir } : {}),
  });

  const homepage = `https://github.com/${repositorySlug}#readme`;
  const repositoryUrl = `git+https://github.com/${repositorySlug}.git`;

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const generated = [];

  for (const { target, filePath } of artifacts) {
    const pkgJson = platformPackageJson({ target, packageName, binaryName, version, description, homepage, repositoryUrl, license });
    const pkgDir = path.join(outDir, pkgJson.name);
    const binDir = path.join(pkgDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const binName = target.os === "win32" ? `${binaryName}.exe` : binaryName;
    const destBin = path.join(binDir, binName);
    fs.copyFileSync(filePath, destBin);
    if (target.os !== "win32") {
      fs.chmodSync(destBin, 0o755);
    }
    fs.writeFileSync(path.join(pkgDir, "LICENSE"), licenseText);
    writeJson(path.join(pkgDir, "package.json"), pkgJson);
    generated.push({ dir: pkgDir, name: pkgJson.name, json: pkgJson });
  }

  const launcherJson = launcherPackageJson({
    packageName,
    binaryName,
    version,
    description,
    homepage,
    repositoryUrl,
    license,
    selfUpdateCommand,
    builtTargets: artifacts.map((artifact) => artifact.target),
  });
  const launcherDir = path.join(outDir, packageName);
  fs.mkdirSync(path.join(launcherDir, "bin"), { recursive: true });
  fs.copyFileSync(path.join(MODULE_DIR, "launcher.js"), path.join(launcherDir, "bin", "launcher.js"));
  fs.writeFileSync(path.join(launcherDir, "LICENSE"), licenseText);
  fs.writeFileSync(path.join(launcherDir, "README.md"), launcherReadme({ packageName, binaryName, description }));
  writeJson(path.join(launcherDir, "package.json"), launcherJson);
  generated.push({ dir: launcherDir, name: launcherJson.name, json: launcherJson });

  return generated;
}

// ---------------------------------------------------------------------------
// Publish + verify.
// ---------------------------------------------------------------------------

function npmScope(name) {
  if (!name.startsWith("@")) return null;
  const slash = name.indexOf("/");
  return slash > 0 ? name.slice(1, slash) : null;
}

/**
 * npm gives scope config (`@scope:registry=`, from any user/project .npmrc)
 * precedence over a bare `--registry` flag. A bare `--registry` is silently
 * inert for a scoped package already routed by `.npmrc`, so scoped packages
 * must be queried through their own scope override.
 */
function registryFlag(name) {
  const scope = npmScope(name);
  return scope ? `--@${scope}:registry=${REGISTRY}` : `--registry=${REGISTRY}`;
}

/** True when npm's failure output means "this name@version has never been published", not a real error. */
function isUnpublishedResponse(output) {
  return /\bE404\b/.test(output) || /is not in this registry/.test(output) || /No match found/.test(output);
}

/**
 * Returns the published version string, or `null` when npm positively
 * reports the spec as unpublished (404 / "is not in this registry" / "No
 * match found"). Any other failure (network, 5xx, auth, ...) throws rather
 * than being treated as "unpublished" — a transient failure here must never
 * be mistaken for "safe to publish".
 */
export function npmViewVersion(name, version) {
  const spec = `${name}@${version}`;
  const result = spawnSync("npm", ["view", spec, "version", registryFlag(name)], { encoding: "utf8" });
  if (result.status === 0) {
    return result.stdout.trim();
  }
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (isUnpublishedResponse(output)) {
    return null;
  }
  throw new PackError(`npm view ${spec} failed (exit ${result.status}): ${output.trim() || "no output"}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve whether `name@version` is already published, retrying on a
 * transient `npmViewVersion` failure (never on a confirmed "unpublished").
 * Exhausting the retries fails loudly rather than falling through to a
 * publish attempt against unknown registry state.
 */
export async function resolvePublishedVersion(name, version, options = {}) {
  const { attempts = 3, delayMs = 2000 } = options;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return npmViewVersion(name, version);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await delay(delayMs);
      }
    }
  }
  throw new PackError(
    `could not determine whether ${name}@${version} is already published, after ${attempts} attempt(s): ${lastError.message}`
  );
}

export async function publishOne(pkg, version, options = {}) {
  const spec = `${pkg.name}@${version}`;
  const current = await resolvePublishedVersion(pkg.name, version, options.resolve);
  if (current === version) {
    console.log(`already published, skipping: ${spec}`);
    return;
  }
  console.log(`publishing ${spec}`);
  const result = spawnSync("npm", ["publish", "--access", "public"], { cwd: pkg.dir, stdio: "inherit" });
  if (result.status !== 0) {
    throw new PackError(`npm publish failed for ${spec} with exit code ${result.status}`);
  }
}

/**
 * Poll the registry until `name@version` resolves, backing off
 * exponentially, to absorb npm propagation lag after a publish. `options`
 * makes the backoff and deadline injectable so tests do not need to wait on
 * real wall-clock delays. A transient `npmViewVersion` failure here is
 * treated the same as "not visible yet" — the deadline is what ultimately
 * turns a stuck registry into a loud failure. The default is 15 minutes:
 * npm took ~7 minutes to serve four newly created 12 MB platform packages on
 * their first publish (quoin 0.24.1).
 */
export async function verifyPublished(name, version, options = {}) {
  const { initialDelayMs = 2000, maxDelayMs = 60_000, deadlineMs = 900_000 } = options;
  const spec = `${name}@${version}`;
  const deadline = Date.now() + deadlineMs;
  let wait = initialDelayMs;
  for (;;) {
    let current;
    try {
      current = npmViewVersion(name, version);
    } catch (_error) {
      current = null;
    }
    if (current === version) {
      console.log(`verified ${spec}`);
      return;
    }
    if (Date.now() >= deadline) {
      throw new PackError(`${spec} did not resolve on ${REGISTRY} within the retry window`);
    }
    await delay(wait);
    wait = Math.min(wait * 2, maxDelayMs);
  }
}

/** Recursively find every directory under `outDir` that holds a package.json. */
function listGeneratedPackageDirs(outDir) {
  const results = [];
  function walk(dir) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      const json = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      results.push({ dir, name: json.name, version: json.version });
      return;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
    }
  }
  walk(outDir);
  return results;
}

export async function publishAll({ packageName, version, outDir, publishOptions, verifyOptions }) {
  const dirs = listGeneratedPackageDirs(outDir);
  const launcherDir = dirs.find((pkg) => pkg.name === packageName);
  if (!launcherDir) {
    throw new PackError(`launcher package ${packageName} not found under ${outDir}`);
  }
  const platformDirs = dirs.filter((pkg) => pkg.name !== packageName);
  // Platform packages first: the launcher's optionalDependencies reference
  // them at this exact version, so it must never resolve before they exist.
  const ordered = [...platformDirs, launcherDir];

  for (const pkg of ordered) {
    await publishOne(pkg, version, publishOptions);
  }
  for (const pkg of ordered) {
    await verifyPublished(pkg.name, version, verifyOptions);
  }
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    result[arg.slice(2)] = argv[i + 1] ?? "";
    i++;
  }
  return result;
}

function required(args, key) {
  const value = args[key];
  if (value === undefined || value === "") {
    throw new PackError(`missing required --${key}`);
  }
  return value;
}

function runGenerate(args) {
  const packageName = required(args, "package");
  const outDir = args["out-dir"] || "npm-dist";
  const generated = generate({
    packageName,
    binaryName: required(args, "binary"),
    version: required(args, "version"),
    artifactsDir: args["artifacts-dir"] || "artifacts",
    repositorySlug: required(args, "repository"),
    license: args["license"] || "AGPL-3.0-or-later",
    licenseFile: required(args, "license-file"),
    description: required(args, "description"),
    selfUpdateCommand: args["self-update-command"] || "",
    outDir,
  });

  const publish = (args["publish"] || "false") === "true";
  console.log(`generated ${generated.length} package(s) in ${outDir}:`);
  for (const pkg of generated) {
    console.log(`  - ${pkg.name}`);
  }

  if (publish) {
    return;
  }

  for (const pkg of generated) {
    console.log(`\n--- ${pkg.name}/package.json ---`);
    console.log(fs.readFileSync(path.join(pkg.dir, "package.json"), "utf8"));
    console.log(`--- npm pack --dry-run (${pkg.name}) ---`);
    const result = spawnSync("npm", ["pack", "--dry-run"], { cwd: pkg.dir, stdio: "inherit" });
    if (result.status !== 0) {
      throw new PackError(`npm pack --dry-run failed for ${pkg.name} with exit code ${result.status}`);
    }
  }
}

async function runPublish(args) {
  await publishAll({
    packageName: required(args, "package"),
    version: required(args, "version"),
    outDir: args["out-dir"] || "npm-dist",
  });
}

async function main() {
  const [, , command, ...rest] = process.argv;
  const args = parseArgs(rest);
  if (command === "generate") {
    runGenerate(args);
    return;
  }
  if (command === "publish") {
    await runPublish(args);
    return;
  }
  throw new PackError(`unknown command ${JSON.stringify(command)}; expected "generate" or "publish"`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    if (error instanceof PackError) {
      console.error(`error: ${error.message}`);
    } else {
      console.error(error.stack || String(error));
    }
    process.exitCode = 1;
  });
}

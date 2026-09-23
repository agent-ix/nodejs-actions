#!/usr/bin/env node
"use strict";

// Generic thin launcher, copied verbatim into every generated launcher
// package by pack.mjs. It carries no per-project knowledge: everything it
// needs (the binary name, the package name prefix, the optional self-update
// intercept command, and the closed set of supported platforms) comes from
// its own package.json at runtime.
//
// Behavior:
//   - Resolve `<name>-<platform>-<arch>/bin/<binary>[.exe]` via
//     require.resolve, restricted to declared optionalDependencies.
//   - chmod 0755 best-effort on POSIX, then spawn with inherited stdio.
//   - Mirror the child's exit status, or re-raise its terminating signal.
//   - If nativeLauncher.selfUpdateCommand is set and matches argv[2], print
//     an update hint and exit 1 without spawning anything.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const packageJson = require("../package.json");

const PLATFORM = process.platform; // 'linux' | 'darwin' | 'win32' | ...
const ARCH = process.arch; // 'x64' | 'arm64' | ...
const NAME = packageJson.name;
const NATIVE_LAUNCHER = packageJson.nativeLauncher || {};
const BINARY = NATIVE_LAUNCHER.binary;
const SELF_UPDATE_COMMAND = NATIVE_LAUNCHER.selfUpdateCommand || "";
const PACKAGE_PREFIX = `${NAME}-`;
const OPTIONAL_DEPENDENCIES = packageJson.optionalDependencies || {};

if (!BINARY) {
  process.stderr.write(`${NAME}: package.json is missing nativeLauncher.binary\n`);
  process.exit(1);
}

if (SELF_UPDATE_COMMAND && process.argv[2] === SELF_UPDATE_COMMAND) {
  process.stderr.write(
    `${BINARY} was installed with npm; update it with: npm install -g ${NAME}@latest\n`
  );
  process.exit(1);
}

function resolveBinary() {
  const key = `${PLATFORM}-${ARCH}`;
  const pkg = `${PACKAGE_PREFIX}${key}`;
  if (!Object.prototype.hasOwnProperty.call(OPTIONAL_DEPENDENCIES, pkg)) {
    const supported = Object.keys(OPTIONAL_DEPENDENCIES)
      .filter((name) => name.startsWith(PACKAGE_PREFIX))
      .map((name) => name.slice(PACKAGE_PREFIX.length))
      .sort();
    throw new Error(
      `${NAME}: unsupported platform "${key}".\n` +
        `Prebuilt binaries exist for: ${supported.join(", ")}.\n` +
        `Build ${BINARY} from source for this platform instead.`
    );
  }
  const binName = PLATFORM === "win32" ? `${BINARY}.exe` : BINARY;
  try {
    return require.resolve(`${pkg}/bin/${binName}`);
  } catch (_) {
    throw new Error(
      `${NAME}: the prebuilt binary package "${pkg}" is not installed.\n` +
        `It is an optional dependency — reinstall without --no-optional, or\n` +
        `add "${pkg}" explicitly. (--ignore-optional / CPU-VM mismatches skip it.)`
    );
  }
}

let bin;
try {
  bin = resolveBinary();
} catch (err) {
  process.stderr.write(String(err.message) + "\n");
  process.exit(1);
}

// npm does not always preserve the executable bit through publish/install;
// best-effort restore it on POSIX before exec.
if (PLATFORM !== "win32") {
  try {
    fs.chmodSync(bin, 0o755);
  } catch (_) {
    /* non-fatal: the file may already be executable or read-only */
  }
}

const result = spawnSync(bin, process.argv.slice(2), { stdio: "inherit" });

if (result.error) {
  process.stderr.write(`${NAME}: failed to launch binary: ${result.error.message}\n`);
  process.exit(1);
}
if (result.signal) {
  // Re-raise the child's terminating signal so callers observe the same
  // signal-driven exit.
  process.kill(process.pid, result.signal);
}
process.exit(result.status === null ? 1 : result.status);

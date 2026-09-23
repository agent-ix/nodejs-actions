import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

import { makeTempDir } from "./helpers.mjs";

const LAUNCHER_SOURCE = path.join(import.meta.dirname, "..", "launcher.js");

/**
 * Build a fake installed launcher package: <root>/bin/launcher.js,
 * <root>/package.json, and (optionally) a platform binary package under
 * <root>/node_modules/<name>-<platform>-<arch>/bin/<binary>. Mirrors a real
 * npm install layout closely enough for require.resolve to work from
 * launcher.js's own location.
 */
const DEFAULT_SCRIPT_BODY = "#!/bin/sh\n" + 'printf "ARGS:%s\\n" "$*"\n' + 'printf "ERR:%s\\n" "$*" 1>&2\n' + "cat\n" + "exit 23\n";

function setupPackage({ name, binary, selfUpdateCommand, optionalDependencies, installPlatformPackage, scriptBody }) {
  const root = makeTempDir("publish-native-npm-launcher-");
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.copyFileSync(LAUNCHER_SOURCE, path.join(root, "bin", "launcher.js"));

  const nativeLauncher = { binary };
  if (selfUpdateCommand) nativeLauncher.selfUpdateCommand = selfUpdateCommand;

  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name, version: "1.2.3", optionalDependencies, nativeLauncher }, null, 2) + "\n"
  );

  if (installPlatformPackage) {
    const key = `${process.platform}-${process.arch}`;
    const pkgName = `${name}-${key}`;
    const binName = process.platform === "win32" ? `${binary}.exe` : binary;
    const pkgDir = path.join(root, "node_modules", pkgName);
    fs.mkdirSync(path.join(pkgDir, "bin"), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: pkgName, version: "1.2.3" }, null, 2) + "\n"
    );
    const scriptPath = path.join(pkgDir, "bin", binName);
    fs.writeFileSync(scriptPath, scriptBody || DEFAULT_SCRIPT_BODY);
    fs.chmodSync(scriptPath, 0o755);
  }

  return root;
}

function runLauncher(root, args, options = {}) {
  return spawnSync(process.execPath, [path.join(root, "bin", "launcher.js"), ...args], {
    encoding: "utf8",
    ...options,
  });
}

const isLinux = process.platform === "linux";
const isDarwin = process.platform === "darwin";
const hasPosixShell = isLinux || isDarwin;
const shSkip = hasPosixShell ? false : "fake shell-script binary needs a POSIX shell (linux/darwin)";

test(
  "launcher: forwards args, stdin, exit code, and stderr through to the native binary",
  { skip: shSkip },
  () => {
    const root = setupPackage({
      name: "@agent-ix/quoin",
      binary: "quoin",
      optionalDependencies: { [`@agent-ix/quoin-${process.platform}-${process.arch}`]: "1.2.3" },
      installPlatformPackage: true,
    });

    const result = runLauncher(root, ["foo", "bar baz"], { input: "hello from stdin" });

    assert.equal(result.status, 23);
    assert.match(result.stdout, /ARGS:foo bar baz/);
    assert.match(result.stdout, /hello from stdin/);
    // AC-9: stderr is inherited, not swallowed.
    assert.match(result.stderr, /ERR:foo bar baz/);

    fs.rmSync(root, { recursive: true, force: true });
  }
);

test("launcher: self-update intercept prints message, exits 1, and never spawns", () => {
  const root = setupPackage({
    name: "@agent-ix/quoin",
    binary: "quoin",
    selfUpdateCommand: "update",
    optionalDependencies: { [`@agent-ix/quoin-${process.platform}-${process.arch}`]: "1.2.3" },
    // Deliberately do not install the platform package: if the launcher
    // tried to spawn anything, resolution would throw a different error.
    installPlatformPackage: false,
  });

  const result = runLauncher(root, ["update", "--force"]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /quoin was installed with npm; update it with: npm install -g @agent-ix\/quoin@latest/);

  fs.rmSync(root, { recursive: true, force: true });
});

test("launcher: unsupported platform names the built set and exits 1", () => {
  const root = setupPackage({
    name: "@agent-ix/quoin",
    binary: "quoin",
    optionalDependencies: { "@agent-ix/quoin-neverland-mips": "1.2.3", "@agent-ix/quoin-madeup-arm": "1.2.3" },
    installPlatformPackage: false,
  });

  const result = runLauncher(root, ["--help"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /unsupported platform/);
  assert.match(result.stderr, /madeup-arm/);
  assert.match(result.stderr, /neverland-mips/);

  fs.rmSync(root, { recursive: true, force: true });
});

test("launcher: supported platform but missing optional dependency package errors clearly", () => {
  const key = `${process.platform}-${process.arch}`;
  const root = setupPackage({
    name: "@agent-ix/quoin",
    binary: "quoin",
    optionalDependencies: { [`@agent-ix/quoin-${key}`]: "1.2.3" },
    installPlatformPackage: false,
  });

  const result = runLauncher(root, ["--help"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /is not installed/);
  assert.match(result.stderr, new RegExp(`@agent-ix/quoin-${key}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result.stderr, /--no-optional/);
  // Finding 8: also point at a libc mismatch as a possible cause, not just
  // --no-optional / CPU-VM mismatches.
  assert.match(result.stderr, /libc/);
  assert.match(result.stderr, /musl/);

  fs.rmSync(root, { recursive: true, force: true });
});

// --- signal handling ---------------------------------------------------

test(
  "launcher: a child killed by SIGTERM leads to the launcher exiting by SIGTERM or 143",
  { skip: shSkip },
  () => {
    const root = setupPackage({
      name: "@agent-ix/quoin",
      binary: "quoin",
      optionalDependencies: { [`@agent-ix/quoin-${process.platform}-${process.arch}`]: "1.2.3" },
      installPlatformPackage: true,
      scriptBody: "#!/bin/sh\nkill -s TERM $$\nsleep 5\n",
    });

    const result = runLauncher(root, []);

    const bySignal = result.signal === "SIGTERM";
    const byCode = result.status === 143;
    assert.ok(bySignal || byCode, `expected exit by SIGTERM or status 143, got status=${result.status} signal=${result.signal}`);

    fs.rmSync(root, { recursive: true, force: true });
  }
);

test(
  "launcher: a SIGTERM sent to the launcher reaches the child",
  { skip: shSkip },
  async () => {
    const root = setupPackage({
      name: "@agent-ix/quoin",
      binary: "quoin",
      optionalDependencies: { [`@agent-ix/quoin-${process.platform}-${process.arch}`]: "1.2.3" },
      installPlatformPackage: true,
      // Trap TERM, prove receipt, then exit cleanly (rather than dying by
      // the trapped signal) so the assertion below is unambiguous.
      scriptBody: "#!/bin/sh\ntrap 'echo GOT_TERM; exit 0' TERM\nwhile true; do sleep 0.05; done\n",
    });

    const child = spawn(process.execPath, [path.join(root, "bin", "launcher.js")], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    child.kill("SIGTERM");

    const exit = await new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));

    assert.match(stdout, /GOT_TERM/);
    assert.equal(exit.code, 0);

    fs.rmSync(root, { recursive: true, force: true });
  }
);

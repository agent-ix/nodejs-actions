import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  TARGETS,
  assertSafeOutDir,
  discoverArtifacts,
  generate,
  launcherPackageJson,
  matchesBinaryFormat,
  platformPackageJson,
} from "../pack.mjs";
import { makeTempDir, writeFakeBinary, writeLicense } from "./helpers.mjs";

function target(rust) {
  const found = TARGETS.find((entry) => entry.rust === rust);
  assert.ok(found, `no target for ${rust}`);
  return found;
}

function setupArtifacts(rustTriples, binaryName) {
  const dir = makeTempDir("publish-native-npm-artifacts-");
  for (const rust of rustTriples) {
    const t = target(rust);
    const binName = t.os === "win32" ? `${binaryName}.exe` : binaryName;
    writeFakeBinary(path.join(dir, rust, binName), t.format);
  }
  return dir;
}

// --- platformPackageJson --------------------------------------------------

test("platformPackageJson: linux gnu package declares libc glibc", () => {
  const pkg = platformPackageJson({
    target: target("x86_64-unknown-linux-gnu"),
    packageName: "@agent-ix/quoin",
    binaryName: "quoin",
    version: "1.2.3",
    description: "ignored for platform packages",
    homepage: "https://github.com/agent-ix/quoin#readme",
    repositoryUrl: "git+https://github.com/agent-ix/quoin.git",
    license: "AGPL-3.0-or-later",
  });
  assert.deepEqual(pkg, {
    name: "@agent-ix/quoin-linux-x64",
    version: "1.2.3",
    description: "Prebuilt quoin binary for linux-x64.",
    homepage: "https://github.com/agent-ix/quoin#readme",
    repository: { type: "git", url: "git+https://github.com/agent-ix/quoin.git" },
    license: "AGPL-3.0-or-later",
    os: ["linux"],
    cpu: ["x64"],
    libc: ["glibc"],
    files: ["bin/", "LICENSE"],
    publishConfig: { registry: "https://registry.npmjs.org/", access: "public" },
  });
});

test("platformPackageJson: linux musl package declares libc musl", () => {
  const pkg = platformPackageJson({
    target: target("aarch64-unknown-linux-musl"),
    packageName: "@agent-ix/quoin",
    binaryName: "quoin",
    version: "1.2.3",
    description: "x",
    homepage: "https://github.com/agent-ix/quoin#readme",
    repositoryUrl: "git+https://github.com/agent-ix/quoin.git",
    license: "AGPL-3.0-or-later",
  });
  assert.deepEqual(pkg.cpu, ["arm64"]);
  assert.deepEqual(pkg.os, ["linux"]);
  assert.deepEqual(pkg.libc, ["musl"]);
});

test("platformPackageJson: darwin and win32 packages omit libc entirely", () => {
  for (const rust of ["aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-pc-windows-msvc"]) {
    const pkg = platformPackageJson({
      target: target(rust),
      packageName: "@agent-ix/quoin",
      binaryName: "quoin",
      version: "1.2.3",
      description: "x",
      homepage: "https://github.com/agent-ix/quoin#readme",
      repositoryUrl: "git+https://github.com/agent-ix/quoin.git",
      license: "AGPL-3.0-or-later",
    });
    assert.equal("libc" in pkg, false, `${rust} package must not declare libc`);
  }
});

test("platformPackageJson: aarch64-unknown-linux-gnu maps to linux/arm64/glibc", () => {
  const pkg = platformPackageJson({
    target: target("aarch64-unknown-linux-gnu"),
    packageName: "@agent-ix/quoin",
    binaryName: "quoin",
    version: "1.2.3",
    description: "x",
    homepage: "https://github.com/agent-ix/quoin#readme",
    repositoryUrl: "git+https://github.com/agent-ix/quoin.git",
    license: "AGPL-3.0-or-later",
  });
  assert.equal(pkg.name, "@agent-ix/quoin-linux-arm64");
  assert.deepEqual(pkg.os, ["linux"]);
  assert.deepEqual(pkg.cpu, ["arm64"]);
  assert.deepEqual(pkg.libc, ["glibc"]);
});

test("platformPackageJson: x86_64-unknown-linux-musl maps to linux/x64/musl", () => {
  const pkg = platformPackageJson({
    target: target("x86_64-unknown-linux-musl"),
    packageName: "@agent-ix/quoin",
    binaryName: "quoin",
    version: "1.2.3",
    description: "x",
    homepage: "https://github.com/agent-ix/quoin#readme",
    repositoryUrl: "git+https://github.com/agent-ix/quoin.git",
    license: "AGPL-3.0-or-later",
  });
  assert.equal(pkg.name, "@agent-ix/quoin-linux-x64");
  assert.deepEqual(pkg.os, ["linux"]);
  assert.deepEqual(pkg.cpu, ["x64"]);
  assert.deepEqual(pkg.libc, ["musl"]);
});

test("platformPackageJson: x86_64-apple-darwin maps to darwin/x64, no libc key", () => {
  const pkg = platformPackageJson({
    target: target("x86_64-apple-darwin"),
    packageName: "@agent-ix/quoin",
    binaryName: "quoin",
    version: "1.2.3",
    description: "x",
    homepage: "https://github.com/agent-ix/quoin#readme",
    repositoryUrl: "git+https://github.com/agent-ix/quoin.git",
    license: "AGPL-3.0-or-later",
  });
  assert.equal(pkg.name, "@agent-ix/quoin-darwin-x64");
  assert.deepEqual(pkg.os, ["darwin"]);
  assert.deepEqual(pkg.cpu, ["x64"]);
  assert.equal("libc" in pkg, false);
});

// --- launcherPackageJson ---------------------------------------------------

test("launcherPackageJson: optionalDependencies equals exactly the built set", () => {
  const built = [target("x86_64-unknown-linux-gnu"), target("aarch64-apple-darwin")];
  const pkg = launcherPackageJson({
    packageName: "@agent-ix/quoin",
    binaryName: "quoin",
    version: "1.2.3",
    description: "The quoin CLI",
    homepage: "https://github.com/agent-ix/quoin#readme",
    repositoryUrl: "git+https://github.com/agent-ix/quoin.git",
    license: "AGPL-3.0-or-later",
    selfUpdateCommand: "",
    builtTargets: built,
  });
  assert.deepEqual(pkg.optionalDependencies, {
    "@agent-ix/quoin-darwin-arm64": "1.2.3",
    "@agent-ix/quoin-linux-x64": "1.2.3",
  });
  assert.equal(Object.keys(pkg.optionalDependencies).length, 2);
});

test("launcherPackageJson: full manifest shape, self-update omitted when empty", () => {
  const pkg = launcherPackageJson({
    packageName: "@agent-ix/quoin",
    binaryName: "quoin",
    version: "1.2.3",
    description: "The quoin CLI",
    homepage: "https://github.com/agent-ix/quoin#readme",
    repositoryUrl: "git+https://github.com/agent-ix/quoin.git",
    license: "AGPL-3.0-or-later",
    selfUpdateCommand: "",
    builtTargets: [target("x86_64-unknown-linux-gnu")],
  });
  assert.deepEqual(pkg, {
    name: "@agent-ix/quoin",
    version: "1.2.3",
    description: "The quoin CLI",
    homepage: "https://github.com/agent-ix/quoin#readme",
    repository: { type: "git", url: "git+https://github.com/agent-ix/quoin.git" },
    license: "AGPL-3.0-or-later",
    type: "commonjs",
    bin: { quoin: "bin/launcher.js" },
    files: ["bin/", "LICENSE"],
    engines: { node: ">=16" },
    optionalDependencies: { "@agent-ix/quoin-linux-x64": "1.2.3" },
    publishConfig: { registry: "https://registry.npmjs.org/", access: "public" },
    nativeLauncher: { binary: "quoin" },
  });
});

test("launcherPackageJson: nativeLauncher carries selfUpdateCommand when set", () => {
  const pkg = launcherPackageJson({
    packageName: "@agent-ix/quoin",
    binaryName: "quoin",
    version: "1.2.3",
    description: "The quoin CLI",
    homepage: "https://github.com/agent-ix/quoin#readme",
    repositoryUrl: "git+https://github.com/agent-ix/quoin.git",
    license: "AGPL-3.0-or-later",
    selfUpdateCommand: "update",
    builtTargets: [target("x86_64-unknown-linux-gnu")],
  });
  assert.deepEqual(pkg.nativeLauncher, { binary: "quoin", selfUpdateCommand: "update" });
});

// --- matchesBinaryFormat ----------------------------------------------------

test("matchesBinaryFormat: rejects a binary built for the wrong architecture", () => {
  const dir = makeTempDir("publish-native-npm-header-");
  const filePath = path.join(dir, "bin");
  // ELF header claiming arm64 (183) while validating against x64 (62).
  writeFakeBinary(filePath, { type: "elf", machine: 183 });
  const buffer = fs.readFileSync(filePath);
  assert.equal(matchesBinaryFormat(buffer, { type: "elf", machine: 62 }), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- discoverArtifacts / generate refusals ---------------------------------

function runGenerateExpectingRefusal(t, setup, matchMessage) {
  const artifactsDir = setup();
  const workDir = makeTempDir("publish-native-npm-work-");
  const licenseFile = writeLicense(workDir);
  const outDir = path.join(workDir, "npm-dist");

  assert.throws(
    () =>
      generate({
        packageName: "@agent-ix/quoin",
        binaryName: "quoin",
        version: "1.2.3",
        artifactsDir,
        repositorySlug: "agent-ix/quoin",
        license: "AGPL-3.0-or-later",
        licenseFile,
        description: "The quoin CLI",
        selfUpdateCommand: "",
        outDir,
      }),
    matchMessage
  );
  assert.equal(fs.existsSync(outDir), false, "refusal must not write any output");
  fs.rmSync(artifactsDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
}

test("generate: refuses an unknown target directory name, writes no output", (t) => {
  runGenerateExpectingRefusal(
    t,
    () => {
      // A valid target directory alongside one outside the catalog.
      const dir = setupArtifacts(["x86_64-unknown-linux-gnu"], "quoin");
      fs.mkdirSync(path.join(dir, "sparc64-unknown-solaris"), { recursive: true });
      fs.writeFileSync(path.join(dir, "sparc64-unknown-solaris", "quoin"), "x");
      return dir;
    },
    /unknown target director/
  );
});

test("generate: refuses a binary whose header does not match its target directory", (t) => {
  runGenerateExpectingRefusal(
    t,
    () => {
      const dir = makeTempDir("publish-native-npm-artifacts-");
      // Directory says x64 gnu-linux, but the binary header is arm64.
      writeFakeBinary(path.join(dir, "x86_64-unknown-linux-gnu", "quoin"), { type: "elf", machine: 183 });
      return dir;
    },
    /does not match the expected header/
  );
});

test("generate: refuses a target directory with an extra file", (t) => {
  runGenerateExpectingRefusal(
    t,
    () => {
      const dir = setupArtifacts(["x86_64-unknown-linux-gnu"], "quoin");
      fs.writeFileSync(path.join(dir, "x86_64-unknown-linux-gnu", "extra.txt"), "x");
      return dir;
    },
    /must contain exactly one file/
  );
});

test("generate: refuses an empty target directory", (t) => {
  runGenerateExpectingRefusal(
    t,
    () => {
      const dir = makeTempDir("publish-native-npm-artifacts-");
      fs.mkdirSync(path.join(dir, "x86_64-unknown-linux-gnu"), { recursive: true });
      return dir;
    },
    /must contain exactly one file/
  );
});

test("generate: refuses an artifacts directory with no target directories at all", (t) => {
  runGenerateExpectingRefusal(t, () => makeTempDir("publish-native-npm-artifacts-empty-"), /contains no target directories/);
});

test("generate: refuses two targets that collide on the same npm os/cpu", (t) => {
  runGenerateExpectingRefusal(
    t,
    () => setupArtifacts(["x86_64-unknown-linux-gnu", "x86_64-unknown-linux-musl"], "quoin"),
    /map to npm platform/
  );
});

test("generate: refuses a win32 target directory whose sole file is missing .exe", (t) => {
  runGenerateExpectingRefusal(
    t,
    () => {
      const dir = makeTempDir("publish-native-npm-artifacts-");
      // Right bytes for a win32 PE binary, but named without the required
      // .exe extension.
      writeFakeBinary(path.join(dir, "x86_64-pc-windows-msvc", "quoin"), { type: "pe", machine: 0x8664 });
      return dir;
    },
    /must contain exactly one file named quoin\.exe/
  );
});

test("generate: refuses a stray file at the top level of artifacts-dir", (t) => {
  runGenerateExpectingRefusal(
    t,
    () => {
      const dir = setupArtifacts(["x86_64-unknown-linux-gnu"], "quoin");
      fs.writeFileSync(path.join(dir, "README.txt"), "stray top-level file");
      return dir;
    },
    /must contain only target directories/
  );
});

test("generate: refuses a missing LICENSE file, writes no output", () => {
  const artifactsDir = setupArtifacts(["x86_64-unknown-linux-gnu"], "quoin");
  const workDir = makeTempDir("publish-native-npm-work-");
  const outDir = path.join(workDir, "npm-dist");
  assert.throws(
    () =>
      generate({
        packageName: "@agent-ix/quoin",
        binaryName: "quoin",
        version: "1.2.3",
        artifactsDir,
        repositorySlug: "agent-ix/quoin",
        license: "AGPL-3.0-or-later",
        licenseFile: path.join(workDir, "does-not-exist", "LICENSE"),
        description: "The quoin CLI",
        selfUpdateCommand: "",
        outDir,
      }),
    /LICENSE file not found/
  );
  assert.equal(fs.existsSync(outDir), false);
  fs.rmSync(artifactsDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
});

// --- generate: full successful run -----------------------------------------

test("generate: produces exact manifests for a mixed gnu+musl+darwin+win32 set, deterministically", () => {
  const rustTriples = [
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-musl",
    "aarch64-apple-darwin",
    "x86_64-pc-windows-msvc",
  ];
  const artifactsDir = setupArtifacts(rustTriples, "quoin");
  const workDir = makeTempDir("publish-native-npm-work-");
  const licenseFile = writeLicense(workDir, "AGPL license text\n");
  const outDir = path.join(workDir, "npm-dist");

  const options = {
    packageName: "@agent-ix/quoin",
    binaryName: "quoin",
    version: "1.2.3",
    artifactsDir,
    repositorySlug: "agent-ix/quoin",
    license: "AGPL-3.0-or-later",
    licenseFile,
    description: "The quoin CLI",
    selfUpdateCommand: "quoin-update",
    outDir,
  };

  const first = generate(options);
  assert.equal(first.length, 5); // 4 platform packages + 1 launcher

  const launcher = first.find((pkg) => pkg.name === "@agent-ix/quoin");
  assert.ok(launcher);
  assert.deepEqual(Object.keys(launcher.json.optionalDependencies).sort(), [
    "@agent-ix/quoin-darwin-arm64",
    "@agent-ix/quoin-linux-arm64",
    "@agent-ix/quoin-linux-x64",
    "@agent-ix/quoin-win32-x64",
  ]);
  assert.equal(launcher.json.nativeLauncher.selfUpdateCommand, "quoin-update");

  // bin/launcher.js was copied in, LICENSE present, package.json trailing newline.
  assert.ok(fs.existsSync(path.join(launcher.dir, "bin", "launcher.js")));
  assert.ok(fs.existsSync(path.join(launcher.dir, "LICENSE")));
  assert.ok(fs.existsSync(path.join(launcher.dir, "README.md")));
  const rawJson = fs.readFileSync(path.join(launcher.dir, "package.json"), "utf8");
  assert.ok(rawJson.endsWith("\n"));

  const linuxArm64 = first.find((pkg) => pkg.name === "@agent-ix/quoin-linux-arm64");
  assert.deepEqual(linuxArm64.json.libc, ["musl"]);
  const binStat = fs.statSync(path.join(linuxArm64.dir, "bin", "quoin"));
  assert.equal(binStat.mode & 0o777, 0o755);

  const win32 = first.find((pkg) => pkg.name === "@agent-ix/quoin-win32-x64");
  assert.ok(fs.existsSync(path.join(win32.dir, "bin", "quoin.exe")));
  assert.equal("libc" in win32.json, false);

  // Deterministic: regenerating from identical inputs is byte-identical.
  const before = captureTree(outDir);
  generate(options);
  const after = captureTree(outDir);
  assert.deepEqual(after, before);

  fs.rmSync(artifactsDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
});

function captureTree(dir) {
  const result = {};
  for (const entry of walk(dir)) {
    result[entry] = fs.readFileSync(path.join(dir, entry));
  }
  return result;
}

function* walk(dir, prefix = "") {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path.join(dir, entry.name), rel);
    } else {
      yield rel;
    }
  }
}

test("discoverArtifacts: sole export used directly still enforces the catalog", () => {
  const dir = makeTempDir("publish-native-npm-artifacts-");
  fs.mkdirSync(path.join(dir, "x86_64-unknown-linux-gnu"), { recursive: true });
  writeFakeBinary(path.join(dir, "x86_64-unknown-linux-gnu", "quoin"), { type: "elf", machine: 62 });
  const artifacts = discoverArtifacts(dir, "quoin");
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].target.rust, "x86_64-unknown-linux-gnu");
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- assertSafeOutDir / generate: out-dir guard -----------------------------

test("assertSafeOutDir: refuses the workspace root", () => {
  const workspaceDir = makeTempDir("publish-native-npm-workspace-");
  assert.throws(
    () => assertSafeOutDir({ outDir: ".", artifactsDir: "artifacts", workspaceDir, homeDir: "/nonexistent-home" }),
    /workspace root/
  );
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

test("assertSafeOutDir: refuses the filesystem root", () => {
  assert.throws(
    () => assertSafeOutDir({ outDir: "/", artifactsDir: "artifacts", workspaceDir: "/some/workspace", homeDir: "/nonexistent-home" }),
    /filesystem root/
  );
});

test("assertSafeOutDir: refuses $HOME", () => {
  const homeDir = makeTempDir("publish-native-npm-home-");
  assert.throws(
    () => assertSafeOutDir({ outDir: homeDir, artifactsDir: "artifacts", workspaceDir: "/some/workspace", homeDir }),
    /\$HOME/
  );
  fs.rmSync(homeDir, { recursive: true, force: true });
});

test("assertSafeOutDir: refuses an ancestor of the workspace", () => {
  const workspaceDir = makeTempDir("publish-native-npm-workspace-");
  assert.throws(
    () =>
      assertSafeOutDir({
        outDir: path.dirname(workspaceDir),
        artifactsDir: "artifacts",
        workspaceDir,
        homeDir: "/nonexistent-home",
      }),
    /ancestor of the workspace/
  );
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

test("assertSafeOutDir: refuses an out-dir equal to artifacts-dir", () => {
  const workspaceDir = makeTempDir("publish-native-npm-workspace-");
  assert.throws(
    () =>
      assertSafeOutDir({
        outDir: "artifacts",
        artifactsDir: "artifacts",
        workspaceDir,
        homeDir: "/nonexistent-home",
      }),
    /contains? artifacts-dir|equal to/
  );
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

test("assertSafeOutDir: refuses an out-dir that contains artifacts-dir", () => {
  const workspaceDir = makeTempDir("publish-native-npm-workspace-");
  // artifacts-dir nested under "build/", so "build" is a proper ancestor of
  // it without being the workspace root itself.
  assert.throws(
    () =>
      assertSafeOutDir({
        outDir: "build",
        artifactsDir: "build/artifacts",
        workspaceDir,
        homeDir: "/nonexistent-home",
      }),
    /contains artifacts-dir/
  );
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

test("assertSafeOutDir: accepts an ordinary sibling out-dir", () => {
  const workspaceDir = makeTempDir("publish-native-npm-workspace-");
  assert.doesNotThrow(() =>
    assertSafeOutDir({ outDir: "npm-dist", artifactsDir: "artifacts", workspaceDir, homeDir: "/nonexistent-home" })
  );
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

test("generate: refuses an unsafe out-dir before writing anything", (t) => {
  const artifactsDir = setupArtifacts(["x86_64-unknown-linux-gnu"], "quoin");
  const workDir = makeTempDir("publish-native-npm-work-");
  const licenseFile = writeLicense(workDir);

  assert.throws(
    () =>
      generate({
        packageName: "@agent-ix/quoin",
        binaryName: "quoin",
        version: "1.2.3",
        artifactsDir,
        repositorySlug: "agent-ix/quoin",
        license: "AGPL-3.0-or-later",
        licenseFile,
        description: "The quoin CLI",
        selfUpdateCommand: "",
        outDir: workDir,
        workspaceDir: workDir,
        homeDir: "/nonexistent-home",
      }),
    /workspace root/
  );
  assert.equal(fs.existsSync(path.join(workDir, "npm-dist")), false);
  fs.rmSync(artifactsDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
});

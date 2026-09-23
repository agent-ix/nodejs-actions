import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { generate, npmViewVersion, publishAll, publishOne, resolvePublishedVersion, verifyPublished } from "../pack.mjs";
import { installFakeNpm, makeTempDir, writeFakeBinary, writeLicense } from "./helpers.mjs";

// Build a small, real generated package tree (one platform package plus the
// launcher) so publishAll/publishOne/verifyPublished exercise real
// directories, the same way action.yml's "Publish and verify" step does.
function setupGeneratedTree() {
  const artifactsDir = makeTempDir("publish-native-npm-publish-artifacts-");
  writeFakeBinary(path.join(artifactsDir, "x86_64-unknown-linux-gnu", "quoin"), { type: "elf", machine: 62 });
  writeFakeBinary(path.join(artifactsDir, "aarch64-apple-darwin", "quoin"), { type: "macho", cputype: 0x0100000c });

  const workDir = makeTempDir("publish-native-npm-publish-work-");
  const licenseFile = writeLicense(workDir);
  const outDir = path.join(workDir, "npm-dist");

  const generated = generate({
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
  });

  return { artifactsDir, workDir, outDir, generated };
}

function cleanup({ artifactsDir, workDir }) {
  fs.rmSync(artifactsDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
}

// --- publishAll: ordering + skip-existing -----------------------------------

test("publishAll: publishes every platform package before the launcher, and verifies all of them", async () => {
  const tree = setupGeneratedTree();
  const npm = installFakeNpm();
  try {
    const fixture = {};
    for (const pkg of tree.generated) {
      const spec = `${pkg.name}@1.2.3`;
      // First view call (publishOne's pre-check) says unpublished; the next
      // (verifyPublished's poll) says it now resolves.
      fixture[spec] = [{ notFound: true }, { version: "1.2.3" }];
    }
    npm.setFixture(fixture);

    await publishAll({
      packageName: "@agent-ix/quoin",
      version: "1.2.3",
      outDir: tree.outDir,
      verifyOptions: { initialDelayMs: 1, maxDelayMs: 1, deadlineMs: 5000 },
    });

    const record = npm.readRecord();
    const dirToName = new Map(tree.generated.map((pkg) => [pkg.dir, pkg.name]));
    const publishOrder = record
      .filter((entry) => entry.argv[0] === "publish")
      .map((entry) => dirToName.get(entry.cwd));

    assert.equal(publishOrder.length, 3);
    assert.equal(publishOrder[2], "@agent-ix/quoin", "launcher must publish last");
    assert.deepEqual(
      new Set(publishOrder.slice(0, 2)),
      new Set(["@agent-ix/quoin-linux-x64", "@agent-ix/quoin-darwin-arm64"])
    );
  } finally {
    npm.restore();
    cleanup(tree);
  }
});

test("publishOne: an already-published name@version is skipped, never re-published", async () => {
  const npm = installFakeNpm();
  const dir = makeTempDir("publish-native-npm-already-published-");
  try {
    npm.setFixture({ "@agent-ix/quoin@1.2.3": { version: "1.2.3" } });

    await publishOne({ name: "@agent-ix/quoin", dir }, "1.2.3");

    const record = npm.readRecord();
    assert.equal(record.length, 1);
    assert.equal(record[0].argv[0], "view");
    assert.ok(!record.some((entry) => entry.argv[0] === "publish"));
  } finally {
    npm.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- verifyPublished: retry until visible, then deadline --------------------

test("verifyPublished: retries until the package appears", async () => {
  const npm = installFakeNpm();
  try {
    npm.setFixture({
      "@agent-ix/quoin@1.2.3": [{ notFound: true }, { notFound: true }, { version: "1.2.3" }],
    });

    await verifyPublished("@agent-ix/quoin", "1.2.3", { initialDelayMs: 1, maxDelayMs: 1, deadlineMs: 5000 });

    const record = npm.readRecord();
    assert.equal(record.length, 3);
  } finally {
    npm.restore();
  }
});

test("verifyPublished: fails after the deadline when the package never appears", async () => {
  const npm = installFakeNpm();
  try {
    npm.setFixture({ "@agent-ix/quoin@1.2.3": { notFound: true } });

    await assert.rejects(
      () => verifyPublished("@agent-ix/quoin", "1.2.3", { initialDelayMs: 1, maxDelayMs: 1, deadlineMs: 20 }),
      /did not resolve on .* within the retry window/
    );
  } finally {
    npm.restore();
  }
});

// --- npmViewVersion / resolvePublishedVersion error handling ----------------

test("npmViewVersion: returns the version on a match", () => {
  const npm = installFakeNpm();
  try {
    npm.setFixture({ "@agent-ix/quoin@1.2.3": { version: "1.2.3" } });
    assert.equal(npmViewVersion("@agent-ix/quoin", "1.2.3"), "1.2.3");
  } finally {
    npm.restore();
  }
});

test("npmViewVersion: returns null only for a confirmed-unpublished response", () => {
  const npm = installFakeNpm();
  try {
    npm.setFixture({ "@agent-ix/quoin@1.2.3": { notFound: true } });
    assert.equal(npmViewVersion("@agent-ix/quoin", "1.2.3"), null);
  } finally {
    npm.restore();
  }
});

test("npmViewVersion: throws (does not return null) for a non-404 failure", () => {
  const npm = installFakeNpm();
  try {
    npm.setFixture({ "@agent-ix/quoin@1.2.3": { error: "npm error code E500\nnpm error 500 Internal Server Error" } });
    assert.throws(() => npmViewVersion("@agent-ix/quoin", "1.2.3"), /npm view .* failed/);
  } finally {
    npm.restore();
  }
});

test("resolvePublishedVersion: retries a transient failure, then fails loudly rather than publishing", async () => {
  const npm = installFakeNpm();
  const dir = makeTempDir("publish-native-npm-transient-error-");
  try {
    npm.setFixture({ "@agent-ix/quoin@1.2.3": { error: "npm error code ECONNRESET" } });

    await assert.rejects(
      () => resolvePublishedVersion("@agent-ix/quoin", "1.2.3", { attempts: 2, delayMs: 1 }),
      /could not determine whether/
    );

    // publishOne must propagate the same failure and never attempt a publish.
    await assert.rejects(
      () => publishOne({ name: "@agent-ix/quoin", dir }, "1.2.3", { resolve: { attempts: 2, delayMs: 1 } }),
      /could not determine whether/
    );
    const record = npm.readRecord();
    assert.ok(!record.some((entry) => entry.argv[0] === "publish"));
  } finally {
    npm.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

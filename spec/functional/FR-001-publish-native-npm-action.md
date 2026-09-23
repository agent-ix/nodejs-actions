---
id: FR-001
title: "publish-native-npm composite action"
type: FR
object_type: github_action
relationships:
  - target: "ix://agent-ix/nodejs-actions/spec/spec"
    type: "implements"
    cardinality: "1:1"
---

# FR-001: publish-native-npm composite action

## Description

`publish-native-npm/` SHALL be a reusable composite GitHub Action that
publishes a prebuilt native (Rust) CLI to public npmjs as one launcher
package plus one per-platform binary package per built target. It is the
org's shared replacement for the quire-specific machinery previously
duplicated per-repo (`agent-ix/quire-cli`'s `tools/quire-dist` and
`npm/quire-cli/bin/quire.js`): the packaging and validation logic and the
launcher process contract are generic, driven entirely by action inputs, and
carry no per-project knowledge of any one binary or repository.

The action's own logic lives in `publish-native-npm/pack.mjs` (Node >= 22, no
npm dependencies, only `node:` builtins), invoked by `action.yml`'s steps.
`publish-native-npm/launcher.js` is copied verbatim into every generated
launcher package and is likewise generic: it derives everything it needs
(binary name, package-name prefix, optional self-update intercept command,
and the supported-platform set) from its own `package.json` at runtime.

## Target catalog

One Rust target triple maps to exactly one npm `os`/`cpu`/`libc` combination
and one expected binary header:

| Rust target | npm os | npm cpu | npm libc |
|---|---|---|---|
| `x86_64-unknown-linux-gnu` | `linux` | `x64` | `glibc` |
| `aarch64-unknown-linux-gnu` | `linux` | `arm64` | `glibc` |
| `x86_64-unknown-linux-musl` | `linux` | `x64` | `musl` |
| `aarch64-unknown-linux-musl` | `linux` | `arm64` | `musl` |
| `aarch64-apple-darwin` | `darwin` | `arm64` | (absent) |
| `x86_64-apple-darwin` | `darwin` | `x64` | (absent) |
| `x86_64-pc-windows-msvc` | `win32` | `x64` | (absent) |

A directory name under `artifacts-dir` outside this catalog is refused. Two
built targets that would map to the same `os`/`cpu` pair (e.g. building both
the `gnu` and `musl` variants of `linux-x64` in one run) are refused, since
the fixed platform-package naming scheme (`<package>-<os>-<cpu>`, no libc
suffix) cannot distinguish them.

## Behavior

1. **Validation before any write.** The action reads `artifacts-dir`, which
   must contain only subdirectories named by an admitted Rust target triple,
   each holding exactly one file named `<binary>` (or `<binary>.exe` for
   `win32`). Every binary's header is checked against its target's expected
   format (ELF `e_machine` 62/x64 or 183/arm64; Mach-O 64-bit `cputype`
   `0x01000007`/x64 or `0x0100000c`/arm64; PE/COFF `machine` `0x8664`). A
   missing `LICENSE` file at `$GITHUB_WORKSPACE/LICENSE`, an unknown target
   directory, a wrong file count, or a header mismatch is refused before any
   file under `out-dir` is created or modified.
2. **Deterministic generation.** A successful run replaces `out-dir` with one
   package directory per built target plus one launcher package directory.
   Each platform package gets `package.json` (name, version, description,
   homepage, repository, license, `os`, `cpu`, `libc` when the target has one,
   `files`, `publishConfig`), `bin/<binary>[.exe]` (mode `0755` unless
   `win32`), and `LICENSE`. The launcher package gets `package.json` (name,
   version, description, homepage, repository, license, `type: "commonjs"`,
   `bin`, `files`, `engines`, `optionalDependencies` pinned to `version` for
   exactly the platforms built this run, `publishConfig`, and a
   `nativeLauncher: {binary, selfUpdateCommand?}` block), `bin/launcher.js`
   (copied from this action, byte-identical across all consumers), `LICENSE`,
   and a generated `README.md`. Regenerating from identical inputs is
   byte-identical (fixed key order, trailing newline on every JSON file).
3. **Dry-run by default.** When `publish` is `"false"` (default), the action
   prints every generated `package.json` and an `npm pack --dry-run` listing
   for it, then stops without publishing or requiring `npm-token`.
4. **Publish and verify.** When `publish` is `"true"`, the action publishes
   every platform package, then the launcher, skipping any `name@version`
   that `npm view` already resolves (idempotent re-runs). It then verifies
   every package resolves on the public registry, retrying with exponential
   backoff for up to about two minutes to absorb npm propagation lag. A
   `npm view` failure that is not a confirmed "unpublished" response (404 /
   "is not in this registry" / "No match found") — a network error, a 5xx, an
   auth failure — is retried a bounded number of times and then fails loudly;
   it is never treated as "safe to publish". The `npm-token` input, when set,
   is available to every publish in the run, not only the first: npm prefers
   the OIDC exchange whenever the calling job has `permissions: id-token:
   write`, so a package with a trusted publisher already configured on
   npmjs.org publishes tokenlessly regardless of `npm-token`. The token only
   matters for a package that has no trusted publisher configured yet, e.g.
   its first publish. The OIDC contract (no `registry-url` on
   `actions/setup-node`, `npm install -g npm@11.6.2` before any
   publish-capable command) holds regardless of whether a token is supplied.
   When `npm-token` is empty and the calling job has no OIDC token request
   URL (`permissions: id-token: write` not granted), the action fails early
   with a clear `::error::` rather than attempting a publish that can never
   authenticate. The token is passed to the step that writes `.npmrc` via an
   environment variable, never interpolated into a `run:` script; that
   `.npmrc` is written to a runner-temp path (never `$HOME/.npmrc`), pointed
   at via `NPM_CONFIG_USERCONFIG` for the steps that run npm, and removed in
   a final `if: always()` step.
5. **Launcher process contract.** The installed binary command resolves
   `<name>-<platform>-<arch>/bin/<binary>[.exe]` via `require.resolve`,
   restricted to an own property of the launcher's `optionalDependencies` —
   an unsupported platform/arch or a supported-but-absent optional package
   both exit 1 with a clear, specific message and launch nothing. Otherwise
   the launcher is a transparent process boundary: it forwards every
   argument, inherits all three standard streams, mirrors a normal exit
   status, and re-raises a terminating signal. On non-`win32` hosts it makes
   one best-effort `chmod 0755` attempt before spawning; a chmod refusal is
   not fatal, a spawn failure is. If `nativeLauncher.selfUpdateCommand` is
   set and equals `argv[2]`, the launcher prints an "installed with npm;
   update with `npm install -g <name>@latest`" hint to stderr and exits 1
   without spawning anything.

## Acceptance Criteria

| ID | Criteria | Verification |
|----|----------|--------------|
| FR-001-AC-1 | Every admitted Rust target triple maps to exactly one npm os/cpu/(libc), and any other artifact-dir name is refused before any output is written. | Test (`generate.test.mjs`) |
| FR-001-AC-2 | Each binary's header is validated against its target's ELF/Mach-O/PE format; a mismatch is refused before any output is written. | Test (`generate.test.mjs`) |
| FR-001-AC-3 | An artifact target directory containing anything other than exactly one correctly named file, or an empty artifacts directory, is refused before any output is written. | Test (`generate.test.mjs`) |
| FR-001-AC-4 | Two built targets mapping to the same npm os/cpu pair are refused before any output is written. | Test (`generate.test.mjs`) |
| FR-001-AC-5 | Every generated platform `package.json` declares the exact release version, description, homepage, repository, license, matching `os`/`cpu`, `libc` for Linux gnu/musl targets and no `libc` key for darwin/win32, `files`, and `publishConfig`. | Test (`generate.test.mjs`) |
| FR-001-AC-6 | The launcher `package.json`'s `optionalDependencies` equals exactly one entry per target built this run, pinned to the release version, and `nativeLauncher.selfUpdateCommand` is present only when the input is non-empty. | Test (`generate.test.mjs`) |
| FR-001-AC-7 | Regenerating from identical inputs produces a byte-identical output tree. | Test (`generate.test.mjs`) |
| FR-001-AC-8 | A missing `LICENSE` file at the caller's workspace root is refused before any output is written. | Test (`generate.test.mjs`) |
| FR-001-AC-9 | The launcher resolves and spawns exactly the optional package for the current platform/arch, forwards argv, inherits stdin/stdout/stderr, and mirrors the child's exit status. | Test (`launcher.test.mjs`) |
| FR-001-AC-10 | An unsupported platform/arch exits 1, lists the generated supported set, and launches nothing. | Test (`launcher.test.mjs`) |
| FR-001-AC-11 | A supported but absent optional dependency package exits 1, names that exact package, and launches nothing. | Test (`launcher.test.mjs`) |
| FR-001-AC-12 | When `nativeLauncher.selfUpdateCommand` is set and matches `argv[2]`, the launcher prints the update hint, exits 1, and never spawns the binary. | Test (`launcher.test.mjs`) |
| FR-001-AC-13 | `out-dir` resolving to the workspace root, the filesystem root, `$HOME`, an ancestor of the workspace, or a path equal to or containing `artifacts-dir` is refused before any output is written. | Test (`generate.test.mjs`) |
| FR-001-AC-14 | Publishing publishes every platform package before the launcher package, since the launcher's `optionalDependencies` reference them at the release version. | Test (`publish.test.mjs`) |
| FR-001-AC-15 | A `name@version` that `npm view` already resolves is skipped rather than re-published. | Test (`publish.test.mjs`) |
| FR-001-AC-16 | Verification retries with exponential backoff until the package resolves, and fails with a clear error once the deadline passes. | Test (`publish.test.mjs`) |
| FR-001-AC-17 | A `npm view` failure other than a confirmed "unpublished" response (404 / "is not in this registry" / "No match found") is retried and then fails loudly; it is never treated as license to publish. | Test (`publish.test.mjs`) |
| FR-001-AC-18 | When `publish` is `"true"`, `npm-token` is empty, and the calling job has no OIDC token request URL, the action fails early with a clear `::error::` naming the missing `permissions: id-token: write`, before attempting any publish. | Manual (composite-action step; see `action.yml`) |

## Dependencies

- **Upstream**: none — this is a leaf composite action within `nodejs-actions`.
- **Downstream**: per-repo release workflows (e.g. `agent-ix/quoin`) call
  `agent-ix/nodejs-actions/publish-native-npm@main` instead of maintaining
  their own copy of quire-cli's distribution tooling.

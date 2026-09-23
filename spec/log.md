---
type: log
title: "Update Log"
description: "Chronological log of structural changes to this bundle."
---
# Update Log

## History

* **2026-09-23** — Added [FR-001](./functional/FR-001-publish-native-npm-action.md)
  and the `publish-native-npm/` composite action: publishes a prebuilt native
  (Rust) CLI to public npmjs as a launcher package plus per-platform binary
  packages, validating each binary's target directory name and header before
  writing any output. It is the org's shared, generic replacement for
  `agent-ix/quire-cli`'s repo-local `tools/quire-dist` and
  `npm/quire-cli/bin/quire.js` — no files were copied between the repos; the
  behavior was read from `quire-cli` and reimplemented generically, driven
  entirely by action inputs (`package`, `binary`, `version`, `repository`,
  `license`, `description`, `self-update-command`, etc.), with an added
  `libc` (`glibc`/`musl`) distinction the quire-cli tooling never needed.

* **2026-06-15** — Adopted OKF-compatible bundle structure with directory indexes.

# Node.js Actions

[![Discord](https://img.shields.io/badge/Discord-Join%20us-5865F2?logo=discord&logoColor=white)](https://discord.gg/6qsdhSPE)

Reusable GitHub workflows and composite actions for Node.js / TypeScript
repos in the agent-ix ecosystem.

Two entry-point workflows, picked by repo type:

| Workflow | Use for | Docker? |
|---|---|---|
| `build-test.yml` | Libraries (npm-only publish) | No — bare pnpm |
| `build-test-app.yml` | Apps (runtime image + Helm chart) | Yes |

Libs are the common case. Apps are only the handful that ship a k8s
deployment.

---

## `build-test.yml` — library CI (non-docker)

Parallel `test` and `lint` status checks plus `publish`. Each job runs
`make install` then `make test`/`make lint`/`make build`+publish against a
shared pnpm store cache. No Docker image is built.

**Jobs:**
1. `test` — `make install && make test`
2. `lint` — `make install && make lint`
3. `publish` — `make install && make build`, then npm publish with
   PR dist-tag (`pr-N`) on PRs or `latest` on tags. Auto-bumps patch
   if the resolved version is already published, idempotent on races.

**Inputs:**

| Name | Required | Default |
|---|---|---|
| `node_version` | No | `20` |
| `npm_registry` | No | `https://npm.pkg.github.com` |

**Secrets:**

| Name | Required |
|---|---|
| `NPM_REGISTRY_TOKEN` | Yes |

**Example:**

```yaml
name: CI
on:
  push:
    tags: ['*.*.*']
  workflow_dispatch:

jobs:
  ci:
    uses: agent-ix/nodejs-actions/.github/workflows/build-test.yml@main
    secrets:
      NPM_REGISTRY_TOKEN: ${{ secrets.REGISTRY_TOKEN }}
```

Version resolution uses the git tag when checked out on one (clean tree);
otherwise falls back to `make version`.

---

## `build-test-app.yml` — app CI (docker + Helm)

Builds a Docker runtime image, optionally packages and pushes an OCI Helm
chart, runs `test`/`eslint`/`prettier` inside the image, then publishes
npm + image. Used by apps whose deploy artifact is a container image.

**Inputs:**

| Name | Required | Default |
|---|---|---|
| `docker_repository` | Yes | — |
| `docker_registry` | No | `ghcr.io` |
| `npm_registry` | No | `https://npm.pkg.github.com` |
| `helm_chart_path` | No | `""` (no chart published) |
| `helm_chart_registry` | No | `ghcr.io` |
| `helm_chart_repository` | No | `""` |

**Secrets:** `DOCKER_REGISTRY_USER`, `DOCKER_REGISTRY_PASSWORD`,
`NPM_REGISTRY_TOKEN`.

**Example:**

```yaml
jobs:
  ci:
    uses: agent-ix/nodejs-actions/.github/workflows/build-test-app.yml@main
    with:
      docker_repository: ${{ github.repository }}
      helm_chart_path: helm
      helm_chart_repository: agent-ix/my-app
    secrets:
      DOCKER_REGISTRY_USER: ${{ github.actor }}
      DOCKER_REGISTRY_PASSWORD: ${{ secrets.REGISTRY_TOKEN }}
      NPM_REGISTRY_TOKEN: ${{ secrets.REGISTRY_TOKEN }}
```

---

## Composite actions

### `setup-npmrc`
Writes a CI `.npmrc` scoping `@agent-ix` at the configured registry with
an auth token. Used by `build-test.yml` jobs before `make install`.

Inputs: `npm_registry` (default `https://npm.pkg.github.com`),
`npm_registry_token` (required).

### `image-metadata`, `test`, `eslint`, `prettier`, `publish`
Used internally by `build-test-app.yml`. Pull a dev Docker image and run
the named command inside it, plus image-metadata for version resolution
and publish for npm release. Not intended for direct use by repos; call
`build-test-app.yml` instead.

### `publish-native-npm`
Publishes a prebuilt native (Rust) CLI to public npmjs as a launcher package
plus one per-platform binary package per built target. This is the org's
shared, generic replacement for `agent-ix/quire-cli`'s repo-local
`tools/quire-dist` and `npm/quire-cli/bin/quire.js` — every project-specific
detail (package name, binary name, repository, license, description) comes
from inputs.

The caller is responsible for building the native binaries first (one Rust
target triple per subdirectory of `artifacts-dir`) and for providing a
`LICENSE` file at the repository root.

**Inputs:**

| Name | Required | Default | Description |
|---|---|---|---|
| `package` | Yes | — | Launcher package name, e.g. `@agent-ix/quoin`. Platform packages are named `<package>-<os>-<cpu>`. |
| `binary` | Yes | — | Binary name, e.g. `quoin`. On win32 the file is `<binary>.exe`. |
| `version` | Yes | — | Release version, `X.Y.Z` with no leading `v`. |
| `artifacts-dir` | No | `artifacts` | Directory containing only subdirectories named by Rust target triple, each holding exactly one file, `<binary>` or `<binary>.exe`. |
| `repository` | Yes | — | GitHub `owner/repo`, e.g. `agent-ix/quoin`. Used for `homepage` and `repository.url`. |
| `license` | No | `AGPL-3.0-or-later` | SPDX identifier written into every generated `package.json`. A `LICENSE` file is also required at `$GITHUB_WORKSPACE/LICENSE` and is copied into every package. |
| `description` | Yes | — | Description written into the launcher `package.json`. |
| `self-update-command` | No | `""` | When set, the launcher intercepts this subcommand and prints an "update with npm" hint instead of spawning the binary. |
| `publish` | No | `"false"` | When `"false"`, generate packages and print manifests + `npm pack --dry-run` listings, then stop. Set `"true"` to actually publish. |
| `npm-token` | No | `""` | npm auth token, available to every publish in the run. npm prefers the OIDC exchange when the calling job has `permissions: id-token: write`, so trusted-publisher packages publish tokenlessly regardless of this input; it only matters for a package without a trusted publisher yet, e.g. its first publish. When empty, the calling job must grant `permissions: id-token: write` or the publish step fails early. |
| `out-dir` | No | `npm-dist` | Directory to write the generated packages into. Refused if it resolves to the workspace root, `/`, `$HOME`, an ancestor of the workspace, or a path equal to or containing `artifacts-dir`. |

Supported Rust targets: `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`,
`x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl`,
`aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-pc-windows-msvc`.

`artifacts-dir` must contain only subdirectories named by Rust target triple,
each holding exactly one file, `<binary>` or `<binary>.exe`, so an artifact
download step that lands files elsewhere (e.g. one subdirectory per uploaded
artifact name) must be normalized into that shape first.

**Example** (`workflow_dispatch` on a release tag, downloading the built
binaries from the matching GitHub Release):

```yaml
name: Publish native npm package

on:
  workflow_dispatch:
    inputs:
      tag:
        description: "Release tag to publish, e.g. v1.2.3"
        required: true

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Resolve version from tag
        id: version
        env:
          TAG: ${{ inputs.tag }}
        run: echo "version=${TAG#v}" >> "$GITHUB_OUTPUT"

      - name: Download release assets
        env:
          GH_TOKEN: ${{ github.token }}
          TAG: ${{ inputs.tag }}
        run: gh release download "$TAG" --repo agent-ix/quoin --pattern 'quoin-*.tar.gz' --dir release-assets

      - name: Normalize into artifacts/<rust-target>/<binary>
        run: |
          set -euo pipefail
          for asset in release-assets/quoin-*.tar.gz; do
            target=$(basename "$asset" .tar.gz)
            target=${target#quoin-}
            mkdir -p "artifacts/$target"
            tar -xzf "$asset" -C "artifacts/$target"
          done

      - uses: agent-ix/nodejs-actions/publish-native-npm@main
        with:
          package: "@agent-ix/quoin"
          binary: quoin
          version: ${{ steps.version.outputs.version }}
          repository: agent-ix/quoin
          description: "The quoin CLI"
          self-update-command: update
          publish: "true"
          npm-token: ${{ secrets.NPM_TOKEN }}
```

Each release asset here is assumed to be named `quoin-<rust-target>.tar.gz`
and to extract to a single `quoin`/`quoin.exe` file — adjust the download and
normalize steps to match how your own release workflow names and shapes its
assets. `permissions: id-token: write` is required on the calling job:
without it, and without `npm-token`, the action fails fast rather than
attempting a publish that can never authenticate.

---

## Versioning

The repo is tagged with floating major tags (e.g. `v2`). `@main` tracks
latest; pin to `@v2` if you need to insulate against future breaking
changes.

Consumer-side version is computed by the `publish` job:
- On an exact git tag with a clean tree → that tag
- Otherwise → `make version` from the consumer repo (semver with
  commit metadata, e.g. `0.2.7-20260419.163812-abc123.xyz`)

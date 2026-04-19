# Node.js Actions

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

---

## Versioning

The repo is tagged with floating major tags (e.g. `v2`). `@main` tracks
latest; pin to `@v2` if you need to insulate against future breaking
changes.

Consumer-side version is computed by the `publish` job:
- On an exact git tag with a clean tree → that tag
- Otherwise → `make version` from the consumer repo (semver with
  commit metadata, e.g. `0.2.7-20260419.163812-abc123.xyz`)

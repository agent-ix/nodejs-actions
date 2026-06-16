---
type: master-requirements
name: nodejs-actions
org: agent-ix
component_type: github-actions
implementation_language: none
depends_on: []
standards_alignment: []
---

# Master Requirements Specification

## Overview

Node.js Actions provides reusable GitHub Actions for Node.js build, test, and publish workflows.

## Purpose

`nodejs-actions` is the shared CI toolkit for Node.js and TypeScript repositories in the agent-ix ecosystem. It exists to eliminate per-repo CI boilerplate by providing a small set of reusable callable GitHub Actions workflows and composite actions that standardize how libraries and applications are built, tested, linted, and published. Consuming repos reference these workflows (e.g. `uses: agent-ix/nodejs-actions/.github/workflows/build-test.yml@main`) and gain consistent test/lint status checks, deterministic version resolution from git tags or `make version`, idempotent npm publishing with PR dist-tags, and—for apps—Docker runtime image and OCI Helm chart packaging. The purpose is to make CI behavior uniform, centrally maintainable, and version-pinnable across dozens of downstream repositories.

## Scope

This specification covers the reusable workflows and composite actions published from this repository:

- **Callable workflows**: `build-test.yml` (library, non-docker CI: parallel `test`/`lint` jobs plus npm `publish`), `build-test-app.yml` (application CI: Docker runtime image, optional OCI Helm chart, in-image `test`/`eslint`/`prettier`, then npm + image publish), `build-test-monorepo.yml`, and `security-scan.yml`.
- **Composite actions**: `setup-npmrc` (writes a CI `.npmrc` scoping `@agent-ix` to the configured registry), `image-metadata` (generates `image.json` for the dev container and resolves tags), and the in-image runners `test`, `eslint`, `prettier`, and `publish`.

Out of scope: the build logic of consumer repositories themselves (each repo owns its `make install`/`make test`/`make lint`/`make build`/`make version` targets and Dockerfile), the registries and clusters these actions target, and any non-Node.js CI tooling.

## System Overview

The repository ships GitHub Actions artifacts only; there is no local build or runtime. Consumers invoke an entry-point workflow chosen by repo type:

- **Libraries** call `build-test.yml`, which runs `test` and `lint` as parallel status checks and a `publish` job. Each job calls `setup-npmrc` then `make install`, followed by `make test`/`make lint`/`make build`, against a shared pnpm store cache. No Docker image is built. The `publish` job resolves the version from an exact, clean git tag or otherwise from `make version`, then npm-publishes with a `pr-N` dist-tag on PRs or `latest` on tags, auto-bumping the patch level if the version is already published (idempotent on races).
- **Applications** call `build-test-app.yml`, which uses `image-metadata` to produce `image.json`, builds a Docker dev/runtime image, optionally packages and pushes an OCI Helm chart, runs the `test`/`eslint`/`prettier` composite actions inside the image, and finally publishes to npm and the image registry.

Inputs are typed workflow inputs (e.g. `node_version`, `npm_registry`, `docker_repository`, `helm_chart_path`); credentials are passed as secrets (`NPM_REGISTRY_TOKEN`, `DOCKER_REGISTRY_USER`, `DOCKER_REGISTRY_PASSWORD`). The repo is tagged with floating major tags (e.g. `v2`); `@main` tracks latest while `@vN` insulates consumers from breaking changes.

## Requirements Architecture

Requirements for this component are organized into the following classes:

- **Functional Requirements (FR)**: behavior of the callable workflows and composite actions — job graph, input/secret contracts, version resolution, dist-tag selection, idempotent publish, image and Helm chart packaging.
- **Non-Functional Requirements (NFR)**: CI reliability and idempotency (safe re-runs and race handling), build performance via the shared pnpm store cache, and supply-chain/security constraints (registry scoping, token handling, `security-scan.yml`).
- **Stakeholder Requirements (StR)**: needs of consumer-repo maintainers for low-boilerplate, centrally maintained, version-pinnable CI consistent across the ecosystem.

Detailed requirement artifacts live alongside this master specification under `spec/` and are traceable to the workflows and actions described in the System Overview.

## References

- Repository README: `nodejs-actions/README.md` — workflow catalog, inputs, secrets, and usage examples.
- Callable workflows: `.github/workflows/build-test.yml`, `.github/workflows/build-test-app.yml`, `.github/workflows/build-test-monorepo.yml`, `.github/workflows/security-scan.yml`.
- Composite actions: `setup-npmrc/action.yml`, `image-metadata/action.yml`, `test/action.yml`, `eslint/action.yml`, `prettier/action.yml`, `publish/action.yml`.
- GitHub Actions reusable workflows documentation: <https://docs.github.com/actions/using-workflows/reusing-workflows>.

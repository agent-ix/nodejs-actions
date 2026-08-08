# nodejs-actions

Reusable GitHub Actions workflows. No local build or deploy.

## Commands

```bash
make test    # run workflow tests (if available)
make lint    # lint check
```

## npm publishing

All `@agent-ix` npm publishing goes through public npm via tokenless OIDC Trusted
Publishing. Three reusable workflows own it — `release.yml` (TS packages),
`release-monorepo.yml`, and `release-npm-module.yml` (data-only Filament module
repos: `spec-artifacts-*`, `spec-objects-*`). Callers stay thin; never inline a
publish job in a consumer repo.

A publish workflow is **broken** if it sets `NODE_AUTH_TOKEN` **or** omits
`npm install -g npm@latest`. Either alone is fatal:

- `actions/setup-node`'s `registry-url` writes an `.npmrc` with
  `_authToken=${NODE_AUTH_TOKEN}`, and that line makes npm authenticate by token
  instead of performing the OIDC exchange.
- setup-node ships npm 10.x, which has no Trusted Publishing support at all
  (needs >= 11.5.1).

Sweep for divergence — publishing must stay centralized, so nothing outside this
repo should inline a publish step:

```bash
grep -l "npm publish\|pnpm publish" ~/dev/*/.github/workflows/*.yml | grep -v nodejs-actions
```

Expected output is exactly two known exceptions, both Rust repos that cannot use a
Node reusable: `quire-wasm` (wasm-pack) and `quire-cli` (per-platform binaries).
Anything else in that list is a repo that has drifted and will break the next time
npm's publish contract changes.

`provenance=false` is required in the npmrc — agent-ix repos are private, where npm
cannot generate provenance attestations.

**A green release run is not proof of publication.** Always confirm with
`npm view @agent-ix/<pkg> versions`. In August 2026 all eight module repos were
silently unable to publish for six weeks; six of them had never even been
dispatched, so nothing went red to signal it.

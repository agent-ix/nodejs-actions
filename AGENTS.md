# nodejs-actions

Reusable GitHub Actions workflows. No local build or deploy.

## Commands

```bash
make test    # run workflow tests (if available)
make lint    # lint check
```

## npm publishing

There are **two** publishing targets and both are correct. Which one applies is decided
by repo visibility:

- **Public repos → public npmjs**, tokenless via OIDC Trusted Publishing.
  17 repos publish this way: `ix-cli`, `ix-cli-core`, `ix-flow`, `ix-ui`, `quire`,
  `quire-cli`, `quire-wasm`, `quoin`, `ts-plugin-kit`, and the 8 data-only Filament
  module repos (`spec-artifacts-*`, `spec-objects-*`).
- **Everything else → GitHub Packages** (`npm.pkg.github.com`) with
  `NPM_TOKEN`/`NPM_REGISTRY_TOKEN`. This is the large majority of repos.

A token-based publish is a bug **only** in a repo that targets `registry.npmjs.org`.
Do not "migrate" GitHub Packages repos to OIDC — they are working as intended.

### The OIDC contract (public-npm publishers only)

Four things must all hold. Any one of them missing breaks the publish:

- **No `NODE_AUTH_TOKEN`** in the publish step's env.
- **No `registry-url` on `actions/setup-node`.** It writes an `.npmrc` containing
  `_authToken=${NODE_AUTH_TOKEN}`, and that line makes npm authenticate by token
  instead of performing the OIDC exchange.
- **`npm install -g npm@latest`.** setup-node ships npm 10.x, which has no Trusted
  Publishing support at all; OIDC needs >= 11.5.1.
- **`provenance=false`** in the npmrc. Every publish proven to work sets it. Turning
  provenance on is a separate, deliberate change — not a cleanup.

Failure signature when the contract is broken: `npm error 404 Not Found - PUT` against
a package that plainly exists. That is npm rejecting an unauthorized write, not a
missing package.

Publishing is owned by three reusable workflows here — `release.yml` (TS packages),
`release-monorepo.yml`, and `release-npm-module.yml` (data-only module repos). Callers
stay thin; do not inline a publish job in a consumer repo.

### Sweeps

Which repos target public npmjs:

```bash
grep -l "registry.npmjs.org" ~/dev/*/.github/workflows/*.yml | cut -d/ -f1 | sort -u
```

Who has inlined a publish instead of calling a reusable:

```bash
grep -l "npm publish\|pnpm publish" ~/dev/*/.github/workflows/*.yml | grep -v nodejs-actions
```

Expect exactly two hits: `quire-wasm` (wasm-pack) and `quire-cli` (per-platform
binaries) — Rust repos that cannot use a Node reusable. Anything else has drifted.

### A green run is not proof of publication

Always confirm with `npm view @agent-ix/<pkg> versions`. In August 2026 all eight module
repos were silently unable to publish for six weeks; six had never even been dispatched,
so nothing went red to signal it.

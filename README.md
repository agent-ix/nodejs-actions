# 🛠 Node.js Actions

> Composite GitHub Actions and workflows for Node.js/TypeScript projects. Supports containerized testing, linting, formatting, version tagging, and publishing.

---

## 📦 Composite Actions

### 🧾 `image-metadata`
**Path:** `image-metadata/action.yml`

Generates `image.json` metadata including tag and description from project state.

**Inputs:**
| Name               | Description                              | Required | Default      |
|--------------------|------------------------------------------|----------|--------------|
| `docker_repository`| Docker image repository (e.g., org/pkg)  | ✅        | —            |
| `docker_registry`  | Docker registry host                     | ❌        | `ghcr.io`    |
| `artifact`         | Output filename                          | ❌        | `image.json` |
| `github_token`     | GitHub token for authentication          | ✅        | —            |

**Outputs:**
| Name         | Description               |
|--------------|---------------------------|
| `version`    | Resolved version          |
| `url`        | Fully qualified image URL |
| `image`      | Image path without tag    |

**Behavior:**
- Runs `make version` to compute semver-compatible tag
- Reads `.description` from `package.json`
- Constructs metadata JSON via `docker-actions/create-metadata`

---

### ✅ `jest`
**Path:** `jest/action.yml`

Runs tests using Jest inside a Docker container using a previously-built image.

**Inputs:**
| Name                      | Description                           | Required | Default       |
|---------------------------|---------------------------------------|----------|---------------|
| `docker_registry_user`    | Docker registry username              | ✅        | —             |
| `docker_registry_password`| Docker registry password              | ✅        | —             |
| `artifact`                | Path to image.json                    | ❌        | `image.json`  |

**Behavior:**
- Pulls dev image from registry
- Runs `pnpm jest` in container
- Uploads `jest.txt` and adds step summary

---

### 🧹 `eslint`
**Path:** `eslint/action.yml`

Runs ESLint inside the service container.

**Inputs:**
| Name                      | Description                           | Required | Default       |
|---------------------------|---------------------------------------|----------|---------------|
| `docker_registry_user`    | Docker registry username              | ✅        | —             |
| `docker_registry_password`| Docker registry password              | ✅        | —             |
| `artifact`                | Path to image.json                    | ❌        | `image.json`  |

**Behavior:**
- Pulls dev image from registry
- Runs `pnpm eslint` in container
- Uploads `eslint.txt` and adds step summary

---

### 🎨 `prettier`
**Path:** `prettier/action.yml`

Checks code formatting using Prettier inside the container.

**Inputs:**
| Name                      | Description                           | Required | Default       |
|---------------------------|---------------------------------------|----------|---------------|
| `docker_registry_user`    | Docker registry username              | ✅        | —             |
| `docker_registry_password`| Docker registry password              | ✅        | —             |
| `artifact`                | Path to image.json                    | ❌        | `image.json`  |

**Behavior:**
- Pulls dev image from registry
- Runs `pnpm prettier --check .` in container
- Uploads `prettier.txt` and adds step summary

---

### 🚀 `publish`
**Path:** `publish/action.yml`

Publishes the Node.js package using the version from `image.json`.

**Inputs:**
| Name                      | Description                           | Required | Default                      |
|---------------------------|---------------------------------------|----------|------------------------------|
| `artifact`                | Path to image.json                    | ✅        | —                            |
| `docker_registry_user`    | Docker registry username              | ✅        | —                            |
| `docker_registry_password`| Docker registry password              | ✅        | —                            |
| `npm_registry`            | NPM registry URL                      | ❌        | `https://npm.pkg.github.com` |
| `npm_registry_token`      | NPM auth token                        | ✅        | —                            |
| `github_token`            | GitHub token for API calls            | ✅        | —                            |

**Behavior:**
- Pulls dev image from Docker registry
- Resolves version from image metadata
- Gets PR number for dist-tag
- Publishes via `npm publish` with resolved version
- Adds PR dist-tag if applicable

---

## 📋 Workflows

### 🧪 `build-test.yml`
**Path:** `.github/workflows/build-test.yml`

Complete CI workflow for Node.js projects.

**Inputs:**
| Name               | Description                            | Required | Default                      |
|--------------------|----------------------------------------|----------|------------------------------|
| `docker_repository`| Docker image repository                | ✅        | —                            |
| `docker_registry`  | Docker registry host                   | ❌        | `ghcr.io`                    |
| `npm_registry`     | NPM registry URL                       | ❌        | `https://npm.pkg.github.com` |

**Secrets:**
| Name                      | Description                   | Required |
|---------------------------|-------------------------------|----------|
| `DOCKER_REGISTRY_USER`    | Docker registry username      | ✅        |
| `DOCKER_REGISTRY_PASSWORD`| Docker registry password      | ✅        |
| `NPM_REGISTRY_TOKEN`      | NPM registry auth token       | ✅        |
| `GITHUB_TOKEN`            | GitHub token for API calls    | ✅        |

**Jobs:**
1. **metadata** - Generate image.json
2. **build** - Build Docker image
3. **jest** - Run tests
4. **eslint** - Run linting
5. **prettier** - Check formatting
6. **publish** - Publish to npm registry

---

## 🧠 Versioning

Version is derived from Git via:
```bash
make version
```

It must output a valid semver string like `1.2.3+4.gabc123`.
This is used in:
- image.json
- Docker tags
- npm package version

---

## 🚀 Example Usage

```yaml
name: NodeJS CI/CD

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build-test:
    uses: agent-ix/nodejs-actions/.github/workflows/build-test.yml@main
    with:
      docker_repository: ${{ github.repository }}
      # docker_registry: ghcr.io  (default)
      # npm_registry: https://npm.pkg.github.com  (default)
    secrets:
      DOCKER_REGISTRY_USER: ${{ github.actor }}
      DOCKER_REGISTRY_PASSWORD: ${{ secrets.REGISTRY_TOKEN }}
      NPM_REGISTRY_TOKEN: ${{ secrets.REGISTRY_TOKEN }}
      GITHUB_TOKEN: ${{ secrets.REGISTRY_TOKEN }}
```

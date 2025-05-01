# 🛠 Node.js Actions

> Composite GitHub Actions and workflows for Node.js/TypeScript projects. Supports containerized testing, linting, formatting, version tagging, and publishing.

---

## 📦 Composite Actions

### 🧾 `image-metadata`
**Path:** `image-metadata/action.yml`

Generates `image.json` metadata including tag and description from project state.

**Inputs:**
| Name       | Description                              | Required | Default      |
|------------|------------------------------------------|----------|--------------|
| `image`    | Image name (e.g., org/pkg)               | ✅        | —            |
| `registry` | Docker registry (e.g., ghcr.io)          | ❌        | `ghcr.io`    |
| `artifact` | Output filename                          | ❌        | `image.json` |

**Outputs:**
| Name         | Description               |
|--------------|---------------------------|
| `image_tag`  | Resolved image tag value  |

**Behavior:**
- Runs `make version` to compute semver-compatible tag
- Reads `.description` from `package.json`
- Constructs metadata JSON:
  - `tag`, `image`, `url`, `version`, `description`, `registry`, `repository`, `source`

---

### ✅ `jest`
**Path:** `jest/action.yml`

Runs tests using Jest inside a Docker container using a previously-built image.

**Inputs:**
| Name           | Description                       | Required | Default       |
|----------------|-----------------------------------|----------|---------------|
| `artifact`     | Path to image.json                | ✅        | —             |
| `test_command` | Command inside container          | ❌        | `pnpm test`   |

**Behavior:**
- Pulls and runs container
- Executes tests in project directory
- Uploads `jest.json` with dummy result and adds summary

---

### 🧹 `eslint`
**Path:** `eslint/action.yml`

Runs ESLint inside the service container.

**Inputs:**
| Name           | Description                       | Required | Default       |
|----------------|-----------------------------------|----------|---------------|
| `artifact`     | Path to image.json                | ✅        | —             |
| `lint_command` | ESLint command                    | ❌        | `pnpm lint`   |

**Behavior:**
- Pulls container
- Runs ESLint with provided command
- Writes lint output to `eslint.json` and step summary

---

### 🎨 `prettier`
**Path:** `prettier/action.yml`

Formats code using Prettier inside the container.

**Inputs:**
| Name               | Description                      | Required | Default            |
|--------------------|----------------------------------|----------|--------------------|
| `artifact`         | Path to image.json               | ✅        | —                  |
| `format_command`   | Prettier command                 | ❌        | `pnpm format`      |

**Behavior:**
- Runs container with formatting command
- Output goes to summary and `prettier.json` result

---

### 🚀 `publish`
**Path:** `publish/action.yml`

Publishes the Node.js package using the version from `image.json`.

**Inputs:**
| Name           | Description                          | Required | Default       |
|----------------|--------------------------------------|----------|---------------|
| `artifact`     | Path to image.json                   | ✅        | —             |
| `registry`     | Registry (e.g., https://npm.pkg...) | ❌        | —             |
| `token`        | Auth token (e.g., NPM_TOKEN)         | ✅        | —             |

**Behavior:**
- Reads tag from metadata
- Publishes via `npm publish` with correct tag

---

## 📋 Workflows

### 🧪 `build-test.yml`
**Path:** `.github/workflows/build-test.yml`

**Inputs:**
| Name       | Description                            | Required | Default     |
|------------|----------------------------------------|----------|-------------|
| `image`    | Docker image name (`org/myapp`)        | ✅        | —           |
| `registry` | Docker registry (e.g. `ghcr.io`)        | ❌        | `ghcr.io`   |
| `npm`    | npm registry        | ✅        | —           |

**Secrets:**
| Name               | Description                   | Required |
|--------------------|-------------------------------|----------|
| `REGISTRY_USER`    | Docker registry username       | ✅        |
| `REGISTRY_PASSWORD`| Docker registry password       | ✅        |
| `NPM_TOKEN`        | Token for npm publish          | ✅        |

**Behavior:**
- Generates `image.json` using `image-metadata`
- Builds Docker image with external `build-image` action
- publishes package to npm
- Runs:
  - Jest tests via `jest` action
  - Linting via `eslint` action
  - Code formatting via `prettier` action


**Path:** `.github/workflows/release.yml`

**Inputs:**
| Name       | Description                    | Required | Default       |
|------------|--------------------------------|----------|----------------|
| `artifact` | Name of image metadata file   | ✅        | `image.json`   |

- Uses `pnpm` and GitHub’s npm registry by default
- Runs:
  1. Docker image build + push (delegated)
  2. `publish` with resolved tag from `image.json`

- Requires `artifact`
- Runs:
  1. Docker image build + push (external)
  2. `publish` with npm token

---

## 🔐 Required Secrets

| Secret       | Required By | Purpose                 |
|--------------|-------------|-------------------------|
| `NPM_TOKEN`  | publish     | Publish to npm registry |

All secrets must be passed via workflow `env:` blocks.

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

jobs:
  build-test:
    uses: org/nodejs-actions/.github/workflows/build-test.yml@main
    with:
      image: org/my-app
      registry: ghcr.io
    secrets:
      REGISTRY_USER: ${{ secrets.REGISTRY_USER }}
      REGISTRY_PASSWORD: ${{ secrets.REGISTRY_PASSWORD }}
      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

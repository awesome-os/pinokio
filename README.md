# `@awesome-os/pinokio`

**Pinokio Virtual PC recipe runner re-engineered on Awesome-OS `b8g-ghost @ cas-v1`, Sectium Display, and our shared debloated Python LLM stack.**

Run original Pinokio community recipes (`install.json`, `start.json`, `pinokio.json`, `install.js`, `start.js`) with **zero `250 MB` Electron monolith** and **zero `10 GB × N apps` conda environment duplication**.

---

## Quick Install & Usage

### Install via `pnpm` (or release tarball)

```powershell
pnpm add github:awesome-os/pinokio
```

Or download the latest SHA-256 verified archive from [`Releases`](https://github.com/awesome-os/pinokio/releases/latest).

### Usage & Verification

```powershell
# Inspect or dry-run a Pinokio recipe with live b8g-ghost cas-v1 interception
node src/cli.mts inspect examples/llm-app/install.json
node src/cli.mts run examples/llm-app/install.json --dry-run

# Verify locally (Node.js 22+)
node --test
```

---

## Comparison: Legacy Pinokio vs. Awesome-OS Pinokio

| Dimension | Legacy Pinokio | `@awesome-os/pinokio` |
| :--- | :--- | :--- |
| **Desktop Shell** | Bundled `250 MB` Electron + Chromium monolith | **0 MB** — routes UI over Sectium Device Pipe (`\\.\pipe\sectium-dev` / `/tmp/sectium-dev.sock`) |
| **Python / LLM Stack** | `10 GB × N apps` duplicated Conda/venv environments | **Shared `b8g-ghost @ cas-v1` CAS wheels** (`~/.b8g/cas/wheels/<sha256>`) |
| **Native ABI Bridge** | Per-app compiled extensions & ad-hoc IPC | Shared `b8g-ghost-abi` (`B8G_ARENA_V1`) zero-copy N-API addon |
| **Control Plane IPC** | Loopback `127.0.0.1:42000` HTTP server | Dual orthogonal NDJSON channels (`command` + `display`) over OS Pipe |
| **Recipe Compatibility** | Pinokio `run: [...]` JSON/JS recipes | **100% compatible** with original Pinokio `run: [...]` recipes (`shell.run`, `local.set`, `fs.download`, `notify`, `log`, `script.start`) |
| **Build Overhead** | Webpack/TypeScript emit pipeline | Direct erasable TypeScript (`erasableSyntaxOnly: true`, `noEmit: true`) on Node 22+/24+ |

---

## Intercepted `b8g-ghost @ cas-v1` Python LLM Stack

Every `pip install` and `conda install` command inside a Pinokio recipe's `shell.run` step is automatically intercepted by [`src/cas-interceptor.mts`](src/cas-interceptor.mts) against the live `awesome-os/b8g-ghost` CAS manifest (`manifests/index.json` → `cas-v1` SHA-256 release blobs):

- `pillow` (including `PIL` alias)
- `numpy`
- `safetensors`
- `tokenizers`
- `tiktoken`
- `pydantic-core` (including `pydantic_core`)
- `orjson`
- `cryptography`
- `lxml`
- Plus platform-matched `b8g-ghost-abi` (`B8G_ARENA_V1`) N-API addon (`win64`, `linux-x64`, `linux-arm64`, `macos-arm64`)

Packages not yet in `cas-v1` cleanly pass through in `rewrittenCommand` while CAS-matched packages hydrate once into `~/.b8g/cas/wheels/<sha256>/` with strict SHA-256 verification.

---

## Quickstart

```bash
# Check version
node src/cli.mts --version

# Inspect a Pinokio recipe against live b8g-ghost cas-v1
node src/cli.mts inspect examples/llm-app/install.json

# Dry-run a Pinokio recipe with live CAS interception
node src/cli.mts run examples/llm-app/install.json --dry-run

# Run full test suite
node --test test/pinokio-recipe.test.mts
```

---

## Architecture

- [`src/cas-interceptor.mts`](src/cas-interceptor.mts) — Fetches `awesome-os/b8g-ghost` `manifests/index.json`, resolves `pypi-llm-stack` + `b8g-ghost-abi`, exports `interceptPipCommand(cmd, index)` and `hydrateCasWheel(entry)`.
- [`src/recipe-runner.mts`](src/recipe-runner.mts) — Pinokio `run: [...]` recipe engine (`shell.run`, `local.set`, `fs.download`, `notify`, `log`, `script.start`) with `{{local.x}}` template interpolation and automatic `cas-v1` interception.
- [`src/sectium-surface.mts`](src/sectium-surface.mts) — Power-Button Sectium Host Device Pipe client (`\\.\pipe\sectium-dev` / `/tmp/sectium-dev.sock`) emitting dual `command` + `display` NDJSON frames and HTML5 `<b8g-sectium-*>` Web Component bindings.
- [`src/cli.mts`](src/cli.mts) — Zero-dependency CLI (`pinokio run`, `pinokio inspect`, `pinokio --version`).

## License

MIT — see [LICENSE](LICENSE).

# StellarCode v0.4

> **A living map of your codebase.** Humans explore the universe; AI agents query the map before reading source.

This package contains the runnable **M0–M3 MVP plus the v0.4 Universe UX/architecture rewrite**, and preserves the original design/spec/mockup pack under `design-pack/`.

## v0.4 highlights

- **Galaxy → Module → File** navigation instead of rendering every file at once.
- **Graph-on-demand**: no global dependency spiderweb; edges appear on Focus/Impact only.
- Cross-module dependencies become contextual **external satellites**.
- Deterministic architecture roles: App Entry, Module Entry, Domain Core, Service, UI, Infrastructure, Test, Config, Docs, Source.
- `package.json`/framework-aware application-entry hints.
- `stellar architecture` CLI command.
- `stellar_architecture` MCP tool.
- Architecture queries no longer treat every nested `index.ts` as an application entry.
- Installed CLI hides only the noisy Node 22 `node:sqlite` ExperimentalWarning.
- Existing StellarCode project IDs and databases remain compatible.

See `docs/V0.4_RELEASE.md` and `docs/V0.4_UI_QA.md`.

## M0 — Foundation

- Cross-platform application data path adapter (macOS/Linux/Windows).
- Stable repo identity in `.stellar/project.json`.
- Global registry DB + isolated per-project `index.db`.
- Idempotent `stellar init`, dry-run, optional agent-rule installer.
- Three-OS GitHub Actions CI matrix.

## M1 — Repository index engine

- TypeScript, JavaScript and Python source indexing.
- Ignore rules, binary/size filtering, SHA-256 content state.
- Deterministic symbol/import extraction with no LLM/API key.
- Import/test/reference graph + reverse dependencies.
- Git HEAD/status/activity and rename hints.
- Incremental add/modify/delete sync.
- Importance scoring.
- Git-clean fast path for warm queries.
- **Zero-token maintenance**.

## M2 — Universe UI

- Local-only HTTP server (`127.0.0.1`).
- Galaxy-first hierarchical navigation.
- Canvas starfield and deterministic layout.
- Search, breadcrumbs, zoom/pan, floating inspector.
- Architecture role visual language.
- Focus mode and cross-module external satellites.
- Bounded Impact mode.
- Changes view.

## M3 — AI Gateway

MCP tools:

```text
stellar_search
stellar_file
stellar_symbol
stellar_related
stellar_impact
stellar_context
stellar_architecture
```

Responses contain indexed metadata and line locations, not full source bodies.

## Requirements

- Node.js **22.5+**.
- Git is recommended.
- Runtime has no npm dependencies.

## Quick start

```bash
cd StellarCode_v0.4
npm test
npm link

cd /path/to/your/repo
stellar init --install-agent-rule
stellar scan
stellar architecture
stellar search "login"
stellar context "找出這個專案的主要入口與核心模組"
stellar serve
```

Open the printed URL (default `http://127.0.0.1:7432`).

If the repository was already initialized with v0.3.x, you do **not** need to delete `.stellar/` or the Application Support database. Install/link v0.4 and run `stellar serve` or `stellar sync` normally.

## CLI

```text
stellar init [path] [--dry-run] [--install-agent-rule]
stellar scan [path] [--json]
stellar sync [path] [--json]
stellar status [path] [--json]
stellar search <query> [path] [--json]
stellar find <query> [path] [--json]
stellar file <relative-path> [project-path] [--json]
stellar symbol <query> [project-path] [--json]
stellar related <path-or-symbol> [project-path] [--json]
stellar impact <path-or-symbol> [project-path] [--depth N] [--json]
stellar context <task> [project-path] [--json]
stellar architecture [project-path] [--json]
stellar serve [path] [--port 7432]
stellar mcp [path]
stellar agent-rule
stellar benchmark report <baseline.jsonl> <stellar.jsonl>
```

## Storage policy

Repository-local identity only:

```text
repo/
└── .stellar/
    └── project.json
```

Application data:

```text
macOS   ~/Library/Application Support/StellarCode/
Linux   ~/.local/share/stellarcode/
Windows %LOCALAPPDATA%\StellarCode\
```

Each project has an isolated `index.db`; source code is never copied into the database.

## Parser note

The current MVP parser is dependency-free and deterministic rather than Tree-sitter/LSP based. It is sufficient for the included TS/JS/Python fixture and current navigation experiments, but production parser depth remains a post-MVP upgrade. See `docs/KNOWN_LIMITATIONS.md`.

## Verification

```bash
npm test
```

v0.4 adds regression coverage for architecture classification, hierarchy payloads, nested barrel handling and the architecture API/MCP surface.

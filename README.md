# StellarCode — M0–M3 MVP Implementation

> **A living map of your codebase.** Humans explore the universe; AI agents query the map before reading source.

This package contains a runnable M0–M3 implementation **plus the full original design/spec/mockup pack** under `design-pack/`.

## What is implemented

### M0 — Foundation
- Cross-platform application data path adapter (macOS/Linux/Windows).
- Stable repo identity in `.stellar/project.json` (UUID only; no absolute path).
- Global registry DB + isolated per-project `index.db`.
- Idempotent `stellar init`, dry-run, optional agent-rule installer.
- Three-OS GitHub Actions CI matrix.

### M1 — Repository index engine
- Supported source types: TypeScript, JavaScript, Python.
- Ignore rules, binary/size filtering, SHA-256 content state.
- Fast stale check reuses hashes when size+mtime are unchanged.
- Deterministic symbol/import extraction with no LLM/API key.
- Import/test/reference graph + reverse dependencies.
- Git HEAD/status/activity and rename hints.
- Incremental add/modify/delete sync.
- Importance scoring.
- Search/file/symbol/related/impact/context query service.
- Full-vs-incremental equivalence test fixture.
- Git-clean fast path; synthetic 10k-file benchmark reached 163 ms warm no-change sync in the final delivery run.

### M2 — Universe UI
- Local-only HTTP server (`127.0.0.1`).
- Canvas-based galaxy view using the real project index.
- Folder clustering, importance-sized planets, test markers and dependency edges.
- Pan/zoom, focus, Cmd/Ctrl+K search, inspector, Impact mode, Changes view.
- Reduced-motion CSS support and graph payload limits.

### M3 — AI Gateway
- MCP stdio JSON-RPC server.
- `stellar_search`, `stellar_file`, `stellar_symbol`, `stellar_related`, `stellar_impact`, `stellar_context`.
- Compact, source-body-free tool responses.
- Optional minimal `AGENTS.md` / `CLAUDE.md` rule installer.
- A/B benchmark JSONL reporter and 12-task benchmark suite template.

## Important implementation note

The M1 design document originally proposed Tree-sitter. This self-contained MVP ships a dependency-free deterministic parser instead, so the ZIP runs with Node 22 without `npm install` or native modules. It passes the included golden fixture but is **not a replacement for a production Tree-sitter/LSP parser on all real-world syntax**. See `docs/KNOWN_LIMITATIONS.md`.

The M3 benchmark harness is complete, but the real acceptance gate (Claude/Codex A/B token savings) requires running external agents with telemetry. Example data demonstrates the report format only; it is not claimed as real token savings evidence.

## Requirements

- Node.js 22.5+ (uses built-in `node:sqlite`).
- Git is recommended for Git metadata; indexing still works without useful Git history.

No npm dependencies are required for the MVP runtime.

## Quick start

```bash
cd StellarCode_M0-M3_Complete
npm test
npm link

cd /path/to/your/repo
stellar init --install-agent-rule
stellar scan
stellar status
stellar find "login"
stellar context "fix refresh token retry after 401"
stellar serve
```

Open the URL printed by `stellar serve` (default `http://127.0.0.1:7432`).

### Without `npm link`

```bash
node /path/to/StellarCode_M0-M3_Complete/src/cli.js init /path/to/repo
node /path/to/StellarCode_M0-M3_Complete/src/cli.js scan /path/to/repo
node /path/to/StellarCode_M0-M3_Complete/src/cli.js serve /path/to/repo
```

## CLI

```text
stellar init [path] [--dry-run] [--install-agent-rule]
stellar scan [path] [--json]
stellar sync [path] [--json]
stellar status [path] [--json]
stellar find <query> [path] [--json]
stellar file <relative-path> [project-path] [--json]
stellar symbol <query> [project-path] [--json]
stellar related <path-or-symbol> [project-path] [--json]
stellar impact <path-or-symbol> [project-path] [--depth N] [--json]
stellar context <task> [project-path] [--json]
stellar serve [path] [--port 7432]
stellar mcp [path]
stellar agent-rule
stellar benchmark report <baseline.jsonl> <stellar.jsonl>
```

## Storage policy

Repository local:

```text
repo/
└── .stellar/
    └── project.json     # UUID + schema version only
```

Application data:

```text
macOS   ~/Library/Application Support/StellarCode/
Linux   ~/.local/share/stellarcode/
Windows %LOCALAPPDATA%\StellarCode\
```

Each project has its own `index.db`. Source code is never copied into the database.

## Project layout

```text
src/
  cli.js
  core/       project identity, runtime, agent rule
  platform/   OS-standard data paths
  storage/    SQLite registry/project databases
  indexer/    scan, parse, Git, incremental graph sync
  query/      search, file, related, impact, context
  web/        local API + interactive Universe UI
  mcp/        MCP stdio server
  benchmark/  A/B metric reporter
fixtures/     mixed TS/Python golden repo
tests/        M0–M3 automated tests
benchmark/    12-task suite + example telemetry
design-pack/  all previous specs, wireframes, UI assets, mockups, prototype
```

## Verification

Run:

```bash
npm test
```

The package was delivered with all included tests passing in the build environment. See `docs/IMPLEMENTATION_STATUS.md` for what is automatically verified vs. what still requires external/OS-specific validation.

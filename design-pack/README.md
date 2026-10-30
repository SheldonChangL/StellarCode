# StellarCode MVP Design Pack

**StellarCode** turns a repository into a living code universe: a deterministic local index for AI navigation plus a visual HTML explorer for humans.

Core principles:

1. **Repository is the source of truth.** StellarCode never becomes a second copy of the repository.
2. **Zero-token maintenance.** File/symbol/dependency index maintenance is deterministic; LLMs consume the map, not maintain it.
3. **Ask the map before searching the repo.** AI tools should query StellarCode first, then open only relevant source ranges.
4. **Incremental by default.** Add/modify/delete/rename operations update only affected graph regions.
5. **One machine daemon, many projects.** No per-repository always-on watcher explosion.
6. **Human UI and AI API are separate products over the same graph.** HTML is for exploration; MCP/CLI/HTTP is for agents.

## MVP boundary

M0–M3 are the MVP. M4–M5 are post-MVP hardening and advanced intelligence.

| Milestone | Focus | MVP |
|---|---|---|
| M0 | Foundation & cross-platform storage | Yes |
| M1 | Repository index engine | Yes |
| M2 | Universe UI | Yes |
| M3 | AI gateway + benchmark validation | Yes — MVP complete |
| M4 | Global daemon, scale & reliability | Post-MVP |
| M5 | Advanced code intelligence | Post-MVP |

## Package contents

- `docs/` — product, system architecture, software architecture, data model, indexing, CLI/MCP/API, security, validation.
- `milestones/` — M0–M5 detailed implementation plans and exit criteria.
- `ui/` — UX spec, wireframes, design tokens, visual assets.
- `prototype/` — self-contained HTML/CSS/JS clickable mockup.
- `schemas/` — JSON schemas for project metadata and graph payloads.
- `examples/` — example repository graph and AI query responses.

## Quick demo

Open `prototype/index.html` in a browser. The prototype is static and self-contained; no build step is required.

## Recommended implementation stack

- Core/CLI/daemon: TypeScript + Node.js
- AST: Tree-sitter
- Storage: SQLite, one database per project
- Git: native Git CLI adapter or `simple-git`
- UI: React + TypeScript + React Three Fiber/Three.js for production; prototype uses plain HTML/CSS/JS
- IPC: Unix Domain Socket (macOS/Linux), Named Pipe (Windows)
- AI integration: MCP first, local HTTP/CLI fallback

## Platform storage

- macOS: `~/Library/Application Support/StellarCode/`
- Linux: `~/.local/share/stellarcode/`
- Windows: `%LOCALAPPDATA%\\StellarCode\\`

Each repository stores only `.stellar/project.json` containing an immutable project UUID and schema version.

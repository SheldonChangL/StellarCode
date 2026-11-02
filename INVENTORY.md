# StellarCode v0.5 Inventory

Release: **0.5.0 — Multi-Project Core**

Packaged files (before SHA manifest): 144

## Functional core

- `src/storage/registry.js` — machine-wide registry, project lifecycle, move recovery support, GC/purge
- `src/core/global-runtime.js` — resolve project by path/name/UUID and availability guard
- `src/web/global-server.js` — one HTTP server for every registered project, lazy sync on access
- `src/mcp/server.js` — global MCP plus `stellar_projects`
- `src/cli.js` — `projects`, `ui`, `remove`, `gc`, project-aware query commands
- `src/indexer/sync.js` — deterministic incremental index and registry index timestamps

## Global UI

- `src/web/public/dashboard.html`
- `src/web/public/dashboard.js`
- `src/web/public/dashboard.css`
- Existing v0.4 Universe remains available per project at `/project/<uuid>`.

## Validation

- 27 automated tests: **27 pass / 0 fail**
- Multi-project CLI smoke test: `docs/CLI_MULTIPROJECT_SMOKE.txt`
- Test report: `docs/TEST_REPORT_V0.5.txt`
- npm packaging report: `docs/NPM_PACK_DRY_RUN_V0.5.txt`

## v0.5 docs

- `README.md`
- `docs/V0.5_RELEASE.md`
- `docs/V0.5_ARCHITECTURE.md`
- `docs/IMPLEMENTATION_STATUS_V0.5.md`
- `docs/KNOWN_LIMITATIONS.md`

## Previous design / implementation assets

The package retains the full earlier design pack, M0–M3 implementation docs, v0.4 Universe assets/screenshots, benchmark fixtures, and original MVP design ZIP.

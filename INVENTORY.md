# StellarCode M0-M3 Complete Package Inventory

- Package version: 0.3.0-mvp
- Total files before checksum manifest: 114
- Unpacked size: 5.9M

## Runnable implementation

- `src/cli.js` — CLI entrypoint
- `src/core/` — project/runtime/agent rules
- `src/platform/` — macOS/Linux/Windows paths
- `src/storage/` — registry + per-project SQLite
- `src/indexer/` — scanner/parser/Git/incremental graph
- `src/query/` — search/file/symbol/related/impact/context
- `src/web/` — local API + Universe UI
- `src/mcp/` — MCP stdio server
- `src/benchmark/` — A/B reporter

## Verification

- `tests/` — M0-M3 automated tests
- `fixtures/sample/` — TypeScript/Python golden fixture
- `scripts/benchmark-10k.js` — 10k-source-file benchmark
- `docs/TEST_REPORT.txt` — final automated test output
- `docs/BENCHMARK_10K_RESULT.json` — final 10k benchmark result

## Design/spec assets

- `design-pack/` — full previous StellarCode MVP Design Pack
- `design-pack/original-zip/StellarCode_MVP_Design_Pack.zip` — original previous ZIP preserved verbatim
- includes M0-M5 plans, architecture docs, schemas, wireframes, SVG assets, PNG mockups and static prototype

## Read first

1. `README.md`
2. `docs/DELIVERY_SUMMARY.md`
3. `docs/IMPLEMENTATION_STATUS.md`
4. `docs/KNOWN_LIMITATIONS.md`
5. `docs/MCP_SETUP.md`

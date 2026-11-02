# Known Limitations

## v0.5 Multi-Project Core

- `stellar ui` is an **on-demand global service**, not yet an OS login daemon. It stops when the process stops.
- StellarCode intentionally does **not** crawl Home or mounted volumes to rediscover moved repositories. A moved repo is recovered automatically the first time StellarCode is used from its new location because the UUID in `.stellar/project.json` is path-independent.
- Idle projects use lazy synchronization rather than always-on filesystem watchers. This keeps background CPU/file-descriptor usage near zero, but a project is refreshed on access rather than at the exact instant an idle file changes.
- Missing/orphaned indexes are deliberately retained until explicit purge. This is conservative for external disks/network mounts but can leave storage allocated until `stellar remove --purge` or `stellar gc --purge-orphaned` is requested.
- The global UI is functional project switching plus the v0.4 Universe. UI/visual hierarchy is not the focus of v0.5.

## Indexing / Code Intelligence

- The current TypeScript/JavaScript/Python parser is deterministic and dependency-free, not Tree-sitter/LSP-grade semantic analysis.
- Relative imports are resolved; package aliases/path mappings and framework-specific dynamic imports are not fully modeled.
- Call graphs are not yet complete runtime call graphs.
- File-purpose summaries are deterministic metadata summaries; no LLM summary is required for index maintenance.

## AI Benchmark

The benchmark harness exists, but real Claude/Codex token savings must be measured with actual agent telemetry on representative repositories before claiming a production percentage reduction.

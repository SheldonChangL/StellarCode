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

v0.5.1 can execute controlled Claude/Codex A/B runs and reads the agents' reported token usage. Numeric savings still depend on the repository, task set, agent version, model, cache state, and account configuration.

- The harness currently targets read-only repository-navigation tasks; editing-quality benchmarking is not yet the primary scope.
- It requires a Git repository with a committed HEAD because each run uses a detached temporary worktree. Uncommitted changes are disclosed in the manifest but are not included in the benchmark snapshot.
- Authentication/subscription/API quota is managed by the installed Claude/Codex CLI, not StellarCode.
- Agent CLI output formats can evolve; adapters are regression-tested against fixtures but should be revalidated when upgrading major CLI versions.
- The harness does not claim a universal token-saving percentage. The HTML report only marks the evidence gate PASS when token/navigation thresholds and answer-key correctness all pass.

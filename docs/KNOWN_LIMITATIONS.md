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

## v0.5.5 context-precision limits

- Ranking is lexical/structural: IDF-weighted, identifier-boundary-aware term matching plus import-binding usage. Without types or a call graph, a method reached through `this.field.method()` is not linked to the imported class that field holds.
- Relative thresholds (primary 0.35/0.5, unlinked flow file 0.6, evidence 0.6) and the 40-line density/window constants are fixed heuristics, not learned per repository.
- Intent classification is keyword-based. Prompts that describe a flow without flow vocabulary are classified as navigation and get navigation's smaller evidence budget.
- `expectedFileSourcePrecision` is a file-level focus proxy, not semantic usefulness of the returned lines.
- Range deduplication runs before byte allocation. If a target is later cut to its densest window, evidence that overlapped the target's full range has already been dropped, so the overlapping lines may be returned by neither.

## v0.5.2 source-grounding limits

- Source grounding is detected from explicit native Read operations, read-like shell commands, or `stellar source` / `stellar_source`. Extremely custom scripts that read files indirectly may not be classified as source reads.
- `stellar source` is intentionally line-bounded (default/max limits) and does not persist source bodies in StellarCode databases.
- Benchmark answer correctness is currently answer-key file correctness, not semantic grading of every sentence in the prose summary. Grounded success therefore proves the agent found and read the expected implementation file, not that every explanation sentence is perfect.
- JS/TS symbol extraction is deterministic and regex-based rather than Tree-sitter/LSP. v0.5.2 corrects class-method line ranges, but complex syntax can still produce incomplete symbol ranges.

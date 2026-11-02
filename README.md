# StellarCode v0.5.2

**A living map of your codebases for humans and AI agents.**

v0.5 changed StellarCode from a per-repository web server into a **multi-project local knowledge service**. v0.5.1 added a controlled Claude/Codex A/B harness. v0.5.2 makes that benchmark source-grounded: StellarCode locates code, but the agent must read repository source before an answer counts as correct. Run `stellar init` once in each repository, then use one global UI/MCP service from anywhere.

## Requirements

- Node.js 22.5+
- Git recommended
- macOS, Linux, or Windows

No npm runtime dependencies are required.

## Install locally

```bash
npm install
npm link
```

## First-time project registration

Inside each repository:

```bash
stellar init --install-agent-rule
stellar scan
```

The repo only receives:

```text
.stellar/project.json
```

The index remains outside the repo in the OS application-data directory.

## Global workflow

List every registered project from anywhere:

```bash
stellar projects
```

Start one UI server for every project:

```bash
stellar ui
```

Open:

```text
http://127.0.0.1:7432
```

Selecting a project performs a lazy sync before its graph/query data is returned. Idle projects have no background file watcher.

## Query a project

From inside a registered repo:

```bash
stellar search login
stellar context "modify the login flow"
stellar source src/actions/auth.ts --lines 47:116
stellar architecture
```

From anywhere:

```bash
stellar search login --project JetBook
stellar context "modify the login flow" --project JetBook
stellar architecture --project JetBook
```

A project selector may be a display name, UUID/UUID prefix, or repository path.

## Global MCP

Run once from any directory:

```bash
stellar mcp
```

v0.5 exposes:

- `stellar_projects`
- `stellar_search`
- `stellar_file`
- `stellar_symbol`
- `stellar_related`
- `stellar_impact`
- `stellar_context`
- `stellar_architecture`
- `stellar_source`

AI agents can first call `stellar_projects`, then pass `project` or `projectId` to another tool. If MCP is launched for a specific repo, that repo may still be used as the default.

## Zero-manual-maintenance lifecycle

Registered projects move through:

```text
ACTIVE -> IDLE -> MISSING -> ORPHANED
```

- **ACTIVE**: recently accessed through UI/MCP/query.
- **IDLE**: registered and available, but not recently used.
- **MISSING**: the repository root or its project UUID is unavailable.
- **ORPHANED**: missing for the configured grace period (default 30 days).

StellarCode never scans your Home directory to rediscover projects. It checks only paths already present in the registry.

When a repository is moved, its `.stellar/project.json` UUID moves with it. The first StellarCode command used at the new location automatically refreshes the global registry path and reuses the existing index.

When a repository is deleted, the global registry marks it missing on the next UI/MCP/projects health check. The index is preserved. Once orphaned, reconstructable cache may be deleted automatically, but **`index.db` is never automatically purged**.

Explicit cleanup is available:

```bash
stellar gc
stellar remove JetBook
stellar remove JetBook --purge
stellar gc --purge-orphaned
```

`--purge` is intentionally explicit because source indexes may be useful after temporary disk/network failures.


## Prove token savings

Create a hidden-answer-key benchmark file:

```bash
stellar benchmark init
```

Edit `.stellar/benchmark/tasks.json`, enable 10–20 real navigation tasks, then check your local agents:

```bash
stellar benchmark doctor --agent all
```

Run paired fresh-session A/B tests:

```bash
stellar benchmark run --agent codex --mode both --repeat 3
# or
stellar benchmark run --agent claude --mode both --repeat 3
```

Each run produces `baseline.jsonl`, `stellar.jsonl`, `manifest.json`, `report.json`, and a standalone `report.html` under `.stellar/benchmark/runs/`.

The report now separates **Discovery**, **Source Grounding**, **Answer Correctness**, and **Grounded Success**. A final answer that names the right file but never reads the source fails the benchmark. Default evidence gates are >=20% overall input-token reduction, >=50% navigation-token reduction, >=40% tool-call reduction, >=40% faster first relevant source read, >=95% Stellar source-grounding rate, and no >5-point answer/grounded-success regression.

See `docs/V0.5.2_SOURCE_GROUNDED_BENCHMARK.md`.

## Storage

macOS:

```text
~/Library/Application Support/StellarCode/
```

Linux:

```text
~/.local/share/stellarcode/
```

Windows:

```text
%LOCALAPPDATA%\StellarCode\
```

Layout:

```text
StellarCode/
├── registry.db
└── projects/
    ├── <uuid-A>/index.db
    └── <uuid-B>/index.db
```

Every project has an independent index database. Source files are never copied into StellarCode.

## Commands

```text
stellar init [path]
stellar projects
stellar ui
stellar scan [path]
stellar sync [path]
stellar status [path] [--project NAME_OR_ID]
stellar search <query> [--project NAME_OR_ID]
stellar file <path> [--project NAME_OR_ID]
stellar symbol <query> [--project NAME_OR_ID]
stellar related <target> [--project NAME_OR_ID]
stellar impact <target> [--project NAME_OR_ID]
stellar context <task> [--project NAME_OR_ID]
stellar source <path> [--lines START:END] [--project NAME_OR_ID]
stellar architecture [--project NAME_OR_ID]
stellar remove <project> [--purge]
stellar gc [--purge-orphaned]
stellar mcp
stellar serve [path]   # legacy single-project mode when path is supplied
stellar benchmark init
stellar benchmark doctor --agent all
stellar benchmark run --agent codex|claude --mode both --repeat 3
stellar benchmark report baseline.jsonl stellar.jsonl --html report.html
```

## v0.5-v0.5.2 design constraints

1. **One global service, not one watcher/server per repo.**
2. **Lazy synchronization instead of always-on watchers.**
3. **Zero-token maintenance.** Indexing, lifecycle, and relation updates are deterministic.
4. **Zero-manual-maintenance for normal repo deletion/move.**
5. **No Home-directory crawling.** Only registered paths are checked.
6. **Repository remains source of truth.** StellarCode stores metadata/graph knowledge, not source snapshots.
7. **Conservative deletion.** Rebuildable cache may be reclaimed; durable indexes require explicit purge.
8. **Source-grounded answers.** Stellar metadata narrows where to read; repository source remains the evidence for implementation claims.

## Validation

```bash
npm test
```

v0.5 ships regression coverage for multi-project registry, lazy global UI sync, global MCP, moved repositories, deleted repositories, missing/orphan lifecycle, and conservative GC.

See:

- `docs/V0.5_RELEASE.md`
- `docs/V0.5_ARCHITECTURE.md`
- `docs/IMPLEMENTATION_STATUS_V0.5.md`
- `docs/V0.5.1_TOKEN_BENCHMARK.md`
- `docs/V0.5.2_SOURCE_GROUNDED_BENCHMARK.md`
- `docs/V0.5.2_RELEASE.md`
- `docs/IMPLEMENTATION_STATUS_V0.5.1.md`
- `docs/V0.5.1_RELEASE.md`
- `docs/BENCHMARK_TASK_AUTHORING.md`

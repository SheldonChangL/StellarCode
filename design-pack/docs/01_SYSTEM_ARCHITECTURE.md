# System Architecture

## High-level architecture

```text
                            +-----------------------+
                            |      Repository       |
                            | source + git history  |
                            +-----------+-----------+
                                        |
                                        v
                           +------------+-------------+
                           |    Indexing Pipeline     |
                           | scanner / git / AST      |
                           +------------+-------------+
                                        |
                                        v
                           +------------+-------------+
                           | Project Knowledge Graph  |
                           | SQLite: one DB / project |
                           +------+-------------+-----+
                                  |             |
                     compact data |             | graph payload
                                  v             v
                         +--------+---+     +---+----------------+
                         | AI Gateway |     | Universe Web UI    |
                         | MCP/CLI/API|     | human exploration  |
                         +------------+     +--------------------+
```

## Storage model

Repository-local metadata:

```text
repo/
└── .stellar/
    └── project.json
```

`project.json` contains only:

- immutable project UUID;
- metadata schema version;
- optional display name override.

Machine-level application data:

### macOS
`~/Library/Application Support/StellarCode/`

### Linux
`~/.local/share/stellarcode/`

### Windows
`%LOCALAPPDATA%\\StellarCode\\`

Recommended structure:

```text
StellarCode/
├── registry.db
├── config.json
└── projects/
    ├── <uuid-A>/index.db
    ├── <uuid-B>/index.db
    └── <uuid-C>/index.db
```

Rebuildable cache is separated into the OS cache directory. Logs use the OS log directory where practical.

## Source-of-truth rule

StellarCode does **not** persist full repository source snapshots. The original repository remains authoritative. The index stores derived facts such as paths, hashes, symbols, edges, change metadata, short summaries, and optional layout cache.

## Project lifecycle

```text
unregistered -> indexed -> active -> idle -> archived
                  ^          |         |
                  |          +---------+
                  |      re-activated on query
                  +------ reindex if invalid
```

- **indexed**: initial graph exists.
- **active**: recently queried/opened; optional watcher enabled.
- **idle**: no watcher; stale detection occurs lazily on next query.
- **archived**: metadata retained, cache eligible for cleanup.

## Synchronization strategy

MVP uses **lazy sync first**:

1. Agent or UI requests project data.
2. Stellar checks current Git state + changed-file metadata.
3. If stale, only affected files are re-indexed.
4. Query executes against the fresh index.

Post-MVP may add active-project watchers managed by one global daemon.

## Cross-platform abstraction

```text
PlatformAdapter
├── getDataDirectory()
├── getCacheDirectory()
├── getLogDirectory()
├── getIpcEndpoint()
├── createWatcher()
├── normalizePath()
└── acquireProcessLock()
```

The core graph/index logic must not depend directly on macOS, Linux, or Windows APIs.

## Trust boundaries

1. Repository source: untrusted input for parsers.
2. Local index DB: trusted derived data, rebuildable.
3. MCP/HTTP interface: local-only by default.
4. Browser UI: read-only against index in MVP.
5. Optional LLM summary provider: disabled by default and never required for correctness.

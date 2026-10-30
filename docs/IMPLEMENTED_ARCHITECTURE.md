# Implemented Architecture — M0 to M3

## Runtime

```text
Developer / AI agent
        |
        +--------------------+
        |                    |
        v                    v
   stellar CLI           MCP stdio
        |                    |
        +---------+----------+
                  v
             Query Service
                  |
          lazy sync before query
                  |
                  v
          Incremental Indexer
        /       |        |      \
   Scanner   Parser     Git    Graph
        \       |        |      /
                  v
           per-project SQLite
                  |
          +-------+-------+
          |               |
          v               v
     Local API       Universe Web UI
     127.0.0.1        Canvas renderer
```

## Storage

Global registry and project databases use OS-standard application data directories. The repository stores only `.stellar/project.json`.

Each project DB contains metadata, file facts, symbols, unresolved imports, graph edges, change events, rename hints and warnings. It intentionally does not contain source bodies.

## Lazy synchronization

Every query can trigger `syncProject()` first. Scanner compares current file size + mtime to stored facts and reuses the prior SHA-256 hash when unchanged. Only content-hash changes are reparsed. This provides M4-compatible on-demand synchronization without requiring one watcher process per repo.

## Dependency graph

MVP file relationships:
- `contains`: file → symbol
- `imports`: source file → resolved relative module
- `tests`: test file → imported source file
- `references`: importing file → deterministically resolved imported symbol

Reverse dependency queries use the same edge table with a target index.

## Context recommender

`stellar_context` is deterministic. Ranking signals are:
- path/summary lexical match;
- symbol lexical match;
- file importance;
- Git activity;
- one-hop graph proximity;
- linked test relevance.

No LLM is used and no source body is returned.

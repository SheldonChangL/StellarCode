# Software Architecture

## Proposed monorepo

```text
stellarcode/
├── apps/
│   ├── cli/
│   ├── daemon/
│   └── web/
├── packages/
│   ├── core/
│   ├── platform/
│   ├── scanner/
│   ├── parser/
│   ├── git/
│   ├── graph/
│   ├── storage/
│   ├── query/
│   ├── mcp/
│   ├── benchmark/
│   └── shared/
├── fixtures/
├── tests/
└── docs/
```

## Package responsibilities

### `core`
Coordinates project registration, synchronization state, indexing jobs, graph versioning, and error handling.

### `platform`
OS-specific directories, IPC, locks, watcher adapters, path normalization, process management.

### `scanner`
Filesystem traversal, ignore rules, language detection, size limits, binary detection, hash collection.

### `parser`
Tree-sitter adapters and language-specific symbol/import/export extraction.

### `git`
Repository detection, HEAD state, diff, rename hints, commit metadata, file history, co-change input.

### `graph`
Node/edge construction, reverse edges, centrality/importance calculations, impact traversal.

### `storage`
SQLite migrations, repositories/DAOs, transactions, indexes, integrity checks.

### `query`
Search, symbol lookup, file detail, related graph, impact graph, context recommendation.

### `mcp`
MCP tool definitions and compact response serializers.

### `benchmark`
A/B task runner and token/tool-call metrics.

### `web`
Universe visualization, search, details panel, impact mode, changes view, settings.

## Internal dependency rule

```text
apps -> package APIs
query -> graph + storage
core -> scanner + parser + git + graph + storage + platform
mcp -> query
web -> local API only
```

`web` should never import parser/storage internals directly.

## Core indexing flow

```text
syncProject(projectId)
  -> detectChanges()
  -> classifyChange(add/modify/delete/rename)
  -> parseChangedFiles()
  -> updateFileFacts()
  -> rebuildAffectedEdges()
  -> updateReverseEdges()
  -> updateImportanceForAffectedSubgraph()
  -> commitGraphVersion()
```

## Error model

Each indexing result should be partial-success capable:

```ts
type IndexResult = {
  graphVersion: number;
  changedFiles: number;
  warnings: IndexWarning[];
  failures: IndexFailure[];
};
```

A single unsupported or malformed file must not invalidate the whole project index.

## Concurrency

- One write transaction per project DB at a time.
- Queries may run concurrently against committed graph version.
- Synchronization acquires a project-scoped lock, not a global lock.
- Global daemon handles multiple project syncs with bounded concurrency.

## Compatibility

MVP languages:

- TypeScript
- JavaScript
- Python

Architecture must allow parser plugins for additional languages without changing graph/query contracts.

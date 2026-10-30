# Indexing & Synchronization

## Initial scan

`stellar init` registers the project and may optionally invoke `stellar scan`.

Initial scan steps:

1. Validate Git repository if present; support non-Git folders as degraded mode.
2. Apply ignore rules.
3. Enumerate text source files.
4. Record metadata and content hash.
5. Parse supported languages.
6. Extract symbols/imports/exports and deterministic references.
7. Build folder/file/symbol graph.
8. Add Git metadata.
9. Calculate reverse dependencies and importance.
10. Commit graph version 1.

## Ignore precedence

1. Stellar hard excludes: `.git`, dependency caches, binary folders.
2. `.stellarignore` if present.
3. `.gitignore` when Git repository is detected.
4. User global excludes.

MVP hard excludes should include common heavy/generated trees such as `node_modules`, `.venv`, `dist`, `build`, `target`, `.gradle`, `DerivedData` unless explicitly included.

## Lazy stale detection

Before a query:

```text
project index exists?
  no -> require initial scan
  yes
    |
    v
compare git HEAD + working tree + tracked metadata
    |
    +-- no changes -> answer immediately
    |
    +-- changes -> incremental sync -> answer
```

No LLM is involved.

## Change handling

### Add
Parse new file, add symbols and outgoing edges, update reverse edges for resolved imports.

### Modify
Hash mismatch triggers reparse. Replace file-derived facts transactionally, then rebuild affected edges.

### Delete
Remove file/symbol nodes and all incident edges. Mark unresolved references for diagnostics.

### Rename
Use Git rename detection first. Otherwise use content hash/similarity heuristics. Preserve file history if confidence exceeds threshold.

## Active watcher (post-MVP/M4)

One global daemon may watch only active projects. Watchers are suspended after inactivity. Lazy sync remains the correctness fallback.

## Zero-token maintenance rule

The following must never require an LLM:

- path changes;
- file hashes;
- add/modify/delete/rename;
- AST parsing;
- symbol/import/export extraction;
- graph edge updates;
- Git metadata;
- stale detection;
- importance recomputation.

LLMs are optional only for semantic summaries or human-authored intent.
